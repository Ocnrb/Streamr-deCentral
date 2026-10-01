/**
 * Race Data Processor Web Worker
 * Offloads heavy timeline data processing from main thread
 * 
 * Handles:
 * - Building timeline data structure from raw buckets
 * - Sorting and ranking operators
 * - Filtering deprecated operators
 */

const DISPLAY_COUNT = 30;

/**
 * Format date timestamp to readable string
 * @param {number} timestamp - Unix timestamp in seconds
 * @returns {string} Formatted date string
 */
function formatDate(timestamp) {
    return new Date(timestamp * 1000).toLocaleDateString('en-US', { 
        year: 'numeric', month: 'short', day: 'numeric' 
    }).replace(',', '');
}

/**
 * Process raw bucket data into timeline frames
 * This is the heavy computation moved off the main thread
 * 
 * @param {Array} buckets - Raw bucket data from GraphQL
 * @param {Array} operatorIds - List of operator IDs to process
 * @param {Object} operatorMetaMap - Metadata for operators (name, color)
 * @param {boolean} filterDeprecated - Whether to filter out deprecated operators
 * @returns {Array} Processed timeline data frames
 */
function processTimeline(buckets, operatorIds, operatorMetaMap, filterDeprecated) {
    const startTime = performance.now();
    
    const bucketsByDate = {};
    const uniqueDates = new Set();
    const blacklist = ['old', 'testnet', 'deprecated'];

    // Group buckets by date
    for (const b of buckets) {
        const d = parseInt(b.date);
        uniqueDates.add(d);
        if (!bucketsByDate[d]) bucketsByDate[d] = {};
        bucketsByDate[d][b.operator.id] = {
            stake: b.valueWithoutEarnings,
            earnings: b.cumulativeEarningsWei
        };
    }

    const sortedDates = Array.from(uniqueDates).sort((a, b) => a - b);
    
    if (sortedDates.length === 0) {
        throw new Error("No data found");
    }

    // Initialize last known values for all operators
    const lastKnownValues = {};
    for (const id of operatorIds) {
        lastKnownValues[id] = { stake: '0', earnings: '0' };
    }

    // Process each date into a timeline frame
    const timelineData = [];
    
    for (const date of sortedDates) {
        const daysData = bucketsByDate[date];
        
        // Update last known values with this day's data
        if (daysData) {
            for (const opId of Object.keys(daysData)) {
                if (daysData[opId].stake) lastKnownValues[opId].stake = daysData[opId].stake;
                if (daysData[opId].earnings) lastKnownValues[opId].earnings = daysData[opId].earnings;
            }
        }

        // Filter operators based on metadata and deprecated flag
        const validOperatorIds = operatorIds.filter(id => {
            if (!operatorMetaMap[id]) return false;
            if (filterDeprecated) {
                const name = operatorMetaMap[id].name.toLowerCase();
                return !blacklist.some(word => name.includes(word));
            }
            return true;
        });

        // Create rankings for stake metric
        const rankingsStake = validOperatorIds
            .map(id => ({
                id: id,
                valueWei: lastKnownValues[id].stake,
                floatValue: parseFloat(lastKnownValues[id].stake),
                name: operatorMetaMap[id].name,
                color: operatorMetaMap[id].color
            }))
            .sort((a, b) => b.floatValue - a.floatValue)
            .slice(0, DISPLAY_COUNT);

        // Create rankings for earnings metric
        const rankingsEarnings = validOperatorIds
            .map(id => ({
                id: id,
                valueWei: lastKnownValues[id].earnings,
                floatValue: parseFloat(lastKnownValues[id].earnings),
                name: operatorMetaMap[id].name,
                color: operatorMetaMap[id].color
            }))
            .sort((a, b) => b.floatValue - a.floatValue)
            .slice(0, DISPLAY_COUNT);

        timelineData.push({
            date: date,
            formattedDate: formatDate(date),
            stake: rankingsStake,
            earnings: rankingsEarnings
        });
    }

    const processingTime = (performance.now() - startTime).toFixed(2);
    
    return {
        timelineData,
        processingTime,
        frameCount: timelineData.length
    };
}

/**
 * Handle messages from main thread
 */
self.onmessage = function(e) {
    const { type, buckets, operatorIds, operatorMetaMap, filterDeprecated } = e.data;
    
    try {
        if (type === 'process') {
            const result = processTimeline(buckets, operatorIds, operatorMetaMap, filterDeprecated);
            
            self.postMessage({
                success: true,
                timelineData: result.timelineData,
                processingTime: result.processingTime,
                frameCount: result.frameCount
            });
        }
    } catch (error) {
        self.postMessage({
            success: false,
            error: error.message
        });
    }
};
