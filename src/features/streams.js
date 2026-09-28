/**
 * Streams Feature Module
 * Handles the streams list view with Sponsorships and All Streams tables
 */

import * as Utils from '../core/utils.js';
import * as UI from '../ui/ui.js';
import * as Services from '../core/services.js';
import { getOperatorProfile } from '../core/profile.js';

const { logger } = Utils;

// ============================================
// Constants
// ============================================

const STREAMS_PER_PAGE = 1000;

// ============================================
// State Management
// ============================================

const state = {
    // Sponsorships
    sponsorships: [],
    sponsorshipsSkip: 0,
    hasMoreSponsorships: true,
    sponsorshipsLoading: false,
    
    // Zero balance sponsorships (remaining balance = 0)
    zeroBalanceStreams: [],
    zeroBalanceSkip: 0,
    hasMoreZeroBalance: true,
    zeroBalanceLoading: false,
    showZeroBalance: false, // Toggle state for zero balance sponsorships
    
    // All streams 
    allStreams: [],
    allStreamsSkip: 0,
    hasMoreAllStreams: true,
    allStreamsLoading: false,
    
    // Search state
    searchQuery: '',
    searchMode: false,
    filteredSponsorships: [],
    filteredAllStreams: [],
    
    // Sort state for sponsorships
    sortField: 'apy', // 'payout', 'apy', 'staked', 'operators'
    sortDirection: 'desc', // 'asc' or 'desc'
    
    // Shared state
    dataPriceUSD: null,
    
    // Active tab
    activeTab: 'allStreams',
    
    // Operator stakes - Set of sponsorship IDs where user's operator has stake
    operatorStakes: new Set(),
};

// ============================================
// Data Fetching
// ============================================

/**
 * Fetch sponsorships 
 */
async function fetchSponsorships(skip = 0) {
    const query = `
        query Getsponsorships {
            sponsorships(
                first: ${STREAMS_PER_PAGE},
                skip: ${skip},
                orderBy: spotAPY,
                orderDirection: desc,
                where: { isRunning: true, remainingWei_gt: "0" }
            ) {
                id
                spotAPY
                totalStakedWei
                remainingWei
                operatorCount
                isRunning
                totalPayoutWeiPerSec
                stream {
                    id
                    metadata
                }
                stakes(first: 100, orderBy: amountWei, orderDirection: desc) {
                    operator {
                        id
                        metadataJsonString
                    }
                    amountWei
                }
            }
        }
    `;
    
    const data = await Services.runQuery(query);
    return data.sponsorships || [];
}

/**
 * Fetch current stakes for the user's operator
 * Returns a Set of sponsorship IDs where the operator has stake
 */
async function fetchOperatorStakes() {
    const operatorProfile = getOperatorProfile();
    if (!operatorProfile || !operatorProfile.id) {
        return new Set();
    }
    
    const operatorId = operatorProfile.id.toLowerCase();
    const query = `
        {
            stakes(
                where: { operator: "${operatorId}" }
                first: 1000
            ) {
                sponsorship { id }
            }
        }
    `;
    
    try {
        const data = await Services.runQuery(query);
        const stakes = data.stakes || [];
        return new Set(stakes.map(stake => stake.sponsorship.id));
    } catch (e) {
        console.warn('Failed to fetch operator stakes:', e);
        return new Set();
    }
}

/**
 * Fetch zero balance or stopped sponsorships (sponsorships with remaining balance = 0 OR isRunning = false)
 * Makes two queries and combines results to capture all "inactive" sponsorships
 */
async function fetchZeroBalanceSponsorships(skip = 0) {
    // Query for zero balance sponsorships 
    const queryZeroBalance = `
        query GetZeroBalanceSponsorships {
            sponsorships(
                first: ${STREAMS_PER_PAGE},
                skip: ${skip},
                orderBy: spotAPY,
                orderDirection: desc,
                where: { remainingWei: "0", operatorCount_gt: 0 }
            ) {
                id
                spotAPY
                totalStakedWei
                remainingWei
                operatorCount
                isRunning
                totalPayoutWeiPerSec
                stream {
                    id
                    metadata
                }
                stakes(first: 100, orderBy: amountWei, orderDirection: desc) {
                    operator {
                        id
                        metadataJsonString
                    }
                    amountWei
                }
            }
        }
    `;
    
    // Query for stopped sponsorships (isRunning = false) - no operatorCount filter
    // This will catch ALL stopped sponsorships including those with remaining balance
    const queryNotRunning = `
        query GetStoppedSponsorships {
            sponsorships(
                first: ${STREAMS_PER_PAGE},
                skip: ${skip},
                orderBy: spotAPY,
                orderDirection: desc,
                where: { isRunning: false }
            ) {
                id
                spotAPY
                totalStakedWei
                remainingWei
                operatorCount
                isRunning
                totalPayoutWeiPerSec
                stream {
                    id
                    metadata
                }
                stakes(first: 100, orderBy: amountWei, orderDirection: desc) {
                    operator {
                        id
                        metadataJsonString
                    }
                    amountWei
                }
            }
        }
    `;
    
    try {
        // Run both queries in parallel
        const [dataZeroBalance, dataNotRunning] = await Promise.all([
            Services.runQuery(queryZeroBalance),
            Services.runQuery(queryNotRunning)
        ]);
        
        const zeroBalanceSpons = dataZeroBalance.sponsorships || [];
        const notRunningSpons = dataNotRunning.sponsorships || [];
        
        logger.log(`Zero balance sponsorships: ${zeroBalanceSpons.length}, Stopped sponsorships: ${notRunningSpons.length}`);
        
        // Combine and deduplicate by sponsorship ID
        const seen = new Set();
        const combined = [];
        
        for (const s of [...zeroBalanceSpons, ...notRunningSpons]) {
            if (!seen.has(s.id)) {
                seen.add(s.id);
                combined.push(s);
            }
        }
        
        // Sort by APY descending
        combined.sort((a, b) => parseFloat(b.spotAPY || 0) - parseFloat(a.spotAPY || 0));
        
        logger.log(`Combined inactive sponsorships: ${combined.length}`);
        
        return combined;
    } catch (error) {
        logger.error('Failed to fetch zero balance/stopped sponsorships:', error);
        return [];
    }
}

/**
 * Fetch all streams (ordered by updatedAt desc)
 */
async function fetchAllStreams(skip = 0) {
    const query = `
        query GetAllStreams {
            streams(
                first: ${STREAMS_PER_PAGE},
                skip: ${skip},
                orderBy: updatedAt,
                orderDirection: desc
            ) {
                id
                createdAt
                updatedAt
                metadata
                sponsorships(first: 1) {
                    id
                }
                permissions(first: 10) {
                    userAddress
                    subscribeExpiration
                    publishExpiration
                }
                storageNodes(first: 1) {
                    id
                }
            }
        }
    `;
    
    try {
        const data = await Services.runQuery(query);
        return data.streams || [];
    } catch (error) {
        logger.error('Failed to fetch streams:', error);
        return [];
    }
}

/**
 * Search sponsorships via API by stream ID
 * @param {string} searchTerm - Search term to match stream ID
 * @param {boolean} includeInactive - Include zero balance/stopped sponsorships
 */
