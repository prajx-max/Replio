import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-fixture/**',
      'apps/api/public/setup.js',
      '**/node_modules/**',
      '**/coverage/**',
      '.pnpm-*/**',
      '.dependency-metadata/**',
      '**/.types/**',
      '.browser-cache/**',
      'artifacts/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/test-fixtures/whatsapp-page/fixture.js'],
    languageOptions: {
      globals: { document: 'readonly', URL: 'readonly', location: 'readonly' },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
