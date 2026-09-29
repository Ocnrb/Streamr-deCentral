/**
 * Bridge: DATA between Ethereum and Polygon over the official Polygon PoS bridge (Polygon's contracts only)
 * - Ethereum -> Polygon (deposit): DATA.approve(ERC20Predicate, amount), then
 *   RootChainManager.depositFor(user, DATA, amount). The DATA shows up on Polygon once the state sync of
 *   the deposit reaches Polygon (StateReceiver.lastStateId >= the id emitted by the deposit).
 * - Polygon -> Ethereum (withdraw): DATA.withdraw(amount) burns on Polygon. Once a checkpoint that covers
 *   the burn block reaches Ethereum (RootChain.getLastChildBlock), RootChainManager.exit(proof) releases the
 *   DATA on Ethereum. The proof comes from Polygon's public proof generator; the contract checks it against
 *   the checkpoint, so a bad proof can only fail, never redirect funds.
 * Transfers are kept per wallet in localStorage and recovered from the explorer history.
 */

import * as Utils from '../core/utils.js';
import * as UI from '../ui/ui.js';
import * as Services from '../core/services.js';
import { DATA_TOKEN_ADDRESS_POLYGON, POLYGONSCAN_NETWORK, getEtherscanApiKey } from '../core/constants.js';

const { logger } = Utils;

// ============================================
// Constants
// ============================================

const ETH_CHAIN_ID = 1;
const POLYGON_CHAIN_ID = 137;
const ETH_DATA = '0x8f693ca8D21b157107184d29D398A8D082b38b76';
const POLYGON_DATA = DATA_TOKEN_ADDRESS_POLYGON;
// Polygon PoS bridge
const ROOT_CHAIN_MANAGER = '0xA0c68C638235ee32657e8f720a23ceC1bFc77C77';
const ERC20_PREDICATE = '0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf';
const ROOT_CHAIN = '0x86E4Dc95c7FBdBf52e33D563BbDB00823894C287';
const STATE_SENDER = '0x28e4F3a7f651294B9564800b2D01f35189A5bFbE';
const STATE_RECEIVER = '0x0000000000000000000000000000000000001001';

const ETHEREUM_RPCS = [
    'https://ethereum-rpc.publicnode.com',
    'https://eth.drpc.org',
    'https://1rpc.io/eth'
];
const PROOF_API = 'https://proof-generator.polygon.technology/api/v1/matic/exit-payload/';
const TRANSFER_TOPIC = ethers.utils.id('Transfer(address,address,uint256)');
const STATE_SYNCED_TOPIC = ethers.utils.id('StateSynced(uint256,address,bytes)');
const STATE_COMMITTED_TOPIC = ethers.utils.id('StateCommitted(uint256,bool)');   // emitted on Polygon when a deposit lands
const DAY_MS = 24 * 60 * 60 * 1000;

const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)'
];
const CHILD_DATA_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function withdraw(uint256 amount)'
];
const ROOT_CHAIN_MANAGER_ABI = [
    'function depositFor(address user, address rootToken, bytes depositData)',
    'function exit(bytes inputData)'
];
const ROOT_CHAIN_ABI = [
    'function getLastChildBlock() view returns (uint256)',
    'function headerBlocks(uint256) view returns (bytes32 root, uint256 start, uint256 end, uint256 createdAt, address proposer)'
];
const STATE_RECEIVER_ABI = ['function lastStateId() view returns (uint256)'];

const DEPOSIT_GAS_FALLBACK = 180000;   // depositFor can't be estimated before the approval
const EXIT_GAS_ESTIMATE = 400000;      // typical RootChainManager.exit of an ERC-20
const POLL_INTERVAL_MS = 30 * 1000;
const RECEIPT_POLL_MS = 6 * 1000;       // Ethereum receipt polling while a transaction of this page is mined
const LOST_TX_AFTER_MS = 10 * 60 * 1000; // a claim transaction the RPC does not know after this long left the mempool
const HISTORY_LIMIT = 10;              // explorer transfers recovered per direction
const STORED_LIMIT = 50;
const AMOUNT_REGEX = /^\d+(\.\d{1,18})?$/;

const CHAINS = {
    [ETH_CHAIN_ID]: {
        name: 'Ethereum',
        gasSymbol: 'ETH',
        explorer: 'https://etherscan.io/tx/',
        icon: '<svg class="w-5 h-5 flex-shrink-0" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#627EEA"/><path fill="#fff" fill-opacity=".6" d="M16.5 4v8.87l7.5 3.35z"/><path fill="#fff" d="M16.5 4 9 16.22l7.5-3.35z"/><path fill="#fff" fill-opacity=".6" d="M16.5 21.97V28L24 17.62z"/><path fill="#fff" d="M16.5 28v-6.03L9 17.62z"/><path fill="#fff" fill-opacity=".2" d="m16.5 20.57 7.5-4.35-7.5-3.35z"/><path fill="#fff" fill-opacity=".6" d="m9 16.22 7.5 4.35v-7.7z"/></svg>'
    },
    [POLYGON_CHAIN_ID]: {
        name: 'Polygon',
        gasSymbol: 'POL',
        explorer: 'https://polygonscan.com/tx/',
        icon: '<svg class="w-5 h-5 flex-shrink-0" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#8247E5"/><path fill="#fff" d="M21.1 13.1a1.3 1.3 0 0 0-1.3 0l-2.9 1.7-2 1.1-2.9 1.7a1.3 1.3 0 0 1-1.3 0l-2.3-1.3a1.3 1.3 0 0 1-.6-1.1v-2.6c0-.4.2-.9.6-1.1l2.2-1.3a1.3 1.3 0 0 1 1.3 0l2.2 1.3c.4.2.6.7.6 1.1v1.7l2-1.2v-1.7c0-.4-.2-.9-.6-1.1l-4.2-2.4a1.3 1.3 0 0 0-1.3 0l-4.3 2.5c-.4.2-.6.6-.6 1v4.9c0 .4.2.9.6 1.1l4.3 2.4c.4.2.9.2 1.3 0l2.9-1.6 2-1.2 2.9-1.6a1.3 1.3 0 0 1 1.3 0l2.2 1.3c.4.2.6.7.6 1.1v2.6c0 .4-.2.9-.6 1.1l-2.2 1.3a1.3 1.3 0 0 1-1.3 0l-2.2-1.3a1.3 1.3 0 0 1-.6-1.1v-1.7l-2 1.2v1.7c0 .4.2.9.6 1.1l4.3 2.4c.4.2.9.2 1.3 0l4.3-2.4c.4-.2.6-.7.6-1.1v-4.9c0-.4-.2-.9-.6-1.1z"/></svg>'
    }
};

// ============================================
// State
// ============================================

const state = {
    active: false,
    direction: 'deposit',    // 'deposit' (Ethereum -> Polygon) | 'withdraw' (Polygon -> Ethereum)
    address: null,           // connected wallet (lowercase)
    balances: { ethData: null, polygonData: null, eth: null, pol: null },
    transfers: [],
    flow: null,
    submitting: false,
    claiming: new Set(),     // burn tx hashes with a claim in progress
    claimChecked: new Set(), // burn tx hashes already checked for a past claim this session
    timeChecked: new Set(),  // burn tx hashes whose checkpoint time was looked up this session
    estimateSeq: 0,
    estimatedCost: null,     // { wei, symbol }
    pollTimer: null,
    listenersSetup: false
};

const $ = (id) => document.getElementById(id);
const debouncedEstimate = Utils.debounce(() => updateEstimate(), 400);

// ============================================
// Helpers
// ============================================

const fromChain = () => state.direction === 'deposit' ? ETH_CHAIN_ID : POLYGON_CHAIN_ID;
const toChain = () => state.direction === 'deposit' ? POLYGON_CHAIN_ID : ETH_CHAIN_ID;

function formatData(wei, decimals = 2) {
    const value = parseFloat(ethers.utils.formatEther(wei));
    if (value > 0 && value < 0.01) return '< 0.01';
    return Utils.formatBigNumber(Number(value.toFixed(decimals)));
}

