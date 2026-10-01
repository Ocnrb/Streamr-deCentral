/**
 * Overview Feature Module
 * Home page: the Streamr Network at a glance. Stake, delegations, operators, sponsorships,
 * network APY and the DATA price; total stake and DATA/USD over time; top operators,
 * best and ending sponsorships, and the flags in review or voting.
 * Network data comes from The Graph (time-travel queries for the stake history),
 * the DATA price from the app's price streams.
 */

import * as Services from '../core/services.js';
import { getGraphUrl } from '../core/constants.js';
import { escapeHtml, convertWeiToData, formatBigNumber, parseOperatorMetadata, shortAddress, operatorAvatarHtml, calculateWeightedApy, logger } from '../core/utils.js';

// ============================================
// Constants
// ============================================

const DAY = 86400;
const YEAR = 365 * DAY;
const REFRESH_MS = 60 * 1000;        // network numbers and lists while the page is open
const LIST_SIZE = 5;
// Streamr 1.0 staking went live late November 2023 (the Leaderboard starts there too)
const NETWORK_START = Math.floor(Date.UTC(2023, 11, 1) / 1000);
const POLYGON_BLOCK_SECONDS = 2.1;   // first guess, calibrated against the subgraph before the history query

// Stake history: one point per `step` days (time-travel query per point)
const STAKE_RANGES = {
    '30d': { label: '30D', days: 30, step: 1 },
    '1y': { label: '1Y', days: 365, step: 7 },
    'all': { label: 'All', days: null, step: 14 }
};
const PRICE_RANGES = {
    '30d': { label: '30D', days: 30 },
    '1y': { label: '1Y', days: 365 },
    'all': { label: 'All', days: null }
};

const LINK_CLASS = 'hover:text-white hover:underline underline-offset-2 transition-colors';
const STATUS = {
    waiting: { label: 'In review', badge: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
    voting: { label: 'Voting', badge: 'bg-blue-500/10 text-blue-400 border-blue-500/30' }
};

// ============================================
// State
// ============================================

const state = {
    active: false,
    timer: null,
    network: null,
    activeOperators: null,
    nodes: null,
    sponsorships: [],
    operators: [],
    flags: [],
    loaded: false,
    error: false,
    stakeRange: '1y',
    priceRange: '1y',
    stakeHistory: {},            // range -> points (ms, DATA)
    stakeLoading: {},
    stakeError: {},
    priceHistory: [],            // daily DATA/USD (ms, USD)
    charts: {},
    initialized: false
};

const $ = (id) => document.getElementById(id);
const now = () => Math.floor(Date.now() / 1000);

// ============================================
// Formatting
// ============================================

const weiToNumber = (wei) => Number(convertWeiToData(wei || '0', true)) || 0;

/** 182.4M, 12.5K: KPI values (the full number is in the tooltip) */
function compact(value) {
    const abs = Math.abs(value);
    if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e8 ? 0 : 1)}M`;
    if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}K`;
    return value.toFixed(0);
}

function formatUsd(value) {
    if (!(value > 0)) return '--';
    return `$${formatBigNumber(Math.round(value).toString())}`;
}

function formatPrice(value) {
    if (!(value > 0)) return '--';
    return `$${value >= 1 ? value.toFixed(2) : value.toPrecision(4)}`;
}

function formatPercent(value, digits = 1) {
    return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '--';
}

function formatDuration(seconds) {
    if (seconds <= 0) return 'now';
    const days = Math.floor(seconds / DAY);
    if (days >= 1) return `${days}d ${Math.floor((seconds % DAY) / 3600)}h`;
    const hours = Math.floor(seconds / 3600);
    return hours >= 1 ? `${hours}h ${Math.floor((seconds % 3600) / 60)}m` : `${Math.max(1, Math.floor(seconds / 60))}m`;
}

function shortStreamId(streamId) {
    const match = /^(0x[0-9a-fA-F]{40})(\/.*)$/.exec(streamId || '');
    return match ? `${shortAddress(match[1])}${match[2]}` : (streamId || '');
}

function operatorName(operator) {
    return parseOperatorMetadata(operator?.metadataJsonString).name || shortAddress(operator?.id || '');
}

function sponsorshipHref(sponsorship) {
    const streamId = sponsorship.stream?.id || sponsorship.id;
    return `/stream/${encodeURIComponent(streamId)}?sponsored=true&sponsorshipId=${sponsorship.id}`;
}

