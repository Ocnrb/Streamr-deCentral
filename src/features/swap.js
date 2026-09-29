/**
 * Swap: DATA against POL / USDC / USDC.e on Polygon, straight through the DEX contracts (no aggregator API)
 * - Pools are discovered on-chain (factories of QuickSwap V2, SushiSwap V2, QuickSwap V3 (Algebra) and
 *   Uniswap v3, every fee tier): DATA against WPOL / USDC / USDC.e / USDT / WETH / DAI, and the pools
 *   between those tokens (two-hop routes). All reads go through Multicall3 (one RPC call per batch).
 * - Each candidate route is quoted with the venue's own quoter (V2 routers getAmountsOut,
 *   Algebra Quoter, Uniswap QuoterV2); the best output wins.
 * - The swap goes to that venue's router with the minimum output (slippage) and a deadline. POL is
 *   wrapped / unwrapped by the router in the same transaction. Approvals are for the exact amount.
 * - The price impact compares the quote with a quote for 1/1000 of the amount on the same route.
 */

import * as Utils from '../core/utils.js';
import * as UI from '../ui/ui.js';
import * as Services from '../core/services.js';
import { DATA_TOKEN_ADDRESS_POLYGON } from '../core/constants.js';

const { logger } = Utils;

// ============================================
// Contracts (Polygon)
// ============================================

const WPOL = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';
const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const USDCE = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDT = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
const WETH = '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619';
const DAI = '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063';
const DATA = DATA_TOKEN_ADDRESS_POLYGON;
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const QUICKSWAP_V2_FACTORY = '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32';
const QUICKSWAP_V2_ROUTER = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff';
const SUSHI_V2_FACTORY = '0xc35DADB65012eC5796536bD9864eD8773aBc74C4';
const SUSHI_V2_ROUTER = '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506';
const QUICKSWAP_V3_FACTORY = '0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28';
const QUICKSWAP_V3_QUOTER = '0xa15F0D7377B2A0C0c10db057f641beD21028FC89';
const QUICKSWAP_V3_ROUTER = '0xf5b509bB0909a69B1c207E495f687a596C168E12';
const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const UNISWAP_V3_QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
const UNISWAP_V3_ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';   // SwapRouter02
const UNISWAP_ADDRESS_THIS = '0x0000000000000000000000000000000000000002'; // SwapRouter02: keep the output in the router (to unwrap)
const UNISWAP_FEES = [100, 500, 3000, 10000];

const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)'
];
const V2_FACTORY_ABI = ['function getPair(address, address) view returns (address)'];
const V2_ROUTER_ABI = [
    'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
    'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
    'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
    'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)'
];
const ALGEBRA_FACTORY_ABI = ['function poolByPair(address, address) view returns (address)'];
const ALGEBRA_QUOTER_ABI = ['function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint16[] fees)'];
const ALGEBRA_ROUTER_ABI = [
    'function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
    'function unwrapWNativeToken(uint256 amountMinimum, address recipient) payable',
    'function multicall(bytes[] data) payable returns (bytes[] results)'
];
const UNISWAP_FACTORY_ABI = ['function getPool(address, address, uint24) view returns (address)'];
const UNISWAP_QUOTER_ABI = ['function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)'];
const MULTICALL_ABI = ['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)'];
const UNISWAP_ROUTER_ABI = [
    'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
    'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
    'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)'
];

const VENUES = {
    qv2: { name: 'QuickSwap V2', router: QUICKSWAP_V2_ROUTER, factory: QUICKSWAP_V2_FACTORY },
    sushi: { name: 'SushiSwap V2', router: SUSHI_V2_ROUTER, factory: SUSHI_V2_FACTORY },
    qv3: { name: 'QuickSwap V3', router: QUICKSWAP_V3_ROUTER },
    uni: { name: 'Uniswap v3', router: UNISWAP_V3_ROUTER }
};

// ============================================
// Tokens
// ============================================

const DATA_LOGO_PATH = 'M32.9091 10.2118V9.08164C32.9091 8.69418 32.5861 8.38241 32.199 8.4008C24.6009 8.76169 18.5119 14.8843 18.2056 22.4955C18.2219 22.9725 18.608 23.0974 18.8351 23.0974H19.983C20.3463 23.0974 20.6441 22.8122 20.6629 22.4495C20.989 16.1879 26.0134 11.1697 32.278 10.8522C32.7558 10.7908 32.9091 10.5297 32.9091 10.2118ZM22.5761 23.0974H23.6747C24.0313 23.0974 24.3221 22.8195 24.348 22.4638C24.6586 18.2097 28.0701 14.8164 32.3324 14.5336C32.523 14.521 32.9091 14.3783 32.9091 13.8844V12.7659C32.9091 12.3707 32.5739 12.0603 32.1795 12.0861C26.6654 12.4459 22.256 16.8547 21.8961 22.3679C21.8704 22.7623 22.1808 23.0974 22.5761 23.0974ZM37.1763 32.9026C37.4035 32.9026 37.7895 33.0275 37.8058 33.5045C37.4995 41.1158 31.4105 47.2383 23.8124 47.5993C23.4253 47.6176 23.1023 47.3059 23.1023 46.9183V45.7883C23.1023 45.4704 23.2556 45.2093 23.7333 45.1479C29.9981 44.8304 35.0224 39.8121 35.3485 33.5505C35.3673 33.1878 35.6651 32.9026 36.0284 32.9026H37.1763ZM33.4353 32.9026C33.8306 32.9026 34.141 33.2377 34.1153 33.6321C33.7554 39.1454 29.346 43.5542 23.8319 43.914C23.4375 43.9398 23.1023 43.6293 23.1023 43.2341V42.1155C23.1023 41.6217 23.4884 41.4791 23.679 41.4664C27.9413 41.1837 31.3529 37.7903 31.6633 33.5362C31.6893 33.1805 31.9801 32.9026 32.3367 32.9026H33.4353ZM29.7445 32.9026C30.1445 32.9026 30.463 33.246 30.4231 33.6441C30.0758 37.1151 27.3154 39.8751 23.8438 40.2224C23.4458 40.2623 23.1023 39.9438 23.1023 39.5438V38.4201C23.1023 37.9604 23.5015 37.795 23.6961 37.7715C25.9261 37.5025 27.6953 35.7373 27.9703 33.5095C28.0129 33.1647 28.2999 32.9026 28.6474 32.9026H29.7445ZM10.212 23.0945C10.53 23.0945 10.7911 23.2477 10.8525 23.7254C11.1701 29.9892 16.189 35.0129 22.4516 35.3389C22.8143 35.3577 23.0996 35.6555 23.0996 36.0187V37.1666C23.0996 37.3936 22.9746 37.7796 22.4976 37.7959C14.8853 37.4896 8.76181 31.4015 8.4008 23.8045C8.3824 23.4174 8.69423 23.0945 9.0818 23.0945H10.212ZM13.8853 23.0945C14.3792 23.0945 14.5219 23.4805 14.5346 23.6711C14.8173 27.9328 18.2111 31.3439 22.4659 31.6543C22.8216 31.6803 23.0996 31.971 23.0996 32.3276V33.426C23.0996 33.8212 22.7644 34.1316 22.3699 34.1059C16.8559 33.746 12.4464 29.3373 12.0866 23.824C12.0608 23.4296 12.3713 23.0945 12.7666 23.0945H13.8853ZM33.5024 18.1729C41.1148 18.4792 47.2382 24.5673 47.5993 32.1644C47.6176 32.5514 47.3058 32.8744 46.9183 32.8744H45.788C45.4701 32.8744 45.2089 32.7211 45.1475 32.2434C44.8299 25.9795 39.811 20.956 33.5485 20.6299C33.1857 20.6111 32.9005 20.3133 32.9005 19.9501V18.8023C32.9005 18.5752 33.0253 18.1892 33.5024 18.1729ZM33.6301 21.8629C39.1442 22.2227 43.5536 26.6315 43.9135 32.1448C43.9392 32.5392 43.6288 32.8744 43.2335 32.8744H42.1148C41.6208 32.8744 41.4782 32.4883 41.4655 32.2977C41.1828 28.036 37.7889 24.6249 33.5342 24.3145C33.1784 24.2886 32.9005 23.9978 32.9005 23.6412V22.5428C32.9005 22.1476 33.2357 21.8372 33.6301 21.8629ZM33.642 25.5545C37.1136 25.9019 39.874 28.6619 40.2213 32.1329C40.2612 32.5309 39.9427 32.8744 39.5427 32.8744H38.4188C37.959 32.8744 37.7936 32.4752 37.7701 32.2806C37.501 30.0509 35.7356 28.282 33.5075 28.0071C33.1626 27.9645 32.9005 27.6775 32.9005 27.33V26.2331C32.9005 25.8331 33.244 25.5147 33.642 25.5545ZM17.5812 23.0945C18.0411 23.0945 18.2064 23.4936 18.2299 23.6882C18.4991 25.9179 20.2644 27.6868 22.4926 27.9618C22.8374 28.0043 23.0996 28.2913 23.0996 28.6388V29.7357C23.0996 30.1357 22.7561 30.4541 22.358 30.4144C18.8865 30.0669 16.1261 27.3069 15.7786 23.8359C15.7388 23.4379 16.0573 23.0945 16.4574 23.0945H17.5812ZM32.9091 16.4562V17.5798C32.9091 18.0396 32.51 18.205 32.3152 18.2285C30.0853 18.4976 28.3161 20.2627 28.0411 22.4905C27.9985 22.8353 27.7115 23.0974 27.364 23.0974H26.2669C25.8669 23.0974 25.5484 22.7539 25.5882 22.3559C25.9357 18.885 28.6961 16.125 32.1675 15.7776C32.5656 15.7378 32.9091 16.0562 32.9091 16.4562Z';

