/**
 * Swap page market panel: the DATA/USD chart and the latest trades of the DATA pools.
 * - Trades: Swap events of every DATA pool with liquidity (the main one, Uniswap v4 DATA/USDC 0.3%, and
 *   the others the swap page finds: Uniswap v4 / v3, QuickSwap V2 / V3, SushiSwap), read with the
 *   explorer's log API. A trade's price is its USD value over its DATA amount: USD stablecoins as is,
 *   POL at the Chainlink POL/USD price of the hour. Buy / sell: the amounts' signs (v2 / v3), the move of
 *   the pool price for v4 (only swaps move it).
 * - Chart: the main pool's price. 24H and 7D follow it trade by trade; longer ranges use the daily
 *   DATA/USD history (DATA_History stream, CSV fallback). Every range ends at the pool's current price.
 * - Volume and trades of the range: from the loaded trades of every pool (24H / 7D, to the minute), else
 *   from the daily volume and transaction counts of the pools in their DEX's subgraph (Uniswap v4 / v3,
 *   QuickSwap V3; the others have none here).
 */

import * as Utils from '../core/utils.js';
import * as Services from '../core/services.js';
import { DATA_TOKEN_ADDRESS_POLYGON, POLYGONSCAN_NETWORK, getEtherscanApiKey, DEX_SUBGRAPH_IDS, getDexSubgraphUrl } from '../core/constants.js';

const { logger } = Utils;

const DATA = DATA_TOKEN_ADDRESS_POLYGON.toLowerCase();
const USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const POOL_MANAGER = '0x67366782805870060151383f4bbff9dab53e5cd6';
const SWAP_TOPICS = {
    v4: ethers.utils.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),
    v3: ethers.utils.id('Swap(address,address,int256,int256,uint160,uint128,int24)'),   // Uniswap v3 and QuickSwap V3 (Algebra)
    v2: ethers.utils.id('Swap(address,uint256,uint256,uint256,uint256,address)')
};
const DATA_IS_CURRENCY0 = DATA < USDC;
const POOL_ID = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [...(DATA_IS_CURRENCY0 ? [DATA, USDC] : [USDC, DATA]), 3000, 60, ethers.constants.AddressZero]
));
const USD_STABLES = ['USDC', 'USDC.e', 'USDT', 'DAI'];

/** A DATA pool: kind v4 (id) / v3 / v2 (address), the token against DATA, and its own loading state */
function makePool(desc) {
    return {
        ...desc,
        key: desc.kind === 'v4' ? `v4:${desc.id.toLowerCase()}` : `${desc.kind}:${desc.address.toLowerCase()}`,
        nextFromBlock: null,
        oldestBlock: null,
        firstTradeBlock: undefined,
        reachedStart: false
    };
}

// The main pool: the chart, the price and the change follow it
const MAIN = makePool({ kind: 'v4', venue: 'v4', id: POOL_ID, dataIs0: DATA_IS_CURRENCY0, counterSymbol: 'USDC', counterDecimals: 6, label: 'Uniswap v4 0.3%' });

const BLOCKS_PER_DAY = 43200;        // Polygon: about 2 s per block
const TRADE_DAYS = 7;
const MAX_LOGS = 1000;               // the explorer returns at most 1000 logs (the oldest first)
const TRADES_PAGE = 50;              // rows shown at first, and added by Load More
const MAX_PAGES = 5;                 // explorer pages of 1000 logs for the 7 days (5000 trades)
const PAGE_PAUSE_MS = 400;           // between pages (explorer rate limit)
const DAYS_REFRESH_MS = 10 * 60 * 1000; // the subgraph's daily volume, read again after 10 min
const REFRESH_MS = 30 * 1000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const RANGES = { '24H': DAY, '7D': 7 * DAY, '1M': 30 * DAY, '3M': 90 * DAY, '1Y': 365 * DAY, 'All': Infinity };
const TRADE_RANGES = ['24H', '7D'];

const state = {
    active: false,
    range: '24H',
    trades: [],            // every pool's, oldest first
    seen: new Set(),       // txHash:logIndex
    pools: [MAIN],         // the DATA pools read (the main one first)
    filter: 'all',         // trades list: 'all' pools or 'main'
    polUsdAt: null,        // (times in s) -> POL/USD prices, from the swap page (Chainlink)
    tokenChip: (symbol) => Utils.escapeHtml(symbol),   // token chip with its logo, from the swap page
    polUsd: new Map(),     // hour (ms) -> POL/USD
    windowStart: null,     // time from which the main pool's trades are complete
    loaded: false,
    error: false,
    history: [],           // daily { t, p }, oldest first
    ownSwaps: new Map(),   // this wallet's swaps: txHash -> { pay, receive } symbols of the whole swap
    shown: TRADES_PAGE,    // rows of the trades list
    loadingOlder: false,
    days: null,            // the pools' days from their DEX subgraphs, added up: { date, volume, txCount }, oldest first
    daysAt: 0,
    failures: 0,           // failed loads in a row (before the first success: asked again sooner)
    chart: null,
    timer: null,
    listening: false
};

