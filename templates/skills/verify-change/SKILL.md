---
name: verify-change
description: Use before calling any change done, and when opening a PR. Produces proof the change works (test output, screenshots, eval runs) instead of a claim.
---

# Verify the change, then show the proof

Review should look at evidence, not reread every line. Before saying "done":

1. **Static:** `npx harness check` passes (no new type or lint problems).
2. **Tests:** run the project's tests (`npx harness test`). Add one that fails without your change when the change is a fix.
3. **Run it for real**, the way a user would:
   - **CLI or job:** run it on a real or fixture input and keep the output.
   - **Web UI:** open it in a headless browser (Playwright), click through the changed flow, and save screenshots at the sizes people use.
   - **AI behavior:** run the eval set several times (`--runs 3`) and report the pass rate, not one lucky run.
4. **Write it down** in the PR's "How I verified it": what you ran, what you saw, and the artifacts.
5. **Say what you didn't verify** and why (no credentials, no device). Never imply you checked something you didn't.
