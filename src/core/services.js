import {
    DATA_TOKEN_ADDRESS_POLYGON,
    STREAMR_CONFIG_ADDRESS,
    STREAMR_TREASURY_ADDRESS, 
    DATA_TOKEN_ABI,
    OPERATOR_CONTRACT_ABI,
    STREAMR_CONFIG_ABI,
    DATA_HISTORY_STREAM_ID,
    POLYGON_RPC_URL,
    POLYGON_RPC_FALLBACKS,
    DELEGATORS_PER_PAGE,
    OPERATORS_PER_PAGE,
    MIN_SEARCH_LENGTH,
    MIN_ADDRESS_SEARCH_LENGTH,
    FULL_ADDRESS_LENGTH,
    POLYGONSCAN_NETWORK,
    POLYGONSCAN_METHOD_IDS,
    VOTE_ON_FLAG_RAW_AMOUNTS,
    getGraphUrl,
    getEtherscanApiKey,
    buildPolygonscanUrl,
    STORAGE_KEYS
} from './constants.js';
import { showToast, setModalState, txModalAmount, txModalBalanceValue, txModalMinimumValue, stakeModalAmount, stakeModalCurrentStake, stakeModalFreeFunds, dataPriceValueEl, transactionModal, stakeModal } from '../ui/ui.js';
import { getFriendlyErrorMessage, convertWeiToData, parseDateFromCsv, parseOperatorMetadata, logger } from './utils.js';

// Note: etherscanApiKey is now managed via getEtherscanApiKey() from constants.js
// This variable is kept for backward compatibility with updateEtherscanApiKey()
let _etherscanApiKeyOverride = null;

let streamrClient = null;
let coordinationSubscription = null;
let historySubscription = null;
let historicalDataPriceMap = null;
let historicalEurRateMap = null;

// Callbacks for notifying when historical data is loaded
let historicalDataCallbacks = [];

// Callback for live price updates (extracted from DATA_History stream)
let livePriceCallback = null;
let currentLivePrice = null; 

// --- Centralized RPC Provider ---

let _readOnlyProvider = null;
let _currentRpcIndex = 0;

// Storage key for persisting working RPC index
const RPC_INDEX_STORAGE_KEY = 'polygon_rpc_index';

/**
 * Load the last working RPC index from localStorage
 */
function loadRpcIndex() {
    try {
        const stored = localStorage.getItem(RPC_INDEX_STORAGE_KEY);
        if (stored !== null) {
            const index = parseInt(stored, 10);
            if (!isNaN(index) && index >= 0 && index < POLYGON_RPC_FALLBACKS.length) {
                _currentRpcIndex = index;
                console.log(`[RPC] Loaded last working RPC index: ${index} (${POLYGON_RPC_FALLBACKS[index]})`);
            }
        }
    } catch (e) {
        // Ignore localStorage errors
    }
}

/**
 * Save the current RPC index to localStorage
 */
function saveRpcIndex() {
    try {
        localStorage.setItem(RPC_INDEX_STORAGE_KEY, String(_currentRpcIndex));
    } catch (e) {
        // Ignore localStorage errors
    }
}

/**
 * Get or create a singleton read-only JsonRpcProvider for Polygon.
 * This should be used for all read operations that don't require a signer.
 * @returns {ethers.providers.JsonRpcProvider}
 */
export function getReadOnlyProvider() {
    if (!_readOnlyProvider) {
        // Load last working RPC on first call
        loadRpcIndex();
        const rpcUrl = POLYGON_RPC_FALLBACKS[_currentRpcIndex] || POLYGON_RPC_URL;
        _readOnlyProvider = new ethers.providers.JsonRpcProvider(rpcUrl);
        console.log(`[RPC] Initialized with: ${rpcUrl}`);
    }
    return _readOnlyProvider;
}

/**
 * Switch to next available RPC endpoint when rate limited.
 * @returns {ethers.providers.JsonRpcProvider} New provider with fallback RPC
 */
export function switchToFallbackRpc() {
    _currentRpcIndex = (_currentRpcIndex + 1) % POLYGON_RPC_FALLBACKS.length;
    const newRpcUrl = POLYGON_RPC_FALLBACKS[_currentRpcIndex];
    console.log(`[RPC] Switching to fallback RPC: ${newRpcUrl}`);
    _readOnlyProvider = new ethers.providers.JsonRpcProvider(newRpcUrl);
    saveRpcIndex(); // Persist the new working RPC
    return _readOnlyProvider;
}

/**
 * Get current RPC URL being used
 * @returns {string} Current RPC URL
 */
export function getCurrentRpcUrl() {
    return POLYGON_RPC_FALLBACKS[_currentRpcIndex] || POLYGON_RPC_URL;
}

/**
 * Reconnect a signer to the current RPC provider.
 * Use this when the signer's provider is rate limited.
 * @param {ethers.Signer} signer - The signer to reconnect
 * @returns {ethers.Signer} A new signer connected to the current provider
 */
export function reconnectSigner(signer) {
    if (!signer) return null;
    
    // For Wallet signers, we can connect to a new provider
    if (signer._isSigner && signer.privateKey) {
        const newProvider = getReadOnlyProvider();
        return new ethers.Wallet(signer.privateKey, newProvider);
    }
    
    // For other signers (like from MetaMask), return as-is
    return signer;
}

/**
 * Get the best available provider for READ operations.
 * Always uses the current read-only provider (which may have been switched due to rate limits).
 * For write operations, use the signer directly.
 * @param {ethers.Signer|null} signer - Optional signer (ignored for reads, use getReadOnlyProvider)
 * @returns {ethers.providers.Provider}
 */
export function getProvider(signer = null) {
    // Always use the current read-only provider for read operations
    // This ensures we use the fallback RPC if the primary was rate limited
    return getReadOnlyProvider();
}

// --- Gas Price Helper ---

// Gas price limits (in gwei)
const GAS_CONFIG = {
    MIN_GAS_PRICE: 35,           // Minimum gas price for Polygon
    MIN_PRIORITY_FEE: 30,        // Minimum priority fee
    MAX_GAS_PRICE: 1500,          // Maximum gas price we'll accept (safety limit)
    WARNING_GAS_PRICE: 150,      // Show warning above this threshold
    DEFAULT_GAS_PRICE: 50,       // Fallback if we can't get fee data
    DEFAULT_PRIORITY_FEE: 30     // Fallback priority fee
};

/**
 * Get gas overrides for Polygon transactions
 * Polygon requires higher gas prices than the default ethers.js estimation
 * Includes safety limits to prevent excessive gas costs
 */
export async function getGasOverrides(provider) {
    try {
        const feeData = await provider.getFeeData();
        const minGasPrice = ethers.utils.parseUnits(String(GAS_CONFIG.MIN_GAS_PRICE), 'gwei');
        const minPriorityFee = ethers.utils.parseUnits(String(GAS_CONFIG.MIN_PRIORITY_FEE), 'gwei');
        const maxGasPrice = ethers.utils.parseUnits(String(GAS_CONFIG.MAX_GAS_PRICE), 'gwei');
        
        let maxFeePerGas = feeData.maxFeePerGas && feeData.maxFeePerGas.gt(minGasPrice) 
            ? feeData.maxFeePerGas 
            : minGasPrice;
            
        let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas.gt(minPriorityFee)
            ? feeData.maxPriorityFeePerGas
            : minPriorityFee;
        
        // Safety cap: prevent excessively high gas prices
        if (maxFeePerGas.gt(maxGasPrice)) {
            const currentGwei = ethers.utils.formatUnits(maxFeePerGas, 'gwei');
            console.warn(`Gas price ${currentGwei} gwei exceeds safety limit of ${GAS_CONFIG.MAX_GAS_PRICE} gwei, capping.`);
            maxFeePerGas = maxGasPrice;
        }
        
        // Cap priority fee to not exceed max gas price
        if (maxPriorityFeePerGas.gt(maxFeePerGas)) {
            maxPriorityFeePerGas = maxFeePerGas;
        }
        
        return {
            maxFeePerGas,
            maxPriorityFeePerGas
        };
    } catch (e) {
        console.warn('Failed to get fee data, using defaults:', e);
        return {
            maxFeePerGas: ethers.utils.parseUnits(String(GAS_CONFIG.DEFAULT_GAS_PRICE), 'gwei'),
            maxPriorityFeePerGas: ethers.utils.parseUnits(String(GAS_CONFIG.DEFAULT_PRIORITY_FEE), 'gwei')
        };
    }
}