function formatGas(wei) {
    const value = parseFloat(ethers.utils.formatEther(wei));
    if (value === 0) return '0';
    if (value < 0.0001) return '< 0.0001';
    return value.toFixed(4);
}

function parseAmount(value) {
    return AMOUNT_REGEX.test(value) ? ethers.utils.parseEther(value) : null;
}

function timeAgo(ms) {
    const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatTxError(error) {
    if (error?.code === 4001 || error?.code === 'ACTION_REJECTED') return 'Rejected in your wallet.';
    const text = `${error?.reason || ''} ${error?.error?.message || ''} ${error?.data?.message || ''} ${error?.message || ''}`;
    if (text.toLowerCase().includes('insufficient funds')) return 'Not enough ETH / POL to pay for gas.';
    if (/EXIT_ALREADY_PROCESSED/.test(text)) return 'This withdrawal was already claimed.';
    if (Services.isRateLimitError(error)) return 'RPC rate limited. Please try again in a few seconds.';
    return Utils.getFriendlyErrorMessage(error);
}

function setStatus(elementId, text, tone) {
    const el = $(elementId);
    if (!el) return;
    const tones = { ok: 'text-green-400', warn: 'text-yellow-400', error: 'text-red-400', info: 'text-gray-400' };
    el.classList.remove('hidden', ...Object.values(tones));
    if (!text) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
    }
    el.classList.add(tones[tone] || tones.info);
    el.textContent = text;
}

// ============================================
// Providers and wallet
// ============================================

let ethProvider = null;

/** Ethereum RPCs with failover (Services.FailoverRpcProvider) */
function getEthProvider() {
    if (!ethProvider) ethProvider = new Services.FailoverRpcProvider(ETHEREUM_RPCS, ETH_CHAIN_ID, 'ethereum_rpc_index');
    return ethProvider;
}

/** Ethereum read (the provider moves to the next RPC on its own when one fails) */
async function ethRead(readFn) {
    return readFn(getEthProvider());
}

const polygonRead = (readFn) => Services.readWithFallback(() => readFn(Services.getReadOnlyProvider()));

const usesPrivateKey = () => Boolean(window.appSigner?.privateKey);

async function walletChainId() {
    return parseInt(await window.ethereum.request({ method: 'eth_chainId' }), 16);
}

// The app reloads on a network change (main.js) unless appNetworkSwitchInProgress is set.
// It is cleared once the wallet is back on Polygon.
let restoringPolygon = false;
let restoreTimer = null;

function onWalletChainChanged(chainIdHex) {
    if (restoringPolygon && parseInt(chainIdHex, 16) === POLYGON_CHAIN_ID) finishRestore();
}

function finishRestore() {
    restoringPolygon = false;
    clearTimeout(restoreTimer);
    window.appNetworkSwitchInProgress = false;
}

