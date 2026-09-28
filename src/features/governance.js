/**
 * Governance Feature Module
 * Explore the flagging & voting process: live flags, outcomes over time, protocol
 * parameters, per-flag timeline and votes, and the most involved operators.
 * All data comes from The Graph (Flag, Vote, Network entities).
 */

import * as Services from '../core/services.js';
import * as UI from '../ui/ui.js';
import { escapeHtml, convertWeiToData, formatBigNumber, parseOperatorMetadata, shortAddress, operatorAvatarHtml } from '../core/utils.js';
import { navigationController } from '../ui/navigation.js';

// ============================================
// Constants
// ============================================

const PAGE_SIZE = 500;          // flags per subgraph request
const MAX_PAGES = 10;           // hard cap: 5000 flags per range
const LIST_PAGE = 25;           // rows rendered per "Show more"
const REFRESH_MS = 60 * 1000;   // live data refresh while the view is open
const DAY = 86400;
// A vote only closes when every reviewer voted or when someone triggers the final count after
// voteEndTimestamp (VoteKickPolicy._endVote). Flags still open this long after the voting period
// were never closed on-chain: they have no final result and are not shown as active.
const RESOLUTION_GRACE = 3600;

const RANGES = {
    '30d': { label: '30D', seconds: 30 * DAY, bucket: 'day' },
    '90d': { label: '90D', seconds: 90 * DAY, bucket: 'week' },
    '1y': { label: '1Y', seconds: 365 * DAY, bucket: 'week' },
    'all': { label: 'All', seconds: null, bucket: 'month' },
};

