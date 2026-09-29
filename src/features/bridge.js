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
    'https://eth.llamarpc.com',
    'https://1rpc.io/eth'
];
const PROOF_API = 'https://proof-generator.polygon.technology/api/v1/matic/exit-payload/';
const TRANSFER_TOPIC = ethers.utils.id('Transfer(address,address,uint256)');
const STATE_SYNCED_TOPIC = ethers.utils.id('StateSynced(uint256,address,bytes)');

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
const ROOT_CHAIN_ABI = ['function getLastChildBlock() view returns (uint256)'];
const STATE_RECEIVER_ABI = ['function lastStateId() view returns (uint256)'];

const DEPOSIT_GAS_FALLBACK = 180000;   // depositFor can't be estimated before the approval
const EXIT_GAS_ESTIMATE = 400000;      // typical RootChainManager.exit of an ERC-20
const POLL_INTERVAL_MS = 30 * 1000;
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

let ethRpcIndex = 0;
let ethProvider = null;

function getEthProvider() {
    if (!ethProvider) ethProvider = new ethers.providers.StaticJsonRpcProvider(ETHEREUM_RPCS[ethRpcIndex], ETH_CHAIN_ID);
    return ethProvider;
}

function isRpcFailure(error) {
    if (['SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR'].includes(error?.code)) return true;
    return Services.isRateLimitError(error) || /failed to fetch|missing response|bad response|could not detect network/i.test(error?.message || '');
}