const ICONS = {
    DATA: `<svg class="w-7 h-7 flex-shrink-0" viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="28" fill="#F7600A"/><path fill-rule="evenodd" clip-rule="evenodd" d="${DATA_LOGO_PATH}" fill="white"/></svg>`,
    POL: '<svg class="w-7 h-7 flex-shrink-0" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#8247E5"/><path fill="#fff" d="M21.1 13.1a1.3 1.3 0 0 0-1.3 0l-2.9 1.7-2 1.1-2.9 1.7a1.3 1.3 0 0 1-1.3 0l-2.3-1.3a1.3 1.3 0 0 1-.6-1.1v-2.6c0-.4.2-.9.6-1.1l2.2-1.3a1.3 1.3 0 0 1 1.3 0l2.2 1.3c.4.2.6.7.6 1.1v1.7l2-1.2v-1.7c0-.4-.2-.9-.6-1.1l-4.2-2.4a1.3 1.3 0 0 0-1.3 0l-4.3 2.5c-.4.2-.6.6-.6 1v4.9c0 .4.2.9.6 1.1l4.3 2.4c.4.2.9.2 1.3 0l2.9-1.6 2-1.2 2.9-1.6a1.3 1.3 0 0 1 1.3 0l2.2 1.3c.4.2.6.7.6 1.1v2.6c0 .4-.2.9-.6 1.1l-2.2 1.3a1.3 1.3 0 0 1-1.3 0l-2.2-1.3a1.3 1.3 0 0 1-.6-1.1v-1.7l-2 1.2v1.7c0 .4.2.9.6 1.1l4.3 2.4c.4.2.9.2 1.3 0l4.3-2.4c.4-.2.6-.7.6-1.1v-4.9c0-.4-.2-.9-.6-1.1z"/></svg>',
    USDC: '<svg class="w-7 h-7 flex-shrink-0" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#2775CA"/><path fill="#fff" d="M20.2 18.1c0-2.2-1.3-3-4-3.3-1.9-.3-2.3-.8-2.3-1.7s.7-1.4 1.9-1.4c1.1 0 1.8.4 2.1 1.3.1.2.3.3.4.3h1c.3 0 .5-.2.5-.5v-.1a3.2 3.2 0 0 0-2.8-2.6V8.9c0-.3-.2-.5-.6-.5h-.9c-.3 0-.5.2-.6.5v1.2c-1.9.3-3.1 1.5-3.1 3.1 0 2.1 1.3 2.9 4 3.2 1.8.3 2.3.7 2.3 1.7s-.9 1.7-2.1 1.7c-1.6 0-2.2-.7-2.4-1.6-.1-.2-.3-.4-.5-.4h-1c-.3 0-.5.2-.5.5v.1c.3 1.6 1.3 2.7 3.3 3v1.2c0 .3.2.5.6.5h.9c.3 0 .5-.2.6-.5v-1.2c1.9-.3 3.2-1.6 3.2-3.3z"/><path fill="#fff" d="M12.8 24.6a9 9 0 0 1 0-17.2c.3-.1.5-.4.5-.7V5.8c0-.3-.2-.5-.4-.5h-.2a10.9 10.9 0 0 0 0 21.4c.3.1.5 0 .6-.3v-1.1c0-.3-.2-.6-.5-.7zm6.6-19.3c-.3-.1-.5 0-.6.3v.9c0 .3.2.6.5.7a9 9 0 0 1 0 17.2c-.3.1-.5.4-.5.7v.9c0 .3.2.5.4.5h.2a10.9 10.9 0 0 0 0-21.4z"/></svg>'
};

const TOKENS = {
    DATA: { symbol: 'DATA', address: DATA, decimals: 18, icon: ICONS.DATA },
    POL: { symbol: 'POL', address: WPOL, decimals: 18, native: true, icon: ICONS.POL },
    USDC: { symbol: 'USDC', address: USDC, decimals: 6, icon: ICONS.USDC },
    'USDC.e': { symbol: 'USDC.e', address: USDCE, decimals: 6, icon: ICONS.USDC }
};
const COUNTER_TOKENS = ['POL', 'USDC', 'USDC.e'];
const INTERMEDIATES = [WPOL, USDC, USDCE, USDT, WETH, DAI];
// Symbol / decimals of every token a route or pool can hold
const KNOWN_TOKENS = {
    [DATA.toLowerCase()]: { symbol: 'DATA', decimals: 18 },
    [WPOL.toLowerCase()]: { symbol: 'WPOL', decimals: 18 },
    [USDC.toLowerCase()]: { symbol: 'USDC', decimals: 6 },
    [USDCE.toLowerCase()]: { symbol: 'USDC.e', decimals: 6 },
    [USDT.toLowerCase()]: { symbol: 'USDT', decimals: 6 },
    [WETH.toLowerCase()]: { symbol: 'WETH', decimals: 18 },
    [DAI.toLowerCase()]: { symbol: 'DAI', decimals: 18 }
};

