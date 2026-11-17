import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { hookCommand, init, shellQuote, SOURCE } from '../lib/init.mjs';
import { json, project, read, recorder, write } from './helpers.mjs';

/** @import { ClaudeSettings, PackageJson } from '../lib/types.mjs' */

/**
 * Run init and return the step lines it printed.
 * @param {string} cwd
 */
function runInit(cwd) {
  const log = recorder();
  assert.equal(init({ cwd, log }), 0);
  return log.text().split('\n').filter((l) => /^(added|updated|kept|skipped|note)\s/.test(l));
}
/** @param {string[]} steps */
const changed = (steps) => steps.filter((l) => /^(added|updated)/.test(l));
/**
 * @param {string} repo
 * @returns {string[]}
 */
const hookCommands = (repo) => (/** @type {ClaudeSettings} */ (JSON.parse(read(repo, '.claude/settings.json'))).hooks?.PostToolUse ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);

test('a fresh TypeScript project gets every piece', (t) => {
  const root = project(t, { 'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest' } }), 'src/a.ts': 'export {};\n' }, { git: true });
  runInit(root);
  for (const f of ['harness.config.json', 'tsconfig.json', 'eslint.config.mjs', '.github/workflows/quality.yml', '.github/pull_request_template.md', '.claude/skills/correction-to-check/SKILL.md', '.claude/skills/verify-change/SKILL.md', 'CLAUDE.md']) {
    assert.ok(existsSync(join(root, f)), `${f} missing`);
  }
  const pkg = /** @type {PackageJson} */ (JSON.parse(read(root, 'package.json')));
  assert.equal(pkg.scripts?.['check'], 'harness check');
  assert.equal(pkg.devDependencies?.['quality-harness'], SOURCE);
  assert.match(SOURCE, /^github:tylersexton-dev\/quality-harness#v\d+\.\d+\.\d+$/, 'pinned to a release tag, not a branch');
  assert.equal(json(root, 'harness.config.json')['test'], 'npm test');
  assert.match(read(root, 'tsconfig.json'), /quality-harness\/config\/tsconfig\.base\.json/);
  assert.deepEqual(hookCommands(root), [hookCommand('')]);
  assert.match(read(root, '.gitignore'), /^\.harness\/tsbuildinfo\*$/m);
  assert.match(read(root, 'CLAUDE.md'), /^# app\n/);
});

test('running init again changes nothing', (t) => {
  const root = project(t, { 'package.json': '{}', 'src/a.ts': 'export {};\n' }, { git: true });
  runInit(root);
  assert.deepEqual(changed(runInit(root)), []);
});

test('no package test script means no test command', (t) => {
  const root = project(t, { 'package.json': '{}' });
  runInit(root);
  assert.equal(json(root, 'harness.config.json')['test'], '');
});

test('a subfolder project: repo files at the git root, scoped to the folder', (t) => {
  const repo = project(t, { 'frontend/package.json': JSON.stringify({ engines: { node: '>=22' } }), 'frontend/src/a.ts': 'export {};\n', 'backend/main.py': '' }, { git: true });
  const steps = runInit(join(repo, 'frontend'));
  assert.ok(!existsSync(join(repo, 'frontend/.github')), 'workflow inside the subfolder never runs');
  assert.ok(!existsSync(join(repo, 'frontend/.claude')), 'Claude Code never reads a nested .claude/');
  const yml = read(repo, '.github/workflows/quality-frontend.yml');
  assert.match(yml, /^name: "quality \(frontend\)"$/m);
  assert.match(yml, /working-directory: "frontend"/);
  assert.match(yml, /node-version-file: "frontend\/package\.json"/);
  assert.match(yml, /cache-dependency-path: "frontend\/package-lock\.json"/);
  assert.deepEqual(hookCommands(repo), [hookCommand('frontend')]);
  assert.ok(existsSync(join(repo, '.claude/skills/verify-change/SKILL.md')));
  assert.ok(existsSync(join(repo, 'frontend/harness.config.json')));
  assert.ok(steps.some((l) => l.includes('(repo) .github/workflows/quality-frontend.yml')));
});

test('two subfolder projects in one repo each get their own hook entry and workflow', (t) => {
  const repo = project(t, { 'web/package.json': '{}', 'api/package.json': '{}' }, { git: true });
  runInit(join(repo, 'web'));
  runInit(join(repo, 'api'));
  assert.deepEqual(hookCommands(repo).sort(), [hookCommand('api'), hookCommand('web')].sort());
  assert.ok(existsSync(join(repo, '.github/workflows/quality-web.yml')));
  assert.ok(existsSync(join(repo, '.github/workflows/quality-api.yml')));
});

test('an older install is upgraded in place: hook command and .gitignore pattern', (t) => {
  const root = project(t, {
    'package.json': '{}',
    '.claude/settings.json': JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'npx --no-install harness hook', timeout: 120 }] }] }, other: true }),
    '.gitignore': 'node_modules\n.harness/tsbuildinfo\n',
  }, { git: true });
  const steps = runInit(root);
  assert.ok(steps.some((l) => l.includes('hook upgraded')));
  assert.deepEqual(hookCommands(root), [hookCommand('')]);
  assert.equal(json(root, '.claude/settings.json')['other'], true, 'other settings kept');
  assert.equal(read(root, '.gitignore'), 'node_modules\n.harness/tsbuildinfo*\n');
});

