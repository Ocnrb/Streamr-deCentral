/**
 * Ethereum transactions from pages that run on Polygon (the swap): the signer on Ethereum, the private key
 * with an Ethereum RPC or the browser wallet switched to Ethereum, and the wallet back on Polygon after.
 * The app reloads on a network change (main.js) unless appNetworkSwitchInProgress is set: it is cleared
 * once the wallet is back on Polygon.
 */

import * as UI from '../ui/ui.js';
import { ethers } from 'ethers';

const POLYGON_CHAIN_ID = 137;
const ETHEREUM_CHAIN_ID = 1;

export const usesPrivateKey = () => Boolean(window.appSigner?.privateKey);

let restoring = false;
let restoreTimer = null;
let listening = false;

async function walletChainId() {
    return parseInt(await window.ethereum.request({ method: 'eth_chainId' }), 16);
}

function finishRestore() {
    restoring = false;
    clearTimeout(restoreTimer);
    window.appNetworkSwitchInProgress = false;
}

function listen() {
    if (listening || !window.ethereum?.on) return;
    listening = true;
    window.ethereum.on('chainChanged', (chainIdHex) => {
        if (restoring && parseInt(chainIdHex, 16) === POLYGON_CHAIN_ID) finishRestore();
    });
}

async function switchWalletChain(chainId, name) {
    if (await walletChainId() === chainId) return;
    listen();
    window.appNetworkSwitchInProgress = true;
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${chainId.toString(16)}` }] });
    if (await walletChainId() !== chainId) throw new Error(`Switch your wallet to ${name} to continue.`);
}

/** The signer on Ethereum for `address` (the app's account): `provider` reads Ethereum for a private key */
export async function getEthereumSigner(address, provider) {
    if (usesPrivateKey()) return new ethers.Wallet(window.appSigner.privateKey, provider);
    if (!window.ethereum) throw new Error('Wallet not found.');
    await switchWalletChain(ETHEREUM_CHAIN_ID, 'Ethereum');
    const signer = new ethers.providers.Web3Provider(window.ethereum, 'any').getSigner();
    if ((await signer.getAddress()).toLowerCase() !== address.toLowerCase()) throw new Error('The wallet account changed. Reload the page.');
    return signer;
}

/** Back to Polygon after Ethereum transactions (the rest of the app runs on Polygon) */
export async function restorePolygon() {
    if (usesPrivateKey() || !window.ethereum || !window.appNetworkSwitchInProgress) return;
    try {
        if (await walletChainId() === POLYGON_CHAIN_ID) {
            finishRestore();
            return;
        }
        restoring = true;
        // The chainChanged event clears the flag; the timer covers a wallet that sends none
        restoreTimer = setTimeout(finishRestore, 5000);
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x89' }] });
    } catch (e) {
        finishRestore();
        UI.showToast({ type: 'warning', title: 'Switch back to Polygon', message: 'The rest of deCentral runs on Polygon: switch your wallet back to Polygon.', duration: 0 });
    }
}
