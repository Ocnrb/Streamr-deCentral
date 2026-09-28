/**
 * Create / Edit Operator Feature Module
 * One modal, two modes (same pattern as Create / Edit Stream):
 * - create (button on the operators list): deploys an Operator contract through the OperatorFactory
 *   with the default delegation / exchange rate / undelegation policies.
 * - edit (button on the operator page, owner or controller): updates the metadata and the owner's cut.
 *   Existing metadata keys that the form doesn't manage are preserved.
 * Both modes can host the avatar on a profile stream (optional, see streamAvatar.js):
 * a stream owned by the wallet (only it publishes, anyone reads) with a storage node,
 * Pombo by default. The avatar is published to partition 0 and read back over HTTPS.
 */

import * as Utils from '../core/utils.js';
import * as UI from '../ui/ui.js';
import * as Services from '../core/services.js';
import * as StreamAvatar from '../core/streamAvatar.js';
import {
    OPERATOR_FACTORY_ADDRESS,
    OPERATOR_FACTORY_ABI,
    OPERATOR_DEFAULT_POLICIES,
    OPERATOR_CONTRACT_ABI,
    STREAM_REGISTRY_ADDRESS,
    STREAM_REGISTRY_ABI,
    STREAM_STORAGE_REGISTRY_ADDRESS,
    STREAM_STORAGE_REGISTRY_ABI,
    PUBLIC_PERMISSION_ADDRESS
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
const STORAGE_PICKUP_TIMEOUT_MS = 3 * 60 * 1000;
const AVATAR_VERIFY_TIMEOUT_MS = 90 * 1000;
const AVATAR_POLL_INTERVAL_MS = 3000;
const CUSTOM_STORAGE_OPTION = 'custom';

// Gas of avatar stream transactions that can't be estimated before the stream exists (approximations)
const APPROX_GAS = { avatarStream: 350000, avatarStorage: 120000 };

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
    listenersSetup: false,
    // Avatar stream: { streamId, ownedByUser, loading, exists, storedBy:Set, hasAvatar, currentAvatar, prepared }
    avatar: null,
    storageNodes: null,          // registered storage nodes from the subgraph (cached)
    nodeProbes: new Map()        // storage node address -> Promise<{ urls, reachable, purge, pombo }>
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
        links,
        avatar: {
            enabled: Boolean($('operator-form-avatar-enabled')?.checked),
            storageNode: selectedStorageNode(),
            storageDays: Number($('operator-form-avatar-days')?.value),
            purge: Boolean($('operator-form-avatar-purge')?.checked)
        }
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
    errors.push(...validateAvatar(form.avatar));
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
    setText('imageStreamId', form.avatar.enabled && state.avatar ? state.avatar.streamId : '', text(original.imageStreamId));
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
    const avatar = planAvatar(form);
    if (state.mode === 'create') {
        return { metadataJson, avatar, deploy: true, metadata: false, cut: false };
    }
    const cutChanged = Number(form.cut) !== Number(state.edit.cutPercent);
    return {
        metadataJson,
        avatar,
        deploy: false,
        metadata: metadataJson !== JSON.stringify(state.edit.metadata),
        cut: cutChanged && !state.edit.cutLocked
    };
}

function planSteps(changes) {
    const steps = [];
    // Avatar first: a failure there costs no more than the stream transactions
    const avatar = changes.avatar;
    if (avatar) {
        if (avatar.createStream) steps.push({ key: 'avatar-stream', label: 'Create avatar stream' });
        if (avatar.addStorage) {
            steps.push({ key: 'avatar-storage', label: 'Add the storage node to the avatar stream' });
            steps.push({ key: 'avatar-storage-wait', label: 'Wait for the storage node to pick up the stream', noTx: true, busy: 'Waiting for storage...' });
        }
        if (avatar.publish) {
            steps.push({ key: 'avatar-publish', label: 'Publish the avatar (signed message)', noTx: true, busy: 'Sign in wallet...' });
            steps.push({ key: 'avatar-verify', label: 'Check the avatar is stored', noTx: true, busy: 'Checking storage...' });
        }
        if (avatar.purge) steps.push({ key: 'avatar-purge', label: 'Delete previous avatars (signed request)', noTx: true, busy: 'Sign in wallet...' });
    }
    const operatorSteps = [];
    if (changes.deploy) operatorSteps.push({ key: 'deploy', label: 'Deploy Operator contract' });
    if (changes.metadata) operatorSteps.push({ key: 'metadata', label: 'Update metadata' });
    if (changes.cut) operatorSteps.push({ key: 'cut', label: "Update owner's cut" });
    if (operatorSteps.length) operatorSteps.push({ key: 'index', label: 'Wait for the subgraph to index', noTx: true, busy: 'Waiting for indexing...' });
    return [...steps, ...operatorSteps].map(step => ({ ...step, status: 'pending', txHash: null }));
}

