import { builtinModules } from 'node:module';

import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

const sourceFiles = ['src/**/*.ts'];
const testFiles = ['__tests__/**/*.ts'];
const jsConfigFiles = ['**/*.js', '**/*.mjs'];

// Dynamically filter builtin modules instead of hardcoding a massive array
const nodeBuiltins = builtinModules.filter((m) => !m.startsWith('node:') && !m.startsWith('_'));
const nodeBuiltinImportRestrictions = nodeBuiltins.map((name) => ({
  name,
  message: `Use the node: protocol for Node.js built-ins, e.g. node:${name}.`,
}));

export default tseslint.config(
  {
    name: 'project/global-ignores',
    ignores: [
      'dist/**',
      'dist-test/**',
      'coverage/**',
      'node_modules/**',
      '.agents/**',
      '.claude/**',
      '.ua/**',
      'graphify-out/**',
      'logs/**',
      '.worktrees/**',
    ],
  },

  {
    name: 'project/linter-options',
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
  },

  {
    name: 'project/language-options',
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
    },
  },

  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  // Project-wide rule defaults applied to both src and tests.
  {
    name: 'project/common-rules',
    rules: {
      // Catch blocks frequently use `unknown`; numbers are safe to interpolate.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],

      // Allow `_`-prefixed args/vars/caught-errors as the deliberate unused-marker convention.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  {
    name: 'project/source',
    files: sourceFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript already checks undefined identifiers; ESLint core no-undef adds noise in TS projects.
      'no-undef': 'off',

      // MCP stdio servers must not write protocol-breaking logs to stdout.
      'no-console': ['error', { allow: ['error'] }],

      // Enforce node: protocol for Node.js built-ins.
      'no-restricted-imports': [
        'error',
        {
          paths: nodeBuiltinImportRestrictions,
        },
      ],

      // Catches accidental split value imports while still allowing separate type imports.
      'no-duplicate-imports': [
        'error',
        {
          includeExports: true,
          allowSeparateTypeImports: true,
        },
      ],

      // Low-noise correctness/style rules for server code.
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-implicit-coercion': 'error',
      'no-template-curly-in-string': 'error',
      'no-var': 'error',
      'object-shorthand': ['error', 'always'],
      'prefer-const': ['error', { destructuring: 'all' }],
      'prefer-object-has-own': 'error',
      'no-useless-assignment': 'error',
      'no-promise-executor-return': 'error',
      'preserve-caught-error': 'error',

      // TypeScript-specific discipline.
      '@typescript-eslint/no-deprecated': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
        },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',

      // Fire-and-forget promises must be explicit with void.
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true, ignoreIIFE: true }],

      // Express/MCP route handlers often pass async callbacks to APIs typed as void callbacks.
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: {
            arguments: false,
            attributes: false,
          },
        },
      ],

      // Useful for protocol enums, transport modes, Gemini finish reasons, tool profiles, etc.
      // Allow default cases (this codebase uses `assertNever(...)` defensively).
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        {
          allowDefaultCaseForExhaustiveSwitch: true,
          requireDefaultForNonUnion: false,
        },
      ],
    },
  },

  {
    name: 'project/registrar-boundaries',
    files: ['src/prompts.ts', 'src/resources.ts', 'src/tools/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: nodeBuiltinImportRestrictions,
          patterns: [
            {
              regex: '^(?:\\.\\.?/)+server\\.js$',
              message: 'Registrars own local dependency contracts; do not import server.ts.',
            },
          ],
        },
      ],
    },
  },

  {
    name: 'project/tests',
    files: testFiles,
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './tsconfig.test.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-undef': 'off',

      // Tests need looser ergonomics for mocks, fixtures, assertions, and deliberate edge cases.
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/dot-notation': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },

  {
    name: 'project/js-configs',
    files: jsConfigFiles,
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-undef': 'off',
    },
  },

  eslintConfigPrettier,
);
