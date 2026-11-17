#!/usr/bin/env node
// Stage 1 evals: does the core do what the talks say it should?
//   node evals/stage1.mjs <project> <source file>
//   A real TypeScript project with the harness installed and a baseline written, and one of its
//   source files (relative path) to change. The first run used a production Node service.
//
// Each eval makes a change, runs the harness, checks the outcome, and puts the
// project back exactly as it was. Prints a pass/fail table; exits 1 on any failure.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Evals, harness, hookInput, secs, withFiles } from './lib.mjs';

const [root, SRC] = process.argv.slice(2);
if (!root || !SRC) {
  console.error('usage: node evals/stage1.mjs <project> <source file, relative to the project>');
  process.exit(2);
}
const SLOP = '\nexport const sloppy: any = JSON.parse("{}");\nexport async function later(): Promise<void> { fetch("https://example.com"); }\n';
/** @param {string[]} args @param {string} [input] */
const run = (args, input) => harness(root, args, input);
/** @param {(s: string) => string} change @template T @param {() => T} fn */
const withSrc = (change, fn) => withFiles(root, { [SRC]: change }, fn);
const evals = new Evals();

evals.case('E1', 'Untouched code passes check', () => {
  const r = run(['check']);
  return [r.code === 0, `exit ${r.code}, ${secs(r.ms)}`];
});

evals.case('E2', 'New `any` + un-awaited promise fail check, and only those', () =>
  withSrc((s) => s + SLOP, () => {
    const r = run(['check']);
    const n = Number(/✗ (\d+) new problem/.exec(r.out)?.[1] ?? -1);
    const both = r.out.includes('no-explicit-any') && r.out.includes('no-floating-promises');
    return [r.code === 1 && both && n === 2, `exit ${r.code}, ${n} new, names both rules: ${both}`];
  }));

evals.case('E3', 'Hook blocks the edit and tells the agent to fix the root cause', () =>
  withSrc((s) => s + SLOP, () => {
    const r = run(['hook'], hookInput(root, SRC));
    const teaches = r.out.includes(SRC) && /root cause/i.test(r.out);
    return [r.code === 2 && teaches, `exit ${r.code} (2 = sent back to Claude), names file + root cause: ${teaches}`];
  }));

evals.case('E4', 'Hook lets clean edits, non-code files and bad input through', () => {
  const clean = run(['hook'], hookInput(root, SRC));
  const md = run(['hook'], hookInput(root, 'README.md'));
  const junk = run(['hook'], 'not json');
  return [clean.code === 0 && md.code === 0 && junk.code === 0, `clean ${clean.code}, README ${md.code}, junk ${junk.code}`];
});

evals.case('E5', 'Running init again changes nothing', () => {
  const r = run(['init']);
  const lines = r.out.split('\n').filter((l) => /^(added|updated|kept|skipped|note)\s/.test(l));
  const changed = lines.filter((l) => /^(added|updated)/.test(l));
  return [r.code === 0 && lines.length > 0 && changed.length === 0, changed.length ? `changed: ${changed.join('; ')}` : `${lines.length} steps, none changed anything`];
});

evals.case('E6', 'Baseline refuses to absorb new problems', () =>
  withSrc((s) => s + SLOP, () => {
    const path = join(root, '.harness/baseline.json');
    const before = readFileSync(path, 'utf8');
    const r = run(['baseline']);
    const after = readFileSync(path, 'utf8');
    return [r.code === 1 && before === after, `exit ${r.code}, baseline file unchanged: ${before === after}`];
  }));

evals.case('E7', 'Folder boundary catches a forbidden import, with its message', () =>
  withFiles(root, {
    'harness.config.json': (s) => {
      const c = /** @type {Record<string, unknown>} */ (JSON.parse(s));
      c['boundaries'] = [{ files: [`${dirname(SRC)}/**`], disallow: ['**/forbidden/**'], message: 'Eval boundary: this folder never imports from forbidden/.' }];
      return JSON.stringify(c, null, 2);
    },
    [SRC]: (s) => `import { handler as _h } from './forbidden/handler.ts';\n${s}`,
  }, () => {
    const r = run(['check']);
    const ok = r.out.includes('no-restricted-imports') && r.out.includes('never imports from forbidden');
    return [r.code === 1 && ok, `exit ${r.code}, rule + custom message shown: ${ok}`];
  }));

evals.case('E8', 'Hook is fast enough to run on every edit (< 10s)', () => {
  run(['hook'], hookInput(root, SRC)); // warm the incremental type cache, as a real session would
  const r = run(['hook'], hookInput(root, SRC));
  return [r.code === 0 && r.ms < 10_000, `${secs(r.ms)} warm`];
});

evals.case('E9', 'Escape hatches fail: unexplained eslint-disable and @ts-ignore', () =>
  withSrc((s) => `${s}\n// eslint-disable-next-line @typescript-eslint/no-explicit-any\nexport const a: any = 1;\n// @ts-ignore\nexport const b: number = 'x';\n`, () => {
    const r = run(['check']);
    const both = r.out.includes('require-description') && r.out.includes('ban-ts-comment');
    return [r.code === 1 && both, `exit ${r.code}, both caught: ${both}`];
  }));

evals.case('E10', 'Hand-editing the baseline to sneak a problem in fails on PRs', () => {
  /** @param {string[]} a */
  const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  git('add', '.harness/baseline.json');
  git('-c', 'user.email=eval@local', '-c', 'user.name=eval', 'commit', '-q', '-m', 'eval: baseline as on main', '--allow-empty');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  try {
    return withFiles(root, {
      '.harness/baseline.json': (s) => {
        const b = /** @type {{ counts: Record<string, number> }} */ (JSON.parse(s));
        const [k, n = 0] = Object.entries(b.counts)[0] ?? ['none'];
        b.counts[k] = n + 1;
        return JSON.stringify(b, null, 2);
      },
    }, () => {
      const r = run(['check', '--against', base]);
      return [r.code === 1 && r.out.includes('baseline.json grew'), `exit ${r.code}, guard message: ${r.out.includes('baseline.json grew')}`];
    });
  } finally {
    git('reset', '-q', '--soft', 'HEAD~1');
  }
});

evals.case('E11', 'Moving code around doesn\'t make old problems look new', () =>
  withSrc((s) => `\n\n\n// a header someone added\n\n${s}`, () => {
    const r = run(['check']);
    return [r.code === 0, `exit ${r.code} after shifting every line of ${SRC} down 5`];
  }));

evals.report(`Stage 1 evals on ${root}`);
