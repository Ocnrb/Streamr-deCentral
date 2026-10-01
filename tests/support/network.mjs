// The outside world for the tests: an in-memory subgraph that runs the app's queries (validated against the
// subgraph's schema), the Etherscan logs API, a Polygon RPC and a Streamr client. Nothing leaves the machine.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSchema, parse, validate } from 'graphql';

const root = fileURLToPath(new URL('../..', import.meta.url));
// The app's own ethers build (v5), to encode the event logs
const ethers = (() => {
    const m = { exports: {} };
    new Function('module', 'exports', 'self', 'window', fs.readFileSync(`${root}libs/ethers.umd.min.js`, 'utf8'))(m, m.exports, {}, {});
    return m.exports.ethers || m.exports;
})();
const schema = buildSchema(fs.readFileSync(new URL('../fixtures/subgraph-schema.graphql', import.meta.url), 'utf8'));

export const NOW = Math.floor(Date.now() / 1000);
export const DAY = 86400;
const LATEST_BLOCK = 77000000;
const W = (n) => (BigInt(Math.round(n)) * 10n ** 18n).toString();
export const hex = (n) => '0x' + n.toString(16).padStart(40, '0');
export const XSS_NAME = '<img src=x onerror="window.__xss=1">Evil';

// ---------- Subgraph data ----------

