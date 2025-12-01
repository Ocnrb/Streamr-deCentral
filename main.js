import * as Constants from './src/core/constants.js';
import * as Utils from './src/core/utils.js';
import * as UI from './src/ui/ui.js';
import * as Services from './src/core/services.js';
import { Router } from './src/core/router.js';
import * as Autostaker from './src/features/autostaker.js';

// Lazy-loaded modules
let RaceLogic = null;
let VisualLogic = null;
let raceModuleLoading = false;
let visualModuleLoading = false;

/**
 * Lazy load the Race module
 * @returns {Promise<object>} The RaceLogic module
 */
async function loadRaceModule() {
    if (RaceLogic) return RaceLogic;
    if (raceModuleLoading) {
        // Wait for existing load to complete
        while (raceModuleLoading) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        return RaceLogic;
    }
    
    raceModuleLoading = true;
    
    try {
        const module = await import('./src/features/race.js');
        RaceLogic = module.RaceLogic;
        return RaceLogic;
    } catch (error) {
        UI.showToast({
            type: 'error',
            title: 'Failed to load Race View',
            message: error.message,
            duration: 5000
        });
        throw error;
    } finally {
        raceModuleLoading = false;
    }
}

/**
 * Lazy load the Visual module
 * @returns {Promise<object>} The VisualLogic module
 */
async function loadVisualModule() {
    if (VisualLogic) return VisualLogic;
    if (visualModuleLoading) {
        // Wait for existing load to complete
        while (visualModuleLoading) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        return VisualLogic;
    }
    
    visualModuleLoading = true;
    
    try {
        const module = await import('./src/features/visual.js');
        VisualLogic = module.VisualLogic;
        return VisualLogic;
    } catch (error) {
        UI.showToast({
            type: 'error',
            title: 'Failed to load Visual View',
            message: error.message,
            duration: 5000
        });
        throw error;
    } finally {
        visualModuleLoading = false;
    }
}

const { logger } = Utils;

// --- Private Key Encryption Utilities ---

const PK_STORAGE_KEY = 'pk_encrypted';
const PK_SALT_KEY = 'pk_salt';
const PK_IV_KEY = 'pk_iv';

/**
 * Generate a cryptographic key from user password using PBKDF2
 * @param {string} password - User's encryption password
 * @param {Uint8Array} salt - Random salt
 */
async function deriveKeyFromPassword(password, salt) {
    const encoder = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        'PBKDF2',
        false,
        ['deriveKey']
    );
    
    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: 100000,
            hash: 'SHA-256'
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypt private key for storage using user's password
 * @param {string} privateKey - The private key to encrypt
 * @param {string} password - User's encryption password
 */
async function encryptPrivateKey(privateKey, password) {
    try {
        const encoder = new TextEncoder();
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await deriveKeyFromPassword(password, salt);
        
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv },
            key,
            encoder.encode(privateKey)
        );
        
        return {
            encrypted: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
            salt: btoa(String.fromCharCode(...salt)),
            iv: btoa(String.fromCharCode(...iv))
        };
    } catch (e) {
        logger.error('Encryption failed:', e);
        return null;
    }
}

/**
 * Decrypt stored private key using user's password
 * @param {string} password - User's encryption password
 * @returns {string|null} Decrypted private key or null if failed
 */
async function decryptPrivateKey(password) {
    try {
        const encryptedB64 = localStorage.getItem(PK_STORAGE_KEY);
        const saltB64 = localStorage.getItem(PK_SALT_KEY);
        const ivB64 = localStorage.getItem(PK_IV_KEY);
        
        if (!encryptedB64 || !saltB64 || !ivB64) return null;
        
        const encrypted = Uint8Array.from(atob(encryptedB64), c => c.charCodeAt(0));
        const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
        const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
        
        const key = await deriveKeyFromPassword(password, salt);
        
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv },
            key,
            encrypted
        );
        
        return new TextDecoder().decode(decrypted);
    } catch (e) {
        // Don't clear on failure - might be wrong password
        logger.error('Decryption failed:', e);
        return null;
    }
}

/**
 * Save encrypted private key to localStorage
 * @param {string} privateKey - The private key to save
 * @param {string} password - User's encryption password
 */
async function savePrivateKey(privateKey, password) {
    const encrypted = await encryptPrivateKey(privateKey, password);
    if (encrypted) {
        localStorage.setItem(PK_STORAGE_KEY, encrypted.encrypted);
        localStorage.setItem(PK_SALT_KEY, encrypted.salt);
        localStorage.setItem(PK_IV_KEY, encrypted.iv);
        return true;
    }
    return false;
}

/**
 * Check if there's a stored private key
 */
function hasStoredPrivateKey() {
    return localStorage.getItem(PK_STORAGE_KEY) !== null;
}

/**
 * Clear stored private key
 */
function clearStoredPrivateKey() {
    localStorage.removeItem(PK_STORAGE_KEY);
    localStorage.removeItem(PK_SALT_KEY);
    localStorage.removeItem(PK_IV_KEY);
}

