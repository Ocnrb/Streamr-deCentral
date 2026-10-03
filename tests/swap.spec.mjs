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
const POSITION = [[BASE - 600, LIQUIDITY], [BASE + 600, LIQUIDITY.mul(-1)]];
const bitmapSlot = (tick) => ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['int16', 'bytes32'], [Math.floor(tick / 60) >> 8, word(STATE_SLOT.add(5))]));
const POOL_STORAGE = new Map([
    [word(STATE_SLOT), word(ethers.BigNumber.from(TICK).toTwos(24).shl(160).or(SQRT_PRICE))],
    [word(STATE_SLOT.add(3)), word(LIQUIDITY)],
    ...POSITION.map(([tick, net]) => [
        ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['int24', 'bytes32'], [tick, word(STATE_SLOT.add(4))])),
        word(net.toTwos(128).shl(128).or(LIQUIDITY))
    ])
]);
// The tick bitmap: a bit per initialized tick (tick / spacing), 256 to a word
for (const [tick] of POSITION) {
    const slot = bitmapSlot(tick);
    const bit = ((Math.floor(tick / 60) % 256) + 256) % 256;
    POOL_STORAGE.set(slot, word(ethers.BigNumber.from(POOL_STORAGE.get(slot) || 0).or(ethers.BigNumber.from(1).shl(bit))));
}
const MULTICALL = new ethers.utils.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
const EXTSLOAD = new ethers.utils.Interface(['function extsload(bytes32 slot) view returns (bytes32)']);

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
        // Multicall3: the PoolManager's storage reads answered, any other call failed
        if (call?.to?.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11' && call.data.startsWith(MULTICALL.getSighash('aggregate3'))) {
            const [calls] = MULTICALL.decodeFunctionData('aggregate3', call.data);
            const result = MULTICALL.encodeFunctionResult('aggregate3', [calls.map(c => {
                if (c.target.toLowerCase() !== '0x67366782805870060151383f4bbff9dab53e5cd6' || !c.callData.startsWith(EXTSLOAD.getSighash('extsload'))) return { success: false, returnData: '0x' };
                const [slot] = EXTSLOAD.decodeFunctionData('extsload', c.callData);
                return { success: true, returnData: EXTSLOAD.encodeFunctionResult('extsload', [POOL_STORAGE.get(slot.toLowerCase()) || ethers.constants.HashZero]) };
            })]);
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
    await openSwap(page);
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
    await openSwap(page);
    await expect(page.locator('#swap-trades tr')).toHaveCount(4, { timeout: 30000 });
    const [from, to] = ranges[0];
    expect(to - from).toBe(7 * 86400 / 1.5);
});

test('the trade chart holds each price from its trade until the next one', async ({ page }) => {
    await openSwap(page);
    await expect(page.locator('#swap-trades tr')).toHaveCount(4, { timeout: 30000 });
    await page.click('#swap-chart-range [data-range="7D"]');
    const chart = () => page.evaluate(() => {
        const dataset = window.Chart?.getChart(document.querySelector('#swap-chart canvas'))?.data.datasets[0];
        return dataset && { stepped: dataset.stepped, xs: dataset.data.map(p => p.x) };
    });
    await expect.poll(async () => (await chart())?.xs.length || 0, { timeout: 30000 }).toBeGreaterThan(2);
    const { stepped, xs } = await chart();
    // 'before': flat at the old price up to the trade, then the step (not the new price drawn from the trade before)
    expect(stepped).toBe('before');
    expect(new Set(xs).size).toBe(xs.length);
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
    await openSwap(page);
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
    await openSwap(page);
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
    await openSwap(page);
    await page.click('#swap-chart-range [data-range="All"]');
    await expect(page.locator('#swap-market-stats')).toHaveText('All-time volume $100.00 · 3 trades', { timeout: 30000 });
    expect(asked.some(query => query.includes(FAKE) && query.includes('poolDayDatas'))).toBe(false);
});

