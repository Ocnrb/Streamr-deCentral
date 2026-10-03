/**
 * Swap page liquidity book: the liquidity by price of the DATA pools on Uniswap v4 (where the market is, and
 * the swap goes), the alternative view to Market trades, on the chains of the market's filter. Each pool is
 * read from its chain's PoolManager storage (extsload): price, active liquidity, tick bitmap and ticks.
 * Between two initialized ticks a pool's liquidity L is constant: from √a to √b it holds L (1/√a - 1/√b) of
 * token0 and L (√b - √a) of token1. Walking away from the price, L changes by each tick's liquidityNet. The
 * pools' DATA is valued in USD (stablecoins at $1, POL and ETH at Chainlink's price) and added up in levels
 * of the same USD prices, from the deepest pool's price: above it the DATA a buy takes (asks), below it the
 * DATA a sale gets (bids).
 */

import * as Services from '../core/services.js';
import * as Utils from '../core/utils.js';
import { SwapMarket, getEthProvider, formatPrice, formatUsd, formatData } from './swapMarket.js';
import { ethers } from 'ethers';

const { logger } = Utils;
const $ = (id) => document.getElementById(id);

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';   // the same address on Polygon and Ethereum
const POOL_MANAGERS = { 137: '0x67366782805870060151383f4bbff9dab53e5cd6', 1: '0x000000000004444c5dc75cb358380d2e3de08a90' };
const FEEDS = { pol: '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0', eth: '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419' };   // Chainlink POL/USD (Polygon), ETH/USD (Ethereum)
const POOLS_SLOT = 6n;                     // the PoolManager's pools mapping
const LEVELS = 20;                         // levels on each side
const STEPS = [0.005, 0.01, 0.02, 0.04, 0.08];   // level sizes (the + shows more depth); 20 levels of 8%: about x4.7
const RANGE_TICKS = Math.ceil(Math.log(6) / Math.log(1.0001));   // ticks read each side of a pool's price (x6)
const REFRESH_MS = 30 * 1000;
const VIEW_KEY = 'swapMarketView';
const STABLES = ['USDC', 'USDC.e', 'USDT', 'DAI'];
const CHAIN_NAMES = { 137: 'Polygon', 1: 'Ethereum' };

const IFACES = {
    multicall: new ethers.utils.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']),
    manager: new ethers.utils.Interface(['function extsload(bytes32 slot) view returns (bytes32)']),
    feed: new ethers.utils.Interface(['function latestRoundData() view returns (uint80, int256 answer, uint256, uint256, uint80)'])
};

const state = {
    view: 'trades',        // 'trades' or 'book'
    models: null,          // the pools read: their liquidity around their price
    error: false,
    step: 0,               // index in STEPS
    active: false,
    loading: false,
    timer: null,
    listening: false
};

// ============================================
// Reading the pools
// ============================================

const slotHex = (n) => ethers.utils.hexZeroPad(`0x${n.toString(16)}`, 32);
const sqrtAt = (tick) => 1.0001 ** (tick / 2);
const toSigned = (value, bits) => (value >= 1n << BigInt(bits - 1) ? value - (1n << BigInt(bits)) : value);

/** Calls on one chain through Multicall3: decoded results, null for a failed one */
async function multicall(chain, calls) {
    const results = [];
    for (let i = 0; i < calls.length; i += 300) {
        const batch = calls.slice(i, i + 300);
        const data = IFACES.multicall.encodeFunctionData('aggregate3', [batch.map(c => ({ target: c.target, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args || []) }))]);
        const call = (provider) => provider.call({ to: MULTICALL3, data });
        const raw = chain === 137 ? await Services.readWithFallback(() => call(Services.getReadOnlyProvider())) : await call(getEthProvider());
        const [returned] = IFACES.multicall.decodeFunctionResult('aggregate3', raw);
        returned.forEach((r, j) => {
            try {
                results.push(r.success ? batch[j].iface.decodeFunctionResult(batch[j].fn, r.returnData) : null);
            } catch (e) {
                results.push(null);
            }
        });
    }
    return results;
}

