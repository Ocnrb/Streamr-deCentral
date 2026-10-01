/**
 * Production logger - only logs errors to keep console clean
 */
export const logger = {
    log: () => {},   // Silent
    warn: () => {},  // Silent
    error: (...args) => console.error(...args),
    info: () => {},  // Silent
};

/**
 * Creates a debounced function that delays invoking func until after wait milliseconds
 * have elapsed since the last time the debounced function was invoked.
 * @param {Function} func - The function to debounce.
 * @param {number} wait - The number of milliseconds to delay.
 * @returns {Function} The debounced function.
 */
export function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Escapes HTML special characters in a string.
 * @param {string} unsafe - The string to escape.
 * @returns {string} The escaped string.
 */
export function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') {
        return '';
    }
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

/** Text for inside a GraphQL string literal ("..."): quotes, backslashes and control characters escaped (JSON rules) */
export function gqlEscape(value) {
    return JSON.stringify(String(value ?? '')).slice(1, -1);
}

/**
 * Formats a big number string with spaces as thousands separators.
 * @param {string} numStr - The number string to format.
 * @returns {string} The formatted number string.
 */
export const formatBigNumber = (numStr) => {
    if (!numStr) return '0';
    const parts = numStr.toString().split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return parts.join('.');
};

/**
 * Converts a wei string to a DATA token string.
 * @param {string} weiStr - The amount in wei.
 * @param {boolean} [withDecimals=false] - Whether to include decimals in the output.
 * @returns {string} The amount in DATA.
 */
export const convertWeiToData = (weiStr, withDecimals = false) => {
    if (!weiStr || weiStr === '0') return '0';
    try {
        const weiBigInt = BigInt(weiStr);
        const dataDenominator = BigInt('1000000000000000000'); // 10^18
        if (!withDecimals) {
            return (weiBigInt / dataDenominator).toString();
        }
        const dataValue = weiBigInt / dataDenominator;
        const remainder = weiBigInt % dataDenominator;
        const decimals = (remainder * BigInt(100)) / dataDenominator;
        return `${dataValue.toString()}.${decimals.toString().padStart(2, '0')}`;
    } catch (e) {
        console.error("Could not convert wei to DATA:", weiStr, e);
        return 'N/A';
    }
};

/**
 * Calculates the USD value for a given DATA amount and price.
 * @param {string} dataAmountStr - The amount of DATA.
 * @param {number|null} dataPriceUSD - The current price of DATA in USD.
 * @returns {string} The formatted USD value.
 */
export const formatUsdForTooltip = (dataAmountStr, dataPriceUSD) => {
    if (dataPriceUSD === null || !dataAmountStr) return 'Not available';
    const numericDataAmount = parseFloat(dataAmountStr.replace(/ /g, '').replace(',', '.'));
    const usdValue = numericDataAmount * dataPriceUSD;
    if (usdValue < 10) {
        return `~$${usdValue.toFixed(2)}`;
    }
    return `~$${formatBigNumber(Math.round(usdValue))}`;
};

/**
 * Format tooltip with DATA amount and USD value (with line break)
 * @param {string} dataAmountStr - The DATA amount as string
 * @param {number|null} dataPriceUSD - The price of DATA in USD
 * @returns {string} The formatted tooltip content with HTML
 */
export const formatDataWithUsdTooltip = (dataAmountStr, dataPriceUSD) => {
    if (!dataAmountStr) return 'Not available';
    
    let tooltipContent = `${formatBigNumber(dataAmountStr)} DATA`;
    
    if (dataPriceUSD !== null) {
        const numericDataAmount = parseFloat(dataAmountStr.replace(/ /g, '').replace(',', '.'));
        const usdValue = numericDataAmount * dataPriceUSD;
        if (usdValue < 10) {
            tooltipContent += `<br>~$${usdValue.toFixed(2)}`;
        } else {
            tooltipContent += `<br>~$${formatBigNumber(Math.round(usdValue))}`;
        }
    }
    
    return tooltipContent;
};

/**
 * Abbreviate an Ethereum address to a short form.
 * @param {string} address - The Ethereum address.
 * @returns {string} The abbreviated address (0x1234...abcd).
 */
