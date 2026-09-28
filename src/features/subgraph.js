/**
 * Subgraph Feature Module
 * Query builder for every entity of the Streamr network subgraph (ported from Streamr Subgraph Explorer).
 * Uses the app-wide The Graph API key (Constants.getGraphUrl).
 */

import { getGraphUrl } from '../core/constants.js';
import * as UI from '../ui/ui.js';
import { navigationController } from '../ui/navigation.js';
import { ENTITY_CONFIG, CATEGORY_ORDER, CATEGORY_ICONS } from './subgraphEntities.js';

const DEFAULT_ENTITY = 'operators';
const MAX_RETRIES = 5;

// ============================================
// State Management
// ============================================

const state = {
    initialized: false,
    entityName: DEFAULT_ENTITY,
    isManualOverride: false,
    lastResultCount: 0,
    lastJson: '',
    requestId: 0,
};

const el = (id) => document.getElementById(id);

// ============================================
// Value Conversion & Formatting
// ============================================

/**
 * Converts a datetime-local string (YYYY-MM-DDThh:mm) to a Unix timestamp (seconds).
 */
function dateToTimestamp(dateString) {
    if (!dateString) return null;
    const time = new Date(dateString).getTime();
    return Number.isNaN(time) ? null : Math.floor(time / 1000).toString();
}

/**
 * Converts a human-readable DATA amount (e.g. "1.5", "-0.5") to a wei string.
 */
function dataToWei(dataAmount) {
    if (!dataAmount) return null;
    try {
        const DECIMAL_PLACES = 18;
        // Keep the sign apart so negative decimals (e.g. -0.5) convert correctly
        const isNegative = dataAmount.trim().startsWith('-');
        const unsignedAmount = dataAmount.trim().replace(/^[-+]/, '');
        const [integerPartStr, fractionalPartStr] = unsignedAmount.split('.').concat('');

        const integerWei = BigInt(integerPartStr || '0') * (10n ** BigInt(DECIMAL_PLACES));
        let fractionalWei = 0n;
        if (fractionalPartStr) {
            const trimmedFractional = fractionalPartStr.slice(0, DECIMAL_PLACES);
            fractionalWei = BigInt(trimmedFractional) * (10n ** BigInt(DECIMAL_PLACES - trimmedFractional.length));
        }
        const totalWei = integerWei + fractionalWei;
        return (isNegative ? -totalWei : totalWei).toString();
    } catch (e) {
        return null;
    }
}

/**
 * Formats a wei amount as DATA (up to 4 decimals).
 */
function formatWei(wei) {
    if (!wei) return '0';
    try {
        const WEI_PER_UNIT = 10n ** 18n;
        const value = BigInt(wei);
        if (value >= WEI_PER_UNIT * 1000000000000n) {
            return `(BigInt) ${wei.toString().slice(0, 10)}...`;
        }
        const integerPart = value / WEI_PER_UNIT;
        const fractional = (value % WEI_PER_UNIT).toString().padStart(18, '0').replace(/0+$/, '').slice(0, 4);
        return fractional ? `${integerPart}.${fractional}` : integerPart.toString();
    } catch (e) {
        return `(Wei) ${wei}`;
    }
}

/**
 * Formats a Unix timestamp (seconds) as a readable local date.
 */
function formatTimestamp(timestamp) {
    if (!timestamp) return 'N/A';
    const date = new Date(parseInt(timestamp) * 1000);
    return Number.isNaN(date.getTime()) ? `(Timestamp) ${timestamp}` : date.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short'
    });
}

/**
 * Adds *_formatted (DATA) and *_formatted_date fields next to raw values, recursively.
 */
