/**
 * Autostaker Module
 * Based on the official Streamr Autostaker Plugin algorithm
 * Allows operators to automatically manage stakes across sponsorships
 */

import { showToast, updateToast } from '../ui/ui.js';
import { runQuery } from '../core/services.js';
import { convertWeiToData, formatBigNumber } from '../core/utils.js';
import { OPERATOR_CONTRACT_ABI, SPONSORSHIP_ABI } from '../core/constants.js';

// ethers is loaded globally from libs/ethers.umd.min.js

// Configuration Constants
const MIN_SPONSORSHIP_TOTAL_PAYOUT_PER_SECOND = BigInt('1000000000000'); // 1e12 wei
const MIN_SPONSORSHIP_BALANCE_DATA = 15; // Minimum balance in DATA tokens
const MIN_SPONSORSHIP_BALANCE_WEI = BigInt(MIN_SPONSORSHIP_BALANCE_DATA) * BigInt('1000000000000000000'); // Convert to wei
const DEFAULT_MAX_SPONSORSHIP_COUNT = 20;
const DEFAULT_MIN_TRANSACTION_AMOUNT = 100; // DATA tokens
const DEFAULT_MAX_ACCEPTABLE_MIN_OPERATOR_COUNT = 4;
const DEFAULT_AUTO_COLLECT_INTERVAL_HOURS = 24; // Auto collect every 24 hours by default

// Gas settings for Polygon
const POLYGON_GAS_SETTINGS = {
    maxPriorityFeePerGas: ethers.utils.parseUnits('50', 'gwei'), // 50 gwei tip
    maxFeePerGas: ethers.utils.parseUnits('300', 'gwei') // 300 gwei max
};

// Storage keys
const AUTOSTAKER_CONFIG_KEY = 'autostaker_config';
const EXCLUDED_SPONSORSHIPS_KEY = 'autostaker_excluded_sponsorships';

/**
 * Get default autostaker configuration
 */
function getDefaultConfig() {
    return {
        maxSponsorshipCount: DEFAULT_MAX_SPONSORSHIP_COUNT,
        minTransactionAmount: DEFAULT_MIN_TRANSACTION_AMOUNT,
        maxAcceptableMinOperatorCount: DEFAULT_MAX_ACCEPTABLE_MIN_OPERATOR_COUNT,
        enabled: false,
        autoCollectEnabled: true,
        autoCollectIntervalHours: DEFAULT_AUTO_COLLECT_INTERVAL_HOURS,
        lastCollectTime: null, // ISO string of last collect time
        ignoreFirstCollect: true
    };
}

/**
 * Load autostaker configuration from localStorage
 * @param {string} operatorId - The operator contract address
 * @returns {Object} Configuration object
 */
export function loadAutostakerConfig(operatorId) {
    try {
        const stored = localStorage.getItem(`${AUTOSTAKER_CONFIG_KEY}_${operatorId.toLowerCase()}`);
        if (stored) {
            return { ...getDefaultConfig(), ...JSON.parse(stored) };
        }
    } catch (e) {
        console.error('Failed to load autostaker config:', e);
    }
    return getDefaultConfig();
}

/**
 * Save autostaker configuration to localStorage
 * @param {string} operatorId - The operator contract address
 * @param {Object} config - Configuration to save
 */
export function saveAutostakerConfig(operatorId, config) {
    try {
        localStorage.setItem(
            `${AUTOSTAKER_CONFIG_KEY}_${operatorId.toLowerCase()}`,
            JSON.stringify(config)
        );
    } catch (e) {
        console.error('Failed to save autostaker config:', e);
    }
}

/**
 * Load excluded sponsorships from localStorage
 * @param {string} operatorId - The operator contract address
 * @returns {Set<string>} Set of excluded sponsorship IDs
 */
export function loadExcludedSponsorships(operatorId) {
    try {
        const stored = localStorage.getItem(`${EXCLUDED_SPONSORSHIPS_KEY}_${operatorId.toLowerCase()}`);
        if (stored) {
            return new Set(JSON.parse(stored));
        }
    } catch (e) {
        console.error('Failed to load excluded sponsorships:', e);
    }
    return new Set();
}

/**
 * Save excluded sponsorships to localStorage
 * @param {string} operatorId - The operator contract address
 * @param {Set<string>} excluded - Set of excluded sponsorship IDs
 */
export function saveExcludedSponsorships(operatorId, excluded) {
    try {
        localStorage.setItem(
            `${EXCLUDED_SPONSORSHIPS_KEY}_${operatorId.toLowerCase()}`,
            JSON.stringify([...excluded])
        );
    } catch (e) {
        console.error('Failed to save excluded sponsorships:', e);
    }
}

/**
 * Fetch minimum stake per sponsorship from The Graph
 * @returns {Promise<bigint>} Minimum stake in wei
 */
async function fetchMinStakePerSponsorship() {
    const query = `
        {
            network(id: "network-entity-id") {
                minimumStakeWei
            }
        }
    `;
    const data = await runQuery(query);
    return BigInt(data.network?.minimumStakeWei || '0');
}

/**
 * Fetch stakeable sponsorships from The Graph
 * @param {Map<string, bigint>} currentStakes - Current stakes by sponsorship ID
 * @param {number} maxAcceptableMinOperatorCount - Max acceptable min operator count
 * @param {Set<string>} excludedSponsorships - Set of excluded sponsorship IDs
 * @returns {Promise<Map<string, Object>>} Map of sponsorship ID to config
 */
