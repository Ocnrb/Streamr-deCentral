/**
 * Market page, Liquidity tab: the wallet's actions on the DATA/USDC Uniswap v4 pools.
 * - New position (in the pool card): a range (full, a strategy or custom prices, drawn on the liquidity chart) and the
 *   tokens to deposit, the second worked out from the first at the pool's price
 * - A position's Add / Remove / Collect fees (modal)
 * Each action is a list of steps run in order (the token approvals to Permit2, the Permit2 signature, the transaction),
 * shown as it goes; a failure after an approval keeps the done steps for Retry.
 */

import * as Services from '../core/services.js';
import * as Utils from '../core/utils.js';
import * as UI from '../ui/ui.js';
import { getEthereumSigner, restorePolygon } from '../core/ethWallet.js';
import { getEthProvider, formatPrice, formatUsd, formatData, chainChip } from './swapMarket.js';
import { LIQUIDITY_POOLS, Liquidity, readPoolState, readWallet } from './liquidity.js';
import {
    PERMIT2, MIN_TICK, MAX_TICK, priceAtTick, tickAtPrice, rangeTicks, amountsForLiquidity, depositFor,
    mintTx, increaseTx, decreaseTx, collectTx, permitNeeded, signPermit
} from './liquidityTx.js';
import { ethers } from 'ethers';

const { logger } = Utils;
const $ = (id) => document.getElementById(id);

const SPACING = 60;
const SLOT_TTL_MS = 15 * 1000;
const ERC20_IFACE = new ethers.utils.Interface(['function approve(address spender, uint256 amount) returns (bool)']);
const DECIMALS = { data: 18, usdc: 6 };
const SYMBOLS = { data: 'DATA', usdc: 'USDC' };

/** Ranges around the price, as Uniswap's strategies (one-sided: a single token, from the next tick on its side) */
const STRATEGIES = [
    { key: 'stable', title: 'Stable', range: '± 1.82%', hint: 'Narrow, around the price' },
    { key: 'wide', title: 'Wide', range: '−50% — +100%', hint: 'For volatile pairs' },
    { key: 'lower', title: 'One-sided lower', range: '−50%', hint: 'USDC only, buys DATA if the price falls' },
    { key: 'upper', title: 'One-sided upper', range: '+100%', hint: 'DATA only, sells it if the price rises' }
];

const MANAGE_TITLES = { add: 'Add liquidity', remove: 'Remove liquidity', collect: 'Collect fees' };

const state = {
    ctx: null,              // { chain(), address(), icons, onDraft() } from the Market page
    slots: {},              // chain -> { sqrtP, tick, at }
    wallets: {},            // `${chain}:${address}` -> readWallet
    form: { open: false, chain: null, full: false, strategy: 'wide', lower: null, upper: null, last: 'data', amounts: { data: '', usdc: '' } },
    modal: { open: false, tokenId: null, chain: null, mode: 'add', pct: 50, last: 'data', amounts: { data: '', usdc: '' } },
    flows: { new: null, modal: null }
};

const slippage = () => {
    try {
        const saved = Number(localStorage.getItem('swapSlippage'));
        return [0.5, 1, 3].includes(saved) ? saved : 0.5;
    } catch (e) {
        return 0.5;
    }
};
const address = () => state.ctx?.address() || null;
const walletOf = (chain) => (address() ? state.wallets[`${chain}:${address()}`] || null : null);
const balanceOf = (wallet, token) => (wallet ? Number(wallet[token]) / 10 ** DECIMALS[token] : null);
const floorTick = (tick) => Math.floor(tick / SPACING) * SPACING;

/** A typed amount: a plain positive decimal, else 0 */
const parse = (text) => (/^\d*\.?\d*$/.test(text.trim()) && Number(text) > 0 ? Number(text) : 0);

/** An amount for an input: no exponent, no trailing zeros */
function inputValue(amount, decimals) {
    if (!(amount > 0)) return '';
    return amount.toFixed(Math.min(decimals, amount >= 1 ? 4 : 8)).replace(/\.?0+$/, '');
}