function addFormattedFields(obj) {
    for (const key of Object.keys(obj)) {
        const value = obj[key];
        const lowerKey = key.toLowerCase();
        if ((key.endsWith('Wei') || key === 'amount' || lowerKey.includes('value'))
            && String(value).length > 10 && /^-?\d+$/.test(String(value))) {
            obj[`${key}_formatted`] = formatWei(value);
        }
        if ((lowerKey.includes('timestamp') || lowerKey.includes('date') || lowerKey.includes('createdat') || lowerKey.includes('lastseen'))
            && String(value).length <= 10 && /^\d+$/.test(String(value))) {
            obj[`${key}_formatted_date`] = formatTimestamp(value);
        }
        if (Array.isArray(value)) {
            value.forEach(child => { if (child && typeof child === 'object') addFormattedFields(child); });
        } else if (value && typeof value === 'object') {
            addFormattedFields(value);
        }
    }
    if (obj.operator?.operatorsCutFraction) {
        const cut = formatWei(obj.operator.operatorsCutFraction);
        obj.operator.operatorsCutFraction_formatted_percent = `${(parseFloat(cut) * 100).toFixed(2)}%`;
    }
    if (obj.sponsorship?.spotAPY) {
        obj.sponsorship.spotAPY_formatted_percent = `${(parseFloat(obj.sponsorship.spotAPY) * 100).toFixed(2)}%`;
    }
    return obj;
}

// ============================================
// Filters
// ============================================

const INPUT_CLASS = 'w-full p-2.5 bg-[#121212] border border-[#333333] rounded-lg text-white text-sm placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 transition-all';

/**
 * Generates the HTML for one filter input based on its type.
 */
function generateFilterInput(filter) {
    const placeholder = filter.placeholder || '';
    let inputHtml;

    switch (filter.type) {
        case 'text':
        case 'address':
            inputHtml = `<input type="text" id="${filter.id}" class="${INPUT_CLASS} ${filter.type === 'address' ? 'font-mono' : ''}" placeholder="${placeholder}">`;
            break;
        case 'number':
            inputHtml = `<input type="number" id="${filter.id}" step="${filter.step || '1'}" class="${INPUT_CLASS}" placeholder="${placeholder}">`;
            break;
        case 'wei':
            inputHtml = `<input type="text" id="${filter.id}" class="${INPUT_CLASS}" placeholder="${placeholder}" title="Amount in tokens (converted to wei)">`;
            break;
        case 'fraction':
            inputHtml = `<input type="number" id="${filter.id}" step="0.0001" min="0" max="1" class="${INPUT_CLASS}" placeholder="${placeholder}" title="Value between 0 and 1">`;
            break;
        case 'datetime':
            inputHtml = `<input type="datetime-local" id="${filter.id}" class="${INPUT_CLASS} [color-scheme:dark]">`;
            break;
        case 'boolean':
            inputHtml = `
                <select id="${filter.id}" class="${INPUT_CLASS}">
                    <option value="">-- Any --</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                </select>`;
            break;
        case 'toggle':
            // Applies a fixed condition (filter.value) when set to "Yes"
            inputHtml = `
                <select id="${filter.id}" class="${INPUT_CLASS}">
                    <option value="">-- Any --</option>
                    <option value="on">Yes</option>
                </select>`;
            break;
        case 'select':
            inputHtml = `
                <select id="${filter.id}" class="${INPUT_CLASS}">
                    <option value="">-- Any --</option>
                    ${filter.options.map(opt => `<option value="${opt}">${opt}</option>`).join('')}
                </select>`;
            break;
        default:
            inputHtml = `<input type="text" id="${filter.id}" class="${INPUT_CLASS}" placeholder="${placeholder}">`;
    }

    return `
        <div class="w-full">
            <label for="${filter.id}" class="block text-xs font-medium text-gray-500 mb-1.5">${filter.label}</label>
            ${inputHtml}
        </div>`;
}

/**
 * Builds the `where` clause contents from the filter inputs.
 */
