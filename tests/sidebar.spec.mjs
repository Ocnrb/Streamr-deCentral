// Sidebar: compact mode on desktop, kept in the browser, page names in a tooltip. The bottom bar on phones
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
    await expect(page.locator('#sidebar-tooltip')).toHaveText('Market');
});

const barLabels = (page) => page.locator('#bottom-nav .bottom-nav-item:visible > span:last-child');

test('phones have the bottom bar, with the other pages under More', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await expect(barLabels(page)).toHaveText(['Operator', 'Delegator', 'Overview', 'Streams', 'Market', 'More']);
    // The six fit the narrowest phones
    expect(await page.locator('#bottom-nav > div').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.click('#bottom-nav-more');
    const menu = page.locator('#bottom-nav-more-menu');
    await expect(menu).toContainText('Autostaker');
    await expect(menu).toContainText('Settings');
    await expect(menu).not.toContainText('Market');
    await page.click('#bottom-nav-autostaker');
    await expect(menu).toBeHidden();
});

test('a saved profile takes its list\'s place in the bar, and the list moves to More', async ({ page }) => {
    const id = '0x1111111111111111111111111111111111111111';
    await page.evaluate((id) => localStorage.setItem('userOperatorProfile', JSON.stringify({ id, name: 'My Node' })), id);
    await page.setViewportSize({ width: 320, height: 700 });
    await openApp(page, '/');
    await expect(barLabels(page)).toHaveText(['My Node', 'Delegator', 'Overview', 'Streams', 'Market', 'More']);
    await page.click('#bottom-nav-more');
    await expect(page.locator('#more-nav-operators')).toBeVisible();
    await expect(page.locator('#more-nav-delegators')).toBeHidden();
    await page.click('#bottom-nav-more');
    await page.click('#mobile-operator-profile-link');
    await expect(page).toHaveURL(new RegExp(`/operator/${id}$`));
});
