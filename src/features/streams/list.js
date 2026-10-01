// The Sponsorships and All Streams tables: rows, tabs, sorting, search and loading more
import * as Utils from '../../core/utils.js';
import * as UI from '../../ui/ui.js';
import { logger } from '../../core/utils.js';
import { STREAMS_PER_PAGE, state } from './state.js';
import { fetchSponsorships, fetchZeroBalanceSponsorships, fetchAllStreams, searchSponsorships, searchAllStreams, determineAccessControl } from './data.js';

// ============================================
// Rendering
// ============================================

/**
 * Create HTML for a sponsorship row
 */
function createSponsorshipRowHtml(sponsorship, index) {
    const streamId = sponsorship.stream?.id || 'Unknown Stream';
    const displayStreamId = streamId.length > 50 ? streamId.substring(0, 47) + '...' : streamId;
    const apy = parseFloat(sponsorship.spotAPY || 0);
    const apyFormatted = Math.round(apy * 100);
    const totalStaked = Utils.convertWeiToData(sponsorship.totalStakedWei || '0');
    const operatorCount = sponsorship.operatorCount || 0;
    const hasZeroBalance = sponsorship.remainingWei === '0' || BigInt(sponsorship.remainingWei || '0') === BigInt(0);
    const isNotRunning = !sponsorship.isRunning;
    const isInactive = hasZeroBalance || isNotRunning;
    const isStaked = state.operatorStakes.has(sponsorship.id);
    
    // Calculate payout rate in DATA/day
    const payoutWeiPerSec = BigInt(sponsorship.totalPayoutWeiPerSec || '0');
    const payoutWeiPerDay = payoutWeiPerSec * BigInt(86400);
    const payoutPerDay = Utils.convertWeiToData(payoutWeiPerDay.toString());
    const payoutPerDayFormatted = Utils.formatBigNumber(parseFloat(payoutPerDay));
    
    // Encode the stream ID for URL - preserve slashes but encode other special chars
    // Use encodeURI to keep slashes intact
    const encodedStreamId = streamId.split('/').map(part => encodeURIComponent(part)).join('/');
    const sponsorshipId = sponsorship.id;
    
    // Badge for inactive sponsorships - show specific reason
    let inactiveBadge = '';
    if (hasZeroBalance) {
        inactiveBadge = '<span class="ml-2 px-1.5 py-0.5 text-[10px] font-semibold bg-orange-500/20 text-orange-400 rounded">ZERO BALANCE</span>';
    } else if (isNotRunning) {
        inactiveBadge = '<span class="ml-2 px-1.5 py-0.5 text-[10px] font-semibold bg-red-500/20 text-red-400 rounded">STOPPED</span>';
    }
    
    // Staked badge for sponsorships where user's operator has stake
    const stakedBadge = isStaked ? '<span class="ml-2 px-1.5 py-0.5 text-[10px] font-semibold bg-blue-500/20 text-blue-400 rounded">STAKED</span>' : '';
    
    // Row styling for inactive
    const rowClasses = isInactive ? 'stream-row cursor-pointer hover:bg-white/5 transition-colors group opacity-70' : 'stream-row cursor-pointer hover:bg-white/5 transition-colors group';
    
    return `
        <tr class="${rowClasses}" 
            data-stream-id="${Utils.escapeHtml(streamId)}" 
            data-sponsorship-id="${sponsorshipId}"
            data-sponsored="true"
            data-inactive="${isInactive}"
            data-nav-href="${Utils.escapeHtml(`/stream/${encodedStreamId}?sponsored=true&sponsorshipId=${sponsorshipId}`)}">
            <td class="px-4 py-3">
                <span class="font-mono text-sm group-hover:text-blue-400 transition-colors" title="${Utils.escapeHtml(streamId)}">${Utils.escapeHtml(displayStreamId)}</span>${stakedBadge}${inactiveBadge}
            </td>
            <td class="px-4 py-3 text-right font-mono text-gray-300 whitespace-nowrap">${payoutPerDayFormatted}</td>
            <td class="px-4 py-3 text-right font-mono text-gray-300 whitespace-nowrap">${apyFormatted}%</td>
            <td class="px-4 py-3 text-right font-mono text-gray-300 whitespace-nowrap">${Utils.formatBigNumber(totalStaked)}</td>
            <td class="px-4 py-3 text-right font-mono text-gray-300 whitespace-nowrap">${operatorCount}</td>
        </tr>
    `;
}

