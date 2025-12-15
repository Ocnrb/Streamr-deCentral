/**
 * Delegators Feature Module
 * Handles the delegators exploration view with leaderboard, detail dashboard, and charts
 */

import { 
    getGraphUrl, 
    buildPolygonscanUrl,
    DELEGATORS_LIST_PAGE_SIZE,
    DELEGATOR_TX_HISTORY_LIMIT,
    POLYGONSCAN_NETWORK,
    POLYGONSCAN_METHOD_IDS,
    DATA_TOKEN_ADDRESS_POLYGON
} from '../core/constants.js';
import { formatBigNumber, shortAddress, parseOperatorMetadata, formatUsdForTooltip } from '../core/utils.js';
import { showToast, customTooltip } from '../ui/ui.js';

// ============================================
// State Management
// ============================================

const state = {
    // Delegators list
    allDelegators: [],
    filteredDelegators: [],
    selectedDelegator: null,
    
    // Pagination
    pagination: {
        skip: 0,
        limit: DELEGATORS_LIST_PAGE_SIZE,
        hasMore: true,
        isLoading: false
    },
    
    // Filters
    showSelfDelegation: false,
    searchMode: false,
    searchQuery: '',
    
    // Selected delegator data
    txHistory: null,
    earningsHistory: null,
    
    // Charts
    charts: {
        unified: null,
        map: null
    },
    
    // Chart type and timeframe
    chartType: 'earnings', // 'flow' or 'earnings'
    timeframe: 'all',
    
    // Price data
    dataPriceUSD: null,
    historicalDataPriceMap: null,
    
    // Operator metadata cache
    operatorAddresses: new Set(),
    operatorNames: {},
    operatorImages: {},
    
    // Module state
    isInitialized: false,
    isActive: false
};

// ============================================
// Utility Functions
// ============================================

/**
 * Format DATA token value from wei
 */
const formatDATA = (wei, minDecimals = 0, maxDecimals = 2) => {
    if (!wei) return '0';
    const value = parseFloat(wei) / 1e18;
    return new Intl.NumberFormat('en-US', {
        minimumFractionDigits: minDecimals,
        maximumFractionDigits: maxDecimals
    }).format(value).replace(/,/g, ' ');
};

/**
 * Format timestamp to readable date
 */
const formatTimestamp = (ts) => {
    return new Date(ts * 1000).toLocaleDateString('en-US', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    });
};

/**
 * Format timestamp to readable date with time (for transaction map tooltip)
 */
const formatTimestampWithTime = (ts) => {
    const date = new Date(ts * 1000);
    const datePart = date.toLocaleDateString('en-US', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    });
    const timePart = date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    return `${datePart} ${timePart}`;
};

/**
 * Calculate exchange rate from operator data
 * exchangeRate = valueWithoutEarnings / operatorTokenTotalSupplyWei
 * Returns 1 if data is missing or invalid
 */
const calculateExchangeRate = (operator) => {
    if (!operator) return 1;
    const valueWithoutEarnings = parseFloat(operator.valueWithoutEarnings) || 0;
    const totalSupply = parseFloat(operator.operatorTokenTotalSupplyWei) || 0;
    if (totalSupply === 0) return 1;
    return valueWithoutEarnings / totalSupply;
};

/**
 * Get operator image from parsed metadata
 */
const getOperatorImage = (metadata) => {
    // parseOperatorMetadata returns { name, description, imageUrl }
    if (metadata && metadata.imageUrl) {
        return metadata.imageUrl;
    }
    return null;
};

/**
 * Run GraphQL query
 */
async function runQuery(query) {
    const response = await fetch(getGraphUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
    });
    
    const result = await response.json();
    
    if (result.errors) {
        throw new Error(result.errors[0].message);
    }
    
    return result.data;
}

// ============================================
// Data Fetching
// ============================================

/**
 * Fetch metadata for operators by their IDs
 * Used to get images for operators in transaction history that aren't in current delegations
 */
async function fetchOperatorsMetadata(operatorIds) {
    if (!operatorIds || operatorIds.length === 0) return;
    
    // Filter out operators we already have images for
    const missingIds = operatorIds.filter(id => !state.operatorImages[id]);
    if (missingIds.length === 0) return;
    
    // Build query for multiple operators
    const idsString = missingIds.map(id => `"${id}"`).join(', ');
    const query = `
        query GetOperatorsMetadata {
            operators(where: { id_in: [${idsString}] }) {
                id
                metadataJsonString
            }
        }
    `;
    
    try {
        const data = await runQuery(query);
        const operators = data?.operators || [];
        
        operators.forEach(op => {
            const opId = op.id.toLowerCase();
            state.operatorAddresses.add(opId);
            const meta = parseOperatorMetadata(op.metadataJsonString);
            if (!state.operatorNames[opId]) {
                state.operatorNames[opId] = meta.name || shortAddress(opId);
            }
            const img = getOperatorImage(meta);
            if (img) {
                state.operatorImages[opId] = img;
            }
        });
    } catch (err) {
        console.warn('[FetchOperatorsMetadata] Failed to fetch operator metadata:', err);
    }
}

/**
 * Fetch delegators list from The Graph
 */
async function fetchDelegatorsList(skip = 0, limit = DELEGATORS_LIST_PAGE_SIZE) {
    const query = `
        query GetDelegators {
            delegators(
                first: ${limit}, 
                skip: ${skip}, 
                orderBy: totalValueDataWei, 
                orderDirection: desc
            ) {
                id
                numberOfDelegations
                totalValueDataWei
                cumulativeEarningsWei
                delegations(first: 20, orderBy: _valueDataWei, orderDirection: desc) {
                    id
                    _valueDataWei
                    operatorTokenBalanceWei
                    latestDelegationTimestamp
                    isSelfDelegation
                    operator {
                        id
                        metadataJsonString
                        valueWithoutEarnings
                        operatorTokenTotalSupplyWei
                    }
                }
            }
        }
    `;
    
    const data = await runQuery(query);
    return data.delegators || [];
}

/**
 * Fetch a specific delegator by address
 */
async function fetchDelegatorById(address) {
    const query = `
        query GetDelegator {
            delegator(id: "${address.toLowerCase()}") {
                id
                numberOfDelegations
                totalValueDataWei
                cumulativeEarningsWei
                delegations(first: 50, orderBy: _valueDataWei, orderDirection: desc) {
                    id
                    _valueDataWei
                    operatorTokenBalanceWei
                    latestDelegationTimestamp
                    isSelfDelegation
                    operator {
                        id
                        metadataJsonString
                        valueWithoutEarnings
                        operatorTokenTotalSupplyWei
                    }
                }
            }
        }
    `;
    
    const data = await runQuery(query);
    return data.delegator;
}

/**
 * Fetch delegator earnings history
 */
async function fetchDelegatorEarningsHistory(delegatorId) {
    const query = `
        query GetEarningsHistory {
            delegatorDailyBuckets(
                where: { delegator: "${delegatorId.toLowerCase()}" }, 
                orderBy: date, 
                orderDirection: asc, 
                first: 1000
            ) {
                date
                cumulativeEarningsWei
            }
        }
    `;
    
    const data = await runQuery(query);
    return data.delegatorDailyBuckets || [];
}

/**
 * Fetch transaction history from Polygonscan
 */