test('existing settings and hooks are merged, not replaced', (t) => {
  const root = project(t, { 'package.json': '{}', '.claude/settings.json': JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } }) });
  runInit(root);
  assert.deepEqual(hookCommands(root), ['echo hi', hookCommand('')]);
});

test('a workspace monorepo keeps its per-app tsconfigs and gets no root one', (t) => {
  const root = project(t, {
    'package.json': JSON.stringify({ workspaces: ['apps/*'] }),
    'apps/api/tsconfig.json': '{}',
    'apps/api/src/a.ts': 'export {};\n',
    'apps/web/tsconfig.json': '{}',
  });
  const steps = runInit(root);
  assert.ok(!existsSync(join(root, 'tsconfig.json')));
  assert.ok(steps.some((l) => l.startsWith('kept') && l.includes('apps/api/tsconfig.json, apps/web/tsconfig.json')));
});

test('your own tsconfig and flat ESLint config are kept; a harness-based one is recognized', (t) => {
  const mine = project(t, { 'package.json': '{}', 'src/a.ts': '', 'tsconfig.json': '{"compilerOptions":{}}', 'eslint.config.js': 'export default [];\n' });
  const steps = runInit(mine);
  assert.equal(read(mine, 'tsconfig.json'), '{"compilerOptions":{}}');
  assert.equal(read(mine, 'eslint.config.js'), 'export default [];\n');
  assert.ok(steps.some((l) => l.startsWith('kept     tsconfig.json')));
  assert.ok(steps.some((l) => l.startsWith('kept') && l.includes('eslint.config.js')));

  const ours = project(t, { 'package.json': '{}', 'src/a.ts': '', 'tsconfig.json': '{"extends":"quality-harness/config/tsconfig.base.json"}', 'eslint.config.mjs': "import harness from 'quality-harness/eslint';\n" });
  const again = runInit(ours);
  assert.ok(again.some((l) => l.includes('already extends the harness base')));
  assert.ok(again.some((l) => l.includes('already uses the harness')));
});

test('a legacy .eslintrc stays for older tools, and the harness still gets a flat config', (t) => {
  const root = project(t, { 'package.json': '{}', '.eslintrc.json': '{}' });
  const steps = runInit(root);
  assert.ok(existsSync(join(root, 'eslint.config.mjs')));
  assert.equal(read(root, '.eslintrc.json'), '{}');
  assert.ok(steps.some((l) => l.includes('.eslintrc.json kept for older tools')));
});

test('existing scripts and dependency are never overwritten', (t) => {
  const root = project(t, { 'package.json': JSON.stringify({ scripts: { lint: 'next lint' }, devDependencies: { 'quality-harness': 'file:vendor/qh.tgz' } }) });
  const steps = runInit(root);
  const pkg = /** @type {PackageJson} */ (JSON.parse(read(root, 'package.json')));
  assert.equal(pkg.scripts?.['lint'], 'next lint');
  assert.equal(pkg.devDependencies?.['quality-harness'], 'file:vendor/qh.tgz');
  assert.ok(steps.some((l) => l.startsWith('note') && l.includes('lint')));
});

test('the CLAUDE.md block is appended once and refreshed in place', (t) => {
  const root = project(t, { 'package.json': '{}', 'CLAUDE.md': '# Mine\n\nMy notes.\n' });
  runInit(root);
  const once = read(root, 'CLAUDE.md');
  assert.ok(once.startsWith('# Mine\n\nMy notes.\n'));
  assert.equal(once.split('quality-harness:start').length, 2);
  write(root, 'CLAUDE.md', once.replace(/(<!-- quality-harness:start -->)[\s\S]*(<!-- quality-harness:end -->)/, '$1\nstale\n$2'));
  runInit(root);
  const refreshed = read(root, 'CLAUDE.md');
  assert.ok(!refreshed.includes('stale'));
  assert.equal(refreshed, once);
});

test('no TypeScript means no tsconfig', (t) => {
  const root = project(t, { 'package.json': '{}', 'index.js': '' });
  runInit(root);
  assert.ok(!existsSync(join(root, 'tsconfig.json')));
});

test('folder names can never become code: hook command and workflow are quoted', (t) => {
  for (const name of ['my app', "it's", 'x`touch pwned`', 'a$(touch pwned)b']) {
    const echoed = spawnSync('sh', ['-c', `printf %s ${shellQuote(name)}`], { encoding: 'utf8' }).stdout;
    assert.equal(echoed, name, `${name} must round-trip as plain text`);
  }
  assert.equal(shellQuote('apps/web'), 'apps/web', 'plain names stay readable');

  const name = 'web: app\non: [push]';
  const repo = project(t, { [`${name}/package.json`]: '{}' }, { git: true });
  runInit(join(repo, name));
  const [file, ...others] = readdirSync(join(repo, '.github/workflows'));
  assert.equal(others.length, 0);
  assert.match(file ?? '', /^quality-[\w.-]+\.yml$/, 'the file name is sanitized');
  const yml = read(repo, `.github/workflows/${file}`);
  assert.ok(yml.includes(`working-directory: ${JSON.stringify(name)}`));
  assert.equal(yml.match(/^on:/gm)?.length, 1, 'the folder name added no YAML keys');
  assert.ok(hookCommands(repo).includes(hookCommand(name)));
  assert.ok(hookCommand(name).includes(`'${name}'/node_modules`));
});
