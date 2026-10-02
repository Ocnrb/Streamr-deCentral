/**
 * Swap page order book: the main DATA pool's liquidity (Uniswap v4 DATA/USDC 0.3%) as price levels, the
 * alternative view to Market trades. Concentrated liquidity sits between ticks: above the price it is DATA
 * for sale (asks), below it USDC buying DATA (bids). Read from the PoolManager's storage (extsload): the
 * pool's price and active liquidity, then the liquidityNet of each tick a level ends on (liquidity is only
 * added or removed on multiples of the tick spacing, so the levels are exact). Walking up from the price
 * the liquidity grows by each tick's net, walking down it shrinks by it.
 */

import * as Services from '../core/services.js';
import * as Utils from '../core/utils.js';
import { DATA_TOKEN_ADDRESS_POLYGON } from '../core/constants.js';
import { formatPrice, formatUsd, formatData } from './swapMarket.js';
import { ethers } from 'ethers';

const { logger } = Utils;
const $ = (id) => document.getElementById(id);

const POOL_MANAGER = '0x67366782805870060151383f4bbff9dab53e5cd6';
const DATA = DATA_TOKEN_ADDRESS_POLYGON.toLowerCase();
const USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const FEE = 3000;
const TICK_SPACING = 60;                 // a level: 60 ticks, about 0.6% of price
const LEVELS = 20;                       // levels on each side, about 12.7%
const POOLS_SLOT = 6;                    // the PoolManager's pools mapping
const DEPTH_PERCENT = 2;                 // the depth shown beside the price: within 2% of it
const REFRESH_MS = 30 * 1000;
const VIEW_KEY = 'swapMarketView';

// DATA sorts before USDC: it is the pool's currency0, the price is USDC per DATA
const POOL_ID = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(
    ['address', 'address', 'uint24', 'int24', 'address'], [DATA, USDC, FEE, TICK_SPACING, ethers.constants.AddressZero]));
const STATE_SLOT = BigInt(ethers.utils.keccak256(ethers.utils.solidityPack(['bytes32', 'bytes32'], [POOL_ID, ethers.utils.hexZeroPad(ethers.utils.hexlify(POOLS_SLOT), 32)])));
const IFACE = new ethers.utils.Interface(['function extsload(bytes32[] slots) view returns (bytes32[])']);
const DECIMALS_SHIFT = 1e12;             // DATA 18 decimals, USDC 6

const slotHex = (n) => ethers.utils.hexZeroPad(`0x${n.toString(16)}`, 32);
/** Storage slot of a tick's info: pools[id].ticks[tick] (its first word: liquidityGross, then liquidityNet) */
const tickSlot = (tick) => ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['int24', 'bytes32'], [tick, slotHex(STATE_SLOT + 4n)]));
const sqrtAt = (tick) => 1.0001 ** (tick / 2);
const usdPrice = (sqrtPrice) => sqrtPrice * sqrtPrice * DECIMALS_SHIFT;

const state = {
    view: 'trades',        // 'trades' or 'book'
    book: null,            // { price, asks, bids } (levels nearest the price first)
    error: false,
    active: false,
    timer: null,
    listening: false
};

async function extsload(slots) {
    const data = await Services.readWithFallback(() => Services.getReadOnlyProvider().call({ to: POOL_MANAGER, data: IFACE.encodeFunctionData('extsload', [slots]) }));
    return IFACE.decodeFunctionResult('extsload', data)[0];
}

