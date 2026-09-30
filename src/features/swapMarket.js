/**
 * Swap page market panel: the DATA/USD chart and the latest trades of the main DATA pool.
 * - Trades: Swap events of the Uniswap v4 DATA/USDC 0.3% pool (where the DATA liquidity on Polygon is),
 *   read with the explorer's log API. A trade's price is its USDC amount over its DATA amount; whether it
 *   bought or sold DATA comes from the move of the pool price (only swaps move it).
 * - Chart: 24H and 7D follow the pool price trade by trade; longer ranges use the daily DATA/USD
 *   history (DATA_History stream, CSV fallback). Every range ends at the pool's current price.
 */

import * as Utils from '../core/utils.js';
import * as Services from '../core/services.js';
import { DATA_TOKEN_ADDRESS_POLYGON, POLYGONSCAN_NETWORK, getEtherscanApiKey } from '../core/constants.js';

const { logger } = Utils;

const DATA = DATA_TOKEN_ADDRESS_POLYGON.toLowerCase();
const USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const POOL_MANAGER = '0x67366782805870060151383f4bbff9dab53e5cd6';
const SWAP_TOPIC = ethers.utils.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const DATA_IS_CURRENCY0 = DATA < USDC;
const POOL_ID = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [...(DATA_IS_CURRENCY0 ? [DATA, USDC] : [USDC, DATA]), 3000, 60, ethers.constants.AddressZero]
));

const BLOCKS_PER_DAY = 43200;        // Polygon: about 2 s per block
const TRADE_DAYS = 7;
const MAX_LOGS = 1000;               // the explorer returns at most 1000 logs (the oldest first)
const TRADES_PAGE = 50;              // rows shown at first, and added by Load More
const MAX_PAGES = 5;                 // explorer pages of 1000 logs for the 7 days (5000 trades)
const PAGE_PAUSE_MS = 400;           // between pages (explorer rate limit)
const REFRESH_MS = 30 * 1000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const RANGES = { '24H': DAY, '7D': 7 * DAY, '1M': 30 * DAY, '3M': 90 * DAY, '1Y': 365 * DAY, 'All': Infinity };
const TRADE_RANGES = ['24H', '7D'];

