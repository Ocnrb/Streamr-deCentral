// Autostaker panel: its settings, the sponsorships it leaves out and the bot that runs every few minutes
import * as Constants from '../core/constants.js';
import * as Utils from '../core/utils.js';
import * as UI from '../ui/ui.js';
import * as Services from '../core/services.js';
import * as Autostaker from '../features/autostaker.js';
import { OperatorLogic } from '../features/operator.js';
import { state } from './state.js';

let autostakerState = {
    config: null,
    sponsorships: [],
    botIntervalId: null,
    isRunning: false,
    isCycleRunning: false, // Prevents concurrent cycles
    lastRunTime: null,
    nextRunTime: null,
    intervalMinutes: 5,
    logs: [],
    operatorId: null,  
    operatorSigner: null,
    cachedOperatorData: null  // Cached operator data for quick access
};

// Add log entry to the autostaker
function addAutostakerLog(type, message) {
    const entry = {
        time: new Date(),
        type, // 'info', 'success', 'error', 'action'
        message
    };
    autostakerState.logs.unshift(entry);
    
    // Keep only last 100 logs
    if (autostakerState.logs.length > 1000) {
        autostakerState.logs.pop();
    }
    
    // Update UI if log tab is visible
    renderAutostakerLogs();
}

function renderAutostakerLogs() {
    const logList = document.getElementById('autostaker-log-list');
    if (!logList) return;
    
    if (autostakerState.logs.length === 0) {
        logList.innerHTML = '<div class="text-center py-6 text-gray-500">No activity yet. Start the bot to see logs.</div>';
        return;
    }
    
    logList.innerHTML = autostakerState.logs.map(log => {
        const timeStr = log.time.toLocaleTimeString();
        let colorClass = 'text-gray-400';
        let icon = '•';
        
        switch (log.type) {
            case 'success':
                colorClass = 'text-green-400';
                icon = '✓';
                break;
            case 'error':
                colorClass = 'text-red-400';
                icon = '✗';
                break;
            case 'warning':
                colorClass = 'text-yellow-400';
                icon = '⚠';
                break;
            case 'action':
                colorClass = 'text-blue-400';
                icon = '→';
                break;
            case 'info':
            default:
                colorClass = 'text-gray-400';
                icon = '•';
        }
        
        return `
            <div class="flex gap-2 py-1 border-b border-[#333333]/50">
                <span class="text-gray-500 flex-shrink-0">${timeStr}</span>
                <span class="${colorClass}">${icon}</span>
                <span class="${colorClass}">${Utils.escapeHtml(String(log.message ?? ''))}</span>
            </div>
        `;
    }).join('');
}

function clearAutostakerLogs() {
    autostakerState.logs = [];
    renderAutostakerLogs();
}

export async function handleAutostakerClick() {
    // Check if wallet is connected
    if (!state.signer) {
        UI.showToast({ type: 'warning', title: 'Wallet Required', message: 'Please connect your wallet.' });
        return;
    }
    
    // Check if connected with private key (not MetaMask)
    const isPrivateKeyConnection = sessionStorage.getItem('authMethod') === 'privateKey';
    if (!isPrivateKeyConnection) {
        UI.showToast({ 
            type: 'warning', 
            title: 'Private Key Required', 
            message: 'Autostaker requires a private key connection, not MetaMask.' 
        });
        return;
    }
    
    // Get operator ID - prioritize: running bot > saved operator > current view
    let operatorId = autostakerState.operatorId || localStorage.getItem('lastOperatorId');
    
    if (!operatorId) {
        UI.showToast({ 
            type: 'info', 
            title: 'Select Operator', 
            message: 'Please open your operator page first to use the Autostaker.' 
        });
        return;
    }
    
    // If we already have the autostaker running for this operator, just show the panel
    if (autostakerState.operatorId === operatorId && autostakerState.cachedOperatorData) {
        autostakerState.config = Autostaker.loadAutostakerConfig(operatorId);
        UI.populateAutostakerSettings(autostakerState.config);
        const timeUntil = Autostaker.getTimeUntilNextCollect(autostakerState.config);
        UI.updateAutoCollectStatus(autostakerState.config, timeUntil);
        updateBotStatusUI();
        UI.showAutostakerModal();
        return;
    }
    
    // If we don't have operator data loaded for this operator, fetch it
    let controllers;
    try {
        UI.showLoader(true);
        const data = await Services.fetchOperatorDetails(operatorId);
        controllers = data.operator?.controllers || [];
        // Cache for autostaker use
        autostakerState.cachedOperatorData = data.operator;
    } catch (e) {
        UI.showLoader(false);
        UI.showToast({ 
            type: 'error', 
            title: 'Error', 
            message: 'Failed to load operator data.' 
        });
        return;
    } finally {
        UI.showLoader(false);
    }
    
    // Check if user is an agent for this operator
    const isAgent = state.myRealAddress && controllers.some(
        agent => agent.toLowerCase() === state.myRealAddress.toLowerCase()
    );
    
    if (!isAgent) {
        UI.showToast({ 
            type: 'warning', 
            title: 'Agent Required', 
            message: 'You must be an agent for this operator to use the Autostaker.' 
        });
        return;
    }

    // Store operator info for global operation
    autostakerState.operatorId = operatorId;
    autostakerState.operatorSigner = state.signer;
    
    // Load config and show modal
    autostakerState.config = Autostaker.loadAutostakerConfig(operatorId);
    UI.populateAutostakerSettings(autostakerState.config);
    
    // Update auto-collect status display
    const timeUntil = Autostaker.getTimeUntilNextCollect(autostakerState.config);
    UI.updateAutoCollectStatus(autostakerState.config, timeUntil);
    
    updateBotStatusUI();
    UI.showAutostakerModal();
}

