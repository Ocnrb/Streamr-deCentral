/**
 * Create / Edit Operator Feature Module
 * One modal, two modes (same pattern as Create / Edit Stream):
 * - create (button on the operators list): deploys an Operator contract through the OperatorFactory
 *   with the default delegation / exchange rate / undelegation policies.
 * - edit (button on the operator page, owner or controller): updates the metadata and the owner's cut.
 *   Existing metadata keys that the form doesn't manage are preserved.
 */

import * as Utils from '../core/utils.js';
import * as UI from '../ui/ui.js';
import * as Services from '../core/services.js';
import {
    OPERATOR_FACTORY_ADDRESS,
    OPERATOR_FACTORY_ABI,
    OPERATOR_DEFAULT_POLICIES,
    OPERATOR_CONTRACT_ABI
} from '../core/constants.js';

const { logger } = Utils;

// ============================================
// Constants
// ============================================

const NAME_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 1000;
const MAX_REDUNDANCY_FACTOR = 100;
const INDEX_WAIT_TIMEOUT_MS = 90 * 1000;
const INDEX_WAIT_INTERVAL_MS = 3000;

// Metadata keys edited by the form; any other key found in existing metadata is kept as is
const LINK_FIELDS = [
    { key: 'url', input: 'operator-form-url', label: 'Website' },
    { key: 'email', input: 'operator-form-email', label: 'Email' },
    { key: 'x', input: 'operator-form-x', label: 'X' },
    { key: 'telegram', input: 'operator-form-telegram', label: 'Telegram' },
    { key: 'reddit', input: 'operator-form-reddit', label: 'Reddit' },
    { key: 'linkedIn', input: 'operator-form-linkedin', label: 'LinkedIn' }
];

// Same CID check as Utils.parseOperatorMetadata (CIDv0 Qm... / CIDv1 b...)
const IPFS_CID_REGEX = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$|^b[a-z2-7]{58,}$/;

// Custom errors of the OperatorFactory / Operator contracts (4-byte selectors)
const CONTRACT_ERRORS = {
    'OperatorAlreadyDeployed(address)': 'This wallet already has an Operator.',
    'PolicyNotTrusted()': 'One of the operator policies is not trusted by the factory.',
    'StakedInSponsorships()': "The owner's cut can only be changed when the operator is not staked in any sponsorship.",
    'InvalidOperatorsCut(uint256)': "The owner's cut must be between 0% and 100%.",
    'AccessDeniedOperatorOnly()': 'This wallet is not the owner or a controller of the operator.'
};
const CONTRACT_ERROR_SELECTORS = Object.fromEntries(
    Object.entries(CONTRACT_ERRORS).map(([signature, message]) => [ethers.utils.id(signature).slice(0, 10), message])
);

// ============================================
// State
// ============================================

const state = {
    mode: 'create',            // 'create' | 'edit'
    owner: null,               // connected wallet (lowercase)
    existingOperator: null,    // create mode: operator contract already deployed by this wallet
    edit: null,                // edit mode: { operatorId, metadata, cutPercent, cutLocked, onSaved }
    flow: null,                // in-progress submission (kept for retry)
    submitting: false,
    estimateSeq: 0,
    estimatedCostWei: null,
    balanceWei: null,
    listenersSetup: false
};

const debouncedEstimate = Utils.debounce(() => updateEstimate(), 600);

// ============================================
// Helpers
// ============================================

const $ = (id) => document.getElementById(id);

function getReadFactory() {
    return new ethers.Contract(OPERATOR_FACTORY_ADDRESS, OPERATOR_FACTORY_ABI, Services.getReadOnlyProvider());
}

function parseMetadataObject(json) {
    try {
        const parsed = json ? JSON.parse(json) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        // Same prototype pollution guard as Utils.parseOperatorMetadata
        for (const key of ['__proto__', 'constructor', 'prototype']) {
            if (Object.prototype.hasOwnProperty.call(parsed, key)) return {};
        }
        return parsed;
    } catch (e) {
        return {};
    }
}

