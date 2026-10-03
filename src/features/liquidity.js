/**
 * Market page, Liquidity tab: the wallet's Uniswap v4 positions in the DATA/USDC pools (0.3%, no hooks) on Polygon
 * and Ethereum, read only.
 * - The positions are NFTs of each chain's PositionManager: the wallet's ones are found from its NFT transfers on the
 *   explorer, then checked on-chain (ownerOf, getPoolAndPositionInfo, getPositionLiquidity), all through Multicall3.
 * - The pool's price, fee growth and the ticks of each range come from the PoolManager's storage (extsload): a position
 *   holds L (1/√p - 1/√b) DATA and L (√p - √a) USDC inside its range (all DATA below it, all USDC above it), and its
 *   uncollected fees are L x (fee growth inside its range - fee growth inside when last collected) / 2^128.
 */

import * as Services from '../core/services.js';
import * as Utils from '../core/utils.js';
import { DATA_TOKEN_ADDRESS_POLYGON, DATA_TOKEN_ADDRESS_ETHEREUM, POLYGONSCAN_NETWORK, getEtherscanApiKey } from '../core/constants.js';
import { getEthProvider } from './swapMarket.js';
import { readPoolDepth } from './swapBook.js';
import { ethers } from 'ethers';

const { logger } = Utils;

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';   // the same address on both chains
const FEE = 3000;
const TICK_SPACING = 60;
const Q128 = 1n << 128n;
const MOD = 1n << 256n;
const EXPLORER_BUSY = /rate limit|max calls|too many|timeout|temporarily|busy/i;

/** The DATA/USDC v4 pool of each chain, with its PoolManager and PositionManager */
export const LIQUIDITY_POOLS = {
    137: {
        chain: 137, name: 'Polygon', slug: 'polygon', explorer: 'https://polygonscan.com',
        manager: '0x67366782805870060151383f4bbff9dab53e5cd6', positions: '0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9',
        data: DATA_TOKEN_ADDRESS_POLYGON.toLowerCase(), usdc: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'
    },
    1: {
        chain: 1, name: 'Ethereum', slug: 'ethereum', explorer: 'https://etherscan.io',
        manager: '0x000000000004444c5dc75cb358380d2e3de08a90', positions: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',
        data: DATA_TOKEN_ADDRESS_ETHEREUM.toLowerCase(), usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
    }
};
for (const pool of Object.values(LIQUIDITY_POOLS)) {
    pool.dataIs0 = pool.data < pool.usdc;
    const [currency0, currency1] = pool.dataIs0 ? [pool.data, pool.usdc] : [pool.usdc, pool.data];
    pool.id = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'address', 'uint24', 'int24', 'address'], [currency0, currency1, FEE, TICK_SPACING, ethers.constants.AddressZero]));
    pool.stateSlot = BigInt(ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['bytes32', 'uint256'], [pool.id, 6])));
    pool.url = `https://app.uniswap.org/explore/pools/${pool.slug}/${pool.id}`;
    pool.book = { id: pool.id, tickSpacing: TICK_SPACING, dataIs0: pool.dataIs0, counterDecimals: 6, counterSymbol: 'USDC' };   // for its depth
}

const IFACES = {
    multicall: new ethers.utils.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']),
    manager: new ethers.utils.Interface(['function extsload(bytes32 slot) view returns (bytes32)']),
    positions: new ethers.utils.Interface([
        'function ownerOf(uint256 id) view returns (address)',
        'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
        'function getPositionLiquidity(uint256 tokenId) view returns (uint128)'
    ])
};

const word = (value) => `0x${BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, '0')}`;
const toSigned = (value, bits) => BigInt.asIntN(bits, value);

/** Read calls on a chain through Multicall3: each result decoded, or null when it failed */
async function multicall(chain, calls) {
    if (!calls.length) return [];
    const data = IFACES.multicall.encodeFunctionData('aggregate3', [calls.map(c => ({ target: c.target, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args || []) }))]);
    const read = (provider) => provider.call({ to: MULTICALL3, data });
    const raw = chain === 137 ? await Services.readWithFallback(() => read(Services.getReadOnlyProvider())) : await read(getEthProvider());
    const [results] = IFACES.multicall.decodeFunctionResult('aggregate3', raw);
    return results.map((r, i) => {
        if (!r.success) return null;
        try { return calls[i].iface.decodeFunctionResult(calls[i].fn, r.returnData); } catch (e) { return null; }
    });
}

