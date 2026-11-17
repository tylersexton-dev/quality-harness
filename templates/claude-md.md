<!-- quality-harness:start -->
## Quality rules (quality-harness)

- Before saying a change is done, run `npx harness check` and the tests. Both must pass.
- A hook lints and type-checks every file you edit. When it reports a problem, fix the root cause. Never add a comment, an `eslint-disable`, `any` or `@ts-ignore` to get around it.
- When the user corrects you, prefer turning the correction into a check (a lint rule, a type, a test) over a note in this file. Use the `correction-to-check` skill.
- Don't copy a pattern just because it exists in the code. Old problems are listed in `.harness/baseline.json`; they are debt, not examples.
- Prove changes work with the `verify-change` skill: test output, screenshots or an eval run, attached to the PR.
- Never edit `.harness/baseline.json` by hand. `npx harness baseline` only ever shrinks it.
<!-- quality-harness:end -->