const $ = (id) => document.getElementById(id);

// ============================================
// Formatting
// ============================================

function formatPrice(value) {
    if (!(value > 0)) return '--';
    // Always 4 significant digits (0.0003750, not 0.000375): the prices line up in the trades list
    return `$${value >= 1 ? value.toFixed(2) : value.toPrecision(4)}`;
}

function formatUsd(value) {
    if (!(value > 0)) return '$0';
    if (value < 0.01) return '< $0.01';
    return `$${Utils.formatBigNumber(value >= 1000 ? value.toFixed(0) : value.toFixed(2))}`;
}

function formatData(value) {
    return Utils.formatBigNumber(value >= 1000 ? value.toFixed(0) : Number(value.toFixed(2)).toString());
}

/** Compact time for the trades list: "15:08" today, "Sep 29 15:08" before */
function formatTime(ms) {
    const date = new Date(ms);
    const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    if (new Date().toDateString() === date.toDateString()) return time;
    return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

// ============================================
// Trades (Swap events of the pool)
// ============================================

const EXPLORER_BUSY = /rate limit|max calls|too many|timeout|temporarily|busy/i;

/** Swap logs of a pool from a block on; a busy explorer (rate limit: the app's default key is shared) is asked again shortly */
async function fetchLogs(pool, fromBlock, page = 1, toBlock = 'latest', offset = MAX_LOGS) {
    const filter = pool.kind === 'v4'
        ? `address=${POOL_MANAGER}&topic0=${SWAP_TOPICS.v4}&topic0_1_opr=and&topic1=${pool.id}`
        : `address=${pool.address}&topic0=${SWAP_TOPICS[pool.kind]}`;
    const url = `${POLYGONSCAN_NETWORK.apiUrl}?chainid=137&module=logs&action=getLogs&${filter}`
        + `&fromBlock=${fromBlock}&toBlock=${toBlock}&page=${page}&offset=${offset}&apikey=${getEtherscanApiKey()}`;
    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
        let json;
        try {
            json = await fetch(url).then(r => r.json());
        } catch (e) {
            lastError = e;   // network failure: asked again
            continue;
        }
        if (Array.isArray(json?.result)) return json.result;
        if (/no records/i.test(json?.message || '')) return [];
        lastError = new Error(`${json?.message || 'Explorer error'}: ${json?.result || ''}`);
        if (!EXPLORER_BUSY.test(`${json?.message} ${json?.result}`)) break;   // e.g. an invalid API key: no point asking again
    }
    throw lastError;
}

/** Counter token per DATA (or USDC per DATA for the main pool) from a pool's sqrtPriceX96 */
function poolPrice(pool, sqrtPriceX96) {
    const ratio = (Number(sqrtPriceX96.toString()) / 2 ** 96) ** 2;   // currency1 per currency0, raw units
    const scale = 10 ** (18 - pool.counterDecimals);
    return pool.dataIs0 ? ratio * scale : scale / ratio;
}

const units = (value, decimals) => Math.abs(Number(ethers.utils.formatUnits(value, decimals)));

function parseLog(pool, log) {
    const trade = {
        id: `${log.transactionHash}:${parseInt(log.logIndex, 16)}`,
        pool: pool.key,
        txHash: log.transactionHash,
        block: parseInt(log.blockNumber, 16),
        logIndex: parseInt(log.logIndex, 16),
        time: parseInt(log.timeStamp, 16) * 1000
    };
    if (pool.kind === 'v4') {
        const [amount0, amount1, sqrtPriceX96] = ethers.utils.defaultAbiCoder.decode(['int128', 'int128', 'uint160', 'uint128', 'int24', 'uint24'], log.data);
        const dataDelta = pool.dataIs0 ? amount0 : amount1;
        trade.data = units(dataDelta, 18);
        trade.counter = units(pool.dataIs0 ? amount1 : amount0, pool.counterDecimals);
        trade.poolPrice = poolPrice(pool, sqrtPriceX96);
        trade.signBuy = dataDelta.gt(0);   // v4 swap deltas are the swapper's: negative = paid into the pool
    } else if (pool.kind === 'v3') {
        const [amount0, amount1] = ethers.utils.defaultAbiCoder.decode(['int256', 'int256', 'uint160', 'uint128', 'int24'], log.data);
        const dataDelta = pool.dataIs0 ? amount0 : amount1;   // the pool's side: positive = DATA paid in (a sell)
        trade.data = units(dataDelta, 18);
        trade.counter = units(pool.dataIs0 ? amount1 : amount0, pool.counterDecimals);
        trade.buy = dataDelta.lt(0);
    } else {
        const [in0, in1, out0, out1] = ethers.utils.defaultAbiCoder.decode(['uint256', 'uint256', 'uint256', 'uint256'], log.data);
        const [dataIn, dataOut, counterIn, counterOut] = pool.dataIs0 ? [in0, out0, in1, out1] : [in1, out1, in0, out0];
        trade.buy = dataOut.gt(dataIn);
        trade.data = units(trade.buy ? dataOut.sub(dataIn) : dataIn.sub(dataOut), 18);
        trade.counter = units(trade.buy ? counterIn.sub(counterOut) : counterOut.sub(counterIn), pool.counterDecimals);
    }
    setUsd(pool, trade);
    return trade;
}