function operatorTokenName() {
    // Same naming as the Streamr Hub; the address is unique per wallet anyway (one operator per wallet)
    return `StreamrOperator-${state.owner.slice(-5)}`;
}

// ============================================
// Avatar stream
// ============================================

function getStreamRegistry(signerOrProvider = Services.getReadOnlyProvider()) {
    return new ethers.Contract(STREAM_REGISTRY_ADDRESS, STREAM_REGISTRY_ABI, signerOrProvider);
}

function getStorageRegistry(signerOrProvider = Services.getReadOnlyProvider()) {
    return new ethers.Contract(STREAM_STORAGE_REGISTRY_ADDRESS, STREAM_STORAGE_REGISTRY_ABI, signerOrProvider);
}

function selectedStorageNode() {
    const value = $('operator-form-avatar-storage')?.value || '';
    if (value !== CUSTOM_STORAGE_OPTION) return value.toLowerCase();
    return ($('operator-form-avatar-storage-custom')?.value || '').trim().toLowerCase();
}

function streamMetadataJson(storageDays) {
    return JSON.stringify({
        partitions: StreamAvatar.PROFILE_STREAM_PARTITIONS,
        storageDays,
        description: 'Operator profile: avatar on partition 0 (deCentral)'
    });
}

// Public subscribe only; the creator gets every permission from the registry
const PUBLIC_SUBSCRIBE_PERMISSION = [false, false, 0, ethers.constants.MaxUint256, false];

/**
 * Probe a storage node: HTTPS endpoints from its registry metadata, reachable from this page
 * (CORS / CSP), and whether it is a Pombo node with purge. Cached per address.
 */
function probeStorageNode(address) {
    if (!state.nodeProbes.has(address)) {
        const promise = (async () => {
            let node = (state.storageNodes || []).find(n => n.id.toLowerCase() === address);
            if (!node) {
                const data = await Services.runQuery(`{ node(id: "${address}") { id metadata } }`);
                node = data?.node;
            }
            if (!node) return { registered: false, urls: [], reachable: false, purge: false, pombo: false };
            const urls = StreamAvatar.storageNodeUrls(node.metadata);
            if (!urls.length) return { registered: true, urls, reachable: false, purge: false, pombo: false };
            try {
                const response = await fetch(`${urls[0]}/capabilities`, { cache: 'no-store' });
                const caps = response.ok ? await response.json().catch(() => null) : null;
                const pombo = caps?.name === 'pombo-storage-node';
                return { registered: true, urls, reachable: true, pombo, purge: pombo && Array.isArray(caps.features) && caps.features.includes('purge') };
            } catch (e) {
                // Network error: unreachable, or blocked by the browser (CORS / Content Security Policy)
                return { registered: true, urls, reachable: false, purge: false, pombo: false };
            }
        })().catch(e => {
            state.nodeProbes.delete(address);
            throw e;
        });
        state.nodeProbes.set(address, promise);
    }
    return state.nodeProbes.get(address);
}

// Settled probe results, so validation stays synchronous
const probeResults = new Map();