/**
 * Check if current gas prices are unusually high and warn user
 * Returns true if user should proceed, false if they cancelled
 */
async function checkGasPriceAndWarn(provider) {
    try {
        const feeData = await provider.getFeeData();
        if (!feeData.maxFeePerGas) return true;
        
        const currentGwei = parseFloat(ethers.utils.formatUnits(feeData.maxFeePerGas, 'gwei'));
        
        if (currentGwei > GAS_CONFIG.WARNING_GAS_PRICE) {
            const proceed = confirm(
                `⚠️ High Gas Price Warning!\n\n` +
                `Current gas price: ${currentGwei.toFixed(0)} gwei\n` +
                `Normal range: 30-100 gwei\n\n` +
                `This transaction may cost more than usual.\n` +
                `Do you want to proceed?`
            );
            return proceed;
        }
        
        if (currentGwei > GAS_CONFIG.MAX_GAS_PRICE) {
            showToast({ 
                type: 'error', 
                title: 'Gas Price Too High', 
                message: `Current gas (${currentGwei.toFixed(0)} gwei) exceeds safety limit. Try again later.`,
                duration: 10000 
            });
            return false;
        }
        
        return true;
    } catch (e) {
        console.warn('Could not check gas price:', e);
        return true; // Proceed if we can't check
    }
}

/**
 * Check if an error is a rate limit error
 * Excludes transaction failures (CALL_EXCEPTION with receipt) which are on-chain reverts, not rate limits
 * @param {Error} error - The error to check
 * @returns {boolean} True if rate limited
 */
export function isRateLimitError(error) {
    // If this error has a transaction receipt, it's an on-chain failure, not a rate limit
    // These are transactions that were mined but reverted
    if (error?.receipt || error?.transactionHash) {
        return false;
    }
    
    const msg = error?.message?.toLowerCase() || '';
    const errorStr = JSON.stringify(error || {}).toLowerCase();
    
    // Check for rate limit patterns
    const isRateLimit = msg.includes('too many requests') || 
           msg.includes('rate limit') || 
           msg.includes('-32090') ||
           msg.includes('could not detect network') ||
           errorStr.includes('-32090') ||
           errorStr.includes('rate limit');
    
    return isRateLimit;
}

/**
 * Check if a Polygonscan API response indicates a rate limit error
 * @param {Object} data - The JSON response from Polygonscan API
 * @returns {boolean} True if rate limited
 */
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
export async function readWithFallback(readFn, maxRetries = 3) {
    let lastError = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await readFn();
        } catch (e) {
            lastError = e;
            
            if (isRateLimitError(e) && attempt < maxRetries - 1) {
                console.log(`[RPC] Read rate limited, switching to fallback (attempt ${attempt + 1}/${maxRetries})...`);
                
                // Switch to fallback RPC
                switchToFallbackRpc();
                
                // Wait before retry (longer for rate limits)
                await new Promise(resolve => setTimeout(resolve, 2000));
                continue;
            }
            
            throw e;
        }
    }
    
    throw lastError;
}

/**
 * Execute a transaction with automatic RPC fallback on rate limiting.
 * IMPORTANT: Only retries if rate limit occurs BEFORE transaction is submitted.
 * If tx is already submitted, we wait for it instead of retrying.
 * @param {Function} txFn - Async function that executes the transaction, receives signer
 * @param {ethers.Signer} signer - The signer to use
 * @param {number} maxRetries - Maximum retry attempts (default: 3)
 * @returns {Promise<any>} Transaction result
 */
export async function executeWithFallback(txFn, signer, maxRetries = 3) {
    let currentSigner = signer;
    let lastError = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await txFn(currentSigner);
        } catch (e) {
            lastError = e;
            
            // If the error has a transaction hash, the tx was already submitted
            // Don't retry - just throw the error (tx either succeeded or failed on-chain)
            if (e?.transactionHash || e?.transaction?.hash || e?.receipt) {
                console.log(`[RPC] Transaction was submitted (hash exists), not retrying:`, e?.transactionHash || e?.transaction?.hash);
                throw e;
            }
            
            if (isRateLimitError(e) && attempt < maxRetries - 1) {
                console.log(`[RPC] Rate limited before tx submission, switching to fallback (attempt ${attempt + 1}/${maxRetries})...`);
                
                // Switch to fallback RPC
                switchToFallbackRpc();
                
                // Reconnect signer to new provider
                currentSigner = reconnectSigner(signer);
                
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, 2000));
                continue;
            }
            
            throw e;
        }
    }
    
    throw lastError;
}

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


// --- Wallet & Network ---
export async function checkAndSwitchNetwork() {
    try {
        if (!window.ethereum) {
            showToast({ type: 'error', title: 'Wallet not detected', message: 'Please install a wallet like MetaMask.', duration: 0 });
            return false;
        }
        const provider = new ethers.providers.Web3Provider(window.ethereum);
        const network = await provider.getNetwork();
        if (network.chainId !== 137) {
            showToast({ type: 'warning', title: 'Incorrect Network', message: 'Please switch your wallet to the Polygon Mainnet.', duration: 8000 });
            try {
                await window.ethereum.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: '0x89' }],
                });
                window.location.reload();
                return true;
            } catch (switchError) {
                if (switchError.code === 4902) {
                    try {
                        await window.ethereum.request({
                            method: 'wallet_addEthereumChain',
                            params: [{
                                chainId: '0x89',
                                chainName: 'Polygon Mainnet',
                                rpcUrls: ['https://polygon-rpc.com'],
                                nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
                                blockExplorerUrls: ['https://polygonscan.com/'],
                            }],
                        });
                        window.location.reload();
                        return true;
                    } catch (addError) {
                        console.error("Failed to add Polygon network", addError);
                        showToast({ type: 'error', title: 'Network Error', message: 'Failed to add the Polygon network to your wallet.', duration: 0 });
                    }
                } else {
                     showToast({ type: 'error', title: 'Network Error', message: 'Failed to switch network. Please do it manually in your wallet.', duration: 0 });
                }
                console.error("Failed to switch network", switchError);
                return false;
            }
        }
        return true;
    } catch (e) {
        console.error("Could not check network:", e);
        return false;
    }
}

// --- API (CSV Price Data) ---

// Web Worker instance for CSV parsing
let csvParserWorker = null;

/**
 * Initialize CSV parser Web Worker
 * @returns {Worker|null} Worker instance or null if not supported
 */
function getCsvParserWorker() {
    if (csvParserWorker) return csvParserWorker;
    
    if (typeof Worker !== 'undefined') {
        try {
            csvParserWorker = new Worker('/workers/csv-parser.worker.js');
            return csvParserWorker;
        } catch (e) {
            console.warn('Failed to create CSV parser worker, falling back to main thread:', e);
            return null;
        }
    }
    return null;
}

/**
 * Parse CSV using Web Worker (non-blocking)
 * @param {string} csvText - Raw CSV content
 * @returns {Promise<Map<number, number>>} Price map
 */
