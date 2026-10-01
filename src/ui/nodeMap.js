// The operator page's node map (Leaflet with a MapLibre basemap) and its coordination stream messages
import { escapeHtml } from '../core/utils.js';
import { regionToLocationMap } from './locationData.js';
import { MAX_STREAM_MESSAGES } from '../core/constants.js';

// --- Leaflet Map State ---
let leafletMap = null;
// Use a Map to group nodes by location. Key: "lat,long", Value: { marker, nodes (Map<nodeId, host>), location }
let locationNodeMap = new Map();
let mapLayers = {
    markers: null,
    lines: null
};

export function addStreamMessageToUI(message, activeNodes, unreachableNodes) {
    const messagesContainerEl = document.getElementById('stream-messages-container');
    if (!messagesContainerEl) return;

    if (message?.msgType === 'heartbeat' && message?.peerDescriptor?.nodeId) {
        const nodeId = message.peerDescriptor.nodeId;
        const region = message.peerDescriptor.region; // Get the region
        const host = message.peerDescriptor.websocket?.host || nodeId; // Get the host, fallback to nodeId

        if (!activeNodes.has(nodeId)) {
            activeNodes.add(nodeId);
            document.getElementById('active-nodes-count-value').textContent = activeNodes.size;
            document.getElementById('active-nodes-stats-value').textContent = activeNodes.size;

            if (region && leafletMap) {
                const location = regionToLocationMap[region];
                if (location) {
                    addNodeToMap(location, host, nodeId); // Pass location, host, AND nodeId
                } else {
                    console.warn(`Region code ${region} not found in location map.`);
                }
            }
        }
        if (message.peerDescriptor?.websocket?.tls === false && !unreachableNodes.has(nodeId)) {
            unreachableNodes.add(nodeId);
            const unreachableContainer = document.getElementById('unreachable-nodes-container');
            unreachableContainer.querySelector('span').textContent = unreachableNodes.size;
            unreachableContainer.classList.remove('hidden');
        }
    }

    const placeholder = messagesContainerEl.querySelector('.text-gray-500');
    if (placeholder) placeholder.remove();

    const messageWrapper = document.createElement('div');
    messageWrapper.className = 'stream-message-entry py-2 border-t border-[#333333]/50 first:border-t-0';
    messageWrapper.innerHTML = `
        <div class="flex justify-between items-center text-xs text-gray-400 mb-1">
            <span class="font-mono">${new Date().toLocaleTimeString()}</span>
        </div>
        <pre class="whitespace-pre-wrap break-all text-xs text-gray-400"><code>${escapeHtml(JSON.stringify(message, null, 2))}</code></pre>`;

    messagesContainerEl.prepend(messageWrapper);
    while (messagesContainerEl.children.length > MAX_STREAM_MESSAGES) {
        messagesContainerEl.removeChild(messagesContainerEl.lastChild);
    }
}


// --- Leaflet Map Functions ---

// Basemap: OpenFreeMap "Dark" (Dark Matter style, OpenStreetMap data), open and keyless.
// Vector tiles rendered by MapLibre GL inside Leaflet (markers and lines stay Leaflet layers).
// MapLibre (~1.4 MB) is self-hosted in /libs and only loaded when a map is shown; the CSP build
// runs its worker from a same-origin file, so no blob: workers are needed.
const BASEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
let mapLibreLoading = null;

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
    });
}

function loadMapLibre() {
    if (window.maplibregl && L.maplibreGL) return Promise.resolve();
    if (!mapLibreLoading) {
        mapLibreLoading = (async () => {
            if (!document.getElementById('maplibre-gl-css')) {
                const link = document.createElement('link');
                link.id = 'maplibre-gl-css';
                link.rel = 'stylesheet';
                link.href = '/assets/maplibre-gl.css';
                document.head.appendChild(link);
            }
            await loadScript('/libs/maplibre-gl-csp.js');
            window.maplibregl.setWorkerUrl('/libs/maplibre-gl-csp-worker.js');
            await loadScript('/libs/leaflet-maplibre-gl.js');
        })().catch(e => {
            mapLibreLoading = null;
            throw e;
        });
    }
    return mapLibreLoading;
}

/**
 * Adds the vector basemap once MapLibre is loaded. Without it (no WebGL, offline) the map
 * still works: markers and lines on the dark background.
 */
function addBasemap(map) {
    loadMapLibre().then(() => {
        if (leafletMap !== map) return; // map replaced meanwhile
        L.maplibreGL({ style: BASEMAP_STYLE_URL, interactive: false }).addTo(map);
    }).catch(e => console.warn('Basemap unavailable:', e));
}