/** A balance cut (not rounded) to 2 decimals: never shown above what the wallet holds */
const formatBalance = (amount) => Utils.formatBigNumber((Math.floor(amount * 100) / 100).toFixed(2));
const formatPriceInput = (price) => (price >= 1 ? price.toFixed(4) : price.toPrecision(5)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

function formatTxError(error) {
    if (error?.code === 4001 || error?.code === 'ACTION_REJECTED') return 'Rejected in your wallet.';
    const text = `${error?.reason || ''} ${error?.error?.message || ''} ${error?.data?.message || ''} ${error?.error?.data || ''} ${error?.message || ''}`;
    if (text.toLowerCase().includes('insufficient funds')) return 'Not enough gas in your wallet.';
    if (/0x31e30ad0|0x12816f22/i.test(text)) return 'The price moved beyond your max slippage. Try again.';
    if (/TRANSFER_FROM_FAILED/i.test(text)) return 'Not enough tokens in your wallet, or the allowance is missing.';
    if (/0xbfb22adf/i.test(text)) return 'The transaction expired before it was mined. Try again.';
    if (Services.isRateLimitError(error)) return 'RPC rate limited. Please try again in a few seconds.';
    return Utils.getFriendlyErrorMessage(error);
}

// ============================================
// Data
// ============================================

/** The pool's price now (read again after 15 s) */
async function loadSlot(chain, force = false) {
    const cached = state.slots[chain];
    if (!force && cached && Date.now() - cached.at < SLOT_TTL_MS) return cached;
    const slot = { ...await readPoolState(LIQUIDITY_POOLS[chain]), at: Date.now() };
    state.slots[chain] = slot;
    return slot;
}

/** The wallet's DATA and USDC on a chain, with its allowances */
async function loadWallet(chain) {
    const owner = address();
    if (!owner) return null;
    const wallet = await readWallet(LIQUIDITY_POOLS[chain], owner);
    state.wallets[`${chain}:${owner}`] = wallet;
    return wallet;
}

/** The pool's price and the wallet's tokens on a chain, then the shown form and modal again */
function loadChain(chain, force = false) {
    Promise.allSettled([loadSlot(chain, force), loadWallet(chain)]).then(([slot, wallet]) => {
        if (slot.status === 'rejected') logger.warn('Liquidity: pool price not read', slot.reason);
        if (wallet.status === 'rejected') logger.warn('Liquidity: wallet not read', wallet.reason);
        render();
    });
}

// ============================================
// Steps (approvals, signature, transaction)
// ============================================

const flowSigner = (chain) => (chain === 137 ? window.appSigner : getEthereumSigner(address(), getEthProvider()));

/** Sends a transaction on a chain: on Polygon the app's signer with its fallbacks and gas overrides */
async function send(chain, txData) {
    if (chain === 137) {
        return Services.executeWithFallback(async (signer) => signer.sendTransaction({ ...txData, ...await Services.getGasOverrides(signer.provider) }), window.appSigner);
    }
    return (await flowSigner(chain)).sendTransaction(txData);
}

/** The approvals and signature a deposit of at most maxIn ([token0, token1]) still needs */
async function depositSteps(pool, maxIn) {
    const wallet = await loadWallet(pool.chain);
    const tokens = pool.dataIs0 ? ['data', 'usdc'] : ['usdc', 'data'];
    const steps = [];
    tokens.forEach((token, i) => {
        if (maxIn[i] > 0n && wallet.toPermit2[i] < maxIn[i]) {
            steps.push({ key: 'approve', token: pool[token], amount: maxIn[i], label: `Approve ${SYMBOLS[token]} for Permit2 (Uniswap)` });
        }
    });
    const batch = permitNeeded(pool, maxIn, wallet.permits);
    if (batch) steps.push({ key: 'permit', batch, noTx: true, label: 'Sign the Uniswap allowance (Permit2, no gas)' });
    return steps;
}

async function runStep(step, flow) {
    if (step.key === 'permit') {
        flow.permit = await signPermit(await flowSigner(flow.chain), flow.chain, address(), step.batch);
        return;
    }
    const txData = step.key === 'approve'
        ? { to: step.token, data: ERC20_IFACE.encodeFunctionData('approve', [PERMIT2, step.amount]) }
        : (({ to, data }) => ({ to, data }))(flow.build(flow.permit));   // the transaction only (maxIn is BigInt: not for JSON)
    const tx = await send(flow.chain, txData);
    step.txHash = tx.hash;
    if (step.key === 'send') flow.sent = true;
    renderSteps(flow.kind);
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error(step.key === 'approve' ? 'The approval failed on-chain.' : 'The transaction failed on-chain.');
}

const IDS = {
    new: { steps: 'liquidity-new-steps', error: 'liquidity-new-error', success: 'liquidity-new-success', submit: 'liquidity-new-submit' },
    modal: { steps: 'liquidity-modal-steps', error: 'liquidity-modal-error', success: 'liquidity-modal-success', submit: 'liquidity-modal-submit' }
};

function renderSteps(kind) {
    const flow = state.flows[kind];
    const list = $(IDS[kind].steps);
    if (!list) return;
    list.classList.toggle('hidden', !flow);
    if (!flow) return;
    const icons = {
        pending: '<span class="w-4 h-4 rounded-full border-2 border-[#555] flex-shrink-0"></span>',
        active: '<span class="w-4 h-4 border-2 border-blue-400 rounded-full border-t-transparent animate-spin flex-shrink-0"></span>',
        done: '<svg class="w-4 h-4 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg>',
        error: '<svg class="w-4 h-4 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"/></svg>'
    };
    const textClass = { pending: 'text-gray-300', active: 'text-white', done: 'text-gray-300', error: 'text-red-400' };
    const explorer = LIQUIDITY_POOLS[flow.chain].explorer;
    list.innerHTML = flow.steps.map(step => `
        <li class="flex items-center gap-2">
            ${icons[step.status]}
            <span class="${textClass[step.status]}">${Utils.escapeHtml(step.label)}</span>
            ${step.txHash ? `<a href="${explorer}/tx/${Utils.escapeHtml(step.txHash)}" target="_blank" rel="noopener noreferrer" class="ml-auto text-xs text-blue-400 hover:text-blue-300">tx</a>` : ''}
        </li>`).join('');
}

function showMessage(kind, which, text) {
    const el = $(IDS[kind][which]);
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
}

/** Runs a flow's steps from the first not done; the submit button follows them */
async function runFlow(kind) {
    const flow = state.flows[kind];
    if (!flow || flow.running) return;
    flow.running = true;
    showMessage(kind, 'error', '');
    const submit = $(IDS[kind].submit);
    try {
        if (flow.chain === 137 && sessionStorage.getItem('authMethod') !== 'privateKey' && !await Services.checkAndSwitchNetwork()) {
            throw new Error('Switch your wallet to Polygon to continue.');
        }
        if (flow.chain !== 137) await flowSigner(flow.chain);   // the wallet on Ethereum (asked once)
        for (const step of flow.steps) {
            if (step.status === 'done') continue;
            step.status = 'active';
            renderSteps(kind);
            if (submit) {
                submit.disabled = true;
                submit.textContent = step.noTx ? 'Sign in wallet...' : 'Confirm in wallet...';
            }
            await runStep(step, flow);
            step.status = 'done';
            renderSteps(kind);
        }
        flow.finished = true;
        showMessage(kind, 'success', flow.success);
        UI.showToast({ type: 'success', title: flow.title, message: flow.success, duration: 6000 });
        Liquidity.refresh(address());
        loadChain(flow.chain, true);
    } catch (e) {
        logger.error('Liquidity action failed:', e);
        const failed = flow.steps.find(s => s.status === 'active');
        if (failed) failed.status = 'error';
        renderSteps(kind);
        showMessage(kind, 'error', formatTxError(e));
        // Approved or signed but not sent: Retry continues from there; else the form is free again
        flow.retry = flow.steps.some(s => s.status === 'done') && !flow.sent;
        if (!flow.retry) state.flows[kind] = null;
    } finally {
        if (flow.chain !== 137) restorePolygon();
        flow.running = false;
        render();
    }
}

// ============================================
// New position
// ============================================

const formPool = () => LIQUIDITY_POOLS[state.form.chain];

/** The ticks of a strategy around the pool's tick */
function strategyTicks(pool, tick, key) {
    const price = priceAtTick(pool, tick);
    if (key === 'stable') return rangeTicks(pool, price / 1.0182, price * 1.0182);
    if (key === 'wide') return rangeTicks(pool, price * 0.5, price * 2);
    // One token only: the range starts at the next usable tick on its side of the price
    const far = tickAtPrice(pool, key === 'upper' ? price * 2 : price * 0.5);
    const token0Only = (key === 'upper') === pool.dataIs0;
    const base = floorTick(tick);
    return token0Only ? [base + SPACING, Math.max(far, base + 2 * SPACING)] : [Math.min(far, base - SPACING), base];
}

/** The form's range in ticks */
function formTicks() {
    const f = state.form;
    if (f.full) return [MIN_TICK, MAX_TICK];
    return f.lower === null ? null : [f.lower, f.upper];
}

/** The form's range as DATA prices: { min, max } (full: 0 to ∞) */
function formPrices() {
    const f = state.form;
    if (f.full) return { min: 0, max: Infinity };
    const ticks = formTicks();
    if (!ticks) return null;
    const [a, b] = ticks.map(t => priceAtTick(formPool(), t));
    return { min: Math.min(a, b), max: Math.max(a, b) };
}

function applyStrategy(key) {
    const slot = state.slots[state.form.chain];
    state.form.full = false;
    state.form.strategy = key;
    if (!slot) {
        state.form.lower = null;
        return;
    }
    [state.form.lower, state.form.upper] = strategyTicks(formPool(), slot.tick, key);
}

/** The tick behind the min or max price, and the tick step that raises that price */
const sideOf = (pool, end) => ({ key: (end === 'min') === pool.dataIs0 ? 'lower' : 'upper', up: pool.dataIs0 ? SPACING : -SPACING });

/** A price typed or nudged: its side of the range moves, the other stays (at least one step apart) */
function setEdge(end, tick) {
    const f = state.form;
    const { key } = sideOf(formPool(), end);
    f[key] = Math.min(MAX_TICK, Math.max(MIN_TICK, tick));
    if (f.lower >= f.upper) {
        if (key === 'lower') f.upper = f.lower + SPACING;
        else f.lower = f.upper - SPACING;
    }
    f.strategy = null;
}

/** The deposit at the pool's price: { data, usdc, L, holds: { data, usdc } } (holds: the range takes that token now) */
function quoteDeposit(pool, slot, [lower, upper], target) {
    const one = amountsForLiquidity(pool, 1, slot.sqrtP, lower, upper);
    const holds = { data: one.data > 0, usdc: one.usdc > 0 };
    const other = target.last === 'data' ? 'usdc' : 'data';
    const token = holds[target.last] ? target.last : other;
    const amount = parse(target.amounts[token]);
    if (!holds[token] || !amount) return { data: 0, usdc: 0, L: 0, holds, token };
    return { ...depositFor(pool, slot.sqrtP, lower, upper, token, amount), holds, token };
}

/** The deposit inputs: the typed one kept, the other worked out; a token the range doesn't take now disabled */
function renderDeposit(prefix, pool, quote, wallet, focused) {
    for (const token of ['data', 'usdc']) {
        const input = $(`${prefix}-${token}`);
        if (!input) continue;
        input.disabled = !quote.holds[token];
        if (!quote.holds[token]) input.value = '';
        else if (token !== quote.token && document.activeElement !== input && focused !== token) input.value = inputValue(quote[token], DECIMALS[token]);
        const amount = balanceOf(wallet, token);
        const balance = $(`${prefix}-${token}-balance`);
        if (balance) balance.textContent = amount === null ? '--' : formatBalance(amount);
        const max = $(`${prefix}-${token}-max`);
        if (max) max.disabled = amount === null || !(amount > 0) || !quote.holds[token];
    }
}

/** The submit label of a deposit, and whether it can go */
function depositLabel(quote, wallet, action) {
    if (!address()) return ['Connect a wallet', false];
    if (!(quote.L > 0)) return ['Enter an amount', false];
    for (const token of ['data', 'usdc']) {
        // A hair of margin: MAX's amount comes back from L a rounding error over (the transaction takes a hair less)
        if (wallet && quote[token] > balanceOf(wallet, token) * (1 + 1e-9)) return [`Insufficient ${SYMBOLS[token]}`, false];
    }
    return [action, true];
}

/**
 * The form is taller than the pool's numbers: while it is open the positions move up beside it, under the chart, and
 * narrow down, when the whole table fits there (else they stay below, full width)
 */
function placePositions() {
    const positions = $('market-positions-section');
    const card = $('liquidity-new')?.closest('section');
    const table = positions?.querySelector('table');
    const scroller = table?.parentElement;
    if (!positions || !card || !table) return;
    const place = (beside) => {
        card.classList.toggle('xl:row-span-2', beside);
        positions.classList.toggle('xl:col-span-1', beside);
        positions.classList.toggle('xl:col-start-1', beside);
        table.classList.toggle('min-w-[860px]', !beside);
    };
    const beside = state.form.open && window.matchMedia('(min-width: 1280px)').matches;
    place(beside);
    if (beside && scroller.scrollWidth > scroller.clientWidth + 1) place(false);
}

function renderForm(focused = null) {
    const f = state.form;
    $('liquidity-overview')?.classList.toggle('hidden', f.open);
    $('liquidity-new')?.classList.toggle('hidden', !f.open);
    placePositions();
    if (!f.open) return;
    const pool = formPool();
    const slot = state.slots[f.chain];
    if (slot && !f.full && f.lower === null) applyStrategy(f.strategy || 'wide');
    const locked = Boolean(state.flows.new);

    document.querySelectorAll('#liquidity-new-mode [data-range-mode]').forEach(btn => {
        const active = (btn.dataset.rangeMode === 'full') === f.full;
        btn.classList.toggle('bg-blue-800', active);
        btn.classList.toggle('text-white', active);
        btn.disabled = locked;
    });
    const strategies = $('liquidity-new-strategies');
    if (strategies) {
        strategies.classList.toggle('hidden', f.full);
        strategies.innerHTML = STRATEGIES.map(s => `
            <button type="button" data-strategy="${s.key}" ${locked ? 'disabled' : ''} class="text-left p-2.5 rounded-lg border transition-colors ${s.key === f.strategy ? 'border-blue-500 bg-blue-500/10' : 'border-[#333] bg-[#121212] hover:border-[#555]'}">
                <div class="text-xs font-semibold text-white">${s.title}</div>
                <div class="text-sm font-semibold text-white">${s.range}</div>
                <div class="mt-0.5 text-[11px] leading-tight text-gray-400">${s.hint}</div>
            </button>`).join('');
    }
    const prices = formPrices();
    const current = slot ? priceAtTick(pool, slot.tick) : null;
    for (const end of ['min', 'max']) {
        const input = $(`liquidity-new-${end}`);
        const value = prices ? prices[end] : null;
        if (input && document.activeElement !== input) input.value = value === null ? '' : value === Infinity ? '∞' : value === 0 ? '0' : formatPriceInput(value);
        if (input) input.disabled = f.full || locked || !slot;
        const pct = $(`liquidity-new-${end}-pct`);
        if (pct) pct.textContent = f.full || !current || value === null ? '' : `${value >= current ? '+' : ''}${((value / current - 1) * 100).toFixed(2)}%`;
    }
    document.querySelectorAll('#liquidity-new [data-nudge]').forEach(btn => { btn.disabled = f.full || locked || !slot; });

    const ticks = formTicks();
    const wallet = walletOf(f.chain);
    const quote = slot && ticks ? quoteDeposit(pool, slot, ticks, f) : { data: 0, usdc: 0, L: 0, holds: { data: true, usdc: true }, token: f.last };
    renderDeposit('liquidity-new', pool, quote, wallet, focused);
    if (locked) ['data', 'usdc'].forEach(token => ['', '-max'].forEach(suffix => { const el = $(`liquidity-new-${token}${suffix}`); if (el) el.disabled = true; }));
    const note = $('liquidity-new-note');
    if (note) {
        const one = quote.holds.data !== quote.holds.usdc ? (quote.holds.data ? 'DATA' : 'USDC') : null;
        note.textContent = one ? `At the current price this range takes ${one} only.` : '';
        note.classList.toggle('hidden', !one);
    }
    renderSteps('new');
    const submit = $('liquidity-new-submit');
    if (submit && !state.flows.new?.running) {
        const flow = state.flows.new;
        const [label, ok] = flow?.finished ? ['New position', true] : flow?.retry ? ['Retry', true] : !slot ? ['Reading the pool...', false] : depositLabel(quote, wallet, 'Create position');
        submit.textContent = label;
        submit.disabled = !ok;
    }
    state.form.quote = quote;
}

async function submitNew() {
    const f = state.form;
    const flow = state.flows.new;
    if (flow?.finished) {
        state.flows.new = null;
        f.amounts = { data: '', usdc: '' };
        ['data', 'usdc'].forEach(token => { const input = $(`liquidity-new-${token}`); if (input) input.value = ''; });
        showMessage('new', 'success', '');
        render();
        return;
    }
    if (flow?.retry) return runFlow('new');
    const pool = formPool();
    const [lower, upper] = formTicks();
    const quote = f.quote;
    if (!(quote?.L > 0)) return;
    const owner = address();
    const options = { lower, upper, L: quote.L, amounts: quote, slippage: slippage(), owner };
    const submit = $('liquidity-new-submit');
    if (submit) submit.disabled = true;
    try {
        const steps = await depositSteps(pool, mintTx(pool, options).maxIn);
        const deposit = ['data', 'usdc'].filter(t => quote[t] > 0).map(t => `${inputValue(quote[t], 4)} ${SYMBOLS[t]}`).join(' and ');
        state.flows.new = {
            kind: 'new', chain: pool.chain, permit: null, sent: false,
            title: 'Position created', success: `Position created with ${deposit}.`,
            build: (permit) => mintTx(pool, { ...options, permit }),
            steps: [...steps, { key: 'send', label: `Create the position with ${deposit}` }].map(s => ({ ...s, status: 'pending', txHash: null }))
        };
    } catch (e) {
        logger.warn('Liquidity: deposit not prepared', e);
        showMessage('new', 'error', formatTxError(e));
        render();
        return;
    }
    runFlow('new');
}

// ============================================
// A position's Add / Remove / Collect
// ============================================

const modalPosition = () => (Liquidity.positions() || []).find(p => p.tokenId === state.modal.tokenId && p.chain === state.modal.chain) || null;

function renderModal(focused = null) {
    const m = state.modal;
    const modal = $('liquidityModal');
    if (!modal) return;
    modal.classList.toggle('hidden', !m.open);
    if (!m.open) return;
    const p = modalPosition();
    const pool = LIQUIDITY_POOLS[m.chain];
    const slot = state.slots[m.chain];
    const wallet = walletOf(m.chain);
    const flow = state.flows.modal;
    const locked = Boolean(flow);
    if (p?.closed && m.mode === 'remove') m.mode = 'add';

    $('liquidity-modal-title').textContent = `${MANAGE_TITLES[m.mode]} #${m.tokenId}`;
    const tags = $('liquidity-modal-tags');
    if (tags && p) {
        const [label, text] = p.closed ? ['Closed', 'text-gray-400'] : p.inRange ? ['In range', 'text-green-400'] : ['Out of range', 'text-amber-300'];
        tags.innerHTML = `${chainChip(p.chain, { named: true })}<span class="font-medium ${text}">${label}</span><span class="text-gray-300">${formatPrice(p.min)} – ${formatPrice(p.max)}</span>`;
    }
    document.querySelectorAll('#liquidity-modal-tabs [data-manage]').forEach(btn => {
        const active = btn.dataset.manage === m.mode;
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('border-blue-500', active);
        btn.classList.toggle('text-gray-400', !active);
        btn.classList.toggle('border-transparent', !active);
        btn.disabled = locked || (btn.dataset.manage === 'remove' && Boolean(p?.closed));
    });
    $('liquidity-add')?.classList.toggle('hidden', m.mode !== 'add');
    $('liquidity-remove')?.classList.toggle('hidden', m.mode !== 'remove');

    const row = (label, value) => `<div class="flex justify-between gap-3"><dt class="text-gray-300">${label}</dt><dd class="text-white font-medium text-right">${value}</dd></div>`;
    const summary = $('liquidity-modal-summary');
    let label = 'Enter an amount';
    let ok = false;
    if (!p) {
        if (summary) summary.innerHTML = row('Position', 'Not found');
    } else if (m.mode === 'add') {
        const quote = slot ? quoteDeposit(pool, slot, [p.lower, p.upper], m) : { data: 0, usdc: 0, L: 0, holds: { data: true, usdc: true }, token: m.last };
        renderDeposit('liquidity-add', pool, quote, wallet, focused);
        if (locked) ['data', 'usdc'].forEach(token => ['', '-max'].forEach(suffix => { const el = $(`liquidity-add-${token}${suffix}`); if (el) el.disabled = true; }));
        m.quote = quote;
        if (summary) summary.innerHTML = [row('Position DATA', formatData(p.data)), row('Position USDC', Utils.formatBigNumber(p.usdc.toFixed(2)))].join('');
        [label, ok] = !slot ? ['Reading the pool...', false] : depositLabel(quote, wallet, 'Add liquidity');
    } else if (m.mode === 'remove') {
        $('liquidity-remove-pct').textContent = `${m.pct}%`;
        const range = $('liquidity-remove-range');
        if (range && document.activeElement !== range) range.value = String(m.pct);
        if (range) range.disabled = locked;
        document.querySelectorAll('#liquidity-remove-presets button').forEach(btn => { btn.disabled = locked; });
        const share = m.pct / 100;
        if (summary) {
            summary.innerHTML = [
                row('DATA', formatData(p.data * share + p.feeData)),
                row('USDC', Utils.formatBigNumber((p.usdc * share + p.feeUsdc).toFixed(2))),
                row('Value', formatUsd(p.value * share + p.feeValue)),
                '<p class="text-xs text-gray-400">With the uncollected fees.</p>'
            ].join('');
        }
        [label, ok] = [`Remove ${m.pct}%`, true];
    } else {
        if (summary) summary.innerHTML = [row('DATA', formatData(p.feeData)), row('USDC', Utils.formatBigNumber(p.feeUsdc.toFixed(6).replace(/\.?0+$/, '') || '0')), row('Value', formatUsd(p.feeValue))].join('');
        [label, ok] = p.feeData > 0 || p.feeUsdc > 0 ? ['Collect fees', true] : ['No fees to collect', false];
    }
    if (!address()) [label, ok] = ['Connect a wallet', false];
    renderSteps('modal');
    const submit = $('liquidity-modal-submit');
    if (submit && !flow?.running) {
        [label, ok] = flow?.finished ? ['Done', true] : flow?.retry ? ['Retry', true] : [label, ok];
        submit.textContent = label;
        submit.disabled = !ok;
    }
}

async function submitModal() {
    const m = state.modal;
    const flow = state.flows.modal;
    if (flow?.finished) return closeManage();
    if (flow?.retry) return runFlow('modal');
    const p = modalPosition();
    if (!p) return;
    const pool = LIQUIDITY_POOLS[m.chain];
    const owner = address();
    const submit = $('liquidity-modal-submit');
    if (submit) submit.disabled = true;
    const base = { kind: 'modal', chain: pool.chain, permit: null, sent: false };
    try {
        if (m.mode === 'add') {
            const quote = m.quote;
            if (!(quote?.L > 0)) return;
            const options = { tokenId: p.tokenId, L: quote.L, amounts: quote, slippage: slippage() };
            const steps = await depositSteps(pool, increaseTx(pool, options).maxIn);
            const deposit = ['data', 'usdc'].filter(t => quote[t] > 0).map(t => `${inputValue(quote[t], 4)} ${SYMBOLS[t]}`).join(' and ');
            state.flows.modal = {
                ...base, title: 'Liquidity added', success: `Added ${deposit} to #${p.tokenId}.`,
                build: (permit) => increaseTx(pool, { ...options, permit }),
                steps: [...steps, { key: 'send', label: `Add ${deposit}` }]
            };
        } else if (m.mode === 'remove') {
            const liquidity = m.pct === 100 ? p.liquidity : p.liquidity * BigInt(m.pct) / 100n;
            const slot = await loadSlot(pool.chain, true);
            const amounts = amountsForLiquidity(pool, Number(liquidity), slot.sqrtP, p.lower, p.upper);
            state.flows.modal = {
                ...base, title: 'Liquidity removed', success: `Removed ${m.pct}% of #${p.tokenId}, with its fees.`,
                build: () => decreaseTx(pool, { tokenId: p.tokenId, liquidity, amounts, slippage: slippage(), owner }),
                steps: [{ key: 'send', label: `Remove ${m.pct}% and collect the fees` }]
            };
        } else {
            state.flows.modal = {
                ...base, title: 'Fees collected', success: `Collected the fees of #${p.tokenId}.`,
                build: () => collectTx(pool, { tokenId: p.tokenId, owner }),
                steps: [{ key: 'send', label: 'Collect the fees' }]
            };
        }
        state.flows.modal.steps = state.flows.modal.steps.map(s => ({ ...s, status: 'pending', txHash: null }));
    } catch (e) {
        logger.warn('Liquidity: action not prepared', e);
        showMessage('modal', 'error', formatTxError(e));
        render();
        return;
    }
    runFlow('modal');
}

function closeManage() {
    if (state.flows.modal?.running) return;
    state.modal.open = false;
    state.flows.modal = null;
    showMessage('modal', 'error', '');
    showMessage('modal', 'success', '');
    document.body.classList.remove('overflow-hidden');
    render();
}

// ============================================
// Listeners
// ============================================

function render(focused = null) {
    renderForm(focused);
    renderModal(focused);
    state.ctx?.onDraft();
}

function setupListeners() {
    $('liquidity-new-open')?.addEventListener('click', () => LiquidityManage.openNew());
    $('liquidity-new-close')?.addEventListener('click', () => {
        if (state.flows.new?.running) return;
        state.form.open = false;
        state.flows.new = null;
        showMessage('new', 'error', '');
        showMessage('new', 'success', '');
        render();
    });
    $('liquidity-new-mode')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-range-mode]');
        if (!btn || state.flows.new) return;
        if (btn.dataset.rangeMode === 'full') state.form.full = true;
        else applyStrategy(state.form.strategy || 'wide');
        render();
    });
    $('liquidity-new-strategies')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-strategy]');
        if (!btn || state.flows.new) return;
        applyStrategy(btn.dataset.strategy);
        render();
    });
    $('liquidity-new')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-nudge]');
        if (!btn || state.flows.new || state.form.full || state.form.lower === null) return;
        const [end, dir] = btn.dataset.nudge.split(':');
        const { key, up } = sideOf(formPool(), end);
        setEdge(end, state.form[key] + Number(dir) * up);
        render();
    });
    for (const end of ['min', 'max']) {
        $(`liquidity-new-${end}`)?.addEventListener('change', (e) => {
            const price = parse(e.target.value);
            if (price > 0 && !state.form.full && state.form.lower !== null) setEdge(end, tickAtPrice(formPool(), price));
            e.target.blur();
            render();
        });
    }
    for (const [prefix, target] of [['liquidity-new', () => state.form], ['liquidity-add', () => state.modal]]) {
        for (const token of ['data', 'usdc']) {
            $(`${prefix}-${token}`)?.addEventListener('input', (e) => {
                const t = target();
                t.last = token;
                t.amounts[token] = e.target.value;
                render(token);
            });
            $(`${prefix}-${token}-max`)?.addEventListener('click', () => {
                const t = target();
                const chain = prefix === 'liquidity-new' ? state.form.chain : state.modal.chain;
                const wallet = walletOf(chain);
                if (!wallet) return;
                // The exact balance, all its decimals (rounded, it could be over the balance)
                t.last = token;
                t.amounts[token] = ethers.utils.formatUnits(wallet[token].toString(), DECIMALS[token]).replace(/\.0$/, '');
                const input = $(`${prefix}-${token}`);
                if (input) input.value = t.amounts[token];
                render(token);
            });
        }
    }
    $('liquidity-new-submit')?.addEventListener('click', submitNew);
    // The page's width (the window, the sidebar collapsed or not): the positions placed again
    const view = $('market-liquidity-view');
    let width = 0;
    if (view && window.ResizeObserver) {
        new ResizeObserver(() => {
            if (view.offsetWidth === width) return;
            width = view.offsetWidth;
            placePositions();
        }).observe(view);
    }

    $('liquidity-modal-close')?.addEventListener('click', closeManage);
    $('liquidityModal')?.addEventListener('click', (e) => { if (e.target.id === 'liquidityModal') closeManage(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.modal.open) closeManage(); });
    $('liquidity-modal-tabs')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-manage]');
        if (!btn || btn.disabled) return;
        state.modal.mode = btn.dataset.manage;
        showMessage('modal', 'error', '');
        render();
    });
    $('liquidity-remove-presets')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-remove-pct]');
        if (!btn || state.flows.modal) return;
        state.modal.pct = Number(btn.dataset.removePct);
        render();
    });
    $('liquidity-remove-range')?.addEventListener('input', (e) => {
        if (state.flows.modal) return;
        state.modal.pct = Number(e.target.value);
        render();
    });
    $('liquidity-modal-submit')?.addEventListener('click', submitModal);
    // A refresh (a new wallet too): the open form's or modal's chain read again for that wallet
    Liquidity.onChange(() => {
        const chain = state.modal.open ? state.modal.chain : state.form.open ? state.form.chain : null;
        if (chain && address() && !walletOf(chain) && !Liquidity.loading()) loadChain(chain);
        render();
    });
}

