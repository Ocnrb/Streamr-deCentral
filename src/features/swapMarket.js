/**
 * Swap page market panel: the DATA/USD chart and the latest trades of the DATA pools.
 * - Trades: Swap events of every DATA pool with liquidity, on Polygon (the main one, Uniswap v4 DATA/USDC
 *   0.3%, and the others the swap page finds: Uniswap v4 / v3, QuickSwap V2 / V3, SushiSwap) and on
 *   Ethereum (Uniswap v2 / v3 / v4, SushiSwap; found here), read with the explorer's log API. A trade's price is its USD value over its DATA amount: USD stablecoins as is,
 *   POL and ETH at the Chainlink POL/USD and ETH/USD prices of the hour. Buy / sell: the amounts' signs (v2 / v3), the move of
 *   the pool price for v4 (only swaps move it).
 * - Chart: the price of the Uniswap v4 pools (Polygon and Ethereum, where the market is). 24H and 7D follow
 *   their trades, each at its pool's USD price after it; longer ranges use the daily DATA/USD history
 *   (DATA_History stream, CSV fallback). Every range ends at the latest of those prices.
 * - Volume and trades of the range: from the loaded trades of every pool (24H / 7D, to the minute), else
 *   from the daily volume and transaction counts of the pools in their DEX's subgraph (Uniswap v4 / v3,
 *   QuickSwap V3; the others have none here).
 */

import * as Utils from '../core/utils.js';
import * as Services from '../core/services.js';
import { DATA_TOKEN_ADDRESS_POLYGON, DATA_TOKEN_ADDRESS_ETHEREUM, ETHEREUM_RPC_URLS, POLYGONSCAN_NETWORK, getEtherscanApiKey, DEX_SUBGRAPH_IDS, getDexSubgraphUrl } from '../core/constants.js';
import { ethers } from 'ethers';
import Chart from 'chart.js/auto';

const { logger } = Utils;

const DATA = DATA_TOKEN_ADDRESS_POLYGON.toLowerCase();
const USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const POOL_MANAGER = '0x67366782805870060151383f4bbff9dab53e5cd6';
const CHAINS = {
    // blocksPerDay: an estimate until measured (block times change with the chains' upgrades)
    137: { name: 'Polygon', blocksPerDay: 43200, poolManager: POOL_MANAGER, explorer: 'https://polygonscan.com/tx/' },
    1: { name: 'Ethereum', blocksPerDay: 7200, poolManager: '0x000000000004444c5dc75cb358380d2e3de08a90', explorer: 'https://etherscan.io/tx/' }
};
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
        chain: desc.chain || 137,
        key: `${desc.chain || 137}:${desc.kind === 'v4' ? `v4:${desc.id.toLowerCase()}` : `${desc.kind}:${desc.address.toLowerCase()}`}`,
        nextFromBlock: null,
        oldestBlock: null,
        firstTradeBlock: undefined,
        reachedStart: false
    };
}

// The main pool: the chart, the price and the change follow it
const MAIN = makePool({ chain: 137, kind: 'v4', venue: 'v4', id: POOL_ID, fee: 3000, tickSpacing: 60, dataIs0: DATA_IS_CURRENCY0, counterSymbol: 'USDC', counterDecimals: 6, label: 'Uniswap v4 0.3%' });

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
    filter: 'all',         // trades list: 'all', 'polygon' or 'ethereum'
    polUsdAt: null,        // (times in s) -> POL/USD prices, from the swap page (Chainlink)
    tokenChip: (symbol) => Utils.escapeHtml(symbol),   // token chip with its logo, from the swap page
    polUsd: new Map(),     // hour (ms) -> POL/USD
    ethUsd: new Map(),     // hour (ms) -> ETH/USD
    ethDiscovery: null,    // the Ethereum DATA pools lookup (once)
    windowStart: null,     // time from which the main pool's trades are complete
    loaded: false,
    error: false,
    history: [],           // daily { t, p }, oldest first
    ownSwaps: new Map(),   // this wallet's swaps: txHash -> { pay, receive } symbols of the whole swap
    shown: TRADES_PAGE,    // rows of the trades list
    loadingOlder: false,
    days: null,            // the pools' days from their DEX subgraphs, added up: { date, volume, unpricedData, txCount }, oldest first
    daysAt: 0,
    oldPrices: null,       // daily DATA/USD of the DEX subgraphs, for the days before the history: { t, p }, oldest first
    failures: 0,           // failed loads in a row (before the first success: asked again sooner)
    chart: null,
    timer: null,
    listening: false
};

const $ = (id) => document.getElementById(id);

// ============================================
// Formatting
// ============================================

export function formatPrice(value) {
    if (!(value > 0)) return '--';
    // Always 4 significant digits (0.0003750, not 0.000375): the prices line up in the trades list
    return `$${value >= 1 ? value.toFixed(2) : value.toPrecision(4)}`;
}

