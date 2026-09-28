/**
 * Operator Feature Module
 * Handles the operators list and operator detail views
 */

import * as Constants from '../core/constants.js';
import * as Utils from '../core/utils.js';
import * as UI from '../ui/ui.js';
import { OperatorForm } from './operatorForm.js';
import * as Services from '../core/services.js';

const { logger } = Utils;

// ============================================
// State Management
// ============================================

const state = {
    currentOperatorId: null,
    currentOperatorData: null,
    currentDelegations: [],
    totalDelegatorCount: 0,
    
    sponsorshipHistory: [],
    operatorDailyBuckets: [],
    chartTimeFrame: 90,
    chartType: 'stake',
    
    loadedOperatorCount: 0,
    searchQuery: '',
    
    detailsRefreshInterval: null,
    
    activeSponsorshipMenu: null,
    uiState: {
        isStatsPanelExpanded: false,
        isDelegatorViewActive: true,
        isSponsorshipsListViewActive: true,
        isChartUsdView: false,
    },
    
    activeNodes: new Set(),
    unreachableNodes: new Set(),
    
    signer: null,
    myRealAddress: '',
    dataPriceUSD: null,
    historicalDataPriceMap: null,
    
    historyState: {
        isFullLoaded: false,
        graphEvents: [],
        graphSkip: 0,
        hasMoreGraph: true,
        etherscanTxs: [],
        etherscanPage: 1,
        hasMoreEtherscan: true,
        etherscanCutoffDate: null,
        allSponsorshipAddresses: [],
    },
    
    // Sponsorship earnings state for real-time ticker
    sponsorshipEarnings: new Map(), // Map<sponsorshipId, {earningsWei, changePerSecond, lastUpdated}>
    earningsTickerInterval: null,
};

// Debounced search function
const debouncedSearch = Utils.debounce((query) => {
    const trimmedQuery = query.trim();
    if (state.searchQuery !== trimmedQuery) {
        state.searchQuery = trimmedQuery;
        state.loadedOperatorCount = 0;
        OperatorLogic.fetchAndRenderList(false, 0, state.searchQuery);
    }
}, 300);

// ============================================
// Data Fetching and Processing
// ============================================

const INITIAL_GRAPH_LIMIT = 1000;
const INITIAL_ETHERSCAN_OFFSET = 500;

/**
 * Stake change of each StakingEvent. The subgraph stores the operator's stake in the sponsorship
 * after the transaction (not the amount moved), also for earnings withdrawals (stake unchanged), and
 * no event when the stake goes to 0 (full unstake): compare with the previous event of the same
 * sponsorship, restarting from 0 after an Unstake seen on Polygonscan. The Polygonscan transfer of the
 * same transaction, when there is one (Stake to the sponsorship / Reduce Stake from it), is the exact
 * amount moved and takes priority; it also covers events whose previous one is not loaded
 * (operators with 1000+ events). Only Collect Earnings in the tx = earnings.
 * @returns {Map<string, {delta: number|null, kind: 'stake'|'reduce'|'earnings'|null}>} by event id
 */
function computeStakeChanges(graphEvents, polygonscanTxs) {
    const changes = new Map();
    const unstakes = (polygonscanTxs || [])
        .filter(tx => ['Unstake', 'Force Unstake'].includes(tx.methodId) && tx.from)
        .map(tx => ({ sponsorship: tx.from.toLowerCase(), timestamp: Number(tx.timestamp) }));
    // Polygonscan transfers by transaction (lowercase hash)
    const scanByTx = new Map();
    for (const tx of polygonscanTxs || []) {
        const hash = tx.txHash?.toLowerCase();
        if (!hash) continue;
        if (!scanByTx.has(hash)) scanByTx.set(hash, []);
        scanByTx.get(hash).push(tx);
    }
    // With decimals (convertWeiToData truncates): the amounts are compared with the transfers' amounts
    const toData = (wei) => parseFloat(ethers.utils.formatEther(wei.toString()));
    const fromScan = (e, sponsorshipId) => {
        const hash = typeof e.id === 'string' ? e.id.split('-').pop().toLowerCase() : '';
        const txs = scanByTx.get(hash) || [];
        const staked = txs.find(t => t.methodId === 'Stake' && t.to?.toLowerCase() === sponsorshipId && t.token === 'DATA');
        if (staked) return { delta: toData(BigInt(staked.rawValue || '0')), kind: 'stake' };
        const reduced = txs.find(t => t.methodId === 'Reduce Stake' && t.from?.toLowerCase() === sponsorshipId && t.token === 'DATA');
        if (reduced) return { delta: -toData(BigInt(reduced.rawValue || '0')), kind: 'reduce' };
        if (txs.some(t => t.methodId === 'Collect Earnings')) return { delta: 0, kind: 'earnings' };
        return null;
    };
    const bySponsorship = new Map();
    for (const e of graphEvents || []) {
        const id = e.sponsorship?.id?.toLowerCase();
        if (!id) continue;
        if (!bySponsorship.has(id)) bySponsorship.set(id, []);
        bySponsorship.get(id).push(e);
    }
    for (const [sponsorshipId, events] of bySponsorship) {
        events.sort((a, b) => Number(a.date) - Number(b.date));
        events.forEach((e, i) => {
            const scan = fromScan(e, sponsorshipId);
            if (scan && scan.kind !== 'earnings') {
                changes.set(e.id, scan);
                return;
            }
            const amount = BigInt(e.amount || '0');
            const prev = events[i - 1];
            let previous = prev ? BigInt(prev.amount || '0') : null;
            // Left the sponsorship in between (no event at 0): the stake started again from 0
            if (prev && unstakes.some(u => u.sponsorship === sponsorshipId && u.timestamp > Number(prev.date) && u.timestamp < Number(e.date))) {
                previous = 0n;
            }
            // Oldest loaded event while older ones exist: the same transaction on Polygonscan, else
            // unknown change (keep the plain row)
            if (previous === null && state.historyState.hasMoreGraph) {
                changes.set(e.id, scan || { delta: null, kind: null });
                return;
            }
            const delta = amount - (previous ?? 0n);
            const kind = delta > 0n ? 'stake' : (delta < 0n ? 'reduce' : 'earnings');
            changes.set(e.id, { delta: toData(delta), kind });
        });
    }
    return changes;
}

/**
 * Transfers with a sponsorship on the other side can't be delegations: the shared Polygonscan
 * classification only knows the sponsorships of the first load, so after "Load All History" older
 * ones showed as Delegate (IN) / Undelegate (OUT). Sponsorships known from The Graph fix them.
 */