const DEADLINE_SECONDS = 20 * 60;
const QUOTE_REFRESH_MS = 30 * 1000;
const IMPACT_WARN = 2;     // %
const IMPACT_BLOCK = 15;   // %
const POL_GAS_RESERVE = ethers.utils.parseEther('0.2');   // kept by MAX when paying with POL
const SWAP_GAS_FALLBACK = 300000;                          // before approval the swap can't be estimated
const SLIPPAGE_KEY = 'swapSlippage';

// ============================================
// State
// ============================================

const state = {
    active: false,
    address: null,
    counter: 'POL',          // the token traded against DATA
    sellData: true,          // true: pay DATA, receive counter; false: the reverse
    slippage: 0.5,
    balances: {},            // symbol -> BigNumber
    pools: new Map(),        // pairKey -> { qv2, sushi, qv3: pool address | null, uni: Map(fee -> pool) } (session cache)
    liquidity: null,         // DATA pools with their balances (Liquidity section)
    poolBalances: new Map(), // pool address -> { [token]: BigNumber, at } (skips empty pools before quoting)
    quote: null,             // { route, amountIn, amountOut, impact, key }
    quoteSeq: 0,
    quoteError: null,
    quoteChecked: null,      // routes tried by the last failed quote
    quoting: false,
    flow: null,
    submitting: false,
    refreshTimer: null,
    listenersSetup: false
};

const $ = (id) => document.getElementById(id);
const debouncedQuote = Utils.debounce(() => updateQuote(), 450);

const payToken = () => TOKENS[state.sellData ? 'DATA' : state.counter];
const receiveToken = () => TOKENS[state.sellData ? state.counter : 'DATA'];
const lower = (a) => a.toLowerCase();
const pairKey = (a, b) => [lower(a), lower(b)].sort().join('-');
const read = (fn) => Services.readWithFallback(() => fn(Services.getReadOnlyProvider()));

// ============================================
// Formatting
// ============================================

function formatAmount(wei, decimals, maxDigits = 4) {
    const value = parseFloat(ethers.utils.formatUnits(wei, decimals));
    if (value === 0) return '0';
    if (value < 0.0001) return '< 0.0001';
    const digits = value >= 1000 ? 2 : maxDigits;
    return Utils.formatBigNumber(String(Number(value.toFixed(digits))));
}

function formatToken(wei, token) {
    return `${formatAmount(wei, token.decimals)} ${token.symbol}`;
}

function parseAmount(value, decimals) {
    const regex = new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
    return regex.test(value) ? ethers.utils.parseUnits(value, decimals) : null;
}

function formatTxError(error) {
    if (error?.code === 4001 || error?.code === 'ACTION_REJECTED') return 'Rejected in your wallet.';
    const text = `${error?.reason || ''} ${error?.error?.message || ''} ${error?.data?.message || ''} ${error?.message || ''}`;
    if (text.toLowerCase().includes('insufficient funds')) return 'Not enough POL to pay for gas.';
    if (/INSUFFICIENT_OUTPUT_AMOUNT|Too little received|Too much requested|price slippage/i.test(text)) return 'The price moved beyond your max slippage. Get a new quote and try again.';
    if (/Transaction too old|EXPIRED/i.test(text)) return 'The swap expired before it was mined. Try again.';
    if (Services.isRateLimitError(error)) return 'RPC rate limited. Please try again in a few seconds.';
    return Utils.getFriendlyErrorMessage(error);
}

// ============================================
// Pools and quotes
// ============================================

/** Read calls in batches through Multicall3; a failed call gives null */
async function multicall(calls, batchSize = 60) {
    const results = [];
    for (let i = 0; i < calls.length; i += batchSize) {
        const batch = calls.slice(i, i + batchSize);
        const encoded = batch.map(c => ({ target: c.target, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args) }));
        const raw = await read(p => new ethers.Contract(MULTICALL3, MULTICALL_ABI, p).callStatic.aggregate3(encoded));
        raw.forEach((r, j) => {
            if (!r.success) { results.push(null); return; }
            try {
                results.push(batch[j].iface.decodeFunctionResult(batch[j].fn, r.returnData));
            } catch (e) {
                results.push(null);
            }
        });
    }
    return results;
}

const IFACES = {
    v2Factory: new ethers.utils.Interface(V2_FACTORY_ABI),
    v2Router: new ethers.utils.Interface(V2_ROUTER_ABI),
    algebraFactory: new ethers.utils.Interface(ALGEBRA_FACTORY_ABI),
    algebraQuoter: new ethers.utils.Interface(ALGEBRA_QUOTER_ABI),
    uniFactory: new ethers.utils.Interface(UNISWAP_FACTORY_ABI),
    uniQuoter: new ethers.utils.Interface(UNISWAP_QUOTER_ABI),
    erc20: new ethers.utils.Interface(ERC20_ABI)
};

const poolAddress = (result) => {
    const address = result?.[0];
    return address && address !== ethers.constants.AddressZero ? address : null;
};

/** Looks up the pools of each pair on every venue (cached; a pair whose lookup failed is asked again next time) */
async function ensurePairs(pairs) {
    const missing = [...new Map(pairs.map(([a, b]) => [pairKey(a, b), [a, b]])).values()].filter(([a, b]) => !state.pools.has(pairKey(a, b)));
    if (!missing.length) return;
    const calls = missing.flatMap(([a, b]) => [
        { target: QUICKSWAP_V2_FACTORY, iface: IFACES.v2Factory, fn: 'getPair', args: [a, b] },
        { target: SUSHI_V2_FACTORY, iface: IFACES.v2Factory, fn: 'getPair', args: [a, b] },
        { target: QUICKSWAP_V3_FACTORY, iface: IFACES.algebraFactory, fn: 'poolByPair', args: [a, b] },
        ...UNISWAP_FEES.map(fee => ({ target: UNISWAP_V3_FACTORY, iface: IFACES.uniFactory, fn: 'getPool', args: [a, b, fee] }))
    ]);
    const results = await multicall(calls);
    const perPair = 3 + UNISWAP_FEES.length;
    missing.forEach(([a, b], i) => {
        const r = results.slice(i * perPair, (i + 1) * perPair);
        if (r.some(x => x === null)) return;   // incomplete answer: not cached
        const uni = new Map();
        UNISWAP_FEES.forEach((fee, j) => { const pool = poolAddress(r[3 + j]); if (pool) uni.set(fee, pool); });
        state.pools.set(pairKey(a, b), { a, b, qv2: poolAddress(r[0]), sushi: poolAddress(r[1]), qv3: poolAddress(r[2]), uni });
    });
}

