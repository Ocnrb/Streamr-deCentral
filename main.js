import * as Constants from './src/core/constants.js';
import * as Utils from './src/core/utils.js';
import * as UI from './src/ui/ui.js';
import * as Services from './src/core/services.js';
import { Router } from './src/core/router.js';
import * as Autostaker from './src/features/autostaker.js';
import { navigationController } from './src/ui/navigation.js';
import { OperatorLogic } from './src/features/operator.js';

// Lazy-loaded modules
let RaceLogic = null;
let VisualLogic = null;
let DelegatorsLogic = null;
let raceModuleLoading = false;
let visualModuleLoading = false;
let delegatorsModuleLoading = false;

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

/**
 * Lazy load the Delegators module
 * @returns {Promise<object>} The DelegatorsLogic module
 */
async function loadDelegatorsModule() {
    if (DelegatorsLogic) return DelegatorsLogic;
    if (delegatorsModuleLoading) {
        // Wait for existing load to complete
        while (delegatorsModuleLoading) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        return DelegatorsLogic;
    }
    
    delegatorsModuleLoading = true;
    
    try {
        const module = await import('./src/features/delegators.js');
        DelegatorsLogic = module.DelegatorsLogic;
        window.DelegatorsLogic = DelegatorsLogic; // Expose globally for HTML onclick handlers
        return DelegatorsLogic;
    } catch (error) {
        UI.showToast({
            type: 'error',
            title: 'Failed to load Delegators View',
            message: error.message,
            duration: 5000
        });
        throw error;
    } finally {
        delegatorsModuleLoading = false;
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
    // Authentication
    signer: null,
    myRealAddress: '',
    
    // Shared data (passed to modules)
    historicalDataPriceMap: null, 
    dataPriceUSD: null,
};

// Router instance
let router = null;

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
            // Update delegators module if loaded
            if (DelegatorsLogic) {
                DelegatorsLogic.setSharedState({ dataPriceUSD: price });
            }
        });
        
        // Hide login modal and show main UI
        UI.loginModal.classList.add('hidden');
        UI.mainContainer.classList.remove('hidden');
        
        // Show navigation elements after login (with proper responsive classes)
        const sidebar = document.getElementById('app-sidebar');
        const mobileHeader = document.getElementById('mobile-header');
        const desktopHeader = document.getElementById('desktop-header');
        const bottomNav = document.getElementById('bottom-nav');
        
        // Sidebar: hidden on mobile, flex on md+
        if (sidebar) {
            sidebar.className = 'hidden md:flex flex-col fixed left-0 top-0 h-full w-[72px] lg:w-72 bg-[#1A1A1A] border-r border-[#2a2a2a] z-40 transition-all duration-300';
        }
        // Mobile header: visible on mobile, hidden on md+
        if (mobileHeader) {
            mobileHeader.className = 'md:hidden fixed top-0 left-0 right-0 z-30 bg-[#121212]/95 backdrop-blur-md border-b border-[#2a2a2a]';
        }
        // Desktop header: hidden on mobile, block on md+
        if (desktopHeader) {
            desktopHeader.className = 'hidden md:block fixed top-0 right-0 z-30 bg-[#121212]/95 backdrop-blur-md border-b border-[#2a2a2a] transition-all duration-300';
            desktopHeader.style.left = ''; // Let CSS control this
        }
        // Bottom nav: visible on mobile, hidden on md+
        if (bottomNav) {
            bottomNav.className = 'md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#1A1A1A]/95 backdrop-blur-md border-t border-[#2a2a2a] safe-area-bottom';
        }

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

        navigationController.updateWallet(state.myRealAddress);
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
    navigationController.updateWallet(null);
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
        
        navigationController.updateWallet(state.myRealAddress);
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

// Track failed unlock attempts
const MAX_UNLOCK_ATTEMPTS = 5;
let failedUnlockAttempts = 0;

/**
 * Unlock wallet with stored encrypted private key
 * @param {string} password - User's unlock password
 * @returns {boolean} True if unlock successful
 */
