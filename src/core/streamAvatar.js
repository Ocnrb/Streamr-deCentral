/**
 * Operator avatars stored in a Streamr stream (optional alternative to an IPFS CID).
 *
 * The operator metadata points to a "profile stream" owned by the operator wallet
 * (owner-only write, public read) with a storage node assigned:
 *   { "imageStreamId": "<owner>/operator/profile", "imageStreamPartition": 0 }
 * The latest message on that partition holds the avatar:
 *   { "type": "avatar", "mime": "image/webp", "width": 256, "height": 256, "data": "data:image/webp;base64,..." }
 *
 * Reading goes over HTTPS to the stream's storage nodes (`/data/partitions/:p/last`). Only Pombo storage
 * nodes are read: they check the signature and PUBLISH permission before storing, while a vanilla Streamr
 * storage node stores whatever reaches it, so anyone could slip a newer "avatar" into its history.
 * Pombo nodes also support purge.
 */

import { runQuery } from './services.js';
import { AVATAR_STREAM_MARKER as MARKER, OPERATOR_AVATAR_PLACEHOLDER, isValidProfileStreamId, ipfsCidFromAvatarUrl, markDeadIpfsCid, gqlEscape } from './utils.js';
import { STREAMR_SDK_CONTRACTS_CONFIG } from './constants.js';

export { isValidProfileStreamId };

export const PROFILE_STREAM_PATH = '/operator/profile';
export const PROFILE_STREAM_PARTITIONS = 2;        // 0: avatar, 1: reserved
export const AVATAR_PARTITION = 0;
export const AVATAR_SIZE = 256;
export const DEFAULT_PROFILE_STORAGE_DAYS = 3650;  // storage nodes drop messages older than storageDays

// Pombo storage cluster (default storage for profile streams)
export const POMBO_STORAGE_NODE = '0xae340e799e8151f6a4999d245e466197aa217667';

const DATA_URL_REGEX = /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/]+=*$/;
const MAX_AVATAR_BYTES = 400 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_STORAGE_URLS = 3;                   // endpoints tried per stream (registry metadata is open to anyone)
const MAX_RESPONSE_BYTES = 600 * 1024;        // one avatar message plus JSON envelope
const MAX_SMALL_RESPONSE_BYTES = 64 * 1024;   // capabilities, message metadata lists
const FETCH_TIMEOUT_MS = 10 * 1000;
const POMBO_NODE_NAME = 'pombo-storage-node';

const avatarCache = new Map();   // streamId#partition -> { promise, at }
const urlCache = new Map();      // streamId -> Promise<string[]>
const pomboCache = new Map();    // base URL -> Promise<boolean>

export function profileStreamIdFor(ownerAddress) {
    return `${ownerAddress.toLowerCase()}${PROFILE_STREAM_PATH}`;
}

/**
 * HTTPS endpoints of a storage node from its registry metadata ({ urls: [...] } or legacy { http })
 */
export function storageNodeUrls(nodeMetadataJson) {
    try {
        const meta = JSON.parse(nodeMetadataJson || '{}');
        const urls = Array.isArray(meta.urls) ? meta.urls : (typeof meta.http === 'string' ? [meta.http] : []);
        return urls.filter(u => typeof u === 'string' && /^https:\/\//i.test(u)).map(u => u.replace(/\/+$/, ''));
    } catch (e) {
        return [];
    }
}

async function getStreamStorageUrls(streamId) {
    if (!urlCache.has(streamId)) {
        const promise = runQuery(`{ stream(id: "${gqlEscape(streamId)}") { storageNodes { id metadata } } }`)
            .then(data => [...new Set((data?.stream?.storageNodes || []).flatMap(node => storageNodeUrls(node.metadata)))].slice(0, MAX_STORAGE_URLS))
            .catch(() => { urlCache.delete(streamId); return []; });
        urlCache.set(streamId, promise);
    }
    return urlCache.get(streamId);
}

/**
 * Validates the avatar message content and returns a safe data URL (or null)
 */
export function avatarFromContent(content) {
    if (!content || typeof content !== 'object' || content.type !== 'avatar') return null;
    const data = content.data;
    if (typeof data !== 'string' || data.length > MAX_AVATAR_BYTES * 1.4 || !DATA_URL_REGEX.test(data)) return null;
    return data;
}

/**
 * GET a JSON document from a storage node, with a timeout and a size cap
 * (the node comes from registry metadata, so its responses are untrusted)
 */
async function fetchJsonLimited(url, maxBytes) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const declared = Number(response.headers.get('content-length'));
        if (declared > maxBytes) throw new Error('Response too large');
        if (!response.body) return JSON.parse(await response.text());
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
                reader.cancel().catch(() => {});
                throw new Error('Response too large');
            }
            chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return JSON.parse(new TextDecoder().decode(bytes));
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Latest message of a stream partition from one storage node (public read)
 */