function getFilterWhereClause(config) {
    if (!config?.filters) return '';
    const filters = [];

    config.filters.forEach(filter => {
        const element = el(filter.id);
        if (!element) return;
        const rawValue = element.value.trim();
        if (!rawValue) return;

        let filterString = '';
        switch (filter.type) {
            case 'address':
                filterString = `${filter.field}: "${rawValue.toLowerCase()}"`;
                break;
            case 'text': {
                // Case-sensitive contains on addresses/ids expects lowercase
                const value = filter.field.includes('_contains') && !filter.field.includes('nocase') ? rawValue.toLowerCase() : rawValue;
                filterString = `${filter.field}: "${value.replace(/"/g, '\\"')}"`;
                break;
            }
            case 'number':
                if (!Number.isNaN(Number(rawValue))) filterString = `${filter.field}: ${rawValue}`;
                break;
            case 'wei': {
                const weiValue = dataToWei(rawValue);
                if (weiValue) filterString = `${filter.field}: "${weiValue}"`;
                break;
            }
            case 'fraction': {
                const fraction = parseFloat(rawValue);
                if (!Number.isNaN(fraction) && fraction >= 0 && fraction <= 1) {
                    filterString = `${filter.field}: "${BigInt(Math.round(fraction * 1e18)).toString()}"`;
                }
                break;
            }
            case 'datetime': {
                const timestamp = dateToTimestamp(rawValue);
                if (timestamp) {
                    // Int fields must be sent as numbers, BigInt fields as strings
                    filterString = filter.valueType === 'Int' ? `${filter.field}: ${timestamp}` : `${filter.field}: "${timestamp}"`;
                }
                break;
            }
            case 'boolean':
                if (rawValue === 'true' || rawValue === 'false') filterString = `${filter.field}: ${rawValue}`;
                break;
            case 'toggle':
                if (rawValue === 'on') {
                    const value = typeof filter.value === 'function' ? filter.value() : filter.value;
                    filterString = `${filter.field}: ${value}`;
                }
                break;
            case 'select':
                if (filter.options.includes(rawValue)) filterString = `${filter.field}: "${rawValue}"`;
                break;
            default:
                filterString = `${filter.field}: "${rawValue.replace(/"/g, '\\"')}"`;
        }
        if (filterString) filters.push(filterString);
    });

    return filters.join(', ');
}

// ============================================
// Query Generation
// ============================================

function getAutoGeneratedQuery() {
    const entityName = state.entityName;
    const config = ENTITY_CONFIG[entityName];
    if (!config) return `# Unknown entity: ${entityName}`;

    const queryName = config.label.replace(/[\s()]/g, '');

    if (config.queryType === 'meta') {
        return `query GetSubgraphMeta {\n    _meta {\n        ${config.fields}\n    }\n}`;
    }

    if (config.queryType === 'single') {
        const idFilter = (config.filters || []).find(f => f.field === 'id');
        const id = idFilter ? el(idFilter.id)?.value.trim().toLowerCase() : '';

        if (id) {
            return `query Get${queryName} {\n    ${config.singularQuery}(id: "${id}", subgraphError: allow) {\n        ${config.fields}\n    }\n}`;
        }
        if (config.listFallback) {
            return `# No ID provided: returning the first ${config.label} from the list query\nquery Get${queryName} {\n    ${config.listFallback}(first: 1, subgraphError: allow) {\n        ${config.fields}\n    }\n}`;
        }
        return `# Please provide an ID in the filter to query ${config.label}\nquery Get${queryName} {\n    ${config.singularQuery}(id: "YOUR_ID_HERE", subgraphError: allow) {\n        ${config.fields}\n    }\n}`;
    }

    const limit = Math.min(Math.max(parseInt(el('sg-limit').value) || 10, 1), 1000);
    const skip = Math.max(parseInt(el('sg-skip').value) || 0, 0);
    const args = [
        `first: ${limit}`,
        `skip: ${skip}`,
        `orderBy: ${el('sg-order-by').value}`,
        `orderDirection: ${el('sg-order-direction').value}`,
    ];
    const where = getFilterWhereClause(config);
    if (where) args.push(`where: {${where}}`);
    args.push('subgraphError: allow');

    return `query Get${queryName}s {\n    ${entityName}(${args.join(', ')}) {\n        ${config.fields}\n    }\n}`;
}

// ============================================
// Rendering
// ============================================

/**
 * Renders the entity navigation (right panel) and the entity select (mobile).
 */