// --- Global State ---
let state = {
    signer: null,
    myRealAddress: '',
    currentOperatorId: null,
    currentOperatorData: null,
    currentDelegations: [],
    sponsorshipHistory: [],
    operatorDailyBuckets: [],
    historicalDataPriceMap: null, 
    chartTimeFrame: 90,
    totalDelegatorCount: 0,
    dataPriceUSD: null,
    loadedOperatorCount: 0,
    searchQuery: '',
    detailsRefreshInterval: null,
    activeSponsorshipMenu: null,
    uiState: {
        isStatsPanelExpanded: false,
        isDelegatorViewActive: true,
        reputationViewIndex: 0,
        walletViewIndex: 0,
        isSponsorshipsListViewActive: true,
        isChartUsdView: false, 
    },
    activeNodes: new Set(),
    unreachableNodes: new Set(),
};

// Router instance
let router = null;

// Debounced search function
const debouncedSearch = Utils.debounce((query) => {
    const trimmedQuery = query.trim();
    if (state.searchQuery !== trimmedQuery) {
        state.searchQuery = trimmedQuery;
        state.loadedOperatorCount = 0;
        fetchAndRenderOperatorsList(false, 0, state.searchQuery);
    }
}, 300);

// --- Initialization ---

async function initializeApp() {
    await Services.cleanupClient();
    try {
        const streamrClient = new StreamrClient();
        Services.setStreamrClient(streamrClient);
        logger.log("Streamr client initialized.");

        // Load CSV price data on startup
        state.historicalDataPriceMap = await Services.fetchHistoricalDataPrice();

        await Services.setupDataPriceStream((price) => {
            state.dataPriceUSD = price;
        });
        
        UI.loginModal.classList.add('hidden');
        UI.mainContainer.classList.remove('hidden');

        // Initialize router and handle current route
        router.init();

    } catch (error) {
        console.error("Initialization failed:", error);
        UI.showToast({ type: 'error', title: 'Initialization Error', message: 'Failed to initialize the application. Please refresh.', duration: 0 });
        UI.setLoginModalState('buttons');
    }
}

function setupWalletListeners() {
    if (window.ethereum) {
        window.ethereum.on('accountsChanged', () => {
            logger.log('Wallet account changed, reloading page.');
            window.location.reload();
        });
        window.ethereum.on('chainChanged', () => {
            logger.log('Wallet network changed, reloading page.');
            window.location.reload();
        });
    }
}

async function connectWithWallet() {
    const injectedProvider = window.ethereum || window.top?.ethereum;
    if (!injectedProvider) {
        UI.showToast({ type: 'error', title: 'MetaMask Not Found', message: 'Please install the MetaMask extension.', duration: 0 });
        return;
    }

    try {
        UI.setLoginModalState('loading', 'wallet');
        const provider = new ethers.providers.Web3Provider(injectedProvider);
        await provider.send("eth_requestAccounts", []);
        state.signer = provider.getSigner();
        state.myRealAddress = await state.signer.getAddress();

        if (!await Services.checkAndSwitchNetwork()) {
            UI.setLoginModalState('buttons');
            return;
        }

        UI.updateWalletUI(state.myRealAddress);
        setupWalletListeners();
        await initializeApp();
        sessionStorage.setItem('authMethod', 'metamask');

    } catch (err) {
        logger.error("Wallet connection error:", err);
        state.myRealAddress = '';
        state.signer = null;
        const message = (err.code === 4001 || err.info?.error?.code === 4001) 
            ? "The signature request was rejected in your wallet."
            : "Wallet connection request was rejected or failed.";
        UI.showToast({ type: 'error', title: 'Wallet Connection Failed', message: message, duration: 8000 });
        UI.setLoginModalState('buttons');
    }
}

async function connectAsGuest() {
    UI.setLoginModalState('loading', 'guest');
    state.myRealAddress = '';
    state.signer = null;
    UI.updateWalletUI(null); 
    sessionStorage.removeItem('authMethod');
    await initializeApp();
}

/**
 * Connect using a private key
 * @param {string} privateKey - The private key to use
 * @param {string|null} encryptionPassword - Password to encrypt and save the key (null = don't save)
 */
async function connectWithPrivateKey(privateKey, encryptionPassword = null) {
    try {
        UI.setLoginModalState('loading', 'privateKey');
        UI.hidePrivateKeyModal();
        
        // Validate private key format
        if (!privateKey || privateKey.trim().length === 0) {
            throw new Error('Please enter a private key.');
        }
        
        // Ensure it starts with 0x
        let formattedKey = privateKey.trim();
        if (!formattedKey.startsWith('0x')) {
            formattedKey = '0x' + formattedKey;
        }
        
        // Validate key length (64 hex chars + 0x prefix = 66)
        if (formattedKey.length !== 66) {
            throw new Error('Invalid private key format. Must be 64 hexadecimal characters.');
        }
        
        // Create wallet from private key using centralized provider
        const wallet = new ethers.Wallet(formattedKey, Services.getReadOnlyProvider());
        
        state.signer = wallet;
        state.myRealAddress = wallet.address;
        
        // Save encrypted key if requested (password is provided)
        if (encryptionPassword) {
            const saved = await savePrivateKey(formattedKey, encryptionPassword);
            if (!saved) {
                UI.showToast({ type: 'warning', title: 'Key Not Saved', message: 'Could not save the private key. You will need to enter it again next time.', duration: 5000 });
            }
        }
        
        UI.updateWalletUI(state.myRealAddress);
        await initializeApp();
        sessionStorage.setItem('authMethod', 'privateKey');
        
    } catch (err) {
        logger.error("Private key connection error:", err);
        state.myRealAddress = '';
        state.signer = null;
        UI.showToast({ type: 'error', title: 'Connection Failed', message: err.message || 'Invalid private key.', duration: 8000 });
        UI.setLoginModalState('buttons');
    }
}

