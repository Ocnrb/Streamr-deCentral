// Stream / Sponsorship Details: the header, permissions, sponsorships, the remaining balance and funding
import * as Utils from '../../core/utils.js';
import { logger } from '../../core/utils.js';
import { CreateStream } from '../createStream.js';
import { SponsorshipForm } from '../sponsorshipForm.js';
import { state, detailState } from './state.js';
import { determineAccessControl, getAccessControlBadge } from './data.js';
import { renderStreamStorageNodes } from './storageNodes.js';
import { setupOperatorStakeButton, renderOperatorsList } from './stake.js';
import { loadSponsorshipOnchainHistory } from './onchainHistory.js';
import { setupChartEventListeners } from './charts.js';
import { initializePartitionSelector, setupStreamPlayerListeners } from './player.js';
import { StreamsLogic } from '../streams.js';

// ============================================
// Stream Detail Rendering
// ============================================

/**
 * Render the stream detail view
 */
export function renderStreamDetail(stream, isSponsored, sponsorshipId) {
    // Helper for safe text setting
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    const setHtml = (id, html) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
    };
    
    // Parse metadata
    let metadata = {};
    let partitions = 1;
    let description = '';
    
    try {
        if (stream.metadata) {
            metadata = JSON.parse(stream.metadata);
            // A whole number in the SDK's range (the metadata is the creator's), or 1
            const count = Number(metadata.partitions);
            partitions = Number.isInteger(count) && count >= 1 && count <= 100 ? count : 1;
            description = metadata.description || '';
        }
    } catch (e) { /* ignore */ }
    
    // Store partitions in state for player
    detailState.partitions = partitions;
    
    // Stream ID with link to PolygonScan
    setText('stream-detail-id', stream.id);
    
    // Setup link to PolygonScan
    const streamLinkEl = document.getElementById('stream-detail-link');
    if (streamLinkEl) {
        // Link to PolygonScan using the stream ID (ENS-style address)
        const streamAddress = stream.id.split('/')[0]; // Get the first part (e.g., "eth-watch.eth")
        streamLinkEl.href = `https://polygonscan.com/address/${streamAddress}`;
        streamLinkEl.title = 'View on PolygonScan';
    }
    
    // Partitions
    setText('stream-partitions', partitions);
    
    // Initialize partition selector for Live Data Viewer
    initializePartitionSelector(partitions);
    
    // Created/Updated
    setText('stream-created', stream.createdAt 
        ? new Date(parseInt(stream.createdAt) * 1000).toLocaleDateString() 
        : 'N/A');
    setText('stream-updated', stream.updatedAt 
        ? new Date(parseInt(stream.updatedAt) * 1000).toLocaleDateString() 
        : 'N/A');
    
    // Access Control
    const accessType = determineAccessControl(stream.permissions);
    setHtml('stream-access-control', getAccessControlBadge(accessType));
    
    // Description
    const descPanel = document.getElementById('stream-description-panel');
    if (description) {
        descPanel.classList.remove('hidden');
        document.getElementById('stream-description').textContent = description;
    } else {
        descPanel.classList.add('hidden');
    }
    
    // Sponsorship panel and header APY
    const sponsorshipPanel = document.getElementById('stream-sponsorship-panel');
    const sponsoredBadge = document.getElementById('stream-sponsored-badge');
    const permissionsStandalone = document.getElementById('stream-permissions-panel-standalone');
    const streamStatsGrid = document.getElementById('stream-stats-grid');
    const sponsorshipStatsGrid = document.getElementById('sponsorship-stats-grid');
    
    // Toggle icons and headers between Stream and Sponsorship modes
    const iconNormal = document.getElementById('stream-icon-normal');
    const iconSponsorship = document.getElementById('stream-icon-sponsorship');
    const headerNormal = document.getElementById('stream-header-normal');
    const headerSponsorship = document.getElementById('stream-header-sponsorship');
    
    if (isSponsored && stream.sponsorships && stream.sponsorships.length > 0) {
        if (sponsorshipPanel) sponsorshipPanel.classList.remove('hidden');
        if (sponsoredBadge) sponsoredBadge.classList.remove('hidden');
        if (permissionsStandalone) permissionsStandalone.classList.add('hidden');
        // Show sponsorship stats, hide stream stats
        if (streamStatsGrid) streamStatsGrid.classList.add('hidden');
        if (sponsorshipStatsGrid) sponsorshipStatsGrid.classList.remove('hidden');
        // Hide Stream Details specific panels
        const sponsorshipsListPanel = document.getElementById('stream-sponsorships-list-panel');
        const storagePanel = document.getElementById('stream-storage-panel');
        if (sponsorshipsListPanel) sponsorshipsListPanel.classList.add('hidden');
        if (storagePanel) storagePanel.classList.add('hidden');
        
        // Switch to Sponsorship mode (DATA icon + Sponsorship header)
        if (iconNormal) iconNormal.classList.add('hidden');
        if (iconSponsorship) iconSponsorship.classList.remove('hidden');
        CreateStream.setupEditButton(null);
        if (headerNormal) headerNormal.classList.add('hidden');
        if (headerSponsorship) headerSponsorship.classList.remove('hidden');
        
        const targetSponsorship = sponsorshipId 
            ? stream.sponsorships.find(s => s.id === sponsorshipId) || stream.sponsorships[0]
            : stream.sponsorships[0];
        
        // Setup sponsorship header links
        setText('sponsorship-stream-id', stream.id);
        const sponsorshipStreamLink = document.getElementById('sponsorship-stream-link');
        if (sponsorshipStreamLink) {
            // Link to Stream Details (internal navigation)
            const encodedStreamId = stream.id.split('/').map(part => encodeURIComponent(part)).join('/');
            sponsorshipStreamLink.href = `/stream/${encodedStreamId}`;
            sponsorshipStreamLink.onclick = (e) => {
                e.preventDefault();
                window.router.navigate(`/stream/${encodedStreamId}`);
            };
            sponsorshipStreamLink.title = 'View Stream Details';
        }
        const sponsorshipContractLink = document.getElementById('sponsorship-contract-link');
        if (sponsorshipContractLink && targetSponsorship.id) {
            // Link to PolygonScan
            sponsorshipContractLink.href = `https://polygonscan.com/address/${targetSponsorship.id}`;
            sponsorshipContractLink.title = 'View on PolygonScan';
            // Display the contract address
            setText('sponsorship-contract-address', targetSponsorship.id);
        }
        
        // Update header APY with dynamic color
        const apy = parseFloat(targetSponsorship.spotAPY || 0);
        const apyPercent = Math.round(apy * 100);
        const apyEl = document.getElementById('stream-header-apy');
        if (apyEl) {
            apyEl.textContent = apyPercent + '%';
            apyEl.className = apyEl.className.replace(/text-(green|red)-400/g, '');
            apyEl.classList.add(apyPercent > 0 ? 'text-green-400' : 'text-red-400');
        }
        
        // Update header stats for sponsorship
        updateSponsorshipHeaderStats(targetSponsorship);
        
        renderSponsorshipDetails(targetSponsorship);
        setupChartEventListeners();
        
        // Setup operator stake button if user has operator profile
        setupOperatorStakeButton(targetSponsorship);
        // "Add Funds" (any wallet can sponsor)
        SponsorshipForm.setupFundButton(targetSponsorship, stream.id,
            () => StreamsLogic.loadStreamDetail(stream.id, true, targetSponsorship.id));
    } else {
        if (sponsorshipPanel) sponsorshipPanel.classList.add('hidden');
        if (sponsoredBadge) sponsoredBadge.classList.add('hidden');
        if (permissionsStandalone) permissionsStandalone.classList.remove('hidden');
        // Show stream stats, hide sponsorship stats
        if (streamStatsGrid) streamStatsGrid.classList.remove('hidden');
        if (sponsorshipStatsGrid) sponsorshipStatsGrid.classList.add('hidden');
        
        // Switch to Stream mode (normal icon + Stream header)
        if (iconNormal) iconNormal.classList.remove('hidden');
        if (iconSponsorship) iconSponsorship.classList.add('hidden');
        if (headerNormal) headerNormal.classList.remove('hidden');
        if (headerSponsorship) headerSponsorship.classList.add('hidden');
        
        // Render permissions in standalone panel for streams without sponsorship
        renderPermissionsTable(stream.permissions, true);
        // Render sponsorships list for stream details view
        renderStreamSponsorshipsList(stream.sponsorships);
        // "New Sponsorship" (any wallet can sponsor any stream)
        SponsorshipForm.setupCreateButton(stream, () => StreamsLogic.loadStreamDetail(stream.id, false, null));
        // Render storage nodes
        renderStreamStorageNodes(stream.storageNodes, stream.id, metadata.storageDays);
        // Edit button (only if the connected wallet has EDIT permission)
        CreateStream.setupEditButton(stream, () => StreamsLogic.loadStreamDetail(stream.id, false, null));
    }
    
    // Also render permissions in the sponsored panel if sponsored
    if (isSponsored) {
        renderPermissionsTable(stream.permissions, false);
    }
    
    // Live data player (show for public streams)
    const playerPanel = document.getElementById('stream-player-panel');
    if (accessType === 'public-all' || accessType === 'public-subscribe') {
        if (playerPanel) playerPanel.classList.remove('hidden');
        setupStreamPlayerListeners();
    } else {
        if (playerPanel) playerPanel.classList.add('hidden');
    }
}

