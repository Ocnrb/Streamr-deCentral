// A sponsorship's on-chain history (Polygonscan), its transfers classified by the events in each transaction
import * as Utils from '../../core/utils.js';
import * as UI from '../../ui/ui.js';
import * as Services from '../../core/services.js';
import { logger } from '../../core/utils.js';
import { STREAMR_TREASURY_ADDRESS } from '../../core/constants.js';
import { detailState } from './state.js';
import { syncTileHeights } from './detail.js';

const ONCHAIN_HISTORY_PAGE_SIZE = 100;

// On-chain history of the sponsorship shown (pages of Polygonscan results, loaded with "Load more")
const onchainHistory = { address: null, page: 0, hasMore: false, txs: [], names: new Map(), loading: false };

function onchainTxKey(tx) {
    return `${tx.txHash}|${tx.token}|${tx.from}|${tx.to}|${tx.rawValue}`.toLowerCase();
}

/**
 * Fetches one page of the sponsorship's history, merges it (no duplicates), labels the transfers and
 * resolves the names of operators that left
 */
async function fetchOnchainHistoryPage(page) {
    const address = onchainHistory.address;
    const result = await Services.fetchPolygonscanHistory(address, ONCHAIN_HISTORY_PAGE_SIZE, [address], page);
    if (onchainHistory.address !== address) return false; // another sponsorship was opened meanwhile
    const pageTxs = result.transactions || (Array.isArray(result) ? result : []);
    const known = new Set(onchainHistory.txs.map(onchainTxKey));
    onchainHistory.txs.push(...pageTxs.filter(tx => !known.has(onchainTxKey(tx))));
    onchainHistory.page = page;
    onchainHistory.hasMore = Boolean(result.hasMore);

    // Label what each DATA transfer out of the sponsorship was (unstake / earnings / reduce stake / flag rewards)
    await classifySponsorshipTransfers(address, onchainHistory.txs);

    // Names of operators that already left the sponsorship (not in the current stakes)
    const missing = onchainHistory.txs.flatMap(tx => [tx.from, tx.to])
        .filter(a => typeof a === 'string' && !onchainHistory.names.has(a.toLowerCase()));
    const names = await fetchOperatorNames(missing)
        .catch(e => { logger.warn('Could not resolve operator names:', e); return new Map(); });
    names.forEach((name, addr) => onchainHistory.names.set(addr, name));
    return onchainHistory.address === address;
}

export async function loadSponsorshipOnchainHistory(sponsorshipAddress) {
    const container = document.getElementById('sponsorship-history-list');
    const emptyState = document.getElementById('sponsorship-history-empty');
    
    if (!container) return;
    
    // Show loading state
    container.innerHTML = `
        <div class="flex items-center justify-center py-8">
            <div class="loader rounded-full border-4 border-t-4 border-[#555555] border-t-transparent h-8 w-8"></div>
        </div>
    `;
    if (emptyState) emptyState.classList.add('hidden');

    Object.assign(onchainHistory, { address: sponsorshipAddress, page: 0, hasMore: false, txs: [], names: new Map(), loading: false });
    sponsorshipLogsCache.delete(sponsorshipAddress.toLowerCase());

    const syncHeights = () => {
        requestAnimationFrame(() => syncTileHeights());
        // Additional sync for Funding/History after longer delay
        setTimeout(() => syncTileHeights(), 300);
    };
    
    try {
        if (!await fetchOnchainHistoryPage(1)) return;
        
        if (onchainHistory.txs.length === 0) {
            container.innerHTML = '';
            if (emptyState) emptyState.classList.remove('hidden');
            syncHeights();
            return;
        }
        
        renderSponsorshipOnchainHistory(onchainHistory.txs, 'sponsorships', onchainHistory.names, onchainHistory.hasMore);
        syncHeights();
    } catch (error) {
        logger.error('Failed to load sponsorship on-chain history:', error);
        container.innerHTML = `<div class="px-4 py-4 text-gray-500 text-center text-sm">Failed to load on-chain history</div>`;
        syncHeights();
    }
}