/**
 * operatorsCutFraction (fraction of 1e18) -> percent string with up to 2 decimals
 */
function cutFractionToPercent(fractionWei) {
    try {
        const basisPoints = ethers.BigNumber.from(fractionWei || '0').mul(10000).div(ethers.constants.WeiPerEther).toNumber();
        return String(basisPoints / 100);
    } catch (e) {
        return '0';
    }
}

/**
 * Percent (e.g. "12.5") -> operatorsCutFraction (fraction of 1e18)
 */
function percentToCutFraction(percent) {
    return ethers.utils.parseEther(String(percent)).div(100);
}

function formatPol(wei) {
    const value = parseFloat(ethers.utils.formatEther(wei));
    if (value === 0) return '0 POL';
    if (value < 0.0001) return '< 0.0001 POL';
    return `${value.toFixed(4)} POL`;
}

function formatTxError(error) {
    if (error?.code === 4001 || error?.code === 'ACTION_REJECTED') return 'Transaction rejected in your wallet.';
    const text = `${error?.reason || ''} ${error?.error?.message || ''} ${error?.data?.message || ''} ${error?.message || ''} ${error?.error?.data?.data || ''} ${error?.data || ''} ${error?.error?.data || ''}`;
    for (const [selector, message] of Object.entries(CONTRACT_ERROR_SELECTORS)) {
        if (text.includes(selector)) return message;
    }
    for (const [signature, message] of Object.entries(CONTRACT_ERRORS)) {
        if (text.includes(signature.split('(')[0])) return message;
    }
    if (text.toLowerCase().includes('insufficient funds')) return 'Insufficient POL to pay for gas.';
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

// ============================================
// Form
// ============================================

function readForm() {
    const links = {};
    for (const field of LINK_FIELDS) links[field.key] = ($(field.input)?.value || '').trim();
    return {
        name: ($('operator-form-name')?.value || '').trim(),
        description: ($('operator-form-description')?.value || '').trim(),
        imageIpfsCid: ($('operator-form-image')?.value || '').trim(),
        cut: ($('operator-form-cut')?.value || '').trim(),
        redundancy: ($('operator-form-redundancy')?.value || '').trim(),
        links
    };
}

function validateForm(form) {
    const errors = [];
    if (!form.name) errors.push('Name is required.');
    else if (form.name.length > NAME_MAX_LENGTH) errors.push(`Name must be at most ${NAME_MAX_LENGTH} characters.`);
    if (form.description.length > DESCRIPTION_MAX_LENGTH) errors.push(`Description must be at most ${DESCRIPTION_MAX_LENGTH} characters.`);
    if (form.imageIpfsCid && !IPFS_CID_REGEX.test(form.imageIpfsCid)) errors.push('Image must be a valid IPFS CID (Qm... or b...).');

    const cut = Number(form.cut);
    if (form.cut === '' || !Number.isFinite(cut) || cut < 0 || cut > 100) errors.push("Owner's cut must be between 0 and 100.");
    else if (!/^\d+(\.\d{1,2})?$/.test(form.cut)) errors.push("Owner's cut can have at most 2 decimals.");

    const redundancy = Number(form.redundancy);
    if (!Number.isInteger(redundancy) || redundancy < 1 || redundancy > MAX_REDUNDANCY_FACTOR) {
        errors.push(`Redundancy factor must be a whole number between 1 and ${MAX_REDUNDANCY_FACTOR}.`);
    }

    if (form.links.url && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(form.links.url)) errors.push('Website must start with http:// or https://.');
    if (form.links.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.links.email)) errors.push('Email address is not valid.');
    return errors;
}

/**
 * Metadata JSON for the operator. In edit mode it starts from the current metadata,
 * so keys this form doesn't know about are preserved.
 */