test('the liquidity book shows the v4 pools\' liquidity by price, in place of the trades', async ({ page }) => {
    await openSwap(page);
    // The info icon is the books' only
    await expect(page.locator('#swap-book-info')).toBeHidden();
    await page.click('[data-market-view="book"]');
    await expect(page.locator('#swap-trades-view')).toBeHidden();
    await expect(page.locator('#swap-trades-filter')).toBeVisible();
    await expect(page.locator('#swap-book-info')).toBeVisible();
    // The position's 600 ticks each side of the price: up to 6.2%, 12 or 13 levels of 0.5% each way (where the price sits in its tick)
    const asks = page.locator('#swap-book-asks > div');
    const bids = page.locator('#swap-book-bids > div');
    await expect(asks.first()).toBeVisible({ timeout: 30000 });
    for (const side of [asks, bids]) {
        const count = await side.count();
        expect(count).toBeGreaterThanOrEqual(11);
        expect(count).toBeLessThanOrEqual(13);
    }
    const narrow = await asks.count();
    const mid = page.locator('#swap-book-mid');
    await expect(mid).toContainText('$0.0002500');
    await expect(mid).toContainText('1 pool');
    await expect(mid).toContainText('Levels');
    // The nearest ask just above the price, the farthest at the top
    const prices = await asks.evaluateAll(rows => rows.map(row => Number(row.querySelector('span').textContent.replace('$', ''))));
    expect(prices[prices.length - 1]).toBeGreaterThan(0.00025);
    expect(prices[0]).toBeGreaterThan(prices[prices.length - 1]);
    // Wider levels: the position fits in fewer of them
    await page.click('[data-book-step="1"]');
    await expect(mid).toContainText('1%');
    await expect.poll(() => asks.count()).toBeLessThan(narrow);
    // The swap form's chain sets the books' (no v4 pool read on Ethereum here: nothing)
    await page.click('#swap-chain [data-chain="1"]');
    await expect(page.locator('#swap-trades-filter [data-filter="ethereum"]')).toHaveClass(/bg-blue-800/);
    await expect(mid).toContainText('No pool liquidity read on this chain.');
    // Not the other way round
    await page.click('#swap-trades-filter [data-filter="polygon"]');
    await expect(page.locator('#swap-chain [data-chain="1"]')).toHaveClass(/bg-blue-800/);
    // Back to the trades
    await page.click('[data-market-view="trades"]');
    await expect(page.locator('#swap-trades-view')).toBeVisible();
    await expect(page.locator('#swap-book-view')).toBeHidden();
    await expect(page.locator('#swap-book-info')).toBeHidden();
});

test('the market opens on the swap form\'s chain', async ({ page }) => {
    const active = (chain) => expect(page.locator(`#swap-trades-filter [data-filter="${chain}"]`)).toHaveClass(/bg-blue-800/);
    await openSwap(page);
    await active('polygon');
    // The form kept on Ethereum: the market opens there too
    await page.click('#swap-chain [data-chain="1"]');
    await page.reload();
    await openSwap(page);
    await expect(page.locator('#swap-chain [data-chain="1"]')).toHaveClass(/bg-blue-800/);
    await active('ethereum');
});

test('hovering a book level highlights the levels from the price to it and sums them in a tooltip', async ({ page }) => {
    await openSwap(page);
    await page.click('[data-market-view="book"]');
    const bids = page.locator('#swap-book-bids > div');
    await expect(bids.first()).toBeVisible({ timeout: 30000 });
    const rows = await bids.evaluateAll(list => list.map(row => [...row.querySelectorAll('span')].map(span => span.textContent)));
    await bids.nth(2).hover();
    // The three nearest bids, and only them
    await expect(page.locator('#swap-book-bids > div.bg-white\\/\\[0\\.06\\]')).toHaveCount(3);
    const tooltip = page.locator('#custom-tooltip');
    await expect(tooltip).toBeVisible();
    const text = (await tooltip.innerText()).replace(/\u00A0/g, ' ');
    // The DATA of the three levels (each row rounded), and their average price
    const data = rows.slice(0, 3).reduce((sum, row) => sum + Number(row[1].replace(/ /g, '')), 0);
    const [, summed] = text.match(/Total DATA ([\d ]+)/);
    expect(Math.abs(Number(summed.replace(/ /g, '')) - data)).toBeLessThanOrEqual(2);
    expect(text).toMatch(/^Total DATA [\d ]+\nAverage price \$0\.000248\d$/);
    // Leaving the book: nothing highlighted
    await page.mouse.move(0, 0);
    await expect(page.locator('#swap-book-bids > div.bg-white\\/\\[0\\.06\\]')).toHaveCount(0);
});

