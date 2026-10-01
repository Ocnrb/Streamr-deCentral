/**
 * Overview Feature Module
 * Home page: the Streamr Network at a glance. A row of network numbers (stake, delegations, APY,
 * operators, sponsorships, streams, DATA sponsored and slashed, DATA price); the selected one opens
 * its chart over time. Below: top operators, best sponsorships and the latest staking, delegation
 * and governance events.
 *
 * Everything comes from The Graph, except the DATA price (the app's price streams) and the operators'
 * own events read through the Etherscan API (Delegated / Undelegated, and OperatorSlashed, which every
 * slashing reports to the operator contract):
 * - totals: sums over every operator and sponsorship (paged), the slashings, the streams' creation dates;
 * - history: the daily buckets of sponsorships and operators (each keeps its last bucket until the next one),
 *   and the dated sponsoring events, slashings and stream creations, added up over time.
 */

import * as Services from '../core/services.js';
import { POLYGONSCAN_NETWORK, getEtherscanApiKey } from '../core/constants.js';
import { escapeHtml, convertWeiToData, formatBigNumber, parseOperatorMetadata, shortAddress, operatorAvatarHtml, calculateWeightedApy, logger } from '../core/utils.js';

// ============================================
// Constants
// ============================================

const DAY = 86400;
const REFRESH_MS = 60 * 1000;            // totals and lists while the page is open
const STREAMS_REFRESH_MS = 10 * 60 * 1000;
const LIST_SIZE = 5;
const PAGE = 1000;                       // rows per subgraph request (The Graph's maximum)
const MAX_SKIP_PAGES = 5;                // skip is capped at 5000 by graph-node
const ALIASES = 10;                      // queries per subgraph request
const CONCURRENCY = 4;
// Streamr 1.0 staking went live late November 2023 (the Leaderboard starts there too)
const NETWORK_START = Math.floor(Date.UTC(2023, 11, 1) / 1000);
const STREAMS_START = Math.floor(Date.UTC(2020, 0, 1) / 1000);
const STREAMS_CACHE_KEY = 'overview.streamsByDay.v1';

// Operator contract events (the subgraph keeps no delegation history)
const DELEGATION_TOPICS = {
    delegate: ethers.utils.id('Delegated(address,uint256)'),
    undelegate: ethers.utils.id('Undelegated(address,uint256)')
};
// Operator.onSlash: the DATA a sponsorship slashed from the operator
const SLASHED_TOPIC = ethers.utils.id('OperatorSlashed(uint256,uint256,uint256)');
const OPERATORS_FIRST_BLOCK = 49000000;      // Polygon, before Streamr 1.0 (November 2023)
const POLYGON_BLOCKS_PER_DAY = 43200;
const DELEGATION_WINDOWS_DAYS = [1, 7, 30];   // looked back further while there are fewer than LIST_SIZE events
const EXPLORER_BUSY = /rate limit|max calls|too many|timeout|temporarily|busy/i;

// Chart ranges: one point per `step` days
const RANGES = {
    '30d': { label: '30D', days: 30, step: 1 },
    '1y': { label: '1Y', days: 365, step: 7 },
    'all': { label: 'All', days: null, step: 14 }
};

// The numbers in the stats row; `source` loads the history (one load serves the metrics sharing it)
const METRICS = {
    staked: { label: 'Total staked', kind: 'data', source: 'sponsorships',
        info: 'DATA staked by the operators in sponsorships.<br>Over time: the daily records of each sponsorship.' },
    delegated: { label: 'Delegated', kind: 'data', source: 'operators',
        info: 'DATA delegated to the operators by delegators, without the owners\' own stake in their operator.<br>Over time: the daily value of each operator, with its owner\'s share as it is now.' },
    apy: { label: 'Network APY', kind: 'percent', source: 'sponsorships',
        info: 'APY of the running sponsorships weighted by their stake: their yearly payouts over the DATA staked in them, before the operators\' cut.' },
    operators: { label: 'Operators', kind: 'count', source: 'operators',
        info: 'Operators with stake in sponsorships.<br>Nodes: the node addresses these operators registered in their contract (not a live count).' },
    sponsorships: { label: 'Sponsorships', kind: 'count', source: 'sponsorships',
        info: 'Running sponsorships: funds left and DATA staked.<br>Over time: the daily records of each sponsorship.' },
    streams: { label: 'Streams', kind: 'count', source: 'streams',
        info: 'Streams created on the Streamr Network, by their creation date.<br>Deleted streams are not counted.' },
    sponsored: { label: 'DATA sponsored', kind: 'data', source: 'sponsoring',
        info: 'DATA paid into sponsorships by their sponsors, all time.' },
    slashed: { label: 'DATA slashed', kind: 'data', source: 'slashing',
        info: 'DATA slashed from operators, all time: every slashing their sponsorships reported to the operator contracts (onSlash).' },
    price: { label: 'DATA price', kind: 'price', source: 'price',
        info: 'DATA/USD from the app\'s price feed: the daily history, then the latest price.' }
};
const METRIC_ORDER = ['staked', 'delegated', 'apy', 'operators', 'sponsorships', 'streams', 'sponsored', 'slashed', 'price'];