function relabelSponsorshipTransfers(graphEvents, polygonscanTxs) {
    const sponsorships = new Set([
        ...(state.historyState.allSponsorshipAddresses || []),
        ...(graphEvents || []).map(e => e.sponsorship?.id)
    ].filter(Boolean).map(a => a.toLowerCase()));
    for (const tx of polygonscanTxs || []) {
        if (tx.token !== 'DATA') continue;
        if (tx.direction === 'IN' && ['Delegate', 'Transfer'].includes(tx.methodId) && sponsorships.has(tx.from?.toLowerCase())) {
            tx.methodId = 'Reduce Stake';
        } else if (tx.direction === 'OUT' && ['Undelegate', 'Transfer'].includes(tx.methodId) && sponsorships.has(tx.to?.toLowerCase())) {
            tx.methodId = 'Stake';
        }
    }
}

function processSponsorshipHistory(graphEvents, polygonscanTxs, limitToEtherscan = true) {
    const combinedEvents = new Map();
    relabelSponsorshipTransfers(state.historyState.graphEvents?.length ? state.historyState.graphEvents : graphEvents, polygonscanTxs);
    const stakeChanges = computeStakeChanges(graphEvents, polygonscanTxs);
    
    let cutoffDate = null;
    if (limitToEtherscan && polygonscanTxs && polygonscanTxs.length > 0) {
        const timestamps = polygonscanTxs.map(tx => Number(tx.timestamp));
        cutoffDate = Math.min(...timestamps);
        state.historyState.etherscanCutoffDate = cutoffDate;
    }

    const filteredGraphEvents = limitToEtherscan && cutoffDate
        ? graphEvents.filter(e => Number(e.date) >= cutoffDate)
        : graphEvents;

    filteredGraphEvents.forEach(e => {
        const timestamp = Number(e.date); 
        if (!combinedEvents.has(timestamp)) {
            combinedEvents.set(timestamp, { timestamp, events: [] });
        }
        const change = stakeChanges.get(e.id) || { delta: null, kind: null };
        combinedEvents.get(timestamp).events.push({
            timestamp: timestamp,
            type: 'graph',
            amount: parseFloat(Utils.convertWeiToData(e.amount)),
            stakeDelta: change.delta,
            stakeChange: change.kind,
            token: 'DATA',
            methodId: 'Staking Event',
            // StakingEvent id is "<sponsorship>-<txHash>"
            txHash: typeof e.id === 'string' && e.id.includes('-') ? e.id.split('-').pop() : null,
            relatedObject: e.sponsorship
        });
    });

    (polygonscanTxs || []).forEach(tx => {
        const timestamp = Number(tx.timestamp); 
        if (!combinedEvents.has(timestamp)) {
            combinedEvents.set(timestamp, { timestamp, events: [] });
        }
        combinedEvents.get(timestamp).events.push({
            timestamp: timestamp,
            type: 'scan',
            amount: tx.amount,
            token: tx.token,
            methodId: tx.methodId,
            txHash: tx.txHash,
            relatedObject: tx.direction
        });
    });

    // Full exits: the subgraph writes no StakingEvent when the stake goes to 0, so the stake returned by
    // the sponsorship (Unstake / Force Unstake / Reduce Stake with no event in that tx) gets its row here,
    // within the period covered by the loaded StakingEvents
    const allGraphEvents = state.historyState.graphEvents?.length ? state.historyState.graphEvents : (graphEvents || []);
    const graphTxHashes = new Set(allGraphEvents
        .map(e => (typeof e.id === 'string' ? e.id.split('-').pop().toLowerCase() : null))
        .filter(Boolean));
    const coverageStart = state.historyState.hasMoreGraph && allGraphEvents.length
        ? Math.min(...allGraphEvents.map(e => Number(e.date)))
        : -Infinity;
    const streamOf = new Map();
    for (const e of allGraphEvents) {
        if (e.sponsorship?.id && e.sponsorship.stream?.id) streamOf.set(e.sponsorship.id.toLowerCase(), e.sponsorship.stream.id);
    }
    for (const stake of state.currentOperatorData?.stakes || []) {
        if (stake.sponsorship?.id && stake.sponsorship.stream?.id) streamOf.set(stake.sponsorship.id.toLowerCase(), stake.sponsorship.stream.id);
    }
    (polygonscanTxs || []).forEach(tx => {
        const timestamp = Number(tx.timestamp);
        const sponsorshipId = tx.from?.toLowerCase();
        if (!['Unstake', 'Force Unstake', 'Reduce Stake'].includes(tx.methodId) || tx.direction !== 'IN' || tx.token !== 'DATA') return;
        if (!sponsorshipId || !tx.txHash || graphTxHashes.has(tx.txHash.toLowerCase()) || timestamp < coverageStart) return;
        if (!combinedEvents.has(timestamp)) combinedEvents.set(timestamp, { timestamp, events: [] });
        const streamId = streamOf.get(sponsorshipId);
        combinedEvents.get(timestamp).events.push({
            timestamp,
            type: 'graph',
            synthetic: true,
            amount: 0,
            stakeDelta: -tx.amount,
            stakeChange: 'unstake',
            token: 'DATA',
            methodId: 'Staking Event',
            txHash: tx.txHash,
            relatedObject: { id: sponsorshipId, stream: streamId ? { id: streamId } : null }
        });
    });

    const unifiedHistory = Array.from(combinedEvents.values());
    unifiedHistory.sort((a, b) => b.timestamp - a.timestamp); 
    
    state.sponsorshipHistory = unifiedHistory;
}

function hasMoreHistoryToLoad() {
    return state.historyState.hasMoreGraph || 
           state.historyState.hasMoreEtherscan || 
           (state.historyState.etherscanCutoffDate && 
            state.historyState.graphEvents.some(e => Number(e.date) < state.historyState.etherscanCutoffDate));
}