async function switchWalletChain(chainId) {
    if (await walletChainId() === chainId) return;
    window.appNetworkSwitchInProgress = true;
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${chainId.toString(16)}` }] });
    if (await walletChainId() !== chainId) throw new Error(`Switch your wallet to ${CHAINS[chainId].name} to continue.`);
}

/** Back to Polygon after Ethereum transactions (the rest of the app runs on Polygon) */
async function restorePolygon() {
    if (usesPrivateKey() || !window.ethereum || !window.appNetworkSwitchInProgress) return;
    try {
        if (await walletChainId() === POLYGON_CHAIN_ID) {
            finishRestore();
            return;
        }
        restoringPolygon = true;
        // The chainChanged event clears the flag; the timer covers a wallet that sends none
        restoreTimer = setTimeout(finishRestore, 5000);
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x89' }] });
    } catch (e) {
        finishRestore();
        UI.showToast({ type: 'warning', title: 'Switch back to Polygon', message: 'The rest of deCentral runs on Polygon: switch your wallet back to Polygon.', duration: 0 });
    }
}

async function checkWalletAccount(signer) {
    if ((await signer.getAddress()).toLowerCase() !== state.address) {
        throw new Error('The wallet account changed. Reload the page.');
    }
}

// Ethereum transactions of this page go out one at a time (claims and the transfer form alike).
// With a private key the nonce is also kept here: two claims asking the RPC at once got the same
// nonce, and only one of the two transactions could ever be mined.
let ethQueue = Promise.resolve();
let ethQueued = 0;
let nextEthNonce = null;   // { address, nonce, at } after the last transaction sent from this page
const LOCAL_NONCE_MS = 60 * 1000;   // the RPC's pending count lags seconds, not minutes: a dropped transaction leaves no gap

function inEthQueue(task) {
    ethQueued++;
    const run = ethQueue.then(task).finally(() => { ethQueued--; });
    ethQueue = run.catch(() => {});
    return run;
}

/** Sends one Ethereum transaction: send(signer, overrides) returns the transaction response */
function sendEthTx(send) {
    return inEthQueue(async () => {
        const signer = await getEthereumSigner();
        const overrides = {};
        if (usesPrivateKey()) {
            const pending = await ethRead(p => p.getTransactionCount(state.address, 'pending'));
            const recent = nextEthNonce?.address === state.address && Date.now() - nextEthNonce.at < LOCAL_NONCE_MS;
            overrides.nonce = recent ? Math.max(pending, nextEthNonce.nonce) : pending;
        }
        const tx = await send(signer, overrides);
        if (usesPrivateKey()) nextEthNonce = { address: state.address, nonce: tx.nonce + 1, at: Date.now() };
        return tx;
    });
}

/** Back to Polygon once no other Ethereum transaction of this page waits for the wallet */
function restoreWhenIdle() {
    return inEthQueue(() => (ethQueued > 1 ? null : restorePolygon()));
}

/** Receipt of an Ethereum transaction; null when its nonce went to another transaction (replaced or dropped) */
async function waitForEthReceipt(hash, nonce) {
    for (;;) {
        const receipt = await ethRead(p => p.getTransactionReceipt(hash)).catch(() => null);
        if (receipt) return receipt;
        if (Number.isInteger(nonce)) {
            const mined = await ethRead(p => p.getTransactionCount(state.address, 'latest')).catch(() => null);
            // The nonce may have moved with this very transaction: one more receipt read decides
            if (mined !== null && mined > nonce) return ethRead(p => p.getTransactionReceipt(hash)).catch(() => null);
        }
        await new Promise(resolve => setTimeout(resolve, RECEIPT_POLL_MS));
    }
}

/** true when a claim transaction will never be mined: its nonce was used by another one, or it left the mempool */
async function isClaimTxLost(t) {
    if (!t.claimTxHash) return true;
    const tx = await ethRead(p => p.getTransaction(t.claimTxHash)).catch(() => undefined);
    if (tx === undefined) return false;   // RPC failure: decide on the next check
    const nonce = Number.isInteger(t.claimNonce) ? t.claimNonce : tx?.nonce;
    if (!Number.isInteger(nonce)) return !tx && Date.now() - (t.claimSentAt || 0) > LOST_TX_AFTER_MS;
    const mined = await ethRead(p => p.getTransactionCount(state.address, 'latest'));
    if (mined <= nonce) return false;
    return !(await ethRead(p => p.getTransactionReceipt(t.claimTxHash)));
}

async function getEthereumSigner() {
    if (usesPrivateKey()) return new ethers.Wallet(window.appSigner.privateKey, getEthProvider());
    if (!window.ethereum) throw new Error('Wallet not found.');
    await switchWalletChain(ETH_CHAIN_ID);
    const signer = new ethers.providers.Web3Provider(window.ethereum, 'any').getSigner();
    await checkWalletAccount(signer);
    return signer;
}

async function ensurePolygonWallet() {
    if (usesPrivateKey() || !window.ethereum) return;
    if (await walletChainId() !== POLYGON_CHAIN_ID) {
        await switchWalletChain(POLYGON_CHAIN_ID);
        finishRestore();
    }
}

// ============================================
// Transfers (localStorage + explorer history)
// ============================================

const storageKey = () => `bridgeTransfers:${state.address}`;

function loadStoredTransfers() {
    try {
        const list = JSON.parse(localStorage.getItem(storageKey()) || '[]');
        return Array.isArray(list) ? list.filter(t => t && /^0x[0-9a-fA-F]{64}$/.test(t.txHash)) : [];
    } catch (e) {
        return [];
    }
}

function saveTransfers() {
    try {
        localStorage.setItem(storageKey(), JSON.stringify(state.transfers.slice(0, STORED_LIMIT)));
    } catch (e) {
        // Storage full or blocked: the explorer history still recovers the transfers
    }
}

function upsertTransfer(transfer) {
    const hash = transfer.txHash.toLowerCase();
    const existing = state.transfers.find(t => t.txHash.toLowerCase() === hash);
    if (existing) Object.assign(existing, transfer);
    else state.transfers.push(transfer);
    state.transfers.sort((a, b) => b.createdAt - a.createdAt);
    saveTransfers();
    renderTransfers();
}

async function fetchTokenTransfers(chainId, contract) {
    const url = `${POLYGONSCAN_NETWORK.apiUrl}?chainid=${chainId}&module=account&action=tokentx&contractaddress=${contract}`
        + `&address=${state.address}&page=1&offset=100&sort=desc&apikey=${getEtherscanApiKey()}`;
    const response = await fetch(url);
    const json = await response.json();
    return Array.isArray(json?.result) ? json.result : [];
}

/** Deposits (DATA sent to the ERC20 predicate) and withdrawals (DATA burned on Polygon) of this wallet */
async function recoverFromExplorer() {
    const [ethTransfers, polygonTransfers] = await Promise.all([
        fetchTokenTransfers(ETH_CHAIN_ID, ETH_DATA).catch(e => { logger.warn('Bridge: Ethereum history failed', e); return []; }),
        fetchTokenTransfers(POLYGON_CHAIN_ID, POLYGON_DATA).catch(e => { logger.warn('Bridge: Polygon history failed', e); return []; })
    ]);
    const known = new Set(state.transfers.map(t => t.txHash.toLowerCase()));
    const deposits = ethTransfers
        .filter(tx => tx.from?.toLowerCase() === state.address && tx.to?.toLowerCase() === ERC20_PREDICATE.toLowerCase())
        .slice(0, HISTORY_LIMIT)
        .map(tx => ({ kind: 'deposit', txHash: tx.hash, amountWei: tx.value, createdAt: Number(tx.timeStamp) * 1000, status: 'bridging' }));
    const withdrawals = polygonTransfers
        .filter(tx => tx.from?.toLowerCase() === state.address && tx.to === ethers.constants.AddressZero)
        .slice(0, HISTORY_LIMIT)
        .map(tx => ({ kind: 'withdraw', txHash: tx.hash, amountWei: tx.value, createdAt: Number(tx.timeStamp) * 1000, block: Number(tx.blockNumber), status: 'checkpoint' }));
    let added = false;
    for (const transfer of [...deposits, ...withdrawals]) {
        if (known.has(transfer.txHash.toLowerCase())) continue;
        state.transfers.push(transfer);
        added = true;
    }
    // Arrival of deposits: the DATA minted on Polygon (same amount, first one after the deposit)
    const mints = polygonTransfers
        .filter(tx => tx.from === ethers.constants.AddressZero && tx.to?.toLowerCase() === state.address)
        .map(tx => ({ value: tx.value, at: Number(tx.timeStamp) * 1000 }));
    // Any other DATA received on Polygon (fallback when the deposit does not show as a mint)
    const incoming = polygonTransfers
        .filter(tx => tx.from !== ethers.constants.AddressZero && tx.to?.toLowerCase() === state.address)
        .map(tx => ({ value: tx.value, at: Number(tx.timeStamp) * 1000 }));
    // Claims of withdrawals: the DATA released on Ethereum by the ERC20 predicate
    const exits = ethTransfers
        .filter(tx => tx.from?.toLowerCase() === ERC20_PREDICATE.toLowerCase() && tx.to?.toLowerCase() === state.address)
        .map(tx => ({ value: tx.value, at: Number(tx.timeStamp) * 1000 }));
    state.explorerEvents = { mints, incoming, exits };
    const timed = applyExplorerTimes();
    if (added || timed) {
        state.transfers.sort((a, b) => b.createdAt - a.createdAt);
        saveTransfers();
    }
}

/** Exact arrival (Polygon mint) and claim (Ethereum release) times from the last explorer read */
function applyExplorerTimes() {
    const { mints = [], incoming = [], exits = [] } = state.explorerEvents || {};
    const arrived = (t, at) => { t.arrivedAt = at; t.arrivedExact = true; };
    const openDeposits = () => state.transfers.filter(t => t.kind === 'deposit' && t.status !== 'failed' && !t.arrivedExact);
    return matchTimes(openDeposits(), mints, arrived)
        + matchTimes(openDeposits(), incoming, arrived, DAY_MS)
        + matchTimes(state.transfers.filter(t => t.kind === 'withdraw' && t.status === 'claimed' && !t.claimedAt), exits, (t, at) => { t.claimedAt = at; });
}

/**
 * Arrival of deposits the explorer transfers could not date: the StateCommitted event of the deposit's
 * state sync id on Polygon (a few per refresh, once per session each)
 */
async function fillArrivalTimes() {
    const pending = state.transfers
        .filter(t => t.kind === 'deposit' && t.status === 'done' && !t.arrivedExact && !state.timeChecked.has(t.txHash))
        .slice(0, 5);
    let changed = false;
    for (const t of pending) {
        state.timeChecked.add(t.txHash);
        try {
            if (!t.stateId) {
                const receipt = await ethRead(p => p.getTransactionReceipt(t.txHash));
                t.stateId = receipt ? stateIdFromReceipt(receipt) : null;
            }
            if (!t.stateId) continue;
            const url = `${POLYGONSCAN_NETWORK.apiUrl}?chainid=${POLYGON_CHAIN_ID}&module=logs&action=getLogs&address=${STATE_RECEIVER}`
                + `&topic0=${STATE_COMMITTED_TOPIC}&topic0_1_opr=and&topic1=${ethers.utils.hexZeroPad(ethers.BigNumber.from(t.stateId).toHexString(), 32)}`
                + `&fromBlock=0&toBlock=latest&apikey=${getEtherscanApiKey()}`;
            const json = await fetch(url).then(r => r.json());
            const log = Array.isArray(json?.result) ? json.result[0] : null;
            if (log?.timeStamp) {
                t.arrivedAt = parseInt(log.timeStamp, 16) * 1000;
                t.arrivedExact = true;
                changed = true;
            }
        } catch (e) {
            logger.warn(`Bridge: arrival time not found for ${t.txHash}`, e);
        }
    }
    if (changed) {
        saveTransfers();
        renderTransfers();
    }
}

/** Pairs transfers with later events of the same amount (within maxDelayMs), oldest first, each event used once */
function matchTimes(transfers, events, apply, maxDelayMs = Infinity) {
    const pool = [...events].sort((a, b) => a.at - b.at);
    let count = 0;
    for (const t of [...transfers].sort((a, b) => a.createdAt - b.createdAt)) {
        const i = pool.findIndex(e => e.value === String(t.amountWei) && e.at >= t.createdAt - 60000 && e.at - t.createdAt <= maxDelayMs);
        if (i === -1) continue;
        apply(t, pool[i].at);
        pool.splice(i, 1);
        count++;
    }
    return count;
}

/** When the checkpoint that covers a burn reached Ethereum: its header number is the first field of the exit proof */
async function checkpointTime(payload) {
    const fields = ethers.utils.RLP.decode(payload);
    const headerNumber = ethers.BigNumber.from(fields[0]);
    const header = await ethRead(p => new ethers.Contract(ROOT_CHAIN, ROOT_CHAIN_ABI, p).headerBlocks(headerNumber));
    return header.createdAt.gt(0) ? header.createdAt.toNumber() * 1000 : null;
}

/** Checkpoint times of withdrawals past the checkpoint (a few per refresh, once per session each) */
async function fillCheckpointTimes() {
    const pending = state.transfers
        .filter(t => t.kind === 'withdraw' && ['ready', 'claiming', 'claimed'].includes(t.status) && !t.checkpointAt && !state.timeChecked.has(t.txHash))
        .slice(0, 5);
    let changed = false;
    for (const t of pending) {
        state.timeChecked.add(t.txHash);
        try {
            const at = await checkpointTime(await fetchExitPayload(t.txHash));
            if (at) { t.checkpointAt = at; changed = true; }
        } catch (e) {
            logger.warn(`Bridge: checkpoint time not found for ${t.txHash}`, e);
        }
    }
    if (changed) {
        saveTransfers();
        renderTransfers();
    }
}

async function fetchExitPayload(burnTxHash) {
    const response = await fetch(`${PROOF_API}${burnTxHash}?eventSignature=${TRANSFER_TOPIC}`);
    const json = await response.json().catch(() => null);
    if (!response.ok || typeof json?.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(json.result)) {
        throw new Error(json?.message || json?.error || `The withdrawal proof is not available yet (HTTP ${response.status}).`);
    }
    return json.result;
}

/** true when the withdrawal was already claimed (the exit would revert with EXIT_ALREADY_PROCESSED) */
async function isAlreadyClaimed(payload) {
    try {
        await ethRead(p => new ethers.Contract(ROOT_CHAIN_MANAGER, ROOT_CHAIN_MANAGER_ABI, p).estimateGas.exit(payload, { from: state.address }));
        return false;
    } catch (e) {
        const text = `${e?.reason || ''} ${e?.error?.message || ''} ${e?.message || ''} ${JSON.stringify(e?.error || {})}`;
        return /EXIT_ALREADY_PROCESSED/.test(text);
    }
}

function stateIdFromReceipt(receipt) {
    const log = receipt.logs.find(l => l.address.toLowerCase() === STATE_SENDER.toLowerCase() && l.topics[0] === STATE_SYNCED_TOPIC);
    return log ? ethers.BigNumber.from(log.topics[1]).toString() : null;
}

/** Moves each unfinished transfer forward by reading both chains */
async function refreshStatuses() {
    const open = state.transfers.filter(t => !['done', 'claimed', 'failed'].includes(t.status));
    if (!open.length) return;
    let lastStateId = null;
    let lastChildBlock = null;
    let changed = false;

    for (const t of open) {
        try {
            if (t.kind === 'deposit') {
                if (!t.stateId) {
                    const receipt = await ethRead(p => p.getTransactionReceipt(t.txHash));
                    if (!receipt) continue;
                    if (receipt.status === 0) { t.status = 'failed'; changed = true; continue; }
                    t.stateId = stateIdFromReceipt(receipt);
                    t.status = 'bridging';
                    changed = true;
                }
                if (!t.stateId) continue;
                if (lastStateId === null) {
                    lastStateId = await polygonRead(p => new ethers.Contract(STATE_RECEIVER, STATE_RECEIVER_ABI, p).lastStateId()).catch(() => undefined);
                }
                if (lastStateId && lastStateId.gte(t.stateId)) {
                    t.status = 'done';
                    // Seen arriving from this page: replaced by the exact mint time from the explorer
                    if (!t.arrivedAt && t.local) t.arrivedAt = Date.now();
                    changed = true;
                }
            } else {
                if (t.status === 'claiming') {
                    if (state.claiming.has(t.txHash)) continue;   // followed by claim()
                    const receipt = t.claimTxHash ? await ethRead(p => p.getTransactionReceipt(t.claimTxHash)) : null;
                    if (receipt) {
                        t.status = receipt.status === 1 ? 'claimed' : 'ready';
                        changed = true;
                    } else if (await isClaimTxLost(t)) {
                        await settleLostClaim(t);
                        changed = true;
                    }
                    continue;
                }
                if (!t.block) {
                    const receipt = await polygonRead(p => p.getTransactionReceipt(t.txHash));
                    if (!receipt) continue;
                    if (receipt.status === 0) { t.status = 'failed'; changed = true; continue; }
                    t.block = receipt.blockNumber;
                    t.status = 'checkpoint';
                    changed = true;
                }
                if (t.status === 'checkpoint') {
                    if (lastChildBlock === null) {
                        lastChildBlock = await ethRead(p => new ethers.Contract(ROOT_CHAIN, ROOT_CHAIN_ABI, p).getLastChildBlock());
                    }
                    if (lastChildBlock.gte(t.block)) { t.status = 'ready'; changed = true; }
                }
                // A recovered withdrawal may already be claimed (e.g. from another app): check once per session
                if (t.status === 'ready' && !state.claimChecked.has(t.txHash) && !state.claiming.has(t.txHash)) {
                    state.claimChecked.add(t.txHash);
                    const payload = await fetchExitPayload(t.txHash);
                    if (await isAlreadyClaimed(payload)) { t.status = 'claimed'; changed = true; }
                }
            }
        } catch (e) {
            logger.warn(`Bridge: status check failed for ${t.txHash}`, e);
        }
    }
    if (changed) {
        saveTransfers();
        renderTransfers();
        loadBalances();
    }
}

// ============================================
// Rendering
// ============================================

const STATUS_BADGES = {
    pending: ['Confirming', 'bg-gray-500/15 text-gray-300'],
    bridging: ['On its way', 'bg-blue-500/15 text-blue-300'],
    done: ['Arrived', 'bg-green-500/15 text-green-400'],
    checkpoint: ['Waiting for checkpoint', 'bg-yellow-500/15 text-yellow-300'],
    ready: ['Ready to claim', 'bg-blue-500/15 text-blue-300'],
    claiming: ['Claiming', 'bg-blue-500/15 text-blue-300'],
    claimed: ['Claimed', 'bg-green-500/15 text-green-400'],
    failed: ['Failed', 'bg-red-500/15 text-red-400']
};

const DATA_ICON = '<svg class="w-4 h-4 flex-shrink-0" viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="28" fill="#F7600A"/><path fill-rule="evenodd" clip-rule="evenodd" d="M32.9091 10.2118V9.08164C32.9091 8.69418 32.5861 8.38241 32.199 8.4008C24.6009 8.76169 18.5119 14.8843 18.2056 22.4955C18.2219 22.9725 18.608 23.0974 18.8351 23.0974H19.983C20.3463 23.0974 20.6441 22.8122 20.6629 22.4495C20.989 16.1879 26.0134 11.1697 32.278 10.8522C32.7558 10.7908 32.9091 10.5297 32.9091 10.2118ZM22.5761 23.0974H23.6747C24.0313 23.0974 24.3221 22.8195 24.348 22.4638C24.6586 18.2097 28.0701 14.8164 32.3324 14.5336C32.523 14.521 32.9091 14.3783 32.9091 13.8844V12.7659C32.9091 12.3707 32.5739 12.0603 32.1795 12.0861C26.6654 12.4459 22.256 16.8547 21.8961 22.3679C21.8704 22.7623 22.1808 23.0974 22.5761 23.0974ZM37.1763 32.9026C37.4035 32.9026 37.7895 33.0275 37.8058 33.5045C37.4995 41.1158 31.4105 47.2383 23.8124 47.5993C23.4253 47.6176 23.1023 47.3059 23.1023 46.9183V45.7883C23.1023 45.4704 23.2556 45.2093 23.7333 45.1479C29.9981 44.8304 35.0224 39.8121 35.3485 33.5505C35.3673 33.1878 35.6651 32.9026 36.0284 32.9026H37.1763ZM33.4353 32.9026C33.8306 32.9026 34.141 33.2377 34.1153 33.6321C33.7554 39.1454 29.346 43.5542 23.8319 43.914C23.4375 43.9398 23.1023 43.6293 23.1023 43.2341V42.1155C23.1023 41.6217 23.4884 41.4791 23.679 41.4664C27.9413 41.1837 31.3529 37.7903 31.6633 33.5362C31.6893 33.1805 31.9801 32.9026 32.3367 32.9026H33.4353ZM29.7445 32.9026C30.1445 32.9026 30.463 33.246 30.4231 33.6441C30.0758 37.1151 27.3154 39.8751 23.8438 40.2224C23.4458 40.2623 23.1023 39.9438 23.1023 39.5438V38.4201C23.1023 37.9604 23.5015 37.795 23.6961 37.7715C25.9261 37.5025 27.6953 35.7373 27.9703 33.5095C28.0129 33.1647 28.2999 32.9026 28.6474 32.9026H29.7445ZM10.212 23.0945C10.53 23.0945 10.7911 23.2477 10.8525 23.7254C11.1701 29.9892 16.189 35.0129 22.4516 35.3389C22.8143 35.3577 23.0996 35.6555 23.0996 36.0187V37.1666C23.0996 37.3936 22.9746 37.7796 22.4976 37.7959C14.8853 37.4896 8.76181 31.4015 8.4008 23.8045C8.3824 23.4174 8.69423 23.0945 9.0818 23.0945H10.212ZM13.8853 23.0945C14.3792 23.0945 14.5219 23.4805 14.5346 23.6711C14.8173 27.9328 18.2111 31.3439 22.4659 31.6543C22.8216 31.6803 23.0996 31.971 23.0996 32.3276V33.426C23.0996 33.8212 22.7644 34.1316 22.3699 34.1059C16.8559 33.746 12.4464 29.3373 12.0866 23.824C12.0608 23.4296 12.3713 23.0945 12.7666 23.0945H13.8853ZM33.5024 18.1729C41.1148 18.4792 47.2382 24.5673 47.5993 32.1644C47.6176 32.5514 47.3058 32.8744 46.9183 32.8744H45.788C45.4701 32.8744 45.2089 32.7211 45.1475 32.2434C44.8299 25.9795 39.811 20.956 33.5485 20.6299C33.1857 20.6111 32.9005 20.3133 32.9005 19.9501V18.8023C32.9005 18.5752 33.0253 18.1892 33.5024 18.1729ZM33.6301 21.8629C39.1442 22.2227 43.5536 26.6315 43.9135 32.1448C43.9392 32.5392 43.6288 32.8744 43.2335 32.8744H42.1148C41.6208 32.8744 41.4782 32.4883 41.4655 32.2977C41.1828 28.036 37.7889 24.6249 33.5342 24.3145C33.1784 24.2886 32.9005 23.9978 32.9005 23.6412V22.5428C32.9005 22.1476 33.2357 21.8372 33.6301 21.8629ZM33.642 25.5545C37.1136 25.9019 39.874 28.6619 40.2213 32.1329C40.2612 32.5309 39.9427 32.8744 39.5427 32.8744H38.4188C37.959 32.8744 37.7936 32.4752 37.7701 32.2806C37.501 30.0509 35.7356 28.282 33.5075 28.0071C33.1626 27.9645 32.9005 27.6775 32.9005 27.33V26.2331C32.9005 25.8331 33.244 25.5147 33.642 25.5545ZM17.5812 23.0945C18.0411 23.0945 18.2064 23.4936 18.2299 23.6882C18.4991 25.9179 20.2644 27.6868 22.4926 27.9618C22.8374 28.0043 23.0996 28.2913 23.0996 28.6388V29.7357C23.0996 30.1357 22.7561 30.4541 22.358 30.4144C18.8865 30.0669 16.1261 27.3069 15.7786 23.8359C15.7388 23.4379 16.0573 23.0945 16.4574 23.0945H17.5812ZM32.9091 16.4562V17.5798C32.9091 18.0396 32.51 18.205 32.3152 18.2285C30.0853 18.4976 28.3161 20.2627 28.0411 22.4905C27.9985 22.8353 27.7115 23.0974 27.364 23.0974H26.2669C25.8669 23.0974 25.5484 22.7539 25.5882 22.3559C25.9357 18.885 28.6961 16.125 32.1675 15.7776C32.5656 15.7378 32.9091 16.0562 32.9091 16.4562Z" fill="white"/></svg>';

/** Chip with a logo and a label (token or network) */
function chip(icon, label) {
    return `<span class="inline-flex items-center gap-1.5 pl-1 pr-2 py-0.5 rounded-full bg-[#2C2C2C] text-xs font-semibold text-gray-200 whitespace-nowrap">${icon.replace(/w-5 h-5|w-6 h-6/, 'w-4 h-4')}${label}</span>`;
}

function formatDateTime(ms) {
    const date = new Date(ms);
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleString(undefined, { ...(sameYear ? {} : { year: 'numeric' }), month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function shortHash(hash) {
    return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

function formatDuration(ms) {
    if (!Number.isFinite(ms)) return '';
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return '< 1 min';
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
    return `${Math.floor(hours / 24)} d${hours % 24 ? ` ${hours % 24} h` : ''}`;
}

/** How long each stage took (or has been running), for the status tooltip */
function timeLines(t) {
    const line = (label, value, approx = false) => `${label} ${approx && !value.startsWith('<') ? '~' : ''}${value}`;
    const since = formatDuration(Date.now() - t.createdAt);
    if (t.status === 'failed') return [];
    if (t.kind === 'deposit') {
        if (t.status === 'done') return t.arrivedAt ? [line('Arrived in', formatDuration(t.arrivedAt - t.createdAt), !t.arrivedExact)] : [];
        return [line('In progress for', since)];
    }
    if (t.status === 'pending' || t.status === 'checkpoint') return [line('Waiting for', since)];
    const lines = t.checkpointAt ? [line('Checkpoint in', formatDuration(t.checkpointAt - t.createdAt))] : [];
    if (t.claimedAt) lines.push(line('Claimed after', formatDuration(t.claimedAt - t.createdAt)));
    else if (t.status === 'ready' && t.checkpointAt) lines.push(line('Claimable for', formatDuration(Date.now() - t.checkpointAt)));
    return lines;
}

function transferHtml(t) {
    const [label, badgeClass] = STATUS_BADGES[t.status] || STATUS_BADGES.pending;
    const deposit = t.kind === 'deposit';
    const from = CHAINS[deposit ? ETH_CHAIN_ID : POLYGON_CHAIN_ID];
    const to = CHAINS[deposit ? POLYGON_CHAIN_ID : ETH_CHAIN_ID];
    const claimBusy = state.claiming.has(t.txHash);
    const hash = Utils.escapeHtml(t.txHash);
    const txRow = (chainId, txHash, name) => `<div class="whitespace-nowrap"><span class="text-gray-500">${name}</span> <a href="${CHAINS[chainId].explorer}${Utils.escapeHtml(txHash)}" target="_blank" rel="noopener noreferrer" class="font-mono text-blue-400 hover:text-blue-300">${shortHash(Utils.escapeHtml(txHash))} ↗</a></div>`;
    const links = [txRow(deposit ? ETH_CHAIN_ID : POLYGON_CHAIN_ID, t.txHash, deposit ? 'Deposit' : 'Burn')];
    if (t.claimTxHash) links.push(txRow(ETH_CHAIN_ID, t.claimTxHash, 'Claim'));
    const hint = t.status === 'checkpoint' ? 'Claimable once a Polygon checkpoint includes it'
        : t.status === 'bridging' ? 'Shows up on Polygon once Polygon picks it up'
        : '';
    // Withdrawals always show the Claim button: disabled with a spinner until the checkpoint reaches Ethereum
    const spinner = '<span class="w-3 h-3 border-2 border-white rounded-full border-t-transparent animate-spin"></span>';
    const claiming = claimBusy || t.status === 'claiming';
    const waiting = t.status === 'pending' || t.status === 'checkpoint';
    // Wrapped: a disabled button gets no pointer events, the tooltip sits on the wrapper
    const claimButton = !deposit && (claiming || waiting || t.status === 'ready') ? `
        <span class="inline-flex" data-tooltip-content="${waiting ? 'Available once a Polygon checkpoint includes the burn' : claiming ? 'Waiting for the claim transaction' : 'Claim the DATA on Ethereum (needs ETH for gas)'}">
        <button type="button" data-claim="${hash}" ${claiming || waiting ? 'disabled' : ''}
            class="ml-auto bg-blue-800 hover:bg-blue-900 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition-colors inline-flex items-center gap-2 whitespace-nowrap disabled:opacity-50 disabled:pointer-events-none disabled:hover:bg-blue-800">
            ${claiming ? `${spinner}Claiming...` : waiting ? `${spinner}Claim` : 'Claim'}
        </button></span>` : '';
    // Status tooltip: what the status means, then how long each stage took
    const tooltip = [hint, ...timeLines(t)].filter(Boolean).map(text => Utils.escapeHtml(text)).join('<br>');
    const action = deposit
        ? '<span class="px-2 py-0.5 rounded-md text-[11px] font-semibold whitespace-nowrap bg-blue-500/15 text-blue-300">Deposit</span>'
        : '<span class="px-2 py-0.5 rounded-md text-[11px] font-semibold whitespace-nowrap bg-violet-500/15 text-violet-300">Withdraw</span>';
    return `
        <tr class="border-b border-[#2a2a2a] last:border-0 align-middle">
            <td class="py-3 pr-3 whitespace-nowrap"><div class="text-gray-200">${formatDateTime(t.createdAt)}</div>${Date.now() - t.createdAt < 86400000 ? `<div class="text-xs text-gray-500">${timeAgo(t.createdAt)}</div>` : ''}</td>
            <td class="py-3 pr-3">${action}</td>
            <td class="py-3 pr-3"><span class="inline-flex items-center gap-2 whitespace-nowrap"><span class="text-white font-medium">${formatData(t.amountWei)}</span>${chip(DATA_ICON, 'DATA')}</span></td>
            <td class="py-3 pr-3"><span class="inline-flex items-center gap-1.5 whitespace-nowrap">${chip(from.icon, from.name)}<span class="text-gray-500">→</span>${chip(to.icon, to.name)}</span></td>
            <td class="py-3 pr-3"><span class="px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${badgeClass} ${tooltip ? 'cursor-help' : ''}" ${tooltip ? `data-tooltip-content="${tooltip}"` : ''}>${label}</span></td>
            <td class="py-3 pr-3 text-xs space-y-0.5">${links.join('')}</td>
            <td class="py-3 text-right">${claimButton}</td>
        </tr>`;
}

function renderTransfers() {
    const body = $('bridge-transfers');
    if (!body) return;
    const empty = (text) => `<tr><td colspan="7" class="py-4 text-sm text-gray-400">${text}</td></tr>`;
    if (!state.address) {
        body.innerHTML = empty('Connect a wallet to see your transfers.');
        return;
    }
    body.innerHTML = state.transfers.length ? state.transfers.map(transferHtml).join('') : empty('No bridge transfers yet.');
}

function renderDirection() {
    const from = CHAINS[fromChain()];
    const to = CHAINS[toChain()];
    $('bridge-from-chain').innerHTML = `${from.icon}<span>${from.name}</span>`;
    $('bridge-to-chain').innerHTML = `${to.icon}<span>${to.name}</span>`;
    $('bridge-route-note').textContent = state.direction === 'deposit'
        ? 'Approve and deposit on Ethereum (ETH for gas). The DATA then shows up in the same wallet on Polygon.'
        : 'Burn on Polygon now, then claim on Ethereum (ETH for gas) once a Polygon checkpoint includes the burn: the Claim button shows up under Your transfers.';
    $('bridge-gas-label').textContent = state.direction === 'deposit' ? 'Your ETH balance' : 'Your POL / ETH balance';
    renderBalances();
    renderSubmit();
}

function renderBalances() {
    const b = state.balances;
    const dataFrom = state.direction === 'deposit' ? b.ethData : b.polygonData;
    const dataTo = state.direction === 'deposit' ? b.polygonData : b.ethData;
    $('bridge-from-balance').textContent = dataFrom ? `${formatData(dataFrom)} DATA` : state.address ? '...' : '--';
    $('bridge-to-balance').textContent = dataTo ? `${formatData(dataTo)} DATA` : state.address ? '...' : '--';
    const gas = state.direction === 'deposit'
        ? (b.eth ? `${formatGas(b.eth)} ETH` : '--')
        : `${b.pol ? `${formatGas(b.pol)} POL` : '--'} / ${b.eth ? `${formatGas(b.eth)} ETH` : '--'}`;
    $('bridge-gas-balance').textContent = state.address ? gas : '--';
}

function readAmount() {
    const raw = $('bridge-amount').value.trim();
    const wei = parseAmount(raw);
    const balance = state.direction === 'deposit' ? state.balances.ethData : state.balances.polygonData;
    let error = null;
    if (raw && !wei) error = 'Enter a valid amount.';
    else if (wei && wei.isZero()) error = 'Enter an amount above 0.';
    else if (wei && balance && wei.gt(balance)) error = 'Not enough DATA on this network.';
    return { raw, wei, error };
}

function renderSubmit() {
    const btn = $('bridge-submit');
    if (!btn || state.submitting) return;
    if (state.flow?.finished) {
        setSubmitState('New transfer', false);
        return;
    }
    if (state.flow) return;
    const { wei, error } = readAmount();
    setSubmitState(!state.address ? 'Connect a wallet to bridge' : state.direction === 'deposit' ? 'Bridge to Polygon' : 'Withdraw to Ethereum', false);
    btn.disabled = !state.address || !wei || Boolean(error);
    $('bridge-receive').textContent = wei && !error ? formatData(wei, 4) : '0';
}

function setSubmitState(label, busy) {
    const btn = $('bridge-submit');
    if (!btn) return;
    btn.disabled = busy;
    btn.innerHTML = busy
        ? `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent animate-spin"></div><span>${Utils.escapeHtml(label)}</span>`
        : Utils.escapeHtml(label);
}