async function searchSponsorships(searchTerm, includeInactive = false) {
    // Escape special characters for GraphQL
    const sanitizedTerm = searchTerm.replace(/"/g, '\\"');
    
    // Build where conditions based on includeInactive toggle
    const activeCondition = includeInactive 
        ? '' // No filter - get all 
        : ', isRunning: true, remainingWei_gt: "0"';
    
    const query = `
        query searchSponsorships {
            sponsorships(
                first: ${STREAMS_PER_PAGE},
                orderBy: spotAPY,
                orderDirection: desc,
                where: { stream_: { idAsString_contains_nocase: "${sanitizedTerm}" }${activeCondition} }
            ) {
                id
                spotAPY
                totalStakedWei
                remainingWei
                operatorCount
                isRunning
                totalPayoutWeiPerSec
                stream {
                    id
                    metadata
                }
                stakes(first: 100, orderBy: amountWei, orderDirection: desc) {
                    operator {
                        id
                        metadataJsonString
                    }
                    amountWei
                }
            }
        }
    `;
    
    try {
        const data = await Services.runQuery(query);
        return data.sponsorships || [];
    } catch (error) {
        logger.error('Failed to Search sponsorships:', error);
        return [];
    }
}

/**
 * Search all streams via API by stream ID
 * @param {string} searchTerm - Search term to match stream ID
 */
async function searchAllStreams(searchTerm) {
    // Escape special characters for GraphQL
    const sanitizedTerm = searchTerm.replace(/"/g, '\\"');
    
    const query = `
        query SearchAllStreams {
            streams(
                first: ${STREAMS_PER_PAGE},
                orderBy: updatedAt,
                orderDirection: desc,
                where: { idAsString_contains_nocase: "${sanitizedTerm}" }
            ) {
                id
                createdAt
                updatedAt
                metadata
                sponsorships(first: 1) {
                    id
                }
                permissions(first: 10) {
                    userAddress
                    subscribeExpiration
                    publishExpiration
                }
                storageNodes(first: 1) {
                    id
                }
            }
        }
    `;
    
    try {
        const data = await Services.runQuery(query);
        return data.streams || [];
    } catch (error) {
        logger.error('Failed to search all streams:', error);
        return [];
    }
}

// ============================================
// Stream Detail Data Fetching
// ============================================

// Detail view state
const detailState = {
    currentStreamId: null,
    currentSponsorshipId: null,
    isSponsored: false,
    subscription: null,
    subscriptions: [], // For subscribing to multiple partitions
    messageCount: 0,
    messageTimestamps: [],
    bytesReceived: 0,
    bytesTimestamps: [], // {timestamp, bytes} for KB/s calculation
    partitions: 1, // Number of partitions in the stream
    sponsorshipStakes: [], // Operators staked in current sponsorship
    // Unified chart state
    chart: null,
    chartData: null,
    currentChartType: 'apy',
    currentViewMode: 'data',
    currentTimeframe: 'all',
    // Remaining balance ticker state
    remainingBalanceData: null, // {remainingWei: BigInt, changePerSecond: BigInt, lastUpdated: number}
    remainingBalanceTickerInterval: null
};

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
function stopRemainingBalanceTicker() {
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

/**
 * Fetch complete stream details including permissions
 */
async function fetchStreamDetails(streamId) {
    // Escape quotes in stream ID for safe interpolation
    const sanitizedId = streamId.replace(/"/g, '\\"');
    
    const query = `
        query GetStreamDetails {
            stream(id: "${sanitizedId}") {
                id
                metadata
                createdAt
                updatedAt
                permissions(first: 100) {
                    id
                    userAddress
                    canEdit
                    canDelete
                    publishExpiration
                    subscribeExpiration
                    canGrant
                }
                storageNodes {
                    id
                    metadata
                    lastSeen
                }
                sponsorships(first: 10, orderBy: spotAPY, orderDirection: desc) {
                    id
                    spotAPY
                    totalStakedWei
                    remainingWei
                    cumulativeSponsoring
                    totalPayoutWeiPerSec
                    minimumStakingPeriodSeconds
                    projectedInsolvency
                    operatorCount
                    isRunning
                    stakes(first: 100, orderBy: amountWei, orderDirection: desc) {
                        operator {
                            id
                            metadataJsonString
                        }
                        amountWei
                    }
                    sponsoringEvents(first: 50, orderBy: date, orderDirection: desc) {
                        id
                        sponsor
                        amount
                        date
                    }
                }
            }
        }
    `;
    
    const data = await Services.runQuery(query);
    return data.stream;
}

/**
 * Fetch sponsorship daily buckets for charts
 */
async function fetchSponsorshipDailyData(sponsorshipId) {
    const query = `
        query GetSponsorshipDailyData {
            sponsorshipDailyBuckets(
                first: 90,
                orderBy: date,
                orderDirection: desc,
                where: { sponsorship: "${sponsorshipId}" }
            ) {
                id
                date
                spotAPY
                totalStakedWei
                operatorCount
            }
        }
    `;
    
    const data = await Services.runQuery(query);
    return (data.sponsorshipDailyBuckets || []).reverse();
}

/**
 * Determine access control type based on permissions
 * Returns: 'public-all', 'public-subscribe', 'private'
 */
function determineAccessControl(permissions) {
    if (!permissions || permissions.length === 0) {
        // No permissions set = default public subscribe
        return 'public-subscribe';
    }
    
    // Check for public permissions (address = 0x0000...)
    const publicPermission = permissions.find(p => 
        p.userAddress && p.userAddress.toLowerCase() === '0x0000000000000000000000000000000000000000'
    );
    
    if (publicPermission) {
        const hasPublicPublish = publicPermission.publishExpiration && 
            parseInt(publicPermission.publishExpiration) > Math.floor(Date.now() / 1000);
        const hasPublicSubscribe = publicPermission.subscribeExpiration && 
            parseInt(publicPermission.subscribeExpiration) > Math.floor(Date.now() / 1000);
        
        if (hasPublicPublish && hasPublicSubscribe) {
            return 'public-all';
        } else if (hasPublicSubscribe) {
            return 'public-subscribe';
        }
    }
    
    return 'private';
}

/**
 * Get access control badge HTML
 */
function getAccessControlBadge(accessType) {
    const configs = {
        'public-all': {
            text: 'Public (Publish & Subscribe)',
            icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>`,
            classes: 'bg-green-500/20 text-green-400 border-green-500/30'
        },
        'public-subscribe': {
            text: 'Public (Subscribe Only)',
            icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
            </svg>`,
            classes: 'bg-blue-500/20 text-blue-400 border-blue-500/30'
        },
        'private': {
            text: 'Private',
            icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
            </svg>`,
            classes: 'bg-red-500/20 text-red-400 border-red-500/30'
        }
    };
    
    const config = configs[accessType] || configs['private'];
    return `<span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border ${config.classes} text-sm font-medium">
        ${config.icon}
        ${config.text}
    </span>`;
}

// ============================================
// Rendering
// ============================================

/**
 * Create HTML for a sponsorship row
 */
function createSponsorshipRowHtml(sponsorship, index) {
    const streamId = sponsorship.stream?.id || 'Unknown Stream';
    const displayStreamId = streamId.length > 50 ? streamId.substring(0, 47) + '...' : streamId;
    const apy = parseFloat(sponsorship.spotAPY || 0);
    const apyFormatted = Math.round(apy * 100);
    const totalStaked = Utils.convertWeiToData(sponsorship.totalStakedWei || '0');
    const operatorCount = sponsorship.operatorCount || 0;
    const hasZeroBalance = sponsorship.remainingWei === '0' || BigInt(sponsorship.remainingWei || '0') === BigInt(0);
    const isNotRunning = !sponsorship.isRunning;
    const isInactive = hasZeroBalance || isNotRunning;
    const isStaked = state.operatorStakes.has(sponsorship.id);
    
    // Calculate payout rate in DATA/day
    const payoutWeiPerSec = BigInt(sponsorship.totalPayoutWeiPerSec || '0');
    const payoutWeiPerDay = payoutWeiPerSec * BigInt(86400);
    const payoutPerDay = Utils.convertWeiToData(payoutWeiPerDay.toString());
    const payoutPerDayFormatted = Utils.formatBigNumber(parseFloat(payoutPerDay));
    
    // Encode the stream ID for URL - preserve slashes but encode other special chars
    // Use encodeURI to keep slashes intact
    const encodedStreamId = streamId.split('/').map(part => encodeURIComponent(part)).join('/');
    const sponsorshipId = sponsorship.id;
    
    // Badge for inactive sponsorships - show specific reason
    let inactiveBadge = '';
    if (hasZeroBalance) {
        inactiveBadge = '<span class="ml-2 px-1.5 py-0.5 text-[10px] font-semibold bg-orange-500/20 text-orange-400 rounded">ZERO BALANCE</span>';
    } else if (isNotRunning) {
        inactiveBadge = '<span class="ml-2 px-1.5 py-0.5 text-[10px] font-semibold bg-red-500/20 text-red-400 rounded">STOPPED</span>';
    }
    
    // Staked badge for sponsorships where user's operator has stake
    const stakedBadge = isStaked ? '<span class="ml-2 px-1.5 py-0.5 text-[10px] font-semibold bg-blue-500/20 text-blue-400 rounded">STAKED</span>' : '';
    
    // Row styling for inactive
    const rowClasses = isInactive ? 'stream-row cursor-pointer hover:bg-white/5 transition-colors group opacity-70' : 'stream-row cursor-pointer hover:bg-white/5 transition-colors group';
    
    return `
        <tr class="${rowClasses}" 
            data-stream-id="${Utils.escapeHtml(streamId)}" 
            data-sponsorship-id="${sponsorshipId}"
            data-sponsored="true"
            data-inactive="${isInactive}"
            onclick="event.preventDefault(); window.router.navigate('/stream/${encodedStreamId}?sponsored=true&sponsorshipId=${sponsorshipId}')">
            <td class="px-4 py-3">
                <span class="font-mono text-sm group-hover:text-blue-400 transition-colors" title="${Utils.escapeHtml(streamId)}">${Utils.escapeHtml(displayStreamId)}</span>${stakedBadge}${inactiveBadge}
            </td>
            <td class="px-4 py-3 text-right font-mono text-gray-300 whitespace-nowrap">${payoutPerDayFormatted}</td>
            <td class="px-4 py-3 text-right font-mono text-gray-300 whitespace-nowrap">${apyFormatted}%</td>
            <td class="px-4 py-3 text-right font-mono text-gray-300 whitespace-nowrap">${Utils.formatBigNumber(totalStaked)}</td>
            <td class="px-4 py-3 text-right font-mono text-gray-300 whitespace-nowrap">${operatorCount}</td>
        </tr>
    `;
}

/**
 * Create HTML for an all streams row
 */
function createAllStreamRowHtml(stream, index) {
    const streamId = stream.id || 'Unknown Stream';
    // Desktop: show more characters, Mobile: abbreviated format
    const displayStreamIdDesktop = streamId.length > 80 ? streamId.substring(0, 77) + '...' : streamId;
    const displayStreamIdMobile = streamId.length > 30 ? streamId.substring(0, 27) + '...' : streamId;
    
    // Format date as dd/mm/yyyy hh:mm
    let createdAt = 'N/A';
    if (stream.createdAt) {
        const date = new Date(parseInt(stream.createdAt) * 1000);
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        createdAt = `${day}/${month}/${year} ${hours}:${minutes}`;
    }
    
    // Check if stream has sponsorships
    const hasSponsorship = stream.sponsorships && stream.sponsorships.length > 0;
    const sponsorshipIcon = hasSponsorship 
        ? `<svg class="w-5 h-5" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg" title="Has Sponsorship">
            <circle cx="28" cy="28" r="28" fill="#F7600A"/>
            <path fill-rule="evenodd" clip-rule="evenodd" d="M32.9091 10.2118V9.08164C32.9091 8.69418 32.5861 8.38241 32.199 8.4008C24.6009 8.76169 18.5119 14.8843 18.2056 22.4955C18.2219 22.9725 18.608 23.0974 18.8351 23.0974H19.983C20.3463 23.0974 20.6441 22.8122 20.6629 22.4495C20.989 16.1879 26.0134 11.1697 32.278 10.8522C32.7558 10.7908 32.9091 10.5297 32.9091 10.2118ZM22.5761 23.0974H23.6747C24.0313 23.0974 24.3221 22.8195 24.348 22.4638C24.6586 18.2097 28.0701 14.8164 32.3324 14.5336C32.523 14.521 32.9091 14.3783 32.9091 13.8844V12.7659C32.9091 12.3707 32.5739 12.0603 32.1795 12.0861C26.6654 12.4459 22.256 16.8547 21.8961 22.3679C21.8704 22.7623 22.1808 23.0974 22.5761 23.0974ZM37.1763 32.9026C37.4035 32.9026 37.7895 33.0275 37.8058 33.5045C37.4995 41.1158 31.4105 47.2383 23.8124 47.5993C23.4253 47.6176 23.1023 47.3059 23.1023 46.9183V45.7883C23.1023 45.4704 23.2556 45.2093 23.7333 45.1479C29.9981 44.8304 35.0224 39.8121 35.3485 33.5505C35.3673 33.1878 35.6651 32.9026 36.0284 32.9026H37.1763ZM33.4353 32.9026C33.8306 32.9026 34.141 33.2377 34.1153 33.6321C33.7554 39.1454 29.346 43.5542 23.8319 43.914C23.4375 43.9398 23.1023 43.6293 23.1023 43.2341V42.1155C23.1023 41.6217 23.4884 41.4791 23.679 41.4664C27.9413 41.1837 31.3529 37.7903 31.6633 33.5362C31.6893 33.1805 31.9801 32.9026 32.3367 32.9026H33.4353ZM29.7445 32.9026C30.1445 32.9026 30.463 33.246 30.4231 33.6441C30.0758 37.1151 27.3154 39.8751 23.8438 40.2224C23.4458 40.2623 23.1023 39.9438 23.1023 39.5438V38.4201C23.1023 37.9604 23.5015 37.795 23.6961 37.7715C25.9261 37.5025 27.6953 35.7373 27.9703 33.5095C28.0129 33.1647 28.2999 32.9026 28.6474 32.9026H29.7445ZM10.212 23.0945C10.53 23.0945 10.7911 23.2477 10.8525 23.7254C11.1701 29.9892 16.189 35.0129 22.4516 35.3389C22.8143 35.3577 23.0996 35.6555 23.0996 36.0187V37.1666C23.0996 37.3936 22.9746 37.7796 22.4976 37.7959C14.8853 37.4896 8.76181 31.4015 8.4008 23.8045C8.3824 23.4174 8.69423 23.0945 9.0818 23.0945H10.212ZM13.8853 23.0945C14.3792 23.0945 14.5219 23.4805 14.5346 23.6711C14.8173 27.9328 18.2111 31.3439 22.4659 31.6543C22.8216 31.6803 23.0996 31.971 23.0996 32.3276V33.426C23.0996 33.8212 22.7644 34.1316 22.3699 34.1059C16.8559 33.746 12.4464 29.3373 12.0866 23.824C12.0608 23.4296 12.3713 23.0945 12.7666 23.0945H13.8853ZM33.5024 18.1729C41.1148 18.4792 47.2382 24.5673 47.5993 32.1644C47.6176 32.5514 47.3058 32.8744 46.9183 32.8744H45.788C45.4701 32.8744 45.2089 32.7211 45.1475 32.2434C44.8299 25.9795 39.811 20.956 33.5485 20.6299C33.1857 20.6111 32.9005 20.3133 32.9005 19.9501V18.8023C32.9005 18.5752 33.0253 18.1892 33.5024 18.1729ZM33.6301 21.8629C39.1442 22.2227 43.5536 26.6315 43.9135 32.1448C43.9392 32.5392 43.6288 32.8744 43.2335 32.8744H42.1148C41.6208 32.8744 41.4782 32.4883 41.4655 32.2977C41.1828 28.036 37.7889 24.6249 33.5342 24.3145C33.1784 24.2886 32.9005 23.9978 32.9005 23.6412V22.5428C32.9005 22.1476 33.2357 21.8372 33.6301 21.8629ZM33.642 25.5545C37.1136 25.9019 39.874 28.6619 40.2213 32.1329C40.2612 32.5309 39.9427 32.8744 39.5427 32.8744H38.4188C37.959 32.8744 37.7936 32.4752 37.7701 32.2806C37.501 30.0509 35.7356 28.282 33.5075 28.0071C33.1626 27.9645 32.9005 27.6775 32.9005 27.33V26.2331C32.9005 25.8331 33.244 25.5147 33.642 25.5545ZM17.5812 23.0945C18.0411 23.0945 18.2064 23.4936 18.2299 23.6882C18.4991 25.9179 20.2644 27.6868 22.4926 27.9618C22.8374 28.0043 23.0996 28.2913 23.0996 28.6388V29.7357C23.0996 30.1357 22.7561 30.4541 22.358 30.4144C18.8865 30.0669 16.1261 27.3069 15.7786 23.8359C15.7388 23.4379 16.0573 23.0945 16.4574 23.0945H17.5812ZM32.9091 16.4562V17.5798C32.9091 18.0396 32.51 18.205 32.3152 18.2285C30.0853 18.4976 28.3161 20.2627 28.0411 22.4905C27.9985 22.8353 27.7115 23.0974 27.364 23.0974H26.2669C25.8669 23.0974 25.5484 22.7539 25.5882 22.3559C25.9357 18.885 28.6961 16.125 32.1675 15.7776C32.5656 15.7378 32.9091 16.0562 32.9091 16.4562Z" fill="white"/>
           </svg>` 
        : '';
    
    // Parse partitions from metadata
    let partitions = 1;
    try {
        if (stream.metadata) {
            const meta = JSON.parse(stream.metadata);
            partitions = meta.partitions || 1;
        }
    } catch (e) { /* ignore */ }
    
    // Create partition pill (purple badge like in Live Data Viewer)
    const partitionPill = `<span class="px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded text-[10px] font-medium">P${partitions}</span>`;
    
    // Check if stream has storage nodes
    const hasStorage = stream.storageNodes && stream.storageNodes.length > 0;
    const storageIcon = hasStorage
        ? `<svg class="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" title="Has Storage">
             <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"/>
           </svg>`
        : '';
    
    // Determine access control (public vs private)
    const accessType = determineAccessControl(stream.permissions);
    const isPublic = accessType === 'public-all' || accessType === 'public-subscribe';
    const accessIcon = isPublic
        ? `<svg class="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" title="Public Stream">
             <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
             <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
           </svg>`
        : `<svg class="w-4 h-4 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" title="Private Stream">
             <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
           </svg>`;
    
    // Encode the stream ID for URL - preserve slashes but encode other special chars
    const encodedStreamId = streamId.split('/').map(part => encodeURIComponent(part)).join('/');
    
    return `
        <tr class="stream-row cursor-pointer hover:bg-white/5 transition-colors group" 
            data-stream-id="${Utils.escapeHtml(streamId)}"
            data-sponsored="false"
            onclick="event.preventDefault(); window.router.navigate('/stream/${encodedStreamId}')">
            <td class="px-4 py-3">
                <span class="font-mono text-sm group-hover:text-blue-400 transition-colors hidden md:inline" title="${Utils.escapeHtml(streamId)}">${Utils.escapeHtml(displayStreamIdDesktop)}</span>
                <span class="font-mono text-sm group-hover:text-blue-400 transition-colors md:hidden" title="${Utils.escapeHtml(streamId)}">${Utils.escapeHtml(displayStreamIdMobile)}</span>
            </td>
            <td class="px-4 py-3 text-center">${sponsorshipIcon}</td>
            <td class="px-4 py-3 text-center">${storageIcon}</td>
            <td class="px-4 py-3 text-center">${accessIcon}</td>
            <td class="px-4 py-3 text-center whitespace-nowrap">${partitionPill}</td>
            <td class="px-4 py-3 text-right text-gray-400 whitespace-nowrap hidden md:table-cell">${createdAt}</td>
        </tr>
    `;
}

/**
 * Render sponsorships table
 */
function renderSponsorshipsTable(streams, isAppend = false) {
    const tbody = document.getElementById('sponsorships-tbody');
    const loadMoreBtn = document.getElementById('load-more-sponsorships-btn');
    const emptyState = document.getElementById('sponsorships-empty');
    
    if (!tbody) return;
    
    if (!isAppend) {
        tbody.innerHTML = '';
    }
    
    if (streams.length === 0 && !isAppend) {
        if (emptyState) emptyState.classList.remove('hidden');
        if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
        return;
    }
    
    if (emptyState) emptyState.classList.add('hidden');
    
    const startIndex = isAppend ? state.sponsorships.length - streams.length : 0;
    const html = streams.map((s, i) => createSponsorshipRowHtml(s, startIndex + i)).join('');
    
    if (isAppend) {
        tbody.insertAdjacentHTML('beforeend', html);
    } else {
        tbody.innerHTML = html;
    }
    
    // Update load more button
    if (loadMoreBtn) {
        loadMoreBtn.classList.toggle('hidden', !state.hasMoreSponsorships);
    }
}

/**
 * Render all streams table
 */
function renderAllStreamsTable(streams, isAppend = false) {
    const tbody = document.getElementById('nonsponsorships-tbody');
    const loadMoreBtn = document.getElementById('load-more-nonsponsored-btn');
    const emptyState = document.getElementById('nonsponsorships-empty');
    
    if (!tbody) return;
    
    if (!isAppend) {
        tbody.innerHTML = '';
    }
    
    if (streams.length === 0 && !isAppend) {
        if (emptyState) emptyState.classList.remove('hidden');
        if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
        return;
    }
    
    if (emptyState) emptyState.classList.add('hidden');
    
    const startIndex = isAppend ? state.allStreams.length - streams.length : 0;
    const html = streams.map((s, i) => createAllStreamRowHtml(s, startIndex + i)).join('');
    
    if (isAppend) {
        tbody.insertAdjacentHTML('beforeend', html);
    } else {
        tbody.innerHTML = html;
    }
    
    // Update load more button
    if (loadMoreBtn) {
        loadMoreBtn.classList.toggle('hidden', !state.hasMoreAllStreams);
    }
}

// ============================================
// Event Handlers
// ============================================

/**
 * Switch between tabs
 */
function switchTab(tab) {
    state.activeTab = tab;
    
    const sponsorshipsTab = document.getElementById('streams-tab-sponsorships');
    const allStreamsTab = document.getElementById('streams-tab-nonsponsored');
    const sponsorshipsPanel = document.getElementById('streams-panel-sponsorships');
    const allStreamsPanel = document.getElementById('streams-panel-nonsponsored');
    const sponsorshipsCount = document.getElementById('streams-tab-sponsorships-count');
    const allStreamsTabCount = document.getElementById('streams-tab-nonsponsored-count');
    const searchInput = document.getElementById('streams-search-input');
    
    // Safety check - if elements don't exist yet, skip UI updates
    if (!sponsorshipsTab || !allStreamsTab || !sponsorshipsPanel || !allStreamsPanel) {
        return;
    }
    
    if (tab === 'sponsorships') {
        // Update sponsorships tab to active
        sponsorshipsTab.classList.remove('text-gray-400', 'border-transparent', 'hover:border-gray-600');
        sponsorshipsTab.classList.add('text-white', 'border-blue-500', 'bg-gradient-to-t', 'from-blue-500/10', 'to-transparent');
        if (sponsorshipsCount) {
            sponsorshipsCount.classList.remove('bg-gray-500/20', 'text-gray-400');
            sponsorshipsCount.classList.add('bg-green-500/20', 'text-green-400');
        }
        
        // Update all streams tab to inactive
        allStreamsTab.classList.remove('text-white', 'border-blue-500', 'bg-gradient-to-t', 'from-blue-500/10', 'to-transparent');
        allStreamsTab.classList.add('text-gray-400', 'border-transparent', 'hover:border-gray-600');
        if (allStreamsTabCount) {
            allStreamsTabCount.classList.remove('bg-green-500/20', 'text-green-400');
            allStreamsTabCount.classList.add('bg-gray-500/20', 'text-gray-400');
        }
        
        // Show/hide panels
        sponsorshipsPanel.classList.remove('hidden');
        allStreamsPanel.classList.add('hidden');
    } else {
        // Update all streams tab to active
        allStreamsTab.classList.remove('text-gray-400', 'border-transparent', 'hover:border-gray-600');
        allStreamsTab.classList.add('text-white', 'border-blue-500', 'bg-gradient-to-t', 'from-blue-500/10', 'to-transparent');
        if (allStreamsTabCount) {
            allStreamsTabCount.classList.remove('bg-gray-500/20', 'text-gray-400');
            allStreamsTabCount.classList.add('bg-green-500/20', 'text-green-400');
        }
        
        // Update sponsorships tab to inactive
        sponsorshipsTab.classList.remove('text-white', 'border-blue-500', 'bg-gradient-to-t', 'from-blue-500/10', 'to-transparent');
        sponsorshipsTab.classList.add('text-gray-400', 'border-transparent', 'hover:border-gray-600');
        if (sponsorshipsCount) {
            sponsorshipsCount.classList.remove('bg-green-500/20', 'text-green-400');
            sponsorshipsCount.classList.add('bg-gray-500/20', 'text-gray-400');
        }
        
        // Show/hide panels
        allStreamsPanel.classList.remove('hidden');
        sponsorshipsPanel.classList.add('hidden');
    }
    
    // If there's an active search query, execute search for the new tab
    const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';
    if (searchTerm) {
        handleStreamSearch(searchTerm);
    }
}

/**
 * Update tab counters
 */
function updateTabCounters() {
    const sponsorshipsCount = document.getElementById('streams-tab-sponsorships-count');
    const allStreamsCount = document.getElementById('streams-tab-nonsponsored-count');
    
    if (sponsorshipsCount) {
        // Include zero balance count if toggle is on
        const totalSponsorships = state.showZeroBalance 
            ? state.sponsorships.length + state.zeroBalanceStreams.length 
            : state.sponsorships.length;
        const hasMore = state.showZeroBalance 
            ? (state.hasMoreSponsorships || state.hasMoreZeroBalance) 
            : state.hasMoreSponsorships;
        sponsorshipsCount.textContent = totalSponsorships + (hasMore ? '+' : '');
    }
    if (allStreamsCount) {
        allStreamsCount.textContent = state.allStreams.length + (state.hasMoreAllStreams ? '+' : '');
    }
}

/**
 * Handle load more sponsorships
 */
async function handleLoadMoreSponsorships() {
    // Check if we're in zero balance mode
    if (state.showZeroBalance) {
        // In zero balance mode, we can load more if either has more
        if (state.sponsorshipsLoading || state.zeroBalanceLoading) return;
        if (!state.hasMoreSponsorships && !state.hasMoreZeroBalance) return;
    } else {
        if (state.sponsorshipsLoading || !state.hasMoreSponsorships) return;
    }
    
    const btn = document.getElementById('load-more-sponsorships-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent animate-spin inline-block mr-2"></div>Loading...';
    }
    
    state.sponsorshipsLoading = true;
    
    try {
        // Load more sponsorships if available
        if (state.hasMoreSponsorships) {
            const newStreams = await fetchSponsorships(state.sponsorshipsSkip);
            
            if (newStreams.length < STREAMS_PER_PAGE) {
                state.hasMoreSponsorships = false;
            }
            
            state.sponsorships = [...state.sponsorships, ...newStreams];
            state.sponsorshipsSkip += newStreams.length;
        }
        
        // In zero balance mode, also load more zero balance if available
        if (state.showZeroBalance && state.hasMoreZeroBalance) {
            state.zeroBalanceLoading = true;
            const newZeroBalance = await fetchZeroBalanceSponsorships(state.zeroBalanceSkip);
            
            if (newZeroBalance.length < STREAMS_PER_PAGE) {
                state.hasMoreZeroBalance = false;
            }
            
            state.zeroBalanceStreams = [...state.zeroBalanceStreams, ...newZeroBalance];
            state.zeroBalanceSkip += newZeroBalance.length;
            state.zeroBalanceLoading = false;
        }
        
        // Re-render the table with sorting
        if (state.showZeroBalance) {
            const combined = [...state.sponsorships, ...state.zeroBalanceStreams];
            renderSponsorshipsTable(sortSponsorships(combined), false);
            // Update button visibility
            if (btn) {
                btn.classList.toggle('hidden', !state.hasMoreSponsorships && !state.hasMoreZeroBalance);
            }
        } else {
            renderSponsorshipsTable(sortSponsorships(state.sponsorships), false);
        }
        
        updateTabCounters();
    } catch (error) {
        logger.error('Failed to Load more sponsorships:', error);
        UI.showToast({ type: 'error', title: 'Error', message: 'Failed to load more streams' });
    } finally {
        state.sponsorshipsLoading = false;
        state.zeroBalanceLoading = false;
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Load More';
        }
    }
}

/**
 * Handle load more all streams
 */
async function handleLoadMoreAllStreams() {
    if (state.allStreamsLoading || !state.hasMoreAllStreams) return;
    
    const btn = document.getElementById('load-more-nonsponsored-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent animate-spin inline-block mr-2"></div>Loading...';
    }
    
    state.allStreamsLoading = true;
    
    try {
        const newStreams = await fetchAllStreams(state.allStreamsSkip);
        
        if (newStreams.length < STREAMS_PER_PAGE) {
            state.hasMoreAllStreams = false;
        }
        
        state.allStreams = [...state.allStreams, ...newStreams];
        state.allStreamsSkip += newStreams.length;
        
        renderAllStreamsTable(newStreams, true);
        updateTabCounters();
    } catch (error) {
        logger.error('Failed to load more streams:', error);
        UI.showToast({ type: 'error', title: 'Error', message: 'Failed to load more streams' });
    } finally {
        state.allStreamsLoading = false;
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Load More';
        }
    }
}

/**
 * Handle zero balance sponsorships toggle
 */
async function handleZeroBalanceToggle(event) {
    state.showZeroBalance = event.target.checked;
    
    const loadMoreBtn = document.getElementById('load-more-sponsorships-btn');
    const searchInput = document.getElementById('streams-search-input');
    const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';
    
    if (state.showZeroBalance) {
        // Load zero balance sponsorships if not already loaded
        if (state.zeroBalanceStreams.length === 0) {
            UI.showLoader(true);
            try {
                const zeroBalance = await fetchZeroBalanceSponsorships(0);
                state.zeroBalanceStreams = zeroBalance;
                state.zeroBalanceSkip = zeroBalance.length;
                state.hasMoreZeroBalance = zeroBalance.length >= STREAMS_PER_PAGE;
            } catch (error) {
                logger.error('Failed to load zero balance sponsorships:', error);
                UI.showToast({ type: 'error', title: 'Error', message: 'Failed to load zero balance sponsorships' });
            } finally {
                UI.showLoader(false);
            }
        }
        
        // Combine active and zero balance sponsorships
        let combined = [...state.sponsorships, ...state.zeroBalanceStreams];
        
        // Apply search filter if there's a search term
        if (searchTerm) {
            combined = combined.filter(s => (s.stream?.id || '').toLowerCase().includes(searchTerm));
            state.filteredSponsorships = sortSponsorships(combined);
            renderSponsorshipsTable(state.filteredSponsorships, false);
        } else {
            renderSponsorshipsTable(sortSponsorships(combined), false);
        }
        
        // Update load more button logic
        if (loadMoreBtn) {
            loadMoreBtn.classList.toggle('hidden', !state.hasMoreSponsorships && !state.hasMoreZeroBalance);
        }
    } else {
        // Show only active sponsorships with balance > 0
        let streams = state.sponsorships;
        
        // Apply search filter if there's a search term
        if (searchTerm) {
            streams = streams.filter(s => (s.stream?.id || '').toLowerCase().includes(searchTerm));
            state.filteredSponsorships = sortSponsorships(streams);
            renderSponsorshipsTable(state.filteredSponsorships, false);
        } else {
            renderSponsorshipsTable(sortSponsorships(streams), false);
        }
        
        if (loadMoreBtn) {
            loadMoreBtn.classList.toggle('hidden', !state.hasMoreSponsorships);
        }
    }
    
    updateTabCounters();
}

/**
 * Sort sponsorships based on current sort state
 */
function sortSponsorships(streams) {
    const sorted = [...streams];
    
    sorted.sort((a, b) => {
        let aVal, bVal;
        
        switch (state.sortField) {
            case 'payout':
                aVal = BigInt(a.totalPayoutWeiPerSec || '0');
                bVal = BigInt(b.totalPayoutWeiPerSec || '0');
                break;
            case 'apy':
                aVal = parseFloat(a.spotAPY || 0);
                bVal = parseFloat(b.spotAPY || 0);
                break;
            case 'staked':
                aVal = BigInt(a.totalStakedWei || '0');
                bVal = BigInt(b.totalStakedWei || '0');
                break;
            case 'operators':
                aVal = parseInt(a.operatorCount || 0);
                bVal = parseInt(b.operatorCount || 0);
                break;
            default:
                aVal = parseFloat(a.spotAPY || 0);
                bVal = parseFloat(b.spotAPY || 0);
        }
        
        // Handle BigInt comparison
        if (typeof aVal === 'bigint' && typeof bVal === 'bigint') {
            if (state.sortDirection === 'desc') {
                return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
            } else {
                return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
            }
        }
        
        // Handle number comparison
        if (state.sortDirection === 'desc') {
            return bVal - aVal;
        } else {
            return aVal - bVal;
        }
    });
    
    return sorted;
}

/**
 * Handle sort column click
 */
function handleSortClick(field) {
    // Toggle direction if same field, otherwise set to desc
    if (state.sortField === field) {
        state.sortDirection = state.sortDirection === 'desc' ? 'asc' : 'desc';
    } else {
        state.sortField = field;
        state.sortDirection = 'desc';
    }
    
    // Update header UI
    updateSortHeaderUI();
    
    // Re-render with sorted data
    const streams = state.showZeroBalance 
        ? [...state.sponsorships, ...state.zeroBalanceStreams]
        : state.sponsorships;
    
    // If in search mode, sort filtered results
    if (state.searchMode && state.filteredSponsorships.length > 0) {
        renderSponsorshipsTable(sortSponsorships(state.filteredSponsorships), false);
    } else {
        renderSponsorshipsTable(sortSponsorships(streams), false);
    }
}

/**
 * Update sort header UI to show current sort state
 */
function updateSortHeaderUI() {
    const fields = ['payout', 'apy', 'staked', 'operators'];
    const downArrow = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>';
    const upArrow = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"/>';
    const neutralArrow = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"/>';
    
    fields.forEach(field => {
        const header = document.getElementById(`sponsorships-sort-${field}`);
        if (!header) return;
        
        const icon = header.querySelector('.sort-icon');
        if (!icon) return;
        
        if (state.sortField === field) {
            header.classList.add('text-blue-400');
            header.classList.remove('text-gray-500');
            icon.classList.add('opacity-100');
            icon.classList.remove('opacity-0', 'group-hover:opacity-50');
            icon.innerHTML = state.sortDirection === 'desc' ? downArrow : upArrow;
        } else {
            header.classList.remove('text-blue-400');
            header.classList.add('text-gray-500');
            icon.classList.remove('opacity-100');
            icon.classList.add('opacity-0', 'group-hover:opacity-50');
            icon.innerHTML = neutralArrow;
        }
    });
}

/**
 * Handle stream search - queries API directly for results
 */
async function handleStreamSearch(term) {
    state.searchQuery = term;
    
    if (!term) {
        // Reset to show all
        state.searchMode = false;
        state.filteredSponsorships = [];
        state.filteredAllStreams = [];
        
        // Re-render with original data
        if (state.activeTab === 'sponsorships') {
            const streams = state.showZeroBalance 
                ? [...state.sponsorships, ...state.zeroBalanceStreams]
                : state.sponsorships;
            renderSponsorshipsTable(sortSponsorships(streams), false);
        } else {
            renderAllStreamsTable(state.allStreams, false);
        }
        updateTabCounters();
        return;
    }
    
    state.searchMode = true;
    
    // Hide Load More buttons during search mode
    const loadMoreSponsorshipsBtn = document.getElementById('load-more-sponsorships-btn');
    const loadMoreAllStreamsBtn = document.getElementById('load-more-nonsponsored-btn');
    if (loadMoreSponsorshipsBtn) loadMoreSponsorshipsBtn.classList.add('hidden');
    if (loadMoreAllStreamsBtn) loadMoreAllStreamsBtn.classList.add('hidden');
    
    // Show loading indicator
    UI.showLoader(true);
    
    try {
        // Search via API based on current tab
        if (state.activeTab === 'sponsorships') {
            // Search sponsorships via API, considering the inactive toggle
            const results = await searchSponsorships(term, state.showZeroBalance);
            state.filteredSponsorships = sortSponsorships(results);
            renderSponsorshipsTable(state.filteredSponsorships, false);
            
            // Hide Load More for sponsorships during search
            if (loadMoreSponsorshipsBtn) loadMoreSponsorshipsBtn.classList.add('hidden');
        } else {
            // Search all streams via API
            const results = await searchAllStreams(term);
            state.filteredAllStreams = results;
            renderAllStreamsTable(state.filteredAllStreams, false);
            
            // Hide Load More for all streams during search
            if (loadMoreAllStreamsBtn) loadMoreAllStreamsBtn.classList.add('hidden');
        }
        
        // Update counters to reflect search results
        const sponsorshipsCount = document.getElementById('streams-tab-sponsorships-count');
        const allStreamsCount = document.getElementById('streams-tab-nonsponsored-count');
        
        if (sponsorshipsCount && state.filteredSponsorships.length > 0) {
            sponsorshipsCount.textContent = state.filteredSponsorships.length;
        }
        if (allStreamsCount && state.filteredAllStreams.length > 0) {
            allStreamsCount.textContent = state.filteredAllStreams.length;
        }
    } catch (error) {
        logger.error('Failed to search streams:', error);
        UI.showToast({ type: 'error', title: 'Search Error', message: 'Failed to search streams' });
    } finally {
        UI.showLoader(false);
    }
}

// ============================================
// Public API
// ============================================

export const StreamsLogic = {
    /**
     * Get current state
     */
    getState() {
        return { ...state };
    },
    
    /**
     * Set shared state from main.js
     */
    setSharedState(sharedState) {
        if (sharedState.dataPriceUSD !== undefined) {
            state.dataPriceUSD = sharedState.dataPriceUSD;
        }
    },
    
    /**
     * Initialize the streams view
     */
    async init() {
        logger.log('StreamsLogic: Initializing...');
        
        // Reset state
        state.sponsorships = [];
        state.allStreams = [];
        state.zeroBalanceStreams = [];
        state.sponsorshipsSkip = 0;
        state.allStreamsSkip = 0;
        state.zeroBalanceSkip = 0;
        state.hasMoreSponsorships = true;
        state.hasMoreAllStreams = true;
        state.hasMoreZeroBalance = true;
        state.showZeroBalance = false;
        state.sponsorshipsLoading = false;
        state.allStreamsLoading = false;
        state.zeroBalanceLoading = false;
        state.activeTab = 'sponsorships';
        state.searchQuery = '';
        state.searchMode = false;
        state.filteredSponsorships = [];
        state.filteredAllStreams = [];
        state.sortField = 'apy';
        state.sortDirection = 'desc';
        state.operatorStakes = new Set();
        
        // Reset search input
        const searchInput = document.getElementById('streams-search-input');
        if (searchInput) {
            searchInput.value = '';
        }
        
        // Reset zero balance toggle UI
        const zeroBalanceToggle = document.getElementById('streams-show-zero-balance-toggle');
        if (zeroBalanceToggle) {
            zeroBalanceToggle.checked = false;
        }
        
        // Reset sort header UI
        updateSortHeaderUI();
        
        // Reset UI to default tab
        switchTab('nonsponsored');
        
        // Show loading state
        UI.showLoader(true);
        
        try {
            // Fetch all data in parallel (including operator stakes for badge display)
            const [sponsored, allStreams, operatorStakes] = await Promise.all([
                fetchSponsorships(0),
                fetchAllStreams(0),
                fetchOperatorStakes()
            ]);
            
            state.operatorStakes = operatorStakes;
            state.sponsorships = sponsored;
            state.allStreams = allStreams;
            state.sponsorshipsSkip = sponsored.length;
            state.allStreamsSkip = allStreams.length;
            
            if (sponsored.length < STREAMS_PER_PAGE) {
                state.hasMoreSponsorships = false;
            }
            if (allStreams.length < STREAMS_PER_PAGE) {
                state.hasMoreAllStreams = false;
            }
            
            // Render tables
            renderSponsorshipsTable(sponsored, false);
            renderAllStreamsTable(allStreams, false);
            
            // Update tab counters
            updateTabCounters();
            
            logger.log(`StreamsLogic: Loaded ${sponsored.length} sponsorships, ${allStreams.length} streams`);
        } catch (error) {
            logger.error('StreamsLogic: Failed to initialize:', error);
            UI.showToast({ type: 'error', title: 'Error', message: 'Failed to load streams' });
        } finally {
            UI.showLoader(false);
        }
    },
    
    /**
     * Setup event listeners
     */
    setupEventListeners() {
        const loadMoreSponsoredBtn = document.getElementById('load-more-sponsorships-btn');
        const loadMoreAllStreamsBtn = document.getElementById('load-more-nonsponsored-btn');
        const sponsorshipsTab = document.getElementById('streams-tab-sponsorships');
        const allStreamsTab = document.getElementById('streams-tab-nonsponsored');
        
        if (loadMoreSponsoredBtn) {
            loadMoreSponsoredBtn.addEventListener('click', handleLoadMoreSponsorships);
        }
        
        if (loadMoreAllStreamsBtn) {
            loadMoreAllStreamsBtn.addEventListener('click', handleLoadMoreAllStreams);
        }
        
        if (sponsorshipsTab) {
            sponsorshipsTab.addEventListener('click', () => switchTab('sponsorships'));
        }
        
        if (allStreamsTab) {
            allStreamsTab.addEventListener('click', () => switchTab('nonsponsored'));
        }
        
        // Search input
        const searchInput = document.getElementById('streams-search-input');
        if (searchInput) {
            let searchTimeout;
            searchInput.addEventListener('input', (e) => {
                const term = e.target.value.toLowerCase().trim();
                clearTimeout(searchTimeout);
                
                searchTimeout = setTimeout(() => {
                    handleStreamSearch(term);
                }, 300);
            });
        }
        
        // Zero balance sponsorships toggle
        const zeroBalanceToggle = document.getElementById('streams-show-zero-balance-toggle');
        if (zeroBalanceToggle) {
            zeroBalanceToggle.addEventListener('change', handleZeroBalanceToggle);
        }
        
        // Sort column headers
        const sortHeaders = ['payout', 'apy', 'staked', 'operators'];
        sortHeaders.forEach(field => {
            const header = document.getElementById(`sponsorships-sort-${field}`);
            if (header) {
                header.addEventListener('click', () => handleSortClick(field));
            }
        });
    },
    
    /**
     * Stop/cleanup module
     */
    stop() {
        logger.log('StreamsLogic: Stopping...');
        stopStreamPlayer();
        stopRemainingBalanceTicker();
        detailState.remainingBalanceData = null;
        
        // Destroy chart if exists
        if (detailState.chart) {
            detailState.chart.destroy();
            detailState.chart = null;
        }
        detailState.chartData = null;
        
        // Reset listener flags for next time
        chartListenersSetup = false;
        playerListenersSetup = false;
        
        // Hide operator stake button
        const stakeActionContainer = document.getElementById('stream-operator-stake-action');
        if (stakeActionContainer) stakeActionContainer.classList.add('hidden');
        
        // Hide stake modal if open
        const stakeModal = document.getElementById('stakeModal');
        if (stakeModal) stakeModal.classList.add('hidden');
        
        // Clear stake modal state
        currentSponsorshipForStake = null;
    },
    
    /**
     * Load and display stream detail view
     */
    async loadStreamDetail(streamId, isSponsored = false, sponsorshipId = null) {
        logger.log(`StreamsLogic: Loading stream detail for ${streamId}`);
        
        // Stop any existing stream player and clear log before loading new stream
        await stopStreamPlayer();
        clearStreamPlayerLog();
        
        // Stop any existing remaining balance ticker
        stopRemainingBalanceTicker();
        detailState.remainingBalanceData = null;
        
        detailState.currentStreamId = streamId;
        detailState.currentSponsorshipId = sponsorshipId;
        detailState.isSponsored = isSponsored;
        
        UI.showLoader(true);
        
        try {
            const stream = await fetchStreamDetails(streamId);
            
            if (!stream) {
                throw new Error('Stream not found');
            }
            
            // Render stream details
            renderStreamDetail(stream, isSponsored, sponsorshipId);
            
            // If sponsored, load charts data
            if (isSponsored && stream.sponsorships && stream.sponsorships.length > 0) {
                const targetSponsorship = sponsorshipId 
                    ? stream.sponsorships.find(s => s.id === sponsorshipId) || stream.sponsorships[0]
                    : stream.sponsorships[0];
                    
                const dailyData = await fetchSponsorshipDailyData(targetSponsorship.id);
                renderSponsorshipCharts(dailyData);
            }
            
        } catch (error) {
            logger.error('StreamsLogic: Failed to load stream detail:', error);
            UI.showToast({ type: 'error', title: 'Error', message: 'Failed to load stream details' });
        } finally {
            UI.showLoader(false);
        }
    },
    
    /**
     * Get detail state for external access
     */
    getDetailState() {
        return { ...detailState };
    }
};

// ============================================
// Stream Detail Rendering
// ============================================

/**
 * Render the stream detail view
 */
function renderStreamDetail(stream, isSponsored, sponsorshipId) {
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
            partitions = metadata.partitions || 1;
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
        // Render storage nodes
        renderStreamStorageNodes(stream.storageNodes, stream.id, metadata.storageDays);
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
function renderStreamStorageNodes(storageNodes, streamId, storageDays) {
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
                        <th class="px-4 py-3 text-left">Node</th>
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
 * Probe a storage node endpoint. The node root has no route on Streamr nodes (404),
 * so several paths are tried in parallel and any 200 counts:
 * - the registered URL as-is
 * - /capabilities (pombo storage nodes)
 * - /streams/{id}/storage/partitions/0 (Streamr storage plugin: 200 if the node stores the stream)
 * @returns {Promise<{status: 'ok'|'reachable'|'down', url: string|null}>}
 */
async function probeStorageEndpoint(url, streamId) {
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
        dot.classList.remove('bg-yellow-500', 'animate-pulse');
        dot.classList.add(isUp ? 'bg-green-500' : 'bg-red-500');
        dot.title = ok
            ? `Online - ${ok.url} responded 200`
            : reachable
                ? `Online - ${reachable.url} reachable (status hidden by CORS)`
                : 'Offline - no endpoint responded 200';
    });
}

/**
 * Update the header stats grid for sponsorship details view
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
function syncTileHeights() {
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
let currentSponsorshipForStake = null;

/**
 * Setup the operator stake button based on user's operator profile
 * @param {Object} sponsorship - The sponsorship data
 */
function setupOperatorStakeButton(sponsorship) {
    const actionContainer = document.getElementById('stream-operator-stake-action');
    const stakeBtn = document.getElementById('stream-stake-btn');
    const stakeBtnText = document.getElementById('stream-stake-btn-text');
    
    if (!actionContainer || !stakeBtn) return;
    
    // Check if user has an operator profile
    const operatorProfile = getOperatorProfile();
    if (!operatorProfile || !operatorProfile.id) {
        actionContainer.classList.add('hidden');
        return;
    }
    
    // Check if user's operator is already staked in this sponsorship
    const operatorId = operatorProfile.id.toLowerCase();
    const stakes = sponsorship.stakes || [];
    const operatorStake = stakes.find(s => s.operator?.id?.toLowerCase() === operatorId);
    const currentStakeWei = operatorStake ? operatorStake.amountWei : '0';
    
    // Store sponsorship info for modal
    currentSponsorshipForStake = {
        id: sponsorship.id,
        currentStakeWei: currentStakeWei,
        operatorId: operatorId,
        streamId: sponsorship.stream?.id || 'Unknown'
    };
    
    // Update button text and icon
    if (operatorStake && BigInt(currentStakeWei) > BigInt(0)) {
        stakeBtnText.textContent = 'Edit Stake';
        stakeBtn.innerHTML = `
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
            </svg>
            <span id="stream-stake-btn-text">Edit Stake</span>
        `;
    } else {
        stakeBtn.innerHTML = `
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"/>
            </svg>
            <span id="stream-stake-btn-text">Join as Operator</span>
        `;
    }
    
    // Show the button
    actionContainer.classList.remove('hidden');
    
    // Remove old listener and add new one
    const newBtn = stakeBtn.cloneNode(true);
    stakeBtn.parentNode.replaceChild(newBtn, stakeBtn);
    
    newBtn.addEventListener('click', () => {
        // Check if wallet is connected
        if (!window.appSigner) {
            UI.showToast({
                type: 'warning',
                title: 'Wallet Required',
                message: 'Please connect your wallet.',
                duration: 5000
            });
            return;
        }
        openStakeModal(currentSponsorshipForStake);
    });
}

/**
 * Open the stake modal for joining/editing stake
 * @param {Object} sponsorshipInfo - Sponsorship info with id, currentStakeWei, operatorId
 */
async function openStakeModal(sponsorshipInfo) {
    const modal = document.getElementById('stakeModal');
    const titleEl = document.getElementById('stake-modal-title');
    const descriptionEl = document.getElementById('stake-modal-description');
    const amountInput = document.getElementById('stake-modal-amount');
    const currentStakeEl = document.getElementById('stake-modal-current-stake');
    const freeFundsEl = document.getElementById('stake-modal-free-funds');
    const confirmBtn = document.getElementById('stake-modal-confirm');
    const cancelBtn = document.getElementById('stake-modal-cancel');
    const maxBtn = document.getElementById('stake-modal-max-btn');
    
    if (!modal) return;
    
    const currentStakeData = Utils.convertWeiToData(sponsorshipInfo.currentStakeWei);
    const isJoining = BigInt(sponsorshipInfo.currentStakeWei) === BigInt(0);
    
    // Update modal title and description
    if (titleEl) {
        titleEl.textContent = isJoining ? 'Join Sponsorship' : 'Edit Stake';
    }
    if (descriptionEl) {
        descriptionEl.textContent = isJoining 
            ? 'Enter the amount to stake in this sponsorship.'
            : 'Enter the new total stake amount for this sponsorship.';
    }
    
    // Set current stake
    if (currentStakeEl) {
        currentStakeEl.textContent = `${Utils.formatBigNumber(currentStakeData)} DATA`;
    }
    
    // Set initial amount
    if (amountInput) {
        amountInput.value = isJoining ? '' : parseFloat(currentStakeData);
    }
    
    // Fetch free funds from operator contract
    if (freeFundsEl) {
        freeFundsEl.textContent = 'Loading...';
        try {
            const query = `{
                operator(id: "${sponsorshipInfo.operatorId}") {
                    valueWithoutEarnings
                    stakes { amountWei }
                }
            }`;
            const data = await Services.runQuery(query);
            if (data.operator) {
                const totalValue = BigInt(data.operator.valueWithoutEarnings || '0');
                const stakedAmount = data.operator.stakes.reduce(
                    (sum, s) => sum + BigInt(s.amountWei || '0'), 
                    BigInt(0)
                );
                const freeBalance = totalValue > stakedAmount ? totalValue - stakedAmount : BigInt(0);
                const freeBalanceData = Utils.convertWeiToData(freeBalance.toString());
                freeFundsEl.textContent = `${Utils.formatBigNumber(freeBalanceData)} DATA`;
                
                // Store for MAX button
                freeFundsEl.dataset.freeWei = freeBalance.toString();
                freeFundsEl.dataset.currentStakeWei = sponsorshipInfo.currentStakeWei;
            } else {
                freeFundsEl.textContent = 'N/A';
            }
        } catch (e) {
            logger.error('Failed to fetch operator free funds:', e);
            freeFundsEl.textContent = 'Error';
        }
    }
    
    // Show modal
    modal.classList.remove('hidden');
    
    // Setup MAX button
    if (maxBtn) {
        const newMaxBtn = maxBtn.cloneNode(true);
        maxBtn.parentNode.replaceChild(newMaxBtn, maxBtn);
        newMaxBtn.addEventListener('click', () => {
            const freeWei = BigInt(freeFundsEl?.dataset?.freeWei || '0');
            const currentWei = BigInt(freeFundsEl?.dataset?.currentStakeWei || '0');
            const maxWei = freeWei + currentWei;
            const maxData = Utils.convertWeiToData(maxWei.toString());
            if (amountInput) amountInput.value = parseFloat(maxData);
        });
    }
    
    // Setup Cancel button
    if (cancelBtn) {
        const newCancelBtn = cancelBtn.cloneNode(true);
        cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
        newCancelBtn.addEventListener('click', () => {
            modal.classList.add('hidden');
        });
    }
    
    // Setup Confirm button
    if (confirmBtn) {
        const newConfirmBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
        newConfirmBtn.disabled = false;
        newConfirmBtn.textContent = 'Confirm';
        
        newConfirmBtn.addEventListener('click', async () => {
            await handleStakeConfirm(sponsorshipInfo, amountInput, newConfirmBtn, modal);
        });
    }
}

/**
 * Handle stake confirmation
 */
async function handleStakeConfirm(sponsorshipInfo, amountInput, confirmBtn, modal) {
    const newAmountData = parseFloat(amountInput?.value || '0');
    if (isNaN(newAmountData) || newAmountData < 0) {
        UI.showToast({
            type: 'error',
            title: 'Invalid Amount',
            message: 'Please enter a valid amount.',
            duration: 3000
        });
        return;
    }
    
    // Get signer from main app
    const signer = window.appSigner;
    if (!signer) {
        UI.showToast({
            type: 'error',
            title: 'Wallet Not Connected',
            message: 'Please connect your wallet to manage stakes.',
            duration: 5000
        });
        return;
    }
    
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent animate-spin"></div>';
    
    try {
        const newAmountWei = ethers.utils.parseUnits(String(newAmountData), 18);
        const currentStakeWei = BigInt(sponsorshipInfo.currentStakeWei);
        const newAmountWeiBig = BigInt(newAmountWei.toString());
        
        // Use executeWithFallback to handle rate limiting
        await Services.executeWithFallback(async (currentSigner) => {
            // Get gas overrides for Polygon
            const gasOverrides = await Services.getGasOverrides(currentSigner.provider);
            
            // Get operator contract
            const operatorContract = new ethers.Contract(
                sponsorshipInfo.operatorId,
                [
                    'function stake(address sponsorship, uint256 amountWei) external',
                    'function reduceStakeTo(address sponsorship, uint256 targetStakeWei) external',
                    'function unstake(address sponsorship) external'
                ],
                currentSigner
            );
            
            let tx;
            
            if (newAmountWeiBig === BigInt(0) && currentStakeWei > BigInt(0)) {
                // Unstake completely
                tx = await operatorContract.unstake(sponsorshipInfo.id, gasOverrides);
            } else if (newAmountWeiBig > currentStakeWei) {
                // Stake more
                const amountToStake = newAmountWeiBig - currentStakeWei;
                tx = await operatorContract.stake(sponsorshipInfo.id, amountToStake.toString(), gasOverrides);
            } else if (newAmountWeiBig < currentStakeWei) {
                // Reduce stake
                tx = await operatorContract.reduceStakeTo(sponsorshipInfo.id, newAmountWeiBig.toString(), gasOverrides);
            } else {
                // No change
                modal.classList.add('hidden');
                UI.showToast({
                    type: 'info',
                    title: 'No Change',
                    message: 'Stake amount unchanged.',
                    duration: 3000
                });
                return;
            }
            
            UI.showToast({
                type: 'info',
                title: 'Transaction Submitted',
                message: 'Waiting for confirmation...',
                duration: 5000
            });
            
            await tx.wait();
        }, signer);
        
        modal.classList.add('hidden');
        
        UI.showToast({
            type: 'success',
            title: 'Stake Updated',
            message: 'Your stake has been updated successfully.',
            duration: 5000
        });
        
        // Reload the stream detail to show updated data
        if (detailState.currentStreamId) {
            StreamsLogic.loadStreamDetail(
                detailState.currentStreamId, 
                detailState.isSponsored, 
                detailState.currentSponsorshipId
            );
        }
        
    } catch (error) {
        logger.error('Stake transaction failed:', error);
        
        // Provide more user-friendly error message for rate limiting
        let errorMessage = error.reason || error.message || 'Failed to update stake.';
        if (Services.isRateLimitError(error)) {
            errorMessage = 'RPC rate limited. Please try again in a few seconds.';
        }
        
        UI.showToast({
            type: 'error',
            title: 'Transaction Failed',
            message: errorMessage,
            duration: 5000
        });
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Confirm';
    }
}

/**
 * Render operators list
 */
function renderOperatorsList(stakes) {
    const container = document.getElementById('stream-operators-list');
    
    if (!stakes || stakes.length === 0) {
        container.innerHTML = `<div class="px-4 md:px-6 py-4 text-gray-500 text-center text-sm">No operators staked</div>`;
        return;
    }
    
    const html = stakes.map(stake => {
        const { name, imageUrl } = Utils.parseOperatorMetadata(stake.operator?.metadataJsonString);
        const fullName = name || Utils.shortAddress(stake.operator?.id);
        const opName = fullName.length > 20 ? fullName.slice(0, 20) + '...' : fullName;
        const stakeAmount = Utils.formatBigNumber(Utils.convertWeiToData(stake.amountWei));
        const rawStake = Utils.convertWeiToData(stake.amountWei);
        
        // Generate profile image or fallback avatar
        const profileImage = imageUrl 
            ? `<img src="${Utils.escapeHtml(imageUrl)}" alt="${Utils.escapeHtml(opName)}" class="w-7 h-7 rounded-full object-cover border border-[#444] flex-shrink-0" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/><div class="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 items-center justify-center text-white text-xs font-bold flex-shrink-0 hidden">${opName.charAt(0).toUpperCase()}</div>`
            : `<div class="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">${opName.charAt(0).toUpperCase()}</div>`;
        
        return `
            <div class="flex justify-between items-center px-4 md:px-6 py-3 border-b border-[#333] last:border-b-0 hover:bg-white/5 transition-colors">
                <div class="flex items-center gap-3 min-w-0">
                    ${profileImage}
                    <a href="/operator/${stake.operator?.id}" onclick="event.preventDefault(); window.router.navigate('/operator/${stake.operator?.id}')" class="text-blue-400 hover:text-blue-300 font-medium text-sm truncate">${Utils.escapeHtml(opName)}</a>
                </div>
                <span class="text-gray-300 font-mono text-sm flex-shrink-0 ml-2" data-tooltip-value="${rawStake}">${stakeAmount} DATA</span>
            </div>
        `;
    }).join('');
    
    container.innerHTML = html;
}

/**
 * Render funding history
 */
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
async function loadSponsorshipOnchainHistory(sponsorshipAddress) {
    const container = document.getElementById('sponsorship-history-list');
    const emptyState = document.getElementById('sponsorship-history-empty');
    
    if (!container) return;
    
    // Show loading state
    container.innerHTML = `
        <div class="flex items-center justify-center py-8">
            <div class="loader rounded-full border-4 border-t-4 border-[#555555] border-t-transparent h-8 w-8"></div>
        </div>
    `;
    if (emptyState) emptyState.classList.add('hidden');
    
    try {
        // Fetch transaction history from Polygonscan
        const result = await Services.fetchPolygonscanHistory(sponsorshipAddress, 100, [sponsorshipAddress]);
        const transactions = result.transactions || result || [];
        
        if (transactions.length === 0) {
            container.innerHTML = '';
            if (emptyState) emptyState.classList.remove('hidden');
            
            // Sync tile heights even when no transactions
            requestAnimationFrame(() => {
                syncTileHeights();
            });
            setTimeout(() => {
                syncTileHeights();
            }, 300);
            return;
        }
        
        // Render the transactions
        renderSponsorshipOnchainHistory(transactions, 'sponsorships');
        
        // Sync tile heights after history content is loaded
        requestAnimationFrame(() => {
            syncTileHeights();
        });
        
        // Additional sync for Funding/History after longer delay
        setTimeout(() => {
            syncTileHeights();
        }, 300);
    } catch (error) {
        logger.error('Failed to load sponsorship on-chain history:', error);
        container.innerHTML = `<div class="px-4 py-4 text-gray-500 text-center text-sm">Failed to load on-chain history</div>`;
        
        // Still sync tile heights even on error
        requestAnimationFrame(() => {
            syncTileHeights();
        });
        
        // Additional sync for Funding/History after longer delay
        setTimeout(() => {
            syncTileHeights();
        }, 300);
    }
}

/**
 * Render on-chain history transactions
 * @param {Array} transactions - Array of transaction objects from Polygonscan
 * @param {string} context - 'operators' or 'sponsorships' to determine badge colors
 */
function renderSponsorshipOnchainHistory(transactions, context = 'sponsorships') {
    const container = document.getElementById('sponsorship-history-list');
    if (!container) return;
    
    if (!transactions || transactions.length === 0) {
        container.innerHTML = `<div class="px-4 py-4 text-gray-500 text-center text-sm">No on-chain activity found</div>`;
        return;
    }
    
    // Build operator lookup map from stakes (address -> name)
    const operatorNameMap = new Map();
    for (const stake of detailState.sponsorshipStakes || []) {
        if (stake.operator?.id) {
            const addr = stake.operator.id.toLowerCase();
            const { name } = Utils.parseOperatorMetadata(stake.operator?.metadataJsonString);
            if (name) {
                operatorNameMap.set(addr, name);
            }
        }
    }
    
    // Sort by timestamp descending (most recent first)
    const sortedTxs = [...transactions].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    
    const html = sortedTxs.slice(0, 100).map(tx => {
        const date = tx.timestamp ? new Date(tx.timestamp * 1000).toLocaleString() : 'Unknown';
        let method = tx.methodId || 'Unknown';
        const direction = tx.direction || tx.relatedObject || 'IN';
        const amount = tx.amount ? Utils.formatBigNumber(Math.round(tx.amount).toString()) : '0';
        const token = tx.token || 'DATA';
        const txUrl = `https://polygonscan.com/tx/${tx.txHash}`;

        // Translate method names
        // If method is Delegate, show Stake (or Funding if input is transferAndCall)
        // If method is Undelegate, show Unstake
        if (method === 'Delegate') {
            // Heuristic: if input length > 10, it's likely transferAndCall (Funding)
            if (tx.input && tx.input.length > 10) {
                method = 'Funding';
            } else {
                method = 'Stake';
            }
        } else if (method === 'Undelegate') {
            method = 'Unstake';
        }

        // Determine badge style based on method/direction and context
        let badgeClass = 'tx-badge-in';
        
        if (context === 'sponsorships') {
            // Sponsorships context
            if (method === 'Stake' && direction === 'IN') {
                badgeClass = 'tx-badge-stake'; // Green for STAKE-IN
            } else if (['Unstake', 'Force Unstake', 'Reduce Stake'].includes(method)) {
                badgeClass = 'tx-badge-out'; // Red for unstake operations
            } else if (direction === 'OUT') {
                badgeClass = 'tx-badge-out';
            }
        } else if (context === 'operators') {
            // Operators context - ALL stake operations should be orange
            if (['Stake', 'Unstake', 'Force Unstake', 'Reduce Stake'].includes(method)) {
                badgeClass = 'tx-badge-stake-out'; // Orange for ALL stake operations
            } else if (direction === 'OUT') {
                badgeClass = 'tx-badge-out';
            }
        }

        // Get operator name/address 
        const otherAddress = direction === 'IN' ? tx.from : tx.to;
        let operatorDisplay = '';
        if (otherAddress) {
            const addrLower = otherAddress.toLowerCase();
            const operatorName = operatorNameMap.get(addrLower);
            if (operatorName) {
                operatorDisplay = `<span class="text-gray-400 text-xs truncate max-w-[120px]" title="${otherAddress}">${Utils.escapeHtml(operatorName)}</span>`;
            } else {
                operatorDisplay = `<span class="text-gray-500 text-xs font-mono" title="${otherAddress}">${Utils.shortAddress(otherAddress)}</span>`;
            }
        }

        return `
            <div class="flex items-center gap-3 py-2 border-b border-[#333] last:border-b-0">
                <div class="flex-shrink-0">
                    <span class="tx-badge ${badgeClass}">${Utils.escapeHtml(direction)}</span>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                        <a href="${txUrl}" target="_blank" rel="noopener noreferrer" class="text-sm font-medium text-gray-300 hover:text-white transition-colors">
                            ${Utils.escapeHtml(method)}
                        </a>
                        ${operatorDisplay}
                    </div>
                    <span class="text-xs text-gray-500">${date}</span>
                </div>
                <div class="text-right flex-shrink-0">
                    <p class="font-mono text-sm text-white">${amount} ${Utils.escapeHtml(token)}</p>
                </div>
            </div>
        `;
    }).join('');
    
    container.innerHTML = html;
}

/**
 * Render sponsorship charts - unified chart with pill toggles
 */
function renderSponsorshipCharts(dailyData) {
    if (!dailyData || dailyData.length === 0) {
        return;
    }
    
    // Store the chart data
    detailState.chartData = dailyData;
    detailState.currentChartType = 'apy';
    detailState.currentViewMode = 'data';
    detailState.currentTimeframe = 'all';
    
    // Initial render
    updateUnifiedChart();
}

/**
 * Update unified chart based on current state
 */
function updateUnifiedChart() {
    const dailyData = detailState.chartData;
    if (!dailyData || dailyData.length === 0) return;
    
    // Destroy existing chart
    if (detailState.chart) {
        detailState.chart.destroy();
        detailState.chart = null;
    }
    
    // Filter data by timeframe
    let filteredData = dailyData;
    if (detailState.currentTimeframe !== 'all') {
        const days = parseInt(detailState.currentTimeframe);
        const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
        filteredData = dailyData.filter(d => parseInt(d.date) * 1000 >= cutoff);
    }
    
    if (filteredData.length === 0) {
        filteredData = dailyData.slice(-7); // Fallback to last 7 days
    }
    
    const labels = filteredData.map(d => new Date(parseInt(d.date) * 1000).toLocaleDateString());
    const dataPriceUSD = state.dataPriceUSD || 0;
    const useUsd = detailState.currentViewMode === 'usd' && dataPriceUSD > 0;
    
    // Show/hide USD toggle based on chart type
    const viewButtons = document.getElementById('stream-chart-view-buttons');
    if (viewButtons) {
        viewButtons.classList.toggle('hidden', detailState.currentChartType !== 'stake');
    }
    
    // Prepare data based on chart type
    let chartData, chartColor, chartLabel, chartType, isStepped;
    
    switch (detailState.currentChartType) {
        case 'apy':
            chartData = filteredData.map(d => parseFloat(d.spotAPY || 0) * 100);
            chartColor = '#22c55e';
            chartLabel = 'APY (%)';
            chartType = 'line';
            isStepped = false;
            break;
        case 'stake':
            chartData = filteredData.map(d => {
                const val = Utils.convertWeiToData(d.totalStakedWei || '0');
                return useUsd ? val * dataPriceUSD : val;
            });
            chartColor = '#3b82f6';
            chartLabel = useUsd ? 'Staked (USD)' : 'Staked (DATA)';
            chartType = 'bar';
            isStepped = false;
            break;
        case 'operators':
            chartData = filteredData.map(d => parseInt(d.operatorCount || 0));
            chartColor = '#8b5cf6';
            chartLabel = 'Operators';
            chartType = 'line';
            isStepped = true;
            break;
    }
    
    const ctx = document.getElementById('stream-unified-chart')?.getContext('2d');
    if (!ctx) return;
    
    const chartConfig = {
        type: chartType,
        data: {
            labels,
            datasets: [{
                data: chartData,
                borderColor: chartColor,
                backgroundColor: chartType === 'bar' ? chartColor : `${chartColor}20`,
                fill: chartType === 'line',
                tension: 0.4,
                pointRadius: 0,
                borderWidth: 2,
                borderRadius: chartType === 'bar' ? 4 : 0,
                ...(isStepped ? { stepped: 'middle' } : {})
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#1E1E1E',
                    borderColor: '#333',
                    borderWidth: 1,
                    titleColor: '#fff',
                    bodyColor: '#a3a3a3',
                    titleFont: { family: 'Inter, system-ui, sans-serif', size: 12 },
                    bodyFont: { family: 'Inter, system-ui, sans-serif', size: 11 },
                    padding: 10,
                    cornerRadius: 6,
                    callbacks: {
                        label: function(context) {
                            const value = context.raw;
                            if (detailState.currentChartType === 'apy') {
                                return `${value.toFixed(2)}%`;
                            } else if (detailState.currentChartType === 'stake') {
                                const prefix = useUsd ? '$' : '';
                                const suffix = useUsd ? '' : ' DATA';
                                return `${prefix}${Utils.formatBigNumber(value)}${suffix}`;
                            } else {
                                return `${value} operators`;
                            }
                        }
                    }
                }
            },
            scales: {
                x: {
                    display: true,
                    grid: { display: false },
                    ticks: { 
                        color: '#666', 
                        font: { size: 10, family: 'Inter, system-ui, sans-serif' },
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 8
                    }
                },
                y: {
                    grid: { color: '#333', drawBorder: false },
                    ticks: { 
                        color: '#666', 
                        font: { size: 10, family: 'Inter, system-ui, sans-serif' },
                        callback: function(value) {
                            if (detailState.currentChartType === 'apy') {
                                return value + '%';
                            } else if (detailState.currentChartType === 'stake') {
                                const prefix = useUsd ? '$' : '';
                                return prefix + Utils.formatBigNumber(value);
                            }
                            return value;
                        }
                    }
                }
            }
        }
    };
    
    detailState.chart = new Chart(ctx, chartConfig);
}

/**
 * Setup chart event listeners for pills
 */
let chartListenersSetup = false;

function setupChartEventListeners() {
    if (chartListenersSetup) return;
    chartListenersSetup = true;
    
    // Chart type pills
    const chartTypeTabs = document.getElementById('stream-chart-type-tabs');
    if (chartTypeTabs) {
        chartTypeTabs.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-stream-chart-type]');
            if (!btn) return;
            
            const chartType = btn.getAttribute('data-stream-chart-type');
            detailState.currentChartType = chartType;
            
            // Update pill styling
            chartTypeTabs.querySelectorAll('button').forEach(b => {
                b.classList.remove('bg-blue-600', 'text-white');
                b.classList.add('text-gray-400');
            });
            btn.classList.add('bg-blue-600', 'text-white');
            btn.classList.remove('text-gray-400');
            
            updateUnifiedChart();
        });
    }
    
    // View mode pills (DATA/USD)
    const viewButtons = document.getElementById('stream-chart-view-buttons');
    if (viewButtons) {
        viewButtons.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-stream-view]');
            if (!btn) return;
            
            const viewMode = btn.getAttribute('data-stream-view');
            detailState.currentViewMode = viewMode;
            
            // Update pill styling
            viewButtons.querySelectorAll('button').forEach(b => {
                b.classList.remove('bg-blue-600', 'text-white');
                b.classList.add('text-gray-300');
            });
            btn.classList.add('bg-blue-600', 'text-white');
            btn.classList.remove('text-gray-300');
            
            updateUnifiedChart();
        });
    }
    
    // Timeframe pills
    const timeframeButtons = document.getElementById('stream-chart-timeframe-buttons');
    if (timeframeButtons) {
        timeframeButtons.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-stream-days]');
            if (!btn) return;
            
            const days = btn.getAttribute('data-stream-days');
            detailState.currentTimeframe = days;
            
            // Update pill styling
            timeframeButtons.querySelectorAll('button').forEach(b => {
                b.classList.remove('bg-blue-600', 'text-white', 'shadow-sm');
                b.classList.add('text-gray-300');
            });
            btn.classList.add('bg-blue-600', 'text-white', 'shadow-sm');
            btn.classList.remove('text-gray-300');
            
            updateUnifiedChart();
        });
    }
}

