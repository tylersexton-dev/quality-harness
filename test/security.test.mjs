// Supply-chain properties, checked so they can't quietly regress.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { init, SOURCE } from '../lib/init.mjs';
import { HARNESS, project, read, recorder } from './helpers.mjs';

/** @import { PackageJson } from '../lib/types.mjs' */

/** Every `uses:` in a workflow, with its line. @param {string} yml */
const uses = (yml) => [...yml.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1] ?? '');
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;

/** The harness's own workflows, plus the one `init` writes into projects. */
function workflows() {
  const dir = join(HARNESS, '.github/workflows');
  const own = readdirSync(dir).map((f) => /** @type {const} */ ([`.github/workflows/${f}`, readFileSync(join(dir, f), 'utf8')]));
  return [...own, /** @type {const} */ (['templates/quality.yml', readFileSync(join(HARNESS, 'templates/quality.yml'), 'utf8')])];
}

test('every GitHub Action is pinned to a full commit SHA, not a movable tag', () => {
  for (const [file, yml] of workflows()) {
    const found = uses(yml);
    assert.ok(found.length > 0, `${file} has no actions?`);
    for (const u of found) assert.match(u, PINNED, `${file}: ${u} must be pinned to a 40-character commit SHA`);
  }
});

test('checkout never leaves the token on disk, and workflows default to read-only', () => {
  for (const [file, yml] of workflows()) {
    const checkouts = yml.split(/\n(?=\s*- uses:)/).filter((step) => step.includes('actions/checkout@'));
    for (const step of checkouts) assert.match(step, /persist-credentials: false/, `${file}: checkout must set persist-credentials: false`);
    assert.match(yml, /^permissions:\n\s+contents: read$/m, `${file}: top-level permissions must be contents: read`);
    assert.doesNotMatch(yml, /pull_request_target/, `${file}: pull_request_target runs fork code with secrets`);
  }
});

test('dependencies are exact versions, so a compromised new release is never pulled in silently', () => {
  const pkg = /** @type {PackageJson} */ (JSON.parse(readFileSync(join(HARNESS, 'package.json'), 'utf8')));
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    assert.match(range, /^\d+\.\d+\.\d+$/, `${name}@${range} must be an exact version`);
  }
});

test('projects install the harness from a release tag, never a branch', (t) => {
  assert.match(SOURCE, /#v\d+\.\d+\.\d+$/);
  const root = project(t, { 'package.json': '{}' });
  init({ cwd: root, log: recorder() });
  const pkg = /** @type {PackageJson} */ (JSON.parse(read(root, 'package.json')));
  assert.equal(pkg.devDependencies?.['quality-harness'], SOURCE);
});

test('the workflow init writes is pinned and token-safe too', (t) => {
  const root = project(t, { 'package.json': '{}' }, { git: true });
  init({ cwd: root, log: recorder() });
  const yml = read(root, '.github/workflows/quality.yml');
  for (const u of uses(yml)) assert.match(u, PINNED);
  assert.match(yml, /persist-credentials: false/);
});