// Below these balances a pool is treated as empty (quoting an empty Uniswap v3 pool can burn a lot of gas)
const MIN_POOL_BALANCE = {
    [DATA.toLowerCase()]: ethers.utils.parseUnits('1', 18),
    [WPOL.toLowerCase()]: ethers.utils.parseUnits('0.01', 18),
    [USDC.toLowerCase()]: ethers.utils.parseUnits('0.01', 6),
    [USDCE.toLowerCase()]: ethers.utils.parseUnits('0.01', 6),
    [USDT.toLowerCase()]: ethers.utils.parseUnits('0.01', 6),
    [WETH.toLowerCase()]: ethers.utils.parseUnits('0.000005', 18),
    [DAI.toLowerCase()]: ethers.utils.parseUnits('0.01', 18)
};
const POOL_BALANCE_TTL_MS = 5 * 60 * 1000;

/** Token balances of the pools (cached for a few minutes) */
async function ensurePoolBalances(pools) {
    const now = Date.now();
    const missing = [...new Map(pools.map(pool => [lower(pool.address), pool])).values()]
        .filter(pool => !(state.poolBalances.get(lower(pool.address))?.at > now - POOL_BALANCE_TTL_MS));
    if (!missing.length) return;
    const results = await multicall(missing.flatMap(pool => [
        { target: pool.a, iface: IFACES.erc20, fn: 'balanceOf', args: [pool.address] },
        { target: pool.b, iface: IFACES.erc20, fn: 'balanceOf', args: [pool.address] }
    ]));
    missing.forEach((pool, i) => {
        const balanceA = results[i * 2]?.[0];
        const balanceB = results[i * 2 + 1]?.[0];
        if (!balanceA || !balanceB) return;   // unknown: not cached, the pool stays a candidate
        state.poolBalances.set(lower(pool.address), { [lower(pool.a)]: balanceA, [lower(pool.b)]: balanceB, at: now });
    });
}

function hasLiquidity(address, a, b) {
    const balances = state.poolBalances.get(lower(address));
    if (!balances) return true;   // balances unknown: let the quote decide
    return [a, b].every(token => balances[lower(token)]?.gte(MIN_POOL_BALANCE[lower(token)] || 1));
}

/** Candidate routes from tokenIn to tokenOut: direct, or through one intermediate on the same venue (empty pools skipped) */
async function candidateRoutes(tokenIn, tokenOut) {
    const mids = INTERMEDIATES.filter(m => lower(m) !== lower(tokenIn) && lower(m) !== lower(tokenOut));
    const paths = [[tokenIn, tokenOut], ...mids.map(m => [tokenIn, m, tokenOut])];
    await ensurePairs(paths.flatMap(path => path.slice(1).map((token, i) => [path[i], token])));

    const hopsOf = (path) => path.slice(1).map((token, i) => state.pools.get(pairKey(path[i], token)));
    const pools = [];
    for (const path of paths) {
        for (const h of hopsOf(path)) {
            if (!h) continue;
            for (const venue of ['qv2', 'sushi', 'qv3']) if (h[venue]) pools.push({ address: h[venue], a: h.a, b: h.b });
            for (const address of h.uni.values()) pools.push({ address, a: h.a, b: h.b });
        }
    }
    await ensurePoolBalances(pools);

    const routes = [];
    for (const path of paths) {
        const hops = hopsOf(path);
        if (hops.some(h => !h)) continue;
        for (const venue of ['qv2', 'sushi', 'qv3']) {
            if (hops.every(h => h[venue] && hasLiquidity(h[venue], h.a, h.b))) routes.push({ venue, path });
        }
        const feesPerHop = hops.map(h => [...h.uni.entries()].filter(([, address]) => hasLiquidity(address, h.a, h.b)).map(([fee]) => fee));
        if (feesPerHop.every(fees => fees.length)) {
            // Every fee tier combination of the pools with liquidity
            let combos = [[]];
            for (const fees of feesPerHop) combos = combos.flatMap(c => fees.map(fee => [...c, fee]));
            for (const fees of combos) routes.push({ venue: 'uni', path, fees });
        }
    }
    return routes;
}

function encodeAlgebraPath(path) {
    return ethers.utils.solidityPack(path.map(() => 'address'), path);
}

function encodeUniswapPath(path, fees) {
    const types = [];
    const values = [];
    path.forEach((token, i) => {
        types.push('address');
        values.push(token);
        if (i < fees.length) {
            types.push('uint24');
            values.push(fees[i]);
        }
    });
    return ethers.utils.solidityPack(types, values);
}

function quoteCall(route, amountIn) {
    if (route.venue === 'qv2' || route.venue === 'sushi') {
        return { target: VENUES[route.venue].router, iface: IFACES.v2Router, fn: 'getAmountsOut', args: [amountIn, route.path] };
    }
    if (route.venue === 'qv3') {
        return { target: QUICKSWAP_V3_QUOTER, iface: IFACES.algebraQuoter, fn: 'quoteExactInput', args: [encodeAlgebraPath(route.path), amountIn] };
    }
    return { target: UNISWAP_V3_QUOTER, iface: IFACES.uniQuoter, fn: 'quoteExactInput', args: [encodeUniswapPath(route.path, route.fees), amountIn] };
}

function quoteOutput(route, result) {
    if (!result) return null;
    const out = route.venue === 'qv2' || route.venue === 'sushi' ? result.amounts[result.amounts.length - 1] : result.amountOut;
    return out && out.gt(0) ? out : null;
}

/**
 * Quotes each route in its own eth_call (4 at a time): quoters are gas hungry, and inside one
 * Multicall3 batch an expensive quote could starve the next ones of gas
 */
async function quoteRoutes(routes, amountIn, errors = []) {
    const outputs = new Array(routes.length).fill(null);
    let next = 0;
    const worker = async () => {
        while (next < routes.length) {
            const i = next++;
            const call = quoteCall(routes[i], amountIn);
            try {
                const data = await read(p => p.call({ to: call.target, data: call.iface.encodeFunctionData(call.fn, call.args) }));
                outputs[i] = quoteOutput(routes[i], call.iface.decodeFunctionResult(call.fn, data));
                if (!outputs[i]) errors[i] = 'no output';
            } catch (e) {
                outputs[i] = null;
                errors[i] = (e?.reason || e?.error?.message || e?.message || 'failed').toString().slice(0, 120);
                logger.warn(`Swap: quote failed on ${routeLabel(routes[i])}`, e);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(4, routes.length) }, worker));
    return outputs;
}

async function quoteRoute(route, amountIn) {
    const [out] = await quoteRoutes([route], amountIn);
    if (!out) throw new Error('This route can not fill the amount.');
    return out;
}

