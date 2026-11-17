// The two checks against real ESLint and TypeScript, on fixture projects.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { lint, types } from '../lib/checks.mjs';
import { CLEAN, HARNESS, project, SLOP, tsProject } from './helpers.mjs';

test('lint: clean code passes; an any and a floating promise are reported with file and position', async (t) => {
  const root = project(t, { ...tsProject(), 'src/ok.ts': CLEAN, 'src/bad.ts': SLOP });
  const found = await lint(root);
  assert.deepEqual(found.map((v) => [v.file, v.rule, v.line]).sort(), [
    ['src/bad.ts', '@typescript-eslint/no-explicit-any', 1],
    ['src/bad.ts', '@typescript-eslint/no-floating-promises', 3],
  ]);
});

test('lint: async handlers in JSX attributes are fine; promises in other void callbacks are not', async (t) => {
  const root = project(t, {
    ...tsProject(),
    'tsconfig.json': JSON.stringify({ extends: join(HARNESS, 'config/tsconfig.base.json'), compilerOptions: { types: [], jsx: 'preserve' }, include: ['src'] }),
    'src/jsx.d.ts': 'declare namespace JSX { interface IntrinsicElements { button: { onClick?: () => void } } }\n',
    'src/button.tsx': 'export const b = <button onClick={async () => { await Promise.resolve(); }} />;\n',
    'src/each.ts': 'export function each(f: () => void): void { f(); }\neach(async () => { await Promise.resolve(); });\n',
  });
  const rules = (await lint(root)).map((v) => `${v.file} ${v.rule}`);
  assert.deepEqual(rules, ['src/each.ts @typescript-eslint/no-misused-promises']);
});

test('lint: an unexplained eslint-disable is a problem; one with a reason is not', async (t) => {
  const root = project(t, {
    ...tsProject(),
    'src/a.ts': '// eslint-disable-next-line @typescript-eslint/no-explicit-any\nexport const a: any = 1;\n',
    'src/b.ts': '// eslint-disable-next-line @typescript-eslint/no-explicit-any -- third-party callback has no types\nexport const b: any = 1;\n',
  });
  const found = await lint(root);
  assert.deepEqual(found.map((v) => `${v.file} ${v.rule}`), ['src/a.ts @eslint-community/eslint-comments/require-description']);
});

test('lint: boundaries block forbidden imports with the configured message', async (t) => {
  const root = project(t, {
    ...tsProject({ boundaries: [{ files: ['src/domain/**'], disallow: ['**/cli/**'], message: 'domain never imports cli' }] }),
    'src/cli/x.ts': 'export const x = 1;\n',
    'src/domain/y.ts': "import { x } from '../cli/x.ts';\nexport const y = x;\n",
  });
  const [problem, ...rest] = await lint(root);
  assert.equal(rest.length, 0);
  assert.equal(problem?.rule, 'no-restricted-imports');
  assert.match(problem?.message ?? '', /domain never imports cli/);
});

test('lint: files outside every tsconfig are parse errors until listed in `untyped`', async (t) => {
  const files = { ...tsProject(), 'src/a.ts': CLEAN, 'tests/a.test.ts': 'export const t: any = 1;\n' };
  const strict = project(t, files);
  const [parse] = await lint(strict);
  assert.equal(parse?.rule, 'parse-error');
  assert.match(parse?.message ?? '', /not found by the project service/);

  const relaxed = project(t, { ...files, ...tsProject({ untyped: ['tests/**'] }) });
  const found = await lint(relaxed);
  assert.deepEqual(found.map((v) => `${v.file} ${v.rule}`), ['tests/a.test.ts @typescript-eslint/no-explicit-any']);
});

test('types: errors carry file, position and TS code; unused names are left to lint', (t) => {
  // Like AgentFlow's web app: the project's own tsconfig turns on TypeScript's unused checks,
  // which would report the same thing ESLint's no-unused-vars does.
  const tsconfig = JSON.stringify({ extends: join(HARNESS, 'config/tsconfig.base.json'), compilerOptions: { types: [], noUnusedLocals: true, noUnusedParameters: true }, include: ['src'] });
  const root = project(t, { ...tsProject(), 'tsconfig.json': tsconfig, 'src/a.ts': "export const n: number = 'x';\nfunction unused(): void {}\n" });
  const found = types(root);
  assert.deepEqual(found.map((v) => [v.file, v.rule, v.line, v.col]), [['src/a.ts', 'TS2322', 1, 14]]);
});

test('types: a monorepo checks every workspace; `file` narrows it to the owning one', (t) => {
  const tsconfig = JSON.stringify({ extends: join(HARNESS, 'config/tsconfig.base.json'), compilerOptions: { types: [] }, include: ['src'] });
  const root = project(t, {
    'package.json': JSON.stringify({ workspaces: ['apps/*'] }),
    'harness.config.json': '{}',
    'apps/api/package.json': '{"type":"module"}',
    'apps/api/tsconfig.json': tsconfig,
    'apps/api/src/a.ts': "export const a: number = 'api';\n",
    'apps/web/package.json': '{"type":"module"}',
    'apps/web/tsconfig.json': tsconfig,
    'apps/web/src/b.ts': "export const b: number = 'web';\n",
  });
  assert.deepEqual(types(root).map((v) => v.file).sort(), ['apps/api/src/a.ts', 'apps/web/src/b.ts']);
  assert.deepEqual(types(root, { file: 'apps/web/src/b.ts' }).map((v) => v.file), ['apps/web/src/b.ts']);
  assert.deepEqual(types(root, { file: 'README.md' }), []);
});

test('types: a broken tsconfig throws instead of reporting a tolerable problem', (t) => {
  const root = project(t, { ...tsProject(), 'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'node10', types: [] }, include: ['src'] }), 'src/a.ts': "export const n: number = 'x';\n" });
  assert.throws(() => types(root), /can't check tsconfig\.json: its config has errors/);
});

test('types: no tsconfig means nothing to check', (t) => {
  assert.deepEqual(types(project(t, { 'package.json': '{}' })), []);
});
