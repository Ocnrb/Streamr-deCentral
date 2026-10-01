// The autostaker panel's settings, sponsorships, actions and tabs
import { escapeHtml, formatBigNumber, convertWeiToData } from '../core/utils.js';

// --- Autostaker UI Functions ---

// Lazy-loaded references (get them when needed, not at module load time)
let _autostakerModal = null;

function getAutostakerModal() {
    if (!_autostakerModal) {
        _autostakerModal = document.getElementById('autostakerModal');
    }
    return _autostakerModal;
}

let currentAutostakerTab = 'settings';

/**
 * Open the Autostaker modal
 */
export function showAutostakerModal() {
    const modal = getAutostakerModal();
    const overlay = document.getElementById('autostakerOverlay');
    if (modal) {
        modal.style.cssText = 'display: flex !important;';
        if (overlay) overlay.style.cssText = 'display: block !important;';
        switchAutostakerTab('settings');
    }
}

/**
 * Close the Autostaker modal
 */
export function hideAutostakerModal() {
    const modal = getAutostakerModal();
    const overlay = document.getElementById('autostakerOverlay');
    if (modal) {
        modal.style.cssText = 'display: none !important;';
    }
    if (overlay) {
        overlay.style.cssText = 'display: none !important;';
    }
}

/**
 * Switch between Autostaker tabs
 * @param {string} tab - Tab name: 'settings', 'sponsorships', 'preview'
 */
export function switchAutostakerTab(tab) {
    currentAutostakerTab = tab;
    
    // Update tab buttons
    const tabs = ['settings', 'sponsorships', 'preview'];
    tabs.forEach(t => {
        const btn = document.getElementById(`autostaker-tab-${t}`);
        const content = document.getElementById(`autostaker-content-${t}`);
        
        if (btn && content) {
            if (t === tab) {
                btn.classList.add('text-white', 'bg-[#2C2C2C]', 'border-b-2', 'border-blue-500');
                btn.classList.remove('text-gray-400');
                content.classList.remove('hidden');
            } else {
                btn.classList.remove('text-white', 'bg-[#2C2C2C]', 'border-b-2', 'border-blue-500');
                btn.classList.add('text-gray-400');
                content.classList.add('hidden');
            }
        }
    });
}

/**
 * Populate Autostaker settings form
 * @param {Object} config - Configuration object
 */
export function populateAutostakerSettings(config) {
    const maxSponsorships = document.getElementById('autostaker-max-sponsorships');
    const minTransaction = document.getElementById('autostaker-min-transaction');
    const maxMinOperators = document.getElementById('autostaker-max-min-operators');
    const runInterval = document.getElementById('autostaker-run-interval');
    const autoCollectEnabled = document.getElementById('autostaker-auto-collect-enabled');
    const collectInterval = document.getElementById('autostaker-collect-interval');
    const ignoreFirstCollect = document.getElementById('autostaker-ignore-first-collect');

    if (maxSponsorships) maxSponsorships.value = config.maxSponsorshipCount || 20;
    if (minTransaction) minTransaction.value = config.minTransactionAmount || 100;
    if (maxMinOperators) maxMinOperators.value = config.maxAcceptableMinOperatorCount || 4;
    if (runInterval) runInterval.value = config.runIntervalMinutes || 5;
    if (autoCollectEnabled) autoCollectEnabled.checked = config.autoCollectEnabled || false;
    if (collectInterval) collectInterval.value = config.autoCollectIntervalHours || 24;
    if (ignoreFirstCollect) ignoreFirstCollect.checked = config.ignoreFirstCollect !== false;
}

/**
 * Get current values from Autostaker settings form
 * @returns {Object} Configuration object
 */
export function getAutostakerSettingsFromForm() {
    const maxSponsorships = document.getElementById('autostaker-max-sponsorships');
    const minTransaction = document.getElementById('autostaker-min-transaction');
    const maxMinOperators = document.getElementById('autostaker-max-min-operators');
    const runInterval = document.getElementById('autostaker-run-interval');
    const autoCollectEnabled = document.getElementById('autostaker-auto-collect-enabled');
    const collectInterval = document.getElementById('autostaker-collect-interval');
    const ignoreFirstCollect = document.getElementById('autostaker-ignore-first-collect');

    return {
        maxSponsorshipCount: parseInt(maxSponsorships?.value) || 20,
        minTransactionAmount: parseInt(minTransaction?.value) || 100,
        maxAcceptableMinOperatorCount: parseInt(maxMinOperators?.value) || 4,
        runIntervalMinutes: parseInt(runInterval?.value) || 5,
        autoCollectEnabled: autoCollectEnabled?.checked || false,
        autoCollectIntervalHours: parseInt(collectInterval?.value) || 24,
        ignoreFirstCollect: ignoreFirstCollect?.checked !== false
    };
}