async function fetchStakeableSponsorships(currentStakes, maxAcceptableMinOperatorCount, excludedSponsorships) {
    const now = Math.floor(Date.now() / 1000);
    const query = `
        {
            sponsorships(
                where: {
                    isRunning: true
                    projectedInsolvency_gt: ${now}
                    minimumStakingPeriodSeconds: "0"
                    minOperators_lte: ${maxAcceptableMinOperatorCount}
                    totalPayoutWeiPerSec_gte: "${MIN_SPONSORSHIP_TOTAL_PAYOUT_PER_SECOND.toString()}"
                    remainingWei_gte: "${MIN_SPONSORSHIP_BALANCE_WEI.toString()}"
                }
                first: 1000
                orderBy: totalPayoutWeiPerSec
                orderDirection: desc
            ) {
                id
                totalPayoutWeiPerSec
                operatorCount
                maxOperators
                remainingWei
                stream { id }
            }
        }
    `;
    
    const data = await runQuery(query);
    const sponsorships = data.sponsorships || [];
    
    const hasAcceptableOperatorCount = (item) => {
        if (currentStakes.has(item.id)) {
            // Already staked - keep in list
            return true;
        }
        return (item.maxOperators === null) || (item.operatorCount < Number(item.maxOperators));
    };
    
    const result = new Map();
    for (const sp of sponsorships) {
        // Skip excluded sponsorships (unless already staked)
        if (excludedSponsorships.has(sp.id.toLowerCase()) && !currentStakes.has(sp.id)) {
            continue;
        }
        
        if (hasAcceptableOperatorCount(sp)) {
            result.set(sp.id, {
                payoutPerSec: BigInt(sp.totalPayoutWeiPerSec),
                streamId: sp.stream?.id || sp.id,
                operatorCount: sp.operatorCount,
                maxOperators: sp.maxOperators
            });
        }
    }
    
    return result;
}

/**
 * Fetch operator's free balance from The Graph
 * @param {string} operatorId - The operator contract address
 * @returns {Promise<Object>} Object with totalValue, stakedAmount, freeBalance
 */
async function fetchOperatorFreeBalance(operatorId) {
    const query = `
        {
            operator(id: "${operatorId.toLowerCase()}") {
                id
                valueWithoutEarnings
                stakes {
                    amountWei
                }
            }
        }
    `;
    
    try {
        const data = await runQuery(query);
        const operator = data.operator;
        
        if (!operator) {
            return { totalValue: BigInt(0), stakedAmount: BigInt(0), freeBalance: BigInt(0) };
        }
        
        const totalValue = BigInt(operator.valueWithoutEarnings || '0');
        const stakedAmount = (operator.stakes || []).reduce(
            (sum, stake) => sum + BigInt(stake.amountWei || '0'),
            BigInt(0)
        );
        const freeBalance = totalValue > stakedAmount ? totalValue - stakedAmount : BigInt(0);
        
        return { totalValue, stakedAmount, freeBalance };
    } catch (e) {
        console.error('Failed to fetch operator free balance:', e);
        return { totalValue: BigInt(0), stakedAmount: BigInt(0), freeBalance: BigInt(0) };
    }
}

/**
 * Fetch current stakes for an operator
 * @param {string} operatorId - The operator contract address
 * @returns {Promise<Map<string, bigint>>} Map of sponsorship ID to stake amount
 */
async function fetchCurrentStakes(operatorId) {
    const query = `
        {
            stakes(
                where: { operator: "${operatorId.toLowerCase()}" }
                first: 1000
            ) {
                id
                sponsorship { id }
                amountWei
            }
        }
    `;
    
    const data = await runQuery(query);
    const stakes = data.stakes || [];
    
    return new Map(stakes.map(stake => [stake.sponsorship.id, BigInt(stake.amountWei)]));
}

/**
 * Fetch undelegation queue amount for an operator
 * @param {string} operatorId - The operator contract address
 * @returns {Promise<bigint>} Total amount in undelegation queue
 */
async function fetchUndelegationQueueAmount(operatorId) {
    const query = `
        {
            queueEntries(
                where: { operator: "${operatorId.toLowerCase()}" }
                first: 1000
            ) {
                id
                amount
            }
        }
    `;
    
    const data = await runQuery(query);
    const entries = data.queueEntries || [];
    
    return entries.reduce((sum, entry) => sum + BigInt(entry.amount), BigInt(0));
}

/**
 * Fetch all available sponsorships for display (including excluded status)
 * @param {string} operatorId - The operator contract address
 * @returns {Promise<Array>} Array of sponsorship objects with stake info
 */
export async function fetchAllSponsorshipsForDisplay(operatorId) {
    const currentStakes = await fetchCurrentStakes(operatorId);
    const excludedSponsorships = loadExcludedSponsorships(operatorId);
    
    const now = Math.floor(Date.now() / 1000);
    const query = `
        {
            sponsorships(
                where: {
                    isRunning: true
                    projectedInsolvency_gt: ${now}
                    totalPayoutWeiPerSec_gte: "${MIN_SPONSORSHIP_TOTAL_PAYOUT_PER_SECOND.toString()}"
                    remainingWei_gte: "${MIN_SPONSORSHIP_BALANCE_WEI.toString()}"
                }
                first: 500
                orderBy: totalPayoutWeiPerSec
                orderDirection: desc
            ) {
                id
                totalPayoutWeiPerSec
                operatorCount
                maxOperators
                spotAPY
                remainingWei
                stream { id }
            }
        }
    `;
    
    const data = await runQuery(query);
    const sponsorships = data.sponsorships || [];
    
    return sponsorships.map(sp => ({
        id: sp.id,
        streamId: sp.stream?.id || sp.id,
        payoutPerSec: sp.totalPayoutWeiPerSec,
        operatorCount: sp.operatorCount,
        maxOperators: sp.maxOperators,
        spotAPY: sp.spotAPY,
        remainingWei: sp.remainingWei,
        currentStake: currentStakes.get(sp.id) || BigInt(0),
        isStaked: currentStakes.has(sp.id),
        isExcluded: excludedSponsorships.has(sp.id.toLowerCase())
    }));
}

/**
 * Sum of bigints
 * @param {bigint[]} values - Array of bigints
 * @returns {bigint} Sum
 */
function sumBigInts(values) {
    return values.reduce((sum, val) => sum + val, BigInt(0));
}

/**
 * BigInt max helper
 */
function bigIntMax(...args) {
    return args.reduce((m, e) => e > m ? e : m);
}

