/**
 * Subgraph Explorer - Entity Configuration
 * Every entity of the Streamr network subgraph that can be queried from the Subgraph view:
 * fields requested, sortable fields and filters (with their input type).
 *
 * Filter types: text, address, number, wei (DATA amount converted to wei), fraction (0-1 as 1e18),
 * datetime (valueType 'Int' for Int fields), boolean, toggle (fixed condition), select (options).
 */

export const ENTITY_CONFIG = {
    // ─────────────────────────────────────────────────
    // STREAMS & PERMISSIONS
    // ─────────────────────────────────────────────────
    streams: {
        label: 'Stream',
        category: 'Data',
        queryType: 'list',
        singularQuery: 'stream',
        description: 'Data streams on the Streamr network - includes permissions, storage nodes and sponsorships',
        fields: `id idAsString metadata createdAt updatedAt 
            permissions(first: 10) { id userId userAddress canEdit canDelete canGrant publishExpiration subscribeExpiration } 
            storageNodes(first: 5) { id metadata lastSeen } 
            sponsorships(first: 5) { id spotAPY totalStakedWei remainingWei isRunning operatorCount }`,
        sortFields: [
            { value: 'id', label: 'ID (Address/Path)' },
            { value: 'idAsString', label: 'ID (Substring Searchable)' },
            { value: 'createdAt', label: 'Created At' },
            { value: 'updatedAt', label: 'Updated At' },
        ],
        defaultSort: { field: 'createdAt', direction: 'desc' },
        filters: [
            { id: 'streamIdFilter', field: 'idAsString_contains_nocase', label: 'Stream ID Contains', type: 'text', placeholder: 'Ex: streamr-dev/my-stream' },
            { id: 'streamIdExact', field: 'id', label: 'Stream ID (Exact)', type: 'text', placeholder: 'Full stream ID' },
            { id: 'streamIdStartsWith', field: 'idAsString_starts_with', label: 'Stream ID Starts With (e.g. creator address)', type: 'text', placeholder: '0x...' },
            { id: 'streamMetadataFilter', field: 'metadata_contains_nocase', label: 'Metadata Contains', type: 'text', placeholder: "Ex: 'sensor-data'" },
            { id: 'streamMetadataNotNull', field: 'metadata_not', label: 'Has Metadata (not empty)', type: 'toggle', value: '""' },
            { id: 'streamMinCreatedAt', field: 'createdAt_gte', label: 'Created After', type: 'datetime' },
            { id: 'streamMaxCreatedAt', field: 'createdAt_lte', label: 'Created Before', type: 'datetime' },
            { id: 'streamMinUpdatedAt', field: 'updatedAt_gte', label: 'Updated After', type: 'datetime' },
            { id: 'streamMaxUpdatedAt', field: 'updatedAt_lte', label: 'Updated Before', type: 'datetime' },
        ],
    },
    streamPermissions: {
        label: 'Stream Permission',
        category: 'Data',
        queryType: 'list',
        singularQuery: 'streamPermission',
        description: 'User permissions on streams - publish, subscribe, edit, delete and grant capabilities',
        fields: 'id userAddress userId stream { id idAsString metadata createdAt } canEdit canDelete canGrant publishExpiration subscribeExpiration',
        sortFields: [
            { value: 'id', label: 'ID' },
            { value: 'userAddress', label: 'User Address' },
            { value: 'userId', label: 'User ID' },
            { value: 'publishExpiration', label: 'Publish Expiration' },
            { value: 'subscribeExpiration', label: 'Subscribe Expiration' },
        ],
        defaultSort: { field: 'id', direction: 'asc' },
        filters: [
            { id: 'permUserAddress', field: 'userAddress', label: 'User Address', type: 'address', placeholder: '0x...' },
            { id: 'permUserAddressContains', field: 'userAddress_contains', label: 'User Address Contains', type: 'text', placeholder: '0x...' },
            { id: 'permUserId', field: 'userId', label: 'User ID', type: 'address', placeholder: '0x...' },
            { id: 'permUserIdContains', field: 'userId_contains', label: 'User ID Contains', type: 'address', placeholder: '0x...' },
            { id: 'permStreamId', field: 'stream', label: 'Stream ID', type: 'text', placeholder: 'Stream address/path' },
            { id: 'permStreamContains', field: 'stream_contains', label: 'Stream ID Contains', type: 'text', placeholder: 'stream' },
            { id: 'permCanEdit', field: 'canEdit', label: 'Can Edit', type: 'boolean' },
            { id: 'permCanDelete', field: 'canDelete', label: 'Can Delete', type: 'boolean' },
            { id: 'permCanGrant', field: 'canGrant', label: 'Can Grant', type: 'boolean' },
            { id: 'permMinPublishExp', field: 'publishExpiration_gte', label: 'Publish Expires After', type: 'datetime' },
            { id: 'permMaxPublishExp', field: 'publishExpiration_lte', label: 'Publish Expires Before', type: 'datetime' },
            { id: 'permMinSubscribeExp', field: 'subscribeExpiration_gte', label: 'Subscribe Expires After', type: 'datetime' },
            { id: 'permMaxSubscribeExp', field: 'subscribeExpiration_lte', label: 'Subscribe Expires Before', type: 'datetime' },
            { id: 'permHasPublish', field: 'publishExpiration_gt', label: 'Has Publish Permission (exp > 0)', type: 'toggle', value: '"0"' },
            { id: 'permHasSubscribe', field: 'subscribeExpiration_gt', label: 'Has Subscribe Permission (exp > 0)', type: 'toggle', value: '"0"' },
        ],
    },
    // ─────────────────────────────────────────────────
    // SPONSORSHIPS
    // ─────────────────────────────────────────────────
    sponsorships: {
        label: 'Sponsorship',
        category: 'Staking',
        queryType: 'list',
        singularQuery: 'sponsorship',
        description: 'Sponsorship contracts for streams - includes staking, APY, operators and events',
        fields: `id stream { id idAsString metadata } metadata creator totalPayoutWeiPerSec remainingWei remainingWeiUpdateTimestamp 
            projectedInsolvency spotAPY operatorCount minOperators maxOperators minimumStakingPeriodSeconds totalStakedWei cumulativeSponsoring isRunning
            stakes(first: 5) { id operator { id metadataJsonString } amountWei earningsWei }
            flags(first: 3) { id result target { id } flagger { id } flaggingTimestamp }
            slashingEvents(first: 3) { id operator { id } amount date }
            stakingEvents(first: 5) { id operator { id } amount date }
            sponsoringEvents(first: 3) { id sponsor amount date }`,
        sortFields: [
            { value: 'id', label: 'ID (Address)' },
            { value: 'spotAPY', label: 'Spot APY' },
            { value: 'remainingWei', label: 'Remaining Funds' },
            { value: 'totalPayoutWeiPerSec', label: 'Payout Per Second' },
            { value: 'operatorCount', label: 'Operator Count' },
            { value: 'totalStakedWei', label: 'Total Staked' },
            { value: 'projectedInsolvency', label: 'Projected Insolvency' },
            { value: 'cumulativeSponsoring', label: 'Cumulative Sponsoring' },
            { value: 'minimumStakingPeriodSeconds', label: 'Min Staking Period' },
            { value: 'minOperators', label: 'Min Operators Required' },
            { value: 'maxOperators', label: 'Max Operators Allowed' },
        ],
        defaultSort: { field: 'spotAPY', direction: 'desc' },
        filters: [
            { id: 'sponsorshipIdFilter', field: 'id', label: 'Sponsorship Address', type: 'address', placeholder: '0x...' },
            { id: 'sponsorshipCreatorFilter', field: 'creator', label: 'Creator Address', type: 'address', placeholder: '0x...' },
            { id: 'sponsorshipCreatorContains', field: 'creator_contains', label: 'Creator Contains', type: 'text', placeholder: '0x...' },
            { id: 'sponsorshipStreamFilter', field: 'stream', label: 'Stream ID', type: 'text', placeholder: 'Stream address' },
            { id: 'sponsorshipStreamContains', field: 'stream_contains', label: 'Stream Contains', type: 'text', placeholder: 'stream' },
            { id: 'sponsorshipMetadataFilter', field: 'metadata_contains_nocase', label: 'Metadata Contains', type: 'text', placeholder: 'description' },
            { id: 'sponsorshipMinApy', field: 'spotAPY_gte', label: 'Min APY (0.1 = 10%)', type: 'number', step: '0.0001', placeholder: '0.1' },
            { id: 'sponsorshipMaxApy', field: 'spotAPY_lte', label: 'Max APY (0.1 = 10%)', type: 'number', step: '0.0001', placeholder: '0.5' },
            { id: 'sponsorshipMinOperators', field: 'operatorCount_gte', label: 'Min Operators', type: 'number', placeholder: '1' },
            { id: 'sponsorshipMaxOperators', field: 'operatorCount_lte', label: 'Max Operators', type: 'number', placeholder: '10' },
            { id: 'sponsorshipIsRunning', field: 'isRunning', label: 'Is Active', type: 'boolean' },
            { id: 'sponsorshipMinRemainingWei', field: 'remainingWei_gte', label: 'Min Remaining (DATA)', type: 'wei', placeholder: '10' },
            { id: 'sponsorshipMaxRemainingWei', field: 'remainingWei_lte', label: 'Max Remaining (DATA)', type: 'wei', placeholder: '1000000' },
            { id: 'sponsorshipMinTotalStaked', field: 'totalStakedWei_gte', label: 'Min Total Staked (DATA)', type: 'wei', placeholder: '1000' },
            { id: 'sponsorshipMaxTotalStaked', field: 'totalStakedWei_lte', label: 'Max Total Staked (DATA)', type: 'wei', placeholder: '1000000' },
            { id: 'sponsorshipMinCumulative', field: 'cumulativeSponsoring_gte', label: 'Min Cumulative Sponsoring (DATA)', type: 'wei', placeholder: '100' },
            { id: 'sponsorshipMinPayout', field: 'totalPayoutWeiPerSec_gte', label: 'Min Payout/Sec (DATA)', type: 'wei', placeholder: '0.001' },
            { id: 'sponsorshipMinInsolvency', field: 'projectedInsolvency_gte', label: 'Insolvency After (timestamp)', type: 'datetime' },
            { id: 'sponsorshipMaxInsolvency', field: 'projectedInsolvency_lte', label: 'Insolvency Before (timestamp)', type: 'datetime' },
        ],
    },
    sponsorshipDailyBuckets: {
        label: 'Sponsorship Daily Bucket',
        category: 'Metrics',
        queryType: 'list',
        singularQuery: 'sponsorshipDailyBucket',
        description: 'Daily performance metrics for sponsorships - APY, staking and remaining funds tracking',
        fields: 'id sponsorship { id stream { idAsString metadata } creator isRunning totalPayoutWeiPerSec } date totalStakedWei remainingWei projectedInsolvency spotAPY operatorCount',
        sortFields: [
            { value: 'date', label: 'Date' },
            { value: 'spotAPY', label: 'Spot APY' },
            { value: 'totalStakedWei', label: 'Total Staked' },
            { value: 'remainingWei', label: 'Remaining' },
            { value: 'operatorCount', label: 'Operator Count' },
            { value: 'projectedInsolvency', label: 'Projected Insolvency' },
        ],
        defaultSort: { field: 'date', direction: 'desc' },
        filters: [
            { id: 'dailyBucketSponsorshipFilter', field: 'sponsorship', label: 'Sponsorship Address', type: 'address', placeholder: '0x...' },
            { id: 'dailyBucketSponsorshipContains', field: 'sponsorship_contains', label: 'Sponsorship Contains', type: 'text', placeholder: '0x...' },
            { id: 'dailyBucketMinApy', field: 'spotAPY_gte', label: 'Min APY', type: 'number', step: '0.0001', placeholder: '0.1' },
            { id: 'dailyBucketMaxApy', field: 'spotAPY_lte', label: 'Max APY', type: 'number', step: '0.0001', placeholder: '0.5' },
            { id: 'dailyBucketMinDate', field: 'date_gte', label: 'From Date', type: 'datetime' },
            { id: 'dailyBucketMaxDate', field: 'date_lte', label: 'To Date', type: 'datetime' },
            { id: 'dailyBucketMinStaked', field: 'totalStakedWei_gte', label: 'Min Total Staked (DATA)', type: 'wei', placeholder: '1000' },
            { id: 'dailyBucketMaxStaked', field: 'totalStakedWei_lte', label: 'Max Total Staked (DATA)', type: 'wei', placeholder: '1000000' },
            { id: 'dailyBucketMinRemaining', field: 'remainingWei_gte', label: 'Min Remaining (DATA)', type: 'wei', placeholder: '100' },
            { id: 'dailyBucketMaxRemaining', field: 'remainingWei_lte', label: 'Max Remaining (DATA)', type: 'wei', placeholder: '100000' },
            { id: 'dailyBucketMinOperators', field: 'operatorCount_gte', label: 'Min Operators', type: 'number', placeholder: '1' },
            { id: 'dailyBucketMaxOperators', field: 'operatorCount_lte', label: 'Max Operators', type: 'number', placeholder: '10' },
        ],
    },
    // ─────────────────────────────────────────────────
    // OPERATORS
    // ─────────────────────────────────────────────────
    operators: {
        label: 'Operator',
        category: 'Staking',
        queryType: 'list',
        singularQuery: 'operator',
        description: 'Network operators staking in sponsorships - includes earnings, delegations, stakes and governance',
        fields: `id owner metadataJsonString delegatorCount valueWithoutEarnings totalStakeInSponsorshipsWei 
            dataTokenBalanceWei operatorTokenTotalSupplyWei exchangeRate valueUpdateTimestamp valueUpdateBlockNumber
            cumulativeProfitsWei cumulativeOperatorsCutWei cumulativeEarningsWei operatorsCutFraction contractVersion 
            slashingsCount isEligibleToVote protectionEndTimestamp latestHeartbeatTimestamp latestHeartbeatMetadata 
            nodes controllers
            stakes(first: 5) { id sponsorship { id stream { idAsString } spotAPY } amountWei earningsWei }
            delegations(first: 5) { id delegator { id } _valueDataWei isSelfDelegation }
            flagsOpened(first: 3) { id result flaggingTimestamp }
            flagsTargeted(first: 3) { id result flaggingTimestamp }
            queueEntries(first: 5) { id amount date delegator { id } }`,
        sortFields: [
            { value: 'id', label: 'ID (Address)' },
            { value: 'valueWithoutEarnings', label: 'Total Value' },
            { value: 'delegatorCount', label: 'Delegator Count' },
            { value: 'totalStakeInSponsorshipsWei', label: 'Total Stake in Sponsorships' },
            { value: 'cumulativeEarningsWei', label: 'Cumulative Earnings' },
            { value: 'cumulativeProfitsWei', label: 'Cumulative Profits' },
            { value: 'cumulativeOperatorsCutWei', label: 'Cumulative Operator Cut' },
            { value: 'operatorsCutFraction', label: 'Operator Cut %' },
            { value: 'slashingsCount', label: 'Slashings Count' },
            { value: 'latestHeartbeatTimestamp', label: 'Last Heartbeat' },
            { value: 'exchangeRate', label: 'Exchange Rate' },
            { value: 'dataTokenBalanceWei', label: 'DATA Token Balance' },
            { value: 'operatorTokenTotalSupplyWei', label: 'Operator Token Supply' },
            { value: 'protectionEndTimestamp', label: 'Protection End' },
            { value: 'valueUpdateTimestamp', label: 'Value Update Time' },
        ],
        defaultSort: { field: 'valueWithoutEarnings', direction: 'desc' },
        filters: [
            { id: 'operatorIdExact', field: 'id', label: 'Operator Address (Exact)', type: 'address', placeholder: '0x...' },
            { id: 'operatorOwnerFilter', field: 'owner', label: 'Owner Address', type: 'address', placeholder: '0x...' },
            { id: 'operatorOwnerContains', field: 'owner_contains', label: 'Owner Contains', type: 'text', placeholder: '0x...' },
            { id: 'operatorMetadataFilter', field: 'metadataJsonString_contains_nocase', label: 'Metadata Contains', type: 'text', placeholder: 'operator name' },
            { id: 'operatorMinDelegators', field: 'delegatorCount_gte', label: 'Min Delegators', type: 'number', placeholder: '5' },
            { id: 'operatorMaxDelegators', field: 'delegatorCount_lte', label: 'Max Delegators', type: 'number', placeholder: '100' },
            { id: 'operatorMinValue', field: 'valueWithoutEarnings_gte', label: 'Min Total Value (DATA)', type: 'wei', placeholder: '1000' },
            { id: 'operatorMaxValue', field: 'valueWithoutEarnings_lte', label: 'Max Total Value (DATA)', type: 'wei', placeholder: '1000000' },
            { id: 'operatorMinStake', field: 'totalStakeInSponsorshipsWei_gte', label: 'Min Stake in Sponsorships (DATA)', type: 'wei', placeholder: '500' },
            { id: 'operatorMaxStake', field: 'totalStakeInSponsorshipsWei_lte', label: 'Max Stake in Sponsorships (DATA)', type: 'wei', placeholder: '100000' },
            { id: 'operatorMinEarnings', field: 'cumulativeEarningsWei_gte', label: 'Min Cumulative Earnings (DATA)', type: 'wei', placeholder: '100' },
            { id: 'operatorMinProfits', field: 'cumulativeProfitsWei_gte', label: 'Min Cumulative Profits (DATA)', type: 'wei', placeholder: '10' },
            { id: 'operatorIsEligibleToVote', field: 'isEligibleToVote', label: 'Eligible to Vote', type: 'boolean' },
            { id: 'operatorMinCut', field: 'operatorsCutFraction_gte', label: 'Min Operator Cut (0-1)', type: 'fraction', placeholder: '0.05' },
            { id: 'operatorMaxCut', field: 'operatorsCutFraction_lte', label: 'Max Operator Cut (0-1)', type: 'fraction', placeholder: '0.20' },
            { id: 'operatorMinSlashings', field: 'slashingsCount_gte', label: 'Min Slashings', type: 'number', placeholder: '0' },
            { id: 'operatorMaxSlashings', field: 'slashingsCount_lte', label: 'Max Slashings', type: 'number', placeholder: '5' },
            { id: 'operatorMinHeartbeat', field: 'latestHeartbeatTimestamp_gte', label: 'Last Heartbeat After', type: 'datetime' },
            { id: 'operatorContractVersion', field: 'contractVersion', label: 'Contract Version', type: 'number', placeholder: '1' },
        ],
    },
    operatorDailyBuckets: {
        label: 'Operator Daily Bucket',
        category: 'Metrics',
        queryType: 'list',
        singularQuery: 'operatorDailyBucket',
        description: 'Daily performance metrics for operators - profits, losses, delegations and earnings',
        fields: 'id operator { id owner metadataJsonString valueWithoutEarnings delegatorCount operatorsCutFraction } date valueWithoutEarnings totalStakeInSponsorshipsWei dataTokenBalanceWei delegatorCountAtStart delegatorCountChange totalDelegatedWei totalUndelegatedWei profitsWei lossesWei operatorsCutWei cumulativeEarningsWei',
        sortFields: [
            { value: 'date', label: 'Date' },
            { value: 'profitsWei', label: 'Profits' },
            { value: 'lossesWei', label: 'Losses' },
            { value: 'totalDelegatedWei', label: 'Total Delegated' },
            { value: 'totalUndelegatedWei', label: 'Total Undelegated' },
            { value: 'valueWithoutEarnings', label: 'Value' },
            { value: 'totalStakeInSponsorshipsWei', label: 'Stake in Sponsorships' },
            { value: 'dataTokenBalanceWei', label: 'DATA Balance' },
            { value: 'delegatorCountAtStart', label: 'Delegators at Start' },
            { value: 'delegatorCountChange', label: 'Delegator Change' },
            { value: 'operatorsCutWei', label: 'Operator Cut' },
            { value: 'cumulativeEarningsWei', label: 'Cumulative Earnings' },
        ],
        defaultSort: { field: 'date', direction: 'desc' },
        filters: [
            { id: 'operatorDailyOperatorFilter', field: 'operator', label: 'Operator Address', type: 'address', placeholder: '0x...' },
            { id: 'operatorDailyOperatorContains', field: 'operator_contains', label: 'Operator Address Contains', type: 'text', placeholder: '0x...' },
            { id: 'operatorDailyMinDate', field: 'date_gte', label: 'From Date', type: 'datetime' },
            { id: 'operatorDailyMaxDate', field: 'date_lte', label: 'To Date', type: 'datetime' },
            { id: 'operatorDailyMinProfits', field: 'profitsWei_gte', label: 'Min Profits (DATA)', type: 'wei', placeholder: '1' },
            { id: 'operatorDailyMaxProfits', field: 'profitsWei_lte', label: 'Max Profits (DATA)', type: 'wei', placeholder: '10000' },
            { id: 'operatorDailyMinLosses', field: 'lossesWei_gte', label: 'Min Losses (DATA)', type: 'wei', placeholder: '0' },
            { id: 'operatorDailyMaxLosses', field: 'lossesWei_lte', label: 'Max Losses (DATA)', type: 'wei', placeholder: '1000' },
            { id: 'operatorDailyMinDelegated', field: 'totalDelegatedWei_gte', label: 'Min Delegated (DATA)', type: 'wei', placeholder: '100' },
            { id: 'operatorDailyMinUndelegated', field: 'totalUndelegatedWei_gte', label: 'Min Undelegated (DATA)', type: 'wei', placeholder: '100' },
            { id: 'operatorDailyMinValue', field: 'valueWithoutEarnings_gte', label: 'Min Value (DATA)', type: 'wei', placeholder: '1000' },
            { id: 'operatorDailyMinDelegatorChange', field: 'delegatorCountChange_gte', label: 'Min Delegator Change', type: 'number', placeholder: '0' },
            { id: 'operatorDailyMaxDelegatorChange', field: 'delegatorCountChange_lte', label: 'Max Delegator Change', type: 'number', placeholder: '0' },
        ],
    },
    // ─────────────────────────────────────────────────
    // STAKES & DELEGATIONS
    // ─────────────────────────────────────────────────
    stakes: {
        label: 'Stake',
        category: 'Staking',
        queryType: 'list',
        singularQuery: 'stake',
        description: 'Operator stake positions in sponsorships with earnings and lock status',
        fields: 'id sponsorship { id stream { idAsString metadata } spotAPY totalStakedWei operatorCount isRunning remainingWei projectedInsolvency } operator { id owner metadataJsonString operatorsCutFraction valueWithoutEarnings delegatorCount } amountWei lockedWei minimumStakeWei earningsWei updateTimestamp joinTimestamp',
        sortFields: [
            { value: 'id', label: 'ID' },
            { value: 'amountWei', label: 'Amount Staked' },
            { value: 'lockedWei', label: 'Locked Amount' },
            { value: 'earningsWei', label: 'Earnings' },
            { value: 'minimumStakeWei', label: 'Minimum Stake' },
            { value: 'joinTimestamp', label: 'Join Date' },
            { value: 'updateTimestamp', label: 'Last Update' },
        ],
        defaultSort: { field: 'amountWei', direction: 'desc' },
        filters: [
            { id: 'stakeOperatorFilter', field: 'operator', label: 'Operator Address', type: 'address', placeholder: '0x...' },
            { id: 'stakeOperatorContains', field: 'operator_contains', label: 'Operator Contains', type: 'text', placeholder: '0x...' },
            { id: 'stakeSponsorshipFilter', field: 'sponsorship', label: 'Sponsorship Address', type: 'address', placeholder: '0x...' },
            { id: 'stakeSponsorshipContains', field: 'sponsorship_contains', label: 'Sponsorship Contains', type: 'text', placeholder: '0x...' },
            { id: 'stakeMinAmountWei', field: 'amountWei_gte', label: 'Min Amount (DATA)', type: 'wei', placeholder: '100' },
            { id: 'stakeMaxAmountWei', field: 'amountWei_lte', label: 'Max Amount (DATA)', type: 'wei', placeholder: '100000' },
            { id: 'stakeMinLockedWei', field: 'lockedWei_gte', label: 'Min Locked (DATA)', type: 'wei', placeholder: '0' },
            { id: 'stakeMinEarnings', field: 'earningsWei_gte', label: 'Min Earnings (DATA)', type: 'wei', placeholder: '1' },
            { id: 'stakeMaxEarnings', field: 'earningsWei_lte', label: 'Max Earnings (DATA)', type: 'wei', placeholder: '10000' },
            { id: 'stakeMinJoinDate', field: 'joinTimestamp_gte', label: 'Joined After', type: 'datetime', valueType: 'Int' },
            { id: 'stakeMaxJoinDate', field: 'joinTimestamp_lte', label: 'Joined Before', type: 'datetime', valueType: 'Int' },
            { id: 'stakeMinUpdateDate', field: 'updateTimestamp_gte', label: 'Updated After', type: 'datetime', valueType: 'Int' },
        ],
    },
    delegations: {
        label: 'Delegation',
        category: 'Staking',
        queryType: 'list',
        singularQuery: 'delegation',
        description: 'Delegator stake positions with operators - includes value, timestamps and self-delegation status',
        fields: 'id delegator { id numberOfDelegations totalValueDataWei cumulativeEarningsWei } operator { id owner metadataJsonString operatorsCutFraction valueWithoutEarnings delegatorCount totalStakeInSponsorshipsWei cumulativeEarningsWei } operatorTokenBalanceWei _valueDataWei latestDelegationTimestamp earliestUndelegationTimestamp isSelfDelegation',
        sortFields: [
            { value: 'id', label: 'ID' },
            { value: '_valueDataWei', label: 'Value Delegated' },
            { value: 'operatorTokenBalanceWei', label: 'Operator Token Balance' },
            { value: 'latestDelegationTimestamp', label: 'Delegation Date' },
            { value: 'earliestUndelegationTimestamp', label: 'Undelegation Date' },
        ],
        defaultSort: { field: '_valueDataWei', direction: 'desc' },
        filters: [
            { id: 'delegationDelegatorFilter', field: 'delegator', label: 'Delegator Address', type: 'address', placeholder: '0x...' },
            { id: 'delegationDelegatorContains', field: 'delegator_contains', label: 'Delegator Contains', type: 'text', placeholder: '0x...' },
            { id: 'delegationOperatorFilter', field: 'operator', label: 'Operator Address', type: 'address', placeholder: '0x...' },
            { id: 'delegationOperatorContains', field: 'operator_contains', label: 'Operator Contains', type: 'text', placeholder: '0x...' },
            { id: 'delegationMinValueWei', field: '_valueDataWei_gte', label: 'Min Value (DATA)', type: 'wei', placeholder: '100' },
            { id: 'delegationMaxValueWei', field: '_valueDataWei_lte', label: 'Max Value (DATA)', type: 'wei', placeholder: '100000' },
            { id: 'delegationMinTokenBalance', field: 'operatorTokenBalanceWei_gte', label: 'Min Operator Token Balance', type: 'wei', placeholder: '1' },
            { id: 'delegationIsSelf', field: 'isSelfDelegation', label: 'Self Delegation', type: 'boolean' },
            { id: 'delegationMinDelegationDate', field: 'latestDelegationTimestamp_gte', label: 'Delegated After', type: 'datetime', valueType: 'Int' },
            { id: 'delegationMaxDelegationDate', field: 'latestDelegationTimestamp_lte', label: 'Delegated Before', type: 'datetime', valueType: 'Int' },
            { id: 'delegationMinUndelegationDate', field: 'earliestUndelegationTimestamp_gte', label: 'Undelegation After', type: 'datetime', valueType: 'Int' },
            { id: 'delegationHasUndelegation', field: 'earliestUndelegationTimestamp_gt', label: 'Has Undelegation Lock (timestamp > 0)', type: 'toggle', value: '0' },
        ],
    },
    delegators: {
        label: 'Delegator',
        category: 'Staking',
        queryType: 'list',
        singularQuery: 'delegator',
        description: 'Accounts that delegate to operators - with portfolio summary and earnings',
        fields: `id numberOfDelegations totalValueDataWei cumulativeEarningsWei 
            delegations(first: 10) { id operator { id owner metadataJsonString operatorsCutFraction } _valueDataWei isSelfDelegation latestDelegationTimestamp } 
            queueEntries(first: 5) { id operator { id metadataJsonString } amount date }`,
        sortFields: [
            { value: 'id', label: 'ID (Address)' },
            { value: 'numberOfDelegations', label: 'Number of Delegations' },
            { value: 'totalValueDataWei', label: 'Total Value' },
            { value: 'cumulativeEarningsWei', label: 'Cumulative Earnings' },
        ],
        defaultSort: { field: 'totalValueDataWei', direction: 'desc' },
        filters: [
            { id: 'delegatorIdFilter', field: 'id', label: 'Delegator Address', type: 'address', placeholder: '0x...' },
            { id: 'delegatorMinDelegations', field: 'numberOfDelegations_gte', label: 'Min Delegations', type: 'number', placeholder: '1' },
            { id: 'delegatorMaxDelegations', field: 'numberOfDelegations_lte', label: 'Max Delegations', type: 'number', placeholder: '10' },
            { id: 'delegatorMinValue', field: 'totalValueDataWei_gte', label: 'Min Total Value (DATA)', type: 'wei', placeholder: '100' },
            { id: 'delegatorMaxValue', field: 'totalValueDataWei_lte', label: 'Max Total Value (DATA)', type: 'wei', placeholder: '1000000' },
            { id: 'delegatorMinEarnings', field: 'cumulativeEarningsWei_gte', label: 'Min Cumulative Earnings (DATA)', type: 'wei', placeholder: '1' },
            { id: 'delegatorHasEarnings', field: 'cumulativeEarningsWei_gt', label: 'Has Earnings (>0)', type: 'toggle', value: '"0"' },
        ],
    },
    delegatorDailyBuckets: {
        label: 'Delegator Daily Bucket',
        category: 'Metrics',
        queryType: 'list',
        singularQuery: 'delegatorDailyBucket',
        description: 'Daily portfolio metrics for delegators - value, operator count and earnings',
        fields: 'id delegator { id numberOfDelegations totalValueDataWei cumulativeEarningsWei } date totalValueDataWei operatorCount cumulativeEarningsWei',
        sortFields: [
            { value: 'date', label: 'Date' },
            { value: 'totalValueDataWei', label: 'Total Value' },
            { value: 'operatorCount', label: 'Operator Count' },
            { value: 'cumulativeEarningsWei', label: 'Cumulative Earnings' },
        ],
        defaultSort: { field: 'date', direction: 'desc' },
        filters: [
            { id: 'delegatorDailyDelegatorFilter', field: 'delegator', label: 'Delegator Address', type: 'address', placeholder: '0x...' },
            { id: 'delegatorDailyDelegatorContains', field: 'delegator_contains', label: 'Delegator Contains', type: 'text', placeholder: '0x...' },
            { id: 'delegatorDailyMinDate', field: 'date_gte', label: 'From Date', type: 'datetime' },
            { id: 'delegatorDailyMaxDate', field: 'date_lte', label: 'To Date', type: 'datetime' },
            { id: 'delegatorDailyMinValue', field: 'totalValueDataWei_gte', label: 'Min Value (DATA)', type: 'wei', placeholder: '100' },
            { id: 'delegatorDailyMaxValue', field: 'totalValueDataWei_lte', label: 'Max Value (DATA)', type: 'wei', placeholder: '1000000' },
            { id: 'delegatorDailyMinOperators', field: 'operatorCount_gte', label: 'Min Operators', type: 'number', placeholder: '1' },
            { id: 'delegatorDailyMaxOperators', field: 'operatorCount_lte', label: 'Max Operators', type: 'number', placeholder: '10' },
            { id: 'delegatorDailyMinEarnings', field: 'cumulativeEarningsWei_gte', label: 'Min Cumulative Earnings (DATA)', type: 'wei', placeholder: '1' },
        ],
    },
    pastDelegationCounts: {
        label: 'Past Delegation Count',
        category: 'Metrics',
        queryType: 'list',
        singularQuery: 'pastDelegationCount',
        description: 'Historical delegation count snapshots - useful for tracking delegation trends',
        fields: 'id count',
        sortFields: [
            { value: 'id', label: 'ID' },
            { value: 'count', label: 'Count' },
        ],
        defaultSort: { field: 'count', direction: 'desc' },
        filters: [
            { id: 'pastDelegationIdExact', field: 'id', label: 'ID (Exact)', type: 'text', placeholder: '0xoperator-0xdelegator' },
            { id: 'pastDelegationMinCount', field: 'count_gte', label: 'Min Count', type: 'number', placeholder: '1' },
            { id: 'pastDelegationMaxCount', field: 'count_lte', label: 'Max Count', type: 'number', placeholder: '100' },
        ],
    },
    // ─────────────────────────────────────────────────
    // EVENTS
    // ─────────────────────────────────────────────────
    stakingEvents: {
        label: 'Staking Event',
        category: 'Events',
        queryType: 'list',
        singularQuery: 'stakingEvent',
        description: 'Stake/Unstake events on sponsorships - positive amounts are stakes, negative are unstakes',
        fields: `id operator { id owner metadataJsonString operatorsCutFraction valueWithoutEarnings delegatorCount totalStakeInSponsorshipsWei } 
            sponsorship { id stream { idAsString metadata } spotAPY totalStakedWei remainingWei operatorCount isRunning creator } 
            amount date`,
        sortFields: [
            { value: 'date', label: 'Event Date' },
            { value: 'amount', label: 'Amount' },
            { value: 'id', label: 'ID' },
        ],
        defaultSort: { field: 'date', direction: 'desc' },
        filters: [
            { id: 'stakingEventOperatorFilter', field: 'operator', label: 'Operator Address', type: 'address', placeholder: '0x...' },
            { id: 'stakingEventOperatorContains', field: 'operator_contains', label: 'Operator Contains', type: 'text', placeholder: '0x...' },
            { id: 'stakingEventSponsorshipFilter', field: 'sponsorship', label: 'Sponsorship Address', type: 'address', placeholder: '0x...' },
            { id: 'stakingEventSponsorshipContains', field: 'sponsorship_contains', label: 'Sponsorship Contains', type: 'text', placeholder: '0x...' },
            { id: 'stakingEventMinAmount', field: 'amount_gte', label: 'Min Amount (DATA) - positive=stake', type: 'wei', placeholder: '100' },
            { id: 'stakingEventMaxAmount', field: 'amount_lte', label: 'Max Amount (DATA) - negative=unstake', type: 'wei', placeholder: '-100' },
            { id: 'stakingEventPositiveOnly', field: 'amount_gt', label: 'Stakes Only (amount > 0)', type: 'toggle', value: '"0"' },
            { id: 'stakingEventNegativeOnly', field: 'amount_lt', label: 'Unstakes Only (amount < 0)', type: 'toggle', value: '"0"' },
            { id: 'stakingEventMinDate', field: 'date_gte', label: 'From Date', type: 'datetime' },
            { id: 'stakingEventMaxDate', field: 'date_lte', label: 'To Date', type: 'datetime' },
        ],
    },
    sponsoringEvents: {
        label: 'Sponsoring Event',
        category: 'Events',
        queryType: 'list',
        singularQuery: 'sponsoringEvent',
        description: 'Sponsorship funding events - when sponsors add funds to sponsorships',
        fields: `id sponsor 
            sponsorship { id stream { idAsString metadata } spotAPY totalStakedWei remainingWei operatorCount isRunning creator totalPayoutWeiPerSec projectedInsolvency } 
            amount date`,
        sortFields: [
            { value: 'date', label: 'Event Date' },
            { value: 'amount', label: 'Amount' },
            { value: 'sponsor', label: 'Sponsor Address' },
            { value: 'id', label: 'ID' },
        ],
        defaultSort: { field: 'date', direction: 'desc' },
        filters: [
            { id: 'sponsoringEventSponsorFilter', field: 'sponsor', label: 'Sponsor Address', type: 'address', placeholder: '0x...' },
            { id: 'sponsoringEventSponsorContains', field: 'sponsor_contains', label: 'Sponsor Contains', type: 'text', placeholder: '0x...' },
            { id: 'sponsoringEventSponsorshipFilter', field: 'sponsorship', label: 'Sponsorship Address', type: 'address', placeholder: '0x...' },
            { id: 'sponsoringEventSponsorshipContains', field: 'sponsorship_contains', label: 'Sponsorship Contains', type: 'text', placeholder: '0x...' },
            { id: 'sponsoringEventMinAmount', field: 'amount_gte', label: 'Min Amount (DATA)', type: 'wei', placeholder: '100' },
            { id: 'sponsoringEventMaxAmount', field: 'amount_lte', label: 'Max Amount (DATA)', type: 'wei', placeholder: '100000' },
            { id: 'sponsoringEventMinDate', field: 'date_gte', label: 'From Date', type: 'datetime' },
            { id: 'sponsoringEventMaxDate', field: 'date_lte', label: 'To Date', type: 'datetime' },
        ],
    },
    slashingEvents: {
        label: 'Slashing Event',
        category: 'Events',
        queryType: 'list',
        singularQuery: 'slashingEvent',
        description: 'Operator penalty/slashing events - funds lost due to misconduct or failed flag disputes',
        fields: `id 
            operator { id owner metadataJsonString valueWithoutEarnings slashingsCount delegatorCount totalStakeInSponsorshipsWei operatorsCutFraction } 
            sponsorship { id stream { idAsString metadata } spotAPY totalStakedWei remainingWei operatorCount isRunning creator } 
            amount date`,
        sortFields: [
            { value: 'date', label: 'Event Date' },
            { value: 'amount', label: 'Amount Slashed' },
            { value: 'id', label: 'ID' },
        ],
        defaultSort: { field: 'date', direction: 'desc' },
        filters: [
            { id: 'slashingEventOperatorFilter', field: 'operator', label: 'Operator Address', type: 'address', placeholder: '0x...' },
            { id: 'slashingEventOperatorContains', field: 'operator_contains', label: 'Operator Contains', type: 'text', placeholder: '0x...' },
            { id: 'slashingEventSponsorshipFilter', field: 'sponsorship', label: 'Sponsorship Address', type: 'address', placeholder: '0x...' },
            { id: 'slashingEventSponsorshipContains', field: 'sponsorship_contains', label: 'Sponsorship Contains', type: 'text', placeholder: '0x...' },
            { id: 'slashingEventMinAmount', field: 'amount_gte', label: 'Min Amount Slashed (DATA)', type: 'wei', placeholder: '1' },
            { id: 'slashingEventMaxAmount', field: 'amount_lte', label: 'Max Amount Slashed (DATA)', type: 'wei', placeholder: '100000' },
            { id: 'slashingEventMinDate', field: 'date_gte', label: 'From Date', type: 'datetime' },
            { id: 'slashingEventMaxDate', field: 'date_lte', label: 'To Date', type: 'datetime' },
        ],
    },
    // ─────────────────────────────────────────────────
    // FLAGS & VOTES (Governance)
    // ─────────────────────────────────────────────────
    flags: {
        label: 'Flag',
        category: 'Governance',
        queryType: 'list',
        singularQuery: 'flag',
        description: 'Operator flagging/dispute events - governance mechanism for reporting misconduct',
        fields: `id lastFlagIndex 
            sponsorship { id stream { idAsString metadata } creator spotAPY totalStakedWei remainingWei operatorCount } 
            target { id owner metadataJsonString valueWithoutEarnings slashingsCount delegatorCount } 
            flagger { id owner metadataJsonString valueWithoutEarnings } 
            flaggingTimestamp result flagResolutionTimestamp votesForKick votesAgainstKick reviewerCount 
            targetStakeAtRiskWei metadata voteStartTimestamp voteEndTimestamp protectionEndTimestamp 
            votes(first: 10) { id voter { id metadataJsonString } votedKick voterWeight timestamp } 
            reviewers(first: 10) { id }`,
        sortFields: [
            { value: 'flaggingTimestamp', label: 'Flagging Date' },
            { value: 'flagResolutionTimestamp', label: 'Resolution Date' },
            { value: 'votesForKick', label: 'Votes For Kick' },
            { value: 'votesAgainstKick', label: 'Votes Against Kick' },
            { value: 'targetStakeAtRiskWei', label: 'Stake at Risk' },
            { value: 'reviewerCount', label: 'Reviewer Count' },
            { value: 'voteStartTimestamp', label: 'Vote Start' },
            { value: 'voteEndTimestamp', label: 'Vote End' },
            { value: 'protectionEndTimestamp', label: 'Protection End' },
            { value: 'lastFlagIndex', label: 'Flag Index' },
        ],
        defaultSort: { field: 'flaggingTimestamp', direction: 'desc' },
        filters: [
            { id: 'flagTargetFilter', field: 'target', label: 'Target Operator', type: 'address', placeholder: '0x...' },
            { id: 'flagTargetContains', field: 'target_contains', label: 'Target Contains', type: 'text', placeholder: '0x...' },
            { id: 'flagFlaggerFilter', field: 'flagger', label: 'Flagger Operator', type: 'address', placeholder: '0x...' },
            { id: 'flagFlaggerContains', field: 'flagger_contains', label: 'Flagger Contains', type: 'text', placeholder: '0x...' },
            { id: 'flagSponsorshipFilter', field: 'sponsorship', label: 'Sponsorship Address', type: 'address', placeholder: '0x...' },
            { id: 'flagSponsorshipContains', field: 'sponsorship_contains', label: 'Sponsorship Contains', type: 'text', placeholder: '0x...' },
            { id: 'flagResult', field: 'result', label: 'Result', type: 'select', options: ['waiting', 'voting', 'kicked', 'failed'] },
            { id: 'flagResolved', field: 'result_in', label: 'Resolved (kicked or failed)', type: 'toggle', value: '["kicked", "failed"]' },
            { id: 'flagMinStakeAtRisk', field: 'targetStakeAtRiskWei_gte', label: 'Min Stake at Risk (DATA)', type: 'wei', placeholder: '1000' },
            { id: 'flagMaxStakeAtRisk', field: 'targetStakeAtRiskWei_lte', label: 'Max Stake at Risk (DATA)', type: 'wei', placeholder: '100000' },
            { id: 'flagMinDate', field: 'flaggingTimestamp_gte', label: 'Flagged After', type: 'datetime', valueType: 'Int' },
            { id: 'flagMaxDate', field: 'flaggingTimestamp_lte', label: 'Flagged Before', type: 'datetime', valueType: 'Int' },
            { id: 'flagMinResolution', field: 'flagResolutionTimestamp_gte', label: 'Resolved After', type: 'datetime', valueType: 'Int' },
            { id: 'flagMaxResolution', field: 'flagResolutionTimestamp_lte', label: 'Resolved Before', type: 'datetime', valueType: 'Int' },
            { id: 'flagMinVotesFor', field: 'votesForKick_gte', label: 'Min Votes For Kick', type: 'number', placeholder: '1' },
            { id: 'flagMinVotesAgainst', field: 'votesAgainstKick_gte', label: 'Min Votes Against Kick', type: 'number', placeholder: '1' },
            { id: 'flagMinReviewers', field: 'reviewerCount_gte', label: 'Min Reviewers', type: 'number', placeholder: '1' },
            { id: 'flagVoteStartAfter', field: 'voteStartTimestamp_gte', label: 'Vote Started After', type: 'datetime', valueType: 'Int' },
            { id: 'flagVoteEndBefore', field: 'voteEndTimestamp_lte', label: 'Vote Ends Before', type: 'datetime', valueType: 'Int' },
        ],
    },
    votes: {
        label: 'Vote',
        category: 'Governance',
        queryType: 'list',
        singularQuery: 'vote',
        description: 'Individual votes cast on flag disputes - governance participation tracking',
        fields: `id 
            flag { id target { id owner metadataJsonString } flagger { id owner metadataJsonString } sponsorship { id stream { idAsString } creator } result flaggingTimestamp flagResolutionTimestamp votesForKick votesAgainstKick targetStakeAtRiskWei } 
            voter { id owner metadataJsonString valueWithoutEarnings delegatorCount totalStakeInSponsorshipsWei isEligibleToVote } 
            voterWeight timestamp votedKick`,
        sortFields: [
            { value: 'timestamp', label: 'Vote Date' },
            { value: 'voterWeight', label: 'Voter Weight' },
            { value: 'votedKick', label: 'Vote Direction' },
            { value: 'id', label: 'ID' },
        ],
        defaultSort: { field: 'timestamp', direction: 'desc' },
        filters: [
            { id: 'voteVoterFilter', field: 'voter', label: 'Voter Operator', type: 'address', placeholder: '0x...' },
            { id: 'voteVoterContains', field: 'voter_contains', label: 'Voter Contains', type: 'text', placeholder: '0x...' },
            { id: 'voteFlagFilter', field: 'flag', label: 'Flag ID', type: 'text', placeholder: 'Flag ID' },
            { id: 'voteFlagContains', field: 'flag_contains', label: 'Flag ID Contains', type: 'text', placeholder: 'flag' },
            { id: 'voteVotedKick', field: 'votedKick', label: 'Voted to Kick', type: 'boolean' },
            { id: 'voteMinWeight', field: 'voterWeight_gte', label: 'Min Voter Weight (DATA)', type: 'wei', placeholder: '1000' },
            { id: 'voteMaxWeight', field: 'voterWeight_lte', label: 'Max Voter Weight (DATA)', type: 'wei', placeholder: '1000000' },
            { id: 'voteMinDate', field: 'timestamp_gte', label: 'Voted After', type: 'datetime', valueType: 'Int' },
            { id: 'voteMaxDate', field: 'timestamp_lte', label: 'Voted Before', type: 'datetime', valueType: 'Int' },
        ],
    },
    // ─────────────────────────────────────────────────
    // QUEUE, NODES & NETWORK
    // ─────────────────────────────────────────────────
    queueEntries: {
        label: 'Queue Entry',
        category: 'Staking',
        queryType: 'list',
        singularQuery: 'queueEntry',
        description: 'Pending undelegation queue entries - funds waiting to be withdrawn from operators',
        fields: `id 
            operator { id owner metadataJsonString valueWithoutEarnings delegatorCount totalStakeInSponsorshipsWei operatorsCutFraction cumulativeEarningsWei } 
            delegator { id totalValueDataWei numberOfDelegations cumulativeEarningsWei } 
            amount date`,
        sortFields: [
            { value: 'date', label: 'Queue Date' },
            { value: 'amount', label: 'Amount' },
            { value: 'id', label: 'ID' },
        ],
        defaultSort: { field: 'date', direction: 'desc' },
        filters: [
            { id: 'queueOperatorFilter', field: 'operator', label: 'Operator Address', type: 'address', placeholder: '0x...' },
            { id: 'queueOperatorContains', field: 'operator_contains', label: 'Operator Contains', type: 'text', placeholder: '0x...' },
            { id: 'queueDelegatorFilter', field: 'delegator', label: 'Delegator Address', type: 'address', placeholder: '0x...' },
            { id: 'queueDelegatorContains', field: 'delegator_contains', label: 'Delegator Contains', type: 'text', placeholder: '0x...' },
            { id: 'queueMinAmount', field: 'amount_gte', label: 'Min Amount (DATA)', type: 'wei', placeholder: '100' },
            { id: 'queueMaxAmount', field: 'amount_lte', label: 'Max Amount (DATA)', type: 'wei', placeholder: '100000' },
            { id: 'queueMinDate', field: 'date_gte', label: 'Queued After', type: 'datetime' },
            { id: 'queueMaxDate', field: 'date_lte', label: 'Queued Before', type: 'datetime' },
            { id: 'queueIdExact', field: 'id', label: 'Queue Entry ID (Exact)', type: 'text', placeholder: '0xoperator-index' },
        ],
    },
    nodes: {
        label: 'Node',
        category: 'Network',
        queryType: 'list',
        singularQuery: 'node',
        description: 'Storage/broker nodes on the network - includes stored streams and activity tracking',
        fields: 'id metadata lastSeen createdAt storedStreams(first: 15) { id idAsString metadata }',
        sortFields: [
            { value: 'id', label: 'ID (Address)' },
            { value: 'lastSeen', label: 'Last Seen' },
            { value: 'createdAt', label: 'Created At' },
        ],
        defaultSort: { field: 'lastSeen', direction: 'desc' },
        filters: [
            { id: 'nodeIdExact', field: 'id', label: 'Node Address (Exact)', type: 'address', placeholder: '0x...' },
            { id: 'nodeMetadataFilter', field: 'metadata_contains_nocase', label: 'Metadata Contains', type: 'text', placeholder: 'version info' },
            { id: 'nodeMetadataNotEmpty', field: 'metadata_not', label: 'Has Metadata (not empty)', type: 'toggle', value: '""' },
            { id: 'nodeMinLastSeenDate', field: 'lastSeen_gte', label: 'Last Seen After', type: 'datetime' },
            { id: 'nodeMaxLastSeenDate', field: 'lastSeen_lte', label: 'Last Seen Before', type: 'datetime' },
            { id: 'nodeMinCreatedAt', field: 'createdAt_gte', label: 'Created After', type: 'datetime' },
            { id: 'nodeMaxCreatedAt', field: 'createdAt_lte', label: 'Created Before', type: 'datetime' },
        ],
    },
    networks: {
        label: 'Networks',
        category: 'Network',
        queryType: 'list',
        singularQuery: 'network',
        description: 'Network configuration and global statistics - includes staking parameters and governance settings',
        fields: `id totalStake totalDelegated totalUndelegated sponsorshipsCount fundedSponsorshipsCount operatorsCount eligibleVotersCount 
            slashingFraction earlyLeaverPenaltyWei minimumDelegationWei minimumSelfDelegationFraction minimumDelegationSeconds minimumStakeWei 
            maxPenaltyPeriodSeconds maxQueueSeconds maxAllowedEarningsFraction fishermanRewardFraction protocolFeeFraction protocolFeeBeneficiary 
            minEligibleVoterAge minEligibleVoterFractionOfAllStake flagReviewerCount flagReviewerRewardWei flaggerRewardWei 
            reviewPeriodSeconds votingPeriodSeconds flagProtectionSeconds`,
        sortFields: [
            { value: 'id', label: 'ID' },
            { value: 'totalStake', label: 'Total Stake' },
            { value: 'totalDelegated', label: 'Total Delegated' },
            { value: 'operatorsCount', label: 'Operators Count' },
            { value: 'sponsorshipsCount', label: 'Sponsorships Count' },
            { value: 'fundedSponsorshipsCount', label: 'Funded Sponsorships' },
            { value: 'eligibleVotersCount', label: 'Eligible Voters' },
        ],
        defaultSort: { field: 'id', direction: 'asc' },
        filters: [
            { id: 'networksIdExact', field: 'id', label: 'Network ID (StreamrConfig address)', type: 'address', placeholder: '0x...' },
            { id: 'networksMinStake', field: 'totalStake_gte', label: 'Min Total Stake (DATA)', type: 'wei', placeholder: '1000000' },
            { id: 'networksMinOperators', field: 'operatorsCount_gte', label: 'Min Operators', type: 'number', placeholder: '10' },
            { id: 'networksMinSponsorships', field: 'sponsorshipsCount_gte', label: 'Min Sponsorships', type: 'number', placeholder: '5' },
        ],
    },
    network: {
        label: 'Network (Single)',
        category: 'Network',
        queryType: 'single',
        singularQuery: 'network',
        description: 'Complete global network configuration and statistics',
        fields: `id 
            totalStake totalDelegated totalUndelegated 
            sponsorshipsCount fundedSponsorshipsCount operatorsCount eligibleVotersCount 
            slashingFraction earlyLeaverPenaltyWei 
            minimumDelegationWei minimumSelfDelegationFraction minimumDelegationSeconds minimumStakeWei
            maxPenaltyPeriodSeconds maxQueueSeconds maxAllowedEarningsFraction 
            fishermanRewardFraction protocolFeeFraction protocolFeeBeneficiary 
            minEligibleVoterAge minEligibleVoterFractionOfAllStake 
            flagReviewerCount flagReviewerRewardWei flaggerRewardWei flagReviewerSelectionIterations flagStakeWei 
            reviewPeriodSeconds votingPeriodSeconds flagProtectionSeconds 
            randomOracle trustedForwarder sponsorshipFactory operatorFactory voterRegistry 
            operatorContractOnlyJoinPolicy streamRegistryAddress`,
        sortFields: [],
        defaultSort: { field: 'id', direction: 'asc' },
        filters: [
            { id: 'networkIdFilter', field: 'id', label: 'Network ID (StreamrConfig address, empty = first)', type: 'address', placeholder: '0x...' },
        ],
        singleIdRequired: true,
        // Without an ID, fall back to the list query and take the first result
        listFallback: 'networks',
    },
    // ─────────────────────────────────────────────────
    // PROJECTS (Marketplace)
    // ─────────────────────────────────────────────────
    projects: {
        label: 'Project',
        category: 'Marketplace',
        queryType: 'list',
        singularQuery: 'project',
        description: 'Marketplace projects with subscriptions, permissions and payment details',
        fields: `id domainIds metadata isDataUnion createdAt updatedAt score stakedWei counter minimumSubscriptionSeconds 
            streams 
            permissions(first: 5) { id userAddress canBuy canEdit canDelete canGrant } 
            paymentDetails(first: 3) { id domainId beneficiary pricingTokenAddress pricePerSecond } 
            subscriptions(first: 5) { id userAddress endTimestamp } 
            purchases(first: 5) { id subscriber price purchasedAt }`,
        sortFields: [
            { value: 'id', label: 'ID' },
            { value: 'createdAt', label: 'Created At' },
            { value: 'updatedAt', label: 'Updated At' },
            { value: 'score', label: 'Score' },
            { value: 'stakedWei', label: 'Staked' },
            { value: 'minimumSubscriptionSeconds', label: 'Min Subscription Duration' },
            { value: 'counter', label: 'Counter' },
        ],
        defaultSort: { field: 'score', direction: 'desc' },
        filters: [
            { id: 'projectIdExact', field: 'id', label: 'Project ID (Exact)', type: 'text', placeholder: '0x...-project-id' },
            { id: 'projectMetadata', field: 'metadata_contains_nocase', label: 'Metadata Contains', type: 'text', placeholder: 'search term' },
            { id: 'projectIsDataUnion', field: 'isDataUnion', label: 'Is Data Union', type: 'boolean' },
            { id: 'projectMinScore', field: 'score_gte', label: 'Min Score', type: 'number', placeholder: '0' },
            { id: 'projectMaxScore', field: 'score_lte', label: 'Max Score', type: 'number', placeholder: '1000' },
            { id: 'projectMinStaked', field: 'stakedWei_gte', label: 'Min Staked (DATA)', type: 'wei', placeholder: '100' },
            { id: 'projectMaxStaked', field: 'stakedWei_lte', label: 'Max Staked (DATA)', type: 'wei', placeholder: '100000' },
            { id: 'projectMinCreatedAt', field: 'createdAt_gte', label: 'Created After', type: 'datetime' },
            { id: 'projectMaxCreatedAt', field: 'createdAt_lte', label: 'Created Before', type: 'datetime' },
            { id: 'projectMinUpdatedAt', field: 'updatedAt_gte', label: 'Updated After', type: 'datetime' },
            { id: 'projectMinCounter', field: 'counter_gte', label: 'Min Counter', type: 'number', placeholder: '0' },
            { id: 'projectMinSubDuration', field: 'minimumSubscriptionSeconds_gte', label: 'Min Subscription Duration (sec)', type: 'number', placeholder: '3600' },
        ],
    },
    projectPermissions: {
        label: 'Project Permission',
        category: 'Marketplace',
        queryType: 'list',
        singularQuery: 'projectPermission',
        description: 'User permissions on marketplace projects (buy, edit, delete, grant)',
        fields: 'id userAddress project { id metadata isDataUnion score createdAt } canBuy canDelete canEdit canGrant',
        sortFields: [
            { value: 'id', label: 'ID' },
            { value: 'userAddress', label: 'User Address' },
            { value: 'project__score', label: 'Project Score' },
            { value: 'project__createdAt', label: 'Project Created At' },
        ],
        defaultSort: { field: 'id', direction: 'asc' },
        filters: [
            { id: 'projPermUserAddress', field: 'userAddress', label: 'User Address', type: 'address', placeholder: '0x...' },
            { id: 'projPermUserAddressContains', field: 'userAddress_contains', label: 'User Address Contains', type: 'text', placeholder: '0x...' },
            { id: 'projPermProjectId', field: 'project', label: 'Project ID', type: 'text', placeholder: 'project-id' },
            { id: 'projPermProjectIdContains', field: 'project_contains', label: 'Project ID Contains', type: 'text', placeholder: 'project' },
            { id: 'projPermCanBuy', field: 'canBuy', label: 'Can Buy', type: 'boolean' },
            { id: 'projPermCanEdit', field: 'canEdit', label: 'Can Edit', type: 'boolean' },
            { id: 'projPermCanDelete', field: 'canDelete', label: 'Can Delete', type: 'boolean' },
            { id: 'projPermCanGrant', field: 'canGrant', label: 'Can Grant', type: 'boolean' },
        ],
    },
    projectSubscriptions: {
        label: 'Project Subscription',
        category: 'Marketplace',
        queryType: 'list',
        singularQuery: 'projectSubscription',
        description: 'Active and expired project subscriptions with expiration tracking',
        fields: 'id project { id metadata isDataUnion score stakedWei } userAddress endTimestamp',
        sortFields: [
            { value: 'id', label: 'ID' },
            { value: 'endTimestamp', label: 'End Date' },
            { value: 'userAddress', label: 'User Address' },
            { value: 'project__score', label: 'Project Score' },
        ],
        defaultSort: { field: 'endTimestamp', direction: 'desc' },
        filters: [
            { id: 'projSubUserAddress', field: 'userAddress', label: 'User Address', type: 'address', placeholder: '0x...' },
            { id: 'projSubUserAddressContains', field: 'userAddress_contains', label: 'User Address Contains', type: 'text', placeholder: '0x...' },
            { id: 'projSubProjectId', field: 'project', label: 'Project ID', type: 'text', placeholder: 'project-id' },
            { id: 'projSubProjectIdContains', field: 'project_contains', label: 'Project ID Contains', type: 'text', placeholder: 'project' },
            { id: 'projSubMinEndDate', field: 'endTimestamp_gte', label: 'Expires After', type: 'datetime' },
            { id: 'projSubMaxEndDate', field: 'endTimestamp_lte', label: 'Expires Before', type: 'datetime' },
            { id: 'projSubActiveOnly', field: 'endTimestamp_gt', label: 'Active Only (not expired)', type: 'toggle', value: () => `"${Math.floor(Date.now() / 1000)}"` },
        ],
    },
    projectPurchases: {
        label: 'Project Purchase',
        category: 'Marketplace',
        queryType: 'list',
        singularQuery: 'projectPurchase',
        description: 'Complete project purchase history with pricing and fees',
        fields: 'id project { id metadata isDataUnion score stakedWei createdAt } subscriber subscriptionSeconds price fee purchasedAt',
        sortFields: [
            { value: 'purchasedAt', label: 'Purchase Date' },
            { value: 'price', label: 'Price' },
            { value: 'fee', label: 'Fee' },
            { value: 'subscriptionSeconds', label: 'Duration' },
            { value: 'subscriber', label: 'Subscriber' },
        ],
        defaultSort: { field: 'purchasedAt', direction: 'desc' },
        filters: [
            { id: 'projPurchaseSubscriber', field: 'subscriber', label: 'Subscriber Address', type: 'address', placeholder: '0x...' },
            { id: 'projPurchaseSubscriberContains', field: 'subscriber_contains', label: 'Subscriber Contains', type: 'text', placeholder: '0x...' },
            { id: 'projPurchaseProjectId', field: 'project', label: 'Project ID', type: 'text', placeholder: 'project-id' },
            { id: 'projPurchaseProjectContains', field: 'project_contains', label: 'Project ID Contains', type: 'text', placeholder: 'project' },
            { id: 'projPurchaseMinDate', field: 'purchasedAt_gte', label: 'Purchased After', type: 'datetime' },
            { id: 'projPurchaseMaxDate', field: 'purchasedAt_lte', label: 'Purchased Before', type: 'datetime' },
            { id: 'projPurchaseMinPrice', field: 'price_gte', label: 'Min Price (tokens)', type: 'wei', placeholder: '1' },
            { id: 'projPurchaseMaxPrice', field: 'price_lte', label: 'Max Price (tokens)', type: 'wei', placeholder: '100' },
            { id: 'projPurchaseMinFee', field: 'fee_gte', label: 'Min Fee (tokens)', type: 'wei', placeholder: '0' },
            { id: 'projPurchaseMinDuration', field: 'subscriptionSeconds_gte', label: 'Min Duration (sec)', type: 'number', placeholder: '86400' },
            { id: 'projPurchaseMaxDuration', field: 'subscriptionSeconds_lte', label: 'Max Duration (sec)', type: 'number', placeholder: '31536000' },
        ],
    },
    projectStakeByUsers: {
        label: 'Project Stake by User',
        category: 'Marketplace',
        queryType: 'list',
        singularQuery: 'projectStakeByUser',
        description: 'Individual user stake positions on marketplace projects',
        fields: 'id project { id metadata isDataUnion score stakedWei createdAt updatedAt } user userStake',
        sortFields: [
            { value: 'id', label: 'ID' },
            { value: 'userStake', label: 'Stake Amount' },
            { value: 'user', label: 'User Address' },
            { value: 'project__score', label: 'Project Score' },
            { value: 'project__stakedWei', label: 'Total Project Stake' },
        ],
        defaultSort: { field: 'userStake', direction: 'desc' },
        filters: [
            { id: 'projStakeUser', field: 'user', label: 'User Address', type: 'address', placeholder: '0x...' },
            { id: 'projStakeUserContains', field: 'user_contains', label: 'User Address Contains', type: 'text', placeholder: '0x...' },
            { id: 'projStakeProjectId', field: 'project', label: 'Project ID', type: 'text', placeholder: 'project-id' },
            { id: 'projStakeProjectContains', field: 'project_contains', label: 'Project ID Contains', type: 'text', placeholder: 'project' },
            { id: 'projStakeMinAmount', field: 'userStake_gte', label: 'Min Stake (DATA)', type: 'wei', placeholder: '100' },
            { id: 'projStakeMaxAmount', field: 'userStake_lte', label: 'Max Stake (DATA)', type: 'wei', placeholder: '100000' },
            { id: 'projStakeNonZero', field: 'userStake_gt', label: 'Stake Greater Than (DATA)', type: 'wei', placeholder: '0' },
        ],
    },
    projectStakingDayBuckets: {
        label: 'Project Staking Day Bucket',
        category: 'Metrics',
        queryType: 'list',
        singularQuery: 'projectStakingDayBucket',
        description: 'Daily staking metrics for projects - track stake changes over time',
        fields: 'id project { id metadata score stakedWei isDataUnion } date stakeAtStart stakeChange stakingsWei unstakingsWei',
        sortFields: [
            { value: 'date', label: 'Date' },
            { value: 'stakeAtStart', label: 'Stake at Start' },
            { value: 'stakeChange', label: 'Stake Change' },
            { value: 'stakingsWei', label: 'Stakings' },
            { value: 'unstakingsWei', label: 'Unstakings' },
        ],
        defaultSort: { field: 'date', direction: 'desc' },
        filters: [
            { id: 'projStakingBucketProjectId', field: 'project', label: 'Project ID', type: 'text', placeholder: 'project-id' },
            { id: 'projStakingBucketProjectContains', field: 'project_contains', label: 'Project ID Contains', type: 'text', placeholder: 'project' },
            { id: 'projStakingBucketMinDate', field: 'date_gte', label: 'From Date', type: 'datetime' },
            { id: 'projStakingBucketMaxDate', field: 'date_lte', label: 'To Date', type: 'datetime' },
            { id: 'projStakingBucketMinStakeStart', field: 'stakeAtStart_gte', label: 'Min Stake at Start (DATA)', type: 'wei', placeholder: '1000' },
            { id: 'projStakingBucketMinStakeChange', field: 'stakeChange_gte', label: 'Min Stake Change (DATA)', type: 'wei', placeholder: '0' },
            { id: 'projStakingBucketMaxStakeChange', field: 'stakeChange_lte', label: 'Max Stake Change (DATA)', type: 'wei', placeholder: '0' },
            { id: 'projStakingBucketMinStakings', field: 'stakingsWei_gte', label: 'Min Stakings (DATA)', type: 'wei', placeholder: '100' },
            { id: 'projStakingBucketMinUnstakings', field: 'unstakingsWei_gte', label: 'Min Unstakings (DATA)', type: 'wei', placeholder: '100' },
        ],
    },
    projectPaymentDetails_collection: {
        label: 'Project Payment Details',
        category: 'Marketplace',
        queryType: 'list',
        singularQuery: 'projectPaymentDetails',
        description: 'Payment configuration for projects - pricing tokens, beneficiaries and rates',
        fields: 'id project { id metadata isDataUnion score stakedWei createdAt } domainId beneficiary pricingTokenAddress pricePerSecond',
        sortFields: [
            { value: 'id', label: 'ID' },
            { value: 'pricePerSecond', label: 'Price Per Second' },
            { value: 'domainId', label: 'Domain ID' },
            { value: 'beneficiary', label: 'Beneficiary' },
        ],
        defaultSort: { field: 'pricePerSecond', direction: 'desc' },
        filters: [
            { id: 'paymentProjectId', field: 'project', label: 'Project ID', type: 'text', placeholder: 'project-id' },
            { id: 'paymentProjectContains', field: 'project_contains', label: 'Project ID Contains', type: 'text', placeholder: 'project' },
            { id: 'paymentBeneficiary', field: 'beneficiary', label: 'Beneficiary Address', type: 'address', placeholder: '0x...' },
            { id: 'paymentBeneficiaryContains', field: 'beneficiary_contains', label: 'Beneficiary Contains', type: 'text', placeholder: '0x...' },
            { id: 'paymentTokenAddress', field: 'pricingTokenAddress', label: 'Pricing Token Address', type: 'address', placeholder: '0x...' },
            { id: 'paymentDomainId', field: 'domainId', label: 'Domain ID', type: 'number', placeholder: '137' },
            { id: 'paymentMinPrice', field: 'pricePerSecond_gte', label: 'Min Price/Second (tokens)', type: 'wei', placeholder: '0' },
            { id: 'paymentMaxPrice', field: 'pricePerSecond_lte', label: 'Max Price/Second (tokens)', type: 'wei', placeholder: '0.001' },
        ],
    },
    // ─────────────────────────────────────────────────
    // SUBGRAPH META
    // ─────────────────────────────────────────────────
    _meta: {
        label: 'Subgraph Meta',
        category: 'Network',
        queryType: 'meta',
        singularQuery: '_meta',
        description: 'Subgraph indexing status - current block, deployment hash and error status',
        fields: 'block { hash number timestamp parentHash } deployment hasIndexingErrors',
        sortFields: [],
        defaultSort: { field: 'id', direction: 'asc' },
        filters: [],
        singleIdRequired: false,
    },
};

// Category display order for the entity navigation
export const CATEGORY_ORDER = ['Network', 'Data', 'Metrics', 'Staking', 'Events', 'Governance', 'Marketplace'];

// Category icons (inner SVG markup, 24x24 viewBox, stroke based)
export const CATEGORY_ICONS = {
    Staking: '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
    Events: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    Governance: '<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>',
    Data: '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/>',
    Network: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    Metrics: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    Marketplace: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
};