export function formatUsd(value) {
    if (!(value > 0)) return '$0';
    if (value < 0.01) return '< $0.01';
    return `$${Utils.formatBigNumber(value >= 1000 ? value.toFixed(0) : value.toFixed(2))}`;
}

export function formatData(value) {
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
        ? `address=${CHAINS[pool.chain].poolManager}&topic0=${SWAP_TOPICS.v4}&topic0_1_opr=and&topic1=${pool.id}`
        : `address=${pool.address}&topic0=${SWAP_TOPICS[pool.kind]}`;
    const url = `${POLYGONSCAN_NETWORK.apiUrl}?chainid=${pool.chain}&module=logs&action=getLogs&${filter}`
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
const isPol = (pool) => pool.counterSymbol === 'POL' || pool.counterSymbol === 'WPOL';
const isEth = (pool) => pool.counterSymbol === 'ETH' || pool.counterSymbol === 'WETH';

/** USD value and price per DATA: stablecoins as is, POL at the hour's POL/USD (filled in once read) */
function setUsd(pool, trade) {
    let usd = null;
    if (USD_STABLES.includes(pool.counterSymbol)) usd = trade.counter;
    else if (isPol(pool) || isEth(pool)) {
        const rate = (isPol(pool) ? state.polUsd : state.ethUsd).get(hourOf(trade.time));
        if (rate) usd = trade.counter * rate;
    }
    trade.usd = usd;
    trade.price = usd !== null && trade.data > 0 ? usd / trade.data : null;
}

/** POL/USD and ETH/USD of the hours of the POL / ETH trades still without a USD value */
async function fillUsdRates() {
    const byKey = new Map(state.pools.map(p => [p.key, p]));
    const missing = state.trades.filter(t => t.usd === null && byKey.get(t.pool));
    for (const [test, map, source] of [[isPol, state.polUsd, state.polUsdAt], [isEth, state.ethUsd, ethUsdAt]]) {
        if (!source) continue;
        const hours = [...new Set(missing.filter(t => test(byKey.get(t.pool))).map(t => hourOf(t.time)))].filter(h => !map.has(h));
        if (!hours.length) continue;
        try {
            const prices = await source(hours.map(h => Math.floor((h + HOUR / 2) / 1000)));
            hours.forEach((h, i) => { if (prices[i]) map.set(h, prices[i]); });
        } catch (e) {
            logger.warn('Swap market: USD rate (Chainlink) not read', e);
        }
    }
    for (const trade of missing) setUsd(byKey.get(trade.pool), trade);
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
        const fromBlock = Math.max(floorBlock, toBlock - Math.round(days * CHAINS[pool.chain].blocksPerDay));
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

/**
 * A chain's blocks per day over the last TRADE_DAYS, from the times of two blocks: the trades then cover exactly
 * the 7 days (the 7D chart has no daily part). Kept as estimated when the blocks can't be read.
 */
async function measureBlockRate(chain, latest) {
    const info = CHAINS[chain];
    if (info.measured) return;
    const read = (fn) => (chain === 137 ? Services.readWithFallback(() => fn(Services.getReadOnlyProvider())) : fn(getEthProvider()));
    try {
        const span = Math.round(TRADE_DAYS * info.blocksPerDay);
        const [last, first] = await Promise.all([read(p => p.getBlock(latest)), read(p => p.getBlock(latest - span))]);
        const days = (last.timestamp - first.timestamp) * 1000 / DAY;
        if (days > 0) info.blocksPerDay = span / days;
        info.measured = true;
    } catch (e) {
        logger.warn(`Swap market: ${info.name} block times not read`, e);
    }
}

/** New trades of one pool: its first load reads the last 7 days, then from its last trade on */
async function loadPool(pool, latest) {
    let added;
    if (pool.nextFromBlock === null) {
        await measureBlockRate(pool.chain, latest);
        const { logs, fromBlock } = await fetchNewest(pool, latest, TRADE_DAYS);
        pool.oldestBlock = fromBlock;
        if (pool === MAIN) state.windowStart = Date.now() - (latest - fromBlock) * (DAY / CHAINS[pool.chain].blocksPerDay);
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
    const latest = { 137: await Services.readWithFallback(() => Services.getReadOnlyProvider().getBlockNumber()) };
    let added = await loadPool(MAIN, latest[137]);
    state.loaded = true;
    state.error = false;
    for (const pool of state.pools) {
        if (pool === MAIN) continue;
        await pause(PAGE_PAUSE_MS);
        try {
            if (latest[pool.chain] === undefined) latest[pool.chain] = await getEthProvider().getBlockNumber();
            added += await loadPool(pool, latest[pool.chain]);
        } catch (e) {
            logger.warn(`Swap market: trades of ${pool.label} not loaded`, e);
        }
    }
    await fillUsdRates();
    markOutliers();
    return added;
}

const OUTLIER_FACTOR = 3;   // a trade priced over 3x away from the main pool's price is a broken pool's

/**
 * Marks the trades priced far from the main pool at their time (nearly empty pools trade at any price):
 * left out of the list and the volume. One pass in time order, following the main pool's price.
 */
function markOutliers() {
    let reference = null;
    for (const trade of state.trades) {
        if (trade.pool === MAIN.key) {
            reference = trade.poolPrice;
            trade.outlier = false;
            continue;
        }
        trade.outlier = Boolean(reference && trade.price && (trade.price > reference * OUTLIER_FACTOR || trade.price < reference / OUTLIER_FACTOR));
    }
}

/** New pools (from the swap page or the Ethereum lookup): their trades and subgraph days are read right away */
function addPools(descs) {
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
    notifyChange();
    if (state.active) loadDays(); else state.daysAt = 0;
    if (state.active && state.loaded) refresh();
}

/** Trades before each pool's oldest loaded: 7 days back, further (a doubling window) over quiet weeks, until its first trade */
async function loadOlder() {
    let added = 0;
    let days = TRADE_DAYS;
    const pools = filteredPools();
    while (!added && !pools.every(p => p.reachedStart)) {
        for (const pool of pools) {
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
    await fillUsdRates();
    markOutliers();
    return added;
}

// ============================================
// Ethereum DATA pools (found here: the swap page works on Polygon only)
// ============================================

const ETH = {
    DATA: DATA_TOKEN_ADDRESS_ETHEREUM.toLowerCase(),
    counters: [
        { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', decimals: 18 },
        { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6 },
        { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', decimals: 6 },
        { address: '0x6b175474e89094c44da98b954eedeac495271d0f', symbol: 'DAI', decimals: 18 }
    ],
    v2Factories: [
        { address: '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f', label: 'Uniswap v2', subgraph: 'ethUniV2' },
        { address: '0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac', label: 'SushiSwap V2' }
    ],
    v3Factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984',
    v3Fees: [100, 500, 3000, 10000],
    v4Tiers: [[100, 1], [500, 10], [3000, 60], [10000, 200]],
    v4PoolsSlot: 6,
    ethUsdFeed: '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419'   // Chainlink ETH/USD
};
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ETH_POOL_MIN_DATA = ethers.utils.parseUnits('10000', 18);
const ETH_IFACES = {
    multicall: new ethers.utils.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']),
    v2Factory: new ethers.utils.Interface(['function getPair(address, address) view returns (address)']),
    v3Factory: new ethers.utils.Interface(['function getPool(address, address, uint24) view returns (address)']),
    erc20: new ethers.utils.Interface(['function balanceOf(address) view returns (uint256)']),
    v4Manager: new ethers.utils.Interface(['function extsload(bytes32 slot) view returns (bytes32)']),
    feed: new ethers.utils.Interface([
        'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
        'function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)'
    ])
};

let ethProvider = null;
export function getEthProvider() {
    if (!ethProvider) ethProvider = new Services.FailoverRpcProvider(ETHEREUM_RPC_URLS, 1, 'ethereum_rpc_index');
    return ethProvider;
}

/** Ethereum reads through Multicall3: [{ target, iface, fn, args }] -> decoded results (null for a failed call) */
async function ethMulticall(calls) {
    const results = [];
    for (let i = 0; i < calls.length; i += 60) {
        const batch = calls.slice(i, i + 60);
        const encoded = batch.map(c => ({ target: c.target, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args) }));
        const raw = await new ethers.Contract(MULTICALL3, ETH_IFACES.multicall, getEthProvider()).callStatic.aggregate3(encoded);
        raw.forEach((r, j) => {
            try {
                results.push(r.success ? batch[j].iface.decodeFunctionResult(batch[j].fn, r.returnData) : null);
            } catch (e) {
                results.push(null);
            }
        });
    }
    return results;
}

/** ETH/USD at each time (s): the last Chainlink round before it, by a binary search over the current phase's rounds */
async function ethUsdAt(times) {
    const feed = ETH.ethUsdFeed;
    const price = (round) => (round && round.answer.gt(0) && round.updatedAt.gt(0) ? Number(round.answer.toString()) / 1e8 : null);
    const [latest] = await ethMulticall([{ target: feed, iface: ETH_IFACES.feed, fn: 'latestRoundData', args: [] }]);
    if (!latest) return times.map(() => null);
    const phase = latest.roundId.shr(64);
    const roundId = (n) => phase.shl(64).or(n);
    const getRound = (n) => ({ target: feed, iface: ETH_IFACES.feed, fn: 'getRoundData', args: [roundId(n)] });
    const [first] = await ethMulticall([getRound(1)]);
    const results = times.map(t => (t >= latest.updatedAt.toNumber() ? price(latest) : undefined));
    const searches = results.flatMap((r, i) => (r === undefined && first && times[i] >= first.updatedAt.toNumber()
        ? [{ i, lo: 1, hi: latest.roundId.mask(64).toNumber(), round: first }] : []));
    for (let open = searches; open.length; open = searches.filter(s => s.lo < s.hi)) {
        const mids = open.map(s => Math.ceil((s.lo + s.hi) / 2));
        const rounds = await ethMulticall(mids.map(getRound));
        open.forEach((s, j) => {
            if (!price(rounds[j])) s.lo = s.hi = 0;
            else if (rounds[j].updatedAt.toNumber() <= times[s.i]) [s.lo, s.round] = [mids[j], rounds[j]];
            else s.hi = mids[j] - 1;
        });
    }
    searches.forEach(s => { results[s.i] = s.lo ? price(s.round) : null; });
    return results.map(r => r ?? null);
}

/** DATA pools on Ethereum with liquidity: Uniswap v2 / SushiSwap pairs, Uniswap v3 pools (every fee), hookless Uniswap v4 pools */
async function discoverEthereumPools() {
    const zero = ethers.constants.AddressZero;
    const v2 = ETH.v2Factories.flatMap(f => ETH.counters.map(c => ({ f, c })));
    const v3 = ETH.v3Fees.flatMap(fee => ETH.counters.map(c => ({ fee, c })));
    const found = await ethMulticall([
        ...v2.map(({ f, c }) => ({ target: f.address, iface: ETH_IFACES.v2Factory, fn: 'getPair', args: [ETH.DATA, c.address] })),
        ...v3.map(({ fee, c }) => ({ target: ETH.v3Factory, iface: ETH_IFACES.v3Factory, fn: 'getPool', args: [ETH.DATA, c.address, fee] }))
    ]);
    const candidates = [];
    v2.forEach(({ f, c }, i) => {
        const address = found[i]?.[0];
        if (address && address !== zero) candidates.push({ chain: 1, kind: 'v2', venue: 'v2', address: address.toLowerCase(), counter: c, label: f.label, subgraph: f.subgraph });
    });
    v3.forEach(({ fee, c }, i) => {
        const address = found[v2.length + i]?.[0];
        if (address && address !== zero) candidates.push({ chain: 1, kind: 'v3', venue: 'v3', address: address.toLowerCase(), counter: c, label: `Uniswap v3 ${fee / 10000}%`, subgraph: 'ethUniV3' });
    });
    // At least 10k DATA (a pool briefly out of balance stays: its trades are shown as off-market)
    const balances = await ethMulticall(candidates.map(p => ({ target: ETH.DATA, iface: ETH_IFACES.erc20, fn: 'balanceOf', args: [p.address] })));
    const pools = candidates.filter((p, i) => balances[i]?.[0]?.gte(ETH_POOL_MIN_DATA));

    // v4: the pools of the standard tiers, against native ETH and the counters; liquidity from the PoolManager's storage
    const v4Counters = [{ address: zero, symbol: 'ETH', decimals: 18 }, ...ETH.counters];
    const v4 = v4Counters.flatMap(c => ETH.v4Tiers.map(([fee, tickSpacing]) => {
        const [currency0, currency1] = ETH.DATA < c.address.toLowerCase() ? [ETH.DATA, c.address] : [c.address, ETH.DATA];
        const id = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'address', 'uint24', 'int24', 'address'], [currency0, currency1, fee, tickSpacing, zero]));
        const slot = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['bytes32', 'uint256'], [id, ETH.v4PoolsSlot]));
        const liquiditySlot = ethers.utils.hexZeroPad(ethers.BigNumber.from(slot).add(3).toHexString(), 32);
        return { id, fee, tickSpacing, c, dataIs0: currency0 === ETH.DATA, liquiditySlot };
    }));
    const liquidity = await ethMulticall(v4.map(p => ({ target: CHAINS[1].poolManager, iface: ETH_IFACES.v4Manager, fn: 'extsload', args: [p.liquiditySlot] })));
    v4.forEach((p, i) => {
        const word = liquidity[i]?.[0];
        if (word && !ethers.BigNumber.from(word).mask(128).isZero()) {
            pools.push({ chain: 1, kind: 'v4', venue: 'v4', id: p.id, fee: p.fee, tickSpacing: p.tickSpacing, counter: p.c, label: `Uniswap v4 ${p.fee / 10000}%`, v4DataIs0: p.dataIs0, subgraph: 'ethUniV4' });
        }
    });
    return pools.map(p => ({
        chain: 1, kind: p.kind, venue: p.venue, subgraph: p.subgraph || null, label: p.label,
        ...(p.kind === 'v4' ? { id: p.id, fee: p.fee, tickSpacing: p.tickSpacing, dataIs0: p.v4DataIs0 } : { address: p.address, dataIs0: ETH.DATA < p.counter.address.toLowerCase() }),
        counterSymbol: p.counter.symbol, counterDecimals: p.counter.decimals
    }));
}

/** Ethereum pools once per session, added to the trades once found */
function loadEthereumPools() {
    if (state.ethDiscovery) return;
    state.ethDiscovery = discoverEthereumPools()
        .then(pools => addPools(pools))
        .catch(e => {
            logger.warn('Swap market: Ethereum DATA pools not found', e);
            state.ethDiscovery = null;   // asked again next time the page opens
        });
}

// ============================================
// Daily volume (Uniswap v4 subgraph)
// ============================================

const DAYS_PAGE = 1000;   // days per pool and request (The Graph's maximum)
const DAYS_POOLS = 10;    // pools per request of their days
const SUBGRAPH_POOLS = 25;   // a DEX's DATA pools read, the most traded first

// The tokens a DATA pool's volume counts against: a pool against any other token (a test or fake one) is left out
const VOLUME_COUNTERS = {
    137: new Set([USDC, '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063',
        '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', ethers.constants.AddressZero]),   // USDC, USDC.e, USDT, DAI, WPOL, WETH, POL
    1: new Set([...ETH.counters.map(c => c.address), ethers.constants.AddressZero])   // WETH, USDC, USDT, DAI, ETH
};

async function querySubgraph(subgraph, query) {
    return fetch(getDexSubgraphUrl(subgraph), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
    }).then(r => r.json());
}

