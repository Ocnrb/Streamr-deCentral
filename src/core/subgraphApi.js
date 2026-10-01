// The Streamr subgraph (The Graph): operators, their details, delegators and staking events
import { OPERATOR_CONTRACT_ABI, DELEGATORS_PER_PAGE, OPERATORS_PER_PAGE, MIN_SEARCH_LENGTH, FULL_ADDRESS_LENGTH, getGraphUrl } from './constants.js';
import { parseOperatorMetadata, logger } from './utils.js';
import { getReadOnlyProvider, readWithFallback } from './rpc.js';

// --- API (The Graph) ---
export async function runQuery(query) {
    const response = await fetch(getGraphUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
    });
    if (!response.ok) throw new Error(`Network error: ${response.statusText}`);
    const result = await response.json();
    if (result.errors) throw new Error(`GraphQL error: ${result.errors.map(e => e.message).join(', ')}`);
    return result.data;
}

const isAddressFilter = (query) => {
    const normalizedQuery = query.toLowerCase();
    return normalizedQuery.startsWith('0x') && /^[0-9a-f]+$/.test(normalizedQuery.substring(2));
};

export async function fetchOperators(skip = 0, filterQuery = '') {
    if (filterQuery && filterQuery.length > 0 && filterQuery.length < MIN_SEARCH_LENGTH) {
        return [];
    }

    if (filterQuery) {
        const lowerCaseFilter = filterQuery.toLowerCase();
        if (isAddressFilter(lowerCaseFilter)) {
            
            if (lowerCaseFilter.length === FULL_ADDRESS_LENGTH) {
                const whereClause = `where: {id: "${lowerCaseFilter}"}`;
                
                const query = `
                query GetOperatorsList {
                    operators(first: ${OPERATORS_PER_PAGE}, skip: ${skip}, orderBy: valueWithoutEarnings, orderDirection: desc, ${whereClause}) {
                        id valueWithoutEarnings delegatorCount metadataJsonString stakes(first: 50) { amountWei sponsorship { spotAPY } }
                    }
                }`;
                const data = await runQuery(query);
                return data.operators;

            } else {
                return [];
            }

        } else {
            const topResultsQuery = `
                query GetTopOperatorsForClientSearch {
                    operators(first: 1000, orderBy: valueWithoutEarnings, orderDirection: desc) {
                        id valueWithoutEarnings delegatorCount metadataJsonString stakes(first: 50) { amountWei sponsorship { spotAPY } }
                    }
                }`;
            const data = await runQuery(topResultsQuery);
            return data.operators.filter(op => {
                const { name } = parseOperatorMetadata(op.metadataJsonString);
                return name ? name.toLowerCase().includes(lowerCaseFilter) : false;
            });
        }
    } else {
        const query = `
            query GetOperatorsList {
                operators(first: ${OPERATORS_PER_PAGE}, skip: ${skip}, orderBy: valueWithoutEarnings, orderDirection: desc) {
                    id valueWithoutEarnings delegatorCount metadataJsonString stakes(first: 50) { amountWei sponsorship { spotAPY } }
                }
            }`;
        const data = await runQuery(query);
        return data.operators;
    }
}

/**
 * Validates if a string is a valid Ethereum address.
 * @param {string} address - The address to validate.
 * @returns {boolean} True if valid, false otherwise.
 */
function isValidEthereumAddress(address) {
    return typeof address === 'string' && /^0x[a-fA-F0-9]{40}$/.test(address);
}

export async function fetchOperatorDetails(operatorId) {
    if (!isValidEthereumAddress(operatorId)) {
        throw new Error('Invalid operator ID format. Must be a valid Ethereum address.');
    }
    const sanitizedId = operatorId.toLowerCase();
    const query = `
        query GetOperatorDetails {
          operator(id: "${sanitizedId}") {
            id owner valueWithoutEarnings operatorTokenTotalSupplyWei delegatorCount cumulativeEarningsWei cumulativeProfitsWei cumulativeOperatorsCutWei operatorsCutFraction nodes controllers metadataJsonString
            stakes(first: 100) { amountWei sponsorship { id remainingWei spotAPY isRunning totalPayoutWeiPerSec totalStakedWei stream { id } } }
            delegations(where: {isSelfDelegation: false}, first: 15, orderBy: _valueDataWei, orderDirection: desc) { id _valueDataWei operatorTokenBalanceWei delegator { id } }
            queueEntries(orderBy: date, orderDirection: asc) { id amount delegator { id } date }
          }
          selfDelegation: delegations(where: {operator: "${sanitizedId}", isSelfDelegation: true}, first: 1) { _valueDataWei }
          stakingEvents(orderBy: date, orderDirection: desc, first: 1000, where: {operator: "${sanitizedId}"}) {
            id
            amount
            date
            sponsorship { id stream { id } }
          }
          operatorDailyBuckets(first: 1000, orderBy: date, orderDirection: asc, where: {operator: "${sanitizedId}"}) {
            date
            valueWithoutEarnings
            totalDelegatedWei
            totalUndelegatedWei
            profitsWei
            cumulativeEarningsWei
          }
          flagsAgainst: flags(where: {target: "${sanitizedId}"}, orderBy: flaggingTimestamp, orderDirection: desc) {
                id
                flagger { id, metadataJsonString }
                sponsorship { id stream { id } }
                flaggingTimestamp
                result
                votes(orderBy: timestamp, orderDirection: desc) {
                    id
                    voter { id, metadataJsonString }
                    voterWeight
                    votedKick
                    timestamp
                }
          }
          flagsAsFlagger: flags(where: {flagger: "${sanitizedId}"}, orderBy: flaggingTimestamp, orderDirection: desc, first: 100) {
            id
            target { id, metadataJsonString }
            sponsorship { id stream { id } }
            flaggingTimestamp
            result
             votes(orderBy: timestamp, orderDirection: desc) {
                id
                voter { id, metadataJsonString }
                voterWeight
                votedKick
                timestamp
            }
          }
          slashingEvents(where: {operator: "${sanitizedId}"}, orderBy: date, orderDirection: desc, first: 100) { id amount date sponsorship { id stream { id } } }
        }`;
    return await runQuery(query);
}

