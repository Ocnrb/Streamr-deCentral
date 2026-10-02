/**
 * Swap: DATA against POL / USDC / USDC.e on Polygon, or ETH / USDC / USDT on Ethereum (Uniswap only there),
 * straight through the DEX contracts (no aggregator API)
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
import { DATA_TOKEN_ADDRESS_POLYGON, DATA_TOKEN_ADDRESS_ETHEREUM, POLYGONSCAN_NETWORK, getEtherscanApiKey } from '../core/constants.js';
import { getEthereumSigner, restorePolygon } from '../core/ethWallet.js';
import { SwapMarket, getEthProvider } from './swapMarket.js';
import { SwapBook } from './swapBook.js';
import { ethers } from 'ethers';

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
// Uniswap v4: one PoolManager holds every pool; pools are found by computing the ids of hookless pools
// with the standard fee / tick spacing pairs and reading their state (extsload). Swaps go through the
// Universal Router (V4_SWAP), which pulls ERC-20 tokens with Permit2.
const UNISWAP_V4_POOL_MANAGER = '0x67366782805870060151383f4bbff9dab53e5cd6';
const UNIVERSAL_ROUTER = '0x1095692a6237d83c6a72f3f5efedb9a670c49223';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const PERMIT2_EXPIRATION_SECONDS = 30 * 60;
// Universal Router command and v4 router actions
const UR_V4_SWAP = '0x10';
const UR_PERMIT2_PERMIT = '0x0a';
const PERMIT_SINGLE = 'tuple(tuple(address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline)';
const V4_SWAP_EXACT_IN_SINGLE = 0x06;
const V4_SWAP_EXACT_IN = 0x07;
const V4_SETTLE = 0x0b;
const V4_SETTLE_ALL = 0x0c;
const V4_TAKE_ALL = 0x0f;
const UNISWAP_V4_QUOTER = '0xb3d5c3dfc3a7aebff71895a7191796bffc2c81b9';
const V4_TIERS = [[100, 1], [500, 10], [3000, 60], [10000, 200]];
const V4_POOLS_SLOT = 6;
const NATIVE = ethers.constants.AddressZero;
const Q96 = ethers.BigNumber.from(2).pow(96);

// ============================================
// Contracts (Ethereum): SushiSwap V2 and Uniswap v4 here; Uniswap v3's factory, quoter and router have the Polygon addresses
// ============================================

const ETH_DATA = DATA_TOKEN_ADDRESS_ETHEREUM;
const ETH_WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const ETH_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ETH_USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const ETH_DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';
const ETH_SUSHI_V2_FACTORY = '0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac';
const ETH_SUSHI_V2_ROUTER = '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f';
const ETH_V4_POOL_MANAGER = '0x000000000004444c5dc75cb358380d2e3de08a90';
const ETH_V4_QUOTER = '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203';
const ETH_UNIVERSAL_ROUTER = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af';
const ETH_USD_FEED = '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419';   // Chainlink ETH/USD

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
const V4_POOL_MANAGER_ABI = ['function extsload(bytes32 slot) view returns (bytes32)'];
const V4_QUOTER_ABI = [
    'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
    'function quoteExactInput((address exactCurrency, (address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)[] path, uint128 exactAmount) params) returns (uint256 amountOut, uint256 gasEstimate)'
];
const PERMIT2_ABI = [
    'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
    'function approve(address token, address spender, uint160 amount, uint48 expiration)'
];
const UNIVERSAL_ROUTER_ABI = ['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'];
const V4_SINGLE_PARAMS = 'tuple(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)';
const V4_MULTI_PARAMS = 'tuple(address currencyIn, tuple(address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)[] path, uint128 amountIn, uint128 amountOutMinimum)';
const MULTICALL_ABI = ['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)'];
// Chainlink POL/USD feed (proxy): rounds are phaseId << 64 | round within the phase
const POL_USD_FEED = '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0';
const FEED_ABI = [
    'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
    'function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
    'function phaseAggregators(uint16 phaseId) view returns (address)',
    'function latestRound() view returns (uint256)'
];
const UNISWAP_ROUTER_ABI = [
    'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
    'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
    'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)'
];

const VENUES = {
    qv2: { name: 'QuickSwap V2', router: QUICKSWAP_V2_ROUTER, factory: QUICKSWAP_V2_FACTORY },
    sushi: { name: 'SushiSwap V2', router: SUSHI_V2_ROUTER, factory: SUSHI_V2_FACTORY },
    qv3: { name: 'QuickSwap V3', router: QUICKSWAP_V3_ROUTER },
    uni: { name: 'Uniswap v3', router: UNISWAP_V3_ROUTER },
    v4: { name: 'Uniswap v4', router: UNIVERSAL_ROUTER }   // tokens pulled through Permit2
};

// ============================================
// Tokens
// ============================================

const DATA_LOGO_PATH = 'M32.9091 10.2118V9.08164C32.9091 8.69418 32.5861 8.38241 32.199 8.4008C24.6009 8.76169 18.5119 14.8843 18.2056 22.4955C18.2219 22.9725 18.608 23.0974 18.8351 23.0974H19.983C20.3463 23.0974 20.6441 22.8122 20.6629 22.4495C20.989 16.1879 26.0134 11.1697 32.278 10.8522C32.7558 10.7908 32.9091 10.5297 32.9091 10.2118ZM22.5761 23.0974H23.6747C24.0313 23.0974 24.3221 22.8195 24.348 22.4638C24.6586 18.2097 28.0701 14.8164 32.3324 14.5336C32.523 14.521 32.9091 14.3783 32.9091 13.8844V12.7659C32.9091 12.3707 32.5739 12.0603 32.1795 12.0861C26.6654 12.4459 22.256 16.8547 21.8961 22.3679C21.8704 22.7623 22.1808 23.0974 22.5761 23.0974ZM37.1763 32.9026C37.4035 32.9026 37.7895 33.0275 37.8058 33.5045C37.4995 41.1158 31.4105 47.2383 23.8124 47.5993C23.4253 47.6176 23.1023 47.3059 23.1023 46.9183V45.7883C23.1023 45.4704 23.2556 45.2093 23.7333 45.1479C29.9981 44.8304 35.0224 39.8121 35.3485 33.5505C35.3673 33.1878 35.6651 32.9026 36.0284 32.9026H37.1763ZM33.4353 32.9026C33.8306 32.9026 34.141 33.2377 34.1153 33.6321C33.7554 39.1454 29.346 43.5542 23.8319 43.914C23.4375 43.9398 23.1023 43.6293 23.1023 43.2341V42.1155C23.1023 41.6217 23.4884 41.4791 23.679 41.4664C27.9413 41.1837 31.3529 37.7903 31.6633 33.5362C31.6893 33.1805 31.9801 32.9026 32.3367 32.9026H33.4353ZM29.7445 32.9026C30.1445 32.9026 30.463 33.246 30.4231 33.6441C30.0758 37.1151 27.3154 39.8751 23.8438 40.2224C23.4458 40.2623 23.1023 39.9438 23.1023 39.5438V38.4201C23.1023 37.9604 23.5015 37.795 23.6961 37.7715C25.9261 37.5025 27.6953 35.7373 27.9703 33.5095C28.0129 33.1647 28.2999 32.9026 28.6474 32.9026H29.7445ZM10.212 23.0945C10.53 23.0945 10.7911 23.2477 10.8525 23.7254C11.1701 29.9892 16.189 35.0129 22.4516 35.3389C22.8143 35.3577 23.0996 35.6555 23.0996 36.0187V37.1666C23.0996 37.3936 22.9746 37.7796 22.4976 37.7959C14.8853 37.4896 8.76181 31.4015 8.4008 23.8045C8.3824 23.4174 8.69423 23.0945 9.0818 23.0945H10.212ZM13.8853 23.0945C14.3792 23.0945 14.5219 23.4805 14.5346 23.6711C14.8173 27.9328 18.2111 31.3439 22.4659 31.6543C22.8216 31.6803 23.0996 31.971 23.0996 32.3276V33.426C23.0996 33.8212 22.7644 34.1316 22.3699 34.1059C16.8559 33.746 12.4464 29.3373 12.0866 23.824C12.0608 23.4296 12.3713 23.0945 12.7666 23.0945H13.8853ZM33.5024 18.1729C41.1148 18.4792 47.2382 24.5673 47.5993 32.1644C47.6176 32.5514 47.3058 32.8744 46.9183 32.8744H45.788C45.4701 32.8744 45.2089 32.7211 45.1475 32.2434C44.8299 25.9795 39.811 20.956 33.5485 20.6299C33.1857 20.6111 32.9005 20.3133 32.9005 19.9501V18.8023C32.9005 18.5752 33.0253 18.1892 33.5024 18.1729ZM33.6301 21.8629C39.1442 22.2227 43.5536 26.6315 43.9135 32.1448C43.9392 32.5392 43.6288 32.8744 43.2335 32.8744H42.1148C41.6208 32.8744 41.4782 32.4883 41.4655 32.2977C41.1828 28.036 37.7889 24.6249 33.5342 24.3145C33.1784 24.2886 32.9005 23.9978 32.9005 23.6412V22.5428C32.9005 22.1476 33.2357 21.8372 33.6301 21.8629ZM33.642 25.5545C37.1136 25.9019 39.874 28.6619 40.2213 32.1329C40.2612 32.5309 39.9427 32.8744 39.5427 32.8744H38.4188C37.959 32.8744 37.7936 32.4752 37.7701 32.2806C37.501 30.0509 35.7356 28.282 33.5075 28.0071C33.1626 27.9645 32.9005 27.6775 32.9005 27.33V26.2331C32.9005 25.8331 33.244 25.5147 33.642 25.5545ZM17.5812 23.0945C18.0411 23.0945 18.2064 23.4936 18.2299 23.6882C18.4991 25.9179 20.2644 27.6868 22.4926 27.9618C22.8374 28.0043 23.0996 28.2913 23.0996 28.6388V29.7357C23.0996 30.1357 22.7561 30.4541 22.358 30.4144C18.8865 30.0669 16.1261 27.3069 15.7786 23.8359C15.7388 23.4379 16.0573 23.0945 16.4574 23.0945H17.5812ZM32.9091 16.4562V17.5798C32.9091 18.0396 32.51 18.205 32.3152 18.2285C30.0853 18.4976 28.3161 20.2627 28.0411 22.4905C27.9985 22.8353 27.7115 23.0974 27.364 23.0974H26.2669C25.8669 23.0974 25.5484 22.7539 25.5882 22.3559C25.9357 18.885 28.6961 16.125 32.1675 15.7776C32.5656 15.7378 32.9091 16.0562 32.9091 16.4562Z';

const ICONS = {
    DATA: `<svg class="w-7 h-7 flex-shrink-0" viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="28" fill="#F7600A"/><path fill-rule="evenodd" clip-rule="evenodd" d="${DATA_LOGO_PATH}" fill="white"/></svg>`,
    POL: '<svg class="w-7 h-7 flex-shrink-0" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#8247E5"/><path fill="#fff" d="M21.1 13.1a1.3 1.3 0 0 0-1.3 0l-2.9 1.7-2 1.1-2.9 1.7a1.3 1.3 0 0 1-1.3 0l-2.3-1.3a1.3 1.3 0 0 1-.6-1.1v-2.6c0-.4.2-.9.6-1.1l2.2-1.3a1.3 1.3 0 0 1 1.3 0l2.2 1.3c.4.2.6.7.6 1.1v1.7l2-1.2v-1.7c0-.4-.2-.9-.6-1.1l-4.2-2.4a1.3 1.3 0 0 0-1.3 0l-4.3 2.5c-.4.2-.6.6-.6 1v4.9c0 .4.2.9.6 1.1l4.3 2.4c.4.2.9.2 1.3 0l2.9-1.6 2-1.2 2.9-1.6a1.3 1.3 0 0 1 1.3 0l2.2 1.3c.4.2.6.7.6 1.1v2.6c0 .4-.2.9-.6 1.1l-2.2 1.3a1.3 1.3 0 0 1-1.3 0l-2.2-1.3a1.3 1.3 0 0 1-.6-1.1v-1.7l-2 1.2v1.7c0 .4.2.9.6 1.1l4.3 2.4c.4.2.9.2 1.3 0l4.3-2.4c.4-.2.6-.7.6-1.1v-4.9c0-.4-.2-.9-.6-1.1z"/></svg>',
    ETH: '<svg class="w-7 h-7 flex-shrink-0" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#627EEA"/><path fill="#fff" fill-opacity=".6" d="M16.5 4v8.87l7.5 3.35z"/><path fill="#fff" d="M16.5 4 9 16.22l7.5-3.35z"/><path fill="#fff" fill-opacity=".6" d="M16.5 21.97v6.03L24 17.62z"/><path fill="#fff" d="M16.5 28v-6.03L9 17.62z"/><path fill="#fff" fill-opacity=".2" d="m16.5 20.57 7.5-4.35-7.5-3.35z"/><path fill="#fff" fill-opacity=".6" d="m9 16.22 7.5 4.35v-7.7z"/></svg>',
    USDC: '<svg class="w-7 h-7 flex-shrink-0" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#2775CA"/><path fill="#fff" d="M20.2 18.1c0-2.2-1.3-3-4-3.3-1.9-.3-2.3-.8-2.3-1.7s.7-1.4 1.9-1.4c1.1 0 1.8.4 2.1 1.3.1.2.3.3.4.3h1c.3 0 .5-.2.5-.5v-.1a3.2 3.2 0 0 0-2.8-2.6V8.9c0-.3-.2-.5-.6-.5h-.9c-.3 0-.5.2-.6.5v1.2c-1.9.3-3.1 1.5-3.1 3.1 0 2.1 1.3 2.9 4 3.2 1.8.3 2.3.7 2.3 1.7s-.9 1.7-2.1 1.7c-1.6 0-2.2-.7-2.4-1.6-.1-.2-.3-.4-.5-.4h-1c-.3 0-.5.2-.5.5v.1c.3 1.6 1.3 2.7 3.3 3v1.2c0 .3.2.5.6.5h.9c.3 0 .5-.2.6-.5v-1.2c1.9-.3 3.2-1.6 3.2-3.3z"/><path fill="#fff" d="M12.8 24.6a9 9 0 0 1 0-17.2c.3-.1.5-.4.5-.7V5.8c0-.3-.2-.5-.4-.5h-.2a10.9 10.9 0 0 0 0 21.4c.3.1.5 0 .6-.3v-1.1c0-.3-.2-.6-.5-.7zm6.6-19.3c-.3-.1-.5 0-.6.3v.9c0 .3.2.6.5.7a9 9 0 0 1 0 17.2c-.3.1-.5.4-.5.7v.9c0 .3.2.5.4.5h.2a10.9 10.9 0 0 0 0-21.4z"/></svg>'
};

ICONS.USDT = '<svg class="w-7 h-7 flex-shrink-0" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#26A17B"/><path fill="#fff" d="M9 9h14v3.2h-5.4v3c3.3.2 5.8.9 5.8 1.7s-2.5 1.5-5.8 1.7V24h-3.2v-5.4c-3.3-.2-5.8-.9-5.8-1.7s2.5-1.5 5.8-1.7v-3H9V9zm5.4 7.1v1.2c.5 0 1 .1 1.6.1s1.1 0 1.6-.1v-1.2c-.5 0-1-.1-1.6-.1s-1.1 0-1.6.1z"/></svg>';

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
    [DAI.toLowerCase()]: { symbol: 'DAI', decimals: 18 },
    [NATIVE]: { symbol: 'POL', decimals: 18 }
};

const ETH_TOKENS = {
    DATA: { symbol: 'DATA', address: ETH_DATA, decimals: 18, icon: ICONS.DATA },
    ETH: { symbol: 'ETH', address: ETH_WETH, decimals: 18, native: true, icon: ICONS.ETH },
    USDC: { symbol: 'USDC', address: ETH_USDC, decimals: 6, icon: ICONS.USDC },
    USDT: { symbol: 'USDT', address: ETH_USDT, decimals: 6, icon: ICONS.USDT }
};
const ETH_KNOWN_TOKENS = {
    [ETH_DATA.toLowerCase()]: { symbol: 'DATA', decimals: 18 },
    [ETH_WETH]: { symbol: 'WETH', decimals: 18 },
    [ETH_USDC]: { symbol: 'USDC', decimals: 6 },
    [ETH_USDT]: { symbol: 'USDT', decimals: 6 },
    [ETH_DAI]: { symbol: 'DAI', decimals: 18 },
    [NATIVE]: { symbol: 'ETH', decimals: 18 }
};

const DEADLINE_SECONDS = 20 * 60;
const QUOTE_REFRESH_MS = 30 * 1000;
const HISTORY_REFRESH_TICKS = 4;    // the wallet's swaps every 4 refreshes (2 min): explorer calls are rate limited
const IMPACT_WARN = 2;     // %
const IMPACT_BLOCK = 15;   // %
const POL_GAS_RESERVE = ethers.utils.parseEther('0.2');   // kept by MAX when paying with POL
const SWAP_GAS_FALLBACK = 300000;                          // before approval the swap can't be estimated
const SLIPPAGE_KEY = 'swapSlippage';
const CHAIN_KEY = 'swapChain';

// The chains the swap runs on: their tokens, DEXes (Polygon: QuickSwap, SushiSwap, Uniswap; Ethereum: SushiSwap V2,
// Uniswap v3 and v4), their contracts and the session caches of their pools
const NETWORKS = {
    137: {
        id: 137, name: 'Polygon', native: 'POL', wrapped: WPOL, tokens: TOKENS, counters: COUNTER_TOKENS, intermediates: INTERMEDIATES, known: KNOWN_TOKENS,
        v4: { manager: UNISWAP_V4_POOL_MANAGER, quoter: UNISWAP_V4_QUOTER, router: UNIVERSAL_ROUTER }, v2v3Venues: ['qv2', 'sushi', 'qv3'],
        factories: { qv2: QUICKSWAP_V2_FACTORY, sushi: SUSHI_V2_FACTORY },
        routers: { qv2: QUICKSWAP_V2_ROUTER, sushi: SUSHI_V2_ROUTER, qv3: QUICKSWAP_V3_ROUTER, uni: UNISWAP_V3_ROUTER, v4: UNIVERSAL_ROUTER },
        gasReserve: POL_GAS_RESERVE, explorer: 'https://polygonscan.com', dexes: 'QuickSwap, SushiSwap or Uniswap', dexList: 'QuickSwap, SushiSwap and Uniswap'
    },
    1: {
        id: 1, name: 'Ethereum', native: 'ETH', wrapped: ETH_WETH, tokens: ETH_TOKENS, counters: ['ETH', 'USDC', 'USDT'], intermediates: [ETH_WETH, ETH_USDC, ETH_USDT, ETH_DAI], known: ETH_KNOWN_TOKENS,
        v4: { manager: ETH_V4_POOL_MANAGER, quoter: ETH_V4_QUOTER, router: ETH_UNIVERSAL_ROUTER }, v2v3Venues: ['sushi'],
        factories: { sushi: ETH_SUSHI_V2_FACTORY },
        routers: { sushi: ETH_SUSHI_V2_ROUTER, uni: UNISWAP_V3_ROUTER, v4: ETH_UNIVERSAL_ROUTER },
        gasReserve: ethers.utils.parseEther('0.005'), explorer: 'https://etherscan.io', dexes: 'SushiSwap or Uniswap', dexList: 'SushiSwap and Uniswap'
    }
};
for (const net of Object.values(NETWORKS)) net.cache = { pools: new Map(), v4Pairs: new Map(), poolBalances: new Map() };
const POLYGON = NETWORKS[137];

// ============================================
// State
// ============================================

const state = {
    active: false,
    address: null,
    chain: 137,              // the chain of the swap (137 Polygon, 1 Ethereum)
    counter: 'USDC',         // the token traded against DATA
    sellData: false,         // true: pay DATA, receive counter; false: the reverse (default: pay USDC, buy DATA)
    slippage: 0.5,
    balances: {},            // symbol -> BigNumber
    liquidity: null,         // Polygon's DATA pools with their balances (DATA pools list, the market's pools)
    ethLiquidity: null,      // Ethereum's
    quote: null,             // { route, amountIn, amountOut, impact, key }
    quoteSeq: 0,
    quoteError: null,
    quoteChecked: null,      // routes tried by the last failed quote
    quoting: false,
    flow: null,
    submitting: false,
    refreshTimer: null,
    history: [],             // swaps of this wallet (localStorage + explorer)
    listenersSetup: false
};

const $ = (id) => document.getElementById(id);
const debouncedQuote = Utils.debounce(() => updateQuote(), 450);

const NET = () => NETWORKS[state.chain];
const payToken = () => NET().tokens[state.sellData ? 'DATA' : state.counter];
const receiveToken = () => NET().tokens[state.sellData ? state.counter : 'DATA'];
const lower = (a) => a.toLowerCase();
const pairKey = (a, b) => [lower(a), lower(b)].sort().join('-');
/** Reads on a chain: Polygon through the app's RPCs (with fallback), Ethereum through the market's providers */
const readOn = (net) => (fn) => (net.id === 137 ? Services.readWithFallback(() => fn(Services.getReadOnlyProvider())) : fn(getEthProvider()));
const read = readOn(POLYGON);

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
    if (text.toLowerCase().includes('insufficient funds')) return `Not enough ${NET().native} to pay for gas.`;
    if (/INSUFFICIENT_OUTPUT_AMOUNT|Too little received|Too much requested|price slippage/i.test(text)) return 'The price moved beyond your max slippage. Get a new quote and try again.';
    if (/Transaction too old|EXPIRED/i.test(text)) return 'The swap expired before it was mined. Try again.';
    if (Services.isRateLimitError(error)) return 'RPC rate limited. Please try again in a few seconds.';
    return Utils.getFriendlyErrorMessage(error);
}