test('the market\'s old address opens it, on its Swap tab', async ({ page }) => {
    await openSwap(page);
    await expect(page).toHaveURL(/\/market$/);
    await expect(page.locator('#market-tabs [data-market-tab="swap"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#market-liquidity-view')).toBeHidden();
    // As a guest, the Liquidity tab asks for a wallet
    await page.click('#market-tabs [data-market-tab="liquidity"]');
    await expect(page).toHaveURL(/\/market\/liquidity$/);
    await expect(page.locator('#market-swap-grid')).toBeHidden();
    await expect(page.locator('#market-liquidity-view')).toBeVisible();
    await expect(page.locator('#swap-market-views')).toBeHidden();
    await expect(page.locator('#liquidity-positions')).toHaveText('Connect a wallet to see your liquidity positions.');
});

test('the Liquidity tab shows the pool, and the wallet\'s v4 positions with their fees and ranges', async ({ page }) => {
    const me = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
    const POSITIONS = '0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9';
    const PM = new ethers.utils.Interface([
        'function ownerOf(uint256 id) view returns (address)',
        'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
        'function getPositionLiquidity(uint256 tokenId) view returns (uint128)'
    ]);
    // Position #7: the mocked pool's whole liquidity (600 ticks each side of the price), 1000 DATA and 2 USDC of fees to collect
    const info = ethers.BigNumber.from(BASE + 600).toTwos(24).shl(32).or(ethers.BigNumber.from(BASE - 600).toTwos(24).shl(8));
    const growth = (amount) => word(ethers.BigNumber.from(amount).shl(128).div(LIQUIDITY));
    POOL_STORAGE.set(word(STATE_SLOT.add(1)), growth(ethers.utils.parseEther('1000')));
    POOL_STORAGE.set(word(STATE_SLOT.add(2)), growth(2000000));
    await page.route(url => url.hostname === 'api.etherscan.io' && url.search.includes('action=tokennfttx'), (route) => {
        const polygon = route.request().url().includes('chainid=137&');
        return route.fulfill({ json: { status: '1', message: 'OK', result: polygon ? [{ tokenID: '7', from: ethers.constants.AddressZero, to: me }] : [] } });
    });
    await page.route('**/*', (route) => {
        const body = route.request().postDataJSON?.();
        const call = body?.method === 'eth_call' ? body.params[0] : null;
        if (call?.to?.toLowerCase() !== '0xca11bde05977b3631167028862be2a173976ca11' || !call.data.startsWith(MULTICALL.getSighash('aggregate3'))) return route.fallback();
        const [calls] = MULTICALL.decodeFunctionData('aggregate3', call.data);
        if (!calls.some(c => c.target.toLowerCase() === POSITIONS)) return route.fallback();
        const result = MULTICALL.encodeFunctionResult('aggregate3', [calls.map(c => {
            const fn = PM.parseTransaction({ data: c.callData }).name;
            const answer = fn === 'ownerOf' ? [me]
                : fn === 'getPositionLiquidity' ? [LIQUIDITY]
                : [['0x3a9a81d576d83ff21f26f325066054540720fc34', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', 3000, 60, ethers.constants.AddressZero], info];
            return { success: true, returnData: PM.encodeFunctionResult(fn, answer) };
        })]);
        return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result } });
    });
    await page.goto('/market/liquidity', { waitUntil: 'domcontentloaded' });
    await page.click('#privateKeyBtn');
    await page.fill('#privateKeyInput', '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    await page.click('#pkModalConnect');
    const row = page.locator('#liquidity-positions tr').first();
    await expect(row).toContainText('#7', { timeout: 30000 });
    await expect(row).toContainText('Polygon');
    await expect(row).toContainText('In range');
    await expect(row).toContainText('$0.0002352 – $0.0002652');
    await expect(row).toContainText('1 834 684');
    await expect(row).toContainText('$934.54');
    await expect(row).toContainText('$2.25');
    const summary = page.locator('#liquidity-summary');
    await expect(summary).toContainText('Positions1');
    await expect(summary).toContainText('Uncollected fees$2.25');
    await expect(page.locator('#liquidity-pool-link')).toHaveAttribute('href', /app\.uniswap\.org\/explore\/pools\/polygon\/0x/);
    // The pool: its tags, and its value (the mocked pool holds that position only)
    await expect(page.locator('#liquidity-pool-tags')).toContainText('Polygon');
    await expect(page.locator('#liquidity-pool-tags')).toContainText('v4');
    await expect(page.locator('#liquidity-stats')).toContainText('TVL$934.54');
    await expect(page.locator('#liquidity-stats')).toContainText('1 834 684 DATA');
    // Its liquidity by price in levels of 2%, bids and asks around the price, the position's range shaded behind
    await expect(page.locator('#liquidity-depth-legend')).toContainText('your ranges shaded in blue');
    const dataset = await page.evaluate(() => {
        const d = window.Chart?.getChart(document.querySelector('#liquidity-depth canvas'))?.data.datasets[0];
        return d && { colors: d.backgroundColor, ranges: d.ranges };
    });
    expect(dataset.colors).toHaveLength(50);
    expect(dataset.colors.filter(c => c.startsWith('rgba(34, 197, 94')).length).toBe(25);
    expect(dataset.ranges).toHaveLength(1);
    expect(dataset.ranges[0].min).toBeCloseTo(0.00023518, 7);
    // The Swap tab: the form, the market and the swaps
    await page.click('#market-tabs [data-market-tab="swap"]');
    await expect(page.locator('#market-swap-grid')).toBeVisible();
    await expect(page.locator('#market-liquidity-view')).toBeHidden();
});