/** Best route for amountIn, with its price impact */
async function findBestQuote(tokenIn, tokenOut, amountIn) {
    const routes = await candidateRoutes(tokenIn.address, tokenOut.address);
    if (!routes.length) throw new Error(`No ${tokenIn.symbol} / ${tokenOut.symbol} pool found on QuickSwap, SushiSwap or Uniswap.`);
    const errors = [];
    const outputs = await quoteRoutes(routes, amountIn, errors);
    // Every route that was tried, for the "Routes checked" list
    const checked = routes.map((route, i) => ({ route, out: outputs[i], error: errors[i] || null }));
    let best = null;
    outputs.forEach((out, i) => {
        if (out && (!best || out.gt(best.amountOut))) best = { route: routes[i], amountOut: out };
    });
    if (!best) {
        const error = new Error('No pool can fill this amount right now.');
        error.checked = checked;
        throw error;
    }

    // Price impact: this quote against a quote for 1/1000 of the amount on the same route
    let impact = null;
    const small = amountIn.div(1000);
    if (small.gt(0)) {
        try {
            const smallOut = await quoteRoute(best.route, small);
            const ratio = best.amountOut.mul(small).mul(1000000).div(smallOut.mul(amountIn)).toNumber() / 1000000;
            impact = Math.max(0, (1 - ratio) * 100);
        } catch (e) {
            logger.warn('Swap: price impact quote failed', e);
        }
    }
    return { ...best, amountIn, impact, checked };
}

/** Every DATA pool with its token balances (Liquidity section) */
async function loadLiquidity() {
    await ensurePairs(INTERMEDIATES.map(m => [DATA, m]));
    const pools = [];
    for (const m of INTERMEDIATES) {
        const entry = state.pools.get(pairKey(DATA, m));
        if (!entry) continue;
        for (const venue of ['qv2', 'sushi', 'qv3']) if (entry[venue]) pools.push({ venue, partner: m, address: entry[venue] });
        for (const [fee, address] of entry.uni) pools.push({ venue: 'uni', fee, partner: m, address });
    }
    const balances = await multicall(pools.flatMap(pool => [
        { target: DATA, iface: IFACES.erc20, fn: 'balanceOf', args: [pool.address] },
        { target: pool.partner, iface: IFACES.erc20, fn: 'balanceOf', args: [pool.address] }
    ]));
    const now = Date.now();
    pools.forEach((pool, i) => {
        pool.data = balances[i * 2]?.[0] || ethers.constants.Zero;
        pool.other = balances[i * 2 + 1]?.[0] || ethers.constants.Zero;
        if (balances[i * 2] && balances[i * 2 + 1]) {
            state.poolBalances.set(lower(pool.address), { [lower(DATA)]: pool.data, [lower(pool.partner)]: pool.other, at: now });
        }
    });
    pools.sort((x, y) => (y.data.gt(x.data) ? 1 : y.data.lt(x.data) ? -1 : 0));
    state.liquidity = { pools, complete: INTERMEDIATES.every(m => state.pools.has(pairKey(DATA, m))) };
    renderLiquidity();
}

function renderLiquidity() {
    const list = $('swap-liquidity-list');
    const count = $('swap-liquidity-count');
    if (!list || !state.liquidity) return;
    const { pools, complete } = state.liquidity;
    count.textContent = `(${pools.length})`;
    const rows = pools.map(pool => {
        const partner = KNOWN_TOKENS[lower(pool.partner)];
        const venue = `${VENUES[pool.venue].name}${pool.fee ? ` ${pool.fee / 10000}%` : ''}`;
        return `
            <li class="flex items-center justify-between gap-3 py-1.5 border-b border-[#2a2a2a] last:border-0">
                <a href="https://polygonscan.com/address/${Utils.escapeHtml(pool.address)}" target="_blank" rel="noopener noreferrer" class="text-gray-300 hover:text-white">${venue} · DATA / ${partner.symbol}</a>
                <span class="text-right text-gray-400 whitespace-nowrap">${formatAmount(pool.data, 18)} DATA · ${formatAmount(pool.other, partner.decimals)} ${partner.symbol}</span>
            </li>`;
    });
    list.innerHTML = (rows.join('') || '<li class="py-1.5 text-gray-400">No DATA pool found on these DEXes.</li>')
        + (complete ? '' : '<li class="py-1.5 text-yellow-300">Some pools could not be checked (RPC). Refresh to try again.</li>');
}

function routeLabel(route) {
    const symbol = (address) => KNOWN_TOKENS[lower(address)]?.symbol || Utils.shortAddress(address);
    const fees = route.fees ? ` (${route.fees.map(f => `${f / 10000}%`).join(' / ')})` : '';
    return `${VENUES[route.venue].name}${fees} · ${route.path.map(symbol).join(' → ')}`;
}

const minOut = (amountOut) => amountOut.mul(Math.round((100 - state.slippage) * 100)).div(10000);

// ============================================
// Transactions
// ============================================

/** Swap transaction for a quote: { to, data, value } (built with the venue router's ABI) */
function buildSwapTx(quote, recipient) {
    const tokenIn = payToken();
    const tokenOut = receiveToken();
    const { route, amountIn } = quote;
    const minimum = minOut(quote.amountOut);
    const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;
    const value = tokenIn.native ? amountIn : ethers.constants.Zero;

    if (route.venue === 'qv2' || route.venue === 'sushi') {
        const iface = new ethers.utils.Interface(V2_ROUTER_ABI);
        const data = tokenIn.native
            ? iface.encodeFunctionData('swapExactETHForTokens', [minimum, route.path, recipient, deadline])
            : tokenOut.native
                ? iface.encodeFunctionData('swapExactTokensForETH', [amountIn, minimum, route.path, recipient, deadline])
                : iface.encodeFunctionData('swapExactTokensForTokens', [amountIn, minimum, route.path, recipient, deadline]);
        return { to: VENUES[route.venue].router, data, value };
    }
    if (route.venue === 'qv3') {
        const iface = new ethers.utils.Interface(ALGEBRA_ROUTER_ABI);
        const path = encodeAlgebraPath(route.path);
        if (tokenOut.native) {
            // Output kept by the router, then unwrapped to POL for the recipient
            const swap = iface.encodeFunctionData('exactInput', [{ path, recipient: QUICKSWAP_V3_ROUTER, deadline, amountIn, amountOutMinimum: minimum }]);
            const unwrap = iface.encodeFunctionData('unwrapWNativeToken', [minimum, recipient]);
            return { to: QUICKSWAP_V3_ROUTER, data: iface.encodeFunctionData('multicall', [[swap, unwrap]]), value };
        }
        return { to: QUICKSWAP_V3_ROUTER, data: iface.encodeFunctionData('exactInput', [{ path, recipient, deadline, amountIn, amountOutMinimum: minimum }]), value };
    }
    const iface = new ethers.utils.Interface(UNISWAP_ROUTER_ABI);
    const path = encodeUniswapPath(route.path, route.fees);
    const calls = tokenOut.native
        ? [
            iface.encodeFunctionData('exactInput', [{ path, recipient: UNISWAP_ADDRESS_THIS, amountIn, amountOutMinimum: minimum }]),
            iface.encodeFunctionData('unwrapWETH9', [minimum, recipient])
        ]
        : [iface.encodeFunctionData('exactInput', [{ path, recipient, amountIn, amountOutMinimum: minimum }])];
    return { to: UNISWAP_V3_ROUTER, data: iface.encodeFunctionData('multicall(uint256,bytes[])', [deadline, calls]), value };
}

