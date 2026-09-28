/**
 * Create Stream Feature Module
 * Modal on /streams to create a new stream on-chain (StreamRegistry on Polygon):
 * stream ID (address or ENS domain + path), description, partitions, access/permissions,
 * storage nodes + TTL (storageDays), POL cost estimate and step-by-step submission.
 */

import * as Utils from '../core/utils.js';
import * as UI from '../ui/ui.js';
import * as Services from '../core/services.js';
import {
    STREAM_REGISTRY_ADDRESS,
    STREAM_REGISTRY_ABI,
    STREAM_STORAGE_REGISTRY_ADDRESS,
    STREAM_STORAGE_REGISTRY_ABI,
    ENS_CACHE_ABI,
    PUBLIC_PERMISSION_ADDRESS,
    MAX_STREAM_PARTITIONS,
    DEFAULT_STORAGE_DAYS
} from '../core/constants.js';

const { logger } = Utils;

// ============================================
// Constants
// ============================================

const PERMISSION_KEYS = ['publish', 'subscribe', 'edit', 'delete', 'grant'];

// Allowed characters in the stream path (same check as StreamRegistry contract)
const STREAM_PATH_REGEX = /^[A-Za-z0-9_.\-\/]+$/;

// Gas used by transactions that can't be estimated before the stream exists (approximations)
const APPROX_GAS = {
    permissionsBase: 60000,
    permissionsPerUser: 40000,
    storageBase: 70000,
    storagePerNode: 50000
};

const ENS_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const ENS_WAIT_INTERVAL_MS = 3000;
const INDEX_WAIT_TIMEOUT_MS = 60 * 1000;
const INDEX_WAIT_INTERVAL_MS = 3000;

const ACCESS_HINTS = {
    'private': 'Only you and the addresses below can publish or subscribe.',
    'public-subscribe': 'Anyone can subscribe (read). Only you and the addresses below can publish.',
    'public-publish': 'Anyone can publish (write). Only you and the addresses below can subscribe.',
    'public-all': 'Anyone can publish and subscribe.'
};

// ============================================
// State
// ============================================

const state = {
    owner: null,                  // connected wallet address (lowercase)
    access: 'public-subscribe',
    permRows: [],                 // { id, address, publish, subscribe, edit, delete, grant }
    nextRowId: 1,
    storageNodes: [],             // { address, label }
    knownNodes: null,             // storage nodes from the subgraph (cached)
    ensCacheAddress: null,
    nameAvailable: null,          // true / false / null (unknown)
    ensVerified: null,            // true if ENS name is in Streamr's ENS cache for this wallet
    checkSeq: 0,                  // guards async stream-ID checks against stale results
    estimateSeq: 0,               // guards async estimates against stale results
    flow: null,                   // in-progress submission (kept for retry)
    submitting: false,
    listenersSetup: false
};

const debouncedCheckStreamId = Utils.debounce(() => checkStreamId(), 400);
const debouncedEstimate = Utils.debounce(() => updateEstimate(), 600);

// ============================================
// Helpers
// ============================================

const $ = (id) => document.getElementById(id);

function getReadRegistry() {
    return new ethers.Contract(STREAM_REGISTRY_ADDRESS, STREAM_REGISTRY_ABI, Services.getReadOnlyProvider());
}

function isEnsName(name) {
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name);
}

/**
 * Read form values into a normalized object
 */
function readForm() {
    const domainMode = $('create-stream-domain')?.value === 'ens' ? 'ens' : 'address';
    const ensName = ($('create-stream-ens')?.value || '').trim().toLowerCase();
    const rawName = ($('create-stream-name')?.value || '').trim().replace(/^\/+/, '');
    const description = ($('create-stream-description')?.value || '').trim();
    const partitions = Number($('create-stream-partitions')?.value);
    const storageDays = Number($('create-stream-ttl')?.value);

    const domain = domainMode === 'ens' ? ensName : state.owner;
    const path = rawName ? `/${rawName}` : '';

    return {
        domainMode,
        ensName,
        rawName,
        domain,
        path,
        streamId: domain && path ? `${domain}${path}` : null,
        description,
        partitions,
        storageDays
    };
}

/**
 * Stream metadata JSON (same fields as the Streamr SDK)
 */
function buildMetadata(form) {
    const metadata = { partitions: form.partitions };
    if (form.description) metadata.description = form.description;
    if (state.storageNodes.length > 0) metadata.storageDays = form.storageDays;
    return JSON.stringify(metadata);
}

/**
 * Permission assignments for the contract: public (zero address) + listed addresses.
 * The owner always gets all permissions from the contract itself.
 */