function parseCSVWithWorker(csvText) {
    return new Promise((resolve, reject) => {
        const worker = getCsvParserWorker();
        
        if (!worker) {
            // Fallback to synchronous parsing if worker not available
            resolve(parseCSVSync(csvText));
            return;
        }
        
        const timeoutId = setTimeout(() => {
            reject(new Error('CSV parsing timeout'));
        }, 10000); // 10 second timeout
        
        worker.onmessage = function(e) {
            clearTimeout(timeoutId);
            
            if (e.data.success) {
                // Convert array entries back to Map
                const priceMap = new Map(e.data.priceEntries);
                logger.log(`[Worker] Processed ${e.data.count} price points in ${e.data.processingTime}ms`);
                resolve(priceMap);
            } else {
                reject(new Error(e.data.error));
            }
        };
        
        worker.onerror = function(error) {
            clearTimeout(timeoutId);
            logger.warn('CSV Worker error, falling back to main thread:', error);
            resolve(parseCSVSync(csvText));
        };
        
        worker.postMessage({ csvText });
    });
}

/**
 * Synchronous CSV parsing fallback
 * @param {string} csvText - Raw CSV content
 * @returns {Map<number, number>} Price map
 */
function parseCSVSync(csvText) {
    const lines = csvText.split('\n').slice(1);
    const priceMap = new Map();

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue; // Skip empty lines
        
        const parts = trimmedLine.split(',');
        if (parts.length < 2) continue;

        const dateStr = parts[0].trim();
        const priceStr = parts[1].trim();

        if (dateStr && priceStr) {
            const date = parseDateFromCsv(dateStr);
            const price = parseFloat(priceStr);

            if (date && !isNaN(price)) {
                const dayStart = new Date(date);
                dayStart.setUTCHours(0, 0, 0, 0);
                
                const dayTimestampSeconds = Math.floor(dayStart.getTime() / 1000);

                const existingPrice = priceMap.get(dayTimestampSeconds) || 0;
                if (price > existingPrice) {
                    priceMap.set(dayTimestampSeconds, price);
                }
            }
        }
    }
    
    logger.log(`[Sync] Processed ${priceMap.size} price points`);
    return priceMap;
}

/**
 * Parse date string from stream format (DD/MM/YYYY) to UTC timestamp in seconds
 * @param {string} dateStr - Date in format "DD/MM/YYYY"
 * @returns {number|null} UTC timestamp in seconds, or null if invalid
 */
function parseDateFromStream(dateStr) {
    if (!dateStr) return null;
    
    // Match DD/MM/YYYY format
    const match = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) return null;
    
    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1; // 0-indexed
    const year = parseInt(match[3], 10);
    
    // Create UTC date at midnight
    const utcMs = Date.UTC(year, month, day);
    return Math.floor(utcMs / 1000);
}

/**
 * Process historical price data from stream message
 * @param {Array|string|object} data - Array of price objects from stream (may be string or wrapped)
 * @returns {{ priceMap: Map<number, number>, eurMap: Map<number, number> }}
 */
function processStreamHistoricalData(data) {
    const priceMap = new Map();
    const eurMap = new Map();
    
    // Handle different input formats
    let parsedData = data;
    
    // If it's a string, try to parse as JSON
    if (typeof data === 'string') {
        try {
            parsedData = JSON.parse(data);
        } catch (e) {
            console.error('[HistoryStream] Failed to parse string as JSON:', e.message);
            return { priceMap, eurMap };
        }
    }
    
    // If the data is wrapped in an object (e.g., { data: [...] } or { content: [...] })
    if (parsedData && typeof parsedData === 'object' && !Array.isArray(parsedData)) {
        // Try common wrapper keys
        const possibleArrayKeys = ['data', 'content', 'prices', 'history', 'records'];
        for (const key of possibleArrayKeys) {
            if (Array.isArray(parsedData[key])) {
                parsedData = parsedData[key];
                break;
            }
        }
        
        // If still not an array, check if it's an object with numeric keys (array-like)
        if (!Array.isArray(parsedData) && parsedData) {
            const keys = Object.keys(parsedData);
            if (keys.length > 0 && keys.every(k => !isNaN(parseInt(k, 10)))) {
                parsedData = Object.values(parsedData);
            }
        }
    }
    
    if (!Array.isArray(parsedData)) {
        console.warn('[HistoryStream] Invalid data format, expected array');
        return { priceMap, eurMap };
    }
    
    for (const entry of parsedData) {
        const timestamp = parseDateFromStream(entry.date);
        if (timestamp === null) continue;
        
        const price = parseFloat(entry.DATA_USD);
        const eurRate = parseFloat(entry.USD_EUR);
        
        if (!isNaN(price)) {
            // Keep highest price for each day (same logic as CSV)
            const existing = priceMap.get(timestamp) || 0;
            if (price > existing) {
                priceMap.set(timestamp, price);
            }
        }
        
        if (!isNaN(eurRate)) {
            eurMap.set(timestamp, eurRate);
        }
    }
    
    return { priceMap, eurMap };
}

/**
 * Extract and update live price from the stream data (first/most recent entry)
 * @param {Array|Object} data - Raw stream message data
 */
function extractAndUpdateLivePrice(data) {
    try {
        let parsedData = data;
        
        // If it's a string, try to parse as JSON
        if (typeof data === 'string') {
            parsedData = JSON.parse(data);
        }
        
        // If wrapped in an object, extract the array
        if (parsedData && typeof parsedData === 'object' && !Array.isArray(parsedData)) {
            const possibleArrayKeys = ['data', 'content', 'prices', 'history', 'records'];
            for (const key of possibleArrayKeys) {
                if (Array.isArray(parsedData[key])) {
                    parsedData = parsedData[key];
                    break;
                }
            }
        }
        
        if (!Array.isArray(parsedData) || parsedData.length === 0) {
            return;
        }
        
        // Get the first (most recent) entry
        const latestEntry = parsedData[0];
        if (latestEntry && latestEntry.DATA_USD !== undefined) {
            const price = parseFloat(latestEntry.DATA_USD);
            if (!isNaN(price) && price > 0) {
                currentLivePrice = price;
                
                // Update UI
                const priceText = `$${price.toFixed(4)}`;
                if (dataPriceValueEl) {
                    dataPriceValueEl.textContent = priceText;
                }
                const mobilePriceEl = document.getElementById('mobile-data-price');
                if (mobilePriceEl) {
                    mobilePriceEl.textContent = priceText;
                }
                
                // Notify callback
                if (livePriceCallback) {
                    livePriceCallback(price);
                }
                
                logger.log(`[LivePrice] Updated from DATA_History: $${price.toFixed(4)} (date: ${latestEntry.date})`);
            }
        }
    } catch (error) {
        console.error('[LivePrice] Error extracting live price:', error);
    }
}

/**
 * Handle incoming historical data from stream
 * Updates the maps, notifies callbacks, and extracts live price
 * @param {Array} message - Stream message data
 * @param {boolean} isOverride - Whether this is overriding CSV fallback data
 */
function handleHistoricalStreamData(message, isOverride = false) {
    try {
        // Extract live price from the most recent data point
        extractAndUpdateLivePrice(message);
        
        const { priceMap, eurMap } = processStreamHistoricalData(message);
        
        if (priceMap.size > 0) {
            historicalDataPriceMap = priceMap;
            historicalEurRateMap = eurMap;
            
            // Notify callbacks (they may have already been called with CSV data)
            notifyHistoricalDataLoaded();
            return true;
        } else {
            console.warn('[HistoryStream] Received empty data');
            return false;
        }
    } catch (error) {
        console.error('[HistoryStream] Error processing data:', error);
        return false;
    }
}