const BADGES = {
    flagged: { label: 'Flagged', badge: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
    kick: { label: 'Voted kick', badge: 'bg-red-500/10 text-red-400 border-red-500/30' },
    keep: { label: 'Voted no kick', badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
    kicked: { label: 'Kicked', badge: 'bg-red-500/10 text-red-400 border-red-500/30' },
    failed: { label: 'Not kicked', badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
    self: { label: 'Self', badge: 'bg-purple-500/10 text-purple-300 border-purple-500/30' },
    delegator: { label: 'Delegator', badge: 'bg-blue-500/10 text-blue-300 border-blue-500/30' },
    owner: { label: 'Owner', badge: 'bg-purple-500/10 text-purple-300 border-purple-500/30' }
};

// ============================================
// State
// ============================================

const state = {
    active: false,
    initialized: false,
    timer: null,
    streamsTimer: null,
    loaded: false,
    error: false,
    network: null,
    allOperators: [],
    ownerShare: new Map(),      // operator id -> owner's share of its value now
    allSponsorships: [],
    bestStreams: [],
    slashing: null,             // { total, count } of the operators' slashings
    slashingEvents: [],         // [{ t, v }] oldest first
    slashingSeen: new Set(),
    slashingFrom: OPERATORS_FIRST_BLOCK,
    slashingLoading: null,
    slashingError: false,
    totals: null,
    totalsPromise: null,
    streams: null,              // { byDay: Map(day -> count), total }
    streamsLoading: false,
    topOperators: [],
    stakingEvents: [],
    delegations: [],
    delegationsLoaded: false,
    delegationsError: false,
    govEvents: [],
    priceHistory: [],           // daily DATA/USD (ms, USD)
    metric: 'staked',           // metric whose chart is open (null: closed)
    range: '1y',
    activity: 'staking',
    history: {},                // `${source}:${range}` -> { series: points[] } | 'loading' | 'error'
    sponsoringEvents: null,     // sorted [{ t, v }]
    chart: null
};

const $ = (id) => document.getElementById(id);
const now = () => Math.floor(Date.now() / 1000);

// ============================================
// Formatting
// ============================================

const weiToNumber = (wei) => Number(convertWeiToData(wei || '0', true)) || 0;

/** 182.4M, 12.5K: stat values (the full number is in the tooltip) */
function compact(value) {
    const abs = Math.abs(value);
    if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e8 ? 0 : 1)}M`;
    if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}K`;
    return value.toFixed(0);
}

const full = (value) => formatBigNumber(Math.round(value).toString());

function formatPrice(value) {
    if (!(value > 0)) return '--';
    return `$${value >= 1 ? value.toFixed(2) : String(Number(value.toPrecision(3)))}`;
}

function formatPercent(value, digits = 1) {
    return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '--';
}

/** A metric's value: short (stats, axis) or long (chart header and tooltip) */
function formatMetric(kind, value, long = false) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '--';
    if (kind === 'data') return long ? `${full(value)} DATA` : compact(value);
    if (kind === 'count') return long ? full(value) : (value >= 1e4 ? compact(value) : full(value));
    if (kind === 'percent') return formatPercent(value);
    if (kind === 'price') return value > 0 ? formatPrice(value) : '$0';
    return String(value);
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

function sponsorshipHref(sponsorshipId, streamId) {
    return `/stream/${encodeURIComponent(streamId || sponsorshipId)}?sponsored=true&sponsorshipId=${sponsorshipId}`;
}

function currentPrice() {
    return Services.getCurrentLivePrice() || state.priceHistory[state.priceHistory.length - 1]?.y || null;
}

// ============================================
// Data: helpers
// ============================================

/** Runs async tasks with at most `limit` at a time */
async function pool(tasks, limit = CONCURRENCY) {
    const results = new Array(tasks.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
        while (next < tasks.length) {
            const i = next++;
            results[i] = await tasks[i]();
        }
    }));
    return results;
}

/** Every row of an entity, paged on the id */
async function fetchAll(entity, fields, where = '') {
    const rows = [];
    let cursor = '';
    for (;;) {
        const data = await Services.runQuery(`{ rows: ${entity}(first: ${PAGE}, orderBy: id, orderDirection: asc, where: { ${where} id_gt: ${JSON.stringify(cursor)} }) { id ${fields} } }`);
        const batch = data.rows || [];
        rows.push(...batch);
        if (batch.length < PAGE) return rows;
        cursor = batch[batch.length - 1].id;
    }
}

/** Points of a range: today, then back `step` days at a time down to the range start */
function rangeTimes(rangeKey, allStart) {
    const range = RANGES[rangeKey];
    const step = range.step * DAY;
    const today = Math.floor(now() / DAY) * DAY;
    const start = range.days ? today - range.days * DAY : Math.floor(allStart / DAY) * DAY;
    const times = [];
    for (let t = today; t > start - step; t -= step) times.unshift(t);
    return times;
}

// ============================================
// Data: totals and lists
// ============================================

async function fetchLists() {
    const PARTY = 'id metadataJsonString';
    const FLAG = `id result flaggingTimestamp flagResolutionTimestamp target { ${PARTY} } flagger { ${PARTY} } sponsorship { id stream { id } }`;
    const data = await Services.runQuery(`{
        topOperators: operators(first: ${LIST_SIZE}, orderBy: valueWithoutEarnings, orderDirection: desc) {
            id valueWithoutEarnings delegatorCount metadataJsonString
            stakes(first: 50) { amountWei sponsorship { spotAPY } }
        }
        stakingEvents(first: ${LIST_SIZE}, orderBy: date, orderDirection: desc) {
            id amount date operator { ${PARTY} } sponsorship { id stream { id } }
        }
        raised: flags(first: ${LIST_SIZE}, orderBy: flaggingTimestamp, orderDirection: desc) { ${FLAG} }
        resolved: flags(first: ${LIST_SIZE}, orderBy: flagResolutionTimestamp, orderDirection: desc, where: { result_in: ["kicked", "failed"] }) { ${FLAG} }
        votes(first: ${LIST_SIZE}, orderBy: timestamp, orderDirection: desc) {
            id timestamp votedKick voter { ${PARTY} }
            flag { id target { ${PARTY} } sponsorship { id stream { id } } }
        }
    }`);
    state.topOperators = data.topOperators || [];
    state.stakingEvents = data.stakingEvents || [];

    // Governance: flags raised, votes cast and results, newest first
    const events = [];
    for (const flag of data.raised || []) events.push({ kind: 'flagged', time: Number(flag.flaggingTimestamp), flag, who: flag.target, by: flag.flagger });
    for (const flag of data.resolved || []) events.push({ kind: flag.result, time: Number(flag.flagResolutionTimestamp), flag, who: flag.target });
    for (const vote of data.votes || []) events.push({ kind: vote.votedKick ? 'kick' : 'keep', time: Number(vote.timestamp), flag: vote.flag, who: vote.voter, on: vote.flag?.target });
    state.govEvents = events.sort((a, b) => b.time - a.time).slice(0, LIST_SIZE);
}

/** An operator's value without its owner's share */
function delegatedValue(operatorId, valueWei) {
    return weiToNumber(valueWei) * (1 - (state.ownerShare.get(operatorId) || 0));
}

