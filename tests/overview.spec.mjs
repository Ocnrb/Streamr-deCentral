// Overview page: the network numbers, their charts, the activity panels and the intro
import { test, expect } from '@playwright/test';
import { mockNetwork, openApp } from './support/network.mjs';

let stats;
test.beforeEach(async ({ page }) => {
    stats = await mockNetwork(page.context());
    await openApp(page, '/');
});
test.afterEach(() => {
    expect(stats.invalidQueries, 'every subgraph query is valid for its schema').toEqual([]);
});

const tile = (page, metric) => page.locator(`#overview-stats [data-stat="${metric}"]`);

test('network numbers', async ({ page }) => {
    await expect(tile(page, 'staked')).toContainText('96.0M');
    // Delegated: third parties only (owners hold 30% of the first 300 operators)
    await expect(tile(page, 'delegated')).toContainText('74.6M');
    await expect(tile(page, 'sponsorships')).toContainText('running of 20');
    await expect(tile(page, 'streams')).toContainText('2 500');
    // Slashings of the sponsorships, without the recovery sponsorship
    await expect(tile(page, 'slashed')).toContainText('81.5K');
    await expect(tile(page, 'slashed')).toContainText('31 slashings');
    // Nodes heard on the coordination streams (unique node ids)
    await expect(tile(page, 'operators')).toContainText('451 nodes', { timeout: 30000 });
    // Value tooltips start with the USD value; not for sums over the years
    await expect(tile(page, 'staked').locator('[data-tooltip-content]')).toHaveAttribute('data-tooltip-content', /^\$[\d ]+<br>96 000 000 DATA$/);
    await expect(tile(page, 'sponsored').locator('[data-tooltip-content]')).toHaveAttribute('data-tooltip-content', '2 950 000 DATA');
});

test('charts end on one point for today', async ({ page }) => {
    for (const metric of ['staked', 'operators', 'slashed']) {
        // Total staked opens with the page (a click would close it)
        if (await tile(page, metric).locator('[data-metric]').getAttribute('aria-pressed') !== 'true') await tile(page, metric).click();
        await expect.poll(() => page.evaluate(() => {
            const chart = window.Chart?.getChart(document.querySelector('#overview-chart canvas'));
            const points = chart?.data.datasets[0].data || [];
            if (points.length < 2) return null;
            const day = (p) => new Date(p.x).toISOString().slice(0, 10);
            return day(points.at(-2)) !== day(points.at(-1));
        }), { message: `${metric}: the last two points are on different days` }).toBe(true);
    }
});

test('the Y axis fits the line and never goes below 0', async ({ page }) => {
    // DATA slashed starts from 0 in All, Streams grows slowly: a fitted axis, no negative values
    await tile(page, 'slashed').click();
    await page.click('#overview-range [data-range="all"]');
    const axis = () => page.evaluate(() => {
        const chart = window.Chart?.getChart(document.querySelector('#overview-chart canvas'));
        return chart?.data.datasets[0].data.length > 10 ? { min: chart.scales.y.min, max: chart.scales.y.max } : null;
    });
    await expect.poll(async () => (await axis())?.min).toBe(0);
    await tile(page, 'streams').click();
    await page.click('#overview-range [data-range="30d"]');
    await expect.poll(async () => (await axis())?.min ?? -1).toBeGreaterThan(0);
});

test('the coordination streams are left once the nodes are counted', async ({ page }) => {
    const subscriptions = () => page.evaluate(() => window.__subscriptions || 0);
    await expect(tile(page, 'operators')).toContainText('451 nodes', { timeout: 30000 });
    await expect(page.locator('[data-action="nodes-refresh"]')).toBeEnabled({ timeout: 30000 });
    expect(await subscriptions()).toBe(0);
    // Counted again on request, and left when another page opens in the middle of it
    await page.click('[data-action="nodes-refresh"]');
    await expect.poll(subscriptions).toBeGreaterThan(0);
    await page.evaluate(() => window.router.navigate('/operators'));
    await expect.poll(subscriptions).toBe(0);
});