/**
 * BigInt min helper
 */
function bigIntMin(...args) {
    return args.reduce((m, e) => e < m ? e : m);
}

/**
 * BigInt abs helper
 */
function bigIntAbs(n) {
    return n < BigInt(0) ? -n : n;
}

/**
 * Simple hash function for deterministic tie-breaking (like MD5 in official)
 * Uses FNV-1a algorithm for simplicity in browser
 */
function hashString(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 16777619) >>> 0;
    }
    return hash;
}

/**
 * Get expired sponsorships (currently staked but no longer in stakeable list)
 */
function getExpiredSponsorships(myCurrentStakes, stakeableSponsorships) {
    return [...myCurrentStakes.keys()].filter(id => !stakeableSponsorships.has(id));
}

/**
 * Select sponsorships to stake - OFFICIAL ALGORITHM
 * Keeps currently staked ones and adds new ones based on payout
 */
function getSelectedSponsorships(
    myCurrentStakes,
    stakeableSponsorships,
    totalStakeableAmount,
    operatorContractAddress,
    maxSponsorshipCount,
    minStakePerSponsorship
) {
    // Calculate how many we can afford
    const count = Math.min(
        stakeableSponsorships.size,
        maxSponsorshipCount,
        minStakePerSponsorship > BigInt(0) 
            ? Number(totalStakeableAmount / minStakePerSponsorship) 
            : Infinity
    );
    
    if (count <= 0) return [];
    
    // Partition into kept (already staked) and potential (not staked yet)
    const keptSponsorships = [...stakeableSponsorships.keys()].filter(id => myCurrentStakes.has(id));
    const potentialSponsorships = [...stakeableSponsorships.keys()].filter(id => !myCurrentStakes.has(id));
    
    // Sort potential sponsorships by:
    // 1. payoutPerSec (descending)
    // 2. Hash of operator+sponsorship (for deterministic tie-breaking)
    const sortedPotential = potentialSponsorships.sort((a, b) => {
        const payoutA = stakeableSponsorships.get(a).payoutPerSec;
        const payoutB = stakeableSponsorships.get(b).payoutPerSec;
        
        if (payoutB > payoutA) return 1;
        if (payoutA > payoutB) return -1;
        
        // Tie-breaker: hash of operatorAddress + sponsorshipId
        const hashA = hashString(operatorContractAddress + a);
        const hashB = hashString(operatorContractAddress + b);
        return hashA - hashB;
    });
    
    // Keep all currently staked, then add from sorted potential
    return [
        ...keptSponsorships,
        ...sortedPotential
    ].slice(0, count);
}

/**
 * Calculate target stakes for each sponsorship - OFFICIAL ALGORITHM
 * Formula: target = minStake + (payoutProportionalAmount * payoutPerSec / totalPayoutPerSec)
 */
function getTargetStakes(
    myCurrentStakes,
    myUnstakedAmount,
    stakeableSponsorships,
    undelegationQueueAmount,
    operatorContractAddress,
    maxSponsorshipCount,
    minStakePerSponsorship
) {
    const totalStakeableAmount = sumBigInts([...myCurrentStakes.values()]) + myUnstakedAmount - undelegationQueueAmount;
    
    const selectedSponsorships = getSelectedSponsorships(
        myCurrentStakes,
        stakeableSponsorships,
        totalStakeableAmount,
        operatorContractAddress,
        maxSponsorshipCount,
        minStakePerSponsorship
    );
    
    if (selectedSponsorships.length === 0) {
        // Return targets for expired sponsorships (unstake all)
        const expiredTargets = new Map();
        for (const id of getExpiredSponsorships(myCurrentStakes, stakeableSponsorships)) {
            expiredTargets.set(id, BigInt(0));
        }
        return expiredTargets;
    }
    
    // Calculate payout-proportional allocation
    const minStakePerSponsorshipSum = BigInt(selectedSponsorships.length) * minStakePerSponsorship;
    const payoutProportionalAmount = totalStakeableAmount > minStakePerSponsorshipSum 
        ? totalStakeableAmount - minStakePerSponsorshipSum 
        : BigInt(0);
    
    const payoutPerSecSum = sumBigInts(selectedSponsorships.map(id => stakeableSponsorships.get(id).payoutPerSec));
    
    const targetStakes = new Map();
    
    // Target for selected sponsorships
    for (const id of selectedSponsorships) {
        const proportionalPart = payoutPerSecSum > BigInt(0)
            ? (payoutProportionalAmount * stakeableSponsorships.get(id).payoutPerSec) / payoutPerSecSum
            : BigInt(0);
        targetStakes.set(id, minStakePerSponsorship + proportionalPart);
    }
    
    // Target 0 for sponsorships we're currently staked in but not selected
    for (const id of myCurrentStakes.keys()) {
        if (!selectedSponsorships.includes(id)) {
            targetStakes.set(id, BigInt(0));
        }
    }
    
    // Target 0 for expired sponsorships
    for (const id of getExpiredSponsorships(myCurrentStakes, stakeableSponsorships)) {
        targetStakes.set(id, BigInt(0));
    }
    
    return targetStakes;
}

/**
 * Payout Proportional Strategy - Calculate stake adjustments
 * Based EXACTLY on the official AutostakerPlugin algorithm
 * @param {Object} params - Strategy parameters
 * @returns {Array} Array of actions to execute
 */