// ============================================
// Live Data Player
// ============================================

let playerListenersSetup = false;

/**
 * Initialize partition selector based on stream partitions
 */
function initializePartitionSelector(partitions) {
    const selectorContainer = document.getElementById('stream-partition-selector');
    const select = document.getElementById('stream-partition-select');
    
    if (!selectorContainer || !select) return;
    
    // Show selector only if more than 1 partition
    if (partitions > 1) {
        selectorContainer.classList.remove('hidden');
        selectorContainer.classList.add('flex');
        
        // Populate partition options with "All" first
        select.innerHTML = '';
        
        // Add "All" option first
        const allOption = document.createElement('option');
        allOption.value = 'all';
        allOption.textContent = 'All';
        select.appendChild(allOption);
        
        // Add individual partition options
        for (let i = 0; i < partitions; i++) {
            const option = document.createElement('option');
            option.value = i;
            option.textContent = `Partition ${i}`;
            select.appendChild(option);
        }
        
        // Set default to Partition 0
        select.value = '0';
    } else {
        selectorContainer.classList.add('hidden');
        selectorContainer.classList.remove('flex');
    }
}

function setupStreamPlayerListeners() {
    if (playerListenersSetup) return;
    playerListenersSetup = true;
    
    const playBtn = document.getElementById('stream-play-btn');
    const stopBtn = document.getElementById('stream-stop-btn');
    const clearBtn = document.getElementById('stream-clear-btn');
    const partitionSelect = document.getElementById('stream-partition-select');
    
    if (playBtn) {
        playBtn.addEventListener('click', startStreamPlayer);
    }
    
    if (stopBtn) {
        stopBtn.addEventListener('click', stopStreamPlayer);
    }
    
    if (clearBtn) {
        clearBtn.addEventListener('click', clearStreamPlayerLog);
    }
    
    // Add change listener for partition selector to auto-switch subscription
    if (partitionSelect) {
        partitionSelect.addEventListener('change', handlePartitionChange);
    }
}