function buildMetadata(form) {
    const original = state.mode === 'edit' ? state.edit.metadata : {};
    const metadata = { ...original };
    const text = (value) => (typeof value === 'string' ? value : '');

    // A field is only rewritten when its effective value changed, so opening and saving
    // without edits produces no transaction (e.g. "2" vs 2, missing vs default, x vs twitter)
    const setText = (key, value, current) => {
        if (value === current) return;
        if (value) metadata[key] = value;
        else delete metadata[key];
    };
    setText('name', form.name, text(original.name));
    setText('description', form.description, text(original.description));
    setText('imageIpfsCid', form.imageIpfsCid, text(original.imageIpfsCid));
    for (const field of LINK_FIELDS) {
        // Older metadata may only have "twitter": it is shown in the X field
        const current = field.key === 'x' ? text(original.x ?? original.twitter) : text(original[field.key]);
        setText(field.key, form.links[field.key], current);
    }

    const redundancy = Number(form.redundancy);
    const currentRedundancy = Number(original.redundancyFactor ?? 1);
    if (redundancy !== currentRedundancy || state.mode === 'create') metadata.redundancyFactor = redundancy;

    return JSON.stringify(metadata);
}

/**
 * Transactions needed for the current form
 */
function planChanges(form) {
    const metadataJson = buildMetadata(form);
    if (state.mode === 'create') {
        return { metadataJson, deploy: true, metadata: false, cut: false };
    }
    const cutChanged = Number(form.cut) !== Number(state.edit.cutPercent);
    return {
        metadataJson,
        deploy: false,
        metadata: metadataJson !== JSON.stringify(state.edit.metadata),
        cut: cutChanged && !state.edit.cutLocked
    };
}

function planSteps(changes) {
    const steps = [];
    if (changes.deploy) steps.push({ key: 'deploy', label: 'Deploy Operator contract' });
    if (changes.metadata) steps.push({ key: 'metadata', label: 'Update metadata' });
    if (changes.cut) steps.push({ key: 'cut', label: "Update owner's cut" });
    if (steps.length) steps.push({ key: 'index', label: 'Wait for the subgraph to index', noTx: true });
    return steps.map(step => ({ ...step, status: 'pending', txHash: null }));
}

function operatorTokenName() {
    // Same naming as the Streamr Hub; the address is unique per wallet anyway (one operator per wallet)
    return `StreamrOperator-${state.owner.slice(-5)}`;
}

// ============================================
// Rendering
// ============================================

function renderImagePreview() {
    const cid = ($('operator-form-image')?.value || '').trim();
    const img = $('operator-form-image-preview');
    if (!img) return;
    const valid = IPFS_CID_REGEX.test(cid);
    img.src = valid ? `https://ipfs.io/ipfs/${cid}` : 'https://placehold.co/64x64/1E1E1E/a3a3a3?text=OP';
    setStatus('operator-form-image-status', cid && !valid ? 'Not a valid IPFS CID.' : '', 'error');
}

function renderCutLock() {
    const locked = state.mode === 'edit' && state.edit.cutLocked;
    const input = $('operator-form-cut');
    if (input) input.disabled = locked || state.submitting;
    setStatus('operator-form-cut-status', locked
        ? "Locked while the operator is staked in sponsorships. Unstake from all sponsorships to change it."
        : 'Share of the earnings that goes directly to you.', locked ? 'warn' : 'info');
}

function renderExistingOperator() {
    const box = $('operator-form-existing');
    if (!box) return;
    const show = state.mode === 'create' && !!state.existingOperator;
    box.classList.toggle('hidden', !show);
    if (show) {
        const link = $('operator-form-existing-link');
        link.href = `/operator/${state.existingOperator}`;
        link.textContent = state.existingOperator;
    }
}

function renderProgress() {
    const container = $('operator-form-progress');
    const list = $('operator-form-progress-list');
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
    const el = $('operator-form-error');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
    if (message) el.scrollIntoView({ block: 'nearest' });
}

function submitLabel() {
    return state.mode === 'edit' ? 'Save Changes' : 'Create Operator';
}

function setSubmitState(label, busy) {
    const btn = $('operator-form-submit');
    if (!btn) return;
    btn.disabled = busy;
    btn.innerHTML = busy
        ? `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent animate-spin"></div><span>${Utils.escapeHtml(label)}</span>`
        : Utils.escapeHtml(label);
}

