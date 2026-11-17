// The ratchet: old problems are recorded once and tolerated; new ones fail.
//
// Each problem is fingerprinted by tool, file, rule and the text of its line
// (whitespace-normalized), not its line number. So:
//   - code moving up or down a file doesn't make old problems look new;
//   - adding a new problem to a file that already has some reports only the new one;
//   - editing a line that has an old problem makes it yours: it counts as new.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASELINE_FILE } from './project.mjs';
import { readText, writeText } from './safe-fs.mjs';

/** @import { Baseline, Fingerprinted, Violation } from './types.mjs' */

export const VERSION = 2;

/**
 * Fingerprint violations in place (adds `key`) and return them.
 * @param {string} root
 * @param {Violation[]} violations
 * @returns {Fingerprinted[]}
 */
export function fingerprint(root, violations) {
  /** @type {Map<string, string[]>} */
  const lines = new Map();
  /** @param {string} file @param {number} n */
  const lineOf = (file, n) => {
    if (!lines.has(file)) {
      const path = join(root, file);
      lines.set(file, existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []);
    }
    return (lines.get(file)?.[n - 1] ?? '').trim().replace(/\s+/g, ' ');
  };
  for (const v of violations) {
    const text = createHash('sha1').update(lineOf(v.file, v.line)).digest('hex').slice(0, 10);
    v.key = `${v.tool}|${v.file}|${v.rule}|${text}`;
  }
  return /** @type {Fingerprinted[]} */ (violations);
}

/**
 * How many of each fingerprint.
 * @param {Fingerprinted[]} violations
 * @returns {Record<string, number>}
 */
export function count(violations) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const v of violations) counts[v.key] = (counts[v.key] ?? 0) + 1;
  return counts;
}

/**
 * The committed baseline, or null before `harness baseline` has run.
 * @param {string} root
 * @returns {Baseline | null}
 */
export function readBaseline(root) {
  const text = readText(join(root, BASELINE_FILE)); // refuses a symlink
  /** @type {Baseline | null} */
  let b = null;
  if (text !== null) {
    try {
      b = /** @type {Baseline} */ (JSON.parse(text));
    } catch (err) {
      throw new Error(`.harness/baseline.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }
  if (b && b.version !== VERSION) {
    throw new Error(`.harness/baseline.json is from an older harness (version ${b.version ?? 1}). Delete it and run \`harness baseline\` again.`);
  }
  return b;
}

/**
 * @param {string} root
 * @param {Fingerprinted[]} violations
 * @returns {Baseline}
 */
export function writeBaseline(root, violations) {

  const counts = Object.fromEntries(Object.entries(count(violations)).sort(([a], [b]) => a.localeCompare(b)));
  const body = {
    version: VERSION,
    note: 'Problems that existed when the harness was added. New ones fail; fix these over time and run `harness baseline` to tighten. Never edit by hand: PR checks fail if it grows.',
    total: violations.length,
    counts,
  };
  writeText(root, BASELINE_FILE, `${JSON.stringify(body, null, 2)}\n`, 'replace');
  return body;
}

/**
 * Compare fingerprinted violations with the baseline. `scope` limits it to some
 * files (the hook checks one file). Returns the new violations, the keys that grew
 * and the keys that improved.
 * @param {Fingerprinted[]} violations
 * @param {Baseline | null} baseline
 * @param {{ scope?: Set<string> }} [options]
 * @returns {{ added: Fingerprinted[], grown: { key: string, before: number, now: number }[], improved: string[] }}
 */
export function compare(violations, baseline, { scope } = {}) {
  /** @type {Record<string, number>} */
  const base = baseline?.counts ?? {};
  /** @param {string} key */
  const inScope = (key) => !scope || scope.has(key.split('|')[1] ?? '');
  /** @type {Record<string, number>} */
  const seen = {};
  /** @type {Fingerprinted[]} */
  const added = [];
  for (const v of violations) {
    if (!inScope(v.key)) continue;
    seen[v.key] = (seen[v.key] ?? 0) + 1;
    if ((seen[v.key] ?? 0) > (base[v.key] ?? 0)) added.push(v); // beyond what the baseline allows
  }
  const grown = Object.entries(seen).filter(([k, n]) => n > (base[k] ?? 0)).map(([k, n]) => ({ key: k, before: base[k] ?? 0, now: n }));
  const now = count(violations);
  const improved = Object.entries(base).filter(([k, n]) => inScope(k) && (now[k] ?? 0) < n).map(([k]) => k);
  return { added, grown, improved };
}
