// The live stream player: partitions, messages and rates
import * as Utils from '../../core/utils.js';
import * as UI from '../../ui/ui.js';
import * as Services from '../../core/services.js';
import { logger } from '../../core/utils.js';
import { detailState } from './state.js';

// ============================================
// Live Data Player
// ============================================

let playerListenersSetup = false;

/**
 * Initialize partition selector based on stream partitions
 */
export function initializePartitionSelector(partitions) {
    const selectorContainer = document.getElementById('stream-partition-selector');
    const select = document.getElementById('stream-partition-select');
    
    if (!selectorContainer || !select) return;
    
    // Show selector only if more than 1 partition
    if (partitions > 1) {
        selectorContainer.classList.remove('hidden');
        selectorContainer.classList.add('flex');
        
        // Populate partition options with "All" first
        select.innerHTML = '';
        
        // Add "All" option first
        const allOption = document.createElement('option');
        allOption.value = 'all';
        allOption.textContent = 'All';
        select.appendChild(allOption);
        
        // Add individual partition options
        for (let i = 0; i < partitions; i++) {
            const option = document.createElement('option');
            option.value = i;
            option.textContent = `Partition ${i}`;
            select.appendChild(option);
        }
        
        // Set default to Partition 0
        select.value = '0';
    } else {
        selectorContainer.classList.add('hidden');
        selectorContainer.classList.remove('flex');
    }
}

export function setupStreamPlayerListeners() {
    if (playerListenersSetup) return;
    playerListenersSetup = true;
    
    const playBtn = document.getElementById('stream-play-btn');
    const stopBtn = document.getElementById('stream-stop-btn');
    const clearBtn = document.getElementById('stream-clear-btn');
    const partitionSelect = document.getElementById('stream-partition-select');
    
    if (playBtn) {
        playBtn.addEventListener('click', startStreamPlayer);
    }
    
    if (stopBtn) {
        stopBtn.addEventListener('click', stopStreamPlayer);
    }
    
    if (clearBtn) {
        clearBtn.addEventListener('click', clearStreamPlayerLog);
    }
    
    // Add change listener for partition selector to auto-switch subscription
    if (partitionSelect) {
        partitionSelect.addEventListener('change', handlePartitionChange);
    }
}

/**
 * Handle partition dropdown change - auto-switch subscription if active
 */
async function handlePartitionChange() {
    // Only re-subscribe if there's an active subscription
    const isSubscribed = detailState.subscription || detailState.subscriptions.length > 0;
    if (!isSubscribed) return;
    
    // Stop current subscription and start new one with selected partition
    await stopStreamPlayer();
    await startStreamPlayer();
}

async function startStreamPlayer() {
    const streamId = detailState.currentStreamId;
    if (!streamId) return;
    
    const playBtn = document.getElementById('stream-play-btn');
    const stopBtn = document.getElementById('stream-stop-btn');
    const statusDot = document.getElementById('stream-player-status');
    const statusText = document.getElementById('stream-player-status-text');
    const logContainer = document.getElementById('stream-player-log');
    const partitionSelect = document.getElementById('stream-partition-select');
    
    statusText.textContent = 'Connecting...';
    statusDot.classList.remove('bg-gray-500', 'bg-green-500');
    statusDot.classList.add('bg-yellow-500');
    
    try {
        // Get the global Streamr client from Services
        const streamrClient = Services.getStreamrClient();
        if (!streamrClient) {
            throw new Error('Streamr client not initialized');
        }
        
        detailState.messageCount = 0;
        detailState.messageTimestamps = [];
        detailState.bytesReceived = 0;
        detailState.bytesTimestamps = [];
        logContainer.innerHTML = '';
        
        // Determine which partitions to subscribe to
        const selectedValue = partitionSelect ? partitionSelect.value : '0';
        const subscribeToAll = selectedValue === 'all';
        const partitions = detailState.partitions;
        
        if (subscribeToAll && partitions > 1) {
            // Subscribe to all partitions
            detailState.subscriptions = [];
            for (let i = 0; i < partitions; i++) {
                const sub = await streamrClient.subscribe(
                    { streamId, partition: i },
                    (content, metadata) => {
                        handleStreamMessage(content, metadata, i);
                    }
                );
                detailState.subscriptions.push(sub);
            }
            statusText.textContent = `Subscribed (All ${partitions} partitions)`;
        } else if (partitions > 1 && partitionSelect) {
            // Subscribe to selected partition
            const selectedPartition = parseInt(partitionSelect.value) || 0;
            detailState.subscription = await streamrClient.subscribe(
                { streamId, partition: selectedPartition },
                (content, metadata) => {
                    handleStreamMessage(content, metadata, selectedPartition);
                }
            );
            statusText.textContent = `Subscribed (Partition ${selectedPartition})`;
        } else {
            // Subscribe to stream (default partition 0)
            detailState.subscription = await streamrClient.subscribe(
                streamId,
                (content, metadata) => {
                    handleStreamMessage(content, metadata);
                }
            );
            statusText.textContent = 'Subscribed';
        }
        
        // Update UI
        playBtn.classList.add('hidden');
        stopBtn.classList.remove('hidden');
        statusDot.classList.remove('bg-yellow-500');
        statusDot.classList.add('bg-green-500');
        
        // Start rate counter
        detailState.rateInterval = setInterval(updateMessageRate, 1000);
        
    } catch (error) {
        logger.error('Failed to subscribe to stream:', error);
        statusText.textContent = 'Error: ' + error.message;
        statusDot.classList.remove('bg-yellow-500');
        statusDot.classList.add('bg-red-500');
        UI.showToast({ type: 'error', title: 'Subscription Failed', message: error.message });
    }
}

