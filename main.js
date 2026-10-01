import './src/core/libs.js';   // Leaflet's CSS and the libraries as globals (MapLibre plugin)
import * as Constants from './src/core/constants.js';
import * as UI from './src/ui/ui.js';
import * as Services from './src/core/services.js';
import { logger } from './src/core/utils.js';
import { OperatorLogic } from './src/features/operator.js';
import { syncOperatorState } from './src/app/state.js';
import { router, setupRouter } from './src/app/routes.js';
import { logout } from './src/app/session.js';
import { setupLoginForms } from './src/app/loginForms.js';
import { hasStoredPrivateKey } from './src/app/keystore.js';
import { handleAutostakerClick, updateBotStatusUI, setupAutostakerListeners } from './src/app/autostakerPanel.js';
import { setupInstallButtons, updateInstallButtons } from './src/app/install.js';

// The mouse wheel over a focused number input changes its value in most browsers: blur it so the
// wheel scrolls the page / modal instead
document.addEventListener('wheel', (e) => {
    const target = e.target;
    if (target instanceof HTMLInputElement && target.type === 'number' && document.activeElement === target) target.blur();
}, { passive: true });

// For the navigation controller and the modules that call back into the app
window.handleLogout = () => logout(true);
window.handleAutostakerClick = handleAutostakerClick;
window.updateBotStatusUI = updateBotStatusUI;
window.navigateToOperator = (operatorId) => {
    if (router) router.navigate(`/operator/${operatorId}`);
};

// --- Delegated Listeners (no inline handlers under the CSP) ---
function setupDelegatedListeners() {
    // Delegators page buttons (data-delegators-action)
    document.addEventListener('click', (e) => {
        const button = e.target.closest('[data-delegators-action]');
        if (!button) return;
        const action = window.DelegatorsLogic?.[button.dataset.delegatorsAction];
        if (typeof action === 'function') action.call(window.DelegatorsLogic, ...(button.dataset.delegatorsArg ? [button.dataset.delegatorsArg] : []));
    });
    // Images with a fallback (data-fallback-src) switch to it once when they fail
    document.addEventListener('error', (e) => {
        const img = e.target;
        if (img?.tagName === 'IMG' && img.dataset.fallbackSrc && img.getAttribute('src') !== img.dataset.fallbackSrc) img.src = img.dataset.fallbackSrc;
    }, true);
    // Table rows that open a page (data-nav-href, escaped): the links inside them keep their own target
    document.addEventListener('click', (e) => {
        const row = e.target.closest('[data-nav-href]');
        if (!row || e.target.closest('a[href], button')) return;
        e.preventDefault();
        router.navigate(row.dataset.navHref);
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

    // --- VISUAL VIEW LISTENERS ---
    const visualBackBtn = document.getElementById('vis-btn-back');
    if (visualBackBtn) {
        visualBackBtn.addEventListener('click', () => router.navigate('/'));
    }

    // Modals
    document.getElementById('tx-modal-cancel').addEventListener('click', () => UI.transactionModal.classList.add('hidden'));
    document.getElementById('stake-modal-cancel').addEventListener('click', () => UI.stakeModal.classList.add('hidden'));
    
    // Settings modal cancel/save handlers
    document.getElementById('settings-cancel-btn').addEventListener('click', () => UI.settingsModal.classList.add('hidden'));
    
    // About modal close handlers
    const aboutModal = document.getElementById('aboutModal');
    const aboutModalClose = document.getElementById('aboutModalClose');
    if (aboutModalClose && aboutModal) {
        aboutModalClose.addEventListener('click', () => aboutModal.classList.add('hidden'));
        // Close on background click
        aboutModal.addEventListener('click', (e) => {
            if (e.target === aboutModal) aboutModal.classList.add('hidden');
        });
    }
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
    setupDelegatedListeners();
    setupLoginForms();
    setupEventListeners();
    
    // Setup PWA install buttons
    setupInstallButtons();
    updateInstallButtons();
    
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