// Subgraph result -> display status
const STATUS = {
    waiting: { label: 'In review', badge: 'bg-amber-500/10 text-amber-400 border-amber-500/30', active: true },
    voting: { label: 'Voting', badge: 'bg-blue-500/10 text-blue-400 border-blue-500/30', active: true },
    kicked: { label: 'Kicked', badge: 'bg-red-500/10 text-red-400 border-red-500/30', active: false },
    failed: { label: 'Not kicked', badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30', active: false },
    unresolved: { label: 'Unresolved', badge: 'bg-gray-500/10 text-gray-400 border-gray-500/30', active: false,
        title: 'The voting period ended but the flag was never closed on-chain, so it has no final result' },
};

const COLORS = { kicked: '#f87171', failed: '#34d399', active: '#60a5fa', unresolved: '#6b7280' };

const FLAG_FIELDS = `
    id lastFlagIndex result metadata
    flaggingTimestamp voteStartTimestamp voteEndTimestamp flagResolutionTimestamp protectionEndTimestamp
    votesForKick votesAgainstKick reviewerCount targetStakeAtRiskWei
    target { id metadataJsonString }
    flagger { id metadataJsonString }
    sponsorship { id stream { id } }
    reviewers { id metadataJsonString }
    votes(first: 100) { id voter { id metadataJsonString } voterWeight timestamp votedKick }`;

// ============================================
// State
// ============================================

const state = {
    initialized: false,
    range: '90d',
    flags: [],              // flags in the selected range (newest first)
    activeFlags: [],        // waiting/voting flags, independent of the range
    network: null,
    truncated: false,
    loadedAt: 0,
    statusFilter: 'all',
    search: '',
    listLimit: LIST_PAGE,
    openFlagId: null,
    chart: null,
    tickTimer: null,
    refreshTimer: null,
    requestId: 0,
};

const el = (id) => document.getElementById(id);
const now = () => Math.floor(Date.now() / 1000);

// ============================================
// Formatting helpers
// ============================================

function formatDuration(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    const d = Math.floor(seconds / DAY);
    const h = Math.floor((seconds % DAY) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function timeAgo(ts) {
    const diff = now() - ts;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < DAY) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}d ago`;
    return formatDate(ts, false);
}

function formatDate(ts, withTime = true) {
    const options = withTime
        ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
        : { year: 'numeric', month: 'short', day: 'numeric' };
    return new Date(ts * 1000).toLocaleString(undefined, options);
}

/**
 * Stream IDs are "<creator address>/<path>": shorten the address so the path stays readable.
 */
function shortStreamId(streamId) {
    const match = /^(0x[0-9a-fA-F]{40})(\/.*)$/.exec(streamId || '');
    return match ? `${shortAddress(match[1])}${match[2]}` : (streamId || '');
}

// Internal app links (handled by the router): operator, stream and sponsorship detail pages
const LINK_CLASS = 'hover:text-white hover:underline underline-offset-2 transition-colors';

function operatorHref(operator) {
    return `/operator/${operator.id}`;
}

function operatorLink(operator, className = 'text-gray-300') {
    if (!operator?.id) return '';
    return `<a href="${operatorHref(operator)}" class="${className} ${LINK_CLASS}" title="${escapeHtml(operator.id)}">${escapeHtml(operatorInfo(operator).name)}</a>`;
}

function streamLink(sponsorship, className = 'text-gray-400') {
    const streamId = sponsorship?.stream?.id;
    if (!streamId) return '';
    return `<a href="/stream/${encodeURIComponent(streamId)}" class="${className} ${LINK_CLASS}" title="${escapeHtml(streamId)}">${escapeHtml(shortStreamId(streamId))}</a>`;
}

function sponsorshipLink(sponsorship, className = 'text-gray-400', label = null) {
    if (!sponsorship?.id) return '';
    const streamId = sponsorship.stream?.id || sponsorship.id;
    const href = `/stream/${encodeURIComponent(streamId)}?sponsored=true&sponsorshipId=${sponsorship.id}`;
    return `<a href="${href}" class="${className} ${LINK_CLASS}" title="Sponsorship ${escapeHtml(sponsorship.id)}">${escapeHtml(label || shortAddress(sponsorship.id))}</a>`;
}

function formatData(wei) {
    return `${formatBigNumber(convertWeiToData(wei || '0'))} DATA`;
}

function formatPercent(value) {
    return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
}

function operatorInfo(operator) {
    const { name } = parseOperatorMetadata(operator?.metadataJsonString);
    return { name: name || shortAddress(operator?.id || '') };
}

function avatar(operator, size = 'w-8 h-8') {
    return operatorAvatarHtml(operator?.metadataJsonString, { className: `${size} border border-[#333]` });
}

/**
 * Status to display: the subgraph result, except open flags whose voting period ended
 * more than RESOLUTION_GRACE ago, which are "unresolved".
 */
function effectiveStatus(flag) {
    if (flag.result === 'kicked' || flag.result === 'failed') return flag.result;
    if (flag.voteEndTimestamp && now() > flag.voteEndTimestamp + RESOLUTION_GRACE) return 'unresolved';
    return flag.result;
}

function statusBadge(flag) {
    const key = effectiveStatus(flag);
    const status = STATUS[key] || { label: escapeHtml(key || 'Unknown'), badge: 'bg-gray-500/10 text-gray-400 border-gray-500/30' };
    const dot = status.active ? '<span class="w-1.5 h-1.5 rounded-full bg-current animate-pulse"></span>' : '';
    const title = status.title ? ` title="${status.title}"` : '';
    return `<span${title} class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-semibold whitespace-nowrap ${status.badge}">${dot}${status.label}</span>`;
}

/**
 * Stake-weighted vote split. Weights are BigInt strings.
 */
function voteSplit(flag) {
    const forKick = BigInt(flag.votesForKick || '0');
    const against = BigInt(flag.votesAgainstKick || '0');
    const total = forKick + against;
    if (total === 0n) return null;
    const kickShare = Number((forKick * 10000n) / total) / 10000;
    return { kickShare, keepShare: 1 - kickShare };
}

function voteBar(flag, height = 'h-1.5') {
    const split = voteSplit(flag);
    if (!split) return `<div class="${height} rounded-full bg-[#2a2a2a]"></div>`;
    return `
        <div class="flex ${height} rounded-full overflow-hidden bg-[#2a2a2a]">
            <div style="width:${split.kickShare * 100}%; background:${COLORS.kicked}"></div>
            <div style="width:${split.keepShare * 100}%; background:${COLORS.failed}"></div>
        </div>`;
}

/**
 * Where an active flag is in its process, for countdowns.
 */
function phaseOf(flag) {
    const t = now();
    if (flag.result === 'waiting' && flag.voteStartTimestamp > t) return { label: 'Voting starts in', target: flag.voteStartTimestamp };
    if (flag.voteEndTimestamp > t) return { label: 'Voting ends in', target: flag.voteEndTimestamp };
    return { label: 'Awaiting resolution', target: null };
}

// ============================================
// Data
// ============================================

async function fetchNetwork() {
    const data = await Services.runQuery(`{
        networks(first: 1) {
            flagStakeWei flagReviewerCount flagReviewerRewardWei flaggerRewardWei
            reviewPeriodSeconds votingPeriodSeconds flagProtectionSeconds slashingFraction
            eligibleVotersCount minEligibleVoterAge
        }
    }`);
    return data?.networks?.[0] || null;
}

async function fetchActiveFlags() {
    const data = await Services.runQuery(`{
        flags(first: 100, orderBy: voteEndTimestamp, orderDirection: asc, where: { result_in: ["waiting", "voting"], voteEndTimestamp_gt: ${now() - RESOLUTION_GRACE} }) { ${FLAG_FIELDS} }
    }`);
    return data?.flags || [];
}

/**
 * All flags raised since `since`, newest first. Paginates on flaggingTimestamp
 * (inclusive cursor + de-duplication, so flags sharing a timestamp are not lost).
 */
async function fetchFlagsSince(since) {
    const flags = [];
    const seen = new Set();
    let cursor = null;

    for (let page = 0; page < MAX_PAGES; page++) {
        const where = [`flaggingTimestamp_gte: ${since}`];
        if (cursor !== null) where.push(`flaggingTimestamp_lte: ${cursor}`);
        const data = await Services.runQuery(`{
            flags(first: ${PAGE_SIZE}, orderBy: flaggingTimestamp, orderDirection: desc, where: { ${where.join(', ')} }) { ${FLAG_FIELDS} }
        }`);
        const batch = data?.flags || [];
        const fresh = batch.filter(f => !seen.has(f.id));
        fresh.forEach(f => { seen.add(f.id); flags.push(f); });

        if (batch.length < PAGE_SIZE || fresh.length === 0) return { flags, truncated: false };
        cursor = batch[batch.length - 1].flaggingTimestamp;
    }
    return { flags, truncated: true };
}

async function fetchFlag(id) {
    const data = await Services.runQuery(`{ flag(id: "${id.replace(/[^0-9a-zA-Z-]/g, '')}") { ${FLAG_FIELDS} } }`);
    return data?.flag || null;
}

async function loadAll() {
    const requestId = ++state.requestId;
    const range = RANGES[state.range];
    const since = range.seconds ? now() - range.seconds : 0;
    renderLoading();

    try {
        const [network, active, { flags, truncated }] = await Promise.all([
            state.network ? Promise.resolve(state.network) : fetchNetwork(),
            fetchActiveFlags(),
            fetchFlagsSince(since),
        ]);
        if (requestId !== state.requestId) return;

        state.network = network;
        state.activeFlags = active;
        state.flags = flags;
        state.truncated = truncated;
        state.loadedAt = Date.now();
        state.listLimit = LIST_PAGE;
        renderAll();
    } catch (error) {
        if (requestId !== state.requestId) return;
        console.error('Governance data error:', error);
        el('gov-flags-list').innerHTML = `<p class="p-6 text-sm text-red-400">Could not load governance data.</p>`;
        UI.showToast({ type: 'error', title: 'Governance', message: 'Could not load data from The Graph.', duration: 5000 });
    }
}

async function refreshActive() {
    try {
        const active = await fetchActiveFlags();
        // Flags that just left the active set: update them in the range list too
        const activeIds = new Set(active.map(f => f.id));
        const resolvedIds = state.activeFlags.filter(f => !activeIds.has(f.id)).map(f => f.id);
        state.activeFlags = active;
        if (resolvedIds.length) {
            const updated = await Promise.all(resolvedIds.map(fetchFlag));
            updated.filter(Boolean).forEach(flag => {
                const index = state.flags.findIndex(f => f.id === flag.id);
                if (index !== -1) state.flags[index] = flag;
            });
            renderAll();
        } else {
            renderKpis();
            renderLive();
        }
    } catch (error) {
        console.warn('Governance live refresh failed:', error);
    }
}

// ============================================
// Rendering
// ============================================

function renderLoading() {
    el('gov-kpis').innerHTML = Array.from({ length: 6 }, () =>
        '<div class="detail-section p-4 h-[92px] animate-pulse"><div class="h-3 w-16 bg-[#2a2a2a] rounded"></div><div class="h-6 w-12 bg-[#2a2a2a] rounded mt-3"></div></div>').join('');
    el('gov-flags-list').innerHTML = `
        <div class="flex items-center justify-center py-16">
            <div class="loader rounded-full border-4 border-[#555555] border-t-transparent h-8 w-8"></div>
        </div>`;
    el('gov-range-note').textContent = '';
}

function renderAll() {
    renderKpis();
    renderLive();
    renderChart();
    renderProcess();
    renderList();
    renderLeaderboards();
    const range = RANGES[state.range];
    el('gov-range-note').textContent = state.truncated
        ? `Showing the latest ${state.flags.length} flags`
        : `${state.flags.length} flag${state.flags.length === 1 ? '' : 's'} ${range.seconds ? `in the last ${range.label}` : 'in total'}`;
}

function kpiTile(label, value, sub = '', accent = '') {
    return `
        <div class="detail-section p-4">
            <p class="text-[11px] font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">${accent}${label}</p>
            <p class="text-2xl font-bold text-white mt-1.5">${value}</p>
            <p class="text-xs text-gray-500 mt-0.5 truncate">${sub}</p>
        </div>`;
}

function renderKpis() {
    const kicked = state.flags.filter(f => f.result === 'kicked').length;
    const unresolved = state.flags.filter(f => effectiveStatus(f) === 'unresolved').length;
    const failed = state.flags.filter(f => f.result === 'failed').length;
    const resolved = state.flags.filter(f => f.result === 'kicked' || f.result === 'failed');
    const seats = resolved.reduce((sum, f) => sum + (f.reviewerCount || 0), 0);
    const votes = resolved.reduce((sum, f) => sum + (f.votes?.length || 0), 0);
    const atRisk = state.activeFlags.reduce((sum, f) => sum + BigInt(f.targetStakeAtRiskWei || '0'), 0n);
    const liveDot = state.activeFlags.length ? '<span class="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"></span>' : '';

    el('gov-kpis').innerHTML = [
        kpiTile('Flags', state.flags.length, `${RANGES[state.range].seconds ? `Last ${RANGES[state.range].label}` : 'All time'}${unresolved ? ` · ${unresolved} unresolved` : ''}`),
        kpiTile('Active now', state.activeFlags.length, state.activeFlags.length ? `${formatData(atRisk.toString())} at risk` : 'No open flags', liveDot),
        kpiTile('Kicked', kicked, 'Flag upheld'),
        kpiTile('Not kicked', failed, 'Flag rejected'),
        kpiTile('Kick rate', formatPercent(kicked / (kicked + failed)), `${kicked + failed} resolved`),
        kpiTile('Participation', formatPercent(votes / seats), 'Reviewer votes cast'),
    ].join('');
}

function renderLive() {
    const section = el('gov-live');
    section.classList.toggle('hidden', state.activeFlags.length === 0);
    if (!state.activeFlags.length) return;

    el('gov-live-count').textContent = state.activeFlags.length;
    el('gov-live-list').innerHTML = state.activeFlags.map(flag => {
        const target = operatorInfo(flag.target);
        const phase = phaseOf(flag);
        const voted = flag.votes?.length || 0;
        return `
            <div role="button" tabindex="0" data-flag-id="${flag.id}" class="gov-flag-open text-left p-4 rounded-xl bg-[#121212] border border-[#333] hover:border-[#555] cursor-pointer transition-colors min-w-[260px] sm:min-w-0">
                <div class="flex items-center justify-between gap-2">
                    ${statusBadge(flag)}
                    <span class="text-[11px] text-gray-500">${voted}/${flag.reviewerCount} voted</span>
                </div>
                <div class="flex items-center gap-2.5 mt-3">
                    ${avatar(flag.target)}
                    <div class="min-w-0">
                        <p class="text-sm font-semibold truncate">${operatorLink(flag.target, 'text-white')}</p>
                        <p class="text-xs truncate">${streamLink(flag.sponsorship, 'text-gray-500')}</p>
                    </div>
                </div>
                <div class="mt-3">${voteBar(flag)}</div>
                <p class="mt-2 text-xs text-gray-400">${phase.label}${phase.target ? ` <span class="text-white font-medium tabular-nums" data-countdown="${phase.target}">${formatDuration(phase.target - now())}</span>` : ''}</p>
            </div>`;
    }).join('');
}

function bucketStart(ts, bucket) {
    const d = new Date(ts * 1000);
    if (bucket === 'day') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    if (bucket === 'week') {
        const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        return day - ((d.getUTCDay() + 6) % 7) * DAY * 1000; // Monday
    }
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function nextBucket(ms, bucket) {
    const d = new Date(ms);
    if (bucket === 'day') return ms + DAY * 1000;
    if (bucket === 'week') return ms + 7 * DAY * 1000;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function renderChart() {
    const canvas = el('gov-chart');
    const empty = el('gov-chart-empty');
    if (state.chart) {
        state.chart.destroy();
        state.chart = null;
    }
    empty.classList.toggle('hidden', state.flags.length > 0);
    const hasUnresolved = state.flags.some(f => effectiveStatus(f) === 'unresolved');
    el('gov-legend-unresolved').classList.toggle('hidden', !hasUnresolved);
    el('gov-legend-unresolved').classList.toggle('flex', hasUnresolved);
    canvas.classList.toggle('hidden', state.flags.length === 0);
    if (!state.flags.length || typeof Chart === 'undefined') return;

    const range = RANGES[state.range];
    const bucket = range.bucket;
    const first = range.seconds ? now() - range.seconds : Math.min(...state.flags.map(f => f.flaggingTimestamp));
    const buckets = new Map();
    for (let ms = bucketStart(first, bucket); ms <= Date.now(); ms = nextBucket(ms, bucket)) {
        buckets.set(ms, { kicked: 0, failed: 0, active: 0, unresolved: 0 });
    }
    state.flags.forEach(flag => {
        const key = bucketStart(flag.flaggingTimestamp, bucket);
        const entry = buckets.get(key);
        if (!entry) return;
        const status = effectiveStatus(flag);
        if (status === 'kicked' || status === 'failed' || status === 'unresolved') entry[status]++;
        else entry.active++;
    });

    const labelFormat = bucket === 'month' ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' };
    const labels = [...buckets.keys()].map(ms => new Date(ms).toLocaleDateString(undefined, labelFormat));
    const values = [...buckets.values()];
    const dataset = (key, label) => ({
        label, data: values.map(v => v[key]), backgroundColor: COLORS[key], borderRadius: 3, borderSkipped: false, maxBarThickness: 28,
    });

    state.chart = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: { labels, datasets: [dataset('kicked', 'Kicked'), dataset('failed', 'Not kicked'), dataset('active', 'Active'), dataset('unresolved', 'Unresolved')] },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#1E1E1E', borderColor: '#333', borderWidth: 1, titleColor: '#fff', bodyColor: '#a3a3a3',
                    titleFont: { family: 'Inter, system-ui, sans-serif', size: 12 }, bodyFont: { family: 'Inter, system-ui, sans-serif', size: 11 },
                    padding: 10, cornerRadius: 6,
                    filter: (item) => item.raw > 0,
                },
            },
            scales: {
                x: { stacked: true, grid: { display: false }, ticks: { color: '#666', font: { size: 10, family: 'Inter, system-ui, sans-serif' }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
                y: { stacked: true, beginAtZero: true, grid: { color: '#2a2a2a' }, border: { display: false }, ticks: { color: '#666', precision: 0, font: { size: 10, family: 'Inter, system-ui, sans-serif' } } },
            },
        },
    });
}

function renderProcess() {
    const n = state.network;
    const value = (v) => `<span class="text-white font-medium">${v}</span>`;
    const step = (index, title, body) => `
        <li class="group relative pl-9 pb-5 last:pb-0">
            <span class="absolute left-0 top-0 w-6 h-6 rounded-full bg-[#121212] border border-[#333] text-[11px] font-semibold text-gray-400 flex items-center justify-center">${index}</span>
            <span class="absolute left-3 top-6 bottom-0 w-px bg-[#333] group-last:hidden"></span>
            <p class="text-sm font-semibold text-white">${title}</p>
            <p class="text-xs text-gray-400 mt-0.5 leading-relaxed">${body}</p>
        </li>`;

    if (!n) {
        el('gov-process').innerHTML = '<p class="text-sm text-gray-500">Network parameters unavailable.</p>';
        return;
    }
    const slashing = formatPercent(Number(BigInt(n.slashingFraction || '0') * 10000n / 10n ** 18n) / 10000);

    el('gov-process').innerHTML = `
        <ol>
            ${step(1, 'Flag raised', `An operator staked in the same sponsorship flags another one, locking ${value(formatData(n.flagStakeWei))} as flag stake.`)}
            ${step(2, 'Reviewers selected', `${value(n.flagReviewerCount)} eligible operators are picked as reviewers. Review period: ${value(formatDuration(n.reviewPeriodSeconds))}.`)}
            ${step(3, 'Voting', `Reviewers vote to kick or keep; votes are weighted by stake. Voting period: ${value(formatDuration(n.votingPeriodSeconds))}.`)}
            ${step(4, 'Outcome', `Kicked: the target is removed and ${value(slashing)} of its stake is slashed. Reviewers earn ${value(formatData(n.flagReviewerRewardWei))} each; a successful flagger earns ${value(formatData(n.flaggerRewardWei))}.`)}
            ${step(5, 'Protection', `After a flag, the target cannot be flagged again for ${value(formatDuration(n.flagProtectionSeconds))}.`)}
        </ol>
        <p class="text-xs text-gray-500 mt-4 pt-4 border-t border-[#2a2a2a]">${value(formatBigNumber(String(n.eligibleVotersCount)))} operators are currently eligible to review.</p>`;
}

function filteredFlags() {
    const search = state.search.toLowerCase();
    return state.flags.filter(flag => {
        const status = state.statusFilter;
        const flagStatus = effectiveStatus(flag);
        if (status === 'active' && !STATUS[flagStatus]?.active) return false;
        if (['kicked', 'failed', 'unresolved'].includes(status) && flagStatus !== status) return false;
        if (!search) return true;
        const haystack = [
            flag.target?.id, flag.flagger?.id, flag.sponsorship?.id, flag.sponsorship?.stream?.id,
            operatorInfo(flag.target).name, operatorInfo(flag.flagger).name,
        ].join(' ').toLowerCase();
        return haystack.includes(search);
    });
}

function renderList() {
    const flags = filteredFlags();
    const visible = flags.slice(0, state.listLimit);

    document.querySelectorAll('#gov-status-filter [data-status]').forEach(button => {
        const active = button.dataset.status === state.statusFilter;
        button.classList.toggle('bg-[#2C2C2C]', active);
        button.classList.toggle('text-white', active);
        button.classList.toggle('text-gray-400', !active);
    });

    if (!flags.length) {
        el('gov-flags-list').innerHTML = `<p class="p-6 text-sm text-gray-500 text-center">No flags match the current filters.</p>`;
        el('gov-show-more').classList.add('hidden');
        el('gov-show-all').classList.add('hidden');
        return;
    }

    el('gov-flags-list').innerHTML = visible.map(flag => {
        const split = voteSplit(flag);
        const voted = flag.votes?.length || 0;
        return `
            <div role="button" tabindex="0" data-flag-id="${flag.id}" class="gov-flag-open grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[6.5rem_minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1.2fr)_5.5rem] items-center gap-x-4 gap-y-2.5 px-4 sm:px-6 py-3.5 hover:bg-white/[0.02] cursor-pointer transition-colors">
                <div class="col-start-1 row-start-1 md:col-auto md:row-auto">${statusBadge(flag)}</div>
                <div class="col-span-2 md:col-span-1 flex items-center gap-2.5 min-w-0">
                    ${avatar(flag.target)}
                    <div class="min-w-0">
                        <p class="text-sm font-medium truncate">${operatorLink(flag.target, 'text-white')}</p>
                        <p class="text-xs text-gray-500 truncate">flagged by ${operatorLink(flag.flagger, 'text-gray-400')}</p>
                    </div>
                </div>
                <div class="hidden md:block min-w-0">
                    <p class="text-xs truncate">${streamLink(flag.sponsorship, 'text-gray-300')}</p>
                    <p class="text-[11px] text-gray-500 truncate">${sponsorshipLink(flag.sponsorship, 'text-gray-500')}</p>
                </div>
                <div class="col-span-2 md:col-span-1 min-w-0">
                    ${voteBar(flag)}
                    <p class="text-[11px] text-gray-500 mt-1">${split ? `${formatPercent(split.kickShare)} kick · ` : ''}${voted}/${flag.reviewerCount} voted</p>
                </div>
                <p class="col-start-2 row-start-1 md:col-auto md:row-auto text-xs text-gray-500 text-right whitespace-nowrap" title="${formatDate(flag.flaggingTimestamp)}">${timeAgo(flag.flaggingTimestamp)}</p>
            </div>`;
    }).join('');

    const remaining = flags.length - visible.length;
    el('gov-show-more').classList.toggle('hidden', remaining <= 0);
    el('gov-show-more').textContent = `Show more (${remaining})`;
    el('gov-show-all').classList.toggle('hidden', remaining <= 0);
}

function leaderboardRow(operator, primary, secondary) {
    const info = operatorInfo(operator);
    return `
        <li class="flex items-center gap-3 py-2">
            ${avatar(operator, 'w-7 h-7')}
            <a href="${operatorHref(operator)}" class="flex-1 min-w-0 text-sm text-gray-300 truncate ${LINK_CLASS}" title="${escapeHtml(operator.id)}">${escapeHtml(info.name)}</a>
            <div class="text-right flex-shrink-0">
                <p class="text-sm font-semibold text-white tabular-nums">${primary}</p>
                <p class="text-[11px] text-gray-500">${secondary}</p>
            </div>
        </li>`;
}

function topBy(map, count = 5) {
    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, count);
}

