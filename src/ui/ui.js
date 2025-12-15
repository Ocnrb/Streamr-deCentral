import { escapeHtml, formatBigNumber, convertWeiToData, createAddressLink, createEntityLink, parseOperatorMetadata, calculateWeightedApy } from '../core/utils.js';
import { getMaticBalance } from '../core/services.js';
import { regionToLocationMap } from './locationData.js';
import { MAX_STREAM_MESSAGES } from '../core/constants.js';

// --- Element Cache ---
export const loginModal = document.getElementById('loginModal');
export const mainContainer = document.getElementById('main-container');
export const operatorsGrid = document.getElementById('operators-grid');
export const searchInput = document.getElementById('search-input');
export const loadMoreOperatorsBtn = document.getElementById('load-more-operators-btn');
export const detailContent = document.getElementById('detail-content');
export const operatorDetailView = document.getElementById('operator-detail-view');
export const operatorListView = document.getElementById('operator-list-view');
export const raceView = document.getElementById('race-view'); 
export const visualView = document.getElementById('visual-view'); 
export const delegatorsListView = document.getElementById('delegators-list-view'); 
export const delegatorDetailView = document.getElementById('delegator-detail-view'); 
export const customTooltip = document.getElementById('custom-tooltip');
export const loaderOverlay = document.getElementById('loader-overlay');
export const dataPriceValueEl = document.getElementById('data-price-value');
export const transactionModal = document.getElementById('transactionModal');
export const stakeModal = document.getElementById('stakeModal');
export const settingsModal = document.getElementById('settingsModal');
export const theGraphApiKeyInput = document.getElementById('thegraph-api-key-input');
// Transaction Modal Elements
export const txModalAmount = document.getElementById('tx-modal-amount');
export const txModalBalanceValue = document.getElementById('tx-modal-balance-value');
export const txModalMinimumValue = document.getElementById('tx-modal-minimum-value');
// Stake Modal Elements
export const stakeModalAmount = document.getElementById('stake-modal-amount');
export const stakeModalCurrentStake = document.getElementById('stake-modal-current-stake');
export const stakeModalFreeFunds = document.getElementById('stake-modal-free-funds');
// Operator Settings Modal Elements
export const operatorSettingsModal = document.getElementById('operatorSettingsModal');
export const operatorSettingsModalNameInput = document.getElementById('operator-settings-modal-name');
export const operatorSettingsModalDescriptionInput = document.getElementById('operator-settings-modal-description-input');
export const operatorSettingsModalCutInput = document.getElementById('operator-settings-modal-cut');
export const operatorSettingsModalRedundancyInput = document.getElementById('operator-settings-modal-redundancy');


// --- Module State ---
let stakeHistoryChart = null;

// --- Leaflet Map State ---
let leafletMap = null;
// Use a Map to group nodes by location. Key: "lat,long", Value: { marker, nodes (Map<nodeId, host>), location }
let locationNodeMap = new Map();
let mapLayers = {
    markers: null,
    lines: null
};


// --- UI Update Functions ---

export function showLoader(show) {
    loaderOverlay.style.display = show ? 'flex' : 'none';
}

// Toast container reference
const toastContainer = document.getElementById('toast-container');
let toastCounter = 0;
const activeToasts = new Map(); // Track active toasts for updates

/**
 * Get icon SVG for toast type
 */
function getToastIcon(type) {
    const icons = {
        success: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>`,
        error: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>`,
        warning: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>`,
        info: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`,
        loading: `<svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>`
    };
    return icons[type] || icons.info;
}

/**
 * Build Polygonscan link HTML
 */
function buildPolygonscanLink(txHash) {
    if (!txHash) return '';
    return `
        <a href="https://polygonscan.com/tx/${txHash}" target="_blank" rel="noopener noreferrer" 
           class="toast-link text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1 mt-2 transition-colors">
            <span>View on Polygonscan</span>
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path>
            </svg>
        </a>`;
}

/**
 * Display a toast notification
 * @param {Object} options - Toast options
 * @param {string} options.type - 'success' | 'error' | 'warning' | 'info' | 'loading'
 * @param {string} options.title - Toast title
 * @param {string} [options.message] - Optional message
 * @param {string} [options.txHash] - Transaction hash for Polygonscan link
 * @param {number} [options.duration=5000] - Duration in ms (0 = no auto-close)
 * @returns {string} Toast ID for later updates
 */
export function showToast({ type = 'info', title, message = '', txHash = null, duration = 5000 }) {
    const toastId = `toast-${++toastCounter}`;
    
    // Loading toasts never auto-close
    if (type === 'loading') {
        duration = 0;
    }
    
    // Progress bar for auto-close
    const progressBar = duration > 0 
        ? `<div class="toast-progress" style="width: 100%; transition: width ${duration}ms linear;"></div>` 
        : '';
    
    const toastHtml = `
        <div id="${toastId}" class="toast toast-${type} relative overflow-hidden" data-type="${type}">
            <div class="flex items-start gap-3">
                <span class="toast-icon">${getToastIcon(type)}</span>
                <div class="flex-1 min-w-0">
                    <p class="toast-title font-semibold text-white text-sm">${title}</p>
                    <p class="toast-message text-sm text-gray-400 mt-0.5 ${message ? '' : 'hidden'}">${message}</p>
                    <div class="toast-link-container">${buildPolygonscanLink(txHash)}</div>
                </div>
                <button class="toast-close flex-shrink-0 ${type === 'loading' ? 'hidden' : ''}" onclick="document.getElementById('${toastId}').dispatchEvent(new CustomEvent('close'))">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                </button>
            </div>
            ${progressBar}
        </div>
    `;
    
    toastContainer.insertAdjacentHTML('beforeend', toastHtml);
    
    const toastElement = document.getElementById(toastId);
    
    // Start progress bar animation
    if (duration > 0) {
        const progressEl = toastElement.querySelector('.toast-progress');
        if (progressEl) {
            progressEl.offsetHeight; // Trigger reflow
            progressEl.style.width = '0%';
        }
    }
    
    // Function to remove toast
    const removeToast = () => {
        activeToasts.delete(toastId);
        toastElement.classList.add('toast-removing');
        setTimeout(() => {
            toastElement.remove();
        }, 300);
    };
    
    // Store toast data for updates
    activeToasts.set(toastId, {
        element: toastElement,
        removeToast,
        timeoutId: null
    });
    
    // Listen for close event
    toastElement.addEventListener('close', removeToast);
    
    // Auto-remove after duration
    if (duration > 0) {
        const timeoutId = setTimeout(removeToast, duration);
        activeToasts.get(toastId).timeoutId = timeoutId;
    }
    
    return toastId;
}

/**
 * Update an existing toast notification
 * @param {string} toastId - The ID of the toast to update
 * @param {Object} options - New options for the toast
 * @param {string} [options.type] - New type (changes icon and color)
 * @param {string} [options.title] - New title
 * @param {string} [options.message] - New message
 * @param {string} [options.txHash] - Transaction hash for Polygonscan link
 * @param {number} [options.duration] - New duration (0 = no auto-close, >0 = auto-close)
 */
export function updateToast(toastId, { type, title, message, txHash, duration }) {
    const toastData = activeToasts.get(toastId);
    if (!toastData) return;
    
    const { element, removeToast, timeoutId } = toastData;
    const currentType = element.dataset.type;
    
    // Update type if changed
    if (type && type !== currentType) {
        element.classList.remove(`toast-${currentType}`);
        element.classList.add(`toast-${type}`);
        element.dataset.type = type;
        
        // Update icon
        const iconEl = element.querySelector('.toast-icon');
        if (iconEl) {
            iconEl.innerHTML = getToastIcon(type);
        }
        
        // Show/hide close button (hide for loading)
        const closeBtn = element.querySelector('.toast-close');
        if (closeBtn) {
            closeBtn.classList.toggle('hidden', type === 'loading');
        }
    }
    
    // Update title
    if (title !== undefined) {
        const titleEl = element.querySelector('.toast-title');
        if (titleEl) titleEl.textContent = title;
    }
    
    // Update message
    if (message !== undefined) {
        const messageEl = element.querySelector('.toast-message');
        if (messageEl) {
            messageEl.textContent = message;
            messageEl.classList.toggle('hidden', !message);
        }
    }
    
    // Update Polygonscan link
    if (txHash !== undefined) {
        const linkContainer = element.querySelector('.toast-link-container');
        if (linkContainer) {
            linkContainer.innerHTML = buildPolygonscanLink(txHash);
        }
    }
    
    // Handle duration changes
    if (duration !== undefined) {
        // Clear existing timeout
        if (timeoutId) {
            clearTimeout(timeoutId);
            activeToasts.get(toastId).timeoutId = null;
        }
        
        // Remove existing progress bar
        const existingProgress = element.querySelector('.toast-progress');
        if (existingProgress) {
            existingProgress.remove();
        }
        
        // Add new duration behavior
        if (duration > 0) {
            // Add progress bar
            const progressHtml = `<div class="toast-progress" style="width: 100%; transition: width ${duration}ms linear;"></div>`;
            element.insertAdjacentHTML('beforeend', progressHtml);
            
            const progressEl = element.querySelector('.toast-progress');
            if (progressEl) {
                progressEl.offsetHeight; // Trigger reflow
                progressEl.style.width = '0%';
            }
            
            // Set new timeout
            const newTimeoutId = setTimeout(removeToast, duration);
            activeToasts.get(toastId).timeoutId = newTimeoutId;
        }
    }
}