function updateSubmitEnabled(enabled) {
    const btn = $('operator-form-submit');
    if (btn && !state.submitting && !state.flow) btn.disabled = !enabled;
}

function setFormLocked(locked) {
    $('operator-form-body')?.querySelectorAll('input, textarea, button').forEach(el => { el.disabled = locked; });
    if (!locked) renderCutLock();
}

function updateBalanceWarning() {
    const balanceEl = $('operator-form-balance');
    if (!balanceEl) return;
    const insufficient = state.balanceWei && state.estimatedCostWei && state.balanceWei.lt(state.estimatedCostWei);
    balanceEl.classList.toggle('text-red-400', Boolean(insufficient));
    balanceEl.classList.toggle('text-gray-400', !insufficient);
    balanceEl.title = insufficient ? 'Balance is lower than the estimated cost' : '';
}

// ============================================
// Cost estimate
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

async function estimateStepGas(step, form, changes) {
    const from = { from: state.owner };
    switch (step.key) {
        case 'deploy':
            return Services.readWithFallback(() => getReadFactory().estimateGas.deployOperator(
                percentToCutFraction(form.cut), operatorTokenName(), changes.metadataJson,
                OPERATOR_DEFAULT_POLICIES, [0, 0, 0], from));
        case 'metadata': {
            const contract = new ethers.Contract(state.edit.operatorId, OPERATOR_CONTRACT_ABI, Services.getReadOnlyProvider());
            return Services.readWithFallback(() => contract.estimateGas.updateMetadata(changes.metadataJson, from));
        }
        case 'cut': {
            const contract = new ethers.Contract(state.edit.operatorId, OPERATOR_CONTRACT_ABI, Services.getReadOnlyProvider());
            return Services.readWithFallback(() => contract.estimateGas.updateOperatorsCutFraction(percentToCutFraction(form.cut), from));
        }
    }
    return ethers.BigNumber.from(0);
}

async function updateEstimate() {
    const seq = ++state.estimateSeq;
    const txList = $('operator-form-tx-list');
    const costEl = $('operator-form-cost');
    const noteEl = $('operator-form-cost-note');
    const balanceEl = $('operator-form-balance');
    if (!txList || !costEl) return;

    const form = readForm();
    const errors = validateForm(form);
    const changes = planChanges(form);
    const txSteps = planSteps(changes).filter(s => !s.noTx);

    Services.readWithFallback(() => Services.getReadOnlyProvider().getBalance(state.owner))
        .then(balance => {
            if (seq !== state.estimateSeq) return;
            state.balanceWei = balance;
            balanceEl.textContent = formatPol(balance);
            updateBalanceWarning();
        })
        .catch(() => { balanceEl.textContent = 'N/A'; });

    if (state.mode === 'create' && state.existingOperator) {
        txList.innerHTML = '';
        costEl.textContent = '--';
        noteEl.textContent = '';
        updateSubmitEnabled(false);
        return;
    }
    if (state.mode === 'edit' && txSteps.length === 0) {
        txList.innerHTML = '';
        costEl.textContent = '--';
        state.estimatedCostWei = null;
        noteEl.textContent = 'No changes yet.';
        updateSubmitEnabled(false);
        updateBalanceWarning();
        return;
    }
    updateSubmitEnabled(true);

    if (errors.length > 0) {
        txList.innerHTML = txSteps.map(s => `<li class="flex justify-between gap-2"><span>${Utils.escapeHtml(s.label)}</span><span>--</span></li>`).join('');
        costEl.textContent = '--';
        state.estimatedCostWei = null;
        noteEl.textContent = 'Complete the form to see the estimate.';
        updateBalanceWarning();
        return;
    }

    costEl.textContent = 'Estimating...';
    noteEl.textContent = '';
    try {
        const [estimates, gasPrice] = await Promise.all([
            Promise.all(txSteps.map(step => estimateStepGas(step, form, changes))),
            getExpectedGasPrice()
        ]);
        if (seq !== state.estimateSeq) return;

        let total = ethers.BigNumber.from(0);
        txList.innerHTML = txSteps.map((step, i) => {
            const cost = estimates[i].mul(gasPrice);
            total = total.add(cost);
            return `<li class="flex justify-between gap-2"><span>${Utils.escapeHtml(step.label)}</span><span class="font-mono whitespace-nowrap">${formatPol(cost)}</span></li>`;
        }).join('');
        state.estimatedCostWei = total;
        costEl.textContent = `≈ ${formatPol(total)}`;
        const gwei = parseFloat(ethers.utils.formatUnits(gasPrice, 'gwei')).toFixed(0);
        noteEl.textContent = `At ~${gwei} gwei. ${txSteps.length} ${txSteps.length === 1 ? 'transaction' : 'transactions'}.`;
        updateBalanceWarning();
    } catch (e) {
        if (seq !== state.estimateSeq) return;
        logger.warn('Operator cost estimate failed:', e);
        costEl.textContent = '--';
        state.estimatedCostWei = null;
        noteEl.textContent = `Could not estimate: ${formatTxError(e)}`;
        updateBalanceWarning();
    }
}