async function loadAutostakerSponsorships() {
    const listEl = document.getElementById('autostaker-sponsorships-list');
    if (listEl) {
        listEl.innerHTML = '<div class="text-center py-6 text-gray-500 text-sm">Loading...</div>';
    }
    
    try {
        const opState = OperatorLogic.getState();
        const operatorId = autostakerState.operatorId || opState.currentOperatorId;
        autostakerState.sponsorships = await Autostaker.fetchAllSponsorshipsForDisplay(operatorId);
        UI.renderAutostakerSponsorships(autostakerState.sponsorships, handleToggleSponsorshipExclusion);
    } catch (e) {
        console.error('Failed to load sponsorships:', e);
        if (listEl) {
            listEl.innerHTML = '<div class="text-center py-6 text-red-400 text-sm">Failed to load sponsorships.</div>';
        }
    }
}

function handleToggleSponsorshipExclusion(sponsorshipId) {
    const opState = OperatorLogic.getState();
    const operatorId = autostakerState.operatorId || opState.currentOperatorId;
    const excluded = Autostaker.loadExcludedSponsorships(operatorId);
    const normalizedId = sponsorshipId.toLowerCase();
    
    if (excluded.has(normalizedId)) {
        excluded.delete(normalizedId);
    } else {
        excluded.add(normalizedId);
    }
    
    Autostaker.saveExcludedSponsorships(operatorId, excluded);
    
    // Update UI
    autostakerState.sponsorships = autostakerState.sponsorships.map(sp => ({
        ...sp,
        isExcluded: excluded.has(sp.id.toLowerCase())
    }));
    UI.renderAutostakerSponsorships(autostakerState.sponsorships, handleToggleSponsorshipExclusion);
}

function handleAutostakerSaveSettings() {
    const opState = OperatorLogic.getState();
    const operatorId = autostakerState.operatorId || opState.currentOperatorId;
    const config = UI.getAutostakerSettingsFromForm();
    
    // Preserve lastCollectTime from existing config
    const existingConfig = Autostaker.loadAutostakerConfig(operatorId);
    config.lastCollectTime = existingConfig.lastCollectTime;
    
    Autostaker.saveAutostakerConfig(operatorId, config);
    autostakerState.config = config;
    
    // Update auto-collect status display
    const timeUntil = Autostaker.getTimeUntilNextCollect(config);
    UI.updateAutoCollectStatus(config, timeUntil);
    
    UI.showToast({ type: 'success', title: 'Settings Saved', message: 'Autostaker settings have been saved.' });
}

