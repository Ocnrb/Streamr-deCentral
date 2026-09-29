/**
 * Operator wallets (Operator Details, owner only): add and remove agent and node wallets
 * - agents: Operator.grantRole / revokeRole(CONTROLLER_ROLE, address), one transaction per wallet.
 *   Only the owner can call them (OWNER_ROLE administers CONTROLLER_ROLE).
 * - nodes: Operator.updateNodeAddresses(add[], remove[]), one transaction for all node changes.
 * Changes are staged in the table and sent on Save, then the subgraph is polled until it shows them.
 */

import * as Utils from '../core/utils.js';
import * as UI from '../ui/ui.js';
import * as Services from '../core/services.js';

const { logger } = Utils;

// ============================================
// Constants
// ============================================

const OPERATOR_WALLETS_ABI = [
    'function getNodeAddresses() view returns (address[])',
    'function updateNodeAddresses(address[] addNodes, address[] removeNodes)',
    'function grantRole(bytes32 role, address account)',
    'function revokeRole(bytes32 role, address account)'
];
const CONTROLLER_ROLE = ethers.utils.id('CONTROLLER_ROLE');
const INDEX_WAIT_TIMEOUT_MS = 90 * 1000;
const INDEX_WAIT_INTERVAL_MS = 3000;

// ============================================
// State
// ============================================

const state = {
    operatorId: null,
    owner: null,              // operator owner (lowercase)
    agents: [],               // current agents (lowercase)
    nodes: [],                // current node wallets (lowercase)
    added: { agents: new Set(), nodes: new Set() },
    removed: { agents: new Set(), nodes: new Set() },
    balances: new Map(),      // address -> BigNumber | null (loading) | 'error'
    polBalanceWei: null,
    onDone: null,
    flow: null,
    submitting: false,
    estimateSeq: 0,
    estimatedCostWei: null,
    listenersSetup: false
};

const $ = (id) => document.getElementById(id);
const debouncedEstimate = Utils.debounce(() => updateEstimate(), 400);

// ============================================
// Helpers
// ============================================

function getOperator(signerOrProvider = Services.getReadOnlyProvider()) {
    return new ethers.Contract(state.operatorId, OPERATOR_WALLETS_ABI, signerOrProvider);
}

function formatPol(wei) {
    const value = parseFloat(ethers.utils.formatEther(wei));
    if (value === 0) return '0';
    if (value < 0.01) return '< 0.01';
    return value.toFixed(2);
}

