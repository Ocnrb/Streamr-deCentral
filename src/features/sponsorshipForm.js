/**
 * Sponsorships: create and fund (same modal, two modes)
 * - create ("New Sponsorship" on Stream Details): DATA.transferAndCall(SponsorshipFactory, amount, params)
 *   deploys a Sponsorship for the stream with the standard policies (as the Streamr Hub does):
 *   stake-weighted allocation (payout rate), default leave (min stake duration), vote kick and,
 *   optionally, max operators.
 * - fund ("Add Funds" on Sponsorship Details): DATA.transferAndCall(sponsorship, amount, "0x").
 * One transaction each (ERC-677, no approve), then a wait for the subgraph to index it.
 * Anyone with a wallet can do both; sponsoring can't be undone.
 */

import * as Utils from '../core/utils.js';
import * as UI from '../ui/ui.js';
import * as Services from '../core/services.js';
import {
    DATA_TOKEN_ADDRESS_POLYGON,
    DATA_TOKEN_ERC677_ABI,
    SPONSORSHIP_FACTORY_ADDRESS,
    SPONSORSHIP_POLICIES
} from '../core/constants.js';
import { ethers } from 'ethers';

const { logger } = Utils;

// ============================================
// Constants
// ============================================

const DAY_SECONDS = 86400;
const INDEX_WAIT_TIMEOUT_MS = 90 * 1000;
const INDEX_WAIT_INTERVAL_MS = 3000;
const AMOUNT_REGEX = /^\d+(\.\d{1,18})?$/;

// ============================================
// State
// ============================================

const state = {
    mode: 'create',         // 'create' | 'fund'
    owner: null,
    streamId: null,
    sponsorship: null,      // fund mode: sponsorship from the subgraph
    onDone: null,
    dataBalanceWei: null,
    polBalanceWei: null,
    maxPenaltyPeriodSeconds: null,
    flow: null,
    submitting: false,
    estimateSeq: 0,
    estimatedCostWei: null,
    listenersSetup: false
};

const $ = (id) => document.getElementById(id);
const debouncedEstimate = Utils.debounce(() => updateEstimate(), 500);

// ============================================
// Helpers
// ============================================

function getToken(signerOrProvider = Services.getReadOnlyProvider()) {
    return new ethers.Contract(DATA_TOKEN_ADDRESS_POLYGON, DATA_TOKEN_ERC677_ABI, signerOrProvider);
}

function parseData(value) {
    return AMOUNT_REGEX.test(value) ? ethers.utils.parseEther(value) : null;
}

function formatData(wei, decimals = 2) {
    const value = parseFloat(ethers.utils.formatEther(wei));
    return Utils.formatBigNumber(Number(value.toFixed(decimals)));
}

function formatPol(wei) {
    const value = parseFloat(ethers.utils.formatEther(wei));
    if (value === 0) return '0 POL';
    if (value < 0.0001) return '< 0.0001 POL';
    return `${value.toFixed(4)} POL`;
}

function formatDays(seconds) {
    const days = seconds / DAY_SECONDS;
    if (days < 1) return `${Math.max(1, Math.round(seconds / 3600))} hours`;
    if (days < 100) return `${days.toFixed(1).replace(/\.0$/, '')} days`;
    return `${Math.round(days)} days`;
}