test('a 30-day chart starts from the records just before it', async ({ page }) => {
    await page.click('#overview-range [data-range="30d"]');
    // Total staked is 96.0M now and grows slowly: a sponsorship emptied before the range adds nothing
    const highest = () => page.evaluate(() => {
        const points = window.Chart?.getChart(document.querySelector('#overview-chart canvas'))?.data.datasets[0].data || [];
        return points.length > 20 ? Math.max(...points.map(p => p.y)) : null;
    });
    await expect.poll(highest).toBeGreaterThan(9e7);
    expect(await highest()).toBeLessThan(9.7e7);
});

test('operator and delegator activity', async ({ page }) => {
    const rows = page.locator('#overview-activity a');
    // Staking: the change of each action, unstakes included, collected earnings left out
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(0)).toContainText('Staked in');
    await expect(rows.nth(0)).toContainText('+250K DATA');
    await expect(rows.nth(1)).toContainText('+45.0K DATA');
    await expect(rows.nth(2)).toContainText('Slashed in');
    await expect(rows.nth(3)).toContainText('Unstaked from');
    await expect(rows.nth(3)).toContainText('-20.0K DATA');
    await expect(rows.nth(4)).toContainText('Reduced stake in');
    // Delegations: not the ones inside staking transactions, nor another contract's
    await page.click('#overview-activity-tabs [data-tab="delegations"]');
    await expect(rows).toHaveCount(3);
    await expect(page.locator('#overview-activity')).not.toContainText('999');
    // Earnings: the total, its split in the tooltip (the owner's own stake apart from the delegators)
    await page.click('#overview-activity-tabs [data-tab="earnings"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('+5.0K DATA');
    await expect(rows.nth(0).locator('[data-tooltip-content]')).toHaveAttribute('data-tooltip-content', /2 800 DATA to the delegators<br>500 DATA owner's cut<br>1 200 DATA to the owner's own stake/);
    // The lists keep their height whatever the tab
    const heights = [];
    for (const tab of ['staking', 'earnings', 'delegations', 'governance']) {
        await page.click(`#overview-activity-tabs [data-tab="${tab}"]`);
        heights.push(await page.locator('#overview-activity').evaluate(el => el.offsetHeight));
    }
    expect(new Set(heights).size).toBe(1);
});

test('network activity', async ({ page }) => {
    const rows = page.locator('#overview-network a');
    await expect(rows.first()).toContainText('New stream');
    // A sponsorship's creation below the sponsoring done in the same transaction
    await page.click('#overview-network-tabs [data-tab="sponsorships"]');
    await expect(rows.nth(0)).toContainText('+2.0K DATA');
    await expect(rows.nth(1)).toContainText('Sponsorship created');
    await expect(rows.nth(2)).toContainText('+7.5K DATA');
    // Permission changes (without the ones given with a new stream) and storage changes, newest first
    await page.click('#overview-network-tabs [data-tab="permissions"]');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('Storage node');
    await expect(rows.nth(0)).toContainText('Added');
    await expect(rows.nth(1)).toContainText('Everyone · publish, subscribe');
    await expect(rows.nth(2)).toContainText('Revoked');
    await expect(rows.nth(3)).toContainText('Removed');
    await expect(page.locator('#overview-network-tabs [data-tab="storage"]')).toHaveCount(0);
});

test('top operators skip the ones earning nothing', async ({ page }) => {
    const rows = page.locator('#overview-operators a');
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(0)).toContainText('Operator 298');
    await expect(rows.nth(1)).toContainText('Operator 295');
});

test('operator names are shown as text', async ({ page }) => {
    await page.click('#overview-activity-tabs [data-tab="staking"]');
    await expect(page.locator('#overview-activity')).toContainText('<img src=x onerror="window.__xss=1">Evil');
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('the intro can be closed for good and opened again', async ({ page }) => {
    const hero = page.locator('#overview-hero');
    await expect(hero).toBeVisible();
    await page.click('#overview-hero-close');
    await expect(hero).toBeHidden();
    // Hidden from the first paint on the next visit (set before the app runs)
    await page.reload({ waitUntil: 'commit' });
    await page.waitForSelector('#overview-hero', { state: 'attached' });
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('overview-hero')).display)).toBe('none');
    await openApp(page, '/');
    await page.click('#overview-hero-reopen button');
    await expect(hero).toBeVisible();
});
