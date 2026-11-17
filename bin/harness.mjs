#!/usr/bin/env node
// quality-harness CLI. Run `harness help`.
import { baseline, check, ci, format, hook, test } from '../lib/commands.mjs';
import { lint, types } from '../lib/checks.mjs';
import { init } from '../lib/init.mjs';
import { findRoot } from '../lib/project.mjs';

/** @import { Violation } from '../lib/types.mjs' */

const HELP = `quality-harness: make agent-written code trustworthy

  harness init       wire this project up (configs, PR check, Claude hook, skills)
  harness baseline   accept today's problems; afterwards only new ones fail
  harness check      types + lint; fails on problems the baseline doesn't cover
                     --against <ref>  also fail if the baseline grew vs that ref (PRs)
  harness test       run the test command from harness.config.json
  harness ci         check, then test (what the PR workflow runs)
  harness types      type-check only, every problem listed
  harness lint       lint only, every problem listed
  harness hook       Claude Code PostToolUse hook (reads JSON on stdin)`;

/**
 * `--name value` from argv, or undefined.
 * @param {string} name
 */
function flag(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/**
 * Print every problem one check finds (no baseline).
 * @param {(root: string) => Violation[] | Promise<Violation[]>} fn
 */
async function listAll(fn) {
  const root = findRoot();
  const found = await fn(root);
  if (found.length) {
    console.error(format(found, { limit: 500 }));
    console.error(`\n${found.length} problem(s). \`harness check\` only fails on ones not in the baseline.`);
    return 1;
  }
  console.log('✓ None.');
  return 0;
}

/** @type {Record<string, () => number | Promise<number>>} */
const commands = {
  init: () => init(),
  baseline: () => baseline(),
  check: () => check({ against: flag('--against') }),
  test: () => test(),
  ci: () => ci({ against: flag('--against') }),
  hook: () => hook(),
  types: () => listAll((root) => types(root)),
  lint: () => listAll((root) => lint(root)),
  help: () => (console.log(HELP), 0),
};

const name = process.argv[2] ?? 'help';
const run = commands[name];
if (!run) {
  console.error(`Unknown command: ${name}\n\n${HELP}`);
  process.exit(2);
}
try {
  process.exitCode = await run();
} catch (err) {
  console.error(`quality-harness: ${err instanceof Error ? err.message : String(err)}`);
  // A crashing hook must never block the agent; everything else fails loudly.
  process.exitCode = name === 'hook' ? 0 : 1;
}