const hourOf = (ms) => Math.floor(ms / HOUR) * HOUR;

/** USD value and price per DATA: stablecoins as is, POL at the hour's POL/USD (filled in once read) */
function setUsd(pool, trade) {
    let usd = null;
    if (USD_STABLES.includes(pool.counterSymbol)) usd = trade.counter;
    else if (pool.counterSymbol === 'POL' || pool.counterSymbol === 'WPOL') {
        const polUsd = state.polUsd.get(hourOf(trade.time));
        if (polUsd) usd = trade.counter * polUsd;
    }
    trade.usd = usd;
    trade.price = usd !== null && trade.data > 0 ? usd / trade.data : null;
}

/** POL/USD of the hours of the POL trades still without a USD value */
async function fillPolUsd() {
    if (!state.polUsdAt) return;
    const polPools = new Set(state.pools.filter(p => p.counterSymbol === 'POL' || p.counterSymbol === 'WPOL').map(p => p.key));
    const hours = [...new Set(state.trades.filter(t => t.usd === null && polPools.has(t.pool)).map(t => hourOf(t.time)))]
        .filter(h => !state.polUsd.has(h));
    if (!hours.length) return;
    try {
        const prices = await state.polUsdAt(hours.map(h => Math.floor((h + HOUR / 2) / 1000)));
        hours.forEach((h, i) => { if (prices[i]) state.polUsd.set(h, prices[i]); });
        const byKey = new Map(state.pools.map(p => [p.key, p]));
        for (const trade of state.trades) if (trade.usd === null && polPools.has(trade.pool)) setUsd(byKey.get(trade.pool), trade);
    } catch (e) {
        logger.warn('Swap market: POL/USD for the POL pools not read', e);
    }
}

/** Buy / sell of a v4 pool's trades: the pool price goes up when DATA is bought (only swaps move it) */
function setSides(trades) {
    let agree = 0;
    let disagree = 0;
    for (let i = 1; i < trades.length; i++) {
        const move = trades[i].poolPrice - trades[i - 1].poolPrice;
        if (move === 0) continue;
        trades[i].buy = move > 0;
        if (trades[i].buy === trades[i].signBuy) agree++; else disagree++;
    }
    // Trades without a previous one (or no price move): the delta sign, read as the other trades show it
    const flip = disagree > agree;
    for (let i = 0; i < trades.length; i++) {
        if (trades[i].buy === undefined || (i > 0 && trades[i].poolPrice === trades[i - 1].poolPrice)) {
            trades[i].buy = flip ? !trades[i].signBuy : trades[i].signBuy;
        }
    }
}

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Every log of a block range, page by page (oldest first); complete: false when it holds more than MAX_PAGES pages */
async function fetchRange(pool, fromBlock, toBlock) {
    const logs = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
        if (page > 1) await pause(PAGE_PAUSE_MS);
        const pageLogs = await fetchLogs(pool, fromBlock, page, toBlock);
        logs.push(...pageLogs);
        if (pageLogs.length < MAX_LOGS) return { logs, complete: true };
    }
    return { logs, complete: false };
}

/** The trades of up to `days` before toBlock; a range too busy for MAX_PAGES pages is narrowed, so the newest are there */
async function fetchNewest(pool, toBlock, days, floorBlock = 0) {
    for (;;) {
        const fromBlock = Math.max(floorBlock, toBlock - Math.round(days * BLOCKS_PER_DAY));
        const { logs, complete } = await fetchRange(pool, fromBlock, toBlock);
        if (complete || days <= 0.25) return { logs, fromBlock };
        days /= 4;
    }
}

