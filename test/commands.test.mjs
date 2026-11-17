// The commands people and Claude run, end to end on fixture projects.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { baseline, baselineGrowth, check, hook, test as runTests } from '../lib/commands.mjs';
import { CLEAN, commit, json, project, read, recorder, SLOP, sh, tsProject, write } from './helpers.mjs';

/**
 * The hook's stdin for an edit to `file`.
 * @param {string} root
 * @param {string} file  relative to root
 */
const edit = (root, file) => JSON.stringify({ tool_name: 'Edit', cwd: root, tool_input: { file_path: join(root, file) } });

test('check: passes on clean code, fails on new problems and names them', async (t) => {
  const root = project(t, { ...tsProject(), 'src/a.ts': CLEAN });
  assert.equal(await check({ cwd: root, log: recorder() }), 0);
  write(root, 'src/b.ts', SLOP);
  const log = recorder();
  assert.equal(await check({ cwd: root, log }), 1);
  assert.match(log.text(), /✗ 2 new problem\(s\)/);
  assert.match(log.text(), /src\/b\.ts:1:\d+ {2}\[@typescript-eslint\/no-explicit-any\]/);
  assert.match(log.text(), /root cause/);
});

test('baseline: accepts what exists, so only new problems fail afterwards', async (t) => {
  const root = project(t, { ...tsProject(), 'src/old.ts': SLOP });
  assert.equal(await baseline({ cwd: root, log: recorder() }), 0);
  assert.equal(json(root, '.harness/baseline.json')['total'], 2);
  const ok = recorder();
  assert.equal(await check({ cwd: root, log: ok }), 0);
  assert.match(ok.text(), /2 old ones in the baseline/);
  write(root, 'src/new.ts', 'export const fresh: any = 2;\n');
  const log = recorder();
  assert.equal(await check({ cwd: root, log }), 1);
  assert.match(log.text(), /✗ 1 new problem/);
  assert.doesNotMatch(log.text(), /old\.ts/);
});

test('baseline: refuses to grow, and tightens when problems are fixed', async (t) => {
  const root = project(t, { ...tsProject(), 'src/old.ts': SLOP });
  await baseline({ cwd: root, log: recorder() });
  write(root, 'src/new.ts', 'export const fresh: any = 2;\n');
  const before = read(root, '.harness/baseline.json');
  assert.equal(await baseline({ cwd: root, log: recorder() }), 1);
  assert.equal(read(root, '.harness/baseline.json'), before);

  write(root, 'src/new.ts', CLEAN);
  write(root, 'src/old.ts', CLEAN);
  const log = recorder();
  assert.equal(await check({ cwd: root, log }), 0);
  assert.match(log.text(), /improved: run `harness baseline`/);
  assert.equal(await baseline({ cwd: root, log: recorder() }), 0);
  assert.equal(json(root, '.harness/baseline.json')['total'], 0);
});

