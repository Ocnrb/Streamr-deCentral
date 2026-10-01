// Lint: real problems are errors (undefined names, unreachable code...), style is left to the code's own conventions
import js from '@eslint/js';
import globals from 'globals';

// Libraries loaded by index.html as globals (see /libs)
const LIBRARIES = { ethers: 'readonly', Chart: 'readonly', d3: 'readonly', L: 'readonly', lucide: 'readonly', StreamrClient: 'readonly', maplibregl: 'readonly' };

export default [
    { ignores: ['libs/**', 'node_modules/**', 'styles.css', 'test-results/**', 'playwright-report/**'] },
    js.configs.recommended,
    {
        files: ['main.js', 'src/**/*.js'],
        languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.browser, ...LIBRARIES } },
        rules: {
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
            'no-empty': ['error', { allowEmptyCatch: true }]
        }
    },
    {
        files: ['src/early.js'],
        languageOptions: { sourceType: 'script', globals: globals.browser }
    },
    {
        files: ['sw.js'],
        languageOptions: { sourceType: 'script', globals: globals.serviceworker },
        rules: { 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }] }
    },
    {
        files: ['workers/**/*.js'],
        languageOptions: { sourceType: 'script', globals: globals.worker }
    },
    {
        files: ['tests/**/*.mjs', 'scripts/**/*.mjs', '*.config.mjs'],
        languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node, ...globals.browser } }
    }
];