export const shortAddress = (address) => {
    if (!address) return '';
    return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
};

/**
 * Creates an HTML anchor tag for a Polygonscan link.
 * @param {string} address - The Ethereum address.
 * @param {string} [type='address'] - The type of link (e.g., 'address', 'tx').
 * @returns {string} The HTML string for the link.
 */
export const createAddressLink = (address, type = 'address') => {
    if (!address) return '';
    const abbreviated = `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
    const url = `https://polygonscan.com/${type}/${address}`;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-gray-300 hover:text-white transition-colors" title="${escapeHtml(address)}">${abbreviated}</a>`;
};

/**
 * Creates an internal app link to an operator's detail view.
 * @param {object} entity The entity object (e.g., operator, flagger) with id and metadata.
 * @returns {string} The HTML anchor tag.
 */
export function createEntityLink(entity) {
    if (!entity || !entity.id) return 'Unknown';
    const { name } = parseOperatorMetadata(entity.metadataJsonString);
    const address = entity.id;
    const abbreviated = `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
    const displayText = escapeHtml(name || abbreviated);
    const titleText = escapeHtml(name ? `${name} (${address})` : address);
    return `<a href="#" class="text-gray-300 hover:text-white transition-colors operator-link" data-operator-id="${address}" title="${titleText}">${displayText}</a>`;
}

/**
 * Creates an internal app link to a delegator's detail view.
 * @param {string} address The delegator's address.
 * @returns {string} The HTML anchor tag.
 */
export function createDelegatorLink(address) {
    if (!address) return '';
    const abbreviated = `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
    return `<a href="#" class="text-gray-300 hover:text-white transition-colors delegator-link" data-delegator-id="${address}" title="${escapeHtml(address)}">${abbreviated}</a>`;
}

/**
 * Creates an internal app link to a sponsorship details view.
 * @param {object} sponsorship The sponsorship object with id and stream info.
 * @returns {string} The HTML anchor tag.
 */
export function createSponsorshipLink(sponsorship) {
    if (!sponsorship || !sponsorship.id) return '';
    const streamId = sponsorship.stream?.id || sponsorship.id;
    const displayText = escapeHtml(streamId);
    return `<a href="#" class="text-gray-300 hover:text-white transition-colors sponsorship-link" data-sponsorship-id="${sponsorship.id}" data-stream-id="${escapeHtml(streamId)}" title="${displayText}">${displayText}</a>`;
}

/**
 * Validates if a string is a valid IPFS CID (Content Identifier).
 * Supports both CIDv0 (Qm...) and CIDv1 (ba...) formats.
 * @param {string} cid - The CID to validate.
 * @returns {boolean} True if valid, false otherwise.
 */
function isValidIpfsCid(cid) {
    if (typeof cid !== 'string') return false;
    // CIDv0: starts with Qm, 46 chars; CIDv1: starts with b, variable length
    return /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid) || /^b[a-z2-7]{58,}$/.test(cid);
}

// Operator avatar stored in a Streamr stream (see streamAvatar.js)
export const OPERATOR_AVATAR_PLACEHOLDER = 'https://placehold.co/64x64/1E1E1E/a3a3a3?text=OP';
export const AVATAR_STREAM_MARKER = '#avatar-stream=';
const PROFILE_STREAM_ID_REGEX = /^(0x[0-9a-fA-F]{40}|[a-z0-9.-]+\.eth)\/[A-Za-z0-9_.\-\/]+$/;

// IPFS avatars that failed to load are remembered (7 days): the files of most Streamr operator avatars
// are no longer available on IPFS, so they aren't requested again on every render
const DEAD_CIDS_STORAGE_KEY = 'deadIpfsAvatarCids';
const DEAD_CID_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let deadCids = null;

function loadDeadCids() {
    if (deadCids) return deadCids;
    deadCids = new Map();
    try {
        const stored = JSON.parse(localStorage.getItem(DEAD_CIDS_STORAGE_KEY) || '{}');
        const now = Date.now();
        for (const [cid, at] of Object.entries(stored)) {
            if (typeof at === 'number' && now - at < DEAD_CID_TTL_MS) deadCids.set(cid, at);
        }
    } catch (e) { /* storage unavailable */ }
    return deadCids;
}

