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
const PANEL_COLLAPSED_KEY = 'subgraph-panel-collapsed';
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
    // Entity navigation categories currently expanded (all collapsed by default)
    expandedCategories: new Set(),
    // Right panel collapsed to the icon rail (remembered per browser)
    panelCollapsed: false,
    // Filters shown for the current entity, in the order they were added
    activeFilters: [],
    // Pagination offset (skip), controlled by the result arrows
    skip: 0,
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
            <label for="${filter.id}" class="block text-xs font-medium text-gray-400 mb-1.5">${filter.label}</label>
            ${inputHtml}
        </div>`;
}

// Groups used by the "Add filter" menu
const FILTER_GROUPS = [
    { label: 'Addresses & IDs', types: ['address', 'text'] },
    { label: 'Amounts & counts', types: ['wei', 'number', 'fraction'] },
    { label: 'Dates', types: ['datetime'] },
    { label: 'Options', types: ['boolean', 'toggle', 'select'] },
];

const REMOVE_ICON = '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

/**
 * Renders the active filter rows (or the empty state).
 * Existing rows keep their values: only missing rows are created and removed ones dropped.
 */
function renderActiveFilters() {
    const config = ENTITY_CONFIG[state.entityName];
    const container = el('sg-filters');
    const removable = config.queryType === 'list';

    container.querySelector('[data-filters-empty]')?.remove();
    container.querySelectorAll('[data-filter-row]').forEach(row => {
        if (!state.activeFilters.includes(row.dataset.filterRow)) row.remove();
    });

    state.activeFilters.forEach(id => {
        if (container.querySelector(`[data-filter-row="${id}"]`)) return;
        const filter = config.filters.find(f => f.id === id);
        container.insertAdjacentHTML('beforeend', `
            <div data-filter-row="${id}" class="flex items-end gap-2">
                <div class="flex-1 min-w-0">${generateFilterInput(filter)}</div>
                ${removable ? `<button type="button" data-remove-filter="${id}" title="Remove filter"
                        class="p-2.5 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors flex-shrink-0">${REMOVE_ICON}</button>` : ''}
            </div>`);
        if (filter.defaultValue) el(id).value = filter.defaultValue;
    });

    if (!state.activeFilters.length) {
        container.insertAdjacentHTML('beforeend', '<p data-filters-empty class="text-sm text-gray-400">No filters applied.</p>');
    }

    const remaining = removable ? config.filters.filter(f => !state.activeFilters.includes(f.id)).length : 0;
    el('sg-add-filter-wrap').classList.toggle('hidden', remaining === 0);
}

/**
 * Adds a filter row, preselecting option-type filters so they apply right away.
 */
function addFilter(id) {
    const filter = ENTITY_CONFIG[state.entityName].filters.find(f => f.id === id);
    if (!filter || state.activeFilters.includes(id)) return;

    state.activeFilters.push(id);
    renderActiveFilters();

    const input = el(id);
    if (filter.type === 'toggle') input.value = 'on';
    else if (filter.type === 'boolean') input.value = 'true';
    else if (filter.type === 'select') input.value = filter.options[0];
    input.focus();
    onQueryInputsChanged();
}

function removeFilter(id) {
    state.activeFilters = state.activeFilters.filter(f => f !== id);
    renderActiveFilters();
    onQueryInputsChanged();
}

/**
 * Renders the "Add filter" menu list, grouped by type and filtered by the search text.
 */
function renderAddFilterMenu() {
    const config = ENTITY_CONFIG[state.entityName];
    const search = el('sg-add-filter-search').value.trim().toLowerCase();
    const available = config.filters.filter(f =>
        !state.activeFilters.includes(f.id) && (!search || f.label.toLowerCase().includes(search) || f.field.toLowerCase().includes(search)));

    let html = '';
    FILTER_GROUPS.forEach(group => {
        const items = available.filter(f => group.types.includes(f.type));
        if (!items.length) return;
        html += `<div class="px-3 pt-2 pb-1 text-[10px] font-semibold text-gray-500 uppercase tracking-widest">${group.label}</div>`;
        html += items.map(f => `
            <button type="button" data-add-filter="${f.id}"
                    class="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-[#2a2a2a] hover:text-white focus:bg-[#2a2a2a] focus:outline-none transition-colors">${f.label}</button>`).join('');
    });
    el('sg-add-filter-list').innerHTML = html || '<p class="px-3 py-3 text-sm text-gray-400">No matching filters.</p>';
}

function setAddFilterMenuOpen(open) {
    el('sg-add-filter-menu').classList.toggle('hidden', !open);
    el('sg-add-filter').setAttribute('aria-expanded', open);
    if (open) {
        el('sg-add-filter-search').value = '';
        renderAddFilterMenu();
        el('sg-add-filter-search').focus();
    }
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

    const args = [`first: ${getLimit()}`];
    // skip defaults to 0 in The Graph: only written from page 2 onwards
    if (state.skip > 0) args.push(`skip: ${state.skip}`);
    args.push(`orderBy: ${el('sg-order-by').value}`, `orderDirection: ${el('sg-order-direction').value}`);
    const where = getFilterWhereClause(config);
    if (where) args.push(`where: {${where}}`);
    args.push('subgraphError: allow');

    return `query Get${queryName}s {\n    ${entityName}(${args.join(', ')}) {\n        ${config.fields}\n    }\n}`;
}

function getLimit() {
    return Math.min(Math.max(parseInt(el('sg-limit').value) || 10, 1), 1000);
}

/**
 * Any change to the query inputs (limit, sorting, filters) starts again from the first page.
 */
function onQueryInputsChanged() {
    state.skip = 0;
    updateQueryPreview();
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
    const rail = el('sg-entity-rail');
    select.innerHTML = '';
    nav.innerHTML = '';
    rail.innerHTML = '';

    const categories = {};
    Object.entries(ENTITY_CONFIG).forEach(([key, config]) => {
        (categories[config.category] ||= []).push({ key, ...config });
    });

    CATEGORY_ORDER.forEach(category => {
        if (!categories[category]) return;

        const optgroup = document.createElement('optgroup');
        optgroup.label = category;

        const expanded = state.expandedCategories.has(category);
        let itemsHtml = '';

        categories[category].forEach(entity => {
            const option = document.createElement('option');
            option.value = entity.key;
            option.textContent = entity.label;
            optgroup.appendChild(option);

            // Internal link: handled by the app router (/subgraph/:entity)
            itemsHtml += `
                <a href="/subgraph/${entity.key}" data-entity="${entity.key}" title="${entity.description}"
                   class="nav-link flex items-center pl-9 pr-3 py-2 rounded-md text-sm font-medium text-gray-400 hover:text-white hover:bg-white/[0.03] transition-all duration-200">
                    ${entity.label}
                </a>`;
        });

        select.appendChild(optgroup);
        nav.insertAdjacentHTML('beforeend', `
            <div class="px-2">
                <button type="button" data-category-toggle="${category}" aria-expanded="${expanded}"
                        class="group w-full flex items-center gap-2 px-3 py-2 rounded-md hover:bg-white/[0.03] transition-colors">
                    <svg class="w-4 h-4 flex-shrink-0 text-gray-400 group-hover:text-gray-300 transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${CATEGORY_ICONS[category] || ''}</svg>
                    <span data-category-label class="text-[11px] font-semibold text-gray-400 group-hover:text-gray-300 uppercase tracking-widest transition-colors">${category}</span>
                    <span data-category-active class="hidden w-1.5 h-1.5 rounded-full bg-blue-500" title="Contains the selected entity"></span>
                    <span class="ml-auto text-[10px] text-gray-500">${categories[category].length}</span>
                    <svg data-category-chevron class="w-3.5 h-3.5 text-gray-500 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                </button>
                <div data-category-items="${category}" class="${expanded ? '' : 'hidden'} space-y-0.5 pb-1">${itemsHtml}</div>
            </div>`);

        // Collapsed panel: one icon per category
        rail.insertAdjacentHTML('beforeend', `
            <button type="button" data-rail-category="${category}" title="${category}"
                    class="relative p-2.5 rounded-md text-gray-400 hover:text-white hover:bg-white/[0.05] transition-colors">
                <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${CATEGORY_ICONS[category] || ''}</svg>
                <span data-category-active class="hidden absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-blue-500"></span>
            </button>`);
    });
}

/**
 * Collapses the right panel to an icon rail or expands it back.
 */
function setPanelCollapsed(collapsed) {
    state.panelCollapsed = collapsed;
    try {
        localStorage.setItem(PANEL_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch (e) {
        // Storage unavailable (private mode): the state just isn't remembered
    }

    const panel = el('sg-entity-panel');
    panel.classList.toggle('w-64', !collapsed);
    panel.classList.toggle('w-14', collapsed);
    // The panel is fixed: the content keeps clear of it with a matching margin
    el('sg-content').classList.toggle('lg:mr-64', !collapsed);
    el('sg-content').classList.toggle('lg:mr-14', collapsed);
    panel.querySelectorAll('[data-panel-expanded]').forEach(node => node.classList.toggle('hidden', collapsed));
    el('sg-entity-rail').classList.toggle('hidden', !collapsed);
    el('sg-entity-rail').classList.toggle('flex', collapsed);

    const toggle = el('sg-panel-toggle');
    toggle.setAttribute('aria-expanded', !collapsed);
    toggle.title = collapsed ? 'Expand panel' : 'Collapse panel';
    toggle.querySelector('[data-panel-icon-collapse]').classList.toggle('hidden', collapsed);
    toggle.querySelector('[data-panel-icon-expand]').classList.toggle('hidden', !collapsed);
}

/**
 * Expands or collapses a category of the entity navigation.
 */
function toggleCategory(category) {
    const expanded = !state.expandedCategories.has(category);
    if (expanded) state.expandedCategories.add(category);
    else state.expandedCategories.delete(category);

    const toggle = document.querySelector(`#sg-entity-nav [data-category-toggle="${category}"]`);
    toggle.setAttribute('aria-expanded', expanded);
    toggle.querySelector('[data-category-chevron]').classList.toggle('rotate-90', expanded);
    document.querySelector(`#sg-entity-nav [data-category-items="${category}"]`).classList.toggle('hidden', !expanded);
}