async function fetchPolygonscanTxHistory(walletAddress) {
    const txlistUrl = buildPolygonscanUrl({
        module: 'account',
        action: 'txlist',
        address: walletAddress,
        offset: DELEGATOR_TX_HISTORY_LIMIT
    });
    
    const tokentxUrl = buildPolygonscanUrl({
        module: 'account',
        action: 'tokentx',
        address: walletAddress,
        offset: DELEGATOR_TX_HISTORY_LIMIT
    });
    
    try {
        const [txlistRes, tokentxRes] = await Promise.all([
            fetch(txlistUrl, { cache: 'no-store' }),
            fetch(tokentxUrl, { cache: 'no-store' })
        ]);
        
        const txlistData = await txlistRes.json();
        const tokentxData = await tokentxRes.json();
        
        if (tokentxData.status === "0" && tokentxData.message !== "No transactions found") {
            throw new Error(tokentxData.result);
        }
        
        // Build method ID map from txlist
        const methodIdMap = new Map();
        if (txlistData.result && Array.isArray(txlistData.result)) {
            txlistData.result.forEach(tx => {
                if (tx.input && tx.input.length >= 10) {
                    methodIdMap.set(tx.hash, tx.input.substring(0, 10));
                }
            });
        }
        
        return processCombinedTxs(tokentxData.result || [], methodIdMap, walletAddress);
        
    } catch (err) {
        console.error("Polygonscan fetch error:", err);
        return [];
    }
}

/**
 * Process combined transaction data
 */
function processCombinedTxs(tokenTxs, methodIdMap, walletAddress) {
    const dataTokenAddress = DATA_TOKEN_ADDRESS_POLYGON.toLowerCase();
    const processed = [];
    
    const dataTxs = tokenTxs.filter(tx => 
        tx.contractAddress.toLowerCase() === dataTokenAddress
    );
    
    dataTxs.forEach(tx => {
        const isOut = tx.from.toLowerCase() === walletAddress.toLowerCase();
        const amount = parseFloat(tx.value) / 1e18;
        const methodId = methodIdMap.get(tx.hash) || "0x";
        const counterparty = isOut ? tx.to.toLowerCase() : tx.from.toLowerCase();
        
        let isKnownOperator = state.operatorAddresses.has(counterparty);
        let type = "Transfer";
        
        // Check method signature
        if (POLYGONSCAN_METHOD_IDS[methodId]) {
            type = POLYGONSCAN_METHOD_IDS[methodId];
            if (["Delegate", "Undelegate", "Stake", "Unstake", "Force Unstake"].includes(type)) {
                isKnownOperator = true;
                // Add to known operators if it's a delegation-related tx
                state.operatorAddresses.add(counterparty);
            }
        } else if (isKnownOperator) {
            type = isOut ? "Delegate" : "Undelegate";
        }
        
        // Normalize types for charts
        if (type === "Delegate" || type === "Stake") type = "Delegated";
        if (type === "Undelegate" || type === "Unstake" || type === "Force Unstake") type = "Undelegated";
        
        const operatorName = isKnownOperator && state.operatorNames[counterparty]
            ? state.operatorNames[counterparty]
            : shortAddress(counterparty);
        
        processed.push({
            hash: tx.hash,
            timestamp: parseInt(tx.timeStamp),
            date: new Date(parseInt(tx.timeStamp) * 1000),
            amount,
            isOut,
            type,
            operatorId: counterparty,
            operatorName,
            isRelevantFlow: type === "Delegated" || type === "Undelegated"
        });
    });
    
    return processed;
}

// ============================================
// Rendering Functions
// ============================================

/**
 * Render the delegators leaderboard table
 */
function renderLeaderboard() {
    const tbody = document.getElementById('delegators-leaderboard-body');
    const totalCountEl = document.getElementById('delegators-total-count');
    const totalStakedEl = document.getElementById('delegators-total-staked');
    const emptyState = document.getElementById('delegators-empty-state');
    const loadMoreContainer = document.getElementById('delegators-load-more-container');
    
    if (!tbody) return;
    
    tbody.innerHTML = '';
    
    // Calculate totals using calculated exchangeRate for accurate current value
    // For each delegator, sum (operatorTokenBalanceWei * exchangeRate) across all delegations
    // exchangeRate = valueWithoutEarnings / operatorTokenTotalSupplyWei
    const totalStakedWei = state.filteredDelegators.reduce((sum, d) => {
        const delegatorStake = d.delegations.reduce((delSum, del) => {
            const exchangeRate = calculateExchangeRate(del.operator);
            const operatorTokens = parseFloat(del.operatorTokenBalanceWei) || 0;
            // operatorTokens * exchangeRate gives DATA value in wei
            return delSum + (operatorTokens * exchangeRate);
        }, 0);
        return sum + delegatorStake;
    }, 0);
    
    if (totalCountEl) totalCountEl.textContent = state.filteredDelegators.length;
    if (totalStakedEl) totalStakedEl.textContent = formatDATA(totalStakedWei, 0, 0) + ' DATA';
    
    // Handle empty state
    if (state.filteredDelegators.length === 0) {
        if (emptyState) emptyState.classList.remove('hidden');
        if (loadMoreContainer) loadMoreContainer.classList.add('hidden');
        return;
    }
    
    if (emptyState) emptyState.classList.add('hidden');
    
    // Render rows
    state.filteredDelegators.forEach(d => {
        const tr = document.createElement('tr');
        tr.className = "group border-b border-[#333] hover:bg-[#252525] transition-colors cursor-pointer";
        tr.onclick = () => {
            // Navigate via router to update URL
            if (window.router) {
                window.router.navigate(`/delegator/${d.id}`);
            } else {
                DelegatorsLogic.selectDelegator(d);
            }
        };
        
        const avatarUrl = `https://effigy.im/a/${d.id}.svg`;
        
        // Calculate real staked value using calculated exchangeRate
        // Sum (operatorTokenBalanceWei * exchangeRate) across all delegations
        // exchangeRate = valueWithoutEarnings / operatorTokenTotalSupplyWei
        const realStakedWei = d.delegations.reduce((sum, del) => {
            const exchangeRate = calculateExchangeRate(del.operator);
            const operatorTokens = parseFloat(del.operatorTokenBalanceWei) || 0;
            return sum + (operatorTokens * exchangeRate);
        }, 0);
        const staked = formatDATA(realStakedWei.toString(), 0, 0);
        
        // Calculate last seen
        let lastTimestamp = 0;
        if (d.delegations && d.delegations.length > 0) {
            lastTimestamp = Math.max(...d.delegations.map(del => parseInt(del.latestDelegationTimestamp)));
        }
        const lastSeenStr = lastTimestamp > 0 ? formatTimestamp(lastTimestamp) : "-";
        
        // Check if self-delegator (operator)
        const isSelf = d.isSelfDelegator;
        const imgClass = isSelf
            ? "h-10 w-10 rounded-full bg-[#2a2a2a] border border-blue-500/50 ring-2 ring-blue-500/20 shadow-[0_0_10px_rgba(59,130,246,0.3)]"
            : "h-10 w-10 rounded-full bg-[#2a2a2a] border border-[#333]";
        
        // Truncated address for mobile: 0x1234...5678
        const truncatedAddr = d.id.slice(0, 6) + '...' + d.id.slice(-4);
        
        tr.innerHTML = `
            <td class="px-4 md:px-6 py-5 whitespace-nowrap">
                <div class="flex items-center gap-3 md:gap-4">
                    <img src="${avatarUrl}" class="${imgClass} h-8 w-8 md:h-10 md:w-10" alt="">
                    <div class="flex flex-col">
                        <span class="text-sm font-mono text-gray-200 group-hover:text-blue-400 transition-colors hidden md:inline">${d.id}</span>
                        <span class="text-sm font-mono text-gray-200 group-hover:text-blue-400 transition-colors md:hidden">${truncatedAddr}</span>
                        ${isSelf ? '<span class="text-[10px] text-blue-400 font-medium">Operator</span>' : ''}
                    </div>
                </div>
            </td>
            <td class="px-4 md:px-6 py-5 text-right whitespace-nowrap">
                <div class="text-sm font-bold text-white">${staked}</div>
            </td>
            <td class="px-6 py-5 text-center whitespace-nowrap hidden md:table-cell">
                <span class="px-2.5 py-0.5 rounded-full text-xs font-medium bg-[#2a2a2a] text-gray-300 border border-[#333]">${d.numberOfDelegations} Ops</span>
            </td>
            <td class="px-6 py-5 text-center whitespace-nowrap hidden md:table-cell">
                <span class="text-xs text-gray-400">${lastSeenStr}</span>
            </td>
        `;
        
        tbody.appendChild(tr);
    });
    
    // Show/hide load more button
    if (!state.searchMode && state.pagination.hasMore) {
        if (loadMoreContainer) loadMoreContainer.classList.remove('hidden');
    } else {
        if (loadMoreContainer) loadMoreContainer.classList.add('hidden');
    }
}