/**
 * Create HTML for an all streams row
 */
function createAllStreamRowHtml(stream, index) {
    const streamId = stream.id || 'Unknown Stream';
    // Desktop: show more characters, Mobile: abbreviated format
    const displayStreamIdDesktop = streamId.length > 80 ? streamId.substring(0, 77) + '...' : streamId;
    const displayStreamIdMobile = streamId.length > 30 ? streamId.substring(0, 27) + '...' : streamId;
    
    // Format date as dd/mm/yyyy hh:mm
    let createdAt = 'N/A';
    if (stream.createdAt) {
        const date = new Date(parseInt(stream.createdAt) * 1000);
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        createdAt = `${day}/${month}/${year} ${hours}:${minutes}`;
    }
    
    // Check if stream has sponsorships
    const hasSponsorship = stream.sponsorships && stream.sponsorships.length > 0;
    const sponsorshipIcon = hasSponsorship 
        ? `<svg class="w-5 h-5" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg" title="Has Sponsorship">
            <circle cx="28" cy="28" r="28" fill="#F7600A"/>
            <path fill-rule="evenodd" clip-rule="evenodd" d="M32.9091 10.2118V9.08164C32.9091 8.69418 32.5861 8.38241 32.199 8.4008C24.6009 8.76169 18.5119 14.8843 18.2056 22.4955C18.2219 22.9725 18.608 23.0974 18.8351 23.0974H19.983C20.3463 23.0974 20.6441 22.8122 20.6629 22.4495C20.989 16.1879 26.0134 11.1697 32.278 10.8522C32.7558 10.7908 32.9091 10.5297 32.9091 10.2118ZM22.5761 23.0974H23.6747C24.0313 23.0974 24.3221 22.8195 24.348 22.4638C24.6586 18.2097 28.0701 14.8164 32.3324 14.5336C32.523 14.521 32.9091 14.3783 32.9091 13.8844V12.7659C32.9091 12.3707 32.5739 12.0603 32.1795 12.0861C26.6654 12.4459 22.256 16.8547 21.8961 22.3679C21.8704 22.7623 22.1808 23.0974 22.5761 23.0974ZM37.1763 32.9026C37.4035 32.9026 37.7895 33.0275 37.8058 33.5045C37.4995 41.1158 31.4105 47.2383 23.8124 47.5993C23.4253 47.6176 23.1023 47.3059 23.1023 46.9183V45.7883C23.1023 45.4704 23.2556 45.2093 23.7333 45.1479C29.9981 44.8304 35.0224 39.8121 35.3485 33.5505C35.3673 33.1878 35.6651 32.9026 36.0284 32.9026H37.1763ZM33.4353 32.9026C33.8306 32.9026 34.141 33.2377 34.1153 33.6321C33.7554 39.1454 29.346 43.5542 23.8319 43.914C23.4375 43.9398 23.1023 43.6293 23.1023 43.2341V42.1155C23.1023 41.6217 23.4884 41.4791 23.679 41.4664C27.9413 41.1837 31.3529 37.7903 31.6633 33.5362C31.6893 33.1805 31.9801 32.9026 32.3367 32.9026H33.4353ZM29.7445 32.9026C30.1445 32.9026 30.463 33.246 30.4231 33.6441C30.0758 37.1151 27.3154 39.8751 23.8438 40.2224C23.4458 40.2623 23.1023 39.9438 23.1023 39.5438V38.4201C23.1023 37.9604 23.5015 37.795 23.6961 37.7715C25.9261 37.5025 27.6953 35.7373 27.9703 33.5095C28.0129 33.1647 28.2999 32.9026 28.6474 32.9026H29.7445ZM10.212 23.0945C10.53 23.0945 10.7911 23.2477 10.8525 23.7254C11.1701 29.9892 16.189 35.0129 22.4516 35.3389C22.8143 35.3577 23.0996 35.6555 23.0996 36.0187V37.1666C23.0996 37.3936 22.9746 37.7796 22.4976 37.7959C14.8853 37.4896 8.76181 31.4015 8.4008 23.8045C8.3824 23.4174 8.69423 23.0945 9.0818 23.0945H10.212ZM13.8853 23.0945C14.3792 23.0945 14.5219 23.4805 14.5346 23.6711C14.8173 27.9328 18.2111 31.3439 22.4659 31.6543C22.8216 31.6803 23.0996 31.971 23.0996 32.3276V33.426C23.0996 33.8212 22.7644 34.1316 22.3699 34.1059C16.8559 33.746 12.4464 29.3373 12.0866 23.824C12.0608 23.4296 12.3713 23.0945 12.7666 23.0945H13.8853ZM33.5024 18.1729C41.1148 18.4792 47.2382 24.5673 47.5993 32.1644C47.6176 32.5514 47.3058 32.8744 46.9183 32.8744H45.788C45.4701 32.8744 45.2089 32.7211 45.1475 32.2434C44.8299 25.9795 39.811 20.956 33.5485 20.6299C33.1857 20.6111 32.9005 20.3133 32.9005 19.9501V18.8023C32.9005 18.5752 33.0253 18.1892 33.5024 18.1729ZM33.6301 21.8629C39.1442 22.2227 43.5536 26.6315 43.9135 32.1448C43.9392 32.5392 43.6288 32.8744 43.2335 32.8744H42.1148C41.6208 32.8744 41.4782 32.4883 41.4655 32.2977C41.1828 28.036 37.7889 24.6249 33.5342 24.3145C33.1784 24.2886 32.9005 23.9978 32.9005 23.6412V22.5428C32.9005 22.1476 33.2357 21.8372 33.6301 21.8629ZM33.642 25.5545C37.1136 25.9019 39.874 28.6619 40.2213 32.1329C40.2612 32.5309 39.9427 32.8744 39.5427 32.8744H38.4188C37.959 32.8744 37.7936 32.4752 37.7701 32.2806C37.501 30.0509 35.7356 28.282 33.5075 28.0071C33.1626 27.9645 32.9005 27.6775 32.9005 27.33V26.2331C32.9005 25.8331 33.244 25.5147 33.642 25.5545ZM17.5812 23.0945C18.0411 23.0945 18.2064 23.4936 18.2299 23.6882C18.4991 25.9179 20.2644 27.6868 22.4926 27.9618C22.8374 28.0043 23.0996 28.2913 23.0996 28.6388V29.7357C23.0996 30.1357 22.7561 30.4541 22.358 30.4144C18.8865 30.0669 16.1261 27.3069 15.7786 23.8359C15.7388 23.4379 16.0573 23.0945 16.4574 23.0945H17.5812ZM32.9091 16.4562V17.5798C32.9091 18.0396 32.51 18.205 32.3152 18.2285C30.0853 18.4976 28.3161 20.2627 28.0411 22.4905C27.9985 22.8353 27.7115 23.0974 27.364 23.0974H26.2669C25.8669 23.0974 25.5484 22.7539 25.5882 22.3559C25.9357 18.885 28.6961 16.125 32.1675 15.7776C32.5656 15.7378 32.9091 16.0562 32.9091 16.4562Z" fill="white"/>
           </svg>` 
        : '';
    
    // Parse partitions from metadata
    let partitions = 1;
    try {
        if (stream.metadata) {
            const meta = JSON.parse(stream.metadata);
            // Metadata is whatever the stream's creator wrote: a whole number in the SDK's range, or 1
            const count = Number(meta.partitions);
            partitions = Number.isInteger(count) && count >= 1 && count <= 100 ? count : 1;
        }
    } catch (e) { /* ignore */ }
    
    // Create partition pill (purple badge like in Live Data Viewer)
    const partitionPill = `<span class="px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded text-[10px] font-medium">P${partitions}</span>`;
    
    // Check if stream has storage nodes
    const hasStorage = stream.storageNodes && stream.storageNodes.length > 0;
    const storageIcon = hasStorage
        ? `<svg class="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" title="Has Storage">
             <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"/>
           </svg>`
        : '';
    
    // Determine access control (public vs private)
    const accessType = determineAccessControl(stream.permissions);
    const isPublic = accessType === 'public-all' || accessType === 'public-subscribe';
    const accessIcon = isPublic
        ? `<svg class="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" title="Public Stream">
             <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
             <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
           </svg>`
        : `<svg class="w-4 h-4 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" title="Private Stream">
             <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
           </svg>`;
    
    // Encode the stream ID for URL - preserve slashes but encode other special chars
    const encodedStreamId = streamId.split('/').map(part => encodeURIComponent(part)).join('/');
    
    return `
        <tr class="stream-row cursor-pointer hover:bg-white/5 transition-colors group" 
            data-stream-id="${Utils.escapeHtml(streamId)}"
            data-sponsored="false"
            data-nav-href="${Utils.escapeHtml(`/stream/${encodedStreamId}`)}">
            <td class="px-4 py-3">
                <span class="font-mono text-sm group-hover:text-blue-400 transition-colors hidden md:inline" title="${Utils.escapeHtml(streamId)}">${Utils.escapeHtml(displayStreamIdDesktop)}</span>
                <span class="font-mono text-sm group-hover:text-blue-400 transition-colors md:hidden" title="${Utils.escapeHtml(streamId)}">${Utils.escapeHtml(displayStreamIdMobile)}</span>
            </td>
            <td class="px-4 py-3 text-center">${sponsorshipIcon}</td>
            <td class="px-4 py-3 text-center">${storageIcon}</td>
            <td class="px-4 py-3 text-center">${accessIcon}</td>
            <td class="px-4 py-3 text-center whitespace-nowrap">${partitionPill}</td>
            <td class="px-4 py-3 text-right text-gray-400 whitespace-nowrap hidden md:table-cell">${createdAt}</td>
        </tr>
    `;
}