// ============================================
// Submission
// ============================================

async function sendTx(buildTx) {
    const signer = window.appSigner;
    if (!signer) throw new Error('Wallet not connected.');
    return Services.executeWithFallback(async (currentSigner) => {
        const overrides = await Services.getGasOverrides(currentSigner.provider);
        return buildTx(currentSigner, overrides);
    }, signer);
}

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

async function isFlowIndexed(flow) {
    if (!flow.operatorId) return false;
    const data = await Services.runQuery(`{ operator(id: "${flow.operatorId.toLowerCase()}") { id metadataJsonString operatorsCutFraction } }`);
    const operator = data?.operator;
    if (!operator) return false;
    if (flow.mode === 'create') return true;
    const done = (key) => flow.steps.find(s => s.key === key)?.status === 'done';
    if (done('metadata') && operator.metadataJsonString !== flow.metadataJson) return false;
    if (done('cut') && !ethers.BigNumber.from(operator.operatorsCutFraction).eq(flow.cutFraction)) return false;
    return true;
}

async function runTxStep(step, buildTx) {
    const tx = await sendTx(buildTx);
    step.txHash = tx.hash;
    renderProgress();
    await tx.wait();
}

async function runStep(step, flow) {
    switch (step.key) {
        case 'deploy':
            await runTxStep(step, (signer, overrides) =>
                new ethers.Contract(OPERATOR_FACTORY_ADDRESS, OPERATOR_FACTORY_ABI, signer).deployOperator(
                    flow.cutFraction, flow.tokenName, flow.metadataJson, OPERATOR_DEFAULT_POLICIES, [0, 0, 0], overrides));
            // One operator per wallet: the factory maps the owner to the new contract
            flow.operatorId = (await Services.readWithFallback(() => getReadFactory().operators(flow.owner))).toLowerCase();
            break;
        case 'metadata':
            await runTxStep(step, (signer, overrides) =>
                new ethers.Contract(flow.operatorId, OPERATOR_CONTRACT_ABI, signer).updateMetadata(flow.metadataJson, overrides));
            break;
        case 'cut':
            await runTxStep(step, (signer, overrides) =>
                new ethers.Contract(flow.operatorId, OPERATOR_CONTRACT_ABI, signer).updateOperatorsCutFraction(flow.cutFraction, overrides));
            break;
        case 'index':
            flow.indexed = await waitUntil(() => isFlowIndexed(flow), INDEX_WAIT_TIMEOUT_MS, INDEX_WAIT_INTERVAL_MS);
            break;
    }
}

function showSuccess(flow) {
    const box = $('operator-form-success');
    if (!box) return;
    box.classList.remove('hidden');
    $('operator-form-success-title').textContent = flow.mode === 'create' ? 'Operator created' : 'Changes saved';
    $('operator-form-success-text').textContent = flow.mode === 'create'
        ? 'Next steps: delegate DATA to your operator (self-delegation), set up your node(s) and stake into sponsorships.'
        : (flow.indexed ? 'The operator page shows the new values.' : 'The subgraph is still indexing: the operator page may take a moment to show the new values.');
    const link = $('operator-form-success-link');
    link.href = `/operator/${flow.operatorId}`;
    link.classList.toggle('hidden', flow.mode !== 'create');
    box.scrollIntoView({ block: 'nearest' });
}

