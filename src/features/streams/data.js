// Subgraph queries of the Streams pages: sponsorships, streams, a stream's details and access
import * as Utils from '../../core/utils.js';
import * as Services from '../../core/services.js';
import { logger } from '../../core/utils.js';
import { getOperatorProfile } from '../../core/profile.js';
import { STREAMS_PER_PAGE } from './state.js';

// ============================================
// Data Fetching
// ============================================

/**
 * Fetch sponsorships 
 */
export async function fetchSponsorships(skip = 0) {
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
export async function fetchOperatorStakes() {
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
export async function fetchZeroBalanceSponsorships(skip = 0) {
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
export async function fetchAllStreams(skip = 0) {
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
export async function searchSponsorships(searchTerm, includeInactive = false) {
    // Escape special characters for GraphQL
    const sanitizedTerm = Utils.gqlEscape(searchTerm);
    
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
export async function searchAllStreams(searchTerm) {
    // Escape special characters for GraphQL
    const sanitizedTerm = Utils.gqlEscape(searchTerm);
    
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

/**
 * Fetch complete stream details including permissions
 */
// Sponsorship fields used by Stream / Sponsorship Details
const SPONSORSHIP_DETAIL_FIELDS = `
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
`;

export async function fetchStreamDetails(streamId) {
    // Escape quotes in stream ID for safe interpolation
    const sanitizedId = Utils.gqlEscape(streamId);
    
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
                    ${SPONSORSHIP_DETAIL_FIELDS}
                }
            }
        }
    `;
    
    const data = await Services.runQuery(query);
    return data.stream;
}

/**
 * Makes sure the requested sponsorship is in stream.sponsorships: the list only has the top 10 by APY,
 * so a new sponsorship (0% APY) would otherwise be replaced by another one on its details page
 */
export async function ensureSponsorshipLoaded(stream, sponsorshipId) {
    if (!stream || !sponsorshipId) return;
    stream.sponsorships = stream.sponsorships || [];
    if (stream.sponsorships.some(s => s.id === sponsorshipId)) return;
    const safeId = sponsorshipId.replace(/[^0-9a-fA-Fx]/g, '');
    const data = await Services.runQuery(`{ sponsorship(id: "${safeId}") { stream { id } ${SPONSORSHIP_DETAIL_FIELDS} } }`);
    const sponsorship = data?.sponsorship;
    if (sponsorship && sponsorship.stream?.id === stream.id) stream.sponsorships.unshift(sponsorship);
}

/**
 * Fetch sponsorship daily buckets for charts
 */
export async function fetchSponsorshipDailyData(sponsorshipId) {
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
export function determineAccessControl(permissions) {
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
export function getAccessControlBadge(accessType) {
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