async function allowanceOf(token, spender) {
    return read(p => new ethers.Contract(token.address, ERC20_ABI, p).allowance(state.address, spender));
}

// ============================================
// Rendering
// ============================================

function tokenSlotHtml(symbol, selectable) {
    const token = TOKENS[symbol];
    if (!selectable) {
        return `${token.icon}<span class="text-lg font-semibold text-white">${token.symbol}</span>`;
    }
    const options = COUNTER_TOKENS.map(s => `<option value="${s}" ${s === symbol ? 'selected' : ''}>${Utils.escapeHtml(s)}</option>`).join('');
    return `${token.icon}<select data-token-select aria-label="Token" title="USDC is native USDC; USDC.e is the older bridged USDC" class="w-[6.5rem] bg-[#2C2C2C] hover:bg-[#3C3C3C] text-white text-sm font-semibold rounded-lg pl-2 pr-7 py-1.5 border border-[#444] focus:outline-none focus:ring-2 focus:ring-blue-500/50 disabled:opacity-50">${options}</select>`;
}

function renderTokens() {
    $('swap-from-token').innerHTML = tokenSlotHtml(state.sellData ? 'DATA' : state.counter, !state.sellData);
    $('swap-to-token').innerHTML = tokenSlotHtml(state.sellData ? state.counter : 'DATA', state.sellData);
    if (state.flow) document.querySelectorAll('#swap-view select[data-token-select]').forEach(el => { el.disabled = true; });
    renderBalances();
}

function renderBalances() {
    const pay = payToken();
    const receive = receiveToken();
    const show = (token) => {
        if (!state.address) return '--';
        const balance = state.balances[token.symbol];
        return balance ? formatToken(balance, token) : '...';
    };
    $('swap-from-balance').textContent = show(pay);
    $('swap-to-balance').textContent = show(receive);
}

function renderSlippage() {
    document.querySelectorAll('#swap-slippage button').forEach(btn => {
        const active = Number(btn.dataset.slippage) === state.slippage;
        btn.classList.toggle('bg-blue-800', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('text-gray-400', !active);
    });
}

function readAmount() {
    const token = payToken();
    const raw = $('swap-amount').value.trim();
    const wei = raw ? parseAmount(raw, token.decimals) : null;
    const balance = state.balances[token.symbol];
    let error = null;
    if (raw && !wei) error = 'Enter a valid amount.';
    else if (wei && wei.isZero()) error = 'Enter an amount above 0.';
    else if (wei && balance && wei.gt(balance)) error = `Not enough ${token.symbol}.`;
    return { raw, wei, error };
}

function setWarning(text, tone) {
    const el = $('swap-warning');
    if (!el) return;
    el.classList.remove('hidden', 'bg-yellow-500/10', 'border-yellow-500/30', 'text-yellow-300', 'bg-red-500/10', 'border-red-500/30', 'text-red-400');
    if (!text) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
    }
    el.classList.add(...(tone === 'error' ? ['bg-red-500/10', 'border-red-500/30', 'text-red-400'] : ['bg-yellow-500/10', 'border-yellow-500/30', 'text-yellow-300']));
    el.textContent = text;
}

function renderQuote() {
    const pay = payToken();
    const receive = receiveToken();
    const q = state.quote;
    const { wei, error } = readAmount();
    const valid = q && wei && q.amountIn.eq(wei) && !error;
    $('swap-receive').textContent = state.quoting && !valid ? '...' : valid ? formatAmount(q.amountOut, receive.decimals) : '0';
    $('swap-receive').classList.toggle('text-white', Boolean(valid));
    $('swap-receive').classList.toggle('text-gray-400', !valid);
    if (valid) {
        const rate = parseFloat(ethers.utils.formatUnits(q.amountOut, receive.decimals)) / parseFloat(ethers.utils.formatUnits(q.amountIn, pay.decimals));
        $('swap-rate').textContent = `1 ${pay.symbol} = ${rate < 0.0001 ? rate.toExponential(3) : Number(rate.toPrecision(5))} ${receive.symbol}`;
        $('swap-route').textContent = routeLabel(q.route);
        $('swap-min').textContent = formatToken(minOut(q.amountOut), receive);
        const impactEl = $('swap-impact');
        impactEl.textContent = q.impact === null ? 'n/a' : q.impact < 0.01 ? '< 0.01%' : `${q.impact.toFixed(2)}%`;
        impactEl.classList.toggle('text-red-400', q.impact !== null && q.impact >= IMPACT_BLOCK);
        impactEl.classList.toggle('text-yellow-300', q.impact !== null && q.impact >= IMPACT_WARN && q.impact < IMPACT_BLOCK);
        impactEl.classList.toggle('text-gray-200', q.impact === null || q.impact < IMPACT_WARN);
    } else {
        ['swap-rate', 'swap-route', 'swap-impact', 'swap-min'].forEach(id => { $(id).textContent = '--'; });
    }

    renderCheckedRoutes(valid ? q.checked : state.quoteChecked);

    if (!state.flow) {
        if (error) setWarning('', null);
        else if (state.quoteError && wei) setWarning(state.quoteError, 'error');
        else if (valid && q.impact !== null && q.impact >= IMPACT_BLOCK) setWarning(`Price impact of ${q.impact.toFixed(1)}%: the pools are too small for this amount. Try a smaller amount.`, 'error');
        else if (valid && q.impact !== null && q.impact >= IMPACT_WARN) setWarning(`High price impact (${q.impact.toFixed(1)}%): you get noticeably less than the market price. Consider a smaller amount.`, 'warn');
        else setWarning('', null);
    }
    renderSubmit();
}

function renderCheckedRoutes(checked) {
    const box = $('swap-routes');
    const list = $('swap-routes-list');
    if (!box || !list) return;
    box.classList.toggle('hidden', !checked?.length);
    if (!checked?.length) return;
    const receive = receiveToken();
    $('swap-routes-count').textContent = `(${checked.length})`;
    const sorted = [...checked].sort((x, y) => (x.out && y.out ? (y.out.gt(x.out) ? 1 : -1) : x.out ? -1 : y.out ? 1 : 0));
    list.innerHTML = sorted.map(item => `
        <li class="flex items-start justify-between gap-3 py-1 border-b border-[#2a2a2a] last:border-0">
            <span class="text-gray-300">${Utils.escapeHtml(routeLabel(item.route))}</span>
            <span class="text-right whitespace-nowrap ${item.out ? 'text-gray-200' : 'text-gray-500'}" ${item.error ? `title="${Utils.escapeHtml(item.error)}"` : ''}>${item.out ? formatToken(item.out, receive) : `failed${item.error ? `: ${Utils.escapeHtml(item.error.slice(0, 40))}` : ''}`}</span>
        </li>`).join('');
}

function canSubmit() {
    const { wei, error } = readAmount();
    const q = state.quote;
    return Boolean(state.address && wei && !error && q && q.amountIn.eq(wei) && !state.quoting
        && !(q.impact !== null && q.impact >= IMPACT_BLOCK));
}