/** A sponsorship pays out: funds left and stake in it */
function isRunning(s) {
    return weiToNumber(s.remainingWei) > 0 && weiToNumber(s.totalStakedWei) > 0;
}

function bestSponsorships() {
    return state.allSponsorships
        .filter(s => s.isRunning && isRunning(s) && Number(s.spotAPY) > 0)
        .sort((a, b) => Number(b.spotAPY) - Number(a.spotAPY))
        .slice(0, LIST_SIZE);
}

async function fetchTotals() {
    const [operators, sponsorships, selfDelegations] = await Promise.all([
        fetchAll('operators', 'owner valueWithoutEarnings totalStakeInSponsorshipsWei nodes'),
        fetchAll('sponsorships', 'totalStakedWei remainingWei spotAPY isRunning cumulativeSponsoring'),
        fetchAll('delegations', '_valueDataWei operator { id }', 'isSelfDelegation: true,')
    ]);
    state.allOperators = operators;
    state.allSponsorships = sponsorships;
    // The owners' share of each operator (their self-delegation), left out of Delegated
    const ownStake = new Map(selfDelegations.map(d => [d.operator?.id, weiToNumber(d._valueDataWei)]));
    state.ownerShare = new Map(operators.map(op => {
        const value = weiToNumber(op.valueWithoutEarnings);
        return [op.id, value > 0 ? Math.min(1, (ownStake.get(op.id) || 0) / value) : 0];
    }));

    const staking = operators.filter(op => BigInt(op.totalStakeInSponsorshipsWei || '0') > 0n);
    const running = sponsorships.filter(isRunning);
    // APY of each running sponsorship weighted by its stake (as in the history)
    let apySum = 0;
    let runningStake = 0;
    for (const s of running) {
        const stake = weiToNumber(s.totalStakedWei);
        apySum += stake * Number(s.spotAPY || 0);
        runningStake += stake;
    }
    state.totals = {
        staked: sponsorships.reduce((sum, s) => sum + weiToNumber(s.totalStakedWei), 0),
        delegated: operators.reduce((sum, op) => sum + delegatedValue(op.id, op.valueWithoutEarnings), 0),
        apy: runningStake > 0 ? apySum / runningStake : null,
        operators: staking.length,
        operatorsAll: operators.length,
        nodes: staking.reduce((sum, op) => sum + (op.nodes?.length || 0), 0),
        sponsorships: running.length,
        sponsorshipsAll: sponsorships.length,
        sponsored: sponsorships.reduce((sum, s) => sum + weiToNumber(s.cumulativeSponsoring), 0)
    };

    // Streams of the best sponsorships (the totals keep to numbers)
    const best = bestSponsorships();
    if (best.length) {
        const data = await Services.runQuery(`{ sponsorships(where: { id_in: ${JSON.stringify(best.map(s => s.id))} }) { id stream { id } } }`);
        state.bestStreams = (data.sponsorships || []).map(s => [s.id, s.stream?.id || '']);
    }
}

// ============================================
// Data: delegation events (operator contract logs)
// ============================================

/** Logs of one event from a block on, oldest first (at most 1000); a busy explorer is asked again shortly */
async function fetchEventLogs(topic, fromBlock) {
    const url = `${POLYGONSCAN_NETWORK.apiUrl}?chainid=${POLYGONSCAN_NETWORK.chainId}&module=logs&action=getLogs&topic0=${topic}`
        + `&fromBlock=${fromBlock}&toBlock=latest&page=1&offset=${PAGE}&apikey=${getEtherscanApiKey()}`;
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
        const json = await fetch(url).then(r => r.json()).catch(e => ({ message: e.message }));
        if (Array.isArray(json?.result)) return json.result;
        if (/no records/i.test(json?.message || '')) return [];
        lastError = new Error(`${json?.message || 'Explorer error'}: ${json?.result || ''}`);
        if (!EXPLORER_BUSY.test(`${json?.message} ${json?.result}`)) break;
    }
    throw lastError;
}

/** Newest logs of an event since a block: when the explorer returns its 1000-log maximum, the newer half is asked */
async function newestLogs(topic, fromBlock, latestBlock) {
    let from = fromBlock;
    for (let i = 0; i < 8; i++) {
        const logs = await fetchEventLogs(topic, from);
        if (logs.length < PAGE) return logs;
        from = Math.floor((from + latestBlock) / 2);
    }
    return fetchEventLogs(topic, from);
}

/** The delegator and DATA amount of a Delegated / Undelegated log (delegator indexed or in the data) */
function parseDelegationLog(log) {
    if (log.topics.length > 1) {
        return { delegator: ethers.utils.hexDataSlice(log.topics[1], 12).toLowerCase(), amount: ethers.BigNumber.from(log.data).toString() };
    }
    const [delegator, amount] = ethers.utils.defaultAbiCoder.decode(['address', 'uint256'], log.data);
    return { delegator: delegator.toLowerCase(), amount: amount.toString() };
}

async function loadDelegations() {
    state.delegationsAt = Date.now();
    try {
        await fetchDelegationEvents();
    } catch (e) {
        logger.warn('Overview: delegation events not loaded', e);
        if (!state.delegationsLoaded) state.delegationsError = true;
    }
    if (state.active) renderActivity();
}