const ONCHAIN_HISTORY_MAX_PAGES = 20;  // same cap as the Operator Details "Load All History"

const LOAD_ALL_BUTTON_HTML = `
    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path>
    </svg>
    Load All History`;

/**
 * "Load All History": the remaining pages of the sponsorship's on-chain history
 */
async function loadAllOnchainHistory(button) {
    if (onchainHistory.loading || !onchainHistory.hasMore) return;
    onchainHistory.loading = true;
    button.disabled = true;
    button.innerHTML = `<span class="w-4 h-4 border-2 border-white rounded-full border-t-transparent animate-spin"></span> Loading...`;
    const container = document.getElementById('sponsorship-history-list');
    const scrollTop = container?.scrollTop || 0;
    const address = onchainHistory.address;
    try {
        while (onchainHistory.hasMore && onchainHistory.page < ONCHAIN_HISTORY_MAX_PAGES) {
            if (!await fetchOnchainHistoryPage(onchainHistory.page + 1)) return;
            if (onchainHistory.hasMore) await new Promise(resolve => setTimeout(resolve, 300)); // Polygonscan rate limit
        }
        onchainHistory.hasMore = false;
        renderSponsorshipOnchainHistory(onchainHistory.txs, 'sponsorships', onchainHistory.names, false);
        if (container) container.scrollTop = scrollTop;
    } catch (error) {
        logger.error('Failed to load the full on-chain history:', error);
        if (onchainHistory.address === address) {
            // Show what was loaded so far; the button stays for another try
            renderSponsorshipOnchainHistory(onchainHistory.txs, 'sponsorships', onchainHistory.names, onchainHistory.hasMore);
        }
        UI.showToast({ type: 'error', title: 'Error', message: 'Failed to load complete history' });
    } finally {
        onchainHistory.loading = false;
    }
}

// Sponsorship address -> Promise of its event logs
const sponsorshipLogsCache = new Map();

// Sponsorship events used to tell the DATA transfers to operators apart
const SPONSORSHIP_EVENT_TOPICS = {
    stakeUpdate: ethers.utils.id('StakeUpdate(address,uint256,uint256)'),
    operatorLeft: ethers.utils.id('OperatorLeft(address,uint256)'),
    operatorKicked: ethers.utils.id('OperatorKicked(address)'),
    flagged: ethers.utils.id('Flagged(address,address,uint256,uint256,string)'),
    flagUpdate: ethers.utils.id('FlagUpdate(address,uint8,uint256,uint256,address,int256)')
};

/**
 * From the sponsorship's side, Polygonscan only gives the DATA transfers (operators act through their
 * Operator contract), so every transfer to an operator looked like an unstake. The sponsorship's own
 * events tell them apart:
 * - OperatorLeft(operator, returnedStakeWei): the transfer of that amount is the Unstake (Kicked when
 *   OperatorKicked is in the same tx); another transfer to the operator in that tx is its earnings
 *   (paid first, in the same transaction)
 * - a tx that resolves a flag (FlagUpdate) also pays the reviewers and the flagger: those transfers are
 *   Vote On Flag / Flag Reward (the shared classification could call them Collect Earnings)
 * - otherwise a StakeUpdate with a lower stake than before is a Reduce Stake, else Collect Earnings
 * Without the events: several transfers to one operator in a tx = the largest is the Unstake; a tx
 * paying several operators = flag resolution (single transfers = Vote On Flag, the other = Kicked).
 * @param {string} sponsorshipAddress
 * @param {Array} transactions - from Services.fetchPolygonscanHistory (updated in place: methodId)
 */
