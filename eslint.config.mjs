// Lint: real problems are errors (undefined names, unreachable code...), style is left to the code's own conventions
import js from '@eslint/js';
import globals from 'globals';

// Libraries loaded outside the bundle as globals (public/libs); the npm ones are imported where they are used
const LIBRARIES = { StreamrClient: 'readonly', maplibregl: 'readonly' };

export default [
    { ignores: ['public/libs/**', 'dist/**', 'node_modules/**', 'test-results/**', 'playwright-report/**'] },
    js.configs.recommended,
    {
        files: ['main.js', 'src/**/*.js'],
        languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.browser, ...LIBRARIES } },
        rules: {
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
            'no-empty': ['error', { allowEmptyCatch: true }]
        }
    },
    {
        files: ['public/early.js'],
        languageOptions: { sourceType: 'script', globals: globals.browser },
        rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }] }
    },
    {
        files: ['public/sw.js'],
        languageOptions: { sourceType: 'script', globals: globals.serviceworker },
        rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }] }
    },
    {
        files: ['public/workers/**/*.js'],
        languageOptions: { sourceType: 'script', globals: globals.worker }
    },
    {
        files: ['tests/**/*.mjs', 'scripts/**/*.mjs', '*.config.mjs'],
        languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node, ...globals.browser } }
    }
];