async function fetchDelegationEvents() {
    const operators = new Map(state.allOperators.map(op => [op.id.toLowerCase(), op]));
    if (!operators.size) return;
    const latest = (await Services.runQuery('{ _meta { block { number } } }'))._meta.block.number;
    let events = [];
    for (const days of DELEGATION_WINDOWS_DAYS) {
        const from = Math.max(0, latest - days * POLYGON_BLOCKS_PER_DAY);
        const [delegated, undelegated] = await Promise.all([
            newestLogs(DELEGATION_TOPICS.delegate, from, latest),
            newestLogs(DELEGATION_TOPICS.undelegate, from, latest)
        ]);
        events = [...delegated.map(log => ({ log, type: 'delegate' })), ...undelegated.map(log => ({ log, type: 'undelegate' }))]
            // Only the operators' own events (other contracts can share the signature)
            .filter(({ log }) => operators.has(log.address.toLowerCase()))
            .map(({ log, type }) => {
                const operator = operators.get(log.address.toLowerCase());
                const { delegator, amount } = parseDelegationLog(log);
                return { type, delegator, amount, operatorId: operator.id, owner: delegator === (operator.owner || '').toLowerCase(),
                    time: parseInt(log.timeStamp, 16), block: parseInt(log.blockNumber, 16), index: parseInt(log.logIndex, 16) };
            });
        if (events.length >= LIST_SIZE) break;
    }
    events.sort((a, b) => b.block - a.block || b.index - a.index);
    events = events.slice(0, LIST_SIZE);
    // Names and avatars of their operators
    const ids = [...new Set(events.map(e => e.operatorId))];
    if (ids.length) {
        const data = await Services.runQuery(`{ operators(where: { id_in: ${JSON.stringify(ids)} }) { id metadataJsonString } }`);
        const meta = new Map((data.operators || []).map(op => [op.id, op]));
        for (const event of events) event.operator = meta.get(event.operatorId) || { id: event.operatorId };
    }
    state.delegations = events;
    state.delegationsLoaded = true;
    state.delegationsError = false;
}

/** OperatorSlashed logs of the operators since the last read (kept between visits) */
async function loadSlashing() {
    if (state.slashingLoading) return state.slashingLoading;
    state.slashingLoading = (async () => {
        try {
            if (!state.totals) await state.totalsPromise;
            const operators = new Set(state.allOperators.map(op => op.id.toLowerCase()));
            if (!operators.size) throw new Error('No operators');
            const seen = state.slashingSeen;
            let from = state.slashingFrom;
            for (let i = 0; i < 50; i++) {
                const logs = await fetchEventLogs(SLASHED_TOPIC, from);
                for (const log of logs) {
                    const key = `${log.transactionHash}:${log.logIndex}`;
                    if (seen.has(key) || !operators.has(log.address.toLowerCase())) continue;
                    seen.add(key);
                    const [amount] = ethers.utils.defaultAbiCoder.decode(['uint256', 'uint256', 'uint256'], log.data);
                    state.slashingEvents.push({ t: parseInt(log.timeStamp, 16), v: weiToNumber(amount.toString()) });
                }
                if (logs.length) from = parseInt(logs[logs.length - 1].blockNumber, 16);   // that block again: seen ones are skipped
                if (logs.length < PAGE) break;
            }
            state.slashingFrom = from;
            state.slashingEvents.sort((a, b) => a.t - b.t);
            state.slashing = {
                total: state.slashingEvents.reduce((sum, e) => sum + e.v, 0),
                count: state.slashingEvents.length
            };
            for (const range of Object.keys(RANGES)) delete state.history[`slashing:${range}`];
        } catch (e) {
            logger.warn('Overview: slashings not loaded', e);
            if (!state.slashing) state.slashingError = true;
        } finally {
            state.slashingLoading = null;
        }
        if (state.active) {
            renderStats();
            if (state.metric === 'slashed') renderChart();
        }
    })();
    return state.slashingLoading;
}

// ============================================
// Data: streams (creation dates, kept in the browser and topped up)
// ============================================

function readStreamsCache() {
    try {
        const cached = JSON.parse(localStorage.getItem(STREAMS_CACHE_KEY) || 'null');
        if (cached?.days && cached.until) return { byDay: new Map(cached.days), until: cached.until };
    } catch (e) { /* no cache */ }
    return null;
}

function writeStreamsCache(byDay, until) {
    try {
        localStorage.setItem(STREAMS_CACHE_KEY, JSON.stringify({ days: [...byDay.entries()], until }));
    } catch (e) { /* storage full or blocked: counted again next time */ }
}

/** Streams created in [from, to): counts per day, in parallel windows paged on the id */
async function countStreams(from, to) {
    const span = 90 * DAY;
    const windows = [];
    for (let t = from; t < to; t += span) windows.push([t, Math.min(t + span, to)]);
    const byDay = new Map();
    await pool(windows.map(([a, b]) => async () => {
        let cursor = '';
        for (;;) {
            const data = await Services.runQuery(`{ rows: streams(first: ${PAGE}, orderBy: id, orderDirection: asc, where: { createdAt_gte: "${a}", createdAt_lt: "${b}", id_gt: ${JSON.stringify(cursor)} }) { id createdAt } }`);
            const batch = data.rows || [];
            for (const s of batch) {
                const day = Math.floor(Number(s.createdAt) / DAY) * DAY;
                byDay.set(day, (byDay.get(day) || 0) + 1);
            }
            if (batch.length < PAGE) return;
            cursor = batch[batch.length - 1].id;
        }
    }));
    return byDay;
}

async function loadStreams() {
    if (state.streamsLoading) return;
    state.streamsLoading = true;
    try {
        const cached = readStreamsCache();
        const today = Math.floor(now() / DAY) * DAY;
        // From the last cached day on (counted again whole), or everything
        const from = cached ? Math.min(cached.until, today) : STREAMS_START;
        const byDay = cached ? new Map([...cached.byDay].filter(([day]) => day < from)) : new Map();
        const fresh = await countStreams(from, now() + 1);
        for (const [day, count] of fresh) byDay.set(day, (byDay.get(day) || 0) + count);
        writeStreamsCache(byDay, today);
        state.streams = { byDay, total: [...byDay.values()].reduce((a, b) => a + b, 0) };
        for (const range of Object.keys(RANGES)) delete state.history[`streams:${range}`];
    } catch (e) {
        logger.warn('Overview: streams not counted', e);
    } finally {
        state.streamsLoading = false;
    }
    if (state.active) {
        renderStats();
        if (state.metric === 'streams') renderChart();
    }
}

// ============================================
// Data: history
// ============================================