function adjustStakes({
    myCurrentStakes,
    myUnstakedAmount,
    stakeableSponsorships,
    undelegationQueueAmount,
    operatorContractAddress,
    maxSponsorshipCount,
    minTransactionAmount,
    minStakePerSponsorship
}) {
    const targetStakes = getTargetStakes(
        myCurrentStakes,
        myUnstakedAmount,
        stakeableSponsorships,
        undelegationQueueAmount,
        operatorContractAddress,
        maxSponsorshipCount,
        minStakePerSponsorship
    );
    
    // Calculate adjustments (difference between target and current)
    let adjustments = [...targetStakes.keys()]
        .map(sponsorshipId => {
            const target = targetStakes.get(sponsorshipId) || BigInt(0);
            const current = myCurrentStakes.get(sponsorshipId) || BigInt(0);
            const difference = target - current;
            
            console.log(`[Autostaker] Sponsorship ${sponsorshipId.substring(0, 10)}... : current=${current}, target=${target}, diff=${difference}`);
            
            return {
                sponsorshipId,
                difference,
                currentStake: current,
                targetStake: target
            };
        })
        .filter(({ difference }) => difference !== BigInt(0));
    
    // Filter out too-small adjustments (except for expired sponsorships which must be unstaked)
    const tooSmallAdjustments = adjustments.filter(
        a => bigIntAbs(a.difference) < minTransactionAmount && stakeableSponsorships.has(a.sponsorshipId)
    );
    adjustments = adjustments.filter(a => !tooSmallAdjustments.includes(a));
    
    // Balance out any excess staking from filtering small adjustments
    while (true) {
        const stakings = adjustments.filter(a => a.difference > BigInt(0));
        const unstakings = adjustments.filter(a => a.difference < BigInt(0));
        const stakingSum = sumBigInts(stakings.map(a => a.difference));
        const availableSum = bigIntAbs(sumBigInts(unstakings.map(a => a.difference))) + myUnstakedAmount - undelegationQueueAmount;
        let excess = stakingSum - availableSum;
        
        if (excess > BigInt(0) && stakings.length > 0) {
            // Calculate allowances for reducing stakings
            const stakingReductionAllowances = new Map(
                stakings.map(a => {
                    const minDiff = bigIntMax(
                        minTransactionAmount,
                        myCurrentStakes.has(a.sponsorshipId) ? BigInt(0) : minStakePerSponsorship
                    );
                    const allowance = bigIntMax(a.difference - minDiff, BigInt(0));
                    return [a.sponsorshipId, allowance];
                })
            );
            const totalAllowance = sumBigInts([...stakingReductionAllowances.values()]);
            
            if (excess > totalAllowance) {
                // Remove smallest staking
                const smallestStaking = stakings.reduce((min, a) => 
                    a.difference < min.difference ? a : min, stakings[0]);
                adjustments = adjustments.filter(a => a !== smallestStaking);
            } else {
                // Reduce stakings proportionally
                for (const staking of stakings) {
                    const allowance = stakingReductionAllowances.get(staking.sponsorshipId);
                    if (allowance > BigInt(0)) {
                        const reduction = bigIntMin(allowance, excess);
                        excess -= reduction;
                        staking.difference -= reduction;
                        if (excess <= BigInt(0)) break;
                    }
                }
                break;
            }
        } else {
            break;
        }
    }
    
    // Convert to actions and sort (unstakes first)
    const actions = adjustments
        .map(({ sponsorshipId, difference, currentStake, targetStake }) => {
            // For unstake, ensure targetStake is not greater than currentStake
            // This prevents arithmetic underflow in the contract
            const safeTargetStake = difference < BigInt(0) 
                ? (targetStake > currentStake ? BigInt(0) : targetStake)  // If target > current, set to 0 (full unstake)
                : targetStake;
            
            const isUnstake = difference < BigInt(0);
            
            // For unstake, recalculate amount based on safe target
            const safeAmount = isUnstake 
                ? (currentStake - safeTargetStake)  // How much we're actually removing
                : bigIntAbs(difference);
            
            console.log(`[Autostaker] Action: ${isUnstake ? 'unstake' : 'stake'} ${sponsorshipId.substring(0, 10)}... amount=${safeAmount}, targetStake=${safeTargetStake}`);
            
            return {
                type: isUnstake ? 'unstake' : 'stake',
                sponsorshipId,
                amount: safeAmount,
                targetStake: safeTargetStake,
                currentStake
            };
        })
        .filter(action => {
            // Skip actions with 0 amount
            if (action.amount === BigInt(0)) {
                console.warn(`[Autostaker] Skipping zero-amount action for ${action.sponsorshipId}`);
                return false;
            }
            // Additional safety: skip unstake actions where target >= current (nothing to unstake)
            if (action.type === 'unstake' && action.targetStake >= action.currentStake) {
                console.warn(`[Autostaker] Skipping invalid unstake: target (${action.targetStake}) >= current (${action.currentStake}) for ${action.sponsorshipId}`);
                return false;
            }
            return true;
        })
        .sort((a, b) => {
            const typeOrder = ['unstake', 'stake'];
            return typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type);
        });
    
    return actions;
}

/**
 * Analyze current state and calculate recommended actions
 * @param {string} operatorId - The operator contract address
 * @param {Object} config - Autostaker configuration
 * @param {ethers.Contract} operatorContract - Operator contract instance
 * @returns {Promise<Object>} Analysis result with actions
 */