/**
 * Render permissions table
 * @param {Array} permissions - Permission entries
 * @param {boolean} standalone - If true, use standalone panel elements
 */
function renderPermissionsTable(permissions, standalone = false) {
    const suffix = standalone ? '-standalone' : '';
    const tbody = document.getElementById(`stream-permissions-tbody${suffix}`);
    const emptyState = document.getElementById(`stream-permissions-empty${suffix}`);
    const table = document.getElementById(`stream-permissions-table${suffix}`);
    
    if (!tbody || !table) return;
    
    if (!permissions || permissions.length === 0) {
        if (emptyState) emptyState.classList.remove('hidden');
        table.classList.add('hidden');
        return;
    }
    
    if (emptyState) emptyState.classList.add('hidden');
    table.classList.remove('hidden');
    
    const now = Math.floor(Date.now() / 1000);
    
    // Sort permissions to put Public (0x0000...) address first
    const sortedPermissions = [...permissions].sort((a, b) => {
        const aIsPublic = a.userAddress && a.userAddress.toLowerCase() === '0x0000000000000000000000000000000000000000';
        const bIsPublic = b.userAddress && b.userAddress.toLowerCase() === '0x0000000000000000000000000000000000000000';
        if (aIsPublic && !bIsPublic) return -1;
        if (!aIsPublic && bIsPublic) return 1;
        return 0;
    });
    
    const html = sortedPermissions.map(p => {
        const isPublicAddress = p.userAddress && p.userAddress.toLowerCase() === '0x0000000000000000000000000000000000000000';
        const displayAddress = isPublicAddress ? 'Public' : Utils.shortAddress(p.userAddress);
        const addressClass = isPublicAddress ? 'text-blue-400 font-medium' : 'font-mono text-gray-300';
        
        const hasPublish = p.publishExpiration && parseInt(p.publishExpiration) > now;
        const hasSubscribe = p.subscribeExpiration && parseInt(p.subscribeExpiration) > now;
        
        const checkIcon = `<svg class="w-4 h-4 text-green-400 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`;
        const xIcon = `<svg class="w-4 h-4 text-gray-600 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>`;
        
        return `
            <tr class="hover:bg-white/5">
                <td class="px-4 py-2 ${addressClass} text-xs" title="${p.userAddress}">${displayAddress}</td>
                <td class="px-4 py-2 text-center">${hasPublish ? checkIcon : xIcon}</td>
                <td class="px-4 py-2 text-center">${hasSubscribe ? checkIcon : xIcon}</td>
                <td class="px-4 py-2 text-center">${p.canEdit ? checkIcon : xIcon}</td>
                <td class="px-4 py-2 text-center">${p.canDelete ? checkIcon : xIcon}</td>
                <td class="px-4 py-2 text-center">${p.canGrant ? checkIcon : xIcon}</td>
            </tr>
        `;
    }).join('');
    
    tbody.innerHTML = html;
}