function buildData() {
    const T = {};
    T.operators = Array.from({ length: 1500 }, (_, i) => ({
        id: hex(0xa0000 + i), owner: hex(0xf000 + i),
        valueWithoutEarnings: W(i < 300 ? 200000 + i * 1000 : 1000), totalStakeInSponsorshipsWei: i < 300 ? W(150000 + i * 500) : '0',
        delegatorCount: i % 40, metadataJsonString: JSON.stringify({ name: i === 2 ? XSS_NAME : `Operator ${i}` }),
        // The largest ones earning nothing are skipped from the top list
        stakes: [{ amountWei: W(1e5), sponsorship: { spotAPY: i === 299 || i === 297 ? '0' : i === 296 ? '0.0001' : '0.12' } }]
    }));
    T.sponsorships = Array.from({ length: 20 }, (_, i) => ({
        id: hex(0xb000 + i), totalStakedWei: W(i < 15 ? 5e6 + i * 2e5 : 0), remainingWei: W(i < 12 ? 40000 + i * 1000 : 0),
        spotAPY: String(i < 12 ? 0.05 + i * 0.02 : 0), totalPayoutWeiPerSec: (BigInt(W(1)) / 50n).toString(), isRunning: i < 15,
        cumulativeSponsoring: W(100000 + i * 5000), operatorCount: 3 + i, stream: { id: `${hex(0xc000 + i)}/stream-${i}` }
    }));
    const party = (o) => ({ id: o.id, metadataJsonString: o.metadataJsonString });
    T.slashingEvents = [
        ...Array.from({ length: 30 }, (_, i) => ({ id: `sl${i}`, amount: W(1000 + i * 100), date: String(NOW - (700 - i * 20) * DAY), sponsorship: { id: hex(0xb000 + (i % 20)) }, operator: { id: hex(0xa0000) } })),
        // The March 2024 recovery sponsorship: left out of DATA slashed
        ...Array.from({ length: 5 }, (_, i) => ({ id: `rec${i}`, amount: W(2e6), date: String(NOW - 560 * DAY), sponsorship: { id: '0x9109abd75eae7e526fc85e33bab24ac45f71717a' }, operator: { id: hex(0xa0001) } }))
    ];
    T.sponsoringEvents = T.sponsorships.map((s, i) => ({ id: `sp${i}`, amount: s.cumulativeSponsoring, date: String(NOW - (650 - i * 30) * DAY), sponsor: hex(0x5000 + i), sponsorship: s }));
    T.sponsoringEvents.push({ id: 'spNew', amount: W(7500), date: String(NOW - 400), sponsor: hex(0x5555), sponsorship: T.sponsorships[4] });
    const streamStart = Math.floor(Date.UTC(2021, 5, 1) / 1000);
    T.streams = Array.from({ length: 2500 }, (_, i) => ({ id: `${hex(0xd000 + (i % 97))}/s-${String(i).padStart(5, '0')}`, createdAt: String(streamStart + Math.floor((NOW - streamStart) * (i / 2500) ** 0.7)) }));
    // Daily buckets: sponsorships every 2 days growing to their stake now; operators 0-49 every 3 days; 300-329 stopped 200 days ago
    T.sponsorshipDailyBuckets = [];
    T.sponsorships.forEach((s, i) => {
        const now = Number(BigInt(s.totalStakedWei) / 10n ** 18n);
        const start = Math.floor((NOW - (600 - i * 10) * DAY) / DAY) * DAY;
        for (let t = start; t <= NOW; t += 2 * DAY) {
            T.sponsorshipDailyBuckets.push({ id: `${s.id}-${t}`, date: String(t), sponsorship: { id: s.id }, totalStakedWei: W(now * (t - start) / (NOW - start)), remainingWei: s.remainingWei, spotAPY: s.spotAPY });
        }
    });
    T.operatorDailyBuckets = [];
    T.operators.slice(0, 50).forEach((o) => {
        const now = Number(BigInt(o.valueWithoutEarnings) / 10n ** 18n);
        const start = Math.floor((NOW - 500 * DAY) / DAY) * DAY;
        for (let t = start; t <= NOW; t += 3 * DAY) {
            T.operatorDailyBuckets.push({ id: `${o.id}-${t}`, date: String(t), operator: { id: o.id }, valueWithoutEarnings: W(now * (0.5 + 0.5 * (t - start) / (NOW - start))), totalStakeInSponsorshipsWei: o.totalStakeInSponsorshipsWei });
        }
    });
    T.operators.slice(300, 330).forEach((o) => {
        const start = Math.floor((NOW - 500 * DAY) / DAY) * DAY;
        for (let t = start; t <= NOW - 200 * DAY; t += 3 * DAY) {
            T.operatorDailyBuckets.push({ id: `${o.id}-${t}`, date: String(t), operator: { id: o.id }, valueWithoutEarnings: W(50000), totalStakeInSponsorshipsWei: W(40000) });
        }
    });
    // Staking events hold the stake after each change (as the subgraph does); none when it goes to 0
    const se = (op, sp, tx, secsAgo, amount) => ({ id: `${T.sponsorships[sp].id}-0x${String(tx).padStart(64, '0')}`, amount: W(amount), date: String(NOW - secsAgo), operator: party(T.operators[op]), sponsorship: T.sponsorships[sp] });
    T.stakingEvents = [
        se(0, 3, 701, 2 * DAY, 100000), se(0, 3, 702, 120, 350000),     // staked +250K
        se(2, 5, 703, 3 * DAY, 1500000), se(2, 5, 704, 5000, 300000),   // reduced 1.2M
        se(1, 1, 705, 4 * DAY, 80000), se(1, 1, 706, 600, 80000),       // earnings collected: skipped
        se(5, 2, 707, 5 * DAY, 50000), se(5, 2, 708, 900, 42000),       // slashed 8K
        se(7, 6, 709, 6 * DAY, 20000),                                  // then unstaked (Unstaked log): 20K
        se(8, 9, 710, 10 * DAY, 30000), se(8, 9, 711, 200, 45000)       // left 8 days ago, staked again: +45K
    ];
    T.slashingEvents.push({ id: T.stakingEvents[7].id, amount: W(8000), date: T.stakingEvents[7].date, sponsorship: T.sponsorships[2], operator: { id: T.operators[5].id } });
    // Owners' self-delegations: 30% of the first 300 operators' value
    T.delegations = T.operators.slice(0, 300).map((o, i) => ({ id: `self${i}`, isSelfDelegation: true, _valueDataWei: (BigInt(o.valueWithoutEarnings) * 3n / 10n).toString(), latestDelegationTimestamp: NOW - 50 * DAY, delegator: { id: hex(0xf000 + i) }, operator: party(o) }));
    T.flags = [
        ...Array.from({ length: 25 }, (_, i) => ({ id: `k${i}`, result: 'kicked', flaggingTimestamp: NOW - (500 - i * 15) * DAY, flagResolutionTimestamp: NOW - (500 - i * 15) * DAY + 7200, targetStakeAtRiskWei: W(8000), target: party(T.operators[5]), flagger: party(T.operators[6]), sponsorship: T.sponsorships[2] })),
        { id: 'f1', result: 'voting', flaggingTimestamp: NOW - 3000, flagResolutionTimestamp: 0, target: party(T.operators[1]), flagger: party(T.operators[0]), sponsorship: T.sponsorships[0] },
        { id: 'f0', result: 'kicked', flaggingTimestamp: NOW - 90000, flagResolutionTimestamp: NOW - 7200, target: party(T.operators[2]), flagger: party(T.operators[3]), sponsorship: T.sponsorships[1] }
    ];
    T.votes = [{ id: 'v1', timestamp: NOW - 600, votedKick: true, voter: party(T.operators[3]), flag: { id: 'f1', target: party(T.operators[1]), sponsorship: T.sponsorships[0] } }];
    return T;
}

