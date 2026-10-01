// The operator page: details, delegators, sponsorships, charts and the stats panel
import { escapeHtml, formatBigNumber, convertWeiToData, createAddressLink, createEntityLink, createDelegatorLink, parseOperatorMetadata, calculateWeightedApy, avatarImgHtml } from '../core/utils.js';
import { getMaticBalance } from '../core/services.js';
import { initLeafletMap } from './nodeMap.js';
import { updateProfileButton } from './profileShortcut.js';
import Chart from 'chart.js/auto';

export const detailContent = document.getElementById('detail-content');

// --- Module State ---
let stakeHistoryChart = null;

// --- Detail View Rendering ---

export async function renderBalances(addresses) {
    const uniqueAddresses = [...new Set(addresses)];
    for (const address of uniqueAddresses) {
        const balance = await getMaticBalance(address);
        const formattedBalance = `${balance} POL`;
        document.querySelectorAll(`#agent-balance-${address}, #node-balance-${address}`).forEach(el => {
            if (el) el.textContent = formattedBalance;
        });
    }
}

export function updateDelegatorsSection(delegations, totalDelegatorCount, operatorData = null) {
    const listEl = document.getElementById('delegators-list');
    const footerEl = document.getElementById('delegators-footer');
    if (!listEl || !footerEl) return;

    // Calculate exchange rate from operator data for real-time value
    // exchangeRate = valueWithoutEarnings / operatorTokenTotalSupply
    let exchangeRateNum = 1;
    if (operatorData && operatorData.operatorTokenTotalSupplyWei && operatorData.valueWithoutEarnings) {
        const totalSupply = BigInt(operatorData.operatorTokenTotalSupplyWei);
        const valueWithoutEarnings = BigInt(operatorData.valueWithoutEarnings);
        if (totalSupply > 0n) {
            // exchangeRate as a ratio (multiply by 1e18 for precision)
            exchangeRateNum = Number(valueWithoutEarnings * BigInt(1e18) / totalSupply) / 1e18;
        }
    }

    listEl.innerHTML = delegations.map(delegation => {
        // Calculate current DATA value: operatorTokenBalanceWei * exchangeRate
        let currentDataValue;
        if (delegation.operatorTokenBalanceWei && exchangeRateNum !== 1) {
            const tokenBalance = BigInt(delegation.operatorTokenBalanceWei);
            // currentValue = tokenBalance * valueWithoutEarnings / totalSupply
            if (operatorData && operatorData.operatorTokenTotalSupplyWei && operatorData.valueWithoutEarnings) {
                const totalSupply = BigInt(operatorData.operatorTokenTotalSupplyWei);
                const valueWithoutEarnings = BigInt(operatorData.valueWithoutEarnings);
                if (totalSupply > 0n) {
                    const currentValueWei = tokenBalance * valueWithoutEarnings / totalSupply;
                    currentDataValue = convertWeiToData(currentValueWei.toString());
                } else {
                    currentDataValue = convertWeiToData(delegation._valueDataWei);
                }
            } else {
                currentDataValue = convertWeiToData(delegation._valueDataWei);
            }
        } else {
            currentDataValue = convertWeiToData(delegation._valueDataWei);
        }
        
        return `
        <li class="flex justify-between items-center py-2 border-b border-[#333333]">
            <div class="font-mono text-xs text-gray-300 truncate">${createDelegatorLink(delegation.delegator.id)}</div>
            <div class="text-right"><span class="font-mono text-xs text-green-400 block" data-tooltip-value="${currentDataValue}">${formatBigNumber(currentDataValue)} DATA</span></div>
        </li>`;
    }).join('');

    footerEl.innerHTML = '';
    if (delegations.length < (totalDelegatorCount - 1)) {
        footerEl.innerHTML = `<div class="flex justify-center"><button id="load-more-delegators-btn" class="bg-[#2C2C2C] hover:bg-[#3A3A3A] text-white font-medium py-2.5 px-8 rounded-lg transition-colors text-sm">Load More</button></div>`;
    }
}