const load = (pool, slot) => ({ target: pool.manager, iface: IFACES.manager, fn: 'extsload', args: [word(slot)] });
const tickSlot = (pool, tick) => BigInt(ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['int24', 'uint256'], [tick, word(pool.stateSlot + 4n)])));
function positionSlot(pool, tokenId, lower, upper) {
    const key = ethers.utils.keccak256(ethers.utils.solidityPack(['address', 'int24', 'int24', 'bytes32'], [pool.positions, lower, upper, word(tokenId)]));
    return BigInt(ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['bytes32', 'uint256'], [key, word(pool.stateSlot + 6n)])));
}

/** The token ids the wallet holds by its NFT transfers on the explorer (asked again while it is busy) */
async function heldTokenIds(pool, address) {
    const url = `${POLYGONSCAN_NETWORK.apiUrl}?chainid=${pool.chain}&module=account&action=tokennfttx&contractaddress=${pool.positions}&address=${address}&page=1&offset=1000&sort=asc&apikey=${getEtherscanApiKey()}`;
    for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
        try {
            const json = await fetch(url).then(r => r.json());
            if (Array.isArray(json?.result)) {
                const held = new Set();
                for (const t of json.result) {
                    if (t.to?.toLowerCase() === address) held.add(String(t.tokenID));
                    if (t.from?.toLowerCase() === address) held.delete(String(t.tokenID));
                }
                return [...held];
            }
            if (!EXPLORER_BUSY.test(`${json?.message} ${json?.result}`)) return [];
        } catch (e) { /* network failure: asked again */ }
    }
    throw new Error(`${pool.name} explorer busy`);
}

/** DATA's USD price at a raw √price (USDC at $1) */
function usdAtSqrt(pool, sqrt) {
    const raw = sqrt * sqrt * 1e12;   // token1 per token0, DATA 18 and USDC 6 decimals
    return pool.dataIs0 ? raw : 1 / raw;
}
const sqrtAtTick = (tick) => 1.0001 ** (tick / 2);

/** The token amounts of liquidity L between two raw √prices at the pool's √price, as [DATA, USDC] */
function amounts(pool, L, sqrtP, sqrtA, sqrtB) {
    const s = Math.min(Math.max(sqrtP, sqrtA), sqrtB);
    const amount0 = L * (1 / s - 1 / sqrtB) / (pool.dataIs0 ? 1e18 : 1e6);
    const amount1 = L * (s - sqrtA) / (pool.dataIs0 ? 1e6 : 1e18);
    return pool.dataIs0 ? [amount0, amount1] : [amount1, amount0];
}