export function isDeadIpfsCid(cid) {
    return loadDeadCids().has(cid);
}

export function markDeadIpfsCid(cid) {
    if (!isValidIpfsCid(cid)) return;
    const cids = loadDeadCids();
    cids.set(cid, Date.now());
    try {
        localStorage.setItem(DEAD_CIDS_STORAGE_KEY, JSON.stringify(Object.fromEntries(cids)));
    } catch (e) { /* storage unavailable */ }
}

/**
 * CID of an IPFS avatar URL (thumbnail or gateway), or null
 */
export function ipfsCidFromAvatarUrl(url) {
    const match = typeof url === 'string' && url.match(/ipfs(?:%2F|\/)((?:Qm[1-9A-HJ-NP-Za-km-z]{44})|(?:b[a-z2-7]{58,}))/);
    return match ? match[1] : null;
}

/**
 * IPFS avatar as a small square thumbnail through the wsrv.nl image proxy (as the Network Map does):
 * the gateway serves the original file, often large, which is slow in lists
 */
export function ipfsAvatarUrl(cid, size = 160) {
    return `https://wsrv.nl/?url=${encodeURIComponent(`https://ipfs.io/ipfs/${cid}`)}&w=${size}&h=${size}&fit=cover&output=webp`;
}

/**
 * The one operator avatar <img> used across the app. Priority: IPFS CID (official) > avatar stream
 * (resolved by the hydrator in streamAvatar.js) > placeholder.
 * @param {string|null} imageUrl - from parseOperatorMetadata (may carry the avatar stream marker)
 * @param {Object} [options]
 * @param {string} [options.className] - size and extra classes (e.g. 'w-8 h-8 border border-[#333]')
 * @param {string} [options.alt]
 * @param {string} [options.attrs] - extra raw attributes (already escaped)
 */
