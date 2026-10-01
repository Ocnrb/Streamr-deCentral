// Login: a private key saved encrypted in the browser, unlocked with its password on the next visit
import { test, expect } from '@playwright/test';
import { mockNetwork } from './support/network.mjs';

// A well-known test key (Hardhat's first account), never used with funds
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADDRESS = /0xf39f/i;

test.beforeEach(async ({ page }) => {
    await mockNetwork(page.context());
    await page.goto('/operators', { waitUntil: 'domcontentloaded' });
    await page.click('#privateKeyBtn');
    await page.fill('#privateKeyInput', KEY);
    await page.check('#rememberPrivateKey');
});

test('a saved key is unlocked with its password', async ({ page }) => {
    await page.fill('#encryptionPassword', 'secret-123');
    await page.fill('#encryptionPasswordConfirm', 'secret-123');
    await page.click('#pkModalConnect');
    await expect(page.locator('#sidebar-wallet-address')).toHaveText(ADDRESS, { timeout: 30000 });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#unlockWalletModal')).toBeVisible();
    await page.fill('#unlockPassword', 'wrong');
    await page.click('#unlockConfirm');
    await expect(page.locator('#unlockError')).toHaveText('Incorrect password. 4 attempts remaining.', { timeout: 30000 });
    await page.fill('#unlockPassword', 'secret-123');
    await page.click('#unlockConfirm');
    await expect(page.locator('#unlockWalletModal')).toBeHidden({ timeout: 30000 });
    await expect(page.locator('#sidebar-wallet-address')).toHaveText(ADDRESS);
});

test('the password to save the key is checked', async ({ page }) => {
    await page.fill('#encryptionPassword', 'abc');
    await page.fill('#encryptionPasswordConfirm', 'abc');
    await page.click('#pkModalConnect');
    await expect(page.locator('#toast-container')).toContainText('Use at least 6 characters.');
    await page.fill('#encryptionPassword', 'secret-123');
    await page.fill('#encryptionPasswordConfirm', 'secret-456');
    await page.click('#pkModalConnect');
    await expect(page.locator('#toast-container')).toContainText('The two passwords do not match.');
    expect(await page.evaluate(() => localStorage.getItem('encrypted_wallet'))).toBeNull();
});