async function loadFullHistory() {
    const btn = document.getElementById('load-all-history-btn');
    if (!btn) return;
    
    btn.disabled = true;
    btn.innerHTML = `
        <span class="flex items-center gap-2">
            <div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent animate-spin"></div>
            Loading...
        </span>`;
    
    try {
        const [allGraphEvents, allEtherscanTxs] = await Promise.all([
            state.historyState.hasMoreGraph 
                ? Services.fetchAllStakingEvents(
                    state.currentOperatorId, 
                    state.historyState.graphSkip,
                    state.historyState.graphEvents
                  )
                : Promise.resolve(state.historyState.graphEvents),
            
            state.historyState.hasMoreEtherscan
                ? Services.fetchAllPolygonscanHistory(
                    state.currentOperatorId,
                    state.historyState.allSponsorshipAddresses,
                    state.historyState.etherscanPage,
                    state.historyState.etherscanTxs
                  )
                : Promise.resolve(state.historyState.etherscanTxs)
        ]);
        
        state.historyState.graphEvents = allGraphEvents;
        state.historyState.etherscanTxs = allEtherscanTxs;
        state.historyState.isFullLoaded = true;
        state.historyState.hasMoreGraph = false;
        state.historyState.hasMoreEtherscan = false;
        
        processSponsorshipHistory(allGraphEvents, allEtherscanTxs, false);
        UI.renderSponsorshipsHistory(state.sponsorshipHistory, false, 'operators');
        
    } catch (error) {
        logger.error('Failed to load full history:', error);
        UI.showToast({ 
            type: 'error', 
            title: 'Error', 
            message: 'Failed to load complete history' 
        });
        
        btn.disabled = false;
        btn.innerHTML = `
            <span class="flex items-center gap-2">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path>
                </svg>
                Load All History
            </span>`;
    }
}

/**
 * Get historical price for a given date (unix timestamp in seconds)
 * Normalizes timestamp to midnight UTC to match price map keys
 */
function getHistoricalPrice(dateTimestamp) {
    if (!state.historicalDataPriceMap) return state.dataPriceUSD || 0;
    
    // Normalize to midnight UTC (same as price map keys)
    const normalizedTimestamp = Math.floor(dateTimestamp / 86400) * 86400;
    
    let price = state.historicalDataPriceMap.get(normalizedTimestamp);
    
    if (!price) {
        for (let i = 1; i <= 7; i++) {
            const priorDate = normalizedTimestamp - (i * 86400);
            price = state.historicalDataPriceMap.get(priorDate);
            if (price) break;
        }
    }
    
    return price || state.dataPriceUSD || 0;
}

/**
 * Format date label for charts
 */
function formatDateLabel(timestamp) {
    const date = new Date(timestamp * 1000);
    const month = date.toLocaleDateString(undefined, { month: 'short' });
    const day = date.getDate();
    const year = date.getFullYear().toString().substring(2);
    return `${month} ${day} '${year}`;
}

/**
 * Filter buckets by timeframe
 */
function filterBucketsByTimeframe(buckets) {
    if (state.chartTimeFrame === 'all') return buckets;
    
    const now = new Date();
    return buckets.filter(bucket => {
        const bucketDateObj = new Date(bucket.date * 1000);
        const daysAgo = (now - bucketDateObj) / (1000 * 60 * 60 * 24);
        return daysAgo <= state.chartTimeFrame;
    });
}

/**
 * Filter and render the appropriate chart based on chartType
 */
function filterAndRenderChart() {
    switch (state.chartType) {
        case 'earnings':
            renderEarningsChart();
            break;
        case 'stake':
        default:
            renderStakeChart();
            break;
    }
    UI.updateChartTimeframeButtons(state.chartTimeFrame, state.uiState.isChartUsdView, state.chartType);
}

/**
 * Render Stake chart 
 */
function renderStakeChart() {
    let latestKnownPrice = state.dataPriceUSD || 0;
    const filteredBuckets = filterBucketsByTimeframe(state.operatorDailyBuckets);

    const chartData = filteredBuckets.map(bucket => {
        const dataAmount = parseFloat(Utils.convertWeiToData(bucket.valueWithoutEarnings));
        let value;
        
        if (state.uiState.isChartUsdView) {
            const priceToUse = getHistoricalPrice(bucket.date) || latestKnownPrice;
            if (priceToUse > 0) latestKnownPrice = priceToUse;
            value = dataAmount * priceToUse;
        } else {
            value = dataAmount;
        }

        return {
            label: formatDateLabel(bucket.date),
            value: value
        };
    });

    UI.renderStakeChart(chartData, state.uiState.isChartUsdView);
}

/**
 * Render Earnings chart (daily bars + cumulative line)
 * Daily earnings calculated from difference between consecutive cumulativeEarningsWei values
 * Always shows DATA values (USD toggle only applies to Stake chart)
 */
function renderEarningsChart() {
    const filteredBuckets = filterBucketsByTimeframe(state.operatorDailyBuckets);
    
    const labels = [];
    const dailyData = [];
    const cumulativeData = [];
    
    // We need to look at ALL buckets to calculate daily earnings correctly
    // even for filtered timeframe, because we need previous day's cumulative
    const allBuckets = state.operatorDailyBuckets;
    
    // Build a map of date -> cumulative for easy lookup
    const cumulativeMap = new Map();
    allBuckets.forEach(bucket => {
        cumulativeMap.set(bucket.date, parseFloat(Utils.convertWeiToData(bucket.cumulativeEarningsWei || '0')));
    });
    
    filteredBuckets.forEach((bucket, index) => {
        const cumulative = parseFloat(Utils.convertWeiToData(bucket.cumulativeEarningsWei || '0'));
        
        // Calculate daily earnings from difference with previous day
        let dailyEarnings = 0;
        const prevDayTimestamp = bucket.date - 86400; // Previous day (24h in seconds)
        const prevCumulative = cumulativeMap.get(String(prevDayTimestamp));
        
        if (prevCumulative !== undefined) {
            dailyEarnings = Math.max(0, cumulative - prevCumulative);
        } else {
            // If no previous day data, check the bucket before this one in the array
            const bucketIndex = allBuckets.findIndex(b => b.date === bucket.date);
            if (bucketIndex > 0) {
                const prevBucket = allBuckets[bucketIndex - 1];
                const prevCum = parseFloat(Utils.convertWeiToData(prevBucket.cumulativeEarningsWei || '0'));
                dailyEarnings = Math.max(0, cumulative - prevCum);
            }
        }
        
        labels.push(formatDateLabel(bucket.date));
        dailyData.push(dailyEarnings);
        cumulativeData.push(cumulative);
    });
    
    // Always pass false for isUsdView - Earnings chart only shows DATA
    UI.renderOperatorEarningsChart(labels, dailyData, cumulativeData, false, state.dataPriceUSD);
}

/**
 * Update the "My Stake" UI section
 */
