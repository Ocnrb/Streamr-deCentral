// Staking into a sponsorship from its page (operator agents), and the operators staked in it
import * as Utils from '../../core/utils.js';
import * as UI from '../../ui/ui.js';
import * as Services from '../../core/services.js';
import { logger } from '../../core/utils.js';
import { getOperatorProfile } from '../../core/profile.js';
import { detailState } from './state.js';
import { StreamsLogic } from '../streams.js';

let currentSponsorshipForStake = null;

/**
 * Setup the operator stake button based on user's operator profile
 * @param {Object} sponsorship - The sponsorship data
 */
export function setupOperatorStakeButton(sponsorship) {
    const actionContainer = document.getElementById('stream-operator-stake-action');
    const stakeBtn = document.getElementById('stream-stake-btn');
    const stakeBtnText = document.getElementById('stream-stake-btn-text');
    
    if (!actionContainer || !stakeBtn) return;
    
    // Check if user has an operator profile
    const operatorProfile = getOperatorProfile();
    if (!operatorProfile || !operatorProfile.id) {
        actionContainer.classList.add('hidden');
        return;
    }
    
    // Check if user's operator is already staked in this sponsorship
    const operatorId = operatorProfile.id.toLowerCase();
    const stakes = sponsorship.stakes || [];
    const operatorStake = stakes.find(s => s.operator?.id?.toLowerCase() === operatorId);
    const currentStakeWei = operatorStake ? operatorStake.amountWei : '0';
    
    // Store sponsorship info for modal
    currentSponsorshipForStake = {
        id: sponsorship.id,
        currentStakeWei: currentStakeWei,
        operatorId: operatorId,
        streamId: sponsorship.stream?.id || 'Unknown'
    };
    
    // Update button text and icon
    if (operatorStake && BigInt(currentStakeWei) > BigInt(0)) {
        stakeBtnText.textContent = 'Edit Stake';
        stakeBtn.innerHTML = `
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
            </svg>
            <span id="stream-stake-btn-text">Edit Stake</span>
        `;
    } else {
        stakeBtn.innerHTML = `
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"/>
            </svg>
            <span id="stream-stake-btn-text">Join as Operator</span>
        `;
    }
    
    // Show the button
    actionContainer.classList.remove('hidden');
    
    // Remove old listener and add new one
    const newBtn = stakeBtn.cloneNode(true);
    stakeBtn.parentNode.replaceChild(newBtn, stakeBtn);
    
    newBtn.addEventListener('click', () => {
        // Check if wallet is connected
        if (!window.appSigner) {
            UI.showToast({
                type: 'warning',
                title: 'Wallet Required',
                message: 'Please connect your wallet.',
                duration: 5000
            });
            return;
        }
        openStakeModal(currentSponsorshipForStake);
    });
}

/**
 * Open the stake modal for joining/editing stake
 * @param {Object} sponsorshipInfo - Sponsorship info with id, currentStakeWei, operatorId
 */