function addTrades(pool, logs) {
    let added = 0;
    for (const log of logs) {
        const trade = parseLog(pool, log);
        if (state.seen.has(trade.id)) continue;
        state.seen.add(trade.id);
        state.trades.push(trade);
        added++;
    }
    if (!added) return 0;
    state.trades.sort((a, b) => a.time - b.time || a.block - b.block || a.logIndex - b.logIndex);
    if (pool.kind === 'v4') setSides(state.trades.filter(t => t.pool === pool.key));
    return added;
}

const mainTrades = () => state.trades.filter(t => t.pool === MAIN.key);

/** New trades of one pool: its first load reads the last 7 days, then from its last trade on */
async function loadPool(pool, latest) {
    let added;
    if (pool.nextFromBlock === null) {
        const { logs, fromBlock } = await fetchNewest(pool, latest, TRADE_DAYS);
        pool.oldestBlock = fromBlock;
        if (pool === MAIN) state.windowStart = Date.now() - (latest - fromBlock) * (DAY / BLOCKS_PER_DAY);
        added = addTrades(pool, logs);
    } else {
        added = addTrades(pool, await fetchLogs(pool, pool.nextFromBlock));
    }
    const own = state.trades.filter(t => t.pool === pool.key);
    const lastLogBlock = own.length ? own[own.length - 1].block : 0;
    // From the last trade seen (the explorer may be a few blocks behind the RPC); duplicates are skipped
    pool.nextFromBlock = Math.max(lastLogBlock, latest - 150);
    return added;
}

/** New trades of every pool: the main one first (it alone decides whether the trades loaded), the others after it */
async function loadTrades() {
    const latest = await Services.readWithFallback(() => Services.getReadOnlyProvider().getBlockNumber());
    let added = await loadPool(MAIN, latest);
    state.loaded = true;
    state.error = false;
    for (const pool of state.pools) {
        if (pool === MAIN) continue;
        await pause(PAGE_PAUSE_MS);
        try {
            added += await loadPool(pool, latest);
        } catch (e) {
            logger.warn(`Swap market: trades of ${pool.label} not loaded`, e);
        }
    }
    await fillPolUsd();
    return added;
}

const allReachedStart = () => state.pools.every(p => p.reachedStart);

/** Trades before each pool's oldest loaded: 7 days back, further (a doubling window) over quiet weeks, until its first trade */
async function loadOlder() {
    let added = 0;
    let days = TRADE_DAYS;
    while (!added && !allReachedStart()) {
        for (const pool of state.pools) {
            if (pool.reachedStart || pool.oldestBlock === null) continue;
            if (pool.firstTradeBlock === undefined) {
                const first = await fetchLogs(pool, 0, 1, 'latest', 1);
                pool.firstTradeBlock = first.length ? parseInt(first[0].blockNumber, 16) : null;
            }
            if (pool.firstTradeBlock === null || pool.oldestBlock <= pool.firstTradeBlock) {
                pool.reachedStart = true;
                continue;
            }
            const { logs, fromBlock } = await fetchNewest(pool, pool.oldestBlock - 1, days, pool.firstTradeBlock);
            pool.oldestBlock = fromBlock;
            added += addTrades(pool, logs);
            if (pool.oldestBlock <= pool.firstTradeBlock) pool.reachedStart = true;
            await pause(PAGE_PAUSE_MS);
        }
        days *= 2;
    }
    // The main pool's trades are complete from its oldest one loaded on
    const main = mainTrades();
    if (main.length) state.windowStart = Math.min(state.windowStart, main[0].time);
    await fillPolUsd();
    return added;
}

// ============================================
// Daily volume (Uniswap v4 subgraph)
// ============================================

/** One DEX subgraph's days for its pools (one query, an alias per pool) */
async function fetchDays(venue, pools) {
    const query = `{ ${pools.map((p, i) => `p${i}: poolDayDatas(first: 1000, orderBy: date, orderDirection: desc, where: { pool: "${(p.kind === 'v4' ? p.id : p.address).toLowerCase()}" }) { date volumeUSD txCount }`).join(' ')} }`;
    const json = await fetch(getDexSubgraphUrl(venue), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
    }).then(r => r.json());
    const lists = pools.map((p, i) => json?.data?.[`p${i}`]);
    if (!lists.some(Array.isArray)) throw new Error(json?.errors?.[0]?.message || 'No pool days');
    return lists.filter(Array.isArray).flat();
}