/**
 * Render delegator detail view header
 */
function renderDetailHeader(delegator) {
    const addressEl = document.getElementById('delegator-detail-address');
    const linkEl = document.getElementById('delegator-detail-link');
    const avatarEl = document.getElementById('delegator-detail-avatar');
    const stakeEl = document.getElementById('delegator-detail-stake');
    const initialEl = document.getElementById('delegator-detail-initial');
    const earningsEl = document.getElementById('delegator-detail-earnings');
    const opsCountEl = document.getElementById('delegator-detail-ops-count');
    const lastSeenEl = document.getElementById('delegator-detail-last-seen');
    
    if (addressEl) addressEl.textContent = delegator.id;
    if (linkEl) linkEl.href = `https://polygonscan.com/address/${delegator.id}`;
    if (avatarEl) avatarEl.src = `https://effigy.im/a/${delegator.id}.svg`;
    
    // Initial Delegation (totalValueDataWei) with USD tooltip
    const initialValue = parseFloat(delegator.totalValueDataWei) / 1e18;
    if (initialEl) {
        initialEl.textContent = formatDATA(delegator.totalValueDataWei, 0, 0);
        initialEl.setAttribute('data-tooltip-value', initialValue.toString());
    }
    
    // Current Staked value = sum of (operatorTokenBalanceWei * exchangeRate) for all delegations
    // This matches exactly what is shown in the list
    // exchangeRate = valueWithoutEarnings / operatorTokenTotalSupplyWei (calculated, not from The Graph)
    const currentStakedWei = delegator.delegations.reduce((sum, del) => {
        const exchangeRate = calculateExchangeRate(del.operator);
        const operatorTokens = parseFloat(del.operatorTokenBalanceWei) || 0;
        return sum + (operatorTokens * exchangeRate);
    }, 0);
    const currentStakedValue = currentStakedWei / 1e18;
    if (stakeEl) {
        stakeEl.textContent = formatDATA(currentStakedWei.toString(), 0, 0);
        stakeEl.setAttribute('data-tooltip-value', currentStakedValue.toString());
    }
    
    // Earnings value with USD tooltip
    const earningsValue = parseFloat(delegator.cumulativeEarningsWei) / 1e18;
    if (earningsEl) {
        earningsEl.textContent = formatDATA(delegator.cumulativeEarningsWei, 0, 0);
        earningsEl.setAttribute('data-tooltip-value', earningsValue.toString());
    }
    
    // Count active operators
    // For pure self-delegators (operators), count self-delegations
    // For regular delegators, exclude self-delegations
    let activeOps = 0;
    try {
        const hasSelfDelegation = delegator.delegations.some(del => del.isSelfDelegation);
        const hasOtherDelegations = delegator.delegations.some(del => !del.isSelfDelegation);
        
        if (hasSelfDelegation && !hasOtherDelegations) {
            // Pure self-delegator (operator) - count self-delegations
            activeOps = delegator.delegations.filter(
                del => parseFloat(del._valueDataWei) > 0
            ).length;
        } else {
            // Regular delegator - exclude self-delegations
            activeOps = delegator.delegations.filter(
                del => !del.isSelfDelegation && parseFloat(del._valueDataWei) > 0
            ).length;
        }
    } catch (e) { /* ignore */ }
    
    if (opsCountEl) opsCountEl.textContent = activeOps;
    
    // Calculate last seen
    let lastTimestamp = 0;
    if (delegator.delegations && delegator.delegations.length > 0) {
        lastTimestamp = Math.max(...delegator.delegations.map(del => parseInt(del.latestDelegationTimestamp)));
    }
    if (lastSeenEl) lastSeenEl.textContent = lastTimestamp > 0 ? formatTimestamp(lastTimestamp) : "Never";
}

/**
 * Render delegations table in modal
 */
function renderDelegationsTable(delegations) {
    const tbody = document.getElementById('delegator-delegations-table-body');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    
    // Check if this is a pure self-delegator (operator)
    const hasSelfDelegation = delegations.some(del => del.isSelfDelegation);
    const hasOtherDelegations = delegations.some(del => !del.isSelfDelegation);
    const isPureSelfDelegator = hasSelfDelegation && !hasOtherDelegations;
    
    delegations.forEach(del => {
        // Skip self-delegations only if delegator has other delegations
        if (del.isSelfDelegation && !isPureSelfDelegator) return;
        
        const metadata = parseOperatorMetadata(del.operator.metadataJsonString);
        const name = metadata.name || "Unknown Operator";
        const opId = del.operator.id.toLowerCase();
        const valueData = parseFloat(del._valueDataWei) / 1e18;
        const date = formatTimestamp(del.latestDelegationTimestamp);
        const sharePct = (parseFloat(del.operatorTokenBalanceWei) / parseFloat(del.operator.operatorTokenTotalSupplyWei)) * 100 || 0;
        const isUndelegated = valueData < 0.0001;
        
        // Get operator image
        const imageUrl = state.operatorImages[opId] || getOperatorImage(metadata);
        
        const row = document.createElement('tr');
        row.className = isUndelegated 
            ? "border-b border-[#333] bg-[#1E1E1E] text-gray-500" 
            : "border-b border-[#333] hover:bg-[#2a2a2a] transition-colors";
        
        row.innerHTML = `
            <td class="px-6 py-4 font-medium">
                <div class="flex items-center gap-2">
                    ${imageUrl 
                        ? `<img src="${imageUrl}" alt="${name}" class="h-6 w-6 rounded-full object-cover ${isUndelegated ? 'opacity-50 grayscale' : ''}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                           <div class="h-6 w-6 rounded-full items-center justify-center text-[10px] font-bold text-white shadow-sm ${isUndelegated ? 'bg-gray-700' : 'bg-gradient-to-br from-orange-400 to-red-500'}" style="display:none;">
                               ${name.charAt(0).toUpperCase()}
                           </div>`
                        : `<div class="h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shadow-sm ${isUndelegated ? 'bg-gray-700' : 'bg-gradient-to-br from-orange-400 to-red-500'}">
                               ${name.charAt(0).toUpperCase()}
                           </div>`
                    }
                    <div class="flex flex-col">
                        <span class="truncate max-w-[150px] ${isUndelegated ? 'text-gray-500' : 'text-white'}" title="${name}">${name}</span>
                        <span class="text-[10px] text-gray-500 font-mono">${shortAddress(del.operator.id)}</span>
                    </div>
                </div>
            </td>
            <td class="px-6 py-4 text-right font-bold ${isUndelegated ? 'text-gray-600' : 'text-orange-400'}">
                ${formatDATA(del._valueDataWei, 0, 0)} <span class="text-[10px] text-gray-500">DATA</span>
            </td>
            <td class="px-6 py-4 text-right font-mono text-gray-300 text-xs">${date}</td>
            <td class="px-6 py-4 text-right font-mono text-gray-500 text-xs">${sharePct.toFixed(4)}%</td>
            <td class="px-6 py-4 text-center">
                <a href="/operator/${del.operator.id}" class="p-2 text-gray-400 hover:text-white hover:bg-gray-600 rounded-lg inline-flex" data-nav-link>
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
                    </svg>
                </a>
            </td>
        `;
        
        tbody.appendChild(row);
    });
}