/** The wallet's positions in a chain's DATA/USDC pool, with their amounts, uncollected fees and USD value */
async function readPositions(pool, address) {
    const ids = await heldTokenIds(pool, address);
    if (!ids.length) return [];
    const p = (fn, id) => ({ target: pool.positions, iface: IFACES.positions, fn, args: [id] });
    const info = await multicall(pool.chain, ids.flatMap(id => [p('ownerOf', id), p('getPoolAndPositionInfo', id), p('getPositionLiquidity', id)]));
    const found = [];
    ids.forEach((id, i) => {
        const [owner, details, liquidity] = info.slice(i * 3, i * 3 + 3);
        if (!owner || !details || !liquidity || owner[0].toLowerCase() !== address) return;
        const key = details.poolKey;
        const id2 = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'address', 'uint24', 'int24', 'address'], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
        if (id2 !== pool.id) return;
        const packed = BigInt(details.info.toString());
        found.push({ tokenId: id, lower: Number(toSigned((packed >> 8n) & 0xffffffn, 24)), upper: Number(toSigned((packed >> 32n) & 0xffffffn, 24)), liquidity: BigInt(liquidity[0].toString()) });
    });
    if (!found.length) return [];

    // The pool's price and fee growth, each range's ticks and the position's fee growth when last collected
    const s = pool.stateSlot;
    const calls = [load(pool, s), load(pool, s + 1n), load(pool, s + 2n)];
    for (const f of found) {
        const lowerSlot = tickSlot(pool, f.lower);
        const upperSlot = tickSlot(pool, f.upper);
        const posSlot = positionSlot(pool, f.tokenId, f.lower, f.upper);
        calls.push(load(pool, lowerSlot + 1n), load(pool, lowerSlot + 2n), load(pool, upperSlot + 1n), load(pool, upperSlot + 2n), load(pool, posSlot + 1n), load(pool, posSlot + 2n));
    }
    const words = (await multicall(pool.chain, calls)).map(r => (r ? BigInt(r[0]) : null));
    if (words[0] === null) throw new Error(`${pool.name} pool not read`);
    const slot0 = words[0];
    const sqrtP = Number(slot0 & ((1n << 160n) - 1n)) / 2 ** 96;
    const tick = Number(toSigned((slot0 >> 160n) & 0xffffffn, 24));
    const price = usdAtSqrt(pool, sqrtP);
    const [global0, global1] = [words[1] ?? 0n, words[2] ?? 0n];
    return found.map((f, i) => {
        const [out0Lower, out1Lower, out0Upper, out1Upper, last0, last1] = words.slice(3 + i * 6, 9 + i * 6).map(w => w ?? 0n);
        // Fee growth inside the range: the global one minus what grew below and above it
        const inside = (global, outLower, outUpper) => {
            const below = tick >= f.lower ? outLower : global - outLower;
            const above = tick < f.upper ? outUpper : global - outUpper;
            return ((global - below - above) % MOD + MOD) % MOD;
        };
        const owed = (now, last) => Number(f.liquidity * (((now - last) % MOD + MOD) % MOD) / Q128);
        const fees0 = owed(inside(global0, out0Lower, out0Upper), last0);
        const fees1 = owed(inside(global1, out1Lower, out1Upper), last1);
        const [data, usdc] = amounts(pool, Number(f.liquidity), sqrtP, sqrtAtTick(f.lower), sqrtAtTick(f.upper));
        const [feeData, feeUsdc] = pool.dataIs0 ? [fees0 / 1e18, fees1 / 1e6] : [fees1 / 1e18, fees0 / 1e6];
        const [min, max] = [usdAtSqrt(pool, sqrtAtTick(f.lower)), usdAtSqrt(pool, sqrtAtTick(f.upper))].sort((a, b) => a - b);
        return {
            chain: pool.chain, tokenId: f.tokenId, min, max, inRange: tick >= f.lower && tick < f.upper, closed: f.liquidity === 0n,
            data, usdc, value: data * price + usdc, feeData, feeUsdc, feeValue: feeData * price + feeUsdc,
            url: `https://app.uniswap.org/positions/v4/${pool.slug}/${f.tokenId}`
        };
    });
}

const state = {
    address: null,
    positions: null,        // every chain's, null until read
    depth: {},              // chain -> its pool's price, liquidity by price and holdings (readPoolDepth)
    errors: [],
    loading: false,
    seq: 0
};
const listeners = new Set();
const notify = () => listeners.forEach(fn => fn());

export const Liquidity = {
    /** Reads the pools' depth and the wallet's positions on both chains; listeners are told when done */
    async refresh(address) {
        const seq = ++state.seq;
        if (address !== state.address) {
            state.address = address;
            state.positions = null;
        }
        state.loading = true;
        notify();
        const pools = Object.values(LIQUIDITY_POOLS);
        const depths = await Promise.all(pools.map(pool => readPoolDepth(pool.chain, pool.book).catch(e => { logger.warn('Liquidity: pool not read', e); return null; })));
        const positions = [];
        const errors = [];
        if (address) {
            // One chain at a time: the explorer's calls are rate limited
            for (const pool of pools) {
                try {
                    positions.push(...await readPositions(pool, address));
                } catch (e) {
                    logger.warn(`Liquidity: ${pool.name} positions not read`, e);
                    errors.push(pool.name);
                }
            }
        }
        if (seq !== state.seq) return;
        pools.forEach((pool, i) => { state.depth[pool.chain] = depths[i]; });
        state.positions = address ? positions.filter(p => !p.closed || p.feeValue > 0) : null;
        state.errors = errors;
        state.loading = false;
        notify();
    },
    positions: () => state.positions,
    /** A chain's pool: { price, levels, data, usdc, tvl }, null when not read */
    depth: (chain) => state.depth[chain] ?? null,
    errors: () => state.errors,
    loading: () => state.loading,
    onChange(fn) {
        listeners.add(fn);
    }
};