/**
 * Update the auto-collect status display
 * @param {Object} config - Configuration object with lastCollectTime
 * @param {Object} timeUntil - Object with hours, minutes, formatted string
 */
export function updateAutoCollectStatus(config, timeUntil) {
    const statusEl = document.getElementById('autostaker-collect-status');
    if (!statusEl) return;
    
    if (!config.autoCollectEnabled) {
        statusEl.textContent = 'Auto-collect: Disabled';
        statusEl.className = 'text-xs text-gray-500 mt-2';
        return;
    }
    
    let lastCollectStr = 'Never';
    if (config.lastCollectTime) {
        const lastDate = new Date(config.lastCollectTime);
        lastCollectStr = lastDate.toLocaleString();
    }
    
    statusEl.innerHTML = `
        <span class="text-green-400">●</span> Auto-collect: Active
        <br>
        <span class="text-gray-600">Last: ${lastCollectStr}</span>
        <br>
        <span class="text-gray-600">Next: ${timeUntil?.formatted || 'Next cycle'}</span>
    `;
    statusEl.className = 'text-xs text-gray-400 mt-2';
}

/**
 * Convert payout from Wei/sec to DATA/day
 * @param {string|BigInt} weiPerSec - Payout in wei per second
 * @returns {string} Formatted payout in DATA/day
 */
function formatPayoutPerDay(weiPerSec) {
    if (!weiPerSec) return '0';
    // Convert wei/sec to DATA/day: weiPerSec * 86400 / 1e18
    const weiPerDay = BigInt(weiPerSec) * BigInt(86400);
    const dataPerDay = Number(weiPerDay) / 1e18;
    
    if (dataPerDay >= 1000) {
        return formatBigNumber(dataPerDay.toFixed(0));
    } else if (dataPerDay >= 1) {
        return dataPerDay.toFixed(2);
    } else if (dataPerDay >= 0.01) {
        return dataPerDay.toFixed(4);
    } else {
        return dataPerDay.toExponential(2);
    }
}

/**
 * Render sponsorships list in the Autostaker modal
 * @param {Array} sponsorships - Array of sponsorship objects
 * @param {Function} onToggleExclude - Callback when exclusion is toggled
 */