async function handleSubmit() {
    if (state.submitting) return;

    // Finished flow: the button closes the modal
    if (state.flow?.finished) {
        closeModal();
        return;
    }
    showError('');

    if (!state.flow) {
        const form = readForm();
        const errors = validateForm(form);
        if (errors.length > 0) {
            showError(errors.join(' '));
            return;
        }
        const changes = planChanges(form);
        const steps = planSteps(changes);
        if (!steps.length) return;
        state.flow = {
            mode: state.mode,
            owner: state.owner,
            operatorId: state.mode === 'edit' ? state.edit.operatorId : null,
            tokenName: state.mode === 'create' ? operatorTokenName() : null,
            metadataJson: changes.metadataJson,
            cutFraction: percentToCutFraction(form.cut),
            steps
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
            renderProgress();
        }

        flow.finished = true;
        state.submitting = false;
        showSuccess(flow);
        setSubmitState('Close', false);
        if (flow.mode === 'edit') state.edit?.onSaved?.();
        UI.showToast({
            type: 'success',
            title: flow.mode === 'create' ? 'Operator Created' : 'Operator Updated',
            message: flow.mode === 'create' ? 'Your operator contract was deployed.' : 'The operator settings were updated.',
            txHash: flow.steps.filter(s => s.txHash).pop()?.txHash,
            duration: 8000
        });
    } catch (e) {
        logger.error('Operator flow failed:', e);
        const failed = flow.steps.find(s => s.status === 'active');
        if (failed) failed.status = 'error';
        renderProgress();
        state.submitting = false;
        showError(formatTxError(e));
        // Steps already done are kept: Retry continues from the failed step
        const anyDone = flow.steps.some(s => s.status === 'done');
        setSubmitState(anyDone ? 'Retry' : submitLabel(), false);
        if (!anyDone) {
            state.flow = null;
            $('operator-form-progress')?.classList.add('hidden');
            setFormLocked(false);
        }
    }
}

// ============================================
// Modal lifecycle
// ============================================

function fillForm(metadata, cutPercent) {
    $('operator-form-name').value = typeof metadata.name === 'string' ? metadata.name : '';
    $('operator-form-description').value = typeof metadata.description === 'string' ? metadata.description : '';
    $('operator-form-image').value = typeof metadata.imageIpfsCid === 'string' ? metadata.imageIpfsCid : '';
    $('operator-form-cut').value = cutPercent;
    const redundancy = parseInt(metadata.redundancyFactor, 10);
    $('operator-form-redundancy').value = String(Number.isInteger(redundancy) && redundancy >= 1 ? redundancy : 1);
    for (const field of LINK_FIELDS) {
        // Older metadata may only have "twitter"
        const value = metadata[field.key] ?? (field.key === 'x' ? metadata.twitter : undefined);
        $(field.input).value = typeof value === 'string' ? value : '';
    }
    const hasLinks = LINK_FIELDS.some(field => $(field.input).value);
    $('operator-form-links').open = hasLinks;
}

function resetForm() {
    state.flow = null;
    state.submitting = false;
    state.estimatedCostWei = null;
    state.balanceWei = null;

    const isEdit = state.mode === 'edit';
    $('operator-form-title').textContent = isEdit ? 'Edit Operator' : 'Create Operator';
    $('operator-form-intro').classList.toggle('hidden', isEdit);
    $('operator-form-progress').classList.add('hidden');
    $('operator-form-success').classList.add('hidden');
    showError('');

    if (isEdit) {
        fillForm(state.edit.metadata, state.edit.cutPercent);
    } else {
        fillForm({ redundancyFactor: 1 }, '10');
    }
    renderImagePreview();
    renderExistingOperator();
    setFormLocked(false);
    setSubmitState(submitLabel(), false);
}

