// Polygonscan (Etherscan API v2): the operator's transaction history and contract logs
import { STREAMR_TREASURY_ADDRESS, POLYGONSCAN_NETWORK, POLYGONSCAN_METHOD_IDS, VOTE_ON_FLAG_RAW_AMOUNTS, getEtherscanApiKey, buildPolygonscanUrl, STORAGE_KEYS } from './constants.js';
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

        const methodIdMap = new Map();
        const processedNormalTxs = normalTxs.map(tx => {
            const direction = tx.from.toLowerCase() === walletAddress.toLowerCase() ? "OUT" : "IN";
            const methodIdHex = (tx.input === "0x" || !tx.input) ? "-" : tx.input.substring(0, 10);
            const methodId = POLYGONSCAN_METHOD_IDS[methodIdHex] || methodIdHex;
            
            if (methodId !== "-") {
                methodIdMap.set(tx.hash, methodId);
            }

            const amount = parseFloat(tx.value) / 1e18;

            return {
                txHash: tx.hash,
                timestamp: parseInt(tx.timeStamp),
                token: nativeToken,
                direction: direction,
                methodId: methodId,
                amount: amount,
                rawValue: tx.value,
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
            let groupMethodId = baseMethodId;

            // ===========================================
            // INFER METHOD ID FROM TOKEN TRANSFER PATTERNS
            // (for transactions initiated by other addresses)
            // ===========================================
            if (groupMethodId === "-") {
                const directions = txGroup.map(t => t.from.toLowerCase() === walletAddress.toLowerCase() ? "OUT" : "IN");
                const hasIn = directions.includes("IN");
                const hasOut = directions.includes("OUT");
                const hasOutToTreasury = txGroup.some(t => 
                    t.from.toLowerCase() === walletAddress.toLowerCase() && 
                    t.to.toLowerCase() === STREAMR_TREASURY_ADDRESS.toLowerCase()
                );
                const allAreIn = directions.every(d => d === "IN");
                const dataTransfers = txGroup.filter(t => t.tokenSymbol === "DATA");
                
                if (txGroup.length > 1) {
                    // Multiple transfers in same tx
                    if (hasIn && hasOutToTreasury) {
                        // IN + OUT to Treasury = Collect Earnings (earnings + protocol tax)
                        groupMethodId = "Collect Earnings";
                    } else if (allAreIn && dataTransfers.length > 1) {
                        // Multiple DATA INs = Force Unstake (slashing payout from multiple sources)
                        groupMethodId = "Force Unstake";
                    }
                } else if (txGroup.length === 1) {
                    // Single transfer - try to infer from context
                    const singleTx = txGroup[0];
                    const singleDirection = directions[0];
                    const singleIsToTreasury = singleTx.to.toLowerCase() === STREAMR_TREASURY_ADDRESS.toLowerCase();
                    
                    if (singleTx.tokenSymbol === "DATA") {
                        // First check if it's a Vote on Flag (specific amounts)
                        if (VOTE_ON_FLAG_RAW_AMOUNTS.has(singleTx.value)) {
                            groupMethodId = "Vote On Flag";
                        } else if (singleDirection === "OUT" && singleIsToTreasury) {
                            // OUT to Treasury = Protocol Tax
                            groupMethodId = "Protocol Tax";
                        } else if (singleDirection === "IN") {
                            // Single DATA IN with unknown method
                            // Check if from address is a known sponsorship (smart contract)
                            const fromAddress = singleTx.from.toLowerCase();
                            if (sponsorshipSet.has(fromAddress)) {
                                // From sponsorship without Tax (single tx) = Reduce Stake
                                // (Collect Earnings would typically have a second Tax transfer)
                                groupMethodId = "Reduce Stake";
                            } else {
                                // From normal address (EOA) = Delegate (external user delegating)
                                groupMethodId = "Delegate";
                            }
                        } else if (singleDirection === "OUT" && !singleIsToTreasury) {
                            // Single DATA OUT without known method
                            // Check if destination is a known sponsorship (smart contract)
                            const toAddress = singleTx.to.toLowerCase();
                            if (sponsorshipSet.has(toAddress)) {
                                // To sponsorship = Stake
                                groupMethodId = "Stake";
                            } else {
                                // To normal address (EOA) = Undelegate (returning funds to delegator)
                                groupMethodId = "Undelegate";
                            }
                        }
                    }
                }
            }

            // Find index of Protocol Tax transaction (OUT to Treasury) in this group to help classify related transfers
            const protocolTaxIndex = txGroup.findIndex(t => 
                t.from.toLowerCase() === walletAddress.toLowerCase() && 
                t.to.toLowerCase() === STREAMR_TREASURY_ADDRESS.toLowerCase() &&
                t.tokenSymbol === "DATA"
            );

            for (let i = 0; i < txGroup.length; i++) {
                const tx = txGroup[i];
                const direction = tx.from.toLowerCase() === walletAddress.toLowerCase() ? "OUT" : "IN";
                const decimals = parseInt(tx.tokenDecimal) || 18;
                const amount = parseFloat(tx.value) / Math.pow(10, decimals);
                const isToTreasury = tx.to.toLowerCase() === STREAMR_TREASURY_ADDRESS.toLowerCase();
                
                let finalMethodId = groupMethodId;

                // ===========================================
                // TRANSACTION CLASSIFICATION RULES (in order of priority)
                // ===========================================

                // 1. Protocol Tax: any DATA OUT to Treasury address (highest priority)
                if (direction === "OUT" && tx.tokenSymbol === "DATA" && isToTreasury) {
                    finalMethodId = "Protocol Tax";
                }
                // 2. Specific overrides for Reduce Stake/Collect Earnings OUT
                // If the group is identified as "Collect Earnings" (inferred or explicit), 
                // any OUT that isn't Tax (caught by Rule 1) must be something else, usually Undelegate.
                else if ((groupMethodId === "Reduce Stake" || groupMethodId === "Collect Earnings") && direction === "OUT") {
                    finalMethodId = "Undelegate";
                }
                // 3. Protocol Tax Context: The 2nd transaction after tax is typically the earnings component
                else if (protocolTaxIndex !== -1 && i === protocolTaxIndex + 2 && tx.tokenSymbol === "DATA") {
                    finalMethodId = "Collect Earnings";
                }
                // 4. Known methods that should keep their name
                else if (baseMethodId === "Stake") {
                    finalMethodId = "Stake";
                }
                else if (baseMethodId === "Undelegate") {
                    finalMethodId = "Undelegate";
                }
                else if (baseMethodId === "Reduce Stake") {
                    finalMethodId = "Reduce Stake";
                }
                else if (baseMethodId === "Unstake") {
                    finalMethodId = "Unstake";
                }
                // 5. Collect Earnings (0xe8e658b4): IN = "Collect Earnings"
                else if (baseMethodId === "Collect Earnings" && direction === "IN" && tx.tokenSymbol === "DATA") {
                    finalMethodId = "Collect Earnings";
                }
                // 6. Unstake/Force Unstake: OUT (not to treasury) - keep method name
                else if ((baseMethodId === "Unstake" || baseMethodId === "Force Unstake") && direction === "OUT" && !isToTreasury) {
                    finalMethodId = baseMethodId;
                }
                // 7. Delegate (transferAndCall) OUT = "Stake" (staking into sponsorship via transferAndCall)
                else if (baseMethodId === "Delegate" && direction === "OUT" && tx.tokenSymbol === "DATA" && !isToTreasury) {
                    finalMethodId = "Stake";
                }
                // 8. Delegate/Transfer: IN = "Delegate"
                else if ((baseMethodId === "Delegate" || baseMethodId === "Transfer") && direction === "IN") {
                    finalMethodId = "Delegate";
                }
                // 9. Vote On Flag: detected by specific raw amounts (fallback)
                else if (finalMethodId === "-" && tx.tokenSymbol === "DATA" && VOTE_ON_FLAG_RAW_AMOUNTS.has(tx.value)) {
                    finalMethodId = "Vote On Flag";
                }
                // 10. Fallback for unknown methods based on address types (Heuristic for complex txs)
                else if (finalMethodId === "-" && tx.tokenSymbol === "DATA") {
                    if (direction === "IN") {
                        // IN from Sponsorship -> Reduce Stake (heuristic for unknown method)
                        if (sponsorshipSet.has(tx.from.toLowerCase())) {
                            finalMethodId = "Reduce Stake";
                        } else {
                            // IN from User/Other -> Delegate
                            finalMethodId = "Delegate";
                        }
                    } else if (direction === "OUT") {
                        // OUT to Sponsorship -> Stake
                        if (sponsorshipSet.has(tx.to.toLowerCase())) {
                            finalMethodId = "Stake";
                        } else if (!isToTreasury) {
                            // OUT to User/Other -> Undelegate
                            finalMethodId = "Undelegate";
                        }
                    }
                }
            
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

        const filteredFinalTxs = allTxs.filter(tx => {
            const tokenSymbol = tx.token.toUpperCase();
            const nativeTokenSymbol = nativeToken.toUpperCase();
            if (tokenSymbol === 'DATA') {
                return true;
            }
            if (tokenSymbol === nativeTokenSymbol && tx.amount > 0) {
                return true;
            }
            return false;
        });

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

        for (let i = 0; i < txGroup.length; i++) {
            const tx = txGroup[i];
            const direction = tx.from.toLowerCase() === walletAddress.toLowerCase() ? "OUT" : "IN";
            const decimals = parseInt(tx.tokenDecimal) || 18;
            const amount = parseFloat(tx.value) / Math.pow(10, decimals);
            const isToTreasury = tx.to.toLowerCase() === STREAMR_TREASURY_ADDRESS.toLowerCase();
            
            const finalMethodId = classifyTransaction(
                tx, direction, isToTreasury, baseMethodId, groupMethodId, 
                protocolTaxIndex, i, sponsorshipSet
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

function classifyTransaction(tx, direction, isToTreasury, baseMethodId, groupMethodId, protocolTaxIndex, index, sponsorshipSet) {
    if (direction === "OUT" && tx.tokenSymbol === "DATA" && isToTreasury) {
        return "Protocol Tax";
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
