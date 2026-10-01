// The private key saved in the browser, encrypted with the user's password (Keystore V3, as in ethers)
import { logger } from '../core/utils.js';
import { ethers } from 'ethers';

const KEYSTORE_STORAGE_KEY = 'encrypted_wallet';

/**
 * Save wallet as encrypted Keystore V3 JSON to localStorage
 * Uses the same secure format as MetaMask, MyEtherWallet, Geth, etc.
 * @param {string} privateKey - The private key to encrypt
 * @param {string} password - User's encryption password
 * @returns {Promise<boolean>} True if saved successfully
 */
export async function savePrivateKey(privateKey, password) {
    try {
        const wallet = new ethers.Wallet(privateKey);
        // Encrypt using Keystore V3 format (scrypt + AES-128-CTR)
        // This is slow by design (~3-5 seconds) to prevent brute-force attacks
        const encryptedJson = await wallet.encrypt(password);
        localStorage.setItem(KEYSTORE_STORAGE_KEY, encryptedJson);
        return true;
    } catch (e) {
        logger.error('Keystore encryption failed:', e);
        return false;
    }
}

/**
 * Decrypt stored Keystore V3 JSON and return the private key
 * @param {string} password - User's encryption password
 * @returns {Promise<string|null>} Decrypted private key or null if failed
 */
export async function decryptPrivateKey(password) {
    try {
        const encryptedJson = localStorage.getItem(KEYSTORE_STORAGE_KEY);
        if (!encryptedJson) return null;

        // Decrypt Keystore V3 JSON (slow by design)
        const wallet = await ethers.Wallet.fromEncryptedJson(encryptedJson, password);
        return wallet.privateKey;
    } catch (e) {
        // Don't clear on failure - might be wrong password
        logger.error('Keystore decryption failed:', e);
        return null;
    }
}

/**
 * Check if there's a stored encrypted wallet
 * @returns {boolean}
 */
export function hasStoredPrivateKey() {
    return localStorage.getItem(KEYSTORE_STORAGE_KEY) !== null;
}

/**
 * Clear stored encrypted wallet
 */
export function clearStoredPrivateKey() {
    localStorage.removeItem(KEYSTORE_STORAGE_KEY);
    // Also clear legacy keys if they exist (one-time cleanup)
    localStorage.removeItem('pk_encrypted');
    localStorage.removeItem('pk_salt');
    localStorage.removeItem('pk_iv');
}
