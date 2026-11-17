// check, baseline, hook, ci: the commands that run in a project.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { lint, types } from './checks.mjs';
import { findRoot, isSetUp, loadConfig } from './project.mjs';
import { compare, fingerprint, readBaseline, writeBaseline } from './ratchet.mjs';

/** @import { Baseline, Fingerprinted, Log, Violation } from './types.mjs' */

const LINTABLE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;

/**
 * One line per problem, for people and for Claude.
 * @param {Violation[]} violations
 * @param {{ limit?: number }} [options]
 */
export function format(violations, { limit = 40 } = {}) {
  const lines = violations
    .slice(0, limit)
    .map((v) => `  ${v.file}:${v.line}:${v.col}  ${v.tool === 'types' ? v.rule : `[${v.rule}]`}  ${v.message}`);
  if (violations.length > limit) lines.push(`  …and ${violations.length - limit} more`);
  return lines.join('\n');
}

/**
 * A file ESLint can't parse gets no lint at all: a syntax error, or a .ts file no tsconfig
 * includes. Baselining that would leave the file unchecked forever, so these always fail.
 * @param {Violation[]} violations
 * @param {Log} log
 */
function unreadable(violations, log) {
  const bad = violations.filter((v) => v.rule === 'parse-error');
  if (!bad.length) return false;
  const outside = bad.some((v) => v.message.includes('not found by the project service'));
  log.error(`✗ ${bad.length} file(s) can't be read, so nothing in them is checked (never added to the baseline):\n${format(bad)}`);
  if (outside) log.error('\nFor .ts files no tsconfig includes: add them to a tsconfig, or list their globs in `untyped` in harness.config.json (they then get every rule that doesn\'t need type information).');
  return true;
}

/**
 * Every problem in the project, fingerprinted.
 * @param {string} root
 * @returns {Promise<Fingerprinted[]>}
 */
async function collect(root) {
  const [l, t] = [await lint(root), types(root)];
  return fingerprint(root, [...t, ...l]);
}

/**
 * The baseline must only ever shrink. Compared with the base branch's copy, a
 * grown count means someone (or some agent) edited the baseline to let a new
 * problem through. That's an escape hatch, so it fails.
 * @param {string} root
 * @param {string} ref  a git ref, like origin/main
 * @returns {{ grown: { key: string, before: number, now: number }[], note?: string }}
 */
export function baselineGrowth(root, ref) {
  if (ref.startsWith('-')) throw new Error(`--against needs a git ref like origin/main, not "${ref}"`);
  // `ref:./path` is relative to cwd, so this works when the project is a subfolder of the repo.
  const res = spawnSync('git', ['show', `${ref}:./.harness/baseline.json`], { cwd: root, encoding: 'utf8' });
  if (res.status !== 0) return { grown: [], note: `no baseline on ${ref} yet` };
  /** @type {Record<string, number>} */
  let before;
  try {
    before = /** @type {Partial<Baseline>} */ (JSON.parse(res.stdout)).counts ?? {};
  } catch {
    return { grown: [], note: `baseline on ${ref} is not valid JSON` };
  }
  const now = readBaseline(root)?.counts ?? {};
  const grown = Object.entries(now).filter(([k, n]) => n > (before[k] ?? 0)).map(([k, n]) => ({ key: k, before: before[k] ?? 0, now: n }));
  return { grown };
}

/**
 * harness check: fail on any problem the baseline doesn't already cover.
 * @param {{ cwd?: string, log?: Log, against?: string }} [options]
 * @returns {Promise<number>} exit code
 */
export async function check({ cwd = process.cwd(), log = console, against } = {}) {
  const root = findRoot(cwd);
  if (against) {
    const { grown, note } = baselineGrowth(root, against);
    if (note) log.log(`(baseline guard: ${note})`);
    if (grown.length) {
      log.error(`✗ .harness/baseline.json grew compared with ${against}. The baseline only shrinks; fix the new problems instead:\n${grown.map((g) => `  ${g.key.split('|').slice(0, 3).join('  ')}  ${g.before} → ${g.now}`).join('\n')}`);
      return 1;
    }
  }
  const baseline = readBaseline(root);
  const violations = await collect(root);
  if (unreadable(violations, log)) return 1;
  const { added, improved } = compare(violations, baseline);
  if (!baseline) log.log('No baseline yet: every problem counts. Run `harness baseline` once to accept what exists today.');
  if (added.length) {
    log.error(`✗ ${added.length} new problem(s):\n${format(added)}`);
    log.error('\nFix the root cause. Don\'t add a comment or a disable to get around it.');
    return 1;
  }
  const tolerated = violations.length;
  log.log(`✓ No new problems${tolerated ? ` (${tolerated} old ones in the baseline)` : ''}.`);
  if (improved.length) log.log(`  ${improved.length} baseline entr${improved.length === 1 ? 'y' : 'ies'} improved: run \`harness baseline\` to lock that in.`);
  return 0;
}

