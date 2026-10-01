// Transactions: delegate, undelegate, stake, collect earnings, and their modals
import { DATA_TOKEN_ADDRESS_POLYGON, STREAMR_CONFIG_ADDRESS, DATA_TOKEN_ABI, OPERATOR_CONTRACT_ABI, STREAMR_CONFIG_ABI } from './constants.js';
import { showToast, setModalState, txModalAmount, txModalBalanceValue, txModalMinimumValue, stakeModalAmount, transactionModal, stakeModal } from '../ui/ui.js';
import { getFriendlyErrorMessage } from './utils.js';
import { getReadOnlyProvider, getProvider, getGasOverrides, checkGasPriceAndWarn, readWithFallback, executeWithFallback } from './rpc.js';

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

        // The user's current DATA balance: operator tokens at the real-time exchange rate
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

        // undelegate() takes the amount in DATA: the contract converts it to operator tokens when it pays out.
        // Full withdrawal: the whole current balance (an amount typed from a rounded balance leaves no dust)
        const fullWithdrawalThreshold = userBalanceDataWei.mul(9999).div(10000);
        const undelegateDataWei = amountDataWei.gte(fullWithdrawalThreshold) ? userBalanceDataWei : amountDataWei;

        // Check gas price before proceeding
        if (!await checkGasPriceAndWarn(signer.provider)) {
            setModalState('tx-modal', 'input');
            return null;
        }

        setModalState('tx-modal', 'loading');
        const gasOverrides = await getGasOverrides(signer.provider);
        const tx = await operatorContract.undelegate(undelegateDataWei, gasOverrides);
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