export async function analyzeAndCalculateActions(operatorId, config, operatorContract) {
    const excludedSponsorships = loadExcludedSponsorships(operatorId);
    
    // Fetch all required data
    const [minStakePerSponsorship, myCurrentStakes, undelegationQueueAmount, operatorData] = await Promise.all([
        fetchMinStakePerSponsorship(),
        fetchCurrentStakes(operatorId),
        fetchUndelegationQueueAmount(operatorId),
        fetchOperatorFreeBalance(operatorId)
    ]);
    
    // Get stakeable sponsorships (excluding user's exclusion list)
    const stakeableSponsorships = await fetchStakeableSponsorships(
        myCurrentStakes,
        config.maxAcceptableMinOperatorCount,
        excludedSponsorships
    );
    
    // Get operator's free funds from The Graph data
    let myUnstakedAmount = operatorData.freeBalance;
    
    // Fallback to contract if Graph data not available
    if (myUnstakedAmount === BigInt(0)) {
        try {
            const valueWithoutEarnings = await operatorContract.totalValueInQueuesAndSponsorships();
            const myStakedAmount = sumBigInts([...myCurrentStakes.values()]);
            myUnstakedAmount = valueWithoutEarnings > myStakedAmount ? valueWithoutEarnings - myStakedAmount : BigInt(0);
        } catch (e) {
            console.warn('Failed to get operator free funds from contract, using Graph data:', e.message);
        }
    }
    
    // Log key values for debugging
    const totalCurrentStakes = sumBigInts([...myCurrentStakes.values()]);
    console.log('[Autostaker] Analysis:', {
        currentStakesTotal: convertWeiToData(totalCurrentStakes.toString()) + ' DATA',
        freeBalance: convertWeiToData(myUnstakedAmount.toString()) + ' DATA',
        undelegationQueue: convertWeiToData(undelegationQueueAmount.toString()) + ' DATA',
        minStakePerSponsorship: convertWeiToData(minStakePerSponsorship.toString()) + ' DATA',
        stakeableSponsorshipsCount: stakeableSponsorships.size
    });
    
    // Convert minTransactionAmount to wei
    const minTransactionAmountWei = BigInt(config.minTransactionAmount) * BigInt('1000000000000000000');
    
    // Check if there's a pending undelegation queue that needs to be paid
    // If freeBalance is insufficient, we need to unstake to cover the queue
    const hasUnpaidQueue = undelegationQueueAmount > BigInt(0) && myUnstakedAmount < undelegationQueueAmount;
    const amountNeededForQueue = hasUnpaidQueue ? (undelegationQueueAmount - myUnstakedAmount) : BigInt(0);
    
    if (hasUnpaidQueue) {
        console.log('[Autostaker] Detected unpaid undelegation queue with insufficient free balance');
        console.log(`[Autostaker] Queue: ${convertWeiToData(undelegationQueueAmount.toString())} DATA, Free: ${convertWeiToData(myUnstakedAmount.toString())} DATA`);
        console.log(`[Autostaker] Need to unstake: ${convertWeiToData(amountNeededForQueue.toString())} DATA to pay queue`);
        
        // Generate an action to unstake enough to pay the queue
        // Find the best sponsorship to unstake from (one with highest stake above minimum)
        const queuePaymentAction = generateQueuePaymentAction(
            myCurrentStakes,
            stakeableSponsorships,
            amountNeededForQueue,
            minStakePerSponsorship
        );
        
        if (queuePaymentAction) {
            console.log(`[Autostaker] Generated queue payment action: unstake ${convertWeiToData(queuePaymentAction.amount.toString())} DATA from ${queuePaymentAction.sponsorshipId.substring(0, 10)}...`);
            
            return {
                actions: [queuePaymentAction],
                currentStakes: myCurrentStakes,
                stakeableSponsorships,
                myUnstakedAmount,
                undelegationQueueAmount,
                minStakePerSponsorship,
                excludedCount: excludedSponsorships.size,
                isQueuePayment: true,
                queuePaymentAmount: amountNeededForQueue
            };
        } else {
            console.warn('[Autostaker] Cannot generate queue payment action - no sponsorship with enough stake above minimum');
            return {
                actions: [],
                currentStakes: myCurrentStakes,
                stakeableSponsorships,
                myUnstakedAmount,
                undelegationQueueAmount,
                minStakePerSponsorship,
                excludedCount: excludedSponsorships.size,
                skippedReason: 'Cannot pay undelegation queue - no sponsorship has enough stake above minimum to unstake'
            };
        }
    }
    
    // Calculate actions
    const actions = adjustStakes({
        myCurrentStakes,
        myUnstakedAmount,
        stakeableSponsorships,
        undelegationQueueAmount,
        operatorContractAddress: operatorId,
        maxSponsorshipCount: config.maxSponsorshipCount,
        minTransactionAmount: minTransactionAmountWei,
        minStakePerSponsorship
    });
    
    return {
        actions,
        currentStakes: myCurrentStakes,
        stakeableSponsorships,
        myUnstakedAmount,
        undelegationQueueAmount,
        minStakePerSponsorship,
        excludedCount: excludedSponsorships.size
    };
}

/**
 * Generate an action to unstake enough to pay the undelegation queue
 * @param {Map<string, bigint>} currentStakes - Current stakes by sponsorship ID
 * @param {Map<string, Object>} stakeableSponsorships - Stakeable sponsorships info
 * @param {bigint} amountNeeded - Amount needed to pay the queue
 * @param {bigint} minStakePerSponsorship - Minimum stake per sponsorship
 * @returns {Object|null} Unstake action or null if not possible
 */
function generateQueuePaymentAction(currentStakes, stakeableSponsorships, amountNeeded, minStakePerSponsorship) {
    // Find sponsorships we can unstake from (stake > minStake)
    const unstakeableSponsorships = [...currentStakes.entries()]
        .filter(([id, stake]) => stake > minStakePerSponsorship)
        .map(([id, stake]) => ({
            sponsorshipId: id,
            currentStake: stake,
            availableToUnstake: stake - minStakePerSponsorship,
            isStakeable: stakeableSponsorships.has(id)
        }))
        .sort((a, b) => {
            // Prefer sponsorships with more available stake
            if (b.availableToUnstake > a.availableToUnstake) return 1;
            if (a.availableToUnstake > b.availableToUnstake) return -1;
            return 0;
        });
    
    if (unstakeableSponsorships.length === 0) {
        return null;
    }
    
    // Try to find a single sponsorship that can cover the queue
    for (const sp of unstakeableSponsorships) {
        if (sp.availableToUnstake >= amountNeeded) {
            // This sponsorship can cover the queue payment
            // Add a small buffer (1%) to account for any timing differences
            const amountWithBuffer = amountNeeded + (amountNeeded / BigInt(100));
            const unstakeAmount = amountWithBuffer > sp.availableToUnstake 
                ? sp.availableToUnstake 
                : amountWithBuffer;
            
            const targetStake = sp.currentStake - unstakeAmount;
            
            return {
                type: 'unstake',
                sponsorshipId: sp.sponsorshipId,
                amount: unstakeAmount,
                targetStake: targetStake,
                currentStake: sp.currentStake,
                isQueuePayment: true
            };
        }
    }
    
    // No single sponsorship can cover it - use the one with most available
    const best = unstakeableSponsorships[0];
    const targetStake = minStakePerSponsorship;
    
    return {
        type: 'unstake',
        sponsorshipId: best.sponsorshipId,
        amount: best.availableToUnstake,
        targetStake: targetStake,
        currentStake: best.currentStake,
        isQueuePayment: true,
        partialPayment: true
    };
}