/** The pool's levels: each one's DATA, its USD value and the price it reaches */
async function readBook() {
    const [slot0, active] = await extsload([slotHex(STATE_SLOT), slotHex(STATE_SLOT + 3n)]);
    const word = BigInt(slot0);
    const sqrtNow = Number(word & ((1n << 160n) - 1n)) / 2 ** 96;
    let tick = Number((word >> 160n) & 0xffffffn);
    if (tick >= 2 ** 23) tick -= 2 ** 24;
    if (!sqrtNow) throw new Error('The pool has no price');
    const base = Math.floor(tick / TICK_SPACING) * TICK_SPACING;
    const edges = Array.from({ length: 2 * LEVELS }, (_, i) => base + (i - LEVELS + 1) * TICK_SPACING);   // base - 19 levels .. base + 20 levels
    const words = await extsload(edges.map(tickSlot));
    const net = new Map(edges.map((edge, i) => {
        let value = BigInt(words[i]) >> 128n;   // liquidityNet: int128 in the high half
        if (value >= 1n << 127n) value -= 1n << 128n;
        return [edge, value];
    }));
    const liquidity = BigInt(active) & ((1n << 128n) - 1n);

    // Asks: from the price up to each level's top, DATA = L (1/√a - 1/√b), paid in USDC = L (√b - √a)
    const asks = [];
    let L = liquidity;
    let lower = sqrtNow;
    for (let k = 1; k <= LEVELS; k++) {
        const edge = base + k * TICK_SPACING;
        const upper = sqrtAt(edge);
        const l = Number(L);
        asks.push({ price: usdPrice(upper), data: l * (1 / lower - 1 / upper) / 1e18, usd: l * (upper - lower) / 1e6 });
        L += net.get(edge) || 0n;
        lower = upper;
    }
    // Bids: from the price down to each level's bottom
    const bids = [];
    L = liquidity;
    let upper = sqrtNow;
    for (let k = 0; k < LEVELS; k++) {
        const edge = base - k * TICK_SPACING;
        const lowerEdge = sqrtAt(edge);
        const l = Number(L);
        if (upper > lowerEdge) bids.push({ price: usdPrice(lowerEdge), data: l * (1 / lowerEdge - 1 / upper) / 1e18, usd: l * (upper - lowerEdge) / 1e6 });
        L -= net.get(edge) || 0n;
        upper = lowerEdge;
    }
    return { price: usdPrice(sqrtNow), asks, bids };
}

async function load() {
    try {
        state.book = await readBook();
        state.error = false;
    } catch (e) {
        logger.warn('Swap order book: pool not read', e);
        state.error = true;
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

function levelRows(levels, side, max) {
    let total = 0;
    return levels.map(level => {
        total += level.usd;
        if (level.data < 1) return '';   // an empty level (no liquidity there)
        const width = max > 0 ? Math.min(100, (total / max) * 100) : 0;
        const bar = side === 'ask' ? 'bg-red-500/10' : 'bg-green-500/10';
        const color = side === 'ask' ? 'text-red-400' : 'text-green-400';
        return `
            <div class="relative grid grid-cols-3 gap-2 px-1 py-1 text-sm">
                <div class="absolute inset-y-0 right-0 ${bar}" style="width: ${width.toFixed(1)}%"></div>
                <span class="relative ${color} font-medium">${formatPrice(level.price)}</span>
                <span class="relative text-right text-gray-200">${formatData(level.data)}</span>
                <span class="relative text-right text-gray-300">${formatUsd(total)}</span>
            </div>`;
    });
}

function render() {
    const asksEl = $('swap-book-asks');
    const bidsEl = $('swap-book-bids');
    const midEl = $('swap-book-mid');
    if (!asksEl || !bidsEl || !midEl) return;
    if (!state.book) {
        const text = state.error ? 'The pool could not be read, trying again...' : 'Reading the pool...';
        asksEl.innerHTML = '';
        bidsEl.innerHTML = '';
        midEl.innerHTML = `<span class="inline-flex items-center gap-2 text-sm text-gray-300">${state.error ? '' : '<span class="w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" aria-hidden="true"></span>'}${text}</span>`;
        return;
    }
    const { price, asks, bids } = state.book;
    const sum = (levels) => levels.reduce((total, level) => total + level.usd, 0);
    const max = Math.max(sum(asks), sum(bids));
    // Asks above the price, the nearest at the bottom; bids below it, the nearest at the top
    asksEl.innerHTML = levelRows(asks, 'ask', max).reverse().join('');
    bidsEl.innerHTML = levelRows(bids, 'bid', max).join('');
    asksEl.scrollTop = asksEl.scrollHeight;
    bidsEl.scrollTop = 0;
    const within = (levels, inside) => sum(levels.filter(level => inside(level.price)));
    const askDepth = within(asks, p => p <= price * (1 + DEPTH_PERCENT / 100));
    const bidDepth = within(bids, p => p >= price * (1 - DEPTH_PERCENT / 100));
    midEl.innerHTML = `
        <span class="text-base font-semibold text-white">${formatPrice(price)}</span>
        <span class="text-xs text-gray-300" data-tooltip-content="DATA for sale up to ${DEPTH_PERCENT}% above the price · USDC buying DATA down to ${DEPTH_PERCENT}% below it">${DEPTH_PERCENT}% depth <span class="text-red-400">${formatUsd(askDepth)}</span> · <span class="text-green-400">${formatUsd(bidDepth)}</span></span>`;
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
    $('swap-trades-filter')?.classList.toggle('hidden', book);
    $('swap-book-view')?.classList.toggle('hidden', !book);
    $('swap-book-pool')?.classList.toggle('hidden', !book);
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