/**
 * Render inline delegations table (between charts)
 */
function renderInlineDelegationsTable(delegations) {
    const tbody = document.getElementById('delegator-inline-delegations-body');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    
    // Check if this is a pure self-delegator (operator)
    const hasSelfDelegation = delegations.some(del => del.isSelfDelegation);
    const hasOtherDelegations = delegations.some(del => !del.isSelfDelegation);
    const isPureSelfDelegator = hasSelfDelegation && !hasOtherDelegations;
    
    // Filter and sort: active delegations first, then undelegated
    const sorted = [...delegations]
        .filter(del => isPureSelfDelegator || !del.isSelfDelegation)
        .sort((a, b) => {
            const aValue = parseFloat(a._valueDataWei);
            const bValue = parseFloat(b._valueDataWei);
            // Active delegations first (higher value first), then undelegated
            if (aValue > 0.0001 && bValue <= 0.0001) return -1;
            if (aValue <= 0.0001 && bValue > 0.0001) return 1;
            return bValue - aValue;
        });
    
    if (sorted.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="px-6 py-8 text-center text-gray-500">No delegations found.</td></tr>';
        return;
    }
    
    sorted.forEach(del => {
        const metadata = parseOperatorMetadata(del.operator.metadataJsonString);
        const name = metadata.name || "Unknown Operator";
        const opId = del.operator.id.toLowerCase();
        const delegatedValue = parseFloat(del._valueDataWei) / 1e18;
        const date = formatTimestamp(del.latestDelegationTimestamp);
        const sharePct = (parseFloat(del.operatorTokenBalanceWei) / parseFloat(del.operator.operatorTokenTotalSupplyWei)) * 100 || 0;
        const isUndelegated = delegatedValue < 0.0001;
        
        // Calculate current stake: operatorTokenBalanceWei * exchangeRate / 1e18
        // exchangeRate = valueWithoutEarnings / operatorTokenTotalSupplyWei (calculated)
        // Result: currentStakeData is in DATA units (not wei)
        const exchangeRate = calculateExchangeRate(del.operator);
        const operatorTokens = parseFloat(del.operatorTokenBalanceWei) || 0;
        const currentStakeData = (operatorTokens * exchangeRate) / 1e18;
        // Convert to wei for formatDATA
        const currentStakeWei = currentStakeData * 1e18;
        
        // Get operator image
        const imageUrl = state.operatorImages[opId] || getOperatorImage(metadata);
        
        const row = document.createElement('tr');
        row.className = isUndelegated 
            ? "border-b border-[#333] bg-[#1E1E1E] text-gray-500" 
            : "border-b border-[#333] hover:bg-[#2a2a2a] transition-colors";
        
        row.innerHTML = `
            <td class="px-6 py-4">
                <a href="/operator/${del.operator.id}" class="flex items-center gap-3 hover:opacity-80 transition-opacity" data-nav-link>
                    ${imageUrl 
                        ? `<img src="${imageUrl}" alt="${name}" class="h-10 w-10 rounded-full object-cover flex-shrink-0 ${isUndelegated ? 'opacity-50 grayscale' : ''}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                           <div class="h-10 w-10 rounded-full items-center justify-center text-sm font-bold text-white shadow-sm flex-shrink-0 ${isUndelegated ? 'bg-gray-700' : 'bg-gradient-to-br from-orange-400 to-red-500'}" style="display:none;">
                               ${name.charAt(0).toUpperCase()}
                           </div>`
                        : `<div class="h-10 w-10 rounded-full flex items-center justify-center text-sm font-bold text-white shadow-sm flex-shrink-0 ${isUndelegated ? 'bg-gray-700' : 'bg-gradient-to-br from-orange-400 to-red-500'}">
                               ${name.charAt(0).toUpperCase()}
                           </div>`
                    }
                    <span class="text-sm truncate max-w-[200px] ${isUndelegated ? 'text-gray-500' : 'text-gray-300'}" title="${name}">${name}</span>
                </a>
            </td>
            <td class="px-6 py-4 text-right text-xs ${isUndelegated ? 'text-gray-600' : 'text-gray-300'}">
                <span data-tooltip-value="${delegatedValue}">${formatDATA(del._valueDataWei, 0, 0)} <span class="text-gray-500">DATA</span></span>
            </td>
            <td class="px-6 py-4 text-right text-xs font-bold ${isUndelegated ? 'text-gray-600' : 'text-orange-400'}">
                <span data-tooltip-value="${currentStakeData}">${formatDATA(currentStakeWei.toString(), 0, 0)} <span class="text-gray-500">DATA</span></span>
            </td>
            <td class="px-6 py-4 text-right text-xs ${isUndelegated ? 'text-gray-600' : 'text-gray-300'}">${Math.round(sharePct)}%</td>
            <td class="px-6 py-4 text-right text-xs ${isUndelegated ? 'text-gray-600' : 'text-gray-300'}">${date}</td>
        `;
        
        tbody.appendChild(row);
    });
}

/**
 * Render transaction history table
 */
function renderHistoryTable(txs) {
    const tbody = document.getElementById('delegator-history-table-body');
    const countEl = document.getElementById('delegator-tx-count');
    
    if (!tbody) return;
    
    tbody.innerHTML = '';
    if (countEl) countEl.textContent = `${txs.length} txs`;
    
    if (txs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="px-6 py-4 text-center text-gray-500">No history found.</td></tr>';
        return;
    }
    
    txs.forEach(tx => {
        const tr = document.createElement('tr');
        tr.className = "hover:bg-[#2a2a2a] transition-colors border-b border-[#333]";
        
        const amountClass = tx.type === "Undelegated" ? "text-red-400" : "text-green-400";
        const sign = tx.type === "Undelegated" ? "-" : "+";
        
        tr.innerHTML = `
            <td class="px-4 py-3 font-mono text-gray-300 text-xs whitespace-nowrap">${tx.date.toLocaleString('en-US')}</td>
            <td class="px-4 py-3 text-xs text-white font-bold">${tx.type}</td>
            <td class="px-4 py-3 text-xs text-gray-300">${tx.operatorName}</td>
            <td class="px-4 py-3 text-right font-medium ${amountClass}">${sign}${formatDATA(tx.amount * 1e18)}</td>
            <td class="px-4 py-3 text-center">
                <a href="${POLYGONSCAN_NETWORK.explorerUrl}${tx.hash}" target="_blank" class="text-blue-400 hover:text-white">
                    <svg class="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
                    </svg>
                </a>
            </td>
        `;
        
        tbody.appendChild(tr);
    });
}

// ============================================
// Chart Rendering
// ============================================

/**
 * Initialize Chart.js defaults
 */
function initChartDefaults() {
    if (typeof Chart === 'undefined') return;
    
    Chart.defaults.color = '#6b7280';
    Chart.defaults.font.family = "'Inter', sans-serif";
    Chart.defaults.font.size = 10;
    Chart.defaults.scale.grid.color = 'rgba(255, 255, 255, 0.03)';
    Chart.defaults.scale.grid.borderColor = 'transparent';
}

/**
 * Get historical price for a given date (unix timestamp in seconds)
 */