function setFormLocked(locked) {
    ['bridge-amount', 'bridge-max', 'bridge-flip'].forEach(id => { const el = $(id); if (el) el.disabled = locked; });
}

function renderProgress() {
    const container = $('bridge-progress');
    const list = $('bridge-progress-list');
    if (!container || !list || !state.flow) return;
    container.classList.remove('hidden');
    // The steps replace the explanation while a transfer runs (keeps the panel within the screen)
    $('bridge-route-note')?.classList.add('hidden');
    const icons = {
        pending: '<span class="w-4 h-4 rounded-full border-2 border-[#555] flex-shrink-0"></span>',
        active: '<span class="w-4 h-4 border-2 border-blue-400 rounded-full border-t-transparent animate-spin flex-shrink-0"></span>',
        done: '<svg class="w-4 h-4 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg>',
        error: '<svg class="w-4 h-4 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"/></svg>'
    };
    const textClass = { pending: 'text-gray-400', active: 'text-white', done: 'text-gray-300', error: 'text-red-400' };
    list.innerHTML = state.flow.steps.map(step => `
        <li class="flex items-center gap-2">
            ${icons[step.status]}
            <span class="${textClass[step.status]}">${Utils.escapeHtml(step.label)}</span>
            ${step.txHash ? `<a href="${CHAINS[step.chainId].explorer}${Utils.escapeHtml(step.txHash)}" target="_blank" rel="noopener noreferrer" class="ml-auto text-xs text-blue-400 hover:text-blue-300">tx</a>` : ''}
        </li>
    `).join('');
}