function refreshStorageProbe() {
    const address = selectedStorageNode();
    if (!ethers.utils.isAddress(address)) {
        renderStorageStatus();
        return;
    }
    if (probeResults.has(address)) {
        renderStorageStatus();
        return;
    }
    renderStorageStatus();
    probeStorageNode(address).then(result => {
        probeResults.set(address, result);
    }).catch(e => {
        logger.warn('Storage node probe failed:', e);
        probeResults.set(address, { registered: true, urls: [], reachable: false, purge: false, pombo: false, error: true });
    }).finally(() => {
        renderStorageStatus();
        renderAvatarSection();
        debouncedEstimate();
    });
}

function validateAvatar(avatarForm) {
    const av = state.avatar;
    if (!avatarForm.enabled || !av) return [];
    if (av.loading) return ['Checking the avatar stream...'];
    const errors = [];
    const needsWrite = !av.exists || Boolean(av.prepared);
    if (needsWrite && !av.ownedByUser) errors.push('The avatar stream belongs to another wallet: only that wallet can publish to it.');
    if (!av.prepared && !av.hasAvatar) errors.push('Choose an image for the avatar stream.');
    if (!av.exists && (!Number.isInteger(avatarForm.storageDays) || avatarForm.storageDays < 1)) errors.push('Storage days must be a whole number of at least 1.');

    const node = avatarForm.storageNode;
    if (av.prepared || !av.exists) {
        if (!ethers.utils.isAddress(node)) {
            errors.push('Choose a storage node for the avatar stream.');
        } else {
            const probe = probeResults.get(node);
            if (probe && !probe.registered) errors.push('This address is not a registered storage node.');
            else if (probe && !probe.urls.length) errors.push('This storage node has no HTTPS endpoint to read the avatar from.');
            else if (probe && !probe.reachable) errors.push("deCentral can't reach this storage node over HTTPS.");
        }
    } else if (ethers.utils.isAddress(node) && !av.storedBy.has(node)) {
        errors.push('Choose the image again to store it on the new storage node.');
    }
    return errors;
}

/**
 * Avatar stream work for the current form (null when not used or nothing to do)
 */
function planAvatar(form) {
    const av = state.avatar;
    if (!form.avatar.enabled || !av || av.loading) return null;
    const node = form.avatar.storageNode;
    const createStream = !av.exists;
    const publish = Boolean(av.prepared);
    const addStorage = (createStream || publish) && ethers.utils.isAddress(node) && !av.storedBy.has(node);
    const purge = publish && av.hasAvatar && form.avatar.purge && Boolean(probeResults.get(node)?.purge);
    if (!createStream && !publish) return null;
    return { streamId: av.streamId, storageNode: node, storageDays: form.avatar.storageDays, createStream, addStorage, publish, purge };
}

async function loadStorageNodes() {
    if (state.storageNodes) return state.storageNodes;
    try {
        const data = await Services.runQuery(`{
            nodes(first: 200, orderBy: lastSeen, orderDirection: desc) { id metadata }
        }`);
        state.storageNodes = (data?.nodes || []).filter(n => StreamAvatar.storageNodeUrls(n.metadata).length > 0);
    } catch (e) {
        logger.warn('Failed to load storage nodes:', e);
        state.storageNodes = [];
    }
    return state.storageNodes;
}

function storageNodeLabel(node) {
    try {
        const meta = JSON.parse(node.metadata || '{}');
        if (typeof meta.name === 'string' && meta.name) return meta.name;
        const url = StreamAvatar.storageNodeUrls(node.metadata)[0];
        if (url) return new URL(url).host;
    } catch (e) { /* ignore */ }
    return Utils.shortAddress(node.id);
}

function renderStorageOptions(preferred) {
    const select = $('operator-form-avatar-storage');
    if (!select) return;
    const pombo = StreamAvatar.POMBO_STORAGE_NODE;
    const others = (state.storageNodes || []).filter(n => n.id.toLowerCase() !== pombo);
    const options = [`<option value="${pombo}">Pombo storage cluster (default)</option>`]
        .concat(others.map(n => {
            const id = n.id.toLowerCase();
            return `<option value="${Utils.escapeHtml(id)}">${Utils.escapeHtml(storageNodeLabel(n))} (${Utils.escapeHtml(Utils.shortAddress(id))})</option>`;
        }))
        .concat(`<option value="${CUSTOM_STORAGE_OPTION}">Custom address...</option>`);
    select.innerHTML = options.join('');

    const target = (preferred || pombo).toLowerCase();
    if ([...select.options].some(o => o.value === target)) {
        select.value = target;
    } else {
        select.value = CUSTOM_STORAGE_OPTION;
        $('operator-form-avatar-storage-custom').value = target;
    }
    $('operator-form-avatar-storage-custom').classList.toggle('hidden', select.value !== CUSTOM_STORAGE_OPTION);
}

