# Security

## Reporting a problem

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/tylersexton-dev/quality-harness/security/advisories/new)
rather than a public issue.

## What the harness runs, and with what trust

The harness is a development tool. It runs on your machine and in your CI, with the same
trust as your `package.json` scripts:

- **`harness test` runs the `test` command from `harness.config.json` through a shell**, like
  `npm test`. Anyone who can edit that file can already run code; review it like a script.
- **The Claude Code hook** (`.claude/settings.json`) runs after every edit Claude makes. It only
  lints and type-checks; it doesn't run project code. Folder names are shell-quoted when the
  command is written, so a folder name can never become code.
- **The generated workflow** uses `pull_request` (not `pull_request_target`), so pull requests
  from forks get no secrets, and asks for `contents: read` only. Values from folder names are
  written as quoted YAML strings.
- **`check --against <ref>`** only accepts git refs, never options.
- Nothing is sent over the network, except what `npm install` fetches.

## Supply chain

Enforced by `test/security.test.mjs`, so none of these can quietly regress:

- **Projects install a release tag** (`github:tylersexton-dev/quality-harness#v0.1.0`), never a
  branch, so a later push to the harness reaches a project only when it upgrades on purpose.
- **Dependencies are exact versions**, so a compromised new release of ESLint, TypeScript or
  typescript-eslint is never pulled in without a reviewed update. Dependabot proposes updates
  weekly as PRs, and only for releases at least 7 days old, so a hijacked release that gets
  pulled within days never reaches the harness.
- **Every GitHub Action is pinned to a full commit SHA**, in this repo's workflows and in the one
  `init` writes into projects. A tag can be moved to other code; a commit can't. Dependabot
  keeps the pins current.
- **Checkout never leaves the token on disk** (`persist-credentials: false`), workflows default
  to `contents: read`, and none use `pull_request_target`.
- **This repo's CI installs with `--ignore-scripts`** (the harness's dependencies need no install
  scripts) and **CodeQL** scans the code on every change and weekly.
- **Releases:** `main` and `v*` tags are protected (no force pushes or deletions; changes to
  `main` go through a PR with passing checks). Secret scanning with push protection is on.

## Known advisories in dependencies

| Advisory | Package | Status | Why it doesn't affect the harness |
| --- | --- | --- | --- |
| [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) (CVE-2026-112366), ReDoS through single-branch repeated extglobs | `picomatch` ≤ 4.0.7, via typescript-eslint → tinyglobby | No patched version exists yet (4.0.7 is the latest; the fix is micromatch/picomatch#194). `npm audit` reports it as high. | The attack needs an attacker to supply a glob pattern. Every glob the harness passes comes from your own config files (`harness.config.json`, tsconfig), which can already run code through `test`. `npm audit`'s suggested fix downgrades typescript-eslint and is not applied. Remove this entry when picomatch ships a fix. |
