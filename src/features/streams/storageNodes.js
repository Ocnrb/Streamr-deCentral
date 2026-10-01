// Storage nodes of a stream, with a check that their endpoints answer
import * as Utils from '../../core/utils.js';
import { detailState } from './state.js';

export function renderStreamStorageNodes(storageNodes, streamId, storageDays) {
    const panel = document.getElementById('stream-storage-panel');
    const content = document.getElementById('stream-storage-content');
    const emptyState = document.getElementById('stream-storage-empty');
    
    if (!panel || !content) return;
    
    // Always show the panel for stream details
    panel.classList.remove('hidden');
    
    if (!storageNodes || storageNodes.length === 0) {
        if (emptyState) emptyState.classList.remove('hidden');
        content.innerHTML = '';
        return;
    }
    
    if (emptyState) emptyState.classList.add('hidden');

    // TTL is set per stream (metadata.storageDays) and applies to every storage node
    const ttlDays = Number.isFinite(storageDays) && storageDays >= 0 ? storageDays : null;
    const ttlText = ttlDays !== null
        ? `${ttlDays} ${ttlDays === 1 ? 'day' : 'days'}`
        : '—';

    const nodeEndpoints = []; // endpoints per row, for the health check

    const rowsHtml = storageNodes.map((node, index) => {
        const nodeId = node.id || 'Unknown';
        const displayId = nodeId.length > 20 ? nodeId.substring(0, 10) + '...' + nodeId.substring(nodeId.length - 8) : nodeId;

        // Parse on-chain metadata (NodeRegistry): name and endpoints (urls)
        let nodeName = null;
        let endpoints = [];
        try {
            if (node.metadata) {
                const meta = JSON.parse(node.metadata);
                nodeName = typeof meta.name === 'string' ? meta.name : null;
                // SDK format is { urls: [...] }; legacy nodes use { http: "..." }
                if (Array.isArray(meta.urls)) {
                    endpoints = meta.urls.filter(u => typeof u === 'string');
                } else if (typeof meta.http === 'string') {
                    endpoints = [meta.http];
                }
            }
        } catch (e) { /* ignore */ }

        const httpEndpoints = endpoints.filter(url => /^https?:\/\//i.test(url));
        nodeEndpoints.push(httpEndpoints);

        // Last updated (subgraph `lastSeen` = last time the node metadata was updated on-chain)
        let lastSeenText = 'Unknown';
        if (parseInt(node.lastSeen) > 0) {
            const lastSeenDate = new Date(parseInt(node.lastSeen) * 1000);
            const now = new Date();
            const diffMs = now - lastSeenDate;
            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMs / 3600000);
            const diffDays = Math.floor(diffMs / 86400000);
            
            if (diffMins < 5) {
                lastSeenText = 'Just now';
            } else if (diffMins < 60) {
                lastSeenText = `${diffMins}m ago`;
            } else if (diffHours < 24) {
                lastSeenText = `${diffHours}h ago`;
            } else {
                lastSeenText = `${diffDays}d ago`;
            }
        }
        
        // Status dot - updated by checkStorageNodeEndpoints() once the endpoints are probed
        const statusDot = httpEndpoints.length > 0
            ? `<span data-storage-node-status="${index}" class="w-2 h-2 rounded-full bg-yellow-500 animate-pulse flex-shrink-0 cursor-help" title="Checking endpoints..."></span>`
            : '<span class="w-2 h-2 rounded-full bg-gray-500 flex-shrink-0 cursor-help" title="No HTTP endpoints registered"></span>';

        // Endpoints - only http(s) URLs become links
        const endpointsHtml = endpoints.length > 0
            ? endpoints.map(url => {
                const safeUrl = Utils.escapeHtml(url);
                const isHttp = /^https?:\/\//i.test(url);
                return isHttp
                    ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="block font-mono text-xs text-blue-400 hover:text-blue-300 break-all">${safeUrl}</a>`
                    : `<span class="block font-mono text-xs text-gray-400 break-all">${safeUrl}</span>`;
            }).join('')
            : '<span class="text-gray-600">—</span>';

        return `
            <tr class="hover:bg-white/5">
                <td class="px-4 py-3">
                    <div class="flex items-center gap-3">
                        ${statusDot}
                        <div class="min-w-0">
                            ${nodeName ? `<span class="block text-white font-medium">${Utils.escapeHtml(nodeName)}</span>` : ''}
                            <span class="font-mono text-sm ${nodeName ? 'text-gray-500' : 'text-gray-300'}" title="${Utils.escapeHtml(nodeId)}">${Utils.escapeHtml(displayId)}</span>
                        </div>
                    </div>
                </td>
                <td class="px-4 py-3">${endpointsHtml}</td>
                <td class="px-4 py-3 text-right whitespace-nowrap ${ttlDays !== null ? 'text-gray-300' : 'text-gray-600'}">${ttlText}</td>
                <td class="px-4 py-3 text-right whitespace-nowrap text-gray-500">${lastSeenText}</td>
            </tr>
        `;
    }).join('');
    
    content.innerHTML = `
        <div class="overflow-x-auto">
            <table class="w-full text-sm min-w-[500px]">
                <thead class="text-xs text-gray-500 uppercase bg-[#252525]">
                    <tr>
                        <th class="px-4 py-3 text-left">Provider</th>
                        <th class="px-4 py-3 text-left">Endpoints</th>
                        <th class="px-4 py-3 text-right">TTL</th>
                        <th class="px-4 py-3 text-right">Last Updated</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-[#333]">
                    ${rowsHtml}
                </tbody>
            </table>
        </div>
    `;

    checkStorageNodeEndpoints(nodeEndpoints, streamId);
}

const STORAGE_ENDPOINT_TIMEOUT_MS = 5000;

/**
 * GET with timeout
 */
async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STORAGE_ENDPOINT_TIMEOUT_MS);
    try {
        return await fetch(url, { ...options, cache: 'no-store', signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Probe a single URL
 * @returns {Promise<'ok'|'reachable'|'down'>}
 *   'ok'        - answered 200
 *   'reachable' - answered but the status is hidden (no CORS headers)
 *   'down'      - no answer, timeout or non-200 status
 */
async function probeUrl(url) {
    try {
        const response = await fetchWithTimeout(url);
        return response.status === 200 ? 'ok' : 'down';
    } catch (e) {
        // CORS or network error - retry in no-cors mode to tell them apart
        try {
            await fetchWithTimeout(url, { mode: 'no-cors' });
            return 'reachable';
        } catch (e2) {
            return 'down';
        }
    }
}

/**
 * Check whether a URL is allowed by the page's CSP connect-src (meta tag in index.html).
 * Storage node hosts must be listed there; blocked hosts can't be probed.
 * Supports 'self', scheme sources (https:) and host sources with *. subdomain and :* port wildcards.
 */
function isAllowedByCsp(url) {
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    const connectSrc = meta?.content.match(/connect-src([^;]*)/);
    if (!connectSrc) return true;

    let target;
    try {
        target = new URL(url);
    } catch (e) {
        return false;
    }
    const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80');

    return connectSrc[1].trim().split(/\s+/).some(source => {
        if (source === "'self'") return target.origin === window.location.origin;
        if (/^[a-z]+:$/i.test(source)) return target.protocol === source.toLowerCase();

        const match = source.match(/^([a-z]+):\/\/([^:/]+)(?::(\d+|\*))?/i);
        if (!match) return false;
        const [, scheme, host, port] = match;
        if (`${scheme.toLowerCase()}:` !== target.protocol) return false;

        const hostOk = host.startsWith('*.')
            ? target.hostname.endsWith(host.slice(1))
            : target.hostname === host.toLowerCase();
        const portOk = port === '*' || (port || (scheme.toLowerCase() === 'https' ? '443' : '80')) === targetPort;
        return hostOk && portOk;
    });
}

/**
 * Probe a storage node endpoint. The node root has no route on Streamr nodes (404),
 * so several paths are tried in parallel and any 200 counts:
 * - the registered URL as-is
 * - /capabilities (pombo storage nodes)
 * - /streams/{id}/storage/partitions/0 (Streamr storage plugin: 200 if the node stores the stream)
 * @returns {Promise<{status: 'ok'|'reachable'|'down'|'blocked', url: string|null}>}
 */
async function probeStorageEndpoint(url, streamId) {
    if (!isAllowedByCsp(url)) return { status: 'blocked', url };

    const base = url.replace(/\/+$/, '');
    const urls = [
        url,
        `${base}/capabilities`,
        `${base}/streams/${encodeURIComponent(streamId)}/storage/partitions/0`
    ];
    const results = await Promise.all(urls.map(probeUrl));

    const okIndex = results.indexOf('ok');
    if (okIndex !== -1) return { status: 'ok', url: urls[okIndex] };
    const reachableIndex = results.indexOf('reachable');
    if (reachableIndex !== -1) return { status: 'reachable', url: urls[reachableIndex] };
    return { status: 'down', url: null };
}

/**
 * Check all storage node endpoints in parallel and update each node's status dot:
 * green if any endpoint answers 200 (or answers without CORS headers), red otherwise
 * @param {Array<Array<string>>} nodeEndpoints - HTTP endpoints per table row
 * @param {string} streamId - Stream ID (to ignore results after navigating away)
 */
function checkStorageNodeEndpoints(nodeEndpoints, streamId) {
    nodeEndpoints.forEach(async (endpoints, index) => {
        if (endpoints.length === 0) return;

        const results = await Promise.all(endpoints.map(url => probeStorageEndpoint(url, streamId)));

        // Ignore results if the user navigated to another stream meanwhile
        if (detailState.currentStreamId !== streamId) return;
        const dot = document.querySelector(`#stream-storage-content [data-storage-node-status="${index}"]`);
        if (!dot) return;

        const ok = results.find(r => r.status === 'ok');
        const reachable = results.find(r => r.status === 'reachable');
        const isUp = Boolean(ok || reachable);
        // Unknown only if nothing answered and some endpoint couldn't be checked
        const isBlocked = !isUp && results.some(r => r.status === 'blocked');
        dot.classList.remove('bg-yellow-500', 'animate-pulse');
        dot.classList.add(isUp ? 'bg-green-500' : isBlocked ? 'bg-gray-500' : 'bg-red-500');
        dot.title = ok
            ? `Online - ${ok.url} responded 200`
            : reachable
                ? `Online - ${reachable.url} reachable (status hidden by CORS)`
                : isBlocked
                    ? 'Status unknown - endpoint host blocked by CSP (add it to connect-src in index.html)'
                    : 'Offline - no endpoint responded 200';
    });
}

/**
 * Update the header stats grid for sponsorship details view
 */