async function openStakeModal(sponsorshipInfo) {
    const modal = document.getElementById('stakeModal');
    const titleEl = document.getElementById('stake-modal-title');
    const descriptionEl = document.getElementById('stake-modal-description');
    const amountInput = document.getElementById('stake-modal-amount');
    const currentStakeEl = document.getElementById('stake-modal-current-stake');
    const freeFundsEl = document.getElementById('stake-modal-free-funds');
    const confirmBtn = document.getElementById('stake-modal-confirm');
    const cancelBtn = document.getElementById('stake-modal-cancel');
    const maxBtn = document.getElementById('stake-modal-max-btn');
    
    if (!modal) return;
    
    const currentStakeData = Utils.convertWeiToData(sponsorshipInfo.currentStakeWei);
    const isJoining = BigInt(sponsorshipInfo.currentStakeWei) === BigInt(0);
    
    // Update modal title and description
    if (titleEl) {
        titleEl.textContent = isJoining ? 'Join Sponsorship' : 'Edit Stake';
    }
    if (descriptionEl) {
        descriptionEl.textContent = isJoining 
            ? 'Enter the amount to stake in this sponsorship.'
            : 'Enter the new total stake amount for this sponsorship.';
    }
    
    // Set current stake
    if (currentStakeEl) {
        currentStakeEl.textContent = `${Utils.formatBigNumber(currentStakeData)} DATA`;
    }
    
    // Set initial amount
    if (amountInput) {
        amountInput.value = isJoining ? '' : parseFloat(currentStakeData);
    }
    
    // Fetch free funds from operator contract
    if (freeFundsEl) {
        freeFundsEl.textContent = 'Loading...';
        try {
            const query = `{
                operator(id: "${sponsorshipInfo.operatorId}") {
                    valueWithoutEarnings
                    stakes { amountWei }
                }
            }`;
            const data = await Services.runQuery(query);
            if (data.operator) {
                const totalValue = BigInt(data.operator.valueWithoutEarnings || '0');
                const stakedAmount = data.operator.stakes.reduce(
                    (sum, s) => sum + BigInt(s.amountWei || '0'), 
                    BigInt(0)
                );
                const freeBalance = totalValue > stakedAmount ? totalValue - stakedAmount : BigInt(0);
                const freeBalanceData = Utils.convertWeiToData(freeBalance.toString());
                freeFundsEl.textContent = `${Utils.formatBigNumber(freeBalanceData)} DATA`;
                
                // Store for MAX button
                freeFundsEl.dataset.freeWei = freeBalance.toString();
                freeFundsEl.dataset.currentStakeWei = sponsorshipInfo.currentStakeWei;
            } else {
                freeFundsEl.textContent = 'N/A';
            }
        } catch (e) {
            logger.error('Failed to fetch operator free funds:', e);
            freeFundsEl.textContent = 'Error';
        }
    }
    
    // Show modal
    modal.classList.remove('hidden');
    
    // Setup MAX button
    if (maxBtn) {
        const newMaxBtn = maxBtn.cloneNode(true);
        maxBtn.parentNode.replaceChild(newMaxBtn, maxBtn);
        newMaxBtn.addEventListener('click', () => {
            const freeWei = BigInt(freeFundsEl?.dataset?.freeWei || '0');
            const currentWei = BigInt(freeFundsEl?.dataset?.currentStakeWei || '0');
            const maxWei = freeWei + currentWei;
            const maxData = Utils.convertWeiToData(maxWei.toString());
            if (amountInput) amountInput.value = parseFloat(maxData);
        });
    }
    
    // Setup Cancel button
    if (cancelBtn) {
        const newCancelBtn = cancelBtn.cloneNode(true);
        cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
        newCancelBtn.addEventListener('click', () => {
            modal.classList.add('hidden');
        });
    }
    
    // Setup Confirm button
    if (confirmBtn) {
        const newConfirmBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
        newConfirmBtn.disabled = false;
        newConfirmBtn.textContent = 'Confirm';
        
        newConfirmBtn.addEventListener('click', async () => {
            await handleStakeConfirm(sponsorshipInfo, amountInput, newConfirmBtn, modal);
        });
    }
}

/**
 * Handle stake confirmation
 */