// ---------- Event logs (Etherscan) and receipts (RPC) ----------

function buildLogs(T) {
    const { id } = ethers.utils;
    const pad = (value) => ethers.utils.hexZeroPad(value, 32);
    const uint = (n) => pad(ethers.BigNumber.from(W(n)).toHexString());
    const enc = (types, values) => ethers.utils.defaultAbiCoder.encode(types, values);
    const log = (address, topics, data, minsAgo, index, tx) => ({
        address, topics, data, blockNumber: '0x' + (LATEST_BLOCK - minsAgo * 30).toString(16), timeStamp: '0x' + (NOW - minsAgo * 60).toString(16),
        logIndex: '0x' + index.toString(16), transactionHash: '0x' + String(tx).padStart(64, '0')
    });
    const op = (i) => T.operators[i].id;
    const TOPICS = {
        delegated: id('Delegated(address,uint256)'), undelegated: id('Undelegated(address,uint256)'), profit: id('Profit(uint256,uint256,uint256)'),
        unstaked: id('Unstaked(address)'), streamCreated: id('StreamCreated(string,string)'),
        permission: id('PermissionUpdated(string,address,bool,bool,uint256,uint256,bool)'), permissionForUserId: id('PermissionUpdatedForUserId(string,bytes,bool,bool,uint256,uint256,bool)'),
        storageAdded: id('Added(string,address)'), storageRemoved: id('Removed(string,address)'), newSponsorship: id('NewSponsorship(address,string,string,address[],uint256[],address)')
    };
    const byTopic = {
        // Delegations, one from another contract, and two inside staking transactions (txs 5 and 6, see the receipts)
        [TOPICS.delegated]: [log(op(1), [TOPICS.delegated, pad(T.operators[1].owner)], uint(50000), 30, 1, 1), log(op(4), [TOPICS.delegated, pad(hex(0xe2))], uint(12345), 5, 2, 2),
            log(hex(0x999), [TOPICS.delegated, pad(hex(0xe9))], uint(7777777), 1, 3, 3), log(op(6), [TOPICS.delegated, pad(T.operators[6].owner)], uint(999), 2, 5, 5)],
        [TOPICS.undelegated]: [log(op(3), [TOPICS.undelegated, pad(hex(0xe3))], uint(2000), 90, 4, 4), log(op(7), [TOPICS.undelegated, pad(hex(0xe7))], uint(888), 3, 6, 6)],
        // Profit(valueIncrease, indexed operatorsCut, indexed protocolFee): one from another contract, one of zero
        [TOPICS.profit]: [log(op(8), [TOPICS.profit, uint(150), uint(50)], uint(800), 400, 1, 101), log(op(9), [TOPICS.profit, uint(500), uint(500)], uint(4000), 10, 2, 102),
            log(hex(0x999), [TOPICS.profit, uint(0), uint(0)], uint(9e6), 5, 3, 103), log(op(10), [TOPICS.profit, uint(0), uint(0)], uint(0), 4, 4, 104)],
        [TOPICS.unstaked]: [log(op(8), [TOPICS.unstaked, pad(T.sponsorships[9].id)], '0x', 8 * 24 * 60, 0, 950), log(op(7), [TOPICS.unstaked, pad(T.sponsorships[6].id)], '0x', 30, 0, 951)]
    };
    const REGISTRY = '0x0d483e10612f327fc11965fc82e90dc19b141641', STORAGE = '0xe8e2660cedf2a59c917a5ed05b72df4146b58399', FACTORY = '0x820b2f9a15ed45f9802c59d0cc77c22c81755e45';
    const PERM = ['string', 'address', 'bool', 'bool', 'uint256', 'uint256', 'bool'];
    const MAX = ethers.constants.MaxUint256;
    const byAddress = {
        [REGISTRY]: [
            // A new stream with its creator's permissions (same transaction: not a permission change)
            log(REGISTRY, [TOPICS.streamCreated], enc(['string', 'string'], ['0xabc0000000000000000000000000000000000001/new-stream', '{}']), 3, 0, 900),
            log(REGISTRY, [TOPICS.permission], enc(PERM, ['0xabc0000000000000000000000000000000000001/new-stream', hex(0xabc), true, true, MAX, MAX, true]), 3, 1, 900),
            log(REGISTRY, [TOPICS.permission], enc(PERM, ['0xabc0000000000000000000000000000000000002/public-feed', ethers.constants.AddressZero, false, false, MAX, MAX, false]), 20, 0, 901),
            log(REGISTRY, [TOPICS.permissionForUserId], enc(['string', 'bytes', 'bool', 'bool', 'uint256', 'uint256', 'bool'], ['streamr.eth/demo', '0x1234567890abcdef1234', false, false, 0, 0, false]), 50, 0, 902)
        ],
        [STORAGE]: [
            log(STORAGE, [TOPICS.storageAdded, pad(hex(0x5701))], enc(['string'], ['streamr.eth/demo']), 15, 0, 903),
            log(STORAGE, [TOPICS.storageRemoved, pad(hex(0x5702))], enc(['string'], ['0xabc0000000000000000000000000000000000002/public-feed']), 70, 0, 904)
        ],
        [FACTORY]: [log(FACTORY, [TOPICS.newSponsorship, pad(T.sponsorships[7].id), pad(hex(0x5c))], enc(['string', 'string', 'address[]', 'uint256[]'], [T.sponsorships[7].stream.id, '{}', [hex(1)], [5]]), 2, 0, 905)]
    };
    const sortLogs = (logs) => logs.sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16));
    Object.values(byTopic).forEach(sortLogs);
    Object.values(byAddress).forEach(sortLogs);
    // Transactions 5 and 6 were staking actions: a sponsorship emitted a log in them
    const stakingTxs = new Set([5, 6].map(i => '0x' + String(i).padStart(64, '0')));
    const receipt = (hash) => ({
        transactionHash: hash, blockHash: '0x' + '1'.repeat(64), blockNumber: '0x1', transactionIndex: '0x0', from: hex(0xe1), to: hex(0xa0000),
        gasUsed: '0x5208', cumulativeGasUsed: '0x5208', logsBloom: '0x' + '0'.repeat(512), status: '0x1', type: '0x2', effectiveGasPrice: '0x1', contractAddress: null,
        logs: (stakingTxs.has(hash) ? [T.sponsorships[0].id, hex(0xa0000)] : [hex(0xa0000)]).map((address, i) => ({
            address, topics: ['0x' + '2'.repeat(64)], data: '0x', blockNumber: '0x1', blockHash: '0x' + '1'.repeat(64), transactionHash: hash, transactionIndex: '0x0', logIndex: '0x' + i.toString(16), removed: false
        }))
    });
    return { byTopic, byAddress, receipt };
}