/**
 * Render sponsorships table
 */
export function renderSponsorshipsTable(streams, isAppend = false) {
    const tbody = document.getElementById('sponsorships-tbody');
    const loadMoreBtn = document.getElementById('load-more-sponsorships-btn');
    const emptyState = document.getElementById('sponsorships-empty');
    
    if (!tbody) return;
    
    if (!isAppend) {
        tbody.innerHTML = '';
    }
    
    if (streams.length === 0 && !isAppend) {
        if (emptyState) emptyState.classList.remove('hidden');
        if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
        return;
    }
    
    if (emptyState) emptyState.classList.add('hidden');
    
    const startIndex = isAppend ? state.sponsorships.length - streams.length : 0;
    const html = streams.map((s, i) => createSponsorshipRowHtml(s, startIndex + i)).join('');
    
    if (isAppend) {
        tbody.insertAdjacentHTML('beforeend', html);
    } else {
        tbody.innerHTML = html;
    }
    
    // Update load more button
    if (loadMoreBtn) {
        loadMoreBtn.classList.toggle('hidden', !state.hasMoreSponsorships);
    }
}

/**
 * Render all streams table
 */
export function renderAllStreamsTable(streams, isAppend = false) {
    const tbody = document.getElementById('nonsponsorships-tbody');
    const loadMoreBtn = document.getElementById('load-more-nonsponsored-btn');
    const emptyState = document.getElementById('nonsponsorships-empty');
    
    if (!tbody) return;
    
    if (!isAppend) {
        tbody.innerHTML = '';
    }
    
    if (streams.length === 0 && !isAppend) {
        if (emptyState) emptyState.classList.remove('hidden');
        if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
        return;
    }
    
    if (emptyState) emptyState.classList.add('hidden');
    
    const startIndex = isAppend ? state.allStreams.length - streams.length : 0;
    const html = streams.map((s, i) => createAllStreamRowHtml(s, startIndex + i)).join('');
    
    if (isAppend) {
        tbody.insertAdjacentHTML('beforeend', html);
    } else {
        tbody.innerHTML = html;
    }
    
    // Update load more button
    if (loadMoreBtn) {
        loadMoreBtn.classList.toggle('hidden', !state.hasMoreAllStreams);
    }
}