function formatTxError(error) {
    if (error?.code === 4001 || error?.code === 'ACTION_REJECTED') return 'Transaction rejected in your wallet.';
    const text = `${error?.reason || ''} ${error?.error?.message || ''} ${error?.data?.message || ''} ${error?.message || ''}`;
    if (text.toLowerCase().includes('insufficient funds')) return 'Insufficient POL to pay for gas.';
    if (/AccessControl|AccessDenied/i.test(text)) return 'Only the operator owner can change the agents.';
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

/** Final list of a kind after the staged changes */
function finalList(kind) {
    return [...state[kind].filter(a => !state.removed[kind].has(a)), ...state.added[kind]];
}

function changeCount() {
    return state.added.agents.size + state.removed.agents.size + state.added.nodes.size + state.removed.nodes.size;
}

/** Transactions for the staged changes (in sending order) */
function plannedSteps() {
    const steps = [];
    if (state.added.nodes.size || state.removed.nodes.size) {
        const parts = [];
        if (state.added.nodes.size) parts.push(`add ${state.added.nodes.size}`);
        if (state.removed.nodes.size) parts.push(`remove ${state.removed.nodes.size}`);
        steps.push({ key: 'nodes', label: `Update node wallets (${parts.join(', ')})`, add: [...state.added.nodes], remove: [...state.removed.nodes] });
    }
    for (const address of state.added.agents) steps.push({ key: 'grant', address, label: `Add agent ${Utils.shortAddress(address)}` });
    for (const address of state.removed.agents) steps.push({ key: 'revoke', address, label: `Remove agent ${Utils.shortAddress(address)}` });
    return steps;
}

function sendTx(step, contract, overrides) {
    if (step.key === 'nodes') return contract.updateNodeAddresses(step.add, step.remove, overrides);
    if (step.key === 'grant') return contract.grantRole(CONTROLLER_ROLE, step.address, overrides);
    return contract.revokeRole(CONTROLLER_ROLE, step.address, overrides);
}

// ============================================
// Rendering
// ============================================

const REMOVE_ICON = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>';
const UNDO_ICON = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3"/></svg>';

function balanceCell(address, kind) {
    const balance = state.balances.get(address);
    if (balance === undefined || balance === null) return '<span class="text-gray-500">...</span>';
    if (balance === 'error') return '<span class="text-gray-500">N/A</span>';
    const empty = balance.isZero();
    const needsGas = empty && kind === 'nodes';
    return `<span class="${needsGas ? 'text-yellow-400' : 'text-gray-300'}" ${needsGas ? 'title="This node wallet needs POL to pay for gas"' : ''}>${formatPol(balance)}</span>`;
}

function rowHtml(rawAddress, kind, status) {
    const address = Utils.escapeHtml(rawAddress);
    const isOwner = kind === 'agents' && rawAddress === state.owner;
    const tag = isOwner ? '<span class="ml-2 text-[10px] uppercase tracking-wide text-yellow-400">Owner</span>'
        : status === 'added' ? '<span class="ml-2 text-[10px] uppercase tracking-wide text-green-400">New</span>'
        : status === 'removed' ? '<span class="ml-2 text-[10px] uppercase tracking-wide text-red-400">Removing</span>'
        : '';
    const locked = Boolean(state.flow);
    let action = '';
    if (!isOwner) {
        const undo = status !== 'current';
        action = `<button type="button" data-kind="${kind}" data-address="${address}" data-action="${undo ? 'undo' : 'remove'}"
            class="p-1.5 rounded-md text-gray-500 hover:text-white hover:bg-[#333] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="${undo ? 'Undo' : 'Remove'}" ${locked ? 'disabled' : ''}>${undo ? UNDO_ICON : REMOVE_ICON}</button>`;
    }
    const addressClass = status === 'removed' ? 'line-through text-gray-500' : status === 'added' ? 'text-green-300' : 'text-gray-200';
    return `
        <tr class="border-b border-[#2a2a2a] last:border-0">
            <td class="px-3 py-2 font-mono text-xs"><span class="${addressClass}" title="${address}"><span class="sm:hidden">${Utils.escapeHtml(Utils.shortAddress(rawAddress))}</span><span class="hidden sm:inline">${address}</span></span>${tag}</td>
            <td class="px-3 py-2 text-right font-mono text-xs">${balanceCell(rawAddress, kind)}</td>
            <td class="px-1 py-1 text-right">${action}</td>
        </tr>`;
}

function renderTable(kind) {
    const body = $(`operator-wallets-${kind}`);
    if (!body) return;
    const rows = [
        ...state[kind].map(a => rowHtml(a, kind, state.removed[kind].has(a) ? 'removed' : 'current')),
        ...[...state.added[kind]].map(a => rowHtml(a, kind, 'added'))
    ];
    body.innerHTML = rows.length ? rows.join('') : `<tr><td colspan="3" class="px-3 py-3 text-xs text-gray-500">${kind === 'agents' ? 'No agents.' : 'No node wallets.'}</td></tr>`;
}

function renderNodesWarning() {
    if (!finalList('nodes').length && state.nodes.length) {
        setStatus('operator-wallets-nodes-status', 'No node wallets left: the operator stops sending heartbeats and can be flagged and slashed.', 'warn');
    } else if ([...state.added.nodes].some(a => state.balances.get(a)?.isZero?.())) {
        setStatus('operator-wallets-nodes-status', 'A new node wallet has no POL: send it some so the node can pay for gas.', 'warn');
    }
}

function renderAll() {
    renderTable('agents');
    renderTable('nodes');
    if (!state.flow) {
        const btn = $('operator-wallets-submit');
        if (btn && !state.submitting) btn.disabled = changeCount() === 0;
    }
}

function renderProgress() {
    const container = $('operator-wallets-progress');
    const list = $('operator-wallets-progress-list');
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
    const el = $('operator-wallets-error');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
    if (message) el.scrollIntoView({ block: 'nearest' });
}

function setSubmitState(label, busy) {
    const btn = $('operator-wallets-submit');
    if (!btn) return;
    btn.disabled = busy;
    btn.innerHTML = busy
        ? `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent animate-spin"></div><span>${Utils.escapeHtml(label)}</span>`
        : Utils.escapeHtml(label);
}

function setFormLocked(locked) {
    $('operator-wallets-body')?.querySelectorAll('input, button').forEach(el => { el.disabled = locked; });
}

function updateBalanceWarning() {
    const el = $('operator-wallets-balance');
    if (!el) return;
    const insufficient = state.polBalanceWei && state.estimatedCostWei && state.polBalanceWei.lt(state.estimatedCostWei);
    el.classList.toggle('text-red-400', Boolean(insufficient));
    el.classList.toggle('text-gray-400', !insufficient);
}

// ============================================
// Data
// ============================================

async function loadBalance(address) {
    if (state.balances.has(address)) return;
    state.balances.set(address, null);
    try {
        const balance = await Services.readWithFallback(() => Services.getReadOnlyProvider().getBalance(address));
        state.balances.set(address, balance);
    } catch (e) {
        state.balances.set(address, 'error');
    }
    if (!$('operatorWalletsModal')?.classList.contains('hidden')) {
        renderAll();
        renderNodesWarning();
    }
}

/** Node wallets from the chain (the subgraph can lag behind) */
async function loadNodes() {
    try {
        const nodes = await Services.readWithFallback(() => getOperator().getNodeAddresses());
        state.nodes = nodes.map(a => a.toLowerCase());
        renderAll();
        state.nodes.forEach(loadBalance);
    } catch (e) {
        logger.warn('Could not read node wallets from the chain, using the subgraph:', e);
    }
}

async function loadOwnBalance() {
    try {
        state.polBalanceWei = await Services.readWithFallback(() => Services.getReadOnlyProvider().getBalance(state.owner));
        $('operator-wallets-balance').textContent = `${formatPol(state.polBalanceWei)} POL`;
    } catch (e) {
        $('operator-wallets-balance').textContent = 'N/A';
    }
    updateBalanceWarning();
}

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
    const costEl = $('operator-wallets-cost');
    const noteEl = $('operator-wallets-cost-note');
    if (!costEl || state.flow) return;
    const steps = plannedSteps();
    if (!steps.length) {
        costEl.textContent = '--';
        noteEl.textContent = 'Add or remove wallets, then Save.';
        state.estimatedCostWei = null;
        updateBalanceWarning();
        return;
    }
    costEl.textContent = 'Estimating...';
    noteEl.textContent = '';
    try {
        const contract = getOperator();
        const from = { from: state.owner };
        const [gasList, gasPrice] = await Promise.all([
            Promise.all(steps.map(step => Services.readWithFallback(() => {
                if (step.key === 'nodes') return contract.estimateGas.updateNodeAddresses(step.add, step.remove, from);
                if (step.key === 'grant') return contract.estimateGas.grantRole(CONTROLLER_ROLE, step.address, from);
                return contract.estimateGas.revokeRole(CONTROLLER_ROLE, step.address, from);
            }))),
            getExpectedGasPrice()
        ]);
        if (seq !== state.estimateSeq) return;
        state.estimatedCostWei = gasList.reduce((sum, gas) => sum.add(gas), ethers.constants.Zero).mul(gasPrice);
        const cost = parseFloat(ethers.utils.formatEther(state.estimatedCostWei));
        costEl.textContent = cost < 0.0001 ? '< 0.0001 POL' : `≈ ${cost.toFixed(4)} POL`;
        const gwei = parseFloat(ethers.utils.formatUnits(gasPrice, 'gwei')).toFixed(0);
        noteEl.textContent = `${steps.length} ${steps.length === 1 ? 'transaction' : 'transactions'} at ~${gwei} gwei.`;
    } catch (e) {
        if (seq !== state.estimateSeq) return;
        logger.warn('Wallets estimate failed:', e);
        costEl.textContent = '--';
        state.estimatedCostWei = null;
        noteEl.textContent = `Could not estimate: ${formatTxError(e)}`;
    }
    updateBalanceWarning();
}

