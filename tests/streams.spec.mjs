// Streams: a stream's page and a sponsorship's page, opened from the list or by their address
import { test, expect } from '@playwright/test';
import { mockNetwork, openApp } from './support/network.mjs';

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

const SPONSORSHIP = '0x000000000000000000000000000000000000b00b';
const SPONSORED_STREAM = '0x000000000000000000000000000000000000c00b/stream-11';

test('a stream opens from the list', async ({ page }) => {
    await openApp(page, '/streams');   // All Streams first
    const row = page.locator('#streams-list-view tr[data-nav-href]:visible').first();
    const id = await row.getAttribute('data-stream-id');
    await row.click();
    await expect(page.locator('#stream-detail-id')).toHaveText(id);
    await expect(page.locator('#stream-detail-view')).toContainText('Public (Subscribe Only)');
    await expect(page.locator('#stream-partitions')).toHaveText('1');
    await expect(page.locator('#stream-player-panel')).toBeVisible();
});

test('a sponsorship page shows its numbers, chart and partitions', async ({ page }) => {
    await openApp(page, `/stream/${encodeURIComponent(SPONSORED_STREAM)}?sponsored=true&sponsorshipId=${SPONSORSHIP}`);
    const view = page.locator('#stream-detail-view');
    await expect(view).toContainText(SPONSORSHIP);
    await expect(view).toContainText('APY 27%');
    await expect(view).toContainText('155 000 DATA');
    await expect(page.locator('#stream-partition-select option')).toHaveCount(3);   // All + 2 partitions
    // The chart and its controls
    const points = () => page.evaluate(() => window.Chart?.getChart(document.getElementById('stream-unified-chart'))?.data.datasets[0]?.data.length || 0);
    await expect.poll(points).toBeGreaterThan(10);
    await page.click('[data-stream-chart-type="stake"]');
    await page.click('[data-stream-days="30"]');
    await expect.poll(points).toBeGreaterThan(5);
});
