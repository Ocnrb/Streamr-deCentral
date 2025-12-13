/**
 * Operator Feature Module
 * Handles the operators list and operator detail views
 */

import * as Constants from '../core/constants.js';
import * as Utils from '../core/utils.js';
import * as UI from '../ui/ui.js';
import * as Services from '../core/services.js';

const { logger } = Utils;

// ============================================
// State Management
// ============================================

const state = {
    // Current operator context
    currentOperatorId: null,
    currentOperatorData: null,
    currentDelegations: [],
    totalDelegatorCount: 0,
    
    // History and chart data
    sponsorshipHistory: [],
    operatorDailyBuckets: [],
    chartTimeFrame: 90,
    chartType: 'stake', // 'stake' or 'earnings'
    
    // List state
    loadedOperatorCount: 0,
    searchQuery: '',
    
    // Intervals
    detailsRefreshInterval: null,
    
    // UI state
    activeSponsorshipMenu: null,
    uiState: {
        isStatsPanelExpanded: false,
        isDelegatorViewActive: true,
        isSponsorshipsListViewActive: true,
        isChartUsdView: false,
    },
    
    // Node status
    activeNodes: new Set(),
    unreachableNodes: new Set(),
    
    // Shared state references (set from main.js)
    signer: null,
    myRealAddress: '',
    dataPriceUSD: null,
    historicalDataPriceMap: null,
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

/**
 * Process sponsorship history from GraphQL and Polygonscan data
 */
function processSponsorshipHistory(gqlData, polygonscanTxs) {
    const combinedEvents = new Map();

    (gqlData.stakingEvents || []).forEach(e => {
        const timestamp = Number(e.date); 
        if (!combinedEvents.has(timestamp)) {
            combinedEvents.set(timestamp, { timestamp, events: [] });
        }
        combinedEvents.get(timestamp).events.push({
            timestamp: timestamp,
            type: 'graph',
            amount: parseFloat(Utils.convertWeiToData(e.amount)),
            token: 'DATA',
            methodId: 'Staking Event',
            txHash: null,
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

    const unifiedHistory = Array.from(combinedEvents.values());
    unifiedHistory.sort((a, b) => b.timestamp - a.timestamp); 
    
    state.sponsorshipHistory = unifiedHistory;
}

/**
 * Get historical price for a given date (unix timestamp in seconds)
 */
function getHistoricalPrice(dateTimestamp) {
    if (!state.historicalDataPriceMap) return state.dataPriceUSD || 0;
    
    let price = state.historicalDataPriceMap.get(dateTimestamp);
    
    if (!price) {
        for (let i = 1; i <= 7; i++) {
            const priorDate = dateTimestamp - (i * 86400);
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
 * Render Stake chart (original behavior)
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
        const freeFundsWei = await tokenContract.balanceOf(state.currentOperatorId);
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
    if (sessionStorage.getItem('authMethod') !== 'privateKey') {
        if (!await Services.checkAndSwitchNetwork()) return;
    }

    UI.populateOperatorSettingsModal(state.currentOperatorData);
    UI.setModalState('operator-settings-modal', 'input');

    const originalConfirmBtn = document.getElementById('operator-settings-modal-confirm');
    const confirmBtn = originalConfirmBtn.cloneNode(true);
    originalConfirmBtn.parentNode.replaceChild(confirmBtn, originalConfirmBtn);

    const enableConfirm = () => { confirmBtn.disabled = false; };
    UI.operatorSettingsModalNameInput.addEventListener('input', enableConfirm, { once: true });
    UI.operatorSettingsModalDescriptionInput.addEventListener('input', enableConfirm, { once: true });
    UI.operatorSettingsModalCutInput.addEventListener('input', enableConfirm, { once: true });
    UI.operatorSettingsModalRedundancyInput.addEventListener('input', enableConfirm, { once: true });

    confirmBtn.addEventListener('click', async () => {
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent btn-spinner"></div> Processing...`;
        UI.setModalState('operator-settings-modal', 'loading', { text: "Checking for changes...", subtext: "Please wait." });

        const oldMetadata = Utils.parseOperatorMetadata(state.currentOperatorData.metadataJsonString);
        let oldRedundancy = '1';
        try {
            if (state.currentOperatorData.metadataJsonString) {
                 const meta = JSON.parse(state.currentOperatorData.metadataJsonString);
                 if (meta && meta.redundancyFactor !== undefined) oldRedundancy = String(meta.redundancyFactor);
            }
        } catch(e) {}
        const oldCut = (BigInt(state.currentOperatorData.operatorsCutFraction) * 100n) / BigInt('1000000000000000000');

        const newName = UI.operatorSettingsModalNameInput.value;
        const newDescription = UI.operatorSettingsModalDescriptionInput.value;
        const newRedundancy = UI.operatorSettingsModalRedundancyInput.value;
        const newCut = UI.operatorSettingsModalCutInput.value;

        const metadataChanged = newName !== (oldMetadata.name || '') ||
                                newDescription !== (oldMetadata.description || '') ||
                                newRedundancy !== oldRedundancy;
        
        const cutChanged = newCut !== oldCut.toString();

        if (!metadataChanged && !cutChanged) {
            UI.setModalState('operator-settings-modal', 'input');
            UI.showToast({ type: 'info', title: 'No Changes', message: 'You have not made any changes.' });
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Confirm Changes';
            return;
        }

        let txHash1 = null;
        let txHash2 = null;

        try {
            if (metadataChanged) {
                UI.setModalState('operator-settings-modal', 'loading', { text: "Updating Metadata...", subtext: "Please confirm in your wallet." });
                const newMetadata = {
                    name: newName,
                    description: newDescription,
                    imageIpfsCid: oldMetadata.imageUrl ? oldMetadata.imageUrl.split('/').pop() : null,
                    redundancyFactor: parseInt(newRedundancy, 10)
                };
                txHash1 = await Services.updateOperatorMetadata(state.signer, state.currentOperatorId, JSON.stringify(newMetadata));
                if (!txHash1) {
                    confirmBtn.disabled = false;
                    confirmBtn.textContent = 'Confirm Changes';
                    return;
                }
            }

            if (cutChanged) {
                UI.setModalState('operator-settings-modal', 'loading', { text: "Updating Owner's Cut...", subtext: "Please confirm in your wallet." });
                txHash2 = await Services.updateOperatorCut(state.signer, state.currentOperatorId, newCut);
                if (!txHash2) {
                     confirmBtn.disabled = false;
                     confirmBtn.textContent = 'Confirm Changes';
                     return;
                }
            }

            UI.setModalState('operator-settings-modal', 'success', {
                txHash: txHash1,
                tx1Text: txHash1 ? "Metadata Update Successful!" : "",
                txHash2: txHash2,
                tx2Text: txHash2 ? "Owner's Cut Update Successful!" : ""
            });
            
            const lastTxHash = txHash2 || txHash1;
            if (lastTxHash) {
                await OperatorLogic.refreshWithRetry(lastTxHash);
            } else {
                await OperatorLogic.refreshData(true);
            }

        } catch (e) {
            UI.setModalState('operator-settings-modal', 'error', { message: Utils.getFriendlyErrorMessage(e) });
        } finally {
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Confirm Changes';
        }
    });
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
                state.loadedOperatorCount += operators.length;
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
                    // Extract sponsorship addresses from current stakes AND historical staking events
                    // This ensures we can properly classify transactions with sponsorships no longer staked
                    const currentStakeSponsorships = (data.operator?.stakes || [])
                        .map(stake => stake.sponsorship?.id)
                        .filter(Boolean);
                    const historicalSponsorships = (data.stakingEvents || [])
                        .map(event => event.sponsorship?.id)
                        .filter(Boolean);
                    
                    // Use Set to deduplicate
                    const allSponsorshipAddresses = [...new Set([...currentStakeSponsorships, ...historicalSponsorships])];
                    
                    polygonscanTxs = await Services.fetchPolygonscanHistory(state.currentOperatorId, 500, allSponsorshipAddresses);
                } catch (error) {
                    logger.error("Failed to load Polygonscan history:", error);
                }
                
                processSponsorshipHistory(data, polygonscanTxs);
                
                UI.renderOperatorDetails(data, state);
                
                // Notify main.js to update bot status UI
                if (typeof window.updateBotStatusUI === 'function') {
                    window.updateBotStatusUI();
                }
                
                const addresses = [...(data.operator.controllers || []), ...(data.operator.nodes || [])];
                UI.renderBalances(addresses);
                updateMyStakeUI();
                setupOperatorStream();
                filterAndRenderChart();
                UI.renderSponsorshipsHistory(state.sponsorshipHistory);
                
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
            
            // Transaction buttons
            if (target.id === 'delegate-btn') handleDelegateClick();
            if (target.id === 'undelegate-btn') handleUndelegateClick();
            if (target.id === 'process-queue-btn') handleProcessQueueClick(target);
            if (target.id === 'collect-all-earnings-btn') handleCollectAllEarningsClick(target);
            if (target.id === 'load-more-delegators-btn') handleLoadMoreDelegators(target);
            if (target.id === 'edit-operator-settings-btn') handleEditOperatorSettingsClick();
            
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
                    UI.renderSponsorshipsHistory(state.sponsorshipHistory);
                }
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
