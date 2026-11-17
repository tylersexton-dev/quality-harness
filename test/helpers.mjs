// Fixture projects for the tests: real folders in the temp dir, cleaned up after each test.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** @import { TestContext } from 'node:test' */
/** @import { Log } from '../lib/types.mjs' */

export const HARNESS = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Make a project from a map of relative path → content, removed when the test ends.
 * @param {TestContext} t
 * @param {Record<string, string>} files
 * @param {{ git?: boolean }} [options]  git: init a repo and commit everything
 * @returns {string} the project's absolute path
 */
export function project(t, files, { git = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'harness-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  if (git) {
    sh(root, 'git', 'init', '-q');
    commit(root, 'start');
  }
  return root;
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {string} content
 */
export function write(root, rel, content) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/**
 * @param {string} root
 * @param {string} rel
 */
export const read = (root, rel) => readFileSync(join(root, rel), 'utf8');

/**
 * A JSON file's top-level fields, for asserting on (values stay `unknown`).
 * @param {string} root
 * @param {string} rel
 * @returns {Record<string, unknown>}
 */
export const json = (root, rel) => /** @type {Record<string, unknown>} */ (JSON.parse(read(root, rel)));

/**
 * Run a command, failing the test with its output if it fails.
 * @param {string} cwd
 * @param {string} cmd
 * @param {...string} args
 */
export function sh(cwd, cmd, ...args) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}

/**
 * @param {string} root
 * @param {string} message
 */
export function commit(root, message) {
  sh(root, 'git', 'add', '-A');
  sh(root, 'git', '-c', 'user.email=test@local', '-c', 'user.name=test', 'commit', '-q', '--allow-empty', '-m', message);
}

/** A Log that records everything, for asserting on messages. */
export function recorder() {
  /** @type {string[]} */
  const out = [];
  /** @type {Log & { out: string[], text: () => string }} */
  const log = {
    out,
    log: (...a) => out.push(a.join(' ')),
    error: (...a) => out.push(a.join(' ')),
    text: () => out.join('\n'),
  };
  return log;
}

/**
 * The files a set-up TypeScript project needs, wired to this checkout of the harness (not an
 * installed copy): config, ESLint config, a strict tsconfig. `types: []` because fixtures have
 * no node_modules for @types/node.
 * @param {Record<string, unknown>} [config]  harness.config.json overrides
 */
export function tsProject(config = {}) {
  const eslint = pathToFileURL(join(HARNESS, 'config/eslint.mjs')).href;
  return {
    'package.json': JSON.stringify({ name: 'fixture', type: 'module' }),
    'harness.config.json': JSON.stringify({ test: '', boundaries: [], ignore: [], typeChecked: true, hook: { typecheck: true }, ...config }),
    'eslint.config.mjs': `import harness from '${eslint}';\nimport config from './harness.config.json' with { type: 'json' };\nexport default harness({ ...config, root: import.meta.dirname });\n`,
    'tsconfig.json': JSON.stringify({ extends: join(HARNESS, 'config/tsconfig.base.json'), compilerOptions: { types: [] }, include: ['src'] }),
  };
}

/** Clean source: no problems under the harness rules. */
export const CLEAN = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
/** Two problems: an explicit any, and a promise nobody awaits. */
export const SLOP = 'export const loose: any = 1;\nexport async function later(): Promise<void> {\n  Promise.resolve();\n}\n';