/**
 * Unlock wallet with stored encrypted private key
 * @param {string} password - User's unlock password
 * @returns {boolean} True if unlock successful
 */
async function unlockWallet(password) {
    if (!hasStoredPrivateKey()) return false;
    
    const unlockModal = document.getElementById('unlockWalletModal');
    
    try {
        const privateKey = await decryptPrivateKey(password);
        if (privateKey) {
            // Hide unlock modal
            if (unlockModal) unlockModal.classList.add('hidden');
            await connectWithPrivateKey(privateKey, null); // null = don't re-save
            return true;
        }
        UI.showToast('Senha incorreta', 'error');
        return false;
    } catch (e) {
        logger.error('Unlock failed:', e);
        UI.showToast('Erro ao desbloquear: ' + e.message, 'error');
        return false;
    }
}

/**
 * Logout and disconnect wallet
 * @param {boolean} clearSavedKey - Whether to clear the saved private key
 */
function logout(clearSavedKey = true) {
    // Stop autostaker bot if running
    if (autostakerState.isRunning) {
        stopAutostakerBot();
    }
    
    // Clear state
    state.signer = null;
    state.myRealAddress = '';
    
    // Clear session
    sessionStorage.removeItem('authMethod');
    
    // Clear stored private key if requested
    if (clearSavedKey) {
        clearStoredPrivateKey();
    }
    
    // Hide dropdown
    const dropdown = document.getElementById('wallet-dropdown');
    if (dropdown) dropdown.classList.add('hidden');
    
    // Reload the page to reset everything
    window.location.reload();
}

// --- Data Fetching and Rendering Orchestration ---

async function fetchAndRenderOperatorsList(isLoadMore = false, skip = 0, filterQuery = '') {
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
}

async function fetchAndRenderOperatorDetails(operatorId) {
    UI.showLoader(true);
    if (state.detailsRefreshInterval) clearInterval(state.detailsRefreshInterval);

    state.currentOperatorId = operatorId.toLowerCase();
    state.activeNodes.clear();
    state.unreachableNodes.clear();
    state.chartTimeFrame = 90;
    state.uiState.isChartUsdView = false; 

    try {
        await refreshOperatorData(true); 
        state.detailsRefreshInterval = setInterval(() => refreshOperatorData(false), 30000);
    } catch (error) {
        UI.detailContent.innerHTML = `<p class="text-red-400">${Utils.escapeHtml(error.message)}</p>`;
    } finally {
        UI.showLoader(false);
    }
}

