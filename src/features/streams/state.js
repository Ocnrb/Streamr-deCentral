// State of the Streams pages: the lists and the open stream or sponsorship

// ============================================
// Constants
// ============================================

export const STREAMS_PER_PAGE = 1000;

// ============================================
// State Management
// ============================================

export const state = {
    // Sponsorships
    sponsorships: [],
    sponsorshipsSkip: 0,
    hasMoreSponsorships: true,
    sponsorshipsLoading: false,
    
    // Zero balance sponsorships (remaining balance = 0)
    zeroBalanceStreams: [],
    zeroBalanceSkip: 0,
    hasMoreZeroBalance: true,
    zeroBalanceLoading: false,
    showZeroBalance: false, // Toggle state for zero balance sponsorships
    
    // All streams 
    allStreams: [],
    allStreamsSkip: 0,
    hasMoreAllStreams: true,
    allStreamsLoading: false,
    
    // Search state
    searchQuery: '',
    searchMode: false,
    filteredSponsorships: [],
    filteredAllStreams: [],
    
    // Sort state for sponsorships
    sortField: 'apy', // 'payout', 'apy', 'staked', 'operators'
    sortDirection: 'desc', // 'asc' or 'desc'
    
    // Shared state
    dataPriceUSD: null,
    
    // Active tab
    activeTab: 'allStreams',
    
    // Operator stakes - Set of sponsorship IDs where user's operator has stake
    operatorStakes: new Set(),
};

// ============================================
// Stream / Sponsorship Details
// ============================================

export const detailState = {
    currentStreamId: null,
    currentSponsorshipId: null,
    isSponsored: false,
    subscription: null,
    subscriptions: [], // For subscribing to multiple partitions
    messageCount: 0,
    messageTimestamps: [],
    bytesReceived: 0,
    bytesTimestamps: [], // {timestamp, bytes} for KB/s calculation
    partitions: 1, // Number of partitions in the stream
    sponsorshipStakes: [], // Operators staked in current sponsorship
    // Unified chart state
    chart: null,
    chartData: null,
    currentChartType: 'apy',
    currentViewMode: 'data',
    currentTimeframe: 'all',
    // Remaining balance ticker state
    remainingBalanceData: null, // {remainingWei: BigInt, changePerSecond: BigInt, lastUpdated: number}
    remainingBalanceTickerInterval: null
};
