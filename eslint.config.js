// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Type-aware linting on top of the compiler's strict mode: no `any` (written
 * or inferred), no unchecked assertions, no non-null `!`, and promises are
 * always handled.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.qlty/**'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Numbers format predictably in messages; objects, unknown and any stay banned.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Every function that returns a promise is async, so a throw always becomes a rejection, never a
      // synchronous exception. This contradicts require-await for bodies with nothing to await, so that one is off.
      '@typescript-eslint/promise-function-async': 'error',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
