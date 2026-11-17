#!/usr/bin/env node
// Stage 3 evals: does the harness work on projects shaped nothing like the first one?
//   node evals/stage3.mjs <prism-repo> <agentflow-repo>
//
// Prism: TypeScript in a frontend/ subfolder (Next 14, React, ESLint 8) beside a Python backend.
// AgentFlow: an npm workspaces monorepo (apps/api CommonJS + Express, apps/web Vite + React),
// one tsconfig per app and none at the root, tests outside every tsconfig.
// Both must already have the harness installed, init run, and a baseline written.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Evals, harness, hookFrom, secs, withFiles } from './lib.mjs';

const [prism, agentflow] = process.argv.slice(2);
if (!prism || !agentflow) {
  console.error('usage: node evals/stage3.mjs <prism-repo> <agentflow-repo>');
  process.exit(2);
}
const front = join(prism, 'frontend');
const evals = new Evals();
const SLOP = '\nexport const loose: any = 1;\nexport async function ping(): Promise<void> { fetch("/x"); }\n';

// ---------- Prism: a project in a subfolder ----------
evals.case('P1', 'Prism: workflow + hook land at the repo root, scoped to frontend/', () => {
  const wf = join(prism, '.github/workflows/quality-frontend.yml');
  const yml = existsSync(wf) ? readFileSync(wf, 'utf8') : '';
  const settings = readFileSync(join(prism, '.claude/settings.json'), 'utf8');
  const ok = yml.includes('working-directory: frontend') && yml.includes('frontend/package-lock.json') && !existsSync(join(front, '.github')) && settings.includes('frontend/node_modules/.bin/harness hook');
  return [ok, `workflow at repo root: ${Boolean(yml)}, nothing in frontend/.github: ${!existsSync(join(front, '.github'))}`];
});

evals.case('P2', 'Prism: check passes on an ESLint 8 project', () => {
  const r = harness(front, ['check']);
  return [r.code === 0, `exit ${r.code}, ${secs(r.ms)}`];
});

evals.case('P3', 'Prism: hook from the repo root blocks slop in frontend/, skips Python', () =>
  withFiles(front, { 'src/lib/utils.ts': (s) => s + SLOP }, () => {
    const ts = hookFrom(prism, 'frontend/src/lib/utils.ts');
    const py = hookFrom(prism, 'backend/main.py');
    const ok = ts.code === 2 && ts.out.includes('no-explicit-any') && ts.out.includes('no-floating-promises') && py.code === 0;
    return [ok, `ts exit ${ts.code} (${secs(ts.ms)}), py exit ${py.code}`];
  }));

evals.case('P4', 'Prism: async onClick in JSX is fine; a floating promise is not', () =>
  withFiles(front, {
    'src/components/StatusBadge.tsx': (s) => `${s}\nexport function Btn() { return <button onClick={async () => { await Promise.resolve(); }}>x</button>; }\n`,
  }, () => {
    const clean = harness(front, ['check']);
    return withFiles(front, { 'src/lib/utils.ts': (s) => `${s}\nexport function go() { void 0; Promise.resolve(); }\n` }, () => {
      const dirty = harness(front, ['check']);
      return [clean.code === 0 && dirty.code === 1 && dirty.out.includes('no-floating-promises'), `onClick exit ${clean.code}, floating exit ${dirty.code}`];
    });
  }));

// ---------- AgentFlow: an npm workspaces monorepo ----------
evals.case('A1', 'AgentFlow: init used each workspace tsconfig, added none at the root', () => {
  const ok = !existsSync(join(agentflow, 'tsconfig.json')) && existsSync(join(agentflow, '.harness/tsbuildinfo-apps_api')) && existsSync(join(agentflow, '.harness/tsbuildinfo-apps_web'));
  return [ok, `root tsconfig: ${existsSync(join(agentflow, 'tsconfig.json'))}, one cache per app: ${ok}`];
});

evals.case('A2', 'AgentFlow: check passes', () => {
  const r = harness(agentflow, ['check']);
  return [r.code === 0, `exit ${r.code}, ${secs(r.ms)}`];
});

evals.case('A3', 'AgentFlow: a type error is caught in each app', () =>
  withFiles(agentflow, {
    'apps/api/src/config.ts': (s) => `${s}\nexport const n: number = 'api';\n`,
    'apps/web/src/App.tsx': (s) => `${s}\nexport const m: number = 'web';\n`,
  }, () => {
    const r = harness(agentflow, ['check']);
    const both = r.out.includes('apps/api/src/config.ts') && r.out.includes('apps/web/src/App.tsx');
    return [r.code === 1 && both, `exit ${r.code}, both apps reported: ${both}`];
  }));

evals.case('A4', 'AgentFlow: hook checks only the edited app, under 10 s', () =>
  withFiles(agentflow, {
    'apps/web/src/App.tsx': (s) => `${s}\nexport const m: number = 'web';\n`,
    'apps/api/src/config.ts': (s) => `${s}\nexport const fine = 1;\n`,
  }, () => {
    const r = hookFrom(agentflow, 'apps/api/src/config.ts');
    return [r.code === 0 && r.ms < 10_000, `api edit exit ${r.code} with a web error present, ${secs(r.ms)}`];
  }));

evals.case('A5', 'AgentFlow: an unused name is reported once (lint), not twice', () =>
  withFiles(agentflow, { 'apps/web/src/App.tsx': (s) => `${s}\nfunction neverUsedHelper() { return 1; }\n` }, () => {
    const r = harness(agentflow, ['check']);
    const mentions = r.out.split('\n').filter((l) => l.includes('neverUsedHelper')).length;
    return [r.code === 1 && mentions === 1, `exit ${r.code}, reported ${mentions}x`];
  }));

evals.case('A6', 'AgentFlow: a broken tsconfig fails loudly and is never baselined', () =>
  withFiles(agentflow, { 'apps/web/tsconfig.node.json': (s) => s.replace(/"emitDeclarationOnly": true,\s*"outDir": "[^"]+"/, '"noEmit": true') }, () => {
    const c = harness(agentflow, ['check']);
    const b = harness(agentflow, ['baseline']);
    const ok = c.code === 1 && b.code === 1 && c.out.includes("can't check apps/web/tsconfig.json");
    return [ok, `check exit ${c.code}, baseline exit ${b.code}`];
  }));

evals.case('A7', 'AgentFlow: files outside every tsconfig fail until declared `untyped`', () =>
  withFiles(agentflow, { 'harness.config.json': (s) => JSON.stringify({ .../** @type {object} */ (JSON.parse(s)), untyped: [] }, null, 2) }, () => {
    const c = harness(agentflow, ['check']);
    const b = harness(agentflow, ['baseline']);
    const ok = c.code === 1 && b.code === 1 && c.out.includes('untyped');
    return [ok, `check exit ${c.code}, baseline exit ${b.code}, points at \`untyped\`: ${c.out.includes('untyped')}`];
  }));

evals.case('A8', 'AgentFlow: hook lints an untyped test file', () =>
  withFiles(agentflow, { 'tests/api/setup.ts': (s) => `${s}\nexport const loose: any = 1;\n` }, () => {
    const r = hookFrom(agentflow, 'tests/api/setup.ts');
    return [r.code === 2 && r.out.includes('no-explicit-any'), `exit ${r.code}, ${secs(r.ms)}`];
  }));

evals.report(`Stage 3 evals\n  prism:     ${prism}\n  agentflow: ${agentflow}`);
