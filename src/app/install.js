// PWA install buttons on the login screen (early.js keeps the browser's install prompt from before this loads)
import * as Utils from '../core/utils.js';
import * as UI from '../ui/ui.js';

// Also listen here in case the event fires after module loads
window.addEventListener('beforeinstallprompt', (e) => {
    Utils.logger.log('PWA: beforeinstallprompt event captured (module)');
    e.preventDefault();
    window.deferredInstallPrompt = e;
    updateInstallButtons();
});

// Listen for successful installation
window.addEventListener('appinstalled', () => {
    Utils.logger.log('PWA: App installed successfully');
    window.deferredInstallPrompt = null;
    document.getElementById('installAppSection')?.classList.add('hidden');
    UI.showToast({
        type: 'success',
        title: 'App Installed',
        message: 'Streamr deCentral is now installed on your device!',
        duration: 4000
    });
});

/**
 * Detect the user's operating system/platform
 * @returns {'android'|'ios'|'windows'|'macos'|'other'}
 */
function getPlatform() {
    const ua = navigator.userAgent || navigator.vendor || window.opera;
    if (/android/i.test(ua)) return 'android';
    if (/iPad|iPhone|iPod/.test(ua) && !window.MSStream) return 'ios';
    if (/Win/.test(navigator.platform)) return 'windows';
    if (/Mac/.test(navigator.platform)) return 'macos';
    return 'other';
}

/**
 * Check if the app is running in standalone mode (already installed)
 * @returns {boolean}
 */
function isAppInstalled() {
    return window.matchMedia('(display-mode: standalone)').matches ||
           window.navigator.standalone === true ||
           document.referrer.includes('android-app://');
}
// Expose globally for use in other modules
window.isAppInstalled = isAppInstalled;

/**
 * Update the visibility of install buttons based on platform and availability
 */
export function updateInstallButtons() {
    const installSection = document.getElementById('installAppSection');
    if (!installSection) return;

    // Hide everything if app is already installed
    if (isAppInstalled()) {
        installSection.classList.add('hidden');
        return;
    }

    // Show all buttons - they're always visible by default in HTML
    installSection.classList.remove('hidden');

    // Log status for debugging
    Utils.logger.log('PWA: Install prompt available:', !!window.deferredInstallPrompt);
}

/**
 * Trigger the native install prompt (for Android, Windows, macOS)
 */
async function triggerInstallPrompt() {
    const platform = getPlatform();
    Utils.logger.log('PWA: Install button clicked, platform:', platform, 'prompt available:', !!window.deferredInstallPrompt);

    if (!window.deferredInstallPrompt) {
        // Provide helpful message based on platform
        let message = 'Use your browser menu to install this app.';
        if (platform === 'windows') {
            message = 'Click the install icon in the address bar, or use browser menu → "Install Streamr deCentral"';
        } else if (platform === 'android') {
            message = 'Tap the browser menu (⋮) → "Install app" or "Add to Home screen"';
        } else if (platform === 'macos') {
            message = 'Click the install icon in the address bar, or use browser menu → "Install Streamr deCentral"';
        }

        UI.showToast({
            type: 'info',
            title: 'Install via Browser Menu',
            message: message,
            duration: 6000
        });
        return;
    }

    try {
        window.deferredInstallPrompt.prompt();
        const { outcome } = await window.deferredInstallPrompt.userChoice;
        Utils.logger.log('PWA: User choice:', outcome);

        if (outcome === 'accepted') {
            UI.showToast({
                type: 'success',
                title: 'App Installed',
                message: 'Streamr deCentral has been installed successfully!',
                duration: 3000
            });
            document.getElementById('installAppSection')?.classList.add('hidden');
        }

        // Clear the deferred prompt - can only be used once
        window.deferredInstallPrompt = null;
    } catch (error) {
        console.error('PWA: Install prompt error:', error);
        UI.showToast({
            type: 'error',
            title: 'Installation Failed',
            message: 'Please try installing via browser menu.',
            duration: 4000
        });
    }
}

/**
 * Show iOS install instructions modal
 */
function showIOSInstallInstructions() {
    const modal = document.getElementById('iosInstallModal');
    if (modal) {
        modal.classList.remove('hidden');
    }
}

/**
 * Setup PWA install button event listeners
 */
export function setupInstallButtons() {
    const androidBtn = document.getElementById('installAndroidBtn');
    const windowsBtn = document.getElementById('installWindowsBtn');
    const macosBtn = document.getElementById('installMacOSBtn');
    const iosBtn = document.getElementById('installIOSBtn');
    const iosModalClose = document.getElementById('iosInstallModalClose');

    androidBtn?.addEventListener('click', triggerInstallPrompt);
    windowsBtn?.addEventListener('click', triggerInstallPrompt);
    macosBtn?.addEventListener('click', triggerInstallPrompt);
    iosBtn?.addEventListener('click', showIOSInstallInstructions);

    iosModalClose?.addEventListener('click', () => {
        document.getElementById('iosInstallModal')?.classList.add('hidden');
    });

    // Close iOS modal on backdrop click
    document.getElementById('iosInstallModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'iosInstallModal') {
            e.target.classList.add('hidden');
        }
    });

    Utils.logger.log('PWA: Install buttons setup complete, prompt available:', !!window.deferredInstallPrompt);
}