export function avatarImgHtml(imageUrl, { className = 'w-8 h-8', alt = '', attrs = '' } = {}) {
    const src = typeof imageUrl === 'string' && imageUrl.startsWith('https://') ? imageUrl : OPERATOR_AVATAR_PLACEHOLDER;
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" onerror="if (window.__avatarFallback) { window.__avatarFallback(this); } else { this.onerror = null; this.src = '${OPERATOR_AVATAR_PLACEHOLDER}'; }" class="rounded-full object-cover flex-shrink-0 bg-[#1E1E1E] ${className}" ${attrs}>`;
}

/**
 * Operator avatar <img> from the operator's metadata JSON (see avatarImgHtml)
 */
export function operatorAvatarHtml(metadataJsonString, options) {
    return avatarImgHtml(parseOperatorMetadata(metadataJsonString).imageUrl, options);
}

export function isValidProfileStreamId(streamId) {
    return typeof streamId === 'string' && streamId.length <= 255 && PROFILE_STREAM_ID_REGEX.test(streamId);
}

/**
 * Parses the operator's metadata JSON string.
 * Includes protection against prototype pollution attacks.
 * @param {string} metadataJsonString The raw JSON string from The Graph.
 * @returns {{name: string|null, description: string|null, imageUrl: string|null}}
 */
export function parseOperatorMetadata(metadataJsonString) {
    try {
        if (metadataJsonString) {
            const metadata = JSON.parse(metadataJsonString);
            
            // Protection against prototype pollution
            const hasDangerousProto = Object.prototype.hasOwnProperty.call(metadata, '__proto__');
            const hasDangerousConstructor = Object.prototype.hasOwnProperty.call(metadata, 'constructor');
            const hasDangerousPrototype = Object.prototype.hasOwnProperty.call(metadata, 'prototype');

            if (hasDangerousProto || hasDangerousConstructor || hasDangerousPrototype) {
                console.warn('Potential prototype pollution attempt detected in metadata.');
                return { name: null, description: null, imageUrl: null };
            }
            
            // Avatar priority: IPFS CID (official) > profile stream (imageStreamId) > placeholder.
            // A stream avatar is signalled with a URL fragment that the avatar hydrator (streamAvatar.js)
            // resolves: right away when there is no CID, or when the IPFS image fails to load.
            let imageUrl = null;
            if (metadata.imageIpfsCid && isValidIpfsCid(metadata.imageIpfsCid) && !isDeadIpfsCid(metadata.imageIpfsCid)) {
                imageUrl = ipfsAvatarUrl(metadata.imageIpfsCid);
            }
            if (isValidProfileStreamId(metadata.imageStreamId)) {
                const partition = Number.isInteger(metadata.imageStreamPartition) ? metadata.imageStreamPartition : 0;
                imageUrl = `${imageUrl || OPERATOR_AVATAR_PLACEHOLDER}${AVATAR_STREAM_MARKER}${encodeURIComponent(metadata.imageStreamId)}:${partition}`;
            }
            
            return {
                name: metadata.name || null,
                description: metadata.description || null,
                imageUrl: imageUrl
            };
        }
    } catch (e) { /* ignore */ }
    return { name: null, description: null, imageUrl: null };
}

/**
 * Provides a user-friendly error message from a transaction error object.
 * @param {Error} error - The error object from ethers.js or wallet.
 * @returns {string} A user-friendly error message.
 */
export function getFriendlyErrorMessage(error) {
    if (error.code === 4001) {
        return 'Transaction rejected in your wallet.';
    }
    if (error.reason) {
        if (error.reason.toLowerCase().includes('slash')) {
            return 'Operation failed. The operator may have been slashed.';
        }
        if (error.reason.toLowerCase().includes('minimum')) {
            return 'Operation failed. The amount may be less than the required minimum.';
        }
         if (error.reason.toLowerCase().includes('capacity')) {
            return 'Operation failed. The operator may be at full capacity.';
        }
        return `Transaction failed: ${error.reason}`;
    }
    if (error.data && error.data.message) {
        return `Transaction failed: ${error.data.message}`;
    }
     if (error.message) {
        return error.message;
    }
    return 'An unknown error occurred.';
}

/**
 * Calculates the weighted APY for an operator based on their stakes.
 * @param {Array} stakes - The operator's stakes array from The Graph.
 * @returns {number} The calculated weighted APY.
 */
export function calculateWeightedApy(stakes) {
    if (!stakes || stakes.length === 0) return 0;
    let weightedApySum = 0;
    let totalStakeInSponsorships = 0;
    for (const stake of stakes) {
        if (stake.sponsorship?.spotAPY) {
            const stakeAmount = Number(stake.amountWei);
            const apy = Number(stake.sponsorship.spotAPY);
            weightedApySum += stakeAmount * apy;
            totalStakeInSponsorships += stakeAmount;
        }
    }
    return totalStakeInSponsorships > 0 ? weightedApySum / totalStakeInSponsorships : 0;
}

/**
 * Parses a non-standard date string from the CSV.
 * Format: "d/MM/yy HH:mm" (e.g., "4/11/25 16:14")
 * @param {string} dateString The date string from the CSV.
 * @returns {Date|null} The parsed Date object or null if invalid.
 */
export function parseDateFromCsv(dateString) {
    if (!dateString) return null;

    try {
        const trimmed = dateString.trim();
        const parts = trimmed.split(' '); // [ "30/11/25", "00:00" ]
        if (parts.length !== 2) return null;

        const dateParts = parts[0].split('/'); // [ "30", "11", "25" ]
        const timeParts = parts[1].split(':'); // [ "00", "00" ]

        if (dateParts.length !== 3 || timeParts.length !== 2) return null;

        const day = parseInt(dateParts[0], 10);
        const month = parseInt(dateParts[1], 10) - 1; // JS months are 0-indexed
        const year = 2000 + parseInt(dateParts[2], 10); // "25" -> 2025
        const hour = parseInt(timeParts[0], 10);
        const minute = parseInt(timeParts[1], 10);

        if (isNaN(day) || isNaN(month) || isNaN(year) || isNaN(hour) || isNaN(minute)) {
            return null;
        }

        return new Date(Date.UTC(year, month, day, hour, minute));
    } catch (e) {
        console.error("Failed to parse CSV date:", dateString, e);
        return null;
    }
}