/**
 * Render sponsorships list for Stream Details view (non-sponsored)
 * @param {Array} sponsorships - Sponsorship entries
 */
function renderStreamSponsorshipsList(sponsorships) {
    const panel = document.getElementById('stream-sponsorships-list-panel');
    const content = document.getElementById('stream-sponsorships-list-content');
    const emptyState = document.getElementById('stream-sponsorships-list-empty');
    
    if (!panel || !content) return;
    
    // Always show the panel for stream details
    panel.classList.remove('hidden');
    
    if (!sponsorships || sponsorships.length === 0) {
        if (emptyState) emptyState.classList.remove('hidden');
        content.innerHTML = '';
        return;
    }
    
    if (emptyState) emptyState.classList.add('hidden');
    
    // Build table HTML
    let tableHtml = `
        <div class="overflow-x-auto">
            <table class="w-full text-sm">
                <thead class="text-xs text-gray-500 uppercase bg-[#252525]">
                    <tr>
                        <th class="px-4 py-3 text-left">Status</th>
                        <th class="px-4 py-3 text-right">APY</th>
                        <th class="px-4 py-3 text-right hidden md:table-cell">Operators</th>
                        <th class="px-4 py-3 text-right hidden md:table-cell">Payout (DATA/day)</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-[#333]">
    `;
    
    sponsorships.forEach(s => {
        const apy = parseFloat(s.spotAPY || 0) * 100;
        const apyRounded = Math.round(apy);
        const apyColor = apyRounded > 0 ? 'text-green-400' : 'text-gray-500';
        const operatorCount = s.operatorCount || 0;
        const payoutWeiPerSec = BigInt(s.totalPayoutWeiPerSec || '0');
        const payoutWeiPerDay = payoutWeiPerSec * BigInt(86400);
        const payoutPerDay = Utils.convertWeiToData(payoutWeiPerDay.toString());
        
        // Check if active
        const now = Math.floor(Date.now() / 1000);
        const insolvencyTs = parseInt(s.projectedInsolvency || 0);
        const isActive = s.isRunning && insolvencyTs > now;
        
        const statusBadge = isActive
            ? `<span class="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-green-500/20 text-green-400 text-xs font-medium">
                 <span class="w-1.5 h-1.5 rounded-full bg-green-400"></span>Active
               </span>`
            : `<span class="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-red-500/20 text-red-400 text-xs font-medium">
                 <span class="w-1.5 h-1.5 rounded-full bg-red-400"></span>Inactive
               </span>`;
        
        tableHtml += `
            <tr class="sponsorship-link hover:bg-white/5 cursor-pointer transition-colors"
                data-sponsorship-id="${s.id}">
                <td class="px-4 py-3">${statusBadge}</td>
                <td class="px-4 py-3 text-right ${apyColor} font-semibold">${apyRounded}%</td>
                <td class="px-4 py-3 text-right text-gray-400 hidden md:table-cell">${operatorCount}</td>
                <td class="px-4 py-3 text-right text-gray-400 hidden md:table-cell">${Utils.formatBigNumber(parseFloat(payoutPerDay))}</td>
            </tr>
        `;
    });
    
    tableHtml += `
                </tbody>
            </table>
        </div>
    `;
    
    content.innerHTML = tableHtml;
    
    // Add click handlers for navigation - use event delegation on tbody
    const tbody = content.querySelector('tbody');
    if (tbody) {
        tbody.addEventListener('click', (e) => {
            const row = e.target.closest('.sponsorship-link');
            if (row) {
                e.preventDefault();
                const sponsorshipId = row.dataset.sponsorshipId;
                if (sponsorshipId && detailState.currentStreamId) {
                    // Navigate to sponsorship details
                    const encodedStreamId = detailState.currentStreamId.split('/').map(part => encodeURIComponent(part)).join('/');
                    window.router.navigate(`/stream/${encodedStreamId}?sponsored=true&sponsorshipId=${sponsorshipId}`);
                }
            }
        });
    }
}