async function refreshOperatorData(isFirstLoad = false, expectedTxHash = null) {
    try {
        const data = await Services.fetchOperatorDetails(state.currentOperatorId);
        
        state.currentOperatorData = data.operator;
        state.currentDelegations = data.operator?.delegations || [];
        state.totalDelegatorCount = data.operator?.delegatorCount || 0;
        state.operatorDailyBuckets = data.operatorDailyBuckets || [];
        
        if (isFirstLoad) {
            let polygonscanTxs = [];
            try {
                polygonscanTxs = await Services.fetchPolygonscanHistory(state.currentOperatorId);
            } catch (error) {
                logger.error("Failed to load Polygonscan history:", error);
            }
            
            processSponsorshipHistory(data, polygonscanTxs);
            
            UI.renderOperatorDetails(data, state);
            updateBotStatusUI(); // Update autostaker button state
            const addresses = [...(data.operator.controllers || []), ...(data.operator.nodes || [])];
            UI.renderBalances(addresses);
            updateMyStakeUI();
            setupOperatorStream();
            filterAndRenderChart();
            UI.renderSponsorshipsHistory(state.sponsorshipHistory);
            
            // Return whether the expected transaction was found
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
}

/**
 * Refresh operator data with retry logic for Polygonscan history
 * Waits for a specific transaction to appear in the history
 * @param {string} txHash - The transaction hash to wait for
 * @param {number} maxAttempts - Maximum number of retry attempts (default: 5)
 * @param {number} delayMs - Delay between attempts in ms (default: 4000)
 */
async function refreshWithRetry(txHash, maxAttempts = 5, delayMs = 4000) {
    logger.log(`Waiting for transaction ${txHash} to appear in Polygonscan...`);
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        logger.log(`Polygonscan refresh attempt ${attempt}/${maxAttempts}`);
        
        const txFound = await refreshOperatorData(true, txHash);
        
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
}

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

function filterAndRenderChart() {
    const now = new Date();
    let latestKnownPrice = state.dataPriceUSD || 0;

    const chartData = state.operatorDailyBuckets.map(bucket => {
        const bucketDate = bucket.date; 
        
        // Filter by time window
        if (state.chartTimeFrame !== 'all') {
            const bucketDateObj = new Date(bucketDate * 1000);
            const daysAgo = (now - bucketDateObj) / (1000 * 60 * 60 * 24);
            if (daysAgo > state.chartTimeFrame) {
                return null;
            }
        }
        
        const dataAmount = parseFloat(Utils.convertWeiToData(bucket.valueWithoutEarnings));

        let value;
        if (state.uiState.isChartUsdView) {
            let price = state.historicalDataPriceMap.get(bucketDate);
            
            if (!price) {
                for (let i = 1; i <= 7; i++) { 
                    const priorDate = bucketDate - (i * 86400); 
                    price = state.historicalDataPriceMap.get(priorDate);
                    if (price) break;
                }
            }

            const priceToUse = price || latestKnownPrice;
            if (priceToUse > 0) latestKnownPrice = priceToUse; 
            
            value = dataAmount * priceToUse;
        } else {
            value = dataAmount;
        }
		
        const date = new Date(bucketDate * 1000);
        const month = date.toLocaleDateString(undefined, { month: 'short' });
        const day = date.getDate(); 
        const year = date.getFullYear().toString().substring(2); 

        return {
            label: `${month} ${day} '${year}`,
            value: value
        };

    }).filter(Boolean); 

    UI.renderStakeChart(chartData, state.uiState.isChartUsdView);
    UI.updateChartTimeframeButtons(state.chartTimeFrame, state.uiState.isChartUsdView);
}

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


// --- Event Handlers ---

function handleShowOperatorDetails(operatorId) {
    router.navigate(`/operator/${operatorId}`);
}

function handleShowRace() {
    router.navigate('/race');
}

function handleBackToFromRace() {
    router.navigate('/');
}

function handleShowVisual() {
    router.navigate('/visual');
}

function handleBackFromVisual() {
    router.navigate('/');
}

async function handleLoadMoreOperators(button) {
    button.disabled = true;
    button.innerHTML = `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent btn-spinner"></div> Loading...`;
    try {
        await fetchAndRenderOperatorsList(true, state.loadedOperatorCount, state.searchQuery);
    } catch (error) {
        console.error("Failed to load more operators:", error);
    } finally {
        button.disabled = false;
        button.innerHTML = 'Load More Operators';
    }
}

function handleSearch(query) {
    debouncedSearch(query);
}

async function handleLoadMoreDelegators(button) {
    button.disabled = true;
    button.innerHTML = `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent btn-spinner"></div> Loading...`;
    try {
        const newDelegations = await Services.fetchMoreDelegators(state.currentOperatorId, state.currentDelegations.length);
        state.currentDelegations.push(...newDelegations);
        UI.updateDelegatorsSection(state.currentDelegations, state.totalDelegatorCount);
    } catch (error) {
        console.error("Failed to load more delegators:", error);
    } finally {
        button.disabled = false;
        button.textContent = 'Load More';
    }
}

// --- Transaction Handlers ---

async function handleDelegateClick() {
    if (!state.signer) {
        UI.showToast({ type: 'warning', title: 'Wallet Required', message: 'Please connect a wallet to delegate.' });
        return;
    }
    // Only check network for MetaMask connections (private key uses RPC directly)
    if (sessionStorage.getItem('authMethod') !== 'privateKey') {
        if (!await Services.checkAndSwitchNetwork()) return;
    }

    let maxAmountWei = await Services.manageTransactionModal(true, 'delegate', state.signer, state.myRealAddress, state.currentOperatorId);

    const confirmBtn = document.getElementById('tx-modal-confirm');
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

    document.getElementById('tx-modal-max-btn').onclick = () => {
        if (maxAmountWei !== '0') {
            UI.txModalAmount.value = ethers.utils.formatEther(maxAmountWei);
        }
    };
    
    newConfirmBtn.addEventListener('click', async () => {
        newConfirmBtn.disabled = true;
        newConfirmBtn.innerHTML = `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent btn-spinner"></div> Processing...`;
        
        const txHash = await Services.confirmDelegation(state.signer, state.myRealAddress, state.currentOperatorId);
        if (txHash) {
            await refreshWithRetry(txHash);
        }

        newConfirmBtn.disabled = false;
        newConfirmBtn.textContent = 'Confirm';
    });
}

async function handleUndelegateClick() {
    if (!state.signer) {
        UI.showToast({ type: 'warning', title: 'Wallet Required', message: 'Please connect a wallet to undelegate.' });
        return;
    }
    // Only check network for MetaMask connections (private key uses RPC directly)
    if (sessionStorage.getItem('authMethod') !== 'privateKey') {
        if (!await Services.checkAndSwitchNetwork()) return;
    }

    let maxAmountWei = await Services.manageTransactionModal(true, 'undelegate', state.signer, state.myRealAddress, state.currentOperatorId);
    
    const confirmBtn = document.getElementById('tx-modal-confirm');
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    
    document.getElementById('tx-modal-max-btn').onclick = () => {
        if (maxAmountWei !== '0') {
            UI.txModalAmount.value = ethers.utils.formatEther(maxAmountWei);
        }
    };
    
    newConfirmBtn.addEventListener('click', async () => {
        newConfirmBtn.disabled = true;
        newConfirmBtn.innerHTML = `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent btn-spinner"></div> Processing...`;

        const txHash = await Services.confirmUndelegation(state.signer, state.myRealAddress, state.currentOperatorId);
        if (txHash) {
           await refreshWithRetry(txHash);
        }

        newConfirmBtn.disabled = false;
        newConfirmBtn.textContent = 'Confirm';
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
        await refreshWithRetry(txHash);
    } else {
        await refreshOperatorData(true);
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
            await refreshWithRetry(result);
        }
        
        newConfirmBtn.disabled = false;
        newConfirmBtn.textContent = 'Confirm';
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
        await refreshWithRetry(txHash);
    } else {
        await refreshOperatorData(true);
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
        await refreshWithRetry(txHash);
    } else {
        await refreshOperatorData(true);
    }

    button.disabled = false;
    button.textContent = 'Collect All';
}

async function handleEditOperatorSettingsClick() {
    if (!state.signer) {
        UI.showToast({ type: 'warning', title: 'Wallet Required', message: 'Please connect your wallet.' });
        return;
    }
    // Only check network for MetaMask connections (private key uses RPC directly)
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
            
            // Use the last successful txHash for retry
            const lastTxHash = txHash2 || txHash1;
            if (lastTxHash) {
                await refreshWithRetry(lastTxHash);
            } else {
                await refreshOperatorData(true);
            }

        } catch (e) {
            UI.setModalState('operator-settings-modal', 'error', { message: Utils.getFriendlyErrorMessage(e) });
        } finally {
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Confirm Changes';
        }
    });
}