/**
 * Cleans up the existing Leaflet map instance and resets state.
 */
function cleanupLeafletMap() {
    if (leafletMap) {
        leafletMap.remove();
        leafletMap = null;
    }
    locationNodeMap.clear(); // Clear the location/node tracker
    mapLayers = { markers: null, lines: null };
}

/**
 * Initializes a new Leaflet map instance.
 * @param {string} containerId - The ID of the div element to contain the map.
 */
export function initLeafletMap(containerId) {
    cleanupLeafletMap(); // Clean up old instance first

    try {
        const mapContainer = document.getElementById(containerId);
        if (!mapContainer) {
            console.error("Map container not found:", containerId);
            return;
        }
        // Clear placeholder
        mapContainer.innerHTML = '';

        leafletMap = L.map(containerId, {
            zoomControl: true, // Show zoom control
            minZoom: 2,
            maxZoom: 18
        }).setView([20, 0], 2); // Center map [lat, long], zoom
        // Basemap attribution (required by OpenFreeMap / OpenStreetMap), without the "Leaflet" prefix
        leafletMap.attributionControl.setPrefix(false);

        addBasemap(leafletMap);

        setTimeout(() => {
            if (leafletMap) {
                leafletMap.invalidateSize();
            }
        }, 0); // 0ms timeout pushes this to the end of the execution stack

        // Initialize layer groups to manage markers and lines
        mapLayers.lines = L.layerGroup().addTo(leafletMap);
        mapLayers.markers = L.layerGroup().addTo(leafletMap);

    } catch (e) {
        console.error("Failed to initialize Leaflet map:", e);
        const mapContainer = document.getElementById(containerId);
        if (mapContainer) {
            mapContainer.innerHTML = '<p class="text-red-400">Error loading map.</p>';
        }
    }
}

/**
 * Formats the tooltip content for a map marker.
 * @param {Map<string, string>} nodesMap - A Map of nodeId -> host
 * @returns {string} HTML content for the tooltip.
 */
function formatNodeTooltip(nodesMap) {
    const lines = [];
    for (const [nodeId, host] of nodesMap.entries()) {
        const safeHost = escapeHtml(host);
        const safeNodeId = escapeHtml(nodeId);
        lines.push(
            `- host: ${safeHost}\n  node: ${safeNodeId}`
        );
    }
    // Wrap in <pre> to respect the newlines and indentation
    return `<pre style="margin: 0; font-family: monospace; font-size: 10px;">${lines.join('\n\n')}</pre>`;
}

/**
 * Adds a new node marker and connection lines to the map.
 * Groups nodes by location and updates tooltips.
 * @param {object} location - The location object { lat, long, code }.
 *HttpS
 * @param {string} host - The node's host ID.
 * @param {string} nodeId - The node's ID.
 */
function addNodeToMap(location, host, nodeId) {
    if (!leafletMap || !mapLayers.markers || !mapLayers.lines) return;

    const latLng = [location.lat, location.long];
    const locationKey = `${location.lat},${location.long}`; // Use lat/long as a unique key

    if (!locationNodeMap.has(locationKey)) {
        // This is the FIRST node at this location
        const marker = L.circleMarker(latLng, {
            radius: 5,
            fillColor: "#3b82f6", // Tailwind Blue-500
            color: "#FFFFFF",
            weight: 1,
            opacity: 1,
            fillOpacity: 0.8
        }).addTo(mapLayers.markers);

        const nodes = new Map();
        nodes.set(nodeId, host);

        // Bind tooltip
        marker.bindTooltip(formatNodeTooltip(nodes));

        // Store marker and nodes
        locationNodeMap.set(locationKey, { marker, nodes, location });

        // Add lines to all *other* existing locations
        for (const [key, existingEntry] of locationNodeMap.entries()) {
            if (key !== locationKey) { // Don't draw line to self
                const latlngs = [
                    [existingEntry.location.lat, existingEntry.location.long],
                    latLng
                ];
                L.polyline(latlngs, {
                    color: "rgba(255, 255, 255, 0.4)", // White, semi-transparent
                    weight: 1
                }).addTo(mapLayers.lines);
            }
        }
    } else {
        // This is an ADDITIONAL node at an existing location
        const entry = locationNodeMap.get(locationKey);
        
        // Add the new node (Map handles duplicates by nodeId)
        entry.nodes.set(nodeId, host);

        // Update the tooltip content
        const tooltipContent = formatNodeTooltip(entry.nodes);
        entry.marker.setTooltipContent(tooltipContent);
    }
}
