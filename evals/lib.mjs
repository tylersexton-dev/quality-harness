// Shared helpers for the stage evals: run the harness, change files for one case, report a table.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * @typedef {{ code: number | null, out: string, ms: number }} Run
 * @typedef {[pass: boolean, detail: string]} Outcome
 * @typedef {{ id: string, name: string, pass: boolean, detail: string }} Result
 */

/**
 * Run the harness CLI installed in `projectRoot`.
 * @param {string} projectRoot
 * @param {string[]} args
 * @param {string} [input]  stdin (the hook's JSON)
 * @param {string} [cwd]
 * @returns {Run}
 */
export function harness(projectRoot, args, input, cwd = projectRoot) {
  const t0 = Date.now();
  const r = spawnSync(join(resolve(projectRoot), 'node_modules/.bin/harness'), args, { cwd: resolve(cwd), encoding: 'utf8', input });
  // A harness that never ran (wrong path, missing install) must fail loudly, not look like a result.
  if (r.error) throw r.error;
  return { code: r.status, out: `${r.stdout}${r.stderr}`, ms: Date.now() - t0 };
}

/**
 * The JSON Claude Code sends a PostToolUse hook after an Edit.
 * @param {string} root
 * @param {string} file  relative to root
 */
export const hookInput = (root, file) => JSON.stringify({ tool_name: 'Edit', cwd: resolve(root), tool_input: { file_path: join(resolve(root), file) } });

/**
 * Run the hook exactly as Claude Code would: the command from the repo's .claude/settings.json,
 * started at the repo root.
 * @param {string} repo
 * @param {string} file  relative to repo
 * @returns {Run}
 */
export function hookFrom(repo, file) {
  const settings = /** @type {{ hooks: { PostToolUse: { hooks: { command: string }[] }[] } }} */ (JSON.parse(readFileSync(join(repo, '.claude/settings.json'), 'utf8')));
  const entry = settings.hooks.PostToolUse.flatMap((g) => g.hooks).find((h) => h.command.includes('harness hook'));
  if (!entry) throw new Error(`no harness hook in ${repo}/.claude/settings.json`);
  const t0 = Date.now();
  const r = spawnSync('bash', ['-c', entry.command], { cwd: resolve(repo), encoding: 'utf8', input: hookInput(resolve(repo), file) });
  if (r.error) throw r.error;
  return { code: r.status, out: `${r.stdout}${r.stderr}`, ms: Date.now() - t0 };
}

/**
 * Change files for the length of `fn`, then put them back exactly as they were.
 * @template T
 * @param {string} base
 * @param {Record<string, (original: string) => string>} changes  relative path → new content
 * @param {() => T} fn
 * @returns {T}
 */
export function withFiles(base, changes, fn) {
  const originals = Object.keys(changes).map((rel) => /** @type {const} */ ([rel, readFileSync(join(base, rel), 'utf8')]));
  for (const [rel, original] of originals) writeFileSync(join(base, rel), changes[rel]?.(original) ?? original);
  try {
    return fn();
  } finally {
    for (const [rel, original] of originals) writeFileSync(join(base, rel), original);
  }
}

/** Collects eval cases and prints the table. */
export class Evals {
  /** @type {Result[]} */
  results = [];

  /**
   * @param {string} id
   * @param {string} name
   * @param {() => Outcome} fn
   */
  case(id, name, fn) {
    /** @type {Outcome} */
    let outcome;
    try {
      outcome = fn();
    } catch (err) {
      outcome = [false, `threw: ${err instanceof Error ? err.message : String(err)}`];
    }
    this.results.push({ id, name, pass: outcome[0], detail: outcome[1] });
  }

  /**
   * Print the table and exit 1 if anything failed.
   * @param {string} title
   */
  report(title) {
    const width = Math.max(...this.results.map((r) => r.name.length));
    const idWidth = Math.max(...this.results.map((r) => r.id.length)) + 1;
    console.log(`\n${title}\n`);
    for (const r of this.results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(idWidth)} ${r.name.padEnd(width)}  ${r.detail}`);
    const failed = this.results.filter((r) => !r.pass).length;
    console.log(`\n${this.results.length - failed}/${this.results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
}

/** @param {number} ms */
export const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