/** Daily volume and transactions of every pool whose DEX has a subgraph here, added up by day */
async function loadDays() {
    state.daysAt = Date.now();
    const byVenue = new Map();
    for (const pool of state.pools) {
        if (!DEX_SUBGRAPH_IDS[pool.venue]) continue;
        byVenue.set(pool.venue, [...(byVenue.get(pool.venue) || []), pool]);
    }
    const results = await Promise.allSettled([...byVenue].map(([venue, pools]) => fetchDays(venue, pools)));
    const rows = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
    results.filter(r => r.status === 'rejected').forEach(r => logger.warn('Swap market: pool volume (subgraph) not loaded', r.reason));
    if (!rows.length) return;
    const byDate = new Map();
    for (const d of rows) {
        const date = Number(d.date) * 1000;
        const day = byDate.get(date) || { date, volume: 0, txCount: 0 };
        day.volume += Number(d.volumeUSD) || 0;
        day.txCount += Number(d.txCount) || 0;
        byDate.set(date, day);
    }
    state.days = [...byDate.values()].sort((a, b) => a.date - b.date);
    if (state.active) renderStats();
}

/** Volume (USD) and trades of the selected range: the loaded trades when they cover it, else the subgraph's days */
function rangeStats() {
    const span = RANGES[state.range];
    const now = Date.now();
    const start = span === Infinity ? -Infinity : now - span;
    if (state.loaded && state.windowStart !== null && start >= state.windowStart) {
        const trades = state.trades.filter(t => t.time >= start);
        return { volume: trades.reduce((sum, t) => sum + (t.usd || 0), 0), count: trades.length };
    }
    if (state.days) {
        const firstDay = start === -Infinity ? -Infinity : Math.floor(start / DAY) * DAY;
        const days = state.days.filter(d => d.date >= firstDay);
        return { volume: days.reduce((sum, d) => sum + d.volume, 0), count: days.reduce((sum, d) => sum + d.txCount, 0) };
    }
    return null;
}

// ============================================
// Daily history (DATA_History stream / CSV)
// ============================================

function setHistory({ priceMap }) {
    if (!priceMap?.size) return;
    state.history = [...priceMap.entries()]
        .map(([seconds, price]) => ({ t: seconds * 1000, p: price }))
        .filter(point => point.p > 0)
        .sort((a, b) => a.t - b.t);
    if (state.active) {
        renderStats();
        renderChart();
    }
}

// ============================================
// Stats
// ============================================

function currentPrice() {
    const main = mainTrades();
    const last = main[main.length - 1];
    return last?.poolPrice || Services.getCurrentLivePrice() || state.history[state.history.length - 1]?.p || null;
}

/** Price at a past time: the pool price after the last trade before it, else the daily history */
function priceAt(time) {
    let price = null;
    if (state.windowStart !== null && time >= state.windowStart) {
        for (const trade of mainTrades()) {
            if (trade.time > time) break;
            price = trade.poolPrice;
        }
        if (price) return price;
    }
    for (const point of state.history) {
        if (point.t > time) break;
        price = point.p;
    }
    return price;
}

function renderStats() {
    const now = currentPrice();
    $('swap-market-price').textContent = formatPrice(now);
    const change = $('swap-market-change');
    // Change over the chart's range: from the price at its start (All: the first price known)
    const span = RANGES[state.range];
    const before = span === Infinity
        ? (state.history[0]?.p || mainTrades()[0]?.poolPrice || null)
        : priceAt(Date.now() - span);
    if (now && before) {
        const pct = (now / before - 1) * 100;
        const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
        change.textContent = `${sign}${Math.abs(pct).toFixed(2)}% ${state.range}`;
        change.className = `text-sm font-semibold ${pct > 0 ? 'text-green-400' : pct < 0 ? 'text-red-400' : 'text-gray-300'}`;
    } else {
        change.textContent = '';
    }
    // Volume and trades of the range: empty until there is data for it
    const stats = rangeStats();
    $('swap-market-stats').textContent = stats
        ? `${state.range === 'All' ? 'All-time' : state.range} volume ${formatUsd(stats.volume)} · ${Utils.formatBigNumber(String(stats.count))} ${stats.count === 1 ? 'trade' : 'trades'}`
        : '';
}

// ============================================
// Trades table
// ============================================

const counterName = (pool) => (pool.counterSymbol === 'WPOL' ? 'POL' : pool.counterSymbol);
/** The swap page's token chip, a size smaller for the trades list */
const compactChip = (symbol) => state.tokenChip(symbol)
    .replace('gap-1.5 pl-1 pr-2', 'gap-1 pl-0.5 pr-1.5')
    .replace('text-xs', 'text-[11px]')
    .replaceAll('w-4 h-4', 'w-3.5 h-3.5');