/**
 * Handle partition dropdown change - auto-switch subscription if active
 */
async function handlePartitionChange() {
    // Only re-subscribe if there's an active subscription
    const isSubscribed = detailState.subscription || detailState.subscriptions.length > 0;
    if (!isSubscribed) return;
    
    // Stop current subscription and start new one with selected partition
    await stopStreamPlayer();
    await startStreamPlayer();
}

async function startStreamPlayer() {
    const streamId = detailState.currentStreamId;
    if (!streamId) return;
    
    const playBtn = document.getElementById('stream-play-btn');
    const stopBtn = document.getElementById('stream-stop-btn');
    const statusDot = document.getElementById('stream-player-status');
    const statusText = document.getElementById('stream-player-status-text');
    const logContainer = document.getElementById('stream-player-log');
    const partitionSelect = document.getElementById('stream-partition-select');
    
    statusText.textContent = 'Connecting...';
    statusDot.classList.remove('bg-gray-500', 'bg-green-500');
    statusDot.classList.add('bg-yellow-500');
    
    try {
        // Get the global Streamr client from Services
        const streamrClient = Services.getStreamrClient();
        if (!streamrClient) {
            throw new Error('Streamr client not initialized');
        }
        
        detailState.messageCount = 0;
        detailState.messageTimestamps = [];
        detailState.bytesReceived = 0;
        detailState.bytesTimestamps = [];
        logContainer.innerHTML = '';
        
        // Determine which partitions to subscribe to
        const selectedValue = partitionSelect ? partitionSelect.value : '0';
        const subscribeToAll = selectedValue === 'all';
        const partitions = detailState.partitions;
        
        if (subscribeToAll && partitions > 1) {
            // Subscribe to all partitions
            detailState.subscriptions = [];
            for (let i = 0; i < partitions; i++) {
                const sub = await streamrClient.subscribe(
                    { streamId, partition: i },
                    (content, metadata) => {
                        handleStreamMessage(content, metadata, i);
                    }
                );
                detailState.subscriptions.push(sub);
            }
            statusText.textContent = `Subscribed (All ${partitions} partitions)`;
        } else if (partitions > 1 && partitionSelect) {
            // Subscribe to selected partition
            const selectedPartition = parseInt(partitionSelect.value) || 0;
            detailState.subscription = await streamrClient.subscribe(
                { streamId, partition: selectedPartition },
                (content, metadata) => {
                    handleStreamMessage(content, metadata, selectedPartition);
                }
            );
            statusText.textContent = `Subscribed (Partition ${selectedPartition})`;
        } else {
            // Subscribe to stream (default partition 0)
            detailState.subscription = await streamrClient.subscribe(
                streamId,
                (content, metadata) => {
                    handleStreamMessage(content, metadata);
                }
            );
            statusText.textContent = 'Subscribed';
        }
        
        // Update UI
        playBtn.classList.add('hidden');
        stopBtn.classList.remove('hidden');
        statusDot.classList.remove('bg-yellow-500');
        statusDot.classList.add('bg-green-500');
        
        // Start rate counter
        detailState.rateInterval = setInterval(updateMessageRate, 1000);
        
    } catch (error) {
        logger.error('Failed to subscribe to stream:', error);
        statusText.textContent = 'Error: ' + error.message;
        statusDot.classList.remove('bg-yellow-500');
        statusDot.classList.add('bg-red-500');
        UI.showToast({ type: 'error', title: 'Subscription Failed', message: error.message });
    }
}

