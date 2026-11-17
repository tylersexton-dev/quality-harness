# Quality Harness: build log

Tyler Sexton · started Nov 16, 2026 · repo `tylersexton-dev/quality-harness`

A reusable harness that makes agent-written TypeScript/Node code trustworthy: strict
types, strict lint, a ratchet so old projects don't drown in old errors, a PR check,
and a Claude Code hook that makes the agent fix its own mistakes as it goes. Built in
six stages, each with evals and a checkpoint, instead of one shot.

## Why: what the two talks taught

| Takeaway | Source | Where it lives in the harness |
| --- | --- | --- |
| Models are trained to make tests pass, not to keep code maintainable. No harness fixes that, so a human still reads code and decides. | Dex Horthy, "The Harness is Not Enough" | No auto-merge, ever. The PR template asks for proof; a person reviews. |
| If you can't verify it, you can't trust it. | Dex Horthy | `harness check` and the PR workflow; the `verify-change` skill. |
| Trust pyramid: code and deterministic checks first, verification next, prose (CLAUDE.md, skills) last. | Lauren Tan, "All code is slop" | Strict tsconfig + ESLint do the work; CLAUDE.md only points at them. |
| Every correction becomes a check, not a sentence in CLAUDE.md. | Lauren Tan | The `correction-to-check` skill, with examples. |
| Your codebase is the prompt: agents copy whatever patterns exist. | Lauren Tan | Baseline marks old problems as debt, not examples; editing a line with an old problem makes it yours to fix. |
| Ban things that need nuance; enforce boundaries with folders + lint. | Lauren Tan | `boundaries` in harness.config.json → `no-restricted-imports` with a teaching message. |
| Comments and disables are escape hatches. | Lauren Tan | `eslint-disable` needs a reason; `@ts-ignore` banned; unused disables fail. |
| Error messages should teach the fix. | Lauren Tan | Boundary messages; the hook says "fix the root cause". |
| Review verification artifacts, not every line. | Lauren Tan | PR template "How I verified it"; `verify-change` skill. |
| Start with lint rules that stop new occurrences, then clean up old ones. | Lauren Tan | The ratchet: new problems fail, old ones are listed and only shrink. |
| Foundations before factory: automating a sloppy loop makes more slop. | Lauren Tan | This harness is the foundation; no agent orchestration in it. |

## What it is

| Piece | What it does |
| --- | --- |
| `harness init` | Wires a project up: harness.config.json, strict tsconfig, eslint.config.mjs, scripts, PR workflow, PR template, Claude hook, two skills, CLAUDE.md rules, .gitignore. Never overwrites; safe to re-run. |
| `harness baseline` | Records today's problems (fingerprinted by file, rule and line text). Refuses to grow; only tightens. |
| `harness check` | Types + lint. Fails only on problems the baseline doesn't cover. `--against <ref>` also fails if the baseline grew vs the base branch (PRs). |
| `harness hook` | Claude Code PostToolUse hook on Edit/Write. Lints + type-checks the edited file; exit 2 sends the problems back to Claude to fix. Never blocks on its own crash. |
| `harness test` / `ci` | Runs the project's test command; `ci` = check then test. |
| `config/eslint.mjs` | Shared rules: typescript-eslint strict, promise rules, no `any`, explained disables only, boundaries. Tests may use `!` and unawaited `describe`. |
| `config/tsconfig.base.json` | Strict, `noUncheckedIndexedAccess`, `erasableSyntaxOnly` (Node type stripping), no emit. |

## Stages

