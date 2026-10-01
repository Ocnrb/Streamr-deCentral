// Polygon RPC: the read-only provider with fallbacks, gas settings, retries and the wallet's network
import { POLYGON_RPC_URL, POLYGON_RPC_FALLBACKS } from './constants.js';
import { showToast } from '../ui/ui.js';
import { ethers } from 'ethers';

// --- Centralized RPC Provider ---

// Errors of the RPC endpoint itself (down, overloaded, rate limited, unauthorized, timed out): another
// endpoint may answer. Answers of the chain (revert, nonce, funds...) are the same everywhere: never retried.
const CHAIN_ANSWER = /revert|insufficient funds|nonce|underpriced|already known|known transaction|intrinsic gas|gas required exceeds|exceeds block gas limit|invalid sender|invalid opcode/i;
const ENDPOINT_TROUBLE = /rate limit|too many requests|limit exceeded|timeout|timed out|failed to fetch|missing response|bad response|could not detect network|unavailable|capacity|unauthorized|forbidden|api key|upstream|gateway|node error|internal error|header not found|missing trie node|no response/i;
const ENDPOINT_ERROR_CODES = [-32005, -32090, -32603, -32701, -32001, -32002];

/** The node's own error message, without the request dump ethers adds */
function rpcErrorMessage(error) {
    if (typeof error?.body === 'string') {
        try {
            return JSON.parse(error.body)?.error?.message || error.body;
        } catch (e) {
            return error.body;
        }
    }
    return error?.error?.message || error?.message || '';
}

/** true when the error comes from the RPC endpoint (another endpoint may answer), not from the chain */
export function isRpcEndpointError(error) {
    const message = rpcErrorMessage(error);
    if (CHAIN_ANSWER.test(message)) return false;
    if (['SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR'].includes(error?.code)) return true;
    if (ENDPOINT_ERROR_CODES.includes(error?.code)) return true;
    return ENDPOINT_TROUBLE.test(message);
}

const RPC_TIMEOUT_MS = 15 * 1000;       // a hanging endpoint moves on instead of waiting ethers' 2 minutes
const RPC_COOLDOWN_MS = 60 * 1000;      // a failed endpoint is skipped for a while when picking the next one

/**
 * JSON-RPC provider over several endpoints: each request goes to the current endpoint and moves on to
 * the next one when the endpoint fails (HTTP 5xx, rate limit, timeout...). The working endpoint is
 * remembered across page loads.
 */
export class FailoverRpcProvider extends ethers.providers.StaticJsonRpcProvider {
    constructor(urls, network, storageKey = null) {
        let start = 0;
        try {
            const stored = storageKey ? parseInt(localStorage.getItem(storageKey), 10) : NaN;
            if (stored >= 0 && stored < urls.length) start = stored;
        } catch (e) { /* storage blocked */ }
        super({ url: urls[start], timeout: RPC_TIMEOUT_MS, throttleLimit: 1 }, network);
        this._failover = {
            urls,
            index: start,
            storageKey,
            coolUntil: urls.map(() => 0),
            endpoints: urls.map(url => new ethers.providers.StaticJsonRpcProvider({ url, timeout: RPC_TIMEOUT_MS, throttleLimit: 1 }, network))
        };
    }

    get currentUrl() {
        return this._failover.urls[this._failover.index];
    }

    /** Moves from the given endpoint to the next one not cooling down */
    switchEndpoint(from = this._failover.index, reason = '') {
        const f = this._failover;
        if (f.index !== from) return;   // a concurrent request already moved on
        f.coolUntil[from] = Date.now() + RPC_COOLDOWN_MS;
        let next = (from + 1) % f.urls.length;
        for (let i = 1; i <= f.urls.length; i++) {
            const candidate = (from + i) % f.urls.length;
            if (f.coolUntil[candidate] <= Date.now()) { next = candidate; break; }
        }
        f.index = next;
        console.log(`[RPC] ${f.urls[from]} failed${reason ? ` (${reason})` : ''}, switching to ${f.urls[next]}`);
        try {
            if (f.storageKey) localStorage.setItem(f.storageKey, String(next));
        } catch (e) { /* storage blocked */ }
    }

    async send(method, params) {
        const f = this._failover;
        let lastError = null;
        for (let attempt = 0; attempt < f.urls.length; attempt++) {
            const index = f.index;
            try {
                return await f.endpoints[index].send(method, params);
            } catch (e) {
                lastError = e;
                // The same signed transaction sent again on another endpoint: it is already out
                if (method === 'eth_sendRawTransaction' && /already known|known transaction/i.test(rpcErrorMessage(e))) {
                    return ethers.utils.keccak256(params[0]);
                }
                if (!isRpcEndpointError(e)) throw e;
                this.switchEndpoint(index, String(e?.status || e?.code || 'error'));
            }
        }
        throw lastError;
    }
}

const RPC_INDEX_STORAGE_KEY = 'polygon_rpc_index';
let _readOnlyProvider = null;

/**
 * Get or create the singleton read-only provider for Polygon (all RPC endpoints with failover).
 * This should be used for all read operations that don't require a signer.
 * @returns {FailoverRpcProvider}
 */
export function getReadOnlyProvider() {
    if (!_readOnlyProvider) {
        _readOnlyProvider = new FailoverRpcProvider(POLYGON_RPC_FALLBACKS.length ? POLYGON_RPC_FALLBACKS : [POLYGON_RPC_URL], 137, RPC_INDEX_STORAGE_KEY);
        console.log(`[RPC] Initialized with: ${_readOnlyProvider.currentUrl}`);
    }
    return _readOnlyProvider;
}

/**
 * Move to the next RPC endpoint (e.g. when rate limited). The provider stays the same object.
 * @returns {FailoverRpcProvider}
 */
export function switchToFallbackRpc() {
    const provider = getReadOnlyProvider();
    provider.switchEndpoint(undefined, 'rate limited');
    return provider;
}

/**
 * Get current RPC URL being used
 * @returns {string} Current RPC URL
 */
export function getCurrentRpcUrl() {
    return getReadOnlyProvider().currentUrl;
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
export async function checkGasPriceAndWarn(provider) {
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

export async function readWithFallback(readFn, maxRetries = 3) {
    let lastError = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await readFn();
        } catch (e) {
            lastError = e;
            
            if ((isRateLimitError(e) || isRpcEndpointError(e)) && attempt < maxRetries - 1) {
                console.log(`[RPC] Read failed on the RPC, switching to fallback (attempt ${attempt + 1}/${maxRetries})...`);
                
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
