// Shared ESLint config. A project's eslint.config.mjs is two lines:
//   import harness from 'quality-harness/eslint';
//   export default harness(config);   // config = harness.config.json
//
// What it enforces, and why (each rule is a correction turned into a check):
// - typescript-eslint strict, plus promise rules: agents drop `await` and pass async
//   callbacks where sync ones are expected; both fail silently at runtime.
// - no `any`: an `any` turns the type checker off for everything it touches.
// - eslint-disable needs a reason: no silent escape hatches.
// - boundaries: folders that must not import each other, from harness.config.json.
import js from '@eslint/js';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const TS = ['**/*.{ts,tsx,mts,cts}'];

/**
 * @param {{ root?: string, ignore?: string[], typeChecked?: boolean, untyped?: string[],
 *   boundaries?: { files: string[], disallow: string[], message?: string }[],
 *   rules?: Record<string, import('eslint').Linter.RuleEntry> }} [config]
 */
export default function harness(config = {}) {
  // root: the folder with harness.config.json. The template passes import.meta.dirname so typed
  // lint finds the right tsconfigs however the command was started (the hook runs from the repo root).
  const { root = process.cwd(), ignore = [], typeChecked = true, untyped = [], boundaries = [], rules = {} } = config;
  return defineConfig(
    {
      ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/.next/**', '**/*.gen.*', '.harness/**', ...ignore],
    },
    {
      languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
      linterOptions: { reportUnusedDisableDirectives: 'error' },
    },
    js.configs.recommended,
    ...tseslint.configs.strict.map((c) => ({ ...c, files: 'files' in c && Array.isArray(c.files) ? c.files : TS })),
    typeChecked
      ? {
          files: TS,
          languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: root } },
          rules: {
            '@typescript-eslint/no-floating-promises': 'error',
            // `onClick={async () => …}` is the normal React pattern; typescript-eslint recommends
            // not flagging promises passed to JSX attributes. Everywhere else still counts.
            '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
            '@typescript-eslint/await-thenable': 'error',
            '@typescript-eslint/switch-exhaustiveness-check': 'error',
          },
        }
      : {},
    // Files no tsconfig includes (tests run by ts-jest from the repo root, say) can't get type
    // information, so they get every rule that doesn't need it. List them in `untyped`.
    ...(typeChecked && untyped.length
      ? [{ ...tseslint.configs.disableTypeChecked, files: untyped }, { files: untyped, languageOptions: { parserOptions: { projectService: false, project: null } } }]
      : []),
    comments.recommended,
    {
      rules: {
        '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
        '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
        eqeqeq: ['error', 'smart'],
        'no-var': 'error',
        'prefer-const': 'error',
      },
    },
    {
      files: TS,
      rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        '@typescript-eslint/consistent-type-imports': 'error',
      },
    },
    {
      // Tests: node:test's describe/test return promises nobody awaits, and `!` on a
      // value the test just asserted is fine. Source code keeps both rules.
      files: ['**/*.{test,spec}.{ts,tsx,mts,cts,js,mjs}', '**/test/**', '**/tests/**', '**/__tests__/**'],
      rules: {
        '@typescript-eslint/no-floating-promises': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
    ...boundaries.map((b) => ({
      files: b.files,
      rules: {
        'no-restricted-imports': /** @type {import('eslint').Linter.RuleEntry} */ ([
          'error',
          { patterns: [{ group: b.disallow, message: b.message ?? `Not allowed from ${b.files.join(', ')}. See boundaries in harness.config.json.` }] },
        ]),
      },
    })),
    { rules },
  );
}