/** Ethereum read with RPC fallback (reverts are answers, not RPC failures) */
async function ethRead(readFn) {
    let lastError = null;
    for (let attempt = 0; attempt < ETHEREUM_RPCS.length; attempt++) {
        try {
            return await readFn(getEthProvider());
        } catch (e) {
            lastError = e;
            if (!isRpcFailure(e)) throw e;
            ethRpcIndex = (ethRpcIndex + 1) % ETHEREUM_RPCS.length;
            ethProvider = null;
        }
    }
    throw lastError;
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
    if (added) {
        state.transfers.sort((a, b) => b.createdAt - a.createdAt);
        saveTransfers();
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
                if (lastStateId && lastStateId.gte(t.stateId)) { t.status = 'done'; changed = true; }
            } else {
                if (t.status === 'claiming') {
                    const receipt = t.claimTxHash ? await ethRead(p => p.getTransactionReceipt(t.claimTxHash)) : null;
                    if (receipt) { t.status = receipt.status === 1 ? 'claimed' : 'ready'; changed = true; }
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

function txLink(chainId, hash, label) {
    return `<a href="${CHAINS[chainId].explorer}${Utils.escapeHtml(hash)}" target="_blank" rel="noopener noreferrer" class="text-blue-400 hover:text-blue-300">${label}</a>`;
}

function transferHtml(t) {
    const [label, badgeClass] = STATUS_BADGES[t.status] || STATUS_BADGES.pending;
    const deposit = t.kind === 'deposit';
    const route = deposit ? 'Ethereum → Polygon' : 'Polygon → Ethereum';
    const claimBusy = state.claiming.has(t.txHash);
    const links = [txLink(deposit ? ETH_CHAIN_ID : POLYGON_CHAIN_ID, t.txHash, deposit ? 'Deposit tx' : 'Burn tx')];
    if (t.claimTxHash) links.push(txLink(ETH_CHAIN_ID, t.claimTxHash, 'Claim tx'));
    const hint = t.status === 'checkpoint' ? 'Claimable on Ethereum once a Polygon checkpoint includes it.'
        : t.status === 'bridging' ? 'Shows up on Polygon once Polygon picks up the deposit.'
        : '';
    // Withdrawals always show the Claim button: disabled with a spinner until the checkpoint reaches Ethereum
    const spinner = '<span class="w-3 h-3 border-2 border-white rounded-full border-t-transparent animate-spin"></span>';
    const claiming = claimBusy || t.status === 'claiming';
    const waiting = t.status === 'pending' || t.status === 'checkpoint';
    const claimButton = !deposit && (claiming || waiting || t.status === 'ready') ? `
        <button type="button" data-claim="${Utils.escapeHtml(t.txHash)}" ${claiming || waiting ? 'disabled' : ''}
            ${waiting ? 'title="Available once a Polygon checkpoint includes the burn"' : ''}
            class="ml-auto bg-blue-800 hover:bg-blue-900 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-blue-800">
            ${claiming ? `${spinner}Claiming...` : waiting ? `${spinner}Claim on Ethereum` : 'Claim on Ethereum'}
        </button>` : '';
    return `
        <li class="p-3 bg-[#121212] border border-[#333] rounded-lg">
            <div class="flex items-center justify-between gap-2">
                <span class="text-sm font-semibold text-white">${formatData(t.amountWei)} DATA</span>
                <span class="px-2 py-0.5 rounded-full text-[11px] font-semibold ${badgeClass}">${label}</span>
            </div>
            <p class="text-xs text-gray-400 mt-1">${route} · ${timeAgo(t.createdAt)}</p>
            ${hint ? `<p class="text-xs text-gray-400 mt-1">${hint}</p>` : ''}
            <div class="flex items-center gap-3 mt-2 text-xs">${links.join('')}${claimButton}</div>
        </li>`;
}

function renderTransfers() {
    const list = $('bridge-transfers');
    if (!list) return;
    if (!state.address) {
        list.innerHTML = '<li class="text-sm text-gray-400">Connect a wallet to see your transfers.</li>';
        return;
    }
    list.innerHTML = state.transfers.length
        ? state.transfers.map(transferHtml).join('')
        : '<li class="text-sm text-gray-400">No bridge transfers yet.</li>';
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
        const signer = await getEthereumSigner();
        const tx = await new ethers.Contract(ETH_DATA, ERC20_ABI, signer).approve(ERC20_PREDICATE, flow.amountWei);
        step.txHash = tx.hash;
        renderProgress();
        const receipt = await ethRead(p => p.waitForTransaction(tx.hash));
        if (receipt.status !== 1) throw new Error('The approval failed on-chain.');
    } else if (step.key === 'deposit') {
        const signer = await getEthereumSigner();
        const depositData = ethers.utils.defaultAbiCoder.encode(['uint256'], [flow.amountWei]);
        const tx = await new ethers.Contract(ROOT_CHAIN_MANAGER, ROOT_CHAIN_MANAGER_ABI, signer).depositFor(address, ETH_DATA, depositData);
        step.txHash = tx.hash;
        flow.sent = true;
        upsertTransfer({ kind: 'deposit', txHash: tx.hash, amountWei: flow.amountWei.toString(), createdAt: Date.now(), status: 'pending' });
        renderProgress();
        const receipt = await ethRead(p => p.waitForTransaction(tx.hash));
        if (receipt.status !== 1) {
            upsertTransfer({ txHash: tx.hash, status: 'failed' });
            throw new Error('The deposit failed on-chain.');
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
        upsertTransfer({ kind: 'withdraw', txHash: tx.hash, amountWei: flow.amountWei.toString(), createdAt: Date.now(), status: 'pending' });
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
        await restorePolygon();
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
        await restorePolygon();
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

async function claim(burnTxHash) {
    const t = state.transfers.find(x => x.txHash === burnTxHash);
    if (!t || state.claiming.has(burnTxHash) || !state.address) return;
    state.claiming.add(burnTxHash);
    renderTransfers();
    try {
        const payload = await fetchExitPayload(burnTxHash);
        const signer = await getEthereumSigner();
        const tx = await new ethers.Contract(ROOT_CHAIN_MANAGER, ROOT_CHAIN_MANAGER_ABI, signer).exit(payload);
        upsertTransfer({ txHash: burnTxHash, status: 'claiming', claimTxHash: tx.hash });
        await restorePolygon();
        const receipt = await ethRead(p => p.waitForTransaction(tx.hash));
        if (receipt.status !== 1) throw new Error('The claim failed on-chain.');
        upsertTransfer({ txHash: burnTxHash, status: 'claimed' });
        UI.showToast({ type: 'success', title: 'Withdrawal Claimed', message: `${formatData(t.amountWei)} DATA are in your Ethereum wallet.`, duration: 8000 });
        loadBalances();
    } catch (e) {
        logger.error('Bridge claim failed:', e);
        await restorePolygon();
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
    btn?.classList.add('animate-spin');
    try {
        await Promise.all([loadBalances(), recoverFromExplorer()]);
        renderTransfers();
        await refreshStatuses();
    } finally {
        btn?.classList.remove('animate-spin');
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