/**
 * Remove a toast by ID
 * @param {string} toastId - The ID of the toast to remove
 */
export function removeToast(toastId) {
    const toastData = activeToasts.get(toastId);
    if (toastData) {
        toastData.removeToast();
    }
}

export function setLoginModalState(state, mode = 'wallet') {
    const walletLoginView = document.getElementById('walletLoginView');
    const loadingContent = document.getElementById('loadingContent');
    const loadingMainText = document.getElementById('loading-main-text');
    const loadingSubText = document.getElementById('loading-sub-text');
    const installAppSection = document.getElementById('installAppSection');

    if (state === 'loading') {
        walletLoginView.classList.add('hidden');
        loadingContent.classList.remove('hidden');
        // Hide install panel during loading
        if (installAppSection) installAppSection.classList.add('hidden');
        if (mode === 'guest') {
            loadingMainText.textContent = 'Loading...';
            loadingSubText.textContent = 'Fetching operator data, please wait.';
        } else if (mode === 'privateKey') {
            loadingMainText.textContent = 'Connecting...';
            loadingSubText.textContent = 'Setting up your wallet connection.';
        } else {
            loadingMainText.textContent = 'Fetching operator data, please wait.';
            loadingSubText.textContent = 'Please follow the instructions in your wallet.';
        }
    } else { // 'buttons'
        loadingContent.classList.add('hidden');
        walletLoginView.classList.remove('hidden');
        // Show install panel when showing login buttons, but only if app is not installed
        if (installAppSection) {
            const isInstalled = typeof window.isAppInstalled === 'function' && window.isAppInstalled();
            if (isInstalled) {
                installAppSection.classList.add('hidden');
            } else {
                installAppSection.classList.remove('hidden');
            }
        }
    }
}

// --- Private Key Modal Functions ---
const privateKeyModal = document.getElementById('privateKeyModal');

export function showPrivateKeyModal() {
    if (privateKeyModal) {
        privateKeyModal.classList.remove('hidden');
        const input = document.getElementById('privateKeyInput');
        if (input) {
            input.value = '';
            input.type = 'password';
            setTimeout(() => input.focus(), 100);
        }
        const eyeIcon = document.getElementById('eyeIcon');
        const eyeOffIcon = document.getElementById('eyeOffIcon');
        if (eyeIcon) eyeIcon.classList.remove('hidden');
        if (eyeOffIcon) eyeOffIcon.classList.add('hidden');
        const checkbox = document.getElementById('rememberPrivateKey');
        if (checkbox) checkbox.checked = false;
    }
}

export function hidePrivateKeyModal() {
    if (privateKeyModal) {
        privateKeyModal.classList.add('hidden');
        const input = document.getElementById('privateKeyInput');
        if (input) input.value = '';
    }
}

export function displayView(view) {
    // Hide all views first
    operatorListView.style.display = 'none';
    operatorDetailView.style.display = 'none';
    if (raceView) raceView.style.display = 'none';
    if (visualView) visualView.style.display = 'none';
    if (delegatorsListView) delegatorsListView.style.display = 'none';
    if (delegatorDetailView) delegatorDetailView.style.display = 'none';

    // Show/hide navigation based on view (visual is fullscreen)
    const bottomNav = document.getElementById('bottom-nav');
    const mobileHeader = document.getElementById('mobile-header');
    const isFullscreenView = view === 'visual';
    
    if (bottomNav) bottomNav.style.display = isFullscreenView ? 'none' : '';
    if (mobileHeader) mobileHeader.style.display = isFullscreenView ? 'none' : '';

    if (view === 'list') {
        operatorListView.style.display = 'block';
    } else if (view === 'race') {
        if (raceView) raceView.style.display = 'block';
    } else if (view === 'visual') {
        if (visualView) visualView.style.display = 'block';
    } else if (view === 'delegators-list') {
        if (delegatorsListView) delegatorsListView.style.display = 'block';
    } else if (view === 'delegator-detail') {
        if (delegatorDetailView) delegatorDetailView.style.display = 'block';
        window.scrollTo(0, 0);
    } else { // 'detail'
        operatorDetailView.style.display = 'block';
        window.scrollTo(0, 0);
    }
}

// Track active loading toast for each modal
const modalLoadingToasts = new Map();

export function setModalState(baseId, state, options = {}) {
    const inputSection = document.getElementById(`${baseId}-input-section`);
    const amountInput = document.getElementById(`${baseId}-amount`);

    // Get the parent modal element
    const modalMap = {
        'tx-modal': transactionModal,
        'stake-modal': stakeModal,
        'operator-settings-modal': operatorSettingsModal
    };
    const modalElement = modalMap[baseId];

    if (state === 'input') {
        // Show input section
        if (inputSection) inputSection.classList.remove('hidden');
        if (amountInput) amountInput.value = '';
        
        // Remove any existing loading toast for this modal
        const existingToastId = modalLoadingToasts.get(baseId);
        if (existingToastId) {
            removeToast(existingToastId);
            modalLoadingToasts.delete(baseId);
        }
        
        if (baseId === 'operator-settings-modal') {
             const confirmBtn = document.getElementById('operator-settings-modal-confirm');
             if (confirmBtn) {
                confirmBtn.disabled = true;
                confirmBtn.textContent = 'Confirm Changes';
             }
        }

    } else if (state === 'loading') {
        // Close modal and show loading toast
        if (modalElement) modalElement.classList.add('hidden');
        
        const title = options.text || 'Processing...';
        const message = options.subtext || 'Please wait.';
        
        // Check if there's an existing loading toast for this modal
        const existingToastId = modalLoadingToasts.get(baseId);
        if (existingToastId) {
            // Update existing toast
            updateToast(existingToastId, { title, message });
        } else {
            // Create new loading toast
            const toastId = showToast({
                type: 'loading',
                title,
                message,
                duration: 0
            });
            modalLoadingToasts.set(baseId, toastId);
        }
        
    } else if (state === 'success') {
        // Remove loading toast and show success toast
        const loadingToastId = modalLoadingToasts.get(baseId);
        if (loadingToastId) {
            // Transform loading toast into success toast
            updateToast(loadingToastId, {
                type: 'success',
                title: 'Transaction Successful',
                message: options.tx1Text || 'Your transaction has been confirmed.',
                txHash: options.txHash,
                duration: 8000
            });
            modalLoadingToasts.delete(baseId);
        } else {
            // No loading toast, create success toast directly
            showToast({
                type: 'success',
                title: 'Transaction Successful',
                message: options.tx1Text || 'Your transaction has been confirmed.',
                txHash: options.txHash,
                duration: 8000
            });
        }
        
        // If there's a second transaction
        if (options.txHash2) {
            setTimeout(() => {
                showToast({
                    type: 'success',
                    title: 'Transaction Successful',
                    message: options.tx2Text || 'Second transaction confirmed.',
                    txHash: options.txHash2,
                    duration: 8000
                });
            }, 300);
        }

    } else if (state === 'error') {
        // Remove loading toast and show error toast
        const loadingToastId = modalLoadingToasts.get(baseId);
        if (loadingToastId) {
            // Transform loading toast into error toast
            updateToast(loadingToastId, {
                type: 'error',
                title: 'Transaction Failed',
                message: options.message || 'Something went wrong.',
                duration: 0
            });
            modalLoadingToasts.delete(baseId);
        } else {
            showToast({
                type: 'error',
                title: 'Transaction Failed',
                message: options.message || 'Something went wrong.',
                duration: 0
            });
        }
    }
}


// --- List View Rendering ---

function createOperatorCardHtml(op) {
    let { name, description, imageUrl } = parseOperatorMetadata(op.metadataJsonString);
    if (imageUrl && !imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
        imageUrl = null;
    }
    const placeholderUrl = 'https://placehold.co/64x64/1E1E1E/a3a3a3?text=OP';
    const weightedApy = calculateWeightedApy(op.stakes);
    const totalStakedData = convertWeiToData(op.valueWithoutEarnings);
    const safeOperatorName = escapeHtml(name || op.id);
    const sponsorshipsCount = op.stakes ? op.stakes.length : 0;

    const roundedApy = Math.round(weightedApy * 100);
    const apyColorClass = roundedApy === 0 ? 'text-red-400' : 'text-green-400';

    return `
     <div class="operator-card bg-[#1E1E1E] p-5 rounded-xl border border-[#333333] card flex flex-col items-center text-center" data-operator-id="${op.id}">
         <img src="${imageUrl || placeholderUrl}" loading="lazy" onerror="this.src='${placeholderUrl}'; this.onerror=null;" alt="Operator Avatar" class="avatar-container w-16 h-16 rounded-full border-2 border-[#333333] object-cover mb-4" ${description ? `data-tooltip-content="${escapeHtml(description)}"` : ''}>
         <div class="w-full">
             <h3 class="operator-name font-bold text-lg text-white truncate" title="${safeOperatorName}">${safeOperatorName}</h3>
             ${name ? `<div class="font-mono text-xs text-gray-500 truncate mt-1">${createAddressLink(op.id)}</div>` : ''}
         </div>
         <div class="metrics-row mt-4 pt-4 border-t border-[#333333] w-full text-left space-y-2 text-sm">
             <p><strong class="text-gray-400">APY:</strong> <span class="font-mono ${apyColorClass}" data-tooltip-content="Sponsorships: ${sponsorshipsCount}">${roundedApy}%</span></p>
             <div><strong class="text-gray-400">Stake:</strong> <span class="font-mono text-white block" data-tooltip-value="${totalStakedData}">${formatBigNumber(totalStakedData)} DATA</span></div>
             <p><strong class="text-gray-400">Delegators:</strong> <span class="font-mono text-white">${op.delegatorCount > 0 ? op.delegatorCount - 1 : 0}</span></p>
         </div>
     </div>`;
}