/**
 * Render storage nodes for Stream Details view
 * @param {Array} storageNodes - Storage node entries
 * @param {string} streamId - Stream ID (used for the endpoint health check)
 * @param {number} [storageDays] - Stream's on-chain storage TTL in days (metadata.storageDays)
 */

function updateSponsorshipHeaderStats(sponsorship) {
    const setHtml = (id, html) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
    };
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    
    // Status badge - based on APY (active if APY > 0)
    const apy = parseFloat(sponsorship.spotAPY || 0);
    const apyPercent = Math.round(apy * 100);
    const isActive = apyPercent > 0;
    
    if (isActive) {
        setHtml('stream-sponsorship-status', `
            <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/20 text-green-400 text-sm font-medium">
                <span class="w-2 h-2 rounded-full bg-green-400"></span>
                Active
            </span>
        `);
    } else {
        setHtml('stream-sponsorship-status', `
            <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/20 text-red-400 text-sm font-medium">
                <span class="w-2 h-2 rounded-full bg-red-400"></span>
                Inactive
            </span>
        `);
    }
    
    // Operators count
    setText('stream-header-operators', sponsorship.operatorCount || '0');
    
    // Payout rate (DATA/day)
    const payoutWeiPerSec = BigInt(sponsorship.totalPayoutWeiPerSec || '0');
    const payoutWeiPerDay = payoutWeiPerSec * BigInt(86400);
    const payoutPerDay = Utils.convertWeiToData(payoutWeiPerDay.toString());
    setText('stream-header-payout', Utils.formatBigNumber(parseFloat(payoutPerDay)));
    
    // Expires date
    const insolvencyTs = parseInt(sponsorship.projectedInsolvency || 0);
    if (insolvencyTs > 0) {
        const insolvencyDate = new Date(insolvencyTs * 1000);
        const day = String(insolvencyDate.getDate()).padStart(2, '0');
        const month = String(insolvencyDate.getMonth() + 1).padStart(2, '0');
        const year = insolvencyDate.getFullYear();
        setText('stream-header-expires', `${day}/${month}/${year}`);
    } else {
        setText('stream-header-expires', 'N/A');
    }
}