function formatDate(tsSeconds) {
    return new Date(tsSeconds * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatTxError(error) {
    if (error?.code === 4001 || error?.code === 'ACTION_REJECTED') return 'Transaction rejected in your wallet.';
    const text = `${error?.reason || ''} ${error?.error?.message || ''} ${error?.data?.message || ''} ${error?.message || ''}`;
    if (text.toLowerCase().includes('insufficient funds')) return 'Insufficient POL to pay for gas.';
    if (/transfer amount exceeds balance|exceeds balance/i.test(text)) return 'Insufficient DATA balance.';
    if (Services.isRateLimitError(error)) return 'RPC rate limited. Please try again in a few seconds.';
    return Utils.getFriendlyErrorMessage(error);
}

function setStatus(elementId, text, tone) {
    const el = $(elementId);
    if (!el) return;
    const tones = { ok: 'text-green-400', warn: 'text-yellow-400', error: 'text-red-400', info: 'text-gray-500' };
    el.classList.remove('hidden', ...Object.values(tones));
    if (!text) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
    }
    el.classList.add(tones[tone] || tones.info);
    el.textContent = text;
}

function streamUrl(streamId, sponsorshipId) {
    const encoded = streamId.split('/').map(part => encodeURIComponent(part)).join('/');
    return sponsorshipId ? `/stream/${encoded}?sponsored=true&sponsorshipId=${sponsorshipId}` : `/stream/${encoded}`;
}

async function loadNetworkLimits() {
    if (state.maxPenaltyPeriodSeconds !== null) return;
    try {
        const data = await Services.runQuery('{ network(id: "network-entity-id") { maxPenaltyPeriodSeconds } }');
        state.maxPenaltyPeriodSeconds = Number(data?.network?.maxPenaltyPeriodSeconds) || 0;
    } catch (e) {
        logger.warn('Could not load network limits:', e);
    }
}

// ============================================
// Form
// ============================================

function readForm() {
    const maxOps = ($('sponsorship-form-max-ops')?.value || '').trim();
    return {
        amount: ($('sponsorship-form-amount')?.value || '').trim(),
        rate: ($('sponsorship-form-rate')?.value || '').trim(),
        minStakeDays: ($('sponsorship-form-min-stake')?.value || '').trim(),
        minOperators: ($('sponsorship-form-min-ops')?.value || '').trim(),
        maxOperators: maxOps
    };
}

/**
 * Parsed values and errors for the current form
 */
function evaluateForm(form) {
    const errors = [];
    const amountWei = form.amount === '' ? null : parseData(form.amount);
    if (form.amount === '') {
        if (state.mode === 'fund') errors.push('Enter an amount.');
    } else if (!amountWei) {
        errors.push('Amount must be a number with at most 18 decimals.');
    }
    if (state.mode === 'fund' && amountWei && amountWei.isZero()) errors.push('Amount must be greater than 0.');
    if (amountWei && state.dataBalanceWei && amountWei.gt(state.dataBalanceWei)) errors.push('Amount is higher than your DATA balance.');

    if (state.mode === 'fund') return { errors, amountWei: amountWei || ethers.constants.Zero };

    const rateWei = form.rate === '' ? null : parseData(form.rate);
    const payoutPerSecond = rateWei ? rateWei.div(DAY_SECONDS) : null;
    if (!rateWei) errors.push('Enter the payout rate (DATA per day).');
    else if (payoutPerSecond.isZero()) errors.push('Payout rate is too low.');

    const minStakeDays = Number(form.minStakeDays);
    if (form.minStakeDays === '' || !Number.isInteger(minStakeDays) || minStakeDays < 0) {
        errors.push('Min stake duration must be a whole number of days (0 or more).');
    } else if (state.maxPenaltyPeriodSeconds && minStakeDays * DAY_SECONDS > state.maxPenaltyPeriodSeconds) {
        errors.push(`Min stake duration can be at most ${Math.floor(state.maxPenaltyPeriodSeconds / DAY_SECONDS)} days.`);
    }

    const minOperators = Number(form.minOperators);
    if (!Number.isInteger(minOperators) || minOperators < 1) errors.push('Min operators must be a whole number of at least 1.');
    let maxOperators = null;
    if (form.maxOperators !== '') {
        maxOperators = Number(form.maxOperators);
        if (!Number.isInteger(maxOperators) || maxOperators < 1) errors.push('Max operators must be a whole number of at least 1.');
        else if (Number.isInteger(minOperators) && maxOperators < minOperators) errors.push('Max operators must be at least the min operators.');
    }

    // Same rule as the Hub: the initial funding must last at least the min stake duration
    const amount = amountWei || ethers.constants.Zero;
    if (payoutPerSecond && !payoutPerSecond.isZero() && amount.gt(0) && Number.isInteger(minStakeDays)
        && amount.div(payoutPerSecond).lt(minStakeDays * DAY_SECONDS)) {
        errors.push('The initial funding must last at least the min stake duration.');
    }

    return { errors, amountWei: amount, rateWei, payoutPerSecond, minStakeDays, minOperators, maxOperators };
}

/**
 * Factory call data: (uint32 minOperatorCount, string streamId, string metadata, address[] policies, uint[] params)
 */
function encodeCreateParams(values) {
    const policies = [
        [SPONSORSHIP_POLICIES.stakeWeightedAllocation, values.payoutPerSecond.toString()],
        [SPONSORSHIP_POLICIES.defaultLeave, String(values.minStakeDays * DAY_SECONDS)],
        [SPONSORSHIP_POLICIES.voteKick, '0']
    ];
    if (values.maxOperators) policies.push([SPONSORSHIP_POLICIES.maxOperatorsJoin, String(values.maxOperators)]);
    return ethers.utils.defaultAbiCoder.encode(
        ['uint32', 'string', 'string', 'address[]', 'uint[]'],
        [values.minOperators, state.streamId, '{}', policies.map(p => p[0]), policies.map(p => p[1])]
    );
}

function txArgs(values) {
    return state.mode === 'create'
        ? [SPONSORSHIP_FACTORY_ADDRESS, values.amountWei, encodeCreateParams(values)]
        : [state.sponsorship.id, values.amountWei, '0x'];
}

// ============================================
// Rendering
// ============================================

function renderEffect(values) {
    const el = $('sponsorship-form-effect');
    if (!el) return;
    let text = '';
    const now = Math.floor(Date.now() / 1000);
    if (state.mode === 'create') {
        if (values.payoutPerSecond && !values.payoutPerSecond.isZero() && values.amountWei.gt(0)) {
            const seconds = values.amountWei.div(values.payoutPerSecond).toNumber();
            text = `Funds about ${formatDays(seconds)} of payouts (until ~${formatDate(now + seconds)} if operators join now).`;
        } else if (values.payoutPerSecond && values.amountWei.isZero()) {
            text = 'Without initial funding the sponsorship pays nothing until someone adds funds.';
        }
    } else if (values.amountWei.gt(0)) {
        const payout = ethers.BigNumber.from(state.sponsorship.totalPayoutWeiPerSec || '0');
        if (payout.gt(0)) {
            const seconds = values.amountWei.div(payout).toNumber();
            const insolvency = parseInt(state.sponsorship.projectedInsolvency || 0);
            const base = Math.max(now, insolvency || now);
            text = `Adds about ${formatDays(seconds)} of payouts: expected end ~${formatDate(base + seconds)}.`;
            if (!state.sponsorship.isRunning) text += ' Payouts only run while enough operators are staked.';
        } else {
            text = 'This sponsorship has no payout rate: the funds are kept until it pays out.';
        }
    }
    el.textContent = text;
    el.classList.toggle('hidden', !text);
}

function renderProgress() {
    const container = $('sponsorship-form-progress');
    const list = $('sponsorship-form-progress-list');
    if (!container || !list || !state.flow) return;
    const wasHidden = container.classList.contains('hidden');
    container.classList.remove('hidden');
    if (wasHidden) container.scrollIntoView({ block: 'nearest' });
    const icons = {
        pending: '<span class="w-4 h-4 rounded-full border-2 border-[#555] flex-shrink-0"></span>',
        active: '<span class="w-4 h-4 border-2 border-blue-400 rounded-full border-t-transparent animate-spin flex-shrink-0"></span>',
        done: '<svg class="w-4 h-4 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg>',
        error: '<svg class="w-4 h-4 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"/></svg>'
    };
    const textClass = { pending: 'text-gray-500', active: 'text-white', done: 'text-gray-300', error: 'text-red-400' };
    list.innerHTML = state.flow.steps.map(step => `
        <li class="flex items-center gap-2">
            ${icons[step.status]}
            <span class="${textClass[step.status]}">${Utils.escapeHtml(step.label)}</span>
            ${step.txHash ? `<a href="https://polygonscan.com/tx/${Utils.escapeHtml(step.txHash)}" target="_blank" rel="noopener noreferrer" class="ml-auto text-xs text-blue-400 hover:text-blue-300">tx</a>` : ''}
        </li>
    `).join('');
}

function showError(message) {
    const el = $('sponsorship-form-error');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
    if (message) el.scrollIntoView({ block: 'nearest' });
}

function submitLabel() {
    return state.mode === 'create' ? 'Create Sponsorship' : 'Add Funds';
}

function setSubmitState(label, busy) {
    const btn = $('sponsorship-form-submit');
    if (!btn) return;
    btn.disabled = busy;
    btn.innerHTML = busy
        ? `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent animate-spin"></div><span>${Utils.escapeHtml(label)}</span>`
        : Utils.escapeHtml(label);
}

function setFormLocked(locked) {
    $('sponsorship-form-body')?.querySelectorAll('input, button').forEach(el => { el.disabled = locked; });
}

function updateBalanceWarning() {
    const el = $('sponsorship-form-balance');
    if (!el) return;
    const insufficient = state.polBalanceWei && state.estimatedCostWei && state.polBalanceWei.lt(state.estimatedCostWei);
    el.classList.toggle('text-red-400', Boolean(insufficient));
    el.classList.toggle('text-gray-400', !insufficient);
}

// ============================================
// Estimate
// ============================================

async function getExpectedGasPrice() {
    const provider = Services.getReadOnlyProvider();
    const [feeData, overrides] = await Promise.all([
        Services.readWithFallback(() => provider.getFeeData()),
        Services.getGasOverrides(provider)
    ]);
    let gasPrice = overrides.maxFeePerGas;
    if (feeData.lastBaseFeePerGas) {
        const expected = feeData.lastBaseFeePerGas.add(overrides.maxPriorityFeePerGas);
        if (expected.lt(gasPrice)) gasPrice = expected;
    }
    return gasPrice;
}

async function updateEstimate() {
    const seq = ++state.estimateSeq;
    const costEl = $('sponsorship-form-cost');
    const noteEl = $('sponsorship-form-cost-note');
    if (!costEl) return;

    const values = evaluateForm(readForm());
    renderEffect(values);
    if (!state.flow) {
        const btn = $('sponsorship-form-submit');
        if (btn && !state.submitting) btn.disabled = values.errors.length > 0;
    }
    // Amount problems are shown under the field as soon as something is typed
    const amountError = readForm().amount !== '' ? values.errors.find(e => /amount|balance/i.test(e)) : null;
    setStatus('sponsorship-form-amount-status', amountError || '', 'error');

    if (values.errors.length > 0) {
        costEl.textContent = '--';
        state.estimatedCostWei = null;
        noteEl.textContent = values.errors[0];
        updateBalanceWarning();
        return;
    }

    costEl.textContent = 'Estimating...';
    noteEl.textContent = '';
    try {
        const [gas, gasPrice] = await Promise.all([
            Services.readWithFallback(() => getToken().estimateGas.transferAndCall(...txArgs(values), { from: state.owner })),
            getExpectedGasPrice()
        ]);
        if (seq !== state.estimateSeq) return;
        state.estimatedCostWei = gas.mul(gasPrice);
        costEl.textContent = `≈ ${formatPol(state.estimatedCostWei)}`;
        noteEl.textContent = `1 transaction at ~${parseFloat(ethers.utils.formatUnits(gasPrice, 'gwei')).toFixed(0)} gwei.`;
    } catch (e) {
        if (seq !== state.estimateSeq) return;
        logger.warn('Sponsorship estimate failed:', e);
        costEl.textContent = '--';
        state.estimatedCostWei = null;
        noteEl.textContent = `Could not estimate: ${formatTxError(e)}`;
    }
    updateBalanceWarning();
}

async function loadBalances() {
    try {
        const [dataBalance, polBalance] = await Promise.all([
            Services.readWithFallback(() => getToken().balanceOf(state.owner)),
            Services.readWithFallback(() => Services.getReadOnlyProvider().getBalance(state.owner))
        ]);
        state.dataBalanceWei = dataBalance;
        state.polBalanceWei = polBalance;
        $('sponsorship-form-data-balance').textContent = formatData(dataBalance);
        $('sponsorship-form-balance').textContent = formatPol(polBalance);
    } catch (e) {
        logger.warn('Could not load balances:', e);
        $('sponsorship-form-data-balance').textContent = 'N/A';
        $('sponsorship-form-balance').textContent = 'N/A';
    }
    updateBalanceWarning();
}

// ============================================
// Submission
// ============================================

async function waitUntil(checkFn, timeoutMs, intervalMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            if (await checkFn()) return true;
        } catch (e) {
            logger.warn('Polling check failed:', e);
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return false;
}

async function fetchCumulativeSponsoring(sponsorshipId) {
    const data = await Services.runQuery(`{ sponsorship(id: "${sponsorshipId}") { id cumulativeSponsoring } }`);
    return data?.sponsorship ? ethers.BigNumber.from(data.sponsorship.cumulativeSponsoring || '0') : null;
}

/**
 * The factory forwards the tokens to the new sponsorship: its address is the recipient of the
 * DATA Transfer sent by the factory in the same transaction
 */
function sponsorshipFromReceipt(receipt) {
    const token = getToken();
    for (const log of receipt.logs || []) {
        if (log.address?.toLowerCase() !== DATA_TOKEN_ADDRESS_POLYGON.toLowerCase()) continue;
        try {
            const parsed = token.interface.parseLog(log);
            if (parsed.name === 'Transfer' && parsed.args.from.toLowerCase() === SPONSORSHIP_FACTORY_ADDRESS.toLowerCase()) {
                return parsed.args.to.toLowerCase();
            }
        } catch (e) { /* other event */ }
    }
    return null;
}

async function runStep(step, flow) {
    if (step.key === 'send') {
        const signer = window.appSigner;
        if (!signer) throw new Error('Wallet not connected.');
        if (flow.mode === 'fund') flow.cumulativeBefore = await fetchCumulativeSponsoring(flow.sponsorshipId).catch(() => null);
        const tx = await Services.executeWithFallback(async (currentSigner) => {
            const overrides = await Services.getGasOverrides(currentSigner.provider);
            return getToken(currentSigner).transferAndCall(...flow.args, overrides);
        }, signer);
        step.txHash = tx.hash;
        renderProgress();
        const receipt = await tx.wait();
        if (flow.mode === 'create') {
            flow.sponsorshipId = sponsorshipFromReceipt(receipt);
            if (!flow.sponsorshipId) throw new Error('The transaction succeeded but the new sponsorship address was not found.');
        }
    } else if (step.key === 'index') {
        flow.indexed = await waitUntil(async () => {
            const cumulative = await fetchCumulativeSponsoring(flow.sponsorshipId);
            if (!cumulative) return false;
            if (flow.mode === 'create') return true;
            return flow.cumulativeBefore ? cumulative.gte(flow.cumulativeBefore.add(flow.amountWei)) : true;
        }, INDEX_WAIT_TIMEOUT_MS, INDEX_WAIT_INTERVAL_MS);
    }
}

function showSuccess(flow) {
    const box = $('sponsorship-form-success');
    if (!box) return;
    box.classList.remove('hidden');
    $('sponsorship-form-success-title').textContent = flow.mode === 'create' ? 'Sponsorship created' : 'Funds added';
    const indexing = flow.indexed ? '' : ' The subgraph is still indexing: it may take a moment to show up.';
    $('sponsorship-form-success-text').textContent = (flow.mode === 'create'
        ? 'Operators can now stake on it to earn the payouts.'
        : `${formatData(flow.amountWei)} DATA were added to the sponsorship.`) + indexing;
    const link = $('sponsorship-form-success-link');
    link.href = streamUrl(state.streamId, flow.sponsorshipId);
    link.classList.toggle('hidden', flow.mode !== 'create');
    box.scrollIntoView({ block: 'nearest' });
}

async function handleSubmit() {
    if (state.submitting) return;
    if (state.flow?.finished) {
        closeModal();
        return;
    }
    showError('');

    if (!state.flow) {
        const values = evaluateForm(readForm());
        if (values.errors.length > 0) {
            showError(values.errors.join(' '));
            return;
        }
        const amountLabel = `${formatData(values.amountWei)} DATA`;
        state.flow = {
            mode: state.mode,
            sponsorshipId: state.mode === 'fund' ? state.sponsorship.id : null,
            amountWei: values.amountWei,
            args: txArgs(values),
            steps: [
                { key: 'send', label: state.mode === 'create' ? `Create sponsorship (sends ${amountLabel})` : `Send ${amountLabel} to the sponsorship`, status: 'pending', txHash: null },
                { key: 'index', label: 'Wait for the subgraph to index', noTx: true, status: 'pending', txHash: null }
            ]
        };
    }

    const flow = state.flow;
    state.submitting = true;
    setFormLocked(true);
    renderProgress();
    try {
        for (const step of flow.steps) {
            if (step.status === 'done') continue;
            step.status = 'active';
            renderProgress();
            setSubmitState(step.noTx ? 'Waiting for indexing...' : 'Confirm in wallet...', true);
            await runStep(step, flow);
            step.status = 'done';
            // Modal closed while this step ran: stop here (refresh the page if the transaction went through)
            if (flow.detached) {
                if (!step.noTx) state.onDone?.(flow);
                return;
            }
            renderProgress();
        }
        flow.finished = true;
        state.submitting = false;
        showSuccess(flow);
        setSubmitState('Close', false);
        state.onDone?.(flow);
        UI.showToast({
            type: 'success',
            title: flow.mode === 'create' ? 'Sponsorship Created' : 'Funds Added',
            message: flow.mode === 'create' ? 'The sponsorship was deployed.' : 'The sponsorship was funded.',
            txHash: flow.steps[0].txHash,
            duration: 8000
        });
    } catch (e) {
        logger.error('Sponsorship flow failed:', e);
        if (flow.detached) return;
        const failed = flow.steps.find(s => s.status === 'active');
        if (failed) failed.status = 'error';
        renderProgress();
        state.submitting = false;
        showError(formatTxError(e));
        // The transaction is never sent twice: Retry only continues from a later step
        const sent = flow.steps[0].status === 'done';
        setSubmitState(sent ? 'Retry' : submitLabel(), false);
        if (!sent) {
            state.flow = null;
            $('sponsorship-form-progress')?.classList.add('hidden');
            setFormLocked(false);
        }
    }
}

// ============================================
// Modal lifecycle
// ============================================

function resetForm() {
    state.flow = null;
    state.submitting = false;
    state.estimatedCostWei = null;
    state.dataBalanceWei = null;
    state.polBalanceWei = null;
    const isCreate = state.mode === 'create';

    $('sponsorship-form-title').textContent = isCreate ? 'New Sponsorship' : 'Add Funds';
    $('sponsorship-form-amount-label').textContent = isCreate ? 'Initial funding' : 'Amount';
    $('sponsorship-form-create').classList.toggle('hidden', !isCreate);
    $('sponsorship-form-target-fund').classList.toggle('hidden', isCreate);
    // Line breaks only after "/" (the stream id is shown on its own line)
    $('sponsorship-form-stream').innerHTML = Utils.escapeHtml(state.streamId).split('/').join('/<wbr>');
    $('sponsorship-form-stream').title = state.streamId;
    $('sponsorship-form-amount').value = '';
    $('sponsorship-form-rate').value = '';
    $('sponsorship-form-min-stake').value = '0';
    $('sponsorship-form-min-ops').value = '1';
    $('sponsorship-form-max-ops').value = '';
    $('sponsorship-form-data-balance').textContent = '--';
    $('sponsorship-form-balance').textContent = '--';
    $('sponsorship-form-cost').textContent = '--';
    $('sponsorship-form-cost-note').textContent = '';
    $('sponsorship-form-progress').classList.add('hidden');
    $('sponsorship-form-success').classList.add('hidden');
    $('sponsorship-form-effect').classList.add('hidden');
    setStatus('sponsorship-form-amount-status', '', 'info');
    showError('');

    if (!isCreate) {
        const s = state.sponsorship;
        const payoutDay = ethers.BigNumber.from(s.totalPayoutWeiPerSec || '0').mul(DAY_SECONDS);
        const insolvency = parseInt(s.projectedInsolvency || 0);
        const now = Math.floor(Date.now() / 1000);
        const remaining = insolvency > now ? ethers.BigNumber.from(s.totalPayoutWeiPerSec || '0').mul(insolvency - now) : ethers.BigNumber.from(s.remainingWei || '0');
        $('sponsorship-form-sponsorship').textContent = Utils.shortAddress(s.id);
        $('sponsorship-form-remaining').textContent = `${formatData(remaining)} DATA`;
        $('sponsorship-form-payout').textContent = `${formatData(payoutDay)} DATA / day`;
        $('sponsorship-form-expires').textContent = insolvency > 0 ? formatDate(insolvency) : 'N/A';
    }
    setFormLocked(false);
    setSubmitState(submitLabel(), false);
}

async function openModal() {
    const signer = window.appSigner;
    if (!signer) {
        UI.showToast({ type: 'warning', title: 'Wallet Required', message: 'Connect MetaMask or a private key to continue.', duration: 5000 });
        return;
    }
    if (sessionStorage.getItem('authMethod') !== 'privateKey') {
        if (!await Services.checkAndSwitchNetwork()) return;
    }
    try {
        state.owner = (await signer.getAddress()).toLowerCase();
    } catch (e) {
        UI.showToast({ type: 'error', title: 'Wallet Error', message: 'Could not read the wallet address.', duration: 5000 });
        return;
    }
    setupListeners();
    resetForm();
    $('sponsorshipFormModal').classList.remove('hidden');
    $('sponsorship-form-body').scrollTop = 0;
    $('sponsorship-form-amount').focus();
    await Promise.all([loadBalances(), state.mode === 'create' ? loadNetworkLimits() : null]);
    updateEstimate();
}

/**
 * @param {Object} [options]
 * @param {boolean} [options.force] - close without asking even if a step is running (route change)
 */
function closeModal({ force = false } = {}) {
    const flow = state.flow;
    if (state.submitting) {
        // Never trap the user: a wallet prompt or the indexing wait can take long (or never end)
        if (!force && !window.confirm('A step is still in progress. Close anyway? A transaction you already confirmed in your wallet still goes through.')) return;
        if (flow) flow.detached = true;
        state.submitting = false;
    }
    if (flow && !flow.finished && flow.steps[0].status === 'done') state.onDone?.(flow);
    state.flow = null;
    $('sponsorshipFormModal')?.classList.add('hidden');
}

function setupListeners() {
    if (state.listenersSetup) return;
    state.listenersSetup = true;
    $('sponsorship-form-close')?.addEventListener('click', closeModal);
    $('sponsorship-form-cancel')?.addEventListener('click', closeModal);
    $('sponsorship-form-submit')?.addEventListener('click', handleSubmit);
    // Leaving the page (links, back button) closes the modal
    window.addEventListener('app:routechange', () => {
        if (!$('sponsorshipFormModal')?.classList.contains('hidden')) closeModal({ force: true });
    });
    $('sponsorship-form-body')?.addEventListener('input', () => {
        if (!state.flow) showError('');
        debouncedEstimate();
    });
    $('sponsorship-form-max')?.addEventListener('click', () => {
        if (!state.dataBalanceWei || state.flow) return;
        $('sponsorship-form-amount').value = ethers.utils.formatEther(state.dataBalanceWei).replace(/\.0$/, '');
        debouncedEstimate();
    });
    $('sponsorship-form-success-link')?.addEventListener('click', (e) => {
        e.preventDefault();
        const href = e.currentTarget.getAttribute('href');
        state.flow = null;
        state.submitting = false;
        $('sponsorshipFormModal')?.classList.add('hidden');
        window.router?.navigate(href);
    });
    $('sponsorshipFormModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'sponsorshipFormModal') closeModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !$('sponsorshipFormModal')?.classList.contains('hidden')) closeModal();
    });
}

