// ESLint flat config: recommended rules for the extension sources and tests.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'src/vendor/**', 'test/fixtures/media/**', 'node_modules/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.serviceworker, ...globals.webextensions },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Content scripts and site extractors are classic scripts (no modules).
    files: ['src/content/**/*.js', 'src/sites/bridge.js', 'src/sites/*/main.js'],
    languageOptions: { sourceType: 'script' },
  },
  {
    files: ['test/**/*.js', 'eslint.config.js', 'scripts/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
];