function buildPermissions() {
    const MAX = ethers.constants.MaxUint256;
    const users = [];
    const permissions = [];

    if (state.access !== 'private') {
        const publicPublish = state.access === 'public-publish' || state.access === 'public-all';
        const publicSubscribe = state.access === 'public-subscribe' || state.access === 'public-all';
        users.push(PUBLIC_PERMISSION_ADDRESS);
        permissions.push({
            canEdit: false,
            canDelete: false,
            publishExpiration: publicPublish ? MAX : 0,
            subscribeExpiration: publicSubscribe ? MAX : 0,
            canGrant: false
        });
    }

    for (const row of state.permRows) {
        if (!ethers.utils.isAddress(row.address.trim())) continue;
        users.push(ethers.utils.getAddress(row.address.trim()));
        permissions.push({
            canEdit: row.edit,
            canDelete: row.delete,
            publishExpiration: row.publish ? MAX : 0,
            subscribeExpiration: row.subscribe ? MAX : 0,
            canGrant: row.grant
        });
    }

    return { users, permissions };
}

/**
 * Validate the form. Returns a list of error messages (empty = valid).
 */
function validateForm(form) {
    const errors = [];

    if (form.domainMode === 'ens' && !isEnsName(form.ensName)) {
        errors.push('Enter a valid ENS name (e.g. yourname.eth).');
    }
    if (!form.rawName) {
        errors.push('Enter a stream name.');
    } else if (!STREAM_PATH_REGEX.test(form.rawName)) {
        errors.push('Stream name can only contain letters, numbers and - _ . /');
    }
    if (state.nameAvailable === false) {
        errors.push('A stream with this ID already exists.');
    }
    if (!Number.isInteger(form.partitions) || form.partitions < 1 || form.partitions > MAX_STREAM_PARTITIONS) {
        errors.push(`Partitions must be a whole number between 1 and ${MAX_STREAM_PARTITIONS}.`);
    }
    if (state.storageNodes.length > 0 && (!Number.isInteger(form.storageDays) || form.storageDays < 1)) {
        errors.push('TTL must be a whole number of days (1 or more).');
    }

    const seen = new Set();
    for (const row of state.permRows) {
        const address = row.address.trim();
        if (!address) {
            errors.push('Fill in or remove the empty address row.');
            continue;
        }
        if (!ethers.utils.isAddress(address)) {
            errors.push(`Invalid address: ${address}`);
            continue;
        }
        const lower = address.toLowerCase();
        if (lower === state.owner) {
            errors.push('You are the owner and already have all permissions - remove your own address.');
        } else if (lower === PUBLIC_PERMISSION_ADDRESS) {
            errors.push('Use the Access options above for public permissions.');
        } else if (seen.has(lower)) {
            errors.push(`Duplicate address: ${Utils.shortAddress(address)}`);
        }
        seen.add(lower);
        if (!PERMISSION_KEYS.some(key => row[key])) {
            errors.push(`Select at least one permission for ${Utils.shortAddress(address)}.`);
        }
    }

    return errors;
}

/**
 * Human readable error from a contract/wallet error
 */
function formatTxError(error) {
    const text = `${error?.reason || ''} ${error?.error?.message || ''} ${error?.data?.message || ''} ${error?.message || ''}`;
    if (error?.code === 4001 || error?.code === 'ACTION_REJECTED') return 'Transaction rejected in your wallet.';
    if (text.includes('error_streamAlreadyExists')) return 'A stream with this ID already exists.';
    if (text.includes('error_invalidPathChars')) return 'Stream name contains invalid characters.';
    if (text.includes('error_storageNodeNotRegistered')) return 'One of the storage nodes is not registered in the Storage Node Registry.';
    if (text.includes('error_noEditPermission')) return 'This wallet has no edit permission on the stream.';
    if (text.includes('error_noSharePermission')) return 'This wallet has no grant permission on the stream.';
    if (text.toLowerCase().includes('insufficient funds')) return 'Insufficient POL to pay for gas.';
    if (Services.isRateLimitError(error)) return 'RPC rate limited. Please try again in a few seconds.';
    return Utils.getFriendlyErrorMessage(error);
}

