// Shared types for the harness, as JSDoc so the package stays plain JavaScript that tsc checks.
// Import them with `/** @import { Violation } from './types.mjs' */`.

/**
 * One problem from a check.
 * @typedef {object} Violation
 * @property {'lint' | 'types'} tool
 * @property {string} file    relative to the project root, posix-style; `(tsconfig.json)` for project-level errors
 * @property {string} rule    ESLint rule id, `parse-error`, or a TS code like TS2322
 * @property {number} line    1-based; 0 when the problem has no position
 * @property {number} col
 * @property {string} message
 * @property {string} [key]   set by `fingerprint`: tool|file|rule|hash of the line's text
 */

/** @typedef {Violation & { key: string }} Fingerprinted */

/**
 * A folder rule: files matching `files` may not import anything matching `disallow`.
 * @typedef {object} Boundary
 * @property {string[]} files
 * @property {string[]} disallow
 * @property {string} [message]
 */

/**
 * harness.config.json, with defaults filled in.
 * @typedef {object} HarnessConfig
 * @property {string} test            shell command for `harness test`; '' to skip
 * @property {Boundary[]} boundaries
 * @property {string[]} ignore        extra globs ESLint skips
 * @property {boolean} typeChecked    run the rules that need type information
 * @property {string[]} [untyped]     globs outside every tsconfig: linted without type information
 * @property {string[]} [tsconfigs]   tsconfig files to check; default: the root one, else one per workspace
 * @property {{ typecheck: boolean }} hook
 * @property {Record<string, import('eslint').Linter.RuleEntry>} [rules]  rule overrides, passed to ESLint as-is
 */

/**
 * .harness/baseline.json
 * @typedef {object} Baseline
 * @property {number} version
 * @property {string} [note]
 * @property {number} total
 * @property {Record<string, number>} counts   fingerprint key → how many are tolerated
 */

/**
 * Where commands write. `console` fits; tests pass a recorder.
 * @typedef {object} Log
 * @property {(...args: unknown[]) => void} log
 * @property {(...args: unknown[]) => void} error
 */

/**
 * The parts of package.json the harness reads or writes.
 * @typedef {object} PackageJson
 * @property {string} [name]
 * @property {Record<string, string>} [scripts]
 * @property {Record<string, string>} [dependencies]
 * @property {Record<string, string>} [devDependencies]
 * @property {{ node?: string }} [engines]
 * @property {string[] | { packages?: string[] }} [workspaces]
 */

/**
 * The parts of .claude/settings.json the harness merges into.
 * @typedef {{ type: string, command: string, timeout?: number }} HookEntry
 * @typedef {{ matcher?: string, hooks?: HookEntry[] }} HookGroup
 * @typedef {{ hooks?: { PostToolUse?: HookGroup[] } & Record<string, unknown> } & Record<string, unknown>} ClaudeSettings
 */

export {};