| # | Stage | Evals | Checkpoint | Status |
| --- | --- | --- | --- | --- |
| 1 | Prove the core on a copy of a private production service | E1–E11 below | Tyler reviews results | Done, 11/11 |
| 2 | The hook in a real Claude Code session on Tyler's Mac | Agent writes slop → hook blocks → agent fixes; feels helpful, < 10 s | Tyler: helpful or annoying? | Done: 5/5 prompts, S1–S5 pass; Tyler's ratings pending |
| 3 | Two differently shaped projects: Prism and AgentFlow | init + baseline + check with no harness code changes | Review baseline + tweaks | Done: 12/12 after 7 fixes (it needed code changes, which was the point of looking) |
| 4 | Tests and docs for the harness itself | Unit tests (ratchet, init, hook); harness passes its own check; README | Review README | Done: 54 tests, 14/14 mutations caught, self-check baseline 0, Node 20 + 22 |
| 5 | Publish to `tylersexton-dev/quality-harness` | Fresh install from GitHub works in a clean folder and in CI | Tyler: public or private | Published, public. CI green on Node 20.19/22/24, CodeQL clean, installs from GitHub; Tyler cuts the v0.1.0 release |
| 6 | Roll out per project | Each project: init, baseline, check green, PR check green | work repos only after their owners OK the CI change | |

## Stage 1: prove the core (Nov 16)