export async function fetchLastMessage(baseUrl, streamId, partition, format = 'object') {
    const url = `${baseUrl}/streams/${encodeURIComponent(streamId)}/data/partitions/${partition}/last?count=1&format=${format}`;
    const messages = await fetchJsonLimited(url, MAX_RESPONSE_BYTES);
    return Array.isArray(messages) && messages.length ? messages[messages.length - 1] : null;
}

/**
 * Whether an endpoint is a Pombo storage node, which validates messages before storing them (cached)
 */
function isPomboEndpoint(baseUrl) {
    if (!pomboCache.has(baseUrl)) {
        const promise = getCapabilities(baseUrl).then(caps => {
            if (!caps) pomboCache.delete(baseUrl);   // unreachable: ask again next time
            return caps?.name === POMBO_NODE_NAME;
        });
        pomboCache.set(baseUrl, promise);
    }
    return pomboCache.get(baseUrl);
}

/**
 * Avatar data URL for a stream (cached), or null
 */
export function loadStreamAvatar(streamId, partition = AVATAR_PARTITION, { force = false } = {}) {
    const key = `${streamId}#${partition}`;
    const cached = avatarCache.get(key);
    if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.promise;

    const promise = (async () => {
        const urls = await getStreamStorageUrls(streamId);
        for (const baseUrl of urls) {
            try {
                const [pombo, message] = await Promise.all([
                    isPomboEndpoint(baseUrl),
                    fetchLastMessage(baseUrl, streamId, partition)
                ]);
                if (!pombo) continue;
                const avatar = avatarFromContent(message?.content);
                if (avatar) return avatar;
            } catch (e) {
                // try the next endpoint of the storage node(s)
            }
        }
        return null;
    })();
    avatarCache.set(key, { promise, at: Date.now() });
    return promise;
}

export function invalidateStreamAvatar(streamId) {
    for (const key of avatarCache.keys()) {
        if (key.startsWith(`${streamId}#`)) avatarCache.delete(key);
    }
    urlCache.delete(streamId);
}

// ============================================
// Hydration of rendered avatars
// ============================================
// parseOperatorMetadata() returns "<ipfs url or placeholder>#avatar-stream=<id>:<partition>".
// Priority: IPFS (official) > stream > placeholder. The stream avatar is loaded right away when
// the base image is the placeholder, and as a fallback when the IPFS image fails to load
// (inline onerror handlers switch to the placeholder first; we then swap in the stream avatar).

const isPlaceholder = (src) => src.startsWith('https://placehold.co/');

function parseMarker(src) {
    const index = src.indexOf(MARKER);
    if (index === -1) return null;
    const [encodedId, partition] = src.slice(index + MARKER.length).split(':');
    let streamId;
    try { streamId = decodeURIComponent(encodedId || ''); } catch (e) { return null; }
    if (!isValidProfileStreamId(streamId)) return null;
    return { key: `${streamId}:${Number(partition) || 0}`, streamId, partition: Number(partition) || 0, base: src.slice(0, index) };
}

/**
 * Error handler of the operator avatar <img> (avatarImgHtml): the IPFS image failed -> remember the
 * CID (not requested again for a while) and show the placeholder; the hydrator then uses the avatar
 * stream, if any.
 */
function avatarFallback(img) {
    const cid = ipfsCidFromAvatarUrl(img.getAttribute('src'));
    if (cid) markDeadIpfsCid(cid);
    img.onerror = null;
    img.src = OPERATOR_AVATAR_PLACEHOLDER;
}