export function renderAutostakerSponsorships(sponsorships, onToggleExclude) {
    const listEl = document.getElementById('autostaker-sponsorships-list');
    if (!listEl) return;
    
    if (!sponsorships || sponsorships.length === 0) {
        listEl.innerHTML = '<div class="text-center py-8 text-gray-500">No sponsorships available.</div>';
        return;
    }
    
    listEl.innerHTML = sponsorships.map(sp => {
        // Truncate stream ID more aggressively to prevent overflow
        const maxIdLength = 45;
        const truncatedId = sp.streamId.length > maxIdLength 
            ? sp.streamId.substring(0, maxIdLength - 3) + '...' 
            : sp.streamId;
        const stakeAmount = sp.currentStake ? formatBigNumber(convertWeiToData(sp.currentStake.toString())) : '0';
        const apy = sp.spotAPY ? Math.round(Number(sp.spotAPY) * 100) : 0;
        const balance = sp.remainingWei ? formatBigNumber(convertWeiToData(sp.remainingWei.toString())) : '?';
        const payoutPerDay = formatPayoutPerDay(sp.payoutPerSec);
        
        // Determine border color based on status
        let borderColor = 'border-[#2a2a2a]';
        const isStakeable = sp.isStakeable === true;
        const hasIssues = sp.issues && sp.issues.length > 0;
        const hasInfo = sp.info && sp.info.length > 0;
        const canBeActivated = sp.canBeActivated === true;
        
        if (sp.isStaked) {
            borderColor = 'border-blue-500/30';
        } else if (sp.isExcluded) {
            borderColor = 'border-red-500/20';
        } else if (hasIssues) {
            borderColor = 'border-yellow-500/20';
        } else if (canBeActivated) {
            borderColor = 'border-green-500/20';
        }
        
        // Build issues badges (blocking) - yellow
        let issuesHtml = '';
        if (hasIssues) {
            issuesHtml = `
                <div class="flex flex-wrap gap-1 mt-2">
                    ${sp.issues.map(issue => `<span class="px-2 py-0.5 text-xs bg-yellow-500/10 text-yellow-400 rounded border border-yellow-500/20">${escapeHtml(issue)}</span>`).join('')}
                </div>
            `;
        }
        
        // Build info badges (non-blocking) - green/cyan for activatable sponsorships
        let infoHtml = '';
        if (hasInfo) {
            infoHtml = `
                <div class="flex flex-wrap gap-1 mt-2">
                    ${sp.info.map(msg => `<span class="px-2 py-0.5 text-xs bg-green-500/10 text-green-400 rounded border border-green-500/20">${escapeHtml(msg)}</span>`).join('')}
                </div>
            `;
        }
        
        return `
            <div class="bg-[#1E1E1E] rounded-xl p-5 border ${borderColor} autostaker-sponsorship-item ${hasIssues && !sp.isStaked ? 'opacity-60' : ''}" data-sponsorship-id="${escapeHtml(String(sp.id))}" data-stream-id="${escapeHtml(sp.streamId.toLowerCase())}" data-is-staked="${sp.isStaked}" data-is-stakeable="${isStakeable}" data-can-be-activated="${canBeActivated}">
                <!-- Header -->
                <div class="mb-4">
                    <p class="text-sm text-gray-200 font-mono leading-relaxed break-all overflow-hidden" title="${escapeHtml(sp.streamId)}">${escapeHtml(truncatedId)}</p>
                    ${issuesHtml}
                    ${infoHtml}
                </div>
                
                <!-- Stats Grid -->
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
                    <div class="space-y-1">
                        <p class="text-xs text-gray-500 uppercase tracking-wide">Payout</p>
                        <p class="text-sm text-gray-200 font-medium">${payoutPerDay} <span class="text-gray-500 text-xs">/ day</span></p>
                    </div>
                    <div class="space-y-1">
                        <p class="text-xs text-gray-500 uppercase tracking-wide">APY</p>
                        <p class="text-sm ${apy >= 10 ? 'text-gray-200' : 'text-gray-400'} font-medium">${apy}%</p>
                    </div>
                    <div class="space-y-1">
                        <p class="text-xs text-gray-500 uppercase tracking-wide">Balance</p>
                        <p class="text-sm text-gray-300">${balance}</p>
                    </div>
                    <div class="space-y-1">
                        <p class="text-xs text-gray-500 uppercase tracking-wide">Operators</p>
                        <p class="text-sm text-gray-300">${sp.operatorCount}${sp.maxOperators ? ' / ' + sp.maxOperators : ''}${sp.minOperators ? ` (min: ${sp.minOperators})` : ''}</p>
                    </div>
                    ${sp.isStaked ? `
                        <div class="space-y-1">
                            <p class="text-xs text-gray-500 uppercase tracking-wide">Your Stake</p>
                            <p class="text-sm text-blue-400 font-medium">${stakeAmount} DATA</p>
                        </div>
                    ` : ''}
                </div>
                
                <!-- Footer -->
                <div class="flex items-center justify-end gap-2 pt-4 pb-2 border-t border-[#2a2a2a] min-h-[48px]">
                    ${sp.isStaked ? `
                        <span class="px-4 py-1.5 text-xs bg-blue-500/20 text-blue-400 rounded-md font-medium border border-blue-500/20 flex items-center gap-2">
                            <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><circle cx="10" cy="10" r="3"/></svg>
                            <span>Staked</span>
                        </span>
                    ` : `
                        <label class="flex items-center gap-2 cursor-pointer group select-none autostaker-exclude-toggle" data-sponsorship-id="${sp.id}">
                            <span class="text-xs font-medium ${sp.isExcluded ? 'text-red-400' : 'text-gray-500 group-hover:text-gray-300'} transition-colors">Blacklist</span>
                            <div class="relative">
                                <input type="checkbox" class="sr-only peer autostaker-exclude-checkbox" ${sp.isExcluded ? 'checked' : ''} data-sponsorship-id="${sp.id}">
                                <div class="w-8 h-4 ${sp.isExcluded ? 'bg-red-600' : 'bg-[#333333]'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-red-600"></div>
                            </div>
                        </label>
                    `}
                </div>
            </div>
        `;
    }).join('');
    
    // Attach event listeners to exclude checkboxes
    listEl.querySelectorAll('.autostaker-exclude-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const sponsorshipId = e.target.getAttribute('data-sponsorship-id');
            if (onToggleExclude) {
                onToggleExclude(sponsorshipId);
            }
        });
    });
}

/**
 * Filter sponsorships list based on search
 * @param {string} searchQuery - Search query
 */
export function filterAutostakerSponsorships(searchQuery) {
    const items = document.querySelectorAll('.autostaker-sponsorship-item');
    const query = searchQuery.toLowerCase().trim();
    
    items.forEach(item => {
        const streamId = item.getAttribute('data-stream-id') || '';
        const sponsorshipId = item.getAttribute('data-sponsorship-id') || '';
        
        let show = true;
        
        // Search filter
        if (query && !streamId.includes(query) && !sponsorshipId.toLowerCase().includes(query)) {
            show = false;
        }
        
        item.style.display = show ? 'flex' : 'none';
    });
}