function getHistoricalPrice(dateTimestamp) {
    if (!state.historicalDataPriceMap) return state.dataPriceUSD || 0;
    
    // Convert ms to seconds if needed
    const dateSeconds = dateTimestamp > 10000000000 ? Math.floor(dateTimestamp / 1000) : dateTimestamp;
    
    // Normalize to midnight UTC
    const normalizedDate = Math.floor(dateSeconds / 86400) * 86400;
    
    let price = state.historicalDataPriceMap.get(normalizedDate);
    
    // If no price for this date, look back up to 7 days
    if (!price) {
        for (let i = 1; i <= 7; i++) {
            const priorDate = normalizedDate - (i * 86400);
            price = state.historicalDataPriceMap.get(priorDate);
            if (price) break;
        }
    }
    
    return price || state.dataPriceUSD || 0;
}

/**
 * Render capital flow chart
 */
function renderFlowChart() {
    if (!state.txHistory) return;
    
    const ctx = document.getElementById('delegator-unified-chart')?.getContext('2d');
    if (!ctx) return;
    
    // Destroy existing unified chart
    if (state.charts.unified) {
        state.charts.unified.destroy();
        state.charts.unified = null;
    }
    
    const sortedTxs = [...state.txHistory].reverse();
    const flowData = [];
    
    // Calculate cutoff
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let cutoffTimestamp = 0;
    
    if (state.timeframe !== 'all') {
        const daysAgo = parseInt(state.timeframe);
        cutoffTimestamp = today.getTime() - (daysAgo * 24 * 60 * 60 * 1000);
    }
    
    sortedTxs.forEach(tx => {
        if (!tx.isRelevantFlow) return;
        const txTime = tx.timestamp * 1000;
        
        if (txTime >= cutoffTimestamp) {
            const dateStr = formatTimestamp(tx.timestamp);
            const historicalPrice = getHistoricalPrice(tx.timestamp);
            
            flowData.push({
                date: dateStr,
                timestamp: tx.timestamp,
                inflow: tx.type === "Delegated" ? tx.amount : 0,
                outflow: tx.type === "Delegated" ? 0 : tx.amount,
                historicalPrice: historicalPrice
            });
        }
    });
    
    // Add mock "today" point if the last data point is not today
    const todayStr = today.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
    if (flowData.length > 0) {
        const lastDate = flowData[flowData.length - 1].date;
        if (lastDate !== todayStr) {
            flowData.push({
                date: todayStr,
                timestamp: Math.floor(today.getTime() / 1000),
                inflow: 0,
                outflow: 0,
                historicalPrice: state.dataPriceUSD || 0
            });
        }
    }
    
    const dates = flowData.map(d => d.date);
    const inflows = flowData.map(d => d.inflow);
    const outflows = flowData.map(d => d.outflow);
    
    state.charts.unified = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: dates,
            datasets: [
                { label: '+', data: inflows, backgroundColor: '#22c55e', borderRadius: 4 },
                { label: '-', data: outflows.map(v => -v), backgroundColor: '#ef4444', borderRadius: 4 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(30, 30, 30, 0.9)',
                    titleColor: '#ffffff',
                    bodyColor: '#9ca3af',
                    borderColor: '#333333',
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 12,
                    displayColors: false,
                    titleFont: { family: "'Inter', sans-serif", size: 13, weight: '600' },
                    bodyFont: { family: "'Inter', sans-serif", size: 13 },
                    callbacks: {
                        label: (context) => {
                            const value = Math.abs(context.raw);
                            const dataPoint = flowData[context.dataIndex];
                            const sign = context.dataset.label;
                            const lines = [];
                            lines.push(`${sign}${formatDATA(value * 1e18, 0, 0)} DATA`);
                            if (dataPoint && dataPoint.historicalPrice > 0) {
                                const usdValue = value * dataPoint.historicalPrice;
                                lines.push(`~$${formatBigNumber(Math.round(usdValue).toString())}`);
                            }
                            return lines;
                        }
                    }
                }
            },
            scales: {
                y: { stacked: true, grid: { color: '#333333', borderDash: [4, 4], drawBorder: false }, ticks: { color: '#6b7280', font: { family: "'Inter', sans-serif", size: 11 } }, border: { display: false } },
                x: { stacked: true, grid: { display: false }, ticks: { color: '#6b7280', maxTicksLimit: 8, maxRotation: 45, minRotation: 45, font: { family: "'Inter', sans-serif", size: 11 } }, border: { display: false } }
            }
        }
    });
}

/**
 * Render earnings chart
 */
function renderEarningsChart() {
    if (!state.earningsHistory) return;
    
    const ctx = document.getElementById('delegator-unified-chart')?.getContext('2d');
    if (!ctx) return;
    
    // Destroy existing unified chart
    if (state.charts.unified) {
        state.charts.unified.destroy();
        state.charts.unified = null;
    }
    
    // Calculate cutoff
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let cutoffTimestamp = 0;
    
    if (state.timeframe !== 'all') {
        const daysAgo = parseInt(state.timeframe);
        cutoffTimestamp = today.getTime() - (daysAgo * 24 * 60 * 60 * 1000);
    }
    
    const dates = [];
    const daily = [];
    const cumulative = [];
    
    for (let i = 0; i < state.earningsHistory.length; i++) {
        const todayData = state.earningsHistory[i];
        if ((todayData.date * 1000) < cutoffTimestamp) continue;
        
        const prev = i > 0 ? state.earningsHistory[i - 1] : null;
        const cum = parseFloat(todayData.cumulativeEarningsWei) / 1e18;
        const prevCum = prev ? parseFloat(prev.cumulativeEarningsWei) / 1e18 : 0;
        
        dates.push(formatTimestamp(todayData.date));
        daily.push(Math.max(0, cum - prevCum));
        cumulative.push(cum);
    }
    
    state.charts.unified = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: dates,
            datasets: [
                { label: 'Daily', data: daily, backgroundColor: 'rgba(59, 130, 246, 0.5)', borderRadius: 2, yAxisID: 'y' },
                { label: 'Total', data: cumulative, type: 'line', borderColor: '#3b82f6', borderWidth: 2, pointBackgroundColor: '#3b82f6', pointBorderColor: '#232c45ff', pointBorderWidth: 0.5, pointRadius: 2.5, pointHoverRadius: 4, tension: 0.25, fill: false, yAxisID: 'y1' }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(30, 30, 30, 0.9)',
                    titleColor: '#ffffff',
                    bodyColor: '#9ca3af',
                    borderColor: '#333333',
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 8,
                    displayColors: false,
                    titleFont: { family: "'Inter', sans-serif", size: 13, weight: '600' },
                    bodyFont: { family: "'Inter', sans-serif", size: 13 },
                    callbacks: {
                        label: (context) => {
                            const value = context.raw;
                            const lines = [];
                            lines.push(`${formatBigNumber(Math.round(value).toString())} DATA`);
                            // Show USD using live stream price
                            if (state.dataPriceUSD > 0) {
                                const usdValue = value * state.dataPriceUSD;
                                lines.push(`~$${formatBigNumber(Math.round(usdValue).toString())}`);
                            }
                            return lines;
                        }
                    }
                }
            },
            scales: {
                y: { 
                    position: 'left', 
                    grid: { color: '#333333', borderDash: [4, 4], drawBorder: false }, 
                    ticks: { 
                        color: '#6b7280', 
                        font: { family: "'Inter', sans-serif", size: 11 },
                        callback: function(value) {
                            if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
                            if (value >= 1000) return (value / 1000).toFixed(0) + 'K';
                            return Math.round(value);
                        }
                    }, 
                    border: { display: false } 
                },
                y1: { 
                    position: 'right', 
                    beginAtZero: false,
                    grid: { display: false }, 
                    ticks: { 
                        color: '#3b82f6', 
                        font: { family: "'Inter', sans-serif", size: 11 },
                        callback: function(value) {
                            if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
                            if (value >= 1000) return (value / 1000).toFixed(0) + 'K';
                            return Math.round(value);
                        }
                    }, 
                    border: { display: false } 
                },
                x: { grid: { display: false }, ticks: { color: '#6b7280', maxTicksLimit: 8, maxRotation: 45, minRotation: 45, font: { family: "'Inter', sans-serif", size: 11 } }, border: { display: false } }
            }
        }
    });
}

