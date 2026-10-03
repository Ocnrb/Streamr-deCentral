/**
 * Market page, Liquidity tab: the transactions of the wallet's Uniswap v4 positions in the DATA/USDC pools, all through
 * the chain's PositionManager (modifyLiquidities: a list of actions and their parameters).
 * - New position: MINT_POSITION + SETTLE_PAIR (the tokens are pulled through Permit2)
 * - Add: INCREASE_LIQUIDITY + SETTLE_PAIR
 * - Remove: DECREASE_LIQUIDITY + TAKE_PAIR (the uncollected fees come with it)
 * - Collect fees: DECREASE_LIQUIDITY of 0 + TAKE_PAIR
 * Tokens in need the token's allowance to Permit2 and Permit2's allowance to the PositionManager: the latter is signed
 * (PermitBatch, no gas) and sent in the same transaction (multicall: permitBatch, then modifyLiquidities).
 * Amounts are worked out from L and √prices (amount0 = L (1/√p - 1/√b), amount1 = L (√p - √a)) with the max slippage
 * as margin: the most paid in, the least taken out.
 */

import { ethers } from 'ethers';

export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const MIN_TICK = -887220;   // the widest range at tick spacing 60
export const MAX_TICK = 887220;
const TICK_SPACING = 60;
const FEE = 3000;
const PERMIT_SECONDS = 30 * 60;

const ACTIONS = { INCREASE_LIQUIDITY: 0x00, DECREASE_LIQUIDITY: 0x01, MINT_POSITION: 0x02, SETTLE_PAIR: 0x0d, TAKE_PAIR: 0x11 };
const POOL_KEY = 'tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)';
const abi = ethers.utils.defaultAbiCoder;

export const POSITION_MANAGER_IFACE = new ethers.utils.Interface([
    'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
    'function multicall(bytes[] data) payable returns (bytes[] results)',
    'function permitBatch(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce)[] details, address spender, uint256 sigDeadline) _permitBatch, bytes signature) payable returns (bytes err)'
]);
export const PERMIT2_IFACE = new ethers.utils.Interface(['function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)']);
const PERMIT_TYPES = {
    PermitBatch: [{ name: 'details', type: 'PermitDetails[]' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
    PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }]
};

// ============================================
// Prices, ticks and amounts
// ============================================

const DECIMALS = { data: 18, usdc: 6 };
export const sqrtAtTick = (tick) => 1.0001 ** (tick / 2);
const currencies = (pool) => (pool.dataIs0 ? [pool.data, pool.usdc] : [pool.usdc, pool.data]);

/** DATA's USD price at a tick (USDC at $1) */
export function priceAtTick(pool, tick) {
    const raw = 1.0001 ** tick * 1e12;   // token1 per token0
    return pool.dataIs0 ? raw : 1 / raw;
}

/** The usable tick nearest a DATA price, within the widest range */
export function tickAtPrice(pool, price) {
    const raw = pool.dataIs0 ? price / 1e12 : 1 / (price * 1e12);
    const tick = Math.round(Math.log(raw) / Math.log(1.0001) / TICK_SPACING) * TICK_SPACING;
    return Math.min(MAX_TICK, Math.max(MIN_TICK, tick));
}

/** A range's ticks from two DATA prices (in either order; the ticks run the other way when DATA is token1) */
export function rangeTicks(pool, minPrice, maxPrice) {
    const ticks = [tickAtPrice(pool, minPrice), tickAtPrice(pool, maxPrice)].sort((a, b) => a - b);
    if (ticks[0] === ticks[1]) ticks[1] = ticks[0] + TICK_SPACING;
    return ticks;
}

/** The token amounts of liquidity L in a range at the pool's √price, in token units: { data, usdc } */
export function amountsForLiquidity(pool, L, sqrtP, lower, upper) {
    const [sa, sb] = [sqrtAtTick(lower), sqrtAtTick(upper)];
    const s = Math.min(Math.max(sqrtP, sa), sb);
    const amount0 = L * (1 / s - 1 / sb);
    const amount1 = L * (s - sa);
    const [data, usdc] = pool.dataIs0 ? [amount0, amount1] : [amount1, amount0];
    return { data: data / 10 ** DECIMALS.data, usdc: usdc / 10 ** DECIMALS.usdc };
}

/** The liquidity a deposit of one token gives in a range, and the other token it then needs: { L, data, usdc } */
export function depositFor(pool, sqrtP, lower, upper, token, amount) {
    const one = amountsForLiquidity(pool, 1, sqrtP, lower, upper);
    if (!(one[token] > 0)) return { L: 0, data: 0, usdc: 0 };   // the range holds none of that token at this price
    const L = amount / one[token];
    return { L, ...amountsForLiquidity(pool, L, sqrtP, lower, upper) };
}

// ============================================
// Transactions
// ============================================

const units = (amount, decimals) => BigInt(ethers.utils.parseUnits(Math.max(0, amount).toFixed(decimals), decimals).toString());
const margin = (amount, slippage, up) => amount * (up ? 1 + slippage / 100 : 1 - slippage / 100);
const deadline = () => Math.floor(Date.now() / 1000) + 20 * 60;