/**
 * Update Autostaker summary stats
 * @param {Object} stats - Statistics object
 */
export function updateAutostakerStats(stats) {
    const freeFundsEl = document.getElementById('autostaker-stat-free-funds');
    const currentStakesEl = document.getElementById('autostaker-stat-current-stakes');
    const queueEl = document.getElementById('autostaker-stat-queue');
    const excludedEl = document.getElementById('autostaker-stat-excluded');
    
    if (freeFundsEl && stats.freeFunds !== undefined) {
        freeFundsEl.textContent = `${formatBigNumber(convertWeiToData(stats.freeFunds.toString()))} DATA`;
    }
    if (currentStakesEl && stats.currentStakesCount !== undefined) {
        currentStakesEl.textContent = stats.currentStakesCount.toString();
    }
    if (queueEl && stats.queueAmount !== undefined) {
        queueEl.textContent = `${formatBigNumber(convertWeiToData(stats.queueAmount.toString()))} DATA`;
    }
    if (excludedEl && stats.excludedCount !== undefined) {
        excludedEl.textContent = stats.excludedCount.toString();
    }
}

/**
 * Render Autostaker preview actions list
 * @param {Array} actions - Array of action objects
 * @param {Map} sponsorshipInfo - Map of sponsorship info
 */
export function renderAutostakerActions(actions, sponsorshipInfo) {
    const listEl = document.getElementById('autostaker-actions-list');
    const executeBtn = document.getElementById('autostaker-execute-btn');
    
    if (!listEl) return;
    
    if (!actions || actions.length === 0) {
        listEl.innerHTML = `
            <div class="text-center py-8 text-gray-500">
                <svg class="w-12 h-12 mx-auto mb-3 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                </svg>
                <p>Your stakes are already optimally distributed!</p>
                <p class="text-xs mt-1">No actions needed at this time.</p>
            </div>
        `;
        if (executeBtn) executeBtn.disabled = true;
        return;
    }
    
    listEl.innerHTML = actions.map((action, index) => {
        const info = sponsorshipInfo?.get(action.sponsorshipId);
        const streamId = info?.streamId || action.sponsorshipId;
        const truncatedId = streamId.length > 40 ? streamId.substring(0, 37) + '...' : streamId;
        const amountData = convertWeiToData(action.amount.toString());
        
        const isStake = action.type === 'stake';
        const iconClass = isStake ? 'text-green-400' : 'text-orange-400';
        const bgClass = isStake ? 'border-green-900/30' : 'border-orange-900/30';
        const actionLabel = isStake ? 'STAKE' : 'UNSTAKE';
        
        return `
            <div class="bg-[#121212] rounded-lg p-4 border ${bgClass} flex items-center gap-4">
                <div class="flex-shrink-0">
                    <span class="inline-flex items-center justify-center w-8 h-8 rounded-full ${isStake ? 'bg-green-900/30' : 'bg-orange-900/30'}">
                        <svg class="w-4 h-4 ${iconClass}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            ${isStake 
                                ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 10l7-7m0 0l7 7m-7-7v18"></path>'
                                : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path>'
                            }
                        </svg>
                    </span>
                </div>
                <div class="flex-1 min-w-0">
                    <p class="text-sm font-medium ${iconClass}">${actionLabel}</p>
                    <p class="text-xs text-gray-400 truncate font-mono" title="${escapeHtml(streamId)}">${escapeHtml(truncatedId)}</p>
                </div>
                <div class="text-right flex-shrink-0">
                    <p class="text-sm font-semibold text-white" data-tooltip-value="${amountData}">${formatBigNumber(amountData)} DATA</p>
                </div>
            </div>
        `;
    }).join('');
    
    if (executeBtn) {
        executeBtn.disabled = false;
        executeBtn.textContent = `Execute ${actions.length} Action${actions.length > 1 ? 's' : ''}`;
    }
}

/**
 * Set Autostaker loading state
 * @param {boolean} loading - Whether loading
 * @param {string} tab - Which tab is loading
 */
export function setAutostakerLoading(loading, tab = 'all') {
    const loadingHtml = `
        <div class="text-center py-8 text-gray-500">
            <svg class="w-8 h-8 mx-auto mb-2 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
            </svg>
            Loading...
        </div>
    `;
    
    if (tab === 'sponsorships' || tab === 'all') {
        const sponsorshipsList = document.getElementById('autostaker-sponsorships-list');
        if (sponsorshipsList && loading) {
            sponsorshipsList.innerHTML = loadingHtml;
        }
    }
    
    if (tab === 'preview' || tab === 'all') {
        const actionsList = document.getElementById('autostaker-actions-list');
        if (actionsList && loading) {
            actionsList.innerHTML = loadingHtml;
        }
    }
}