// --- Autostaker Handlers ---

let autostakerState = {
    config: null,
    sponsorships: [],
    botIntervalId: null,
    isRunning: false,
    lastRunTime: null,
    nextRunTime: null,
    intervalMinutes: 5,
    logs: [],
    operatorId: null,  
    operatorSigner: null  
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
                <span class="${colorClass}">${log.message}</span>
            </div>
        `;
    }).join('');
}

function clearAutostakerLogs() {
    autostakerState.logs = [];
    renderAutostakerLogs();
}

async function handleAutostakerClick() {
    if (!state.signer) {
        UI.showToast({ type: 'warning', title: 'Wallet Required', message: 'Please connect your wallet.' });
        return;
    }
    
    // For private key connections, we use RPC directly (already on Polygon)
    // Only check network for MetaMask connections
    if (sessionStorage.getItem('authMethod') !== 'privateKey') {
        if (!await Services.checkAndSwitchNetwork()) return;
    }

    // Store operator info for global operation
    autostakerState.operatorId = state.currentOperatorId;
    autostakerState.operatorSigner = state.signer;
    
    // Load config and show modal
    autostakerState.config = Autostaker.loadAutostakerConfig(state.currentOperatorId);
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
        const operatorId = autostakerState.operatorId || state.currentOperatorId;
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
    const operatorId = autostakerState.operatorId || state.currentOperatorId;
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
    const operatorId = autostakerState.operatorId || state.currentOperatorId;
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

function updateBotStatusUI() {
    const statusText = document.getElementById('autostaker-status-text');
    const lastRunText = document.getElementById('autostaker-last-run');
    const nextRunText = document.getElementById('autostaker-next-run');
    const startBtn = document.getElementById('autostaker-start-bot');
    const panelStatus = document.getElementById('autostaker-panel-status');
    const globalIndicator = document.getElementById('autostaker-global-indicator');
    const operatorBtn = document.getElementById('autostaker-btn');
    const operatorBtnText = document.getElementById('autostaker-btn-text');
    
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
    
    // Operator page button - minimal style with green text/icon when active
    // Only update styling if button is visible (preserve hidden state)
    if (operatorBtn) {
        const isHidden = operatorBtn.classList.contains('hidden');
        const icon = operatorBtn.querySelector('svg');
        if (autostakerState.isRunning && autostakerState.operatorId === state.currentOperatorId) {
            operatorBtn.className = 'bg-[#1E1E1E] hover:bg-[#2a2a2a] border border-green-600/50 text-green-400 font-bold py-2 px-4 rounded-lg transition-colors flex items-center' + (isHidden ? ' hidden' : '');
            if (operatorBtnText) operatorBtnText.textContent = 'Autostaker';
            if (icon) icon.setAttribute('class', 'h-5 w-5 mr-2 text-green-400');
        } else {
            operatorBtn.className = 'bg-[#1E1E1E] hover:bg-[#2a2a2a] border border-[#333333] text-gray-300 font-bold py-2 px-4 rounded-lg transition-colors flex items-center' + (isHidden ? ' hidden' : '');
            if (operatorBtnText) operatorBtnText.textContent = 'Autostaker';
            if (icon) icon.setAttribute('class', 'h-5 w-5 mr-2');
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
    const operatorId = autostakerState.operatorId;
    const signer = autostakerState.operatorSigner;
    
    if (!signer || !operatorId) {
        addAutostakerLog('error', 'No signer or operator configured');
        return;
    }
    
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
                        addAutostakerLog('info', `🔄 Recalculating actions (attempt ${progress.retryAttempt}/3)...`);
                    } else if (progress.isRetry) {
                        addAutostakerLog('action', `[${progress.current}/${progress.total}] (retry) ${action.type}: ${amountData} DATA`);
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
            addAutostakerLog('error', `${result.results.successful.length} succeeded, ${result.results.failed.length} failed${queuePayoutMsg}${retryInfo}`);
            // Log details of failed actions
            for (const failed of result.results.failed) {
                const shortId = failed.action.sponsorshipId?.substring(0, 10) + '...' || 'unknown';
                const retryMsg = failed.retriesAttempted > 0 ? ` (${failed.retriesAttempted} retries)` : '';
                addAutostakerLog('error', `  ↳ ${failed.action.type} ${shortId}: ${failed.error.substring(0, 60)}${retryMsg}`);
            }
            UI.showToast({
                type: 'warning',
                title: 'Autostaker',
                message: `${result.results.successful.length} succeeded, ${result.results.failed.length} failed.`,
                duration: 8000
            });
        } else {
            addAutostakerLog('error', `All ${result.results.failed.length} action(s) failed${retryInfo}`);
            // Log details of failed actions
            for (const failed of result.results.failed) {
                const shortId = failed.action.sponsorshipId?.substring(0, 10) + '...' || 'unknown';
                const retryMsg = failed.retriesAttempted > 0 ? ` (${failed.retriesAttempted} retries)` : '';
                addAutostakerLog('error', `  ↳ ${failed.action.type} ${shortId}: ${failed.error.substring(0, 60)}${retryMsg}`);
            }
        }
        
        // Refresh operator data if we're on that view
        if (state.currentOperatorId === operatorId) {
            await refreshOperatorData(true);
        }
        
    } catch (e) {
        console.error('[Autostaker Bot] Cycle error:', e);
        addAutostakerLog('error', `Error: ${Utils.getFriendlyErrorMessage(e)}`);
    }
}

function startAutostakerBot() {
    if (autostakerState.isRunning) return;
    
    // Ensure we have operator info
    if (!autostakerState.operatorId || !autostakerState.operatorSigner) {
        autostakerState.operatorId = state.currentOperatorId;
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

function stopAutostakerBot() {
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

function setupAutostakerListeners() {
    // Autostaker button
    const autostakerBtn = document.getElementById('autostaker-btn');
    if (autostakerBtn) {
        autostakerBtn.addEventListener('click', handleAutostakerClick);
    }
    
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


// --- Streamr Coordination Stream ---
function setupOperatorStream() {
    Services.setupStreamrSubscription(state.currentOperatorId, (message) => {
        UI.addStreamMessageToUI(message, state.activeNodes, state.unreachableNodes);
    });
}

// --- Router Setup ---
function setupRouter() {
    router = new Router();

    // Home route - operators list
    router.addRoute('/', async () => {
        if (state.detailsRefreshInterval) clearInterval(state.detailsRefreshInterval);
        Services.unsubscribeFromCoordinationStream();
        if (RaceLogic) RaceLogic.stop();
        if (VisualLogic) VisualLogic.stop();
        
        UI.displayView('list');
        state.loadedOperatorCount = 0;
        fetchAndRenderOperatorsList(false, 0, state.searchQuery);
    });

    // Operator detail route
    router.addRoute('/operator/:id', async (params) => {
        if (RaceLogic) RaceLogic.stop();
        if (VisualLogic) VisualLogic.stop();
        
        UI.displayView('detail');
        state.uiState.reputationViewIndex = 0;
        state.uiState.walletViewIndex = 0;
        state.uiState.isSponsorshipsListViewActive = true;
        fetchAndRenderOperatorDetails(params.id);
    });

    // Race view route
    router.addRoute('/race', async () => {
        if (state.detailsRefreshInterval) clearInterval(state.detailsRefreshInterval);
        Services.unsubscribeFromCoordinationStream();
        if (VisualLogic) VisualLogic.stop();
        
        UI.displayView('race');
        
        try {
            const raceModule = await loadRaceModule();
            raceModule.init();
        } catch (error) {
            console.error('Failed to load race module:', error);
            router.navigate('/');
        }
    });

    // Visual view route
    router.addRoute('/visual', async () => {
        if (state.detailsRefreshInterval) clearInterval(state.detailsRefreshInterval);
        Services.unsubscribeFromCoordinationStream();
        if (RaceLogic) RaceLogic.stop();
        
        UI.displayView('visual');
        
        try {
            const visualModule = await loadVisualModule();
            visualModule.setClient(Services.getStreamrClient());
            
            visualModule.onNavigateToOperator = (operatorId) => {
                router.navigate(`/operator/${operatorId}`);
            };
            
            visualModule.init();
        } catch (error) {
            console.error('Failed to load visual module:', error);
            router.navigate('/');
        }
    });
}

// --- Event Listener Setup ---

function setupEventListeners() {
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            logger.log('Tab hidden, pausing background updates');
        } else {
            logger.log('Tab visible, resuming background updates');
            if (state.currentOperatorId) {
                refreshOperatorData(false);
            }
        }
    });

    document.getElementById('connectWalletBtn').addEventListener('click', connectWithWallet);
    document.getElementById('guestBtn').addEventListener('click', connectAsGuest);

    // --- Private Key Modal Listeners ---
    const privateKeyBtn = document.getElementById('privateKeyBtn');
    const privateKeyModal = document.getElementById('privateKeyModal');
    const privateKeyInput = document.getElementById('privateKeyInput');
    const toggleVisibilityBtn = document.getElementById('togglePrivateKeyVisibility');
    const eyeIcon = document.getElementById('eyeIcon');
    const eyeOffIcon = document.getElementById('eyeOffIcon');
    const rememberCheckbox = document.getElementById('rememberPrivateKey');
    const pkModalCancel = document.getElementById('pkModalCancel');
    const pkModalConnect = document.getElementById('pkModalConnect');

    if (privateKeyBtn) {
        privateKeyBtn.addEventListener('click', () => {
            UI.showPrivateKeyModal();
        });
    }

    if (toggleVisibilityBtn) {
        toggleVisibilityBtn.addEventListener('click', () => {
            const isPassword = privateKeyInput.type === 'password';
            privateKeyInput.type = isPassword ? 'text' : 'password';
            eyeIcon.classList.toggle('hidden', !isPassword);
            eyeOffIcon.classList.toggle('hidden', isPassword);
        });
    }

    // Encryption password section elements
    const encryptionPasswordSection = document.getElementById('encryptionPasswordSection');
    const encryptionPasswordInput = document.getElementById('encryptionPassword');
    const confirmEncryptionPasswordInput = document.getElementById('encryptionPasswordConfirm');

    // Toggle password section visibility based on remember checkbox
    if (rememberCheckbox && encryptionPasswordSection) {
        rememberCheckbox.addEventListener('change', () => {
            encryptionPasswordSection.classList.toggle('hidden', !rememberCheckbox.checked);
            if (!rememberCheckbox.checked) {
                encryptionPasswordInput.value = '';
                confirmEncryptionPasswordInput.value = '';
            }
        });
    }

    if (pkModalCancel) {
        pkModalCancel.addEventListener('click', () => {
            UI.hidePrivateKeyModal();
            privateKeyInput.value = '';
            rememberCheckbox.checked = false;
            if (encryptionPasswordSection) encryptionPasswordSection.classList.add('hidden');
            if (encryptionPasswordInput) encryptionPasswordInput.value = '';
            if (confirmEncryptionPasswordInput) confirmEncryptionPasswordInput.value = '';
        });
    }

    if (pkModalConnect) {
        pkModalConnect.addEventListener('click', async () => {
            const pk = privateKeyInput.value;
            const shouldSave = rememberCheckbox.checked;
            let encryptionPassword = null;

            if (shouldSave) {
                const pwd1 = encryptionPasswordInput.value;
                const pwd2 = confirmEncryptionPasswordInput.value;

                if (!pwd1 || pwd1.length < 6) {
                    UI.showToast('A senha deve ter pelo menos 6 caracteres', 'error');
                    return;
                }
                if (pwd1 !== pwd2) {
                    UI.showToast('As senhas não coincidem', 'error');
                    return;
                }
                encryptionPassword = pwd1;
            }

            // Clear fields
            privateKeyInput.value = '';
            rememberCheckbox.checked = false;
            if (encryptionPasswordSection) encryptionPasswordSection.classList.add('hidden');
            if (encryptionPasswordInput) encryptionPasswordInput.value = '';
            if (confirmEncryptionPasswordInput) confirmEncryptionPasswordInput.value = '';

            await connectWithPrivateKey(pk, encryptionPassword);
        });
    }

    // Allow Enter key to connect (from password confirm field when saving, or from private key field)
    if (privateKeyInput) {
        privateKeyInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter' && !rememberCheckbox.checked) {
                const pk = privateKeyInput.value;
                privateKeyInput.value = '';
                await connectWithPrivateKey(pk, null);
            }
        });
    }

    if (confirmEncryptionPasswordInput) {
        confirmEncryptionPasswordInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                pkModalConnect.click();
            }
        });
    }

    // --- Wallet Dropdown & Logout ---
    const walletDropdown = document.getElementById('wallet-dropdown');
    const logoutBtn = document.getElementById('logout-btn');

    UI.walletInfoEl.addEventListener('click', (e) => {
        if (!state.myRealAddress) {
            connectWithWallet();
        } else {
            // Toggle dropdown when wallet is connected
            e.stopPropagation();
            walletDropdown.classList.toggle('hidden');
        }
    });

    if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            logout(true);
        });
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (walletDropdown && !walletDropdown.classList.contains('hidden')) {
            if (!e.target.closest('#wallet-info') && !e.target.closest('#wallet-dropdown')) {
                walletDropdown.classList.add('hidden');
            }
        }
    });

    // --- Unlock Wallet Modal Listeners ---
    const unlockWalletModal = document.getElementById('unlockWalletModal');
    const unlockPasswordInput = document.getElementById('unlockPassword');
    const unlockConfirmBtn = document.getElementById('unlockConfirm');
    const unlockCancelBtn = document.getElementById('unlockCancel');
    const unlockForgetBtn = document.getElementById('unlockForget');

    if (unlockConfirmBtn) {
        unlockConfirmBtn.addEventListener('click', async () => {
            const password = unlockPasswordInput.value;
            if (!password) {
                UI.showToast('Digite sua senha', 'error');
                return;
            }
            unlockPasswordInput.value = '';
            await unlockWallet(password);
        });
    }

    if (unlockPasswordInput) {
        unlockPasswordInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                unlockConfirmBtn.click();
            }
        });
    }

    if (unlockCancelBtn) {
        unlockCancelBtn.addEventListener('click', () => {
            unlockWalletModal.classList.add('hidden');
            unlockPasswordInput.value = '';
            UI.setLoginModalState(true);
        });
    }

    if (unlockForgetBtn) {
        unlockForgetBtn.addEventListener('click', () => {
            clearStoredPrivateKey();
            unlockWalletModal.classList.add('hidden');
            unlockPasswordInput.value = '';
            UI.setLoginModalState(true);
            UI.showToast('Chave armazenada foi removida', 'success');
        });
    }

    UI.searchInput.addEventListener('input', (e) => handleSearch(e.target.value));
    document.getElementById('load-more-operators-btn').addEventListener('click', (e) => handleLoadMoreOperators(e.target));
    
    document.getElementById('back-to-list-btn').addEventListener('click', () => {
        // Hide autostaker panel but don't stop the bot
        UI.hideAutostakerModal();
        router.navigate('/');
    });

    // --- RACE LISTENERS ---
    const raceBtn = document.getElementById('race-view-btn');
    if (raceBtn) {
        raceBtn.addEventListener('click', handleShowRace);
    }

    const raceBackBtn = document.getElementById('race-back-to-list-btn');
    if (raceBackBtn) {
        raceBackBtn.addEventListener('click', handleBackToFromRace);
    }

    // --- VISUAL VIEW LISTENERS ---
    const visualBtn = document.getElementById('visual-view-btn');
    if (visualBtn) {
        visualBtn.addEventListener('click', handleShowVisual);
    }

    const visualBackBtn = document.getElementById('vis-btn-back');
    if (visualBackBtn) {
        visualBackBtn.addEventListener('click', handleBackFromVisual);
    }

    // Modals
    document.getElementById('tx-modal-cancel').addEventListener('click', () => UI.transactionModal.classList.add('hidden'));
    document.getElementById('stake-modal-cancel').addEventListener('click', () => UI.stakeModal.classList.add('hidden'));
    document.getElementById('operator-settings-modal-cancel').addEventListener('click', () => UI.operatorSettingsModal.classList.add('hidden'));
    
    // Settings
    document.getElementById('settings-btn').addEventListener('click', () => {
        UI.theGraphApiKeyInput.value = localStorage.getItem('the-graph-api-key') || '';
        document.getElementById('etherscan-api-key-input').value = localStorage.getItem('etherscan-api-key') || '';
        UI.settingsModal.classList.remove('hidden');
    });
    document.getElementById('settings-cancel-btn').addEventListener('click', () => UI.settingsModal.classList.add('hidden'));
    document.getElementById('settings-save-btn').addEventListener('click', () => {
        const newGraphKey = UI.theGraphApiKeyInput.value.trim();
        if (newGraphKey) {
            localStorage.setItem('the-graph-api-key', newGraphKey);
        } else {
            localStorage.removeItem('the-graph-api-key');
        }
        // Graph API key is read dynamically from localStorage by getGraphUrl()
        
        const newEtherscanKey = document.getElementById('etherscan-api-key-input').value.trim();
        if (newEtherscanKey) {
            localStorage.setItem('etherscan-api-key', newEtherscanKey);
        } else {
            localStorage.removeItem('etherscan-api-key');
        }
        Services.updateEtherscanApiKey(newEtherscanKey);
        
        UI.settingsModal.classList.add('hidden');
        UI.showToast({ type: 'success', title: 'Settings Saved', message: 'Data will be refreshed with the new API keys.' });
        
        state.loadedOperatorCount = 0;
        fetchAndRenderOperatorsList(false, 0, state.searchQuery);
    });
    
    document.body.addEventListener('click', (e) => {
        const target = e.target;

        const operatorCard = target.closest('.card, .operator-link');
        if (operatorCard && operatorCard.dataset.operatorId) {
            e.preventDefault();
            handleShowOperatorDetails(operatorCard.dataset.operatorId);
            return;
        }

        if (target.id === 'delegate-btn') handleDelegateClick();
        if (target.id === 'undelegate-btn') handleUndelegateClick();
        if (target.id === 'process-queue-btn') handleProcessQueueClick(target);
        if (target.id === 'collect-all-earnings-btn') handleCollectAllEarningsClick(target);
        if (target.id === 'load-more-delegators-btn') handleLoadMoreDelegators(target);
        if (target.id === 'edit-operator-settings-btn') handleEditOperatorSettingsClick();
        
        if (target.closest('#toggle-stats-btn')) UI.toggleStatsPanel(false, state.uiState);
        if (target.id === 'toggle-delegator-view-btn') {
            UI.toggleDelegatorQueueView(state.currentOperatorData, state.uiState);
            if(state.uiState.isDelegatorViewActive) {
                UI.updateDelegatorsSection(state.currentDelegations, state.totalDelegatorCount);
            }
        }
        if (target.id === 'toggle-reputation-view-btn') UI.toggleReputationView(false, state.uiState);
        if (target.id === 'toggle-wallets-view-btn') UI.toggleWalletsView(false, state.uiState);
        if (target.id === 'toggle-sponsorship-view-btn') {
            UI.toggleSponsorshipsView(state.uiState, state.currentOperatorData);
            if (!state.uiState.isSponsorshipsListViewActive) {
                 UI.renderSponsorshipsHistory(state.sponsorshipHistory);
            }
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
    
    // Setup Autostaker listeners
    setupAutostakerListeners();
}


// --- App Entry Point ---
document.addEventListener('DOMContentLoaded', async () => {
    setupRouter();
    setupEventListeners();
    
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
    
    // Check for stored private key - show unlock modal
    if (hasStoredPrivateKey()) {
        // Show unlock modal instead of auto-connecting
        const unlockWalletModal = document.getElementById('unlockWalletModal');
        if (unlockWalletModal) {
            unlockWalletModal.classList.remove('hidden');
            document.getElementById('unlockPassword')?.focus();
            return;
        }
    }
    
    UI.loginModal.classList.remove('hidden');
});