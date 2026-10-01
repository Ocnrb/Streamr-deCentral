// End-to-end tests: the app from a local server, with the subgraph, explorer, RPCs and Streamr mocked (tests/support)
import { defineConfig } from '@playwright/test';

const PORT = 5510;

export default defineConfig({
    testDir: 'tests',
    testMatch: '*.spec.mjs',
    timeout: 90000,
    expect: { timeout: 15000 },
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: `http://localhost:${PORT}`,
        viewport: { width: 1440, height: 900 },
        serviceWorkers: 'block',
        // A Chromium installed elsewhere (e.g. PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/...)
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}
    },
    webServer: {
        command: `node scripts/serve.mjs ${PORT}`,
        port: PORT,
        reuseExistingServer: !process.env.CI
    }
});
