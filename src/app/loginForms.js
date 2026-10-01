// The login screen's forms: private key (optionally saved, encrypted) and unlocking the saved key
import * as UI from '../ui/ui.js';
import { connectWithWallet, connectAsGuest, connectWithPrivateKey, unlockWallet, forgetSavedKey } from './session.js';

export function setupLoginForms() {
    document.getElementById('connectWalletBtn').addEventListener('click', connectWithWallet);
    document.getElementById('guestBtn').addEventListener('click', connectAsGuest);

    // --- Private Key Modal Listeners ---
    const privateKeyBtn = document.getElementById('privateKeyBtn');
    const privateKeyInput = document.getElementById('privateKeyInput');
    const toggleVisibilityBtn = document.getElementById('togglePrivateKeyVisibility');
    const eyeIcon = document.getElementById('eyeIcon');
    const eyeOffIcon = document.getElementById('eyeOffIcon');
    const rememberCheckbox = document.getElementById('rememberPrivateKey');
    const pkModalCancel = document.getElementById('pkModalCancel');
    const pkModalConnect = document.getElementById('pkModalConnect');

    if (privateKeyBtn) {
        privateKeyBtn.addEventListener('click', () => {
            UI.showPrivateKeyModal();
        });
    }

    if (toggleVisibilityBtn) {
        toggleVisibilityBtn.addEventListener('click', () => {
            const isPassword = privateKeyInput.type === 'password';
            privateKeyInput.type = isPassword ? 'text' : 'password';
            eyeIcon.classList.toggle('hidden', !isPassword);
            eyeOffIcon.classList.toggle('hidden', isPassword);
        });
    }

    // Encryption password section elements
    const encryptionPasswordSection = document.getElementById('encryptionPasswordSection');
    const encryptionPasswordInput = document.getElementById('encryptionPassword');
    const confirmEncryptionPasswordInput = document.getElementById('encryptionPasswordConfirm');

    // Toggle password section visibility based on remember checkbox
    if (rememberCheckbox && encryptionPasswordSection) {
        rememberCheckbox.addEventListener('change', () => {
            encryptionPasswordSection.classList.toggle('hidden', !rememberCheckbox.checked);
            if (!rememberCheckbox.checked) {
                encryptionPasswordInput.value = '';
                confirmEncryptionPasswordInput.value = '';
            }
        });
    }

    if (pkModalCancel) {
        pkModalCancel.addEventListener('click', () => {
            UI.hidePrivateKeyModal();
            privateKeyInput.value = '';
            rememberCheckbox.checked = false;
            if (encryptionPasswordSection) encryptionPasswordSection.classList.add('hidden');
            if (encryptionPasswordInput) encryptionPasswordInput.value = '';
            if (confirmEncryptionPasswordInput) confirmEncryptionPasswordInput.value = '';
        });
    }

    if (pkModalConnect) {
        pkModalConnect.addEventListener('click', async () => {
            const pk = privateKeyInput.value;
            const shouldSave = rememberCheckbox.checked;
            let encryptionPassword = null;

            if (shouldSave) {
                const pwd1 = encryptionPasswordInput.value;
                const pwd2 = confirmEncryptionPasswordInput.value;

                if (!pwd1 || pwd1.length < 6) {
                    UI.showToast({ type: 'error', title: 'Password Too Short', message: 'Use at least 6 characters.' });
                    return;
                }
                if (pwd1 !== pwd2) {
                    UI.showToast({ type: 'error', title: 'Passwords Differ', message: 'The two passwords do not match.' });
                    return;
                }
                encryptionPassword = pwd1;
            }

            // Show loading state (encryption takes 3-5 seconds when saving)
            const originalText = pkModalConnect.innerHTML;
            if (shouldSave) {
                pkModalConnect.innerHTML = '<div class="loader rounded-full border-2 border-t-2 border-white border-t-transparent h-5 w-5 animate-spin"></div>';
            }
            pkModalConnect.disabled = true;
            privateKeyInput.disabled = true;

            try {
                await connectWithPrivateKey(pk, encryptionPassword);
            } finally {
                // Clear fields and restore button state
                pkModalConnect.innerHTML = originalText;
                pkModalConnect.disabled = false;
                privateKeyInput.disabled = false;
                privateKeyInput.value = '';
                rememberCheckbox.checked = false;
                if (encryptionPasswordSection) encryptionPasswordSection.classList.add('hidden');
                if (encryptionPasswordInput) encryptionPasswordInput.value = '';
                if (confirmEncryptionPasswordInput) confirmEncryptionPasswordInput.value = '';
            }
        });
    }

    // Allow Enter key to connect (from password confirm field when saving, or from private key field)
    if (privateKeyInput) {
        privateKeyInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter' && !rememberCheckbox.checked) {
                const pk = privateKeyInput.value;
                privateKeyInput.value = '';
                await connectWithPrivateKey(pk, null);
            }
        });
    }

    if (confirmEncryptionPasswordInput) {
        confirmEncryptionPasswordInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                pkModalConnect.click();
            }
        });
    }

    // --- Unlock Wallet Modal Listeners ---
    const unlockWalletModal = document.getElementById('unlockWalletModal');
    const unlockPasswordInput = document.getElementById('unlockPassword');
    const unlockConfirmBtn = document.getElementById('unlockConfirm');
    const unlockCancelBtn = document.getElementById('unlockCancel');
    const unlockForgetBtn = document.getElementById('unlockForget');

    if (unlockConfirmBtn) {
        unlockConfirmBtn.addEventListener('click', async () => {
            const password = unlockPasswordInput.value;
            if (!password) {
                UI.showToast({ type: 'error', title: 'Password Required', message: 'Enter your password.' });
                return;
            }
            
            // Show loading state (decryption takes 3-5 seconds)
            const originalText = unlockConfirmBtn.innerHTML;
            unlockConfirmBtn.innerHTML = '<div class="loader rounded-full border-2 border-t-2 border-white border-t-transparent h-5 w-5 animate-spin"></div>';
            unlockConfirmBtn.disabled = true;
            unlockPasswordInput.disabled = true;
            
            try {
                await unlockWallet(password);
            } finally {
                // Restore button state
                unlockConfirmBtn.innerHTML = originalText;
                unlockConfirmBtn.disabled = false;
                unlockPasswordInput.disabled = false;
                unlockPasswordInput.value = '';
            }
        });
    }

    if (unlockPasswordInput) {
        unlockPasswordInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                unlockConfirmBtn.click();
            }
        });
    }

    if (unlockCancelBtn) {
        unlockCancelBtn.addEventListener('click', () => {
            unlockWalletModal.classList.add('hidden');
            unlockPasswordInput.value = '';
            // Reset error message but keep attempt counter (security)
            const unlockError = document.getElementById('unlockError');
            if (unlockError) unlockError.classList.add('hidden');
            UI.setLoginModalState(true);
        });
    }

    if (unlockForgetBtn) {
        unlockForgetBtn.addEventListener('click', () => {
            forgetSavedKey();
            unlockWalletModal.classList.add('hidden');
            unlockPasswordInput.value = '';
            const unlockError = document.getElementById('unlockError');
            if (unlockError) unlockError.classList.add('hidden');
            UI.setLoginModalState(true);
            UI.showToast({ type: 'success', title: 'Wallet Forgotten', message: 'Stored key has been removed.' });
        });
    }
}