function formatPol(wei) {
    const value = parseFloat(ethers.utils.formatEther(wei));
    if (value === 0) return '0 POL';
    if (value < 0.0001) return '< 0.0001 POL';
    return `${value.toFixed(4)} POL`;
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
// Rendering
// ============================================

function renderDomainOptions() {
    const select = $('create-stream-domain');
    if (!select) return;
    select.innerHTML = `
        <option value="address">${Utils.escapeHtml(Utils.shortAddress(state.owner))} (your address)</option>
        <option value="ens">ENS name...</option>
    `;
    select.value = 'address';
}

function renderAccess() {
    const container = $('create-stream-access');
    if (!container) return;
    container.querySelectorAll('button[data-access]').forEach(btn => {
        const active = btn.dataset.access === state.access;
        btn.classList.toggle('bg-blue-600', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('text-gray-400', !active);
    });
    const hint = $('create-stream-access-hint');
    if (hint) hint.textContent = ACCESS_HINTS[state.access];
}

function renderPermRows() {
    const tbody = $('create-stream-perms-tbody');
    if (!tbody) return;

    const checkIcon = `<svg class="w-4 h-4 text-green-400 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`;
    const ownerRow = `
        <tr>
            <td class="px-3 py-2">
                <span class="font-mono text-xs text-gray-300" title="${Utils.escapeHtml(state.owner)}">${Utils.escapeHtml(Utils.shortAddress(state.owner))}</span>
                <span class="ml-1 px-1.5 py-0.5 text-[10px] font-semibold bg-blue-500/20 text-blue-400 rounded">OWNER</span>
            </td>
            ${PERMISSION_KEYS.map(() => `<td class="px-2 py-2 text-center">${checkIcon}</td>`).join('')}
            <td class="px-2 py-2"></td>
        </tr>
    `;

    // Public row (read-only) reflecting the selected access preset
    const xIcon = `<svg class="w-4 h-4 text-gray-600 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>`;
    let publicRow = '';
    if (state.access !== 'private') {
        const publicPerms = {
            publish: state.access === 'public-publish' || state.access === 'public-all',
            subscribe: state.access === 'public-subscribe' || state.access === 'public-all',
            edit: false,
            delete: false,
            grant: false
        };
        publicRow = `
            <tr>
                <td class="px-3 py-2">
                    <span class="text-xs text-blue-400 font-medium">Public</span>
                    <span class="ml-1 text-[10px] text-gray-500">(anyone)</span>
                </td>
                ${PERMISSION_KEYS.map(key => `<td class="px-2 py-2 text-center">${publicPerms[key] ? checkIcon : xIcon}</td>`).join('')}
                <td class="px-2 py-2"></td>
            </tr>
        `;
    }

    const rows = state.permRows.map(row => `
        <tr data-row-id="${row.id}">
            <td class="px-3 py-2">
                <input type="text" data-field="address" value="${Utils.escapeHtml(row.address)}" placeholder="0x..." autocomplete="off" spellcheck="false"
                    class="w-full min-w-[180px] p-1.5 bg-[#121212] border border-[#333] rounded text-white text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500/50">
            </td>
            ${PERMISSION_KEYS.map(key => `
                <td class="px-2 py-2 text-center">
                    <input type="checkbox" data-field="${key}" ${row[key] ? 'checked' : ''} class="w-4 h-4 accent-blue-600 cursor-pointer">
                </td>
            `).join('')}
            <td class="px-2 py-2 text-center">
                <button type="button" data-action="remove-row" class="p-1 text-gray-500 hover:text-red-400 transition-colors" title="Remove">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
            </td>
        </tr>
    `).join('');

    tbody.innerHTML = ownerRow + publicRow + rows;
}

function nodeLabel(node) {
    let name = null;
    let host = null;
    try {
        const meta = JSON.parse(node.metadata || '{}');
        if (typeof meta.name === 'string') name = meta.name;
        const url = Array.isArray(meta.urls) ? meta.urls[0] : meta.http;
        if (typeof url === 'string') host = new URL(url).host;
    } catch (e) { /* ignore */ }
    return name || host || Utils.shortAddress(node.id);
}

function renderStorageSelect() {
    const select = $('create-stream-storage-select');
    if (!select) return;
    if (!state.knownNodes) {
        select.innerHTML = '<option value="">Loading storage nodes...</option>';
        return;
    }
    const selected = new Set(state.storageNodes.map(n => n.address));
    const available = state.knownNodes.filter(n => !selected.has(n.id.toLowerCase()));
    select.innerHTML = available.length === 0
        ? '<option value="">No more registered storage nodes</option>'
        : '<option value="">Select a registered storage node...</option>' + available.map(n =>
            `<option value="${Utils.escapeHtml(n.id.toLowerCase())}">${Utils.escapeHtml(nodeLabel(n))} (${Utils.escapeHtml(Utils.shortAddress(n.id))})</option>`
        ).join('');
}

function renderStorageList() {
    const list = $('create-stream-storage-list');
    if (!list) return;
    list.innerHTML = state.storageNodes.map(node => `
        <div class="flex items-center justify-between gap-3 p-2.5 bg-[#252525] rounded-lg">
            <div class="min-w-0">
                ${node.label !== Utils.shortAddress(node.address) ? `<span class="text-sm text-white mr-2">${Utils.escapeHtml(node.label)}</span>` : ''}
                <span class="font-mono text-xs text-gray-500" title="${Utils.escapeHtml(node.address)}">${Utils.escapeHtml(Utils.shortAddress(node.address))}</span>
            </div>
            <button type="button" data-remove-node="${Utils.escapeHtml(node.address)}" class="p-1 text-gray-500 hover:text-red-400 transition-colors flex-shrink-0" title="Remove">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
        </div>
    `).join('');

    $('create-stream-ttl-wrapper')?.classList.toggle('hidden', state.storageNodes.length === 0);
    renderStorageSelect();
}

function renderIdPreview() {
    const form = readForm();
    const preview = $('create-stream-id-preview');
    if (preview) preview.textContent = form.streamId || '--';
}

// ============================================
// Async checks
// ============================================

/**
 * Check stream ID availability (and ENS cache ownership when using an ENS domain)
 */
async function checkStreamId() {
    const seq = ++state.checkSeq;
    const form = readForm();

    // ENS status
    if (form.domainMode === 'ens') {
        if (!form.ensName) {
            setStatus('create-stream-ens-status', '', null);
        } else if (!isEnsName(form.ensName)) {
            setStatus('create-stream-ens-status', 'Not a valid ENS name.', 'error');
        } else {
            try {
                const owner = await Services.readWithFallback(async () => {
                    if (!state.ensCacheAddress) {
                        state.ensCacheAddress = await getReadRegistry().ensCache();
                    }
                    const ensCache = new ethers.Contract(state.ensCacheAddress, ENS_CACHE_ABI, Services.getReadOnlyProvider());
                    return ensCache.owners(form.ensName);
                });
                if (seq !== state.checkSeq) return;
                state.ensVerified = owner.toLowerCase() === state.owner;
                if (state.ensVerified) {
                    setStatus('create-stream-ens-status', 'Verified in Streamr\'s ENS cache for this wallet - the stream is created immediately.', 'ok');
                } else {
                    setStatus('create-stream-ens-status', 'Not yet verified for this wallet. Streamr checks ENS ownership off-chain: creation can take a few minutes, and the stream is not created if this wallet does not own the name.', 'warn');
                }
            } catch (e) {
                logger.warn('ENS cache check failed:', e);
                if (seq === state.checkSeq) setStatus('create-stream-ens-status', 'Could not check the ENS name.', 'warn');
            }
        }
    } else {
        state.ensVerified = null;
        setStatus('create-stream-ens-status', '', null);
    }

    // Name availability
    const nameValid = form.rawName && STREAM_PATH_REGEX.test(form.rawName)
        && (form.domainMode === 'address' || isEnsName(form.ensName));
    if (!nameValid) {
        state.nameAvailable = null;
        if (form.rawName && !STREAM_PATH_REGEX.test(form.rawName)) {
            setStatus('create-stream-name-status', 'Invalid characters in the stream name.', 'error');
        } else {
            setStatus('create-stream-name-status', '', null);
        }
        debouncedEstimate();
        return;
    }

    setStatus('create-stream-name-status', 'Checking availability...', 'info');
    try {
        const exists = await Services.readWithFallback(() => getReadRegistry().exists(form.streamId));
        if (seq !== state.checkSeq) return;
        state.nameAvailable = !exists;
        setStatus('create-stream-name-status', exists ? 'A stream with this ID already exists.' : 'Available', exists ? 'error' : 'ok');
    } catch (e) {
        logger.warn('Stream ID check failed:', e);
        if (seq !== state.checkSeq) return;
        state.nameAvailable = null;
        setStatus('create-stream-name-status', 'Could not check availability.', 'warn');
    }
    debouncedEstimate();
}

/**
 * Load registered storage nodes from the subgraph (once per session)
 */
async function loadKnownNodes() {
    if (state.knownNodes) {
        renderStorageSelect();
        return;
    }
    try {
        const data = await Services.runQuery(`{
            nodes(first: 200, orderBy: lastSeen, orderDirection: desc) {
                id
                metadata
                lastSeen
            }
        }`);
        state.knownNodes = data.nodes || [];
    } catch (e) {
        logger.error('Failed to load storage nodes:', e);
        state.knownNodes = [];
    }
    renderStorageSelect();
}

/**
 * Transactions that will be sent, in order
 */
function planSteps(form, users) {
    const steps = [];
    if (form.domainMode === 'ens') {
        steps.push({ key: 'create', label: 'Create stream (ENS)' });
        steps.push({ key: 'ens-wait', label: 'Wait for ENS ownership verification', noTx: true });
        if (users.length > 0) steps.push({ key: 'permissions', label: `Set permissions (${users.length} ${users.length === 1 ? 'entry' : 'entries'})` });
    } else {
        steps.push({
            key: 'create',
            label: users.length > 0 ? `Create stream with permissions (${users.length} ${users.length === 1 ? 'entry' : 'entries'})` : 'Create stream'
        });
    }
    if (state.storageNodes.length > 0) {
        steps.push({ key: 'storage', label: `Add ${state.storageNodes.length} storage ${state.storageNodes.length === 1 ? 'node' : 'nodes'}` });
    }
    steps.push({ key: 'index', label: 'Wait for the stream to be indexed', noTx: true });
    return steps;
}

/**
 * Estimate gas and POL cost of all transactions
 */
async function updateEstimate() {
    const seq = ++state.estimateSeq;
    const txList = $('create-stream-tx-list');
    const costEl = $('create-stream-cost');
    const noteEl = $('create-stream-cost-note');
    const balanceEl = $('create-stream-balance');
    if (!txList || !costEl) return;

    const form = readForm();
    const errors = validateForm(form);
    const { users, permissions } = buildPermissions();
    const txSteps = planSteps(form, users).filter(s => !s.noTx);

    const provider = Services.getReadOnlyProvider();

    // Balance (independent of the form)
    Services.readWithFallback(() => Services.getReadOnlyProvider().getBalance(state.owner))
        .then(balance => {
            if (seq !== state.estimateSeq) return;
            state.balanceWei = balance;
            balanceEl.textContent = formatPol(balance);
            updateBalanceWarning();
        })
        .catch(() => { balanceEl.textContent = 'N/A'; });

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
        const registry = getReadRegistry();
        const metadata = buildMetadata(form);
        const gasByStep = {};
        let approximate = false;

        // Create transaction: real estimate (simulated from the owner's address)
        if (form.domainMode === 'ens') {
            gasByStep.create = await Services.readWithFallback(() =>
                registry.estimateGas.createStreamWithENS(form.ensName, form.path, metadata, { from: state.owner }));
            if (users.length > 0) {
                gasByStep.permissions = ethers.BigNumber.from(APPROX_GAS.permissionsBase + APPROX_GAS.permissionsPerUser * users.length);
                approximate = true;
            }
        } else {
            gasByStep.create = await Services.readWithFallback(() =>
                registry.estimateGas.createStreamWithPermissions(form.path, metadata, users, permissions, { from: state.owner }));
        }

        // Storage transaction can only be estimated once the stream exists
        if (state.storageNodes.length > 0) {
            gasByStep.storage = ethers.BigNumber.from(APPROX_GAS.storageBase + APPROX_GAS.storagePerNode * state.storageNodes.length);
            approximate = true;
        }

        // Expected price: base fee + priority fee (capped at the max fee we send)
        const [feeData, overrides] = await Promise.all([
            Services.readWithFallback(() => provider.getFeeData()),
            Services.getGasOverrides(provider)
        ]);
        let gasPrice = overrides.maxFeePerGas;
        if (feeData.lastBaseFeePerGas) {
            const expected = feeData.lastBaseFeePerGas.add(overrides.maxPriorityFeePerGas);
            if (expected.lt(gasPrice)) gasPrice = expected;
        }

        if (seq !== state.estimateSeq) return;

        let total = ethers.BigNumber.from(0);
        txList.innerHTML = txSteps.map(step => {
            const gas = gasByStep[step.key];
            const cost = gas.mul(gasPrice);
            total = total.add(cost);
            const isApprox = step.key !== 'create';
            return `<li class="flex justify-between gap-2"><span>${Utils.escapeHtml(step.label)}</span><span class="font-mono whitespace-nowrap">${isApprox ? '~' : ''}${formatPol(cost)}</span></li>`;
        }).join('');

        state.estimatedCostWei = total;
        costEl.textContent = `≈ ${formatPol(total)}`;
        const gwei = parseFloat(ethers.utils.formatUnits(gasPrice, 'gwei')).toFixed(0);
        noteEl.textContent = `At ~${gwei} gwei. ${txSteps.length} ${txSteps.length === 1 ? 'transaction' : 'transactions'}.`
            + (approximate ? ' Values marked ~ are approximate (they can only be estimated after the stream exists).' : '');
        updateBalanceWarning();
    } catch (e) {
        if (seq !== state.estimateSeq) return;
        logger.warn('Cost estimate failed:', e);
        const message = formatTxError(e);
        if (message === 'A stream with this ID already exists.') {
            state.nameAvailable = false;
            setStatus('create-stream-name-status', message, 'error');
        }
        costEl.textContent = '--';
        state.estimatedCostWei = null;
        noteEl.textContent = `Could not estimate: ${message}`;
        updateBalanceWarning();
    }
}

function updateBalanceWarning() {
    const balanceEl = $('create-stream-balance');
    if (!balanceEl) return;
    const insufficient = state.balanceWei && state.estimatedCostWei && state.balanceWei.lt(state.estimatedCostWei);
    balanceEl.classList.toggle('text-red-400', Boolean(insufficient));
    balanceEl.classList.toggle('text-gray-400', !insufficient);
    balanceEl.title = insufficient ? 'Balance is lower than the estimated cost' : '';
}

// ============================================
// Submission
// ============================================

function renderProgress() {
    const container = $('create-stream-progress');
    const list = $('create-stream-progress-list');
    if (!container || !list || !state.flow) return;
    container.classList.remove('hidden');

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

function setFormLocked(locked) {
    const form = $('create-stream-form');
    if (!form) return;
    form.querySelectorAll('input, select, textarea, button').forEach(el => { el.disabled = locked; });
}

function setSubmitState(label, busy) {
    const btn = $('create-stream-submit');
    if (!btn) return;
    btn.disabled = busy;
    btn.innerHTML = busy
        ? `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent animate-spin"></div><span>${Utils.escapeHtml(label)}</span>`
        : Utils.escapeHtml(label);
}

function showError(message) {
    const el = $('create-stream-error');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
}

async function sendTx(buildTx) {
    const signer = window.appSigner;
    if (!signer) throw new Error('Wallet not connected.');
    return Services.executeWithFallback(async (currentSigner) => {
        const overrides = await Services.getGasOverrides(currentSigner.provider);
        const tx = await buildTx(currentSigner, overrides);
        return tx;
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

async function runStep(step, flow) {
    switch (step.key) {
        case 'create': {
            const tx = await sendTx((signer, overrides) => {
                const registry = new ethers.Contract(STREAM_REGISTRY_ADDRESS, STREAM_REGISTRY_ABI, signer);
                return flow.domainMode === 'ens'
                    ? registry.createStreamWithENS(flow.ensName, flow.path, flow.metadata, overrides)
                    : registry.createStreamWithPermissions(flow.path, flow.metadata, flow.users, flow.permissions, overrides);
            });
            step.txHash = tx.hash;
            renderProgress();
            await tx.wait();
            break;
        }
        case 'ens-wait': {
            const created = await waitUntil(
                () => Services.readWithFallback(() => getReadRegistry().exists(flow.streamId)),
                ENS_WAIT_TIMEOUT_MS,
                ENS_WAIT_INTERVAL_MS
            );
            if (!created) {
                throw new Error('ENS verification is taking longer than expected. If this wallet owns the ENS name, the stream should appear in a few minutes - click Retry to keep waiting.');
            }
            break;
        }
        case 'permissions': {
            const tx = await sendTx((signer, overrides) => {
                const registry = new ethers.Contract(STREAM_REGISTRY_ADDRESS, STREAM_REGISTRY_ABI, signer);
                return registry.setPermissions(flow.streamId, flow.users, flow.permissions, overrides);
            });
            step.txHash = tx.hash;
            renderProgress();
            await tx.wait();
            break;
        }
        case 'storage': {
            const tx = await sendTx((signer, overrides) => {
                const storageRegistry = new ethers.Contract(STREAM_STORAGE_REGISTRY_ADDRESS, STREAM_STORAGE_REGISTRY_ABI, signer);
                return storageRegistry.addAndRemoveStorageNodes(flow.streamId, flow.storageNodes, [], overrides);
            });
            step.txHash = tx.hash;
            renderProgress();
            await tx.wait();
            break;
        }
        case 'index': {
            const sanitizedId = flow.streamId.replace(/"/g, '\\"');
            flow.indexed = await waitUntil(async () => {
                const data = await Services.runQuery(`{ stream(id: "${sanitizedId}") { id } }`);
                return Boolean(data.stream);
            }, INDEX_WAIT_TIMEOUT_MS, INDEX_WAIT_INTERVAL_MS);
            break;
        }
    }
}

async function handleSubmit() {
    if (state.submitting) return;
    showError('');

    // Start a new flow, or resume the one that failed
    if (!state.flow) {
        const form = readForm();
        const errors = validateForm(form);
        if (errors.length > 0) {
            showError(errors.join(' '));
            return;
        }
        const { users, permissions } = buildPermissions();
        state.flow = {
            domainMode: form.domainMode,
            ensName: form.ensName,
            path: form.path,
            streamId: form.streamId,
            metadata: buildMetadata(form),
            users,
            permissions,
            storageNodes: state.storageNodes.map(n => ethers.utils.getAddress(n.address)),
            steps: planSteps(form, users).map(s => ({ ...s, status: 'pending' })),
            indexed: false
        };
    }

    const flow = state.flow;
    state.submitting = true;
    setFormLocked(true);
    setSubmitState('Creating...', true);
    renderProgress();

    for (const step of flow.steps) {
        if (step.status === 'done') continue;
        step.status = 'active';
        renderProgress();
        try {
            await runStep(step, flow);
            step.status = 'done';
            renderProgress();
        } catch (error) {
            logger.error(`Create stream step "${step.key}" failed:`, error);
            step.status = 'error';
            renderProgress();
            showError(formatTxError(error));
            state.submitting = false;

            const streamCreated = flow.steps.find(s => s.key === 'create')?.status === 'done';
            if (streamCreated) {
                // Stream exists: keep the form locked, allow retrying the remaining steps
                setSubmitState('Retry', false);
            } else {
                // Nothing on-chain yet: allow editing the form again
                state.flow = null;
                setFormLocked(false);
                setSubmitState('Create Stream', false);
                $('create-stream-progress')?.classList.add('hidden');
            }
            return;
        }
    }

    state.submitting = false;
    const streamId = flow.streamId;
    closeModal();

    UI.showToast({
        type: 'success',
        title: 'Stream Created',
        message: flow.indexed
            ? Utils.escapeHtml(streamId)
            : `${Utils.escapeHtml(streamId)} - it may take a minute to appear in the list.`,
        duration: 8000
    });

    if (flow.indexed) {
        const encodedStreamId = streamId.split('/').map(part => encodeURIComponent(part)).join('/');
        window.router.navigate(`/stream/${encodedStreamId}`);
    }
}

// ============================================
// Modal lifecycle
// ============================================

function resetForm() {
    state.access = 'public-subscribe';
    state.permRows = [];
    state.storageNodes = [];
    state.nameAvailable = null;
    state.ensVerified = null;
    state.flow = null;
    state.submitting = false;
    state.estimatedCostWei = null;
    state.balanceWei = null;

    $('create-stream-ens').value = '';
    $('create-stream-name').value = '';
    $('create-stream-description').value = '';
    $('create-stream-partitions').value = '1';
    $('create-stream-ttl').value = String(DEFAULT_STORAGE_DAYS);
    $('create-stream-storage-custom').value = '';
    $('create-stream-ens-wrapper').classList.add('hidden');
    $('create-stream-progress').classList.add('hidden');
    setStatus('create-stream-ens-status', '', null);
    setStatus('create-stream-name-status', '', null);
    showError('');
    setFormLocked(false);
    setSubmitState('Create Stream', false);

    renderDomainOptions();
    renderAccess();
    renderPermRows();
    renderStorageList();
    renderIdPreview();
}

function openModal() {
    const signer = window.appSigner;
    if (!signer) {
        UI.showToast({ type: 'warning', title: 'Wallet Required', message: 'Connect MetaMask or a private key to create a stream.', duration: 5000 });
        return;
    }

    const modal = $('createStreamModal');
    if (!modal) return;

    signer.getAddress().then(address => {
        state.owner = address.toLowerCase();
        resetForm();
        modal.classList.remove('hidden');
        loadKnownNodes();
        updateEstimate();
        $('create-stream-name')?.focus();
    }).catch(e => {
        logger.error('Failed to read wallet address:', e);
        UI.showToast({ type: 'error', title: 'Wallet Error', message: 'Could not read the wallet address.', duration: 5000 });
    });
}

function closeModal() {
    if (state.submitting) return; // don't close while a transaction is in flight
    const flow = state.flow;
    if (flow && flow.steps.find(s => s.key === 'create')?.status === 'done' && flow.steps.some(s => s.status !== 'done')) {
        UI.showToast({
            type: 'warning',
            title: 'Stream Partially Configured',
            message: `${Utils.escapeHtml(flow.streamId)} was created, but not all steps finished (permissions/storage).`,
            duration: 10000
        });
    }
    state.flow = null;
    $('createStreamModal')?.classList.add('hidden');
}

function onFormChanged() {
    renderIdPreview();
    debouncedEstimate();
}

function setupListeners() {
    if (state.listenersSetup) return;
    state.listenersSetup = true;

    $('streams-create-btn')?.addEventListener('click', openModal);
    $('create-stream-close')?.addEventListener('click', closeModal);
    $('create-stream-cancel')?.addEventListener('click', closeModal);
    $('create-stream-submit')?.addEventListener('click', handleSubmit);

    // Stream ID
    $('create-stream-domain')?.addEventListener('change', (e) => {
        $('create-stream-ens-wrapper')?.classList.toggle('hidden', e.target.value !== 'ens');
        state.nameAvailable = null;
        onFormChanged();
        debouncedCheckStreamId();
    });
    ['create-stream-ens', 'create-stream-name'].forEach(id => {
        $(id)?.addEventListener('input', () => {
            state.nameAvailable = null;
            onFormChanged();
            debouncedCheckStreamId();
        });
    });
    ['create-stream-description', 'create-stream-partitions', 'create-stream-ttl'].forEach(id => {
        $(id)?.addEventListener('input', onFormChanged);
    });

    // Access presets
    $('create-stream-access')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-access]');
        if (!btn) return;
        state.access = btn.dataset.access;
        renderAccess();
        renderPermRows();
        onFormChanged();
    });

    // Permission rows
    $('create-stream-add-perm')?.addEventListener('click', () => {
        state.permRows.push({ id: state.nextRowId++, address: '', publish: true, subscribe: true, edit: false, delete: false, grant: false });
        renderPermRows();
        const inputs = $('create-stream-perms-tbody')?.querySelectorAll('input[data-field="address"]');
        inputs?.[inputs.length - 1]?.focus();
        onFormChanged();
    });
    const tbody = $('create-stream-perms-tbody');
    tbody?.addEventListener('input', (e) => {
        const tr = e.target.closest('tr[data-row-id]');
        const row = tr && state.permRows.find(r => r.id === Number(tr.dataset.rowId));
        if (!row) return;
        const field = e.target.dataset.field;
        if (field === 'address') {
            row.address = e.target.value;
            const value = e.target.value.trim();
            e.target.classList.toggle('border-red-500/60', value !== '' && !ethers.utils.isAddress(value));
        } else if (PERMISSION_KEYS.includes(field)) {
            row[field] = e.target.checked;
        }
        onFormChanged();
    });
    tbody?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action="remove-row"]');
        if (!btn) return;
        const tr = btn.closest('tr[data-row-id]');
        state.permRows = state.permRows.filter(r => r.id !== Number(tr.dataset.rowId));
        renderPermRows();
        onFormChanged();
    });

    // Storage nodes
    $('create-stream-storage-add-select')?.addEventListener('click', () => {
        const select = $('create-stream-storage-select');
        const address = select?.value;
        if (!address) return;
        const node = state.knownNodes?.find(n => n.id.toLowerCase() === address);
        state.storageNodes.push({ address, label: node ? nodeLabel(node) : Utils.shortAddress(address) });
        renderStorageList();
        onFormChanged();
    });
    $('create-stream-storage-add-custom')?.addEventListener('click', addCustomStorageNode);
    $('create-stream-storage-custom')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addCustomStorageNode();
    });
    $('create-stream-storage-list')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-remove-node]');
        if (!btn) return;
        state.storageNodes = state.storageNodes.filter(n => n.address !== btn.dataset.removeNode);
        renderStorageList();
        onFormChanged();
    });

    // Close on backdrop click / Escape
    $('createStreamModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'createStreamModal') closeModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !$('createStreamModal')?.classList.contains('hidden')) closeModal();
    });
}

