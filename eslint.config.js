import js from '@eslint/js';
import globals from 'globals';
import json from '@eslint/json';
import css from '@eslint/css';
import {defineConfig} from 'eslint/config';

export default defineConfig([
  // Ignore generated and temporary files
  {
    ignores: [
      'tests/tmp/**/*',
      'tests/debug/**/*',
      'custom-output/**/*',
      'oceanoflights.org/**/*',
      '**/*.md',
      'node_modules/**/*',
      'package-lock.json'
    ]
  },

  // JavaScript source files
  {files: ['**/*.{js,mjs,cjs}'], plugins: {js}, extends: ['js/recommended']},
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {globals: {...globals.node, ...globals.es2022}},
    rules: {
      'no-unused-vars': ['error', {argsIgnorePattern: '^_'}]
    }
  },

  // Test files with vitest globals
  {
    files: ['tests/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2022,
        vi: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly'
      }
    }
  },

  // JSON files (excluding package-lock.json via ignores)
  {files: ['**/*.json'], plugins: {json}, language: 'json/json', extends: ['json/recommended']},
  {files: ['**/*.jsonc'], plugins: {json}, language: 'json/jsonc', extends: ['json/recommended']},
  {files: ['**/*.json5'], plugins: {json}, language: 'json/json5', extends: ['json/recommended']},

  // Markdown files (excluding generated content via ignores)
  // {files: ['**/*.md'], plugins: {markdown}, language: 'markdown/gfm', extends: ['markdown/recommended']},

  // CSS files
  {files: ['**/*.css'], plugins: {css}, language: 'css/css', extends: ['css/recommended']}
]);