/**
 * harness baseline: record today's problems so only new ones fail.
 * @param {{ cwd?: string, log?: Log }} [options]
 * @returns {Promise<number>} exit code
 */
export async function baseline({ cwd = process.cwd(), log = console } = {}) {
  const root = findRoot(cwd);
  const before = readBaseline(root);
  const violations = await collect(root);
  if (unreadable(violations, log)) return 1;
  if (before) {
    const { added } = compare(violations, before);
    if (added.length) {
      log.error(`✗ Refusing to grow the baseline: ${added.length} new problem(s). Fix them first:\n${format(added)}`);
      return 1;
    }
  }
  const body = writeBaseline(root, violations);
  log.log(`✓ Baseline ${before ? 'tightened' : 'written'}: ${body.total} existing problem(s) in .harness/baseline.json. Commit it.`);
  return 0;
}

// Problems the hook leaves to `harness check`. Unused names are almost always a change in
// progress (a parameter added one edit before it's used), so flagging them mid-edit is noise.
// `check` and CI still fail on them.
const DEFERRED = new Set(['@typescript-eslint/no-unused-vars', 'no-unused-vars']);

/**
 * harness hook: Claude Code PostToolUse hook for Edit/Write/MultiEdit.
 * Reads the hook JSON on stdin; lints the edited file (and type-checks if enabled).
 * Exit 2 sends stderr back to Claude so it fixes the problem before moving on.
 * @param {{ stdin?: string, cwd?: string, log?: Log }} [options]
 * @returns {Promise<number>} 0 = carry on, 2 = problems sent back to Claude
 */
export async function hook({ stdin = readFileSync(0, 'utf8'), cwd = process.cwd(), log = console } = {}) {
  /** @type {{ cwd?: string, tool_input?: { file_path?: string, path?: string } } | null} */
  let input;
  try {
    input = /** @type {typeof input} */ (JSON.parse(stdin || '{}'));
  } catch {
    return 0; // not our input; never block on a parse problem
  }
  const file = input?.tool_input?.file_path ?? input?.tool_input?.path;
  if (!file || !LINTABLE.test(file)) return 0;
  const abs = isAbsolute(file) ? file : resolve(input?.cwd ?? cwd, file);
  // The project is wherever the edited file's nearest harness.config.json is, so one hook in the
  // repo root serves a subfolder project (Prism's frontend/) or a whole workspace (AgentFlow).
  let root;
  try {
    root = findRoot(dirname(abs));
  } catch {
    return 0;
  }
  if (!isSetUp(root)) return 0; // a file outside any harness project
  const rel = relative(root, abs).split(sep).join('/');
  if (rel.startsWith('..') || rel.includes('node_modules/')) return 0;
  const config = loadConfig(root);
  const base = readBaseline(root);
  const found = await lint(root, [abs]);
  if (config.hook.typecheck) {
    try {
      found.push(...types(root, { incremental: true, file: rel }).filter((v) => v.file === rel));
    } catch {
      // A broken tsconfig fails `harness check` loudly; here, still report the lint findings.
    }
  }
  const now = found.filter((v) => !DEFERRED.has(v.rule));
  const { added } = compare(fingerprint(root, now), base, { scope: new Set([rel]) });
  if (!added.length) return 0;
  log.error(
    `quality-harness: ${added.length} new problem(s) in ${rel}. Fix the root cause (no comments or disables to get around it):\n${format(added)}\n` +
      `If you're partway through a multi-step change and the next edit resolves this, finish the change; the hook re-checks after every edit.`,
  );
  return 2;
}

/**
 * harness test: run the project's test command from harness.config.json.
 * @param {{ cwd?: string, log?: Log }} [options]
 * @returns {number} exit code
 */
export function test({ cwd = process.cwd(), log = console } = {}) {
  const root = findRoot(cwd);
  const { test: command } = loadConfig(root);
  if (!command) {
    log.log('No test command in harness.config.json; skipping tests.');
    return 0;
  }
  log.log(`$ ${command}`);
  const res = spawnSync(command, { cwd: root, stdio: 'inherit', shell: true });
  return res.status ?? 1;
}

/**
 * harness ci: check, then tests. What the PR workflow runs.
 * @param {{ cwd?: string, log?: Log, against?: string }} [opts]
 * @returns {Promise<number>} exit code
 */
export async function ci(opts = {}) {
  const code = await check(opts);
  if (code !== 0) return code;
  return test(opts);
}
