import {
    DATA_TOKEN_ADDRESS_POLYGON,
    STREAMR_CONFIG_ADDRESS,
    STREAMR_TREASURY_ADDRESS, 
    DATA_TOKEN_ABI,
    OPERATOR_CONTRACT_ABI,
    STREAMR_CONFIG_ABI,
    DATA_PRICE_STREAM_ID,
    POLYGON_RPC_URL,
    DELEGATORS_PER_PAGE,
    OPERATORS_PER_PAGE,
    MIN_SEARCH_LENGTH,
    MIN_ADDRESS_SEARCH_LENGTH,
    FULL_ADDRESS_LENGTH,
    POLYGONSCAN_NETWORK,
    POLYGONSCAN_METHOD_IDS,
    VOTE_ON_FLAG_RAW_AMOUNTS,
    getGraphUrl
} from './constants.js';
import { showToast, setModalState, txModalAmount, txModalBalanceValue, txModalMinimumValue, stakeModalAmount, stakeModalCurrentStake, stakeModalFreeFunds, dataPriceValueEl, transactionModal, stakeModal, operatorSettingsModal } from '../ui/ui.js';
import { getFriendlyErrorMessage, convertWeiToData, parseDateFromCsv, parseOperatorMetadata } from './utils.js';

let etherscanApiKey = localStorage.getItem('etherscan-api-key') || 'B8BXCXWR66RI1J2QYQRTT4SPHCC6VYYJHC';

let streamrClient = null;
let priceSubscription = null;
let coordinationSubscription = null;
let historicalDataPriceMap = null; 

// --- Centralized RPC Provider ---

let _readOnlyProvider = null;

/**
 * Get or create a singleton read-only JsonRpcProvider for Polygon.
 * This should be used for all read operations that don't require a signer.
 * @returns {ethers.providers.JsonRpcProvider}
 */
export function getReadOnlyProvider() {
    if (!_readOnlyProvider) {
        _readOnlyProvider = new ethers.providers.JsonRpcProvider(POLYGON_RPC_URL);
    }
    return _readOnlyProvider;
}

/**
 * Get the best available provider: signer's provider if available, otherwise read-only.
 * @param {ethers.Signer|null} signer - Optional signer with attached provider
 * @returns {ethers.providers.Provider}
 */
export function getProvider(signer = null) {
    return signer?.provider || getReadOnlyProvider();
}

// --- Gas Price Helper ---

// Gas price limits (in gwei)
const GAS_CONFIG = {
    MIN_GAS_PRICE: 35,           // Minimum gas price for Polygon
    MIN_PRIORITY_FEE: 30,        // Minimum priority fee
    MAX_GAS_PRICE: 500,          // Maximum gas price we'll accept (safety limit)
    WARNING_GAS_PRICE: 150,      // Show warning above this threshold
    DEFAULT_GAS_PRICE: 50,       // Fallback if we can't get fee data
    DEFAULT_PRIORITY_FEE: 30     // Fallback priority fee
};

/**
 * Get gas overrides for Polygon transactions
 * Polygon requires higher gas prices than the default ethers.js estimation
 * Includes safety limits to prevent excessive gas costs
 */
async function getGasOverrides(provider) {
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

// --- API Key Management ---
export function updateEtherscanApiKey(newKey) {
    etherscanApiKey = newKey || 'B8BXCXWR66RI1J2QYQRTT4SPHCC6VYYJHC';
    console.log("Etherscan API Key updated.");
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
                console.log(`[Worker] Processed ${e.data.count} price points in ${e.data.processingTime}ms`);
                resolve(priceMap);
            } else {
                reject(new Error(e.data.error));
            }
        };
        
        worker.onerror = function(error) {
            clearTimeout(timeoutId);
            console.warn('CSV Worker error, falling back to main thread:', error);
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
    
    console.log(`[Sync] Processed ${priceMap.size} price points`);
    return priceMap;
}