function showError(message) {
    const el = $('bridge-error');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
}

function showSuccess(message) {
    const el = $('bridge-success');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
}

// ============================================
// Balances and estimate
// ============================================

async function loadBalances() {
    if (!state.address) return;
    const address = state.address;
    const results = await Promise.allSettled([
        ethRead(p => new ethers.Contract(ETH_DATA, ERC20_ABI, p).balanceOf(address)),
        polygonRead(p => new ethers.Contract(POLYGON_DATA, CHILD_DATA_ABI, p).balanceOf(address)),
        ethRead(p => p.getBalance(address)),
        polygonRead(p => p.getBalance(address))
    ]);
    if (address !== state.address) return;
    const [ethData, polygonData, eth, pol] = results.map(r => r.status === 'fulfilled' ? r.value : null);
    state.balances = { ethData, polygonData, eth, pol };
    renderBalances();
    renderSubmit();
    updateAmountStatus();
}

function updateAmountStatus() {
    const { error } = readAmount();
    setStatus('bridge-amount-status', error || '', 'error');
}

async function updateEstimate() {
    const seq = ++state.estimateSeq;
    const costEl = $('bridge-cost');
    const noteEl = $('bridge-cost-note');
    if (!costEl || state.flow) return;
    const { wei, error } = readAmount();
    if (!state.address || !wei || error) {
        costEl.textContent = '--';
        noteEl.textContent = state.address ? '' : 'Connect a wallet (MetaMask or private key) to bridge.';
        state.estimatedCost = null;
        return;
    }
    costEl.textContent = 'Estimating...';
    noteEl.textContent = '';
    try {
        if (state.direction === 'deposit') {
            const [allowance, gasPrice] = await Promise.all([
                ethRead(p => new ethers.Contract(ETH_DATA, ERC20_ABI, p).allowance(state.address, ERC20_PREDICATE)),
                ethRead(p => p.getGasPrice())
            ]);
            const needsApproval = allowance.lt(wei);
            const depositData = ethers.utils.defaultAbiCoder.encode(['uint256'], [wei]);
            const [approveGas, depositGas] = await Promise.all([
                needsApproval ? ethRead(p => new ethers.Contract(ETH_DATA, ERC20_ABI, p).estimateGas.approve(ERC20_PREDICATE, wei, { from: state.address })) : ethers.constants.Zero,
                needsApproval
                    ? ethers.BigNumber.from(DEPOSIT_GAS_FALLBACK)
                    : ethRead(p => new ethers.Contract(ROOT_CHAIN_MANAGER, ROOT_CHAIN_MANAGER_ABI, p).estimateGas.depositFor(state.address, ETH_DATA, depositData, { from: state.address }))
            ]);
            if (seq !== state.estimateSeq) return;
            const cost = approveGas.add(depositGas).mul(gasPrice);
            state.estimatedCost = { wei: cost, symbol: 'ETH' };
            costEl.textContent = `≈ ${formatGas(cost)} ETH`;
            const gwei = parseFloat(ethers.utils.formatUnits(gasPrice, 'gwei')).toFixed(1);
            noteEl.textContent = `${needsApproval ? '2 transactions' : '1 transaction (already approved)'} on Ethereum at ~${gwei} gwei.`;
            const short = state.balances.eth && state.balances.eth.lt(cost);
            if (short) noteEl.textContent += ' Not enough ETH for gas.';
        } else {
            const [burnGas, polGasPrice, ethGasPrice] = await Promise.all([
                polygonRead(p => new ethers.Contract(POLYGON_DATA, CHILD_DATA_ABI, p).estimateGas.withdraw(wei, { from: state.address })),
                polygonRead(p => p.getGasPrice()),
                ethRead(p => p.getGasPrice())
            ]);
            if (seq !== state.estimateSeq) return;
            const burnCost = burnGas.mul(polGasPrice);
            const claimCost = ethers.BigNumber.from(EXIT_GAS_ESTIMATE).mul(ethGasPrice);
            state.estimatedCost = { wei: burnCost, symbol: 'POL' };
            costEl.textContent = `≈ ${formatGas(burnCost)} POL + ${formatGas(claimCost)} ETH`;
            noteEl.textContent = 'The ETH part is the later claim, at the gas price of that moment.';
        }
    } catch (e) {
        if (seq !== state.estimateSeq) return;
        logger.warn('Bridge estimate failed:', e);
        costEl.textContent = '--';
        state.estimatedCost = null;
        noteEl.textContent = `Could not estimate: ${formatTxError(e)}`;
    }
}