function renderLeaderboards() {
    const targets = new Map();
    const flaggers = new Map();
    const reviewers = new Map();
    const add = (map, operator) => {
        if (!operator?.id) return null;
        if (!map.has(operator.id)) map.set(operator.id, { operator, count: 0, kicked: 0, agreed: 0, resolvedVotes: 0, selected: 0 });
        return map.get(operator.id);
    };

    state.flags.forEach(flag => {
        const resolved = flag.result === 'kicked' || flag.result === 'failed';
        const t = add(targets, flag.target);
        if (t) { t.count++; if (flag.result === 'kicked') t.kicked++; }
        const f = add(flaggers, flag.flagger);
        if (f) { f.count++; if (flag.result === 'kicked') f.kicked++; }
        (flag.reviewers || []).forEach(r => { const entry = add(reviewers, r); if (entry) entry.selected++; });
        (flag.votes || []).forEach(vote => {
            const entry = add(reviewers, vote.voter);
            if (!entry) return;
            entry.count++;
            if (resolved) {
                entry.resolvedVotes++;
                if (vote.votedKick === (flag.result === 'kicked')) entry.agreed++;
            }
        });
    });

    const empty = '<li class="py-6 text-sm text-gray-500 text-center">No data in this range.</li>';
    el('gov-top-targets').innerHTML = topBy(targets).map(e =>
        leaderboardRow(e.operator, e.count, `${e.kicked} kicked`)).join('') || empty;
    el('gov-top-flaggers').innerHTML = topBy(flaggers).map(e =>
        leaderboardRow(e.operator, e.count, `${formatPercent(e.kicked / e.count)} upheld`)).join('') || empty;
    el('gov-top-reviewers').innerHTML = topBy(reviewers).filter(e => e.count > 0).map(e =>
        leaderboardRow(e.operator, e.count, `${e.selected ? formatPercent(e.count / e.selected) : '—'} turnout · ${e.resolvedVotes ? formatPercent(e.agreed / e.resolvedVotes) : '—'} with outcome`)).join('') || empty;
}