export function renderSponsorshipsHistory(historyGroups, showLoadAllButton = true, context = 'sponsorships') {
    const listEl = document.getElementById('sponsorships-history-list');
    if (!listEl) return;

    if (historyGroups.length === 0) {
        listEl.innerHTML = '<li class="text-gray-500 text-sm p-4 text-center">No recent activity found from The Graph or Polygonscan.</li>';
        return;
    }

    let html = historyGroups.map(group => {
        const date = new Date(group.timestamp * 1000).toLocaleString();

        // badge: the merged transfer's badge (see clusters below) instead of the info icon
        const graphRowHtml = (event, badge = null) => {
            const sp = event.relatedObject;
            if (!sp) return '';
            const streamId = sp.stream?.id || '';
            const sponsorshipId = sp.id;
            const sponsorshipDisplayText = escapeHtml(streamId || sponsorshipId);
            // Internal link to Sponsorship Details page
            const link = streamId 
                ? `<a href="#" class="sponsorship-link text-gray-300 hover:text-white transition-colors" data-stream-id="${escapeHtml(streamId)}" data-sponsorship-id="${escapeHtml(sponsorshipId)}" title="${sponsorshipDisplayText}">${sponsorshipDisplayText}</a>`
                : `<a href="https://polygonscan.com/address/${sponsorshipId}" target="_blank" rel="noopener noreferrer" class="text-gray-300 hover:text-white transition-colors" title="${sponsorshipDisplayText}">${sponsorshipDisplayText}</a>`;
            // Stake change (computeStakeChanges); rows with an unknown change keep the resulting stake
            const actions = { stake: 'Staked', reduce: 'Stake reduced', earnings: 'Earnings collected', unstake: 'Unstaked' };
            const action = actions[event.stakeChange] || 'Action';
            const actionHtml = event.txHash && /^0x[0-9a-fA-F]{64}$/.test(event.txHash)
                ? `<a href="https://polygonscan.com/tx/${event.txHash}" target="_blank" rel="noopener noreferrer" class="hover:text-white transition-colors">${action}</a>`
                : action;
            // Merged rows (badge) sit under "Action on <sponsorship>": no need to repeat it
            const text = badge ? actionHtml : `${actionHtml} ${event.stakeChange === 'unstake' ? 'from' : 'on'} ${link}`;
            let amountHtml;
            if (event.stakeChange === 'earnings') {
                amountHtml = `<p class="font-mono text-sm text-gray-500" data-tooltip-content="Stake unchanged: ${formatBigNumber(Math.round(event.amount).toString())} DATA">—</p>`;
            } else if (event.stakeChange) {
                // From the operator's side: staking moves DATA out of the operator (−), reducing / unstaking back in (+)
                const sign = event.stakeDelta > 0 ? '−' : '+';
                const abs = Math.round(Math.abs(event.stakeDelta));
                // Tooltip: value (USD), then the stake in the sponsorship before and after (one per line)
                const stakeAfter = Math.max(0, Math.round(event.amount));
                const stakeBefore = Math.max(0, Math.round(event.amount - event.stakeDelta));
                const extra = `Stake before: ${formatBigNumber(stakeBefore.toString())} DATA|Stake after: ${formatBigNumber(stakeAfter.toString())} DATA`;
                amountHtml = `<p class="font-mono text-sm text-white" data-tooltip-value="${abs}" data-tooltip-extra="${escapeHtml(extra)}">${sign} ${formatBigNumber(abs.toString())} ${escapeHtml(event.token)}</p>`;
            } else {
                amountHtml = `<p class="font-mono text-sm text-white" ${event.token.toUpperCase() === 'DATA' ? `data-tooltip-value="${Math.round(event.amount)}"` : ''}>${formatBigNumber(Math.round(event.amount).toString())} ${escapeHtml(event.token)}</p>`;
            }
            const icon = '<svg class="w-5 h-5 text-gray-400" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"></path></svg>';

            return `
            <div class="flex ${badge ? 'items-center' : 'items-start'} gap-3 py-2">
                <div class="flex-shrink-0 ${badge ? '' : 'pt-1'}">${badge || icon}</div>
                <div class="flex-1 min-w-0">
                    <p class="text-sm text-gray-300 truncate">${text}</p>
                </div>
                <div class="text-right flex-shrink-0">
                    ${amountHtml}
                </div>
            </div>`;
        };

        // First line of an action merged with its transfer: "(i) Action on <sponsorship>"
        const actionHeaderHtml = (event) => {
            const icon = '<svg class="w-5 h-5 text-gray-400" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"></path></svg>';
            const action = event.txHash && /^0x[0-9a-fA-F]{64}$/.test(event.txHash)
                ? `<a href="https://polygonscan.com/tx/${event.txHash}" target="_blank" rel="noopener noreferrer" class="hover:text-white transition-colors">Action</a>`
                : 'Action';
            return `
            <div class="flex items-start gap-3 py-2">
                <div class="flex-shrink-0 pt-1">${icon}</div>
                <div class="flex-1 min-w-0">
                    <p class="text-sm text-gray-300 truncate">${action} on ${sponsorshipLinkHtml(event.relatedObject)}</p>
                </div>
            </div>`;
        };

        const scanBadgeHtml = (event) => {
            let directionClass;
            const method = event.methodId;
            const stakeMethods = ["Stake", "Unstake", "Force Unstake", "Reduce Stake"];
            const redMethods = ["Undelegate", "Protocol Tax"];

            if (context === 'operators') {
                // Operators context - ALL stake operations should be orange
                if (stakeMethods.includes(method)) {
                    directionClass = "tx-badge-stake-out"; // Orange for ALL stake operations
                } else if (redMethods.includes(method)) {
                    directionClass = "tx-badge-out";
                } else if (event.relatedObject === "OUT") {
                    directionClass = "tx-badge-out";
                } else {
                    directionClass = "tx-badge-in";
                }
            } else {
                // Sponsorships context
                if (redMethods.includes(method)) {
                    directionClass = "tx-badge-out";
                } else if (method === 'Stake' && event.relatedObject === 'IN') {
                    directionClass = "tx-badge-stake"; // Green only for STAKE-IN in sponsorships
                } else if (['Unstake', 'Force Unstake', 'Reduce Stake'].includes(method)) {
                    directionClass = "tx-badge-out"; // Red for unstake operations in sponsorships
                } else if (event.relatedObject === "OUT") {
                    directionClass = "tx-badge-out";
                } else {
                    directionClass = "tx-badge-in";
                }
            }
            
            return `<span class="tx-badge ${directionClass}">${event.relatedObject}</span>`;
        };

        const sponsorshipLinkHtml = (sp) => {
            const streamId = sp?.stream?.id || '';
            const text = escapeHtml(streamId || sp?.id || '');
            return streamId
                ? `<a href="#" class="sponsorship-link text-gray-300 hover:text-white transition-colors" data-stream-id="${escapeHtml(streamId)}" data-sponsorship-id="${escapeHtml(sp.id)}" title="${text}">${text}</a>`
                : `<a href="https://polygonscan.com/address/${escapeHtml(sp?.id || '')}" target="_blank" rel="noopener noreferrer" class="text-gray-300 hover:text-white transition-colors" title="${text}">${text}</a>`;
        };

        // From the operator's side: earnings and delegations come in (+), the protocol tax and
        // undelegations go out (−)
        const SCAN_SIGNS = { 'Collect Earnings': '+ ', 'Delegate': '+ ', 'Protocol Tax': '− ', 'Undelegate': '− ' };
        const scanSign = (event) => SCAN_SIGNS[event.methodId] || '';

        // sponsorship: shown after the method ("Collect Earnings on X") when merged with its action
        const scanRowHtml = (event, sponsorship = null) => {
            const txUrl = `https://polygonscan.com/tx/${event.txHash}`;
            const methodLink = `<a href="${txUrl}" target="_blank" rel="noopener noreferrer" class="text-sm font-medium text-gray-300 hover:text-white transition-colors">${escapeHtml(event.methodId)}</a>`;

            return `
            <div class="flex items-center gap-3 py-2">
                <div class="flex-shrink-0">
                    ${scanBadgeHtml(event)}
                </div>
                <div class="flex-1 min-w-0">
                    ${sponsorship
                        ? `<p class="text-sm text-gray-300 truncate">${methodLink} on ${sponsorshipLinkHtml(sponsorship)}</p>`
                        : `<div class="truncate">${methodLink}</div>`}
                </div>
                <div class="text-right flex-shrink-0">
                    <p class="font-mono text-sm text-white" ${event.token.toUpperCase() === 'DATA' ? `data-tooltip-value="${Math.round(event.amount)}"` : ''}>${scanSign(event)}${formatBigNumber(Math.round(event.amount).toString())} ${escapeHtml(event.token)}</p>
                </div>
            </div>`;
        };

        // One block per transaction: the sponsorship action (The Graph, or the full exit built from
        // Polygonscan) followed by its token transfers; transactions without an action keep their rows
        const clusters = [];
        const byHash = new Map();
        for (const event of group.events) {
            const key = event.txHash ? event.txHash.toLowerCase() : `no-hash-${clusters.length}`;
            let cluster = byHash.get(key);
            if (!cluster) {
                cluster = { graph: [], scan: [] };
                byHash.set(key, cluster);
                clusters.push(cluster);
            }
            (event.type === 'graph' ? cluster.graph : cluster.scan).push(event);
        }
        // Clusters with an action first, in their original order
        clusters.sort((a, b) => (b.graph.length > 0) - (a.graph.length > 0));

        // An action and its transfer are the same movement (same amount): two lines in the action block,
        // "(i) Action on <sponsorship>" and the transfer with the action text and signed amount
        // ("[OUT] Staked on X +N"; "[IN] Collect Earnings on X" when the stake didn't change).
        const matchingMethods = {
            stake: ['Stake'],
            reduce: ['Reduce Stake'],
            unstake: ['Unstake', 'Force Unstake', 'Reduce Stake'],
            earnings: ['Collect Earnings']
        };
        const clustersHtml = clusters.map((cluster, index) => {
            const merged = new Set();
            // Each action is its own block: a short, slightly thicker bar on the left, rows close
            // together, and some space between blocks
            const actionBlocks = [];
            for (const event of cluster.graph) {
                const methods = matchingMethods[event.stakeChange];
                const match = methods && cluster.scan.find(t => !merged.has(t) && methods.includes(t.methodId) && t.token === 'DATA'
                    && (event.stakeChange === 'earnings' || Math.abs(Math.abs(t.amount) - Math.abs(event.stakeDelta)) < 1));
                if (!match) {
                    actionBlocks.push(graphRowHtml(event));
                    continue;
                }
                merged.add(match);
                actionBlocks.push(actionHeaderHtml(event) + (event.stakeChange === 'earnings'
                    ? scanRowHtml(match)
                    : graphRowHtml(event, scanBadgeHtml(match))));
            }
            // The other transfers of the same transaction (Protocol Tax, earnings...) belong to its action
            const otherTransfers = cluster.scan.filter(t => !merged.has(t)).map(t => scanRowHtml(t)).join('');
            if (actionBlocks.length > 0 && otherTransfers) actionBlocks[actionBlocks.length - 1] += otherTransfers;
            const graphHtml = actionBlocks.map(block => `
                <div class="relative pl-4 [&>div]:py-1.5 before:content-[''] before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[3px] before:rounded-full before:bg-[#444]">${block}</div>`).join('');
            const scanHtml = actionBlocks.length > 0 ? '' : otherTransfers;
            return `
                <div class="${index > 0 ? 'mt-2' : ''}">
                    ${graphHtml ? `<div class="space-y-2">${graphHtml}</div>` : ''}
                    ${scanHtml ? `<div class="pl-4">${scanHtml}</div>` : ''}
                </div>`;
        }).join('');

        return `
        <li class="py-3 border-b border-[#333333]">
            <p class="text-xs text-gray-400 font-mono mb-2">${date}</p>
            <div>${clustersHtml}</div>
        </li>`;
    }).join('');
    
    if (showLoadAllButton) {
        html += `
            <li id="load-all-history-container" class="py-4 text-center">
                <button id="load-all-history-btn" 
                        class="bg-[#2C2C2C] hover:bg-[#3C3C3C] text-white font-medium py-2.5 px-6 rounded-lg text-sm transition-colors inline-flex items-center gap-2">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path>
                    </svg>
                    Load All History
                </button>
                <p class="text-xs text-gray-500 mt-2">Showing recent activity. Click to load complete history.</p>
            </li>`;
    }
    
    listEl.innerHTML = html;
}