// ============================================
// Transfer flows
// ============================================

async function runStep(step, flow) {
    const address = state.address;
    if (step.key === 'approve') {
        const tx = await sendEthTx((signer, overrides) => new ethers.Contract(ETH_DATA, ERC20_ABI, signer).approve(ERC20_PREDICATE, flow.amountWei, overrides));
        step.txHash = tx.hash;
        renderProgress();
        const receipt = await waitForEthReceipt(tx.hash, tx.nonce);
        if (!receipt) throw new Error('The approval was replaced or dropped. Try again.');
        if (receipt.status !== 1) throw new Error('The approval failed on-chain.');
    } else if (step.key === 'deposit') {
        const depositData = ethers.utils.defaultAbiCoder.encode(['uint256'], [flow.amountWei]);
        const tx = await sendEthTx((signer, overrides) => new ethers.Contract(ROOT_CHAIN_MANAGER, ROOT_CHAIN_MANAGER_ABI, signer).depositFor(address, ETH_DATA, depositData, overrides));
        step.txHash = tx.hash;
        flow.sent = true;
        upsertTransfer({ kind: 'deposit', txHash: tx.hash, amountWei: flow.amountWei.toString(), createdAt: Date.now(), status: 'pending', local: true });
        renderProgress();
        const receipt = await waitForEthReceipt(tx.hash, tx.nonce);
        if (!receipt || receipt.status !== 1) {
            upsertTransfer({ txHash: tx.hash, status: 'failed' });
            throw new Error(receipt ? 'The deposit failed on-chain.' : 'The deposit was replaced or dropped. Check your wallet before trying again.');
        }
        upsertTransfer({ txHash: tx.hash, status: 'bridging', stateId: stateIdFromReceipt(receipt) });
    } else if (step.key === 'burn') {
        await ensurePolygonWallet();
        const tx = await Services.executeWithFallback(async (currentSigner) => {
            const overrides = await Services.getGasOverrides(currentSigner.provider);
            return new ethers.Contract(POLYGON_DATA, CHILD_DATA_ABI, currentSigner).withdraw(flow.amountWei, overrides);
        }, window.appSigner);
        step.txHash = tx.hash;
        flow.sent = true;
        upsertTransfer({ kind: 'withdraw', txHash: tx.hash, amountWei: flow.amountWei.toString(), createdAt: Date.now(), status: 'pending', local: true });
        renderProgress();
        const receipt = await tx.wait();
        upsertTransfer({ txHash: tx.hash, status: 'checkpoint', block: receipt.blockNumber });
    }
}