const BUCKETS = {
    sponsorships: {
        entity: 'sponsorshipDailyBuckets', key: 'sponsorship', fields: 'totalStakedWei remainingWei spotAPY', exact: true,
        current: () => state.allSponsorships,
        series(rows) {
            let staked = 0, running = 0, apyStake = 0, apySum = 0;
            for (const r of rows) {
                const stake = weiToNumber(r.totalStakedWei);
                staked += stake;
                if (stake > 0 && weiToNumber(r.remainingWei) > 0) {
                    running++;
                    apyStake += stake;
                    apySum += stake * Number(r.spotAPY || 0);
                }
            }
            return { staked, sponsorships: running, apy: apyStake > 0 ? apySum / apyStake : null };
        }
    },
    operators: {
        // Many operators: per window only the newest buckets (an operator missing keeps its previous value)
        entity: 'operatorDailyBuckets', key: 'operator', fields: 'valueWithoutEarnings totalStakeInSponsorshipsWei', exact: false,
        current: () => state.allOperators,
        series(rows) {
            let delegated = 0, operators = 0;
            for (const r of rows) {
                delegated += delegatedValue(r.operator?.id || r.id, r.valueWithoutEarnings);
                if (weiToNumber(r.totalStakeInSponsorshipsWei) > 0) operators++;
            }
            return { delegated, operators };
        }
    }
};

/** Buckets of each window (from, to], oldest first: all of them (paged), or the newest PAGE */
async function fetchWindows(cfg, windows) {
    const results = windows.map(() => []);
    const order = cfg.exact ? 'asc' : 'desc';
    let pending = windows.map((w, i) => ({ ...w, i, skip: 0 }));
    while (pending.length) {
        const next = [];
        const batches = [];
        for (let k = 0; k < pending.length; k += ALIASES) batches.push(pending.slice(k, k + ALIASES));
        await pool(batches.map(batch => async () => {
            const fields = batch.map((w, j) => `w${j}: ${cfg.entity}(first: ${PAGE}, skip: ${w.skip}, orderBy: date, orderDirection: ${order}, where: { date_gt: "${w.from}", date_lte: "${w.to}" }) { date ${cfg.key} { id } ${cfg.fields} }`).join('\n');
            const data = await Services.runQuery(`{ ${fields} }`);
            batch.forEach((w, j) => {
                const rows = data[`w${j}`] || [];
                results[w.i].push(...rows);
                if (cfg.exact && rows.length === PAGE && w.skip / PAGE + 1 < MAX_SKIP_PAGES) next.push({ ...w, skip: w.skip + PAGE });
            });
        }));
        pending = next;
    }
    return results.map(rows => rows.sort((a, b) => Number(a.date) - Number(b.date)));
}

/**
 * Daily buckets over a range: each sponsorship / operator keeps its last bucket until the next one.
 * The ones without a bucket in the range kept what they have now; the others start from their last
 * bucket before the range.
 */
async function bucketHistory(source, rangeKey) {
    const cfg = BUCKETS[source];
    const times = rangeTimes(rangeKey, NETWORK_START);
    const step = RANGES[rangeKey].step * DAY;
    const first = times[0] - step;
    const [beforeData, windows] = await Promise.all([
        Services.runQuery(`{ rows: ${cfg.entity}(first: ${PAGE}, orderBy: date, orderDirection: desc, where: { date_lte: "${first}" }) { date ${cfg.key} { id } ${cfg.fields} } }`),
        fetchWindows(cfg, times.map((t, i) => ({ from: i ? times[i - 1] : first, to: t })))
    ]);
    const latest = new Map();
    // Oldest first, so each one ends on its newest bucket
    for (const row of [...(beforeData.rows || [])].reverse()) latest.set(row[cfg.key].id, row);
    const seen = new Set([...latest.keys(), ...windows.flat().map(row => row[cfg.key].id)]);
    const unchanged = cfg.current().filter(row => !seen.has(row.id));

    const series = {};
    times.forEach((t, i) => {
        for (const row of windows[i]) latest.set(row[cfg.key].id, row);
        const values = cfg.series([...latest.values(), ...unchanged]);
        for (const [name, value] of Object.entries(values)) {
            if (value === null) continue;
            (series[name] = series[name] || []).push({ x: t * 1000, y: value });
        }
    });
    return series;
}

/** Running totals of dated amounts ({ t, v }, oldest first) at the range's points (end of each day) */
function cumulative(events, rangeKey, allStart) {
    const points = [];
    let i = 0;
    let total = 0;
    for (const t of rangeTimes(rangeKey, allStart)) {
        while (i < events.length && events[i].t < t + DAY) total += events[i++].v;
        points.push({ x: t * 1000, y: total });
    }
    return points;
}