function applyStreamAvatar(img) {
    const key = img.dataset.avatarStream;
    if (!key || img.dataset.avatarStreamLoading === key) return;
    const sep = key.lastIndexOf(':');
    img.dataset.avatarStreamLoading = key;
    loadStreamAvatar(key.slice(0, sep), Number(key.slice(sep + 1))).then(dataUrl => {
        const src = img.getAttribute('src') || '';
        // Still the same operator, and still on the placeholder: IPFS (thumbnail or direct) wins when it loads
        const base = src.includes(MARKER) ? src.slice(0, src.indexOf(MARKER)) : src;
        if (!dataUrl || img.dataset.avatarStream !== key || !isPlaceholder(base)) return;
        img.src = dataUrl;
        // Some lists hide the image on error and show an initial instead
        if (img.style.display === 'none') {
            img.style.display = '';
            const fallback = img.nextElementSibling;
            if (fallback && fallback.style.display === 'flex') fallback.style.display = 'none';
        }
    }).finally(() => {
        if (img.dataset.avatarStreamLoading === key) delete img.dataset.avatarStreamLoading;
    });
}

function hydrateImage(img) {
    const src = img.getAttribute('src') || '';
    if (src.startsWith('data:')) return;
    const marker = parseMarker(src);
    if (marker) {
        img.dataset.avatarStream = marker.key;
        if (!marker.base || isPlaceholder(marker.base)) applyStreamAvatar(img);
    } else if (img.dataset.avatarStream) {
        // The IPFS image failed and an onerror handler switched to the placeholder: use the stream.
        // Any other new image means the element now shows another operator.
        if (isPlaceholder(src)) applyStreamAvatar(img);
        else delete img.dataset.avatarStream;
    }
}

function hydrateTree(root) {
    if (root.nodeType !== 1) return;
    if (root.tagName === 'IMG') hydrateImage(root);
    root.querySelectorAll?.(`img[src*="${MARKER}"]`).forEach(hydrateImage);
}

/**
 * Watches the DOM for operator avatars backed by a stream and loads them (once per page)
 */
export function installAvatarHydrator() {
    if (window.__streamAvatarHydrator) return;
    const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            if (mutation.type === 'attributes') hydrateImage(mutation.target);
            else mutation.addedNodes.forEach(hydrateTree);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    // A failed avatar (data-avatar-fallback, from avatarImgHtml) shows the placeholder, then its avatar stream if it has one
    document.addEventListener('error', (event) => {
        const img = event.target;
        if (img?.tagName !== 'IMG') return;
        if (img.hasAttribute('data-avatar-fallback') && !isPlaceholder(img.getAttribute('src') || '')) avatarFallback(img);
        if (img.dataset.avatarStream) applyStreamAvatar(img);
    }, true);
    window.__streamAvatarHydrator = observer;
    hydrateTree(document.body);
}

export { OPERATOR_AVATAR_PLACEHOLDER };

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => (img.naturalWidth ? resolve(img) : reject(new Error('empty image')));
        img.onerror = () => reject(new Error(`Failed to load ${src}`));
        img.src = src;
    });
}

/**
 * Operator avatar for canvas drawings (Network Map, charts), same priority as the <img> avatars:
 * IPFS (official) > avatar stream > nothing (the caller draws its own fallback).
 * @param {string|null} imageUrl - from parseOperatorMetadata (may carry the avatar stream marker)
 * @returns {Promise<HTMLImageElement|null>} a loaded image, or null
 */
export async function loadOperatorAvatarImage(imageUrl) {
    if (typeof imageUrl !== 'string' || !imageUrl.startsWith('https://')) return null;
    const marker = parseMarker(imageUrl);
    const base = marker ? marker.base : imageUrl;
    if (base && !isPlaceholder(base)) {
        try {
            return await loadImage(base);
        } catch (e) {
            const cid = ipfsCidFromAvatarUrl(base);
            if (cid) markDeadIpfsCid(cid);
            if (!marker) return null;
        }
    }
    if (!marker) return null;
    const dataUrl = await loadStreamAvatar(marker.streamId, marker.partition).catch(() => null);
    return dataUrl ? loadImage(dataUrl).catch(() => null) : null;
}

// ============================================
// Upload: resize, publish, verify, purge
// ============================================

/**
 * Square center crop, resized to AVATAR_SIZE, encoded as WebP (PNG if the browser can't encode WebP)
 * @returns {Promise<{ dataUrl: string, mime: string, bytes: number }>}
 */