const SHORT_DEX = [[/^Uniswap /, 'Uni '], [/^QuickSwap /, 'QS '], [/^SushiSwap V2/, 'Sushi']];
/** Short pool name for the list ("Uni v4 0.3%", "QS V2"): the tokens are in the trade's chips */
const poolShortName = (pool) => (pool ? SHORT_DEX.reduce((name, [from, to]) => name.replace(from, to), pool.label) : '');
const poolFullName = (pool) => (pool ? `${pool.label} · DATA/${counterName(pool)}` : '');

function renderFilter() {
    document.querySelectorAll('#swap-trades-filter button').forEach(btn => {
        const active = btn.dataset.filter === state.filter;
        btn.classList.toggle('bg-blue-800', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('text-gray-300', !active);
    });
}

function renderTrades() {
    const body = $('swap-trades');
    if (!body) return;
    const row = (text) => `<tr><td colspan="6" class="py-4 text-sm text-gray-300">${text}</td></tr>`;
    if (!state.loaded) {
        $('swap-trades-more')?.classList.add('hidden');
        const spinner = '<span class="w-4 h-4 flex-shrink-0 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" aria-hidden="true"></span>';
        body.innerHTML = row(`<span class="inline-flex items-center gap-2">${spinner}${state.error ? 'The explorer is busy, trying again...' : 'Loading market trades...'}</span>`);
        return;
    }
    const listed = state.filter === 'main' ? mainTrades() : state.trades;
    const reachedStart = state.filter === 'main' ? MAIN.reachedStart : allReachedStart();
    // Load More stays until every trade since the pools' first ones is shown
    $('swap-trades-more')?.classList.toggle('hidden', listed.length <= state.shown && reachedStart);
    const recent = listed.slice(-state.shown).reverse();
    if (!recent.length) {
        body.innerHTML = row(reachedStart ? 'No trades yet.' : `No trades in the last ${TRADE_DAYS} days.`);
        return;
    }
    const pools = new Map(state.pools.map(p => [p.key, p]));
    body.innerHTML = recent.map(trade => {
        const hash = Utils.escapeHtml(trade.txHash);
        const pool = pools.get(trade.pool);
        const ownSwap = state.ownSwaps.get(trade.txHash.toLowerCase());
        const side = trade.buy
            ? '<span class="tx-badge tx-badge-in whitespace-nowrap">Buy</span>'
            : '<span class="tx-badge tx-badge-out whitespace-nowrap">Sell</span>';
        // What was paid -> what was received in the pool (the pool's full name in the tooltip)
        // The wallet's own swaps show what it paid and received in the whole swap (e.g. DATA -> POL through USDC)
        const counter = pool ? counterName(pool) : '';
        const [paid, received] = ownSwap?.pay && ownSwap?.receive
            ? [ownSwap.pay, ownSwap.receive]
            : trade.buy ? [counter, 'DATA'] : ['DATA', counter];
        const tradeCell = `<span class="inline-flex items-center gap-2.5 whitespace-nowrap" data-tooltip-content="${Utils.escapeHtml(poolFullName(pool))}">${side}<span class="inline-flex items-center gap-1">${compactChip(paid)}<span class="text-gray-400 text-xs">→</span>${compactChip(received)}</span></span>`;
        const own = ownSwap
            ? '<span class="ml-2 px-1.5 py-0.5 rounded bg-[#2C2C2C] text-[10px] font-semibold text-gray-300">You</span>'
            : '';
        return `
            <tr class="border-b border-[#2a2a2a] last:border-0">
                <td class="py-2 pr-2 whitespace-nowrap"><a href="https://polygonscan.com/tx/${hash}" target="_blank" rel="noopener noreferrer" class="text-gray-300 hover:text-blue-300" data-tooltip-content="${Utils.escapeHtml(new Date(trade.time).toLocaleString())}">${formatTime(trade.time)}</a>${own}</td>
                <td class="py-2 pr-2">${tradeCell}</td>
                <td class="py-2 pr-2 text-right whitespace-nowrap text-white font-medium">${formatPrice(trade.price)}</td>
                <td class="py-2 pr-2 text-right whitespace-nowrap text-gray-200">${formatData(trade.data)}</td>
                <td class="py-2 2xl:pr-2 text-right whitespace-nowrap text-gray-200">${trade.usd === null ? '--' : formatUsd(trade.usd)}</td>
                <td class="hidden 2xl:table-cell py-2 text-right whitespace-nowrap text-xs text-gray-300"><span data-tooltip-content="${Utils.escapeHtml(poolFullName(pool))}">${Utils.escapeHtml(poolShortName(pool))}</span></td>
            </tr>`;
    }).join('');
}

// ============================================
// Chart
// ============================================

/** Points of the selected range: the daily history, then trade by trade where the trades reach, ending at the current price */
function chartPoints() {
    const span = RANGES[state.range];
    const now = Date.now();
    const start = span === Infinity ? -Infinity : now - span;
    const tradeStart = state.windowStart === null ? Infinity : Math.max(start, state.windowStart);
    const points = state.history.filter(p => p.t >= start && p.t < tradeStart).map(p => ({ x: p.t, y: p.p }));
    if (tradeStart !== Infinity) {
        const opening = priceAt(tradeStart);
        if (opening) points.push({ x: tradeStart, y: opening });
        for (const trade of mainTrades()) {
            if (trade.time >= tradeStart) points.push({ x: trade.time, y: trade.poolPrice });
        }
    } else if (!points.length && start !== -Infinity) {
        const opening = priceAt(start);
        if (opening) points.push({ x: start, y: opening });
    }
    const price = currentPrice();
    if (price && (!points.length || points[points.length - 1].x < now)) points.push({ x: now, y: price });
    // Trade ranges hold the price between trades (steps); daily ranges join the days
    return { points, stepped: TRADE_RANGES.includes(state.range) };
}

function tickLabel(ms) {
    const date = new Date(ms);
    if (state.range === '24H') return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (state.range === '1Y' || state.range === 'All') return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Vertical line under the pointer
const crosshair = {
    id: 'swapCrosshair',
    afterDatasetsDraw(chart) {
        const active = chart.tooltip?.getActiveElements?.() || [];
        if (!active.length) return;
        const { ctx, chartArea } = chart;
        const x = active[0].element.x;
        ctx.save();
        ctx.strokeStyle = '#4b5563';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.restore();
    }
};

function renderChart() {
    const container = $('swap-chart');
    if (!container || typeof Chart === 'undefined') return;
    const { points, stepped } = chartPoints();
    if (points.length < 2) {
        state.chart?.destroy();
        state.chart = null;
        container.innerHTML = `<div class="flex items-center justify-center h-full text-sm text-gray-300">${state.loaded || state.history.length ? 'Not enough price data for this range.' : 'Loading prices...'}</div>`;
        return;
    }
    if (!container.querySelector('canvas')) {
        state.chart?.destroy();
        state.chart = null;
        container.innerHTML = '<canvas aria-label="DATA/USD price chart" role="img"></canvas>';
    }
    const ctx = container.querySelector('canvas').getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, container.clientHeight || 300);
    gradient.addColorStop(0, 'rgba(59, 130, 246, 0.25)');
    gradient.addColorStop(1, 'rgba(59, 130, 246, 0)');

    const dataset = {
        label: 'DATA/USD',
        data: points,
        borderColor: '#3b82f6',
        backgroundColor: gradient,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: '#3b82f6',
        pointHoverBorderColor: '#121212',
        pointHoverBorderWidth: 2,
        stepped: stepped ? 'after' : false,
        tension: 0,
        fill: true
    };
    // The axis runs from the first point to now (no empty margin before the data)
    const bounds = { min: points[0].x, max: points[points.length - 1].x };
    if (state.chart) {
        state.chart.data.datasets[0] = dataset;
        Object.assign(state.chart.options.scales.x, bounds);
        state.chart.update('none');
        return;
    }
    const font = { family: "'Inter', sans-serif", size: 11 };
    state.chart = new Chart(ctx, {
        type: 'line',
        data: { datasets: [dataset] },
        plugins: [crosshair],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            parsing: false,
            interaction: { mode: 'nearest', axis: 'x', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(30, 30, 30, 0.9)',
                    titleColor: '#ffffff',
                    bodyColor: '#d1d5db',
                    borderColor: '#333333',
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 8,
                    displayColors: false,
                    titleFont: { ...font, size: 12, weight: '600' },
                    bodyFont: { ...font, size: 13 },
                    callbacks: {
                        title: (items) => {
                            const ms = items[0].parsed.x;
                            return TRADE_RANGES.includes(state.range)
                                ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                                : new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
                        },
                        label: (item) => formatPrice(item.parsed.y)
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    ...bounds,
                    ticks: { color: '#9ca3af', font, maxTicksLimit: 6, maxRotation: 0, callback: (value) => tickLabel(value) },
                    grid: { display: false }
                },
                y: {
                    position: 'right',
                    ticks: { color: '#9ca3af', font, maxTicksLimit: 6, callback: (value) => formatPrice(value) },
                    grid: { color: '#2a2a2a', drawBorder: false }
                }
            }
        }
    });
}

