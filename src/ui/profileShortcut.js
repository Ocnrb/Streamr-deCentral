// The saved operator / delegator shortcut in the navigation, and the save buttons on their pages
import { OPERATOR_AVATAR_PLACEHOLDER } from '../core/utils.js';
import { getOperatorProfile, saveOperatorProfile, removeOperatorProfile, isOperatorSaved, getDelegatorProfile, saveDelegatorProfile, removeDelegatorProfile, isDelegatorSaved } from '../core/profile.js';
import { showToast } from './toast.js';

// --- Profile Shortcut Functions ---

const placeholderAvatarUrl = OPERATOR_AVATAR_PLACEHOLDER;

/**
 * Render the profile shortcut in sidebar and mobile nav
 * Call this on app init and whenever profile changes
 */
export function renderProfileShortcut() {
    const operatorProfile = getOperatorProfile();
    const delegatorProfile = getDelegatorProfile();
    
    // Desktop sidebar section
    const sidebarSection = document.getElementById('sidebar-profiles-section');
    
    // Operator elements - desktop
    const sidebarOperatorLink = document.getElementById('sidebar-operator-profile-link');
    const sidebarOperatorAvatar = document.getElementById('sidebar-operator-profile-avatar');
    const sidebarOperatorName = document.getElementById('sidebar-operator-profile-name');
    
    // Delegator elements - desktop
    const sidebarDelegatorLink = document.getElementById('sidebar-delegator-profile-link');
    const sidebarDelegatorAvatar = document.getElementById('sidebar-delegator-profile-avatar');
    const sidebarDelegatorName = document.getElementById('sidebar-delegator-profile-name');
    
    // Operator elements - mobile
    const mobileOperatorLink = document.getElementById('mobile-operator-profile-link');
    const mobileOperatorAvatar = document.getElementById('mobile-operator-profile-avatar');
    const mobileOperatorName = document.getElementById('mobile-operator-profile-name');
    
    // Delegator elements - mobile
    const mobileDelegatorLink = document.getElementById('mobile-delegator-profile-link');
    const mobileDelegatorAvatar = document.getElementById('mobile-delegator-profile-avatar');
    const mobileDelegatorName = document.getElementById('mobile-delegator-profile-name');
    
    const hasAnyProfile = operatorProfile || delegatorProfile;
    
    // Show/hide the profiles section
    if (sidebarSection) {
        if (hasAnyProfile) {
            sidebarSection.classList.remove('hidden');
        } else {
            sidebarSection.classList.add('hidden');
        }
    }
    
    // Render Operator Profile
    if (operatorProfile) {
        const avatarUrl = operatorProfile.imageUrl || placeholderAvatarUrl;
        const profileId = operatorProfile.id || operatorProfile.operatorId;
        const displayName = operatorProfile.name || profileId.slice(0, 10) + '...';
        const operatorUrl = `/operator/${profileId}`;
        
        // Desktop
        if (sidebarOperatorLink) {
            sidebarOperatorLink.classList.remove('hidden');
            sidebarOperatorLink.classList.add('flex');
            sidebarOperatorLink.href = operatorUrl;
            if (sidebarOperatorAvatar) {
                sidebarOperatorAvatar.src = avatarUrl;
                sidebarOperatorAvatar.onerror = function() { this.src = placeholderAvatarUrl; };
            }
            if (sidebarOperatorName) sidebarOperatorName.textContent = displayName;
        }
        
        // Mobile
        if (mobileOperatorLink) {
            mobileOperatorLink.classList.remove('hidden');
            mobileOperatorLink.classList.add('flex');
            mobileOperatorLink.href = operatorUrl;
            if (mobileOperatorAvatar) {
                mobileOperatorAvatar.src = avatarUrl;
                mobileOperatorAvatar.onerror = function() { this.src = placeholderAvatarUrl; };
            }
            if (mobileOperatorName) mobileOperatorName.textContent = displayName;
        }
    } else {
        // Hide operator shortcuts
        if (sidebarOperatorLink) {
            sidebarOperatorLink.classList.add('hidden');
            sidebarOperatorLink.classList.remove('flex');
        }
        if (mobileOperatorLink) {
            mobileOperatorLink.classList.add('hidden');
            mobileOperatorLink.classList.remove('flex');
        }
    }
    
    // Render Delegator Profile
    if (delegatorProfile) {
        const avatarUrl = delegatorProfile.imageUrl || placeholderAvatarUrl;
        const displayName = delegatorProfile.name || delegatorProfile.id.slice(0, 10) + '...';
        const delegatorUrl = `/delegator/${delegatorProfile.id}`;
        
        // Desktop
        if (sidebarDelegatorLink) {
            sidebarDelegatorLink.classList.remove('hidden');
            sidebarDelegatorLink.classList.add('flex');
            sidebarDelegatorLink.href = delegatorUrl;
            if (sidebarDelegatorAvatar) {
                sidebarDelegatorAvatar.src = avatarUrl;
                sidebarDelegatorAvatar.onerror = function() { this.src = placeholderAvatarUrl; };
            }
            if (sidebarDelegatorName) sidebarDelegatorName.textContent = displayName;
        }
        
        // Mobile
        if (mobileDelegatorLink) {
            mobileDelegatorLink.classList.remove('hidden');
            mobileDelegatorLink.classList.add('flex');
            mobileDelegatorLink.href = delegatorUrl;
            if (mobileDelegatorAvatar) {
                mobileDelegatorAvatar.src = avatarUrl;
                mobileDelegatorAvatar.onerror = function() { this.src = placeholderAvatarUrl; };
            }
            if (mobileDelegatorName) mobileDelegatorName.textContent = displayName;
        }
    } else {
        // Hide delegator shortcuts
        if (sidebarDelegatorLink) {
            sidebarDelegatorLink.classList.add('hidden');
            sidebarDelegatorLink.classList.remove('flex');
        }
        if (mobileDelegatorLink) {
            mobileDelegatorLink.classList.add('hidden');
            mobileDelegatorLink.classList.remove('flex');
        }
    }
}

