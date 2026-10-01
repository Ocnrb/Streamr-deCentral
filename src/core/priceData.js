// DATA prices: the history (Streamr stream, CSV as fallback) and the live price taken from it
import { DATA_HISTORY_STREAM_ID } from './constants.js';
import { showToast, dataPriceValueEl } from '../ui/ui.js';
import { parseDateFromCsv, logger } from './utils.js';
import { getStreamrClient } from './streamrClient.js';

let historySubscription = null;
let historicalDataPriceMap = null;
let historicalEurRateMap = null;

// Callbacks for notifying when historical data is loaded
let historicalDataCallbacks = [];

// Callback for live price updates (extracted from DATA_History stream)
let livePriceCallback = null;
let currentLivePrice = null; 

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
    
    const streamrClient = getStreamrClient();
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

/** Stops the price updates and the DATA history subscription (before the Streamr client is destroyed) */
export async function stopPriceStreams() {
    livePriceCallback = null;
    currentLivePrice = null;
    if (historySubscription) {
        try { await historySubscription.unsubscribe(); } catch (e) { /* ignore */ }
        historySubscription = null;
    }
}