test('check and baseline: unreadable files always fail and are never baselined', async (t) => {
  const root = project(t, { ...tsProject(), 'src/a.ts': CLEAN, 'tests/a.test.ts': CLEAN });
  const log = recorder();
  assert.equal(await baseline({ cwd: root, log }), 1);
  assert.match(log.text(), /can't be read/);
  assert.match(log.text(), /`untyped`/);
  assert.equal(await check({ cwd: root, log: recorder() }), 1);
});

test('check and baseline: a broken tsconfig throws a clear error', async (t) => {
  const root = project(t, { ...tsProject(), 'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'node10', types: [] }, include: ['src'] }), 'src/a.ts': CLEAN });
  await assert.rejects(baseline({ cwd: root, log: recorder() }), /its config has errors/);
  await assert.rejects(check({ cwd: root, log: recorder() }), /its config has errors/);
});

test('check --against: fails when the baseline grew compared with that ref', async (t) => {
  const root = project(t, { ...tsProject(), 'src/old.ts': SLOP }, { git: true });
  await baseline({ cwd: root, log: recorder() });
  commit(root, 'baseline');
  const base = sh(root, 'git', 'rev-parse', 'HEAD');
  assert.deepEqual(baselineGrowth(root, base).grown, []);

  // Someone bumps a count by hand, making room to sneak a new problem through later.
  const b = /** @type {import('../lib/types.mjs').Baseline} */ (JSON.parse(read(root, '.harness/baseline.json')));
  const [key, n] = Object.entries(b.counts)[0] ?? assert.fail('baseline has no entries');
  b.counts[key] = n + 1;
  write(root, '.harness/baseline.json', JSON.stringify(b));
  assert.equal(await check({ cwd: root, log: recorder() }), 0, 'without --against the edit goes unnoticed');
  const log = recorder();
  assert.equal(await check({ cwd: root, log, against: base }), 1);
  assert.match(log.text(), /baseline\.json grew/);
  assert.deepEqual(baselineGrowth(root, base).grown.map((g) => [g.before, g.now]), [[1, 2]]);
});

test('check --against: works for a project in a subfolder of the repo', async (t) => {
  const repo = project(t, Object.fromEntries(Object.entries({ ...tsProject(), 'src/a.ts': SLOP }).map(([k, v]) => [`frontend/${k}`, v])), { git: true });
  const root = join(repo, 'frontend');
  await baseline({ cwd: root, log: recorder() });
  commit(repo, 'baseline');
  assert.deepEqual(baselineGrowth(root, 'HEAD'), { grown: [] });
  assert.match(baselineGrowth(root, 'HEAD~1').note ?? '', /no baseline on HEAD~1/);
  assert.throws(() => baselineGrowth(root, '--output=/tmp/x'), /needs a git ref/);
});

test('hook: blocks an edit that adds problems, with file, rule and the mid-change hint', async (t) => {
  const root = project(t, { ...tsProject(), 'src/a.ts': SLOP });
  const log = recorder();
  assert.equal(await hook({ stdin: edit(root, 'src/a.ts'), cwd: root, log }), 2);
  assert.match(log.text(), /2 new problem\(s\) in src\/a\.ts/);
  assert.match(log.text(), /no-floating-promises/);
  assert.match(log.text(), /partway through a multi-step change/);
});

test('hook: reports only the edited file, and only what the baseline does not cover', async (t) => {
  const root = project(t, { ...tsProject(), 'src/old.ts': SLOP, 'src/a.ts': CLEAN });
  await baseline({ cwd: root, log: recorder() });
  write(root, 'src/other.ts', SLOP); // a problem elsewhere is not this edit's business
  assert.equal(await hook({ stdin: edit(root, 'src/a.ts'), cwd: root, log: recorder() }), 0);
  assert.equal(await hook({ stdin: edit(root, 'src/old.ts'), cwd: root, log: recorder() }), 0);
});

test('hook: catches type errors in the edited file', async (t) => {
  const root = project(t, { ...tsProject(), 'src/a.ts': "export const n: number = 'x';\n" });
  const log = recorder();
  assert.equal(await hook({ stdin: edit(root, 'src/a.ts'), cwd: root, log }), 2);
  assert.match(log.text(), /TS2322/);
});

test('hook: leaves unused names to `check` (a change in progress)', async (t) => {
  const root = project(t, { ...tsProject(), 'src/a.ts': 'export function f(a: number, unusedYet: string): number {\n  return a;\n}\n' });
  assert.equal(await hook({ stdin: edit(root, 'src/a.ts'), cwd: root, log: recorder() }), 0);
  assert.equal(await check({ cwd: root, log: recorder() }), 1);
});

test('hook: lets through non-code, files outside any project, node_modules and bad input', async (t) => {
  const root = project(t, { ...tsProject(), 'README.md': '# x', 'node_modules/dep/index.ts': 'export const x: any = 1;\n' });
  const outside = project(t, { 'package.json': '{}', 'src/a.ts': SLOP });
  /** @param {string} stdin */
  const quiet = async (stdin) => {
    const log = recorder();
    assert.equal(await hook({ stdin, cwd: root, log }), 0);
    assert.equal(log.text(), '');
  };
  await quiet(edit(root, 'README.md'));
  await quiet(edit(root, 'node_modules/dep/index.ts'));
  await quiet(edit(outside, 'src/a.ts')); // no harness.config.json above it
  await quiet('not json');
  await quiet('{}');
  await quiet(JSON.stringify({ tool_input: {} }));
});

test('hook: finds the project from the edited file, wherever Claude was started', async (t) => {
  const repo = project(t, Object.fromEntries(Object.entries({ ...tsProject(), 'src/a.ts': SLOP }).map(([k, v]) => [`frontend/${k}`, v])));
  assert.equal(await hook({ stdin: edit(repo, 'frontend/src/a.ts'), cwd: repo, log: recorder() }), 2);
  const relative = JSON.stringify({ tool_input: { file_path: 'frontend/src/a.ts' } });
  assert.equal(await hook({ stdin: relative, cwd: repo, log: recorder() }), 2);
});

test('test: runs the configured command and returns its exit code; none configured is a pass', (t) => {
  const pass = project(t, { 'harness.config.json': JSON.stringify({ test: 'node -e "process.exit(0)"' }) });
  const fail = project(t, { 'harness.config.json': JSON.stringify({ test: 'node -e "process.exit(3)"' }) });
  const none = project(t, { 'harness.config.json': JSON.stringify({ test: '' }) });
  assert.equal(runTests({ cwd: pass, log: recorder() }), 0);
  assert.equal(runTests({ cwd: fail, log: recorder() }), 3);
  const log = recorder();
  assert.equal(runTests({ cwd: none, log }), 0);
  assert.match(log.text(), /skipping tests/);
});
