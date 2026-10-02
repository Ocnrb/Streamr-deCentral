// Swap page: the market trades of the DATA pools
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { ethers } from 'ethers';
import { mockNetwork, openApp } from './support/network.mjs';

const V4_SWAP = ethers.utils.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const SQRT_PRICE = ethers.BigNumber.from('1252700000000000000000');   // 0.00025 USDC per DATA (DATA is currency0)

let ranges;   // block ranges asked of the main pool's swaps
test.beforeEach(async ({ page }) => {
    await mockNetwork(page.context());
    ranges = [];
    // Polygon blocks of 1.5 s (not the 2 s estimated)
    await page.route('**/*', (route) => {
        const body = route.request().postDataJSON?.();
        if (body?.method !== 'eth_getBlockByNumber') return route.fallback();
        const number = parseInt(body.params[0], 16);
        return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: {
            number: body.params[0], hash: ethers.utils.hexZeroPad(body.params[0], 32), parentHash: ethers.constants.HashZero, nonce: '0x0000000000000000',
            timestamp: '0x' + Math.floor(number * 1.5).toString(16), difficulty: '0x1', gasLimit: '0x1', gasUsed: '0x0', miner: ethers.constants.AddressZero,
            extraData: '0x', transactions: []
        } } });
    });
    // The main pool's swaps on Polygon: buys and sells of 0.00025 USDC per DATA
    await page.route(url => url.search.includes(`topic0=${V4_SWAP}`) && url.search.includes('chainid=137'), (route) => {
        const params = new URL(route.request().url()).searchParams;
        if (params.get('page') !== '1') return route.fulfill({ json: { status: '0', message: 'No records found', result: [] } });
        const from = Number(params.get('fromBlock'));
        ranges.push([from, Number(params.get('toBlock'))]);
        const now = Math.floor(Date.now() / 1000);
        const result = [500000, 2586, 19495, 66291].map((amount, i) => {
            const data = ethers.utils.parseUnits(String(amount), 18);
            const usdc = data.div(4000).div(ethers.BigNumber.from(10).pow(12));
            const buy = i % 2 === 1;
            return {
                address: '0x67366782805870060151383f4bbff9dab53e5cd6', topics: [V4_SWAP, ethers.constants.HashZero, ethers.constants.HashZero],
                data: ethers.utils.defaultAbiCoder.encode(['int128', 'int128', 'uint160', 'uint128', 'int24', 'uint24'], buy ? [data, usdc.mul(-1), SQRT_PRICE, 1, 0, 3000] : [data.mul(-1), usdc, SQRT_PRICE, 1, 0, 3000]),
                blockNumber: '0x' + (from + 1000 + i).toString(16), timeStamp: '0x' + (now - (4 - i) * 3000).toString(16), logIndex: '0x0',
                transactionHash: '0x' + String(i + 1).padStart(64, 'a')
            };
        });
        return route.fulfill({ json: { status: '1', message: 'OK', result } });
    });
});

test('market trades show their chain, with the trades lined up', async ({ page }) => {
    await openApp(page, '/swap');
    const rows = page.locator('#swap-trades tr');
    await expect(rows).toHaveCount(4, { timeout: 30000 });
    await expect(page.locator('#swap-trades').locator('xpath=ancestor::table//th').nth(1)).toHaveText('Chain');
    await expect(page.locator('#swap-submit')).toHaveText('Connect wallet');   // a guest
    await expect(rows.nth(0).locator('td').nth(1).locator('[data-tooltip-content]')).toHaveAttribute('data-tooltip-content', 'Polygon');
    // Buys and sells: their arrows at the same place in every row
    const arrows = await rows.evaluateAll(trs => trs.map(tr => Math.round([...tr.querySelectorAll('span')].find(s => s.textContent === '→').getBoundingClientRect().left)));
    expect(new Set(arrows).size).toBe(1);
});

test('the trades cover the whole 7 days, at the measured block time of the chain', async ({ page }) => {
    await openApp(page, '/swap');
    await expect(page.locator('#swap-trades tr')).toHaveCount(4, { timeout: 30000 });
    const [from, to] = ranges[0];
    expect(to - from).toBe(7 * 86400 / 1.5);
});

test('the all-time volume values the days the DEX subgraph has no USD for at the day\'s DATA price', async ({ page }) => {
    // The main pool's days: 1000 recent ones of $1 (a full page), then an old one without USD: 1 000 000 DATA
    const today = Math.floor(Date.now() / 86400000) * 86400;
    const old = Date.UTC(2024, 5, 1) / 1000;
    await page.route('https://gateway.thegraph.com/**', (route) => {
        const query = route.request().postDataJSON()?.query || '';
        if (!query.includes('poolDayDatas')) return route.fallback();
        const days = query.includes('date_lt')
            ? [{ date: old, volumeUSD: '0', txCount: '7', volumeToken0: '1000000', volumeToken1: '30000' }]
            : Array.from({ length: 1000 }, (_, i) => ({ date: today - i * 86400, volumeUSD: '1', txCount: '1', volumeToken0: '4000', volumeToken1: '1' }));
        return route.fulfill({ json: { data: Object.fromEntries([...query.matchAll(/(p\d+):/g)].map(([, alias], i) => [alias, i ? [] : days])) } });
    });
    const price = Number(fs.readFileSync(new URL('../public/data/DATAHistoricalPrice.csv', import.meta.url), 'utf8').split('\n').find(line => line.startsWith('01/06/2024,')).split(',')[1]);
    await openApp(page, '/swap');
    await page.click('#swap-chart-range [data-range="All"]');
    const stats = page.locator('#swap-market-stats');
    await expect(stats).toContainText('1 007 trades', { timeout: 30000 });
    const volume = Number((await stats.textContent()).match(/volume \$([\d ]+)/)[1].replace(/ /g, ''));
    expect(Math.abs(volume - (1000 + 1e6 * price))).toBeLessThan(2);
});

test('a DEX subgraph without token volumes still gives its USD volume', async ({ page }) => {
    const today = Math.floor(Date.now() / 86400000) * 86400;
    await page.route('https://gateway.thegraph.com/**', (route) => {
        const query = route.request().postDataJSON()?.query || '';
        if (!query.includes('poolDayDatas')) return route.fallback();
        if (query.includes('volumeToken0')) return route.fulfill({ json: { errors: [{ message: 'Type `PoolDayData` has no field `volumeToken0`' }] } });
        const days = [0, 1, 2].map(i => ({ date: today - i * 86400 * 20, volumeUSD: '10', txCount: '2' }));
        return route.fulfill({ json: { data: Object.fromEntries([...query.matchAll(/(p\d+):/g)].map(([, alias], i) => [alias, i ? [] : days])) } });
    });
    await openApp(page, '/swap');
    await page.click('#swap-chart-range [data-range="3M"]');
    await expect(page.locator('#swap-market-stats')).toHaveText('3M volume $30.00 · 6 trades', { timeout: 30000 });
});
