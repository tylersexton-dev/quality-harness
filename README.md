# quality-harness

Make agent-written TypeScript trustworthy. One install gives a project strict types, strict
lint, a ratchet so existing code isn't buried in old errors, a PR check, and a Claude Code
hook that sends problems back to the agent the moment it writes them.

```bash
npm i -D github:tylersexton-dev/quality-harness#v0.1.0
npx harness init        # wire the project up (safe to re-run)
npx harness baseline    # accept today's problems; only new ones fail from now on
npx harness check       # types + lint, no new problems
```

## Why

Agents write code fast and copy whatever patterns are already in the codebase, good or bad.
Instructions in a CLAUDE.md can be skipped; a failing check can't. So the harness puts the
rules where they're enforced:

- **Deterministic checks first, prose last.** Strict TypeScript and ESLint do the work; the
  CLAUDE.md block only points at them.
- **Stop new problems now, pay down old ones over time.** The baseline records what exists
  today. New problems fail; the baseline can only shrink.
- **Feedback while the agent works, not at review.** A hook lints and type-checks every file
  Claude edits and sends problems straight back, with "fix the root cause".
- **No escape hatches.** `any`, `@ts-ignore`, an `eslint-disable` without a reason, or
  hand-editing the baseline all fail.
- **Verify, don't trust.** The PR template and the `verify-change` skill ask for proof
  (test output, screenshots) instead of a claim. A person still reviews; nothing auto-merges.

Built from Lauren Tan's "All code is slop" and Dex Horthy's "The Harness is Not Enough". The
full reasoning, every design decision and the evals behind each one are in
[docs/BUILD-LOG.md](docs/BUILD-LOG.md).

## What `init` sets up

| File | What it's for |
| --- | --- |
| `harness.config.json` | This project's settings (below). |
| `tsconfig.json` | Strict base config, only if the project has none. Existing tsconfigs are checked as they are. |
| `eslint.config.mjs` | The harness rules, only if there's no flat ESLint config. A legacy `.eslintrc` is left for older tools. |
| `package.json` | Scripts `check`, `typecheck`, `lint`, `quality:baseline` (existing ones are never replaced) and the dependency. |
| `.github/workflows/quality.yml` | On every PR: `harness check --against <base branch>`, then tests. |
| `.github/pull_request_template.md` | Asks how the change was verified. |
| `.claude/settings.json` | The PostToolUse hook, merged into existing settings. |
| `.claude/skills/` | `correction-to-check` and `verify-change`. |
| `CLAUDE.md` | A short rules block between markers, refreshed in place on re-run. |
| `.gitignore` | Ignores `.harness/tsbuildinfo*` caches. Commit `.harness/baseline.json`. |

Every step prints `added`, `updated`, `kept` or `skipped`. Running `init` again changes
nothing, except to upgrade files an older version of the harness wrote.

## Commands

| Command | What it does |
| --- | --- |
| `harness init` | Set the project up. |
| `harness baseline` | Record today's problems in `.harness/baseline.json`. Refuses if there are new ones; otherwise tightens. |
| `harness check` | Types + lint. Fails on any problem the baseline doesn't cover. `--against <ref>` also fails if the baseline grew compared with that ref (the PR check uses this). |
| `harness test` | Runs `test` from `harness.config.json`. |
| `harness ci` | `check`, then `test`. |
| `harness types` / `harness lint` | Every problem from one check, ignoring the baseline. |
| `harness hook` | The Claude Code hook. Reads the hook's JSON on stdin. |

Exit codes: 0 pass, 1 fail. The hook exits 2 to send problems back to Claude, and 0 on
anything it can't handle, so a crash never blocks the agent.

## How the baseline works

Each problem is fingerprinted by tool, file, rule and the text of its line (not the line
number). So:

- moving code up or down a file doesn't make old problems look new;
- adding a problem to a file that already has some reports only the new one;
- editing a line that has an old problem makes it yours: it counts as new.

`check` tells you when problems were fixed; run `harness baseline` to lock that in. In a PR,
`check --against origin/main` fails if anyone (or any agent) raised a count by hand.

Two things are never baselined, because accepting them would switch checking off without
anyone noticing:

- **A tsconfig with errors.** TypeScript stops before checking any code, so a baseline would
  hide every type error in that project. `check` fails until the config is fixed.
- **A file ESLint can't parse:** a syntax error, or a `.ts` file no tsconfig includes. For
  the second, list its glob in `untyped` (below).

## The hook