function renderSubmit() {
    const btn = $('swap-submit');
    if (!btn || state.submitting) return;
    if (state.flow?.finished) {
        setSubmitState('New swap', false);
        return;
    }
    if (state.flow) return;
    setSubmitState(state.address ? 'Swap' : 'Connect a wallet to swap', false);
    btn.disabled = !canSubmit();
}

function setSubmitState(label, busy) {
    const btn = $('swap-submit');
    if (!btn) return;
    btn.disabled = busy;
    btn.innerHTML = busy
        ? `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent animate-spin"></div><span>${Utils.escapeHtml(label)}</span>`
        : Utils.escapeHtml(label);
}

function setFormLocked(locked) {
    ['swap-amount', 'swap-max', 'swap-flip', 'swap-refresh'].forEach(id => { const el = $(id); if (el) el.disabled = locked; });
    document.querySelectorAll('#swap-view select[data-token-select], #swap-slippage button').forEach(el => { el.disabled = locked; });
}

function renderProgress() {
    const container = $('swap-progress');
    const list = $('swap-progress-list');
    if (!container || !list || !state.flow) return;
    container.classList.remove('hidden');
    const icons = {
        pending: '<span class="w-4 h-4 rounded-full border-2 border-[#555] flex-shrink-0"></span>',
        active: '<span class="w-4 h-4 border-2 border-blue-400 rounded-full border-t-transparent animate-spin flex-shrink-0"></span>',
        done: '<svg class="w-4 h-4 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg>',
        error: '<svg class="w-4 h-4 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"/></svg>'
    };
    const textClass = { pending: 'text-gray-400', active: 'text-white', done: 'text-gray-300', error: 'text-red-400' };
    list.innerHTML = state.flow.steps.map(step => `
        <li class="flex items-center gap-2">
            ${icons[step.status]}
            <span class="${textClass[step.status]}">${Utils.escapeHtml(step.label)}</span>
            ${step.txHash ? `<a href="https://polygonscan.com/tx/${Utils.escapeHtml(step.txHash)}" target="_blank" rel="noopener noreferrer" class="ml-auto text-xs text-blue-400 hover:text-blue-300">tx</a>` : ''}
        </li>
    `).join('');
}

function showError(message) {
    const el = $('swap-error');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
}

function showSuccess(message) {
    const el = $('swap-success');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
}

// ============================================
// Data
// ============================================

async function loadBalances() {
    if (!state.address) return;
    const address = state.address;
    const entries = await Promise.all(Object.values(TOKENS).map(async token => {
        try {
            const balance = token.native
                ? await read(p => p.getBalance(address))
                : await read(p => new ethers.Contract(token.address, ERC20_ABI, p).balanceOf(address));
            return [token.symbol, balance];
        } catch (e) {
            return [token.symbol, null];
        }
    }));
    if (address !== state.address) return;
    state.balances = Object.fromEntries(entries.filter(([, b]) => b));
    renderBalances();
    updateAmountStatus();
    renderSubmit();
}

function updateAmountStatus() {
    const { error } = readAmount();
    const el = $('swap-amount-status');
    el.textContent = error || '';
    el.classList.toggle('hidden', !error);
    el.classList.toggle('text-red-400', Boolean(error));
}

async function updateQuote() {
    const seq = ++state.quoteSeq;
    const { wei, error } = readAmount();
    state.quoteError = null;
    state.quoteChecked = null;
    if (!wei || error) {
        state.quote = null;
        state.quoting = false;
        renderQuote();
        updateCost();
        return;
    }
    state.quoting = true;
    renderQuote();
    try {
        const quote = await findBestQuote(payToken(), receiveToken(), wei);
        if (seq !== state.quoteSeq) return;
        state.quote = quote;
    } catch (e) {
        if (seq !== state.quoteSeq) return;
        logger.warn('Swap quote failed:', e);
        state.quote = null;
        state.quoteChecked = e.checked || null;
        state.quoteError = e.message?.startsWith('No ') ? e.message : `Could not get a quote: ${formatTxError(e)}`;
    }
    state.quoting = false;
    renderQuote();
    updateCost();
}

async function updateCost() {
    const el = $('swap-cost');
    const q = state.quote;
    if (!el) return;
    if (!q || !state.address) {
        el.textContent = '--';
        return;
    }
    try {
        const pay = payToken();
        const venueRouter = VENUES[q.route.venue].router;
        const needsApproval = !pay.native && (await allowanceOf(pay, venueRouter)).lt(q.amountIn);
        const [gasPrice, swapGas, approveGas] = await Promise.all([
            read(p => p.getGasPrice()),
            needsApproval
                ? ethers.BigNumber.from(SWAP_GAS_FALLBACK)
                : read(p => p.estimateGas({ ...buildSwapTx(q, state.address), from: state.address })),
            needsApproval
                ? read(p => new ethers.Contract(pay.address, ERC20_ABI, p).estimateGas.approve(venueRouter, q.amountIn, { from: state.address }))
                : ethers.constants.Zero
        ]);
        if (q !== state.quote) return;
        const cost = swapGas.add(approveGas).mul(gasPrice);
        el.textContent = `≈ ${formatAmount(cost, 18)} POL${needsApproval ? ' (approve + swap)' : ''}`;
    } catch (e) {
        if (q !== state.quote) return;
        logger.warn('Swap cost estimate failed:', e);
        el.textContent = 'n/a';
    }
}

// ============================================
// Swap flow
// ============================================

async function sendPolygonTx(buildTx) {
    return Services.executeWithFallback(async (currentSigner) => {
        const overrides = await Services.getGasOverrides(currentSigner.provider);
        return buildTx(currentSigner, overrides);
    }, window.appSigner);
}

async function runStep(step, flow) {
    const pay = payToken();
    if (step.key === 'approve') {
        const tx = await sendPolygonTx((signer, overrides) => new ethers.Contract(pay.address, ERC20_ABI, signer).approve(flow.router, flow.quote.amountIn, overrides));
        step.txHash = tx.hash;
        renderProgress();
        const receipt = await tx.wait();
        if (receipt.status !== 1) throw new Error('The approval failed on-chain.');
    } else if (step.key === 'swap') {
        // Fresh quote right before sending (the minimum output follows the current price)
        const fresh = await findBestQuote(pay, receiveToken(), flow.quote.amountIn);
        if (fresh.route.venue !== flow.quote.route.venue && !pay.native) {
            // The best venue changed after the approval: stay on the approved router
            const same = await quoteRoute(flow.quote.route, flow.quote.amountIn).catch(() => null);
            if (same) flow.quote = { ...flow.quote, amountOut: same };
        } else {
            flow.quote = fresh;
        }
        if (flow.quote.impact !== null && flow.quote.impact >= IMPACT_BLOCK) throw new Error('The price impact is now too high. Try a smaller amount.');
        const txData = buildSwapTx(flow.quote, state.address);
        const tx = await sendPolygonTx((signer, overrides) => signer.sendTransaction({ ...txData, ...overrides }));
        step.txHash = tx.hash;
        flow.sent = true;
        renderProgress();
        const receipt = await tx.wait();
        if (receipt.status !== 1) throw new Error('The swap failed on-chain.');
    }
}

