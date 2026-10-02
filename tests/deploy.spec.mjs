// A page opened before a deploy asks for chunks the new build no longer has: it reloads once to get the new build
import { test, expect } from '@playwright/test';
import { mockNetwork, openApp } from './support/network.mjs';

const OVERVIEW_CHUNK = /\/assets\/overview-[\w-]+\.js$/;

/** Counts the page's loads (the first one and each reload) and the ones whose app has started */
function countLoads(page) {
    const loads = { count: 0, ready: 0 };
    page.on('request', (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) loads.count++;
    });
    page.on('domcontentloaded', () => loads.ready++);
    return loads;
}

/** Waits for the reloaded app and enters as a guest again */
async function afterReload(page, loads) {
    await expect.poll(() => loads.ready).toBe(2);
    await page.locator('#guestBtn').click();
}

test('a chunk missing after a deploy reloads the page once', async ({ page }) => {
    await mockNetwork(page.context());
    const loads = countLoads(page);
    // Missing on the first load only, as for a page opened before the deploy
    await page.route(OVERVIEW_CHUNK, (route) => (loads.count < 2 ? route.fulfill({ status: 404, body: 'Not found' }) : route.continue()));
    await openApp(page, '/');
    await afterReload(page, loads);
    await expect(page.locator('#overview-range [data-range="1y"]')).toHaveClass(/bg-blue-800/, { timeout: 30000 });
    expect(loads.count).toBe(2);
    await expect(page.locator('#toast-container')).not.toContainText('Failed to load');
});

test('a chunk that keeps failing reloads once, then shows its error', async ({ page }) => {
    await mockNetwork(page.context());
    const loads = countLoads(page);
    await page.route(OVERVIEW_CHUNK, (route) => route.fulfill({ status: 404, body: 'Not found' }));
    await openApp(page, '/');
    await afterReload(page, loads);
    await expect(page.locator('#toast-container')).toContainText('Failed to load Overview', { timeout: 30000 });
    await page.waitForTimeout(1000);
    expect(loads.count).toBe(2);
});