/** The pool's storage slots in the PoolManager (v4) */
function v4Slots(id) {
    const base = BigInt(ethers.utils.keccak256(ethers.utils.solidityPack(['bytes32', 'bytes32'], [id, slotHex(POOLS_SLOT)])));
    return {
        slot0: slotHex(base),
        liquidity: slotHex(base + 3n),
        tick: (tick) => ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['int24', 'bytes32'], [tick, slotHex(base + 4n)])),
        bitmap: (word) => ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['int16', 'bytes32'], [word, slotHex(base + 5n)]))
    };
}

/** One chain's v4 pools: price and active liquidity, then the bitmap words around the price, then the ticks they mark */
async function readChain(chain, pools) {
    const manager = POOL_MANAGERS[chain];
    const load = (slot) => ({ target: manager, iface: IFACES.manager, fn: 'extsload', args: [slot] });
    const results = await multicall(chain, pools.flatMap(pool => [load(v4Slots(pool.id).slot0), load(v4Slots(pool.id).liquidity)]));
    const models = [];
    pools.forEach((pool, i) => {
        const [slot0, liquidity] = [results[i * 2], results[i * 2 + 1]];
        if (!slot0 || !liquidity || !(pool.tickSpacing > 0)) return;
        const word = BigInt(slot0[0]);
        const S = Number(word & ((1n << 160n) - 1n)) / 2 ** 96;
        if (!(S > 0)) return;
        models.push({ pool, chain, S, tick: Number(toSigned((word >> 160n) & 0xffffffn, 24)), L: Number(BigInt(liquidity[0]) & ((1n << 128n) - 1n)), spacing: pool.tickSpacing, ticks: [] });
    });

    const wordCalls = models.map(m => {
        const compress = (tick) => Math.floor(tick / m.spacing);
        const words = [];
        for (let w = compress(m.tick - RANGE_TICKS) >> 8; w <= compress(m.tick + RANGE_TICKS) >> 8; w++) words.push(w);
        m.words = words;
        return words.map(w => load(v4Slots(m.pool.id).bitmap(w)));
    });
    const words = await multicall(chain, wordCalls.flat());
    let at = 0;
    const tickCalls = models.map((m, i) => {
        const found = [];
        m.words.forEach((w, j) => {
            let bits = words[at + j] ? BigInt(words[at + j][0].toString()) : 0n;
            for (let bit = 0; bits; bit++, bits >>= 1n) {
                if (bits & 1n) {
                    const tick = ((w << 8) + bit) * m.spacing;
                    if (Math.abs(tick - m.tick) <= RANGE_TICKS) found.push(tick);
                }
            }
        });
        at += wordCalls[i].length;
        m.found = found;
        return found.map(tick => load(v4Slots(m.pool.id).tick(tick)));
    });
    const infos = await multicall(chain, tickCalls.flat());
    at = 0;
    models.forEach((m, i) => {
        m.found.forEach((tick, j) => {
            // A tick's first word: liquidityGross, then liquidityNet (int128) in the high half
            if (infos[at + j]) m.ticks.push({ tick, net: Number(toSigned(BigInt(infos[at + j][0]) >> 128n, 128)) });
        });
        at += tickCalls[i].length;
    });
    return models;
}

/** Chainlink's latest price (8 decimals), null when not read */
async function feedPrice(chain, feed) {
    try {
        const [result] = await multicall(chain, [{ target: feed, iface: IFACES.feed, fn: 'latestRoundData' }]);
        return result ? Number(result.answer.toString()) / 1e8 : null;
    } catch (e) {
        logger.warn('Liquidity book: USD price not read', e);
        return null;
    }
}