// ============================================
// Flag detail drawer
// ============================================

function timelineStep(label, ts, isFuture, detail = '') {
    const dot = isFuture
        ? 'border-[#555] bg-[#1E1E1E]'
        : 'border-blue-500 bg-blue-500';
    return `
        <li class="group relative pl-7 pb-5 last:pb-0">
            <span class="absolute left-0 top-1 w-3 h-3 rounded-full border-2 ${dot}"></span>
            <span class="absolute left-[5px] top-4 bottom-0 w-px bg-[#333] group-last:hidden"></span>
            <div class="flex items-baseline justify-between gap-3">
                <p class="text-sm ${isFuture ? 'text-gray-400' : 'text-white'} font-medium">${label}</p>
                <p class="text-xs text-gray-500 whitespace-nowrap" title="${formatDate(ts)}">${isFuture
                    ? `in <span data-countdown="${ts}" class="tabular-nums">${formatDuration(ts - now())}</span>`
                    : timeAgo(ts)}</p>
            </div>
            <p class="text-xs text-gray-500 mt-0.5">${formatDate(ts)}${detail ? ` · ${detail}` : ''}</p>
        </li>`;
}

function renderDrawer(flag) {
    const t = now();
    const target = operatorInfo(flag.target);
    const split = voteSplit(flag);
    const resolved = flag.result === 'kicked' || flag.result === 'failed';
    const votesByVoter = new Map((flag.votes || []).map(v => [v.voter.id, v]));
    const forKick = BigInt(flag.votesForKick || '0');
    const against = BigInt(flag.votesAgainstKick || '0');

    // Reviewers with their vote (or none); voters not listed as reviewers are included too
    const reviewerIds = new Set((flag.reviewers || []).map(r => r.id));
    const rows = [
        ...(flag.reviewers || []).map(r => ({ operator: r, vote: votesByVoter.get(r.id) })),
        ...(flag.votes || []).filter(v => !reviewerIds.has(v.voter.id)).map(v => ({ operator: v.voter, vote: v })),
    ].sort((a, b) => (b.vote ? 1 : 0) - (a.vote ? 1 : 0));

    const timeline = [
        timelineStep('Flagged', flag.flaggingTimestamp, false, `by ${operatorLink(flag.flagger, 'text-gray-400')}`),
        flag.voteStartTimestamp ? timelineStep('Voting starts', flag.voteStartTimestamp, flag.voteStartTimestamp > t) : '',
        flag.voteEndTimestamp ? timelineStep('Voting ends', flag.voteEndTimestamp, flag.voteEndTimestamp > t) : '',
        resolved && flag.flagResolutionTimestamp ? timelineStep(flag.result === 'kicked' ? 'Kicked' : 'Flag rejected', flag.flagResolutionTimestamp, false) : '',
        flag.protectionEndTimestamp ? timelineStep('Protection ends', flag.protectionEndTimestamp, flag.protectionEndTimestamp > t) : '',
    ].join('');

    el('gov-drawer-body').innerHTML = `
        <div class="flex items-center gap-3">
            ${avatar(flag.target, 'w-12 h-12')}
            <div class="min-w-0">
                <div class="flex items-center gap-2">${statusBadge(flag)}<span class="text-xs text-gray-500">Flag #${flag.lastFlagIndex ?? ''}</span></div>
                <p class="text-lg font-semibold truncate mt-1">${operatorLink(flag.target, 'text-white')}</p>
            </div>
        </div>

        ${effectiveStatus(flag) === 'unresolved' ? `
        <div class="mt-5 p-3 rounded-lg bg-[#121212] border border-[#333] text-xs text-gray-400 leading-relaxed">
            Voting ended ${timeAgo(flag.voteEndTimestamp)}, but the flag was never closed on-chain (the final vote count is only
            triggered when all reviewers vote or by a call after the voting period). It has no final result.
        </div>` : ''}

        <dl class="grid grid-cols-2 gap-3 mt-5">
            <div class="p-3 rounded-lg bg-[#121212] border border-[#2a2a2a]"><dt class="text-[11px] text-gray-500 uppercase tracking-wider">Target</dt><dd class="text-sm mt-1 truncate">${operatorLink(flag.target)}</dd></div>
            <div class="p-3 rounded-lg bg-[#121212] border border-[#2a2a2a]"><dt class="text-[11px] text-gray-500 uppercase tracking-wider">Flagger</dt><dd class="text-sm mt-1 truncate">${operatorLink(flag.flagger)}</dd></div>
            <div class="p-3 rounded-lg bg-[#121212] border border-[#2a2a2a]"><dt class="text-[11px] text-gray-500 uppercase tracking-wider">Stake at risk</dt><dd class="text-sm text-white mt-1">${formatData(flag.targetStakeAtRiskWei)}</dd></div>
            <div class="p-3 rounded-lg bg-[#121212] border border-[#2a2a2a]"><dt class="text-[11px] text-gray-500 uppercase tracking-wider">Votes</dt><dd class="text-sm text-white mt-1">${flag.votes?.length || 0} / ${flag.reviewerCount}</dd></div>
            <div class="col-span-2 p-3 rounded-lg bg-[#121212] border border-[#2a2a2a]"><dt class="text-[11px] text-gray-500 uppercase tracking-wider">Stream</dt><dd class="text-sm mt-1 truncate">${streamLink(flag.sponsorship, 'text-gray-300')}</dd></div>
            <div class="col-span-2 p-3 rounded-lg bg-[#121212] border border-[#2a2a2a]"><dt class="text-[11px] text-gray-500 uppercase tracking-wider">Sponsorship</dt><dd class="text-sm mt-1 truncate">${sponsorshipLink(flag.sponsorship, 'text-gray-300', flag.sponsorship?.id)}</dd></div>
        </dl>

        <section class="mt-6">
            <h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Vote</h3>
            ${voteBar(flag, 'h-2.5')}
            <div class="flex justify-between mt-2 text-xs">
                <span class="text-red-400">Kick ${split ? formatPercent(split.kickShare) : '—'} <span class="text-gray-500">· ${formatData(forKick.toString())}</span></span>
                <span class="text-emerald-400">Keep ${split ? formatPercent(split.keepShare) : '—'} <span class="text-gray-500">· ${formatData(against.toString())}</span></span>
            </div>
        </section>

        <section class="mt-6">
            <h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Timeline</h3>
            <ol>${timeline}</ol>
        </section>

        <section class="mt-6">
            <h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Reviewers</h3>
            <ul class="divide-y divide-[#2a2a2a]">
                ${rows.map(({ operator, vote }) => `
                    <li class="flex items-center gap-3 py-2.5">
                        ${avatar(operator, 'w-7 h-7')}
                        <div class="flex-1 min-w-0 text-sm truncate">${operatorLink(operator)}</div>
                        ${vote
                            ? `<div class="text-right"><p class="text-xs font-semibold ${vote.votedKick ? 'text-red-400' : 'text-emerald-400'}">${vote.votedKick ? 'Kick' : 'Keep'}</p><p class="text-[11px] text-gray-500">${formatData(vote.voterWeight)} · ${timeAgo(vote.timestamp)}</p></div>`
                            : '<span class="text-xs text-gray-500">No vote</span>'}
                    </li>`).join('') || '<li class="py-3 text-sm text-gray-500">No reviewers assigned yet.</li>'}
            </ul>
        </section>

        <section id="gov-drawer-metadata" class="mt-6 hidden">
            <h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Flag metadata</h3>
            <pre class="p-3 rounded-lg bg-[#121212] border border-[#2a2a2a] text-xs text-gray-400 whitespace-pre-wrap break-all font-mono"></pre>
        </section>`;

    // Metadata is free text written by the flagger: render as text only
    if (flag.metadata) {
        el('gov-drawer-metadata').classList.remove('hidden');
        el('gov-drawer-metadata').querySelector('pre').textContent = flag.metadata;
    }
}

