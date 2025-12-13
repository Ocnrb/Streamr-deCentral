// navigation.js - Handles navigation UI components (sidebar, bottom nav, headers)
import { STORAGE_KEYS } from '../core/constants.js';

/**
 * Navigation Controller
 * Manages the navigation state across sidebar, bottom nav, and headers
 */
class NavigationController {
    constructor() {
        // Elements
        this.sidebar = document.getElementById('app-sidebar');
        this.bottomNav = document.getElementById('bottom-nav');
        this.mobileHeader = document.getElementById('mobile-header');
        this.desktopHeader = document.getElementById('desktop-header');
        
        // Page title elements
        this.mobilePageTitle = document.getElementById('mobile-page-title');
        this.desktopPageTitle = document.getElementById('desktop-page-title');
        
        // Price elements
        this.desktopPriceValue = document.getElementById('data-price-value');
        this.mobilePriceValue = document.getElementById('mobile-data-price');
        
        // Wallet elements
        this.mobileWalletBtn = document.getElementById('mobile-wallet-btn');
        this.sidebarWallet = document.getElementById('sidebar-wallet');
        this.sidebarWalletIcon = document.getElementById('sidebar-wallet-icon');
        this.sidebarWalletAddress = document.getElementById('sidebar-wallet-address');
        this.sidebarWalletDropdown = document.getElementById('sidebar-wallet-dropdown');
        this.sidebarLogoutBtn = document.getElementById('sidebar-logout-btn');
        
        // Navigation items
        this.sidebarNavLinks = this.sidebar?.querySelectorAll('.nav-link[data-nav]') || [];
        this.bottomNavItems = this.bottomNav?.querySelectorAll('[data-nav]') || [];
        
        // Page titles map
        this.pageTitles = {
            'operators': 'Operators',
            'visual': 'Network Map',
            'race': 'Leaderboard',
            'delegators': 'Delegators',
            'streams': 'Streams'
        };
        
        this.currentPage = 'operators';
        
        this.init();
    }
    
    init() {
        this.setupEventListeners();
        this.setupTooltips();
        this.updateActiveState(this.getPageFromPath());
    }
    
    /**
     * Get page name from URL path
     */
    getPageFromPath(path = window.location.pathname) {
        if (path === '/' || path === '') return 'operators';
        
        const segments = path.split('/').filter(Boolean);
        if (segments.length === 0) return 'operators';
        
        // Check for operator detail view
        if (segments[0] === 'operator') return 'operators';
        
        // Check for known pages
        const page = segments[0];
        if (this.pageTitles[page]) return page;
        
        return 'operators';
    }
    