async function readModels() {
    const pools = SwapMarket.pools().filter(p => p.kind === 'v4');
    const [pol, eth] = await Promise.all([feedPrice(137, FEEDS.pol), feedPrice(1, FEEDS.eth)]);
    const usdOf = (symbol) => (STABLES.includes(symbol) ? 1 : symbol === 'POL' || symbol === 'WPOL' ? pol : symbol === 'ETH' || symbol === 'WETH' ? eth : null);
    const chains = await Promise.allSettled([137, 1].map(chain => {
        const list = pools.filter(p => p.chain === chain && usdOf(p.counterSymbol));
        return list.length ? readChain(chain, list) : [];
    }));
    chains.filter(r => r.status === 'rejected').forEach(r => logger.warn('Liquidity book: pools not read', r.reason));
    const models = chains.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
    for (const m of models) {
        m.usd = usdOf(m.pool.counterSymbol);
        // DATA has 18 decimals; the raw price is token1 per token0
        m.dec0 = m.pool.dataIs0 ? 18 : m.pool.counterDecimals;
        m.dec1 = m.pool.dataIs0 ? m.pool.counterDecimals : 18;
        m.price = usdAtSqrt(m, m.S);
    }
    return models;
}

// ============================================
// Levels
// ============================================

/** DATA's USD price at a pool's raw √price, and back */
function usdAtSqrt(m, sqrt) {
    const raw = sqrt * sqrt * 10 ** (m.dec0 - m.dec1);   // token1 per token0
    return (m.pool.dataIs0 ? raw : 1 / raw) * m.usd;
}
function sqrtAtUsd(m, usd) {
    const counter = usd / m.usd;
    const raw = (m.pool.dataIs0 ? counter : 1 / counter) / 10 ** (m.dec0 - m.dec1);
    return Math.sqrt(raw);
}

/**
 * The DATA and its USD value between a pool's price and each USD edge in turn (asks up, bids down): a level
 * the pool's price is already beyond is empty, the first one past it starts at the pool's price
 */
function sweep(m, edges, side) {
    const up = (side === 'ask') === m.pool.dataIs0;   // DATA's price rises with the raw price when DATA is token0
    const ticks = m.ticks.filter(t => (up ? t.tick > m.tick : t.tick <= m.tick)).sort((a, b) => (up ? a.tick - b.tick : b.tick - a.tick));
    let L = m.L;
    let pos = m.S;
    let j = 0;
    return edges.map(edge => {
        const target = sqrtAtUsd(m, edge);
        let t0 = 0;
        let t1 = 0;
        if (!(up ? target > pos : target < pos)) return { data: 0, usd: 0 };
        while (pos !== target) {
            const next = j < ticks.length ? sqrtAt(ticks[j].tick) : null;
            const crosses = next !== null && (up ? next < target : next > target);
            const stop = crosses ? next : target;
            const [a, b] = up ? [pos, stop] : [stop, pos];
            const l = Math.max(0, L);
            t0 += l * (1 / a - 1 / b);
            t1 += l * (b - a);
            pos = stop;
            if (crosses) {
                L += up ? ticks[j].net : -ticks[j].net;
                j++;
            }
        }
        const data = (m.pool.dataIs0 ? t0 : t1) / 1e18;
        const counter = (m.pool.dataIs0 ? t1 / 10 ** m.dec1 : t0 / 10 ** m.dec0);
        return { data, usd: counter * m.usd };
    });
}

/** The book of the pools shown: levels from the price of the deepest pool (its liquidity within 2% of its price) */
function buildBook(models) {
    const depth = (m, price) => sweep(m, [price * 1.02], 'ask')[0].usd + sweep(m, [price / 1.02], 'bid')[0].usd;
    const deepest = models.reduce((best, m) => {
        const d = depth(m, m.price);
        return !best || d > best.d ? { m, d } : best;
    }, null);
    const price = deepest.m.price;
    const step = STEPS[state.step];
    const askEdges = Array.from({ length: LEVELS }, (_, k) => price * (1 + step) ** (k + 1));
    const bidEdges = Array.from({ length: LEVELS }, (_, k) => price / (1 + step) ** (k + 1));
    const add = (edges, side) => edges.map((edge, k) => ({ price: edge, ...models.map(m => sweep(m, edges, side)[k]).reduce((sum, l) => ({ data: sum.data + l.data, usd: sum.usd + l.usd }), { data: 0, usd: 0 }) }));
    return { price, asks: add(askEdges, 'ask'), bids: add(bidEdges, 'bid') };
}

