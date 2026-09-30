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
        "inputs": [ { "internalType": "uint256", "name": "amountDataWei", "type": "uint256" } ],
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
    },
    {
        "inputs": [],
        "name": "getSponsorshipsAndEarnings",
        "outputs": [
            { "internalType": "address[]", "name": "addresses", "type": "address[]" },
            { "internalType": "uint256[]", "name": "earnings", "type": "uint256[]" },
            { "internalType": "uint256", "name": "maxAllowedEarnings", "type": "uint256" }
        ],
        "stateMutability": "view",
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
export const DATA_HISTORY_STREAM_ID = '0xd5a8024414f59cf0c453c35fc3655a31251645f6/DATA_History';
export const POLYGON_RPC_URL = 'https://polygon.drpc.org';

// Polygon RPC endpoints (the read provider moves to the next one when one fails)
// Order: primary first, then most reliable fallbacks. polygon-rpc.com now answers 401 without an
// API key: kept last only as a final fallback.
export const POLYGON_RPC_FALLBACKS = [
    'https://polygon.drpc.org',
    'https://polygon-bor-rpc.publicnode.com',
    'https://rpc-mainnet.matic.quiknode.pro',
    'https://1rpc.io/matic',
    'https://polygon-rpc.com'
];

// RPCs for the Streamr SDK clients: the same as the current @streamr/config. The bundled SDK still
// lists polygon-rpc.com first, which now answers 401 (Unauthorized).
export const STREAMR_SDK_CONTRACTS_CONFIG = {
    rpcs: [
        { url: 'https://polygon.drpc.org' },
        { url: 'https://rpc-mainnet.matic.quiknode.pro' },
        { url: 'https://polygon-bor-rpc.publicnode.com' }
    ]
};

// ============================================
// API Keys Configuration
// ============================================
// Default API key fallbacks (used when user hasn't configured their own)
export const DEFAULT_GRAPH_API_KEY = 'afbd62cb6433d88cf3a849950adcc2e1';
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

// ============================================
// Stream creation (StreamRegistry / StreamStorageRegistry on Polygon)
// ============================================
export const STREAM_REGISTRY_ADDRESS = '0x0D483E10612F327FC11965Fc82E90dC19b141641';
export const STREAM_STORAGE_REGISTRY_ADDRESS = '0xe8e2660CeDf2a59C917a5ED05B72df4146b58399';

// Permissions set for this address apply to everyone (public stream)
export const PUBLIC_PERMISSION_ADDRESS = '0x0000000000000000000000000000000000000000';

// Same limit as the Streamr SDK
export const MAX_STREAM_PARTITIONS = 100;
export const DEFAULT_STORAGE_DAYS = 365;

const STREAM_PERMISSION_TUPLE = '(bool canEdit, bool canDelete, uint256 publishExpiration, uint256 subscribeExpiration, bool canGrant)';

export const STREAM_REGISTRY_ABI = [
    `function createStreamWithPermissions(string streamIdPath, string metadataJsonString, address[] users, ${STREAM_PERMISSION_TUPLE}[] permissions)`,
    'function createStreamWithENS(string ensName, string streamIdPath, string metadataJsonString)',
    `function setPermissions(string streamId, address[] users, ${STREAM_PERMISSION_TUPLE}[] permissions)`,
    'function updateStreamMetadata(string streamId, string metadata)',
    'function deleteStream(string streamId)',
    'function exists(string streamId) view returns (bool)',
    'function ensCache() view returns (address)'
];

export const STREAM_STORAGE_REGISTRY_ABI = [
    'function addAndRemoveStorageNodes(string streamId, address[] addNodes, address[] removeNodes)',
    'function isStorageNodeOf(string streamId, address nodeAddress) view returns (bool)'
];

export const ENS_CACHE_ABI = [
    'function owners(string ensName) view returns (address)'
];

// ============================================
// Operator creation (OperatorFactory on Polygon, addresses from @streamr/config)
// ============================================
export const OPERATOR_FACTORY_ADDRESS = '0x935734e66729b69260543Cf6e5EfeB42AC962183';

// Default policies trusted by the factory: [0] delegation, [1] exchange rate, [2] undelegation
export const OPERATOR_DEFAULT_POLICIES = [
    '0x8e449F0B1AFAD807135B5Ea829F41851d5DE1426',
    '0xE8F511bB4888D16D81acab7ab1c05A356E37237f',
    '0x5c81fA1e79318386Dd82Ef059bCB194DbA87De45'
];

export const OPERATOR_FACTORY_ABI = [
    'function deployOperator(uint256 operatorsCutFraction, string operatorTokenName, string operatorMetadataJson, address[3] policies, uint256[3] policyParams) returns (address)',
    'function operators(address operatorWallet) view returns (address)',
    'error OperatorAlreadyDeployed(address operatorContractAddress)',
    'error PolicyNotTrusted()'
];

// ============================================
// Sponsorships (SponsorshipFactory on Polygon, addresses from @streamr/config)
// ============================================
export const SPONSORSHIP_FACTORY_ADDRESS = '0x820b2f9a15ed45F9802c59d0CC77C22C81755e45';
export const SPONSORSHIP_POLICIES = {
    stakeWeightedAllocation: '0x1Dd16E748308E9f259f3D6097d00e1793BfBdcDB',  // param: payout wei/second
    defaultLeave: '0xa953D590098A3d56304a12A8e929D63748D90AAC',             // param: minimum staking period (s)
    voteKick: '0xeF3F567D7328849c1130CBCBF8Cd9feB42eA5dB5',                 // param: 0
    maxOperatorsJoin: '0x27448061420bAccAE8c84DDC3E7e2e8B2aE4977E'          // param: max operators (optional)
};
// DATA (ERC-677): sponsorships are created and funded with transferAndCall
export const DATA_TOKEN_ERC677_ABI = [
    'function transferAndCall(address to, uint256 value, bytes data) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
    'event Transfer(address indexed from, address indexed to, uint256 value)'
];
