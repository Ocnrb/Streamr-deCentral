/**
 * Web Worker for parsing CSV price data
 * Offloads CSV parsing from main thread to prevent UI blocking
 */

/**
 * Parse date string from CSV format to UTC timestamp
 * Supports formats: "Dec 07, 2024", "2024-12-07", or "30/11/25 00:00"
 */
function parseDateFromCsv(dateString) {
    if (!dateString) return null;
    
    // Try "30/11/25 00:00" format (DD/MM/YY HH:mm)
    const ddmmyyMatch = dateString.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+\d{2}:\d{2}$/);
    if (ddmmyyMatch) {
        const day = parseInt(ddmmyyMatch[1], 10)-1;
        const month = parseInt(ddmmyyMatch[2], 10) - 1; // 0-indexed
        let year = parseInt(ddmmyyMatch[3], 10);
        // Convert 2-digit year to 4-digit (assuming 2000s)
        year = year < 100 ? 2000 + year : year;
        return Date.UTC(year, month, day);
    }
    
    // Try "Dec 07, 2024" format
    const monthNames = {
        'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
        'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
    };
    
    const match = dateString.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
    if (match) {
        const month = monthNames[match[1]];
        const day = parseInt(match[2], 10)-1;
        const year = parseInt(match[3], 10);
        if (month !== undefined) {
            return Date.UTC(year, month, day);
        }
    }
    
    // Try ISO format "2024-12-07"
    const isoMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
        const year = parseInt(isoMatch[1], 10);
        const month = parseInt(isoMatch[2], 10) - 1;
        const day = parseInt(isoMatch[3], 10)-1;
        return Date.UTC(year, month, day);
    }
    
    return null;
}

/**
 * Process CSV text and extract price data
 * @param {string} csvText - Raw CSV content
 * @returns {Array} Array of [timestamp, price] entries for Map construction
 */
function processCSV(csvText) {
    const lines = csvText.split('\n').slice(1); // Skip header
    const priceEntries = [];
    
    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue; // Skip empty lines
        
        const parts = trimmedLine.split(',');
        if (parts.length < 2) continue;
        
        const dateStr = parts[0].trim();
        const priceStr = parts[1].trim();
        
        if (dateStr && priceStr) {
            const dateMs = parseDateFromCsv(dateStr);
            const price = parseFloat(priceStr);
            
            if (dateMs !== null && !isNaN(price)) {
                // Convert to day start timestamp in seconds
                const dayTimestampSeconds = Math.floor(dateMs / 1000);
                
                // Check if we already have an entry for this day
                const existingIndex = priceEntries.findIndex(([ts]) => ts === dayTimestampSeconds);
                
                if (existingIndex >= 0) {
                    // Keep the higher price
                    if (price > priceEntries[existingIndex][1]) {
                        priceEntries[existingIndex][1] = price;
                    }
                } else {
                    priceEntries.push([dayTimestampSeconds, price]);
                }
            }
        }
    }
    
    return priceEntries;
}

// Handle messages from main thread
self.onmessage = function(e) {
    const { csvText } = e.data;
    
    try {
        const startTime = performance.now();
        const priceEntries = processCSV(csvText);
        const processingTime = performance.now() - startTime;
        
        self.postMessage({
            success: true,
            priceEntries,
            count: priceEntries.length,
            processingTime: processingTime.toFixed(2)
        });
    } catch (error) {
        self.postMessage({
            success: false,
            error: error.message
        });
    }
};