// ============================================
// Editing
// ============================================

function handleAdd(kind, input) {
    const statusId = `operator-wallets-${kind}-status`;
    const raw = input.value.trim();
    if (!raw) return;
    if (!ethers.utils.isAddress(raw) || /^0x0{40}$/i.test(raw)) {
        setStatus(statusId, 'Not a valid address.', 'error');
        return;
    }
    const address = raw.toLowerCase();
    if (address === state.operatorId) {
        setStatus(statusId, 'That is the operator contract itself.', 'error');
        return;
    }
    if (state.removed[kind].has(address)) {
        // Adding back a wallet staged for removal just cancels the removal
        state.removed[kind].delete(address);
    } else if (state[kind].includes(address) || state.added[kind].has(address)) {
        setStatus(statusId, kind === 'agents' ? 'This wallet is already an agent.' : 'This wallet is already a node wallet.', 'error');
        return;
    } else {
        state.added[kind].add(address);
        loadBalance(address);
    }
    input.value = '';
    setStatus(statusId, '', 'info');
    afterEdit(kind);
}

function handleRowAction(kind, address, action) {
    if (action === 'remove') {
        if (kind === 'agents' && address === state.owner) return;
        state.removed[kind].add(address);
    } else if (state.added[kind].has(address)) {
        state.added[kind].delete(address);
    } else {
        state.removed[kind].delete(address);
    }
    setStatus(`operator-wallets-${kind}-status`, '', 'info');
    afterEdit(kind);
}