function renderEntityNavigation() {
    const select = el('sg-entity-select');
    const nav = el('sg-entity-nav');
    select.innerHTML = '';
    nav.innerHTML = '';

    const categories = {};
    Object.entries(ENTITY_CONFIG).forEach(([key, config]) => {
        (categories[config.category] ||= []).push({ key, ...config });
    });

    CATEGORY_ORDER.forEach((category, index) => {
        if (!categories[category]) return;

        const optgroup = document.createElement('optgroup');
        optgroup.label = category;

        let navHtml = `
            ${index > 0 ? '<div class="my-3 mx-3 border-t border-white/[0.04]"></div>' : ''}
            <div class="px-3 pt-2 pb-1 flex items-center gap-2">
                <svg class="w-3.5 h-3.5 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${CATEGORY_ICONS[category] || ''}</svg>
                <span class="text-[10px] font-semibold text-gray-600 uppercase tracking-widest">${category}</span>
            </div>`;

        categories[category].forEach(entity => {
            const option = document.createElement('option');
            option.value = entity.key;
            option.textContent = entity.label;
            optgroup.appendChild(option);

            // Internal link: handled by the app router (/subgraph/:entity)
            navHtml += `
                <a href="/subgraph/${entity.key}" data-entity="${entity.key}" title="${entity.description}"
                   class="nav-link flex items-center px-3 py-2 rounded-md text-sm font-medium text-gray-400 hover:text-white hover:bg-white/[0.03] transition-all duration-200">
                    ${entity.label}
                </a>`;
        });

        select.appendChild(optgroup);
        nav.insertAdjacentHTML('beforeend', `<div class="px-2 space-y-0.5">${navHtml}</div>`);
    });
}

/**
 * Renders header, sorting and filter inputs for the current entity.
 */
function renderEntity() {
    const config = ENTITY_CONFIG[state.entityName];
    state.isManualOverride = false;
    state.lastResultCount = 0;

    el('sg-entity-select').value = state.entityName;
    el('sg-entity-title').textContent = config.label;
    el('sg-entity-category').textContent = config.category;
    el('sg-entity-description').textContent = config.description;
    document.querySelectorAll('#sg-entity-nav .nav-link').forEach(link => {
        link.classList.toggle('active', link.dataset.entity === state.entityName);
    });
    navigationController.updatePageTitle('subgraph', `Subgraph · ${config.label}`);

    // Sorting options
    const sortFields = config.sortFields?.length ? config.sortFields : [{ value: 'id', label: 'ID' }];
    el('sg-order-by').innerHTML = sortFields
        .map(f => `<option value="${f.value}" ${config.defaultSort?.field === f.value ? 'selected' : ''}>${f.label}</option>`)
        .join('');
    el('sg-order-direction').value = config.defaultSort?.direction || 'desc';
    el('sg-skip').value = 0;

    // Pagination and sorting only apply to list queries
    el('sg-list-options').classList.toggle('hidden', config.queryType !== 'list');

    // Filters
    const container = el('sg-filters');
    if (config.queryType === 'meta') {
        container.innerHTML = `
            <p class="text-sm text-gray-400">This query returns subgraph metadata.</p>
            <p class="text-xs text-gray-500 mt-1">No filters needed: returns the current indexing status and block information.</p>`;
    } else if (!config.filters?.length) {
        container.innerHTML = '<p class="text-sm text-gray-500">No filters available for this entity.</p>';
    } else {
        let html = `<div class="grid grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2 gap-3">${config.filters.map(generateFilterInput).join('')}</div>`;
        if (config.queryType === 'single') {
            const hint = config.listFallback
                ? 'Enter an ID to fetch a specific record, or leave it empty to get the first one.'
                : 'This entity requires an ID for lookup.';
            html = `
                <div class="mb-4 p-3 rounded-lg bg-blue-500/10 border border-blue-500/30">
                    <p class="text-sm text-blue-300"><strong>Single entity query.</strong> ${hint}</p>
                </div>` + html;
        }
        container.innerHTML = html;
        config.filters.forEach(filter => {
            if (filter.defaultValue && el(filter.id)) el(filter.id).value = filter.defaultValue;
        });
    }

    updateQueryPreview();
}