After every Edit or Write, Claude Code runs:

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" && node_modules/.bin/harness hook
```

(For a project in a subfolder the path is `frontend/node_modules/.bin/harness`.) The hook finds
the project from the edited file (the nearest `harness.config.json` above
it), lints that file, type-checks the tsconfig that owns it, and reports only problems the
baseline doesn't cover. Files outside any harness project, non-code files and
`node_modules` are skipped. Typical time: 2–5 seconds.

Unused variables and parameters are left to `check`: they're almost always a change in
progress (a parameter added one edit before it's used). The message also tells Claude to
finish a multi-step change when the next edit resolves the problem.

## Configuration: `harness.config.json`

```json
{
  "test": "npm test",
  "boundaries": [
    {
      "files": ["src/domain/**"],
      "disallow": ["**/cli/**"],
      "message": "domain/ is pure logic; pass data in instead of importing the CLI."
    }
  ],
  "ignore": ["generated/**"],
  "typeChecked": true,
  "untyped": ["tests/**"],
  "tsconfigs": ["apps/api/tsconfig.json", "apps/web/tsconfig.json"],
  "hook": { "typecheck": true },
  "rules": { "no-console": "error" }
}
```

| Key | Default | What it does |
| --- | --- | --- |
| `test` | `npm test` if there's a test script, else `''` | Command for `harness test` and the PR check. `''` skips tests. |
| `boundaries` | `[]` | Folders that may not import each other. The `message` is what the agent sees, so say what to do instead. |
| `ignore` | `[]` | Extra globs ESLint skips. `node_modules`, `dist`, `build`, `coverage`, `.next` and `*.gen.*` are always skipped. |
| `typeChecked` | `true` | Rules that need type information (floating promises, exhaustive switches). |
| `untyped` | `[]` | Globs for files no tsconfig includes (tests run by ts-jest from the repo root, say). They get every rule that doesn't need types. |
| `tsconfigs` | the root `tsconfig.json`, else one per workspace | Which tsconfigs to type-check. |
| `hook.typecheck` | `true` | `false` makes the hook lint-only, if type-checking is too slow on a big project. |
| `rules` | `{}` | ESLint rule overrides, as in an ESLint config. |

## What the rules are

typescript-eslint `strict` plus:

- `no-explicit-any`, `no-floating-promises`, `no-misused-promises`, `await-thenable`,
  `switch-exhaustiveness-check`, `consistent-type-imports`
- `eslint-disable` needs a reason (`-- why`); unlimited disables and unused disables fail;
  `@ts-ignore` is banned
- `eqeqeq` (null checks allowed), `no-var`, `prefer-const`, unused names (prefix `_` to keep one)

Two relaxations, each for a reason:

- **Tests** may leave `describe`/`test` promises unawaited (`node:test` returns them) and
  use `!` on a value they just asserted.
- **JSX attributes** may take async functions (`onClick={async () => …}`), as
  typescript-eslint recommends for React. Promises passed anywhere else still count: an
  async Express 4 handler that throws hangs the request.

The strict base tsconfig (written only for projects without one) adds `noUncheckedIndexedAccess`,
`erasableSyntaxOnly` for Node's built-in type stripping, and targets ES2024 (Node 22+).

## Project shapes

- **One project per repo:** everything at the root.
- **A project in a subfolder** (TypeScript in `frontend/` next to a Python backend): run
  `init` in the subfolder. Project files stay there; the workflow
  (`.github/workflows/quality-frontend.yml`, running in `frontend/`), the hook and the skills
  go to the repo root, because GitHub and Claude Code only read them there.
- **npm workspaces:** run `init` at the root. Each workspace's tsconfig is checked, and the
  hook checks only the app that owns the edited file.
- **Several harness projects in one repo:** each `init` adds its own hook entry and workflow.
- **Older ESLint:** if a project pins ESLint 8 (Next 14 does, for `next lint`), the harness
  runs its own ESLint 10 for its checks and leaves the project's alone.

## Requirements

Node `^20.19 || ^22.13 || >=24` (the same range as ESLint 10), npm and git. The harness brings
its own ESLint 10, typescript-eslint and TypeScript; a project's own TypeScript is used when
it has one.

## Security

The harness runs with the same trust as your `package.json` scripts. What it runs, how
folder names are kept from becoming code, and one known dependency advisory (no fix
upstream yet, not reachable through the harness) are in [SECURITY.md](SECURITY.md).

## Developing the harness

The harness is plain ESM JavaScript, type-checked by `tsc` through JSDoc, and it checks
itself with its own rules (baseline: zero).

```bash
npm install
npm test                      # unit tests (node:test) on fixture projects
node bin/harness.mjs check    # the harness on itself
node evals/stage1.mjs <project> <a source file in it>
node evals/stage2.mjs <harness-sandbox>
node evals/stage3.mjs <prism> <agentflow>
```

The evals run against real projects with the harness installed; see the build log for how
each was set up.

## License

MIT