// ============================================
// Pools and quotes
// ============================================

/** Read calls on a chain (Polygon unless told) in batches through Multicall3; a failed call gives null */
async function multicall(calls, batchSize = 60, net = POLYGON) {
    const results = [];
    for (let i = 0; i < calls.length; i += batchSize) {
        const batch = calls.slice(i, i + batchSize);
        const encoded = batch.map(c => ({ target: c.target, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args) }));
        const raw = await readOn(net)(p => new ethers.Contract(MULTICALL3, MULTICALL_ABI, p).callStatic.aggregate3(encoded));
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
    v4Manager: new ethers.utils.Interface(V4_POOL_MANAGER_ABI),
    v4Quoter: new ethers.utils.Interface(V4_QUOTER_ABI),
    erc20: new ethers.utils.Interface(ERC20_ABI),
    feed: new ethers.utils.Interface(FEED_ABI)
};

const poolAddress = (result) => {
    const address = result?.[0];
    return address && address !== ethers.constants.AddressZero ? address : null;
};

/** Looks up the pools of each pair on every venue of the chain (cached; a pair whose lookup failed is asked again next time) */
async function ensurePairs(pairs, net = POLYGON) {
    const cache = net.cache.pools;
    const missing = [...new Map(pairs.map(([a, b]) => [pairKey(a, b), [a, b]])).values()].filter(([a, b]) => !cache.has(pairKey(a, b)));
    if (!missing.length) return;
    // The chain's v2 / Algebra venues (their factories), then Uniswap v3 (the same factory address on both chains)
    const others = net.v2v3Venues.length;
    const venueCall = (venue, a, b) => (venue === 'qv3'
        ? { target: QUICKSWAP_V3_FACTORY, iface: IFACES.algebraFactory, fn: 'poolByPair', args: [a, b] }
        : { target: net.factories[venue], iface: IFACES.v2Factory, fn: 'getPair', args: [a, b] });
    const calls = missing.flatMap(([a, b]) => [
        ...net.v2v3Venues.map(venue => venueCall(venue, a, b)),
        ...UNISWAP_FEES.map(fee => ({ target: UNISWAP_V3_FACTORY, iface: IFACES.uniFactory, fn: 'getPool', args: [a, b, fee] }))
    ]);
    const results = await multicall(calls, 60, net);
    const perPair = others + UNISWAP_FEES.length;
    missing.forEach(([a, b], i) => {
        const r = results.slice(i * perPair, (i + 1) * perPair);
        if (r.some(x => x === null)) return;   // incomplete answer: not cached
        const uni = new Map();
        UNISWAP_FEES.forEach((fee, j) => { const pool = poolAddress(r[others + j]); if (pool) uni.set(fee, pool); });
        const entry = { a, b, qv2: null, sushi: null, qv3: null, uni };
        net.v2v3Venues.forEach((venue, k) => { entry[venue] = poolAddress(r[k]); });
        cache.set(pairKey(a, b), entry);
    });
}