async function openModal(mode) {
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
        logger.error('Failed to read wallet address:', e);
        UI.showToast({ type: 'error', title: 'Wallet Error', message: 'Could not read the wallet address.', duration: 5000 });
        return;
    }

    state.mode = mode;
    state.existingOperator = null;
    if (mode === 'create') state.edit = null;

    resetForm();
    $('operatorFormModal').classList.remove('hidden');
    $('operator-form-body').scrollTop = 0; // only works once the modal is visible

    if (mode === 'create') {
        // One operator per wallet: show the existing one instead of a failing transaction
        try {
            const existing = await Services.readWithFallback(() => getReadFactory().operators(state.owner));
            if (existing && existing !== ethers.constants.AddressZero) {
                state.existingOperator = existing.toLowerCase();
                renderExistingOperator();
            }
        } catch (e) {
            logger.warn('Could not check for an existing operator:', e);
        }
        $('operator-form-name')?.focus();
    }
    updateEstimate();
}

/**
 * Open the modal in edit mode
 * @param {Object} operator - operator from the subgraph (id, metadataJsonString, operatorsCutFraction, stakes)
 * @param {Function} onSaved - called after the changes are saved
 */
function openEdit(operator, onSaved) {
    const stakedWei = (operator.stakes || []).reduce((sum, s) => sum.add(ethers.BigNumber.from(s.amountWei || '0')), ethers.BigNumber.from(0));
    state.edit = {
        operatorId: operator.id.toLowerCase(),
        metadata: parseMetadataObject(operator.metadataJsonString),
        cutPercent: cutFractionToPercent(operator.operatorsCutFraction),
        cutLocked: stakedWei.gt(0),
        onSaved
    };
    openModal('edit');
}

function closeModal() {
    if (state.submitting) return; // don't close while a transaction is in flight
    const flow = state.flow;
    if (flow && !flow.finished && flow.steps.some(s => s.status === 'done' && !s.noTx)) {
        UI.showToast({
            type: 'warning',
            title: flow.mode === 'create' ? 'Operator Deployed' : 'Changes Partially Saved',
            message: flow.mode === 'create' ? 'The operator was deployed, but not all steps finished.' : 'Not all changes were saved.',
            duration: 10000
        });
        if (flow.mode === 'edit') state.edit?.onSaved?.();
    }
    state.flow = null;
    $('operatorFormModal')?.classList.add('hidden');
}

function onFormChanged() {
    renderImagePreview();
    debouncedEstimate();
}

function setupListeners() {
    if (state.listenersSetup) return;
    state.listenersSetup = true;

    $('operators-create-btn')?.addEventListener('click', () => openModal('create'));
    $('operator-form-close')?.addEventListener('click', closeModal);
    $('operator-form-cancel')?.addEventListener('click', closeModal);
    $('operator-form-submit')?.addEventListener('click', handleSubmit);
    $('operator-form-body')?.addEventListener('input', onFormChanged);

    // Links to the operator page close the modal (the router handles the navigation)
    ['operator-form-existing-link', 'operator-form-success-link'].forEach(id => {
        $(id)?.addEventListener('click', () => {
            state.flow = null;
            state.submitting = false;
            $('operatorFormModal')?.classList.add('hidden');
        });
    });

    $('operatorFormModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'operatorFormModal') closeModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !$('operatorFormModal')?.classList.contains('hidden')) closeModal();
    });
}

// ============================================
// Public API
// ============================================

export const OperatorForm = {
    /**
     * Wire up the buttons and modal (once)
     */
    setup() {
        setupListeners();
        this.updateButtonState();
    },

    /**
     * Enable the "Create Operator" button only when a wallet is connected (MetaMask or private key)
     */
    updateButtonState() {
        const btn = $('operators-create-btn');
        if (!btn) return;
        const connected = Boolean(window.appSigner);
        btn.disabled = !connected;
        btn.title = connected ? 'Create a new operator' : 'Connect a wallet (MetaMask or private key) to create an operator';
    },

    openEdit
};