/**
 * Render transaction map (bubble chart with operator images)
 */
function renderMapChart() {
    if (!state.txHistory || state.txHistory.length === 0) return;
    
    const ctx = document.getElementById('delegator-map-chart')?.getContext('2d');
    if (!ctx) return;
    
    if (state.charts.map) {
        state.charts.map.destroy();
    }
    
    // Calculate cutoff
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let cutoffTimestamp = 0;
    
    if (state.timeframe !== 'all') {
        const daysAgo = parseInt(state.timeframe);
        cutoffTimestamp = today.getTime() - (daysAgo * 24 * 60 * 60 * 1000);
    }
    
    const mapDataPoints = [];
    const images = {};
    
    // Process transactions for map data
    const sortedTxs = [...state.txHistory].reverse();
    
    sortedTxs.forEach(tx => {
        if (!tx.isRelevantFlow) return;
        const txTime = tx.timestamp * 1000;
        if (txTime < cutoffTimestamp) return;
        
        // Preload operator images
        const opId = tx.operatorId?.toLowerCase();
        
        // Try to find image with exact match or partial match
        let imageUrl = state.operatorImages[opId];
        if (!imageUrl) {
            const matchingKey = Object.keys(state.operatorImages).find(k => 
                k.toLowerCase() === opId || opId?.includes(k) || k.includes(opId || '')
            );
            if (matchingKey) {
                imageUrl = state.operatorImages[matchingKey];
            }
        }
        
        if (opId && imageUrl && !images[opId]) {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = imageUrl;
            images[opId] = img;
            img.onload = () => {
                if (state.charts.map) state.charts.map.update('none');
            };
            img.onerror = () => {
                // Silently handle image load errors
            };
        }
        
        const signedAmount = tx.type === 'Undelegated' ? -tx.amount : tx.amount;
        const historicalPrice = getHistoricalPrice(tx.timestamp);
        
        mapDataPoints.push({
            x: txTime,
            y: signedAmount,
            r: Math.min(30, Math.max(10, Math.sqrt(tx.amount / 1000) * 3)),
            operator: tx.operatorName || shortAddress(opId || ''),
            operatorId: opId,
            dateStr: formatTimestampWithTime(tx.timestamp),
            type: tx.type,
            historicalPrice: historicalPrice
        });
    });
    
    // Add timeline extender point
    const todayStr = today.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
    if (mapDataPoints.length > 0) {
        mapDataPoints.push({ x: today.getTime(), y: 0, r: 0, operator: '', operatorId: 'timeline-extender', dateStr: todayStr, type: 'Timeline', historicalPrice: 0 });
    }
    
    // Custom plugin for operator images inside bubbles
    const imagePlugin = {
        id: 'customImagePoints',
        afterDatasetsDraw: (chart) => {
            const ctx = chart.ctx;
            chart.data.datasets.forEach((dataset, i) => {
                const meta = chart.getDatasetMeta(i);
                meta.data.forEach((element, index) => {
                    const point = dataset.data[index];
                    if (point.type === 'Timeline') return;
                    
                    const img = images[point.operatorId];
                    if (img && img.complete && img.naturalHeight !== 0) {
                        const size = element.options.radius * 2;
                        ctx.save();
                        ctx.beginPath();
                        ctx.arc(element.x, element.y, element.options.radius, 0, Math.PI * 2);
                        ctx.closePath();
                        ctx.clip();
                        ctx.globalAlpha = 1;
                        try {
                            ctx.drawImage(img, element.x - size / 2, element.y - size / 2, size, size);
                        } catch (e) {
                            // Ignore draw errors
                        }
                        ctx.restore();
                    }
                });
            });
        }
    };
    
    state.charts.map = new Chart(ctx, {
        type: 'bubble',
        data: {
            datasets: [{
                label: 'Transactions',
                data: mapDataPoints,
                backgroundColor: (ctx) => ctx.raw?.type === 'Delegated' ? 'rgba(59, 130, 246, 0.6)' : 'rgba(239, 68, 68, 0.6)',
                borderColor: (ctx) => ctx.raw?.type === 'Delegated' ? 'rgba(59, 130, 246, 1)' : 'rgba(239, 68, 68, 1)',
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(30, 30, 30, 0.9)',
                    titleColor: '#ffffff',
                    bodyColor: '#9ca3af',
                    borderColor: '#333333',
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 8,
                    displayColors: false,
                    titleFont: { family: "'Inter', sans-serif", size: 13, weight: '600' },
                    bodyFont: { family: "'Inter', sans-serif", size: 13 },
                    filter: (item) => item.raw.type !== 'Timeline',
                    callbacks: {
                        title: (items) => {
                            if (items.length === 0) return '';
                            return items[0].raw.dateStr;
                        },
                        label: (ctx) => {
                            const point = ctx.raw;
                            const value = Math.abs(point.y);
                            const lines = [];
                            lines.push(`${point.type} ${point.operator}`);
                            lines.push(`${formatDATA(value * 1e18, 0, 0)} DATA`);
                            if (point.historicalPrice > 0) {
                                const usdValue = value * point.historicalPrice;
                                lines.push(`~$${formatBigNumber(Math.round(usdValue).toString())}`);
                            }
                            return lines;
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    position: 'bottom',
                    ticks: {
                        color: '#6b7280',
                        font: { family: "'Inter', sans-serif", size: 11 },
                        callback: (val) => new Date(val).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
                    },
                    grid: { display: false },
                    border: { display: false }
                },
                y: {
                    title: { display: true, text: 'Value (DATA)', color: '#6b7280', font: { family: "'Inter', sans-serif", size: 11 } },
                    ticks: {
                        color: '#6b7280',
                        font: { family: "'Inter', sans-serif", size: 11 },
                        callback: (val) => formatDATA(Math.abs(val) * 1e18, 0, 0)
                    },
                    grid: {
                        color: (ctx) => ctx.tick.value === 0 ? 'rgba(255, 255, 255, 0.2)' : '#333333',
                        lineWidth: (ctx) => ctx.tick.value === 0 ? 2 : 1,
                        borderDash: (ctx) => ctx.tick.value === 0 ? [] : [4, 4],
                        drawBorder: false
                    },
                    border: { display: false }
                }
            }
        },
        plugins: [imagePlugin]
    });
}

/**
 * Filter and render the appropriate chart based on chartType
 */
function filterAndRenderChart() {
    if (!state.isActive) return;
    
    switch (state.chartType) {
        case 'earnings':
            renderEarningsChart();
            break;
        case 'flow':
        default:
            renderFlowChart();
            break;
    }
    updateDelegatorChartButtons();
}

/**
 * Render all charts (unified chart + map)
 */
function renderAllCharts() {
    if (!state.isActive) return;
    
    filterAndRenderChart();
    renderMapChart();
}

/**
 * Update chart buttons state (chart type pills and timeframe)
 */
function updateDelegatorChartButtons() {
    // Chart type pills
    const chartTypeTabs = document.querySelectorAll('#delegator-chart-type-tabs button');
    chartTypeTabs.forEach(button => {
        if (button.dataset.chartType === state.chartType) {
            button.classList.add('bg-blue-600', 'text-white');
            button.classList.remove('text-gray-400', 'hover:text-white');
        } else {
            button.classList.remove('bg-blue-600', 'text-white');
            button.classList.add('text-gray-400', 'hover:text-white');
        }
    });
    
    // Update legend visibility based on chart type
    const legend = document.getElementById('delegator-chart-legend');
    if (legend) {
        if (state.chartType === 'flow') {
            legend.classList.remove('hidden');
        } else {
            legend.classList.add('hidden');
        }
    }
    
    // Timeframe buttons
    const timeframeButtons = document.querySelectorAll('#delegator-chart-timeframe-buttons button');
    timeframeButtons.forEach(button => {
        const btnTimeframe = button.dataset.delegatorTimeframe;
        if (btnTimeframe === state.timeframe) {
            button.classList.add('bg-blue-600', 'text-white');
            button.classList.remove('hover:bg-[#444444]', 'text-gray-300');
        } else {
            button.classList.remove('bg-blue-600', 'text-white');
            button.classList.add('hover:bg-[#444444]', 'text-gray-300');
        }
    });
}

// ============================================
// Public API (DelegatorsLogic)
// ============================================

export const DelegatorsLogic = {
    /**
     * Set shared state from main.js (e.g., dataPriceUSD, historicalDataPriceMap)
     */
    setSharedState(sharedState) {
        if (sharedState.dataPriceUSD !== undefined) state.dataPriceUSD = sharedState.dataPriceUSD;
        if (sharedState.historicalDataPriceMap !== undefined) state.historicalDataPriceMap = sharedState.historicalDataPriceMap;
    },
    
    /**
     * Initialize the delegators module
     */
    async init() {
        if (state.isInitialized) return;
        
        initChartDefaults();
        this.setupEventListeners();
        
        state.isInitialized = true;
        state.isActive = true;
        
        await this.loadInitialDelegators();
    },
    
    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Search input
        const searchInput = document.getElementById('delegators-search-input');
        if (searchInput) {
            let searchTimeout;
            searchInput.addEventListener('input', (e) => {
                const term = e.target.value.toLowerCase().trim();
                clearTimeout(searchTimeout);
                
                if (!term) {
                    state.searchMode = false;
                    state.filteredDelegators = state.allDelegators;
                    renderLeaderboard();
                    return;
                }
                
                state.searchMode = true;
                state.searchQuery = term;
                
                // Local filter first
                const localResults = state.allDelegators.filter(d => 
                    d.id.toLowerCase().includes(term)
                );
                state.filteredDelegators = localResults;
                renderLeaderboard();
                
                // If no local results and looks like address, search network
                if (localResults.length === 0 && term.startsWith('0x') && term.length === 42) {
                    searchTimeout = setTimeout(() => {
                        this.searchDelegator(term);
                    }, 500);
                }
            });
        }
        
        // Self-delegation checkbox
        const selfDelegationCheckbox = document.getElementById('delegators-show-self-delegation');
        if (selfDelegationCheckbox) {
            selfDelegationCheckbox.addEventListener('change', () => {
                this.toggleSelfDelegation();
            });
        }
        
        // Timeframe buttons
        document.querySelectorAll('[data-delegator-timeframe]').forEach(btn => {
            btn.addEventListener('click', () => {
                const days = btn.dataset.delegatorTimeframe;
                this.setTimeframe(days);
            });
        });
        
        // Chart type pills
        document.querySelectorAll('#delegator-chart-type-tabs button').forEach(btn => {
            btn.addEventListener('click', () => {
                const chartType = btn.dataset.chartType;
                if (chartType && chartType !== state.chartType) {
                    state.chartType = chartType;
                    filterAndRenderChart();
                }
            });
        });
        
        // Tooltip handlers for delegator detail view
        const detailView = document.getElementById('delegator-detail-view');
        if (detailView) {
            detailView.addEventListener('mouseover', (e) => {
                const target = e.target.closest('[data-tooltip-value]');
                if (!target) return;
                
                const content = formatUsdForTooltip(target.dataset.tooltipValue, state.dataPriceUSD);
                if (content) {
                    customTooltip.textContent = content;
                    customTooltip.classList.remove('hidden');
                }
            });
            
            detailView.addEventListener('mousemove', (e) => {
                if (!customTooltip.classList.contains('hidden')) {
                    customTooltip.style.left = `${e.pageX + 15}px`;
                    customTooltip.style.top = `${e.pageY + 15}px`;
                }
            });
            
            detailView.addEventListener('mouseout', (e) => {
                if (e.target.closest('[data-tooltip-value]')) {
                    customTooltip.classList.add('hidden');
                }
            });
        }
    },
    
    /**
     * Load initial delegators list
     */
    async loadInitialDelegators() {
        state.pagination.skip = 0;
        state.allDelegators = [];
        state.pagination.hasMore = true;
        
        await this.fetchDelegators(false);
    },
    
    /**
     * Load more delegators (pagination)
     */
    async loadMoreDelegators() {
        if (state.pagination.isLoading || !state.pagination.hasMore) return;
        await this.fetchDelegators(true);
    },
    
    /**
     * Fetch delegators from API
     */
    async fetchDelegators(isLoadMore) {
        state.pagination.isLoading = true;
        
        const loadingScreen = document.getElementById('delegators-loading');
        const loadMoreBtn = document.getElementById('delegators-load-more-btn');
        
        if (!isLoadMore && loadingScreen) {
            loadingScreen.classList.remove('hidden');
        }
        
        if (isLoadMore && loadMoreBtn) {
            loadMoreBtn.disabled = true;
            loadMoreBtn.textContent = 'Loading...';
        }
        
        try {
            const rawList = await fetchDelegatorsList(state.pagination.skip, state.pagination.limit);
            
            // Process and filter
            const processedDelegators = rawList.filter(delegator => {
                const isOperator = delegator.delegations.some(d => d.isSelfDelegation === true);
                delegator.isSelfDelegator = isOperator;
                
                const hasStake = parseFloat(delegator.totalValueDataWei) > 0;
                
                if (state.showSelfDelegation) {
                    return hasStake;
                }
                return !isOperator && hasStake;
            });
            
            // Cache operator info
            processedDelegators.forEach(d => {
                d.delegations.forEach(del => {
                    const opId = del.operator.id.toLowerCase();
                    state.operatorAddresses.add(opId);
                    const meta = parseOperatorMetadata(del.operator.metadataJsonString);
                    state.operatorNames[opId] = meta.name || shortAddress(opId);
                    const img = getOperatorImage(meta);
                    if (img) state.operatorImages[opId] = img;
                });
            });
            
            if (isLoadMore) {
                state.allDelegators = [...state.allDelegators, ...processedDelegators];
            } else {
                state.allDelegators = processedDelegators;
            }
            
            // Update pagination
            if (rawList.length < state.pagination.limit) {
                state.pagination.hasMore = false;
            } else {
                state.pagination.skip += state.pagination.limit;
            }
            
            if (!state.searchMode) {
                state.filteredDelegators = state.allDelegators;
                renderLeaderboard();
            }
            
        } catch (err) {
            console.error("Failed to fetch delegators:", err);
            showToast({
                type: 'error',
                title: 'Failed to load delegators',
                message: err.message,
                duration: 5000
            });
        } finally {
            state.pagination.isLoading = false;
            
            if (loadingScreen) loadingScreen.classList.add('hidden');
            if (loadMoreBtn) {
                loadMoreBtn.disabled = false;
                loadMoreBtn.textContent = 'Load More';
            }
        }
    },
    
    /**
     * Search for a specific delegator by address
     */
    async searchDelegator(address) {
        const emptyState = document.getElementById('delegators-empty-state');
        
        if (emptyState) {
            emptyState.innerHTML = `
                <div class="flex justify-center mb-4">
                    <div class="loader rounded-full border-4 border-[#555] border-t-transparent h-8 w-8 animate-spin"></div>
                </div>
                <p class="text-gray-500">Searching network...</p>
            `;
            emptyState.classList.remove('hidden');
        }
        
        try {
            const delegator = await fetchDelegatorById(address);
            
            if (delegator) {
                const isOperator = delegator.delegations.some(del => del.isSelfDelegation === true);
                delegator.isSelfDelegator = isOperator;
                
                // Cache operator info
                delegator.delegations.forEach(del => {
                    const opId = del.operator.id.toLowerCase();
                    state.operatorAddresses.add(opId);
                    const meta = parseOperatorMetadata(del.operator.metadataJsonString);
                    state.operatorNames[opId] = meta.name || shortAddress(opId);
                    const img = getOperatorImage(meta);
                    if (img) state.operatorImages[opId] = img;
                });
                
                state.filteredDelegators = [delegator];
                renderLeaderboard();
            } else {
                if (emptyState) {
                    emptyState.innerHTML = `
                        <svg class="w-12 h-12 text-gray-600 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
                        </svg>
                        <p class="text-gray-400 font-medium">Address found but has no delegation data.</p>
                    `;
                }
            }
        } catch (err) {
            console.error("Search failed:", err);
        }
    },
    
    /**
     * Select a delegator and show detail view
     */
    async selectDelegator(delegator) {
        state.selectedDelegator = delegator;
        
        // Cache operator info from delegations BEFORE processing tx history
        delegator.delegations.forEach(del => {
            const opId = del.operator.id.toLowerCase();
            state.operatorAddresses.add(opId);
            const meta = parseOperatorMetadata(del.operator.metadataJsonString);
            state.operatorNames[opId] = meta.name || shortAddress(opId);
            const img = getOperatorImage(meta);
            if (img) state.operatorImages[opId] = img;
        });
        
        // Show detail view
        this.showDetailView();
        
        // Render header
        renderDetailHeader(delegator);
        
        // Fetch data in parallel
        try {
            const [txHistory, earningsHistory] = await Promise.all([
                fetchPolygonscanTxHistory(delegator.id),
                fetchDelegatorEarningsHistory(delegator.id)
            ]);
            
            state.txHistory = txHistory;
            state.earningsHistory = earningsHistory;
            
            // Fetch metadata for operators in tx history that we don't have yet
            const historicOperatorIds = [...new Set(
                txHistory
                    .filter(tx => tx.isRelevantFlow && tx.operatorId)
                    .map(tx => tx.operatorId.toLowerCase())
            )];
            
            // Fetch missing operator metadata (for images)
            await fetchOperatorsMetadata(historicOperatorIds);
            
            // Render history table
            renderHistoryTable(txHistory);
            
            // Render delegations tables (modal and inline)
            renderDelegationsTable(delegator.delegations);
            renderInlineDelegationsTable(delegator.delegations);
            
            // Render charts
            renderAllCharts();
            
        } catch (err) {
            console.error("Failed to load delegator details:", err);
            showToast({
                type: 'error',
                title: 'Failed to load details',
                message: err.message,
                duration: 5000
            });
        }
    },
    
    /**
     * Toggle self-delegation filter
     */
    toggleSelfDelegation() {
        const checkbox = document.getElementById('delegators-show-self-delegation');
        state.showSelfDelegation = checkbox?.checked || false;
        this.loadInitialDelegators();
    },
    
    /**
     * Set chart timeframe
     */
    setTimeframe(days) {
        state.timeframe = days;
        
        // Update button styles
        document.querySelectorAll('[data-delegator-timeframe]').forEach(btn => {
            const btnDays = btn.dataset.delegatorTimeframe;
            if (btnDays === days) {
                btn.className = "px-3 py-1 text-xs font-bold rounded-md bg-blue-600 text-white transition shadow-sm";
            } else {
                btn.className = "px-3 py-1 text-xs font-bold rounded-md hover:bg-[#444444] text-gray-300 transition";
            }
        });
        
        renderAllCharts();
    },
    
    /**
     * Show leaderboard view
     */
    showLeaderboardView() {
        const listView = document.getElementById('delegators-list-view');
        const detailView = document.getElementById('delegator-detail-view');
        
        if (listView) listView.classList.remove('hidden');
        if (detailView) detailView.classList.add('hidden');
        
        state.selectedDelegator = null;
    },
    
    /**
     * Show detail view
     */
    showDetailView() {
        const listView = document.getElementById('delegators-list-view');
        const detailView = document.getElementById('delegator-detail-view');
        
        if (listView) listView.classList.add('hidden');
        if (detailView) detailView.classList.remove('hidden');
    },
    
    /**
     * Open data modal
     */
    openDataModal(type) {
        const modal = document.getElementById('delegator-data-modal');
        const title = document.getElementById('delegator-modal-title');
        const historyContent = document.getElementById('delegator-modal-content-history');
        const delegationsContent = document.getElementById('delegator-modal-content-delegations');
        
        if (!modal) return;
        
        // Hide all content
        if (historyContent) historyContent.classList.add('hidden');
        if (delegationsContent) delegationsContent.classList.add('hidden');
        
        if (type === 'history') {
            if (title) title.textContent = 'Transaction History';
            if (historyContent) historyContent.classList.remove('hidden');
        } else if (type === 'delegations') {
            if (title) title.textContent = 'Current Delegations';
            if (delegationsContent) delegationsContent.classList.remove('hidden');
        }
        
        modal.classList.remove('hidden');
    },
    
    /**
     * Close data modal
     */
    closeDataModal() {
        const modal = document.getElementById('delegator-data-modal');
        if (modal) modal.classList.add('hidden');
    },
    
    /**
     * Activate the module (when navigating to delegators view)
     */
    activate() {
        state.isActive = true;
        if (!state.isInitialized) {
            this.init();
        } else {
            // Re-render if already initialized
            renderLeaderboard();
        }
    },
    
    /**
     * Deactivate the module (when navigating away)
     */
    deactivate() {
        state.isActive = false;
    },
    
    /**
     * Cleanup (destroy charts, etc.)
     */
    destroy() {
        Object.values(state.charts).forEach(chart => {
            if (chart) chart.destroy();
        });
        state.charts = { flow: null, earnings: null, map: null };
        state.isActive = false;
    },
    
    /**
     * Navigate to operator detail
     */
    navigateToOperator(operatorId) {
        // This will be called from the router
        if (typeof window.navigateToOperator === 'function') {
            window.navigateToOperator(operatorId);
        }
    },
    
    /**
     * Show delegator detail by ID (called from router)
     */
    async showDelegatorDetail(delegatorId) {
        if (!state.isInitialized) {
            await this.init();
        }
        
        state.isActive = true;
        
        try {
            // Fetch delegator data
            const delegator = await fetchDelegatorById(delegatorId);
            
            if (delegator) {
                // Cache operator info
                delegator.delegations.forEach(del => {
                    const opId = del.operator.id.toLowerCase();
                    state.operatorAddresses.add(opId);
                    const meta = parseOperatorMetadata(del.operator.metadataJsonString);
                    state.operatorNames[opId] = meta.name || shortAddress(opId);
                    const img = getOperatorImage(meta);
                    if (img) state.operatorImages[opId] = img;
                });
                
                await this.selectDelegator(delegator);
            } else {
                showToast({
                    type: 'error',
                    title: 'Delegator not found',
                    message: `No data found for address ${shortAddress(delegatorId)}`,
                    duration: 5000
                });
                
                // Navigate back to list
                if (window.router) {
                    window.router.navigate('/delegators');
                }
            }
        } catch (err) {
            console.error('Failed to load delegator:', err);
            showToast({
                type: 'error',
                title: 'Failed to load delegator',
                message: err.message,
                duration: 5000
            });
            
            if (window.router) {
                window.router.navigate('/delegators');
            }
        }
    }
};

export default DelegatorsLogic;