function afterEdit(kind) {
    showError('');
    renderAll();
    if (kind === 'nodes') {
        setStatus('operator-wallets-nodes-status', '', 'info');
        renderNodesWarning();
    }
    debouncedEstimate();
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

const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

async function subgraphShowsChanges(flow) {
    const data = await Services.runQuery(`{ operator(id: "${state.operatorId}") { nodes controllers } }`);
    const op = data?.operator;
    if (!op) return false;
    const lower = list => (list || []).map(a => a.toLowerCase());
    return sameSet(lower(op.nodes), flow.expectedNodes) && sameSet(lower(op.controllers), flow.expectedAgents);
}

async function runStep(step, flow) {
    if (step.key === 'index') {
        flow.indexed = await waitUntil(() => subgraphShowsChanges(flow), INDEX_WAIT_TIMEOUT_MS, INDEX_WAIT_INTERVAL_MS);
        return;
    }
    const signer = window.appSigner;
    if (!signer) throw new Error('Wallet not connected.');
    const tx = await Services.executeWithFallback(async (currentSigner) => {
        const overrides = await Services.getGasOverrides(currentSigner.provider);
        return sendTx(step, getOperator(currentSigner), overrides);
    }, signer);
    step.txHash = tx.hash;
    flow.sent = true;
    renderProgress();
    await tx.wait();
}

async function handleSubmit() {
    if (state.submitting) return;
    if (state.flow?.finished) {
        closeModal();
        return;
    }
    showError('');

    if (!state.flow) {
        const steps = plannedSteps();
        if (!steps.length) return;
        state.flow = {
            expectedAgents: finalList('agents'),
            expectedNodes: finalList('nodes'),
            sent: false,
            steps: [
                ...steps.map(step => ({ ...step, status: 'pending', txHash: null })),
                { key: 'index', label: 'Wait for the subgraph to index', noTx: true, status: 'pending', txHash: null }
            ]
        };
        renderAll();
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
            // Modal closed while this step ran: stop here (the page refreshes if something was sent)
            if (flow.detached) return;
            renderProgress();
        }
        flow.finished = true;
        state.submitting = false;
        showSuccess(flow);
        setSubmitState('Close', false);
        UI.showToast({
            type: 'success',
            title: 'Wallets Updated',
            message: 'The operator wallets were updated.',
            txHash: flow.steps[flow.steps.length - 2]?.txHash,
            duration: 8000
        });
    } catch (e) {
        logger.error('Operator wallets flow failed:', e);
        if (flow.detached) return;
        const failed = flow.steps.find(s => s.status === 'active');
        if (failed) failed.status = 'error';
        renderProgress();
        state.submitting = false;
        showError(formatTxError(e));
        // A transaction is never sent twice: Retry continues from the step that failed
        setSubmitState(flow.sent ? 'Retry' : 'Save', false);
        if (!flow.sent) {
            state.flow = null;
            $('operator-wallets-progress')?.classList.add('hidden');
            setFormLocked(false);
            renderAll();
        }
    }
}

function showSuccess(flow) {
    const box = $('operator-wallets-success');
    if (!box) return;
    box.classList.remove('hidden');
    const txCount = flow.steps.filter(s => !s.noTx).length;
    $('operator-wallets-success-text').textContent = `${txCount} ${txCount === 1 ? 'transaction' : 'transactions'} confirmed.`
        + (flow.indexed ? '' : ' The subgraph is still indexing: the lists may take a moment to update.');
    box.scrollIntoView({ block: 'nearest' });
}