/**
 * Add a storage node by address - must be registered in the Storage Node Registry
 */
async function addCustomStorageNode() {
    const input = $('create-stream-storage-custom');
    const value = (input?.value || '').trim();
    if (!value) return;

    if (!ethers.utils.isAddress(value)) {
        showError('Invalid storage node address.');
        return;
    }
    const address = value.toLowerCase();
    if (state.storageNodes.some(n => n.address === address)) {
        showError('This storage node is already added.');
        return;
    }

    showError('');
    let node = state.knownNodes?.find(n => n.id.toLowerCase() === address);
    if (!node) {
        try {
            const data = await Services.runQuery(`{ node(id: "${address}") { id metadata lastSeen } }`);
            node = data.node;
        } catch (e) {
            logger.warn('Storage node lookup failed:', e);
        }
    }
    if (!node) {
        showError('This address is not a registered storage node.');
        return;
    }

    state.storageNodes.push({ address, label: nodeLabel(node) });
    input.value = '';
    renderStorageList();
    onFormChanged();
}

// ============================================
// Public API
// ============================================

export const CreateStream = {
    /**
     * Wire up the button and modal (once)
     */
    setup() {
        setupListeners();
        this.updateButtonState();
    },

    /**
     * Enable the "Create Stream" button only when a wallet is connected (MetaMask or private key)
     */
    updateButtonState() {
        const btn = $('streams-create-btn');
        if (!btn) return;
        const connected = Boolean(window.appSigner);
        btn.disabled = !connected;
        btn.title = connected ? 'Create a new stream' : 'Connect a wallet (MetaMask or private key) to create a stream';
    }
};