/**
 * Regenerates the GraphQL preview unless the user edited it manually.
 */
function updateQueryPreview() {
    const textarea = el('sg-query');
    const autoQuery = getAutoGeneratedQuery().trim();

    if (!state.isManualOverride || textarea.value.trim() === autoQuery) {
        state.isManualOverride = false;
        textarea.value = autoQuery;
    }
    el('sg-manual-hint').classList.toggle('hidden', !state.isManualOverride);
    el('sg-reset-query').classList.toggle('hidden', !state.isManualOverride);

    // Active filter badge
    const count = [...document.querySelectorAll('#sg-filters input, #sg-filters select')].filter(i => i.value.trim() !== '').length;
    el('sg-filter-count').textContent = count;
    el('sg-filter-count').classList.toggle('hidden', count === 0);
    el('sg-clear-filters').classList.toggle('hidden', count === 0);

    updateButtons();
}

function updateButtons() {
    const config = ENTITY_CONFIG[state.entityName];
    const limit = parseInt(el('sg-limit').value) || 10;
    const skip = parseInt(el('sg-skip').value) || 0;
    const isList = config?.queryType === 'list';

    el('sg-execute').disabled = el('sg-query').value.trim() === '';
    el('sg-prev').disabled = !isList || state.isManualOverride || skip <= 0;
    el('sg-next').disabled = !isList || state.isManualOverride || state.lastResultCount < limit;
}

function renderLoading() {
    el('sg-output').innerHTML = `
        <div class="flex items-center justify-center py-16">
            <div class="loader rounded-full border-4 border-[#555555] border-t-transparent h-8 w-8"></div>
        </div>`;
    el('sg-result-meta').textContent = '';
    el('sg-error').classList.add('hidden');
    el('sg-copy').classList.add('hidden');
    el('sg-copy').classList.remove('flex');
}

// ============================================
// Execution
// ============================================

async function fetchWithRetry(query) {
    let response;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            response = await fetch(getGraphUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ query }),
            });
            if (response.status !== 429) return response;
        } catch (e) {
            console.error(`Subgraph query attempt ${attempt + 1} failed:`, e);
        }
        if (attempt < MAX_RETRIES - 1) {
            await new Promise(resolve => setTimeout(resolve, 2 ** (attempt + 1) * 1000));
        }
    }
    return response;
}

async function executeQuery() {
    const query = el('sg-query').value.trim();
    if (!query) return;

    const requestId = ++state.requestId;
    const config = ENTITY_CONFIG[state.entityName];
    renderLoading();
    el('sg-execute').disabled = true;
    el('sg-prev').disabled = true;
    el('sg-next').disabled = true;

    try {
        const response = await fetchWithRetry(query);
        if (!response || !response.ok) {
            const errorText = response ? await response.text() : 'No response from server.';
            throw new Error(`HTTP ${response?.status || 'N/A'}: ${errorText.substring(0, 200)}`);
        }
        const json = await response.json();
        if (json.errors) throw new Error(JSON.stringify(json.errors, null, 2));
        if (requestId !== state.requestId) return; // A newer query replaced this one

        const data = json.data || {};
        const rootKeys = Object.keys(data);
        let output;

        if (!state.isManualOverride && rootKeys.length === 1) {
            // Standard case: a single root field (list, single entity or list fallback)
            const value = data[rootKeys[0]];
            const list = Array.isArray(value) ? value : (value ? [value] : []);
            output = list.map(item => addFormattedFields({ ...item }));
            state.lastResultCount = config?.queryType === 'list' ? list.length : 0;
        } else {
            // Manual or multi-root queries: format every root field
            output = {};
            rootKeys.forEach(key => {
                const value = data[key];
                const list = Array.isArray(value) ? value : (value ? [value] : []);
                output[key] = list.map(item => addFormattedFields({ ...item }));
            });
            state.lastResultCount = 0;
        }

        state.lastJson = JSON.stringify(output, null, 2);
        // Render as text: subgraph data (e.g. stream metadata) is user-controlled
        const pre = document.createElement('pre');
        pre.className = 'whitespace-pre-wrap break-all text-xs sm:text-sm font-mono text-gray-300';
        pre.textContent = state.lastJson;
        el('sg-output').replaceChildren(pre);
        el('sg-copy').classList.remove('hidden');
        el('sg-copy').classList.add('flex');
        if (Array.isArray(output)) {
            el('sg-result-meta').textContent = `${output.length} result${output.length === 1 ? '' : 's'}`;
        }
    } catch (error) {
        if (requestId !== state.requestId) return;
        console.error('Subgraph query error:', error);
        state.lastResultCount = 0;
        el('sg-output').innerHTML = '<p class="text-red-400">Query failed.</p>';
        el('sg-error').textContent = error.message;
        el('sg-error').classList.remove('hidden');
        UI.showToast({ type: 'error', title: 'Query failed', message: 'See the error details below the result.', duration: 4000 });
    } finally {
        if (requestId === state.requestId) updateButtons();
    }
}