async function handleSubmit() {
    if (state.submitting || !state.address) return;
    if (state.flow?.finished) {
        resetFlow();
        return;
    }
    showError('');
    showSuccess('');

    if (!state.flow) {
        const { wei, error } = readAmount();
        if (!wei || error) return;
        const amount = `${formatData(wei, 4)} DATA`;
        let steps;
        if (state.direction === 'deposit') {
            let needsApproval = true;
            try {
                const allowance = await ethRead(p => new ethers.Contract(ETH_DATA, ERC20_ABI, p).allowance(state.address, ERC20_PREDICATE));
                needsApproval = allowance.lt(wei);
            } catch (e) {
                logger.warn('Bridge: allowance check failed, approving anyway', e);
            }
            steps = [
                ...(needsApproval ? [{ key: 'approve', label: `Approve ${amount} for the bridge`, chainId: ETH_CHAIN_ID }] : []),
                { key: 'deposit', label: `Deposit ${amount} on Ethereum`, chainId: ETH_CHAIN_ID }
            ];
        } else {
            steps = [{ key: 'burn', label: `Burn ${amount} on Polygon`, chainId: POLYGON_CHAIN_ID }];
        }
        state.flow = {
            direction: state.direction,
            amountWei: wei,
            sent: false,
            steps: steps.map(step => ({ ...step, status: 'pending', txHash: null }))
        };
    }

    const flow = state.flow;
    state.submitting = true;
    setFormLocked(true);
    renderProgress();
    try {
        for (const step of flow.steps) {
            if (step.status === 'done') continue;
            step.status = 'active';
            renderProgress();
            setSubmitState('Confirm in wallet...', true);
            await runStep(step, flow);
            step.status = 'done';
            renderProgress();
        }
        flow.finished = true;
        state.submitting = false;
        await restoreWhenIdle();
        showSuccess(flow.direction === 'deposit'
            ? 'Deposit sent. The DATA shows up on Polygon once Polygon picks it up: follow it under Your transfers.'
            : 'DATA burned on Polygon. Claim it on Ethereum under Your transfers once the checkpoint reaches Ethereum.');
        setSubmitState('New transfer', false);
        UI.showToast({
            type: 'success',
            title: flow.direction === 'deposit' ? 'Deposit Sent' : 'Withdrawal Started',
            message: flow.direction === 'deposit' ? 'DATA is on its way to Polygon.' : 'Claim it on Ethereum once it is checkpointed.',
            duration: 8000
        });
        loadBalances();
        schedulePoll();
    } catch (e) {
        logger.error('Bridge flow failed:', e);
        const failed = flow.steps.find(s => s.status === 'active');
        if (failed) failed.status = 'error';
        renderProgress();
        state.submitting = false;
        await restoreWhenIdle();
        showError(formatTxError(e));
        // A transaction is never sent twice: Retry continues from the step that failed
        const anyDone = flow.steps.some(s => s.status === 'done') || flow.sent;
        if (anyDone) {
            setSubmitState('Retry', false);
        } else {
            state.flow = null;
            $('bridge-progress')?.classList.add('hidden');
            $('bridge-route-note')?.classList.remove('hidden');
            setFormLocked(false);
            renderSubmit();
        }
    }
}