/**
 * Fetch uncollected earnings for all sponsorships of an operator
 * Calls the operator contract's getSponsorshipsAndEarnings() function
 * and calculates changePerSecond for real-time ticker updates
 * @param {string} operatorId - The operator contract address
 * @param {Array} stakes - Stakes array from operator data (with sponsorship info)
 * @returns {Promise<Map<string, {earningsWei: bigint, changePerSecond: bigint}>>} Map of sponsorship ID to earnings data
 */
export async function fetchSponsorshipEarnings(operatorId, stakes = []) {
    const earningsMap = new Map();
    
    try {
        const provider = getReadOnlyProvider();
        const operatorContract = new ethers.Contract(operatorId, OPERATOR_CONTRACT_ABI, provider);
        
        // Call getSponsorshipsAndEarnings() on the operator contract with fallback
        const result = await readWithFallback(() => operatorContract.getSponsorshipsAndEarnings());
        const addresses = result.addresses || result[0];
        const earnings = result.earnings || result[1];
        
        // Build a lookup map for stake info (for calculating changePerSecond)
        const stakeInfoMap = new Map();
        for (const stake of stakes) {
            if (stake.sponsorship) {
                stakeInfoMap.set(stake.sponsorship.id.toLowerCase(), {
                    myStakeWei: BigInt(stake.amountWei || '0'),
                    totalPayoutWeiPerSec: BigInt(stake.sponsorship.totalPayoutWeiPerSec || '0'),
                    totalStakedWei: BigInt(stake.sponsorship.totalStakedWei || '0'),
                    isRunning: stake.sponsorship.isRunning,
                    remainingWei: BigInt(stake.sponsorship.remainingWei || '0')
                });
            }
        }
        
        // Process each sponsorship's earnings
        for (let i = 0; i < addresses.length; i++) {
            const sponsorshipId = addresses[i].toLowerCase();
            const earningsWei = BigInt(earnings[i].toString());
            
            // Calculate changePerSecond based on stake proportion
            let changePerSecond = BigInt(0);
            const stakeInfo = stakeInfoMap.get(sponsorshipId);
            
            if (stakeInfo && stakeInfo.isRunning && stakeInfo.remainingWei > BigInt(0) && stakeInfo.totalStakedWei > BigInt(0)) {
                // changePerSecond = (myStake / totalStaked) * totalPayoutPerSecond
                // Use BigInt math with precision: (myStake * payoutPerSec) / totalStaked
                changePerSecond = (stakeInfo.myStakeWei * stakeInfo.totalPayoutWeiPerSec) / stakeInfo.totalStakedWei;
            }
            
            earningsMap.set(sponsorshipId, {
                earningsWei,
                changePerSecond,
                lastUpdated: Date.now()
            });
        }
        
        logger.log(`[Earnings] Fetched earnings for ${earningsMap.size} sponsorships`);
        
    } catch (error) {
        logger.error('[Earnings] Failed to fetch sponsorship earnings:', error);
    }
    
    return earningsMap;
}

export async function fetchMoreDelegators(operatorId, skip) {
    if (!isValidEthereumAddress(operatorId)) {
        throw new Error('Invalid operator ID format.');
    }
    const sanitizedId = operatorId.toLowerCase();
    const query = `
        query GetMoreDelegators {
            operator(id: "${sanitizedId}") {
                delegations(where: {isSelfDelegation: false}, first: ${DELEGATORS_PER_PAGE}, skip: ${skip}, orderBy: _valueDataWei, orderDirection: desc) {
                    id _valueDataWei operatorTokenBalanceWei delegator { id }
                }
            }
        }`;
    const data = await runQuery(query);
    return data.operator.delegations;
}

export async function fetchAllStakingEvents(operatorId, initialSkip = 0, existingEvents = []) {
    const PAGE_SIZE = 1000;
    const MAX_EVENTS = 10000;
    let allEvents = [...existingEvents];
    let skip = initialSkip;
    let hasMore = true;
    const sanitizedId = operatorId.toLowerCase();
    
    while (hasMore) {
        const query = `
            query GetStakingEvents {
                stakingEvents(
                    orderBy: date, 
                    orderDirection: desc, 
                    first: ${PAGE_SIZE}, 
                    skip: ${skip}, 
                    where: {operator: "${sanitizedId}"}
                ) {
                    id
                    amount
                    date
                    sponsorship { id stream { id } }
                }
            }`;
        
        const data = await runQuery(query);
        const events = data.stakingEvents || [];
        
        allEvents = [...allEvents, ...events];
        skip += PAGE_SIZE;
        
        hasMore = events.length === PAGE_SIZE && skip < MAX_EVENTS;
        
        if (hasMore) {
            await new Promise(r => setTimeout(r, 100));
        }
    }
    
    return allEvents;
}
