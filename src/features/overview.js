/**
 * Overview Feature Module
 * Home page: the Streamr Network at a glance. Stake, delegations, operators, sponsorships,
 * network APY and the DATA price; stake in sponsorships and DATA/USD over time; top operators,
 * best sponsorships, and the latest staking and governance events.
 * Network data comes from The Graph (the stake history from the sponsorships' daily buckets),
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
const BUCKET_PAGE = 1000;
const BUCKET_ALIASES = 10;           // windows per subgraph request

// Stake history: one point per `step` days
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
const BADGES = {
    flagged: { label: 'Flagged', badge: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
    kick: { label: 'Voted kick', badge: 'bg-red-500/10 text-red-400 border-red-500/30' },
    keep: { label: 'Voted no kick', badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
    kicked: { label: 'Kicked', badge: 'bg-red-500/10 text-red-400 border-red-500/30' },
    failed: { label: 'Not kicked', badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' }
};

// ============================================
// State
// ============================================

const state = {
    active: false,
    timer: null,
    network: null,
    totals: null,                // { staked, delegated, activeOperators, nodes } from the operators
    stakedBySponsorship: [],     // [{ id, staked }] every sponsorship with stake now
    sponsorships: [],
    operators: [],
    govEvents: [],
    stakingEvents: [],
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

function timeAgo(seconds) {
    const elapsed = now() - Number(seconds);
    if (elapsed < 60) return 'just now';
    if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
    if (elapsed < DAY) return `${Math.floor(elapsed / 3600)}h ago`;
    return `${Math.floor(elapsed / DAY)}d ago`;
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
    const PARTY = 'id metadataJsonString';
    const FLAG = `id result flaggingTimestamp flagResolutionTimestamp target { ${PARTY} } flagger { ${PARTY} } sponsorship { id stream { id } }`;
    const data = await Services.runQuery(`{
        networks(first: 1) { operatorsCount sponsorshipsCount }
        allOperators: operators(first: 1000) { valueWithoutEarnings totalStakeInSponsorshipsWei nodes }
        staked: sponsorships(first: 1000, where: { totalStakedWei_gt: "0" }) { id totalStakedWei }
        sponsorships(first: 1000, where: { isRunning: true, remainingWei_gt: "0" }) {
            id spotAPY totalStakedWei remainingWei totalPayoutWeiPerSec operatorCount
            stream { id }
        }
        topOperators: operators(first: ${LIST_SIZE}, orderBy: valueWithoutEarnings, orderDirection: desc) {
            id valueWithoutEarnings delegatorCount metadataJsonString
            stakes(first: 50) { amountWei sponsorship { spotAPY } }
        }
        raised: flags(first: ${LIST_SIZE}, orderBy: flaggingTimestamp, orderDirection: desc) { ${FLAG} }
        resolved: flags(first: ${LIST_SIZE}, orderBy: flagResolutionTimestamp, orderDirection: desc, where: { result_in: ["kicked", "failed"] }) { ${FLAG} }
        votes(first: ${LIST_SIZE}, orderBy: timestamp, orderDirection: desc) {
            id timestamp votedKick voter { ${PARTY} }
            flag { id target { ${PARTY} } sponsorship { id stream { id } } }
        }
        stakingEvents(first: ${LIST_SIZE}, orderBy: date, orderDirection: desc) {
            id amount date operator { ${PARTY} } sponsorship { id stream { id } }
        }
    }`);
    state.network = data.networks?.[0] || null;
    // Stake and delegations: sums over the operators (the Network entity's totals are cumulative)
    const operators = data.allOperators || [];
    const active = operators.filter(op => BigInt(op.totalStakeInSponsorshipsWei || '0') > 0n);
    state.totals = {
        staked: operators.reduce((sum, op) => sum + weiToNumber(op.totalStakeInSponsorshipsWei), 0),
        delegated: operators.reduce((sum, op) => sum + weiToNumber(op.valueWithoutEarnings), 0),
        activeOperators: active.length,
        nodes: active.reduce((sum, op) => sum + (op.nodes?.length || 0), 0)
    };
    state.stakedBySponsorship = (data.staked || []).map(s => ({ id: s.id, staked: weiToNumber(s.totalStakedWei) }));
    state.sponsorships = data.sponsorships || [];
    state.operators = data.topOperators || [];
    state.stakingEvents = data.stakingEvents || [];

    // Governance: flags raised, votes cast and results, newest first
    const events = new Map();
    for (const flag of data.raised || []) {
        events.set(`raised:${flag.id}`, { kind: 'flagged', time: Number(flag.flaggingTimestamp), flag, who: flag.target, by: flag.flagger });
    }
    for (const flag of data.resolved || []) {
        events.set(`resolved:${flag.id}`, { kind: flag.result, time: Number(flag.flagResolutionTimestamp), flag, who: flag.target });
    }
    for (const vote of data.votes || []) {
        events.set(`vote:${vote.id}`, { kind: vote.votedKick ? 'kick' : 'keep', time: Number(vote.timestamp), flag: vote.flag, who: vote.voter, on: vote.flag?.target });
    }
    state.govEvents = [...events.values()].sort((a, b) => b.time - a.time).slice(0, LIST_SIZE);
}

/** Daily buckets of every sponsorship in (from, to], several windows per request, each paged */
async function fetchBuckets(windows) {
    const results = windows.map(() => []);
    let pending = windows.map((w, i) => ({ ...w, i, skip: 0 }));
    while (pending.length) {
        const next = [];
        const batches = [];
        for (let k = 0; k < pending.length; k += BUCKET_ALIASES) batches.push(pending.slice(k, k + BUCKET_ALIASES));
        await Promise.all(batches.map(async (batch) => {
            const fields = batch.map((w, j) => `w${j}: sponsorshipDailyBuckets(first: ${BUCKET_PAGE}, skip: ${w.skip}, orderBy: date, orderDirection: asc, where: { date_gt: "${w.from}", date_lte: "${w.to}" }) { date totalStakedWei sponsorship { id } }`).join('\n');
            const data = await Services.runQuery(`{ ${fields} }`);
            batch.forEach((w, j) => {
                const rows = data[`w${j}`] || [];
                results[w.i].push(...rows);
                if (rows.length === BUCKET_PAGE) next.push({ ...w, skip: w.skip + BUCKET_PAGE });
            });
        }));
        pending = next;
    }
    return results;
}

