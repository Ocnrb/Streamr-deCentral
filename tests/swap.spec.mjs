// Swap page: the market trades of the DATA pools
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { ethers } from 'ethers';
import { mockNetwork, openApp } from './support/network.mjs';

const V4_SWAP = ethers.utils.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const SQRT_PRICE = ethers.BigNumber.from('1252700000000000000000');   // 0.00025 USDC per DATA (DATA is currency0)

// The main pool's storage in the PoolManager (extsload): its price, and one position 10 levels (600 ticks) each side of it
const POOL_ID = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'address', 'uint24', 'int24', 'address'],
    ['0x3a9a81d576d83ff21f26f325066054540720fc34', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', 3000, 60, ethers.constants.AddressZero]));
const STATE_SLOT = ethers.BigNumber.from(ethers.utils.keccak256(ethers.utils.solidityPack(['bytes32', 'bytes32'], [POOL_ID, ethers.utils.hexZeroPad('0x06', 32)])));
const TICK = Math.floor(Math.log((Number(SQRT_PRICE.toString()) / 2 ** 96) ** 2) / Math.log(1.0001));
const BASE = Math.floor(TICK / 60) * 60;
const LIQUIDITY = ethers.BigNumber.from(10).pow(18);
const word = (value) => ethers.utils.hexZeroPad(ethers.BigNumber.from(value).toTwos(256).toHexString(), 32);
const POOL_STORAGE = new Map([
    [word(STATE_SLOT), word(ethers.BigNumber.from(TICK).toTwos(24).shl(160).or(SQRT_PRICE))],
    [word(STATE_SLOT.add(3)), word(LIQUIDITY)],
    ...[[BASE - 600, LIQUIDITY], [BASE + 600, LIQUIDITY.mul(-1)]].map(([tick, net]) => [
        ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['int24', 'bytes32'], [tick, word(STATE_SLOT.add(4))])),
        word(net.toTwos(128).shl(128).or(LIQUIDITY))
    ])
]);
const EXTSLOAD = new ethers.utils.Interface(['function extsload(bytes32[] slots) view returns (bytes32[])']);

let ranges;   // block ranges asked of the main pool's swaps
/** The swap page, once its modules listen (the swap button is set after the market and the book): a click before is lost */
async function openSwap(page) {
    await openApp(page, '/swap');
    await expect(page.locator('#swap-submit')).toHaveText('Connect wallet', { timeout: 30000 });
}

test.beforeEach(async ({ page }) => {
    await mockNetwork(page.context());
    ranges = [];
    // Polygon blocks of 1.5 s (not the 2 s estimated)
    await page.route('**/*', (route) => {
        const body = route.request().postDataJSON?.();
        const call = body?.method === 'eth_call' ? body.params[0] : null;
        if (call?.to?.toLowerCase() === '0x67366782805870060151383f4bbff9dab53e5cd6' && call.data.startsWith(EXTSLOAD.getSighash('extsload'))) {
            const [slots] = EXTSLOAD.decodeFunctionData('extsload', call.data);
            const result = EXTSLOAD.encodeFunctionResult('extsload', [slots.map(slot => POOL_STORAGE.get(slot.toLowerCase()) || ethers.constants.HashZero)]);
            return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result } });
        }
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

test('the all-time volume counts the emptied pools, and prices their old days from the DEX subgraphs', async ({ page }) => {
    // Polygon's Uniswap v4: an emptied DATA/USDC pool (counted), and one against an unknown token (left out)
    const DATA = '0x3a9a81d576d83ff21f26f325066054540720fc34', USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
    const EMPTIED = '0x' + 'e'.repeat(64), FAKE = '0x' + 'f'.repeat(64);
    const day2021 = Date.UTC(2021, 5, 1) / 1000;
    const asked = [];
    await page.route('https://gateway.thegraph.com/**', (route) => {
        const v4 = route.request().url().includes('2CB2uQxcDKWDenagn2z17KQVCtfwSx5eXYuvqTciRTJu');
        const query = route.request().postDataJSON()?.query || '';
        asked.push(query);
        if (query.includes('tokenDayDatas')) {
            return route.fulfill({ json: { data: { tokenDayDatas: route.request().url().includes('GmSczq') ? [{ date: day2021, priceUSD: '0.1' }] : [] } } });
        }
        if (query.includes('token0: {') || query.includes('token0 {')) {
            const pools = v4 ? [{ id: EMPTIED, token0: { id: DATA }, token1: { id: USDC } }, { id: FAKE, token0: { id: DATA }, token1: { id: '0x' + '1'.repeat(40) } }] : [];
            return route.fulfill({ json: { data: { token0: pools, token1: [] } } });
        }
        if (!query.includes('poolDayDatas')) return route.fallback();
        // Each alias: its pool's days (the emptied pool: 2021, 1000 DATA without USD)
        const data = Object.fromEntries([...query.matchAll(/(p\d+): poolDayDatas\(.*?pool: "([^"]+)"/g)].map(([, alias, pool]) => [alias,
            pool === EMPTIED ? [{ date: day2021, volumeUSD: '0', txCount: '3', volumeToken0: '1000', volumeToken1: '0' }] : []]));
        return route.fulfill({ json: { data } });
    });
    await openApp(page, '/swap');
    await page.click('#swap-chart-range [data-range="All"]');
    await expect(page.locator('#swap-market-stats')).toHaveText('All-time volume $100.00 · 3 trades', { timeout: 30000 });
    expect(asked.some(query => query.includes(FAKE) && query.includes('poolDayDatas'))).toBe(false);
});