export function updateBotStatusUI() {
    const statusText = document.getElementById('autostaker-status-text');
    const lastRunText = document.getElementById('autostaker-last-run');
    const nextRunText = document.getElementById('autostaker-next-run');
    const startBtn = document.getElementById('autostaker-start-bot');
    const panelStatus = document.getElementById('autostaker-panel-status');
    const globalIndicator = document.getElementById('autostaker-global-indicator');
    
    if (statusText) {
        if (autostakerState.isRunning) {
            statusText.innerHTML = `<span class="inline-block w-2 h-2 bg-green-500 rounded-full mr-1 animate-pulse"></span>Running`;
            statusText.className = 'text-sm font-medium text-green-400';
        } else {
            statusText.innerHTML = `<span class="inline-block w-2 h-2 bg-gray-500 rounded-full mr-1"></span>Stopped`;
            statusText.className = 'text-sm font-medium text-gray-400';
        }
    }
    
    if (panelStatus) {
        if (autostakerState.isRunning) {
            panelStatus.textContent = 'Running';
            panelStatus.className = 'ml-2 px-4 py-1.5 text-xs rounded-full bg-green-900/50 text-green-400 flex-shrink-0';
        } else {
            panelStatus.textContent = 'Stopped';
            panelStatus.className = 'ml-2 px-4 py-1.5 text-xs rounded-full bg-gray-700 text-gray-400 flex-shrink-0';
        }
    }
    
    // Global indicator in header
    if (globalIndicator) {
        if (autostakerState.isRunning) {
            globalIndicator.classList.remove('hidden');
        } else {
            globalIndicator.classList.add('hidden');
        }
    }
    
    if (lastRunText) {
        if (autostakerState.lastRunTime) {
            lastRunText.textContent = `Last: ${autostakerState.lastRunTime.toLocaleTimeString()}`;
        } else {
            lastRunText.textContent = 'Last: Never';
        }
    }
    
    if (nextRunText) {
        if (autostakerState.nextRunTime && autostakerState.isRunning) {
            nextRunText.textContent = `Next in: ${autostakerState.nextRunTime.toLocaleTimeString()}`;
        } else {
            nextRunText.textContent = 'Next in: -';
        }
    }
    
    if (startBtn) {
        if (autostakerState.isRunning) {
            startBtn.textContent = 'Stop Bot';
            startBtn.className = 'w-full px-3 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium';
        } else {
            startBtn.textContent = 'Start Bot';
            startBtn.className = 'w-full px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-medium';
        }
    }
}