export function renderStakeChart(chartData, isUsdView) {
    const container = document.getElementById('stake-chart-container');
    if (!container) return;

    // Destroy other chart types first
    if (operatorEarningsChart) {
        operatorEarningsChart.destroy();
        operatorEarningsChart = null;
    }

    if (!chartData || chartData.length === 0) {
        if (stakeHistoryChart) {
            stakeHistoryChart.destroy();
            stakeHistoryChart = null;
        }
        container.innerHTML = '<div class="flex items-center justify-center h-full"><p class="text-gray-500">No daily data available for this timeframe.</p></div>';
        return;
    }

    const labels = chartData.map(d => d.label);
    const data = chartData.map(d => d.value);

    const chartLabel = isUsdView ? 'Total Stake (USD)' : 'Total Stake (DATA)';
    const yAxisPrefix = isUsdView ? '$' : '';
    const yAxisSuffix = isUsdView ? '' : ' DATA';

    // Função auxiliar para criar o gradiente
    const createGradient = (ctx) => {
        const gradient = ctx.createLinearGradient(0, 0, 0, 300);
        gradient.addColorStop(0, 'rgba(59, 130, 246, 0.5)'); // Top color
        gradient.addColorStop(1, 'rgba(59, 130, 246, 0.0)'); // Bottom transparency
        return gradient;
    };

    // Configurações de estilo (Options)
    const chartOptions = {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
            mode: 'index',
            intersect: false,
        },
        plugins: {
            legend: {
                display: false
            },
            tooltip: {
                backgroundColor: 'rgba(30, 30, 30, 0.9)', // Fundo escuro minimalista 
                titleColor: '#ffffff',
                bodyColor: '#9ca3af', // Gray-400
                borderColor: '#333333',
                borderWidth: 1,
                padding: 10,
                cornerRadius: 8,
                displayColors: false, // Remove caixa de cor
                titleFont: {
                    family: "'Inter', sans-serif",
                    size: 13,
                    weight: '600'
                },
                bodyFont: {
                    family: "'Inter', sans-serif",
                    size: 13
                },
                callbacks: {
                    label: function (context) {
                        let label = '';
                        if (context.parsed.y !== null) {
                            label += yAxisPrefix + formatBigNumber(Math.round(context.parsed.y).toString()) + yAxisSuffix;
                        }
                        return label;
                    }
                }
            }
        },
        scales: {
            x: {
                ticks: {
                    color: '#6b7280', // Gray-500
                    maxTicksLimit: 8,
                    maxRotation: 0,
                    autoSkip: true,
                    font: {
                        family: "'Inter', sans-serif",
                        size: 11
                    }
                },
                grid: {
                    display: false // Remove grelha vertical
                }
            },
            y: {
                position: 'left',
                ticks: {
                    color: '#6b7280', // Gray-500
                    callback: function (value) {
                        if (value >= 1000000) return yAxisPrefix + (value / 1000000).toFixed(1) + 'M';
                        if (value >= 1000) return yAxisPrefix + (value / 1000).toFixed(0) + 'K';
                        return yAxisPrefix + Math.round(value);
                    },
                    font: {
                        family: "'Inter', sans-serif",
                        size: 11
                    }
                },
                grid: {
                    color: '#333333',
                    borderDash: [4, 4], // Grelha horizontal tracejada subtil
                    drawBorder: false
                }
            }
        }
    };

    // Always destroy and recreate to avoid stale data issues
    if (stakeHistoryChart) {
        stakeHistoryChart.destroy();
        stakeHistoryChart = null;
    }
    
    container.innerHTML = '<canvas id="stake-history-chart"></canvas>';
    const canvas = document.getElementById('stake-history-chart');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    stakeHistoryChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: chartLabel,
                data: data,
                backgroundColor: createGradient(ctx),
                borderColor: '#3b82f6', // Blue-500
                borderWidth: 2,
                pointBackgroundColor: '#3b82f6',
                pointBorderColor: '#232c45ff', 
                pointBorderWidth: 0.5,
                pointRadius: 2.5,
                pointHoverRadius: 4,
                tension: 0.25, 
                fill: true
            }]
        },
        options: chartOptions
    });
}

// Operator Earnings Chart instance
let operatorEarningsChart = null;

/**
 * Render Operator Earnings Chart (daily bars + cumulative line)
 */