function setupButton(id, enabledTitle, onClick) {
    const btn = $(id);
    if (!btn) return;
    const connected = Boolean(window.appSigner);
    btn.disabled = !connected;
    btn.title = connected ? enabledTitle : 'Connect a wallet (MetaMask or private key) to continue';
    btn.onclick = connected ? onClick : null;
}

export const SponsorshipForm = {
    /**
     * Stream Details: "New Sponsorship" for this stream (any wallet can sponsor any stream)
     * @param {Object} stream - stream from the subgraph (id)
     * @param {Function} onDone - called after the sponsorship was created
     */
    setupCreateButton(stream, onDone) {
        setupButton('stream-new-sponsorship-btn', 'Create a sponsorship for this stream', () => {
            state.mode = 'create';
            state.streamId = stream.id;
            state.sponsorship = null;
            state.onDone = onDone;
            openModal();
        });
    },

    /**
     * Sponsorship Details: "Add Funds"
     * @param {Object} sponsorship - sponsorship from the subgraph (id, totalPayoutWeiPerSec, projectedInsolvency, remainingWei, isRunning)
     * @param {string} streamId
     * @param {Function} onDone - called after the funds were added
     */
    setupFundButton(sponsorship, streamId, onDone) {
        setupButton('sponsorship-add-funds-btn', 'Add DATA to this sponsorship', () => {
            state.mode = 'fund';
            state.streamId = streamId;
            state.sponsorship = sponsorship;
            state.onDone = onDone;
            openModal();
        });
    }
};