/**
 * Render sponsorship details
 */
function renderSponsorshipDetails(sponsorship) {
    const dataPriceUSD = state.dataPriceUSD || 0;
    
    // Helper function to set value with tooltip (safe)
    const setValueWithTooltip = (elementId, value, displayText) => {
        const el = document.getElementById(elementId);
        if (el) {
            el.textContent = displayText;
            el.setAttribute('data-tooltip-value', value.toString());
        }
    };
    
    // Helper function to safely set text content
    const setText = (elementId, text) => {
        const el = document.getElementById(elementId);
        if (el) el.textContent = text;
    };
    
    // Cumulative sponsored
    const totalSponsorships = Utils.convertWeiToData(sponsorship.cumulativeSponsoring || '0');
    setValueWithTooltip('stream-total-sponsored', totalSponsorships, Utils.formatBigNumber(totalSponsorships) + ' DATA');
    
    // Remaining balance - calculate real-time value from projectedInsolvency
    // The indexed remainingWei can be stale, so we compute: remaining = (insolvency - now) * payoutPerSec
    const payoutWeiPerSec = BigInt(sponsorship.totalPayoutWeiPerSec || '0');
    const projectedInsolvency = parseInt(sponsorship.projectedInsolvency || 0);
    const nowSeconds = Math.floor(Date.now() / 1000);
    
    let remainingWei;
    if (projectedInsolvency > 0 && projectedInsolvency > nowSeconds && payoutWeiPerSec > BigInt(0)) {
        // Calculate real remaining based on time until insolvency
        const secondsRemaining = BigInt(projectedInsolvency - nowSeconds);
        remainingWei = secondsRemaining * payoutWeiPerSec;
    } else if (projectedInsolvency > 0 && projectedInsolvency <= nowSeconds) {
        // Already past insolvency
        remainingWei = BigInt(0);
    } else {
        // No insolvency data, fall back to indexed value
        remainingWei = BigInt(sponsorship.remainingWei || '0');
    }
    
    const remaining = Utils.convertWeiToData(remainingWei.toString());
    
    // Build tooltip text with USD if available
    let remainingTooltip = remaining.toString();
    if (state.dataPriceUSD && state.dataPriceUSD > 0) {
        const usdValue = parseFloat(remaining) * state.dataPriceUSD;
        remainingTooltip += ` (~$${Utils.formatBigNumber(usdValue)})`;
    }
    setValueWithTooltip('stream-remaining', remainingTooltip, Utils.formatBigNumber(remaining) + ' DATA');
    
    // Initialize and start remaining balance ticker if sponsorship is running and has balance
    stopRemainingBalanceTicker(); // Stop any existing ticker
    if (remainingWei > BigInt(0) && sponsorship.isRunning && payoutWeiPerSec > BigInt(0)) {
        detailState.remainingBalanceData = {
            remainingWei: remainingWei,
            changePerSecond: payoutWeiPerSec,
            lastUpdated: Date.now()
        };
        startRemainingBalanceTicker();
    } else {
        detailState.remainingBalanceData = null;
    }
    
    // Total staked
    const totalStaked = Utils.convertWeiToData(sponsorship.totalStakedWei || '0');
    setValueWithTooltip('stream-total-staked', totalStaked, Utils.formatBigNumber(totalStaked) + ' DATA');
    
    // Payout rate (DATA/day) - calculate in wei first to avoid precision loss
    const payoutWeiPerDay = payoutWeiPerSec * BigInt(86400);
    const payoutPerDay = Utils.convertWeiToData(payoutWeiPerDay.toString());
    setText('stream-payout-rate', Utils.formatBigNumber(parseFloat(payoutPerDay)));
    
    // Min stake duration
    const minStakeSecs = parseInt(sponsorship.minimumStakingPeriodSeconds || 0);
    const minStakeDays = Math.ceil(minStakeSecs / 86400);
    setText('stream-min-stake-duration', minStakeDays > 0 ? `${minStakeDays} days` : 'None');
    
    // Projected insolvency
    const insolvencyTs = parseInt(sponsorship.projectedInsolvency || 0);
    if (insolvencyTs > 0) {
        const insolvencyDate = new Date(insolvencyTs * 1000);
        const day = String(insolvencyDate.getDate()).padStart(2, '0');
        const month = String(insolvencyDate.getMonth() + 1).padStart(2, '0');
        const year = insolvencyDate.getFullYear();
        const hours = String(insolvencyDate.getHours()).padStart(2, '0');
        const minutes = String(insolvencyDate.getMinutes()).padStart(2, '0');
        setText('stream-insolvency', `${day}/${month}/${year} ${hours}:${minutes}`);
    } else {
        setText('stream-insolvency', 'N/A');
    }
    
    // Operators list
    renderOperatorsList(sponsorship.stakes);
    
    // Sync tile heights after operators are rendered
    requestAnimationFrame(() => {
        syncTileHeights();
    });
    
    // Additional sync after content is fully loaded
    setTimeout(() => {
        syncTileHeights();
    }, 200);
    
    // Store stakes for operator name lookup in history
    detailState.sponsorshipStakes = sponsorship.stakes || [];
    
    // Funding history
    renderFundingHistory(sponsorship.sponsoringEvents);
    
    // On-chain history (async)
    loadSponsorshipOnchainHistory(sponsorship.id);
}