/**
 * Fetch historical price from CSV file (fallback method)
 * @returns {Promise<{ priceMap: Map, eurMap: Map }>}
 */
async function fetchHistoricalPriceFromCSV() {
    const response = await fetch('/data/DATAHistoricalPrice.csv');
    if (!response.ok) {
        throw new Error(`Failed to fetch DATAHistoricalPrice.csv: ${response.statusText}`);
    }
    const csvText = await response.text();
    
    // Use Web Worker for parsing (non-blocking)
    const priceMap = await parseCSVWithWorker(csvText);
    
    // CSV doesn't have EUR data, return empty map
    return { priceMap, eurMap: new Map() };
}

/**
 * Register a callback to be notified when historical data is loaded or updated
 * @param {Function} callback - Callback function receiving { priceMap, eurMap }
 */
export function onHistoricalDataLoaded(callback) {
    if (typeof callback === 'function') {
        // Always register callback (may be called multiple times if stream overrides CSV)
        historicalDataCallbacks.push(callback);
        
        // If data is already loaded, call immediately
        if (historicalDataPriceMap) {
            callback({ priceMap: historicalDataPriceMap, eurMap: historicalEurRateMap || new Map() });
        }
    }
}

/**
 * Notify all registered callbacks that historical data is loaded/updated
 */
function notifyHistoricalDataLoaded() {
    const data = { priceMap: historicalDataPriceMap, eurMap: historicalEurRateMap || new Map() };
    for (const callback of historicalDataCallbacks) {
        try {
            callback(data);
        } catch (e) {
            console.error('[HistoricalData] Callback error:', e);
        }
    }
    // Don't clear callbacks - they should be called again if stream overrides CSV
}

// Track if we've received stream data (to know if we need to override)
let streamDataReceived = false;
let csvFallbackLoaded = false;

/**
 * Setup historical price data stream subscription (runs in background)
 * Subscribes to stream and starts 30s timer for CSV fallback
 * Stream stays active and will override CSV data if it arrives later
 * Non-blocking - app can start while this loads
 */
export async function setupHistoricalPriceStream() {
    // Already loaded from stream
    if (historicalDataPriceMap && streamDataReceived) {
        return;
    }
    
    if (!streamrClient) {
        console.error('[HistoricalData] StreamrClient not initialized, falling back to CSV');
        await loadCSVFallback();
        return;
    }
    
    // Reset state
    streamDataReceived = false;
    csvFallbackLoaded = false;
    
    // Start 30s timer for CSV fallback
    const fallbackTimerId = setTimeout(async () => {
        if (!streamDataReceived) {
            await loadCSVFallback();
        }
    }, 30000);
    
    try {
        
        historySubscription = await streamrClient.subscribe(DATA_HISTORY_STREAM_ID, (message) => {
            // Clear fallback timer if we get data before timeout
            if (!streamDataReceived) {
                clearTimeout(fallbackTimerId);
            }
            
            const isOverride = csvFallbackLoaded;
            streamDataReceived = true;
            
            handleHistoricalStreamData(message, isOverride);
        });
        
    } catch (error) {
        console.error('[HistoricalData] Subscription failed:', error.message);
        clearTimeout(fallbackTimerId);
        
        // Subscription failed, load CSV immediately
        await loadCSVFallback();
    }
}

/**
 * Load CSV fallback data
 */
async function loadCSVFallback() {
    if (csvFallbackLoaded) return;
    
    try {
        const { priceMap, eurMap } = await fetchHistoricalPriceFromCSV();
        
        // Only use CSV if we haven't received stream data yet
        if (!streamDataReceived) {
            historicalDataPriceMap = priceMap;
            historicalEurRateMap = eurMap;
            csvFallbackLoaded = true;
            
            // Extract the most recent price from CSV as live price fallback
            if (priceMap.size > 0 && !currentLivePrice) {
                // Get the most recent timestamp (highest value)
                const timestamps = Array.from(priceMap.keys()).sort((a, b) => b - a);
                if (timestamps.length > 0) {
                    const latestTimestamp = timestamps[0];
                    const latestPrice = priceMap.get(latestTimestamp);
                    if (latestPrice && latestPrice > 0) {
                        currentLivePrice = latestPrice;
                        
                        // Update UI
                        const priceText = `$${latestPrice.toFixed(4)}`;
                        if (dataPriceValueEl) {
                            dataPriceValueEl.textContent = priceText;
                        }
                        const mobilePriceEl = document.getElementById('mobile-data-price');
                        if (mobilePriceEl) {
                            mobilePriceEl.textContent = priceText;
                        }
                        
                        // Notify callback
                        if (livePriceCallback) {
                            livePriceCallback(latestPrice);
                        }
                        
                        logger.log(`[LivePrice] Fallback from CSV: $${latestPrice.toFixed(4)}`);
                    }
                }
            }
            
            notifyHistoricalDataLoaded();
        }
        // If stream data already arrived, ignore CSV fallback
    } catch (error) {
        console.error('[HistoricalData] CSV fallback failed:', error);
        
        if (!streamDataReceived) {
            showToast({ type: 'warning', title: 'Price Data Error', message: 'Failed to load historical price data.', duration: 6000 });
            // Set empty maps so the app can continue
            historicalDataPriceMap = new Map();
            historicalEurRateMap = new Map();
            notifyHistoricalDataLoaded();
        }
    }
}

/**
 * Get the historical DATA price map.
 * Returns cached data if available, or empty Map if still loading.
 * Use onHistoricalDataLoaded() to be notified when data is ready.
 * @returns {Map<number, number>}
 */
export function getHistoricalDataPriceMap() {
    return historicalDataPriceMap || new Map();
}

/**
 * Get the historical EUR rate map.
 * Returns cached data if available, or empty Map if still loading.
 * @returns {Map<number, number>}
 */
export function getHistoricalEurRateMap() {
    return historicalEurRateMap || new Map();
}

/**
 * Get the current live DATA price (extracted from DATA_History stream or CSV fallback)
 * @returns {number|null} - Current price in USD or null if not yet loaded
 */
export function getCurrentLivePrice() {
    return currentLivePrice;
}

/**
 * @deprecated Use setupHistoricalPriceStream() for background loading instead.
 * Fetches and processes the historical DATA price from a local CSV file (blocking).
 * Kept for backward compatibility - now just returns cached data or empty Map.
 * @returns {Promise<Map<number, number>>}
 */
export async function fetchHistoricalDataPrice() {
    // Return cached data if available
    if (historicalDataPriceMap) {
        return historicalDataPriceMap;
    }
    
    // If not loaded yet, return empty map (background loading handles this)
    return new Map();
}

// --- API (The Graph) ---
export async function runQuery(query) {
    const response = await fetch(getGraphUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
    });
    if (!response.ok) throw new Error(`Network error: ${response.statusText}`);
    const result = await response.json();
    if (result.errors) throw new Error(`GraphQL error: ${result.errors.map(e => e.message).join(', ')}`);
    return result.data;
}

const isAddressFilter = (query) => {
    const normalizedQuery = query.toLowerCase();
    return normalizedQuery.startsWith('0x') && /^[0-9a-f]+$/.test(normalizedQuery.substring(2));
};