function renderRange() {
    document.querySelectorAll('#swap-chart-range button').forEach(btn => {
        const active = btn.dataset.range === state.range;
        btn.classList.toggle('bg-blue-800', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('text-gray-300', !active);
    });
}

// ============================================
// Lifecycle
// ============================================

function renderAll() {
    renderStats();
    renderTrades();
    renderChart();
}

async function refresh() {
    const wasLoaded = state.loaded;
    try {
        const added = await loadTrades();
        state.failures = 0;
        if (!state.active) return;
        // Stats and chart every time (the 24h window and the "now" point move on); the list only with new trades
        renderStats();
        renderChart();
        if (added || !wasLoaded) renderTrades();
    } catch (e) {
        logger.warn('Swap market: trades not loaded', e);
        state.failures++;
        if (!state.loaded) state.error = true;
        if (state.active) renderAll();
    }
}

/** Next load: every 30 s, sooner (5 s, 10 s, 20 s) while the trades never loaded */
function schedule() {
    clearTimeout(state.timer);
    const delay = !state.loaded && state.failures ? Math.min(5000 * 2 ** (state.failures - 1), REFRESH_MS) : REFRESH_MS;
    state.timer = setTimeout(async () => {
        if (!state.active) return;
        if (!document.hidden) {
            if (Date.now() - state.daysAt > DAYS_REFRESH_MS) loadDays();
            await refresh();
        }
        schedule();
    }, delay);
}

/** Next 50 rows: from the loaded trades, else older ones from the explorer */
async function loadMore() {
    const btn = $('swap-trades-more');
    const listed = state.filter === 'main' ? mainTrades() : state.trades;
    if (state.shown < listed.length) {
        state.shown += TRADES_PAGE;
        renderTrades();
        return;
    }
    if (state.loadingOlder || !btn) return;
    state.loadingOlder = true;
    btn.disabled = true;
    btn.innerHTML = '<span class="inline-flex items-center gap-2"><span class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" aria-hidden="true"></span>Loading...</span>';
    try {
        await loadOlder();
        state.shown += TRADES_PAGE;
    } catch (e) {
        logger.warn('Swap market: older trades not loaded', e);
    } finally {
        state.loadingOlder = false;
        btn.disabled = false;
        btn.textContent = 'Load More';
        if (state.active) {
            renderTrades();
            renderChart();
        }
    }
}

function setupListeners() {
    if (state.listening) return;
    state.listening = true;
    $('swap-trades-more')?.addEventListener('click', loadMore);
    $('swap-trades-filter')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-filter]');
        if (!btn || btn.dataset.filter === state.filter) return;
        state.filter = btn.dataset.filter;
        state.shown = TRADES_PAGE;
        renderFilter();
        renderTrades();
    });
    $('swap-chart-range')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-range]');
        if (!btn || btn.dataset.range === state.range) return;
        state.range = btn.dataset.range;
        renderRange();
        renderStats();
        renderChart();
    });
    Services.onHistoricalDataLoaded(setHistory);
}