async function updateMyStakeUI() {
    if (!state.myRealAddress) return;
    const myStakeSection = document.getElementById('my-stake-section');
    const myStakeValueEl = document.getElementById('my-stake-value');
    if (!myStakeSection || !myStakeValueEl) return;
    
    myStakeSection.classList.remove('hidden');
    myStakeValueEl.textContent = 'Loading...';

    const myStakeWei = await Services.fetchMyStake(state.currentOperatorId, state.myRealAddress, state.signer);
    const myStakeData = Utils.convertWeiToData(myStakeWei);
    myStakeValueEl.textContent = `${Utils.formatBigNumber(myStakeData)} DATA`;
    myStakeValueEl.setAttribute('data-tooltip-value', myStakeData);
}

/**
 * Setup Streamr coordination stream subscription
 */
function setupOperatorStream() {
    Services.setupStreamrSubscription(state.currentOperatorId, (message) => {
        UI.addStreamMessageToUI(message, state.activeNodes, state.unreachableNodes);
    });
}

// ============================================
// Earnings Ticker Functions
// ============================================

/**
 * Start the earnings ticker that updates displayed values every second
 */
function startEarningsTicker() {
    // Stop any existing ticker
    stopEarningsTicker();
    
    state.earningsTickerInterval = setInterval(() => {
        const now = Date.now();
        
        for (const [sponsorshipId, earningsData] of state.sponsorshipEarnings) {
            if (earningsData.changePerSecond <= BigInt(0)) continue;
            
            // Calculate elapsed time since last update
            const elapsedMs = now - earningsData.lastUpdated;
            const elapsedSeconds = elapsedMs / 1000;
            
            // Calculate new earnings value
            const increment = BigInt(Math.floor(Number(earningsData.changePerSecond) * elapsedSeconds));
            earningsData.earningsWei += increment;
            earningsData.lastUpdated = now;
            
            // Update the DOM element
            UI.updateSponsorshipEarningsDisplay(sponsorshipId, earningsData.earningsWei.toString(), state.dataPriceUSD);
        }
    }, 1000);
    
    logger.log('[Earnings] Ticker started');
}

/**
 * Stop the earnings ticker
 */
function stopEarningsTicker() {
    if (state.earningsTickerInterval) {
        clearInterval(state.earningsTickerInterval);
        state.earningsTickerInterval = null;
        logger.log('[Earnings] Ticker stopped');
    }
}

/**
 * Fetch and initialize sponsorship earnings data
 */
async function fetchAndUpdateEarnings() {
    if (!state.currentOperatorId || !state.currentOperatorData?.stakes) {
        return;
    }
    
    try {
        const earningsMap = await Services.fetchSponsorshipEarnings(
            state.currentOperatorId,
            state.currentOperatorData.stakes
        );
        
        // Update state with new earnings data
        state.sponsorshipEarnings = earningsMap;
        
        // Update all earnings displays
        for (const [sponsorshipId, earningsData] of earningsMap) {
            UI.updateSponsorshipEarningsDisplay(sponsorshipId, earningsData.earningsWei.toString(), state.dataPriceUSD);
        }
        
        // Start/restart the ticker
        startEarningsTicker();
        
    } catch (error) {
        logger.error('[Earnings] Failed to fetch earnings:', error);
    }
}

/**
 * Reset earnings for a specific sponsorship (called after collect)
 */
function resetSponsorshipEarnings(sponsorshipId) {
    const normalizedId = sponsorshipId.toLowerCase();
    const earningsData = state.sponsorshipEarnings.get(normalizedId);
    
    if (earningsData) {
        earningsData.earningsWei = BigInt(0);
        earningsData.lastUpdated = Date.now();
        UI.updateSponsorshipEarningsDisplay(normalizedId, '0', state.dataPriceUSD);
    }
}

/**
 * Reset earnings for all sponsorships (called after collect all)
 */
function resetAllSponsorshipEarnings() {
    for (const [sponsorshipId, earningsData] of state.sponsorshipEarnings) {
        earningsData.earningsWei = BigInt(0);
        earningsData.lastUpdated = Date.now();
        UI.updateSponsorshipEarningsDisplay(sponsorshipId, '0', state.dataPriceUSD);
    }
}

// ============================================
// Transaction Handlers
// ============================================

async function handleDelegateClick() {
    if (!state.signer) {
        UI.showToast({ type: 'warning', title: 'Wallet Required', message: 'Please connect a wallet to delegate.' });
        return;
    }
    if (sessionStorage.getItem('authMethod') !== 'privateKey') {
        if (!await Services.checkAndSwitchNetwork()) return;
    }

    let maxAmountWei = await Services.manageTransactionModal(true, 'delegate', state.signer, state.myRealAddress, state.currentOperatorId);

    const confirmBtn = document.getElementById('tx-modal-confirm');
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    
    // Reset button state
    newConfirmBtn.disabled = false;
    newConfirmBtn.textContent = 'Confirm';

    document.getElementById('tx-modal-max-btn').onclick = () => {
        if (maxAmountWei !== '0') {
            UI.txModalAmount.value = ethers.utils.formatEther(maxAmountWei);
        }
    };
    
    newConfirmBtn.addEventListener('click', async () => {
        newConfirmBtn.disabled = true;
        newConfirmBtn.innerHTML = `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent btn-spinner"></div> Processing...`;
        
        try {
            const txHash = await Services.confirmDelegation(state.signer, state.myRealAddress, state.currentOperatorId);
            if (txHash) {
                await OperatorLogic.refreshWithRetry(txHash);
            }
        } finally {
            // Always reset button state
            newConfirmBtn.disabled = false;
            newConfirmBtn.textContent = 'Confirm';
        }
    });
}

async function handleUndelegateClick() {
    if (!state.signer) {
        UI.showToast({ type: 'warning', title: 'Wallet Required', message: 'Please connect a wallet to undelegate.' });
        return;
    }
    if (sessionStorage.getItem('authMethod') !== 'privateKey') {
        if (!await Services.checkAndSwitchNetwork()) return;
    }

    let maxAmountWei = await Services.manageTransactionModal(true, 'undelegate', state.signer, state.myRealAddress, state.currentOperatorId);
    
    const confirmBtn = document.getElementById('tx-modal-confirm');
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    
    // Reset button state
    newConfirmBtn.disabled = false;
    newConfirmBtn.textContent = 'Confirm';
    
    document.getElementById('tx-modal-max-btn').onclick = () => {
        if (maxAmountWei !== '0') {
            UI.txModalAmount.value = ethers.utils.formatEther(maxAmountWei);
        }
    };
    
    newConfirmBtn.addEventListener('click', async () => {
        newConfirmBtn.disabled = true;
        newConfirmBtn.innerHTML = `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent btn-spinner"></div> Processing...`;

        try {
            const txHash = await Services.confirmUndelegation(state.signer, state.myRealAddress, state.currentOperatorId);
            if (txHash) {
               await OperatorLogic.refreshWithRetry(txHash);
            }
        } finally {
            // Always reset button state
            newConfirmBtn.disabled = false;
            newConfirmBtn.textContent = 'Confirm';
        }
    });
}