// Below these balances a pool is treated as empty (quoting an empty Uniswap v3 pool can burn a lot of gas)
const MIN_POOL_BALANCE = {
    [DATA.toLowerCase()]: ethers.utils.parseUnits('1', 18),
    [ETH_DATA.toLowerCase()]: ethers.utils.parseUnits('1', 18),
    [ETH_WETH]: ethers.utils.parseUnits('0.000005', 18),
    [ETH_USDC]: ethers.utils.parseUnits('0.01', 6),
    [ETH_USDT]: ethers.utils.parseUnits('0.01', 6),
    [ETH_DAI]: ethers.utils.parseUnits('0.01', 18),
    [WPOL.toLowerCase()]: ethers.utils.parseUnits('0.01', 18),
    [USDC.toLowerCase()]: ethers.utils.parseUnits('0.01', 6),
    [USDCE.toLowerCase()]: ethers.utils.parseUnits('0.01', 6),
    [USDT.toLowerCase()]: ethers.utils.parseUnits('0.01', 6),
    [WETH.toLowerCase()]: ethers.utils.parseUnits('0.000005', 18),
    [DAI.toLowerCase()]: ethers.utils.parseUnits('0.01', 18)
};
const POOL_BALANCE_TTL_MS = 5 * 60 * 1000;

/** Token balances of the pools (cached for a few minutes) */
async function ensurePoolBalances(pools, net = POLYGON) {
    const now = Date.now();
    const missing = [...new Map(pools.map(pool => [lower(pool.address), pool])).values()]
        .filter(pool => !(net.cache.poolBalances.get(lower(pool.address))?.at > now - POOL_BALANCE_TTL_MS));
    if (!missing.length) return;
    const results = await multicall(missing.flatMap(pool => [
        { target: pool.a, iface: IFACES.erc20, fn: 'balanceOf', args: [pool.address] },
        { target: pool.b, iface: IFACES.erc20, fn: 'balanceOf', args: [pool.address] }
    ]), 60, net);
    missing.forEach((pool, i) => {
        const balanceA = results[i * 2]?.[0];
        const balanceB = results[i * 2 + 1]?.[0];
        if (!balanceA || !balanceB) return;   // unknown: not cached, the pool stays a candidate
        net.cache.poolBalances.set(lower(pool.address), { [lower(pool.a)]: balanceA, [lower(pool.b)]: balanceB, at: now });
    });
}

function hasLiquidity(address, a, b, net = POLYGON) {
    const balances = net.cache.poolBalances.get(lower(address));
    if (!balances) return true;   // balances unknown: let the quote decide
    return [a, b].every(token => balances[lower(token)]?.gte(MIN_POOL_BALANCE[lower(token)] || 1));
}

// ---------- Uniswap v4 (read-only) ----------

function v4PoolKey(a, b, fee, tickSpacing) {
    const [currency0, currency1] = lower(a) < lower(b) ? [a, b] : [b, a];
    return { currency0, currency1, fee, tickSpacing, hooks: NATIVE };
}

function v4PoolId(key) {
    return ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(
        ['address', 'address', 'uint24', 'int24', 'address'],
        [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    ));
}

/** Looks up the hookless v4 pools of each pair (every standard tier); a pair whose lookup failed is asked again next time */
async function ensureV4Pairs(pairs, net = POLYGON) {
    const cache = net.cache.v4Pairs;
    const missing = [...new Map(pairs.map(([a, b]) => [pairKey(a, b), [a, b]])).values()].filter(([a, b]) => !cache.has(pairKey(a, b)));
    if (!missing.length) return;
    const candidates = [];
    for (const [a, b] of missing) {
        for (const [fee, tickSpacing] of V4_TIERS) {
            const key = v4PoolKey(a, b, fee, tickSpacing);
            const id = v4PoolId(key);
            const stateSlot = ethers.utils.keccak256(ethers.utils.solidityPack(['bytes32', 'bytes32'], [id, ethers.utils.hexZeroPad(ethers.utils.hexlify(V4_POOLS_SLOT), 32)]));
            const liquiditySlot = ethers.utils.hexZeroPad(ethers.BigNumber.from(stateSlot).add(3).toHexString(), 32);
            candidates.push({ pair: pairKey(a, b), fee, tickSpacing, key, id, stateSlot, liquiditySlot });
        }
    }
    const results = await multicall(candidates.flatMap(c => [
        { target: net.v4.manager, iface: IFACES.v4Manager, fn: 'extsload', args: [c.stateSlot] },
        { target: net.v4.manager, iface: IFACES.v4Manager, fn: 'extsload', args: [c.liquiditySlot] }
    ]), 60, net);
    const mask160 = ethers.BigNumber.from(2).pow(160).sub(1);
    const mask128 = ethers.BigNumber.from(2).pow(128).sub(1);
    const byPair = new Map();
    let failed = new Set();
    candidates.forEach((c, i) => {
        const slot0 = results[i * 2];
        const liquidity = results[i * 2 + 1];
        if (!slot0 || !liquidity) { failed.add(c.pair); return; }
        const pool = { ...c, sqrtPriceX96: ethers.BigNumber.from(slot0[0]).and(mask160), liquidity: ethers.BigNumber.from(liquidity[0]).and(mask128) };
        if (!byPair.has(c.pair)) byPair.set(c.pair, []);
        if (!pool.sqrtPriceX96.isZero() && !pool.liquidity.isZero()) byPair.get(c.pair).push(pool);
    });
    for (const [a, b] of missing) {
        const key = pairKey(a, b);
        if (!failed.has(key)) cache.set(key, byPair.get(key) || []);
    }
}

const v4PoolsFor = (a, b, net = POLYGON) => net.cache.v4Pairs.get(pairKey(a, b)) || [];

/** A chain's DATA pools on v4 (DATA pools list) */
async function discoverV4Pools(net = POLYGON) {
    const data = net.tokens.DATA.address;
    const counters = [NATIVE, ...net.intermediates];
    await ensureV4Pairs(counters.map(c => [data, c]), net);
    if (!counters.every(c => net.cache.v4Pairs.has(pairKey(data, c)))) throw new Error('Uniswap v4 lookup incomplete');
    return counters.flatMap(counter => v4PoolsFor(data, counter, net).map(pool => ({ ...pool, counter })));
}

/** Amount out within the current price range (no tick crossing): fallback when the v4 quoter is not reachable */
function v4LocalEstimate(pool, zeroForOne, amountIn) {
    const L = pool.liquidity;
    const sp = pool.sqrtPriceX96;
    const net = amountIn.mul(1000000 - pool.fee).div(1000000);
    if (zeroForOne) {
        const next = L.mul(Q96).mul(sp).div(L.mul(Q96).add(net.mul(sp)));
        return L.mul(sp.sub(next)).div(Q96);
    }
    const next = sp.add(net.mul(Q96).div(L));
    return L.mul(Q96).mul(next.sub(sp)).div(next.mul(sp));
}

/** 1 DATA in the other token, from the pool's sqrt price */
function v4DataPrice(pool, net = POLYGON) {
    const counterInfo = net.known[lower(pool.counter)];
    const ratio = Math.pow(parseFloat(pool.sqrtPriceX96.toString()) / Math.pow(2, 96), 2);   // currency1 per currency0 (raw units)
    const dataIsZero = lower(pool.key.currency0) === lower(net.tokens.DATA.address);
    const raw = dataIsZero ? ratio : 1 / ratio;
    return raw * Math.pow(10, 18 - counterInfo.decimals);
}

const v4Currency = (token) => (token.native ? NATIVE : token.address);

/** v4 routes: one pool, or two pools through an intermediate currency (POL / ETH is the native currency on v4) */
async function v4Routes(tokenIn, tokenOut, net = POLYGON) {
    const cin = v4Currency(tokenIn);
    const cout = v4Currency(tokenOut);
    const mids = [NATIVE, ...net.intermediates].filter(m => lower(m) !== lower(cin) && lower(m) !== lower(cout));
    try {
        await ensureV4Pairs([[cin, cout], ...mids.flatMap(m => [[cin, m], [m, cout]])], net);
    } catch (e) {
        logger.warn('Swap: Uniswap v4 lookup failed', e);
        return [];
    }
    const route = (currencies, pools) => ({ venue: 'v4', chain: net.id, currencies, pools, path: currencies.map(c => (c === NATIVE ? net.wrapped : c)) });
    const routes = v4PoolsFor(cin, cout, net).map(pool => route([cin, cout], [pool]));
    for (const m of mids) {
        for (const first of v4PoolsFor(cin, m, net)) {
            for (const second of v4PoolsFor(m, cout, net)) routes.push(route([cin, m, cout], [first, second]));
        }
    }
    return routes;
}

