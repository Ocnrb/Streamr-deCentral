// Toast notifications, with a Polygonscan link for transactions
import { escapeHtml } from '../core/utils.js';

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
                    <p class="toast-title font-semibold text-white text-sm">${escapeHtml(String(title ?? ''))}</p>
                    <p class="toast-message text-sm text-gray-400 mt-0.5 ${message ? '' : 'hidden'}">${escapeHtml(String(message ?? ''))}</p>
                    <div class="toast-link-container">${buildPolygonscanLink(txHash)}</div>
                </div>
                <button type="button" class="toast-close flex-shrink-0 ${type === 'loading' ? 'hidden' : ''}" aria-label="Close">
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
    toastElement.querySelector('.toast-close')?.addEventListener('click', () => toastElement.dispatchEvent(new CustomEvent('close')));
    
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