export function renderOperatorsList(operators, searchQuery) {
    if (!operators || operators.length === 0) {
        let message = 'No operators found.';
        if (searchQuery && searchQuery.length > 0) message = `No operators found for your search "${escapeHtml(searchQuery)}".`;
        operatorsGrid.innerHTML = `<p class="text-gray-500 col-span-full">${message}</p>`;
        return;
    }
    operatorsGrid.innerHTML = operators.map(createOperatorCardHtml).join('');
}

export function appendOperatorsList(operators) {
    if (operators?.length > 0) {
        operatorsGrid.insertAdjacentHTML('beforeend', operators.map(createOperatorCardHtml).join(''));
    }
}

// --- Detail View Rendering ---

export async function renderBalances(addresses) {
    const uniqueAddresses = [...new Set(addresses)];
    for (const address of uniqueAddresses) {
        const balance = await getMaticBalance(address);
        const formattedBalance = `${balance} POL`;
        document.querySelectorAll(`#agent-balance-${address}, #node-balance-${address}`).forEach(el => {
            if (el) el.textContent = formattedBalance;
        });
    }
}

export function updateDelegatorsSection(delegations, totalDelegatorCount, operatorData = null) {
    const listEl = document.getElementById('delegators-list');
    const footerEl = document.getElementById('delegators-footer');
    if (!listEl || !footerEl) return;

    // Calculate exchange rate from operator data for real-time value
    // exchangeRate = valueWithoutEarnings / operatorTokenTotalSupply
    let exchangeRateNum = 1;
    if (operatorData && operatorData.operatorTokenTotalSupplyWei && operatorData.valueWithoutEarnings) {
        const totalSupply = BigInt(operatorData.operatorTokenTotalSupplyWei);
        const valueWithoutEarnings = BigInt(operatorData.valueWithoutEarnings);
        if (totalSupply > 0n) {
            // exchangeRate as a ratio (multiply by 1e18 for precision)
            exchangeRateNum = Number(valueWithoutEarnings * BigInt(1e18) / totalSupply) / 1e18;
        }
    }

    listEl.innerHTML = delegations.map(delegation => {
        // Calculate current DATA value: operatorTokenBalanceWei * exchangeRate
        let currentDataValue;
        if (delegation.operatorTokenBalanceWei && exchangeRateNum !== 1) {
            const tokenBalance = BigInt(delegation.operatorTokenBalanceWei);
            // currentValue = tokenBalance * valueWithoutEarnings / totalSupply
            if (operatorData && operatorData.operatorTokenTotalSupplyWei && operatorData.valueWithoutEarnings) {
                const totalSupply = BigInt(operatorData.operatorTokenTotalSupplyWei);
                const valueWithoutEarnings = BigInt(operatorData.valueWithoutEarnings);
                if (totalSupply > 0n) {
                    const currentValueWei = tokenBalance * valueWithoutEarnings / totalSupply;
                    currentDataValue = convertWeiToData(currentValueWei.toString());
                } else {
                    currentDataValue = convertWeiToData(delegation._valueDataWei);
                }
            } else {
                currentDataValue = convertWeiToData(delegation._valueDataWei);
            }
        } else {
            currentDataValue = convertWeiToData(delegation._valueDataWei);
        }
        
        return `
        <li class="flex justify-between items-center py-2 border-b border-[#333333]">
            <div class="font-mono text-xs text-gray-300 truncate">${createAddressLink(delegation.delegator.id)}</div>
            <div class="text-right"><span class="font-mono text-xs text-green-400 block" data-tooltip-value="${currentDataValue}">${formatBigNumber(currentDataValue)} DATA</span></div>
        </li>`;
    }).join('');

    footerEl.innerHTML = '';
    if (delegations.length < (totalDelegatorCount - 1)) {
        footerEl.innerHTML = `<div class="flex justify-center"><button id="load-more-delegators-btn" class="bg-[#2C2C2C] hover:bg-[#3A3A3A] text-white font-medium py-2.5 px-8 rounded-lg transition-colors text-sm">Load More</button></div>`;
    }
}

export function renderSponsorshipsHistory(historyGroups, showLoadAllButton = true) {
    const listEl = document.getElementById('sponsorships-history-list');
    if (!listEl) return;

    if (historyGroups.length === 0) {
        listEl.innerHTML = '<li class="text-gray-500 text-sm p-4 text-center">No recent activity found from The Graph or Polygonscan.</li>';
        return;
    }

    let html = historyGroups.map(group => {
        const date = new Date(group.timestamp * 1000).toLocaleString();

        const graphEventsHtml = group.events.filter(e => e.type === 'graph').map(event => {
            const sp = event.relatedObject;
            if (!sp) return '';
            const sponsorshipUrl = `https://streamr.network/hub/network/sponsorships/${sp.id}`;
            const sponsorshipDisplayText = escapeHtml(sp.stream?.id || sp.id);
            const link = `<a href="${sponsorshipUrl}" target="_blank" rel="noopener noreferrer" class="text-gray-300 hover:text-white transition-colors" title="${sponsorshipDisplayText}">${sponsorshipDisplayText}</a>`;
            const text = `Action on ${link}`;
            const icon = '<svg class="w-5 h-5 text-gray-400" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"></path></svg>';

            return `
            <div class="flex items-start gap-3 py-2">
                <div class="flex-shrink-0 pt-1">${icon}</div>
                <div class="flex-1 min-w-0">
                    <p class="text-sm text-gray-300 truncate">${text}</p>
                </div>
                <div class="text-right flex-shrink-0">
                    <p class="font-mono text-sm text-white" ${event.token.toUpperCase() === 'DATA' ? `data-tooltip-value="${Math.round(event.amount)}"` : ''}>${formatBigNumber(Math.round(event.amount).toString())} ${escapeHtml(event.token)}</p>
                </div>
            </div>`;
        }).join('');

        const scanEventsHtml = group.events.filter(e => e.type === 'scan').map(event => {
            
            let directionClass;
            const method = event.methodId;
            const stakeInMethods = ["Stake", "Unstake", "Force Unstake", "Reduce Stake"];
            const redMethods = ["Undelegate", "Protocol Tax"];

            if (redMethods.includes(method)) {
                directionClass = "tx-badge-out";
            } else if (stakeInMethods.includes(method)) {
                directionClass = "tx-badge-stake";
            } else if (event.relatedObject === "OUT") {
                directionClass = "tx-badge-out";
            } else {
                directionClass = "tx-badge-in";
            }
            
            const txUrl = `https://polygonscan.com/tx/${event.txHash}`;

            return `
            <div class="flex items-center gap-3 py-2">
                <div class="flex-shrink-0">
                    <span class="tx-badge ${directionClass}">${event.relatedObject}</span>
                </div>
                <div class="flex-1 min-w-0">
                    <a href="${txUrl}" target="_blank" rel="noopener noreferrer" class="text-sm font-medium text-gray-300 hover:text-white truncate transition-colors block">
                        ${escapeHtml(event.methodId)}
                    </a>
                </div>
                <div class="text-right flex-shrink-0">
                    <p class="font-mono text-sm text-white" ${event.token.toUpperCase() === 'DATA' ? `data-tooltip-value="${Math.round(event.amount)}"` : ''}>${formatBigNumber(Math.round(event.amount).toString())} ${escapeHtml(event.token)}</p>
                </div>
            </div>`;
        }).join('');

        const hasGraphEvents = graphEventsHtml.length > 0;
        const hasScanEvents = scanEventsHtml.length > 0;

        return `
        <li class="py-3 border-b border-[#333333]">
            <p class="text-xs text-gray-400 font-mono mb-2">${date}</p>
            <div>
                ${hasGraphEvents ? `
                    <div>
                        <h4 class="text-sm font-semibold text-white mb-1">Sponsorship Actions</h4>
                        <div class="pl-4 border-l-2 border-gray-700">${graphEventsHtml}</div>
                    </div>
                ` : ''}
                
                ${hasScanEvents ? `
                    <div class="${hasGraphEvents ? 'mt-2' : ''}">
                         <div class="pl-4">${scanEventsHtml}</div>
                    </div>
                ` : ''}
            </div>
        </li>`;
    }).join('');
    
    if (showLoadAllButton) {
        html += `
            <li id="load-all-history-container" class="py-4 text-center">
                <button id="load-all-history-btn" 
                        class="bg-[#2C2C2C] hover:bg-[#3C3C3C] text-white font-medium py-2.5 px-6 rounded-lg text-sm transition-colors inline-flex items-center gap-2">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path>
                    </svg>
                    Load All History
                </button>
                <p class="text-xs text-gray-500 mt-2">Showing recent activity. Click to load complete history.</p>
            </li>`;
    }
    
    listEl.innerHTML = html;
}