async function classifySponsorshipTransfers(sponsorshipAddress, transactions) {
    const sponsorship = sponsorshipAddress.toLowerCase();
    const isPayout = (tx) => tx.token === 'DATA' && tx.from?.toLowerCase() === sponsorship
        && tx.to && tx.to.toLowerCase() !== STREAMR_TREASURY_ADDRESS.toLowerCase();
    const payouts = transactions.filter(isPayout);
    if (!payouts.length) return;

    // Events are fetched once per sponsorship view (Load more reuses them)
    const cacheKey = sponsorship;
    if (!sponsorshipLogsCache.has(cacheKey)) {
        sponsorshipLogsCache.set(cacheKey, Services.fetchContractLogs(sponsorshipAddress).catch(e => {
            logger.warn('Could not load sponsorship events:', e);
            sponsorshipLogsCache.delete(cacheKey);
            return null;
        }));
    }
    const logs = await sponsorshipLogsCache.get(cacheKey);

    if (logs && logs.length) {
        const topicAddress = (topic) => '0x' + topic.slice(26).toLowerCase();
        const words = (data) => (data || '0x').slice(2).match(/.{64}/g)?.map(w => BigInt('0x' + w)) || [];
        const byTx = new Map();      // txHash -> { left, kicked, stake: Map(op -> { staked, previous }), flagTargets: Set(target) }
        const lastStake = new Map(); // operator -> latest stakedWei seen (logs are oldest first)
        const flaggerOf = new Map(); // target -> flagger of its latest flag
        const sorted = [...logs].sort((a, b) => (parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16)) || (parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16)));
        for (const log of sorted) {
            const topic0 = log.topics?.[0];
            if (!topic0 || !log.topics[1]) continue;
            const hash = log.transactionHash.toLowerCase();
            if (!byTx.has(hash)) byTx.set(hash, { left: new Map(), kicked: new Set(), stake: new Map(), flagTargets: new Set(), flaggers: new Set() });
            const info = byTx.get(hash);
            const operator = topicAddress(log.topics[1]);
            if (topic0 === SPONSORSHIP_EVENT_TOPICS.operatorLeft) {
                info.left.set(operator, words(log.data)[0]);
            } else if (topic0 === SPONSORSHIP_EVENT_TOPICS.operatorKicked) {
                info.kicked.add(operator);
            } else if (topic0 === SPONSORSHIP_EVENT_TOPICS.flagged && log.topics[2]) {
                flaggerOf.set(operator, topicAddress(log.topics[2]));
            } else if (topic0 === SPONSORSHIP_EVENT_TOPICS.flagUpdate) {
                info.flagTargets.add(operator);
                if (flaggerOf.has(operator)) info.flaggers.add(flaggerOf.get(operator));
            } else if (topic0 === SPONSORSHIP_EVENT_TOPICS.stakeUpdate) {
                const staked = words(log.data)[0];
                if (!info.stake.has(operator)) info.stake.set(operator, { previous: lastStake.get(operator), staked });
                else info.stake.get(operator).staked = staked;
                lastStake.set(operator, staked);
            }
        }

        for (const tx of payouts) {
            const info = byTx.get(tx.txHash?.toLowerCase());
            if (!info) continue;
            const operator = tx.to.toLowerCase();
            const value = BigInt(tx.rawValue || '0');
            if (info.left.has(operator)) {
                tx.methodId = value === info.left.get(operator)
                    ? (info.kicked.has(operator) ? 'Kicked' : 'Unstake')
                    : 'Collect Earnings';
            } else if (info.flagTargets.size > 0 && !info.flagTargets.has(operator)) {
                // Flag resolution: rewards to the flagger and to the reviewers
                tx.methodId = info.flaggers.has(operator) ? 'Flag Reward' : 'Vote On Flag';
            } else if (info.stake.has(operator)) {
                const { previous, staked } = info.stake.get(operator);
                tx.methodId = previous !== undefined && staked < previous ? 'Reduce Stake' : 'Collect Earnings';
            }
        }
        return;
    }

    // No events: in a tx with several transfers to one operator, the largest is the returned stake.
    // A tx paying several operators is a flag resolution: single transfers are the vote rewards and
    // the operator with several transfers is the kicked one.
    const byHash = new Map();
    for (const tx of payouts) {
        if (!byHash.has(tx.txHash)) byHash.set(tx.txHash, new Map());
        const recipients = byHash.get(tx.txHash);
        const to = tx.to.toLowerCase();
        if (!recipients.has(to)) recipients.set(to, []);
        recipients.get(to).push(tx);
    }
    for (const recipients of byHash.values()) {
        const flagResolution = recipients.size > 1;
        for (const group of recipients.values()) {
            if (group.length < 2) {
                if (flagResolution) group[0].methodId = 'Vote On Flag';
                continue;
            }
            const largest = group.reduce((max, tx) => (BigInt(tx.rawValue || '0') > BigInt(max.rawValue || '0') ? tx : max));
            for (const tx of group) tx.methodId = tx === largest ? (flagResolution ? 'Kicked' : 'Unstake') : 'Collect Earnings';
        }
    }
}