function currentPrice() {
    return Services.getCurrentLivePrice() || state.priceHistory[state.priceHistory.length - 1]?.y || null;
}

// ============================================
// Data
// ============================================

async function graphRequest(query) {
    const response = await fetch(getGraphUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
    });
    if (!response.ok) throw new Error(`Network error: ${response.statusText}`);
    return response.json();
}

async function fetchSnapshot() {
    const data = await Services.runQuery(`{
        networks(first: 1) { totalStake totalDelegated operatorsCount sponsorshipsCount fundedSponsorshipsCount }
        activeOperators: operators(first: 1000, where: { totalStakeInSponsorshipsWei_gt: "0" }) { id nodes }
        sponsorships(first: 1000, where: { isRunning: true, remainingWei_gt: "0" }) {
            id spotAPY totalStakedWei remainingWei totalPayoutWeiPerSec projectedInsolvency operatorCount
            stream { id }
        }
        topOperators: operators(first: ${LIST_SIZE}, orderBy: valueWithoutEarnings, orderDirection: desc) {
            id valueWithoutEarnings delegatorCount metadataJsonString
            stakes(first: 50) { amountWei sponsorship { spotAPY } }
        }
        flags(first: 20, orderBy: voteEndTimestamp, orderDirection: asc, where: { result_in: ["waiting", "voting"], voteEndTimestamp_gt: ${now() - 3600} }) {
            id result voteStartTimestamp voteEndTimestamp reviewerCount targetStakeAtRiskWei
            target { id metadataJsonString }
            sponsorship { id stream { id } }
            votes(first: 100) { id }
        }
    }`);
    state.network = data.networks?.[0] || null;
    state.activeOperators = data.activeOperators?.length ?? null;
    state.nodes = (data.activeOperators || []).reduce((sum, op) => sum + (op.nodes?.length || 0), 0);
    state.sponsorships = data.sponsorships || [];
    state.operators = data.topOperators || [];
    state.flags = data.flags || [];
}

/**
 * Total stake at past dates: the Network entity at estimated Polygon blocks (time-travel queries).
 * The block time is calibrated on the oldest point; each point is placed at its block's real timestamp.
 */
async function fetchStakeHistory(rangeKey) {
    const range = STAKE_RANGES[rangeKey];
    const latest = (await Services.runQuery('{ _meta { block { number timestamp } } }'))._meta.block;
    const start = range.days ? latest.timestamp - range.days * DAY : NETWORK_START;
    const step = range.step * DAY;
    const times = [];
    for (let t = latest.timestamp - step; t >= start; t -= step) times.unshift(t);
    if (!times.length) return [];

    let blockSeconds = POLYGON_BLOCK_SECONDS;
    const blockAt = (t) => Math.max(1, Math.round(latest.number - (latest.timestamp - t) / blockSeconds));
    const probe = await graphRequest(`{ _meta(block: { number: ${blockAt(times[0])} }) { block { number timestamp } } }`);
    const probed = probe.data?._meta?.block;
    if (probed && latest.number > probed.number && latest.timestamp > probed.timestamp) {
        blockSeconds = (latest.timestamp - probed.timestamp) / (latest.number - probed.number);
    }

    const fields = times.map((t, i) => {
        const block = `block: { number: ${blockAt(t)} }`;
        return `n${i}: networks(first: 1, ${block}) { totalStake } m${i}: _meta(${block}) { block { timestamp } }`;
    }).join('\n');
    const json = await graphRequest(`{ ${fields} }`);
    // Points the indexer cannot serve (e.g. pruned blocks) come back empty: the others are kept
    const points = times.map((t, i) => {
        const network = json.data?.[`n${i}`]?.[0];
        const timestamp = json.data?.[`m${i}`]?.block?.timestamp;
        return network && timestamp ? { x: timestamp * 1000, y: weiToNumber(network.totalStake) } : null;
    }).filter(Boolean);
    if (!points.length) throw new Error(json.errors?.[0]?.message || 'No stake history');
    return points;
}

function setPriceHistory({ priceMap }) {
    if (!priceMap?.size) return;
    state.priceHistory = [...priceMap.entries()]
        .map(([seconds, price]) => ({ x: seconds * 1000, y: price }))
        .filter(point => point.y > 0)
        .sort((a, b) => a.x - b.x);
    if (state.active) {
        renderKpis();
        renderPriceChart();
    }
}

// ============================================
// Derived numbers
// ============================================