async function loadHistory(source, rangeKey) {
    const key = `${source}:${rangeKey}`;
    if (state.history[key]) return;
    state.history[key] = 'loading';
    await null;   // the chart drawing that asked for it finishes first
    try {
        if (source === 'sponsorships' || source === 'operators') {
            // Needs every sponsorship / operator now
            if (!state.totals) await state.totalsPromise;
            if (!state.totals) throw new Error('No totals');
            state.history[key] = await bucketHistory(source, rangeKey);
        } else if (source === 'sponsoring') {
            if (!state.sponsoringEvents) {
                const events = await fetchAll('sponsoringEvents', 'amount date');
                state.sponsoringEvents = events.map(e => ({ t: Number(e.date), v: weiToNumber(e.amount) })).sort((a, b) => a.t - b.t);
            }
            const events = state.sponsoringEvents;
            state.history[key] = { sponsored: cumulative(events, rangeKey, events[0]?.t || NETWORK_START) };
        } else if (source === 'slashing') {
            if (!state.slashing) { delete state.history[key]; return; }   // drawn when the slashings are read
            const events = state.slashingEvents;
            state.history[key] = { slashed: cumulative(events, rangeKey, events[0]?.t || NETWORK_START) };
        } else if (source === 'streams') {
            if (!state.streams) { delete state.history[key]; return; }   // drawn when the count is done
            const days = [...state.streams.byDay.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
            state.history[key] = { streams: cumulative(days, rangeKey, days[0]?.t || STREAMS_START) };
        }
    } catch (e) {
        logger.warn(`Overview: ${source} history not loaded`, e);
        state.history[key] = 'error';
    }
    if (state.active && state.metric && METRICS[state.metric].source === source && state.range === rangeKey) renderChart();
}

function setPriceHistory({ priceMap }) {
    if (!priceMap?.size) return;
    state.priceHistory = [...priceMap.entries()]
        .map(([seconds, price]) => ({ x: seconds * 1000, y: price }))
        .filter(point => point.y > 0)
        .sort((a, b) => a.x - b.x);
    if (state.active) {
        renderStats();
        if (state.metric === 'price') renderChart();
    }
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

/** A metric's value now */
function currentValue(metric) {
    if (metric === 'price') return currentPrice();
    if (metric === 'streams') return state.streams?.total ?? null;
    if (metric === 'slashed') return state.slashing?.total ?? null;
    return state.totals ? state.totals[metric] ?? null : null;
}

// ============================================
// Rendering: stats
// ============================================

function statSub(metric) {
    const t = state.totals;
    const price = currentPrice();
    const usd = (value) => (price && value ? `$${compact(value * price)}` : '');
    switch (metric) {
        case 'staked': return t ? usd(t.staked) : '';
        case 'delegated': return t ? usd(t.delegated) : '';
        case 'operators': return t ? `of ${full(t.operatorsAll)} · ${full(t.nodes)} nodes` : '';
        case 'sponsorships': return t ? `running of ${full(t.sponsorshipsAll)}` : '';
        case 'streams': return state.streams ? '' : (state.streamsLoading ? 'Counting...' : '');
        case 'sponsored': return t ? usd(t.sponsored) : '';
        case 'slashed': return state.slashing ? `${full(state.slashing.count)} slashings` : '';
        case 'price': {
            const value = currentPrice();
            const before = price24hAgo();
            if (!value || !before) return 'DATA / USD';
            const change = value / before - 1;
            return `<span class="${change >= 0 ? 'text-green-400' : 'text-red-400'}">${change >= 0 ? '+' : ''}${(change * 100).toFixed(2)}%</span> 24h`;
        }
        default: return '';
    }
}

function renderStats() {
    const el = $('overview-stats');
    if (!el) return;
    const placeholder = '<span class="inline-block w-14 h-5 rounded bg-[#2C2C2C] animate-pulse align-middle"></span>';
    el.innerHTML = METRIC_ORDER.map(metric => {
        const def = METRICS[metric];
        const value = currentValue(metric);
        const failed = metric === 'slashed' ? state.slashingError && !state.slashing
            : state.error && !state.totals && metric !== 'price' && metric !== 'streams';
        const shown = value === null ? (failed ? '--' : placeholder) : formatMetric(def.kind, value);
        const unit = def.kind === 'data' && value !== null ? ' <span class="text-xs font-semibold text-gray-400">DATA</span>' : '';
        const tip = value !== null && (def.kind === 'data' || def.kind === 'count') ? ` data-tooltip-content="${formatMetric(def.kind, value, true)}"` : '';
        const selected = state.metric === metric;
        return `
            <button type="button" data-metric="${metric}" aria-pressed="${selected}" aria-controls="overview-chart-panel"
                class="overview-stat group relative text-left px-3 sm:px-4 py-3 min-w-0 transition-colors ${metric === 'price' ? 'col-span-2 sm:col-span-1' : ''} ${selected ? 'bg-[#262626]' : 'bg-[#1E1E1E] hover:bg-[#232323]'}">
                <span class="absolute inset-x-0 bottom-0 h-0.5 ${selected ? 'bg-blue-500' : 'bg-transparent'}"></span>
                <span class="flex items-center justify-between gap-1 text-[11px] font-semibold sm:uppercase sm:tracking-wider ${selected ? 'text-gray-200' : 'text-gray-400'}">
                    <span class="truncate">${def.label}</span>
                    <svg class="w-3 h-3 flex-shrink-0 transition-transform ${selected ? 'rotate-180 text-blue-400' : 'text-gray-500 group-hover:text-gray-300'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
                </span>
                <span class="block mt-1 text-base sm:text-xl font-bold text-white whitespace-nowrap"${tip}>${shown}${unit}</span>
                <span class="block text-[11px] sm:text-xs text-gray-400 truncate min-h-[1rem]">${statSub(metric)}</span>
            </button>`;
    }).join('');
}

// ============================================
// Rendering: chart
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

function tickLabel(ms) {
    const date = new Date(ms);
    if (state.range === 'all') return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Points of the open metric in the selected range, ending at its value now; 'loading' / 'error' while not ready */
function chartPoints(metric) {
    const def = METRICS[metric];
    if (metric === 'price') {
        if (!state.priceHistory.length) return 'loading';
        const range = RANGES[state.range];
        const start = range.days ? Date.now() - range.days * DAY * 1000 : -Infinity;
        const points = state.priceHistory.filter(p => p.x >= start);
        const price = Services.getCurrentLivePrice();
        if (price && points.length) points.push({ x: Date.now(), y: price });
        return points;
    }
    if (metric === 'streams' && !state.streams) return 'loading';
    if (metric === 'slashed' && !state.slashing) return state.slashingError ? 'error' : 'loading';
    const history = state.history[`${def.source}:${state.range}`];
    if (!history || history === 'loading') {
        loadHistory(def.source, state.range);
        return 'loading';
    }
    if (history === 'error') return 'error';
    const points = [...(history[metric] || [])];
    const value = currentValue(metric);
    if (value !== null && points.length) points.push({ x: Date.now(), y: value });
    return points;
}

function chartMessage(container, text, spinner = false) {
    state.chart?.destroy();
    state.chart = null;
    const spin = spinner ? '<span class="w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" aria-hidden="true"></span>' : '';
    container.innerHTML = `<div class="flex items-center justify-center gap-2 h-full text-sm text-gray-300">${spin}${text}</div>`;
}

function renderChartHeader(metric) {
    const def = METRICS[metric];
    $('overview-chart-title').textContent = def.label;
    $('overview-chart-info').setAttribute('data-tooltip-content', def.info);
    const value = currentValue(metric);
    $('overview-chart-value').textContent = value === null ? '' : formatMetric(def.kind, value, true);
}

function renderChart() {
    const panel = $('overview-chart-panel');
    const container = $('overview-chart');
    if (!panel || !container) return;
    const metric = state.metric;
    panel.classList.toggle('hidden', !metric);
    if (!metric) {
        state.chart?.destroy();
        state.chart = null;
        return;
    }
    renderRangeButtons();
    const def = METRICS[metric];
    const points = chartPoints(metric);
    renderChartHeader(metric);
    if (points === 'loading') return chartMessage(container, metric === 'streams' ? 'Counting streams...' : 'Loading history...', true);
    if (points === 'error') return chartMessage(container, 'History could not be loaded.');
    if (points.length < 2) return chartMessage(container, 'Not enough data for this range.');
    if (typeof Chart === 'undefined') return;

    if (!container.querySelector('canvas')) {
        state.chart?.destroy();
        state.chart = null;
        container.innerHTML = '<canvas role="img"></canvas>';
    }
    const canvas = container.querySelector('canvas');
    canvas.setAttribute('aria-label', `${def.label} chart`);
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, container.clientHeight || 280);
    gradient.addColorStop(0, 'rgba(59, 130, 246, 0.25)');
    gradient.addColorStop(1, 'rgba(59, 130, 246, 0)');
    const dataset = {
        label: def.label,
        data: points,
        borderColor: '#3b82f6',
        backgroundColor: gradient,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: '#3b82f6',
        pointHoverBorderColor: '#121212',
        pointHoverBorderWidth: 2,
        tension: 0,
        fill: true
    };
    const bounds = { min: points[0].x, max: points[points.length - 1].x };
    const axisFormat = (value) => formatMetric(def.kind, value);
    const tipFormat = (value) => formatMetric(def.kind, value, true);
    if (state.chart) {
        state.chart.data.datasets[0] = dataset;
        Object.assign(state.chart.options.scales.x, bounds);
        state.chart.options.scales.y.ticks.callback = axisFormat;
        state.chart.options.scales.y.beginAtZero = def.kind === 'count';
        state.chart.options.plugins.tooltip.callbacks.label = (item) => tipFormat(item.parsed.y);
        state.chart.update('none');
        return;
    }
    const font = { family: "'Inter', sans-serif", size: 11 };
    state.chart = new Chart(ctx, {
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
                        label: (item) => tipFormat(item.parsed.y)
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    ...bounds,
                    ticks: { color: '#9ca3af', font, maxTicksLimit: 6, maxRotation: 0, callback: (value) => tickLabel(value) },
                    grid: { display: false }
                },
                y: {
                    position: 'right',
                    beginAtZero: def.kind === 'count',
                    ticks: { color: '#9ca3af', font, maxTicksLimit: 5, callback: axisFormat },
                    grid: { color: '#2a2a2a', drawBorder: false }
                }
            }
        }
    });
}