test('the swap form switches to Ethereum: its tokens and DEXes, kept for the next visit', async ({ page }) => {
    await openSwap(page);
    const options = () => page.locator('#swap-from-token select option').allTextContents();
    expect(await options()).toEqual(['POL', 'USDC', 'USDC.e']);
    await page.click('#swap-chain [data-chain="1"]');
    expect(await options()).toEqual(['ETH', 'USDC', 'USDT']);
    await expect(page.locator('[data-chain-text="1"]')).toHaveText(/Best price across\s+SushiSwap\s+and\s+Uniswap/);
    await expect(page.locator('[data-chain-text="137"]')).toBeHidden();
    await expect(page.locator('#swap-pools-btn')).toBeVisible();
    // ETH for POL, and back
    await page.selectOption('#swap-from-token select', 'ETH');
    await openSwap(page);   // a new visit
    await expect(page.locator('#swap-chain [data-chain="1"]')).toHaveClass(/bg-blue-800/);
    await page.click('#swap-chain [data-chain="137"]');
    expect(await options()).toEqual(['POL', 'USDC', 'USDC.e']);
});

test('on Ethereum the quote goes through its Uniswap v4 pool, SushiSwap V2 checked too', async ({ page }) => {
    // Ethereum's RPC: the DATA/ETH 0.3% v4 pool in its PoolManager and the v4 quoter giving 16M DATA per ETH;
    // a SushiSwap V2 DATA/WETH pair giving 15M
    const MANAGER = '0x000000000004444c5dc75cb358380d2e3de08a90', QUOTER = '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203';
    const SUSHI_FACTORY = '0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac', SUSHI_ROUTER = '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f';
    const DATA_ETH = '0x8f693ca8d21b157107184d29d398a8d082b38b76', WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', PAIR = '0x' + '5'.repeat(40);
    const v2 = new ethers.utils.Interface(['function getPair(address, address) view returns (address)', 'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)', 'function balanceOf(address) view returns (uint256)']);
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
                if (c.target.toLowerCase() === SUSHI_FACTORY && c.callData.startsWith(v2.getSighash('getPair'))) {
                    const tokens = v2.decodeFunctionData('getPair', c.callData).map(a => a.toLowerCase()).sort().join();
                    return { success: true, returnData: v2.encodeFunctionResult('getPair', [tokens === [DATA_ETH, WETH].sort().join() ? PAIR : ethers.constants.AddressZero]) };
                }
                if (c.callData.startsWith(v2.getSighash('balanceOf'))) return { success: true, returnData: v2.encodeFunctionResult('balanceOf', [ethers.utils.parseEther('1000000')]) };
                return { success: true, returnData: ethers.utils.hexZeroPad('0x', 32) };   // no Uniswap v3 pool, nothing else
            })]);
        } else if (call?.to?.toLowerCase() === SUSHI_ROUTER) {
            const [amountIn, path] = v2.decodeFunctionData('getAmountsOut', call.data);
            result = v2.encodeFunctionResult('getAmountsOut', [[amountIn, ...path.slice(1).map(() => amountIn.mul(15000000))]]);
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
    await expect(page.locator('#swap-rate')).toHaveText('1 ETH = 16 000 000 DATA');
    await expect(page.locator('#swap-routes-list')).toContainText('SushiSwap V2 · WETH → DATA');
    await expect(page.locator('#swap-routes-list')).toContainText('15 000 000 DATA');
});