test('the order book shows the main pool\'s liquidity by price, in place of the trades', async ({ page }) => {
    await openApp(page, '/swap');
    await page.click('[data-market-view="book"]');
    await expect(page.locator('#swap-trades-view')).toBeHidden();
    await expect(page.locator('#swap-trades-filter')).toBeHidden();
    await expect(page.locator('#swap-book-pool')).toHaveText('Uniswap v4 · DATA/USDC 0.3%');
    // The position's 10 levels above the price (DATA for sale) and the 11 below it (the one the price is in, then 10)
    const asks = page.locator('#swap-book-asks > div');
    const bids = page.locator('#swap-book-bids > div');
    await expect(asks).toHaveCount(10, { timeout: 30000 });
    await expect(bids).toHaveCount(11);
    await expect(page.locator('#swap-book-mid')).toContainText('$0.0002500');
    await expect(page.locator('#swap-book-mid')).toContainText('2% depth');
    // The nearest ask just above the price, the farthest at the top
    const prices = await asks.evaluateAll(rows => rows.map(row => Number(row.querySelector('span').textContent.replace('$', ''))));
    expect(prices[prices.length - 1]).toBeGreaterThan(0.00025);
    expect(prices[0]).toBeGreaterThan(prices[prices.length - 1]);
    // Back to the trades
    await page.click('[data-market-view="trades"]');
    await expect(page.locator('#swap-trades-view')).toBeVisible();
    await expect(page.locator('#swap-book-view')).toBeHidden();
});

test('the swap form switches to Ethereum: its tokens and DEXes, kept for the next visit', async ({ page }) => {
    await openSwap(page);
    const options = () => page.locator('#swap-from-token select option').allTextContents();
    expect(await options()).toEqual(['POL', 'USDC', 'USDC.e']);
    await page.click('#swap-chain [data-chain="1"]');
    expect(await options()).toEqual(['ETH', 'USDC', 'USDT']);
    await expect(page.locator('[data-chain-text="1"]')).toContainText('On Ethereum');
    await expect(page.locator('[data-chain-text="137"]')).toBeHidden();
    await expect(page.locator('#swap-pools-btn')).toBeHidden();
    // ETH for POL, and back
    await page.selectOption('#swap-from-token select', 'ETH');
    await openSwap(page);   // a new visit
    await expect(page.locator('#swap-chain [data-chain="1"]')).toHaveClass(/bg-blue-800/);
    await page.click('#swap-chain [data-chain="137"]');
    expect(await options()).toEqual(['POL', 'USDC', 'USDC.e']);
    await expect(page.locator('#swap-pools-btn')).toBeVisible();
});

test('on Ethereum the quote goes through its Uniswap v4 pool', async ({ page }) => {
    // Ethereum's RPC: the DATA/ETH 0.3% v4 pool in its PoolManager, and the v4 quoter giving 16M DATA per ETH
    const MANAGER = '0x000000000004444c5dc75cb358380d2e3de08a90', QUOTER = '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203';
    const id = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'address', 'uint24', 'int24', 'address'],
        [ethers.constants.AddressZero, '0x8f693ca8d21b157107184d29d398a8d082b38b76', 3000, 60, ethers.constants.AddressZero]));
    const state = ethers.BigNumber.from(ethers.utils.keccak256(ethers.utils.solidityPack(['bytes32', 'bytes32'], [id, ethers.utils.hexZeroPad('0x06', 32)])));
    const storage = new Map([[word(state), word(ethers.BigNumber.from(2).pow(96).mul(4000))], [word(state.add(3)), word(LIQUIDITY)]]);
    const multicall = new ethers.utils.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
    const extsload = new ethers.utils.Interface(['function extsload(bytes32 slot) view returns (bytes32)']);
    const quoter = new ethers.utils.Interface(['function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)']);
    await page.route('https://ethereum-rpc.publicnode.com/**', (route) => {
        const body = route.request().postDataJSON();
        const call = body.method === 'eth_call' ? body.params[0] : null;
        let result = null;
        if (call?.to?.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11') {
            const [calls] = multicall.decodeFunctionData('aggregate3', call.data);
            result = multicall.encodeFunctionResult('aggregate3', [calls.map(c => {
                if (c.target.toLowerCase() === MANAGER && c.callData.startsWith(extsload.getSighash('extsload'))) {
                    const [slot] = extsload.decodeFunctionData('extsload', c.callData);
                    return { success: true, returnData: extsload.encodeFunctionResult('extsload', [storage.get(slot.toLowerCase()) || ethers.constants.HashZero]) };
                }
                return { success: true, returnData: ethers.utils.hexZeroPad('0x', 32) };   // no Uniswap v3 pool, nothing else
            })]);
        } else if (call?.to?.toLowerCase() === QUOTER) {
            const [params] = quoter.decodeFunctionData('quoteExactInputSingle', call.data);
            result = quoter.encodeFunctionResult('quoteExactInputSingle', [params.exactAmount.mul(16000000), 100000]);
        }
        return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result } });
    });
    await openSwap(page);
    await page.click('#swap-chain [data-chain="1"]');
    await page.selectOption('#swap-from-token select', 'ETH');
    await page.fill('#swap-amount', '1');
    await expect(page.locator('#swap-receive')).toHaveText('16 000 000', { timeout: 30000 });
    await expect(page.locator('#swap-route')).toHaveText('Uniswap v4 (0.3%) · ETH → DATA');
});
