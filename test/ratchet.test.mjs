import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compare, count, fingerprint, readBaseline, VERSION, writeBaseline } from '../lib/ratchet.mjs';
import { project, read, write } from './helpers.mjs';

/** @import { Violation } from '../lib/types.mjs' */

/**
 * @param {string} file
 * @param {number} line
 * @param {string} [rule]
 * @returns {Violation}
 */
const v = (file, line, rule = 'no-explicit-any') => ({ tool: 'lint', file, rule, line, col: 1, message: 'm' });

test('fingerprints by line text, so moving code keeps the same key', (t) => {
  const root = project(t, { 'a.ts': 'const x: any = 1;\n' });
  const [before] = fingerprint(root, [v('a.ts', 1)]);
  write(root, 'a.ts', '\n\n// header\nconst x: any = 1;\n');
  const [after] = fingerprint(root, [v('a.ts', 4)]);
  assert.equal(after?.key, before?.key);
});

test('whitespace changes on the line keep the key; content changes make it new', (t) => {
  const root = project(t, { 'a.ts': 'const x: any = 1;\n    const   x:  any =  1;\nconst y: any = 2;\n' });
  const [a, b, c] = fingerprint(root, [v('a.ts', 1), v('a.ts', 2), v('a.ts', 3)]);
  assert.equal(a?.key, b?.key);
  assert.notEqual(a?.key, c?.key);
});

test('key separates tool, file and rule', (t) => {
  const root = project(t, { 'a.ts': 'x\n', 'b.ts': 'x\n' });
  const keys = fingerprint(root, [v('a.ts', 1), v('b.ts', 1), v('a.ts', 1, 'eqeqeq'), { ...v('a.ts', 1), tool: 'types' }]).map((f) => f.key);
  assert.equal(new Set(keys).size, 4);
});

test('a missing file or line still fingerprints (file-level problems)', (t) => {
  const root = project(t, {});
  const [f] = fingerprint(root, [{ tool: 'types', file: '(tsconfig.json)', rule: 'TS5108', line: 0, col: 0, message: 'm' }]);
  assert.match(f?.key ?? '', /^types\|\(tsconfig\.json\)\|TS5108\|[0-9a-f]{10}$/);
});

test('compare reports only occurrences beyond the baseline count', (t) => {
  const root = project(t, { 'a.ts': 'const x: any = 1;\n' });
  const old = fingerprint(root, [v('a.ts', 1), v('a.ts', 1)]);
  const baseline = { version: VERSION, total: 2, counts: count(old) };
  assert.equal(compare(old, baseline).added.length, 0);
  const three = fingerprint(root, [v('a.ts', 1), v('a.ts', 1), v('a.ts', 1)]);
  const { added, grown } = compare(three, baseline);
  assert.equal(added.length, 1);
  assert.deepEqual(grown.map((g) => [g.before, g.now]), [[2, 3]]);
});

test('compare with no baseline counts everything as new', (t) => {
  const root = project(t, { 'a.ts': 'x\n' });
  assert.equal(compare(fingerprint(root, [v('a.ts', 1)]), null).added.length, 1);
});

test('compare lists improved keys, and scope limits everything to those files', (t) => {
  const root = project(t, { 'a.ts': 'one\n', 'b.ts': 'two\n' });
  const before = fingerprint(root, [v('a.ts', 1), v('b.ts', 1)]);
  const baseline = { version: VERSION, total: 2, counts: count(before) };
  const now = fingerprint(root, [v('b.ts', 1), v('b.ts', 1)]); // a.ts fixed, b.ts got worse
  assert.equal(compare(now, baseline).improved.length, 1);
  assert.equal(compare(now, baseline).added.length, 1);
  const scoped = compare(now, baseline, { scope: new Set(['a.ts']) });
  assert.equal(scoped.added.length, 0);
  assert.equal(scoped.improved.length, 1);
});

test('baseline round-trips, sorted, with version and total', (t) => {
  const root = project(t, { 'a.ts': 'b\na\n' });
  const body = writeBaseline(root, fingerprint(root, [v('a.ts', 2), v('a.ts', 1)]));
  assert.equal(body.total, 2);
  assert.deepEqual(readBaseline(root), body);
  const keys = Object.keys(body.counts);
  assert.deepEqual(keys, [...keys].sort((x, y) => x.localeCompare(y)));
  assert.ok(read(root, '.harness/baseline.json').endsWith('\n'));
});

test('no baseline file reads as null; an older version is refused', (t) => {
  const root = project(t, {});
  assert.equal(readBaseline(root), null);
  write(root, '.harness/baseline.json', JSON.stringify({ version: 1, counts: {} }));
  assert.throws(() => readBaseline(root), /older harness/);
});