// Constants for retry logic
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 3000;

/**
 * Check if an error is retryable (state changed, values outdated)
 * @param {Error} error - The error to check
 * @returns {boolean} True if the error suggests a recalculation might help
 */
function isRetryableError(error) {
    const retryablePatterns = [
        'transfer amount exceeds balance',
        'insufficient balance',
        'queueIsEmpty',
        'FirstEmptyQueueThenStake',
        'execution reverted',
        'nonce too low',
        'replacement transaction underpriced',
        'already known',
        'ReduceStakeToZero',
        'CannotUnstakeBelowMinimum'
    ];
    
    const msg = error.message?.toLowerCase() || '';
    return retryablePatterns.some(pattern => msg.includes(pattern.toLowerCase()));
}

/**
 * Execute autostaker actions with retry and recalculation on failure
 * @param {Array} actions - Actions to execute
 * @param {string} operatorId - The operator contract address
 * @param {ethers.Signer} signer - Ethers signer
 * @param {Function} onProgress - Progress callback
 * @param {Object} config - Autostaker configuration (for recalculation)
 * @returns {Promise<Object>} Execution result
 */
export async function executeActions(actions, operatorId, signer, onProgress, config = null) {
    if (!actions || actions.length === 0) {
        return { success: true, message: 'No actions to execute' };
    }
    
    const operatorContract = new ethers.Contract(operatorId, OPERATOR_CONTRACT_ABI, signer);
    
    // Get current gas prices from the network
    let gasSettings = {};
    try {
        const feeData = await signer.provider.getFeeData();
        // Use higher gas prices for Polygon to avoid "gas price below minimum" errors
        const minPriorityFee = ethers.utils.parseUnits('30', 'gwei');
        const minMaxFee = ethers.utils.parseUnits('100', 'gwei');
        
        gasSettings = {
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.gt(minPriorityFee) 
                ? feeData.maxPriorityFeePerGas 
                : minPriorityFee,
            maxFeePerGas: feeData.maxFeePerGas?.gt(minMaxFee)
                ? feeData.maxFeePerGas
                : minMaxFee
        };
    } catch (e) {
        console.warn('Failed to get fee data, using defaults:', e.message);
        gasSettings = {
            maxPriorityFeePerGas: ethers.utils.parseUnits('50', 'gwei'),
            maxFeePerGas: ethers.utils.parseUnits('200', 'gwei')
        };
    }
    
    // Separate unstake and stake actions (unstake first to free up funds)
    const unstakeActions = actions.filter(a => a.type === 'unstake');
    const stakeActions = actions.filter(a => a.type === 'stake');
    const orderedActions = [...unstakeActions, ...stakeActions];
    
    const results = {
        successful: [],
        failed: []
    };
    
    // First, try to pay out any pending undelegation queue if there are funds available
    // This helps avoid issues where unstake funds go to queue instead of being available
    try {
        const queueIsEmpty = await operatorContract.queueIsEmpty();
        if (!queueIsEmpty) {
            console.log('[Autostaker] Undelegation queue not empty, checking if we can pay it out...');
            
            // Try to pay out the queue first (0 = pay all possible with available funds)
            try {
                const payoutTx = await operatorContract.payOutQueue(0, gasSettings);
                await payoutTx.wait();
                console.log('[Autostaker] Queue payout completed before starting actions');
            } catch (payoutError) {
                // This is expected if there are no free funds - continue with actions
                console.log('[Autostaker] Could not pay queue (likely no free funds):', payoutError.message?.substring(0, 100));
            }
        }
    } catch (e) {
        console.warn('[Autostaker] Failed to check/pay queue status:', e.message);
    }
    
    // Check again if we have stake actions and queue status after potential payout
    if (stakeActions.length > 0) {
        try {
            const queueIsEmpty = await operatorContract.queueIsEmpty();
            if (!queueIsEmpty) {
                // Queue still not empty - need more funds
                // Filter out stake actions, only do unstakes first
                console.warn('[Autostaker] Queue still not empty, will skip stake actions until queue is cleared');
                
                // If we have unstake actions, proceed with them (they will help pay the queue)
                if (unstakeActions.length > 0) {
                    console.log('[Autostaker] Proceeding with unstake actions to help pay queue');
                } else {
                    // No unstakes and queue not empty - can't do stakes
                    return {
                        success: false,
                        message: 'Undelegation queue not empty - need to unstake first to free funds',
                        results: {
                            successful: [],
                            failed: stakeActions.map(a => ({
                                action: a,
                                error: 'Undelegation queue not empty - unstake first to free funds for queue payout'
                            }))
                        }
                    };
                }
            }
        } catch (e) {
            console.warn('[Autostaker] Failed to check queue status:', e.message);
        }
    }
    
    // Track freed funds from unstakes to validate stakes
    let freedFunds = BigInt(0);
    let recalculationAttempts = 0;
    let currentActions = [...orderedActions];
    let actionIndex = 0;
    
    while (actionIndex < currentActions.length) {
        const action = currentActions[actionIndex];
        
        if (onProgress) {
            onProgress({
                current: actionIndex + 1,
                total: currentActions.length,
                action,
                isRetry: recalculationAttempts > 0
            });
        }
        
        try {
            let tx;
            if (action.type === 'stake') {
                // For stakes, convert BigInt to ethers.BigNumber via hex
                const amountHex = '0x' + action.amount.toString(16);
                const amountBN = ethers.BigNumber.from(amountHex);
                console.log(`[Autostaker] Staking ${amountBN.toString()} wei to ${action.sponsorshipId}`);
                tx = await operatorContract.stake(action.sponsorshipId, amountBN, gasSettings);
            } else {
                // For unstakes (reduceStakeTo)
                // Convert BigInt to ethers.BigNumber via hex (avoids precision issues)
                const targetStakeHex = '0x' + action.targetStake.toString(16);
                let targetStakeBN = ethers.BigNumber.from(targetStakeHex);
                
                // Verify targetStake is valid before calling contract
                const currentStakeOnChain = await operatorContract.stakedInto(action.sponsorshipId);
                
                // Check minimumStakeOf on the Sponsorship contract
                const sponsorshipContract = new ethers.Contract(action.sponsorshipId, SPONSORSHIP_ABI, signer.provider);
                const minimumStakeOf = await sponsorshipContract.minimumStakeOf(operatorId);
                const lockedStake = await sponsorshipContract.lockedStakeWei(operatorId);
                
                console.log(`[Autostaker] Unstake debug:`);
                console.log(`  - JS BigInt target: ${action.targetStake}`);
                console.log(`  - targetStakeBN: ${targetStakeBN.toString()}`);
                console.log(`  - onChainStake: ${currentStakeOnChain.toString()}`);
                console.log(`  - minimumStakeOf: ${minimumStakeOf.toString()}`);
                console.log(`  - lockedStake: ${lockedStake.toString()}`);
                
                // If target is below minimum, adjust to minimum
                if (targetStakeBN.lt(minimumStakeOf)) {
                    console.warn(`[Autostaker] Target ${targetStakeBN.toString()} is below minimum ${minimumStakeOf.toString()}, adjusting to minimum`);
                    targetStakeBN = minimumStakeOf;
                }
                
                // Check if there's actually anything to reduce
                if (targetStakeBN.gte(currentStakeOnChain)) {
                    console.warn(`[Autostaker] Skipping unstake: targetStake (${targetStakeBN.toString()}) >= onChainStake (${currentStakeOnChain.toString()})`);
                    results.failed.push({
                        action,
                        error: 'Cannot reduce stake - target is not less than current stake or at minimum'
                    });
                    continue;
                }
                
                console.log(`[Autostaker] Calling reduceStakeTo(${action.sponsorshipId}, ${targetStakeBN.toString()})`);
                tx = await operatorContract.reduceStakeTo(action.sponsorshipId, targetStakeBN, gasSettings);
                
                // Calculate actual freed funds
                const actualFreed = currentStakeOnChain.sub(targetStakeBN);
                freedFunds += BigInt(actualFreed.toString());
            }
            
            const receipt = await tx.wait();
            results.successful.push({
                action,
                txHash: receipt.transactionHash
            });
            
            // If this was a queue payment unstake, try to pay out the queue now
            if (action.isQueuePayment) {
                console.log('[Autostaker] Queue payment unstake successful, attempting to pay out queue...');
                try {
                    // Small delay to ensure state is updated
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                    const payoutTx = await operatorContract.payOutQueue(0, gasSettings);
                    const payoutReceipt = await payoutTx.wait();
                    console.log(`[Autostaker] Queue payout successful! Tx: ${payoutReceipt.transactionHash}`);
                    
                    results.successful.push({
                        action: { type: 'queuePayout', description: 'Pay undelegation queue' },
                        txHash: payoutReceipt.transactionHash
                    });
                } catch (payoutError) {
                    console.warn('[Autostaker] Failed to pay out queue after unstake:', payoutError.message);
                    // Not critical - queue will be paid in next cycle
                }
            }
            
            // Move to next action
            actionIndex++;
            recalculationAttempts = 0; // Reset retry counter on success
            
            // Small delay between transactions to avoid nonce issues
            await new Promise(resolve => setTimeout(resolve, 2000));
            
        } catch (e) {
            console.error(`Failed to execute ${action.type} action:`, e);
            
            // Check if this is a retryable error and we have config for recalculation
            if (config && isRetryableError(e) && recalculationAttempts < MAX_RETRY_ATTEMPTS) {
                recalculationAttempts++;
                console.log(`[Autostaker] Retryable error detected, attempting recalculation (attempt ${recalculationAttempts}/${MAX_RETRY_ATTEMPTS})...`);
                
                if (onProgress) {
                    onProgress({
                        current: actionIndex + 1,
                        total: currentActions.length,
                        action,
                        isRecalculating: true,
                        retryAttempt: recalculationAttempts
                    });
                }
                
                // Wait a bit for chain state to settle
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                
                try {
                    // Recalculate actions based on current on-chain state
                    const newAnalysis = await analyzeAndCalculateActions(operatorId, config, operatorContract);
                    
                    if (newAnalysis.actions && newAnalysis.actions.length > 0) {
                        console.log(`[Autostaker] Recalculated ${newAnalysis.actions.length} new actions`);
                        
                        // Filter out actions that were already successful
                        const successfulSponsorships = new Set(results.successful.map(r => r.action.sponsorshipId));
                        const remainingActions = newAnalysis.actions.filter(a => !successfulSponsorships.has(a.sponsorshipId));
                        
                        // Replace current actions with recalculated ones
                        const unstakes = remainingActions.filter(a => a.type === 'unstake');
                        const stakes = remainingActions.filter(a => a.type === 'stake');
                        currentActions = [...unstakes, ...stakes];
                        actionIndex = 0; // Restart from the beginning of new actions
                        
                        console.log(`[Autostaker] Continuing with ${currentActions.length} recalculated actions`);
                        continue; // Continue with the new actions
                    } else {
                        console.log('[Autostaker] Recalculation produced no actions, stopping');
                    }
                } catch (recalcError) {
                    console.error('[Autostaker] Failed to recalculate actions:', recalcError);
                }
            }
            
            // Extract more user-friendly error message
            let errorMsg = e.message;
            if (e.message.includes('transfer amount exceeds balance')) {
                errorMsg = 'Insufficient balance - operator does not have enough free DATA';
            } else if (e.message.includes('gas price below minimum')) {
                errorMsg = 'Gas price too low - network congested';
            } else if (e.message.includes('FirstEmptyQueueThenStake') || e.message.includes('queueIsEmpty')) {
                errorMsg = 'Undelegation queue not empty - cannot stake until queue is paid out';
            }
            
            results.failed.push({
                action,
                error: errorMsg,
                retriesAttempted: recalculationAttempts
            });
            
            // Move to next action even on failure
            actionIndex++;
            recalculationAttempts = 0; // Reset for next action
        }
    }
    
    return {
        success: results.failed.length === 0,
        results
    };
}