export function renderOperatorEarningsChart(labels, dailyData, cumulativeData, isUsdView, currentPrice) {
    const container = document.getElementById('stake-chart-container');
    if (!container) return;

    if (operatorEarningsChart) {
        operatorEarningsChart.destroy();
        operatorEarningsChart = null;
    }
    if (stakeHistoryChart) {
        stakeHistoryChart.destroy();
        stakeHistoryChart = null;
    }

    if (!labels || labels.length === 0) {
        container.innerHTML = '<div class="flex items-center justify-center h-full"><p class="text-gray-500">No earnings data available for this timeframe.</p></div>';
        return;
    }

    container.innerHTML = '<canvas id="stake-history-chart"></canvas>';
    const canvas = document.getElementById('stake-history-chart');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const yAxisPrefix = isUsdView ? '$' : '';
    const yAxisSuffix = isUsdView ? '' : ' DATA';

    operatorEarningsChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                { 
                    label: 'Daily', 
                    data: dailyData, 
                    backgroundColor: 'rgba(59, 130, 246, 0.5)', 
                    borderRadius: 2, 
                    yAxisID: 'y',
                    order: 2
                },
                { 
                    label: 'Total', 
                    data: cumulativeData, 
                    type: 'line', 
                    borderColor: '#3b82f6',
                    borderWidth: 2,
                    pointBackgroundColor: '#3b82f6',
                    pointBorderColor: '#232c45ff',
                    pointBorderWidth: 0.5,
                    pointRadius: 2.5,
                    pointHoverRadius: 4,
                    tension: 0.25,
                    fill: false,
                    yAxisID: 'y1',
                    order: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'nearest',
                intersect: true,
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(30, 30, 30, 0.9)',
                    titleColor: '#ffffff',
                    bodyColor: '#9ca3af',
                    borderColor: '#333333',
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 8,
                    displayColors: false,
                    titleFont: { family: "'Inter', sans-serif", size: 13, weight: '600' },
                    bodyFont: { family: "'Inter', sans-serif", size: 13 },
                    callbacks: {
                        label: (context) => {
                            const value = context.raw;
                            const lines = [];
                            // Format DATA value with appropriate decimals
                            const formatted = formatBigNumber(Math.round(value).toString());
                            lines.push(`${formatted} DATA`);
                            // Show USD using live current price
                            if (currentPrice && currentPrice > 0) {
                                const usdValue = value * currentPrice;
                                if (usdValue < 10) {
                                    lines.push(`~$${usdValue.toFixed(2)}`);
                                } else {
                                    lines.push(`~$${formatBigNumber(Math.round(usdValue).toString())}`);
                                }
                            }
                            return lines;
                        }
                    }
                }
            },
            scales: {
                y: {
                    position: 'left', 
                    grid: { color: '#333333', borderDash: [4, 4], drawBorder: false }, 
                    ticks: { 
                        color: '#6b7280', 
                        font: { family: "'Inter', sans-serif", size: 11 },
                        callback: function(value) {
                            if (value >= 1000000) return yAxisPrefix + (value / 1000000).toFixed(1) + 'M';
                            if (value >= 1000) return yAxisPrefix + (value / 1000).toFixed(0) + 'K';
                            return yAxisPrefix + Math.round(value) + yAxisSuffix;
                        }
                    }, 
                    border: { display: false } 
                },
                y1: { 
                    position: 'right', 
                    beginAtZero: false,
                    grid: { display: false }, 
                    ticks: { 
                        color: '#3b82f6', 
                        font: { family: "'Inter', sans-serif", size: 11 },
                        callback: function(value) {
                            if (value >= 1000000) return yAxisPrefix + (value / 1000000).toFixed(1) + 'M';
                            if (value >= 1000) return yAxisPrefix + (value / 1000).toFixed(0) + 'K';
                            return yAxisPrefix + Math.round(value);
                        }
                    }, 
                    border: { display: false } 
                },
                x: { 
                    grid: { display: false }, 
                    ticks: { 
                        color: '#6b7280', 
                        maxTicksLimit: 8, 
                        maxRotation: 0,
                        font: { family: "'Inter', sans-serif", size: 11 } 
                    }, 
                    border: { display: false } 
                }
            }
        }
    });
}

/**
 * Update the earnings display for a specific sponsorship
 * @param {string} sponsorshipId - The sponsorship contract address (lowercase)
 * @param {string} earningsWei - The earnings amount in wei
 * @param {number|null} dataPriceUSD - Current DATA price in USD for tooltip
 */
export function updateSponsorshipEarningsDisplay(sponsorshipId, earningsWei, dataPriceUSD = null) {
    const element = document.getElementById(`earnings-${sponsorshipId.toLowerCase()}`);
    if (!element) return;
    
    const earningsData = convertWeiToData(earningsWei);
    const formattedData = formatBigNumber(earningsData);
    
    // Calculate USD value for tooltip
    let tooltipValue = earningsData;
    if (dataPriceUSD && dataPriceUSD > 0) {
        const usdValue = parseFloat(earningsData) * dataPriceUSD;
        tooltipValue = `${earningsData} DATA ≈ $${usdValue.toFixed(2)} USD`;
    }
    
    // Update the element
    element.textContent = `${formattedData} DATA`;
    element.setAttribute('data-tooltip-value', tooltipValue);
}


