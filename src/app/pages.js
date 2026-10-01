// Page modules loaded on first visit, and stopping the other pages when a route opens
import * as UI from '../ui/ui.js';
import * as Services from '../core/services.js';
import { OperatorLogic } from '../features/operator.js';

const PAGES = {
    race: { title: 'Race View', load: () => import('../features/race.js').then(m => m.RaceLogic) },
    visual: { title: 'Visual View', load: () => import('../features/visual.js').then(m => m.VisualLogic) },
    delegators: {
        title: 'Delegators View',
        load: () => import('../features/delegators.js').then(m => {
            window.DelegatorsLogic = m.DelegatorsLogic; // for the page's buttons (data-delegators-action)
            return m.DelegatorsLogic;
        })
    },
    streams: { title: 'Streams View', load: () => import('../features/streams.js').then(m => (m.StreamsLogic.setupEventListeners(), m.StreamsLogic)) },
    subgraph: { title: 'Subgraph View', load: () => import('../features/subgraph.js').then(m => (m.SubgraphLogic.setupEventListeners(), m.SubgraphLogic)) },
    governance: { title: 'Governance View', load: () => import('../features/governance.js').then(m => (m.GovernanceLogic.setupEventListeners(), m.GovernanceLogic)) }
};

const loaded = {};
const loading = {};

/** The page module once loaded, else null */
export const loadedPage = (name) => loaded[name] || null;

/** Loads a page module once (concurrent calls share the load) */
export function loadPage(name) {
    if (loaded[name]) return Promise.resolve(loaded[name]);
    loading[name] ??= PAGES[name].load()
        .then((logic) => (loaded[name] = logic))
        .catch((error) => {
            UI.showToast({ type: 'error', title: `Failed to load ${PAGES[name].title}`, message: error.message, duration: 5000 });
            throw error;
        })
        .finally(() => { delete loading[name]; });
    return loading[name];
}

/**
 * Stops the pages other than `keep` ('operator' keeps the operator page and the coordination stream;
 * the delegators page is deactivated rather than stopped)
 */
export function stopOtherPages(keep) {
    if (keep !== 'operator') {
        OperatorLogic.stop();
        Services.unsubscribeFromCoordinationStream();
    }
    for (const name of Object.keys(PAGES)) {
        if (name === keep || !loaded[name]) continue;
        if (name === 'delegators') loaded[name].deactivate();
        else loaded[name].stop();
    }
}
