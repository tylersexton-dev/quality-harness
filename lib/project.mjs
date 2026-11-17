// Finding the project and reading its harness.config.json.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** @import { HarnessConfig, PackageJson } from './types.mjs' */

export const CONFIG_FILE = 'harness.config.json';
export const BASELINE_FILE = join('.harness', 'baseline.json');

/** @type {HarnessConfig} */
export const DEFAULT_CONFIG = {
  test: 'npm test',
  boundaries: [],
  ignore: [],
  typeChecked: true,
  hook: { typecheck: true },
};

/**
 * The project root: the nearest folder at or above `start` with a harness.config.json, so a
 * file deep in a workspace (apps/api/src/x.ts) belongs to the harness set up at the repo root.
 * Before init has run there's no config yet, so fall back to the nearest package.json.
 * @param {string} [start]
 * @returns {string}
 */
export function findRoot(start = process.cwd()) {
  let dir = resolve(start);
  let firstPackage = null;
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    if (!firstPackage && existsSync(join(dir, 'package.json'))) firstPackage = dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (firstPackage) return firstPackage;
  throw new Error(`No package.json found at or above ${start}`);
}

/** Is the harness set up here (init has run)? @param {string} root */
export const isSetUp = (root) => existsSync(join(root, CONFIG_FILE));

/**
 * The git repo root, where .github/ and .claude/ have to live. Falls back to `root`.
 * @param {string} root
 */
export function gitRoot(root) {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  return res.status === 0 ? resolve(res.stdout.trim()) : root;
}

/**
 * `root` relative to the repo root, posix-style: '' for a project at the repo root, 'frontend' for a subfolder.
 * @param {string} root
 */
export const subPath = (root) => relative(gitRoot(root), root).split(sep).join('/');

/**
 * Parse a JSON file. Callers say what shape they expect; a missing file gives `fallback`.
 * @param {string} path
 * @param {unknown} fallback
 * @returns {unknown}
 */
export function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return /** @type {unknown} */ (JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/**
 * harness.config.json with defaults for anything it leaves out.
 * @param {string} root
 * @returns {HarnessConfig}
 */
export function loadConfig(root) {
  const user = /** @type {Partial<HarnessConfig>} */ (readJson(join(root, CONFIG_FILE), {}));
  return { ...DEFAULT_CONFIG, ...user, hook: { ...DEFAULT_CONFIG.hook, ...(user.hook ?? {}) } };
}

/**
 * Workspace folders from package.json `workspaces` (plain paths and one-level `dir/*` globs).
 * @param {string} root
 * @returns {string[]}
 */
export function workspaceDirs(root) {
  const pkg = /** @type {PackageJson} */ (readJson(join(root, 'package.json'), {}));
  const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
  /** @type {string[]} */
  const dirs = [];
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const parent = join(root, pattern.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const e of readdirSync(parent, { withFileTypes: true })) if (e.isDirectory()) dirs.push(join(pattern.slice(0, -2), e.name));
    } else if (!pattern.includes('*')) dirs.push(pattern);
  }
  return dirs;
}

/**
 * The tsconfig files to type-check, relative to the root. `tsconfigs` in harness.config.json
 * wins; otherwise the root tsconfig.json, or else each workspace's own tsconfig.json.
 * @param {string} root
 * @param {HarnessConfig} [config]
 * @returns {string[]}
 */
export function tsconfigs(root, config = loadConfig(root)) {
  if (Array.isArray(config.tsconfigs)) return config.tsconfigs;
  if (existsSync(join(root, 'tsconfig.json'))) return ['tsconfig.json'];
  return workspaceDirs(root)
    .map((d) => `${d.split(sep).join('/')}/tsconfig.json`)
    .filter((f) => existsSync(join(root, f)));
}

/** Does the project have TypeScript to check? @param {string} root */
export const hasTsconfig = (root) => tsconfigs(root).length > 0;