export function renderOperatorDetails(data, globalState) {
    if (stakeHistoryChart) {
        stakeHistoryChart.destroy();
        stakeHistoryChart = null;
    }

    const { operator: op, selfDelegation: selfDelegationData, flagsAgainst, flagsAsFlagger, slashingEvents } = data;
    if (!op) {
        detailContent.innerHTML = '<p class="text-gray-500">Operator not found.</p>';
        return;
    }

    let { name, description, imageUrl } = parseOperatorMetadata(op.metadataJsonString);
    if (imageUrl && !imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
        imageUrl = null;
    }
    const safeOperatorName = escapeHtml(name || op.id);

    let redundancyFactor = '1 (Default)';
    try {
        if (op.metadataJsonString) {
            const meta = JSON.parse(op.metadataJsonString);
            if (meta && meta.redundancyFactor !== undefined) {
                redundancyFactor = meta.redundancyFactor;
            }
        }
    } catch (e) { console.error("Could not parse redundancy factor from metadata", e); }


    const apy = calculateWeightedApy(op.stakes);
    const roundedApy = Math.round(apy * 100);
    const apyColorClass = roundedApy === 0 ? 'text-red-400' : 'text-green-400';
    const ownersCutPercent = (BigInt(op.operatorsCutFraction) * 100n) / BigInt('1000000000000000000');
    
    const myAddress = globalState.myRealAddress?.toLowerCase();
    const isOwner = myAddress && op.owner && myAddress === op.owner.toLowerCase();
    // Operator settings are for the owner only (not controllers / agent wallets)
    const editSettingsButtonHtml = isOwner ? `
        <div class="mb-4">
            <button id="edit-operator-settings-btn" class="bg-gray-700 hover:bg-gray-600 text-white font-bold py-2 px-4 rounded-lg transition-colors flex items-center text-sm">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                  <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                </svg>
                Edit Settings
            </button>
        </div>
    ` : '';

    const headerStatsHtml = `
        <div class="detail-section px-4 sm:px-6 pt-4 sm:pt-6 pb-2">
            <div class="flex items-start gap-4 sm:gap-6">
                ${avatarImgHtml(imageUrl, { alt: 'Operator Avatar', className: 'w-14 h-14 sm:w-20 sm:h-20 border-2 border-[#333333]', attrs: description ? `data-tooltip-content="${escapeHtml(description)}"` : '' })}
                <div class="flex-1 min-w-0">
                    <h2 class="text-lg sm:text-2xl lg:text-3xl font-bold text-white break-words" ${description ? `data-tooltip-content="${escapeHtml(description)}"` : ''}>${safeOperatorName}</h2>
                    ${name ? `<div class="font-mono text-xs sm:text-sm text-gray-400 mt-1 break-all">${createAddressLink(op.id)}</div>` : ''}
                </div>
                <div class="flex-shrink-0 text-right">
                    <p class="text-xs sm:text-sm text-gray-400 font-semibold mb-1">APY</p>
                    <p class="text-2xl sm:text-3xl lg:text-4xl font-extrabold ${apyColorClass} whitespace-nowrap">${Math.round(apy * 100)}%</p>
                </div>
            </div>
            <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-6 mt-4 sm:mt-6">
                <div><p class="text-xs sm:text-sm text-gray-400">Stake (DATA)</p><p id="header-stat-stake" class="text-lg sm:text-2xl font-semibold text-white"></p></div>
                <div><p class="text-xs sm:text-sm text-gray-400">Total Earnings (DATA)</p><p id="header-stat-earnings" class="text-lg sm:text-2xl font-semibold text-white"></p></div>
                <div><p class="text-xs sm:text-sm text-gray-400">% Owner's Cut</p><p id="header-stat-cut" class="text-lg sm:text-2xl font-semibold text-white"></p></div>
                <div><p class="text-xs sm:text-sm text-gray-400">Nodes</p><p id="active-nodes-stats-value" class="text-lg sm:text-2xl font-semibold text-white">0</p></div>
            </div>
            <div id="extended-stats" class="hidden mt-4 sm:mt-6">
                <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-6">
                    <div><p class="text-xs sm:text-sm text-gray-400">Total Distributed (DATA)</p><p id="extended-stat-distributed" class="text-lg sm:text-2xl font-semibold text-white"></p></div>
                    <div><p class="text-xs sm:text-sm text-gray-400">Owner's Earnings from Cut (DATA)</p><p id="extended-stat-owner-cut" class="text-lg sm:text-2xl font-semibold text-white"></p></div>
                    <div><p class="text-xs sm:text-sm text-gray-400">Deployed Stake (DATA)</p><p id="extended-stat-deployed" class="text-lg sm:text-2xl font-semibold text-white"></p></div>
                    <div><p class="text-xs sm:text-sm text-gray-400">% Owner's Stake</p><p id="extended-stat-owner-stake" class="text-lg sm:text-2xl font-semibold text-white"></p></div>
                </div>
            </div>
            <div class="mt-4 text-center"><button id="toggle-stats-btn" class="text-gray-400 hover:text-white transition"><svg id="stats-arrow" class="w-6 h-6 mx-auto transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 9l-7 7-7-7"></path></svg></button></div>
        </div>
        
        <div class="detail-section p-6 mt-8">
            <div class="flex flex-col gap-2 mb-4">
                <div class="flex justify-between items-center flex-wrap gap-2">
                    <div id="chart-type-tabs" class="flex bg-[#2C2C2C] p-1 rounded-lg">
                        <button data-chart-type="stake" class="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-800 text-white transition-colors">Stake</button>
                        <button data-chart-type="earnings" class="px-3 py-1.5 text-xs font-medium rounded-md text-gray-400 hover:text-white transition-colors">Earnings</button>
                    </div>
                    <div id="chart-view-buttons" class="flex items-center gap-1 bg-[#2C2C2C] p-1 rounded-lg">
                        <button data-view="data" class="px-3 py-1 text-xs font-bold rounded-md hover:bg-[#444444] transition">DATA</button>
                        <button data-view="usd" class="px-3 py-1 text-xs font-bold rounded-md hover:bg-[#444444] transition">USD</button>
                    </div>
                    <span id="chart-info-tooltip" class="relative group cursor-help hidden">
                        <svg class="w-4 h-4 text-gray-500 hover:text-gray-400 transition-colors" fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/>
                        </svg>
                        <span class="absolute bottom-full right-0 mb-2 px-3 py-2 text-xs font-normal text-gray-300 bg-[#1a1a1a] border border-[#333] rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
                            USD values based on current price
                        </span>
                    </span>
                </div>
                <div class="flex justify-end">
                    <div id="chart-timeframe-buttons" class="flex items-center gap-1 bg-[#2C2C2C] p-1 rounded-lg">
                        <button data-days="30" class="px-3 py-1 text-xs font-bold rounded-md hover:bg-[#444444] transition">30D</button>
                        <button data-days="90" class="px-3 py-1 text-xs font-bold rounded-md hover:bg-[#444444] transition">90D</button>
                        <button data-days="365" class="px-3 py-1 text-xs font-bold rounded-md hover:bg-[#444444] transition">1Y</button>
                        <button data-days="all" class="px-3 py-1 text-xs font-bold rounded-md hover:bg-[#444444] transition">All</button>
                    </div>
                </div>
            </div>
            <div id="stake-chart-container" class="h-64">
                <canvas id="stake-history-chart"></canvas>
            </div>
        </div>

        <div id="my-stake-section" class="detail-section p-4 sm:p-6 hidden">
             <h3 class="text-lg sm:text-xl font-semibold text-white mb-4">Your Stake</h3>
             <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                 <div><p class="text-2xl sm:text-3xl font-semibold text-white" id="my-stake-value" data-tooltip-value="0">Loading...</p></div>
                 <div class="flex gap-2 sm:gap-4">
                     <button id="delegate-btn" class="flex-1 sm:flex-none bg-blue-800 hover:bg-blue-900 text-white font-bold py-2.5 px-4 sm:px-6 rounded-lg transition-colors text-sm sm:text-base">Delegate</button>
                     <button id="undelegate-btn" class="flex-1 sm:flex-none bg-blue-800 hover:bg-blue-900 text-white font-bold py-2.5 px-4 sm:px-6 rounded-lg transition-colors text-sm sm:text-base">Undelegate</button>
                 </div>
             </div>
        </div>`;

    const isAgent = globalState.myRealAddress && op.controllers?.some(agent => agent.toLowerCase() === globalState.myRealAddress.toLowerCase());

    const sponsorshipsHtml = op.stakes?.length > 0 ? op.stakes.map(stake => {
        const sp = stake.sponsorship;
        if (!sp) return '';
        const sponsorshipDisplayText = escapeHtml(sp.stream?.id || sp.id);
        const streamId = sp.stream?.id || sp.id;
        const sponsorshipIdLower = sp.id.toLowerCase();
        const editStakeLink = isAgent
            ? `<a href="#" class="block px-4 py-2 text-sm text-gray-200 hover:bg-[#444444] edit-stake-link" data-sponsorship-id="${sp.id}" data-current-stake="${stake.amountWei}">Edit Stake</a>`
            : `<span class="block px-4 py-2 text-sm text-gray-500 opacity-50 cursor-not-allowed" data-tooltip-content="You must be an agent for this operator to edit stake.">Edit Stake</span>`;

        return `
            <li class="relative flex justify-between items-center py-3 border-b border-[#333333]">
                <div class="flex-1 min-w-0">
                    <a href="#" class="font-mono text-xs text-gray-300 hover:text-white transition-colors truncate block sponsorship-link" data-sponsorship-id="${sp.id}" data-stream-id="${escapeHtml(streamId)}" title="${sponsorshipDisplayText}">${sponsorshipDisplayText}</a>
                    <div class="text-xs mt-2 space-y-1">
                        <div class="flex justify-between items-center"><span class="text-gray-400">Staked:</span><strong class="text-white font-mono" data-tooltip-value="${convertWeiToData(stake.amountWei)}">${formatBigNumber(convertWeiToData(stake.amountWei))} DATA</strong></div>
                        <div class="flex justify-between items-center"><span class="text-gray-400">Uncollected Earnings:</span><span id="earnings-${sponsorshipIdLower}" class="text-white font-mono earnings-ticker" data-tooltip-value="0"><span class="earnings-spinner"></span></span></div>
                        <div class="flex justify-between items-center"><span class="text-gray-400">APY:</span><strong class="${Math.round(Number(sp.spotAPY) * 100) === 0 ? 'text-red-400' : 'text-green-400'} font-mono">${Math.round(Number(sp.spotAPY) * 100)}%</strong></div>
                        <div class="flex justify-between items-center"><span class="text-gray-400">Status:</span><strong class="${Math.round(Number(sp.spotAPY) * 100) > 0 ? 'text-green-400' : 'text-red-400'} font-semibold">${Math.round(Number(sp.spotAPY) * 100) > 0 ? 'Active' : 'Inactive'}</strong></div>
                    </div>
                </div>
                <div class="flex-shrink-0 ml-4">
                        <button class="text-gray-400 hover:text-white p-1 toggle-sponsorship-menu-btn" data-sponsorship-id="${sp.id}"><svg class="h-5 w-5 pointer-events-none" viewBox="0 0 20 20" fill="currentColor"><path d="M7 10l5 5 5-5H7z"/></svg></button>
                    <div id="sponsorship-menu-${sp.id}" class="hidden absolute right-0 w-48 bg-[#2C2C2C] border border-[#333333] rounded-md shadow-lg z-20">
                        ${editStakeLink}
                        <a href="#" class="block px-4 py-2 text-sm text-gray-200 hover:bg-[#444444] collect-earnings-link" data-sponsorship-id="${sp.id}">Collect Earnings</a>
                    </div>
                </div>
            </li>`;
    }).join('') : '<li class="text-gray-500 text-sm">Not participating in any sponsorships.</li>';

    const slashesHtml = slashingEvents.length > 0 ? slashingEvents.map(slash => {
        const sp = slash.sponsorship;
        let sponsorshipHtml = '<p class="text-xs text-gray-400">Sponsorship: Unknown</p>';
        if (sp) {
            const sponsorshipUrl = `https://streamr.network/hub/network/sponsorships/${sp.id}`;
            const sponsorshipDisplayText = escapeHtml(sp.stream?.id || sp.id);
            sponsorshipHtml = `<p class="text-xs text-gray-400 truncate">Sponsorship: <a href="${sponsorshipUrl}" target="_blank" rel="noopener noreferrer" class="text-gray-300 hover:text-white transition-colors" title="${sponsorshipDisplayText}">${sponsorshipDisplayText}</a></p>`;
        }
        const slashDate = new Date(slash.date * 1000);
        const slashDateStr = slashDate.toLocaleDateString() + ', ' + slashDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        return `
            <li class="py-3 border-b border-[#333333]">
                <p class="text-xs text-gray-400 mb-1">Date: <span class="text-gray-300">${slashDateStr}</span></p>
                <p class="text-xs text-gray-400 mb-1">Slash: <span class="font-mono text-red-400 font-semibold" data-tooltip-value="${convertWeiToData(slash.amount)}">${formatBigNumber(convertWeiToData(slash.amount))} DATA</span></p>
                ${sponsorshipHtml}
            </li>`;
        }).join('') : '<li class="text-gray-500 text-sm">No slashing events recorded.</li>';

    const agentsHtml = op.controllers?.length > 0 ? op.controllers.map(agent => `
        <li class="flex justify-between items-center py-2 border-b border-[#333333]">
            <div class="font-mono text-xs text-gray-300 truncate">${createAddressLink(agent)}</div>
            <div class="flex items-center gap-2">
                <span id="agent-balance-${agent}" class="font-mono text-xs text-gray-300 text-right" title="POL Balance">...</span>
                ${op.owner && agent.toLowerCase() === op.owner.toLowerCase() ? `<div class="flex items-center" title="Owner"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd" /></svg></div>` : ''}
            </div>
        </li>`).join('') : '<li class="text-gray-500 text-sm">No agents assigned.</li>';

    const nodesHtml = op.nodes?.length > 0 ? op.nodes.map(nodeId => `
        <li class="flex justify-between items-center py-2 border-b border-[#333333]">
            <div class="font-mono text-xs text-gray-300 truncate">${createAddressLink(nodeId)}</div>
            <span id="node-balance-${nodeId}" class="font-mono text-xs text-gray-300 text-right" title="POL Balance">...</span>
        </li>`).join('') : '<li class="text-gray-500 text-sm">No nodes running.</li>';

    const queueHtml = op.queueEntries?.length > 0 ? op.queueEntries.map(entry => `
            <li class="py-2 border-b border-[#333333]">
            <div class="flex justify-between items-center">
                <div class="font-mono text-xs text-gray-300 truncate">${createAddressLink(entry.delegator.id)}</div>
                <p class="font-mono text-xs text-orange-400 font-semibold" data-tooltip-value="${convertWeiToData(entry.amount)}">${formatBigNumber(convertWeiToData(entry.amount))} DATA</p>
            </div>
            <div class="text-xs mt-1 text-gray-400"><p>Queued: ${new Date(entry.date * 1000).toLocaleString()}</p></div>
        </li>`).join('') : '<li class="text-gray-500 text-sm">The undelegation queue is empty.</li>';

    const createFlagHtml = (flag, isTarget) => {
        const sponsorshipUrl = `https://streamr.network/hub/network/sponsorships/${flag.sponsorship.id}`;
        const sponsorshipDisplayText = escapeHtml(flag.sponsorship.stream?.id || flag.sponsorship.id);
        const votesHtml = flag.votes.map(vote => `
            <li class="flex justify-between items-center text-xs py-1">
                <span>${createEntityLink(vote.voter)}</span>
                <div class="flex items-center gap-2">
                    <span class="font-mono" data-tooltip-value="${convertWeiToData(vote.voterWeight)}">${formatBigNumber(convertWeiToData(vote.voterWeight))}</span>
                    <span class="${vote.votedKick ? 'text-red-400' : 'text-green-400'} font-semibold">${vote.votedKick ? 'Kick' : 'Keep'}</span>
                </div>
            </li>
        `).join('');

        let resultText = flag.result || 'Pending';
        if (resultText.toUpperCase() === 'FAILED' || resultText.toUpperCase() === 'VOTE_FAILED') {
            resultText = 'False Flag';
        }

        const flagPartyText = isTarget
            ? `Flagged by: ${createEntityLink(flag.flagger)}`
            : `Flagged: ${createEntityLink(flag.target)}`;
			
		const flagDateObj = new Date(flag.flaggingTimestamp * 1000);
		const flagDate = flagDateObj.toLocaleDateString() + ', ' + flagDateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        return `
            <div class="flex justify-between items-center">
                <div>
				    <p class="text-xs text-gray-400 font-mono mb-1">${flagDate}</p>
                    <p class="text-xs text-gray-400">${flagPartyText}</p>
                    <p class="text-xs text-gray-400 truncate">Sponsorship: <a href="${sponsorshipUrl}" target="_blank" rel="noopener noreferrer" class="text-gray-300 hover:text-white transition-colors" title="${sponsorshipDisplayText}">${sponsorshipDisplayText}</a></p>
                        <p class="text-xs text-gray-400">Result: <span class="font-semibold">${resultText}</span></p>
                </div>
                <button class="text-gray-400 hover:text-white p-1 toggle-vote-list-btn" data-flag-id="${flag.id}"><svg class="w-5 h-5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 9l-7 7-7-7"></path></svg></button>
            </div>
            <ul id="votes-${flag.id}" class="hidden mt-2 pl-4 border-l-2 border-gray-700">${votesHtml || '<li class="text-xs text-gray-500">No votes.</li>'}</ul>`;
    };

    const flagsAgainstHtml = flagsAgainst?.length > 0 ? flagsAgainst.map(flag => `<li class="py-2 border-b border-[#333333]">${createFlagHtml(flag, true)}</li>`).join('') : '<li class="text-gray-500 text-sm">No flags recorded against this operator.</li>';
    const flagsByHtml = flagsAsFlagger?.length > 0 ? flagsAsFlagger.map(flag => `<li class="py-2 border-b border-[#333333]">${createFlagHtml(flag, false)}</li>`).join('') : '<li class="text-gray-500 text-sm">This operator has not flagged anyone.</li>';

    const listsHtml = `
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-8 mt-8">
            <!-- Delegators Card with Pills -->
            <div class="detail-section p-4 sm:p-6">
                <div class="flex items-center justify-between gap-3 mb-4">
                    <h3 class="text-lg sm:text-xl font-semibold text-white">Delegations</h3>
                    <div id="delegator-tabs" class="flex bg-[#2C2C2C] p-1 rounded-lg flex-shrink-0">
                        <button data-tab="delegators" class="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-800 text-white transition-colors">
                            Delegators <span class="opacity-70">(${op.delegatorCount > 0 ? op.delegatorCount - 1 : 0})</span>
                        </button>
                        <button data-tab="queue" class="px-3 py-1.5 text-xs font-medium rounded-md text-gray-400 hover:text-white transition-colors">
                            Queue <span class="opacity-70">(${op.queueEntries?.length || 0})</span>
                        </button>
                    </div>
                </div>
                <div id="delegators-content"><ul id="delegators-list" class="max-h-96 overflow-y-auto pr-2"></ul><div id="delegators-footer" class="mt-4"></div></div>
                <div id="queue-content" class="hidden">
                    ${op.queueEntries?.length > 0 ? `<button id="process-queue-btn" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-4 rounded-lg text-sm mb-4">Process Queue</button>` : ''}
                    <ul class="max-h-96 overflow-y-auto pr-2">${queueHtml}</ul>
                </div>
            </div>

            <!-- Sponsorships Card with Pills -->
            <div class="detail-section p-4 sm:p-6">
                <div class="flex items-center justify-between gap-3 mb-4">
                    <h3 class="text-lg sm:text-xl font-semibold text-white">Sponsorships</h3>
                    <div id="sponsorship-tabs" class="flex bg-[#2C2C2C] p-1 rounded-lg flex-shrink-0">
                        <button data-tab="list" class="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-800 text-white transition-colors">
                            Active <span class="opacity-70">(${op.stakes?.length || 0})</span>
                        </button>
                        <button data-tab="history" class="px-3 py-1.5 text-xs font-medium rounded-md text-gray-400 hover:text-white transition-colors">
                            History
                        </button>
                    </div>
                </div>
                <div id="sponsorships-list-content">
                    <ul class="max-h-96 overflow-y-auto pr-2">${sponsorshipsHtml}</ul>
                    <div class="mt-4 flex justify-center">
                        ${op.stakes?.length > 0 ? `<button id="collect-all-earnings-btn" class="bg-blue-800 hover:bg-blue-900 text-white font-medium py-2.5 px-8 rounded-lg text-sm">Collect All</button>` : ''}
                    </div>
                </div>
                <div id="sponsorships-history-content" class="hidden">
                    <ul id="sponsorships-history-list" class="max-h-96 overflow-y-auto pr-2"></ul>
                </div>
            </div>

            <!-- Reputation Card with Dropdown -->
            <div class="detail-section p-4 sm:p-6 lg:col-span-2">
                <div class="flex items-center justify-between gap-3 mb-4">
                    <h3 class="text-lg sm:text-xl font-semibold text-white">Reputation</h3>
                    <div class="relative flex-shrink-0">
                        <button id="reputation-dropdown-btn" class="flex items-center gap-2 bg-[#2C2C2C] px-3 py-1.5 rounded-lg text-xs font-medium text-white hover:bg-[#3C3C3C] transition-colors min-w-[160px] justify-between">
                            <span id="reputation-dropdown-text">Slashing Events (${slashingEvents.length})</span>
                            <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                        </button>
                        <div id="reputation-dropdown-menu" class="hidden absolute right-0 mt-1 w-48 bg-[#2C2C2C] border border-[#444444] rounded-lg shadow-xl z-20 overflow-hidden">
                            <button data-view="slashing" class="w-full px-3 py-2 text-left text-xs text-white hover:bg-[#3C3C3C] transition-colors bg-blue-800/30">
                                Slashing Events <span class="opacity-70">(${slashingEvents.length})</span>
                            </button>
                            <button data-view="flags-against" class="w-full px-3 py-2 text-left text-xs text-gray-300 hover:bg-[#3C3C3C] transition-colors">
                                Flags Against <span class="opacity-70">(${flagsAgainst?.length || 0})</span>
                            </button>
                            <button data-view="flags-by" class="w-full px-3 py-2 text-left text-xs text-gray-300 hover:bg-[#3C3C3C] transition-colors">
                                Flags Initiated <span class="opacity-70">(${flagsAsFlagger?.length || 0})</span>
                            </button>
                        </div>
                    </div>
                </div>
                <div id="reputation-content-wrapper" 
                    data-slashes-count="${slashingEvents.length}" 
                    data-flags-against-count="${flagsAgainst?.length || 0}" 
                    data-flags-by-count="${flagsAsFlagger?.length || 0}">
                    <div id="slashing-content"><ul class="max-h-96 overflow-y-auto pr-2">${slashesHtml}</ul></div>
                    <div id="flags-against-content" class="hidden"><ul class="max-h-96 overflow-y-auto pr-2">${flagsAgainstHtml}</ul></div>
                    <div id="flags-by-content" class="hidden"><ul class="max-h-96 overflow-y-auto pr-2">${flagsByHtml}</ul></div>
                </div>
            </div>

            <!-- Wallets Card with Pills -->
            <div class="detail-section p-4 sm:p-6 lg:col-span-2">
                <div class="flex items-center justify-between gap-3 mb-4">
                    <h3 class="text-lg sm:text-xl font-semibold text-white">Wallets</h3>
                    <div class="flex items-center gap-2 flex-shrink-0">
                    ${isOwner ? `<button id="manage-wallets-btn" type="button" class="flex items-center gap-1.5 bg-[#2C2C2C] hover:bg-[#3C3C3C] text-gray-300 hover:text-white px-3 py-2 rounded-lg text-xs font-medium transition-colors" title="Add or remove agent and node wallets">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z"/></svg>
                        <span class="hidden sm:inline">Manage</span>
                    </button>` : ''}
                    <div id="wallets-tabs" class="flex bg-[#2C2C2C] p-1 rounded-lg flex-shrink-0">
                        <button data-tab="agents" class="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-800 text-white transition-colors">
                            Agents <span class="opacity-70">(${op.controllers?.length || 0})</span>
                        </button>
                        <button data-tab="nodes" class="px-3 py-1.5 text-xs font-medium rounded-md text-gray-400 hover:text-white transition-colors">
                            Nodes <span class="opacity-70">(${op.nodes?.length || 0})</span>
                        </button>
                    </div>
                    </div>
                </div>
                <div id="agents-content" data-agents-count="${op.controllers?.length || 0}"><ul class="max-h-96 overflow-y-auto pr-2">${agentsHtml}</ul></div>
                <div id="nodes-content" class="hidden" data-nodes-count="${op.nodes?.length || 0}"><ul class="max-h-96 overflow-y-auto pr-2">${nodesHtml}</ul></div>
            </div>
        </div>`;

    const streamHtml = `
        <div class="detail-section p-6 mt-8">
            <div class="flex items-center justify-between mb-4 flex-wrap gap-y-2">
                <h3 class="text-xl font-semibold text-white">Coordination Stream</h3>
                <div class="flex items-center gap-2 text-sm">
                    <div class="flex items-center gap-2" title="Awaiting connection..."><div id="stream-status-indicator" class="w-3 h-3 rounded-full bg-gray-500"></div></div>
                    <div class="bg-[#2C2C2C] text-gray-200 font-semibold px-3 py-1 rounded-lg">Active Nodes: <span id="active-nodes-count-value" class="text-white font-bold">0</span></div>
                    <div id="unreachable-nodes-container" class="hidden bg-[#2C2C2C] text-gray-200 font-semibold px-3 py-1 rounded-lg" title="Nodes that are active but may not be reachable by all peers.">Unreachable: <span id="unreachable-nodes-count-value" class="text-orange-400 font-bold">0</span></div>
                    <div class="bg-[#2C2C2C] text-gray-200 font-semibold px-3 py-1 rounded-lg">Redundancy: <span class="text-white font-bold">${escapeHtml(String(redundancyFactor))}</span></div>
                </div>
            </div>
            <div id="stream-messages-container" class="max-h-96 overflow-y-auto pr-2 bg-black/50 p-2"><div class="text-gray-500 text-sm text-center py-4">Live messages will appear here.</div></div>
        </div>
        
        <!-- Node Map -->
        <div class="detail-section p-6 mt-8">
            <div id="node-map-container" class="h-96 w-full rounded-lg bg-black/50" style="z-index: 0;">
                <div class="text-gray-500 text-sm text-center py-4">Initializing map...</div>
            </div>
        </div>
        `;


    detailContent.innerHTML = editSettingsButtonHtml + headerStatsHtml + listsHtml + streamHtml;

    // Update the profile button state
    updateProfileButton(op.id, name || op.id, imageUrl);

    updateOperatorDetails(data, globalState);
    updateDelegatorsSection(globalState.currentDelegations, globalState.totalDelegatorCount, data.operator);

    toggleStatsPanel(true, globalState.uiState);

    // Initialize the Leaflet map
    initLeafletMap('node-map-container');
}


export function updateOperatorDetails(data, globalState) {
    const { operator: op, selfDelegation: selfDelegationData } = data;
    if (!op) return;

    const selfDelegation = selfDelegationData?.[0];

    const totalStakeWei = BigInt(op.valueWithoutEarnings);
    const totalEarningsWei = BigInt(op.cumulativeEarningsWei);
    const ownerCutWei = BigInt(op.cumulativeOperatorsCutWei);
    const operatorsOwnStakeWei = selfDelegation ? BigInt(selfDelegation._valueDataWei) : 0n;
    const distributedToDelegatorsWei = totalEarningsWei - ownerCutWei;
    const ownersCutPercent = (BigInt(op.operatorsCutFraction) * 100n) / BigInt('1000000000000000000');
    const ownersStakePercent = totalStakeWei > 0n ? Number((operatorsOwnStakeWei * 10000n) / totalStakeWei) / 100 : 0;
    const deployedStakeWei = op.stakes?.reduce((sum, stake) => sum + BigInt(stake.amountWei), 0n) || 0n;

    const totalStakeData = convertWeiToData(op.valueWithoutEarnings);
    const totalEarningsData = convertWeiToData(op.cumulativeEarningsWei);
    const ownerCutData = convertWeiToData(op.cumulativeOperatorsCutWei);
    const distributedData = convertWeiToData(distributedToDelegatorsWei.toString());
    const deployedData = convertWeiToData(deployedStakeWei.toString());
    const ownerStakeData = convertWeiToData(operatorsOwnStakeWei.toString());

    const headerStakeEl = document.getElementById('header-stat-stake');
    if (headerStakeEl) {
        headerStakeEl.textContent = formatBigNumber(totalStakeData);
        headerStakeEl.setAttribute('data-tooltip-value', totalStakeData);
    }

    const headerEarningsEl = document.getElementById('header-stat-earnings');
    if (headerEarningsEl) {
        headerEarningsEl.textContent = formatBigNumber(totalEarningsData);
        headerEarningsEl.setAttribute('data-tooltip-value', totalEarningsData);
    }

    const headerCutEl = document.getElementById('header-stat-cut');
    if (headerCutEl) {
        headerCutEl.textContent = `${ownersCutPercent}%`;
    }

    const distributedEl = document.getElementById('extended-stat-distributed');
    if (distributedEl) {
        distributedEl.textContent = formatBigNumber(distributedData);
        distributedEl.setAttribute('data-tooltip-value', distributedData);
    }

    const ownerCutEl = document.getElementById('extended-stat-owner-cut');
    if (ownerCutEl) {
        ownerCutEl.textContent = formatBigNumber(ownerCutData);
        ownerCutEl.setAttribute('data-tooltip-value', ownerCutData);
    }

    const deployedEl = document.getElementById('extended-stat-deployed');
    if (deployedEl) {
        deployedEl.textContent = formatBigNumber(deployedData);
        deployedEl.setAttribute('data-tooltip-value', deployedData);
    }

    const ownerStakeEl = document.getElementById('extended-stat-owner-stake');
    if (ownerStakeEl) {
        ownerStakeEl.textContent = `${Math.round(ownersStakePercent)}%`;
        // Store the raw DATA value for dynamic tooltip calculation
        ownerStakeEl.setAttribute('data-tooltip-value', ownerStakeData);
        ownerStakeEl.setAttribute('data-tooltip-type', 'owner-stake');
    }
}

// --- UI Toggles ---
export function toggleStatsPanel(isRefresh, uiState) {
    if (!isRefresh) {
        uiState.isStatsPanelExpanded = !uiState.isStatsPanelExpanded;
    }

    const extendedStats = document.getElementById('extended-stats');
    const arrow = document.getElementById('stats-arrow');

    if (extendedStats && arrow) {
        if (uiState.isStatsPanelExpanded) {
            extendedStats.classList.remove('hidden');
            arrow.classList.add('rotate-180');
        } else {
            extendedStats.classList.add('hidden');
            arrow.classList.remove('rotate-180');
        }
    }
}

export function toggleVoteList(flagId) {
    document.getElementById(`votes-${flagId}`)?.classList.toggle('hidden');
}

export function updateChartTimeframeButtons(days, isUsdView, chartType = 'stake') {
    // Chart type pills
    const chartTypeTabs = document.querySelectorAll('#chart-type-tabs button');
    chartTypeTabs.forEach(button => {
        if (button.dataset.chartType === chartType) {
            button.classList.add('bg-blue-800', 'text-white');
            button.classList.remove('text-gray-400', 'hover:text-white');
        } else {
            button.classList.remove('bg-blue-800', 'text-white');
            button.classList.add('text-gray-400', 'hover:text-white');
        }
    });

    // Timeframe buttons
    const buttons = document.querySelectorAll('#chart-timeframe-buttons button');
    buttons.forEach(button => {
        if (button.dataset.days === String(days)) {
            button.classList.add('bg-blue-800', 'text-white');
            button.classList.remove('hover:bg-[#444444]');
        } else {
            button.classList.remove('bg-blue-800', 'text-white');
            button.classList.add('hover:bg-[#444444]');
        }
    });

    // View buttons (DATA/USD) - only visible for Stake chart
    const viewButtonsContainer = document.getElementById('chart-view-buttons');
    if (viewButtonsContainer) {
        if (chartType === 'stake') {
            viewButtonsContainer.classList.remove('hidden');
        } else {
            viewButtonsContainer.classList.add('hidden');
        }
    }

    // Info tooltip - visible for Earnings chart
    const infoTooltip = document.getElementById('chart-info-tooltip');
    if (infoTooltip) {
        if (chartType === 'earnings') {
            infoTooltip.classList.remove('hidden');
        } else {
            infoTooltip.classList.add('hidden');
        }
    }

    const viewButtons = document.querySelectorAll('#chart-view-buttons button');
    viewButtons.forEach(button => {
        const isActive = (button.dataset.view === 'usd' && isUsdView) || (button.dataset.view === 'data' && !isUsdView);
        if (isActive) {
            button.classList.add('bg-blue-800', 'text-white');
            button.classList.remove('hover:bg-[#444444]');
        } else {
            button.classList.remove('bg-blue-800', 'text-white');
            button.classList.add('hover:bg-[#444444]');
        }
    });
}