async function runAutostakerBotCycle() {
    // Prevent concurrent cycles
    if (autostakerState.isCycleRunning) {
        console.log('[Autostaker] Cycle already running, skipping...');
        return;
    }
    
    const operatorId = autostakerState.operatorId;
    const signer = autostakerState.operatorSigner;
    
    if (!signer || !operatorId) {
        addAutostakerLog('error', 'No signer or operator configured');
        return;
    }
    
    // Mark cycle as running
    autostakerState.isCycleRunning = true;
    
    addAutostakerLog('info', 'Starting analysis cycle...');
    
    try {
        const config = Autostaker.loadAutostakerConfig(operatorId);
        const operatorContract = new ethers.Contract(operatorId, Constants.OPERATOR_CONTRACT_ABI, signer.provider);
        
        // === AUTO-COLLECT CHECK ===
        let ignoreFirstCollect = config.ignoreFirstCollect !== false;
        let isFirstCollect = !config.lastCollectTime;
        if (Autostaker.shouldAutoCollect(config)) {
            if (ignoreFirstCollect && isFirstCollect) {
                addAutostakerLog('info', '💰 Ignoring first auto-collect');
                config.lastCollectTime = new Date().toISOString();
                Autostaker.saveAutostakerConfig(operatorId, config);
                autostakerState.config = config;
                const timeUntil = Autostaker.getTimeUntilNextCollect(config);
                UI.updateAutoCollectStatus(config, timeUntil);
            } else {
                addAutostakerLog('info', '💰 Auto-collect triggered...');
                const collectResult = await Autostaker.executeAutoCollect(
                    operatorId, 
                    signer, 
                    addAutostakerLog
                );
                if (collectResult.success && !collectResult.skipped) {
                    config.lastCollectTime = new Date().toISOString();
                    Autostaker.saveAutostakerConfig(operatorId, config);
                    autostakerState.config = config;
                    // Update UI status
                    const timeUntil = Autostaker.getTimeUntilNextCollect(config);
                    UI.updateAutoCollectStatus(config, timeUntil);
                    UI.showToast({
                        type: 'success',
                        title: 'Auto-Collect',
                        message: `Collected earnings from ${collectResult.sponsorshipsCount} sponsorship(s).`,
                        duration: 5000
                    });
                }
            }
        } else if (config.autoCollectEnabled) {
            const timeUntil = Autostaker.getTimeUntilNextCollect(config);
            addAutostakerLog('info', `💰 Next auto-collect in ${timeUntil.formatted}`);
            UI.updateAutoCollectStatus(config, timeUntil);
        }
        
        
        // Analyze and calculate actions
        const analysisResult = await Autostaker.analyzeAndCalculateActions(
            operatorId,
            config,
            operatorContract
        );
        
        const actions = analysisResult.actions;
        
        autostakerState.lastRunTime = new Date();
        
        if (actions.length === 0) {
            if (analysisResult.skippedReason) {
                addAutostakerLog('warning', `⚠️ ${analysisResult.skippedReason}`);
            } else {
                addAutostakerLog('info', 'No actions needed - stakes are balanced');
            }
            updateBotStatusUI();
            return;
        }
        
        if (analysisResult.skippedStakes) {
            addAutostakerLog('warning', '⚠️ Some stake actions skipped due to pending undelegation queue');
        }
        
        // Check if this is a queue payment operation
        if (analysisResult.isQueuePayment) {
            const queueAmountData = Utils.formatBigNumber(Utils.convertWeiToData(analysisResult.queuePaymentAmount.toString()));
            addAutostakerLog('info', `💸 Undelegation queue detected: ${queueAmountData} DATA pending`);
            addAutostakerLog('info', '🔄 Auto-resolving queue by unstaking...');
        }
        
        // Log each action with DATA amount
        for (const action of actions) {
            const amountData = Utils.formatBigNumber(Utils.convertWeiToData(action.amount.toString()));
            const shortId = action.sponsorshipId.substring(0, 10) + '...';
            const prefix = action.isQueuePayment ? '💸 Queue payment: ' : '→ ';
            const icon = action.type === 'stake' ? '📈 Stake' : '📉 Unstake';
            addAutostakerLog('info', `${prefix}${icon} ${amountData} DATA (${shortId})`);
        }
        
        addAutostakerLog('info', `Executing ${actions.length} action(s)...`);
        
        // Execute actions with config for retry/recalculation support
        const result = await Autostaker.executeActions(
            actions,
            operatorId,
            signer,
            (progress) => {
                const action = progress.action;
                if (action) {
                    const amountData = Utils.formatBigNumber(Utils.convertWeiToData(action.amount.toString()));
                    
                    if (progress.isRecalculating) {
                        if (progress.isRateLimited) {
                            addAutostakerLog('warning', `⏳ RPC rate limited - switching RPC & retrying (${progress.retryAttempt}/5)...`);
                        } else {
                            addAutostakerLog('info', `🔄 Recalculating actions (${progress.retryAttempt}/5)...`);
                        }
                    } else if (progress.isRetry) {
                        addAutostakerLog('action', `[${progress.current}/${progress.total}] ↻ ${action.type}: ${amountData} DATA`);
                    } else {
                        addAutostakerLog('action', `[${progress.current}/${progress.total}] ${action.type}: ${amountData} DATA`);
                    }
                }
            },
            config // Pass config for retry/recalculation support
        );
        
        updateBotStatusUI();
        
        // Check if any actions had retries
        const actionsWithRetries = result.results.failed.filter(f => f.retriesAttempted > 0);
        const retryInfo = actionsWithRetries.length > 0 
            ? ` (${actionsWithRetries.length} recalculation attempts made)` 
            : '';
        
        // Check if any queue payout was successful
        const queuePayoutSuccess = result.results.successful.some(s => s.action.type === 'queuePayout');
        const queuePayoutMsg = queuePayoutSuccess ? ' (queue paid ✓)' : '';
        
        if (result.success) {
            addAutostakerLog('success', `✅ Completed ${result.results.successful.length} action(s) successfully${queuePayoutMsg}${retryInfo}`);
            UI.showToast({
                type: 'success',
                title: 'Autostaker',
                message: `Executed ${result.results.successful.length} action(s).${queuePayoutMsg}`,
                duration: 5000
            });
        } else if (result.results.successful.length > 0) {
            // Check if failures were due to rate limiting but state is likely correct
            const allFailuresAreRateLimit = result.results.failed.every(f => 
                f.error?.includes('rate limit') || 
                f.error?.includes('Too many requests') ||
                f.error?.includes('processing response error') ||
                f.error?.includes('could not detect network')
            );
            
            if (allFailuresAreRateLimit) {
                // Rate limit errors often mean the tx was submitted but we couldn't confirm
                // The next cycle will verify the actual state
                addAutostakerLog('warning', `⚠️ ${result.results.successful.length} confirmed, ${result.results.failed.length} unconfirmed (RPC issues)${queuePayoutMsg}`);
                addAutostakerLog('info', `   Next cycle will verify final state`);
            } else {
                addAutostakerLog('warning', `⚠️ ${result.results.successful.length} succeeded, ${result.results.failed.length} failed${queuePayoutMsg}${retryInfo}`);
                // Log details of failed actions
                for (const failed of result.results.failed) {
                    const shortId = failed.action.sponsorshipId?.substring(0, 10) + '...' || 'unknown';
                    const retryMsg = failed.retriesAttempted > 0 ? ` (${failed.retriesAttempted} retries)` : '';
                    // Make error message more readable
                    let errorMsg = failed.error || 'Unknown error';
                    if (errorMsg.includes('rate limit') || errorMsg.includes('Too many requests')) {
                        errorMsg = 'RPC rate limited';
                    } else if (errorMsg.includes('processing response error')) {
                        errorMsg = 'RPC connection error';
                    } else if (errorMsg.length > 50) {
                        errorMsg = errorMsg.substring(0, 50) + '...';
                    }
                    addAutostakerLog('error', `  ↳ ${failed.action.type} ${shortId}: ${errorMsg}${retryMsg}`);
                }
            }
            UI.showToast({
                type: 'warning',
                title: 'Autostaker',
                message: allFailuresAreRateLimit 
                    ? `${result.results.successful.length} confirmed, ${result.results.failed.length} pending verification.`
                    : `${result.results.successful.length} succeeded, ${result.results.failed.length} failed.`,
                duration: 8000
            });
        } else {
            addAutostakerLog('error', `❌ All ${result.results.failed.length} action(s) failed${retryInfo}`);
            // Log details of failed actions
            for (const failed of result.results.failed) {
                const shortId = failed.action.sponsorshipId?.substring(0, 10) + '...' || 'unknown';
                const retryMsg = failed.retriesAttempted > 0 ? ` (${failed.retriesAttempted} retries)` : '';
                // Make error message more readable
                let errorMsg = failed.error || 'Unknown error';
                if (errorMsg.includes('rate limit') || errorMsg.includes('Too many requests')) {
                    errorMsg = 'RPC rate limited - try again later';
                } else if (errorMsg.includes('processing response error')) {
                    errorMsg = 'RPC connection error';
                } else if (errorMsg.length > 50) {
                    errorMsg = errorMsg.substring(0, 50) + '...';
                }
                addAutostakerLog('error', `  ↳ ${failed.action.type} ${shortId}: ${errorMsg}${retryMsg}`);
            }
        }
        
        // Refresh operator data if we're on that view
        const opState = OperatorLogic.getState();
        if (opState.currentOperatorId === operatorId) {
            await OperatorLogic.refreshData(true);
        }
        
    } catch (e) {
        console.error('[Autostaker Bot] Cycle error:', e);
        addAutostakerLog('error', `Error: ${Utils.getFriendlyErrorMessage(e)}`);
    } finally {
        // Always mark cycle as complete
        autostakerState.isCycleRunning = false;
    }
}