/**
 * Sync tile heights: Operators to Details, and Funding to History
 */
export function syncTileHeights() {
    const detailsTile = document.getElementById('sponsorship-details-tile');
    const operatorsTile = document.getElementById('staked-operators-tile');

    if (detailsTile && operatorsTile) {
        const detailsHeight = detailsTile.offsetHeight;
        operatorsTile.style.minHeight = `${detailsHeight}px`;
        operatorsTile.style.maxHeight = `${detailsHeight}px`;
    }

    const fundingTile = document.getElementById('funding-history-tile');
    const historyTile = document.getElementById('onchain-history-tile');

    if (fundingTile && historyTile) {
        const historyHeight = historyTile.offsetHeight;
        fundingTile.style.minHeight = `${historyHeight}px`;
    }
}

// Store current sponsorship for stake management

// ============================================
// Remaining Balance Ticker Functions
// ============================================

/**
 * Start the remaining balance ticker that updates displayed values every second
 * Balance decreases based on totalPayoutWeiPerSec, stops at zero
 */
function startRemainingBalanceTicker() {
    // Stop any existing ticker
    stopRemainingBalanceTicker();
    
    // Don't start if no data or already at zero
    if (!detailState.remainingBalanceData || detailState.remainingBalanceData.remainingWei <= BigInt(0)) {
        return;
    }
    
    detailState.remainingBalanceTickerInterval = setInterval(() => {
        const data = detailState.remainingBalanceData;
        if (!data || data.changePerSecond <= BigInt(0)) return;
        
        const now = Date.now();
        const elapsedMs = now - data.lastUpdated;
        const elapsedSeconds = elapsedMs / 1000;
        
        // Calculate decrement
        const decrement = BigInt(Math.floor(Number(data.changePerSecond) * elapsedSeconds));
        
        // Subtract from remaining, floor at zero
        data.remainingWei = data.remainingWei - decrement;
        if (data.remainingWei < BigInt(0)) {
            data.remainingWei = BigInt(0);
        }
        data.lastUpdated = now;
        
        // Update the display
        updateRemainingBalanceDisplay(data.remainingWei.toString(), state.dataPriceUSD);
        
        // Stop ticker if remaining reached zero
        if (data.remainingWei <= BigInt(0)) {
            logger.log('[RemainingBalance] Ticker stopped - balance reached zero');
            stopRemainingBalanceTicker();
        }
    }, 1000);
    
    logger.log('[RemainingBalance] Ticker started');
}

