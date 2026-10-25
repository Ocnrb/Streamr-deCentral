// Shared UI: element cache, loader, login modal, views, modal states and the operators list
import { escapeHtml, formatBigNumber, convertWeiToData, createAddressLink, parseOperatorMetadata, calculateWeightedApy, avatarImgHtml } from '../core/utils.js';
import { showToast, updateToast, removeToast } from './toast.js';

// The parts of the UI in their own files, still reachable as UI.* from the modules
export * from './tooltip.js';
export * from './toast.js';
export * from './operatorDetail.js';
export * from './nodeMap.js';
export * from './autostakerUI.js';
export * from './profileShortcut.js';

// --- Element Cache ---
export const loginModal = document.getElementById('loginModal');
export const mainContainer = document.getElementById('main-container');
export const operatorsGrid = document.getElementById('operators-grid');
export const searchInput = document.getElementById('search-input');
export const loadMoreOperatorsBtn = document.getElementById('load-more-operators-btn');
export const operatorDetailView = document.getElementById('operator-detail-view');
export const operatorListView = document.getElementById('operator-list-view');
export const raceView = document.getElementById('race-view'); 
export const visualView = document.getElementById('visual-view'); 
export const delegatorsListView = document.getElementById('delegators-list-view'); 
export const delegatorDetailView = document.getElementById('delegator-detail-view'); 
export const streamsListView = document.getElementById('streams-list-view'); 
export const streamDetailView = document.getElementById('stream-detail-view'); 
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

// --- UI Update Functions ---

export function showLoader(show) {
    loaderOverlay.style.display = show ? 'flex' : 'none';
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

let lastDisplayedView = null;

export function displayView(view) {
    // Another page opens at the top (the window keeps the scroll of the page before otherwise);
    // the same page shown again (a data refresh) stays where it is
    if (view !== lastDisplayedView) {
        lastDisplayedView = view;
        window.scrollTo(0, 0);
    }

    // Hide all views first
    operatorListView.style.display = 'none';
    operatorDetailView.style.display = 'none';
    if (raceView) raceView.style.display = 'none';
    if (visualView) visualView.style.display = 'none';
    if (delegatorsListView) delegatorsListView.style.display = 'none';
    if (delegatorDetailView) delegatorDetailView.style.display = 'none';
    
    // For streams views, also try dynamic lookup as fallback
    const streamsListEl = streamsListView || document.getElementById('streams-list-view');
    const streamDetailEl = streamDetailView || document.getElementById('stream-detail-view');
    if (streamsListEl) streamsListEl.style.display = 'none';
    if (streamDetailEl) streamDetailEl.style.display = 'none';
    const subgraphEl = document.getElementById('subgraph-view');
    if (subgraphEl) subgraphEl.style.display = 'none';
    const governanceEl = document.getElementById('governance-view');
    if (governanceEl) governanceEl.style.display = 'none';
    const swapEl = document.getElementById('swap-view');
    if (swapEl) swapEl.style.display = 'none';
    const bridgeEl = document.getElementById('bridge-view');
    if (bridgeEl) bridgeEl.style.display = 'none';
    const overviewEl = document.getElementById('overview-view');
    if (overviewEl) overviewEl.style.display = 'none';

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
    } else if (view === 'streams-list') {
        if (streamsListEl) streamsListEl.style.display = 'block';
    } else if (view === 'stream-detail') {
        if (streamDetailEl) streamDetailEl.style.display = 'block';
        window.scrollTo(0, 0);
    } else if (view === 'governance') {
        if (governanceEl) governanceEl.style.display = 'block';
    } else if (view === 'swap') {
        if (swapEl) swapEl.style.display = 'block';
    } else if (view === 'bridge') {
        if (bridgeEl) bridgeEl.style.display = 'block';
    } else if (view === 'overview') {
        if (overviewEl) overviewEl.style.display = 'block';
    } else if (view === 'subgraph') {
        // Flex row: query builder + entity navigation panel on the right
        if (subgraphEl) subgraphEl.style.display = 'flex';
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
        'stake-modal': stakeModal
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
    const weightedApy = calculateWeightedApy(op.stakes);
    const totalStakedData = convertWeiToData(op.valueWithoutEarnings);
    const safeOperatorName = escapeHtml(name || op.id);
    const sponsorshipsCount = op.stakes ? op.stakes.length : 0;

    const roundedApy = Math.round(weightedApy * 100);
    const apyColorClass = roundedApy === 0 ? 'text-red-400' : 'text-green-400';

    return `
     <div class="operator-card bg-[#1E1E1E] p-5 rounded-xl border border-[#333333] card flex flex-col items-center text-center" data-operator-id="${op.id}">
         ${avatarImgHtml(imageUrl, { alt: 'Operator Avatar', className: 'avatar-container w-16 h-16 border-2 border-[#333333] mb-4', attrs: description ? `data-tooltip-content="${escapeHtml(description)}"` : '' })}
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