/** Every DATA pool of a DEX subgraph against a known token, the emptied ones too (their past days count in the volume) */
async function subgraphPools(subgraph) {
    const chain = subgraph.startsWith('eth') ? 1 : 137;
    const data = chain === 1 ? ETH.DATA : DATA;
    const entity = subgraph === 'ethUniV2' ? 'pairs' : 'pools';
    const list = (side) => `${side}: ${entity}(first: ${SUBGRAPH_POOLS}, orderBy: txCount, orderDirection: desc, where: { ${side}: "${data}", txCount_gt: 0 }) { id token0 { id } token1 { id } }`;
    const json = await querySubgraph(subgraph, `{ ${list('token0')} ${list('token1')} }`);
    if (!Array.isArray(json?.data?.token0) || !Array.isArray(json?.data?.token1)) throw new Error(json?.errors?.[0]?.message || 'No pools');
    const v4 = subgraph === 'v4' || subgraph === 'ethUniV4';
    return [...json.data.token0, ...json.data.token1]
        .map(p => ({ id: p.id.toLowerCase(), dataIs0: p.token0.id.toLowerCase() === data, counter: (p.token0.id.toLowerCase() === data ? p.token1 : p.token0).id.toLowerCase() }))
        .filter(p => VOLUME_COUNTERS[chain].has(p.counter))
        .map(p => (v4 ? { kind: 'v4', id: p.id, dataIs0: p.dataIs0 } : { kind: 'v3', address: p.id, dataIs0: p.dataIs0 }));
}