/**
 * Stop the remaining balance ticker
 */
export function stopRemainingBalanceTicker() {
    if (detailState.remainingBalanceTickerInterval) {
        clearInterval(detailState.remainingBalanceTickerInterval);
        detailState.remainingBalanceTickerInterval = null;
        logger.log('[RemainingBalance] Ticker stopped');
    }
}

/**
 * Update the remaining balance display element
 * @param {string} remainingWei - Remaining balance in wei as string
 * @param {number} dataPriceUSD - Current DATA price in USD
 */
function updateRemainingBalanceDisplay(remainingWei, dataPriceUSD) {
    const element = document.getElementById('stream-remaining');
    if (!element) return;
    
    const remainingData = Utils.convertWeiToData(remainingWei);
    const formattedData = Utils.formatBigNumber(remainingData);
    
    // Display only DATA value
    element.textContent = `${formattedData} DATA`;
    
    // Tooltip shows precise DATA value and USD if available
    let tooltipText = remainingData.toString();
    if (dataPriceUSD && dataPriceUSD > 0) {
        const usdValue = parseFloat(remainingData) * dataPriceUSD;
        tooltipText += ` (~$${Utils.formatBigNumber(usdValue)})`;
    }
    element.setAttribute('data-tooltip-value', tooltipText);
}

function renderFundingHistory(events) {
    const container = document.getElementById('stream-funding-history');
    
    if (!events || events.length === 0) {
        container.innerHTML = `<div class="px-4 md:px-6 py-4 text-gray-500 text-center text-sm">No funding history</div>`;
        return;
    }
    
    const html = events.map(event => {
        const rawAmount = Utils.convertWeiToData(event.amount || '0');
        const amount = Utils.formatBigNumber(rawAmount);
        const date = new Date(parseInt(event.date) * 1000).toLocaleDateString();
        const sponsor = Utils.shortAddress(event.sponsor);
        
        return `
            <div class="flex justify-between items-center px-4 md:px-6 py-3 border-b border-[#333] last:border-b-0 hover:bg-white/5 transition-colors">
                <div class="flex items-center gap-2">
                    <svg class="w-4 h-4 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"/>
                    </svg>
                    <span class="text-gray-400 text-xs">${date}</span>
                    <span class="text-gray-600 text-xs font-mono hidden sm:inline">${sponsor}</span>
                </div>
                <span class="text-green-400 font-semibold text-sm" data-tooltip-value="${rawAmount}">+ ${amount} DATA</span>
            </div>
        `;
    }).join('');
    
    container.innerHTML = html;
}

/**
 * Load and render on-chain history for a sponsorship contract
 * @param {string} sponsorshipAddress - The sponsorship contract address
 */