function renderStorageStatus() {
    const address = selectedStorageNode();
    if (!address) return setStatus('operator-form-avatar-storage-status', '', 'info');
    if (!ethers.utils.isAddress(address)) return setStatus('operator-form-avatar-storage-status', 'Not a valid address.', 'error');
    const probe = probeResults.get(address);
    if (!probe) return setStatus('operator-form-avatar-storage-status', 'Checking storage node...', 'info');
    if (probe.error) return setStatus('operator-form-avatar-storage-status', 'Could not check this storage node.', 'warn');
    if (!probe.registered) return setStatus('operator-form-avatar-storage-status', 'Not a registered storage node.', 'error');
    if (!probe.urls.length) return setStatus('operator-form-avatar-storage-status', 'No HTTPS endpoint: the avatar could not be read back.', 'error');
    const host = new URL(probe.urls[0]).host;
    if (!probe.reachable) return setStatus('operator-form-avatar-storage-status', `${host} is not reachable from deCentral.`, 'error');
    setStatus('operator-form-avatar-storage-status', probe.purge ? `${host} · supports deleting old avatars` : host, 'ok');
}

function renderAvatarSection() {
    const av = state.avatar;
    const enabled = Boolean($('operator-form-avatar-enabled')?.checked);
    $('operator-form-avatar-fields')?.classList.toggle('hidden', !enabled);
    if (!av) return;

    $('operator-form-avatar-stream-id').textContent = av.streamId;
    if (av.loading) setStatus('operator-form-avatar-stream-status', 'Checking stream...', 'info');
    else if (!av.exists) setStatus('operator-form-avatar-stream-status', `Will be created: ${StreamAvatar.PROFILE_STREAM_PARTITIONS} partitions, anyone can read, only you can publish.`, 'info');
    else if (!av.ownedByUser) setStatus('operator-form-avatar-stream-status', 'Owned by another wallet: only that wallet can publish a new avatar.', 'warn');
    else setStatus('operator-form-avatar-stream-status', av.hasAvatar ? 'Existing stream with an avatar.' : 'Existing stream, no avatar stored yet.', 'info');

    const days = $('operator-form-avatar-days');
    if (days) days.disabled = Boolean(av.exists) || state.submitting;

    const preview = $('operator-form-avatar-preview');
    if (preview) preview.src = av.prepared?.dataUrl || av.currentAvatar || Utils.OPERATOR_AVATAR_PLACEHOLDER;

    const probe = probeResults.get(selectedStorageNode());
    $('operator-form-avatar-purge-row')?.classList.toggle('hidden', !(av.hasAvatar && av.prepared && probe?.purge));
    renderImagePreview();
}

/**
 * Stream state for the avatar section: which stream, does it exist, which storage nodes, current avatar
 */