/**
 * One DEX subgraph's days for its pools (an alias per pool), 1000 days at a time back to each pool's first. With
 * the pools' token volumes (for the days without USD); a subgraph that refuses them is asked again without them.
 */
async function fetchDays(subgraph, pools, withTokens = true) {
    // Uniswap v2 schema: pairDayDatas by pair address, daily* fields; the others: poolDayDatas by pool
    const v2 = subgraph === 'ethUniV2';
    const tokens = !withTokens ? '' : v2 ? ' volumeToken0: dailyVolumeToken0 volumeToken1: dailyVolumeToken1' : ' volumeToken0 volumeToken1';
    const fields = `${v2 ? 'date volumeUSD: dailyVolumeUSD txCount: dailyTxns' : 'date volumeUSD txCount'}${tokens}`;
    const rows = [];
    let pending = pools.map(pool => ({ pool, before: null }));
    for (let round = 0; pending.length && round < 5; round++) {
        const query = `{ ${pending.map(({ pool, before }, i) => {
            const where = `${v2 ? 'pairAddress' : 'pool'}: "${(pool.kind === 'v4' ? pool.id : pool.address).toLowerCase()}"${before ? `, date_lt: ${before}` : ''}`;
            return `p${i}: ${v2 ? 'pairDayDatas' : 'poolDayDatas'}(first: ${DAYS_PAGE}, orderBy: date, orderDirection: desc, where: { ${where} }) { ${fields} }`;
        }).join(' ')} }`;
        const json = await querySubgraph(subgraph, query);
        const lists = pending.map((p, i) => json?.data?.[`p${i}`]);
        if (!round && !lists.some(Array.isArray)) {
            if (withTokens) return fetchDays(subgraph, pools, false);
            throw new Error(json?.errors?.[0]?.message || 'No pool days');
        }
        const next = [];
        pending.forEach(({ pool }, i) => {
            const list = lists[i];
            if (!Array.isArray(list)) return;
            rows.push(...list.map(d => ({ ...d, dataIs0: pool.dataIs0 })));
            if (list.length === DAYS_PAGE) next.push({ pool, before: list[list.length - 1].date });
        });
        pending = next;
    }
    return rows;
}