async function handleSubmit() {
    if (state.submitting || !state.address) return;
    if (state.flow?.finished) {
        resetFlow();
        return;
    }
    if (!state.flow && !canSubmit()) return;
    showError('');
    showSuccess('');

    if (!state.flow) {
        const quote = state.quote;
        const pay = payToken();
        const receive = receiveToken();
        const router = VENUES[quote.route.venue].router;
        let needsApproval = false;
        if (!pay.native) {
            try {
                needsApproval = (await allowanceOf(pay, router)).lt(quote.amountIn);
            } catch (e) {
                needsApproval = true;
            }
        }
        const amount = formatToken(quote.amountIn, pay);
        state.flow = {
            quote,
            router,
            sent: false,
            balanceBefore: state.balances[receive.symbol] || null,
            steps: [
                ...(needsApproval ? [{ key: 'approve', label: `Approve ${amount} for ${VENUES[quote.route.venue].name}` }] : []),
                { key: 'swap', label: `Swap ${amount} for ${receive.symbol}` }
            ].map(step => ({ ...step, status: 'pending', txHash: null }))
        };
    }

    const flow = state.flow;
    state.submitting = true;
    setFormLocked(true);
    renderProgress();
    try {
        if (sessionStorage.getItem('authMethod') !== 'privateKey' && !await Services.checkAndSwitchNetwork()) {
            throw new Error('Switch your wallet to Polygon to continue.');
        }
        for (const step of flow.steps) {
            if (step.status === 'done') continue;
            step.status = 'active';
            renderProgress();
            setSubmitState('Confirm in wallet...', true);
            await runStep(step, flow);
            step.status = 'done';
            renderProgress();
        }
        flow.finished = true;
        state.submitting = false;
        const receive = receiveToken();
        await loadBalances();
        const after = state.balances[receive.symbol];
        const received = after && flow.balanceBefore && !receive.native && after.gt(flow.balanceBefore) ? after.sub(flow.balanceBefore) : null;
        showSuccess(received
            ? `Swapped: you received ${formatToken(received, receive)}.`
            : `Swapped: at least ${formatToken(minOut(flow.quote.amountOut), receive)} are in your wallet.`);
        setSubmitState('New swap', false);
        UI.showToast({ type: 'success', title: 'Swap Complete', message: `${payToken().symbol} → ${receive.symbol}`, duration: 6000 });
    } catch (e) {
        logger.error('Swap failed:', e);
        const failed = flow.steps.find(s => s.status === 'active');
        if (failed) failed.status = 'error';
        renderProgress();
        state.submitting = false;
        showError(formatTxError(e));
        const anyDone = flow.steps.some(s => s.status === 'done');
        if (anyDone && !flow.sent) {
            // Approved but not swapped: Retry continues with the swap
            setSubmitState('Retry', false);
        } else {
            state.flow = null;
            $('swap-progress')?.classList.add('hidden');
            setFormLocked(false);
            renderTokens();
            loadBalances();
            updateQuote();
        }
    }
}

function resetFlow() {
    state.flow = null;
    state.submitting = false;
    state.quote = null;
    $('swap-amount').value = '';
    $('swap-progress')?.classList.add('hidden');
    showError('');
    showSuccess('');
    setFormLocked(false);
    renderTokens();
    renderQuote();
    updateAmountStatus();
    updateCost();
}

// ============================================
// Lifecycle
// ============================================

function scheduleRefresh() {
    clearTimeout(state.refreshTimer);
    if (!state.active) return;
    state.refreshTimer = setTimeout(() => {
        if (!document.hidden && !state.flow && state.quote) updateQuote();
        scheduleRefresh();
    }, QUOTE_REFRESH_MS);
}

function setupListeners() {
    if (state.listenersSetup) return;
    state.listenersSetup = true;
    $('swap-amount')?.addEventListener('input', () => {
        if (state.flow) return;
        showError('');
        updateAmountStatus();
        state.quote = null;
        renderQuote();
        debouncedQuote();
    });
    $('swap-max')?.addEventListener('click', () => {
        const token = payToken();
        let balance = state.balances[token.symbol];
        if (!balance || state.flow) return;
        if (token.native) balance = balance.gt(POL_GAS_RESERVE) ? balance.sub(POL_GAS_RESERVE) : ethers.constants.Zero;
        $('swap-amount').value = ethers.utils.formatUnits(balance, token.decimals).replace(/\.0$/, '');
        updateAmountStatus();
        state.quote = null;
        renderQuote();
        updateQuote();
    });
    $('swap-flip')?.addEventListener('click', () => {
        if (state.flow) return;
        state.sellData = !state.sellData;
        $('swap-amount').value = '';
        state.quote = null;
        showError('');
        renderTokens();
        updateAmountStatus();
        renderQuote();
        updateCost();
    });
    $('swap-view')?.addEventListener('change', (e) => {
        if (!e.target.matches('select[data-token-select]') || state.flow) return;
        state.counter = e.target.value;
        state.quote = null;
        renderTokens();
        updateAmountStatus();
        renderQuote();
        updateQuote();
    });
    $('swap-slippage')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-slippage]');
        if (!btn || state.flow) return;
        state.slippage = Number(btn.dataset.slippage);
        try { localStorage.setItem(SLIPPAGE_KEY, String(state.slippage)); } catch (err) { /* private mode */ }
        renderSlippage();
        renderQuote();
    });
    $('swap-refresh')?.addEventListener('click', () => {
        if (state.flow) return;
        loadBalances();
        updateQuote();
        loadLiquidity().catch(e => logger.warn('Swap: pool discovery failed', e));
    });
    $('swap-submit')?.addEventListener('click', handleSubmit);
    window.addEventListener('app:routechange', (e) => {
        if (!e.detail?.path?.startsWith('/swap')) SwapLogic.stop();
    });
}

export const SwapLogic = {
    async show() {
        setupListeners();
        state.active = true;
        try {
            const saved = Number(localStorage.getItem(SLIPPAGE_KEY));
            if ([0.5, 1, 3].includes(saved)) state.slippage = saved;
        } catch (e) { /* private mode */ }
        let address = null;
        try {
            address = window.appSigner ? (await window.appSigner.getAddress()).toLowerCase() : null;
        } catch (e) {
            address = null;
        }
        if (address !== state.address) {
            state.address = address;
            state.balances = {};
        }
        if (!state.flow) {
            $('swap-progress')?.classList.add('hidden');
            showSuccess('');
            showError('');
        }
        renderTokens();
        renderSlippage();
        renderQuote();
        loadBalances();
        if (readAmount().wei) updateQuote();
        // DATA pools early: the first quote is quicker and the Liquidity section fills in
        if (!state.liquidity?.complete) loadLiquidity().catch(e => logger.warn('Swap: pool discovery failed', e));
        scheduleRefresh();
    },

    stop() {
        state.active = false;
        clearTimeout(state.refreshTimer);
        state.refreshTimer = null;
    }
};