async function handleStakeConfirm(sponsorshipInfo, amountInput, confirmBtn, modal) {
    const newAmountData = parseFloat(amountInput?.value || '0');
    if (isNaN(newAmountData) || newAmountData < 0) {
        UI.showToast({
            type: 'error',
            title: 'Invalid Amount',
            message: 'Please enter a valid amount.',
            duration: 3000
        });
        return;
    }
    
    // Get signer from main app
    const signer = window.appSigner;
    if (!signer) {
        UI.showToast({
            type: 'error',
            title: 'Wallet Not Connected',
            message: 'Please connect your wallet to manage stakes.',
            duration: 5000
        });
        return;
    }
    
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent animate-spin"></div>';
    
    try {
        const newAmountWei = ethers.utils.parseUnits(String(newAmountData), 18);
        const currentStakeWei = BigInt(sponsorshipInfo.currentStakeWei);
        const newAmountWeiBig = BigInt(newAmountWei.toString());
        
        // Use executeWithFallback to handle rate limiting
        await Services.executeWithFallback(async (currentSigner) => {
            // Get gas overrides for Polygon
            const gasOverrides = await Services.getGasOverrides(currentSigner.provider);
            
            // Get operator contract
            const operatorContract = new ethers.Contract(
                sponsorshipInfo.operatorId,
                [
                    'function stake(address sponsorship, uint256 amountWei) external',
                    'function reduceStakeTo(address sponsorship, uint256 targetStakeWei) external',
                    'function unstake(address sponsorship) external'
                ],
                currentSigner
            );
            
            let tx;
            
            if (newAmountWeiBig === BigInt(0) && currentStakeWei > BigInt(0)) {
                // Unstake completely
                tx = await operatorContract.unstake(sponsorshipInfo.id, gasOverrides);
            } else if (newAmountWeiBig > currentStakeWei) {
                // Stake more
                const amountToStake = newAmountWeiBig - currentStakeWei;
                tx = await operatorContract.stake(sponsorshipInfo.id, amountToStake.toString(), gasOverrides);
            } else if (newAmountWeiBig < currentStakeWei) {
                // Reduce stake
                tx = await operatorContract.reduceStakeTo(sponsorshipInfo.id, newAmountWeiBig.toString(), gasOverrides);
            } else {
                // No change
                modal.classList.add('hidden');
                UI.showToast({
                    type: 'info',
                    title: 'No Change',
                    message: 'Stake amount unchanged.',
                    duration: 3000
                });
                return;
            }
            
            UI.showToast({
                type: 'info',
                title: 'Transaction Submitted',
                message: 'Waiting for confirmation...',
                duration: 5000
            });
            
            await tx.wait();
        }, signer);
        
        modal.classList.add('hidden');
        
        UI.showToast({
            type: 'success',
            title: 'Stake Updated',
            message: 'Your stake has been updated successfully.',
            duration: 5000
        });
        
        // Reload the stream detail to show updated data
        if (detailState.currentStreamId) {
            StreamsLogic.loadStreamDetail(
                detailState.currentStreamId, 
                detailState.isSponsored, 
                detailState.currentSponsorshipId
            );
        }
        
    } catch (error) {
        logger.error('Stake transaction failed:', error);
        
        // Provide more user-friendly error message for rate limiting
        let errorMessage = error.reason || error.message || 'Failed to update stake.';
        if (Services.isRateLimitError(error)) {
            errorMessage = 'RPC rate limited. Please try again in a few seconds.';
        }
        
        UI.showToast({
            type: 'error',
            title: 'Transaction Failed',
            message: errorMessage,
            duration: 5000
        });
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Confirm';
    }
}

/**
 * Render operators list
 */
export function renderOperatorsList(stakes) {
    const container = document.getElementById('stream-operators-list');
    
    if (!stakes || stakes.length === 0) {
        container.innerHTML = `<div class="px-4 md:px-6 py-4 text-gray-500 text-center text-sm">No operators staked</div>`;
        return;
    }
    
    const html = stakes.map(stake => {
        const { name, imageUrl } = Utils.parseOperatorMetadata(stake.operator?.metadataJsonString);
        const fullName = name || Utils.shortAddress(stake.operator?.id);
        const opName = fullName.length > 20 ? fullName.slice(0, 20) + '...' : fullName;
        const stakeAmount = Utils.formatBigNumber(Utils.convertWeiToData(stake.amountWei));
        const rawStake = Utils.convertWeiToData(stake.amountWei);
        
        const profileImage = Utils.avatarImgHtml(imageUrl, { alt: opName, className: 'w-7 h-7 border border-[#444]' });
        
        return `
            <div class="flex justify-between items-center px-4 md:px-6 py-3 border-b border-[#333] last:border-b-0 hover:bg-white/5 transition-colors">
                <div class="flex items-center gap-3 min-w-0">
                    ${profileImage}
                    <a href="/operator/${Utils.escapeHtml(String(stake.operator?.id || ''))}" class="text-blue-400 hover:text-blue-300 font-medium text-sm truncate">${Utils.escapeHtml(opName)}</a>
                </div>
                <span class="text-gray-300 font-mono text-sm flex-shrink-0 ml-2" data-tooltip-value="${rawStake}">${stakeAmount} DATA</span>
            </div>
        `;
    }).join('');
    
    container.innerHTML = html;
}

/**
 * Render funding history
 */

export function resetStakeModal() {
    currentSponsorshipForStake = null;
}