    /**
     * Setup event listeners for navigation
     */
    setupEventListeners() {
        // Sidebar navigation clicks
        this.sidebarNavLinks.forEach(link => {
            const navId = link.getAttribute('data-nav');
            
            // Skip disabled links
            if (link.classList.contains('cursor-not-allowed')) {
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                });
                return;
            }
            
            link.addEventListener('click', (e) => {
                e.preventDefault();
                this.navigateTo(navId, link.getAttribute('href'));
            });
        });
        
        // Bottom navigation clicks
        this.bottomNavItems.forEach(item => {
            const navId = item.getAttribute('data-nav');
            
            // Skip buttons (autostaker, more)
            if (item.tagName === 'BUTTON') return;
            
            item.addEventListener('click', (e) => {
                e.preventDefault();
                this.navigateTo(navId, item.getAttribute('href'));
            });
        });
        
        // Bottom nav More dropdown
        const bottomNavMore = document.getElementById('bottom-nav-more');
        const bottomNavMoreMenu = document.getElementById('bottom-nav-more-menu');
        const bottomNavOverlay = document.getElementById('bottom-nav-overlay');
        const bottomNavAutostaker = document.getElementById('bottom-nav-autostaker');
        const bottomNavSettings = document.getElementById('bottom-nav-settings');
        
        // Helper to show/hide menu with overlay
        const showMoreMenu = () => {
            bottomNavMoreMenu?.classList.remove('hidden');
            bottomNavOverlay?.classList.remove('hidden');
        };
        
        const hideMoreMenu = () => {
            bottomNavMoreMenu?.classList.add('hidden');
            bottomNavOverlay?.classList.add('hidden');
        };
        
        if (bottomNavMore && bottomNavMoreMenu) {
            bottomNavMore.addEventListener('click', (e) => {
                e.stopPropagation();
                const isHidden = bottomNavMoreMenu.classList.contains('hidden');
                if (isHidden) {
                    showMoreMenu();
                } else {
                    hideMoreMenu();
                }
            });
            
            // Close menu when clicking overlay (captures all clicks, prevents propagation)
            if (bottomNavOverlay) {
                bottomNavOverlay.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    hideMoreMenu();
                });
            }
            
            // Handle menu item clicks
            bottomNavMoreMenu.querySelectorAll('a[data-nav]').forEach(link => {
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    hideMoreMenu();
                    this.navigateTo(link.getAttribute('data-nav'), link.getAttribute('href'));
                });
            });
        }
        
        // Autostaker button (now in main nav bar)
        if (bottomNavAutostaker) {
            bottomNavAutostaker.addEventListener('click', () => {
                this.openAutostaker();
            });
        }
        
        // Settings button (in More menu)
        if (bottomNavSettings) {
            bottomNavSettings.addEventListener('click', () => {
                hideMoreMenu();
                this.openSettings();
            });
        }
        
        // About button (in More menu)
        const bottomNavAbout = document.getElementById('bottom-nav-about');
        if (bottomNavAbout) {
            bottomNavAbout.addEventListener('click', () => {
                hideMoreMenu();
                this.openAbout();
            });
        }
        
        // Sidebar buttons
        const sidebarAutostaker = document.getElementById('sidebar-autostaker-btn');
        const sidebarSettings = document.getElementById('sidebar-settings-btn');
        
        if (sidebarAutostaker) {
            sidebarAutostaker.addEventListener('click', () => {
                this.openAutostaker();
            });
        }
        
        if (sidebarSettings) {
            sidebarSettings.addEventListener('click', () => {
                this.openSettings();
            });
        }
        
        // About button (sidebar)
        const sidebarAbout = document.getElementById('sidebar-about-btn');
        if (sidebarAbout) {
            sidebarAbout.addEventListener('click', () => {
                this.openAbout();
            });
        }
        
        // Mobile wallet button
        if (this.mobileWalletBtn) {
            this.mobileWalletBtn.addEventListener('click', () => {
                // Check if user is connected via sidebar state
                if (this.sidebarWalletAddress?.textContent !== 'Not connected') {
                    // User is logged in, show mobile wallet dropdown
                    this.toggleMobileWalletDropdown();
                } else {
                    // User not logged in, show login modal
                    this.showLoginModal();
                }
            });
        }
        
        // Sidebar wallet click
        if (this.sidebarWallet) {
            this.sidebarWallet.addEventListener('click', () => {
                if (this.sidebarWalletAddress?.textContent !== 'Not connected') {
                    this.toggleSidebarWalletDropdown();
                } else {
                    // Show login modal
                    this.showLoginModal();
                }
            });
        }
        
        // Sidebar logout button
        if (this.sidebarLogoutBtn) {
            this.sidebarLogoutBtn.addEventListener('click', () => {
                this.hideSidebarWalletDropdown();
                // Trigger logout - same as the old logout-btn
                if (window.handleLogout) {
                    window.handleLogout();
                } else {
                    // Fallback: clear storage and reload
                    localStorage.removeItem('walletType');
                    localStorage.removeItem('encrypted_wallet');
                    sessionStorage.clear();
                    window.location.reload();
                }
            });
        }
        
        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (this.sidebarWalletDropdown && !this.sidebarWalletDropdown.classList.contains('hidden')) {
                // Check if click is outside both the sidebar wallet and mobile wallet button
                const clickedSidebarWallet = this.sidebarWallet?.contains(e.target);
                const clickedMobileWallet = this.mobileWalletBtn?.contains(e.target);
                const clickedDropdown = this.sidebarWalletDropdown.contains(e.target);
                
                if (!clickedSidebarWallet && !clickedMobileWallet && !clickedDropdown) {
                    this.hideSidebarWalletDropdown();
                }
            }
            
            // Close reputation dropdown when clicking outside
            const reputationMenu = document.getElementById('reputation-dropdown-menu');
            const reputationBtn = document.getElementById('reputation-dropdown-btn');
            if (reputationMenu && !reputationMenu.classList.contains('hidden')) {
                if (!reputationBtn?.contains(e.target) && !reputationMenu.contains(e.target)) {
                    reputationMenu.classList.add('hidden');
                }
            }
        });
        
        // Listen for popstate (browser back/forward)
        window.addEventListener('popstate', () => {
            this.updateActiveState(this.getPageFromPath());
        });
    }
    
    /**
     * Setup tooltips for collapsed sidebar
     */
    setupTooltips() {
        this.sidebarNavLinks.forEach(link => {
            const navId = link.getAttribute('data-nav');
            const title = this.pageTitles[navId] || navId;
            link.setAttribute('data-tooltip', title);
        });
    }
    
    /**
     * Navigate to a page
     */
    navigateTo(pageId, href = null) {
        // Use router if available
        if (window.router && typeof window.router.navigate === 'function') {
            const path = href || '/' + (pageId === 'operators' ? '' : pageId);
            window.router.navigate(path);
        } else {
            // Fallback to direct navigation
            if (href) {
                window.location.href = href;
            }
        }
        
        this.updateActiveState(pageId);
    }
    
    /**
     * Update active navigation state
     */
    updateActiveState(pageId) {
        this.currentPage = pageId;
        
        // Update sidebar active state
        this.sidebarNavLinks.forEach(link => {
            const navId = link.getAttribute('data-nav');
            link.classList.toggle('active', navId === pageId);
        });
        
        // Update bottom nav active state
        this.bottomNavItems.forEach(item => {
            const navId = item.getAttribute('data-nav');
            item.classList.toggle('active', navId === pageId);
        });
        
        // Update page titles
        this.updatePageTitle(pageId);
    }
    
    /**
     * Update page title in headers
     */
    updatePageTitle(pageId, customTitle = null) {
        const title = customTitle || this.pageTitles[pageId] || 'Operators';
        
        if (this.mobilePageTitle) {
            this.mobilePageTitle.textContent = title;
        }
        
        if (this.desktopPageTitle) {
            this.desktopPageTitle.textContent = title;
        }
        
        // Update document title
        document.title = `${title} | Streamr deCentral`;
    }
    
    /**
     * Update DATA price display in both headers
     */
    updatePrice(priceText) {
        if (this.desktopPriceValue) {
            this.desktopPriceValue.textContent = priceText;
        }
        
        if (this.mobilePriceValue) {
            this.mobilePriceValue.textContent = priceText;
        }
    }
    
    /**
     * Update wallet display in navigation
     */
    updateWallet(address) {
        if (address) {
            const shortAddress = `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
            
            // Update sidebar wallet
            if (this.sidebarWalletAddress) {
                this.sidebarWalletAddress.textContent = shortAddress;
            }
            
            // Update sidebar wallet icon to connected state (green checkmark)
            if (this.sidebarWalletIcon) {
                // Update SVG icon to connected state (green)
                this.sidebarWalletIcon.classList.remove('text-gray-400');
                this.sidebarWalletIcon.classList.add('text-green-400');
            }
            
            // Update mobile wallet button appearance
            if (this.mobileWalletBtn) {
                this.mobileWalletBtn.classList.remove('text-gray-400');
                this.mobileWalletBtn.classList.add('text-green-400', 'border-green-600/50');
            }
        } else {
            // Reset to not connected state
            if (this.sidebarWalletAddress) {
                this.sidebarWalletAddress.textContent = 'Not connected';
            }
            
            // Reset sidebar wallet icon to disconnected state (gray)
            if (this.sidebarWalletIcon) {
                this.sidebarWalletIcon.classList.remove('text-green-400');
                this.sidebarWalletIcon.classList.add('text-gray-400');
            }
            
            if (this.mobileWalletBtn) {
                this.mobileWalletBtn.classList.add('text-gray-400');
                this.mobileWalletBtn.classList.remove('text-green-400', 'border-green-600/50');
            }
            
            // Hide dropdown
            this.hideSidebarWalletDropdown();
        }
    }
    
    /**
     * Toggle sidebar wallet dropdown
     */
    toggleSidebarWalletDropdown() {
        if (this.sidebarWalletDropdown) {
            const isHidden = this.sidebarWalletDropdown.classList.contains('hidden');
            
            if (isHidden) {
                // Position the dropdown next to the wallet button
                if (this.sidebarWallet) {
                    const sidebar = document.getElementById('app-sidebar');
                    const sidebarRect = sidebar?.getBoundingClientRect();
                    const walletRect = this.sidebarWallet.getBoundingClientRect();
                    
                    // Position to the right of the sidebar
                    this.sidebarWalletDropdown.style.left = `${sidebarRect ? sidebarRect.right + 8 : walletRect.right + 8}px`;
                    this.sidebarWalletDropdown.style.top = `${walletRect.top}px`;
                }
                this.sidebarWalletDropdown.classList.remove('hidden');
            } else {
                this.sidebarWalletDropdown.classList.add('hidden');
            }
        }
    }
    
    /**
     * Hide sidebar wallet dropdown
     */
    hideSidebarWalletDropdown() {
        if (this.sidebarWalletDropdown) {
            this.sidebarWalletDropdown.classList.add('hidden');
        }
    }
    
    /**
     * Toggle mobile wallet dropdown - positions near the mobile wallet button
     */
    toggleMobileWalletDropdown() {
        if (this.sidebarWalletDropdown) {
            const isHidden = this.sidebarWalletDropdown.classList.contains('hidden');
            
            if (isHidden) {
                // Position the dropdown below the mobile wallet button
                if (this.mobileWalletBtn) {
                    const btnRect = this.mobileWalletBtn.getBoundingClientRect();
                    
                    // Position below the button, aligned to the right
                    this.sidebarWalletDropdown.style.left = 'auto';
                    this.sidebarWalletDropdown.style.right = '16px';
                    this.sidebarWalletDropdown.style.top = `${btnRect.bottom + 8}px`;
                }
                this.sidebarWalletDropdown.classList.remove('hidden');
            } else {
                this.sidebarWalletDropdown.classList.add('hidden');
            }
        }
    }
    
    /**
     * Toggle autostaker panel - opens if closed, closes if open
     */
    openAutostaker() {
        const modal = document.getElementById('autostakerModal');
        const isOpen = modal && modal.style.display !== 'none' && modal.style.display !== '';
        
        if (isOpen) {
            // Panel is open, close it
            const overlay = document.getElementById('autostakerOverlay');
            if (modal) modal.style.cssText = 'display: none !important;';
            if (overlay) overlay.style.cssText = 'display: none !important;';
        } else {
            // Panel is closed, use the global handler that validates first
            if (window.handleAutostakerClick) {
                window.handleAutostakerClick();
            }
        }
    }
    
    /**
     * Open settings modal
     */
    openSettings() {
        const settingsModal = document.getElementById('settingsModal');
        const theGraphInput = document.getElementById('thegraph-api-key-input');
        const etherscanInput = document.getElementById('etherscan-api-key-input');
        
        // Populate saved values
        if (theGraphInput) {
            theGraphInput.value = localStorage.getItem(STORAGE_KEYS.GRAPH_API_KEY) || '';
        }
        if (etherscanInput) {
            etherscanInput.value = localStorage.getItem(STORAGE_KEYS.ETHERSCAN_API_KEY) || '';
        }
        
        if (settingsModal) {
            settingsModal.classList.remove('hidden');
        }
    }
    
    /**
     * Open about modal
     */
    openAbout() {
        const aboutModal = document.getElementById('aboutModal');
        if (aboutModal) {
            aboutModal.classList.remove('hidden');
        }
    }
    
    /**
     * Show login modal with buttons state (reset from loading state)
     */
    showLoginModal() {
        const loginModal = document.getElementById('loginModal');
        const walletLoginView = document.getElementById('walletLoginView');
        const loadingContent = document.getElementById('loadingContent');
        const installSection = document.getElementById('installAppSection');
        
        if (loginModal) {
            // Reset to buttons state before showing
            if (loadingContent) loadingContent.classList.add('hidden');
            if (walletLoginView) walletLoginView.classList.remove('hidden');
            
            // Hide install section if app is already installed (standalone mode)
            if (installSection && typeof window.isAppInstalled === 'function' && window.isAppInstalled()) {
                installSection.classList.add('hidden');
            }
            
            // Show the modal
            loginModal.classList.remove('hidden');
        }
    }
    
    /**
     * Set autostaker status indicator
     */
    setAutoostakerStatus(isRunning) {
        const sidebarBtn = document.getElementById('sidebar-autostaker-btn');
        const bottomNavBtn = document.getElementById('bottom-nav-autostaker');
        
        if (isRunning) {
            sidebarBtn?.classList.add('autostaker-active');
            bottomNavBtn?.classList.add('active');
            
            // Add green color to icons
            sidebarBtn?.querySelector('svg')?.classList.add('text-green-400');
            bottomNavBtn?.querySelector('svg')?.classList.add('text-green-400');
        } else {
            sidebarBtn?.classList.remove('autostaker-active');
            bottomNavBtn?.classList.remove('active');
            
            sidebarBtn?.querySelector('svg')?.classList.remove('text-green-400');
            bottomNavBtn?.querySelector('svg')?.classList.remove('text-green-400');
        }
    }
    
    /**
     * Show/hide navigation based on view
     * (e.g., hide during full-screen views like Visual)
     */
    setNavigationVisibility(visible) {
        if (this.bottomNav) {
            this.bottomNav.style.display = visible ? '' : 'none';
        }
        if (this.mobileHeader) {
            this.mobileHeader.style.display = visible ? '' : 'none';
        }
    }
}

// Export singleton instance
export const navigationController = new NavigationController();

// Also export the class for testing
export { NavigationController };