function startAutostakerBot() {
    if (autostakerState.isRunning) return;
    
    // Ensure we have operator info
    if (!autostakerState.operatorId || !autostakerState.operatorSigner) {
        const opState = OperatorLogic.getState();
        autostakerState.operatorId = opState.currentOperatorId;
        autostakerState.operatorSigner = state.signer;
    }
    
    if (!autostakerState.operatorId || !autostakerState.operatorSigner) {
        UI.showToast({ type: 'error', title: 'Error', message: 'Please connect wallet and select an operator first.' });
        return;
    }
    
    const intervalInput = document.getElementById('autostaker-run-interval');
    let intervalMinutes = parseInt(intervalInput?.value || '5', 10);
    
    // Clamp between 1 and 60
    intervalMinutes = Math.max(1, Math.min(60, intervalMinutes));
    
    // Save to config
    const config = UI.getAutostakerSettingsFromForm();
    config.runIntervalMinutes = intervalMinutes;
    Autostaker.saveAutostakerConfig(autostakerState.operatorId, config);
    
    autostakerState.isRunning = true;
    autostakerState.nextRunTime = new Date(Date.now() + intervalMinutes * 60 * 1000);
    autostakerState.intervalMinutes = intervalMinutes; // Store for visibility handler
    
    addAutostakerLog('success', `Bot started - running every ${intervalMinutes} min`);
    updateBotStatusUI();
    
    // Run immediately
    runAutostakerBotCycle();
    
    // Set up interval
    autostakerState.botIntervalId = setInterval(() => {
        autostakerState.nextRunTime = new Date(Date.now() + intervalMinutes * 60 * 1000);
        updateBotStatusUI();
        runAutostakerBotCycle();
    }, intervalMinutes * 60 * 1000);
    
    UI.showToast({
        type: 'success',
        title: 'Autostaker Started',
        message: `Running every ${intervalMinutes} minute${intervalMinutes > 1 ? 's' : ''}.`,
        duration: 5000
    });
}