async function loadAvatarContext() {
    const metadataStreamId = state.mode === 'edit' ? state.edit.metadata.imageStreamId : null;
    const streamId = StreamAvatar.isValidProfileStreamId(metadataStreamId)
        ? metadataStreamId
        : StreamAvatar.profileStreamIdFor(state.owner);
    const av = {
        streamId,
        ownedByUser: streamId.toLowerCase().startsWith(`${state.owner}/`),
        loading: true,
        exists: false,
        storedBy: new Set(),
        hasAvatar: false,
        currentAvatar: null,
        prepared: null
    };
    state.avatar = av;
    renderAvatarSection();

    const [exists, streamData] = await Promise.all([
        Services.readWithFallback(() => getStreamRegistry().exists(streamId)).catch(e => {
            logger.warn('Could not check the avatar stream:', e);
            return false;
        }),
        Services.runQuery(`{ stream(id: "${streamId}") { storageNodes { id } } }`).catch(() => null),
        loadStorageNodes()
    ]);
    if (state.avatar !== av) return; // modal reopened meanwhile
    av.exists = Boolean(exists);
    (streamData?.stream?.storageNodes || []).forEach(n => av.storedBy.add(n.id.toLowerCase()));
    if (av.exists) {
        av.currentAvatar = await StreamAvatar.loadStreamAvatar(streamId, StreamAvatar.AVATAR_PARTITION, { force: true }).catch(() => null);
        av.hasAvatar = Boolean(av.currentAvatar);
    }
    if (state.avatar !== av) return;
    av.loading = false;

    renderStorageOptions([...av.storedBy][0] || selectedStorageNode());
    refreshStorageProbe();
    renderAvatarSection();
    debouncedEstimate();
}

async function handleAvatarFile() {
    const input = $('operator-form-avatar-file');
    const file = input?.files?.[0];
    if (!state.avatar) return;
    if (!file) {
        state.avatar.prepared = null;
        setStatus('operator-form-avatar-file-status', '', 'info');
    } else {
        try {
            const prepared = await StreamAvatar.prepareAvatar(file);
            state.avatar.prepared = prepared;
            const kb = Math.max(1, Math.round(prepared.bytes / 1024));
            setStatus('operator-form-avatar-file-status', `${StreamAvatar.AVATAR_SIZE}×${StreamAvatar.AVATAR_SIZE} ${prepared.mime.split('/')[1].toUpperCase()} · ${kb} KB`, 'ok');
        } catch (e) {
            state.avatar.prepared = null;
            input.value = '';
            setStatus('operator-form-avatar-file-status', e.message || 'Could not read the image.', 'error');
        }
    }
    if (!state.flow) showError('');
    renderAvatarSection();
    debouncedEstimate();
}

async function storageUrlsFor(address) {
    const probe = probeResults.get(address) || await probeStorageNode(address);
    if (!probe.urls.length) throw new Error('The storage node has no HTTPS endpoint.');
    return probe.urls;
}

async function runAvatarStep(step, flow) {
    const avatar = flow.avatar;
    switch (step.key) {
        case 'avatar-stream': {
            // Retry-safe: the stream may exist from an earlier attempt
            const exists = await Services.readWithFallback(() => getStreamRegistry().exists(avatar.streamId));
            if (!exists) {
                await runTxStep(step, (signer, overrides) => getStreamRegistry(signer).createStreamWithPermissions(
                    StreamAvatar.PROFILE_STREAM_PATH, streamMetadataJson(avatar.storageDays),
                    [PUBLIC_PERMISSION_ADDRESS], [PUBLIC_SUBSCRIBE_PERMISSION], overrides));
            }
            break;
        }
        case 'avatar-storage': {
            const node = ethers.utils.getAddress(avatar.storageNode);
            const assigned = await Services.readWithFallback(() => getStorageRegistry().isStorageNodeOf(avatar.streamId, node)).catch(() => false);
            if (!assigned) {
                await runTxStep(step, (signer, overrides) =>
                    getStorageRegistry(signer).addAndRemoveStorageNodes(avatar.streamId, [node], [], overrides));
            }
            break;
        }
        case 'avatar-storage-wait': {
            // Storage nodes pick up new assignments from chain events: publishing before that would be lost
            const urls = await storageUrlsFor(avatar.storageNode);
            const stored = await waitUntil(async () => {
                const results = await Promise.all(urls.map(url => StreamAvatar.isStoredBy(url, avatar.streamId)));
                return results.some(Boolean);
            }, STORAGE_PICKUP_TIMEOUT_MS, AVATAR_POLL_INTERVAL_MS);
            if (!stored) throw new Error('The storage node has not picked up the stream yet. Retry in a moment.');
            break;
        }
        case 'avatar-publish': {
            flow.publisher?.destroy();
            flow.publisher = await StreamAvatar.publishAvatar(window.appSigner, avatar.streamId, StreamAvatar.avatarMessage(avatar.prepared));
            flow.published = { timestamp: flow.publisher.timestamp, sequenceNumber: flow.publisher.sequenceNumber };
            break;
        }
        case 'avatar-verify': {
            const urls = await storageUrlsFor(avatar.storageNode);
            const stored = await waitUntil(async () => {
                for (const url of urls) {
                    const last = await StreamAvatar.fetchLastMessage(url, avatar.streamId, StreamAvatar.AVATAR_PARTITION).catch(() => null);
                    if (last && last.timestamp >= flow.published.timestamp && StreamAvatar.avatarFromContent(last.content)) return true;
                }
                return false;
            }, AVATAR_VERIFY_TIMEOUT_MS, AVATAR_POLL_INTERVAL_MS);
            if (!stored) throw new Error('The storage node has not stored the avatar yet. Retry to check again.');
            flow.publisher?.destroy();
            flow.publisher = null;
            StreamAvatar.invalidateStreamAvatar(avatar.streamId);
            break;
        }
        case 'avatar-purge': {
            // In a Pombo cluster deletes replicate between the nodes: one endpoint is enough
            const [url] = await storageUrlsFor(avatar.storageNode);
            const stored = await StreamAvatar.listStoredMessages(url, avatar.streamId, StreamAvatar.AVATAR_PARTITION, 100);
            const targets = stored
                .filter(m => !(m.timestamp === flow.published.timestamp && m.sequenceNumber === flow.published.sequenceNumber))
                .filter(m => m.timestamp <= flow.published.timestamp)
                .map(m => ({ timestamp: m.timestamp, sequenceNumber: m.sequenceNumber }));
            const results = await StreamAvatar.purgeMessages(url, window.appSigner, avatar.streamId, StreamAvatar.AVATAR_PARTITION, targets);
            flow.purged = results.filter(r => r.result === 'deleted').length;
            break;
        }
    }
}