/** Daily volume and transactions of every pool whose DEX has a subgraph here, added up by day */
/**
 * Daily DATA/USD of the DEX subgraphs (Uniswap v2 / v3 on Ethereum, Uniswap v3 on Polygon), once per session:
 * the price of the days before the DATA/USD history, for their volume without USD
 */
async function loadOldPrices() {
    if (state.oldPrices) return;
    const byDay = new Map();
    for (const [subgraph, token] of [['ethUniV2', ETH.DATA], ['ethUniV3', ETH.DATA], ['uni', DATA]]) {
        try {
            let after = 0;
            for (let page = 0; page < 5; page++) {
                const json = await querySubgraph(subgraph, `{ tokenDayDatas(first: ${DAYS_PAGE}, orderBy: date, orderDirection: asc, where: { token: "${token}", date_gt: ${after} }) { date priceUSD } }`);
                const days = json?.data?.tokenDayDatas;
                if (!Array.isArray(days)) throw new Error(json?.errors?.[0]?.message || 'No token days');
                for (const d of days) {
                    const t = Number(d.date) * 1000, p = Number(d.priceUSD);
                    if (p > 0 && !byDay.has(t)) byDay.set(t, p);   // the first subgraph with a price keeps the day
                }
                if (days.length < DAYS_PAGE) break;
                after = days[days.length - 1].date;
            }
        } catch (e) {
            logger.warn(`Swap market: DATA prices of ${subgraph} not loaded`, e);
        }
    }
    state.oldPrices = [...byDay].map(([t, p]) => ({ t, p })).sort((a, b) => a.t - b.t);
}