/**
 * Operator names for addresses (lowercase address -> name), for the operators that are not in the
 * sponsorship's current stakes (e.g. they unstaked): the history keeps showing their name
 * @param {Array<string>} addresses
 * @returns {Promise<Map<string, string>>}
 */
async function fetchOperatorNames(addresses) {
    const staked = new Set((detailState.sponsorshipStakes || []).map(s => s.operator?.id?.toLowerCase()));
    staked.add(detailState.currentSponsorshipId?.toLowerCase()); // the sponsorship itself
    const ids = [...new Set(addresses.filter(a => typeof a === 'string').map(a => a.toLowerCase()))]
        .filter(a => /^0x[0-9a-f]{40}$/.test(a) && !staked.has(a));
    const names = new Map();
    for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const data = await Services.runQuery(`{ operators(where: { id_in: ${JSON.stringify(chunk)} }, first: 100) { id metadataJsonString } }`);
        for (const op of data?.operators || []) {
            const { name } = Utils.parseOperatorMetadata(op.metadataJsonString);
            if (name) names.set(op.id.toLowerCase(), name);
        }
    }
    return names;
}

/**
 * Render on-chain history transactions
 * @param {Array} transactions - Array of transaction objects from Polygonscan
 * @param {string} context - 'operators' or 'sponsorships' to determine badge colors
 * @param {Map<string, string>} [extraNames] - names of operators not in the current stakes
 * @param {boolean} [showLoadMore] - add the "Load All History" button (more pages on Polygonscan)
 */