export const SwapMarket = {
    show() {
        setupListeners();
        state.active = true;
        renderRange();
        renderFilter();
        renderAll();
        if (Date.now() - state.daysAt > DAYS_REFRESH_MS) loadDays();
        refresh().finally(schedule);
    },

    stop() {
        state.active = false;
        clearTimeout(state.timer);
        state.timer = null;
    },

    /** Trades right after a swap made here */
    refresh() {
        if (state.active) refresh();
    },

    /**
     * The DATA pools with liquidity found by the swap page (besides the main one): { kind: 'v4', id } or
     * { kind: 'v3' | 'v2', address }, with dataIs0, counterSymbol, counterDecimals and label
     */
    setPools(descs) {
        const known = new Set(state.pools.map(p => p.key));
        let added = false;
        for (const desc of descs) {
            const pool = makePool(desc);
            if (known.has(pool.key)) continue;
            known.add(pool.key);
            state.pools.push(pool);
            added = true;
        }
        if (!added) return;
        if (state.active) loadDays(); else state.daysAt = 0;   // the subgraph's days again, with the new v4 pools
        if (state.active && state.loaded) refresh();
    },

    /** Token chip (logo + ticker) of the swap page, for the trades list */
    setTokenChip(fn) {
        state.tokenChip = fn;
    },

    /** POL/USD at times (s), for the trades of the POL pools */
    setPolUsdSource(fn) {
        state.polUsdAt = fn;
    },

    /** Swaps of this wallet: marked in the trades list */
    setOwnSwaps(swaps) {
        state.ownSwaps = new Map(swaps.map(swap => [swap.txHash.toLowerCase(), { pay: swap.pay, receive: swap.receive }]));
        if (state.active && state.loaded) renderTrades();
    }
};