export function renderStakeChart(chartData, isUsdView) {
    const container = document.getElementById('stake-chart-container');
    if (!container) return;

    // Destroy other chart types first
    if (operatorEarningsChart) {
        operatorEarningsChart.destroy();
        operatorEarningsChart = null;
    }

    if (!chartData || chartData.length === 0) {
        if (stakeHistoryChart) {
            stakeHistoryChart.destroy();
            stakeHistoryChart = null;
        }
        container.innerHTML = '<div class="flex items-center justify-center h-full"><p class="text-gray-500">No daily data available for this timeframe.</p></div>';
        return;
    }

    const labels = chartData.map(d => d.label);
    const data = chartData.map(d => d.value);

    const chartLabel = isUsdView ? 'Total Stake (USD)' : 'Total Stake (DATA)';
    const yAxisPrefix = isUsdView ? '$' : '';
    const yAxisSuffix = isUsdView ? '' : ' DATA';

    // Função auxiliar para criar o gradiente
    const createGradient = (ctx) => {
        const gradient = ctx.createLinearGradient(0, 0, 0, 300);
        gradient.addColorStop(0, 'rgba(59, 130, 246, 0.5)'); // Top color
        gradient.addColorStop(1, 'rgba(59, 130, 246, 0.0)'); // Bottom transparency
        return gradient;
    };

    // Configurações de estilo (Options)
    const chartOptions = {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
            mode: 'index',
            intersect: false,
        },
        plugins: {
            legend: {
                display: false
            },
            tooltip: {
                backgroundColor: 'rgba(30, 30, 30, 0.9)', // Fundo escuro minimalista 
                titleColor: '#ffffff',
                bodyColor: '#9ca3af', // Gray-400
                borderColor: '#333333',
                borderWidth: 1,
                padding: 10,
                cornerRadius: 8,
                displayColors: false, // Remove caixa de cor
                titleFont: {
                    family: "'Inter', sans-serif",
                    size: 13,
                    weight: '600'
                },
                bodyFont: {
                    family: "'Inter', sans-serif",
                    size: 13
                },
                callbacks: {
                    label: function (context) {
                        let label = '';
                        if (context.parsed.y !== null) {
                            label += yAxisPrefix + formatBigNumber(Math.round(context.parsed.y).toString()) + yAxisSuffix;
                        }
                        return label;
                    }
                }
            }
        },
        scales: {
            x: {
                ticks: {
                    color: '#6b7280', // Gray-500
                    maxTicksLimit: 8,
                    maxRotation: 0,
                    autoSkip: true,
                    font: {
                        family: "'Inter', sans-serif",
                        size: 11
                    }
                },
                grid: {
                    display: false // Remove grelha vertical
                }
            },
            y: {
                position: 'left',
                ticks: {
                    color: '#6b7280', // Gray-500
                    callback: function (value) {
                        if (value >= 1000000) return yAxisPrefix + (value / 1000000).toFixed(1) + 'M';
                        if (value >= 1000) return yAxisPrefix + (value / 1000).toFixed(0) + 'K';
                        return yAxisPrefix + Math.round(value);
                    },
                    font: {
                        family: "'Inter', sans-serif",
                        size: 11
                    }
                },
                grid: {
                    color: '#333333',
                    borderDash: [4, 4], // Grelha horizontal tracejada subtil
                    drawBorder: false
                }
            }
        }
    };

    // Always destroy and recreate to avoid stale data issues
    if (stakeHistoryChart) {
        stakeHistoryChart.destroy();
        stakeHistoryChart = null;
    }
    
    container.innerHTML = '<canvas id="stake-history-chart"></canvas>';
    const canvas = document.getElementById('stake-history-chart');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    stakeHistoryChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: chartLabel,
                data: data,
                backgroundColor: createGradient(ctx),
                borderColor: '#3b82f6', // Blue-500
                borderWidth: 2,
                pointBackgroundColor: '#3b82f6',
                pointBorderColor: '#232c45ff', 
                pointBorderWidth: 0.5,
                pointRadius: 2.5,
                pointHoverRadius: 4,
                tension: 0.25, 
                fill: true
            }]
        },
        options: chartOptions
    });
}

// Operator Earnings Chart instance
let operatorEarningsChart = null;

/**
 * Render Operator Earnings Chart (daily bars + cumulative line)
 */
export function renderOperatorEarningsChart(labels, dailyData, cumulativeData, isUsdView, currentPrice) {
    const container = document.getElementById('stake-chart-container');
    if (!container) return;

    if (operatorEarningsChart) {
        operatorEarningsChart.destroy();
        operatorEarningsChart = null;
    }
    if (stakeHistoryChart) {
        stakeHistoryChart.destroy();
        stakeHistoryChart = null;
    }

    if (!labels || labels.length === 0) {
        container.innerHTML = '<div class="flex items-center justify-center h-full"><p class="text-gray-500">No earnings data available for this timeframe.</p></div>';
        return;
    }

    container.innerHTML = '<canvas id="stake-history-chart"></canvas>';
    const canvas = document.getElementById('stake-history-chart');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const yAxisPrefix = isUsdView ? '$' : '';
    const yAxisSuffix = isUsdView ? '' : ' DATA';

    operatorEarningsChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                { 
                    label: 'Daily', 
                    data: dailyData, 
                    backgroundColor: 'rgba(59, 130, 246, 0.5)', 
                    borderRadius: 2, 
                    yAxisID: 'y',
                    order: 2
                },
                { 
                    label: 'Total', 
                    data: cumulativeData, 
                    type: 'line', 
                    borderColor: '#3b82f6',
                    borderWidth: 2,
                    pointBackgroundColor: '#3b82f6',
                    pointBorderColor: '#232c45ff',
                    pointBorderWidth: 0.5,
                    pointRadius: 2.5,
                    pointHoverRadius: 4,
                    tension: 0.25,
                    fill: false,
                    yAxisID: 'y1',
                    order: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'nearest',
                intersect: true,
            },
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
                            // Format DATA value with appropriate decimals
                            const formatted = formatBigNumber(Math.round(value).toString());
                            lines.push(`${formatted} DATA`);
                            // Show USD using live current price
                            if (currentPrice && currentPrice > 0) {
                                const usdValue = value * currentPrice;
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
                            if (value >= 1000000) return yAxisPrefix + (value / 1000000).toFixed(1) + 'M';
                            if (value >= 1000) return yAxisPrefix + (value / 1000).toFixed(0) + 'K';
                            return yAxisPrefix + Math.round(value) + yAxisSuffix;
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
                            if (value >= 1000000) return yAxisPrefix + (value / 1000000).toFixed(1) + 'M';
                            if (value >= 1000) return yAxisPrefix + (value / 1000).toFixed(0) + 'K';
                            return yAxisPrefix + Math.round(value);
                        }
                    }, 
                    border: { display: false } 
                },
                x: { 
                    grid: { display: false }, 
                    ticks: { 
                        color: '#6b7280', 
                        maxTicksLimit: 8, 
                        maxRotation: 0,
                        font: { family: "'Inter', sans-serif", size: 11 } 
                    }, 
                    border: { display: false } 
                }
            }
        }
    });
}

export function populateOperatorSettingsModal(operatorData) {
    const { name, description } = parseOperatorMetadata(operatorData.metadataJsonString);
    let redundancyFactor = '1';
    try {
        if (operatorData.metadataJsonString) {
            const meta = JSON.parse(operatorData.metadataJsonString);
            if (meta && meta.redundancyFactor !== undefined) {
                redundancyFactor = meta.redundancyFactor;
            }
        }
    } catch (e) { /* ignore */ }

    const ownersCutPercent = (BigInt(operatorData.operatorsCutFraction) * 100n) / BigInt('1000000000000000000');

    operatorSettingsModalNameInput.value = name || '';
    operatorSettingsModalDescriptionInput.value = description || '';
    operatorSettingsModalCutInput.value = ownersCutPercent.toString();
    operatorSettingsModalRedundancyInput.value = redundancyFactor;
    
    document.getElementById('operator-settings-modal-confirm').disabled = false;
    operatorSettingsModal.classList.remove('hidden');
}