function setDrawerOpen(open) {
    el('gov-drawer').classList.toggle('translate-x-full', !open);
    el('gov-drawer-overlay').classList.toggle('hidden', !open);
    document.body.classList.toggle('overflow-hidden', open);
}

async function openFlag(flagId) {
    state.openFlagId = flagId;
    let flag = state.flags.find(f => f.id === flagId) || state.activeFlags.find(f => f.id === flagId);
    setDrawerOpen(true);
    if (!flag) {
        el('gov-drawer-body').innerHTML = '<div class="flex justify-center py-16"><div class="loader rounded-full border-4 border-[#555555] border-t-transparent h-8 w-8"></div></div>';
        try {
            flag = await fetchFlag(flagId);
        } catch (error) {
            console.error('Governance flag error:', error);
        }
        if (state.openFlagId !== flagId) return;
        if (!flag) {
            el('gov-drawer-body').innerHTML = '<p class="text-sm text-gray-500">Flag not found.</p>';
            return;
        }
    }
    renderDrawer(flag);
    navigationController.updatePageTitle('governance', `Governance · ${operatorInfo(flag.target).name}`);
}

function closeFlag() {
    state.openFlagId = null;
    setDrawerOpen(false);
    navigationController.updatePageTitle('governance');
}

// ============================================
// Live updates
// ============================================

