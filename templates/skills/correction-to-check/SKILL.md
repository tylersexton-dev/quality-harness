---
name: correction-to-check
description: Use when the user corrects a mistake you made, or the same review comment comes up twice. Turns the correction into a deterministic check (lint rule, type, test) instead of a note in CLAUDE.md.
---

# Turn a correction into a check

A note in CLAUDE.md can be ignored. A failing check can't. When the user corrects you:

1. **Fix the instance** they pointed at.
2. **Pick the strongest check that would have caught it**, in this order:
   1. **Make it impossible by design:** a type that can't hold the bad value, an API that doesn't offer the wrong call, a folder boundary.
   2. **A lint rule:** an existing ESLint rule turned on in `harness.config.json` → `rules`, a `no-restricted-imports` boundary in `boundaries`, or `no-restricted-syntax` with an AST selector for a pattern.
   3. **A test** that fails on the old behavior. Property-based (fast-check) when the bug was an edge case.
   4. **A note in CLAUDE.md** only when none of the above can express it.
3. **Make the error message teach:** the message should say what to do instead (`message` on `no-restricted-imports` / `no-restricted-syntax`).
4. **Clean up existing copies** of the pattern, or at least confirm they're in `.harness/baseline.json`, so the next agent doesn't copy them.
5. **Run `npx harness check`** and tell the user which check now guards it.

## Examples

| Correction | Check |
| --- | --- |
| "Don't import the database client from the UI folder" | `boundaries: [{ files: ["src/ui/**"], disallow: ["**/db/**"], message: "UI talks to the API, never the database" }]` |
| "You forgot to await that" | Already on: `@typescript-eslint/no-floating-promises` |
| "Never use `setTimeout` to paper over a race" | `rules: { "no-restricted-syntax": ["error", { "selector": "CallExpression[callee.name='setTimeout']", "message": "Fix the ordering; don't wait it out." }] }` |
| "Parameter properties break Node type stripping" | Already on: `erasableSyntaxOnly` in the base tsconfig |
| "That pluralized wrong for 1" | A unit test on the wording helper |