/** Yearly payouts of the running sponsorships over the DATA staked in them */
function networkApy() {
    let payoutPerSec = 0;
    let staked = 0;
    for (const s of state.sponsorships) {
        payoutPerSec += weiToNumber(s.totalPayoutWeiPerSec);
        staked += weiToNumber(s.totalStakedWei);
    }
    return staked > 0 ? (payoutPerSec * YEAR) / staked : null;
}

/** DATA/USD 24 hours ago, between the two daily points around it */
function price24hAgo() {
    const target = Date.now() - DAY * 1000;
    const history = state.priceHistory;
    for (let i = history.length - 1; i > 0; i--) {
        if (history[i - 1].x <= target) {
            const [a, b] = [history[i - 1], history[i]];
            if (b.x <= target) return b.y;
            return a.y + (b.y - a.y) * (target - a.x) / (b.x - a.x);
        }
    }
    return null;
}

// ============================================
// Rendering
// ============================================

function kpiTile(label, value, sub = '', tooltip = '') {
    const tip = tooltip ? ` data-tooltip-content="${escapeHtml(tooltip)}"` : '';
    return `
        <div class="detail-section p-4 min-w-0">
            <p class="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">${label}</p>
            <p class="text-xl sm:text-2xl font-bold text-white mt-1.5 whitespace-nowrap"${tip}>${value}</p>
            <p class="text-xs text-gray-400 mt-0.5">${sub}</p>
        </div>`;
}

function renderKpis() {
    const el = $('overview-kpis');
    if (!el) return;
    const n = state.network;
    const price = currentPrice();
    const usd = (data) => (price ? formatUsd(data * price) : '');
    const dataUnit = (value) => `${compact(value)} <span class="text-sm font-semibold text-gray-300">DATA</span>`;
    const placeholder = state.error ? '--' : '<span class="inline-block w-16 h-6 rounded bg-[#2C2C2C] animate-pulse align-middle"></span>';

    const staked = n ? weiToNumber(n.totalStake) : null;
    const delegated = n ? weiToNumber(n.totalDelegated) : null;
    const apy = state.loaded ? networkApy() : null;
    const before = price24hAgo();
    const change = price && before ? price / before - 1 : null;
    const changeText = change === null ? 'DATA / USD'
        : `<span class="${change >= 0 ? 'text-green-400' : 'text-red-400'} font-semibold">${change >= 0 ? '+' : ''}${(change * 100).toFixed(2)}%</span> 24h`;

    el.innerHTML = [
        kpiTile('Total staked', staked === null ? placeholder : dataUnit(staked), staked === null ? '' : usd(staked),
            staked === null ? '' : `${formatBigNumber(Math.round(staked).toString())} DATA staked in sponsorships`),
        kpiTile('Delegated', delegated === null ? placeholder : dataUnit(delegated), delegated === null ? '' : usd(delegated),
            delegated === null ? '' : `${formatBigNumber(Math.round(delegated).toString())} DATA delegated to operators`),
        kpiTile('Operators', state.activeOperators === null ? placeholder : formatBigNumber(String(state.activeOperators)),
            n ? `Staking · ${formatBigNumber(String(n.operatorsCount))} in total · ${formatBigNumber(String(state.nodes || 0))} nodes` : ''),
        kpiTile('Sponsorships', n ? formatBigNumber(String(state.sponsorships.length)) : placeholder,
            n ? `Running · ${formatBigNumber(String(n.sponsorshipsCount))} in total` : ''),
        kpiTile('Network APY', apy === null ? (state.loaded ? '--' : placeholder) : formatPercent(apy),
            'Payouts over the stake', 'Sum of the payouts per year of the running sponsorships, divided by the DATA staked in them.<br>Before the operators\' cut.'),
        kpiTile('DATA price', price ? formatPrice(price) : placeholder, changeText)
    ].join('');
}

function emptyRow(text) {
    return `<p class="py-6 text-center text-sm text-gray-400">${text}</p>`;
}

function loadingRows() {
    return Array.from({ length: 3 }, () => '<div class="h-10 rounded-lg bg-[#2C2C2C] animate-pulse"></div>').join('');
}