/**
 * Fetches and processes the historical DATA price from a local CSV file.
 * Uses Web Worker for non-blocking parsing when available.
 * Returns a Map where key is a UTC day timestamp (seconds) and value is the price.
 * @returns {Promise<Map<number, number>>}
 */
export async function fetchHistoricalDataPrice() {
    if (historicalDataPriceMap) {
        return historicalDataPriceMap;
    }

    try {
        const response = await fetch('/data/DATAHistoricalPrice.csv');
        if (!response.ok) {
            throw new Error(`Failed to fetch DATAHistoricalPrice.csv: ${response.statusText}`);
        }
        const csvText = await response.text();
        
        // Use Web Worker for parsing (non-blocking)
        historicalDataPriceMap = await parseCSVWithWorker(csvText);
        
        return historicalDataPriceMap;

    } catch (error) {
        console.error("Error fetching or processing historical price data:", error);
        showToast({ type: 'warning', title: 'Price Data Error', message: `Failed to load historical price data.`, duration: 6000 });
        return new Map(); 
    }
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
            stakes(first: 100) { amountWei sponsorship { id remainingWei spotAPY isRunning stream { id } } }
            delegations(where: {isSelfDelegation: false}, first: 15, orderBy: _valueDataWei, orderDirection: desc) { id _valueDataWei delegator { id } }
            queueEntries(orderBy: date, orderDirection: asc) { id amount delegator { id } date }
          }
          selfDelegation: delegations(where: {operator: "${sanitizedId}", isSelfDelegation: true}, first: 1) { _valueDataWei }
          stakingEvents(orderBy: date, orderDirection: desc, first: 800, where: {operator: "${sanitizedId}"}) {
            id
            amount
            date
            sponsorship { id stream { id } }
          }
          operatorDailyBuckets(first: 1000, orderBy: date, orderDirection: asc, where: {operator: "${sanitizedId}"}) {
            date
            valueWithoutEarnings
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

export async function fetchMoreDelegators(operatorId, skip) {
    if (!isValidEthereumAddress(operatorId)) {
        throw new Error('Invalid operator ID format.');
    }
    const sanitizedId = operatorId.toLowerCase();
    const query = `
        query GetMoreDelegators {
            operator(id: "${sanitizedId}") {
                delegations(where: {isSelfDelegation: false}, first: ${DELEGATORS_PER_PAGE}, skip: ${skip}, orderBy: _valueDataWei, orderDirection: desc) {
                    id _valueDataWei delegator { id }
                }
            }
        }`;
    const data = await runQuery(query);
    return data.operator.delegations;
}


// --- API (Polygonscan) ---

export async function fetchPolygonscanHistory(walletAddress) {
    if (!etherscanApiKey) {
        console.warn("Etherscan API Key not set. Skipping transaction history fetch.");
        return [];
    }

    const { apiUrl, chainId, nativeToken } = POLYGONSCAN_NETWORK;
    const page = 1;
    const offset = 500;
    const sort = "desc";
    
    // Add timestamp to prevent caching (cache busting via URL parameter)
    const cacheBuster = `&_t=${Date.now()}`;

    const txlistUrl = `${apiUrl}?chainid=${chainId}&module=account&action=txlist&address=${walletAddress}&page=${page}&offset=${offset}&sort=${sort}&apikey=${etherscanApiKey}${cacheBuster}`;
    const tokentxUrl = `${apiUrl}?chainid=${chainId}&module=account&action=tokentx&address=${walletAddress}&page=${page}&offset=${offset}&sort=${sort}&apikey=${etherscanApiKey}${cacheBuster}`;

    try {
        const [txlistRes, tokentxRes] = await Promise.all([
            fetch(txlistUrl, { cache: 'no-store' }), 
            fetch(tokentxUrl, { cache: 'no-store' })
        ]);

        if (!txlistRes.ok) throw new Error(`API request failed (txlist): HTTP ${txlistRes.status}`);
        if (!tokentxRes.ok) throw new Error(`API request failed (tokentx): HTTP ${tokentxRes.status}`);

        const txlistData = await txlistRes.json();
        const tokentxData = await tokentxRes.json();

        if (txlistData.status === "0") throw new Error(`API Error (txlist): ${txlistData.result}`);
        if (tokentxData.status === "0") throw new Error(`API Error (tokentx): ${tokentxData.result}`);

        const normalTxs = txlistData.result || [];
        const tokenTxs = tokentxData.result || [];

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
            let groupMethodId = baseMethodId; 

            if (groupMethodId === "-" && txGroup.length > 1) {
                const allDirections = txGroup.map(t => t.from.toLowerCase() === walletAddress.toLowerCase() ? "OUT" : "IN");
                const areAllIn = allDirections.every(d => d === "IN");

                if (areAllIn) {
                    groupMethodId = "Force Unstake";
                }
            }

            for (const tx of txGroup) {
                const direction = tx.from.toLowerCase() === walletAddress.toLowerCase() ? "OUT" : "IN";
                const decimals = parseInt(tx.tokenDecimal) || 18;
                const amount = parseFloat(tx.value) / Math.pow(10, decimals);
                
                let finalMethodId = groupMethodId;

                if (
                    direction === "OUT" &&
                    tx.tokenSymbol === "DATA" &&
                    tx.to.toLowerCase() === STREAMR_TREASURY_ADDRESS.toLowerCase()
                ) {
                    finalMethodId = "Protocol Tax";
                }
                else if (
                    finalMethodId === "-" && 
                    tx.tokenSymbol === "DATA" &&
                    VOTE_ON_FLAG_RAW_AMOUNTS.has(tx.value)
                ) {
                    finalMethodId = "Vote On Flag";
                }
                else if (
                    (baseMethodId === "Delegate" || baseMethodId === "Transfer") && 
                    direction === "IN"
                ) {
                    finalMethodId = "Delegate";
                }
                else if (
                    finalMethodId === "-" && 
                    direction === "IN" &&
                    tx.tokenSymbol === "DATA" &&
                    txGroup.length === 1 
                ) {
                    finalMethodId = "Delegate";
                }
                else if (baseMethodId === "Collect Earnings" && direction === "OUT") { 
                    if (tx.to.toLowerCase() === STREAMR_TREASURY_ADDRESS.toLowerCase()) {
                        finalMethodId = "Protocol Tax";
                    } else {
                        finalMethodId = "Undelegate"; 
                    }
                }
                else if (
                    (baseMethodId === "Unstake" || baseMethodId === "Force Unstake") && 
                    direction === "OUT"
                ) {
                    if (tx.to.toLowerCase() === STREAMR_TREASURY_ADDRESS.toLowerCase()) {
                        finalMethodId = "Protocol Tax";
                    } else {
                        finalMethodId = "Undelegate"; 
                    }
                }
            
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

        return filteredFinalTxs;

    } catch (error) {
        console.error("Error fetching Polygonscan history:", error);
        showToast({ type: 'error', title: 'API Error', message: 'Failed to fetch transaction history. Check your API key in Settings.', duration: 8000 });
        return [];
    }
}


// --- Blockchain Interactions (Ethers.js) ---

export async function getMaticBalance(address) {
    try {
        const provider = getReadOnlyProvider();
        const balanceWei = await provider.getBalance(address);
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
            balanceWei = await dataTokenContract.balanceOf(myRealAddress);
            try {
                const configContract = new ethers.Contract(STREAMR_CONFIG_ADDRESS, STREAMR_CONFIG_ABI, provider);
                const minWei = await configContract.minimumDelegationWei();
                txModalMinimumValue.textContent = `${parseFloat(ethers.utils.formatEther(minWei)).toFixed(0)} DATA`;
            } catch (e) {
                console.error("Failed to get minimum delegation", e);
                txModalMinimumValue.textContent = 'N/A';
            }
        } else {
            const operatorContract = new ethers.Contract(currentOperatorId, OPERATOR_CONTRACT_ABI, provider);
            balanceWei = await operatorContract.balanceInData(myRealAddress);
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
        
        const userBalanceWei = await dataTokenContract.balanceOf(myRealAddress);

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
        
        const [userBalanceDataWei, userBalanceTokensWei] = await Promise.all([
            operatorContract.balanceInData(myRealAddress),
            operatorContract.balanceOf(myRealAddress)
        ]);

        if (amountDataWei.gt(userBalanceDataWei)) {
            showToast({ type: 'warning', title: 'Insufficient Stake', message: 'You do not have enough staked DATA to undelegate.' });
            setModalState('tx-modal', 'input');
            return null;
        }

        let amountOperatorTokensWei;
        const fullWithdrawalThreshold = userBalanceDataWei.mul(9999).div(10000);
        
        if (amountDataWei.gte(fullWithdrawalThreshold)) {
            amountOperatorTokensWei = userBalanceTokensWei;
        } else {
            if (userBalanceDataWei.isZero()) {
                throw new Error("User has no DATA balance, cannot calculate conversion");
            }
            amountOperatorTokensWei = amountDataWei
                .mul(userBalanceTokensWei)
                .div(userBalanceDataWei);
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
        // Check gas price before proceeding
        if (!await checkGasPriceAndWarn(signer.provider)) {
            transactionModal.classList.add('hidden');
            return null;
        }
        
        setModalState('tx-modal', 'loading', { text: "Processing Queue...", subtext: "This will pay out queued undelegations." });
        const operatorContract = new ethers.Contract(operatorId, OPERATOR_CONTRACT_ABI, signer);
        const gasOverrides = await getGasOverrides(signer.provider);
        const tx = await operatorContract.payOutQueue(0, gasOverrides);
        setModalState('tx-modal', 'loading', { text: 'Processing Transaction...', subtext: 'Waiting for confirmation.' });
        const receipt = await tx.wait();
        setModalState('tx-modal', 'success', { txHash: receipt.transactionHash });
        return receipt.transactionHash;
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
        // Check gas price before proceeding
        if (!await checkGasPriceAndWarn(signer.provider)) {
            stakeModal.classList.add('hidden');
            return null;
        }
        
        setModalState('stake-modal', 'loading', { text: "Preparing transaction...", subtext: "Please wait." });
        const operatorContract = new ethers.Contract(operatorId, OPERATOR_CONTRACT_ABI, signer);
        const targetAmountWei = ethers.utils.parseEther(targetAmount);
        const currentAmountWei = ethers.BigNumber.from(currentStakeWei);
        const gasOverrides = await getGasOverrides(signer.provider);
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
    } catch(e) {
        console.error("Stake edit failed:", e);
        setModalState('stake-modal', 'error', { message: getFriendlyErrorMessage(e) });
        return null;
    }
}

export async function handleCollectEarnings(signer, operatorId, sponsorshipId) {
    setModalState('tx-modal', 'loading', { text: "Checking gas prices...", subtext: "Please wait." });
    try {
        // Check gas price before proceeding
        if (!await checkGasPriceAndWarn(signer.provider)) {
            transactionModal.classList.add('hidden');
            return null;
        }
        
        setModalState('tx-modal', 'loading', { text: "Collecting Earnings...", subtext: "Please wait." });
        const operatorContract = new ethers.Contract(operatorId, OPERATOR_CONTRACT_ABI, signer);
        const gasOverrides = await getGasOverrides(signer.provider);
        const tx = await operatorContract.withdrawEarningsFromSponsorships([sponsorshipId], gasOverrides);
        setModalState('tx-modal', 'loading', { text: 'Processing Transaction...', subtext: 'Waiting for confirmation.' });
        const receipt = await tx.wait();
        setModalState('tx-modal', 'success', { txHash: receipt.transactionHash });
        return receipt.transactionHash;
    } catch (e) {
        console.error("Earnings collection failed:", e);
        setModalState('tx-modal', 'error', { message: getFriendlyErrorMessage(e) });
        return null;
    }
}

export async function handleCollectAllEarnings(signer, operatorId, currentOperatorData) {
    setModalState('tx-modal', 'loading', { text: "Checking gas prices...", subtext: "Please wait." });
    try {
        // Check gas price before proceeding
        if (!await checkGasPriceAndWarn(signer.provider)) {
            transactionModal.classList.add('hidden');
            return null;
        }
        
        setModalState('tx-modal', 'loading', { text: "Collecting All Earnings...", subtext: "This will collect from all sponsorships." });
        const operatorContract = new ethers.Contract(operatorId, OPERATOR_CONTRACT_ABI, signer);
        const gasOverrides = await getGasOverrides(signer.provider);
        const allSponsorshipIds = currentOperatorData.stakes.map(stake => stake.sponsorship.id);
        const tx = await operatorContract.withdrawEarningsFromSponsorships(allSponsorshipIds, gasOverrides);
        setModalState('tx-modal', 'loading', { text: 'Processing Transaction...', subtext: 'Waiting for confirmation.' });
        const receipt = await tx.wait();
        setModalState('tx-modal', 'success', { txHash: receipt.transactionHash });
        return receipt.transactionHash;
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
        const myStakeWei = await operatorContract.balanceInData(myRealAddress);
        return myStakeWei.toString();
    } catch (e) {
        console.error("Failed to get user's stake:", e);
        return '0';
    }
}

export async function updateOperatorMetadata(signer, operatorId, newMetadataJson) {
    try {
        const operatorContract = new ethers.Contract(operatorId, OPERATOR_CONTRACT_ABI, signer);
        const gasOverrides = await getGasOverrides(signer.provider);
        const tx = await operatorContract.updateMetadata(newMetadataJson, gasOverrides);
        const receipt = await tx.wait();
        return receipt.transactionHash;
    } catch (e) {
        console.error("Metadata update failed:", e);
        setModalState('operator-settings-modal', 'error', { message: getFriendlyErrorMessage(e) });
        return null;
    }
}

export async function updateOperatorCut(signer, operatorId, newCutPercent) {
    try {
        const percent = parseFloat(newCutPercent);
        if (isNaN(percent) || percent < 0 || percent > 100) {
            throw new Error("Invalid percentage value. Must be between 0 and 100.");
        }
        
        const cutWei = ethers.utils.parseEther((percent / 100).toString());
        
        const operatorContract = new ethers.Contract(operatorId, OPERATOR_CONTRACT_ABI, signer);
        const gasOverrides = await getGasOverrides(signer.provider);
        const tx = await operatorContract.updateOperatorsCutFraction(cutWei, gasOverrides);
        const receipt = await tx.wait();
        return receipt.transactionHash;
    } catch (e) {
        console.error("Operator cut update failed:", e);
        setModalState('operator-settings-modal', 'error', { message: getFriendlyErrorMessage(e) });
        return null;
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
    dataPriceValueEl.textContent = 'Subscribing...';
    const mobilePriceEl = document.getElementById('mobile-data-price');
    if (mobilePriceEl) mobilePriceEl.textContent = '...';
    
    try {
        if (priceSubscription) await priceSubscription.unsubscribe();
        priceSubscription = await streamrClient.subscribe(DATA_PRICE_STREAM_ID, (message) => {
            if (message && message.bestBid !== undefined) {
                const price = parseFloat(message.bestBid);
                const priceText = `$${price.toFixed(4)}`;
                dataPriceValueEl.textContent = priceText;
                if (mobilePriceEl) mobilePriceEl.textContent = priceText;
                onPriceUpdate(price);
            }
        });
        console.log(`Subscribed to DATA price stream: ${DATA_PRICE_STREAM_ID}`);
    } catch (error) {
        console.error("Error setting up DATA price stream:", error);
        dataPriceValueEl.textContent = 'Stream Error';
        if (mobilePriceEl) mobilePriceEl.textContent = 'Error';
    }
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
    if (priceSubscription) {
        try { await priceSubscription.unsubscribe(); } catch (e) { /* ignore */ }
        priceSubscription = null;
    }
    if (streamrClient) {
        try { await streamrClient.destroy(); } catch (e) { /* ignore */ }
        streamrClient = null;
    }
}

