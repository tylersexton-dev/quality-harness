// The two deterministic checks: lint (ESLint API) and types (tsc --noEmit).
// Both return the same shape so the ratchet can compare them:
//   { tool, file, rule, line, col, message }  with `file` relative to the project root.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { tsconfigs } from './project.mjs';

/** @import { Violation } from './types.mjs' */

const require = createRequire(import.meta.url);
/** @param {string} p */
const posix = (p) => p.split(sep).join('/');

/**
 * The ESLint to run. The project's own copy when it reads flat config by default (v9+), so its
 * plugins resolve the same way its editor sees them; otherwise the harness's own. Older projects
 * (Next 14 pins ESLint 8 for `next lint`) keep their version for their own scripts and still
 * get the harness rules.
 * @param {string} root
 * @returns {Promise<typeof import('eslint').ESLint>}
 */
async function eslintFor(root) {
  try {
    const own = /** @type {typeof import('eslint')} */ (await import(require.resolve('eslint', { paths: [root] })));
    if (Number.parseInt(own.ESLint.version, 10) >= 9) return own.ESLint;
  } catch {
    // not installed in the project
  }
  return (await import('eslint')).ESLint;
}

/**
 * Lint `targets` (default: the whole project) with the project's own eslint.config.
 * @param {string} root
 * @param {string[]} [targets]
 * @returns {Promise<Violation[]>}
 */
export async function lint(root, targets = ['.']) {
  const ESLint = await eslintFor(root);
  const eslint = new ESLint({ cwd: root, errorOnUnmatchedPattern: false });
  const results = await eslint.lintFiles(targets);
  /** @type {Violation[]} */
  const out = [];
  for (const r of results) {
    for (const m of r.messages) {
      if (m.severity < 2) continue; // warnings never fail a check
      out.push({
        tool: 'lint',
        file: posix(relative(root, r.filePath)),
        rule: m.ruleId ?? (m.fatal ? 'parse-error' : 'eslint'),
        line: m.line ?? 0,
        col: m.column ?? 0,
        message: m.message,
      });
    }
  }
  return out;
}

/** TypeScript's unused-name errors. ESLint's no-unused-vars owns these (and honors `_`), so tsc's copies are dropped. */
export const TS_UNUSED = new Set(['TS6133', 'TS6192', 'TS6196', 'TS6198']);

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/**
 * Type-check the project: every tsconfig it has (one at the root, or one per workspace).
 * With `file`, only the tsconfig that owns it (the deepest one whose folder contains it),
 * so the hook in a monorepo checks one app, not all of them.
 * @param {string} root
 * @param {{ incremental?: boolean, file?: string }} [options]
 * @returns {Violation[]}
 */
export function types(root, { incremental = false, file } = {}) {
  let configs = tsconfigs(root);
  if (file) {
    const owners = configs.filter((c) => {
      const dir = dirname(c);
      return dir === '.' || file === dir || file.startsWith(`${dir}/`);
    });
    configs = owners.sort((a, b) => b.length - a.length).slice(0, 1);
  }
  if (!configs.length) return [];
  let tsc;
  try {
    tsc = require.resolve('typescript/bin/tsc', { paths: [root] });
  } catch {
    tsc = require.resolve('typescript/bin/tsc');
  }
  return configs.flatMap((config) => runTsc(root, tsc, config, incremental)).filter((v) => !TS_UNUSED.has(v.rule));
}

/**
 * @param {string} root
 * @param {string} tsc     path to typescript/bin/tsc
 * @param {string} config  tsconfig path, relative to root
 * @param {boolean} incremental
 * @returns {Violation[]}
 */
function runTsc(root, tsc, config, incremental) {
  const args = [tsc, '--noEmit', '--pretty', 'false', '-p', config];
  if (incremental) {
    const slug = config === 'tsconfig.json' ? '' : `-${config.replace(/\/?tsconfig\.json$/, '').replace(/[^\w.-]+/g, '_')}`;
    args.push('--incremental', '--tsBuildInfoFile', join('.harness', `tsbuildinfo${slug}`));
  }
  const res = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw res.error;
  /** @type {Violation[]} */
  const out = [];
  /** @type {Violation | null} */
  let last = null;
  for (const line of (res.stdout + res.stderr).split('\n')) {
    const m = TSC_LINE.exec(line);
    if (m) {
      const [, file = '', lineNo = '0', colNo = '0', rule = '', message = ''] = m;
      last = { tool: 'types', file: posix(file), rule, line: Number(lineNo), col: Number(colNo), message };
      out.push(last);
    } else if (last && line.startsWith('  ')) {
      last.message += ` ${line.trim()}`; // tsc continues long messages on indented lines
    } else if (/error TS\d+:/.test(line)) {
      out.push({ tool: 'types', file: `(${config})`, rule: /TS\d+/.exec(line)?.[0] ?? 'TS', line: 0, col: 0, message: line.trim() });
    }
  }
  if (res.status !== 0 && out.length === 0) {
    throw new Error(`tsc -p ${config} failed without reporting errors:\n${(res.stdout + res.stderr).trim()}`);
  }
  // An error in the tsconfig itself (a removed option, a bad project reference) stops tsc before
  // it checks any code. Baselining it would switch type-checking off while `check` stays green,
  // so it is never a "problem" to tolerate: it fails every command until the config is fixed.
  const broken = out.filter((v) => /(^|\/)tsconfig[^/]*\.json$/.test(v.file) || v.file.startsWith('('));
  if (broken.length) {
    throw new Error(
      `TypeScript can't check ${config}: its config has errors, so no code in it is being type-checked.\n` +
        `${broken.map((v) => `  ${v.file}${v.line ? `:${v.line}:${v.col}` : ''}  ${v.rule}  ${v.message}`).join('\n')}\n` +
        'Fix the tsconfig first (this is never added to the baseline).',
    );
  }
  return out;
}