async function loadDays() {
    state.daysAt = Date.now();
    // The pools found here (Polygon: their DEX's subgraph; Ethereum: the one set when found), and every other DATA pool of each subgraph
    const bySubgraph = new Map(Object.keys(DEX_SUBGRAPH_IDS).map(subgraph => [subgraph, []]));
    for (const pool of state.pools) bySubgraph.get(pool.chain === 137 ? pool.venue : pool.subgraph)?.push(pool);
    const poolKey = (pool) => (pool.kind === 'v4' ? pool.id : pool.address).toLowerCase();
    const results = await Promise.allSettled([...bySubgraph].map(async ([subgraph, known]) => {
        const pools = new Map(known.map(pool => [poolKey(pool), pool]));
        try {
            for (const pool of await subgraphPools(subgraph)) if (!pools.has(poolKey(pool))) pools.set(poolKey(pool), pool);
        } catch (e) {
            logger.warn(`Swap market: DATA pools of ${subgraph} not listed`, e);
        }
        const list = [...pools.values()];
        const chunks = Array.from({ length: Math.ceil(list.length / DAYS_POOLS) }, (_, i) => list.slice(i * DAYS_POOLS, (i + 1) * DAYS_POOLS));
        const days = await Promise.allSettled(chunks.map(chunk => fetchDays(subgraph, chunk)));
        days.filter(r => r.status === 'rejected').forEach(r => logger.warn(`Swap market: pool volume of ${subgraph} not loaded`, r.reason));
        return days.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
    }));
    await loadOldPrices();
    const rows = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
    results.filter(r => r.status === 'rejected').forEach(r => logger.warn('Swap market: pool volume (subgraph) not loaded', r.reason));
    if (!rows.length) return;
    const byDate = new Map();
    for (const d of rows) {
        const date = Number(d.date) * 1000;
        const day = byDate.get(date) || { date, volume: 0, unpricedData: 0, txCount: 0 };
        // A day the subgraph has no USD value for (it couldn't price DATA then): its DATA, valued at the day's price
        const usd = Number(d.volumeUSD) || 0;
        if (usd > 0) day.volume += usd;
        else day.unpricedData += Number(d.dataIs0 ? d.volumeToken0 : d.volumeToken1) || 0;
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
        const trades = state.trades.filter(t => t.time >= start && !t.outlier);
        return { volume: trades.reduce((sum, t) => sum + (t.usd || 0), 0), count: trades.length };
    }
    if (state.days) {
        const firstDay = start === -Infinity ? -Infinity : Math.floor(start / DAY) * DAY;
        const days = state.days.filter(d => d.date >= firstDay);
        // The price of each day: its last one before the day ends, of the DATA/USD history, before it of the DEX subgraphs
        const historyStart = state.history[0]?.t ?? Infinity;
        const prices = [...(state.oldPrices || []).filter(p => p.t < historyStart), ...state.history];
        let i = 0;
        const volume = days.reduce((sum, d) => {
            while (i + 1 < prices.length && prices[i + 1].t < d.date + DAY) i++;
            const price = prices[i]?.t < d.date + DAY ? prices[i].p : 0;   // none before the first price
            return sum + d.volume + d.unpricedData * price;
        }, 0);
        return { volume, count: days.reduce((sum, d) => sum + d.txCount, 0) };
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

/**
 * The trades of the Uniswap v4 pools (Polygon and Ethereum), oldest first, each at its pool's USD price after it:
 * a USD counter as is, POL and ETH at Chainlink's price of the hour. Off-market ones are left out.
 */
function priceTrades() {
    const pools = new Map(state.pools.filter(p => p.kind === 'v4').map(p => [p.key, p]));
    const list = [];
    for (const trade of state.trades) {
        const pool = pools.get(trade.pool);
        if (!pool || trade.outlier || !trade.poolPrice) continue;
        const rate = USD_STABLES.includes(pool.counterSymbol) ? 1 : (isPol(pool) ? state.polUsd : state.ethUsd).get(hourOf(trade.time));
        if (rate) list.push({ time: trade.time, price: trade.poolPrice * rate });
    }
    return list;
}

function currentPrice() {
    const trades = priceTrades();
    return trades[trades.length - 1]?.price || Services.getCurrentLivePrice() || state.history[state.history.length - 1]?.p || null;
}

/** Price at a past time: the pool price after the last trade before it, else the daily history */
function priceAt(time) {
    let price = null;
    if (state.windowStart !== null && time >= state.windowStart) {
        for (const trade of priceTrades()) {
            if (trade.time > time) break;
            price = trade.price;
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
        ? (state.history[0]?.p || priceTrades()[0]?.price || null)
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

const counterName = (pool) => ({ WPOL: 'POL', WETH: 'ETH' }[pool.counterSymbol] || pool.counterSymbol);

/** Trades and pools of the list's filter: all, or one network */
function filteredPools() {
    if (state.filter === 'polygon') return state.pools.filter(p => p.chain === 137);
    if (state.filter === 'ethereum') return state.pools.filter(p => p.chain === 1);
    return state.pools;
}
function listedTrades() {
    const keys = state.filter === 'all' ? null : new Set(filteredPools().map(p => p.key));
    return state.trades.filter(t => !keys || keys.has(t.pool));
}

// Beside the price of an off-market trade (kept out of the volume and the chart)
const OUTLIER_INFO = '<button type="button" class="inline-flex text-gray-300 hover:text-white cursor-help" aria-label="Off-market price" data-tooltip-content="Price far from the market, a bot passing its own funds through a nearly empty pool.<br>Left out of the volume and the chart."><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg></button>';

// Chain logos, in the trades' Chain column
const ETHEREUM_MARK = '<svg class="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#627EEA"/><path fill="#fff" fill-opacity=".6" d="M16.5 4v8.87l7.5 3.35z"/><path fill="#fff" d="M16.5 4 9 16.22l7.5-3.35z"/><path fill="#fff" fill-opacity=".6" d="M16.5 21.97v6.03L24 17.62z"/><path fill="#fff" d="M16.5 28v-6.03L9 17.62z"/></svg>';
const POLYGON_MARK = '<svg class="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#8247E5"/><path fill="#fff" d="M21.1 13.1a1.3 1.3 0 0 0-1.3 0l-2.9 1.7-2 1.1-2.9 1.7a1.3 1.3 0 0 1-1.3 0l-2.3-1.3a1.3 1.3 0 0 1-.6-1.1v-2.6c0-.4.2-.9.6-1.1l2.2-1.3a1.3 1.3 0 0 1 1.3 0l2.2 1.3c.4.2.6.7.6 1.1v1.7l2-1.2v-1.7c0-.4-.2-.9-.6-1.1l-4.2-2.4a1.3 1.3 0 0 0-1.3 0l-4.3 2.5c-.4.2-.6.6-.6 1v4.9c0 .4.2.9.6 1.1l4.3 2.4c.4.2.9.2 1.3 0l2.9-1.6 2-1.2 2.9-1.6a1.3 1.3 0 0 1 1.3 0l2.2 1.3c.4.2.6.7.6 1.1v2.6c0 .4-.2.9-.6 1.1l-2.2 1.3a1.3 1.3 0 0 1-1.3 0l-2.2-1.3a1.3 1.3 0 0 1-.6-1.1v-1.7l-2 1.2v1.7c0 .4.2.9.6 1.1l4.3 2.4c.4.2.9.2 1.3 0l4.3-2.4c.4-.2.6-.7.6-1.1v-4.9c0-.4-.2-.9-.6-1.1z"/></svg>';
/** A trade's chain: logo + name, as the token chips (the logo alone on smaller screens, the name in its tooltip) */
export function chainChip(chain, { named = false } = {}) {
    const name = chain === 1 ? 'Ethereum' : 'Polygon';
    // named: the name on every screen (else the logo alone below 2xl)
    return `<span class="inline-flex items-center gap-1 p-0.5 ${named ? 'pr-1.5' : '2xl:pr-1.5'} rounded-full bg-[#2C2C2C] text-[11px] font-semibold text-gray-200 whitespace-nowrap" data-tooltip-content="${name}">${chain === 1 ? ETHEREUM_MARK : POLYGON_MARK}<span class="${named ? '' : 'hidden 2xl:inline'}">${name}</span></span>`;
}
/** The swap page's token chip, a size smaller for the trades list, all of one width (their arrows line up) */
const compactChip = (symbol) => state.tokenChip(symbol)
    .replace('gap-1.5 pl-1 pr-2', 'gap-1 pl-0.5 pr-1.5 min-w-[3.75rem]')
    .replace('text-xs', 'text-[11px]')
    .replaceAll('w-4 h-4', 'w-3.5 h-3.5');
const poolFullName = (pool) => (pool ? `${pool.label} · DATA/${counterName(pool)} · ${CHAINS[pool.chain].name}` : '');

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
    const listed = listedTrades();
    const reachedStart = filteredPools().every(p => p.reachedStart);
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
        // Of fixed widths (as the chips): the badges, chips and arrows line up from row to row
        const side = trade.buy
            ? '<span class="tx-badge tx-badge-in inline-block w-12 text-center">Buy</span>'
            : '<span class="tx-badge tx-badge-out inline-block w-12 text-center">Sell</span>';
        // What was paid -> what was received in the pool (the pool's full name in the tooltip)
        // The wallet's own swaps show what it paid and received in the whole swap (e.g. DATA -> POL through USDC)
        const counter = pool ? counterName(pool) : '';
        const [paid, received] = ownSwap?.pay && ownSwap?.receive
            ? [ownSwap.pay, ownSwap.receive]
            : trade.buy ? [counter, 'DATA'] : ['DATA', counter];
        const tradeCell = `<span class="inline-flex items-center gap-2.5 whitespace-nowrap" data-tooltip-content="${Utils.escapeHtml(poolFullName(pool))}">${side}<span class="inline-flex items-center gap-1.5">${compactChip(paid)}<span class="text-gray-400 text-xs">→</span>${compactChip(received)}</span></span>`;
        const own = ownSwap
            ? '<span class="ml-2 px-1.5 py-0.5 rounded bg-[#2C2C2C] text-[10px] font-semibold text-gray-300">You</span>'
            : '';
        return `
            <tr class="border-b border-[#2a2a2a] last:border-0${trade.outlier ? ' opacity-50' : ''}">
                <td class="py-2 pr-2 whitespace-nowrap"><a href="${CHAINS[pool?.chain || 137].explorer}${hash}" target="_blank" rel="noopener noreferrer" class="text-gray-300 hover:text-blue-300" data-tooltip-content="${Utils.escapeHtml(new Date(trade.time).toLocaleString())}">${formatTime(trade.time)}</a>${own}</td>
                <td class="py-2 pr-2 text-center whitespace-nowrap">${chainChip(pool?.chain || 137)}</td>
                <td class="py-2 pr-2 text-center">${tradeCell}</td>
                <td class="py-2 pr-2 text-center whitespace-nowrap text-white font-medium">${trade.outlier ? `<span class="inline-flex items-center gap-1">${OUTLIER_INFO}${formatPrice(trade.price)}</span>` : formatPrice(trade.price)}</td>
                <td class="py-2 pr-2 text-right whitespace-nowrap text-gray-200">${formatData(trade.data)}</td>
                <td class="py-2 pr-3 text-right whitespace-nowrap text-gray-200">${trade.usd === null ? '--' : formatUsd(trade.usd)}</td>
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
        for (const trade of priceTrades()) {
            if (trade.time < tradeStart) continue;
            // Trades of the same second: the price after the last of them (a step of no width would draw a needle)
            if (points[points.length - 1]?.x === trade.time) points.pop();
            points.push({ x: trade.time, y: trade.price });
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
        stepped: stepped ? 'before' : false,   // each price holds from its trade until the next one
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
    const listed = listedTrades();
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
        notifyChange();
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

// The liquidity book follows the pools and the chain filter
const changeListeners = new Set();
function notifyChange() {
    for (const listener of changeListeners) listener();
}

export const SwapMarket = {
    /** The DATA pools of the trades (Polygon and Ethereum) */
    pools: () => state.pools,
    /** The chain filter: 'all', 'polygon' or 'ethereum' */
    filter: () => state.filter,
    /** Calls `fn` when a pool is added or the chain filter changes */
    onChange(fn) {
        changeListeners.add(fn);
    },

    show() {
        setupListeners();
        state.active = true;
        renderRange();
        renderFilter();
        renderAll();
        if (Date.now() - state.daysAt > DAYS_REFRESH_MS) loadDays();
        refresh().finally(schedule);
        loadEthereumPools();
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
        addPools(descs.map(desc => ({ ...desc, chain: 137 })));
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
