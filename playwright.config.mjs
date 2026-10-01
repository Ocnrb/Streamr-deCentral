// End-to-end tests with the subgraph, explorer, RPCs and Streamr mocked (tests/support). The app is the production
// build (npm test builds it first); tests of single modules (*.modules.spec.mjs) use the Vite dev server instead.
import { defineConfig } from '@playwright/test';

const PORT = 5510;
const DEV_PORT = 5511;

export default defineConfig({
    testDir: 'tests',
    timeout: 90000,
    expect: { timeout: 15000 },
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    projects: [
        { name: 'app', testMatch: '*.spec.mjs', testIgnore: '*.modules.spec.mjs', use: { baseURL: `http://localhost:${PORT}` } },
        { name: 'modules', testMatch: '*.modules.spec.mjs', use: { baseURL: `http://localhost:${DEV_PORT}` } }
    ],
    use: {
        viewport: { width: 1440, height: 900 },
        serviceWorkers: 'block',
        // A Chromium installed elsewhere (e.g. PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/...)
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}
    },
    webServer: [
        { command: `node scripts/serve.mjs ${PORT} dist`, port: PORT, reuseExistingServer: !process.env.CI },
        { command: `npx vite --port ${DEV_PORT} --strictPort`, port: DEV_PORT, reuseExistingServer: !process.env.CI }
    ]
});
