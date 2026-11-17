// harness init: wire a project up. Safe to re-run: it never overwrites a file
// it didn't write, and it reports every step as added, updated or skipped.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, findRoot, gitRoot, readJson, subPath, tsconfigs } from './project.mjs';

/** @import { ClaudeSettings, HookEntry, Log, PackageJson } from './types.mjs' */

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
/** @param {string} name */
const template = (name) => readFileSync(join(TEMPLATES, name), 'utf8');
const { version } = /** @type {{ version: string }} */ (readJson(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), { version: '0.0.0' }));
/**
 * Where projects install the harness from: a release tag, never a branch, so a later push to
 * the harness can't reach a project until it chooses to upgrade.
 */
export const SOURCE = `github:tylersexton-dev/quality-harness#v${version}`;
const LEGACY_HOOK = 'npx --no-install harness hook';
/**
 * The hook command for a project at `sub` in the repo. Runs from the repo root whatever folder Claude Code was started in.
 * @param {string} sub  the project's folder relative to the repo root ('' at the root)
 */
export const hookCommand = (sub) => `cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" && ${sub ? `${shellQuote(sub)}/` : ''}node_modules/.bin/harness hook`;

/**
 * Quote a value for a POSIX shell, so a folder name can never become code in the hook command.
 * Plain names (letters, digits, `._/-`) are left readable.
 * @param {string} value
 */
export const shellQuote = (value) => (/^[\w./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);
const FLAT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts'];
const MARK_START = '<!-- quality-harness:start -->';
const MARK_END = '<!-- quality-harness:end -->';

/**
 * Any TypeScript files outside node_modules? (stops at the first one)
 * @param {string} root
 */
export function hasTypeScript(root) {
  const stack = [root];
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      if (e.isDirectory()) stack.push(join(dir, e.name));
      else if (/\.(?:[cm]?ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) return true;
    }
  }
  return false;
}

const LEGACY_CONFIGS = ['.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml'];

/**
 * harness init: set the project up. Every step reports added, updated, kept or skipped.
 * @param {{ cwd?: string, log?: Log }} [options]
 * @returns {number} exit code
 */
