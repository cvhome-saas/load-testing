import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['build/**', 'node_modules/**', 'results/**', 'screenshots/**'],
  },
  {
    files: ['k6/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.es2021,
        __ENV: 'readonly',
        __VU: 'readonly',
        console: 'readonly',
        open: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['k6/lib/journeys/browser/pages/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
      },
    },
  },
];