// ============================================
// Event Handlers
// ============================================

/**
 * Switch between tabs
 */
export function switchTab(tab) {
    state.activeTab = tab;
    
    const sponsorshipsTab = document.getElementById('streams-tab-sponsorships');
    const allStreamsTab = document.getElementById('streams-tab-nonsponsored');
    const sponsorshipsPanel = document.getElementById('streams-panel-sponsorships');
    const allStreamsPanel = document.getElementById('streams-panel-nonsponsored');
    const sponsorshipsCount = document.getElementById('streams-tab-sponsorships-count');
    const allStreamsTabCount = document.getElementById('streams-tab-nonsponsored-count');
    const searchInput = document.getElementById('streams-search-input');
    
    // Safety check - if elements don't exist yet, skip UI updates
    if (!sponsorshipsTab || !allStreamsTab || !sponsorshipsPanel || !allStreamsPanel) {
        return;
    }
    
    if (tab === 'sponsorships') {
        // Update sponsorships tab to active
        sponsorshipsTab.classList.remove('text-gray-400', 'border-transparent', 'hover:border-gray-600');
        sponsorshipsTab.classList.add('text-white', 'border-blue-500', 'bg-gradient-to-t', 'from-blue-500/10', 'to-transparent');
        if (sponsorshipsCount) {
            sponsorshipsCount.classList.remove('bg-gray-500/20', 'text-gray-400');
            sponsorshipsCount.classList.add('bg-green-500/20', 'text-green-400');
        }
        
        // Update all streams tab to inactive
        allStreamsTab.classList.remove('text-white', 'border-blue-500', 'bg-gradient-to-t', 'from-blue-500/10', 'to-transparent');
        allStreamsTab.classList.add('text-gray-400', 'border-transparent', 'hover:border-gray-600');
        if (allStreamsTabCount) {
            allStreamsTabCount.classList.remove('bg-green-500/20', 'text-green-400');
            allStreamsTabCount.classList.add('bg-gray-500/20', 'text-gray-400');
        }
        
        // Show/hide panels
        sponsorshipsPanel.classList.remove('hidden');
        allStreamsPanel.classList.add('hidden');
    } else {
        // Update all streams tab to active
        allStreamsTab.classList.remove('text-gray-400', 'border-transparent', 'hover:border-gray-600');
        allStreamsTab.classList.add('text-white', 'border-blue-500', 'bg-gradient-to-t', 'from-blue-500/10', 'to-transparent');
        if (allStreamsTabCount) {
            allStreamsTabCount.classList.remove('bg-gray-500/20', 'text-gray-400');
            allStreamsTabCount.classList.add('bg-green-500/20', 'text-green-400');
        }
        
        // Update sponsorships tab to inactive
        sponsorshipsTab.classList.remove('text-white', 'border-blue-500', 'bg-gradient-to-t', 'from-blue-500/10', 'to-transparent');
        sponsorshipsTab.classList.add('text-gray-400', 'border-transparent', 'hover:border-gray-600');
        if (sponsorshipsCount) {
            sponsorshipsCount.classList.remove('bg-green-500/20', 'text-green-400');
            sponsorshipsCount.classList.add('bg-gray-500/20', 'text-gray-400');
        }
        
        // Show/hide panels
        allStreamsPanel.classList.remove('hidden');
        sponsorshipsPanel.classList.add('hidden');
    }
    
    // If there's an active search query, execute search for the new tab
    const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';
    if (searchTerm) {
        handleStreamSearch(searchTerm);
    }
}