function handleStreamMessage(content, metadata, partition = null) {
    detailState.messageCount++;
    const now = Date.now();
    detailState.messageTimestamps.push(now);
    
    // Calculate message size for KB/s
    const contentStr = typeof content === 'object' ? JSON.stringify(content) : String(content);
    const messageBytes = new Blob([contentStr]).size;
    detailState.bytesReceived += messageBytes;
    detailState.bytesTimestamps.push({ timestamp: now, bytes: messageBytes });
    
    // Update count
    const msgCountEl = document.getElementById('stream-player-msg-count');
    if (msgCountEl) msgCountEl.textContent = detailState.messageCount;
    
    // Add message to log
    const logContainer = document.getElementById('stream-player-log');
    if (!logContainer) return;
    
    const msgDiv = document.createElement('div');
    msgDiv.className = 'mb-2 pb-2 border-b border-[#333] last:border-b-0';
    
    const timestamp = new Date().toLocaleTimeString();
    const partitionBadge = partition !== null 
        ? `<span class="px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded text-[10px]">P${partition}</span>` 
        : '';
    
    msgDiv.innerHTML = `
        <div class="flex items-center gap-2 mb-1">
            <span class="text-gray-500">${timestamp}</span>
            <span class="text-gray-600">#${detailState.messageCount}</span>
            ${partitionBadge}
        </div>
        <pre class="text-green-400 whitespace-pre-wrap break-all">${Utils.escapeHtml(contentStr)}</pre>
    `;
    
    logContainer.appendChild(msgDiv);
    
    // Auto-scroll to bottom
    logContainer.scrollTop = logContainer.scrollHeight;
    
    // Limit messages displayed
    while (logContainer.children.length > 100) {
        logContainer.removeChild(logContainer.firstChild);
    }
}

function updateMessageRate() {
    const now = Date.now();
    const oneSecondAgo = now - 1000;
    
    // Count messages in last second
    detailState.messageTimestamps = detailState.messageTimestamps.filter(t => t > oneSecondAgo);
    const rate = detailState.messageTimestamps.length;
    
    const rateEl = document.getElementById('stream-player-rate');
    if (rateEl) rateEl.textContent = rate;
    
    // Calculate Kbps (kilobits per second)
    detailState.bytesTimestamps = detailState.bytesTimestamps.filter(b => b.timestamp > oneSecondAgo);
    const bytesInLastSecond = detailState.bytesTimestamps.reduce((sum, b) => sum + b.bytes, 0);
    const kbps = ((bytesInLastSecond * 8) / 1000).toFixed(2);
    
    const kbpsEl = document.getElementById('stream-player-kbps');
    if (kbpsEl) kbpsEl.textContent = kbps;
}

export async function stopStreamPlayer() {
    // Stop single subscription
    if (detailState.subscription) {
        try {
            await detailState.subscription.unsubscribe();
        } catch (e) {
            logger.warn('Error unsubscribing:', e);
        }
        detailState.subscription = null;
    }
    
    // Stop multiple subscriptions
    for (const sub of detailState.subscriptions) {
        try {
            await sub.unsubscribe();
        } catch (e) {
            logger.warn('Error unsubscribing from partition:', e);
        }
    }
    detailState.subscriptions = [];
    
    if (detailState.rateInterval) {
        clearInterval(detailState.rateInterval);
        detailState.rateInterval = null;
    }
    
    const playBtn = document.getElementById('stream-play-btn');
    const stopBtn = document.getElementById('stream-stop-btn');
    const statusDot = document.getElementById('stream-player-status');
    const statusText = document.getElementById('stream-player-status-text');
    
    if (playBtn) playBtn.classList.remove('hidden');
    if (stopBtn) stopBtn.classList.add('hidden');
    if (statusText) statusText.textContent = 'Idle';
    if (statusDot) {
        statusDot.classList.remove('bg-green-500', 'bg-yellow-500', 'bg-red-500');
        statusDot.classList.add('bg-gray-500');
    }
    
    // Reset KB/s display
    const kbpsEl = document.getElementById('stream-player-kbps');
    if (kbpsEl) kbpsEl.textContent = '0';
}

export function clearStreamPlayerLog() {
    const logContainer = document.getElementById('stream-player-log');
    if (logContainer) {
        logContainer.innerHTML = `<div class="text-gray-500 text-center py-8">Click "Subscribe" to start receiving live data</div>`;
    }
    detailState.messageCount = 0;
    detailState.bytesReceived = 0;
    detailState.bytesTimestamps = [];
    
    const msgCountEl = document.getElementById('stream-player-msg-count');
    if (msgCountEl) msgCountEl.textContent = '0';
    
    const kbpsEl = document.getElementById('stream-player-kbps');
    if (kbpsEl) kbpsEl.textContent = '0';
}

/** The player's listeners are set up again with the next stream */
export function resetPlayerListeners() {
    playerListenersSetup = false;
}