/** The most of each token a deposit may take, as [token0, token1] in base units */
function maxIn(pool, amounts, slippage) {
    const data = units(margin(amounts.data, slippage, true), DECIMALS.data);
    const usdc = units(margin(amounts.usdc, slippage, true), DECIMALS.usdc);
    return pool.dataIs0 ? [data, usdc] : [usdc, data];
}

/** The least of each token a withdrawal must give, as [token0, token1] in base units */
function minOut(pool, amounts, slippage) {
    const data = units(margin(amounts.data, slippage, false), DECIMALS.data);
    const usdc = units(margin(amounts.usdc, slippage, false), DECIMALS.usdc);
    return pool.dataIs0 ? [data, usdc] : [usdc, data];
}

/** L in base units, a hair under the computed one so the deposit fits its amounts */
const liquidityUnits = (L) => BigInt(Math.floor(L * (1 - 1e-9)));

function modify(actions, params, permit) {
    const unlock = abi.encode(['bytes', 'bytes[]'], [ethers.utils.hexlify(actions), params]);
    const call = POSITION_MANAGER_IFACE.encodeFunctionData('modifyLiquidities', [unlock, deadline()]);
    if (!permit) return call;
    const permitCall = POSITION_MANAGER_IFACE.encodeFunctionData('permitBatch', [permit.owner, permit.batch, permit.signature]);
    return POSITION_MANAGER_IFACE.encodeFunctionData('multicall', [[permitCall, call]]);
}

/** A new position: { to, data, maxIn } */
export function mintTx(pool, { lower, upper, L, amounts, slippage, owner, permit = null }) {
    const key = [...currencies(pool), FEE, TICK_SPACING, ethers.constants.AddressZero];
    const [max0, max1] = maxIn(pool, amounts, slippage);
    const params = [
        abi.encode([POOL_KEY, 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'], [key, lower, upper, liquidityUnits(L), max0, max1, owner, '0x']),
        abi.encode(['address', 'address'], currencies(pool))
    ];
    return { to: pool.positions, data: modify([ACTIONS.MINT_POSITION, ACTIONS.SETTLE_PAIR], params, permit), maxIn: [max0, max1] };
}

/** More liquidity in a position: { to, data, maxIn } */
export function increaseTx(pool, { tokenId, L, amounts, slippage, permit = null }) {
    const [max0, max1] = maxIn(pool, amounts, slippage);
    const params = [
        abi.encode(['uint256', 'uint256', 'uint128', 'uint128', 'bytes'], [tokenId, liquidityUnits(L), max0, max1, '0x']),
        abi.encode(['address', 'address'], currencies(pool))
    ];
    return { to: pool.positions, data: modify([ACTIONS.INCREASE_LIQUIDITY, ACTIONS.SETTLE_PAIR], params, permit), maxIn: [max0, max1] };
}

/** Liquidity out of a position to the owner, with its uncollected fees (L of 0: the fees only): { to, data } */
export function decreaseTx(pool, { tokenId, liquidity, amounts, slippage, owner }) {
    const [min0, min1] = minOut(pool, amounts, slippage);
    const params = [
        abi.encode(['uint256', 'uint256', 'uint128', 'uint128', 'bytes'], [tokenId, liquidity, min0, min1, '0x']),
        abi.encode(['address', 'address', 'address'], [...currencies(pool), owner])
    ];
    return { to: pool.positions, data: modify([ACTIONS.DECREASE_LIQUIDITY, ACTIONS.TAKE_PAIR], params, null) };
}

/** The uncollected fees of a position to its owner: { to, data } */
export const collectTx = (pool, { tokenId, owner }) => decreaseTx(pool, { tokenId, liquidity: 0n, amounts: { data: 0, usdc: 0 }, slippage: 0, owner });

/**
 * The Permit2 allowances a deposit still needs for the PositionManager: the details to sign, or null when both are
 * enough (allowances: Permit2's { amount, expiration, nonce } for token0 and token1)
 */
export function permitNeeded(pool, needed, allowances, now = Math.floor(Date.now() / 1000)) {
    const missing = currencies(pool).some((token, i) => needed[i] > 0n && (BigInt(allowances[i].amount.toString()) < needed[i] || Number(allowances[i].expiration) < now + 120));
    if (!missing) return null;
    const expiration = now + PERMIT_SECONDS;
    return {
        details: currencies(pool).map((token, i) => ({ token, amount: needed[i].toString(), expiration, nonce: Number(allowances[i].nonce) })),   // signed as text: ethers v5 can't serialize a BigInt
        spender: pool.positions,
        sigDeadline: expiration
    };
}

/** Signs a Permit2 batch: the permit for mintTx / increaseTx */
export async function signPermit(signer, chainId, owner, batch) {
    const signature = await signer._signTypedData({ name: 'Permit2', chainId, verifyingContract: PERMIT2 }, PERMIT_TYPES, batch);
    return { owner, batch, signature };
}