async function unlockWallet(password) {
    if (!hasStoredPrivateKey()) return false;
    
    const unlockModal = document.getElementById('unlockWalletModal');
    const unlockError = document.getElementById('unlockError');
    
    try {
        const privateKey = await decryptPrivateKey(password);
        if (privateKey) {
            // Success - reset counter and hide modal
            failedUnlockAttempts = 0;
            if (unlockError) unlockError.classList.add('hidden');
            if (unlockModal) unlockModal.classList.add('hidden');
            await connectWithPrivateKey(privateKey, null); // null = don't re-save
            return true;
        }
        
        // Failed attempt
        failedUnlockAttempts++;
        const remainingAttempts = MAX_UNLOCK_ATTEMPTS - failedUnlockAttempts;
        
        if (remainingAttempts <= 0) {
            // Max attempts reached - clear stored key for security
            clearStoredPrivateKey();
            failedUnlockAttempts = 0;
            if (unlockModal) unlockModal.classList.add('hidden');
            UI.showToast({
                type: 'error',
                title: 'Wallet Forgotten',
                message: 'Too many failed attempts. Stored key has been removed for security.',
                duration: 8000
            });
            UI.setLoginModalState(true);
            return false;
        }
        
        // Show remaining attempts warning
        if (unlockError) {
            unlockError.textContent = `Incorrect password. ${remainingAttempts} attempt${remainingAttempts === 1 ? '' : 's'} remaining.`;
            unlockError.classList.remove('hidden');
        }
        
        return false;
    } catch (e) {
        logger.error('Unlock failed:', e);
        failedUnlockAttempts++;
        const remainingAttempts = MAX_UNLOCK_ATTEMPTS - failedUnlockAttempts;
        
        if (remainingAttempts <= 0) {
            clearStoredPrivateKey();
            failedUnlockAttempts = 0;
            if (unlockModal) unlockModal.classList.add('hidden');
            UI.showToast({
                type: 'error',
                title: 'Wallet Forgotten',
                message: 'Too many failed attempts. Stored key has been removed for security.',
                duration: 8000
            });
            UI.setLoginModalState(true);
            return false;
        }
        
        if (unlockError) {
            unlockError.textContent = `Error: ${e.message}. ${remainingAttempts} attempt${remainingAttempts === 1 ? '' : 's'} remaining.`;
            unlockError.classList.remove('hidden');
        }
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
    
    // Hide sidebar wallet dropdown
    const sidebarDropdown = document.getElementById('sidebar-wallet-dropdown');
    if (sidebarDropdown) sidebarDropdown.classList.add('hidden');
    
    // Reload the page to reset everything
    window.location.reload();
}

// Expose logout globally for navigation controller
window.handleLogout = () => logout(true);

// Expose handleAutostakerClick globally for navigation controller
window.handleAutostakerClick = handleAutostakerClick;

// --- Helper to sync state with OperatorLogic ---
function syncOperatorState() {
    OperatorLogic.setSharedState({
        signer: state.signer,
        myRealAddress: state.myRealAddress,
        dataPriceUSD: state.dataPriceUSD,
        historicalDataPriceMap: state.historicalDataPriceMap
    });
}

// Expose updateBotStatusUI globally for OperatorLogic to call
window.updateBotStatusUI = updateBotStatusUI;

// Expose navigateToOperator globally for DelegatorsLogic to call
window.navigateToOperator = (operatorId) => {
    if (router) router.navigate(`/operator/${operatorId}`);
};

// --- Event Handlers ---

function handleBackFromVisual() {
    router.navigate('/');
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

function updateBotStatusUI() {
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
        const opState = OperatorLogic.getState();
        if (opState.currentOperatorId === operatorId) {
            await OperatorLogic.refreshData(true);
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


// --- Router Setup ---
function setupRouter() {
    router = new Router();
    
    // Make router available globally for navigation controller
    window.router = router;

    // Home route - operators list
    router.addRoute('/', async () => {
        OperatorLogic.stop();
        Services.unsubscribeFromCoordinationStream();
        if (RaceLogic) RaceLogic.stop();
        if (VisualLogic) VisualLogic.stop();
        
        UI.displayView('list');
        navigationController.updateActiveState('operators');
        navigationController.updatePageTitle('operators');
        syncOperatorState();
        OperatorLogic.resetListState();
        OperatorLogic.fetchAndRenderList(false, 0, '');
    });

    // Operator detail route
    router.addRoute('/operator/:id', async (params) => {
        if (RaceLogic) RaceLogic.stop();
        if (VisualLogic) VisualLogic.stop();
        
        UI.displayView('detail');
        navigationController.updateActiveState('operators');
        navigationController.updatePageTitle('operators', 'Operator Details');
        syncOperatorState();
        OperatorLogic.fetchAndRenderDetails(params.id);
    });

    // Race view route
    router.addRoute('/race', async () => {
        OperatorLogic.stop();
        Services.unsubscribeFromCoordinationStream();
        if (VisualLogic) VisualLogic.stop();
        
        UI.displayView('race');
        navigationController.updateActiveState('race');
        navigationController.updatePageTitle('race');
        
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
        OperatorLogic.stop();
        Services.unsubscribeFromCoordinationStream();
        if (RaceLogic) RaceLogic.stop();
        
        UI.displayView('visual');
        navigationController.updateActiveState('visual');
        navigationController.updatePageTitle('visual');
        // Hide navigation in visual view (full screen)
        navigationController.setNavigationVisibility(false);
        
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

    // Delegators list route
    router.addRoute('/delegators', async () => {
        OperatorLogic.stop();
        Services.unsubscribeFromCoordinationStream();
        if (RaceLogic) RaceLogic.stop();
        if (VisualLogic) VisualLogic.stop();
        
        UI.displayView('delegators-list');
        navigationController.updateActiveState('delegators');
        navigationController.updatePageTitle('delegators');
        
        try {
            const delegatorsModule = await loadDelegatorsModule();
            delegatorsModule.setSharedState({ 
                dataPriceUSD: state.dataPriceUSD,
                historicalDataPriceMap: state.historicalDataPriceMap
            });
            delegatorsModule.init();
        } catch (error) {
            console.error('Failed to load delegators module:', error);
            router.navigate('/');
        }
    });

    // Delegator detail route
    router.addRoute('/delegator/:id', async (params) => {
        OperatorLogic.stop();
        Services.unsubscribeFromCoordinationStream();
        if (RaceLogic) RaceLogic.stop();
        if (VisualLogic) VisualLogic.stop();
        
        UI.displayView('delegator-detail');
        navigationController.updateActiveState('delegators');
        navigationController.updatePageTitle('delegators', 'Delegator Details');
        
        try {
            const delegatorsModule = await loadDelegatorsModule();
            delegatorsModule.setSharedState({ 
                dataPriceUSD: state.dataPriceUSD,
                historicalDataPriceMap: state.historicalDataPriceMap
            });
            delegatorsModule.showDelegatorDetail(params.id);
        } catch (error) {
            console.error('Failed to load delegators module:', error);
            router.navigate('/delegators');
        }
    });
}

// --- Event Listener Setup ---

function setupEventListeners() {
    // Visibility change - delegate to OperatorLogic for refresh
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            logger.log('Tab hidden, pausing background updates');
        } else {
            logger.log('Tab visible, resuming background updates');
            const opState = OperatorLogic.getState();
            if (opState.currentOperatorId) {
                OperatorLogic.refreshData(false);
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
            // Reset error message but keep attempt counter (security)
            const unlockError = document.getElementById('unlockError');
            if (unlockError) unlockError.classList.add('hidden');
            UI.setLoginModalState(true);
        });
    }

    if (unlockForgetBtn) {
        unlockForgetBtn.addEventListener('click', () => {
            clearStoredPrivateKey();
            failedUnlockAttempts = 0; // Reset counter when intentionally forgetting
            unlockWalletModal.classList.add('hidden');
            unlockPasswordInput.value = '';
            const unlockError = document.getElementById('unlockError');
            if (unlockError) unlockError.classList.add('hidden');
            UI.setLoginModalState(true);
            UI.showToast({ type: 'success', title: 'Wallet Forgotten', message: 'Stored key has been removed.' });
        });
    }

    // --- VISUAL VIEW LISTENERS ---
    const visualBackBtn = document.getElementById('vis-btn-back');
    if (visualBackBtn) {
        visualBackBtn.addEventListener('click', handleBackFromVisual);
    }

    // Modals
    document.getElementById('tx-modal-cancel').addEventListener('click', () => UI.transactionModal.classList.add('hidden'));
    document.getElementById('stake-modal-cancel').addEventListener('click', () => UI.stakeModal.classList.add('hidden'));
    document.getElementById('operator-settings-modal-cancel').addEventListener('click', () => UI.operatorSettingsModal.classList.add('hidden'));
    
    // Settings - both desktop header and sidebar buttons
    const openSettings = () => {
        UI.theGraphApiKeyInput.value = localStorage.getItem(Constants.STORAGE_KEYS.GRAPH_API_KEY) || '';
        document.getElementById('etherscan-api-key-input').value = localStorage.getItem(Constants.STORAGE_KEYS.ETHERSCAN_API_KEY) || '';
        UI.settingsModal.classList.remove('hidden');
    };
    
    document.getElementById('sidebar-settings-btn')?.addEventListener('click', openSettings);
    
    document.getElementById('settings-cancel-btn').addEventListener('click', () => UI.settingsModal.classList.add('hidden'));
    document.getElementById('settings-save-btn').addEventListener('click', () => {
        const newGraphKey = UI.theGraphApiKeyInput.value.trim();
        if (newGraphKey) {
            localStorage.setItem(Constants.STORAGE_KEYS.GRAPH_API_KEY, newGraphKey);
        } else {
            localStorage.removeItem(Constants.STORAGE_KEYS.GRAPH_API_KEY);
        }
        // Graph API key is read dynamically from localStorage by getGraphUrl()
        
        const newEtherscanKey = document.getElementById('etherscan-api-key-input').value.trim();
        Services.updateEtherscanApiKey(newEtherscanKey);
        
        UI.settingsModal.classList.add('hidden');
        UI.showToast({ type: 'success', title: 'Settings Saved', message: 'Data will be refreshed with the new API keys.' });
        
        syncOperatorState();
        OperatorLogic.resetListState();
        OperatorLogic.fetchAndRenderList(false, 0, '');
    });
    
    // Setup OperatorLogic event listeners (handles all operator-specific UI events)
    OperatorLogic.setupEventListeners();
    
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