/**
 * Highlights the selected entity and marks its category (visible even when collapsed).
 */
function updateNavigationActiveState() {
    const activeCategory = ENTITY_CONFIG[state.entityName]?.category;
    document.querySelectorAll('#sg-entity-nav .nav-link').forEach(link => {
        link.classList.toggle('active', link.dataset.entity === state.entityName);
    });
    document.querySelectorAll('#sg-entity-nav [data-category-toggle]').forEach(toggle => {
        const isActive = toggle.dataset.categoryToggle === activeCategory;
        toggle.querySelector('[data-category-active]').classList.toggle('hidden', !isActive);
        toggle.querySelector('[data-category-label]').classList.toggle('text-white', isActive);
    });
    document.querySelectorAll('#sg-entity-rail [data-rail-category]').forEach(button => {
        const isActive = button.dataset.railCategory === activeCategory;
        button.querySelector('[data-category-active]').classList.toggle('hidden', !isActive);
        button.classList.toggle('text-white', isActive);
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
    el('sg-entity-description').textContent = config.description;
    updateNavigationActiveState();
    navigationController.updatePageTitle('subgraph', `Subgraph · ${config.label}`);

    // Sorting options
    const sortFields = config.sortFields?.length ? config.sortFields : [{ value: 'id', label: 'ID' }];
    el('sg-order-by').innerHTML = sortFields
        .map(f => `<option value="${f.value}" ${config.defaultSort?.field === f.value ? 'selected' : ''}>${f.label}</option>`)
        .join('');
    el('sg-order-direction').value = config.defaultSort?.direction || 'desc';
    state.skip = 0;

    // Pagination and sorting only apply to list queries
    el('sg-list-options').classList.toggle('hidden', config.queryType !== 'list');
    el('sg-pager').classList.toggle('hidden', config.queryType !== 'list');

    // Filters
    const container = el('sg-filters');
    setAddFilterMenuOpen(false);
    state.activeFilters = [];
    el('sg-add-filter-wrap').classList.add('hidden');
    if (config.queryType === 'meta') {
        container.innerHTML = `
            <p class="text-sm text-gray-400">This query returns subgraph metadata.</p>
            <p class="text-xs text-gray-400 mt-1">No filters needed: returns the current indexing status and block information.</p>`;
    } else if (!config.filters?.length) {
        container.innerHTML = '<p class="text-sm text-gray-400">No filters available for this entity.</p>';
    } else {
        container.innerHTML = '';
        if (config.queryType === 'single') {
            const hint = config.listFallback
                ? 'Enter an ID to fetch a specific record, or leave it empty to get the first one.'
                : 'This entity requires an ID for lookup.';
            container.innerHTML = `
                <div class="p-3 rounded-lg bg-blue-500/10 border border-blue-500/30">
                    <p class="text-sm text-blue-300"><strong>Single entity query.</strong> ${hint}</p>
                </div>`;
        }
        // Single queries always show their (ID) filter; list queries start with none
        state.activeFilters = config.queryType === 'single' ? config.filters.map(f => f.id) : [];
        renderActiveFilters();
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
    const isList = ENTITY_CONFIG[state.entityName]?.queryType === 'list';
    el('sg-clear-filters').classList.toggle('hidden', isList ? state.activeFilters.length === 0 : count === 0);

    updateButtons();
}

function updateButtons() {
    const config = ENTITY_CONFIG[state.entityName];
    const isList = config?.queryType === 'list';

    el('sg-execute').disabled = el('sg-query').value.trim() === '';
    el('sg-prev').disabled = !isList || state.isManualOverride || state.skip <= 0;
    el('sg-next').disabled = !isList || state.isManualOverride || state.lastResultCount < getLimit();
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
    const isPagedList = config?.queryType === 'list' && !state.isManualOverride;
    const executedSkip = state.skip;
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
        el('sg-result-meta').textContent = formatResultMeta(output, isPagedList ? executedSkip : null);
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

/**
 * Footer text: "11–20 · 10 results" for paged lists, "N results" otherwise.
 */
function formatResultMeta(output, skip) {
    if (!Array.isArray(output)) return '';
    const count = `${output.length} result${output.length === 1 ? '' : 's'}`;
    if (skip === null || output.length === 0) return count;
    const range = output.length === 1 ? `${skip + 1}` : `${skip + 1}–${skip + output.length}`;
    return `${range} · ${count}`;
}

function changePage(direction) {
    state.skip = Math.max(0, state.skip + direction * getLimit());
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
        el('sg-entity-nav').addEventListener('click', (e) => {
            const toggle = e.target.closest('[data-category-toggle]');
            if (toggle) toggleCategory(toggle.dataset.categoryToggle);
        });
        el('sg-panel-toggle').addEventListener('click', () => setPanelCollapsed(!state.panelCollapsed));
        // Clicking a category icon in the collapsed rail expands the panel with that category open
        el('sg-entity-rail').addEventListener('click', (e) => {
            const button = e.target.closest('[data-rail-category]');
            if (!button) return;
            const category = button.dataset.railCategory;
            if (!state.expandedCategories.has(category)) toggleCategory(category);
            setPanelCollapsed(false);
        });
        el('sg-entity-select').addEventListener('change', (e) => window.router.navigate(`/subgraph/${e.target.value}`));
        el('sg-limit').addEventListener('input', onQueryInputsChanged);
        ['sg-order-by', 'sg-order-direction'].forEach(id => el(id).addEventListener('change', onQueryInputsChanged));

        // Filter inputs are re-rendered per entity: use delegation
        el('sg-filters').addEventListener('input', onQueryInputsChanged);
        el('sg-filters').addEventListener('change', onQueryInputsChanged);

        el('sg-query').addEventListener('input', () => {
            state.isManualOverride = el('sg-query').value.trim() !== getAutoGeneratedQuery().trim();
            updateQueryPreview();
        });
        el('sg-reset-query').addEventListener('click', () => {
            state.isManualOverride = false;
            updateQueryPreview();
        });
        el('sg-clear-filters').addEventListener('click', () => {
            if (ENTITY_CONFIG[state.entityName]?.queryType === 'list') {
                state.activeFilters = [];
                renderActiveFilters();
            } else {
                document.querySelectorAll('#sg-filters input, #sg-filters select').forEach(i => { i.value = ''; });
            }
            onQueryInputsChanged();
        });
        el('sg-filters').addEventListener('click', (e) => {
            const remove = e.target.closest('[data-remove-filter]');
            if (remove) removeFilter(remove.dataset.removeFilter);
        });

        // "Add filter" menu
        el('sg-add-filter').addEventListener('click', () => {
            setAddFilterMenuOpen(el('sg-add-filter-menu').classList.contains('hidden'));
        });
        el('sg-add-filter-search').addEventListener('input', renderAddFilterMenu);
        el('sg-add-filter-search').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const first = el('sg-add-filter-list').querySelector('[data-add-filter]');
                if (first) {
                    setAddFilterMenuOpen(false);
                    addFilter(first.dataset.addFilter);
                }
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                el('sg-add-filter-list').querySelector('[data-add-filter]')?.focus();
            }
        });
        el('sg-add-filter-list').addEventListener('click', (e) => {
            const item = e.target.closest('[data-add-filter]');
            if (!item) return;
            setAddFilterMenuOpen(false);
            addFilter(item.dataset.addFilter);
        });
        el('sg-add-filter-list').addEventListener('keydown', (e) => {
            const items = [...el('sg-add-filter-list').querySelectorAll('[data-add-filter]')];
            const index = items.indexOf(document.activeElement);
            if (e.key === 'ArrowDown' && index < items.length - 1) { e.preventDefault(); items[index + 1].focus(); }
            if (e.key === 'ArrowUp') { e.preventDefault(); (index > 0 ? items[index - 1] : el('sg-add-filter-search')).focus(); }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !el('sg-add-filter-menu').classList.contains('hidden')) {
                setAddFilterMenuOpen(false);
                el('sg-add-filter').focus();
            }
        });
        document.addEventListener('click', (e) => {
            if (!el('sg-add-filter-wrap').contains(e.target)) setAddFilterMenuOpen(false);
        });

        el('sg-execute').addEventListener('click', executeQuery);
        // Ctrl/Cmd + Enter runs the query from anywhere in the view
        el('subgraph-view').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !el('sg-execute').disabled) {
                e.preventDefault();
                executeQuery();
            }
        });
        el('sg-prev').addEventListener('click', () => changePage(-1));
        el('sg-next').addEventListener('click', () => changePage(1));
        el('sg-copy').addEventListener('click', copyResults);
    },

    /**
     * Shows an entity and runs its default query.
     * @param {string} [entityName] - ENTITY_CONFIG key; defaults to the last viewed entity
     */
    show(entityName) {
        if (!state.initialized) {
            renderEntityNavigation();
            let collapsed = false;
            try {
                collapsed = localStorage.getItem(PANEL_COLLAPSED_KEY) === '1';
            } catch (e) {
                // Storage unavailable: default to expanded
            }
            setPanelCollapsed(collapsed);
            state.initialized = true;
        }
        if (entityName && !ENTITY_CONFIG[entityName]) {
            UI.showToast({ type: 'warning', title: 'Unknown entity', message: 'Showing Operators instead.', duration: 4000 });
            entityName = DEFAULT_ENTITY;
        }
        if (!entityName) {
            // Keep the entity in the URL so back/forward restore the right one
            window.history.replaceState(window.history.state, '', `/subgraph/${state.entityName}`);
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