/**
 * Update tab counters
 */
export function updateTabCounters() {
    const sponsorshipsCount = document.getElementById('streams-tab-sponsorships-count');
    const allStreamsCount = document.getElementById('streams-tab-nonsponsored-count');
    
    if (sponsorshipsCount) {
        // Include zero balance count if toggle is on
        const totalSponsorships = state.showZeroBalance 
            ? state.sponsorships.length + state.zeroBalanceStreams.length 
            : state.sponsorships.length;
        const hasMore = state.showZeroBalance 
            ? (state.hasMoreSponsorships || state.hasMoreZeroBalance) 
            : state.hasMoreSponsorships;
        sponsorshipsCount.textContent = totalSponsorships + (hasMore ? '+' : '');
    }
    if (allStreamsCount) {
        allStreamsCount.textContent = state.allStreams.length + (state.hasMoreAllStreams ? '+' : '');
    }
}

/**
 * Handle load more sponsorships
 */
export async function handleLoadMoreSponsorships() {
    // Check if we're in zero balance mode
    if (state.showZeroBalance) {
        // In zero balance mode, we can load more if either has more
        if (state.sponsorshipsLoading || state.zeroBalanceLoading) return;
        if (!state.hasMoreSponsorships && !state.hasMoreZeroBalance) return;
    } else {
        if (state.sponsorshipsLoading || !state.hasMoreSponsorships) return;
    }
    
    const btn = document.getElementById('load-more-sponsorships-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent animate-spin inline-block mr-2"></div>Loading...';
    }
    
    state.sponsorshipsLoading = true;
    
    try {
        // Load more sponsorships if available
        if (state.hasMoreSponsorships) {
            const newStreams = await fetchSponsorships(state.sponsorshipsSkip);
            
            if (newStreams.length < STREAMS_PER_PAGE) {
                state.hasMoreSponsorships = false;
            }
            
            state.sponsorships = [...state.sponsorships, ...newStreams];
            state.sponsorshipsSkip += newStreams.length;
        }
        
        // In zero balance mode, also load more zero balance if available
        if (state.showZeroBalance && state.hasMoreZeroBalance) {
            state.zeroBalanceLoading = true;
            const newZeroBalance = await fetchZeroBalanceSponsorships(state.zeroBalanceSkip);
            
            if (newZeroBalance.length < STREAMS_PER_PAGE) {
                state.hasMoreZeroBalance = false;
            }
            
            state.zeroBalanceStreams = [...state.zeroBalanceStreams, ...newZeroBalance];
            state.zeroBalanceSkip += newZeroBalance.length;
            state.zeroBalanceLoading = false;
        }
        
        // Re-render the table with sorting
        if (state.showZeroBalance) {
            const combined = [...state.sponsorships, ...state.zeroBalanceStreams];
            renderSponsorshipsTable(sortSponsorships(combined), false);
            // Update button visibility
            if (btn) {
                btn.classList.toggle('hidden', !state.hasMoreSponsorships && !state.hasMoreZeroBalance);
            }
        } else {
            renderSponsorshipsTable(sortSponsorships(state.sponsorships), false);
        }
        
        updateTabCounters();
    } catch (error) {
        logger.error('Failed to Load more sponsorships:', error);
        UI.showToast({ type: 'error', title: 'Error', message: 'Failed to load more streams' });
    } finally {
        state.sponsorshipsLoading = false;
        state.zeroBalanceLoading = false;
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Load More';
        }
    }
}

