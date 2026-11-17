import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG, findRoot, gitRoot, isSetUp, loadConfig, readJson, subPath, tsconfigs, workspaceDirs } from '../lib/project.mjs';
import { project, write } from './helpers.mjs';

test('findRoot prefers the nearest harness.config.json over a nearer package.json', (t) => {
  const root = project(t, { 'package.json': '{}', 'harness.config.json': '{}', 'apps/api/package.json': '{}', 'apps/api/src/x.ts': '' });
  assert.equal(findRoot(join(root, 'apps/api/src')), root);
});

test('findRoot falls back to the nearest package.json before init', (t) => {
  const root = project(t, { 'package.json': '{}', 'apps/api/package.json': '{}', 'apps/api/src/x.ts': '' });
  assert.equal(findRoot(join(root, 'apps/api/src')), join(root, 'apps/api'));
});

test('isSetUp only once harness.config.json exists', (t) => {
  const root = project(t, { 'package.json': '{}' });
  assert.equal(isSetUp(root), false);
  write(root, 'harness.config.json', '{}');
  assert.equal(isSetUp(root), true);
});

test('gitRoot and subPath place a subfolder project inside its repo', (t) => {
  const repo = project(t, { 'frontend/package.json': '{}', 'backend/main.py': '' }, { git: true });
  const front = join(repo, 'frontend');
  assert.equal(gitRoot(front), gitRoot(repo));
  assert.equal(subPath(front), 'frontend');
  assert.equal(subPath(repo), '');
});

test('outside git, the project is its own repo root', (t) => {
  const root = project(t, { 'package.json': '{}' });
  // Stop git from finding any repo above the fixture, wherever the temp dir happens to live.
  const before = process.env['GIT_CEILING_DIRECTORIES'];
  process.env['GIT_CEILING_DIRECTORIES'] = dirname(root);
  t.after(() => {
    if (before === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
    else process.env['GIT_CEILING_DIRECTORIES'] = before;
  });
  assert.equal(gitRoot(root), root);
  assert.equal(subPath(root), '');
});

test('workspaceDirs reads arrays, the { packages } form, globs and plain paths', (t) => {
  const arr = project(t, { 'package.json': JSON.stringify({ workspaces: ['apps/*', 'tools/cli', 'missing/*'] }), 'apps/api/x': '', 'apps/web/x': '', 'tools/cli/x': '' });
  assert.deepEqual(workspaceDirs(arr).sort(), ['apps/api', 'apps/web', 'tools/cli']);
  const obj = project(t, { 'package.json': JSON.stringify({ workspaces: { packages: ['pkg/*'] } }), 'pkg/a/x': '' });
  assert.deepEqual(workspaceDirs(obj), ['pkg/a']);
  assert.deepEqual(workspaceDirs(project(t, { 'package.json': '{}' })), []);
});

test('tsconfigs: harness.config.json wins, then the root tsconfig, then one per workspace', (t) => {
  const mono = project(t, {
    'package.json': JSON.stringify({ workspaces: ['apps/*'] }),
    'apps/api/tsconfig.json': '{}',
    'apps/web/tsconfig.json': '{}',
    'apps/docs/README.md': '',
  });
  assert.deepEqual(tsconfigs(mono).sort(), ['apps/api/tsconfig.json', 'apps/web/tsconfig.json']);
  write(mono, 'tsconfig.json', '{}');
  assert.deepEqual(tsconfigs(mono), ['tsconfig.json']);
  write(mono, 'harness.config.json', JSON.stringify({ tsconfigs: ['apps/api/tsconfig.json'] }));
  assert.deepEqual(tsconfigs(mono), ['apps/api/tsconfig.json']);
});

test('loadConfig fills defaults and merges hook settings', (t) => {
  const root = project(t, { 'harness.config.json': JSON.stringify({ test: 'vitest run', hook: {} }) });
  const config = loadConfig(root);
  assert.equal(config.test, 'vitest run');
  assert.equal(config.typeChecked, DEFAULT_CONFIG.typeChecked);
  assert.equal(config.hook.typecheck, true);
  assert.deepEqual(loadConfig(project(t, {})), DEFAULT_CONFIG);
});

test('readJson: fallback when missing, a clear error with its cause when invalid', (t) => {
  const root = project(t, { 'bad.json': '{ nope' });
  assert.equal(readJson(join(root, 'none.json'), 'fallback'), 'fallback');
  assert.throws(() => readJson(join(root, 'bad.json'), null), (err) => err instanceof Error && /bad\.json is not valid JSON/.test(err.message) && err.cause instanceof SyntaxError);
});