export function init({ cwd = process.cwd(), log = console } = {}) {
  const root = findRoot(cwd);
  const pkgPath = join(root, 'package.json');
  const pkg = /** @type {PackageJson} */ (readJson(pkgPath, {}));
  /** @type {string[]} */
  const done = [];
  /** @param {string} status @param {string} what */
  const step = (status, what) => done.push(`${status.padEnd(8)} ${what}`);
  /** @param {string} rel @param {string} content @param {string} [base] */
  const write = (rel, content, base = root) => {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), content);
  };
  // GitHub reads workflows and Claude Code reads .claude/ only at the repo root, so those go there
  // even when the project is a subfolder (Prism's frontend/). Everything else stays in the project.
  const repo = gitRoot(root);
  const sub = subPath(root);
  /** @param {string} rel */
  const at = (rel) => (sub ? `(repo) ${rel}` : rel);

  // 1. Project settings
  if (!existsSync(join(root, CONFIG_FILE))) {
    const config = { test: pkg.scripts?.test ? 'npm test' : '', boundaries: [], ignore: [], typeChecked: true, hook: { typecheck: true }, rules: {} };
    write(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
    step('added', `${CONFIG_FILE} (test command: ${config.test || 'none'})`);
  } else step('skipped', `${CONFIG_FILE} (exists)`);

  // 2. Strict TypeScript
  const ts = hasTypeScript(root);
  const found = tsconfigs(root);
  if (!ts) step('skipped', 'tsconfig.json (no TypeScript files)');
  else if (found.length === 0) {
    const tsconfig = { extends: 'quality-harness/config/tsconfig.base.json', include: ['**/*.ts', '**/*.mts', '**/*.cts', '**/*.tsx'], exclude: ['node_modules', 'dist', 'build', '.harness'] };
    write('tsconfig.json', `${JSON.stringify(tsconfig, null, 2)}\n`);
    step('added', 'tsconfig.json (strict, extends the harness base)');
  } else if (found.length === 1 && found[0] === 'tsconfig.json') {
    const own = readFileSync(join(root, 'tsconfig.json'), 'utf8');
    if (own.includes('quality-harness/config/tsconfig.base.json')) step('skipped', 'tsconfig.json (already extends the harness base)');
    else step('kept', 'tsconfig.json (checked as is; to go stricter, extend quality-harness/config/tsconfig.base.json)');
  } else step('kept', `${found.join(', ')} (one per workspace, each checked as is)`);

  // 3. Lint config. The harness needs a flat config (eslint.config.*). A legacy .eslintrc is
  // left alone for older tools (Next 14's `next lint`); the harness doesn't read it.
  const flat = FLAT_CONFIGS.find((f) => existsSync(join(root, f)));
  const legacy = LEGACY_CONFIGS.find((f) => existsSync(join(root, f)));
  if (!flat) {
    write('eslint.config.mjs', template('eslint.config.mjs'));
    step('added', `eslint.config.mjs (rules from the harness, settings from harness.config.json${legacy ? `; ${legacy} kept for older tools` : ''})`);
  } else if (readFileSync(join(root, flat), 'utf8').includes('quality-harness/eslint')) step('skipped', `${flat} (already uses the harness)`);
  else step('kept', `${flat} (yours: add \`...harness({ ...config, root: import.meta.dirname })\` from quality-harness/eslint to adopt the shared rules)`);

  // 4. Scripts and the dependency
  const pkgScripts = (pkg.scripts ??= {});
  const scripts = { check: 'harness check', typecheck: 'harness types', lint: 'harness lint', 'quality:baseline': 'harness baseline' };
  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const clashes = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    if (!pkgScripts[name]) {
      pkgScripts[name] = cmd;
      added.push(name);
    } else if (pkgScripts[name] !== cmd) clashes.push(name);
  }
  const devDeps = (pkg.devDependencies ??= {});
  const hadDep = Boolean(devDeps['quality-harness'] || pkg.dependencies?.['quality-harness']);
  if (!hadDep) devDeps['quality-harness'] = SOURCE;
  if (added.length || !hadDep) {
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    step('updated', `package.json (${[added.length ? `scripts: ${added.join(', ')}` : '', hadDep ? '' : 'devDependency: quality-harness'].filter(Boolean).join('; ')})`);
  } else step('skipped', 'package.json (scripts and dependency already there)');
  if (clashes.length) step('note', `package.json already has ${clashes.join(', ')}: left as is; \`npx harness check\` works regardless`);

  // 5. PR check (at the repo root; runs in the project's folder)
  const slug = sub.replace(/[^\w.-]+/g, '-');
  const workflow = `.github/workflows/${sub ? `quality-${slug}` : 'quality'}.yml`;
  if (!existsSync(join(repo, workflow))) {
    const prefix = sub ? `${sub}/` : '';
    // JSON strings are valid YAML scalars, so a folder name can't break or extend the workflow.
    const q = JSON.stringify;
    const node = pkg.engines?.node ? `node-version-file: ${q(`${prefix}package.json`)}` : "node-version: '22'";
    const yml = template('quality.yml')
      .replace('__NAME__', q(sub ? `quality (${sub})` : 'quality'))
      .replace('__DIR__', q(sub || '.'))
      .replace('__NODE__', node)
      .replace('__LOCK__', q(`${prefix}package-lock.json`));
    write(workflow, yml, repo);
    step('added', `${at(workflow)} (types, lint and tests on every PR)`);
  } else step('skipped', `${at(workflow)} (exists)`);
  if (!existsSync(join(repo, '.github/pull_request_template.md'))) {
    write('.github/pull_request_template.md', template('pull_request_template.md'), repo);
    step('added', `${at('.github/pull_request_template.md')} (asks for verification)`);
  } else step('skipped', `${at('.github/pull_request_template.md')} (exists)`);

  // 6. Claude Code hook (merged into the repo's settings; one entry per harness project)
  const settingsPath = join(repo, '.claude/settings.json');
  const settings = /** @type {ClaudeSettings} */ (readJson(settingsPath, {}));
  const postToolUse = ((settings.hooks ??= {}).PostToolUse ??= []);
  const command = hookCommand(sub);
  /** @type {HookEntry[]} */
  const entries = postToolUse.flatMap((g) => g.hooks ?? []);
  const oldHook = !sub && entries.find((h) => h.command === LEGACY_HOOK);
  if (entries.some((h) => h.command === command)) step('skipped', `${at('.claude/settings.json')} (hook already there)`);
  else {
    if (oldHook) oldHook.command = command; // older installs ran `npx` from wherever Claude started
    else postToolUse.push({ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command, timeout: 120 }] });
    write('.claude/settings.json', `${JSON.stringify(settings, null, 2)}\n`, repo);
    step('updated', `${at('.claude/settings.json')} (${oldHook ? 'hook upgraded to run from the repo root' : 'lint + typecheck after every edit'})`);
  }

  // 7. Skills
  for (const skill of ['correction-to-check', 'verify-change']) {
    const dest = join(repo, '.claude/skills', skill);
    if (existsSync(dest)) step('skipped', `${at(`.claude/skills/${skill}`)} (exists)`);
    else {
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(TEMPLATES, 'skills', skill), dest, { recursive: true });
      step('added', at(`.claude/skills/${skill}`));
    }
  }

  // 8. CLAUDE.md block (replaced in place on re-run)
  const claudePath = join(root, 'CLAUDE.md');
  const block = template('claude-md.md').trim();
  const current = existsSync(claudePath) ? readFileSync(claudePath, 'utf8') : '';
  if (current.includes(MARK_START) && current.includes(MARK_END)) {
    const next = current.replace(new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`), block);
    if (next !== current) {
      writeFileSync(claudePath, next);
      step('updated', 'CLAUDE.md (quality rules refreshed)');
    } else step('skipped', 'CLAUDE.md (quality rules current)');
  } else {
    writeFileSync(claudePath, current ? `${current.trimEnd()}\n\n${block}\n` : `# ${pkg.name ?? 'Project'}\n\n${block}\n`);
    step(current ? 'updated' : 'added', 'CLAUDE.md (quality rules)');
  }

  // 9. Ignore the incremental build caches (one per tsconfig), keep the baseline
  const giPath = join(root, '.gitignore');
  const gi = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  if (/^\.harness\/tsbuildinfo\*$/m.test(gi)) step('skipped', '.gitignore (already ignores the caches)');
  else if (/^\.harness\/tsbuildinfo$/m.test(gi)) {
    writeFileSync(giPath, gi.replace(/^\.harness\/tsbuildinfo$/m, '.harness/tsbuildinfo*'));
    step('updated', '.gitignore (.harness/tsbuildinfo* covers one cache per tsconfig)');
  } else {
    appendFileSync(giPath, `${gi && !gi.endsWith('\n') ? '\n' : ''}\n# quality-harness caches (commit .harness/baseline.json)\n.harness/tsbuildinfo*\n`);
    step('updated', '.gitignore (.harness/tsbuildinfo*)');
  }

  log.log(`quality-harness init in ${root}${sub ? `\n(repo) = repo root ${repo}: GitHub and Claude Code only read .github/ and .claude/ there` : ''}\n\n${done.join('\n')}\n`);
  log.log(['Next:', `  1. npm install${hadDep ? '' : `   (adds quality-harness from ${SOURCE})`}`, '  2. npx harness baseline   (accept today\'s problems so only new ones fail)', '  3. npx harness check      (should pass)', '  4. commit, including .harness/baseline.json'].join('\n'));
  return 0;
}