function shownModels() {
    const filter = SwapMarket.filter();
    return (state.models || []).filter(m => filter === 'all' || (filter === 'polygon' ? m.chain === 137 : m.chain === 1));
}

// ============================================
// Rendering
// ============================================

async function load() {
    if (state.loading) return;
    state.loading = true;
    try {
        state.models = await readModels();
        state.error = !state.models.length;
    } catch (e) {
        logger.warn('Liquidity book: pools not read', e);
        state.error = true;
    } finally {
        state.loading = false;
    }
    if (state.active && state.view === 'book') render();
}

function schedule() {
    clearTimeout(state.timer);
    if (!state.active || state.view !== 'book') return;
    state.timer = setTimeout(async () => {
        if (!document.hidden) await load();
        schedule();
    }, REFRESH_MS);
}

/**
 * A side's rows, the nearest level first. Each row's tooltip sums the levels from the price up to it: the DATA and USD
 * of a swap that moves the price that far and its average price (before the pool fee)
 */
function levelRows(levels, side, max) {
    let total = 0;
    let data = 0;
    return levels.map((level, k) => {
        total += level.usd;
        data += level.data;
        if (level.data < 1) return '';   // no liquidity at these prices
        const width = max > 0 ? Math.min(100, (total / max) * 100) : 0;
        const tooltip = [
            `Total DATA ${formatData(data)}`,
            `Average price ${formatPrice(total / data)}`
        ].join('<br>');
        return `
            <div data-book-k="${k}" data-tooltip-content="${Utils.escapeHtml(tooltip)}" class="relative grid grid-cols-3 gap-2 px-1 py-1 text-sm cursor-default transition-colors">
                <div class="absolute inset-y-0 right-0 ${side === 'ask' ? 'bg-red-500/10' : 'bg-green-500/10'}" style="width: ${width.toFixed(1)}%"></div>
                <span class="relative ${side === 'ask' ? 'text-red-400' : 'text-green-400'} font-medium">${formatPrice(level.price)}</span>
                <span class="relative text-right text-gray-200">${formatData(level.data)}</span>
                <span class="relative text-right text-gray-300">${formatUsd(total)}</span>
            </div>`;
    });
}

/** The rows from the price to the hovered one (all of a swap that far), or none */
function highlightRows(container, row) {
    const k = row ? Number(row.dataset.bookK) : -1;
    container.querySelectorAll('[data-book-k]').forEach(r => r.classList.toggle('bg-white/[0.06]', Number(r.dataset.bookK) <= k));
}

const ZOOM_BUTTON = 'inline-flex items-center justify-center w-5 h-5 rounded text-gray-400 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:hover:bg-transparent transition-colors';

