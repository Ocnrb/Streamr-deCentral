// Operator page: its numbers, sponsorships, slashings, nodes heard on its coordination stream, and saving it as a profile
import { test, expect } from '@playwright/test';
import { mockNetwork, openApp, hex } from './support/network.mjs';

let stats, errors;
test.beforeEach(async ({ page }) => {
    stats = await mockNetwork(page.context());
    errors = [];
    page.on('pageerror', e => errors.push(e.message));
});
test.afterEach(() => {
    expect(stats.invalidQueries, 'every subgraph query is valid for its schema').toEqual([]);
    expect(errors).toEqual([]);
});

const OPERATOR = hex(0xa0000);

test('an operator opens from the list', async ({ page }) => {
    await openApp(page, '/operators');
    await page.locator('#operators-grid .operator-card').first().click();
    await expect(page).toHaveURL(/\/operator\/0x[0-9a-f]{40}$/);
    await expect(page.locator('#detail-content')).toContainText('Sponsorships');
});

test('the operator page shows its numbers, stakes and nodes', async ({ page }) => {
    await openApp(page, `/operator/${OPERATOR}`);
    const detail = page.locator('#detail-content');
    await expect(detail).toContainText('Operator 0');
    await expect(detail).toContainText(/APY\s*12%/);
    await expect(page.locator('#header-stat-cut')).toHaveText(/^10\b/);
    await expect(detail).toContainText('Active (1)');
    await expect(detail).toContainText('Slashing Events (30)');
    // Operator 0 sends heartbeats from 2 nodes (n0-0 and a shared one)
    await expect(page.locator('#active-nodes-count-value')).toHaveText('2');
});

test('an operator is saved as a profile', async ({ page }) => {
    await openApp(page, `/operator/${OPERATOR}`);
    await expect(page.locator('#detail-content')).toContainText('Operator 0');
    await page.click('#desktop-save-profile-btn');
    await expect(page.locator('#sidebar-profiles-section')).toBeVisible();
    await expect(page.locator('#sidebar-profiles-section')).toContainText('Operator 0');
});