function changePage(direction) {
    const limit = parseInt(el('sg-limit').value) || 10;
    const skip = parseInt(el('sg-skip').value) || 0;
    el('sg-skip').value = Math.max(0, skip + direction * limit);
    updateQueryPreview();
    executeQuery();
}

async function copyResults() {
    if (!state.lastJson) return;
    try {
        await navigator.clipboard.writeText(state.lastJson);
        UI.showToast({ type: 'success', title: 'Copied', message: 'Result JSON copied to clipboard.', duration: 2500 });
    } catch (e) {
        UI.showToast({ type: 'error', title: 'Copy failed', message: 'Clipboard access was denied.', duration: 4000 });
    }
}

// ============================================
// Public API
// ============================================

export const SubgraphLogic = {
    /**
     * Wires the static controls of the Subgraph view (called once when the module loads).
     */
    setupEventListeners() {
        el('sg-entity-select').addEventListener('change', (e) => window.router.navigate(`/subgraph/${e.target.value}`));
        ['sg-limit', 'sg-skip'].forEach(id => el(id).addEventListener('input', updateQueryPreview));
        ['sg-order-by', 'sg-order-direction'].forEach(id => el(id).addEventListener('change', updateQueryPreview));

        // Filter inputs are re-rendered per entity: use delegation
        el('sg-filters').addEventListener('input', updateQueryPreview);
        el('sg-filters').addEventListener('change', updateQueryPreview);

        el('sg-query').addEventListener('input', () => {
            state.isManualOverride = el('sg-query').value.trim() !== getAutoGeneratedQuery().trim();
            updateQueryPreview();
        });
        el('sg-reset-query').addEventListener('click', () => {
            state.isManualOverride = false;
            updateQueryPreview();
        });
        el('sg-clear-filters').addEventListener('click', () => {
            document.querySelectorAll('#sg-filters input, #sg-filters select').forEach(i => { i.value = ''; });
            updateQueryPreview();
        });

        el('sg-execute').addEventListener('click', executeQuery);
        el('sg-prev').addEventListener('click', () => changePage(-1));
        el('sg-next').addEventListener('click', () => changePage(1));
        el('sg-copy').addEventListener('click', copyResults);
        el('sg-open-settings').addEventListener('click', () => navigationController.openSettings());
    },

    /**
     * Shows an entity and runs its default query.
     * @param {string} [entityName] - ENTITY_CONFIG key; defaults to the last viewed entity
     */
    show(entityName) {
        if (!state.initialized) {
            renderEntityNavigation();
            state.initialized = true;
        }
        if (entityName && !ENTITY_CONFIG[entityName]) {
            UI.showToast({ type: 'warning', title: 'Unknown entity', message: 'Showing Operators instead.', duration: 4000 });
            entityName = DEFAULT_ENTITY;
        }
        if (!entityName) {
            // Keep the entity in the URL so back/forward restore the right one
            window.history.replaceState({}, '', `/subgraph/${state.entityName}`);
        }
        state.entityName = entityName || state.entityName;
        renderEntity();
        executeQuery();
    },

    /**
     * Ignores the result of any in-flight query when leaving the view.
     */
    stop() {
        state.requestId++;
    },
};
