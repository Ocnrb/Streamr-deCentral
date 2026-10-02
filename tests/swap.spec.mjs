// Swap page: the market trades of the DATA pools
import { test, expect } from '@playwright/test';
import { ethers } from 'ethers';
import { mockNetwork, openApp } from './support/network.mjs';

const V4_SWAP = ethers.utils.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const SQRT_PRICE = ethers.BigNumber.from('1252700000000000000000');   // 0.00025 USDC per DATA (DATA is currency0)

test.beforeEach(async ({ page }) => {
    await mockNetwork(page.context());
    // The main pool's swaps on Polygon: buys and sells of 0.00025 USDC per DATA
    await page.route(url => url.search.includes(`topic0=${V4_SWAP}`) && url.search.includes('chainid=137'), (route) => {
        const params = new URL(route.request().url()).searchParams;
        if (params.get('page') !== '1') return route.fulfill({ json: { status: '0', message: 'No records found', result: [] } });
        const from = Number(params.get('fromBlock'));
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
    await expect(rows.nth(0).locator('td').nth(1).locator('[data-tooltip-content]')).toHaveAttribute('data-tooltip-content', 'Polygon');
    // Buys and sells: their arrows at the same place in every row
    const arrows = await rows.evaluateAll(trs => trs.map(tr => Math.round([...tr.querySelectorAll('span')].find(s => s.textContent === '→').getBoundingClientRect().left)));
    expect(new Set(arrows).size).toBe(1);
});