async function handleProcessQueueClick(button) {
    if (!state.signer) {
        UI.showToast({ type: 'warning', title: 'Wallet Required', message: 'Please connect your wallet.' });
        return;
    }
    button.disabled = true;
    button.innerHTML = `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent btn-spinner"></div> Processing...`;
    
    const txHash = await Services.handleProcessQueue(state.signer, state.currentOperatorId);
    if (txHash) {
        await OperatorLogic.refreshWithRetry(txHash);
    } else {
        await OperatorLogic.refreshData(true);
    }

    button.disabled = false;
    button.innerHTML = 'Process Queue';
}

async function handleEditStakeClick(sponsorshipId, currentStakeWei) {
    if (!state.signer) {
        UI.showToast({ type: 'warning', title: 'Wallet Required', message: 'Please connect your wallet.' });
        return;
    }
    UI.setModalState('stake-modal', 'input');
    UI.stakeModal.classList.remove('hidden');

    const currentStakeData = Utils.convertWeiToData(currentStakeWei);
    UI.stakeModalCurrentStake.textContent = `${Utils.formatBigNumber(currentStakeData)} DATA`;
    UI.stakeModalAmount.value = parseFloat(currentStakeData);
    
    try {
        const tokenContract = new ethers.Contract(Constants.DATA_TOKEN_ADDRESS_POLYGON, Constants.DATA_TOKEN_ABI, state.signer.provider);
        const freeFundsWei = await Services.readWithFallback(() => tokenContract.balanceOf(state.currentOperatorId));
        UI.stakeModalFreeFunds.textContent = `${Utils.formatBigNumber(Utils.convertWeiToData(freeFundsWei))} DATA`;
        const maxStakeAmountWei = ethers.BigNumber.from(currentStakeWei).add(freeFundsWei).toString();
        
        document.getElementById('stake-modal-max-btn').onclick = () => {
            UI.stakeModalAmount.value = ethers.utils.formatEther(maxStakeAmountWei);
        };
    } catch(e) {
        console.error("Failed to get free funds:", e);
        UI.stakeModalFreeFunds.textContent = 'Error';
    }
    
    const confirmBtn = document.getElementById('stake-modal-confirm');
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

    newConfirmBtn.addEventListener('click', async () => {
        newConfirmBtn.disabled = true;
        newConfirmBtn.innerHTML = `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent btn-spinner"></div> Processing...`;

        const result = await Services.confirmStakeEdit(state.signer, state.currentOperatorId, sponsorshipId, currentStakeWei);
        if (result && result !== 'nochange') {
            await OperatorLogic.refreshWithRetry(result);
        }
        
        const currentBtn = document.getElementById('stake-modal-confirm');
        if (currentBtn) {
            currentBtn.disabled = false;
            currentBtn.textContent = 'Confirm';
        }
    });
}

async function handleCollectEarningsClick(button, sponsorshipId) {
    if (!state.signer) {
        UI.showToast({ type: 'warning', title: 'Wallet Required', message: 'Please connect your wallet.' });
        return;
    }
    button.classList.add('processing');
    const originalText = button.textContent;
    button.textContent = 'Processing...';

    const txHash = await Services.handleCollectEarnings(state.signer, state.currentOperatorId, sponsorshipId);
    if (txHash) {
        // Reset earnings display immediately
        resetSponsorshipEarnings(sponsorshipId);
        await OperatorLogic.refreshWithRetry(txHash);
    } else {
        await OperatorLogic.refreshData(true);
    }

    button.classList.remove('processing');
    button.textContent = originalText;
}

async function handleCollectAllEarningsClick(button) {
    if (!state.signer) {
        UI.showToast({ type: 'warning', title: 'Wallet Required', message: 'Please connect your wallet.' });
        return;
    }
    button.disabled = true;
    button.innerHTML = `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent btn-spinner"></div>`;

    const txHash = await Services.handleCollectAllEarnings(state.signer, state.currentOperatorId, state.currentOperatorData);
    if (txHash) {
        // Reset all earnings displays immediately
        resetAllSponsorshipEarnings();
        await OperatorLogic.refreshWithRetry(txHash);
    } else {
        await OperatorLogic.refreshData(true);
    }

    button.disabled = false;
    button.textContent = 'Collect All';
}

async function handleEditOperatorSettingsClick() {
    if (!state.signer) {
        UI.showToast({ type: 'warning', title: 'Wallet Required', message: 'Please connect your wallet.' });
        return;
    }
    if (!state.currentOperatorData) return;
    const address = (await state.signer.getAddress().catch(() => '')).toLowerCase();
    if (!address || address !== state.currentOperatorData.owner?.toLowerCase()) {
        UI.showToast({ type: 'warning', title: 'Owner Only', message: 'Only the operator owner can edit its settings.' });
        return;
    }
    // Same modal as "Create Operator", in edit mode; refresh the page once the changes are indexed
    OperatorForm.openEdit(state.currentOperatorData, () => OperatorLogic.refreshData(true));
}

async function handleLoadMoreDelegators(button) {
    button.disabled = true;
    button.innerHTML = `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent btn-spinner"></div> Loading...`;
    try {
        const newDelegations = await Services.fetchMoreDelegators(state.currentOperatorId, state.currentDelegations.length);
        state.currentDelegations.push(...newDelegations);
        UI.updateDelegatorsSection(state.currentDelegations, state.totalDelegatorCount, state.currentOperatorData);
    } catch (error) {
        console.error("Failed to load more delegators:", error);
    } finally {
        button.disabled = false;
        button.textContent = 'Load More';
    }
}

// ============================================
// Public API (OperatorLogic)
// ============================================