export function renderOperatorDetails(data, globalState) {
    if (stakeHistoryChart) {
        stakeHistoryChart.destroy();
        stakeHistoryChart = null;
    }

    const { operator: op, selfDelegation: selfDelegationData, flagsAgainst, flagsAsFlagger, slashingEvents } = data;
    if (!op) {
        detailContent.innerHTML = '<p class="text-gray-500">Operator not found.</p>';
        return;
    }

    let { name, description, imageUrl } = parseOperatorMetadata(op.metadataJsonString);
    if (imageUrl && !imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
        imageUrl = null;
    }
    const safeOperatorName = escapeHtml(name || op.id);
    const placeholderUrl = 'https://placehold.co/80x80/1E1E1E/a3a3a3?text=OP';

    let redundancyFactor = '1 (Default)';
    try {
        if (op.metadataJsonString) {
            const meta = JSON.parse(op.metadataJsonString);
            if (meta && meta.redundancyFactor !== undefined) {
                redundancyFactor = meta.redundancyFactor;
            }
        }
    } catch (e) { console.error("Could not parse redundancy factor from metadata", e); }


    const apy = calculateWeightedApy(op.stakes);
    const roundedApy = Math.round(apy * 100);
    const apyColorClass = roundedApy === 0 ? 'text-red-400' : 'text-green-400';
    const ownersCutPercent = (BigInt(op.operatorsCutFraction) * 100n) / BigInt('1000000000000000000');
    
    const isOwner = globalState.myRealAddress && op.owner && globalState.myRealAddress.toLowerCase() === op.owner.toLowerCase();
    const editSettingsButtonHtml = isOwner ? `
        <div class="mb-4">
            <button id="edit-operator-settings-btn" class="bg-gray-700 hover:bg-gray-600 text-white font-bold py-2 px-4 rounded-lg transition-colors flex items-center text-sm">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                  <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                </svg>
                Edit Settings
            </button>
        </div>
    ` : '';

    const headerStatsHtml = `
        <div class="detail-section px-4 sm:px-6 pt-4 sm:pt-6 pb-2">
            <div class="flex items-start gap-4 sm:gap-6">
                <img src="${imageUrl || placeholderUrl}" loading="lazy" onerror="this.src='${placeholderUrl}';" alt="Operator Avatar" class="w-14 h-14 sm:w-20 sm:h-20 rounded-full border-2 border-[#333333] flex-shrink-0 object-cover" ${description ? `data-tooltip-content="${escapeHtml(description)}"` : ''}>
                <div class="flex-1 min-w-0">
                    <h2 class="text-lg sm:text-2xl lg:text-3xl font-bold text-white break-words" ${description ? `data-tooltip-content="${escapeHtml(description)}"` : ''}>${safeOperatorName}</h2>
                    ${name ? `<div class="font-mono text-xs sm:text-sm text-gray-400 mt-1 break-all">${createAddressLink(op.id)}</div>` : ''}
                </div>
                <div class="flex-shrink-0 text-right">
                    <p class="text-xs sm:text-sm text-gray-400 font-semibold mb-1">APY</p>
                    <p class="text-2xl sm:text-3xl lg:text-4xl font-extrabold text-green-400 whitespace-nowrap">${Math.round(apy * 100)}%</p>
                </div>
            </div>
            <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-6 mt-4 sm:mt-6">
                <div><p class="text-xs sm:text-sm text-gray-400">Stake (DATA)</p><p id="header-stat-stake" class="text-lg sm:text-2xl font-semibold text-white"></p></div>
                <div><p class="text-xs sm:text-sm text-gray-400">Total Earnings (DATA)</p><p id="header-stat-earnings" class="text-lg sm:text-2xl font-semibold text-white"></p></div>
                <div><p class="text-xs sm:text-sm text-gray-400">% Owner's Cut</p><p id="header-stat-cut" class="text-lg sm:text-2xl font-semibold text-white"></p></div>
                <div><p class="text-xs sm:text-sm text-gray-400">Nodes</p><p id="active-nodes-stats-value" class="text-lg sm:text-2xl font-semibold text-white">0</p></div>
            </div>
            <div id="extended-stats" class="hidden mt-4 sm:mt-6">
                <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-6">
                    <div><p class="text-xs sm:text-sm text-gray-400">Total Distributed (DATA)</p><p id="extended-stat-distributed" class="text-lg sm:text-2xl font-semibold text-white"></p></div>
                    <div><p class="text-xs sm:text-sm text-gray-400">Owner's Earnings from Cut (DATA)</p><p id="extended-stat-owner-cut" class="text-lg sm:text-2xl font-semibold text-white"></p></div>
                    <div><p class="text-xs sm:text-sm text-gray-400">Deployed Stake (DATA)</p><p id="extended-stat-deployed" class="text-lg sm:text-2xl font-semibold text-white"></p></div>
                    <div><p class="text-xs sm:text-sm text-gray-400">% Owner's Stake</p><p id="extended-stat-owner-stake" class="text-lg sm:text-2xl font-semibold text-white"></p></div>
                </div>
            </div>
            <div class="mt-4 text-center"><button id="toggle-stats-btn" class="text-gray-400 hover:text-white transition"><svg id="stats-arrow" class="w-6 h-6 mx-auto transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 9l-7 7-7-7"></path></svg></button></div>
        </div>
        
        <div class="detail-section p-6 mt-8">
            <div class="flex flex-col gap-2 mb-4">
                <div class="flex justify-between items-center flex-wrap gap-2">
                    <div id="chart-type-tabs" class="flex bg-[#2C2C2C] p-1 rounded-lg">
                        <button data-chart-type="stake" class="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-800 text-white transition-colors">Stake</button>
                        <button data-chart-type="earnings" class="px-3 py-1.5 text-xs font-medium rounded-md text-gray-400 hover:text-white transition-colors">Earnings</button>
                    </div>
                    <div id="chart-view-buttons" class="flex items-center gap-1 bg-[#2C2C2C] p-1 rounded-lg">
                        <button data-view="data" class="px-3 py-1 text-xs font-bold rounded-md hover:bg-[#444444] transition">DATA</button>
                        <button data-view="usd" class="px-3 py-1 text-xs font-bold rounded-md hover:bg-[#444444] transition">USD</button>
                    </div>
                    <span id="chart-info-tooltip" class="relative group cursor-help hidden">
                        <svg class="w-4 h-4 text-gray-500 hover:text-gray-400 transition-colors" fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/>
                        </svg>
                        <span class="absolute bottom-full right-0 mb-2 px-3 py-2 text-xs font-normal text-gray-300 bg-[#1a1a1a] border border-[#333] rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
                            USD values based on current price
                        </span>
                    </span>
                </div>
                <div class="flex justify-end">
                    <div id="chart-timeframe-buttons" class="flex items-center gap-1 bg-[#2C2C2C] p-1 rounded-lg">
                        <button data-days="30" class="px-3 py-1 text-xs font-bold rounded-md hover:bg-[#444444] transition">30D</button>
                        <button data-days="90" class="px-3 py-1 text-xs font-bold rounded-md hover:bg-[#444444] transition">90D</button>
                        <button data-days="365" class="px-3 py-1 text-xs font-bold rounded-md hover:bg-[#444444] transition">1Y</button>
                        <button data-days="all" class="px-3 py-1 text-xs font-bold rounded-md hover:bg-[#444444] transition">All</button>
                    </div>
                </div>
            </div>
            <div id="stake-chart-container" class="h-64">
                <canvas id="stake-history-chart"></canvas>
            </div>
        </div>

        <div id="my-stake-section" class="detail-section p-4 sm:p-6 hidden">
             <h3 class="text-lg sm:text-xl font-semibold text-white mb-4">Your Stake</h3>
             <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                 <div><p class="text-2xl sm:text-3xl font-semibold text-white" id="my-stake-value" data-tooltip-value="0">Loading...</p></div>
                 <div class="flex gap-2 sm:gap-4">
                     <button id="delegate-btn" class="flex-1 sm:flex-none bg-blue-800 hover:bg-blue-900 text-white font-bold py-2.5 px-4 sm:px-6 rounded-lg transition-colors text-sm sm:text-base">Delegate</button>
                     <button id="undelegate-btn" class="flex-1 sm:flex-none bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 px-4 sm:px-6 rounded-lg transition-colors text-sm sm:text-base">Undelegate</button>
                 </div>
             </div>
        </div>`;

    const isAgent = globalState.myRealAddress && op.controllers?.some(agent => agent.toLowerCase() === globalState.myRealAddress.toLowerCase());

    const sponsorshipsHtml = op.stakes?.length > 0 ? op.stakes.map(stake => {
        const sp = stake.sponsorship;
        if (!sp) return '';
        const sponsorshipUrl = `https://streamr.network/hub/network/sponsorships/${sp.id}`;
        const sponsorshipDisplayText = escapeHtml(sp.stream?.id || sp.id);
        const editStakeLink = isAgent
            ? `<a href="#" class="block px-4 py-2 text-sm text-gray-200 hover:bg-[#444444] edit-stake-link" data-sponsorship-id="${sp.id}" data-current-stake="${stake.amountWei}">Edit Stake</a>`
            : `<span class="block px-4 py-2 text-sm text-gray-500 opacity-50 cursor-not-allowed" data-tooltip-content="You must be an agent for this operator to edit stake.">Edit Stake</span>`;

        return `
            <li class="relative flex justify-between items-center py-3 border-b border-[#333333]">
                <div class="flex-1 min-w-0">
                    <a href="${sponsorshipUrl}" target="_blank" rel="noopener noreferrer" class="font-mono text-xs text-gray-300 hover:text-white transition-colors truncate block" title="${sponsorshipDisplayText}">${sponsorshipDisplayText}</a>
                    <div class="text-xs mt-2 space-y-1">
                        <div class="flex justify-between items-center"><span class="text-gray-400">Staked:</span><strong class="text-white font-mono" data-tooltip-value="${convertWeiToData(stake.amountWei)}">${formatBigNumber(convertWeiToData(stake.amountWei))} DATA</strong></div>
                        <div class="flex justify-between items-center"><span class="text-gray-400">APY:</span><strong class="text-green-400 font-mono">${Math.round(Number(sp.spotAPY) * 100)}%</strong></div>
                        <div class="flex justify-between items-center"><span class="text-gray-400">Status:</span><strong class="${sp.isRunning ? 'text-green-400' : 'text-red-400'} font-semibold">${sp.isRunning ? 'Active' : 'Inactive'}</strong></div>
                    </div>
                </div>
                <div class="flex-shrink-0 ml-4">
                        <button class="text-gray-400 hover:text-white p-1 toggle-sponsorship-menu-btn" data-sponsorship-id="${sp.id}"><svg class="h-5 w-5 pointer-events-none" viewBox="0 0 20 20" fill="currentColor"><path d="M7 10l5 5 5-5H7z"/></svg></button>
                    <div id="sponsorship-menu-${sp.id}" class="hidden absolute right-0 w-48 bg-[#2C2C2C] border border-[#333333] rounded-md shadow-lg z-20">
                        ${editStakeLink}
                        <a href="#" class="block px-4 py-2 text-sm text-gray-200 hover:bg-[#444444] collect-earnings-link" data-sponsorship-id="${sp.id}">Collect Earnings</a>
                    </div>
                </div>
            </li>`;
    }).join('') : '<li class="text-gray-500 text-sm">Not participating in any sponsorships.</li>';

    const slashesHtml = slashingEvents.length > 0 ? slashingEvents.map(slash => {
        const sp = slash.sponsorship;
        let sponsorshipHtml = '<p class="text-xs text-gray-400">Sponsorship: Unknown</p>';
        if (sp) {
            const sponsorshipUrl = `https://streamr.network/hub/network/sponsorships/${sp.id}`;
            const sponsorshipDisplayText = escapeHtml(sp.stream?.id || sp.id);
            sponsorshipHtml = `<p class="text-xs text-gray-400 truncate">Sponsorship: <a href="${sponsorshipUrl}" target="_blank" rel="noopener noreferrer" class="text-gray-300 hover:text-white transition-colors" title="${sponsorshipDisplayText}">${sponsorshipDisplayText}</a></p>`;
        }
        const slashDate = new Date(slash.date * 1000);
        const slashDateStr = slashDate.toLocaleDateString() + ', ' + slashDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        return `
            <li class="py-3 border-b border-[#333333]">
                <p class="text-xs text-gray-400 mb-1">Date: <span class="text-gray-300">${slashDateStr}</span></p>
                <p class="text-xs text-gray-400 mb-1">Slash: <span class="font-mono text-red-400 font-semibold" data-tooltip-value="${convertWeiToData(slash.amount)}">${formatBigNumber(convertWeiToData(slash.amount))} DATA</span></p>
                ${sponsorshipHtml}
            </li>`;
        }).join('') : '<li class="text-gray-500 text-sm">No slashing events recorded.</li>';

    const agentsHtml = op.controllers?.length > 0 ? op.controllers.map(agent => `
        <li class="flex justify-between items-center py-2 border-b border-[#333333]">
            <div class="font-mono text-xs text-gray-300 truncate">${createAddressLink(agent)}</div>
            <div class="flex items-center gap-2">
                <span id="agent-balance-${agent}" class="font-mono text-xs text-gray-300 text-right" title="POL Balance">...</span>
                ${op.owner && agent.toLowerCase() === op.owner.toLowerCase() ? `<div class="flex items-center" title="Owner"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd" /></svg></div>` : ''}
            </div>
        </li>`).join('') : '<li class="text-gray-500 text-sm">No agents assigned.</li>';

    const nodesHtml = op.nodes?.length > 0 ? op.nodes.map(nodeId => `
        <li class="flex justify-between items-center py-2 border-b border-[#333333]">
            <div class="font-mono text-xs text-gray-300 truncate">${createAddressLink(nodeId)}</div>
            <span id="node-balance-${nodeId}" class="font-mono text-xs text-gray-300 text-right" title="POL Balance">...</span>
        </li>`).join('') : '<li class="text-gray-500 text-sm">No nodes running.</li>';

    const queueHtml = op.queueEntries?.length > 0 ? op.queueEntries.map(entry => `
            <li class="py-2 border-b border-[#333333]">
            <div class="flex justify-between items-center">
                <div class="font-mono text-xs text-gray-300 truncate">${createAddressLink(entry.delegator.id)}</div>
                <p class="font-mono text-xs text-orange-400 font-semibold" data-tooltip-value="${convertWeiToData(entry.amount)}">${formatBigNumber(convertWeiToData(entry.amount))} DATA</p>
            </div>
            <div class="text-xs mt-1 text-gray-400"><p>Queued: ${new Date(entry.date * 1000).toLocaleString()}</p></div>
        </li>`).join('') : '<li class="text-gray-500 text-sm">The undelegation queue is empty.</li>';

    const createFlagHtml = (flag, isTarget) => {
        const sponsorshipUrl = `https://streamr.network/hub/network/sponsorships/${flag.sponsorship.id}`;
        const sponsorshipDisplayText = escapeHtml(flag.sponsorship.stream?.id || flag.sponsorship.id);
        const votesHtml = flag.votes.map(vote => `
            <li class="flex justify-between items-center text-xs py-1">
                <span>${createEntityLink(vote.voter)}</span>
                <div class="flex items-center gap-2">
                    <span class="font-mono" data-tooltip-value="${convertWeiToData(vote.voterWeight)}">${formatBigNumber(convertWeiToData(vote.voterWeight))}</span>
                    <span class="${vote.votedKick ? 'text-red-400' : 'text-green-400'} font-semibold">${vote.votedKick ? 'Kick' : 'Keep'}</span>
                </div>
            </li>
        `).join('');

        let resultText = flag.result || 'Pending';
        if (resultText.toUpperCase() === 'FAILED' || resultText.toUpperCase() === 'VOTE_FAILED') {
            resultText = 'False Flag';
        }

        const flagPartyText = isTarget
            ? `Flagged by: ${createEntityLink(flag.flagger)}`
            : `Flagged: ${createEntityLink(flag.target)}`;
			
		const flagDateObj = new Date(flag.flaggingTimestamp * 1000);
		const flagDate = flagDateObj.toLocaleDateString() + ', ' + flagDateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        return `
            <div class="flex justify-between items-center">
                <div>
				    <p class="text-xs text-gray-400 font-mono mb-1">${flagDate}</p>
                    <p class="text-xs text-gray-400">${flagPartyText}</p>
                    <p class="text-xs text-gray-400 truncate">Sponsorship: <a href="${sponsorshipUrl}" target="_blank" rel="noopener noreferrer" class="text-gray-300 hover:text-white transition-colors" title="${sponsorshipDisplayText}">${sponsorshipDisplayText}</a></p>
                        <p class="text-xs text-gray-400">Result: <span class="font-semibold">${resultText}</span></p>
                </div>
                <button class="text-gray-400 hover:text-white p-1 toggle-vote-list-btn" data-flag-id="${flag.id}"><svg class="w-5 h-5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 9l-7 7-7-7"></path></svg></button>
            </div>
            <ul id="votes-${flag.id}" class="hidden mt-2 pl-4 border-l-2 border-gray-700">${votesHtml || '<li class="text-xs text-gray-500">No votes.</li>'}</ul>`;
    };

    const flagsAgainstHtml = flagsAgainst?.length > 0 ? flagsAgainst.map(flag => `<li class="py-2 border-b border-[#333333]">${createFlagHtml(flag, true)}</li>`).join('') : '<li class="text-gray-500 text-sm">No flags recorded against this operator.</li>';
    const flagsByHtml = flagsAsFlagger?.length > 0 ? flagsAsFlagger.map(flag => `<li class="py-2 border-b border-[#333333]">${createFlagHtml(flag, false)}</li>`).join('') : '<li class="text-gray-500 text-sm">This operator has not flagged anyone.</li>';

    const listsHtml = `
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-8 mt-8">
            <!-- Delegators Card with Pills -->
            <div class="detail-section p-4 sm:p-6">
                <div class="flex items-center justify-between gap-3 mb-4">
                    <h3 class="text-lg sm:text-xl font-semibold text-white">Delegations</h3>
                    <div id="delegator-tabs" class="flex bg-[#2C2C2C] p-1 rounded-lg flex-shrink-0">
                        <button data-tab="delegators" class="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-800 text-white transition-colors">
                            Delegators <span class="opacity-70">(${op.delegatorCount > 0 ? op.delegatorCount - 1 : 0})</span>
                        </button>
                        <button data-tab="queue" class="px-3 py-1.5 text-xs font-medium rounded-md text-gray-400 hover:text-white transition-colors">
                            Queue <span class="opacity-70">(${op.queueEntries?.length || 0})</span>
                        </button>
                    </div>
                </div>
                <div id="delegators-content"><ul id="delegators-list" class="max-h-96 overflow-y-auto pr-2"></ul><div id="delegators-footer" class="mt-4"></div></div>
                <div id="queue-content" class="hidden">
                    ${op.queueEntries?.length > 0 ? `<button id="process-queue-btn" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-4 rounded-lg text-sm mb-4">Process Queue</button>` : ''}
                    <ul class="max-h-96 overflow-y-auto pr-2">${queueHtml}</ul>
                </div>
            </div>

            <!-- Sponsorships Card with Pills -->
            <div class="detail-section p-4 sm:p-6">
                <div class="flex items-center justify-between gap-3 mb-4">
                    <h3 class="text-lg sm:text-xl font-semibold text-white">Sponsorships</h3>
                    <div id="sponsorship-tabs" class="flex bg-[#2C2C2C] p-1 rounded-lg flex-shrink-0">
                        <button data-tab="list" class="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-800 text-white transition-colors">
                            Active <span class="opacity-70">(${op.stakes?.length || 0})</span>
                        </button>
                        <button data-tab="history" class="px-3 py-1.5 text-xs font-medium rounded-md text-gray-400 hover:text-white transition-colors">
                            History
                        </button>
                    </div>
                </div>
                <div id="sponsorships-list-content">
                    <ul class="max-h-96 overflow-y-auto pr-2">${sponsorshipsHtml}</ul>
                    <div class="mt-4 flex justify-center">
                        ${op.stakes?.length > 0 ? `<button id="collect-all-earnings-btn" class="bg-blue-800 hover:bg-blue-900 text-white font-medium py-2.5 px-8 rounded-lg text-sm">Collect All</button>` : ''}
                    </div>
                </div>
                <div id="sponsorships-history-content" class="hidden">
                    <ul id="sponsorships-history-list" class="max-h-96 overflow-y-auto pr-2"></ul>
                </div>
            </div>

            <!-- Reputation Card with Dropdown -->
            <div class="detail-section p-4 sm:p-6 lg:col-span-2">
                <div class="flex items-center justify-between gap-3 mb-4">
                    <h3 class="text-lg sm:text-xl font-semibold text-white">Reputation</h3>
                    <div class="relative flex-shrink-0">
                        <button id="reputation-dropdown-btn" class="flex items-center gap-2 bg-[#2C2C2C] px-3 py-1.5 rounded-lg text-xs font-medium text-white hover:bg-[#3C3C3C] transition-colors min-w-[160px] justify-between">
                            <span id="reputation-dropdown-text">Slashing Events (${slashingEvents.length})</span>
                            <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                        </button>
                        <div id="reputation-dropdown-menu" class="hidden absolute right-0 mt-1 w-48 bg-[#2C2C2C] border border-[#444444] rounded-lg shadow-xl z-20 overflow-hidden">
                            <button data-view="slashing" class="w-full px-3 py-2 text-left text-xs text-white hover:bg-[#3C3C3C] transition-colors bg-blue-800/30">
                                Slashing Events <span class="opacity-70">(${slashingEvents.length})</span>
                            </button>
                            <button data-view="flags-against" class="w-full px-3 py-2 text-left text-xs text-gray-300 hover:bg-[#3C3C3C] transition-colors">
                                Flags Against <span class="opacity-70">(${flagsAgainst?.length || 0})</span>
                            </button>
                            <button data-view="flags-by" class="w-full px-3 py-2 text-left text-xs text-gray-300 hover:bg-[#3C3C3C] transition-colors">
                                Flags Initiated <span class="opacity-70">(${flagsAsFlagger?.length || 0})</span>
                            </button>
                        </div>
                    </div>
                </div>
                <div id="reputation-content-wrapper" 
                    data-slashes-count="${slashingEvents.length}" 
                    data-flags-against-count="${flagsAgainst?.length || 0}" 
                    data-flags-by-count="${flagsAsFlagger?.length || 0}">
                    <div id="slashing-content"><ul class="max-h-96 overflow-y-auto pr-2">${slashesHtml}</ul></div>
                    <div id="flags-against-content" class="hidden"><ul class="max-h-96 overflow-y-auto pr-2">${flagsAgainstHtml}</ul></div>
                    <div id="flags-by-content" class="hidden"><ul class="max-h-96 overflow-y-auto pr-2">${flagsByHtml}</ul></div>
                </div>
            </div>

            <!-- Wallets Card with Pills -->
            <div class="detail-section p-4 sm:p-6 lg:col-span-2">
                <div class="flex items-center justify-between gap-3 mb-4">
                    <h3 class="text-lg sm:text-xl font-semibold text-white">Wallets</h3>
                    <div id="wallets-tabs" class="flex bg-[#2C2C2C] p-1 rounded-lg flex-shrink-0">
                        <button data-tab="agents" class="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-800 text-white transition-colors">
                            Agents <span class="opacity-70">(${op.controllers?.length || 0})</span>
                        </button>
                        <button data-tab="nodes" class="px-3 py-1.5 text-xs font-medium rounded-md text-gray-400 hover:text-white transition-colors">
                            Nodes <span class="opacity-70">(${op.nodes?.length || 0})</span>
                        </button>
                    </div>
                </div>
                <div id="agents-content" data-agents-count="${op.controllers?.length || 0}"><ul class="max-h-96 overflow-y-auto pr-2">${agentsHtml}</ul></div>
                <div id="nodes-content" class="hidden" data-nodes-count="${op.nodes?.length || 0}"><ul class="max-h-96 overflow-y-auto pr-2">${nodesHtml}</ul></div>
            </div>
        </div>`;

    const streamHtml = `
        <div class="detail-section p-6 mt-8">
            <div class="flex items-center justify-between mb-4 flex-wrap gap-y-2">
                <h3 class="text-xl font-semibold text-white">Coordination Stream</h3>
                <div class="flex items-center gap-2 text-sm">
                    <div class="flex items-center gap-2" title="Awaiting connection..."><div id="stream-status-indicator" class="w-3 h-3 rounded-full bg-gray-500"></div></div>
                    <div class="bg-[#2C2C2C] text-gray-200 font-semibold px-3 py-1 rounded-lg">Active Nodes: <span id="active-nodes-count-value" class="text-white font-bold">0</span></div>
                    <div id="unreachable-nodes-container" class="hidden bg-[#2C2C2C] text-gray-200 font-semibold px-3 py-1 rounded-lg" title="Nodes that are active but may not be reachable by all peers.">Unreachable: <span id="unreachable-nodes-count-value" class="text-orange-400 font-bold">0</span></div>
                    <div class="bg-[#2C2C2C] text-gray-200 font-semibold px-3 py-1 rounded-lg">Redundancy: <span class="text-white font-bold">${escapeHtml(String(redundancyFactor))}</span></div>
                </div>
            </div>
            <div id="stream-messages-container" class="max-h-96 overflow-y-auto pr-2 bg-black/50 p-2"><div class="text-gray-500 text-sm text-center py-4">Live messages will appear here.</div></div>
        </div>
        
        <!-- Node Map -->
        <div class="detail-section p-6 mt-8">
            <div id="node-map-container" class="h-96 w-full rounded-lg bg-black/50" style="z-index: 0;">
                <div class="text-gray-500 text-sm text-center py-4">Initializing map...</div>
            </div>
        </div>
        `;


    detailContent.innerHTML = editSettingsButtonHtml + headerStatsHtml + listsHtml + streamHtml;

    updateOperatorDetails(data, globalState);
    updateDelegatorsSection(globalState.currentDelegations, globalState.totalDelegatorCount, data.operator);

    toggleStatsPanel(true, globalState.uiState);

    // Initialize the Leaflet map
    initLeafletMap('node-map-container');
}


export function updateOperatorDetails(data, globalState) {
    const { operator: op, selfDelegation: selfDelegationData } = data;
    if (!op) return;

    const selfDelegation = selfDelegationData?.[0];

    const totalStakeWei = BigInt(op.valueWithoutEarnings);
    const totalEarningsWei = BigInt(op.cumulativeEarningsWei);
    const ownerCutWei = BigInt(op.cumulativeOperatorsCutWei);
    const operatorsOwnStakeWei = selfDelegation ? BigInt(selfDelegation._valueDataWei) : 0n;
    const distributedToDelegatorsWei = totalEarningsWei - ownerCutWei;
    const ownersCutPercent = (BigInt(op.operatorsCutFraction) * 100n) / BigInt('1000000000000000000');
    const ownersStakePercent = totalStakeWei > 0n ? Number((operatorsOwnStakeWei * 10000n) / totalStakeWei) / 100 : 0;
    const deployedStakeWei = op.stakes?.reduce((sum, stake) => sum + BigInt(stake.amountWei), 0n) || 0n;

    const totalStakeData = convertWeiToData(op.valueWithoutEarnings);
    const totalEarningsData = convertWeiToData(op.cumulativeEarningsWei);
    const ownerCutData = convertWeiToData(op.cumulativeOperatorsCutWei);
    const distributedData = convertWeiToData(distributedToDelegatorsWei.toString());
    const deployedData = convertWeiToData(deployedStakeWei.toString());
    const ownerStakeData = convertWeiToData(operatorsOwnStakeWei.toString());

    const headerStakeEl = document.getElementById('header-stat-stake');
    if (headerStakeEl) {
        headerStakeEl.textContent = formatBigNumber(totalStakeData);
        headerStakeEl.setAttribute('data-tooltip-value', totalStakeData);
    }

    const headerEarningsEl = document.getElementById('header-stat-earnings');
    if (headerEarningsEl) {
        headerEarningsEl.textContent = formatBigNumber(totalEarningsData);
        headerEarningsEl.setAttribute('data-tooltip-value', totalEarningsData);
    }

    const headerCutEl = document.getElementById('header-stat-cut');
    if (headerCutEl) {
        headerCutEl.textContent = `${ownersCutPercent}%`;
    }

    const distributedEl = document.getElementById('extended-stat-distributed');
    if (distributedEl) {
        distributedEl.textContent = formatBigNumber(distributedData);
        distributedEl.setAttribute('data-tooltip-value', distributedData);
    }

    const ownerCutEl = document.getElementById('extended-stat-owner-cut');
    if (ownerCutEl) {
        ownerCutEl.textContent = formatBigNumber(ownerCutData);
        ownerCutEl.setAttribute('data-tooltip-value', ownerCutData);
    }

    const deployedEl = document.getElementById('extended-stat-deployed');
    if (deployedEl) {
        deployedEl.textContent = formatBigNumber(deployedData);
        deployedEl.setAttribute('data-tooltip-value', deployedData);
    }

    const ownerStakeEl = document.getElementById('extended-stat-owner-stake');
    if (ownerStakeEl) {
        ownerStakeEl.textContent = `${Math.round(ownersStakePercent)}%`;
        // Store the raw DATA value for dynamic tooltip calculation
        ownerStakeEl.setAttribute('data-tooltip-value', ownerStakeData);
        ownerStakeEl.setAttribute('data-tooltip-type', 'owner-stake');
    }
}

// --- UI Toggles ---
export function toggleStatsPanel(isRefresh, uiState) {
    if (!isRefresh) {
        uiState.isStatsPanelExpanded = !uiState.isStatsPanelExpanded;
    }

    const extendedStats = document.getElementById('extended-stats');
    const arrow = document.getElementById('stats-arrow');

    if (extendedStats && arrow) {
        if (uiState.isStatsPanelExpanded) {
            extendedStats.classList.remove('hidden');
            arrow.classList.add('rotate-180');
        } else {
            extendedStats.classList.add('hidden');
            arrow.classList.remove('rotate-180');
        }
    }
}

export function toggleVoteList(flagId) {
    document.getElementById(`votes-${flagId}`)?.classList.toggle('hidden');
}

export function updateChartTimeframeButtons(days, isUsdView, chartType = 'stake') {
    // Chart type pills
    const chartTypeTabs = document.querySelectorAll('#chart-type-tabs button');
    chartTypeTabs.forEach(button => {
        if (button.dataset.chartType === chartType) {
            button.classList.add('bg-blue-800', 'text-white');
            button.classList.remove('text-gray-400', 'hover:text-white');
        } else {
            button.classList.remove('bg-blue-800', 'text-white');
            button.classList.add('text-gray-400', 'hover:text-white');
        }
    });

    // Timeframe buttons
    const buttons = document.querySelectorAll('#chart-timeframe-buttons button');
    buttons.forEach(button => {
        if (button.dataset.days === String(days)) {
            button.classList.add('bg-blue-800', 'text-white');
            button.classList.remove('hover:bg-[#444444]');
        } else {
            button.classList.remove('bg-blue-800', 'text-white');
            button.classList.add('hover:bg-[#444444]');
        }
    });

    // View buttons (DATA/USD) - only visible for Stake chart
    const viewButtonsContainer = document.getElementById('chart-view-buttons');
    if (viewButtonsContainer) {
        if (chartType === 'stake') {
            viewButtonsContainer.classList.remove('hidden');
        } else {
            viewButtonsContainer.classList.add('hidden');
        }
    }

    // Info tooltip - visible for Earnings chart
    const infoTooltip = document.getElementById('chart-info-tooltip');
    if (infoTooltip) {
        if (chartType === 'earnings') {
            infoTooltip.classList.remove('hidden');
        } else {
            infoTooltip.classList.add('hidden');
        }
    }

    const viewButtons = document.querySelectorAll('#chart-view-buttons button');
    viewButtons.forEach(button => {
        const isActive = (button.dataset.view === 'usd' && isUsdView) || (button.dataset.view === 'data' && !isUsdView);
        if (isActive) {
            button.classList.add('bg-blue-800', 'text-white');
            button.classList.remove('hover:bg-[#444444]');
        } else {
            button.classList.remove('bg-blue-800', 'text-white');
            button.classList.add('hover:bg-[#444444]');
        }
    });
}


export function addStreamMessageToUI(message, activeNodes, unreachableNodes) {
    const messagesContainerEl = document.getElementById('stream-messages-container');
    if (!messagesContainerEl) return;

    if (message?.msgType === 'heartbeat' && message?.peerDescriptor?.nodeId) {
        const nodeId = message.peerDescriptor.nodeId;
        const region = message.peerDescriptor.region; // Get the region
        const host = message.peerDescriptor.websocket?.host || nodeId; // Get the host, fallback to nodeId

        if (!activeNodes.has(nodeId)) {
            activeNodes.add(nodeId);
            document.getElementById('active-nodes-count-value').textContent = activeNodes.size;
            document.getElementById('active-nodes-stats-value').textContent = activeNodes.size;

            if (region && leafletMap) {
                const location = regionToLocationMap[region];
                if (location) {
                    addNodeToMap(location, host, nodeId); // Pass location, host, AND nodeId
                } else {
                    console.warn(`Region code ${region} not found in location map.`);
                }
            }
        }
        if (message.peerDescriptor?.websocket?.tls === false && !unreachableNodes.has(nodeId)) {
            unreachableNodes.add(nodeId);
            const unreachableContainer = document.getElementById('unreachable-nodes-container');
            unreachableContainer.querySelector('span').textContent = unreachableNodes.size;
            unreachableContainer.classList.remove('hidden');
        }
    }

    const placeholder = messagesContainerEl.querySelector('.text-gray-500');
    if (placeholder) placeholder.remove();

    const messageWrapper = document.createElement('div');
    messageWrapper.className = 'stream-message-entry py-2 border-t border-[#333333]/50 first:border-t-0';
    messageWrapper.innerHTML = `
        <div class="flex justify-between items-center text-xs text-gray-400 mb-1">
            <span class="font-mono">${new Date().toLocaleTimeString()}</span>
        </div>
        <pre class="whitespace-pre-wrap break-all text-xs text-gray-400"><code>${escapeHtml(JSON.stringify(message, null, 2))}</code></pre>`;

    messagesContainerEl.prepend(messageWrapper);
    while (messagesContainerEl.children.length > MAX_STREAM_MESSAGES) {
        messagesContainerEl.removeChild(messagesContainerEl.lastChild);
    }
}


// --- Leaflet Map Functions ---

/**
 * Cleans up the existing Leaflet map instance and resets state.
 */
function cleanupLeafletMap() {
    if (leafletMap) {
        leafletMap.remove();
        leafletMap = null;
    }
    locationNodeMap.clear(); // Clear the location/node tracker
    mapLayers = { markers: null, lines: null };
}

/**
 * Initializes a new Leaflet map instance.
 * @param {string} containerId - The ID of the div element to contain the map.
 */
export function initLeafletMap(containerId) {
    cleanupLeafletMap(); // Clean up old instance first

    try {
        const mapContainer = document.getElementById(containerId);
        if (!mapContainer) {
            console.error("Map container not found:", containerId);
            return;
        }
        // Clear placeholder
        mapContainer.innerHTML = '';

        leafletMap = L.map(containerId, {
            zoomControl: true, // Show zoom control
            attributionControl: false // Hide "Leaflet" attribution
        }).setView([20, 0], 2); // Center map [lat, long], zoom

        // Add CartoDB dark_matter tile layer
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 19,
            minZoom: 2
        }).addTo(leafletMap);

        setTimeout(() => {
            if (leafletMap) {
                leafletMap.invalidateSize();
            }
        }, 0); // 0ms timeout pushes this to the end of the execution stack

        // Initialize layer groups to manage markers and lines
        mapLayers.lines = L.layerGroup().addTo(leafletMap);
        mapLayers.markers = L.layerGroup().addTo(leafletMap);

    } catch (e) {
        console.error("Failed to initialize Leaflet map:", e);
        const mapContainer = document.getElementById(containerId);
        if (mapContainer) {
            mapContainer.innerHTML = '<p class="text-red-400">Error loading map.</p>';
        }
    }
}

/**
 * Formats the tooltip content for a map marker.
 * @param {Map<string, string>} nodesMap - A Map of nodeId -> host
 * @returns {string} HTML content for the tooltip.
 */
function formatNodeTooltip(nodesMap) {
    const lines = [];
    for (const [nodeId, host] of nodesMap.entries()) {
        const safeHost = escapeHtml(host);
        const safeNodeId = escapeHtml(nodeId);
        lines.push(
            `- host: ${safeHost}\n  node: ${safeNodeId}`
        );
    }
    // Wrap in <pre> to respect the newlines and indentation
    return `<pre style="margin: 0; font-family: monospace; font-size: 10px;">${lines.join('\n\n')}</pre>`;
}

/**
 * Adds a new node marker and connection lines to the map.
 * Groups nodes by location and updates tooltips.
 * @param {object} location - The location object { lat, long, code }.
 *HttpS
 * @param {string} host - The node's host ID.
 * @param {string} nodeId - The node's ID.
 */
function addNodeToMap(location, host, nodeId) {
    if (!leafletMap || !mapLayers.markers || !mapLayers.lines) return;

    const latLng = [location.lat, location.long];
    const locationKey = `${location.lat},${location.long}`; // Use lat/long as a unique key

    if (!locationNodeMap.has(locationKey)) {
        // This is the FIRST node at this location
        const marker = L.circleMarker(latLng, {
            radius: 5,
            fillColor: "#3b82f6", // Tailwind Blue-500
            color: "#FFFFFF",
            weight: 1,
            opacity: 1,
            fillOpacity: 0.8
        }).addTo(mapLayers.markers);

        const nodes = new Map();
        nodes.set(nodeId, host);

        // Bind tooltip
        marker.bindTooltip(formatNodeTooltip(nodes));

        // Store marker and nodes
        locationNodeMap.set(locationKey, { marker, nodes, location });

        // Add lines to all *other* existing locations
        for (const [key, existingEntry] of locationNodeMap.entries()) {
            if (key !== locationKey) { // Don't draw line to self
                const latlngs = [
                    [existingEntry.location.lat, existingEntry.location.long],
                    latLng
                ];
                L.polyline(latlngs, {
                    color: "rgba(255, 255, 255, 0.4)", // White, semi-transparent
                    weight: 1
                }).addTo(mapLayers.lines);
            }
        }
    } else {
        // This is an ADDITIONAL node at an existing location
        const entry = locationNodeMap.get(locationKey);
        
        // Add the new node (Map handles duplicates by nodeId)
        entry.nodes.set(nodeId, host);

        // Update the tooltip content
        const tooltipContent = formatNodeTooltip(entry.nodes);
        entry.marker.setTooltipContent(tooltipContent);
    }
}

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
            <div class="bg-[#1E1E1E] rounded-xl p-5 border ${borderColor} autostaker-sponsorship-item ${hasIssues && !sp.isStaked ? 'opacity-60' : ''}" data-sponsorship-id="${sp.id}" data-stream-id="${sp.streamId.toLowerCase()}" data-is-staked="${sp.isStaked}" data-is-stakeable="${isStakeable}" data-can-be-activated="${canBeActivated}">
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