// Operator page: its numbers, sponsorships, slashings, nodes heard on its coordination stream, and saving it as a profile
import { test, expect } from '@playwright/test';
import { mockNetwork, openApp, hex, NOW } from './support/network.mjs';

const OPERATOR = hex(0xa0000);
const OWNER = hex(0xf000);
const TREASURY = '0x63f74a64fd334122ab5d29760c6e72fb4b752208';
const DRAINER = '0x5e5b9d124fb49e55311aee59a790dc1ef6ad4606';
const txHash = (n) => '0x' + String(n).padStart(64, '0');
const wei = (n) => (BigInt(Math.round(n * 1000)) * 10n ** 15n).toString();
const dataTransfer = (hash, secsAgo, from, to, amount) => ({
    hash, timeStamp: String(NOW - secsAgo), from, to, value: wei(amount), tokenSymbol: 'DATA', tokenDecimal: '18',
    contractAddress: '0x3a9a81d576d83ff21f26f325066054540720fc34'
});
// Operator 0's own transactions on Polygonscan: a V4 rebalance (out of sponsorship 0 with its earnings, into
// sponsorship 3) and the 2026-10-09 drain (no transaction of its own: transfers only)
const EXPLORER = {
    [OPERATOR]: {
        txlist: [{ hash: txHash(901), timeStamp: String(NOW - 300), from: OWNER, to: OPERATOR, value: '0', isError: '0', input: '0x38849a3a' + '0'.repeat(64) }],
        tokentx: [
            dataTransfer(txHash(901), 300, OPERATOR, hex(0xb003), 4000),
            dataTransfer(txHash(901), 300, OPERATOR, TREASURY, 0),
            dataTransfer(txHash(901), 300, hex(0xb000), OPERATOR, 5000),
            dataTransfer(txHash(901), 300, hex(0xb000), OPERATOR, 12.5),
            dataTransfer(txHash(902), 900, OPERATOR, DRAINER, 4591),
            dataTransfer(txHash(902), 900, OPERATOR, TREASURY, 918)
        ]
    }
};

let stats, errors;
test.beforeEach(async ({ page }) => {
    // The rebalance also staked into sponsorship 3 (its StakingEvent; leaving sponsorship 0 has none)
    stats = await mockNetwork(page.context(), { explorer: EXPLORER, stakingEvents: [{ operator: 0, sponsorship: 3, tx: 901, secsAgo: 300, amount: 104000 }] });
    errors = [];
    page.on('pageerror', e => errors.push(e.message));
});
test.afterEach(() => {
    expect(stats.invalidQueries, 'every subgraph query is valid for its schema').toEqual([]);
    expect(errors).toEqual([]);
});

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

test('the operator page shows its contract version, the list does not', async ({ page }) => {
    await openApp(page, '/operators');
    await expect(page.locator('#operators-grid .operator-card').first()).toBeVisible();
    await expect(page.locator('#operators-grid')).not.toContainText(/\bV[34]\b/);
    await openApp(page, `/operator/${OPERATOR}`);
    await expect(page.locator('#detail-content')).toContainText('Operator 0');
    await expect(page.locator('#detail-content')).toContainText('V4');
});

test('the history names V4 rebalances and the 2026-10-09 drain', async ({ page }) => {
    await openApp(page, `/operator/${OPERATOR}`);
    await expect(page.locator('#detail-content')).toContainText('Operator 0');
    await page.click('#sponsorship-tabs button[data-tab="history"]');
    const history = page.locator('#sponsorships-history-content');
    await expect(history).toContainText('Exploit Drain');
    await expect(history).toContainText('Collect Earnings');
    await expect(history).not.toContainText('0x38849a3a');
    // The rebalance: leaving sponsorship 0 (no StakingEvent at 0) is its own block with its earnings and tax,
    // the stake into sponsorship 3 another one
    const blocks = history.locator('div.relative');
    const exit = blocks.filter({ hasText: 'stream-0' }).filter({ hasText: 'Collect Earnings' });
    await expect(exit).toHaveCount(1);
    await expect(exit).toContainText('Unstaked');
    await expect(exit).toContainText('Protocol Tax');
    await expect(blocks.filter({ hasText: 'stream-3' }).filter({ hasText: /Staked\s*− 4\D?000 DATA/ })).toHaveCount(1);
});
