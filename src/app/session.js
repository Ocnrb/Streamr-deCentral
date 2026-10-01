// Signing in (browser wallet, private key or guest), unlocking the saved key, signing out, and starting the app
import * as Constants from '../core/constants.js';
import * as Utils from '../core/utils.js';
import * as UI from '../ui/ui.js';
import * as Services from '../core/services.js';
import { navigationController } from '../ui/navigation.js';
import { OperatorLogic } from '../features/operator.js';
import { installAvatarHydrator } from '../core/streamAvatar.js';
import { getOperatorProfile } from '../core/profile.js';
import { state, setAccount } from './state.js';
import { loadedPage } from './pages.js';
import { router } from './routes.js';
import { isAutostakerRunning, stopAutostakerBot } from './autostakerPanel.js';
import { savePrivateKey, decryptPrivateKey, hasStoredPrivateKey, clearStoredPrivateKey } from './keystore.js';

const { logger } = Utils;

/**
 * The saved operator profile keeps the avatar of when it was saved: recompute it from the operator's
 * current metadata (IPFS > avatar stream > placeholder) and update the shortcut when it changed
 */
async function refreshSavedOperatorProfile() {
    const profile = getOperatorProfile();
    const id = (profile?.id || profile?.operatorId || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(id)) return;
    try {
        const data = await Services.runQuery(`{ operator(id: "${id}") { id metadataJsonString } }`);
        if (!data?.operator) return;
        const { name, imageUrl } = Utils.parseOperatorMetadata(data.operator.metadataJsonString);
        UI.syncSavedOperatorProfile(id, name || id, imageUrl);
    } catch (e) {
        console.warn('Could not refresh the saved operator profile:', e);
    }
}

async function initializeApp() {
    // Operator avatars hosted on a stream (IPFS CID > avatar stream > placeholder)
    installAvatarHydrator();
    await Services.cleanupClient();
    try {
        // Configure Streamr SDK with minimal logging (only errors)
        const streamrClient = new StreamrClient({ logLevel: 'error', contracts: Constants.STREAMR_SDK_CONTRACTS_CONFIG });
        Services.setStreamrClient(streamrClient);

        // Start historical price stream in background (non-blocking)
        // App can start immediately while this loads
        Services.setupHistoricalPriceStream();
        
        // Register callback for when historical data is loaded
        Services.onHistoricalDataLoaded(({ priceMap }) => {
            state.historicalDataPriceMap = priceMap;
            // Propagate to modules
            OperatorLogic.setSharedState({ historicalDataPriceMap: priceMap });
            loadedPage('delegators')?.setSharedState({ historicalDataPriceMap: priceMap });
        });

        await Services.setupDataPriceStream((price) => {
            state.dataPriceUSD = price;
            OperatorLogic.setSharedState({ dataPriceUSD: price });
            // Update delegators module if loaded
            loadedPage('delegators')?.setSharedState({ dataPriceUSD: price });
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

        // Initialize profile shortcut in sidebar/nav, then refresh its name / avatar from the subgraph
        UI.renderProfileShortcut();
        refreshSavedOperatorProfile();

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
            // The Bridge switches to Ethereum and back on purpose
            if (window.appNetworkSwitchInProgress) return;
            logger.log('Wallet network changed, reloading page.');
            window.location.reload();
        });
    }
}

export async function connectWithWallet() {
    const injectedProvider = window.ethereum || window.top?.ethereum;
    if (!injectedProvider) {
        UI.showToast({ type: 'error', title: 'MetaMask Not Found', message: 'Please install the MetaMask extension.', duration: 0 });
        return;
    }

    try {
        UI.setLoginModalState('loading', 'wallet');
        const provider = new ethers.providers.Web3Provider(injectedProvider);
        await provider.send("eth_requestAccounts", []);
        const signer = provider.getSigner();
        setAccount(signer, await signer.getAddress());

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
        setAccount(null);
        const message = (err.code === 4001 || err.info?.error?.code === 4001) 
            ? "The signature request was rejected in your wallet."
            : "Wallet connection request was rejected or failed.";
        UI.showToast({ type: 'error', title: 'Wallet Connection Failed', message: message, duration: 8000 });
        UI.setLoginModalState('buttons');
    }
}

export async function connectAsGuest() {
    UI.setLoginModalState('loading', 'guest');
    setAccount(null);
    navigationController.updateWallet(null);
    sessionStorage.removeItem('authMethod');
    await initializeApp();
}

/**
 * Connect using a private key
 * @param {string} privateKey - The private key to use
 * @param {string|null} encryptionPassword - Password to encrypt and save the key (null = don't save)
 */
export async function connectWithPrivateKey(privateKey, encryptionPassword = null) {
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
        
        setAccount(wallet, wallet.address);
        
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
        setAccount(null);
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
export async function unlockWallet(password) {
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
export function logout(clearSavedKey = true) {
    // Stop autostaker bot if running
    if (isAutostakerRunning()) {
        stopAutostakerBot();
    }
    
    // Clear state
    setAccount(null);
    
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


/** Removes the saved key on request (the unlock attempts start over) */
export function forgetSavedKey() {
    clearStoredPrivateKey();
    failedUnlockAttempts = 0;
}