function handleStreamMessage(content, metadata, partition = null) {
    detailState.messageCount++;
    const now = Date.now();
    detailState.messageTimestamps.push(now);
    
    // Calculate message size for KB/s
    const contentStr = typeof content === 'object' ? JSON.stringify(content) : String(content);
    const messageBytes = new Blob([contentStr]).size;
    detailState.bytesReceived += messageBytes;
    detailState.bytesTimestamps.push({ timestamp: now, bytes: messageBytes });
    
    // Update count
    const msgCountEl = document.getElementById('stream-player-msg-count');
    if (msgCountEl) msgCountEl.textContent = detailState.messageCount;
    
    // Add message to log
    const logContainer = document.getElementById('stream-player-log');
    if (!logContainer) return;
    
    const msgDiv = document.createElement('div');
    msgDiv.className = 'mb-2 pb-2 border-b border-[#333] last:border-b-0';
    
    const timestamp = new Date().toLocaleTimeString();
    const partitionBadge = partition !== null 
        ? `<span class="px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded text-[10px]">P${partition}</span>` 
        : '';
    
    msgDiv.innerHTML = `
        <div class="flex items-center gap-2 mb-1">
            <span class="text-gray-500">${timestamp}</span>
            <span class="text-gray-600">#${detailState.messageCount}</span>
            ${partitionBadge}
        </div>
        <pre class="text-green-400 whitespace-pre-wrap break-all">${Utils.escapeHtml(contentStr)}</pre>
    `;
    
    logContainer.appendChild(msgDiv);
    
    // Auto-scroll to bottom
    logContainer.scrollTop = logContainer.scrollHeight;
    
    // Limit messages displayed
    while (logContainer.children.length > 100) {
        logContainer.removeChild(logContainer.firstChild);
    }
}