function render() {
    const asksEl = $('swap-book-asks');
    const bidsEl = $('swap-book-bids');
    const midEl = $('swap-book-mid');
    if (!asksEl || !bidsEl || !midEl) return;
    const models = shownModels();
    if (!models.length) {
        const spinner = '<span class="w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" aria-hidden="true"></span>';
        const text = !state.models ? (state.error ? 'The pools could not be read, trying again...' : 'Reading the pools...') : 'No pool liquidity read on this chain.';
        asksEl.innerHTML = '';
        bidsEl.innerHTML = '';
        midEl.innerHTML = `<span class="inline-flex items-center gap-2 text-sm text-gray-300">${!state.models && !state.error ? spinner : ''}${text}</span>`;
        return;
    }
    const book = buildBook(models);
    const sum = (levels) => levels.reduce((total, level) => total + level.usd, 0);
    const max = Math.max(sum(book.asks), sum(book.bids));
    // Asks above the price, the nearest at the bottom; bids below it, the nearest at the top
    asksEl.innerHTML = levelRows(book.asks, 'ask', max).reverse().join('');
    bidsEl.innerHTML = levelRows(book.bids, 'bid', max).join('');
    asksEl.scrollTop = asksEl.scrollHeight;
    bidsEl.scrollTop = 0;
    const names = models.map(m => `${m.pool.label} · DATA/${m.pool.counterSymbol === 'WPOL' ? 'POL' : m.pool.counterSymbol} · ${CHAIN_NAMES[m.chain]}`).join('<br>');
    const percent = `${(STEPS[state.step] * 100).toFixed(STEPS[state.step] < 0.01 ? 1 : 0)}%`;
    midEl.innerHTML = `
        <span class="flex items-baseline gap-2">
            <span class="text-base font-semibold text-white">${formatPrice(book.price)}</span>
            <span class="text-xs text-gray-400" data-tooltip-content="${Utils.escapeHtml(names)}">${models.length} ${models.length === 1 ? 'pool' : 'pools'}</span>
        </span>
        <span class="inline-flex items-center gap-1 text-xs text-gray-300">
            <span class="mr-1 text-gray-400">Levels</span>
            <button type="button" data-book-step="-1" class="${ZOOM_BUTTON}" aria-label="Narrower levels" ${state.step === 0 ? 'disabled' : ''}><svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg></button>
            <span class="w-8 text-center tabular-nums">${percent}</span>
            <button type="button" data-book-step="1" class="${ZOOM_BUTTON}" aria-label="Wider levels" ${state.step === STEPS.length - 1 ? 'disabled' : ''}><svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg></button>
        </span>`;
}

function setView(view) {
    state.view = view === 'book' ? 'book' : 'trades';
    try { localStorage.setItem(VIEW_KEY, state.view); } catch (e) { /* kept for this visit only */ }
    const book = state.view === 'book';
    document.querySelectorAll('[data-market-view]').forEach(btn => {
        const selected = btn.dataset.marketView === state.view;
        btn.setAttribute('aria-selected', String(selected));
        btn.classList.toggle('text-white', selected);
        btn.classList.toggle('text-gray-500', !selected);
        btn.classList.toggle('hover:text-gray-300', !selected);
    });
    $('swap-trades-view')?.classList.toggle('hidden', book);
    const info = $('swap-book-info');   // its tooltip explains the books
    info?.classList.toggle('hidden', !book);
    info?.classList.toggle('flex', book);
    $('swap-book-view')?.classList.toggle('hidden', !book);
    if (book) {
        render();
        load();
    }
    schedule();
}

export const SwapBook = {
    show() {
        state.active = true;
        if (!state.listening) {
            state.listening = true;
            $('swap-market-views')?.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-market-view]');
                if (btn) setView(btn.dataset.marketView);
            });
            $('swap-book-mid')?.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-book-step]');
                if (!btn) return;
                state.step = Math.min(STEPS.length - 1, Math.max(0, state.step + Number(btn.dataset.bookStep)));
                render();
            });
            // Hovering a level highlights the levels from the price to it
            ['swap-book-asks', 'swap-book-bids'].forEach(id => {
                const container = $(id);
                container?.addEventListener('mouseover', (e) => highlightRows(container, e.target.closest('[data-book-k]')));
                container?.addEventListener('mouseleave', () => highlightRows(container, null));
            });
            // The chain filter re-draws the book; a new pool is read
            let pools = 0;
            SwapMarket.onChange(() => {
                if (!state.active || state.view !== 'book') return;
                if (SwapMarket.pools().length !== pools) {
                    pools = SwapMarket.pools().length;
                    load();
                }
                render();
            });
        }
        let view = 'trades';
        try { view = localStorage.getItem(VIEW_KEY) || 'trades'; } catch (e) { /* the trades */ }
        setView(view);
    },

    stop() {
        state.active = false;
        clearTimeout(state.timer);
    }
};
