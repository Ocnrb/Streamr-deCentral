export const DATA_TOKEN_ADDRESS_POLYGON = '0x3a9A81d576d83FF21f26f325066054540720fC34';
export const STREAMR_CONFIG_ADDRESS = '0x344587b3d00394821557352354331D7048754d24';
export const STREAMR_TREASURY_ADDRESS = '0x63f74A64fd334122aB5D29760C6E72Fb4b752208';

export const DATA_TOKEN_ABI = [
     {
        "inputs": [
            { "internalType": "address", "name": "to", "type": "address" },
            { "internalType": "uint256", "name": "value", "type": "uint256" },
            { "internalType": "bytes", "name": "data", "type": "bytes" }
        ],
        "name": "transferAndCall",
        "outputs": [ { "internalType": "bool", "name": "", "type": "bool" } ],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "constant": true,
        "inputs": [ { "name": "_owner", "type": "address" } ],
        "name": "balanceOf",
        "outputs": [ { "name": "balance", "type": "uint256" } ],
        "stateMutability": "view",
        "type": "function"
    }
];

export const OPERATOR_CONTRACT_ABI = [
    {
        "inputs": [],
        "name": "totalSupply",
        "outputs": [ { "internalType": "uint256", "name": "", "type": "uint256" } ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "totalValueInQueuesAndSponsorships",
        "outputs": [ { "internalType": "uint256", "name": "", "type": "uint256" } ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "valueWithoutEarnings",
        "outputs": [ { "internalType": "uint256", "name": "", "type": "uint256" } ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "totalStakedIntoSponsorshipsWei",
        "outputs": [ { "internalType": "uint256", "name": "", "type": "uint256" } ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "queueIsEmpty",
        "outputs": [ { "internalType": "bool", "name": "", "type": "bool" } ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [ { "internalType": "address", "name": "sponsorship", "type": "address" } ],
        "name": "stakedInto",
        "outputs": [ { "internalType": "uint256", "name": "", "type": "uint256" } ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [ { "internalType": "uint256", "name": "operatorTokenAmount", "type": "uint256" } ],
        "name": "undelegate",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [ { "internalType": "address", "name": "account", "type": "address" } ],
        "name": "balanceOf",
        "outputs": [ { "internalType": "uint256", "name": "", "type": "uint256" } ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [ { "internalType": "address", "name": "delegator", "type": "address" } ],
        "name": "balanceInData",
        "outputs": [ { "internalType": "uint256", "name": "amountDataWei", "type": "uint256" } ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [ { "internalType": "uint256", "name": "maxIterations", "type": "uint256" } ],
        "name": "payOutQueue",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [ { "internalType": "address", "name": "sponsorship", "type": "address" }, { "internalType": "uint256", "name": "amountWei", "type": "uint256" } ],
        "name": "stake",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [ { "internalType": "address", "name": "sponsorship", "type": "address" }, { "internalType": "uint256", "name": "targetStakeWei", "type": "uint256" } ],
        "name": "reduceStakeTo",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [ { "internalType": "address", "name": "sponsorship", "type": "address" } ],
        "name": "unstake",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [ { "internalType": "address[]", "name": "sponsorshipAddresses", "type": "address[]" } ],
        "name": "withdrawEarningsFromSponsorships",
        "outputs": [ { "internalType": "uint256", "name": "", "type": "uint256" } ],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [ { "internalType": "string", "name": "metadataJsonString", "type": "string" } ],
        "name": "updateMetadata",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [ { "internalType": "uint256", "name": "operatorsCutFractionWei", "type": "uint256" } ],
        "name": "updateOperatorsCutFraction",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    }
];

export const SPONSORSHIP_ABI = [
    {
        "inputs": [ { "internalType": "address", "name": "operator", "type": "address" } ],
        "name": "minimumStakeOf",
        "outputs": [ { "internalType": "uint256", "name": "", "type": "uint256" } ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [ { "internalType": "address", "name": "operator", "type": "address" } ],
        "name": "stakedWei",
        "outputs": [ { "internalType": "uint256", "name": "", "type": "uint256" } ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [ { "internalType": "address", "name": "operator", "type": "address" } ],
        "name": "lockedStakeWei",
        "outputs": [ { "internalType": "uint256", "name": "", "type": "uint256" } ],
        "stateMutability": "view",
        "type": "function"
    }
];

export const STREAMR_CONFIG_ABI = [{ "inputs": [], "name": "minimumDelegationWei", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }];

export const SUBGRAPH_ID = 'EGWFdhhiWypDuz22Uy7b3F69E9MEkyfU9iAQMttkH5Rj';
export const DATA_PRICE_STREAM_ID = 'binance-streamr.eth/DATAUSDT/ticker';
export const POLYGON_RPC_URL = 'https://polygon-rpc.com';

// ============================================
// API Keys Configuration
// ============================================
// Default API key fallbacks (used when user hasn't configured their own)
export const DEFAULT_GRAPH_API_KEY = 'd8acda6777ed7cbaccfd3f1102d447f6';
export const DEFAULT_ETHERSCAN_API_KEY = 'B8BXCXWR66RI1J2QYQRTT4SPHCC6VYYJHC';

// LocalStorage keys for user-configured API keys
export const STORAGE_KEYS = {
    GRAPH_API_KEY: 'the-graph-api-key',
    ETHERSCAN_API_KEY: 'etherscan-api-key'
};

/**
 * Gets the Graph API URL using user-configured key or default fallback.
 * This is the single source of truth for Graph API access across the app.
 * @returns {string} The Graph API URL
 */
export function getGraphUrl() {
    const storedKey = localStorage.getItem(STORAGE_KEYS.GRAPH_API_KEY);
    const apiKey = storedKey && storedKey.trim() !== '' ? storedKey : DEFAULT_GRAPH_API_KEY;
    return `https://gateway-arbitrum.network.thegraph.com/api/${apiKey}/subgraphs/id/${SUBGRAPH_ID}`;
}

/**
 * Gets the Etherscan/Polygonscan API key using user-configured key or default fallback.
 * This is the single source of truth for Etherscan API access across the app.
 * @returns {string} The API key
 */
export function getEtherscanApiKey() {
    const storedKey = localStorage.getItem(STORAGE_KEYS.ETHERSCAN_API_KEY);
    return storedKey && storedKey.trim() !== '' ? storedKey : DEFAULT_ETHERSCAN_API_KEY;
}

/**
 * Builds a Polygonscan API URL with the correct API key.
 * @param {object} params - Query parameters
 * @param {string} params.module - API module (account, transaction, etc.)
 * @param {string} params.action - API action (txlist, tokentx, etc.)
 * @param {string} params.address - Wallet address
 * @param {number} [params.page=1] - Page number
 * @param {number} [params.offset=100] - Results per page
 * @param {string} [params.sort='desc'] - Sort order
 * @returns {string} Complete API URL
 */
export function buildPolygonscanUrl({ module, action, address, page = 1, offset = 100, sort = 'desc' }) {
    const { apiUrl, chainId } = POLYGONSCAN_NETWORK;
    const apiKey = getEtherscanApiKey();
    const cacheBuster = `&_t=${Date.now()}`;
    return `${apiUrl}?chainid=${chainId}&module=${module}&action=${action}&address=${address}&page=${page}&offset=${offset}&sort=${sort}&apikey=${apiKey}${cacheBuster}`;
}

export const POLYGONSCAN_NETWORK = {
    apiUrl: "https://api.etherscan.io/v2/api",
    nativeToken: "MATIC",
    explorerUrl: "https://polygonscan.com/tx/",
    chainId: 137
};

export const POLYGONSCAN_METHOD_IDS = {
    "0xa9059cbb": "Transfer",
    "0x4000aea0": "Delegate",
    "0x918b5be1": "Update Metadata",
    "0x25c33549": "Set Node Address",
    "0xe8e658b4": "Collect Earnings",
    "0xbed6ff09": "Vote On Flag",
    "0x0fd6ff49": "Heartbeat",
    "0x6c68c0e1": "Undelegate",
    "0xadc9772e": "Stake",
    "0xa93a019f": "Force Unstake",
    "0xd1b68611": "Reduce Stake",
    "0xf2888dbb": "Unstake",
    "0x4a178fe4": "Flag",
};

export const VOTE_ON_FLAG_RAW_AMOUNTS = new Set([
    "50000000000000000",
    "500000000000000000",
    "150000000000000000",
    "36000000000000000000",
    "2000000000000000000"
]);

// Pagination
export const DELEGATORS_PER_PAGE = 100;
export const DELEGATORS_LIST_PAGE_SIZE = 50;
export const DELEGATOR_TX_HISTORY_LIMIT = 2000;
export const OPERATORS_PER_PAGE = 20;
export const MIN_SEARCH_LENGTH = 3;
export const MAX_STREAM_MESSAGES = 20;
export const MIN_ADDRESS_SEARCH_LENGTH = 8;
export const FULL_ADDRESS_LENGTH = 42;

// Chart timeframes for delegator view
export const DELEGATOR_TIMEFRAMES = {
    '30': 30,
    '90': 90,
    '365': 365,
    'all': 'all'
};