function resetFlow() {
    state.flow = null;
    state.submitting = false;
    $('bridge-amount').value = '';
    $('bridge-progress')?.classList.add('hidden');
    $('bridge-route-note')?.classList.remove('hidden');
    showError('');
    showSuccess('');
    setFormLocked(false);
    renderSubmit();
    updateAmountStatus();
    updateEstimate();
}

/** A claim transaction that will never be mined: claimed anyway (another transaction did it) or ready to claim again */
async function settleLostClaim(t) {
    const payload = await fetchExitPayload(t.txHash);
    if (await isAlreadyClaimed(payload)) {
        Object.assign(t, { status: 'claimed' });
    } else {
        Object.assign(t, { status: 'ready', claimTxHash: null, claimNonce: null, claimSentAt: null });
    }
    saveTransfers();
    renderTransfers();
}

async function claim(burnTxHash) {
    const t = state.transfers.find(x => x.txHash === burnTxHash);
    if (!t || state.claiming.has(burnTxHash) || !state.address) return;
    state.claiming.add(burnTxHash);
    renderTransfers();
    try {
        const payload = await fetchExitPayload(burnTxHash);
        const tx = await sendEthTx((signer, overrides) => new ethers.Contract(ROOT_CHAIN_MANAGER, ROOT_CHAIN_MANAGER_ABI, signer).exit(payload, overrides));
        upsertTransfer({ txHash: burnTxHash, status: 'claiming', claimTxHash: tx.hash, claimNonce: tx.nonce, claimSentAt: Date.now() });
        restoreWhenIdle();
        const receipt = await waitForEthReceipt(tx.hash, tx.nonce);
        if (!receipt) {
            await settleLostClaim(t);
            if (t.status !== 'claimed') throw new Error('The claim transaction was replaced or dropped. Claim again.');
        } else {
            if (receipt.status !== 1) throw new Error('The claim failed on-chain.');
            upsertTransfer({ txHash: burnTxHash, status: 'claimed', claimedAt: Date.now() });
        }
        UI.showToast({ type: 'success', title: 'Withdrawal Claimed', message: `${formatData(t.amountWei)} DATA are in your Ethereum wallet.`, duration: 8000 });
        loadBalances();
    } catch (e) {
        logger.error('Bridge claim failed:', e);
        await restoreWhenIdle();
        if (t.status === 'claiming') upsertTransfer({ txHash: burnTxHash, status: 'ready' });
        const message = formatTxError(e);
        if (/already claimed/.test(message)) upsertTransfer({ txHash: burnTxHash, status: 'claimed' });
        UI.showToast({ type: 'error', title: 'Claim Failed', message, duration: 8000 });
    } finally {
        state.claiming.delete(burnTxHash);
        renderTransfers();
    }
}

// ============================================
// Lifecycle
// ============================================

function schedulePoll() {
    clearTimeout(state.pollTimer);
    if (!state.active || !state.address) return;
    state.pollTimer = setTimeout(async () => {
        if (!document.hidden) await refreshStatuses();
        schedulePoll();
    }, POLL_INTERVAL_MS);
}

async function refreshAll() {
    if (!state.address) return;
    const btn = $('bridge-refresh');
    const icon = btn?.querySelector('svg');
    const started = Date.now();
    if (btn) btn.disabled = true;
    icon?.classList.add('animate-spin');
    try {
        await Promise.all([loadBalances(), recoverFromExplorer()]);
        renderTransfers();
        await refreshStatuses();
        if (applyExplorerTimes()) {
            saveTransfers();
            renderTransfers();
        }
        await fillCheckpointTimes();
        await fillArrivalTimes();
    } finally {
        // Spin for at least half a second, so the refresh is noticed
        await new Promise(resolve => setTimeout(resolve, Math.max(0, 500 - (Date.now() - started))));
        icon?.classList.remove('animate-spin');
        if (btn) btn.disabled = false;
    }
}

function setupListeners() {
    if (state.listenersSetup) return;
    state.listenersSetup = true;
    $('bridge-amount')?.addEventListener('input', () => {
        if (state.flow) return;
        showError('');
        updateAmountStatus();
        renderSubmit();
        debouncedEstimate();
    });
    $('bridge-max')?.addEventListener('click', () => {
        const balance = state.direction === 'deposit' ? state.balances.ethData : state.balances.polygonData;
        if (!balance || state.flow) return;
        $('bridge-amount').value = ethers.utils.formatEther(balance).replace(/\.0$/, '');
        updateAmountStatus();
        renderSubmit();
        debouncedEstimate();
    });
    $('bridge-flip')?.addEventListener('click', () => {
        if (state.flow) return;
        state.direction = state.direction === 'deposit' ? 'withdraw' : 'deposit';
        showError('');
        renderDirection();
        updateAmountStatus();
        updateEstimate();
    });
    $('bridge-submit')?.addEventListener('click', handleSubmit);
    $('bridge-refresh')?.addEventListener('click', refreshAll);
    $('bridge-transfers')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-claim]');
        if (btn) claim(btn.dataset.claim);
    });
    window.ethereum?.on?.('chainChanged', onWalletChainChanged);
    window.addEventListener('app:routechange', (e) => {
        if (!e.detail?.path?.startsWith('/bridge')) BridgeLogic.stop();
    });
}

export const BridgeLogic = {
    async show() {
        setupListeners();
        state.active = true;
        let address = null;
        try {
            address = window.appSigner ? (await window.appSigner.getAddress()).toLowerCase() : null;
        } catch (e) {
            address = null;
        }
        if (address !== state.address) {
            state.address = address;
            state.transfers = address ? loadStoredTransfers() : [];
            state.balances = { ethData: null, polygonData: null, eth: null, pol: null };
            state.claimChecked.clear();
        }
        if (!state.flow) {
            $('bridge-progress')?.classList.add('hidden');
            $('bridge-route-note')?.classList.remove('hidden');
            showSuccess('');
            showError('');
            setFormLocked(!state.address);
        }
        renderDirection();
        renderTransfers();
        updateEstimate();
        if (state.address) {
            await refreshAll();
            schedulePoll();
        }
    },

    stop() {
        state.active = false;
        clearTimeout(state.pollTimer);
        state.pollTimer = null;
    }
};
