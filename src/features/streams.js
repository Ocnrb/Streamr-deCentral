/**
 * Streams Feature Module
 * The Streams pages: the Sponsorships and All Streams tables, and Stream / Sponsorship Details.
 * Their parts are in streams/ (state, data, list, detail, storage nodes, stake, on-chain history, charts, player).
 */

import * as UI from '../ui/ui.js';
import { logger } from '../core/utils.js';
import { CreateStream } from './createStream.js';
import { STREAMS_PER_PAGE, state, detailState } from './streams/state.js';
import { fetchSponsorships, fetchOperatorStakes, fetchAllStreams, fetchStreamDetails, ensureSponsorshipLoaded, fetchSponsorshipDailyData } from './streams/data.js';
import { renderSponsorshipsTable, renderAllStreamsTable, switchTab, updateTabCounters, handleLoadMoreSponsorships, handleLoadMoreAllStreams, handleZeroBalanceToggle, handleSortClick, updateSortHeaderUI, handleStreamSearch } from './streams/list.js';
import { renderStreamDetail, stopRemainingBalanceTicker } from './streams/detail.js';
import { resetStakeModal } from './streams/stake.js';
import { renderSponsorshipCharts, resetChartListeners } from './streams/charts.js';
import { stopStreamPlayer, clearStreamPlayerLog, resetPlayerListeners } from './streams/player.js';

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
        
        // Create Stream button is only enabled with a connected wallet
        CreateStream.updateButtonState();
        
        // Reset UI to default tab (/streams?tab=sponsorships opens on the sponsorships)
        switchTab(new URLSearchParams(window.location.search).get('tab') === 'sponsorships' ? 'sponsorships' : 'nonsponsored');
        
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
        CreateStream.setup();
        
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
        resetChartListeners();
        resetPlayerListeners();
        
        // Hide operator stake button
        const stakeActionContainer = document.getElementById('stream-operator-stake-action');
        if (stakeActionContainer) stakeActionContainer.classList.add('hidden');
        
        // Hide stake modal if open
        const stakeModal = document.getElementById('stakeModal');
        if (stakeModal) stakeModal.classList.add('hidden');
        
        // Clear stake modal state
        resetStakeModal();
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
            if (isSponsored && sponsorshipId) {
                await ensureSponsorshipLoaded(stream, sponsorshipId).catch(e => logger.warn('Could not load the sponsorship:', e));
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