function renderRangeButtons() {
    document.querySelectorAll('#overview-range button').forEach(btn => {
        const active = btn.dataset.range === state.range;
        btn.classList.toggle('bg-blue-800', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('text-gray-300', !active);
    });
}

// ============================================
// Rendering: lists
// ============================================

const ROW = 'flex items-center gap-3 px-2 py-2 -mx-2 rounded-lg hover:bg-white/[0.03] transition-colors';

function emptyRow(text) {
    return `<p class="py-6 text-center text-sm text-gray-400">${text}</p>`;
}

function loadingRows() {
    return Array.from({ length: 3 }, () => '<div class="h-10 rounded-lg bg-[#2C2C2C] animate-pulse"></div>').join('');
}

function badge(kind) {
    const { label, badge: classes } = BADGES[kind];
    return `<span class="inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-semibold whitespace-nowrap ${classes}">${label}</span>`;
}

function avatar(operator) {
    return operatorAvatarHtml(operator?.metadataJsonString, { className: 'w-8 h-8 border border-[#333]' });
}

/** Rows of a list, or its loading / error / empty state */
function listContent(rows, render, { error, empty, loaded, failed }) {
    if (loaded ? !loaded() : !state.loaded) return (failed ? failed() : state.error) ? emptyRow(error) : loadingRows();
    return rows.length ? rows.map(render).join('') : emptyRow(empty);
}

function renderOperators() {
    const el = $('overview-operators');
    if (!el) return;
    el.innerHTML = listContent(state.topOperators, (op, i) => {
        const value = weiToNumber(op.valueWithoutEarnings);
        return `
            <a href="/operator/${op.id}" class="${ROW}">
                <span class="w-4 text-xs font-semibold text-gray-400 text-right">${i + 1}</span>
                ${avatar(op)}
                <div class="min-w-0 flex-1">
                    <p class="text-sm font-semibold text-white truncate">${escapeHtml(operatorName(op))}</p>
                    <p class="text-xs text-gray-400">${full(op.delegatorCount || 0)} delegators</p>
                </div>
                <div class="text-right whitespace-nowrap">
                    <p class="text-sm font-semibold text-white" data-tooltip-content="${full(value)} DATA">${compact(value)} DATA</p>
                    <p class="text-xs text-gray-400">${formatPercent(calculateWeightedApy(op.stakes))} APY</p>
                </div>
            </a>`;
    }, { error: 'Operators could not be loaded.', empty: 'No operators.' });
}

function renderSponsorships() {
    const el = $('overview-best');
    if (!el) return;
    const streams = new Map(state.bestStreams);
    el.innerHTML = listContent(bestSponsorships(), s => {
        const streamId = streams.get(s.id) || '';
        return `
            <a href="${sponsorshipHref(s.id, streamId)}" class="${ROW}">
                <div class="min-w-0 flex-1">
                    <p class="text-sm font-semibold text-white truncate" data-tooltip-content="${escapeHtml(streamId || s.id)}">${escapeHtml(shortStreamId(streamId) || shortAddress(s.id))}</p>
                    <p class="text-xs text-gray-400">${compact(weiToNumber(s.totalStakedWei))} DATA staked</p>
                </div>
                <div class="text-right whitespace-nowrap">
                    <p class="text-sm font-semibold text-white">${formatPercent(Number(s.spotAPY))}</p>
                    <p class="text-xs text-gray-400">${compact(weiToNumber(s.remainingWei))} DATA left</p>
                </div>
            </a>`;
    }, { error: 'Sponsorships could not be loaded.', empty: 'No running sponsorships.' });
}

function stakingRow(event) {
    const amount = weiToNumber(event.amount);   // negative: unstaked
    const staked = amount >= 0;
    const streamId = event.sponsorship?.stream?.id || '';
    return `
        <a href="/operator/${event.operator?.id}" class="${ROW}">
            ${avatar(event.operator)}
            <div class="min-w-0 flex-1">
                <p class="text-sm font-semibold text-white truncate">${escapeHtml(operatorName(event.operator))}</p>
                <p class="text-xs text-gray-400 truncate" data-tooltip-content="${escapeHtml(streamId)}">${staked ? 'Staked in' : 'Unstaked from'} ${escapeHtml(shortStreamId(streamId) || shortAddress(event.sponsorship?.id || ''))}</p>
            </div>
            <div class="text-right whitespace-nowrap">
                <p class="text-sm font-semibold ${staked ? 'text-green-400' : 'text-red-400'}" data-tooltip-content="${full(Math.abs(amount))} DATA">${staked ? '+' : '-'}${compact(Math.abs(amount))} DATA</p>
                <p class="text-xs text-gray-400">${timeAgo(event.date)}</p>
            </div>
        </a>`;
}

function delegationRow(event) {
    const amount = weiToNumber(event.amount);
    const delegated = event.type === 'delegate';
    const by = event.owner ? 'the owner' : shortAddress(event.delegator);
    return `
        <a href="/delegator/${event.delegator}" class="${ROW}">
            ${avatar(event.operator)}
            <div class="min-w-0 flex-1">
                <p class="text-sm font-semibold text-white truncate">${escapeHtml(operatorName(event.operator))}</p>
                <p class="text-xs text-gray-400 truncate">${delegated ? 'Delegated' : 'Undelegated'} by ${escapeHtml(by)}</p>
            </div>
            <div class="text-right whitespace-nowrap">
                <div class="flex items-center justify-end gap-2">
                    ${badge(event.owner ? 'owner' : 'delegator')}
                    <span class="text-sm font-semibold ${delegated ? 'text-green-400' : 'text-red-400'}" data-tooltip-content="${full(amount)} DATA">${delegated ? '+' : '-'}${compact(amount)} DATA</span>
                </div>
                <p class="text-xs text-gray-400 mt-0.5">${timeAgo(event.time)}</p>
            </div>
        </a>`;
}

function governanceRow(event) {
    const stream = shortStreamId(event.flag?.sponsorship?.stream?.id);
    const detail = event.kind === 'flagged' ? `By ${operatorName(event.by)}` : event.on ? `On ${operatorName(event.on)}` : stream;
    return `
        <a href="/governance/flag/${encodeURIComponent(event.flag?.id || '')}" class="${ROW}">
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
}

const ACTIVITY = {
    staking: { rows: () => state.stakingEvents, render: stakingRow, error: 'Staking events could not be loaded.', empty: 'No staking events.', href: '/subgraph/stakingEvents' },
    delegations: { rows: () => state.delegations, render: delegationRow, error: 'Delegation events could not be loaded.', empty: 'No delegations in the last 30 days.', href: '/delegators',
        loaded: () => state.delegationsLoaded, failed: () => state.delegationsError },
    governance: { rows: () => state.govEvents, render: governanceRow, error: 'Governance events could not be loaded.', empty: 'No governance events.', href: '/governance' }
};

function renderActivity() {
    const el = $('overview-activity');
    if (!el) return;
    const tab = ACTIVITY[state.activity];
    el.innerHTML = listContent(tab.rows(), tab.render, tab);
    $('overview-activity-all')?.setAttribute('href', tab.href);
    document.querySelectorAll('#overview-activity-tabs button').forEach(btn => {
        const active = btn.dataset.tab === state.activity;
        btn.classList.toggle('bg-[#3A3A3A]', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('text-gray-400', !active);
        btn.setAttribute('aria-selected', String(active));
    });
}

function renderLists() {
    renderOperators();
    renderSponsorships();
    renderActivity();
}

// ============================================
// Lifecycle
// ============================================

async function refresh() {
    const totals = fetchTotals();
    state.totalsPromise = totals.catch(() => {});
    // Delegation events (explorer requests): while their tab is open, or once
    if (state.activity === 'delegations' || !state.delegationsLoaded) totals.then(loadDelegations).catch(() => {});
    try {
        await Promise.all([totals, fetchLists()]);
        state.loaded = true;
        state.error = false;
        // Histories that failed are asked again
        for (const [key, value] of Object.entries(state.history)) if (value === 'error') delete state.history[key];
    } catch (e) {
        logger.warn('Overview: network data not loaded', e);
        if (!state.loaded) state.error = true;
    }
    if (!state.active) return;
    renderStats();
    renderLists();
    if (state.metric) renderChart();
}

function schedule() {
    clearTimeout(state.timer);
    state.timer = setTimeout(async () => {
        if (!state.active) return;
        if (!document.hidden) await refresh();
        schedule();
    }, REFRESH_MS);
}

function selectMetric(metric) {
    // The open one closes again
    state.metric = state.metric === metric ? null : metric;
    renderStats();
    renderChart();
}

function init() {
    if (state.initialized) return;
    state.initialized = true;
    $('overview-stats')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-metric]');
        if (btn) selectMetric(btn.dataset.metric);
    });
    document.querySelectorAll('#overview-range button').forEach(btn => btn.addEventListener('click', () => {
        state.range = btn.dataset.range;
        renderChart();
    }));
    document.querySelectorAll('#overview-activity-tabs button').forEach(btn => btn.addEventListener('click', () => {
        state.activity = btn.dataset.tab;
        renderActivity();
        if (state.activity === 'delegations' && state.totals && Date.now() - (state.delegationsAt || 0) > REFRESH_MS) loadDelegations();
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
    refresh();   // first: the histories wait for its totals
    renderStats();
    renderLists();
    renderChart();
    loadStreams();
    loadSlashing();
    schedule();
    clearInterval(state.streamsTimer);
    state.streamsTimer = setInterval(() => {
        if (state.active && !document.hidden) {
            loadStreams();
            loadSlashing();
        }
    }, STREAMS_REFRESH_MS);
}

function stop() {
    state.active = false;
    clearTimeout(state.timer);
    clearInterval(state.streamsTimer);
}

export const OverviewLogic = { show, stop };
