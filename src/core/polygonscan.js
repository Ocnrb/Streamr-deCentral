// Polygonscan (Etherscan API v2): the operator's transaction history and contract logs
import { STREAMR_TREASURY_ADDRESS, POLYGONSCAN_NETWORK, POLYGONSCAN_METHOD_IDS, VOTE_ON_FLAG_RAW_AMOUNTS, OPERATOR_EXPLOIT_ADDRESSES, getEtherscanApiKey, buildPolygonscanUrl, STORAGE_KEYS } from './constants.js';
import { showToast } from '../ui/ui.js';
import { logger } from './utils.js';

function isPolygonscanRateLimited(data) {
    if (data?.status === "0" && typeof data?.result === 'string') {
        const msg = data.result.toLowerCase();
        return msg.includes('rate limit') || 
               msg.includes('max rate limit') || 
               msg.includes('too many requests');
    }
    return false;
}

/**
 * Fetch with retry logic for Polygonscan API rate limits
 * @param {string} url - The URL to fetch
 * @param {number} maxRetries - Maximum retry attempts
 * @param {number} baseDelay - Base delay in ms for exponential backoff
 * @returns {Promise<Object>} The JSON response
 */
async function fetchWithPolygonscanRetry(url, maxRetries = 5, baseDelay = 2000) {
    let lastError = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const response = await fetch(url, { cache: 'no-store' });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            
            // Check for rate limit in response
            if (isPolygonscanRateLimited(data)) {
                if (attempt < maxRetries - 1) {
                    const delay = baseDelay * Math.pow(2, attempt);
                    logger.log(`[Polygonscan] Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                throw new Error('Polygonscan API rate limit exceeded');
            }
            
            return data;
        } catch (error) {
            lastError = error;
            
            // Retry on network errors
            if (attempt < maxRetries - 1) {
                const delay = baseDelay * Math.pow(2, attempt);
                logger.log(`[Polygonscan] Request failed, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
        }
    }
    
    throw lastError || new Error('Polygonscan API request failed after retries');
}

/**
 * Execute a READ operation with automatic RPC fallback on rate limiting.
 * Use this for all contract.call() and provider read operations.
 * @param {Function} readFn - Async function that performs the read operation
 * @param {number} maxRetries - Maximum retry attempts (default: 3)
 * @returns {Promise<any>} Read result
 */

// --- API Key Management ---
/**
 * Updates the Etherscan API key in localStorage.
 * The key will be used by getEtherscanApiKey() from constants.js.
 * @param {string} newKey - The new API key (empty string uses default fallback)
 */
export function updateEtherscanApiKey(newKey) {
    if (newKey && newKey.trim() !== '') {
        localStorage.setItem(STORAGE_KEYS.ETHERSCAN_API_KEY, newKey.trim());
    } else {
        localStorage.removeItem(STORAGE_KEYS.ETHERSCAN_API_KEY);
    }
    logger.log("Etherscan API Key updated.");
}

// --- API (Polygonscan) ---

/**
 * Event logs emitted by a contract (oldest first), through the Polygonscan logs API
 * @param {string} address - contract address
 * @param {number} [maxPages=5] - pages of 1000 logs
 * @returns {Promise<Array<{topics: string[], data: string, transactionHash: string, blockNumber: string, logIndex: string}>>}
 */
export async function fetchContractLogs(address, maxPages = 5) {
    const apiKey = getEtherscanApiKey();
    if (!apiKey) return [];
    const { apiUrl, chainId } = POLYGONSCAN_NETWORK;
    const logs = [];
    for (let page = 1; page <= maxPages; page++) {
        const url = `${apiUrl}?chainid=${chainId}&module=logs&action=getLogs&address=${address}&fromBlock=0&toBlock=latest&page=${page}&offset=1000&apikey=${apiKey}`;
        const data = await fetchWithPolygonscanRetry(url, 2) // few retries: the history waits for it;
        const result = Array.isArray(data?.result) ? data.result : [];
        logs.push(...result);
        if (result.length < 1000) break;
    }
    return logs;
}

export async function fetchPolygonscanHistory(walletAddress, offset = 500, sponsorshipAddresses = [], page = 1) {
    const apiKey = getEtherscanApiKey();
    
    // Create a Set of known sponsorship addresses (smart contracts) for quick lookup
    const sponsorshipSet = new Set(sponsorshipAddresses.map(addr => addr.toLowerCase()));
    if (!apiKey) {
        logger.warn("Etherscan API Key not available. Skipping transaction history fetch.");
        return [];
    }

    // Build URLs using centralized helper
    const txlistUrl = buildPolygonscanUrl({
        module: 'account',
        action: 'txlist',
        address: walletAddress,
        page,
        offset
    });
    
    const tokentxUrl = buildPolygonscanUrl({
        module: 'account',
        action: 'tokentx',
        address: walletAddress,
        page,
        offset
    });

    try {
        // Fetch with retry logic for rate limits - sequential to avoid overwhelming API
        const txlistData = await fetchWithPolygonscanRetry(txlistUrl);
        
        // Small delay between requests to be nice to the API
        await new Promise(r => setTimeout(r, 300));
        
        const tokentxData = await fetchWithPolygonscanRetry(tokentxUrl);

        // Handle "No transactions found" or empty results as empty array, not error
        // Polygonscan returns status "0" for both errors AND empty results
        const isEmptyOrNoTx = (data) => {
            if (data.status === "1") return false; // Success with results
            if (!data.result || data.result === '') return true; // Empty result
            if (typeof data.result === 'string') {
                const msg = data.result.toLowerCase();
                if (msg.includes('no transactions found') || msg.includes('no records found')) return true;
            }
            return false;
        };
        
        const isFatalError = (data, type) => {
            if (data.status === "1") return false;
            if (isEmptyOrNoTx(data)) return false;
            // Real error - has error message that's not about empty results
            if (typeof data.result === 'string' && data.result.length > 0) {
                logger.warn(`Polygonscan ${type} warning:`, data.result);
                return true;
            }
            return false;
        };
        
        if (isFatalError(txlistData, 'txlist')) {
            throw new Error(`API Error (txlist): ${txlistData.result}`);
        }
        if (isFatalError(tokentxData, 'tokentx')) {
            throw new Error(`API Error (tokentx): ${tokentxData.result}`);
        }

        const normalTxs = Array.isArray(txlistData.result) ? txlistData.result : [];
        const tokenTxs = Array.isArray(tokentxData.result) ? tokentxData.result : [];
        const nativeToken = POLYGONSCAN_NETWORK.nativeToken;

        const filteredFinalTxs = processPolygonscanPage(normalTxs, tokenTxs, walletAddress, sponsorshipSet, nativeToken);

        const hasMore = normalTxs.length === offset || tokenTxs.length === offset;
        
        return {
            transactions: filteredFinalTxs,
            hasMore: hasMore
        };

    } catch (error) {
        console.error("Error fetching Polygonscan history:", error);
        showToast({ type: 'error', title: 'API Error', message: 'Failed to fetch transaction history. Check your API key in Settings.', duration: 8000 });
        return { transactions: [], hasMore: false };
    }
}

export async function fetchAllPolygonscanHistory(walletAddress, sponsorshipAddresses = [], initialPage = 1, existingTxs = []) {
    const apiKey = getEtherscanApiKey();
    if (!apiKey) return existingTxs;

    const OFFSET = 500;
    const MAX_PAGES = 20;
    const BASE_DELAY = 2000;
    const sponsorshipSet = new Set(sponsorshipAddresses.map(addr => addr.toLowerCase()));
    const nativeToken = POLYGONSCAN_NETWORK.nativeToken;
    
    // One key per transfer: a transaction has several (e.g. earnings + tax + stake) and can be split
    // across two pages, so hash + timestamp would drop the transfers of the second page
    const transferKey = (tx) => `${tx.txHash}|${tx.token}|${tx.from}|${tx.to}|${tx.rawValue}|${tx.direction}`.toLowerCase();
    const existingHashes = new Set(existingTxs.map(transferKey));
    let allProcessedTxs = [...existingTxs];
    let page = initialPage;
    let hasMore = true;
    let consecutiveErrors = 0;
    
    while (hasMore) {
        try {
            const txlistUrl = buildPolygonscanUrl({
                module: 'account',
                action: 'txlist',
                address: walletAddress,
                page,
                offset: OFFSET
            });
            
            const tokentxUrl = buildPolygonscanUrl({
                module: 'account',
                action: 'tokentx',
                address: walletAddress,
                page,
                offset: OFFSET
            });
            
            // Use retry-enabled fetch for both requests (sequential to avoid overwhelming API)
            const txlistData = await fetchWithPolygonscanRetry(txlistUrl);
            await new Promise(r => setTimeout(r, 300));
            const tokentxData = await fetchWithPolygonscanRetry(tokentxUrl);

            // Handle "No transactions found" as empty, not error
            const isEmptyResult = (data) => {
                if (data.status === "1") return false;
                if (!data.result || data.result === '') return true;
                if (typeof data.result === 'string') {
                    const msg = data.result.toLowerCase();
                    if (msg.includes('no transactions found') || msg.includes('no records found')) return true;
                }
                return false;
            };

            const normalTxs = isEmptyResult(txlistData) ? [] : (txlistData.result || []);
            const tokenTxs = isEmptyResult(tokentxData) ? [] : (tokentxData.result || []);

            const pageTxs = processPolygonscanPage(normalTxs, tokenTxs, walletAddress, sponsorshipSet, nativeToken);
            
            const newTxs = pageTxs.filter(tx => !existingHashes.has(transferKey(tx)));
            newTxs.forEach(tx => existingHashes.add(transferKey(tx)));
            allProcessedTxs = [...allProcessedTxs, ...newTxs];

            hasMore = (normalTxs.length === OFFSET || tokenTxs.length === OFFSET) && page < MAX_PAGES;
            consecutiveErrors = 0;
            page++;

            if (hasMore) {
                await new Promise(r => setTimeout(r, BASE_DELAY));
            }
        } catch (error) {
            logger.warn(`[Polygonscan] Error fetching page ${page}:`, error.message);
            consecutiveErrors++;
            if (consecutiveErrors >= 3) {
                logger.warn(`[Polygonscan] Too many consecutive errors, stopping pagination`);
                break;
            }
            page++;
            hasMore = page <= MAX_PAGES;
        }
    }
    
    return allProcessedTxs;
}

function processPolygonscanPage(normalTxs, tokenTxs, walletAddress, sponsorshipSet, nativeToken) {
    const methodIdMap = new Map();
    
    const processedNormalTxs = normalTxs.map(tx => {
        const direction = tx.from.toLowerCase() === walletAddress.toLowerCase() ? "OUT" : "IN";
        const methodIdHex = (tx.input === "0x" || !tx.input) ? "-" : tx.input.substring(0, 10);
        const methodId = POLYGONSCAN_METHOD_IDS[methodIdHex] || methodIdHex;
        
        if (methodId !== "-") {
            methodIdMap.set(tx.hash, methodId);
        }

        return {
            txHash: tx.hash,
            timestamp: parseInt(tx.timeStamp),
            token: nativeToken,
            direction: direction,
            methodId: methodId,
            amount: parseFloat(tx.value) / 1e18,
            rawValue: tx.value,
            // Same fields as fetchPolygonscanHistory (the history matches transfers by counterparty)
            from: tx.from,
            to: tx.to
        };
    });

    const tokenTxsByHash = new Map();
    for (const tx of tokenTxs) {
        if (!tokenTxsByHash.has(tx.hash)) {
            tokenTxsByHash.set(tx.hash, []);
        }
        tokenTxsByHash.get(tx.hash).push(tx);
    }

    const processedTokenTxs = [];
    for (const [txHash, txGroup] of tokenTxsByHash.entries()) {
        const baseMethodId = methodIdMap.get(txHash) || "-";
        let groupMethodId = inferGroupMethodId(txGroup, baseMethodId, walletAddress, sponsorshipSet);

        const protocolTaxIndex = txGroup.findIndex(t => 
            t.from.toLowerCase() === walletAddress.toLowerCase() && 
            t.to.toLowerCase() === STREAMR_TREASURY_ADDRESS.toLowerCase() &&
            t.tokenSymbol === "DATA"
        );
        const rebalanceEarnings = baseMethodId === "Rebalance Stake" ? findRebalanceEarnings(txGroup, walletAddress) : new Set();

        for (let i = 0; i < txGroup.length; i++) {
            const tx = txGroup[i];
            const direction = tx.from.toLowerCase() === walletAddress.toLowerCase() ? "OUT" : "IN";
            const decimals = parseInt(tx.tokenDecimal) || 18;
            const amount = parseFloat(tx.value) / Math.pow(10, decimals);
            const isToTreasury = tx.to.toLowerCase() === STREAMR_TREASURY_ADDRESS.toLowerCase();
            
            const finalMethodId = classifyTransaction(
                tx, direction, isToTreasury, baseMethodId, groupMethodId, 
                protocolTaxIndex, i, sponsorshipSet, rebalanceEarnings
            );
        
            processedTokenTxs.push({
                txHash: tx.hash,
                timestamp: parseInt(tx.timeStamp),
                token: tx.tokenSymbol,
                direction: direction,
                methodId: finalMethodId,
                amount: amount,
                rawValue: tx.value,
                from: tx.from,
                to: tx.to
            });
        }
    }

    const allTxs = [...processedNormalTxs, ...processedTokenTxs];
    return allTxs.filter(tx => {
        const tokenSymbol = tx.token.toUpperCase();
        if (tokenSymbol === 'DATA') return true;
        if (tokenSymbol === nativeToken.toUpperCase() && tx.amount > 0) return true;
        return false;
    });
}

function inferGroupMethodId(txGroup, baseMethodId, walletAddress, sponsorshipSet) {
    if (baseMethodId !== "-") return baseMethodId;
    
    const directions = txGroup.map(t => t.from.toLowerCase() === walletAddress.toLowerCase() ? "OUT" : "IN");
    const hasIn = directions.includes("IN");
    const hasOutToTreasury = txGroup.some(t => 
        t.from.toLowerCase() === walletAddress.toLowerCase() && 
        t.to.toLowerCase() === STREAMR_TREASURY_ADDRESS.toLowerCase()
    );
    const allAreIn = directions.every(d => d === "IN");
    const dataTransfers = txGroup.filter(t => t.tokenSymbol === "DATA");
    
    if (txGroup.length > 1) {
        if (hasIn && hasOutToTreasury) return "Collect Earnings";
        if (allAreIn && dataTransfers.length > 1) return "Force Unstake";
    } else if (txGroup.length === 1) {
        const singleTx = txGroup[0];
        const singleDirection = directions[0];
        const singleIsToTreasury = singleTx.to.toLowerCase() === STREAMR_TREASURY_ADDRESS.toLowerCase();
        
        if (singleTx.tokenSymbol === "DATA") {
            if (VOTE_ON_FLAG_RAW_AMOUNTS.has(singleTx.value)) return "Vote On Flag";
            if (singleDirection === "OUT" && singleIsToTreasury) return "Protocol Tax";
            if (singleDirection === "IN") {
                return sponsorshipSet.has(singleTx.from.toLowerCase()) ? "Reduce Stake" : "Delegate";
            }
            if (singleDirection === "OUT" && !singleIsToTreasury) {
                return sponsorshipSet.has(singleTx.to.toLowerCase()) ? "Stake" : "Undelegate";
            }
        }
    }
    return "-";
}

/**
 * Rebalance Stake (V4): a sponsorship left or reduced sends the stake and, in a second transfer, its
 * earnings; the smaller transfers from the same sponsorship are the earnings
 * @returns {Set<Object>} the earnings transfers of the group
 */
function findRebalanceEarnings(txGroup, walletAddress) {
    const inBySender = new Map();
    for (const t of txGroup) {
        if (t.tokenSymbol !== "DATA" || t.from.toLowerCase() === walletAddress.toLowerCase()) continue;
        const sender = t.from.toLowerCase();
        if (!inBySender.has(sender)) inBySender.set(sender, []);
        inBySender.get(sender).push(t);
    }
    const earnings = new Set();
    for (const ins of inBySender.values()) {
        if (ins.length < 2) continue;
        const stake = ins.reduce((a, b) => (BigInt(b.value) > BigInt(a.value) ? b : a));
        for (const t of ins) if (t !== stake) earnings.add(t);
    }
    return earnings;
}

function classifyTransaction(tx, direction, isToTreasury, baseMethodId, groupMethodId, protocolTaxIndex, index, sponsorshipSet, rebalanceEarnings = new Set()) {
    if (direction === "OUT" && tx.tokenSymbol === "DATA" && isToTreasury) {
        return "Protocol Tax";
    }
    // DATA taken by the 2026-10-09 Operator drain
    if (direction === "OUT" && tx.tokenSymbol === "DATA" && OPERATOR_EXPLOIT_ADDRESSES.has(tx.to.toLowerCase())) {
        return "Exploit Drain";
    }
    // Rebalance Stake (V4): stake back from sponsorships (+ their earnings), stake into others, undelegation
    // queue paid out. Sponsorships not known here are fixed later from The Graph (relabelSponsorshipTransfers).
    if (baseMethodId === "Rebalance Stake" && tx.tokenSymbol === "DATA") {
        if (direction === "IN") return rebalanceEarnings.has(tx) ? "Collect Earnings" : "Reduce Stake";
        return sponsorshipSet.has(tx.to.toLowerCase()) ? "Stake" : "Undelegate";
    }
    if ((groupMethodId === "Reduce Stake" || groupMethodId === "Collect Earnings") && direction === "OUT") {
        return "Undelegate";
    }
    if (protocolTaxIndex !== -1 && index === protocolTaxIndex + 2 && tx.tokenSymbol === "DATA") {
        return "Collect Earnings";
    }
    if (["Stake", "Undelegate", "Reduce Stake", "Unstake"].includes(baseMethodId)) {
        return baseMethodId;
    }
    if (baseMethodId === "Collect Earnings" && direction === "IN" && tx.tokenSymbol === "DATA") {
        return "Collect Earnings";
    }
    if ((baseMethodId === "Unstake" || baseMethodId === "Force Unstake") && direction === "OUT" && !isToTreasury) {
        return baseMethodId;
    }
    if (baseMethodId === "Delegate" && direction === "OUT" && tx.tokenSymbol === "DATA" && !isToTreasury) {
        return "Stake";
    }
    if ((baseMethodId === "Delegate" || baseMethodId === "Transfer") && direction === "IN") {
        return "Delegate";
    }
    if (groupMethodId === "-" && tx.tokenSymbol === "DATA" && VOTE_ON_FLAG_RAW_AMOUNTS.has(tx.value)) {
        return "Vote On Flag";
    }
    if (groupMethodId === "-" && tx.tokenSymbol === "DATA") {
        if (direction === "IN") {
            return sponsorshipSet.has(tx.from.toLowerCase()) ? "Reduce Stake" : "Delegate";
        }
        if (direction === "OUT") {
            if (sponsorshipSet.has(tx.to.toLowerCase())) return "Stake";
            if (!isToTreasury) return "Undelegate";
        }
    }
    return groupMethodId;
}