function updateMessageRate() {
    const now = Date.now();
    const oneSecondAgo = now - 1000;
    
    // Count messages in last second
    detailState.messageTimestamps = detailState.messageTimestamps.filter(t => t > oneSecondAgo);
    const rate = detailState.messageTimestamps.length;
    
    const rateEl = document.getElementById('stream-player-rate');
    if (rateEl) rateEl.textContent = rate;
    
    // Calculate Kbps (kilobits per second)
    detailState.bytesTimestamps = detailState.bytesTimestamps.filter(b => b.timestamp > oneSecondAgo);
    const bytesInLastSecond = detailState.bytesTimestamps.reduce((sum, b) => sum + b.bytes, 0);
    const kbps = ((bytesInLastSecond * 8) / 1000).toFixed(2);
    
    const kbpsEl = document.getElementById('stream-player-kbps');
    if (kbpsEl) kbpsEl.textContent = kbps;
}

async function stopStreamPlayer() {
    // Stop single subscription
    if (detailState.subscription) {
        try {
            await detailState.subscription.unsubscribe();
        } catch (e) {
            logger.warn('Error unsubscribing:', e);
        }
        detailState.subscription = null;
    }
    
    // Stop multiple subscriptions
    for (const sub of detailState.subscriptions) {
        try {
            await sub.unsubscribe();
        } catch (e) {
            logger.warn('Error unsubscribing from partition:', e);
        }
    }
    detailState.subscriptions = [];
    
    if (detailState.rateInterval) {
        clearInterval(detailState.rateInterval);
        detailState.rateInterval = null;
    }
    
    const playBtn = document.getElementById('stream-play-btn');
    const stopBtn = document.getElementById('stream-stop-btn');
    const statusDot = document.getElementById('stream-player-status');
    const statusText = document.getElementById('stream-player-status-text');
    
    if (playBtn) playBtn.classList.remove('hidden');
    if (stopBtn) stopBtn.classList.add('hidden');
    if (statusText) statusText.textContent = 'Idle';
    if (statusDot) {
        statusDot.classList.remove('bg-green-500', 'bg-yellow-500', 'bg-red-500');
        statusDot.classList.add('bg-gray-500');
    }
    
    // Reset KB/s display
    const kbpsEl = document.getElementById('stream-player-kbps');
    if (kbpsEl) kbpsEl.textContent = '0';
}

function clearStreamPlayerLog() {
    const logContainer = document.getElementById('stream-player-log');
    if (logContainer) {
        logContainer.innerHTML = `<div class="text-gray-500 text-center py-8">Click "Subscribe" to start receiving live data</div>`;
    }
    detailState.messageCount = 0;
    detailState.bytesReceived = 0;
    detailState.bytesTimestamps = [];
    
    const msgCountEl = document.getElementById('stream-player-msg-count');
    if (msgCountEl) msgCountEl.textContent = '0';
    
    const kbpsEl = document.getElementById('stream-player-kbps');
    if (kbpsEl) kbpsEl.textContent = '0';
}