function renderSponsorshipOnchainHistory(transactions, context = 'sponsorships', extraNames = new Map(), showLoadMore = false) {
    const container = document.getElementById('sponsorship-history-list');
    if (!container) return;
    
    if (!transactions || transactions.length === 0) {
        container.innerHTML = `<div class="px-4 py-4 text-gray-500 text-center text-sm">No on-chain activity found</div>`;
        return;
    }
    
    // Build operator lookup map (address -> name): current stakes + operators that left
    const operatorNameMap = new Map(extraNames);
    for (const stake of detailState.sponsorshipStakes || []) {
        if (stake.operator?.id) {
            const addr = stake.operator.id.toLowerCase();
            const { name } = Utils.parseOperatorMetadata(stake.operator?.metadataJsonString);
            if (name) {
                operatorNameMap.set(addr, name);
            }
        }
    }
    
    // Sort by timestamp descending (most recent first)
    const sortedTxs = [...transactions].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    
    const html = sortedTxs.map(tx => {
        const date = tx.timestamp ? new Date(tx.timestamp * 1000).toLocaleString() : 'Unknown';
        let method = tx.methodId || 'Unknown';
        const direction = tx.direction || tx.relatedObject || 'IN';
        const amount = tx.amount ? Utils.formatBigNumber(Math.round(tx.amount).toString()) : '0';
        const token = tx.token || 'DATA';
        const txUrl = `https://polygonscan.com/tx/${tx.txHash}`;

        // Translate method names
        // If method is Delegate, show Stake (or Funding if input is transferAndCall)
        // If method is Undelegate, show Unstake
        if (method === 'Delegate') {
            // Heuristic: if input length > 10, it's likely transferAndCall (Funding)
            if (tx.input && tx.input.length > 10) {
                method = 'Funding';
            } else {
                method = 'Stake';
            }
        } else if (method === 'Undelegate') {
            method = 'Unstake';
        }

        // Determine badge style based on method/direction and context
        let badgeClass = 'tx-badge-in';
        
        if (context === 'sponsorships') {
            // Sponsorships context
            if (method === 'Stake' && direction === 'IN') {
                badgeClass = 'tx-badge-stake'; // Green for STAKE-IN
            } else if (['Unstake', 'Force Unstake', 'Reduce Stake'].includes(method)) {
                badgeClass = 'tx-badge-out'; // Red for unstake operations
            } else if (direction === 'OUT') {
                badgeClass = 'tx-badge-out';
            }
        } else if (context === 'operators') {
            // Operators context - ALL stake operations should be orange
            if (['Stake', 'Unstake', 'Force Unstake', 'Reduce Stake'].includes(method)) {
                badgeClass = 'tx-badge-stake-out'; // Orange for ALL stake operations
            } else if (direction === 'OUT') {
                badgeClass = 'tx-badge-out';
            }
        }

        // Get operator name/address 
        const otherAddress = direction === 'IN' ? tx.from : tx.to;
        let operatorDisplay = '';
        if (otherAddress) {
            const addrLower = otherAddress.toLowerCase();
            const operatorName = operatorNameMap.get(addrLower);
            if (operatorName) {
                operatorDisplay = `<span class="text-gray-400 text-xs truncate max-w-[120px]" title="${otherAddress}">${Utils.escapeHtml(operatorName)}</span>`;
            } else {
                operatorDisplay = `<span class="text-gray-500 text-xs font-mono" title="${otherAddress}">${Utils.shortAddress(otherAddress)}</span>`;
            }
        }

        return `
            <div class="flex items-center gap-3 py-2 border-b border-[#333] last:border-b-0">
                <div class="flex-shrink-0">
                    <span class="tx-badge ${badgeClass}">${Utils.escapeHtml(direction)}</span>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                        <a href="${txUrl}" target="_blank" rel="noopener noreferrer" class="text-sm font-medium text-gray-300 hover:text-white transition-colors">
                            ${Utils.escapeHtml(method)}
                        </a>
                        ${operatorDisplay}
                    </div>
                    <span class="text-xs text-gray-500">${date}</span>
                </div>
                <div class="text-right flex-shrink-0">
                    <p class="font-mono text-sm text-white">${amount} ${Utils.escapeHtml(token)}</p>
                </div>
            </div>
        `;
    }).join('');
    
    // Same button as the Operator Details "Load All History"; the handler is delegated (set once)
    const loadMore = showLoadMore ? `
        <div class="py-4 text-center">
            <button type="button" data-onchain-load-more class="bg-[#2C2C2C] hover:bg-[#3C3C3C] text-white font-medium py-2.5 px-6 rounded-lg text-sm transition-colors inline-flex items-center gap-2 disabled:opacity-60">${LOAD_ALL_BUTTON_HTML}</button>
            <p class="text-xs text-gray-500 mt-2">Showing recent activity. Click to load complete history.</p>
        </div>` : '';
    container.innerHTML = html + loadMore;
    if (!container.dataset.loadMoreBound) {
        container.dataset.loadMoreBound = '1';
        container.addEventListener('click', (e) => {
            const button = e.target.closest('[data-onchain-load-more]');
            if (button) loadAllOnchainHistory(button);
        });
    }
}

/**
 * Render sponsorship charts - unified chart with pill toggles
 */