function renderOperators() {
    const el = $('overview-operators');
    if (!el) return;
    if (!state.loaded) { el.innerHTML = state.error ? emptyRow('Operators could not be loaded.') : loadingRows(); return; }
    if (!state.operators.length) { el.innerHTML = emptyRow('No operators.'); return; }
    el.innerHTML = state.operators.map((op, i) => {
        const apy = calculateWeightedApy(op.stakes);
        const value = weiToNumber(op.valueWithoutEarnings);
        return `
            <a href="/operator/${op.id}" class="flex items-center gap-3 px-2 py-2 -mx-2 rounded-lg hover:bg-white/[0.03] transition-colors">
                <span class="w-4 text-xs font-semibold text-gray-400 text-right">${i + 1}</span>
                ${operatorAvatarHtml(op.metadataJsonString, { className: 'w-8 h-8 border border-[#333]' })}
                <div class="min-w-0 flex-1">
                    <p class="text-sm font-semibold text-white truncate">${escapeHtml(operatorName(op))}</p>
                    <p class="text-xs text-gray-400">${formatBigNumber(String(op.delegatorCount || 0))} delegators</p>
                </div>
                <div class="text-right">
                    <p class="text-sm font-semibold text-white" data-tooltip-content="${formatBigNumber(Math.round(value).toString())} DATA">${compact(value)} DATA</p>
                    <p class="text-xs text-gray-400">${formatPercent(apy)} APY</p>
                </div>
            </a>`;
    }).join('');
}

function sponsorshipRow(s, right, rightSub) {
    return `
        <a href="${sponsorshipHref(s)}" class="flex items-center gap-3 px-2 py-2 -mx-2 rounded-lg hover:bg-white/[0.03] transition-colors">
            <div class="min-w-0 flex-1">
                <p class="text-sm font-semibold text-white truncate" data-tooltip-content="${escapeHtml(s.stream?.id || s.id)}">${escapeHtml(shortStreamId(s.stream?.id) || shortAddress(s.id))}</p>
                <p class="text-xs text-gray-400">${compact(weiToNumber(s.totalStakedWei))} DATA staked · ${s.operatorCount || 0} operators</p>
            </div>
            <div class="text-right whitespace-nowrap">
                <p class="text-sm font-semibold text-white">${right}</p>
                <p class="text-xs text-gray-400">${rightSub}</p>
            </div>
        </a>`;
}

function renderSponsorships() {
    const best = $('overview-best');
    const ending = $('overview-ending');
    if (!best || !ending) return;
    if (!state.loaded) {
        const content = state.error ? emptyRow('Sponsorships could not be loaded.') : loadingRows();
        best.innerHTML = content;
        ending.innerHTML = content;
        return;
    }
    const t = now();
    const top = [...state.sponsorships]
        .filter(s => Number(s.spotAPY) > 0)
        .sort((a, b) => Number(b.spotAPY) - Number(a.spotAPY))
        .slice(0, LIST_SIZE);
    best.innerHTML = top.length
        ? top.map(s => sponsorshipRow(s, formatPercent(Number(s.spotAPY)), `${compact(weiToNumber(s.remainingWei))} DATA left`)).join('')
        : emptyRow('No running sponsorships.');

    const soon = state.sponsorships
        .filter(s => Number(s.projectedInsolvency) > t)
        .sort((a, b) => Number(a.projectedInsolvency) - Number(b.projectedInsolvency))
        .slice(0, LIST_SIZE);
    ending.innerHTML = soon.length
        ? soon.map(s => sponsorshipRow(s, `in ${formatDuration(Number(s.projectedInsolvency) - t)}`, `${formatPercent(Number(s.spotAPY))} APY`)).join('')
        : emptyRow('No sponsorship ends soon.');
}

function renderFlags() {
    const el = $('overview-flags');
    if (!el) return;
    if (!state.loaded) { el.innerHTML = state.error ? emptyRow('Flags could not be loaded.') : loadingRows(); return; }
    if (!state.flags.length) { el.innerHTML = emptyRow('No flags in review or voting.'); return; }
    el.innerHTML = state.flags.slice(0, LIST_SIZE).map(flag => {
        const status = STATUS[flag.result] || STATUS.voting;
        const t = now();
        const phase = flag.result === 'waiting' && flag.voteStartTimestamp > t
            ? `Voting in ${formatDuration(flag.voteStartTimestamp - t)}`
            : flag.voteEndTimestamp > t ? `Ends in ${formatDuration(flag.voteEndTimestamp - t)}` : 'Awaiting result';
        return `
            <a href="/governance/flag/${encodeURIComponent(flag.id)}" class="flex items-center gap-3 px-2 py-2 -mx-2 rounded-lg hover:bg-white/[0.03] transition-colors">
                ${operatorAvatarHtml(flag.target?.metadataJsonString, { className: 'w-8 h-8 border border-[#333]' })}
                <div class="min-w-0 flex-1">
                    <p class="text-sm font-semibold text-white truncate">${escapeHtml(operatorName(flag.target))}</p>
                    <p class="text-xs text-gray-400 truncate">${escapeHtml(shortStreamId(flag.sponsorship?.stream?.id))}</p>
                </div>
                <div class="text-right whitespace-nowrap">
                    <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-semibold ${status.badge}"><span class="w-1.5 h-1.5 rounded-full bg-current animate-pulse"></span>${status.label}</span>
                    <p class="text-xs text-gray-400 mt-1">${phase}<span class="hidden sm:inline"> · ${flag.votes?.length || 0}/${flag.reviewerCount || 0} voted</span></p>
                </div>
            </a>`;
    }).join('');
}