export const OperatorLogic = {
    /**
     * Get current state (for external access)
     */
    getState() {
        return state;
    },
    
    /**
     * Set shared state from main.js
     */
    setSharedState(sharedState) {
        if (sharedState.signer !== undefined) state.signer = sharedState.signer;
        if (sharedState.myRealAddress !== undefined) state.myRealAddress = sharedState.myRealAddress;
        if (sharedState.dataPriceUSD !== undefined) state.dataPriceUSD = sharedState.dataPriceUSD;
        if (sharedState.historicalDataPriceMap !== undefined) state.historicalDataPriceMap = sharedState.historicalDataPriceMap;
    },
    
    /**
     * Fetch and render operators list
     */
    async fetchAndRenderList(isLoadMore = false, skip = 0, filterQuery = '') {
        UI.showLoader(!isLoadMore);
        try {
            const operators = await Services.fetchOperators(skip, filterQuery);

            if (isLoadMore) {
                UI.appendOperatorsList(operators);
            } else {
                UI.renderOperatorsList(operators, filterQuery);
            }

            if (!filterQuery || (filterQuery.toLowerCase().startsWith('0x'))) {
                if (isLoadMore) {
                    state.loadedOperatorCount += operators.length;
                } else {
                    state.loadedOperatorCount = operators.length;
                }
            }
            
            UI.loadMoreOperatorsBtn.style.display = (operators.length === Constants.OPERATORS_PER_PAGE && (!filterQuery || filterQuery.toLowerCase().startsWith('0x'))) ? 'inline-block' : 'none';

        } catch (error) {
            console.error("Failed to fetch operators:", error);
            UI.operatorsGrid.innerHTML = `<p class="text-red-400 col-span-full">${Utils.escapeHtml(error.message)}</p>`;
        } finally {
            UI.showLoader(false);
        }
    },
    
    /**
     * Fetch and render operator details
     */
    async fetchAndRenderDetails(operatorId) {
        UI.showLoader(true);
        if (state.detailsRefreshInterval) clearInterval(state.detailsRefreshInterval);

        state.currentOperatorId = operatorId.toLowerCase();
        
        state.activeNodes.clear();
        state.unreachableNodes.clear();
        state.chartTimeFrame = 90;
        state.chartType = 'stake';
        state.uiState.isChartUsdView = false;
        
        state.historyState = {
            isFullLoaded: false,
            graphEvents: [],
            graphSkip: 0,
            hasMoreGraph: true,
            etherscanTxs: [],
            etherscanPage: 1,
            hasMoreEtherscan: true,
            etherscanCutoffDate: null,
            allSponsorshipAddresses: [],
        };

        try {
            await this.refreshData(true); 
            state.detailsRefreshInterval = setInterval(() => this.refreshData(false), 30000);
        } catch (error) {
            UI.detailContent.innerHTML = `<p class="text-red-400">${Utils.escapeHtml(error.message)}</p>`;
        } finally {
            UI.showLoader(false);
        }
    },
    
    /**
     * Refresh operator data
     */
    async refreshData(isFirstLoad = false, expectedTxHash = null) {
        try {
            const data = await Services.fetchOperatorDetails(state.currentOperatorId);
            
            state.currentOperatorData = data.operator;
            state.currentDelegations = data.operator?.delegations || [];
            state.totalDelegatorCount = data.operator?.delegatorCount || 0;
            state.operatorDailyBuckets = data.operatorDailyBuckets || [];
            
            // Save operator ID for autostaker quick access - only if user is an agent
            if (state.myRealAddress && data.operator?.controllers) {
                const isAgent = data.operator.controllers.some(
                    agent => agent.toLowerCase() === state.myRealAddress.toLowerCase()
                );
                if (isAgent) {
                    localStorage.setItem('lastOperatorId', state.currentOperatorId);
                }
            }
            
            if (isFirstLoad) {
                let polygonscanTxs = [];
                try {
                    const currentStakeSponsorships = (data.operator?.stakes || [])
                        .map(stake => stake.sponsorship?.id)
                        .filter(Boolean);
                    const historicalSponsorships = (data.stakingEvents || [])
                        .map(event => event.sponsorship?.id)
                        .filter(Boolean);
                    
                    const allSponsorshipAddresses = [...new Set([...currentStakeSponsorships, ...historicalSponsorships])];
                    state.historyState.allSponsorshipAddresses = allSponsorshipAddresses;
                    
                    const result = await Services.fetchPolygonscanHistory(state.currentOperatorId, INITIAL_ETHERSCAN_OFFSET, allSponsorshipAddresses);
                    polygonscanTxs = result.transactions || result;
                    state.historyState.hasMoreEtherscan = result.hasMore || false;
                } catch (error) {
                    logger.error("Failed to load Polygonscan history:", error);
                }
                
                const graphEvents = data.stakingEvents || [];
                state.historyState.graphEvents = graphEvents;
                state.historyState.graphSkip = INITIAL_GRAPH_LIMIT;
                state.historyState.hasMoreGraph = graphEvents.length === INITIAL_GRAPH_LIMIT;
                
                state.historyState.etherscanTxs = polygonscanTxs;
                state.historyState.etherscanPage = 2;
                state.historyState.isFullLoaded = false;
                
                processSponsorshipHistory(graphEvents, polygonscanTxs, true);
                
                UI.renderOperatorDetails(data, state);
                
                if (typeof window.updateBotStatusUI === 'function') {
                    window.updateBotStatusUI();
                }
                
                const addresses = [...(data.operator.controllers || []), ...(data.operator.nodes || [])];
                UI.renderBalances(addresses);
                updateMyStakeUI();
                setupOperatorStream();
                filterAndRenderChart();
                
                // Fetch and start earnings ticker
                fetchAndUpdateEarnings();
                
                const showLoadAll = hasMoreHistoryToLoad();
                UI.renderSponsorshipsHistory(state.sponsorshipHistory, showLoadAll, 'operators');
                
                if (expectedTxHash) {
                    const txFound = polygonscanTxs.some(tx => 
                        tx.txHash && tx.txHash.toLowerCase() === expectedTxHash.toLowerCase()
                    );
                    return txFound;
                }
            } else {
                if (document.hidden) return;
                
                UI.updateOperatorDetails(data, state);
                const addresses = [...(data.operator.controllers || []), ...(data.operator.nodes || [])];
                UI.renderBalances(addresses);
                updateMyStakeUI();
                filterAndRenderChart();
                
                // Refresh earnings data (will restart ticker with fresh base values)
                fetchAndUpdateEarnings();
            }

        } catch (error) {
            logger.error("Failed to refresh operator data:", error);
            if (isFirstLoad) {
                UI.detailContent.innerHTML = `<p class="text-red-400">${Utils.escapeHtml(error.message)}</p>`;
            }
        }
        return false;
    },
    
    /**
     * Refresh with retry logic for Polygonscan history
     */
    async refreshWithRetry(txHash, maxAttempts = 5, delayMs = 4000) {
        logger.log(`Waiting for transaction ${txHash} to appear in Polygonscan...`);
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            logger.log(`Polygonscan refresh attempt ${attempt}/${maxAttempts}`);
            
            const txFound = await this.refreshData(true, txHash);
            
            if (txFound) {
                logger.log(`Transaction found on attempt ${attempt}`);
                return true;
            }
            
            if (attempt < maxAttempts) {
                logger.log(`Transaction not yet indexed, waiting ${delayMs}ms...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
        
        logger.warn(`Transaction ${txHash} not found after ${maxAttempts} attempts. It may appear later.`);
        UI.showToast({ 
            type: 'info', 
            title: 'History Update Pending', 
            message: 'Your transaction was successful but may take a moment to appear in history.',
            duration: 6000 
        });
        return false;
    },
    
    /**
     * Handle search input
     */
    handleSearch(query) {
        debouncedSearch(query);
    },
    
    /**
     * Handle load more operators
     */
    async handleLoadMore(button) {
        button.disabled = true;
        button.innerHTML = `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent btn-spinner"></div> Loading...`;
        try {
            await this.fetchAndRenderList(true, state.loadedOperatorCount, state.searchQuery);
        } catch (error) {
            console.error("Failed to load more operators:", error);
        } finally {
            button.disabled = false;
            button.innerHTML = 'Load More Operators';
        }
    },
    
    /**
     * Navigate to operator detail
     */
    navigateToDetail(operatorId) {
        if (window.router) {
            window.router.navigate(`/operator/${operatorId}`);
        }
    },
    
    /**
     * Stop module (cleanup intervals, streams)
     */
    stop() {
        if (state.detailsRefreshInterval) {
            clearInterval(state.detailsRefreshInterval);
            state.detailsRefreshInterval = null;
        }
        stopEarningsTicker();
        state.sponsorshipEarnings.clear();
        Services.unsubscribeFromCoordinationStream();
    },
    
    /**
     * Setup event listeners for operator views
     */
    setupEventListeners() {
        // Search input
        UI.searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));
        
        // Load more button
        document.getElementById('load-more-operators-btn').addEventListener('click', (e) => this.handleLoadMore(e.target));
        
        // Chart type pills (delegated event listener)
        document.body.addEventListener('click', (e) => {
            const chartTypeTab = e.target.closest('#chart-type-tabs button');
            if (chartTypeTab && chartTypeTab.dataset.chartType) {
                state.chartType = chartTypeTab.dataset.chartType;
                filterAndRenderChart();
            }
        });
        
        // Body click handlers for operator-specific actions
        document.body.addEventListener('click', (e) => {
            const target = e.target;
            
            // Operator card click
            const operatorCard = target.closest('.card, .operator-link');
            if (operatorCard && operatorCard.dataset.operatorId) {
                e.preventDefault();
                this.navigateToDetail(operatorCard.dataset.operatorId);
                return;
            }
            
            // Delegator link click - navigate to Delegator Details
            const delegatorLink = target.closest('.delegator-link');
            if (delegatorLink && delegatorLink.dataset.delegatorId) {
                e.preventDefault();
                window.router.navigate(`/delegator/${delegatorLink.dataset.delegatorId}`);
                return;
            }
            
            // Sponsorship link click - navigate to Sponsorship Details
            const sponsorshipLink = target.closest('.sponsorship-link');
            if (sponsorshipLink && sponsorshipLink.dataset.streamId) {
                e.preventDefault();
                const streamId = sponsorshipLink.dataset.streamId;
                const sponsorshipId = sponsorshipLink.dataset.sponsorshipId;
                window.router.navigate(`/stream/${encodeURIComponent(streamId)}?sponsored=true&sponsorshipId=${sponsorshipId}`);
                return;
            }
            
            // Transaction buttons
            if (target.id === 'delegate-btn') handleDelegateClick();
            if (target.id === 'undelegate-btn') handleUndelegateClick();
            if (target.id === 'process-queue-btn') handleProcessQueueClick(target);
            if (target.id === 'collect-all-earnings-btn') handleCollectAllEarningsClick(target);
            if (target.id === 'load-more-delegators-btn') handleLoadMoreDelegators(target);
            if (target.id === 'edit-operator-settings-btn') handleEditOperatorSettingsClick();
            
            // Save as Profile button (in header)
            const profileBtn = target.closest('#desktop-save-profile-btn, #mobile-save-profile-btn');
            if (profileBtn) {
                UI.handleProfileButtonClick(profileBtn);
                return;
            }
            
            // Stats panel toggle
            if (target.closest('#toggle-stats-btn')) UI.toggleStatsPanel(false, state.uiState);
            
            // Delegator Pills Tabs
            const delegatorTab = target.closest('#delegator-tabs button');
            if (delegatorTab) {
                const tab = delegatorTab.dataset.tab;
                const tabs = document.querySelectorAll('#delegator-tabs button');
                tabs.forEach(t => {
                    t.classList.remove('bg-blue-800', 'text-white');
                    t.classList.add('text-gray-400');
                });
                delegatorTab.classList.add('bg-blue-800', 'text-white');
                delegatorTab.classList.remove('text-gray-400');
                
                document.getElementById('delegators-content').classList.toggle('hidden', tab !== 'delegators');
                document.getElementById('queue-content').classList.toggle('hidden', tab !== 'queue');
                state.uiState.isDelegatorViewActive = (tab === 'delegators');
                if (tab === 'delegators') {
                    UI.updateDelegatorsSection(state.currentDelegations, state.totalDelegatorCount, state.currentOperatorData);
                }
            }
            
            // Sponsorship Pills Tabs
            const sponsorshipTab = target.closest('#sponsorship-tabs button');
            if (sponsorshipTab) {
                const tab = sponsorshipTab.dataset.tab;
                const tabs = document.querySelectorAll('#sponsorship-tabs button');
                tabs.forEach(t => {
                    t.classList.remove('bg-blue-800', 'text-white');
                    t.classList.add('text-gray-400');
                });
                sponsorshipTab.classList.add('bg-blue-800', 'text-white');
                sponsorshipTab.classList.remove('text-gray-400');
                
                document.getElementById('sponsorships-list-content').classList.toggle('hidden', tab !== 'list');
                document.getElementById('sponsorships-history-content').classList.toggle('hidden', tab !== 'history');
                state.uiState.isSponsorshipsListViewActive = (tab === 'list');
                if (tab === 'history') {
                    const showLoadAll = hasMoreHistoryToLoad() && !state.historyState.isFullLoaded;
                    UI.renderSponsorshipsHistory(state.sponsorshipHistory, showLoadAll, 'operators');
                }
            }
            
            // Load All History button
            if (target.closest('#load-all-history-btn')) {
                loadFullHistory();
                return;
            }
            
            // Wallets Pills Tabs
            const walletsTab = target.closest('#wallets-tabs button');
            if (walletsTab) {
                const tab = walletsTab.dataset.tab;
                const tabs = document.querySelectorAll('#wallets-tabs button');
                tabs.forEach(t => {
                    t.classList.remove('bg-blue-800', 'text-white');
                    t.classList.add('text-gray-400');
                });
                walletsTab.classList.add('bg-blue-800', 'text-white');
                walletsTab.classList.remove('text-gray-400');
                
                document.getElementById('agents-content').classList.toggle('hidden', tab !== 'agents');
                document.getElementById('nodes-content').classList.toggle('hidden', tab !== 'nodes');
            }
            
            // Reputation Dropdown Toggle
            if (target.closest('#reputation-dropdown-btn')) {
                const menu = document.getElementById('reputation-dropdown-menu');
                menu.classList.toggle('hidden');
            }
            
            // Reputation Dropdown Options
            const reputationOption = target.closest('#reputation-dropdown-menu button');
            if (reputationOption) {
                const view = reputationOption.dataset.view;
                const wrapper = document.getElementById('reputation-content-wrapper');
                const { slashesCount, flagsAgainstCount, flagsByCount } = wrapper.dataset;
                
                const texts = {
                    'slashing': `Slashing Events (${slashesCount})`,
                    'flags-against': `Flags Against (${flagsAgainstCount})`,
                    'flags-by': `Flags Initiated (${flagsByCount})`
                };
                document.getElementById('reputation-dropdown-text').textContent = texts[view];
                
                document.querySelectorAll('#reputation-dropdown-menu button').forEach(btn => {
                    btn.classList.remove('bg-blue-800/30', 'text-white');
                    btn.classList.add('text-gray-300');
                });
                reputationOption.classList.add('bg-blue-800/30', 'text-white');
                reputationOption.classList.remove('text-gray-300');
                
                document.getElementById('slashing-content').classList.toggle('hidden', view !== 'slashing');
                document.getElementById('flags-against-content').classList.toggle('hidden', view !== 'flags-against');
                document.getElementById('flags-by-content').classList.toggle('hidden', view !== 'flags-by');
                
                document.getElementById('reputation-dropdown-menu').classList.add('hidden');
            }
            
            if (target.closest('.toggle-vote-list-btn')) UI.toggleVoteList(target.closest('.toggle-vote-list-btn').dataset.flagId);

            // Chart Timeframe
            const timeframeButton = target.closest('#chart-timeframe-buttons button');
            if (timeframeButton && timeframeButton.dataset.days) {
                const days = timeframeButton.dataset.days === 'all' ? 'all' : parseInt(timeframeButton.dataset.days, 10);
                state.chartTimeFrame = days;
                filterAndRenderChart();
                return;
            }

            // Chart View (DATA/USD)
            const chartViewButton = target.closest('#chart-view-buttons button');
            if (chartViewButton && chartViewButton.dataset.view) {
                state.uiState.isChartUsdView = (chartViewButton.dataset.view === 'usd');
                filterAndRenderChart();
                return;
            }

            // Sponsorship menu
            const menuBtn = target.closest('.toggle-sponsorship-menu-btn');
            if (menuBtn) {
                e.stopPropagation();
                const sponsorshipId = menuBtn.dataset.sponsorshipId;
                const menu = document.getElementById(`sponsorship-menu-${sponsorshipId}`);
                if (state.activeSponsorshipMenu && state.activeSponsorshipMenu !== menu) {
                    state.activeSponsorshipMenu.classList.add('hidden');
                }
                menu.classList.toggle('hidden');
                state.activeSponsorshipMenu = menu.classList.contains('hidden') ? null : menu;
            } else {
                if (state.activeSponsorshipMenu) {
                    state.activeSponsorshipMenu.classList.add('hidden');
                    state.activeSponsorshipMenu = null;
                }
            }
            
            const editStakeLink = target.closest('.edit-stake-link');
            if(editStakeLink) {
                e.preventDefault();
                handleEditStakeClick(editStakeLink.dataset.sponsorshipId, editStakeLink.dataset.currentStake);
            }
            
            const collectEarningsLink = target.closest('.collect-earnings-link');
            if(collectEarningsLink) {
                e.preventDefault();
                if (collectEarningsLink.classList.contains('processing')) return;
                handleCollectEarningsClick(collectEarningsLink, collectEarningsLink.dataset.sponsorshipId);
            }
        });
        
        // Tooltip handlers
        UI.mainContainer.addEventListener('mouseover', (e) => {
            const target = e.target.closest('[data-tooltip-value], [data-tooltip-content]');
            if (!target) return;
            
            let content;
            if (target.dataset.tooltipContent) {
                content = target.dataset.tooltipContent;
            } else if (target.dataset.tooltipType === 'owner-stake') {
                content = Utils.formatDataWithUsdTooltip(target.dataset.tooltipValue, state.dataPriceUSD);
            } else {
                content = Utils.formatUsdForTooltip(target.dataset.tooltipValue, state.dataPriceUSD);
            }
            
            if (content) {
                if (content.includes('<br>')) {
                    UI.customTooltip.innerHTML = content;
                } else {
                    UI.customTooltip.textContent = content;
                }
                UI.customTooltip.classList.remove('hidden');
            }
        });
        
        UI.mainContainer.addEventListener('mousemove', (e) => {
            if (!UI.customTooltip.classList.contains('hidden')) {
                UI.customTooltip.style.left = `${e.pageX + 15}px`;
                UI.customTooltip.style.top = `${e.pageY + 15}px`;
            }
        });
        
        UI.mainContainer.addEventListener('mouseout', (e) => {
            if (e.target.closest('[data-tooltip-value], [data-tooltip-content]')) {
                UI.customTooltip.classList.add('hidden');
            }
        });
    },
    
    /**
     * Reset list state for fresh load
     */
    resetListState() {
        state.loadedOperatorCount = 0;
        state.searchQuery = '';
    }
};

export default OperatorLogic;