/**
 * Handle load more all streams
 */
export async function handleLoadMoreAllStreams() {
    if (state.allStreamsLoading || !state.hasMoreAllStreams) return;
    
    const btn = document.getElementById('load-more-nonsponsored-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent animate-spin inline-block mr-2"></div>Loading...';
    }
    
    state.allStreamsLoading = true;
    
    try {
        const newStreams = await fetchAllStreams(state.allStreamsSkip);
        
        if (newStreams.length < STREAMS_PER_PAGE) {
            state.hasMoreAllStreams = false;
        }
        
        state.allStreams = [...state.allStreams, ...newStreams];
        state.allStreamsSkip += newStreams.length;
        
        renderAllStreamsTable(newStreams, true);
        updateTabCounters();
    } catch (error) {
        logger.error('Failed to load more streams:', error);
        UI.showToast({ type: 'error', title: 'Error', message: 'Failed to load more streams' });
    } finally {
        state.allStreamsLoading = false;
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Load More';
        }
    }
}

/**
 * Handle zero balance sponsorships toggle
 */
export async function handleZeroBalanceToggle(event) {
    state.showZeroBalance = event.target.checked;
    
    const loadMoreBtn = document.getElementById('load-more-sponsorships-btn');
    const searchInput = document.getElementById('streams-search-input');
    const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';
    
    if (state.showZeroBalance) {
        // Load zero balance sponsorships if not already loaded
        if (state.zeroBalanceStreams.length === 0) {
            UI.showLoader(true);
            try {
                const zeroBalance = await fetchZeroBalanceSponsorships(0);
                state.zeroBalanceStreams = zeroBalance;
                state.zeroBalanceSkip = zeroBalance.length;
                state.hasMoreZeroBalance = zeroBalance.length >= STREAMS_PER_PAGE;
            } catch (error) {
                logger.error('Failed to load zero balance sponsorships:', error);
                UI.showToast({ type: 'error', title: 'Error', message: 'Failed to load zero balance sponsorships' });
            } finally {
                UI.showLoader(false);
            }
        }
        
        // Combine active and zero balance sponsorships
        let combined = [...state.sponsorships, ...state.zeroBalanceStreams];
        
        // Apply search filter if there's a search term
        if (searchTerm) {
            combined = combined.filter(s => (s.stream?.id || '').toLowerCase().includes(searchTerm));
            state.filteredSponsorships = sortSponsorships(combined);
            renderSponsorshipsTable(state.filteredSponsorships, false);
        } else {
            renderSponsorshipsTable(sortSponsorships(combined), false);
        }
        
        // Update load more button logic
        if (loadMoreBtn) {
            loadMoreBtn.classList.toggle('hidden', !state.hasMoreSponsorships && !state.hasMoreZeroBalance);
        }
    } else {
        // Show only active sponsorships with balance > 0
        let streams = state.sponsorships;
        
        // Apply search filter if there's a search term
        if (searchTerm) {
            streams = streams.filter(s => (s.stream?.id || '').toLowerCase().includes(searchTerm));
            state.filteredSponsorships = sortSponsorships(streams);
            renderSponsorshipsTable(state.filteredSponsorships, false);
        } else {
            renderSponsorshipsTable(sortSponsorships(streams), false);
        }
        
        if (loadMoreBtn) {
            loadMoreBtn.classList.toggle('hidden', !state.hasMoreSponsorships);
        }
    }
    
    updateTabCounters();
}