// ============================================
// Charts
// ============================================

const crosshair = {
    id: 'overviewCrosshair',
    afterDatasetsDraw(chart) {
        const active = chart.tooltip?.getActiveElements?.() || [];
        if (!active.length) return;
        const { ctx, chartArea } = chart;
        const x = active[0].element.x;
        ctx.save();
        ctx.strokeStyle = '#4b5563';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.restore();
    }
};

function tickLabel(ms, rangeKey) {
    const date = new Date(ms);
    if (rangeKey === 'all') return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Line chart in the Swap chart's style; `key` names the chart in state.charts */
function drawChart(key, container, points, { color, rgb, label, format, rangeKey }) {
    if (typeof Chart === 'undefined') return;
    if (!container.querySelector('canvas')) {
        state.charts[key]?.destroy();
        state.charts[key] = null;
        container.innerHTML = `<canvas aria-label="${label} chart" role="img"></canvas>`;
    }
    const ctx = container.querySelector('canvas').getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, container.clientHeight || 260);
    gradient.addColorStop(0, `rgba(${rgb}, 0.25)`);
    gradient.addColorStop(1, `rgba(${rgb}, 0)`);
    const dataset = {
        label,
        data: points,
        borderColor: color,
        backgroundColor: gradient,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: color,
        pointHoverBorderColor: '#121212',
        pointHoverBorderWidth: 2,
        tension: 0,
        fill: true
    };
    const bounds = { min: points[0].x, max: points[points.length - 1].x };
    const chart = state.charts[key];
    if (chart) {
        chart.data.datasets[0] = dataset;
        Object.assign(chart.options.scales.x, bounds);
        chart.options.scales.x.ticks.callback = (value) => tickLabel(value, rangeKey);
        chart.update('none');
        return;
    }
    const font = { family: "'Inter', sans-serif", size: 11 };
    state.charts[key] = new Chart(ctx, {
        type: 'line',
        data: { datasets: [dataset] },
        plugins: [crosshair],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            parsing: false,
            interaction: { mode: 'nearest', axis: 'x', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(30, 30, 30, 0.9)',
                    titleColor: '#ffffff',
                    bodyColor: '#d1d5db',
                    borderColor: '#333333',
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 8,
                    displayColors: false,
                    titleFont: { ...font, size: 12, weight: '600' },
                    bodyFont: { ...font, size: 13 },
                    callbacks: {
                        title: (items) => new Date(items[0].parsed.x).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
                        label: (item) => format(item.parsed.y, true)
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    ...bounds,
                    ticks: { color: '#9ca3af', font, maxTicksLimit: 6, maxRotation: 0, callback: (value) => tickLabel(value, rangeKey) },
                    grid: { display: false }
                },
                y: {
                    position: 'right',
                    ticks: { color: '#9ca3af', font, maxTicksLimit: 5, callback: (value) => format(value, false) },
                    grid: { color: '#2a2a2a', drawBorder: false }
                }
            }
        }
    });
}

function chartMessage(key, container, text, spinner = false) {
    state.charts[key]?.destroy();
    state.charts[key] = null;
    const spin = spinner ? '<span class="w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" aria-hidden="true"></span>' : '';
    container.innerHTML = `<div class="flex items-center justify-center gap-2 h-full text-sm text-gray-300">${spin}${text}</div>`;
}