function tick() {
    const t = now();
    document.querySelectorAll('#governance-view [data-countdown]').forEach(node => {
        node.textContent = formatDuration(Number(node.dataset.countdown) - t);
    });
}

function startTimers() {
    stopTimers();
    state.tickTimer = setInterval(tick, 1000);
    state.refreshTimer = setInterval(() => {
        if (!document.hidden) refreshActive();
    }, REFRESH_MS);
}

function stopTimers() {
    clearInterval(state.tickTimer);
    clearInterval(state.refreshTimer);
    state.tickTimer = null;
    state.refreshTimer = null;
}

// ============================================
// Public API
// ============================================

export const GovernanceLogic = {
    setupEventListeners() {
        el('gov-range').addEventListener('click', (e) => {
            const button = e.target.closest('[data-range]');
            if (!button || button.dataset.range === state.range) return;
            state.range = button.dataset.range;
            document.querySelectorAll('#gov-range [data-range]').forEach(b => {
                const active = b.dataset.range === state.range;
                b.classList.toggle('bg-blue-800', active);
                b.classList.toggle('text-white', active);
                b.classList.toggle('text-gray-300', !active);
                b.classList.toggle('hover:bg-[#444444]', !active);
            });
            loadAll();
        });
        el('gov-refresh').addEventListener('click', () => {
            state.network = null;
            loadAll();
        });
        el('gov-status-filter').addEventListener('click', (e) => {
            const button = e.target.closest('[data-status]');
            if (!button) return;
            state.statusFilter = button.dataset.status;
            state.listLimit = LIST_PAGE;
            renderList();
        });
        let searchTimer;
        el('gov-search').addEventListener('input', (e) => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                state.search = e.target.value.trim();
                state.listLimit = LIST_PAGE;
                renderList();
            }, 200);
        });
        el('gov-show-more').addEventListener('click', () => {
            state.listLimit += LIST_PAGE;
            renderList();
        });
        el('gov-show-all').addEventListener('click', () => {
            state.listLimit = Infinity;
            renderList();
        });

        // Open a flag (list rows and live cards); inner links keep their own navigation
        el('governance-view').addEventListener('click', (e) => {
            if (e.target.closest('a')) return;
            const row = e.target.closest('.gov-flag-open');
            if (row) window.router.navigate(`/governance/flag/${row.dataset.flagId}`);
        });
        el('governance-view').addEventListener('keydown', (e) => {
            if (e.target.closest('a')) return;
            const row = e.target.closest('.gov-flag-open');
            if (row && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                window.router.navigate(`/governance/flag/${row.dataset.flagId}`);
            }
        });

        // Close the drawer (back to /governance keeps history consistent)
        const close = () => window.router.navigate('/governance');
        el('gov-drawer-close').addEventListener('click', close);
        el('gov-drawer-overlay').addEventListener('click', close);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && state.openFlagId) close();
        });
        // Links inside the drawer navigate to other pages: close it first
        el('gov-drawer').addEventListener('click', (e) => {
            if (e.target.closest('a[href^="/"]')) closeFlag();
        });
    },

    /**
     * Shows the governance view, optionally with a flag open in the drawer.
     * @param {string} [flagId]
     */
    async show(flagId) {
        startTimers();
        const stale = Date.now() - state.loadedAt > 5 * 60 * 1000;
        if (!state.initialized || stale) {
            state.initialized = true;
            loadAll();
        }
        if (flagId) openFlag(flagId);
        else if (state.openFlagId) closeFlag();
    },

    stop() {
        stopTimers();
        state.requestId++;
        if (state.openFlagId) {
            state.openFlagId = null;
            setDrawerOpen(false);
        }
    },
};
