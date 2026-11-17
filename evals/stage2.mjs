#!/usr/bin/env node
// Stage 2 evals: regressions for what the live Claude Code session surfaced.
//   node evals/stage2.mjs <project>   (the harness-sandbox, harness installed, baseline written)
//
// Findings these lock in (see docs/BUILD-LOG.md, Stage 2):
//   - the strict tsconfig rejected Map.groupBy (lib was es2023), pushing the agent to worse code
//   - the hook flagged a half-finished change (a parameter added one edit before it's used)
//   - unused names were reported twice, once by lint and once by TypeScript
import { Evals, harness, hookInput, withFiles } from './lib.mjs';

const root = process.argv[2];
if (!root) {
  console.error('usage: node evals/stage2.mjs <project>');
  process.exit(2);
}
const SRC = 'src/domain/report.ts';
/** @param {string[]} args @param {string} [input] */
const run = (args, input) => harness(root, args, input);
/** @param {(s: string) => string} change @template T @param {() => T} fn */
const withSrc = (change, fn) => withFiles(root, { [SRC]: change }, fn);
/** @param {string} s */
const unusedParam = (s) => s.replace('export function summary(tasks: Task[]): string {', 'export function summary(tasks: Task[], file: string): string {');
const evals = new Evals();

evals.case('S1', 'Modern built-ins (Map.groupBy) type-check', () =>
  withSrc((s) => `${s}\nexport const byStatus = (t: Task[]) => Map.groupBy(t, (x) => x.status);\n`, () => {
    const r = run(['check']);
    return [r.code === 0, `exit ${r.code}`];
  }));

evals.case('S2', 'Hook stays quiet on a half-finished change (unused param)', () =>
  withSrc(unusedParam, () => {
    const r = run(['hook'], hookInput(root, SRC));
    return [r.code === 0, `exit ${r.code}, ${r.ms} ms`];
  }));

evals.case('S3', '`check` still fails on the unused param, reported once', () =>
  withSrc(unusedParam, () => {
    const r = run(['check']);
    const mentions = r.out.split('\n').filter((l) => l.includes("'file'")).length;
    return [r.code === 1 && mentions === 1, `exit ${r.code}, reported ${mentions}x`];
  }));

evals.case('S4', 'Hook still blocks real slop, with the mid-change hint', () =>
  withSrc((s) => `${s}\nexport const x: any = 1;\nexport async function f(): Promise<void> { fetch('https://example.com'); }\n`, () => {
    const r = run(['hook'], hookInput(root, SRC));
    const ok = r.code === 2 && r.out.includes('no-explicit-any') && r.out.includes('no-floating-promises') && r.out.includes('partway');
    return [ok, `exit ${r.code}, ${r.ms} ms`];
  }));

evals.case('S5', 'Hook stays under 10 s', () =>
  withSrc((s) => `${s}\nexport const y = 2;\n`, () => {
    const r = run(['hook'], hookInput(root, SRC));
    return [r.code === 0 && r.ms < 10_000, `exit ${r.code}, ${r.ms} ms`];
  }));

evals.report(`Stage 2 evals on ${root}`);