// ============================================
// Modal lifecycle
// ============================================

function resetForm() {
    state.flow = null;
    state.submitting = false;
    state.estimatedCostWei = null;
    state.polBalanceWei = null;
    state.added = { agents: new Set(), nodes: new Set() };
    state.removed = { agents: new Set(), nodes: new Set() };
    state.balances = new Map();
    ['agents', 'nodes'].forEach(kind => {
        const input = $(`operator-wallets-${kind}-add`)?.querySelector('input');
        if (input) input.value = '';
        setStatus(`operator-wallets-${kind}-status`, '', 'info');
    });
    $('operator-wallets-balance').textContent = '--';
    $('operator-wallets-cost').textContent = '--';
    $('operator-wallets-cost-note').textContent = 'Add or remove wallets, then Save.';
    $('operator-wallets-progress').classList.add('hidden');
    $('operator-wallets-success').classList.add('hidden');
    showError('');
    setFormLocked(false);
    setSubmitState('Save', false);
    renderAll();
}

async function openModal(operator, onDone) {
    const signer = window.appSigner;
    if (!signer) {
        UI.showToast({ type: 'warning', title: 'Wallet Required', message: 'Connect MetaMask or a private key to continue.', duration: 5000 });
        return;
    }
    if (sessionStorage.getItem('authMethod') !== 'privateKey') {
        if (!await Services.checkAndSwitchNetwork()) return;
    }
    let me;
    try {
        me = (await signer.getAddress()).toLowerCase();
    } catch (e) {
        UI.showToast({ type: 'error', title: 'Wallet Error', message: 'Could not read the wallet address.', duration: 5000 });
        return;
    }
    if (!operator?.owner || me !== operator.owner.toLowerCase()) {
        UI.showToast({ type: 'error', title: 'Owner Only', message: 'Only the operator owner can manage its wallets.', duration: 5000 });
        return;
    }
    state.operatorId = operator.id.toLowerCase();
    state.owner = me;
    state.onDone = onDone;
    state.agents = [...new Set((operator.controllers || []).map(a => a.toLowerCase()))];
    // Owner first
    state.agents.sort((a, b) => (b === me) - (a === me));
    state.nodes = [...new Set((operator.nodes || []).map(a => a.toLowerCase()))];

    setupListeners();
    resetForm();
    $('operatorWalletsModal').classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
    $('operator-wallets-body').scrollTop = 0;
    state.agents.forEach(loadBalance);
    state.nodes.forEach(loadBalance);
    await Promise.all([loadNodes(), loadOwnBalance()]);
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
    state.flow = null;
    $('operatorWalletsModal')?.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
    if (flow?.sent && !force) state.onDone?.();
}

function setupListeners() {
    if (state.listenersSetup) return;
    state.listenersSetup = true;
    $('operator-wallets-close')?.addEventListener('click', () => closeModal());
    $('operator-wallets-cancel')?.addEventListener('click', () => closeModal());
    $('operator-wallets-submit')?.addEventListener('click', handleSubmit);
    ['agents', 'nodes'].forEach(kind => {
        const form = $(`operator-wallets-${kind}-add`);
        form?.addEventListener('submit', (e) => {
            e.preventDefault();
            if (!state.flow) handleAdd(kind, form.querySelector('input'));
        });
        form?.querySelector('input')?.addEventListener('input', () => setStatus(`operator-wallets-${kind}-status`, '', 'info'));
        $(`operator-wallets-${kind}`)?.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-action]');
            if (btn && !state.flow) handleRowAction(btn.dataset.kind, btn.dataset.address, btn.dataset.action);
        });
    });
    // Leaving the page (links, back button) closes the modal
    window.addEventListener('app:routechange', () => {
        if (!$('operatorWalletsModal')?.classList.contains('hidden')) closeModal({ force: true });
    });
    $('operatorWalletsModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'operatorWalletsModal') closeModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !$('operatorWalletsModal')?.classList.contains('hidden')) closeModal();
    });
}

export const OperatorWallets = {
    /**
     * Operator Details: "Manage" on the Wallets card (owner only)
     * @param {Object} operator - operator from the subgraph (id, owner, controllers, nodes)
     * @param {Function} onDone - called after the modal closes if a transaction was sent
     */
    open(operator, onDone) {
        openModal(operator, onDone);
    }
};