/** Candidate routes from tokenIn to tokenOut: direct, or through one intermediate on the same venue (empty pools skipped) */
async function candidateRoutes(tokenIn, tokenOut, net = POLYGON) {
    const mids = net.intermediates.filter(m => lower(m) !== lower(tokenIn) && lower(m) !== lower(tokenOut));
    const paths = [[tokenIn, tokenOut], ...mids.map(m => [tokenIn, m, tokenOut])];
    await ensurePairs(paths.flatMap(path => path.slice(1).map((token, i) => [path[i], token])), net);

    const hopsOf = (path) => path.slice(1).map((token, i) => net.cache.pools.get(pairKey(path[i], token)));
    const pools = [];
    for (const path of paths) {
        for (const h of hopsOf(path)) {
            if (!h) continue;
            for (const venue of net.v2v3Venues) if (h[venue]) pools.push({ address: h[venue], a: h.a, b: h.b });
            for (const address of h.uni.values()) pools.push({ address, a: h.a, b: h.b });
        }
    }
    await ensurePoolBalances(pools, net);

    const routes = [];
    for (const path of paths) {
        const hops = hopsOf(path);
        if (hops.some(h => !h)) continue;
        for (const venue of net.v2v3Venues) {
            if (hops.every(h => h[venue] && hasLiquidity(h[venue], h.a, h.b, net))) routes.push({ venue, chain: net.id, path });
        }
        const feesPerHop = hops.map(h => [...h.uni.entries()].filter(([, address]) => hasLiquidity(address, h.a, h.b, net)).map(([fee]) => fee));
        if (feesPerHop.every(fees => fees.length)) {
            // Every fee tier combination of the pools with liquidity
            let combos = [[]];
            for (const fees of feesPerHop) combos = combos.flatMap(c => fees.map(fee => [...c, fee]));
            for (const fees of combos) routes.push({ venue: 'uni', chain: net.id, path, fees });
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

const v4ZeroForOne = (currencyIn, pool) => lower(currencyIn) === lower(pool.key.currency0);

const v4PathKeys = (route) => route.pools.map((pool, i) => ({
    intermediateCurrency: route.currencies[i + 1], fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: NATIVE, hookData: '0x'
}));

/** Estimate hop by hop within each pool's current price range (when the v4 quoter is not reachable) */
function v4RouteEstimate(route, amountIn) {
    let amount = amountIn;
    route.pools.forEach((pool, i) => { amount = v4LocalEstimate(pool, v4ZeroForOne(route.currencies[i], pool), amount); });
    return amount;
}

function quoteCall(route, amountIn) {
    if (route.venue === 'v4') {
        if (route.pools.length === 1) {
            const pool = route.pools[0];
            return { target: NETWORKS[route.chain].v4.quoter, iface: IFACES.v4Quoter, fn: 'quoteExactInputSingle', args: [{ poolKey: pool.key, zeroForOne: v4ZeroForOne(route.currencies[0], pool), exactAmount: amountIn, hookData: '0x' }] };
        }
        return { target: NETWORKS[route.chain].v4.quoter, iface: IFACES.v4Quoter, fn: 'quoteExactInput', args: [{ exactCurrency: route.currencies[0], path: v4PathKeys(route), exactAmount: amountIn }] };
    }
    if (route.venue === 'qv2' || route.venue === 'sushi') {
        return { target: NETWORKS[route.chain].routers[route.venue], iface: IFACES.v2Router, fn: 'getAmountsOut', args: [amountIn, route.path] };
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
                const data = await readOn(NETWORKS[routes[i].chain])(p => p.call({ to: call.target, data: call.iface.encodeFunctionData(call.fn, call.args) }));
                outputs[i] = quoteOutput(routes[i], call.iface.decodeFunctionResult(call.fn, data));
                if (!outputs[i]) errors[i] = 'no output';
            } catch (e) {
                outputs[i] = null;
                errors[i] = (e?.reason || e?.error?.message || e?.message || 'failed').toString().slice(0, 120);
                logger.warn(`Swap: quote failed on ${routeLabel(routes[i])}`, e);
                if (routes[i].venue === 'v4') {
                    // Quoter not reachable: estimate within the current price range
                    try {
                        const estimate = v4RouteEstimate(routes[i], amountIn);
                        if (estimate.gt(0)) {
                            outputs[i] = estimate;
                            errors[i] = `estimate (quoter: ${errors[i].slice(0, 60)})`;
                        }
                    } catch (err) { /* keep the failure */ }
                }
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

/** Best route for amountIn on a chain, with its price impact */
async function findBestQuote(tokenIn, tokenOut, amountIn, net = POLYGON) {
    const routes = [...await candidateRoutes(tokenIn.address, tokenOut.address, net), ...await v4Routes(tokenIn, tokenOut, net)];
    if (!routes.length) throw new Error(`No ${tokenIn.symbol} / ${tokenOut.symbol} pool found on ${net.dexes}.`);
    const errors = [];
    const outputs = await quoteRoutes(routes, amountIn, errors);
    // Every route that was tried, for the "Routes checked" list
    const checked = routes.map((route, i) => ({ route, out: outputs[i], error: errors[i] || null }));
    let best = null;
    outputs.forEach((out, i) => {
        if (out && routes[i].executable !== false && (!best || out.gt(best.amountOut))) best = { route: routes[i], amountOut: out };
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

const liquidityOf = (net) => (net.id === 137 ? state.liquidity : state.ethLiquidity);

/** A chain's DATA pools with their token balances (DATA pools list; Polygon's also feed the market's trades) */
async function loadLiquidity(net = POLYGON) {
    const data = net.tokens.DATA.address;
    await ensurePairs(net.intermediates.map(m => [data, m]), net);
    const pools = [];
    for (const m of net.intermediates) {
        const entry = net.cache.pools.get(pairKey(data, m));
        if (!entry) continue;
        for (const venue of net.v2v3Venues) if (entry[venue]) pools.push({ venue, partner: m, address: entry[venue] });
        for (const [fee, address] of entry.uni) pools.push({ venue: 'uni', fee, partner: m, address });
    }
    const balances = await multicall(pools.flatMap(pool => [
        { target: data, iface: IFACES.erc20, fn: 'balanceOf', args: [pool.address] },
        { target: pool.partner, iface: IFACES.erc20, fn: 'balanceOf', args: [pool.address] }
    ]), 60, net);
    const now = Date.now();
    pools.forEach((pool, i) => {
        pool.data = balances[i * 2]?.[0] || ethers.constants.Zero;
        pool.other = balances[i * 2 + 1]?.[0] || ethers.constants.Zero;
        if (balances[i * 2] && balances[i * 2 + 1]) {
            net.cache.poolBalances.set(lower(pool.address), { [lower(data)]: pool.data, [lower(pool.partner)]: pool.other, at: now });
        }
    });
    pools.sort((x, y) => (y.data.gt(x.data) ? 1 : y.data.lt(x.data) ? -1 : 0));
    let v4 = [];
    let v4Complete = true;
    net.cache.v4Pairs.clear();   // fresh v4 prices
    try {
        v4 = await discoverV4Pools(net);
    } catch (e) {
        v4Complete = false;
        logger.warn('Swap: Uniswap v4 lookup failed', e);
    }
    const liquidity = { pools, v4, complete: v4Complete && net.intermediates.every(m => net.cache.pools.has(pairKey(data, m))) };
    if (net.id === 137) state.liquidity = liquidity;
    else state.ethLiquidity = liquidity;
    renderLiquidity();
    if (net.id === 137) SwapMarket.setPools(marketPools());
}

// Pools whose trades the market list shows: at least this much DATA (v2 / v3), any liquidity (v4)
const MARKET_POOL_MIN_DATA = ethers.utils.parseUnits('10000', 18);
const MARKET_POOLS_MAX = 8;
const MARKET_COUNTERS = ['POL', 'WPOL', 'USDC', 'USDC.e', 'USDT', 'DAI'];   // the trades get a USD value

/** The DATA pools with liquidity, for the market trades (the main v4 DATA/USDC pool is there already) */
function marketPools() {
    const { pools = [], v4 = [] } = state.liquidity || {};
    const list = [];
    for (const pool of v4) {
        const counter = KNOWN_TOKENS[lower(pool.counter)];
        if (!counter || !MARKET_COUNTERS.includes(counter.symbol) || !pool.liquidity || pool.liquidity.isZero()) continue;
        list.push({
            kind: 'v4', venue: 'v4', id: v4PoolId(pool.key), fee: pool.fee, tickSpacing: pool.tickSpacing, dataIs0: lower(pool.key.currency0) === lower(DATA),
            counterSymbol: counter.symbol, counterDecimals: counter.decimals, label: `Uniswap v4 ${pool.fee / 10000}%`
        });
    }
    for (const pool of pools) {
        const counter = KNOWN_TOKENS[lower(pool.partner)];
        if (!counter || !MARKET_COUNTERS.includes(counter.symbol) || pool.data.lt(MARKET_POOL_MIN_DATA)) continue;
        list.push({
            kind: pool.venue === 'qv2' || pool.venue === 'sushi' ? 'v2' : 'v3', venue: pool.venue, address: lower(pool.address),
            dataIs0: lower(DATA) < lower(pool.partner), counterSymbol: counter.symbol, counterDecimals: counter.decimals,
            label: `${VENUES[pool.venue].name}${pool.fee ? ` ${pool.fee / 10000}%` : ''}`
        });
    }
    return list.slice(0, MARKET_POOLS_MAX);
}

/** The DATA pools list of the swap's chain */
function renderLiquidity() {
    const list = $('swap-liquidity-list');
    const count = $('swap-liquidity-count');
    const net = NET();
    if ($('swap-liquidity-chain')) $('swap-liquidity-chain').textContent = net.name;
    if ($('swap-liquidity-dexes')) $('swap-liquidity-dexes').textContent = net.dexList;
    const liquidity = liquidityOf(net);
    if (!list) return;
    if (!liquidity) {
        count.textContent = '';
        list.innerHTML = '<li class="py-1.5 text-gray-400">Looking for pools...</li>';
        return;
    }
    const { pools, v4 = [], complete } = liquidity;
    count.textContent = `(${pools.length + v4.length})`;
    const v4Rows = v4.map(pool => {
        const counter = net.known[lower(pool.counter)];
        const price = v4DataPrice(pool, net);
        return `
            <li class="flex items-center justify-between gap-3 py-1.5 border-b border-[#2a2a2a] last:border-0">
                <span class="text-gray-300">Uniswap v4 ${pool.fee / 10000}% · DATA / ${counter.symbol}</span>
                <span class="text-right text-gray-300 whitespace-nowrap">1 DATA = ${price < 0.0001 ? price.toExponential(3) : Number(price.toPrecision(5))} ${counter.symbol}</span>
            </li>`;
    });
    const rows = pools.map(pool => {
        const partner = net.known[lower(pool.partner)];
        const venue = `${VENUES[pool.venue].name}${pool.fee ? ` ${pool.fee / 10000}%` : ''}`;
        return `
            <li class="flex items-center justify-between gap-3 py-1.5 border-b border-[#2a2a2a] last:border-0">
                <a href="${net.explorer}/address/${Utils.escapeHtml(pool.address)}" target="_blank" rel="noopener noreferrer" class="text-gray-300 hover:text-white">${venue} · DATA / ${partner.symbol}</a>
                <span class="text-right text-gray-300 whitespace-nowrap">${formatAmount(pool.data, 18)} DATA · ${formatAmount(pool.other, partner.decimals)} ${partner.symbol}</span>
            </li>`;
    });
    list.innerHTML = ([...v4Rows, ...rows].join('') || '<li class="py-1.5 text-gray-300">No DATA pool found on these DEXes.</li>')
        + (complete ? '' : '<li class="py-1.5 text-yellow-300">Some pools could not be checked (RPC). Refresh to try again.</li>');
}

function routeLabel(route) {
    const symbol = (address) => NETWORKS[route.chain].known[lower(address)]?.symbol || Utils.shortAddress(address);
    if (route.venue === 'v4') {
        const fees = route.pools.map(pool => `${pool.fee / 10000}%`).join(' / ');
        return `Uniswap v4 (${fees}) · ${route.currencies.map(symbol).join(' → ')}`;
    }
    const fees = route.fees ? ` (${route.fees.map(f => `${f / 10000}%`).join(' / ')})` : '';
    return `${VENUES[route.venue].name}${fees} · ${route.path.map(symbol).join(' → ')}`;
}

const minOut = (amountOut) => amountOut.mul(Math.round((100 - state.slippage) * 100)).div(10000);

// ============================================
// Transactions
// ============================================

/** Swap transaction for a quote: { to, data, value } (built with the venue router's ABI) */
function buildSwapTx(quote, recipient, permit = null) {
    const tokenIn = payToken();
    const tokenOut = receiveToken();
    const { route, amountIn } = quote;
    const net = NETWORKS[route.chain];
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
        return { to: net.routers[route.venue], data, value };
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
    if (route.venue === 'v4') {
        const coder = ethers.utils.defaultAbiCoder;
        const cin = route.currencies[0];
        const cout = route.currencies[route.currencies.length - 1];
        const swap = route.pools.length === 1
            ? [V4_SWAP_EXACT_IN_SINGLE, coder.encode([V4_SINGLE_PARAMS], [{ poolKey: route.pools[0].key, zeroForOne: v4ZeroForOne(cin, route.pools[0]), amountIn, amountOutMinimum: minimum, hookData: '0x' }])]
            : [V4_SWAP_EXACT_IN, coder.encode([V4_MULTI_PARAMS], [{ currencyIn: cin, path: v4PathKeys(route), amountIn, amountOutMinimum: minimum }])];
        // Native POL / ETH is sent with the call and settled from the router; ERC-20 is pulled from the wallet through Permit2
        const settle = cin === NATIVE
            ? [V4_SETTLE, coder.encode(['address', 'uint256', 'bool'], [NATIVE, amountIn, false])]
            : [V4_SETTLE_ALL, coder.encode(['address', 'uint256'], [cin, amountIn])];
        const take = [V4_TAKE_ALL, coder.encode(['address', 'uint256'], [cout, minimum])];
        const actions = ethers.utils.solidityPack(['uint8', 'uint8', 'uint8'], [swap[0], settle[0], take[0]]);
        const input = coder.encode(['bytes', 'bytes[]'], [actions, [swap[1], settle[1], take[1]]]);
        const iface = new ethers.utils.Interface(UNIVERSAL_ROUTER_ABI);
        if (permit) {
            // The signed Permit2 allowance is submitted by the router in the same transaction
            const permitInput = coder.encode([PERMIT_SINGLE, 'bytes'], [permit.permitSingle, permit.signature]);
            return { to: net.v4.router, data: iface.encodeFunctionData('execute', [ethers.utils.hexConcat([UR_PERMIT2_PERMIT, UR_V4_SWAP]), [permitInput, input], deadline]), value };
        }
        return { to: net.v4.router, data: iface.encodeFunctionData('execute', [UR_V4_SWAP, [input], deadline]), value };
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

async function allowanceOf(token, spender, net = POLYGON) {
    return readOn(net)(p => new ethers.Contract(token.address, ERC20_ABI, p).allowance(state.address, spender));
}

/**
 * Approvals the quote needs before the swap: the router's allowance (V2 / V3 routers), or for v4 the
 * token's allowance to Permit2 plus Permit2's allowance to the Universal Router (exact amount, 30 min)
 */
async function approvalSteps(quote) {
    const pay = payToken();
    if (pay.native) return [];
    const net = NETWORKS[quote.route.chain];
    const amount = formatToken(quote.amountIn, pay);
    const venue = VENUES[quote.route.venue];
    if (quote.route.venue !== 'v4') {
        const router = net.routers[quote.route.venue];
        const needed = await allowanceOf(pay, router, net).then(a => a.lt(quote.amountIn)).catch(() => true);
        return needed ? [{ key: 'approve', spender: router, label: `Approve ${amount} for ${venue.name}` }] : [];
    }
    const [tokenAllowance, permit] = await Promise.all([
        allowanceOf(pay, PERMIT2, net).catch(() => ethers.constants.Zero),
        readOn(net)(p => new ethers.Contract(PERMIT2, PERMIT2_ABI, p).allowance(state.address, pay.address, net.v4.router)).catch(() => null)
    ]);
    const steps = [];
    if (tokenAllowance.lt(quote.amountIn)) steps.push({ key: 'approve', spender: PERMIT2, label: `Approve ${amount} for Permit2 (Uniswap)` });
    const now = Math.floor(Date.now() / 1000);
    if (!permit || permit.amount.lt(quote.amountIn) || permit.expiration < now + 120) {
        steps.push({ key: 'permit-sign', noTx: true, label: `Sign the Uniswap allowance for ${amount} (Permit2, no gas)` });
    }
    return steps;
}

// ============================================
// Rendering
// ============================================

function tokenSlotHtml(symbol, selectable) {
    const token = NET().tokens[symbol];
    if (!selectable) {
        return `${token.icon}<span class="text-lg font-semibold text-white">${token.symbol}</span>`;
    }
    const options = NET().counters.map(s => `<option value="${s}" ${s === symbol ? 'selected' : ''}>${Utils.escapeHtml(s)}</option>`).join('');
    return `${token.icon}<select data-token-select aria-label="Token" class="w-[7.5rem] bg-[#2C2C2C] hover:bg-[#3C3C3C] text-white text-sm font-semibold rounded-lg pl-2 pr-7 py-1.5 border border-[#444] focus:outline-none focus:ring-2 focus:ring-blue-500/50 disabled:opacity-50">${options}</select>`;
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

/** The chain selector, the description of its DEXes, and the DATA pools list of the chain */
function renderChain() {
    document.querySelectorAll('#swap-chain button').forEach(btn => {
        const active = Number(btn.dataset.chain) === state.chain;
        btn.classList.toggle('bg-blue-800', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('text-gray-300', !active);
    });
    document.querySelectorAll('[data-chain-text]').forEach(el => {
        const shown = Number(el.dataset.chainText) === state.chain;
        el.classList.toggle('hidden', !shown);
        el.classList.toggle('flex', shown);
    });
    renderLiquidity();
}

/** Swaps on another chain: the same counter where it has one (POL and ETH stand for each other), else USDC */
function setChain(chain) {
    if (state.flow || !NETWORKS[chain] || chain === state.chain) return;
    state.chain = chain;
    try { localStorage.setItem(CHAIN_KEY, String(chain)); } catch (e) { /* this visit only */ }
    const native = { POL: 'ETH', ETH: 'POL' }[state.counter];
    state.counter = NET().counters.includes(state.counter) ? state.counter : NET().counters.includes(native) ? native : 'USDC';
    state.balances = {};
    state.quote = null;
    state.quoteError = null;
    state.quoteChecked = null;
    showError('');
    renderChain();
    renderTokens();
    updateAmountStatus();
    renderQuote();
    loadBalances();
    updateQuote();
    if (!$('swapPoolsModal')?.classList.contains('hidden')) loadLiquidity(NET()).catch(e => logger.warn('Swap: pool discovery failed', e));
}

function renderSlippage() {
    document.querySelectorAll('#swap-slippage button').forEach(btn => {
        const active = Number(btn.dataset.slippage) === state.slippage;
        btn.classList.toggle('bg-blue-800', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('text-gray-300', !active);
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

// POL/USD for the quote's DATA/USD (Chainlink, read again after a minute)
const POL_USD_MAX_AGE_MS = 60 * 1000;
let polUsdNow = null;   // { price, at }
let polUsdLoading = false;

function loadPolUsdNow() {
    if (polUsdLoading) return;
    polUsdLoading = true;
    polUsdAt([Math.floor(Date.now() / 1000)])
        .then(([price]) => { if (price) polUsdNow = { price, at: Date.now() }; })
        .catch(e => logger.warn('Swap: POL/USD not read', e))
        .finally(() => {
            polUsdLoading = false;
            if (polUsdNow) renderQuote();
        });
}

// ETH/USD for the quote's DATA/USD on Ethereum (Chainlink, read again after a minute)
let ethUsdNow = null;   // { price, at }
let ethUsdLoading = false;

function loadEthUsdNow() {
    if (ethUsdLoading) return;
    ethUsdLoading = true;
    multicall([{ target: ETH_USD_FEED, iface: IFACES.feed, fn: 'latestRoundData', args: [] }], 60, NETWORKS[1])
        .then(([round]) => { if (round?.answer.gt(0)) ethUsdNow = { price: Number(round.answer.toString()) / 1e8, at: Date.now() }; })
        .catch(e => logger.warn('Swap: ETH/USD not read', e))
        .finally(() => {
            ethUsdLoading = false;
            if (ethUsdNow) renderQuote();
        });
}

/** Price per DATA of the quote in USD: straight from a USD side, through POL/USD or ETH/USD for a POL or ETH side */
function quoteDataUsd(q, pay, receive) {
    const payIsData = pay.symbol === 'DATA';
    const data = parseFloat(ethers.utils.formatUnits(payIsData ? q.amountIn : q.amountOut, 18));
    const other = payIsData ? receive : pay;
    const otherAmount = parseFloat(ethers.utils.formatUnits(payIsData ? q.amountOut : q.amountIn, other.decimals));
    let usd = null;
    if (USD_STABLES.includes(other.symbol)) {
        usd = otherAmount;
    } else if (other.symbol === 'POL') {
        if (!polUsdNow || Date.now() - polUsdNow.at > POL_USD_MAX_AGE_MS) loadPolUsdNow();
        if (polUsdNow) usd = otherAmount * polUsdNow.price;
    } else if (other.symbol === 'ETH') {
        if (!ethUsdNow || Date.now() - ethUsdNow.at > POL_USD_MAX_AGE_MS) loadEthUsdNow();
        if (ethUsdNow) usd = otherAmount * ethUsdNow.price;
    }
    if (!(data > 0) || !(usd > 0)) return '--';
    const value = usd / data;
    return `1 DATA = $${value >= 1 ? value.toFixed(2) : Number(value.toPrecision(4))}`;
}

function renderQuote() {
    const pay = payToken();
    const receive = receiveToken();
    const q = state.quote;
    const { wei, error } = readAmount();
    const valid = q && wei && q.amountIn.eq(wei) && !error;
    $('swap-receive').textContent = state.quoting && !valid ? '...' : valid ? formatAmount(q.amountOut, receive.decimals) : '0';
    $('swap-receive').classList.toggle('text-white', Boolean(valid));
    $('swap-receive').classList.toggle('text-gray-300', !valid);
    if (valid) {
        const rate = parseFloat(ethers.utils.formatUnits(q.amountOut, receive.decimals)) / parseFloat(ethers.utils.formatUnits(q.amountIn, pay.decimals));
        $('swap-rate').textContent = `1 ${pay.symbol} = ${rate < 0.0001 ? rate.toExponential(3) : Utils.formatBigNumber(String(Number(rate.toPrecision(5))))} ${receive.symbol}`;
        $('swap-rate-usd').textContent = quoteDataUsd(q, pay, receive);
        $('swap-route').textContent = routeLabel(q.route);
        $('swap-min').textContent = formatToken(minOut(q.amountOut), receive);
        const impactEl = $('swap-impact');
        impactEl.textContent = q.impact === null ? 'n/a' : q.impact < 0.01 ? '< 0.01%' : `${q.impact.toFixed(2)}%`;
        impactEl.classList.toggle('text-red-400', q.impact !== null && q.impact >= IMPACT_BLOCK);
        impactEl.classList.toggle('text-yellow-300', q.impact !== null && q.impact >= IMPACT_WARN && q.impact < IMPACT_BLOCK);
        impactEl.classList.toggle('text-gray-200', q.impact === null || q.impact < IMPACT_WARN);
    } else {
        ['swap-rate', 'swap-rate-usd', 'swap-route', 'swap-impact', 'swap-min'].forEach(id => { $(id).textContent = '--'; });
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
    const working = checked.filter(item => item.out).sort((x, y) => (y.out.gt(x.out) ? 1 : -1));
    const failed = checked.filter(item => !item.out);
    const row = (item) => `
        <li class="flex items-start justify-between gap-3 py-1 border-b border-[#2a2a2a] last:border-0">
            <span class="${item.out ? 'text-gray-300' : 'text-gray-400'}">${Utils.escapeHtml(routeLabel(item.route))}</span>
            <span class="text-right whitespace-nowrap ${item.out ? 'text-gray-200' : 'text-gray-400'}" ${item.error ? `data-tooltip-content="${Utils.escapeHtml(item.error)}"` : ''}>${item.out ? `${item.error ? '≈ ' : ''}${formatToken(item.out, receive)}` : 'failed'}</span>
        </li>`;
    list.innerHTML = working.map(row).join('')
        + (failed.length ? `<li class="pt-1"><details><summary class="cursor-pointer text-gray-400 hover:text-gray-300">${failed.length} route${failed.length > 1 ? 's' : ''} failed</summary><ul>${failed.map(row).join('')}</ul></details></li>` : '');
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
    setSubmitState(state.address ? 'Swap' : 'Connect wallet', false);
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
    document.querySelectorAll('#swap-view select[data-token-select], #swap-slippage button, #swap-chain button').forEach(el => { el.disabled = locked; });
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
    const textClass = { pending: 'text-gray-300', active: 'text-white', done: 'text-gray-300', error: 'text-red-400' };
    list.innerHTML = state.flow.steps.map(step => `
        <li class="flex items-center gap-2">
            ${icons[step.status]}
            <span class="${textClass[step.status]}">${Utils.escapeHtml(step.label)}</span>
            ${step.txHash ? `<a href="${NETWORKS[state.flow.chain].explorer}/tx/${Utils.escapeHtml(step.txHash)}" target="_blank" rel="noopener noreferrer" class="ml-auto text-xs text-blue-400 hover:text-blue-300">tx</a>` : ''}
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
    const net = NET();
    const entries = await Promise.all(Object.values(net.tokens).map(async token => {
        try {
            const balance = token.native
                ? await readOn(net)(p => p.getBalance(address))
                : await readOn(net)(p => new ethers.Contract(token.address, ERC20_ABI, p).balanceOf(address));
            return [token.symbol, balance];
        } catch (e) {
            return [token.symbol, null];
        }
    }));
    if (address !== state.address || net !== NET()) return;
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
        const quote = await findBestQuote(payToken(), receiveToken(), wei, NET());
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
        const net = NETWORKS[q.route.chain];
        const approvals = (await approvalSteps(q)).filter(step => !step.noTx);
        const [gasPrice, swapGas] = await Promise.all([
            readOn(net)(p => p.getGasPrice()),
            approvals.length
                ? ethers.BigNumber.from(SWAP_GAS_FALLBACK)
                : readOn(net)(p => p.estimateGas({ ...buildSwapTx(q, state.address), from: state.address }))
        ]);
        if (q !== state.quote) return;
        const approveGas = ethers.BigNumber.from(60000).mul(approvals.length);
        const cost = swapGas.add(approveGas).mul(gasPrice);
        el.textContent = `≈ ${formatAmount(cost, 18)} ${net.native}${approvals.length ? ` (${approvals.length} approval${approvals.length > 1 ? 's' : ''} + swap)` : ''}`;
    } catch (e) {
        if (q !== state.quote) return;
        logger.warn('Swap cost estimate failed:', e);
        el.textContent = 'n/a';
    }
}

// ============================================
// Swap flow
// ============================================

/** What the swap delivered: Transfer logs to the wallet (tokens), or the POL / ETH balance change plus the swap's gas */
async function receivedAmount(receipt, token, polBefore, net) {
    try {
        if (token.native) {
            if (!polBefore) return null;
            const after = await readOn(net)(p => p.getBalance(state.address, receipt.blockNumber));
            const gas = receipt.gasUsed.mul(receipt.effectiveGasPrice || 0);
            const received = after.sub(polBefore).add(gas);
            return received.gt(0) ? received : null;
        }
        const transferTopic = ethers.utils.id('Transfer(address,address,uint256)');
        const toTopic = ethers.utils.hexZeroPad(state.address, 32).toLowerCase();
        const total = receipt.logs
            .filter(l => lower(l.address) === lower(token.address) && l.topics[0] === transferTopic && l.topics[2]?.toLowerCase() === toTopic)
            .reduce((sum, l) => sum.add(ethers.BigNumber.from(l.data)), ethers.constants.Zero);
        return total.gt(0) ? total : null;
    } catch (e) {
        logger.warn('Swap: received amount not measured', e);
        return null;
    }
}

// ---------- Swap history (per wallet) ----------

const HISTORY_LIMIT = 100;          // swaps kept per wallet
const HISTORY_PAGE = 20;            // rows shown at first, and added by Show more
const EXPLORER_RECORDS = 1000;      // latest token transfers / transactions of the wallet read from the explorer
let historyShown = HISTORY_PAGE;
const historyKey = () => `swapHistory:${state.address}`;
const SYMBOL_DECIMALS = { DATA: 18, POL: 18, WPOL: 18, ETH: 18, USDC: 6, 'USDC.e': 6, USDT: 6, WETH: 18, DAI: 18 };

function loadStoredHistory() {
    try {
        const list = JSON.parse(localStorage.getItem(historyKey()) || '[]');
        return Array.isArray(list) ? list.filter(t => t && /^0x[0-9a-fA-F]{64}$/.test(t.txHash)) : [];
    } catch (e) {
        return [];
    }
}

function saveHistory() {
    try {
        localStorage.setItem(historyKey(), JSON.stringify(state.history.slice(0, HISTORY_LIMIT)));
    } catch (e) { /* storage blocked: the explorer history still shows the swaps */ }
}

function upsertSwap(entry) {
    const existing = state.history.find(t => lower(t.txHash) === lower(entry.txHash));
    if (existing) Object.assign(existing, entry);
    else state.history.push(entry);
    state.history.sort((a, b) => b.createdAt - a.createdAt);
    saveHistory();
    renderHistory();
}

// Contracts a swap transaction can be sent to (labels for swaps recovered from the explorer)
const KNOWN_ROUTERS = {
    [UNIVERSAL_ROUTER.toLowerCase()]: 'Uniswap (Universal Router)',
    '0x4c60051384bd2d3c01bfc845cf5f4b44bcbe9de5': 'Uniswap (Universal Router)',
    [UNISWAP_V3_ROUTER.toLowerCase()]: 'Uniswap v3',
    '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap v3',
    [QUICKSWAP_V2_ROUTER.toLowerCase()]: 'QuickSwap V2',
    [QUICKSWAP_V3_ROUTER.toLowerCase()]: 'QuickSwap V3',
    [SUSHI_V2_ROUTER.toLowerCase()]: 'SushiSwap V2',
    '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch',
    '0x111111125421ca6dc452d289314280a0f8842a65': '1inch',
    '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x',
    '0x1a1ec25dc08e98e5e93f1104b5e5cdd298707d31': 'MetaMask Swaps',
    '0x6131b5fae19ea4f9d964eac0408e4408b66337b5': 'KyberSwap',
    '0xdef171fe48cf0115b1d80b88dc8eab59176fee57': 'ParaSwap',
    '0x6a000f20005980200259b80c5102003040001068': 'ParaSwap'
};

// Routers of the DEXes themselves (the route says it all); the other known routers are aggregators or wallets
const DEX_ROUTERS = new Set([UNIVERSAL_ROUTER, '0x4c60051384bd2d3c01bfc845cf5f4b44bcbe9de5', UNISWAP_V3_ROUTER, '0xe592427a0aece92de3edee1f18e0157c05861564',
    QUICKSWAP_V2_ROUTER, QUICKSWAP_V3_ROUTER, SUSHI_V2_ROUTER].map(lower));

/** DATA swaps of this wallet from the explorer (also those made in other apps): token legs in and out of one transaction */
async function recoverSwapsFromExplorer() {
    const base = `${POLYGONSCAN_NETWORK.apiUrl}?chainid=137&module=account&address=${state.address}&page=1&offset=${EXPLORER_RECORDS}&sort=desc&apikey=${getEtherscanApiKey()}`;
    const get = (action) => fetch(`${base}&action=${action}`).then(r => r.json()).then(j => (Array.isArray(j?.result) ? j.result : [])).catch(() => []);
    const [tokenTx, internalTx, normalTx] = await Promise.all([get('tokentx'), get('txlistinternal'), get('txlist')]);
    const me = state.address;
    const txs = new Map();
    const tx = (hash, time) => {
        if (!txs.has(hash)) txs.set(hash, { hash, time: Number(time) * 1000, out: [], in: [] });
        return txs.get(hash);
    };
    for (const t of tokenTx) {
        const info = KNOWN_TOKENS[lower(t.contractAddress || '')];
        if (!info || lower(t.contractAddress) === NATIVE) continue;
        const leg = { symbol: info.symbol, amount: t.value };
        if (lower(t.from) === me) tx(t.hash, t.timeStamp).out.push(leg);
        if (lower(t.to) === me) tx(t.hash, t.timeStamp).in.push(leg);
    }
    for (const t of internalTx) {
        if (lower(t.to) === me && t.value !== '0' && t.isError !== '1') tx(t.hash, t.timeStamp).in.push({ symbol: 'POL', amount: t.value });
    }
    // The contract each transaction of this wallet was sent to (router / aggregator)
    const sentTo = new Map(normalTx.filter(t => lower(t.from) === me && t.to).map(t => [t.hash, lower(t.to)]));
    for (const t of normalTx) {
        if (lower(t.from) === me && t.value !== '0' && t.isError === '0' && txs.has(t.hash)) tx(t.hash, t.timeStamp).out.push({ symbol: 'POL', amount: t.value });
    }
    let changed = false;
    for (const t of txs.values()) {
        const pay = t.out[0];
        const receive = t.in.find(leg => leg.symbol !== pay?.symbol);
        if (!pay || !receive || (pay.symbol !== 'DATA' && receive.symbol !== 'DATA')) continue;
        const existing = state.history.find(h => lower(h.txHash) === lower(t.hash));
        if (existing) {
            if (existing.receive?.estimated) {
                existing.receive = { symbol: receive.symbol, amount: receive.amount };
                existing.status = 'done';
                changed = true;
            }
            if (!existing.route && !existing.via && sentTo.has(t.hash)) {
                existing.via = sentTo.get(t.hash);
                changed = true;
            }
            continue;
        }
        state.history.push({ txHash: t.hash, createdAt: t.time, status: 'done', pay, receive: { symbol: receive.symbol, amount: receive.amount }, via: sentTo.get(t.hash) || null });
        changed = true;
    }
    if (changed) {
        state.history.sort((a, b) => b.createdAt - a.createdAt);
        saveHistory();
    }
}

/** Swaps left pending (page closed before the receipt): confirmed or failed */
async function settlePendingSwaps() {
    for (const entry of state.history.filter(h => h.status === 'pending')) {
        const receipt = await readOn(NETWORKS[entry.chain || 137])(p => p.getTransactionReceipt(entry.txHash)).catch(() => null);
        if (receipt) upsertSwap({ txHash: entry.txHash, status: receipt.status === 1 ? 'done' : 'failed' });
    }
}

// ---------- DATA/USD of each swap ----------

const USD_STABLES = ['USDC', 'USDC.e', 'USDT', 'DAI'];

/** POL/USD at each time (seconds): the last Chainlink round before it, by a binary search over the feed's rounds */
async function polUsdAt(times) {
    const feed = IFACES.feed;
    const price = (round) => (round && round.answer.gt(0) && round.updatedAt.gt(0) ? Number(round.answer.toString()) / 1e8 : null);
    const [latest] = await multicall([{ target: POL_USD_FEED, iface: feed, fn: 'latestRoundData', args: [] }]);
    if (!latest) return times.map(() => null);
    const results = times.map(t => (t >= latest.updatedAt.toNumber() ? price(latest) : undefined));
    let phase = latest.roundId.shr(64).toNumber();
    let lastRound = latest.roundId.mask(64).toNumber();
    // Current phase first, then the earlier ones for older swaps
    for (let hops = 0; hops < 3 && phase > 0 && lastRound > 0 && results.includes(undefined); hops++) {
        const roundId = (n) => ethers.BigNumber.from(phase).shl(64).or(n);
        const getRound = (n) => ({ target: POL_USD_FEED, iface: feed, fn: 'getRoundData', args: [roundId(n)] });
        const [first] = await multicall([getRound(1)]);
        if (!price(first)) break;
        // The answer stays in [lo, hi]: the last round with updatedAt <= t
        const searches = results.flatMap((r, i) => (r === undefined && times[i] >= first.updatedAt.toNumber() ? [{ i, lo: 1, hi: lastRound, round: first }] : []));
        for (let open = searches; open.length; open = searches.filter(s => s.lo < s.hi)) {
            const mids = open.map(s => Math.ceil((s.lo + s.hi) / 2));
            const rounds = await multicall(mids.map(getRound));
            open.forEach((s, j) => {
                if (!price(rounds[j])) s.lo = s.hi = 0;   // round unreadable: no price for this swap
                else if (rounds[j].updatedAt.toNumber() <= times[s.i]) [s.lo, s.round] = [mids[j], rounds[j]];
                else s.hi = mids[j] - 1;
            });
        }
        searches.forEach(s => { results[s.i] = s.lo ? price(s.round) : null; });
        phase -= 1;
        if (phase < 1) break;
        const [aggregator] = await multicall([{ target: POL_USD_FEED, iface: feed, fn: 'phaseAggregators', args: [phase] }]);
        const address = poolAddress(aggregator);
        const [round] = address ? await multicall([{ target: address, iface: feed, fn: 'latestRound', args: [] }]) : [null];
        lastRound = round ? round[0].toNumber() : 0;
    }
    return results.map(r => r ?? null);
}

const needsPolPrice = (entry) => [entry.pay?.symbol, entry.receive?.symbol].some(s => s === 'POL' || s === 'WPOL');
const polPriceTried = new Set();
let pricingSwaps = false;

/** POL/USD at the time of each POL swap, kept with the swap */
async function fillPolPrices() {
    const missing = state.history.filter(h => h.status === 'done' && h.polUsd === undefined && needsPolPrice(h) && !polPriceTried.has(lower(h.txHash)));
    if (pricingSwaps || !missing.length) return;
    pricingSwaps = true;
    missing.forEach(h => polPriceTried.add(lower(h.txHash)));
    try {
        const prices = await polUsdAt(missing.map(h => Math.floor(h.createdAt / 1000)));
        missing.forEach((h, i) => { if (prices[i]) h.polUsd = prices[i]; });
        saveHistory();
    } catch (e) {
        logger.warn('Swap: POL/USD price not found', e);
    } finally {
        pricingSwaps = false;
        renderHistory();
    }
}

/** DATA/USD column: the price paid or got per DATA in the swap */
function dataUsdCell(entry) {
    const none = (tip) => `<span class="text-gray-400"${tip ? ` data-tooltip-content="${tip}"` : ''}>—</span>`;
    if (entry.status === 'failed') return none();
    const dataLeg = entry.pay?.symbol === 'DATA' ? entry.pay : entry.receive;
    const otherLeg = dataLeg === entry.pay ? entry.receive : entry.pay;
    if (!dataLeg || !otherLeg) return none();
    const data = parseFloat(ethers.utils.formatUnits(dataLeg.amount, 18));
    const other = parseFloat(ethers.utils.formatUnits(otherLeg.amount, SYMBOL_DECIMALS[otherLeg.symbol] ?? 18));
    let usd;
    let tip;
    if (USD_STABLES.includes(otherLeg.symbol)) {
        usd = other;
        tip = `Price per DATA in this swap, with 1 ${otherLeg.symbol} = 1 USD`;
    } else if (otherLeg.symbol === 'POL' || otherLeg.symbol === 'WPOL') {
        if (entry.polUsd === undefined) {
            return pricingSwaps || entry.status === 'pending' ? '<span class="text-gray-400">…</span>' : none('POL/USD price not available');
        }
        usd = other * entry.polUsd;
        tip = `Price per DATA in this swap, with POL at ${entry.polUsd.toFixed(4)} USD`;
    } else {
        return none();
    }
    if (!(data > 0) || !(usd > 0)) return none();
    const value = usd / data;
    const estimated = dataLeg.estimated || otherLeg.estimated;
    const text = value >= 1 ? value.toFixed(2) : Number(value.toPrecision(4)).toString();
    return `<span class="text-white font-medium whitespace-nowrap" data-tooltip-content="${tip}${estimated ? '<br>Estimated until the swap is confirmed' : ''}">${estimated ? '≈ ' : ''}$${text}</span>`;
}

// ---------- Route of a swap, read from its transaction ----------
// Every pool a swap goes through logs a Swap event: the pools (and so the DEX, fee and tokens) give the
// route of any swap, also one made in another app or whose local record is gone.

const SWAP_TOPICS = {
    v4: ethers.utils.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),
    v3: ethers.utils.id('Swap(address,address,int256,int256,uint160,uint128,int24)'),   // Uniswap v3 and QuickSwap V3 (Algebra)
    v2: ethers.utils.id('Swap(address,uint256,uint256,uint256,uint256,address)')
};
const POOL_INFO_IFACE = new ethers.utils.Interface([
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function factory() view returns (address)',
    'function fee() view returns (uint24)'
]);
const FACTORY_VENUES = {
    [QUICKSWAP_V2_FACTORY.toLowerCase()]: 'qv2',
    [SUSHI_V2_FACTORY.toLowerCase()]: 'sushi',
    [QUICKSWAP_V3_FACTORY.toLowerCase()]: 'qv3',
    [UNISWAP_V3_FACTORY.toLowerCase()]: 'uni'
};
const poolInfoCache = new Map();   // pool address -> { venue, token0, token1, fee } | null
let v4KeysById = null;

/** Hookless v4 pools between the known tokens, by pool id */
function knownV4Keys() {
    if (!v4KeysById) {
        v4KeysById = new Map();
        const tokens = Object.keys(KNOWN_TOKENS);
        for (let i = 0; i < tokens.length; i++) {
            for (let j = i + 1; j < tokens.length; j++) {
                for (const [fee, tickSpacing] of V4_TIERS) {
                    const key = v4PoolKey(tokens[i], tokens[j], fee, tickSpacing);
                    v4KeysById.set(v4PoolId(key), key);
                }
            }
        }
    }
    return v4KeysById;
}

/** DEX, tokens and fee of v2 / v3 pools (read once per pool) */
async function loadPoolInfo(addresses) {
    const missing = [...new Set(addresses.map(lower))].filter(a => !poolInfoCache.has(a));
    if (!missing.length) return;
    const calls = missing.flatMap(target => ['token0', 'token1', 'factory', 'fee'].map(fn => ({ target, iface: POOL_INFO_IFACE, fn, args: [] })));
    const results = await multicall(calls);
    missing.forEach((address, i) => {
        const [token0, token1, factory, fee] = results.slice(i * 4, i * 4 + 4).map(r => r?.[0]);
        const venue = factory ? FACTORY_VENUES[lower(factory)] : null;
        poolInfoCache.set(address, token0 && token1 ? { venue, token0: lower(token0), token1: lower(token1), fee: venue === 'uni' && fee ? Number(fee) : null } : null);
    });
}

// POL and WPOL are one token for the path (v4 pools hold native POL, the others WPOL)
const sameToken = (a, b) => a === b || ([a, b].every(t => t === NATIVE || t === lower(WPOL)));

/** Route label of a swap from its receipt (null when no known pool took part) */
async function routeFromReceipt(receipt, entry) {
    const logs = receipt.logs.filter(l => Object.values(SWAP_TOPICS).includes(l.topics[0]));
    await loadPoolInfo(logs.filter(l => l.topics[0] !== SWAP_TOPICS.v4).map(l => l.address));
    const hops = [];
    for (const log of logs) {
        if (log.topics[0] === SWAP_TOPICS.v4) {
            if (lower(log.address) !== lower(UNISWAP_V4_POOL_MANAGER)) continue;
            const key = knownV4Keys().get(log.topics[1]);
            hops.push(key ? { venue: 'v4', tokens: [lower(key.currency0), lower(key.currency1)], fee: key.fee } : { venue: 'v4', tokens: null });
        } else {
            const info = poolInfoCache.get(lower(log.address));
            hops.push(info?.venue ? { venue: info.venue, tokens: [info.token0, info.token1], fee: info.fee } : { venue: null, tokens: null });
        }
    }
    if (!hops.length || hops.some(h => !h.venue)) return null;
    const venueName = (venue) => VENUES[venue].name;
    const venues = [...new Set(hops.map(h => h.venue))];
    // Chain the pools from the paid token: a straight route gives the whole token path
    const payToken = entry.pay?.symbol === 'POL' ? NATIVE : Object.keys(KNOWN_TOKENS).find(a => KNOWN_TOKENS[a].symbol === entry.pay?.symbol);
    const path = payToken ? [payToken] : null;
    for (const hop of hops) {
        if (!path || !hop.tokens) break;
        const current = path[path.length - 1];
        const from = hop.tokens.findIndex(t => sameToken(t, current));
        if (from === -1) { path.length = 0; break; }
        path.push(hop.tokens[1 - from]);
    }
    const symbol = (address, i, all) => {
        const known = KNOWN_TOKENS[address]?.symbol || Utils.shortAddress(address);
        // The ends show what was paid and received (POL, not WPOL)
        if (i === 0 && entry.pay?.symbol === 'POL' && known === 'WPOL') return 'POL';
        if (i === all.length - 1 && entry.receive?.symbol === 'POL' && known === 'WPOL') return 'POL';
        return known;
    };
    const straight = path && path.length === hops.length + 1;
    if (venues.length === 1 && straight) {
        const fees = hops.every(h => h.fee) ? ` (${hops.map(h => `${h.fee / 10000}%`).join(' / ')})` : '';
        return `${venueName(venues[0])}${fees} · ${path.map(symbol).join(' → ')}`;
    }
    // Split or mixed routes (aggregators): the DEXes, from what was paid to what was received
    return `${venues.map(venueName).join(' + ')} · ${entry.pay?.symbol} → ${entry.receive?.symbol}`;
}

const routeTried = new Set();
let inferringRoutes = false;

/** Route of each swap without one (recovered from the explorer, or its local record lost), kept with the swap */
async function fillRoutes() {
    const missing = state.history.filter(h => h.status === 'done' && !h.route && !h.chain && !routeTried.has(lower(h.txHash)));
    if (inferringRoutes || !missing.length) return;
    inferringRoutes = true;
    let changed = false;
    try {
        for (const entry of missing) {
            routeTried.add(lower(entry.txHash));
            try {
                const receipt = await read(p => p.getTransactionReceipt(entry.txHash));
                const route = receipt ? await routeFromReceipt(receipt, entry) : null;
                if (route) { entry.route = route; changed = true; }
            } catch (e) {
                logger.warn(`Swap: route of ${entry.txHash} not read`, e);
            }
        }
    } finally {
        inferringRoutes = false;
        if (changed) {
            saveHistory();
            renderHistory();
        }
    }
}

function timeAgo(ms) {
    const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const HISTORY_BADGES = {
    pending: ['Confirming', 'bg-blue-500/15 text-blue-300'],
    done: ['Completed', 'bg-green-500/15 text-green-400'],
    failed: ['Failed', 'bg-red-500/15 text-red-400']
};

/** Token chip: logo + ticker */
function tokenChip(symbol) {
    const icon = (ICONS[{ WPOL: 'POL', 'USDC.e': 'USDC', WETH: 'ETH' }[symbol] || symbol] || '').replace('w-7 h-7', 'w-4 h-4');
    const fallback = `<span class="w-4 h-4 rounded-full bg-[#444] text-[9px] font-bold text-white flex items-center justify-center flex-shrink-0">${Utils.escapeHtml(symbol.slice(0, 1))}</span>`;
    return `<span class="inline-flex items-center gap-1.5 pl-1 pr-2 py-0.5 rounded-full bg-[#2C2C2C] text-xs font-semibold text-gray-200 whitespace-nowrap">${icon || fallback}${Utils.escapeHtml(symbol)}</span>`;
}

function formatDateTime(ms) {
    const date = new Date(ms);
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleString(undefined, { ...(sameYear ? {} : { year: 'numeric' }), month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Route column: the route of swaps made here, else the router / aggregator the transaction went to */
function routeCell(entry) {
    if (entry.chain === 1) return `${Utils.escapeHtml(entry.route || 'Uniswap')}<div class="text-gray-400">on Ethereum</div>`;
    if (entry.route) {
        // Swaps made through an aggregator or wallet: which one, under the route
        const app = entry.via && !DEX_ROUTERS.has(lower(entry.via)) ? KNOWN_ROUTERS[lower(entry.via)] : null;
        return Utils.escapeHtml(entry.route) + (app ? `<div class="text-gray-400">via ${Utils.escapeHtml(app)}</div>` : '');
    }
    if (!entry.via) return '<span class="text-gray-400">Unknown</span>';
    const known = KNOWN_ROUTERS[lower(entry.via)];
    if (known) return Utils.escapeHtml(known);
    const via = Utils.escapeHtml(entry.via);
    return `via <a href="https://polygonscan.com/address/${via}" target="_blank" rel="noopener noreferrer" class="font-mono text-blue-400 hover:text-blue-300">${via.slice(0, 6)}…${via.slice(-4)}</a>`;
}

function renderHistory() {
    const body = $('swap-history');
    if (!body) return;
    const empty = (text) => `<tr><td colspan="8" class="py-4 text-sm text-gray-300">${text}</td></tr>`;
    if (!state.address || !state.history.length) {
        $('swap-history-more')?.classList.add('hidden');
        body.innerHTML = empty(state.address ? 'No DATA swaps yet.' : 'Connect a wallet to see your swaps.');
        return;
    }
    const amount = (leg) => `<span class="inline-flex items-center gap-2 whitespace-nowrap"><span class="text-white font-medium">${leg.estimated ? '≈ ' : ''}${formatAmount(leg.amount, SYMBOL_DECIMALS[leg.symbol] ?? 18)}</span>${tokenChip(leg.symbol)}</span>`;
    const more = $('swap-history-more');
    more?.classList.toggle('hidden', state.history.length <= historyShown);
    body.innerHTML = state.history.slice(0, historyShown).map(entry => {
        const [label, badge] = HISTORY_BADGES[entry.status] || HISTORY_BADGES.pending;
        const selling = entry.pay?.symbol === 'DATA';
        const action = selling
            ? '<span class="tx-badge tx-badge-out whitespace-nowrap">Sell DATA</span>'
            : '<span class="tx-badge tx-badge-in whitespace-nowrap">Buy DATA</span>';
        const hash = Utils.escapeHtml(entry.txHash);
        return `
            <tr class="border-b border-[#2a2a2a] last:border-0 align-middle">
                <td class="py-3 pr-3 whitespace-nowrap"><div class="text-gray-200">${formatDateTime(entry.createdAt)}</div>${Date.now() - entry.createdAt < 86400000 ? `<div class="text-xs text-gray-400">${timeAgo(entry.createdAt)}</div>` : ''}</td>
                <td class="py-3 pr-3">${action}</td>
                <td class="py-3 pr-3">${amount(entry.pay)}</td>
                <td class="py-3 pr-3">${amount(entry.receive)}</td>
                <td class="py-3 pr-3">${dataUsdCell(entry)}</td>
                <td class="py-3 pr-3 text-xs text-gray-300">${routeCell(entry)}</td>
                <td class="py-3 pr-3"><span class="px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${badge}">${label}</span></td>
                <td class="py-3 text-right whitespace-nowrap"><a href="${NETWORKS[entry.chain || 137].explorer}/tx/${hash}" target="_blank" rel="noopener noreferrer" class="font-mono text-xs text-blue-400 hover:text-blue-300">${hash.slice(0, 6)}…${hash.slice(-4)}</a></td>
            </tr>`;
    }).join('');
    fillPolPrices();
    fillRoutes();
    SwapMarket.setOwnSwaps(state.history.map(h => ({ txHash: h.txHash, pay: h.pay?.symbol, receive: h.receive?.symbol })));
}

/** Spins a refresh button's icon while the work runs (at least half a second, so it is noticed) */
async function withSpinner(buttonId, work) {
    const btn = $(buttonId);
    const icon = btn?.querySelector('svg');
    if (btn) btn.disabled = true;
    icon?.classList.add('animate-spin');
    try {
        const [result] = await Promise.all([work, new Promise(resolve => setTimeout(resolve, 500))]);
        return result;
    } finally {
        icon?.classList.remove('animate-spin');
        if (btn && !state.flow) btn.disabled = false;   // a swap in progress keeps the form locked
    }
}

async function refreshHistory() {
    if (!state.address) return;
    await withSpinner('swap-history-refresh', Promise.all([recoverSwapsFromExplorer(), settlePendingSwaps()]));
    renderHistory();
}

async function sendPolygonTx(buildTx) {
    return Services.executeWithFallback(async (currentSigner) => {
        const overrides = await Services.getGasOverrides(currentSigner.provider);
        return buildTx(currentSigner, overrides);
    }, window.appSigner);
}

/** The flow's signer: the app's on Polygon; on Ethereum the private key with an Ethereum RPC, or the wallet switched to Ethereum */
async function flowSigner(flow) {
    return flow.chain === 137 ? window.appSigner : getEthereumSigner(state.address, getEthProvider());
}

/** Sends one transaction of the flow on its chain (Ethereum: the provider's fee data, no Polygon gas overrides) */
async function sendTx(flow, buildTx) {
    if (flow.chain === 137) return sendPolygonTx(buildTx);
    return buildTx(await flowSigner(flow), {});
}

async function runStep(step, flow) {
    const pay = payToken();
    const net = NETWORKS[flow.chain];
    if (step.key === 'approve') {
        const tx = await sendTx(flow, (signer, overrides) => new ethers.Contract(pay.address, ERC20_ABI, signer).approve(step.spender, flow.quote.amountIn, overrides));
        step.txHash = tx.hash;
        renderProgress();
        const receipt = await tx.wait();
        if (receipt.status !== 1) throw new Error('The approval failed on-chain.');
    } else if (step.key === 'permit-sign') {
        // EIP-712 PermitSingle for the Universal Router: exact amount, expires with the signature
        const allowance = await readOn(net)(p => new ethers.Contract(PERMIT2, PERMIT2_ABI, p).allowance(state.address, pay.address, net.v4.router));
        const expiration = Math.floor(Date.now() / 1000) + PERMIT2_EXPIRATION_SECONDS;
        const permitSingle = {
            details: { token: pay.address, amount: flow.quote.amountIn, expiration, nonce: allowance.nonce },
            spender: net.v4.router,
            sigDeadline: expiration
        };
        const domain = { name: 'Permit2', chainId: net.id, verifyingContract: PERMIT2 };
        const types = {
            PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
            PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }]
        };
        const signature = await (await flowSigner(flow))._signTypedData(domain, types, permitSingle);
        flow.permit = { permitSingle, signature, amount: flow.quote.amountIn };
    } else if (step.key === 'swap') {
        // Fresh quote right before sending (the minimum output follows the current price)
        const fresh = await findBestQuote(pay, receiveToken(), flow.quote.amountIn, net);
        if (fresh.route.venue !== flow.quote.route.venue && !pay.native) {
            // The best venue changed after the approval: stay on the approved router
            const same = await quoteRoute(flow.quote.route, flow.quote.amountIn).catch(() => null);
            if (same) flow.quote = { ...flow.quote, amountOut: same };
        } else {
            flow.quote = fresh;
        }
        if (flow.quote.impact !== null && flow.quote.impact >= IMPACT_BLOCK) throw new Error('The price impact is now too high. Try a smaller amount.');
        const permit = flow.quote.route.venue === 'v4' && flow.permit && flow.permit.permitSingle.sigDeadline > Math.floor(Date.now() / 1000) + 60 ? flow.permit : null;
        const txData = buildSwapTx(flow.quote, state.address, permit);
        const receive = receiveToken();
        // POL / ETH output: measured as the balance change plus the swap's own gas
        const polBefore = receive.native ? await readOn(net)(p => p.getBalance(state.address)).catch(() => null) : null;
        const tx = await sendTx(flow, (signer, overrides) => signer.sendTransaction({ ...txData, ...overrides }));
        step.txHash = tx.hash;
        flow.sent = true;
        upsertSwap({
            txHash: tx.hash, createdAt: Date.now(), status: 'pending', route: routeLabel(flow.quote.route), ...(flow.chain === 137 ? {} : { chain: flow.chain }),
            pay: { symbol: pay.symbol, amount: flow.quote.amountIn.toString() },
            receive: { symbol: receive.symbol, amount: flow.quote.amountOut.toString(), estimated: true }
        });
        renderProgress();
        const receipt = await tx.wait();
        if (receipt.status !== 1) {
            upsertSwap({ txHash: tx.hash, status: 'failed' });
            throw new Error('The swap failed on-chain.');
        }
        flow.received = await receivedAmount(receipt, receive, polBefore, net);
        upsertSwap({ txHash: tx.hash, status: 'done', receive: { symbol: receive.symbol, amount: (flow.received || flow.quote.amountOut).toString(), estimated: !flow.received } });
        SwapMarket.refresh();
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
        const approvals = await approvalSteps(quote);
        const amount = formatToken(quote.amountIn, pay);
        state.flow = {
            quote,
            chain: quote.route.chain,
            sent: false,
            steps: [
                ...approvals,
                { key: 'swap', label: `Swap ${amount} for ${receive.symbol}` }
            ].map(step => ({ ...step, status: 'pending', txHash: null }))
        };
    }

    const flow = state.flow;
    state.submitting = true;
    setFormLocked(true);
    renderProgress();
    try {
        if (flow.chain === 137 && sessionStorage.getItem('authMethod') !== 'privateKey' && !await Services.checkAndSwitchNetwork()) {
            throw new Error('Switch your wallet to Polygon to continue.');
        }
        if (flow.chain !== 137) await flowSigner(flow);   // the wallet on Ethereum (asked once, before the first step)
        for (const step of flow.steps) {
            if (step.status === 'done') continue;
            step.status = 'active';
            renderProgress();
            setSubmitState(step.noTx ? 'Sign in wallet...' : 'Confirm in wallet...', true);
            await runStep(step, flow);
            step.status = 'done';
            renderProgress();
        }
        flow.finished = true;
        state.submitting = false;
        const receive = receiveToken();
        loadBalances();
        showSuccess(flow.received
            ? `Swapped: you received ${formatToken(flow.received, receive)}.`
            : `Swapped: at least ${formatToken(minOut(flow.quote.amountOut), receive)} are in your wallet.`);
        setSubmitState('New swap', false);
        UI.showToast({ type: 'success', title: 'Swap Complete', message: `${payToken().symbol} → ${receive.symbol}`, duration: 6000 });
        if (flow.chain !== 137) restorePolygon();
    } catch (e) {
        if (flow.chain !== 137) restorePolygon();
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

/** While the page stays open: the quote and balances every 30 s, the wallet's swaps every 2 min */
function scheduleRefresh() {
    clearTimeout(state.refreshTimer);
    if (!state.active) return;
    state.refreshTimer = setTimeout(() => {
        state.refreshTicks = (state.refreshTicks || 0) + 1;
        if (!document.hidden) {
            if (!state.flow && state.quote) updateQuote();
            loadBalances();
            if (state.refreshTicks % HISTORY_REFRESH_TICKS === 0) refreshHistoryQuietly();
        }
        scheduleRefresh();
    }, QUOTE_REFRESH_MS);
}

/** The wallet's swaps again, without the refresh button's spinner */
function refreshHistoryQuietly() {
    if (!state.address) return;
    Promise.all([recoverSwapsFromExplorer(), settlePendingSwaps()])
        .then(() => renderHistory())
        .catch(e => logger.warn('Swap: history refresh failed', e));
}

/** Back on the tab after a while: everything at once instead of at the next tick */
function refreshOnReturn() {
    if (document.hidden || !state.active) return;
    if (!state.flow && state.quote) updateQuote();
    loadBalances();
    refreshHistoryQuietly();
    SwapMarket.refresh();
}

function openPoolsModal() {
    $('swapPoolsModal')?.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
    renderLiquidity();
    loadLiquidity(NET()).catch(e => logger.warn('Swap: pool discovery failed', e));
}

function closePoolsModal() {
    $('swapPoolsModal')?.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
}

function setupListeners() {
    if (state.listenersSetup) return;
    state.listenersSetup = true;
    document.addEventListener('visibilitychange', refreshOnReturn);
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
        const reserve = NET().gasReserve;
        if (token.native) balance = balance.gt(reserve) ? balance.sub(reserve) : ethers.constants.Zero;
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
    $('swap-chain')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-chain]');
        if (btn) setChain(Number(btn.dataset.chain));
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
        loadLiquidity(NET()).catch(e => logger.warn('Swap: pool discovery failed', e));
        withSpinner('swap-refresh', Promise.all([loadBalances(), updateQuote()]));
    });
    $('swap-submit')?.addEventListener('click', handleSubmit);
    $('swap-history-refresh')?.addEventListener('click', () => refreshHistory());
    $('swap-history-more')?.addEventListener('click', () => {
        historyShown += HISTORY_PAGE;
        renderHistory();
    });
    $('swap-pools-btn')?.addEventListener('click', openPoolsModal);
    $('swap-pools-close')?.addEventListener('click', closePoolsModal);
    $('swapPoolsModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'swapPoolsModal') closePoolsModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !$('swapPoolsModal')?.classList.contains('hidden')) closePoolsModal();
    });
    window.addEventListener('app:routechange', (e) => {
        if (!e.detail?.path?.startsWith('/swap')) {
            closePoolsModal();
            SwapLogic.stop();
        }
    });
}

export const SwapLogic = {
    async show() {
        setupListeners();
        state.active = true;
        try {
            const saved = Number(localStorage.getItem(SLIPPAGE_KEY));
            if ([0.5, 1, 3].includes(saved)) state.slippage = saved;
            const chain = Number(localStorage.getItem(CHAIN_KEY));
            if (NETWORKS[chain] && !state.flow) {
                state.chain = chain;
                if (!NET().counters.includes(state.counter)) state.counter = 'USDC';
            }
        } catch (e) { /* private mode */ }
        let address;
        try {
            address = window.appSigner ? (await window.appSigner.getAddress()).toLowerCase() : null;
        } catch (e) {
            address = null;
        }
        if (address !== state.address) {
            state.address = address;
            state.balances = {};
            state.history = address ? loadStoredHistory() : [];
            historyShown = HISTORY_PAGE;
        }
        renderHistory();
        refreshHistory().catch(e => logger.warn('Swap: history refresh failed', e));
        SwapMarket.setPolUsdSource(polUsdAt);
        SwapMarket.setTokenChip(tokenChip);
        SwapMarket.show();
        SwapBook.show();
        if (state.liquidity) SwapMarket.setPools(marketPools());
        if (!state.flow) {
            $('swap-progress')?.classList.add('hidden');
            showSuccess('');
            showError('');
        }
        renderChain();
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
        SwapMarket.stop();
        SwapBook.stop();
    }
};
