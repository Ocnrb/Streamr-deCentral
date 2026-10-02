// Phones in landscape: the login and the sidebar are taller than the screen, and scroll
import { test, expect } from '@playwright/test';
import { mockNetwork, openApp } from './support/network.mjs';

test.use({ viewport: { width: 844, height: 390 } });

test.beforeEach(async ({ page }) => {
    await mockNetwork(page.context());
});

test('the guest button is not under the install panel', async ({ page }) => {
    await page.goto('/operators', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#installAppSection')).toBeVisible();
    await page.click('#guestBtn');
    await expect(page.locator('#app-sidebar')).toBeVisible();
});

test('the sidebar scrolls to its last page', async ({ page }) => {
    await openApp(page, '/operators');
    const last = page.locator('#app-sidebar nav .nav-link').last();
    await page.mouse.move(36, 200);
    await page.mouse.wheel(0, 2000);
    // The last page's icon is shown (not under the wallet, nor cut off)
    await expect.poll(() => last.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom <= innerHeight && el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    })).toBe(true);
});