const state = {
    active: false,
    range: '7D',
    trades: [],            // oldest first
    seen: new Set(),       // txHash:logIndex
    nextFromBlock: null,
    windowStart: null,     // time from which the trades are complete
    loaded: false,
    error: false,
    history: [],           // daily { t, p }, oldest first
    ownHashes: new Set(),
    shown: TRADES_PAGE,    // rows of the trades list
    oldestBlock: null,     // first block of the loaded trades range
    firstTradeBlock: undefined,  // block of the pool's first trade (null: none)
    reachedStart: false,   // every trade since the pool's first one is loaded
    loadingOlder: false,
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

function formatTime(ms, withYear = false) {
    const date = new Date(ms);
    const today = new Date().toDateString() === date.toDateString();
    return today
        ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleString(undefined, { ...(withYear ? { year: 'numeric' } : {}), month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ============================================
// Trades (Swap events of the pool)
// ============================================

const EXPLORER_BUSY = /rate limit|max calls|too many|timeout|temporarily|busy/i;

/** Swap logs of the pool from a block on; a busy explorer (rate limit: the app's default key is shared) is asked again shortly */
async function fetchLogs(fromBlock, page = 1, toBlock = 'latest', offset = MAX_LOGS) {
    const url = `${POLYGONSCAN_NETWORK.apiUrl}?chainid=137&module=logs&action=getLogs&address=${POOL_MANAGER}`
        + `&topic0=${SWAP_TOPIC}&topic0_1_opr=and&topic1=${POOL_ID}&fromBlock=${fromBlock}&toBlock=${toBlock}`
        + `&page=${page}&offset=${offset}&apikey=${getEtherscanApiKey()}`;
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

/** USDC per DATA from the pool's sqrtPriceX96 */
function poolPrice(sqrtPriceX96) {
    const ratio = (Number(sqrtPriceX96.toString()) / 2 ** 96) ** 2;   // currency1 per currency0, raw units
    return DATA_IS_CURRENCY0 ? ratio * 1e12 : 1e12 / ratio;
}

function parseLog(log) {
    const [amount0, amount1, sqrtPriceX96] = ethers.utils.defaultAbiCoder.decode(
        ['int128', 'int128', 'uint160', 'uint128', 'int24', 'uint24'], log.data
    );
    const dataDelta = DATA_IS_CURRENCY0 ? amount0 : amount1;
    const usdcDelta = DATA_IS_CURRENCY0 ? amount1 : amount0;
    const data = Math.abs(Number(ethers.utils.formatUnits(dataDelta, 18)));
    const usd = Math.abs(Number(ethers.utils.formatUnits(usdcDelta, 6)));
    return {
        id: `${log.transactionHash}:${parseInt(log.logIndex, 16)}`,
        txHash: log.transactionHash,
        block: parseInt(log.blockNumber, 16),
        logIndex: parseInt(log.logIndex, 16),
        time: parseInt(log.timeStamp, 16) * 1000,
        data,
        usd,
        price: data > 0 ? usd / data : 0,
        poolPrice: poolPrice(sqrtPriceX96),
        // v4 swap deltas are the swapper's: negative = paid into the pool
        signBuy: dataDelta.gt(0)
    };
}

/** Buy / sell of each trade: the pool price goes up when DATA is bought (only swaps move it) */
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
async function fetchRange(fromBlock, toBlock) {
    const logs = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
        if (page > 1) await pause(PAGE_PAUSE_MS);
        const pageLogs = await fetchLogs(fromBlock, page, toBlock);
        logs.push(...pageLogs);
        if (pageLogs.length < MAX_LOGS) return { logs, complete: true };
    }
    return { logs, complete: false };
}

/** The trades of up to `days` before toBlock; a range too busy for MAX_PAGES pages is narrowed, so the newest are there */
async function fetchNewest(toBlock, days, floorBlock = 0) {
    for (;;) {
        const fromBlock = Math.max(floorBlock, toBlock - Math.round(days * BLOCKS_PER_DAY));
        const { logs, complete } = await fetchRange(fromBlock, toBlock);
        if (complete || days <= 0.25) return { logs, fromBlock };
        days /= 4;
    }
}

function addTrades(logs) {
    let added = 0;
    for (const log of logs) {
        const trade = parseLog(log);
        if (state.seen.has(trade.id)) continue;
        state.seen.add(trade.id);
        state.trades.push(trade);
        added++;
    }
    state.trades.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    setSides(state.trades);
    return added;
}

async function loadTrades() {
    const latest = await Services.readWithFallback(() => Services.getReadOnlyProvider().getBlockNumber());
    let added;
    if (state.nextFromBlock === null) {
        const { logs, fromBlock } = await fetchNewest(latest, TRADE_DAYS);
        state.oldestBlock = fromBlock;
        state.windowStart = Date.now() - (latest - fromBlock) * (DAY / BLOCKS_PER_DAY);
        added = addTrades(logs);
    } else {
        added = addTrades(await fetchLogs(state.nextFromBlock));
    }
    const lastLogBlock = state.trades.length ? state.trades[state.trades.length - 1].block : 0;
    // From the last trade seen (the explorer may be a few blocks behind the RPC); duplicates are skipped
    state.nextFromBlock = Math.max(lastLogBlock, latest - 150);
    state.loaded = true;
    state.error = false;
    return added;
}

/** Trades before the oldest loaded: 7 days back, further (a doubling window) over quiet weeks, until the pool's first trade */
async function loadOlder() {
    if (state.reachedStart || state.oldestBlock === null) return 0;
    if (state.firstTradeBlock === undefined) {
        const first = await fetchLogs(0, 1, 'latest', 1);
        state.firstTradeBlock = first.length ? parseInt(first[0].blockNumber, 16) : null;
    }
    let added = 0;
    let days = TRADE_DAYS;
    while (!added) {
        if (state.firstTradeBlock === null || state.oldestBlock <= state.firstTradeBlock) {
            state.reachedStart = true;
            break;
        }
        const { logs, fromBlock } = await fetchNewest(state.oldestBlock - 1, days, state.firstTradeBlock);
        state.oldestBlock = fromBlock;
        added = addTrades(logs);
        days *= 2;
        if (!added) await pause(PAGE_PAUSE_MS);
    }
    // The trades are complete from the oldest one loaded on
    if (state.trades.length) state.windowStart = Math.min(state.windowStart, state.trades[0].time);
    if (state.oldestBlock <= state.firstTradeBlock) state.reachedStart = true;
    return added;
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
    const last = state.trades[state.trades.length - 1];
    return last?.poolPrice || Services.getCurrentLivePrice() || state.history[state.history.length - 1]?.p || null;
}

/** Price at a past time: the pool price after the last trade before it, else the daily history */
function priceAt(time) {
    let price = null;
    if (state.windowStart !== null && time >= state.windowStart) {
        for (const trade of state.trades) {
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
    const before = priceAt(Date.now() - DAY);
    if (now && before) {
        const pct = (now / before - 1) * 100;
        const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
        change.textContent = `${sign}${Math.abs(pct).toFixed(2)}% 24h`;
        change.className = `text-sm font-semibold ${pct > 0 ? 'text-green-400' : pct < 0 ? 'text-red-400' : 'text-gray-300'}`;
    } else {
        change.textContent = '';
    }
    const day = state.trades.filter(t => t.time >= Date.now() - DAY);
    // Volume and trades come from the trades list: empty until it loads
    $('swap-market-stats').textContent = state.loaded
        ? `24h volume ${formatUsd(day.reduce((sum, t) => sum + t.usd, 0))} · ${day.length} ${day.length === 1 ? 'trade' : 'trades'} in 24h`
        : '';
}

// ============================================
// Trades table
// ============================================

function renderTrades() {
    const body = $('swap-trades');
    if (!body) return;
    const row = (text) => `<tr><td colspan="5" class="py-4 text-sm text-gray-300">${text}</td></tr>`;
    if (!state.loaded) {
        $('swap-trades-more')?.classList.add('hidden');
        const spinner = '<span class="w-4 h-4 flex-shrink-0 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" aria-hidden="true"></span>';
        body.innerHTML = row(`<span class="inline-flex items-center gap-2">${spinner}${state.error ? 'The explorer is busy, trying again...' : 'Loading market trades...'}</span>`);
        return;
    }
    // Load More stays until every trade since the pool's first one is shown
    $('swap-trades-more')?.classList.toggle('hidden', state.trades.length <= state.shown && state.reachedStart);
    const recent = state.trades.slice(-state.shown).reverse();
    if (!recent.length) {
        body.innerHTML = row(state.reachedStart ? 'No trades on this pool yet.' : `No trades in the last ${TRADE_DAYS} days.`);
        return;
    }
    body.innerHTML = recent.map(trade => {
        const hash = Utils.escapeHtml(trade.txHash);
        const side = trade.buy
            ? '<span class="tx-badge tx-badge-in whitespace-nowrap">Buy</span>'
            : '<span class="tx-badge tx-badge-out whitespace-nowrap">Sell</span>';
        const own = state.ownHashes.has(trade.txHash.toLowerCase())
            ? '<span class="ml-2 px-1.5 py-0.5 rounded bg-[#2C2C2C] text-[10px] font-semibold text-gray-300">You</span>'
            : '';
        return `
            <tr class="border-b border-[#2a2a2a] last:border-0">
                <td class="py-2 pr-2 whitespace-nowrap"><a href="https://polygonscan.com/tx/${hash}" target="_blank" rel="noopener noreferrer" class="text-gray-300 hover:text-blue-300" data-tooltip-content="${Utils.escapeHtml(new Date(trade.time).toLocaleString())}">${formatTime(trade.time)}</a>${own}</td>
                <td class="py-2 pr-2">${side}</td>
                <td class="py-2 pr-2 text-right whitespace-nowrap text-white font-medium">${formatPrice(trade.price)}</td>
                <td class="py-2 pr-2 text-right whitespace-nowrap text-gray-200">${formatData(trade.data)}</td>
                <td class="py-2 text-right whitespace-nowrap text-gray-200">${formatUsd(trade.usd)}</td>
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
        for (const trade of state.trades) {
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
        if (!document.hidden) await refresh();
        schedule();
    }, delay);
}

/** Next 50 rows: from the loaded trades, else older ones from the explorer */
async function loadMore() {
    const btn = $('swap-trades-more');
    if (state.shown < state.trades.length) {
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
    $('swap-chart-range')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-range]');
        if (!btn || btn.dataset.range === state.range) return;
        state.range = btn.dataset.range;
        renderRange();
        renderChart();
    });
    Services.onHistoricalDataLoaded(setHistory);
}

export const SwapMarket = {
    show() {
        setupListeners();
        state.active = true;
        renderRange();
        renderAll();
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

    /** Swaps of this wallet: marked in the trades list */
    setOwnTxHashes(hashes) {
        state.ownHashes = new Set(hashes.map(h => h.toLowerCase()));
        if (state.active && state.loaded) renderTrades();
    }
};