export function stopAutostakerBot() {
    if (!autostakerState.isRunning) return;
    
    if (autostakerState.botIntervalId) {
        clearInterval(autostakerState.botIntervalId);
        autostakerState.botIntervalId = null;
    }
    
    autostakerState.isRunning = false;
    autostakerState.nextRunTime = null;
    
    addAutostakerLog('info', 'Bot stopped');
    updateBotStatusUI();
    
    UI.showToast({
        type: 'info',
        title: 'Autostaker Stopped',
        message: 'The bot has been stopped.',
        duration: 3000
    });
}

function toggleAutostakerBot() {
    if (autostakerState.isRunning) {
        stopAutostakerBot();
    } else {
        startAutostakerBot();
    }
}

export function setupAutostakerListeners() {
    // Modal close (doesn't stop the bot, just hides panel)
    const closeBtn = document.getElementById('autostaker-modal-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', UI.hideAutostakerModal);
    }
    
    // Overlay click closes panel
    const overlay = document.getElementById('autostakerOverlay');
    if (overlay) {
        overlay.addEventListener('click', UI.hideAutostakerModal);
    }
    
    // Tab switching
    const tabSettings = document.getElementById('autostaker-tab-settings');
    const tabSponsorships = document.getElementById('autostaker-tab-sponsorships');
    const tabPreview = document.getElementById('autostaker-tab-preview');
    
    if (tabSettings) {
        tabSettings.addEventListener('click', () => UI.switchAutostakerTab('settings'));
    }
    if (tabSponsorships) {
        tabSponsorships.addEventListener('click', () => {
            UI.switchAutostakerTab('sponsorships');
            loadAutostakerSponsorships();
        });
    }
    if (tabPreview) {
        tabPreview.addEventListener('click', () => {
            UI.switchAutostakerTab('preview');
            renderAutostakerLogs();
        });
    }
    
    // Save settings
    const saveBtn = document.getElementById('autostaker-save-settings');
    if (saveBtn) {
        saveBtn.addEventListener('click', handleAutostakerSaveSettings);
    }
    
    // Sponsorship search
    const searchInput = document.getElementById('autostaker-sponsorship-search');
    
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            UI.filterAutostakerSponsorships(searchInput.value);
        });
    }
    
    // Start/Stop bot
    const startBotBtn = document.getElementById('autostaker-start-bot');
    if (startBotBtn) {
        startBotBtn.addEventListener('click', toggleAutostakerBot);
    }
    
    // Clear logs
    const clearLogBtn = document.getElementById('autostaker-clear-log');
    if (clearLogBtn) {
        clearLogBtn.addEventListener('click', clearAutostakerLogs);
    }
    
    // Global indicator click (opens panel)
    const globalIndicator = document.getElementById('autostaker-global-indicator');
    if (globalIndicator) {
        globalIndicator.addEventListener('click', () => {
            updateBotStatusUI();
            UI.showAutostakerModal();
        });
    }
}


export const isAutostakerRunning = () => autostakerState.isRunning;

// Warn user if bot is running when closing page
window.addEventListener('beforeunload', (e) => {
    if (autostakerState.isRunning) {
        e.preventDefault();
        e.returnValue = 'Autostaker bot is running. Are you sure you want to leave?';
        return e.returnValue;
    }
});

// Handle tab visibility changes - catch up on missed runs when tab becomes visible
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && autostakerState.isRunning) {
        // Check if we missed a scheduled run while tab was hidden
        if (autostakerState.nextRunTime && new Date() >= autostakerState.nextRunTime) {
            addAutostakerLog('info', 'Tab became visible - catching up on missed run');
            runAutostakerBotCycle();

            // Reset the next run time
            const intervalMinutes = autostakerState.intervalMinutes || 5;
            autostakerState.nextRunTime = new Date(Date.now() + intervalMinutes * 60 * 1000);
            updateBotStatusUI();
        }
    }
});
