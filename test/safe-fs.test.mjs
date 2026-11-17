// Hostile repos: symlinks that try to make `harness init` write outside the repo.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { baseline } from '../lib/commands.mjs';
import { init } from '../lib/init.mjs';
import { readText, safeToWrite, writeText } from '../lib/safe-fs.mjs';
import { CLEAN, project, recorder, tsProject } from './helpers.mjs';

/** @import { TestContext } from 'node:test' */

/**
 * A folder outside the repo standing in for the user's home, with a file to protect.
 * @param {TestContext} t
 */
function outside(t) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-victim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, '.zshrc');
  writeFileSync(file, 'export PATH=/usr/bin\n');
  return { dir, file, untouched: () => readFileSync(file, 'utf8') === 'export PATH=/usr/bin\n' };
}

/** @param {string} root */
const runInit = (root) => init({ cwd: root, log: recorder() });

test('a CLAUDE.md that is a symlink to a file outside the repo is refused, and the file is untouched', (t) => {
  const victim = outside(t);
  const root = project(t, { 'package.json': '{}' }, { git: true });
  symlinkSync(victim.file, join(root, 'CLAUDE.md'));
  assert.throws(() => runInit(root), /refusing to use .*CLAUDE\.md: it is a symlink/);
  assert.ok(victim.untouched());
});

test('a .claude/ folder that is a symlink outside the repo is refused', (t) => {
  const victim = outside(t);
  const root = project(t, { 'package.json': '{}' }, { git: true });
  symlinkSync(victim.dir, join(root, '.claude'));
  assert.throws(() => runInit(root), /refusing to write .*: its folder leads outside/);
  assert.ok(victim.untouched());
  assert.throws(() => readFileSync(join(victim.dir, 'settings.json')), /ENOENT/, 'nothing was created out there');
});

test('symlinked package.json, .gitignore and workflow folders are all refused', (t) => {
  for (const [rel, makeLink] of /** @type {const} */ ([
    ['package.json', 'file'],
    ['.gitignore', 'file'],
    ['.github', 'dir'],
  ])) {
    const victim = outside(t);
    const root = project(t, { 'package.json': '{}', 'CLAUDE.md': '# x\n' }, { git: true });
    rmSync(join(root, rel), { force: true });
    symlinkSync(makeLink === 'dir' ? victim.dir : victim.file, join(root, rel));
    assert.throws(() => runInit(root), /refusing/, `${rel} as a symlink must be refused`);
    assert.ok(victim.untouched(), `${rel}: the file outside is untouched`);
  }
});

test('writeText: create is atomic and never overwrites; replace and append work; reads refuse symlinks', (t) => {
  const root = project(t, {});
  assert.equal(writeText(root, 'a/b.txt', 'one', 'create'), true);
  assert.equal(writeText(root, 'a/b.txt', 'two', 'create'), false);
  assert.equal(readText(join(root, 'a/b.txt')), 'one');
  writeText(root, 'a/b.txt', 'three', 'replace');
  writeText(root, 'a/b.txt', '+', 'append');
  assert.equal(readText(join(root, 'a/b.txt')), 'three+');
  assert.equal(readText(join(root, 'missing.txt')), null);

  const victim = outside(t);
  symlinkSync(victim.file, join(root, 'link.txt'));
  assert.throws(() => readText(join(root, 'link.txt')), /it is a symlink/);
  assert.throws(() => writeText(root, 'link.txt', 'x', 'replace'), /it is a symlink/);
  assert.throws(() => writeText(root, 'link.txt', 'x', 'append'), /it is a symlink/);
  assert.equal(writeText(root, 'link.txt', 'x', 'create'), false, 'create never touches an existing entry, link or not');
  assert.ok(victim.untouched());
  assert.throws(() => writeText(root, '../escape.txt', 'x', 'replace'), /leads outside/);
});

test('normal folders, including real nested ones, still work', (t) => {
  const root = project(t, { 'package.json': '{}', 'src/a.ts': 'export {};\n' }, { git: true });
  mkdirSync(join(root, '.claude/skills'), { recursive: true });
  assert.equal(runInit(root), 0);
  assert.ok(readText(join(root, '.claude/skills/verify-change/SKILL.md')));
});

test('a .harness/baseline.json symlink is refused instead of overwritten', async (t) => {
  const victim = outside(t);
  const root = project(t, { ...tsProject(), 'src/a.ts': CLEAN });
  mkdirSync(join(root, '.harness'));
  symlinkSync(victim.file, join(root, '.harness/baseline.json'));
  await assert.rejects(baseline({ cwd: root, log: recorder() }), /refusing|symlink/);
  assert.ok(victim.untouched());
});

test('tsc only gets a cache path inside the project that is not a symlink', (t) => {
  const victim = outside(t);
  const root = project(t, {});
  assert.equal(safeToWrite(root, '.harness/tsbuildinfo'), true);
  symlinkSync(victim.file, join(root, '.harness/tsbuildinfo-x'));
  assert.equal(safeToWrite(root, '.harness/tsbuildinfo-x'), false);
  const other = project(t, {});
  symlinkSync(victim.dir, join(other, '.harness'));
  assert.equal(safeToWrite(other, '.harness/tsbuildinfo'), false);
  assert.ok(victim.untouched());
});