// ============================================
// Rendering
// ============================================

function renderImagePreview() {
    const cid = ($('operator-form-image')?.value || '').trim();
    const img = $('operator-form-image-preview');
    if (!img) return;
    const valid = IPFS_CID_REGEX.test(cid);
    // Same priority as the rest of the app: IPFS CID (official) > avatar stream > placeholder
    const av = $('operator-form-avatar-enabled')?.checked ? state.avatar : null;
    const streamAvatar = av?.prepared?.dataUrl || av?.currentAvatar;
    const next = valid ? `https://ipfs.io/ipfs/${cid}` : (streamAvatar || Utils.OPERATOR_AVATAR_PLACEHOLDER);
    if (img.getAttribute('src') !== next) img.src = next;
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
    $('operator-form-body')?.querySelectorAll('input, textarea, select, button').forEach(el => { el.disabled = locked; });
    if (!locked) {
        renderCutLock();
        renderAvatarSection();
    }
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
        case 'avatar-stream':
            return Services.readWithFallback(() => getStreamRegistry().estimateGas.createStreamWithPermissions(
                StreamAvatar.PROFILE_STREAM_PATH, streamMetadataJson(changes.avatar.storageDays),
                [PUBLIC_PERMISSION_ADDRESS], [PUBLIC_SUBSCRIBE_PERMISSION], from))
                .catch(() => ethers.BigNumber.from(APPROX_GAS.avatarStream));
        case 'avatar-storage':
            // Can't be estimated before the stream exists
            if (changes.avatar.createStream) return ethers.BigNumber.from(APPROX_GAS.avatarStorage);
            return Services.readWithFallback(() => getStorageRegistry().estimateGas.addAndRemoveStorageNodes(
                changes.avatar.streamId, [ethers.utils.getAddress(changes.avatar.storageNode)], [], from))
                .catch(() => ethers.BigNumber.from(APPROX_GAS.avatarStorage));
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
    const allSteps = planSteps(changes);
    const txSteps = allSteps.filter(s => !s.noTx);

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
    if (state.mode === 'edit' && allSteps.length === 0) {
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

    if (txSteps.length === 0) {
        // Only signatures (e.g. a new avatar on an existing stream)
        txList.innerHTML = '';
        costEl.textContent = '0 POL';
        state.estimatedCostWei = ethers.BigNumber.from(0);
        noteEl.textContent = 'No transactions: only a signature in your wallet.';
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
    if (step.key.startsWith('avatar-')) return runAvatarStep(step, flow);
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
    const operatorChanged = flow.steps.some(s => s.key === 'index');
    const parts = [];
    if (flow.mode === 'create') parts.push('Next steps: delegate DATA to your operator (self-delegation), set up your node(s) and stake into sponsorships.');
    else if (operatorChanged) parts.push(flow.indexed ? 'The operator page shows the new values.' : 'The subgraph is still indexing: the operator page may take a moment to show the new values.');
    if (flow.avatar?.publish) {
        parts.push('The avatar is stored on the avatar stream.');
        if (flow.purged) parts.push(`${flow.purged} previous ${flow.purged === 1 ? 'version was' : 'versions were'} deleted.`);
    }
    $('operator-form-success-text').textContent = parts.join(' ');
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
            avatar: changes.avatar ? { ...changes.avatar, prepared: state.avatar.prepared } : null,
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
            setSubmitState(step.busy || 'Confirm in wallet...', true);
            await runStep(step, flow);
            step.status = 'done';
            renderProgress();
        }

        flow.finished = true;
        state.submitting = false;
        showSuccess(flow);
        setSubmitState('Close', false);
        if (flow.mode === 'edit') state.edit?.onSaved?.();
        if (state.avatar && flow.avatar?.publish) {
            state.avatar.currentAvatar = flow.avatar.prepared.dataUrl;
            state.avatar.hasAvatar = true;
        }
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
    const hasAvatarStream = isEdit && StreamAvatar.isValidProfileStreamId(state.edit.metadata.imageStreamId);
    $('operator-form-avatar-enabled').checked = hasAvatarStream;
    $('operator-form-avatar').open = hasAvatarStream;
    $('operator-form-avatar-file').value = '';
    $('operator-form-avatar-days').value = String(StreamAvatar.DEFAULT_PROFILE_STORAGE_DAYS);
    $('operator-form-avatar-purge').checked = true;
    setStatus('operator-form-avatar-file-status', '', 'info');
    renderStorageOptions(StreamAvatar.POMBO_STORAGE_NODE);
    state.avatar = null;

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
    loadAvatarContext().catch(e => logger.warn('Could not load the avatar stream:', e));

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
    flow?.publisher?.destroy();
    state.flow = null;
    $('operatorFormModal')?.classList.add('hidden');
}

function onFormChanged() {
    if (!state.flow) showError('');
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
    $('operator-form-avatar-enabled')?.addEventListener('change', () => {
        if (!state.flow) showError('');
        renderAvatarSection();
        debouncedEstimate();
    });
    $('operator-form-avatar-file')?.addEventListener('change', handleAvatarFile);
    $('operator-form-avatar-storage')?.addEventListener('change', () => {
        const custom = $('operator-form-avatar-storage').value === CUSTOM_STORAGE_OPTION;
        $('operator-form-avatar-storage-custom').classList.toggle('hidden', !custom);
        if (custom) $('operator-form-avatar-storage-custom').focus();
        refreshStorageProbe();
        renderAvatarSection();
        debouncedEstimate();
    });
    $('operator-form-avatar-storage-custom')?.addEventListener('input', Utils.debounce(() => {
        refreshStorageProbe();
        renderAvatarSection();
        debouncedEstimate();
    }, 400));
    $('operator-form-avatar-days')?.addEventListener('input', debouncedEstimate);
    $('operator-form-avatar-purge')?.addEventListener('change', debouncedEstimate);
    // IPFS preview failed: show the stream avatar (or the placeholder)
    $('operator-form-image-preview')?.addEventListener('error', (event) => {
        const av = $('operator-form-avatar-enabled')?.checked ? state.avatar : null;
        const fallback = av?.prepared?.dataUrl || av?.currentAvatar || Utils.OPERATOR_AVATAR_PLACEHOLDER;
        if (event.target.getAttribute('src') !== fallback) event.target.src = fallback;
    });
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