/**
 * Format action for display
 * @param {Object} action - Action object
 * @param {Map} sponsorshipInfo - Map of sponsorship info
 * @returns {string} Formatted action string
 */
export function formatActionForDisplay(action, sponsorshipInfo) {
    const amountData = convertWeiToData(action.amount.toString());
    const info = sponsorshipInfo?.get(action.sponsorshipId);
    const streamId = info?.streamId || action.sponsorshipId;
    const truncatedId = streamId.length > 40 ? streamId.substring(0, 37) + '...' : streamId;
    
    if (action.type === 'stake') {
        return `Stake ${formatBigNumber(amountData)} DATA → ${truncatedId}`;
    } else {
        return `Unstake ${formatBigNumber(amountData)} DATA ← ${truncatedId}`;
    }
}

/**
 * Check if it's time to auto-collect based on config
 * @param {Object} config - Autostaker configuration
 * @returns {boolean} True if auto-collect should run
 */
export function shouldAutoCollect(config) {
    if (!config.autoCollectEnabled) {
        return false;
    }
    
    if (!config.lastCollectTime) {
        // Never collected before, do it now
        return true;
    }
    
    const lastCollect = new Date(config.lastCollectTime);
    const now = new Date();
    const hoursSinceLastCollect = (now - lastCollect) / (1000 * 60 * 60);
    
    return hoursSinceLastCollect >= config.autoCollectIntervalHours;
}