/**
 * DATA staked in sponsorships at past dates, from the sponsorships' daily buckets: each sponsorship
 * keeps its last bucket's stake until the next one. Sponsorships without a bucket in the range kept
 * the stake they have now; the others start from the last bucket before the range.
 */
async function fetchStakeHistory(rangeKey) {
    const range = STAKE_RANGES[rangeKey];
    const today = Math.floor(now() / DAY) * DAY;
    const step = range.step * DAY;
    const start = range.days ? today - range.days * DAY : Math.floor(NETWORK_START / DAY) * DAY;
    const times = [];
    for (let t = today; t > start; t -= step) times.unshift(t);
    if (!times.length) return [];

    // Window i: the buckets after the previous point, up to point i
    const first = times[0] - step;
    const [beforeData, inRange] = await Promise.all([
        // State before the range: the latest buckets before it (read oldest first below, so each sponsorship ends on its newest)
        Services.runQuery(`{ sponsorshipDailyBuckets(first: ${BUCKET_PAGE}, orderBy: date, orderDirection: desc, where: { date_lte: "${first}" }) { date totalStakedWei sponsorship { id } } }`),
        fetchBuckets(times.map((t, i) => ({ from: i ? times[i - 1] : first, to: t })))
    ]);
    const value = new Map();
    for (const row of [...(beforeData.sponsorshipDailyBuckets || [])].reverse()) value.set(row.sponsorship.id, weiToNumber(row.totalStakedWei));
    const seen = new Set([...value.keys(), ...inRange.flat().map(row => row.sponsorship.id)]);
    // Unchanged since before the range: the stake they have now
    const constant = state.stakedBySponsorship.filter(s => !seen.has(s.id)).reduce((sum, s) => sum + s.staked, 0);

    return times.map((t, i) => {
        for (const row of inRange[i]) value.set(row.sponsorship.id, weiToNumber(row.totalStakedWei));
        let total = constant;
        for (const staked of value.values()) total += staked;
        return { x: t * 1000, y: total };
    });
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

    const totals = state.totals;
    const staked = totals ? totals.staked : null;
    const delegated = totals ? totals.delegated : null;
    const apy = state.loaded ? networkApy() : null;
    const before = price24hAgo();
    const change = price && before ? price / before - 1 : null;
    const changeText = change === null ? 'DATA / USD'
        : `<span class="${change >= 0 ? 'text-green-400' : 'text-red-400'} font-semibold">${change >= 0 ? '+' : ''}${(change * 100).toFixed(2)}%</span> 24h`;

    el.innerHTML = [
        kpiTile('Total staked', staked === null ? placeholder : dataUnit(staked), staked === null ? '' : usd(staked),
            staked === null ? '' : `${formatBigNumber(Math.round(staked).toString())} DATA staked by the operators in sponsorships`),
        kpiTile('Delegated', delegated === null ? placeholder : dataUnit(delegated), delegated === null ? '' : usd(delegated),
            delegated === null ? '' : `${formatBigNumber(Math.round(delegated).toString())} DATA delegated to the operators, by delegators and owners<br>Operator value without the earnings not yet withdrawn`),
        kpiTile('Operators', totals ? formatBigNumber(String(totals.activeOperators)) : placeholder,
            n ? `Staking · ${formatBigNumber(String(n.operatorsCount))} in total · ${formatBigNumber(String(totals.nodes))} nodes` : ''),
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
    if (!best) return;
    if (!state.loaded) { best.innerHTML = state.error ? emptyRow('Sponsorships could not be loaded.') : loadingRows(); return; }
    const top = [...state.sponsorships]
        .filter(s => Number(s.spotAPY) > 0)
        .sort((a, b) => Number(b.spotAPY) - Number(a.spotAPY))
        .slice(0, LIST_SIZE);
    best.innerHTML = top.length
        ? top.map(s => sponsorshipRow(s, formatPercent(Number(s.spotAPY)), `${compact(weiToNumber(s.remainingWei))} DATA left`)).join('')
        : emptyRow('No running sponsorships.');
}

function badge(kind) {
    const { label, badge: classes } = BADGES[kind];
    return `<span class="inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-semibold whitespace-nowrap ${classes}">${label}</span>`;
}

function avatar(operator) {
    return operatorAvatarHtml(operator?.metadataJsonString, { className: 'w-8 h-8 border border-[#333]' });
}

function renderStakingEvents() {
    const el = $('overview-staking');
    if (!el) return;
    if (!state.loaded) { el.innerHTML = state.error ? emptyRow('Staking events could not be loaded.') : loadingRows(); return; }
    if (!state.stakingEvents.length) { el.innerHTML = emptyRow('No staking events.'); return; }
    el.innerHTML = state.stakingEvents.map(event => {
        const amount = weiToNumber(event.amount);   // negative: unstaked
        const staked = amount >= 0;
        return `
            <a href="/operator/${event.operator?.id}" class="flex items-center gap-3 px-2 py-2 -mx-2 rounded-lg hover:bg-white/[0.03] transition-colors">
                ${avatar(event.operator)}
                <div class="min-w-0 flex-1">
                    <p class="text-sm font-semibold text-white truncate">${escapeHtml(operatorName(event.operator))}</p>
                    <p class="text-xs text-gray-400 truncate" data-tooltip-content="${escapeHtml(event.sponsorship?.stream?.id || '')}">${staked ? 'Staked in' : 'Unstaked from'} ${escapeHtml(shortStreamId(event.sponsorship?.stream?.id) || shortAddress(event.sponsorship?.id || ''))}</p>
                </div>
                <div class="text-right whitespace-nowrap">
                    <p class="text-sm font-semibold ${staked ? 'text-green-400' : 'text-red-400'}" data-tooltip-content="${formatBigNumber(Math.round(Math.abs(amount)).toString())} DATA">${staked ? '+' : '-'}${compact(Math.abs(amount))} DATA</p>
                    <p class="text-xs text-gray-400">${timeAgo(event.date)}</p>
                </div>
            </a>`;
    }).join('');
}

function renderGovernanceEvents() {
    const el = $('overview-governance');
    if (!el) return;
    if (!state.loaded) { el.innerHTML = state.error ? emptyRow('Governance events could not be loaded.') : loadingRows(); return; }
    if (!state.govEvents.length) { el.innerHTML = emptyRow('No governance events.'); return; }
    el.innerHTML = state.govEvents.map(event => {
        const stream = shortStreamId(event.flag?.sponsorship?.stream?.id);
        const detail = event.kind === 'flagged' ? `By ${operatorName(event.by)}`
            : event.on ? `On ${operatorName(event.on)}` : stream;
        return `
            <a href="/governance/flag/${encodeURIComponent(event.flag?.id || '')}" class="flex items-center gap-3 px-2 py-2 -mx-2 rounded-lg hover:bg-white/[0.03] transition-colors">
                ${avatar(event.who)}
                <div class="min-w-0 flex-1">
                    <p class="text-sm font-semibold text-white truncate">${escapeHtml(operatorName(event.who))}</p>
                    <p class="text-xs text-gray-400 truncate">${escapeHtml(detail)}</p>
                </div>
                <div class="text-right whitespace-nowrap">
                    ${badge(event.kind)}
                    <p class="text-xs text-gray-400 mt-1">${timeAgo(event.time)}</p>
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
    if (state.totals) points.push({ x: Date.now(), y: state.totals.staked });
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
    renderStakingEvents();
    renderGovernanceEvents();
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
    renderStakingEvents();
    renderGovernanceEvents();
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