export async function fetchOperators(skip = 0, filterQuery = '') {
    if (filterQuery && filterQuery.length > 0 && filterQuery.length < MIN_SEARCH_LENGTH) {
        return [];
    }

    if (filterQuery) {
        const lowerCaseFilter = filterQuery.toLowerCase();
        if (isAddressFilter(lowerCaseFilter)) {
            
            if (lowerCaseFilter.length === FULL_ADDRESS_LENGTH) {
                const whereClause = `where: {id: "${lowerCaseFilter}"}`;
                
                const query = `
                query GetOperatorsList {
                    operators(first: ${OPERATORS_PER_PAGE}, skip: ${skip}, orderBy: valueWithoutEarnings, orderDirection: desc, ${whereClause}) {
                        id valueWithoutEarnings delegatorCount metadataJsonString stakes(first: 50) { amountWei sponsorship { spotAPY } }
                    }
                }`;
                const data = await runQuery(query);
                return data.operators;

            } else {
                return [];
            }

        } else {
            const topResultsQuery = `
                query GetTopOperatorsForClientSearch {
                    operators(first: 1000, orderBy: valueWithoutEarnings, orderDirection: desc) {
                        id valueWithoutEarnings delegatorCount metadataJsonString stakes(first: 50) { amountWei sponsorship { spotAPY } }
                    }
                }`;
            const data = await runQuery(topResultsQuery);
            return data.operators.filter(op => {
                const { name } = parseOperatorMetadata(op.metadataJsonString);
                return name ? name.toLowerCase().includes(lowerCaseFilter) : false;
            });
        }
    } else {
        const query = `
            query GetOperatorsList {
                operators(first: ${OPERATORS_PER_PAGE}, skip: ${skip}, orderBy: valueWithoutEarnings, orderDirection: desc) {
                    id valueWithoutEarnings delegatorCount metadataJsonString stakes(first: 50) { amountWei sponsorship { spotAPY } }
                }
            }`;
        const data = await runQuery(query);
        return data.operators;
    }
}

/**
 * Validates if a string is a valid Ethereum address.
 * @param {string} address - The address to validate.
 * @returns {boolean} True if valid, false otherwise.
 */
function isValidEthereumAddress(address) {
    return typeof address === 'string' && /^0x[a-fA-F0-9]{40}$/.test(address);
}

export async function fetchOperatorDetails(operatorId) {
    if (!isValidEthereumAddress(operatorId)) {
        throw new Error('Invalid operator ID format. Must be a valid Ethereum address.');
    }
    const sanitizedId = operatorId.toLowerCase();
    const query = `
        query GetOperatorDetails {
          operator(id: "${sanitizedId}") {
            id owner valueWithoutEarnings operatorTokenTotalSupplyWei delegatorCount cumulativeEarningsWei cumulativeProfitsWei cumulativeOperatorsCutWei operatorsCutFraction nodes controllers metadataJsonString
            stakes(first: 100) { amountWei sponsorship { id remainingWei spotAPY isRunning totalPayoutWeiPerSec totalStakedWei stream { id } } }
            delegations(where: {isSelfDelegation: false}, first: 15, orderBy: _valueDataWei, orderDirection: desc) { id _valueDataWei operatorTokenBalanceWei delegator { id } }
            queueEntries(orderBy: date, orderDirection: asc) { id amount delegator { id } date }
          }
          selfDelegation: delegations(where: {operator: "${sanitizedId}", isSelfDelegation: true}, first: 1) { _valueDataWei }
          stakingEvents(orderBy: date, orderDirection: desc, first: 1000, where: {operator: "${sanitizedId}"}) {
            id
            amount
            date
            sponsorship { id stream { id } }
          }
          operatorDailyBuckets(first: 1000, orderBy: date, orderDirection: asc, where: {operator: "${sanitizedId}"}) {
            date
            valueWithoutEarnings
            totalDelegatedWei
            totalUndelegatedWei
            profitsWei
            cumulativeEarningsWei
          }
          flagsAgainst: flags(where: {target: "${sanitizedId}"}, orderBy: flaggingTimestamp, orderDirection: desc) {
                id
                flagger { id, metadataJsonString }
                sponsorship { id stream { id } }
                flaggingTimestamp
                result
                votes(orderBy: timestamp, orderDirection: desc) {
                    id
                    voter { id, metadataJsonString }
                    voterWeight
                    votedKick
                    timestamp
                }
          }
          flagsAsFlagger: flags(where: {flagger: "${sanitizedId}"}, orderBy: flaggingTimestamp, orderDirection: desc, first: 100) {
            id
            target { id, metadataJsonString }
            sponsorship { id stream { id } }
            flaggingTimestamp
            result
             votes(orderBy: timestamp, orderDirection: desc) {
                id
                voter { id, metadataJsonString }
                voterWeight
                votedKick
                timestamp
            }
          }
          slashingEvents(where: {operator: "${sanitizedId}"}, orderBy: date, orderDirection: desc, first: 100) { id amount date sponsorship { id stream { id } } }
        }`;
    return await runQuery(query);
}

/**
 * Fetch uncollected earnings for all sponsorships of an operator
 * Calls the operator contract's getSponsorshipsAndEarnings() function
 * and calculates changePerSecond for real-time ticker updates
 * @param {string} operatorId - The operator contract address
 * @param {Array} stakes - Stakes array from operator data (with sponsorship info)
 * @returns {Promise<Map<string, {earningsWei: bigint, changePerSecond: bigint}>>} Map of sponsorship ID to earnings data
 */
export async function fetchSponsorshipEarnings(operatorId, stakes = []) {
    const earningsMap = new Map();
    
    try {
        const provider = getReadOnlyProvider();
        const operatorContract = new ethers.Contract(operatorId, OPERATOR_CONTRACT_ABI, provider);
        
        // Call getSponsorshipsAndEarnings() on the operator contract with fallback
        const result = await readWithFallback(() => operatorContract.getSponsorshipsAndEarnings());
        const addresses = result.addresses || result[0];
        const earnings = result.earnings || result[1];
        
        // Build a lookup map for stake info (for calculating changePerSecond)
        const stakeInfoMap = new Map();
        for (const stake of stakes) {
            if (stake.sponsorship) {
                stakeInfoMap.set(stake.sponsorship.id.toLowerCase(), {
                    myStakeWei: BigInt(stake.amountWei || '0'),
                    totalPayoutWeiPerSec: BigInt(stake.sponsorship.totalPayoutWeiPerSec || '0'),
                    totalStakedWei: BigInt(stake.sponsorship.totalStakedWei || '0'),
                    isRunning: stake.sponsorship.isRunning,
                    remainingWei: BigInt(stake.sponsorship.remainingWei || '0')
                });
            }
        }
        
        // Process each sponsorship's earnings
        for (let i = 0; i < addresses.length; i++) {
            const sponsorshipId = addresses[i].toLowerCase();
            const earningsWei = BigInt(earnings[i].toString());
            
            // Calculate changePerSecond based on stake proportion
            let changePerSecond = BigInt(0);
            const stakeInfo = stakeInfoMap.get(sponsorshipId);
            
            if (stakeInfo && stakeInfo.isRunning && stakeInfo.remainingWei > BigInt(0) && stakeInfo.totalStakedWei > BigInt(0)) {
                // changePerSecond = (myStake / totalStaked) * totalPayoutPerSecond
                // Use BigInt math with precision: (myStake * payoutPerSec) / totalStaked
                changePerSecond = (stakeInfo.myStakeWei * stakeInfo.totalPayoutWeiPerSec) / stakeInfo.totalStakedWei;
            }
            
            earningsMap.set(sponsorshipId, {
                earningsWei,
                changePerSecond,
                lastUpdated: Date.now()
            });
        }
        
        logger.log(`[Earnings] Fetched earnings for ${earningsMap.size} sponsorships`);
        
    } catch (error) {
        logger.error('[Earnings] Failed to fetch sponsorship earnings:', error);
    }
    
    return earningsMap;
}