Target: a throwaway copy of a private production Node service (work code, so it isn't named here), harness installed from a
packed tarball exactly as npm would. Script: `node evals/stage1.mjs <project>`; each eval
changes a file, runs the harness and restores the file.

**Baseline on the production service:** 577 existing problems. Biggest: `no-explicit-any` (230),
`TS2532` possibly-undefined index access (130), `no-non-null-assertion` in source (90).

| Eval | What it proves | Result |
| --- | --- | --- |
| E1 | Untouched code passes `check` | PASS (17.7 s full run) |
| E2 | A new `any` + an unawaited promise fail `check`, and only those two are reported | PASS (2 new) |
| E3 | The hook blocks the edit and tells the agent to fix the root cause | PASS (exit 2) |
| E4 | The hook lets clean edits, non-code files and bad input through | PASS |
| E5 | Running `init` again changes nothing | PASS (11 steps skipped) |
| E6 | `baseline` refuses to absorb new problems | PASS |
| E7 | A folder boundary catches a forbidden import and shows its message | PASS |
| E8 | The hook is fast enough for every edit (< 10 s) | PASS (4.9 s warm) |
| E9 | Escape hatches fail: unexplained `eslint-disable`, `@ts-ignore` | PASS |
| E10 | Hand-editing the baseline to sneak a problem in fails on PRs | PASS |
| E11 | Moving code down a file doesn't make old problems look new | PASS |

**What the evals changed in the design:**

1. *Test-file noise.* First baseline was 859; 64 were `no-floating-promises` on `node:test`'s
   `describe`/`test`, plus `!` in tests. Relaxed those two rules in test files only → 577.
2. *Baseline loophole.* An agent could edit `.harness/baseline.json` to let its own problem
   through. Added `check --against <base>`; the PR workflow fails if the baseline grew (E10).
3. *Over-reporting (E2 failed first).* Counting per file + rule meant adding 2 `any`s to a file
   that already had 4 reported all 6, inviting the agent to "fix" old code. Switched to
   fingerprinting each problem by its line's text (baseline v2). Now only new problems are
   reported, moving code doesn't trip it (E11), and editing an old problem's line makes it yours.

**Open for Stage 2:** the hook takes ~5 s warm, mostly the incremental type-check; watch how
that feels in a real session. `hook.typecheck: false` in harness.config.json makes it lint-only.

## Stage 2: the hook in a real session (Nov 16)

**Setup.** A throwaway project, `~/Desktop/harness-sandbox`, so no real repo is touched: a
small TypeScript task tracker (`src/domain/` logic, `src/cli/` commands, 3 `node:test` tests)
with 3 problems planted on purpose (an `any`, a `!`, a loose `switch`), all in the baseline.
One boundary is set: `src/domain/**` may not import from `cli/`. The harness is installed from a
packed tarball in `vendor/` until Stage 5 publishes it. Tyler's script and score sheet are in
`STAGE-2.md` in that folder.

**Dry run in the workspace before handing over:**

| Check | Result |
| --- | --- |
| `harness init` on the sandbox | All 11 steps ran; kept the local tarball dependency instead of the GitHub one |
| `harness check` | Pass, 3 old problems, 2.9 s |
| Hook on an edit adding an `any` and an un-awaited `writeFile` | Exit 2, both reported, old `any` in the same file not reported, 2.8 s |
| Hook on a clean edit | Exit 0, silent |
| Re-running `init` on an already set-up folder | Idempotent; nothing duplicated, check still passes |

**The five prompts Tyler runs:** P1 normal feature (CSV export), P2 asks for slop on purpose
(`any`, no `await`), P3 asks to cross the domain→cli boundary, P4 fishes for a disable or
`ts-ignore`, P5 pays down old debt (baseline should shrink from 3).

**Pass bar:** fires on every slop edit and never on clean ones; under 10 s per check; root-cause
fixes with no disables in 4 of 5; P2/P4 push back briefly; P5 shrinks the baseline; Tyler's gut
is helpful 4+ and annoying 2 or below.

**Live session results** (Claude Code v2.1.325, Opus 5.5, on Tyler's Mac):

| # | Prompt | Hook | What Claude did | Verdict |
| --- | --- | --- | --- | --- |
| P1 | CSV export | Fired once, mid-change (code used `toCsv` one edit before importing it) | Finished the change, added a test, ran check + tests + the command | Pass; surfaced noise finding |
| P2 | "Use `any`, don't await" | Fired on `Map.groupBy` (type error) | Declined the slop in two sentences, reused the typed loader, shipped the feature | Pass; surfaced a harness bug |
| P3 | Import FILE from the CLI | Fired once, mid-change (unused param), reported twice | Refused the boundary from reading harness.config.json, and spotted the import would *run the CLI*; passed the file in instead | Pass; surfaced noise + duplicate |
| P4 | "Just disable the rule" + due dates | Never fired | Clean on the first try, test added, edge cases run; widened date input beyond ISO and said so | Pass |
| P5 | Pay down old debt | n/a | Replaced the planted `any` with a `parseTasks` validator + test, removed the `!`; baseline 3 → 1 | Pass |

End state: `harness check` green (1 old problem left, out of P5's scope), 6/6 tests, no
`eslint-disable`/`ts-ignore`/`ts-expect-error` anywhere, 96 lines added across 6 files.

**What the session taught, and the fixes:**

1. **The harness pushed Claude toward worse code.** The base tsconfig pinned `lib` to es2023,
   so `Map.groupBy` (fine on Node 22+) was a type error and Claude wrote a manual loop. Fix:
   target and lib are es2024, matching `engines: node >= 22`.
2. **The hook flagged half-finished changes** (P1, P3). An edit that adds a parameter or a call
   one step before its counterpart trips it. Fix: the hook defers unused-name findings
   (`no-unused-vars`, TS6133/6192/6196/6198) to `harness check`, which still fails on them; the
   message now says to finish a multi-step change if the next edit resolves it.
3. **Unused names were reported twice** (lint and TypeScript). Fix: TypeScript's
   `noUnusedLocals`/`noUnusedParameters` are off in the base; ESLint owns it (and honors `_`).
   the production service's baseline drops from 577 to 576 for the same reason.
4. **Boundaries are legible to agents.** In P3 Claude read harness.config.json and refused
   before the lint rule had to fire. The rule stays as the CI backstop.
5. **The agent learned within the session.** After two hook hits, P4 came out clean first try.
6. The remote bridge can't write `.claude/` or `.github/`, so Tyler ran `harness init` on the
   Mac: init works on macOS.
7. For Stage 4: init says "add extends…" even when tsconfig/eslint already use the harness.

**Regression evals** (`node evals/stage2.mjs <sandbox>`), run before and after the fixes:

| Eval | Before | After |
| --- | --- | --- |
| S1 Map.groupBy type-checks | failed live in P2 | Pass |
| S2 Hook quiet on a half-finished change | Fail (exit 2) | Pass (exit 0, 2.4 s) |
| S3 `check` still fails on the unused param, reported once | Fail (reported 2x) | Pass (1x) |
| S4 Hook still blocks real slop, with the mid-change hint | Fail (no hint) | Pass (2.5 s) |
| S5 Hook under 10 s | Pass | Pass (2.5 s) |

Stage 1's E1–E11 re-run on the production-service copy with the fixes: **11/11**, hook 4.8 s warm.

**Tyler's ratings:** _pending._

## Stage 3: projects shaped nothing like the first one (Nov 16)

**The two projects** (cloned into the workspace; nothing pushed, nothing on Tyler's Mac):

| | Prism | AgentFlow |
| --- | --- | --- |
| Shape | TypeScript in `frontend/` (Next 14, React) beside a Python backend | npm workspaces: `apps/api` (CommonJS, Express) + `apps/web` (Vite, React) |
| tsconfig | One, in `frontend/` | One per app, none at the root |
| ESLint | Pins ESLint 8 for `next lint`, no config | None |
| CI | none for the frontend | Node 20 |
| Baseline | **15** old problems, check 5.8 s | **37** old problems, check 10.1 s |
| Hook (warm) | ~4.5 s | ~3.3 s per app, 0.6 s for an untyped test file |

**The pass bar was "no harness code changes." It failed on the first try, in seven ways.**
Each is fixed and has an eval:

1. **Files in the wrong place for subfolder projects.** Init put `.github/workflows/` and
   `.claude/` inside `frontend/`, where GitHub and Claude Code never look: the PR check would
   silently never run. Now the project files stay in the project and the repo files go to the
   git root; the workflow is `quality-frontend.yml` with `working-directory: frontend`.
2. **The hook found its project from where Claude started, not from the file.** Now it walks up
   from the edited file to the nearest `harness.config.json`, runs from the repo root, and skips
   files outside any harness project (Prism's Python). Older installs are upgraded in place by
   re-running init.
3. **ESLint 8 projects broke lint.** The harness used the project's own ESLint, which can't read
   flat config. Now it uses the project's ESLint only at v9+, else its own.
4. **React's `onClick={async …}` counted as a problem** (8 of Prism's first 24). typescript-eslint
   recommends not checking promises passed to JSX attributes; everywhere else still counts.
   AgentFlow's 10 async Express handlers still count: in Express 4 a throw there hangs the request.
5. **One tsconfig assumed.** Type-checking now runs every workspace's tsconfig (or the list in
   `tsconfigs`), and the hook checks only the app that owns the edited file, with one cache each.
6. **A broken tsconfig would have been baselined, switching type-checking off.** AgentFlow's web
   config references `tsconfig.node.json` with `noEmit`, which TypeScript 5.9 rejects before
   checking any code: a planted type error in `App.tsx` went unreported. The harness now fails
   loudly on config errors and never baselines them.
7. **Unparseable files would have been baselined, switching lint off for them.** AgentFlow's
   `tests/` sit outside every tsconfig, so typed lint can't parse them. Parse errors now always
   fail and are never baselined; a new `untyped` setting lints such files with every rule that
   doesn't need types. Unused names are also reported once (ESLint), even when a project's own
   tsconfig turns on TypeScript's copy.

Also: the harness runs on Node `^20.19 || ^22.13 || >=24` (ESLint 10's range), not just 22,
since AgentFlow's CI is on Node 20. The strict base tsconfig still targets Node 22+, but it's
only written for projects that have no tsconfig.

**Findings in the projects themselves** (not fixed in their repos; for Tyler to decide):
- **AgentFlow's web build is broken** on TypeScript 5.9: `build` runs `tsc && vite build` and
  `tsc` stops at the tsconfig error above. Fix: in `apps/web/tsconfig.node.json`, replace
  `"noEmit": true` with `"emitDeclarationOnly": true, "outDir": "node_modules/.tmp/tsconfig.node"`.
  Once it type-checks, it also shows `import.meta.env` is untyped (missing `src/vite-env.d.ts`).
- AgentFlow's async Express handlers (10) can hang requests on a thrown error.
- AgentFlow's `better-sqlite3` needs a native build; the workspace sandbox used `--ignore-scripts`.

**Evals** (`node evals/stage3.mjs <prism> <agentflow>`): **12/12**. P1 workflow + hook at the
repo root; P2 check on ESLint 8; P3 hook from the root, skips Python; P4 JSX onClick fine,
floating promise not; A1 per-workspace tsconfigs; A2 check passes; A3 type errors caught in
each app; A4 hook checks only the edited app (2.9 s); A5 unused reported once; A6 broken tsconfig
fails, never baselined; A7 unreadable files fail until `untyped`; A8 untyped test file linted.
Failures 1, 3, 5, 6 and 7 were each observed live before the fix.

**Regression on the same build:** Stage 1 **11/11** on the production service (its first re-run of init
upgraded the old hook and .gitignore, as designed; the second changed nothing). Stage 2 **5/5**.

## Stage 4: the harness holds itself to its own rules (Nov 17)

**1. The harness passes its own check, with a baseline of zero.** It now has its own
`harness.config.json`, `eslint.config.mjs` and a `checkJs` tsconfig, so its plain JavaScript is
type-checked through JSDoc under the same strict settings it gives everyone else.

The first run found **157 type problems and 4 lint problems** in the harness's own code: almost
all implicit `any`, the thing it exists to stop. Baselining them would have been exactly the
excuse the harness is built to refuse, so every one is fixed:

- Shared types live in `lib/types.mjs` (`Violation`, `HarnessConfig`, `Baseline`, `Log`,
  `PackageJson`, `ClaudeSettings`), and every function is annotated.
- `readJson` returns `unknown`, so each caller states the shape it expects. That surfaced 15
  places in `init` that read config without one.
- Errors are re-thrown with their `cause`, and the eval scripts share one typed helper file
  (`evals/lib.mjs`) instead of three copy-pasted ones.
- Lint caught leftovers from my own Stage 3 refactor: `check` and `baseline` loaded a config
  they no longer used.
- A boundary keeps `lib/` and `config/` (which ship to every project) from importing the CLI,
  tests or evals.

**2. Unit tests: 54, in 15 seconds**, `node:test` on throwaway fixture projects with real
ESLint and TypeScript:

| Suite | Tests | Covers |
| --- | --- | --- |
| ratchet | 9 | Line-text fingerprints survive moves and whitespace; counts beyond the baseline; scope; improved/grown; round-trip; old versions refused |
| project | 9 | Project found from a nested file; fallback before init; git root and subfolder path; workspaces in every form; which tsconfigs; config defaults; bad JSON keeps its cause |
| init | 13 | Fresh install; re-run is a no-op; subfolder files at the repo root; two projects in one repo; upgrading an older install; merging existing settings; monorepos; own vs harness configs; legacy `.eslintrc`; scripts and dependency never overwritten; CLAUDE.md block refreshed in place |
| checks | 9 | Positions and rules; JSX `onClick` fine but other async callbacks not; explained vs unexplained disables; boundaries; `untyped`; TS codes; per-workspace narrowing; broken tsconfig throws |
| commands | 14 | check / baseline / hook / test end to end: ratchet both ways, unreadable files, broken tsconfig, `--against` guard (at the root and in a subfolder), hook scoping, type errors, deferred unused, every pass-through case, project found from the file |

**Do the tests actually catch breakage?** I broke the harness on purpose 14 ways (allow one
extra over the baseline, fingerprint by line number, drop the growth guard, tolerate a broken
tsconfig, put `.github` in the subfolder, and so on) and ran the suite each time.

- The first pass caught **13 of 14**. The miss was a real gap: the "unused names reported
  once" test used the harness's own base tsconfig, which already turns TypeScript's unused
  checks off, so it passed either way. The fixture now turns them on, like AgentFlow's web
  app, and the 14th is caught.
- One project test had a tautological assertion (both sides computed the same way). It now
  pins git to "no repo" and fails when the fallback breaks.

**3. Two things that were quietly wrong, found by checking claims:**

- `npm test` was `node --test test/`, which Node 22 doesn't accept as a folder: it would have
  run nothing. It's now `node --test test/*.test.mjs`.
- The engines field says Node 20.19+, but nothing had run on 20. I installed Node 20.19.6: all
  54 tests, the self-check and the Stage 2 evals (hook included) pass.

**4. CI for the harness** (`.github/workflows/ci.yml`): Node 20.19, 22 and 24. Each runs the
harness on itself (with the baseline guard on PRs) and the unit tests, then packs the package,
installs it into a blank project and runs it.

**5. README:**
- what it does and why
- what `init` writes
- every command and exit code
- how the baseline works, and the two things never baselined
- the hook
- every config key, with defaults
- the rules and the two relaxations
- each project shape
- requirements and developing the harness

Every claim in it was checked against the code; one (the hook command) was corrected to match.

**Regression on the final build:** Stage 1 **11/11** (production service), Stage 2 **5/5**
(sandbox, on Node 20), Stage 3 **12/12** (Prism + AgentFlow). The harness is 2,107 lines
across `bin`, `lib`, `config`, `evals` and `test`.

## Stage 5: audit, harden, publish (Nov 17)

**Public, by Tyler's call.** Private → public is one setting; public → private can't take back
copies already made, so nothing was pushed until an audit said it was safe.

**Audit findings, all fixed before the first push:**

1. **Private work details** were in this log and in the Stage 1 eval: the production service's
   name, file paths and problem counts. Scrubbed. The lessons and numbers stay, under "a private
   production service". Prism and AgentFlow are Tyler's own and stay named.
2. **Shell injection through a folder name.** `init` wrote the folder's path, unquoted, into the
   hook command Claude Code runs after every edit, so a folder named `` x`cmd` `` would have run
   `cmd`. Folder names are now shell-quoted. Workflow values are now JSON-quoted YAML, because a
   name like `web: app\non: [push]` could otherwise add keys. Both are tested with hostile names.
3. **`--against` accepted an option** (`--output=…`) as a git ref. It now rejects anything
   starting with `-`.
4. **No LICENSE file**, though the package said MIT. Added.
5. **No secrets** anywhere in the repo (keys, tokens, private keys, service-role strings).

**One advisory accepted, documented in SECURITY.md:** GHSA-fc5q-39xc-vjpf (CVE-2026-112366),
a ReDoS in `picomatch` ≤ 4.0.7 (via typescript-eslint). There's no patched version yet, and npm's
suggested fix is a downgrade. Triggering it needs an attacker-supplied glob, but every glob the
harness uses comes from the project's own config, which can already run code through `test`.
The entry comes out when picomatch ships a fix.

**Hardening** (the supply chain is the real exposure now):

- Projects install a **release tag** (`#v0.1.0`), not `main`. Before this, any push to the
  harness would have reached every project on its next install.
- **Exact dependency versions**, with Dependabot proposing updates as PRs.
- **Every GitHub Action pinned to a commit SHA** (checkout v7.0.1, setup-node v7.1.0, CodeQL
  v4.39.3), in this repo's workflows and the one `init` writes into projects.
- **`persist-credentials: false`** on every checkout, so test code can't read the token.
- **CodeQL** (security-extended) on every change and weekly. **`--ignore-scripts`** in the
  harness's CI.
- `test/security.test.mjs` (5 tests) checks all of it. Unpinning one action or loosening one
  version fails 3 of them.

**Totals:** 60 unit tests, the self-check is clean, and the Stage 2 evals pass 5/5 on the final
package.

**Published** (Nov 17): https://github.com/tylersexton-dev/quality-harness

- **First push:** CI green on Node 20.19, 22 and 24 (self-check, 60 tests, packed install into a
  blank project). CodeQL security-extended found nothing.
- **Installed from GitHub into a blank project:** install (11 s), `init` (11 steps), `baseline`
  (0 problems), a clean `check`, then a planted `any` caught.
- **Secret scanning with push protection** was already on (GitHub's default for public repos).
- **Dependabot worked on the first run, and its first PR showed two config gaps:**
  1. It proposed `@types/node` 24 → 26. Types newer than the oldest supported Node (20) would
     let code call APIs that don't exist there, so major `@types/node` bumps are now ignored.
  2. Its npm job failed trying to move TypeScript past 6.0, which typescript-eslint doesn't
     support yet. TypeScript now moves by hand, together with typescript-eslint; only patches are
     automatic.
  The same log showed Dependabot skipping releases newer than 3 days. That's a strong defense
  (hijacked releases are usually pulled within days), so it's now explicit: 7 days.
- **This session can't create tags, releases or repo settings,** so Tyler does those:
  - the v0.1.0 release
  - rulesets protecting `main` (PR + passing checks) and `v*` tags
  - private vulnerability reporting
  - Dependabot alerts and security updates


### The first CodeQL scan found a real vulnerability in v0.1.0 (fixed in v0.1.1)

**Found:** CodeQL flagged four "potential file system race conditions" in `init`: check whether a
file exists, then write it. Digging in showed something worse than the race. Plain writes
**follow symlinks**, so a hostile repo whose `CLAUDE.md` was a symlink to `~/.zshrc` would get
the rules block appended to the user's shell startup file. The same was true of `package.json`,
`.gitignore`, a symlinked `.claude/` or `.github/` folder, and `.harness/baseline.json`.
Reproduced against the published v0.1.0: the fake `.zshrc` got the block.

**Fixed** with `lib/safe-fs.mjs`, which every project write now goes through:
- `O_NOFOLLOW` on every open, so the OS itself refuses a symlink;
- a check that every write lands inside the project or repo (catches symlinked folders);
- atomic create-if-missing (`O_EXCL`) in place of check-then-write;
- reads that refuse symlinks too. A first version still followed one when *reading* the
  baseline; the test only failed by luck, because `.zshrc` isn't JSON;
- TypeScript's cache only allowed inside a real `.harness/` folder, otherwise skipped.

**Tests:** 7 new attack tests (`test/safe-fs.test.mjs`). Run against v0.1.0's `init`, three of
them fail, which proves they catch the real bug. 67 tests total, self-check clean. Shipped as
v0.1.1, with the issue recorded in SECURITY.md.

## Decisions log

| Date | Decision | Why |
| --- | --- | --- |
| Nov 16 | TypeScript/Node only for now | Covers the production service and most current projects; Python later. |
| Nov 16 | Lives on Tyler's personal GitHub | Reusable across work and personal projects. |
| Nov 16 | Ratchet instead of fix-everything-first | Lauren: stop new occurrences first, clean old ones over time. 577 old problems in the production service alone. |
| Nov 16 | No comment ban (unlike Lauren's team) | Too disruptive for existing projects; disables need reasons instead. Revisit later. |
| Nov 16 | Nothing goes into a work repo until its owner OKs it | Their production code, and a CI change. |
| Nov 16 | Stage 2 runs in a throwaway sandbox, not a real repo | Lets the prompts ask for slop and boundary breaks on purpose without risk. |
| Nov 16 | Hook defers unused names to `check` | Mid-change noise in 2 of 5 live prompts; `check`/CI still enforce it. |
| Nov 16 | ESLint owns unused names, not TypeScript | One report per problem; ESLint honors the `_` prefix. |
| Nov 16 | Base targets es2024 | Strictness must never push agents to older, worse code. |
| Nov 16 | Repo files at the git root, project files in the project | GitHub and Claude Code only read .github/ and .claude/ at the root. |
| Nov 16 | Config errors and parse errors are never baselined | Both silently switch checking off for whole apps or files. |
| Nov 16 | Run on Node 20.19+, not only 22 | Matches ESLint 10; AgentFlow's CI is on Node 20. |
| Nov 16 | JSX attributes exempt from no-misused-promises | typescript-eslint's own React guidance; avoids noise agents would fight. |
| Nov 17 | The harness stays plain JavaScript, type-checked through JSDoc | No build step, so it installs straight from GitHub; tsc still checks it strictly. |
| Nov 17 | Fix the harness's own 161 problems instead of baselining them | A one-day-old tool grandfathering its own `any`s is the excuse it exists to refuse. |
| Nov 17 | Tests are proven by mutation, not by passing | A test that can't fail proves nothing; 14 deliberate breakages, all caught. |
| Nov 17 | Public repo | Simplest install for every project and CI; audited first, since public can't be undone. |
| Nov 17 | Projects pin a release tag | A push to the harness must not reach a project until it chooses to upgrade. |
| Nov 17 | Dependabot waits 7 days; TypeScript moves by hand | Compromised releases are usually pulled within days; TypeScript minors can break typescript-eslint. |
| Nov 17 | Every project write goes through one safe layer | The harness writes into repos it doesn't control; symlinks there must never redirect a write. |
| Nov 17 | Accept the picomatch advisory, documented | No fix exists upstream; not reachable through the harness; the suggested downgrade is worse. |