function renderStakeChart() {
    const container = $('overview-stake-chart');
    if (!container) return;
    const key = state.stakeRange;
    if (state.stakeError[key]) return chartMessage('stake', container, 'Stake history could not be loaded.');
    const history = state.stakeHistory[key];
    if (!history) return chartMessage('stake', container, 'Loading stake history...', true);
    const points = [...history];
    // Ends at the live total
    if (state.network) points.push({ x: Date.now(), y: weiToNumber(state.network.totalStake) });
    if (points.length < 2) return chartMessage('stake', container, 'Not enough data for this range.');
    drawChart('stake', container, points, {
        color: '#3b82f6', rgb: '59, 130, 246', label: 'Total staked', rangeKey: key,
        format: (value, full) => (full ? `${formatBigNumber(Math.round(value).toString())} DATA` : compact(value))
    });
}

async function loadStakeHistory(key) {
    if (state.stakeHistory[key] || state.stakeLoading[key]) return;
    state.stakeLoading[key] = true;
    state.stakeError[key] = false;
    try {
        state.stakeHistory[key] = await fetchStakeHistory(key);
    } catch (e) {
        logger.warn('Overview: stake history not loaded', e);
        state.stakeError[key] = true;
    } finally {
        state.stakeLoading[key] = false;
    }
    if (state.active && state.stakeRange === key) renderStakeChart();
}

function renderPriceChart() {
    const container = $('overview-price-chart');
    if (!container) return;
    const range = PRICE_RANGES[state.priceRange];
    const start = range.days ? Date.now() - range.days * DAY * 1000 : -Infinity;
    const points = state.priceHistory.filter(p => p.x >= start);
    const price = Services.getCurrentLivePrice();
    if (price && points.length) points.push({ x: Date.now(), y: price });
    if (points.length < 2) return chartMessage('price', container, state.priceHistory.length ? 'Not enough price data for this range.' : 'Loading prices...', !state.priceHistory.length);
    drawChart('price', container, points, {
        color: '#3b82f6', rgb: '59, 130, 246', label: 'DATA/USD', rangeKey: state.priceRange,
        format: (value) => (value > 0 ? formatPrice(value) : '$0')
    });
}

function renderRangeButtons(groupId, selected) {
    document.querySelectorAll(`#${groupId} button`).forEach(btn => {
        const active = btn.dataset.range === selected;
        btn.classList.toggle('bg-blue-800', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('text-gray-300', !active);
    });
}

function renderAll() {
    renderKpis();
    renderOperators();
    renderSponsorships();
    renderFlags();
    renderStakeChart();
    renderPriceChart();
    renderRangeButtons('overview-stake-range', state.stakeRange);
    renderRangeButtons('overview-price-range', state.priceRange);
}

// ============================================
// Lifecycle
// ============================================

async function refresh() {
    try {
        await fetchSnapshot();
        state.loaded = true;
        state.error = false;
    } catch (e) {
        logger.warn('Overview: network data not loaded', e);
        if (!state.loaded) state.error = true;
    }
    if (!state.active) return;
    renderKpis();
    renderOperators();
    renderSponsorships();
    renderFlags();
    renderStakeChart();
    renderPriceChart();
}

function schedule() {
    clearTimeout(state.timer);
    state.timer = setTimeout(async () => {
        if (!state.active) return;
        if (!document.hidden) await refresh();
        schedule();
    }, REFRESH_MS);
}

function init() {
    if (state.initialized) return;
    state.initialized = true;
    document.querySelectorAll('#overview-stake-range button').forEach(btn => btn.addEventListener('click', () => {
        state.stakeRange = btn.dataset.range;
        renderRangeButtons('overview-stake-range', state.stakeRange);
        renderStakeChart();
        loadStakeHistory(state.stakeRange);
    }));
    document.querySelectorAll('#overview-price-range button').forEach(btn => btn.addEventListener('click', () => {
        state.priceRange = btn.dataset.range;
        renderRangeButtons('overview-price-range', state.priceRange);
        renderPriceChart();
    }));
    // The page stops itself when another one opens
    window.addEventListener('app:routechange', (e) => {
        if (e.detail.path !== '/') stop();
    });
    // Back on the tab: fresh numbers right away
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && state.active) refresh();
    });
    Services.onHistoricalDataLoaded(setPriceHistory);
}

function show() {
    init();
    state.active = true;
    setPriceHistory({ priceMap: Services.getHistoricalDataPriceMap() });
    renderAll();
    refresh();
    loadStakeHistory(state.stakeRange);
    schedule();
}

function stop() {
    state.active = false;
    clearTimeout(state.timer);
}

export const OverviewLogic = { show, stop };