export async function fetchMoreDelegators(operatorId, skip) {
    if (!isValidEthereumAddress(operatorId)) {
        throw new Error('Invalid operator ID format.');
    }
    const sanitizedId = operatorId.toLowerCase();
    const query = `
        query GetMoreDelegators {
            operator(id: "${sanitizedId}") {
                delegations(where: {isSelfDelegation: false}, first: ${DELEGATORS_PER_PAGE}, skip: ${skip}, orderBy: _valueDataWei, orderDirection: desc) {
                    id _valueDataWei operatorTokenBalanceWei delegator { id }
                }
            }
        }`;
    const data = await runQuery(query);
    return data.operator.delegations;
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

export async function fetchAllStakingEvents(operatorId, initialSkip = 0, existingEvents = []) {
    const PAGE_SIZE = 1000;
    const MAX_EVENTS = 10000;
    let allEvents = [...existingEvents];
    let skip = initialSkip;
    let hasMore = true;
    const sanitizedId = operatorId.toLowerCase();
    
    while (hasMore) {
        const query = `
            query GetStakingEvents {
                stakingEvents(
                    orderBy: date, 
                    orderDirection: desc, 
                    first: ${PAGE_SIZE}, 
                    skip: ${skip}, 
                    where: {operator: "${sanitizedId}"}
                ) {
                    id
                    amount
                    date
                    sponsorship { id stream { id } }
                }
            }`;
        
        const data = await runQuery(query);
        const events = data.stakingEvents || [];
        
        allEvents = [...allEvents, ...events];
        skip += PAGE_SIZE;
        
        hasMore = events.length === PAGE_SIZE && skip < MAX_EVENTS;
        
        if (hasMore) {
            await new Promise(r => setTimeout(r, 100));
        }
    }
    
    return allEvents;
}

export async function fetchAllPolygonscanHistory(walletAddress, sponsorshipAddresses = [], initialPage = 1, existingTxs = []) {
    const apiKey = getEtherscanApiKey();
    if (!apiKey) return existingTxs;

    const OFFSET = 500;
    const MAX_PAGES = 20;
    const BASE_DELAY = 2000;
    const sponsorshipSet = new Set(sponsorshipAddresses.map(addr => addr.toLowerCase()));
    const nativeToken = POLYGONSCAN_NETWORK.nativeToken;
    
    const existingHashes = new Set(existingTxs.map(tx => `${tx.txHash}-${tx.timestamp}`));
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
            
            const newTxs = pageTxs.filter(tx => !existingHashes.has(`${tx.txHash}-${tx.timestamp}`));
            newTxs.forEach(tx => existingHashes.add(`${tx.txHash}-${tx.timestamp}`));
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
            rawValue: tx.value
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
                rawValue: tx.value
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


// --- Blockchain Interactions (Ethers.js) ---

export async function getMaticBalance(address) {
    try {
        const balanceWei = await readWithFallback(async () => {
            const provider = getReadOnlyProvider();
            return await provider.getBalance(address);
        });
        const balanceMatic = parseFloat(ethers.utils.formatEther(balanceWei));
        return balanceMatic.toFixed(2);
    } catch (error) {
        console.error(`Failed to get MATIC balance for ${address}:`, error);
        return 'Error';
    }
}

export async function manageTransactionModal(show, mode = 'delegate', signer, myRealAddress, currentOperatorId) {
    if (!show) {
        transactionModal.classList.add('hidden');
        return '0';
    }
    
    const titleEl = document.getElementById('tx-modal-title');
    const descriptionEl = document.getElementById('tx-modal-description');
    const balanceLabelEl = document.getElementById('tx-modal-balance-label');
    
    titleEl.textContent = mode === 'delegate' ? 'Delegate to Operator' : 'Undelegate from Operator';
    descriptionEl.textContent = mode === 'delegate' ? 'Enter the amount of DATA to delegate.' : 'Enter the amount of DATA to undelegate.';
    balanceLabelEl.textContent = 'Your Balance:';
    txModalBalanceValue.textContent = 'Loading...';
    
    const minimumDelegationContainer = txModalMinimumValue.parentElement;
    minimumDelegationContainer.style.display = mode === 'delegate' ? 'flex' : 'none';

    setModalState('tx-modal', 'input');
    transactionModal.classList.remove('hidden');

    try {
        const provider = signer.provider;
        let balanceWei;
        if (mode === 'delegate') {
            const dataTokenContract = new ethers.Contract(DATA_TOKEN_ADDRESS_POLYGON, DATA_TOKEN_ABI, provider);
            balanceWei = await readWithFallback(() => dataTokenContract.balanceOf(myRealAddress));
            try {
                const configContract = new ethers.Contract(STREAMR_CONFIG_ADDRESS, STREAMR_CONFIG_ABI, provider);
                const minWei = await readWithFallback(() => configContract.minimumDelegationWei());
                txModalMinimumValue.textContent = `${parseFloat(ethers.utils.formatEther(minWei)).toFixed(0)} DATA`;
            } catch (e) {
                console.error("Failed to get minimum delegation", e);
                txModalMinimumValue.textContent = 'N/A';
            }
        } else {
            // Calculate balance using real-time exchange rate for undelegate
            const operatorContract = new ethers.Contract(currentOperatorId, OPERATOR_CONTRACT_ABI, provider);
            const [userTokensWei, totalSupplyWei, valueWithoutEarningsWei] = await readWithFallback(() => 
                Promise.all([
                    operatorContract.balanceOf(myRealAddress),
                    operatorContract.totalSupply(),
                    operatorContract.valueWithoutEarnings()
                ])
            );
            
            // Calculate DATA balance: userTokens * valueWithoutEarnings / totalSupply
            if (totalSupplyWei.isZero()) {
                balanceWei = ethers.BigNumber.from(0);
            } else {
                balanceWei = userTokensWei.mul(valueWithoutEarningsWei).div(totalSupplyWei);
            }
        }
        const balanceFormatted = ethers.utils.formatEther(balanceWei);
        txModalBalanceValue.textContent = `${parseFloat(balanceFormatted).toFixed(4)} DATA`;
        
        return balanceWei.toString();
    } catch (e) {
        console.error(`Failed to get balance for ${mode}:`, e);
        txModalBalanceValue.textContent = 'Error';
        return '0';
    }
}

// Maximum reasonable amount to prevent overflow/abuse (100 billion DATA)
const MAX_DELEGATION_AMOUNT = '100000000000';

export async function confirmDelegation(signer, myRealAddress, currentOperatorId) {
    const amount = txModalAmount.value.replace(',', '.');
    
    // Enhanced input validation
    if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
        showToast({ type: 'warning', title: 'Invalid Amount', message: 'Please enter a valid amount greater than zero.' });
        return null;
    }
    
    // Validate against scientific notation and unreasonable values
    if (/[eE]/.test(amount) || parseFloat(amount) > parseFloat(MAX_DELEGATION_AMOUNT)) {
        showToast({ type: 'warning', title: 'Invalid Amount', message: 'Please enter a reasonable amount without scientific notation.' });
        return null;
    }
    
    setModalState('tx-modal', 'loading', { text: "Checking balance...", subtext: "Please wait." });
    try {
        const dataTokenContract = new ethers.Contract(DATA_TOKEN_ADDRESS_POLYGON, DATA_TOKEN_ABI, signer);
        
        let amountWei;
        try {
            amountWei = ethers.utils.parseEther(amount);
        } catch (parseError) {
            showToast({ type: 'warning', title: 'Invalid Amount', message: 'Could not parse the amount. Please enter a valid number.' });
            setModalState('tx-modal', 'input');
            return null;
        }
        
        const userBalanceWei = await readWithFallback(() => dataTokenContract.balanceOf(myRealAddress));

        if (amountWei.gt(userBalanceWei)) {
            showToast({ type: 'warning', title: 'Insufficient Balance', message: 'You do not have enough DATA to delegate that amount.' });
            setModalState('tx-modal', 'input');
            return null;
        }

        // Check gas price before proceeding
        if (!await checkGasPriceAndWarn(signer.provider)) {
            setModalState('tx-modal', 'input');
            return null;
        }

        setModalState('tx-modal', 'loading');
        const gasOverrides = await getGasOverrides(signer.provider);
        const tx = await dataTokenContract.transferAndCall(currentOperatorId, amountWei, '0x', gasOverrides);
        setModalState('tx-modal', 'loading', { text: 'Processing Transaction...', subtext: 'Waiting for confirmation.' });
        const receipt = await tx.wait();
        setModalState('tx-modal', 'success', { txHash: receipt.transactionHash });
        return receipt.transactionHash;
    } catch (e) {
        console.error("Delegation failed:", e);
        setModalState('tx-modal', 'error', { message: getFriendlyErrorMessage(e) });
        return null;
    }
}

export async function confirmUndelegation(signer, myRealAddress, currentOperatorId) {
    const amountData = txModalAmount.value.replace(',', '.');
    
    // Enhanced input validation
    if (!amountData || isNaN(amountData) || parseFloat(amountData) <= 0) {
        showToast({ type: 'warning', title: 'Invalid Amount', message: 'Please enter a valid amount greater than zero.' });
        return null;
    }
    
    // Validate against scientific notation and unreasonable values
    if (/[eE]/.test(amountData) || parseFloat(amountData) > parseFloat(MAX_DELEGATION_AMOUNT)) {
        showToast({ type: 'warning', title: 'Invalid Amount', message: 'Please enter a reasonable amount without scientific notation.' });
        return null;
    }
    
    setModalState('tx-modal', 'loading', { text: "Checking stake...", subtext: "Please wait." });
    
    try {
        const operatorContract = new ethers.Contract(currentOperatorId, OPERATOR_CONTRACT_ABI, signer);
        
        let amountDataWei;
        try {
            amountDataWei = ethers.utils.parseEther(amountData);
        } catch (parseError) {
            showToast({ type: 'warning', title: 'Invalid Amount', message: 'Could not parse the amount. Please enter a valid number.' });
            setModalState('tx-modal', 'input');
            return null;
        }
        
        // Fetch all required values in parallel for accurate real-time exchange rate calculation
        const [userBalanceTokensWei, totalSupplyWei, valueWithoutEarningsWei] = await readWithFallback(() => 
            Promise.all([
                operatorContract.balanceOf(myRealAddress),
                operatorContract.totalSupply(),
                operatorContract.valueWithoutEarnings()
            ])
        );

        // Calculate real-time exchange rate: DATA per Operator Token
        // exchangeRate = valueWithoutEarnings / totalSupply
        // To convert DATA to Operator Tokens: tokens = amountData * totalSupply / valueWithoutEarnings
        
        // Calculate user's current DATA balance using real-time exchange rate
        let userBalanceDataWei;
        if (totalSupplyWei.isZero()) {
            userBalanceDataWei = ethers.BigNumber.from(0);
        } else {
            userBalanceDataWei = userBalanceTokensWei.mul(valueWithoutEarningsWei).div(totalSupplyWei);
        }

        if (amountDataWei.gt(userBalanceDataWei)) {
            showToast({ type: 'warning', title: 'Insufficient Stake', message: 'You do not have enough staked DATA to undelegate.' });
            setModalState('tx-modal', 'input');
            return null;
        }

        let amountOperatorTokensWei;
        const fullWithdrawalThreshold = userBalanceDataWei.mul(9999).div(10000);
        
        if (amountDataWei.gte(fullWithdrawalThreshold)) {
            // Full withdrawal - use all user's tokens
            amountOperatorTokensWei = userBalanceTokensWei;
        } else {
            // Partial withdrawal - calculate operator tokens using real-time exchange rate
            // operatorTokens = amountData * totalSupply / valueWithoutEarnings
            if (valueWithoutEarningsWei.isZero()) {
                throw new Error("Operator has no DATA value, cannot calculate conversion");
            }
            amountOperatorTokensWei = amountDataWei
                .mul(totalSupplyWei)
                .div(valueWithoutEarningsWei);
            
            // Safety check: never exceed user's token balance
            if (amountOperatorTokensWei.gt(userBalanceTokensWei)) {
                amountOperatorTokensWei = userBalanceTokensWei;
            }
        }

        // Check gas price before proceeding
        if (!await checkGasPriceAndWarn(signer.provider)) {
            setModalState('tx-modal', 'input');
            return null;
        }

        setModalState('tx-modal', 'loading');
        const gasOverrides = await getGasOverrides(signer.provider);
        const tx = await operatorContract.undelegate(amountOperatorTokensWei, gasOverrides);
        setModalState('tx-modal', 'loading', { 
            text: 'Processing Transaction...', 
            subtext: 'Waiting for confirmation.' 
        });
        const receipt = await tx.wait();
        setModalState('tx-modal', 'success', { txHash: receipt.transactionHash });
        return receipt.transactionHash;
        
    } catch (e) {
        console.error("Undelegation failed:", e);
        setModalState('tx-modal', 'error', { message: getFriendlyErrorMessage(e) });
        return null;
    }
}


export async function handleProcessQueue(signer, operatorId) {
    setModalState('tx-modal', 'loading', { text: "Checking gas prices...", subtext: "Please wait." });
    try {
        return await executeWithFallback(async (currentSigner) => {
            // Check gas price before proceeding
            if (!await checkGasPriceAndWarn(currentSigner.provider)) {
                transactionModal.classList.add('hidden');
                return null;
            }
            
            setModalState('tx-modal', 'loading', { text: "Processing Queue...", subtext: "This will pay out queued undelegations." });
            const operatorContract = new ethers.Contract(operatorId, OPERATOR_CONTRACT_ABI, currentSigner);
            const gasOverrides = await getGasOverrides(currentSigner.provider);
            const tx = await operatorContract.payOutQueue(0, gasOverrides);
            setModalState('tx-modal', 'loading', { text: 'Processing Transaction...', subtext: 'Waiting for confirmation.' });
            const receipt = await tx.wait();
            setModalState('tx-modal', 'success', { txHash: receipt.transactionHash });
            return receipt.transactionHash;
        }, signer);
    } catch (e) {
        console.error("Queue processing failed:", e);
        setModalState('tx-modal', 'error', { message: getFriendlyErrorMessage(e) });
        return null;
    }
}

export async function confirmStakeEdit(signer, operatorId, sponsorshipId, currentStakeWei) {
    const targetAmount = stakeModalAmount.value.replace(',', '.');
    if (!targetAmount || isNaN(targetAmount) || parseFloat(targetAmount) < 0) {
        showToast({ type: 'warning', title: 'Invalid Amount', message: 'Please enter a valid number.' });
        return null;
    }
    setModalState('stake-modal', 'loading', { text: "Checking gas prices...", subtext: "Please wait." });
    try {
        // Use executeWithFallback to handle rate limiting
        return await executeWithFallback(async (currentSigner) => {
            // Check gas price before proceeding
            if (!await checkGasPriceAndWarn(currentSigner.provider)) {
                stakeModal.classList.add('hidden');
                return null;
            }
            
            setModalState('stake-modal', 'loading', { text: "Preparing transaction...", subtext: "Please wait." });
            const operatorContract = new ethers.Contract(operatorId, OPERATOR_CONTRACT_ABI, currentSigner);
            const targetAmountWei = ethers.utils.parseEther(targetAmount);
            const currentAmountWei = ethers.BigNumber.from(currentStakeWei);
            const gasOverrides = await getGasOverrides(currentSigner.provider);
            let tx;
            if (targetAmountWei.gt(currentAmountWei)) {
                const differenceWei = targetAmountWei.sub(currentAmountWei);
                tx = await operatorContract.stake(sponsorshipId, differenceWei, gasOverrides);
            } else if (targetAmountWei.lt(currentAmountWei)) {
                tx = await operatorContract.reduceStakeTo(sponsorshipId, targetAmountWei, gasOverrides);
            } else {
                stakeModal.classList.add('hidden');
                return 'nochange';
            }
            setModalState('stake-modal', 'loading');
            const receipt = await tx.wait();
            setModalState('stake-modal', 'success', { txHash: receipt.transactionHash });
            return receipt.transactionHash;
        }, signer);
    } catch(e) {
        console.error("Stake edit failed:", e);
        setModalState('stake-modal', 'error', { message: getFriendlyErrorMessage(e) });
        return null;
    }
}

export async function handleCollectEarnings(signer, operatorId, sponsorshipId) {
    setModalState('tx-modal', 'loading', { text: "Checking gas prices...", subtext: "Please wait." });
    try {
        return await executeWithFallback(async (currentSigner) => {
            // Check gas price before proceeding
            if (!await checkGasPriceAndWarn(currentSigner.provider)) {
                transactionModal.classList.add('hidden');
                return null;
            }
            
            setModalState('tx-modal', 'loading', { text: "Collecting Earnings...", subtext: "Please wait." });
            const operatorContract = new ethers.Contract(operatorId, OPERATOR_CONTRACT_ABI, currentSigner);
            const gasOverrides = await getGasOverrides(currentSigner.provider);
            const tx = await operatorContract.withdrawEarningsFromSponsorships([sponsorshipId], gasOverrides);
            setModalState('tx-modal', 'loading', { text: 'Processing Transaction...', subtext: 'Waiting for confirmation.' });
            const receipt = await tx.wait();
            setModalState('tx-modal', 'success', { txHash: receipt.transactionHash });
            return receipt.transactionHash;
        }, signer);
    } catch (e) {
        console.error("Earnings collection failed:", e);
        setModalState('tx-modal', 'error', { message: getFriendlyErrorMessage(e) });
        return null;
    }
}

export async function handleCollectAllEarnings(signer, operatorId, currentOperatorData) {
    setModalState('tx-modal', 'loading', { text: "Checking gas prices...", subtext: "Please wait." });
    try {
        return await executeWithFallback(async (currentSigner) => {
            // Check gas price before proceeding
            if (!await checkGasPriceAndWarn(currentSigner.provider)) {
                transactionModal.classList.add('hidden');
                return null;
            }
            
            setModalState('tx-modal', 'loading', { text: "Collecting All Earnings...", subtext: "This will collect from all sponsorships." });
            const operatorContract = new ethers.Contract(operatorId, OPERATOR_CONTRACT_ABI, currentSigner);
            const gasOverrides = await getGasOverrides(currentSigner.provider);
            const allSponsorshipIds = currentOperatorData.stakes.map(stake => stake.sponsorship.id);
            const tx = await operatorContract.withdrawEarningsFromSponsorships(allSponsorshipIds, gasOverrides);
            setModalState('tx-modal', 'loading', { text: 'Processing Transaction...', subtext: 'Waiting for confirmation.' });
            const receipt = await tx.wait();
            setModalState('tx-modal', 'success', { txHash: receipt.transactionHash });
            return receipt.transactionHash;
        }, signer);
    } catch (e) {
        console.error("Collect all earnings failed:", e);
        setModalState('tx-modal', 'error', { message: getFriendlyErrorMessage(e) });
        return null;
    }
}


export async function fetchMyStake(operatorId, myRealAddress, signer) {
    if (!myRealAddress) return '0';
    try {
        const provider = getProvider(signer);
        const operatorContract = new ethers.Contract(operatorId, OPERATOR_CONTRACT_ABI, provider);
        
        // Calculate stake using real-time exchange rate
        const [userTokensWei, totalSupplyWei, valueWithoutEarningsWei] = await readWithFallback(() => 
            Promise.all([
                operatorContract.balanceOf(myRealAddress),
                operatorContract.totalSupply(),
                operatorContract.valueWithoutEarnings()
            ])
        );
        
        // Calculate DATA balance: userTokens * valueWithoutEarnings / totalSupply
        if (totalSupplyWei.isZero()) {
            return '0';
        }
        const myStakeWei = userTokensWei.mul(valueWithoutEarningsWei).div(totalSupplyWei);
        return myStakeWei.toString();
    } catch (e) {
        console.error("Failed to get user's stake:", e);
        return '0';
    }
}

// --- Streamr SDK ---
export function setStreamrClient(client) {
    streamrClient = client;
}

export function getStreamrClient() {
    return streamrClient;
}

export async function setupDataPriceStream(onPriceUpdate) {
    // Register callback - price is extracted from DATA_History stream
    livePriceCallback = onPriceUpdate;
    
    const mobilePriceEl = document.getElementById('mobile-data-price');
    
    // Show loading state
    if (dataPriceValueEl) {
        dataPriceValueEl.textContent = 'Loading...';
    }
    if (mobilePriceEl) {
        mobilePriceEl.textContent = '...';
    }
    
    // If we already have a live price from DATA_History, use it immediately
    if (currentLivePrice && currentLivePrice > 0) {
        const priceText = `$${currentLivePrice.toFixed(4)}`;
        if (dataPriceValueEl) {
            dataPriceValueEl.textContent = priceText;
        }
        if (mobilePriceEl) {
            mobilePriceEl.textContent = priceText;
        }
        if (onPriceUpdate) {
            onPriceUpdate(currentLivePrice);
        }
    }
    
    logger.log('[LivePrice] Callback registered - price will be extracted from DATA_History stream');
}

export async function setupStreamrSubscription(operatorId, onMessageCallback) {
    const streamId = `${operatorId}/operator/coordination`;
    await unsubscribeFromCoordinationStream();
    
    const indicatorEl = document.getElementById('stream-status-indicator');
    if (!indicatorEl || !streamrClient) return { subscription: null, error: new Error("Client not ready") };

    indicatorEl.className = 'w-3 h-3 rounded-full bg-yellow-500 animate-pulse';
    indicatorEl.title = `Connecting to ${streamId}...`;
    try {
        coordinationSubscription = await streamrClient.subscribe(streamId, (message) => {
            indicatorEl.className = 'w-3 h-3 rounded-full bg-green-500';
            indicatorEl.title = `Subscribed, receiving data.`;
            onMessageCallback(message);
        });
        indicatorEl.className = 'w-3 h-3 rounded-full bg-gray-400';
        indicatorEl.title = `Subscribed to stream. Awaiting first message...`;
        return { subscription: coordinationSubscription, error: null };
    } catch (error) {
        console.error(`[Streamr] Error subscribing to ${streamId}:`, error);
        indicatorEl.className = 'w-3 h-3 rounded-full bg-red-500';
        indicatorEl.title = `Error subscribing to stream.`;
        return { subscription: null, error };
    }
}

export async function unsubscribeFromCoordinationStream() {
    if (coordinationSubscription) {
        try { await coordinationSubscription.unsubscribe(); } catch (e) { /* ignore */ }
        coordinationSubscription = null;
    }
}

export async function cleanupClient() {
    await unsubscribeFromCoordinationStream();
    livePriceCallback = null;
    currentLivePrice = null;
    if (historySubscription) {
        try { await historySubscription.unsubscribe(); } catch (e) { /* ignore */ }
        historySubscription = null;
    }
    if (streamrClient) {
        try { await streamrClient.destroy(); } catch (e) { /* ignore */ }
        streamrClient = null;
    }
}