/**
 * Sort sponsorships based on current sort state
 */
function sortSponsorships(streams) {
    const sorted = [...streams];
    
    sorted.sort((a, b) => {
        let aVal, bVal;
        
        switch (state.sortField) {
            case 'payout':
                aVal = BigInt(a.totalPayoutWeiPerSec || '0');
                bVal = BigInt(b.totalPayoutWeiPerSec || '0');
                break;
            case 'apy':
                aVal = parseFloat(a.spotAPY || 0);
                bVal = parseFloat(b.spotAPY || 0);
                break;
            case 'staked':
                aVal = BigInt(a.totalStakedWei || '0');
                bVal = BigInt(b.totalStakedWei || '0');
                break;
            case 'operators':
                aVal = parseInt(a.operatorCount || 0);
                bVal = parseInt(b.operatorCount || 0);
                break;
            default:
                aVal = parseFloat(a.spotAPY || 0);
                bVal = parseFloat(b.spotAPY || 0);
        }
        
        // Handle BigInt comparison
        if (typeof aVal === 'bigint' && typeof bVal === 'bigint') {
            if (state.sortDirection === 'desc') {
                return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
            } else {
                return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
            }
        }
        
        // Handle number comparison
        if (state.sortDirection === 'desc') {
            return bVal - aVal;
        } else {
            return aVal - bVal;
        }
    });
    
    return sorted;
}

/**
 * Handle sort column click
 */
export function handleSortClick(field) {
    // Toggle direction if same field, otherwise set to desc
    if (state.sortField === field) {
        state.sortDirection = state.sortDirection === 'desc' ? 'asc' : 'desc';
    } else {
        state.sortField = field;
        state.sortDirection = 'desc';
    }
    
    // Update header UI
    updateSortHeaderUI();
    
    // Re-render with sorted data
    const streams = state.showZeroBalance 
        ? [...state.sponsorships, ...state.zeroBalanceStreams]
        : state.sponsorships;
    
    // If in search mode, sort filtered results
    if (state.searchMode && state.filteredSponsorships.length > 0) {
        renderSponsorshipsTable(sortSponsorships(state.filteredSponsorships), false);
    } else {
        renderSponsorshipsTable(sortSponsorships(streams), false);
    }
}