export const LiquidityManage = {
    /** ctx: { chain(), address(), icons: { DATA, USDC }, onDraft() } from the Market page */
    init(ctx) {
        if (state.ctx) return;
        state.ctx = ctx;
        document.querySelectorAll('[data-token-chip]').forEach(chip => {
            const symbol = chip.dataset.tokenChip;
            chip.innerHTML = `${ctx.icons[symbol].replace('w-7 h-7', 'w-5 h-5')}${symbol}`;
        });
        setupListeners();
    },
    openNew() {
        const chain = state.ctx.chain();
        Object.assign(state.form, { open: true, chain, full: false, strategy: 'wide', lower: null, upper: null });
        render();
        loadChain(chain);
    },
    openManage(tokenId, chain, mode = 'add') {
        Object.assign(state.modal, { open: true, tokenId, chain, mode, pct: 50, last: 'data', amounts: { data: '', usdc: '' } });
        state.flows.modal = null;
        ['data', 'usdc'].forEach(token => { const input = $(`liquidity-add-${token}`); if (input) input.value = ''; });
        showMessage('modal', 'error', '');
        showMessage('modal', 'success', '');
        document.body.classList.add('overflow-hidden');
        render();
        loadChain(chain);
    },
    /** The Market page's chain changed: the form follows it (not while a flow runs) */
    chainChanged() {
        const chain = state.ctx.chain();
        if (!state.form.open || state.form.chain === chain || state.flows.new) return;
        Object.assign(state.form, { chain, lower: null, upper: null });
        render();
        loadChain(chain);
    },
    /** The new position's range on a chain's chart: { min, max } prices, or null */
    draft(chain) {
        if (!state.form.open || state.form.chain !== chain) return null;
        return formPrices();
    },
    busy: () => Boolean(state.flows.new?.running || state.flows.modal?.running)
};
