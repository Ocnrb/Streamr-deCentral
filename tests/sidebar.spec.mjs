// Sidebar: compact mode on desktop, kept in the browser, page names in a tooltip
import { test, expect } from '@playwright/test';
import { mockNetwork, openApp } from './support/network.mjs';

test.beforeEach(async ({ page }) => {
    await mockNetwork(page.context());
    await openApp(page, '/operators');
});

// The sidebar animates its width (300 ms): read it once it settles
const expectWidth = (page, width) => expect.poll(() => page.locator('#app-sidebar').evaluate(el => el.offsetWidth)).toBe(width);

test('compact mode is kept and shows names on hover', async ({ page }) => {
    await expectWidth(page, 288);
    await page.click('#sidebar-compact-toggle');
    await expectWidth(page, 72);
    await expect(page.locator('#desktop-header')).toHaveCSS('left', '72px');
    // The page name next to the icon
    await page.hover('#app-sidebar .nav-link[data-nav="streams"]');
    await expect(page.locator('#sidebar-tooltip')).toHaveClass(/visible/);
    await expect(page.locator('#sidebar-tooltip')).toHaveText('Streams');
    // Compact from the first paint on the next visit
    await page.reload({ waitUntil: 'commit' });
    await page.waitForSelector('#app-sidebar', { state: 'attached' });
    expect(await page.evaluate(() => document.documentElement.classList.contains('sidebar-compact'))).toBe(true);
    // Expanded again from the logo row
    await openApp(page, '/operators');
    await page.hover('#sidebar-logo');
    await page.click('#sidebar-compact-toggle');
    await expectWidth(page, 288);
});

test('tablets have the compact sidebar, with the tooltips and no toggle', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await expectWidth(page, 72);
    await expect(page.locator('#sidebar-compact-toggle')).toBeHidden();
    await page.hover('#app-sidebar .nav-link[data-nav="swap"]');
    await expect(page.locator('#sidebar-tooltip')).toHaveText('Swap');
});