/**
 * Update the save/remove profile buttons in the page header
 * @param {string} operatorId - Current operator ID
 * @param {string} operatorName - Current operator name
 * @param {string|null} operatorImageUrl - Current operator image URL
 */
/**
 * The saved profile stores the name and avatar URL of when it was saved (e.g. an IPFS link that no
 * longer works, before the avatar stream): update them when they changed, and refresh the shortcut.
 * @returns {boolean} whether the saved profile changed
 */
export function syncSavedOperatorProfile(operatorId, operatorName, operatorImageUrl) {
    const profile = getOperatorProfile();
    const id = (profile?.id || profile?.operatorId || '').toLowerCase();
    if (!profile || !operatorId || id !== operatorId.toLowerCase()) return false;
    const name = operatorName || id;
    const imageUrl = operatorImageUrl || null;
    if (profile.name === name && (profile.imageUrl || null) === imageUrl) return false;
    saveOperatorProfile(id, name, imageUrl);
    renderProfileShortcut();
    return true;
}

/**
 * Whether the page open now is the detail page of this operator / delegator. Detail pages load
 * asynchronously: a load that finishes after the user moved on must not show the star elsewhere.
 */
function isCurrentDetailPage(kind, id) {
    const path = decodeURIComponent(window.location.pathname).replace(/\/+$/, '').toLowerCase();
    return path === `/${kind}/${String(id).toLowerCase()}`;
}

export function updateProfileButton(operatorId, operatorName, operatorImageUrl) {
    syncSavedOperatorProfile(operatorId, operatorName, operatorImageUrl);

    const desktopBtn = document.getElementById('desktop-save-profile-btn');
    const mobileBtn = document.getElementById('mobile-save-profile-btn');
    if (!isCurrentDetailPage('operator', operatorId)) {
        [desktopBtn, mobileBtn].forEach(btn => btn?.classList.add('hidden'));
        return;
    }
    
    // Hide delegator profile buttons (only one type should be visible)
    const desktopDelegatorBtn = document.getElementById('desktop-save-delegator-profile-btn');
    const mobileDelegatorBtn = document.getElementById('mobile-save-delegator-profile-btn');
    if (desktopDelegatorBtn) desktopDelegatorBtn.classList.add('hidden');
    if (mobileDelegatorBtn) mobileDelegatorBtn.classList.add('hidden');
    
    const isSaved = isOperatorSaved(operatorId);
    
    // Update both buttons
    [desktopBtn, mobileBtn].forEach(btn => {
        if (!btn) return;
        
        // Show the button
        btn.classList.remove('hidden');
        
        if (isSaved) {
            btn.innerHTML = `
                <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
                </svg>
            `;
            btn.classList.add('text-yellow-400');
            btn.classList.remove('text-gray-400');
            btn.title = 'Remove from profile';
        } else {
            btn.innerHTML = `
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/>
                </svg>
            `;
            btn.classList.remove('text-yellow-400');
            btn.classList.add('text-gray-400');
            btn.title = 'Save as your profile shortcut';
        }
        
        // Store data on button for click handler
        btn.dataset.operatorId = operatorId;
        btn.dataset.operatorName = operatorName || '';
        btn.dataset.operatorImage = operatorImageUrl || '';
    });
}

/**
 * Hide the profile buttons (when leaving operator/delegator detail view)
 */