test('your swaps include the ones on Ethereum, from its explorer', async ({ page }) => {
    // A DATA buy with ETH on Ethereum, made in another app: the ETH sent to Uniswap's router, the DATA received
    const me = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', hash = '0x' + 'e'.repeat(64), time = String(Math.floor(Date.now() / 1000) - 600);
    await page.route(url => url.hostname === 'api.etherscan.io' && url.search.includes('chainid=1&') && url.search.includes('module=account'), (route) => {
        const action = new URL(route.request().url()).searchParams.get('action');
        const result = action === 'tokentx'
            ? [{ hash, timeStamp: time, from: '0x' + '5'.repeat(40), to: me, contractAddress: '0x8f693ca8d21b157107184d29d398a8d082b38b76', value: '1191000000000000000000' }]
            : action === 'txlist' ? [{ hash, timeStamp: time, from: me, to: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af', value: '100000000000000', isError: '0' }] : [];
        return route.fulfill({ json: { status: '1', message: 'OK', result } });
    });
    await page.goto('/swap', { waitUntil: 'domcontentloaded' });
    await page.click('#privateKeyBtn');
    await page.fill('#privateKeyInput', '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    await page.click('#pkModalConnect');
    const row = page.locator('#swap-history tr', { has: page.locator('[data-tooltip-content="Ethereum"]') });
    await expect(row).toContainText('Buy DATA', { ignoreCase: true, timeout: 30000 });
    await expect(row).toContainText('0.0001');
    await expect(row).toContainText('1 191');
    await expect(row).toContainText('Uniswap (Universal Router)');
    await expect(row.locator(`a[href="https://etherscan.io/tx/${hash}"]`)).toBeVisible();
});

test('"You" in the market trades comes from the explorer, not from the browser\'s storage', async ({ page }) => {
    const me = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
    const stored = '0x' + '3'.padStart(64, 'a'), found = '0x' + '2'.padStart(64, 'a');
    await page.addInitScript(([key, hash]) => localStorage.setItem(key, JSON.stringify([{ txHash: hash, createdAt: Date.now(), status: 'done',
        pay: { symbol: 'USDC', amount: '1000000' }, receive: { symbol: 'DATA', amount: '4000000000000000000000' } }])), [`swapHistory:${me}`, stored]);
    // Polygon's explorer: the wallet's USDC -> DATA swap in the second trade's transaction (busy at the first ask of each list)
    const asked = new Set();
    await page.route(url => url.hostname === 'api.etherscan.io' && url.search.includes('chainid=137&') && url.search.includes('module=account'), (route) => {
        const action = new URL(route.request().url()).searchParams.get('action');
        if (!asked.has(action)) {
            asked.add(action);
            return route.fulfill({ json: { status: '0', message: 'NOTOK', result: 'Max calls per sec rate limit reached (5/sec)' } });
        }
        const time = String(Math.floor(Date.now() / 1000) - 9000);
        const result = action === 'tokentx' ? [
            { hash: found, timeStamp: time, from: me, to: '0x' + '6'.repeat(40), contractAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', value: '1000000' },
            { hash: found, timeStamp: time, from: '0x' + '6'.repeat(40), to: me, contractAddress: '0x3a9a81d576d83ff21f26f325066054540720fc34', value: '2586000000000000000000' }
        ] : [];
        return route.fulfill({ json: { status: '1', message: 'OK', result } });
    });
    await page.goto('/swap', { waitUntil: 'domcontentloaded' });
    await page.click('#privateKeyBtn');
    await page.fill('#privateKeyInput', '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    await page.click('#pkModalConnect');
    const row = (hash) => page.locator('#swap-trades tr', { has: page.locator(`a[href$="${hash}"]`) });
    await expect(row(found)).toContainText('You', { timeout: 30000 });
    await expect(row(stored)).toBeVisible();
    await expect(row(stored)).not.toContainText('You');
    await expect(page.locator('#swap-trades tr', { hasText: 'You' })).toHaveCount(1);
});