/**
 * Execute auto-collect earnings from all sponsorships
 * @param {string} operatorId - The operator contract address
 * @param {ethers.Signer} signer - Ethers signer
 * @param {Function} onLog - Callback to log messages (type, message)
 * @returns {Promise<Object>} Result with success status and txHash
 */
export async function executeAutoCollect(operatorId, signer, onLog) {
    onLog?.('info', '💰 Starting auto-collect earnings...');
    
    try {
        // Fetch current stakes to get sponsorship IDs
        const currentStakes = await fetchCurrentStakes(operatorId);
        
        if (currentStakes.size === 0) {
            onLog?.('info', 'No active stakes to collect from');
            return { success: true, message: 'No stakes to collect', skipped: true };
        }
        
        const sponsorshipIds = [...currentStakes.keys()];
        onLog?.('info', `Collecting from ${sponsorshipIds.length} sponsorship(s)...`);
        
        // Get gas settings
        let gasSettings = {};
        try {
            const feeData = await signer.provider.getFeeData();
            const minPriorityFee = ethers.utils.parseUnits('30', 'gwei');
            const minMaxFee = ethers.utils.parseUnits('100', 'gwei');
            
            gasSettings = {
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.gt(minPriorityFee) 
                    ? feeData.maxPriorityFeePerGas 
                    : minPriorityFee,
                maxFeePerGas: feeData.maxFeePerGas?.gt(minMaxFee)
                    ? feeData.maxFeePerGas
                    : minMaxFee
            };
        } catch (e) {
            console.warn('Failed to get fee data for auto-collect, using defaults:', e.message);
            gasSettings = {
                maxPriorityFeePerGas: ethers.utils.parseUnits('50', 'gwei'),
                maxFeePerGas: ethers.utils.parseUnits('200', 'gwei')
            };
        }
        
        // Execute withdraw
        const operatorContract = new ethers.Contract(operatorId, OPERATOR_CONTRACT_ABI, signer);
        const tx = await operatorContract.withdrawEarningsFromSponsorships(sponsorshipIds, gasSettings);
        
        onLog?.('info', 'Transaction submitted, waiting for confirmation...');
        const receipt = await tx.wait();
        
        onLog?.('success', `✅ Collected earnings! Tx: ${receipt.transactionHash.substring(0, 10)}...`);
        
        return {
            success: true,
            txHash: receipt.transactionHash,
            sponsorshipsCount: sponsorshipIds.length
        };
        
    } catch (e) {
        console.error('[Auto-Collect] Error:', e);
        
        let errorMsg = e.message;
        if (e.message.includes('gas price below minimum')) {
            errorMsg = 'Gas price too low - network congested';
        }
        
        onLog?.('error', `❌ Auto-collect failed: ${errorMsg.substring(0, 100)}`);
        
        return {
            success: false,
            error: errorMsg
        };
    }
}

/**
 * Get time until next auto-collect
 * @param {Object} config - Autostaker configuration
 * @returns {Object} Object with hours, minutes, and formatted string
 */
export function getTimeUntilNextCollect(config) {
    if (!config.autoCollectEnabled) {
        return { hours: 0, minutes: 0, formatted: 'Disabled' };
    }
    
    if (!config.lastCollectTime) {
        return { hours: 0, minutes: 0, formatted: 'Next cycle' };
    }
    
    const lastCollect = new Date(config.lastCollectTime);
    const nextCollect = new Date(lastCollect.getTime() + config.autoCollectIntervalHours * 60 * 60 * 1000);
    const now = new Date();
    
    const msUntil = nextCollect - now;
    
    if (msUntil <= 0) {
        return { hours: 0, minutes: 0, formatted: 'Next cycle' };
    }
    
    const hours = Math.floor(msUntil / (1000 * 60 * 60));
    const minutes = Math.floor((msUntil % (1000 * 60 * 60)) / (1000 * 60));
    
    if (hours > 0) {
        return { hours, minutes, formatted: `${hours}h ${minutes}m` };
    } else {
        return { hours, minutes, formatted: `${minutes}m` };
    }
}