// ---------- Subgraph resolver ----------

const toNumber = (v) => (typeof v === 'string' && /^-?\d+$/.test(v) ? BigInt(v) : typeof v === 'number' ? BigInt(Math.trunc(v)) : v);
function compare(a, b) {
    const x = toNumber(a), y = toNumber(b);
    if (typeof x === 'bigint' && typeof y === 'bigint') return x < y ? -1 : x > y ? 1 : 0;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
function valueOf(node, variables = {}) {
    switch (node.kind) {
        case 'IntValue': case 'StringValue': case 'BooleanValue': case 'EnumValue': return node.value;
        case 'ListValue': return node.values.map(v => valueOf(v, variables));
        case 'ObjectValue': return Object.fromEntries(node.fields.map(f => [f.name.value, valueOf(f.value, variables)]));
        case 'Variable': return variables[node.name.value] ?? null;
        default: return null;
    }
}
function matches(row, where) {
    return Object.entries(where || {}).every(([key, value]) => {
        const [, field, op] = key.match(/^(.*?)(_gt|_gte|_lt|_lte|_in|_not)?$/);
        let x = row[field];
        if (x && typeof x === 'object' && !Array.isArray(x)) x = x.id;
        if (op === '_gt') return compare(x, value) > 0;
        if (op === '_gte') return compare(x, value) >= 0;
        if (op === '_lt') return compare(x, value) < 0;
        if (op === '_lte') return compare(x, value) <= 0;
        if (op === '_in') return Array.isArray(value) && value.includes(x);
        if (op === '_not') return String(x) !== String(value);
        return String(x) === String(value);
    });
}
function project(value, selection) {
    if (!selection) return value;
    if (Array.isArray(value)) return value.map(v => project(v, selection));
    if (value === null || typeof value !== 'object') return value;
    const out = {};
    for (const f of selection.selections) out[f.alias?.value || f.name.value] = project(value[f.name.value], f.selectionSet);
    return out;
}

/**
 * Routes every request of a browser context: the subgraph, the explorer API and the RPCs are answered here,
 * the app's own files go to the test server, anything else is aborted. Also replaces the Streamr client with
 * one whose operators send coordination heartbeats (the 300 with stake: even ones 1 node, odd ones 2, the first
 * 10 also a shared one = 451 nodes). Returns what the app asked for.
 */
export async function mockNetwork(context) {
    const T = buildData();
    const logs = buildLogs(T);
    const stats = { invalidQueries: [], queries: {}, explorerCalls: 0, receiptCalls: 0 };

    const resolve = (query, variables = {}) => {
        let doc;
        try {
            doc = parse(query);
            const errors = validate(schema, doc).map(e => e.message);
            if (errors.length) stats.invalidQueries.push({ query: query.replace(/\s+/g, ' ').slice(0, 160), errors });
        } catch (e) {
            stats.invalidQueries.push({ query: query.slice(0, 160), errors: [e.message] });
            return { errors: [{ message: e.message }] };
        }
        const data = {};
        for (const f of doc.definitions[0].selectionSet.selections) {
            const name = f.name.value;
            const args = Object.fromEntries(f.arguments.map(a => [a.name.value, valueOf(a.value, variables)]));
            stats.queries[name] = (stats.queries[name] || 0) + 1;
            if (name === '_meta') {
                data[f.alias?.value || name] = { block: { number: LATEST_BLOCK, timestamp: NOW } };
                continue;
            }
            let rows = (T[name] || []).filter(r => matches(r, args.where));
            if (args.orderBy) {
                const dir = args.orderDirection === 'desc' ? -1 : 1;
                rows = [...rows].sort((a, b) => dir * compare(a[args.orderBy], b[args.orderBy]));
            }
            const skip = Number(args.skip || 0), first = Number(args.first ?? 100);
            if (first > 1000 || skip > 5000) return { errors: [{ message: 'The `first` / `skip` argument is too large' }] };
            data[f.alias?.value || name] = project(rows.slice(skip, skip + first), f.selectionSet);
        }
        return { data };
    };
    const rpc = (req) => ({
        jsonrpc: '2.0', id: req.id,
        result: req.method === 'eth_chainId' ? '0x89' : req.method === 'net_version' ? '137' : req.method === 'eth_blockNumber' ? '0x' + LATEST_BLOCK.toString(16)
            : req.method === 'eth_getTransactionReceipt' ? (stats.receiptCalls++, logs.receipt(req.params[0])) : null
    });

    await context.route('**/*', (route) => {
        const request = route.request();
        const url = request.url();
        if (url.startsWith('http://localhost:')) return route.continue();
        if (url.includes('api.etherscan.io') && url.includes('action=getLogs')) {
            stats.explorerCalls++;
            const q = new URL(url).searchParams;
            const from = Number(q.get('fromBlock'));
            const source = q.get('address') ? (logs.byAddress[q.get('address')] || []).filter(l => l.topics[0] === q.get('topic0')) : logs.byTopic[q.get('topic0')] || [];
            const result = source.filter(l => parseInt(l.blockNumber, 16) >= from).slice(0, Number(q.get('offset')) || 1000);
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result.length ? { status: '1', message: 'OK', result } : { status: '0', message: 'No records found', result: [] }) });
        }
        if (/drpc|publicnode|quiknode|1rpc|polygon-rpc/.test(url) && request.method() === 'POST') {
            const body = JSON.parse(request.postData() || '{}');
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? body.map(rpc) : rpc(body)) });
        }
        if (url.includes('thegraph.com')) {
            const { query = '', variables = {} } = JSON.parse(request.postData() || '{}');
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify(resolve(query, variables || {})) });
        }
        return route.abort();
    });

    await context.addInitScript(() => {
        class FakeStreamrClient {
            async subscribe(streamId, onMessage) {
                const id = String(streamId?.id || streamId);
                if (/DATA_History/.test(id)) throw new Error('offline');   // the price history comes from the CSV
                const m = /^0x([0-9a-f]+)\/operator\/coordination$/.exec(id);
                let timer = null;
                if (m) {
                    window.__subscriptions = (window.__subscriptions || 0) + 1;
                    const i = parseInt(m[1], 16) - 0xa0000;
                    const nodes = i < 300 ? [...Array.from({ length: (i % 2) + 1 }, (_, k) => `n${i}-${k}`), ...(i < 10 ? ['shared'] : [])] : [];
                    if (nodes.length) timer = setInterval(() => nodes.forEach(nodeId => onMessage({ msgType: 'heartbeat', peerDescriptor: { nodeId } }, {})), 150);
                }
                return { unsubscribe: async () => { if (m) window.__subscriptions--; clearInterval(timer); } };
            }
            async destroy() {}
        }
        const handler = { get: (target, key) => (key in target ? target[key] : async () => null) };
        Object.defineProperty(window, 'StreamrClient', { configurable: true, get: () => function () { return new Proxy(new FakeStreamrClient(), handler); }, set: () => {} });
    });
    return stats;
}

/** Opens a page of the app as a guest */
export async function openApp(page, path = '/') {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    const guest = page.locator('#guestBtn');
    await guest.waitFor({ state: 'visible', timeout: 10000 }).then(() => guest.click()).catch(() => {});
}