/**
 * Update sort header UI to show current sort state
 */
export function updateSortHeaderUI() {
    const fields = ['payout', 'apy', 'staked', 'operators'];
    const downArrow = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>';
    const upArrow = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"/>';
    const neutralArrow = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"/>';
    
    fields.forEach(field => {
        const header = document.getElementById(`sponsorships-sort-${field}`);
        if (!header) return;
        
        const icon = header.querySelector('.sort-icon');
        if (!icon) return;
        
        if (state.sortField === field) {
            header.classList.add('text-blue-400');
            header.classList.remove('text-gray-500');
            icon.classList.add('opacity-100');
            icon.classList.remove('opacity-0', 'group-hover:opacity-50');
            icon.innerHTML = state.sortDirection === 'desc' ? downArrow : upArrow;
        } else {
            header.classList.remove('text-blue-400');
            header.classList.add('text-gray-500');
            icon.classList.remove('opacity-100');
            icon.classList.add('opacity-0', 'group-hover:opacity-50');
            icon.innerHTML = neutralArrow;
        }
    });
}

/**
 * Handle stream search - queries API directly for results
 */
export async function handleStreamSearch(term) {
    state.searchQuery = term;
    
    if (!term) {
        // Reset to show all
        state.searchMode = false;
        state.filteredSponsorships = [];
        state.filteredAllStreams = [];
        
        // Re-render with original data
        if (state.activeTab === 'sponsorships') {
            const streams = state.showZeroBalance 
                ? [...state.sponsorships, ...state.zeroBalanceStreams]
                : state.sponsorships;
            renderSponsorshipsTable(sortSponsorships(streams), false);
        } else {
            renderAllStreamsTable(state.allStreams, false);
        }
        updateTabCounters();
        return;
    }
    
    state.searchMode = true;
    
    // Hide Load More buttons during search mode
    const loadMoreSponsorshipsBtn = document.getElementById('load-more-sponsorships-btn');
    const loadMoreAllStreamsBtn = document.getElementById('load-more-nonsponsored-btn');
    if (loadMoreSponsorshipsBtn) loadMoreSponsorshipsBtn.classList.add('hidden');
    if (loadMoreAllStreamsBtn) loadMoreAllStreamsBtn.classList.add('hidden');
    
    // Show loading indicator
    UI.showLoader(true);
    
    try {
        // Search via API based on current tab
        if (state.activeTab === 'sponsorships') {
            // Search sponsorships via API, considering the inactive toggle
            const results = await searchSponsorships(term, state.showZeroBalance);
            state.filteredSponsorships = sortSponsorships(results);
            renderSponsorshipsTable(state.filteredSponsorships, false);
            
            // Hide Load More for sponsorships during search
            if (loadMoreSponsorshipsBtn) loadMoreSponsorshipsBtn.classList.add('hidden');
        } else {
            // Search all streams via API
            const results = await searchAllStreams(term);
            state.filteredAllStreams = results;
            renderAllStreamsTable(state.filteredAllStreams, false);
            
            // Hide Load More for all streams during search
            if (loadMoreAllStreamsBtn) loadMoreAllStreamsBtn.classList.add('hidden');
        }
        
        // Update counters to reflect search results
        const sponsorshipsCount = document.getElementById('streams-tab-sponsorships-count');
        const allStreamsCount = document.getElementById('streams-tab-nonsponsored-count');
        
        if (sponsorshipsCount && state.filteredSponsorships.length > 0) {
            sponsorshipsCount.textContent = state.filteredSponsorships.length;
        }
        if (allStreamsCount && state.filteredAllStreams.length > 0) {
            allStreamsCount.textContent = state.filteredAllStreams.length;
        }
    } catch (error) {
        logger.error('Failed to search streams:', error);
        UI.showToast({ type: 'error', title: 'Search Error', message: 'Failed to search streams' });
    } finally {
        UI.showLoader(false);
    }
}