export async function prepareAvatar(file) {
    if (!file || !/^image\//.test(file.type)) throw new Error('Choose an image file.');
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    bitmap.close?.();

    let dataUrl = canvas.toDataURL('image/webp', 0.85);
    if (!dataUrl.startsWith('data:image/webp')) dataUrl = canvas.toDataURL('image/png');
    const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
    const bytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
    if (bytes > MAX_AVATAR_BYTES) throw new Error('The image is too large after resizing.');
    return { dataUrl, mime, bytes };
}

export function avatarMessage(prepared) {
    return { type: 'avatar', mime: prepared.mime, width: AVATAR_SIZE, height: AVATAR_SIZE, data: prepared.dataUrl };
}

/**
 * Publishes the avatar with a StreamrClient authenticated as the connected wallet
 * (private key login or the injected Ethereum provider). The message is signed by the wallet.
 * @returns {Promise<{ timestamp: number, sequenceNumber: number, destroy: Function }>}
 */
export async function publishAvatar(signer, streamId, content) {
    const injected = window.ethereum;
    if (!signer?.privateKey && !injected?.request) throw new Error('No wallet available to sign the message.');
    // The SDK deep-clones its config, and MetaMask's window.ethereum is a Proxy that can't be cloned
    // ("'get' on proxy: property 'prototype' is a read-only..."). Pass a plain EIP-1193 object instead:
    // functions are kept by reference by the clone, and the SDK's BrowserProvider only needs request().
    const auth = signer?.privateKey
        ? { privateKey: signer.privateKey }
        : { ethereum: { request: (args) => injected.request(args) } };

    // Kept alive until the storage node has the message (destroy() when done): tearing the
    // network node down right after publish() can drop the message before it propagates
    const client = new StreamrClient({ auth, logLevel: 'error', contracts: STREAMR_SDK_CONTRACTS_CONFIG });
    const destroy = () => { client.destroy().catch(() => {}); };
    try {
        const message = await client.publish({ id: streamId, partition: AVATAR_PARTITION }, content);
        return { timestamp: message.timestamp, sequenceNumber: message.sequenceNumber ?? 0, destroy };
    } catch (e) {
        destroy();
        throw e;
    }
}

/**
 * Whether a storage node already stores the stream (Streamr storage plugin endpoint)
 */
export async function isStoredBy(baseUrl, streamId, partition = AVATAR_PARTITION) {
    try {
        const response = await fetch(`${baseUrl}/streams/${encodeURIComponent(streamId)}/storage/partitions/${partition}`, { cache: 'no-store' });
        return response.ok;
    } catch (e) {
        return false;
    }
}

export async function getCapabilities(baseUrl) {
    try {
        const caps = await fetchJsonLimited(`${baseUrl}/capabilities`, MAX_SMALL_RESPONSE_BYTES);
        return caps && typeof caps === 'object' ? caps : null;
    } catch (e) {
        return null;
    }
}

/**
 * Stored avatar messages on a partition (metadata only, newest last)
 */
export async function listStoredMessages(baseUrl, streamId, partition, count = 50) {
    const url = `${baseUrl}/streams/${encodeURIComponent(streamId)}/data/partitions/${partition}/last?count=${count}&format=metadata`;
    const messages = await fetchJsonLimited(url, MAX_SMALL_RESPONSE_BYTES);
    return Array.isArray(messages) ? messages : [];
}

/**
 * Deletes messages from a Pombo storage node (POST /purge, EIP-191 signed request)
 * @param {ethers.Signer} signer - must hold DELETE on the stream or have signed the messages
 * @param {Array<{timestamp:number, sequenceNumber:number}>} targets - at most 100
 */
export async function purgeMessages(baseUrl, signer, streamId, partition, targets) {
    if (!targets.length) return [];
    const user = (await signer.getAddress()).toLowerCase();
    const issuedAt = Date.now();
    const nonce = crypto.randomUUID ? crypto.randomUUID() : `${issuedAt}-${Math.random().toString(36).slice(2)}`;
    const lines = [
        'pombo-storage-node',
        'purge',
        streamId,
        String(partition),
        String(issuedAt),
        nonce,
        ...targets.map(t => `${t.timestamp}:${t.sequenceNumber}`)
    ];
    const signature = await signer.signMessage(lines.join('\n'));
    const response = await fetch(`${baseUrl}/streams/${encodeURIComponent(streamId)}/data/partitions/${partition}/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, issuedAt, nonce, signature, targets })
    });
    if (!response.ok) throw new Error(`Purge failed: HTTP ${response.status}`);
    const result = await response.json();
    return Array.isArray(result) ? result : (result?.results || result?.targets || []);
}