export function hideProfileButtons() {
    const desktopBtn = document.getElementById('desktop-save-profile-btn');
    const mobileBtn = document.getElementById('mobile-save-profile-btn');
    const desktopDelegatorBtn = document.getElementById('desktop-save-delegator-profile-btn');
    const mobileDelegatorBtn = document.getElementById('mobile-save-delegator-profile-btn');
    
    if (desktopBtn) desktopBtn.classList.add('hidden');
    if (mobileBtn) mobileBtn.classList.add('hidden');
    if (desktopDelegatorBtn) desktopDelegatorBtn.classList.add('hidden');
    if (mobileDelegatorBtn) mobileDelegatorBtn.classList.add('hidden');
}

/**
 * Handle save/remove profile button click (for operators)
 * @param {HTMLElement} clickedBtn - The button that was clicked
 */
export function handleProfileButtonClick(clickedBtn) {
    // Get data from the clicked button or fallback to desktop button
    const btn = clickedBtn || document.getElementById('desktop-save-profile-btn');
    if (!btn) return;
    
    const operatorId = btn.dataset.operatorId;
    const operatorName = btn.dataset.operatorName;
    const operatorImageUrl = btn.dataset.operatorImage;
    
    if (!operatorId) return;
    
    if (isOperatorSaved(operatorId)) {
        removeOperatorProfile();
        showToast({
            type: 'info',
            title: 'Profile Removed',
            message: 'Operator shortcut has been removed.',
            duration: 3000
        });
    } else {
        saveOperatorProfile(operatorId, operatorName, operatorImageUrl);
        showToast({
            type: 'success',
            title: 'Profile Saved',
            message: 'Operator added as your profile shortcut.',
            duration: 3000
        });
    }
    
    // Update UI
    updateProfileButton(operatorId, operatorName, operatorImageUrl);
    renderProfileShortcut();
}

/**
 * Update the save/remove delegator profile buttons in the page header
 * @param {string} delegatorId - Current delegator ID
 * @param {string} delegatorName - Current delegator name (usually just address)
 * @param {string|null} delegatorImageUrl - Current delegator image URL
 */
export function updateDelegatorProfileButton(delegatorId, delegatorName, delegatorImageUrl) {
    const desktopBtn = document.getElementById('desktop-save-delegator-profile-btn');
    const mobileBtn = document.getElementById('mobile-save-delegator-profile-btn');
    if (!isCurrentDetailPage('delegator', delegatorId)) {
        [desktopBtn, mobileBtn].forEach(btn => btn?.classList.add('hidden'));
        return;
    }
    
    // Hide operator profile buttons (only one type should be visible)
    const desktopOperatorBtn = document.getElementById('desktop-save-profile-btn');
    const mobileOperatorBtn = document.getElementById('mobile-save-profile-btn');
    if (desktopOperatorBtn) desktopOperatorBtn.classList.add('hidden');
    if (mobileOperatorBtn) mobileOperatorBtn.classList.add('hidden');
    
    const isSaved = isDelegatorSaved(delegatorId);
    
    // Update both buttons
    [desktopBtn, mobileBtn].forEach(btn => {
        if (!btn) return;
        
        // Show the button
        btn.classList.remove('hidden');
        
        if (isSaved) {
            btn.innerHTML = `
                <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
                </svg>
            `;
            btn.classList.add('text-yellow-400');
            btn.classList.remove('text-gray-400');
            btn.title = 'Remove from profile';
        } else {
            btn.innerHTML = `
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/>
                </svg>
            `;
            btn.classList.remove('text-yellow-400');
            btn.classList.add('text-gray-400');
            btn.title = 'Save as your profile shortcut';
        }
        
        // Store data on button for click handler
        btn.dataset.delegatorId = delegatorId;
        btn.dataset.delegatorName = delegatorName || '';
        btn.dataset.delegatorImage = delegatorImageUrl || '';
    });
}

/**
 * Handle save/remove delegator profile button click
 * @param {HTMLElement} clickedBtn - The button that was clicked
 */
export function handleDelegatorProfileButtonClick(clickedBtn) {
    const btn = clickedBtn || document.getElementById('desktop-save-delegator-profile-btn');
    if (!btn) return;
    
    const delegatorId = btn.dataset.delegatorId;
    const delegatorName = btn.dataset.delegatorName;
    const delegatorImageUrl = btn.dataset.delegatorImage;
    
    if (!delegatorId) return;
    
    if (isDelegatorSaved(delegatorId)) {
        removeDelegatorProfile();
        showToast({
            type: 'info',
            title: 'Profile Removed',
            message: 'Delegator shortcut has been removed.',
            duration: 3000
        });
    } else {
        saveDelegatorProfile(delegatorId, delegatorName, delegatorImageUrl);
        showToast({
            type: 'success',
            title: 'Profile Saved',
            message: 'Delegator added as your profile shortcut.',
            duration: 3000
        });
    }
    
    // Update UI
    updateDelegatorProfileButton(delegatorId, delegatorName, delegatorImageUrl);
    renderProfileShortcut();
}
