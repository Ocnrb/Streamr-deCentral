// The app's routes: each opens its page and stops the others
import * as UI from '../ui/ui.js';
import * as Services from '../core/services.js';
import { Router } from '../core/router.js';
import { navigationController } from '../ui/navigation.js';
import { OperatorLogic } from '../features/operator.js';
import { OperatorForm } from '../features/operatorForm.js';
import { state, syncOperatorState } from './state.js';
import { loadPage, stopOtherPages } from './pages.js';

export let router = null;

export function setupRouter() {
    router = new Router();

    // Make router available globally for navigation controller
    window.router = router;

    // Home route - network overview (stops itself when the route changes)
    router.addRoute('/', async () => {
        stopOtherPages();

        UI.displayView('overview');
        UI.hideProfileButtons();
        navigationController.updateActiveState('overview');

        try {
            const { OverviewLogic } = await import('../features/overview.js');
            OverviewLogic.show();
        } catch (error) {
            console.error('Failed to load overview module:', error);
            UI.showToast({ type: 'error', title: 'Failed to load Overview', message: error.message, duration: 5000 });
        }
    });

    // Operators list route
    router.addRoute('/operators', async () => {
        stopOtherPages();
        
        UI.displayView('list');
        UI.hideProfileButtons();
        OperatorForm.setup(); // Create Operator button (enabled with a connected wallet)
        navigationController.updateActiveState('operators');
        navigationController.updatePageTitle('operators');
        syncOperatorState();
        OperatorLogic.resetListState();
        OperatorLogic.fetchAndRenderList(false, 0, '');
    });

    // Operator detail route
    router.addRoute('/operator/:id', async (params) => {
        stopOtherPages('operator');
        
        UI.displayView('detail');
        navigationController.updateActiveState('operators');
        navigationController.updatePageTitle('operators', 'Operator Details');
        syncOperatorState();
        OperatorLogic.fetchAndRenderDetails(params.id);
    });

    // Race view route
    router.addRoute('/race', async () => {
        stopOtherPages('race');
        
        UI.displayView('race');
        UI.hideProfileButtons();
        navigationController.updateActiveState('race');
        navigationController.updatePageTitle('race');
        
        try {
            const raceModule = await loadPage('race');
            raceModule.init();
        } catch (error) {
            console.error('Failed to load race module:', error);
            router.navigate('/');
        }
    });

    // Visual view route
    router.addRoute('/visual', async () => {
        stopOtherPages('visual');
        
        UI.displayView('visual');
        UI.hideProfileButtons();
        navigationController.updateActiveState('visual');
        navigationController.updatePageTitle('visual');
        // Hide navigation in visual view (full screen)
        navigationController.setNavigationVisibility(false);
        
        try {
            const visualModule = await loadPage('visual');
            visualModule.setClient(Services.getStreamrClient());
            
            visualModule.onNavigateToOperator = (operatorId) => {
                router.navigate(`/operator/${operatorId}`);
            };
            
            visualModule.init();
        } catch (error) {
            console.error('Failed to load visual module:', error);
            router.navigate('/');
        }
    });

    // Delegators list route
    router.addRoute('/delegators', async () => {
        stopOtherPages('delegators');
        
        UI.displayView('delegators-list');
        UI.hideProfileButtons();
        navigationController.updateActiveState('delegators');
        navigationController.updatePageTitle('delegators');
        
        try {
            const delegatorsModule = await loadPage('delegators');
            delegatorsModule.setSharedState({ 
                dataPriceUSD: state.dataPriceUSD,
                historicalDataPriceMap: state.historicalDataPriceMap
            });
            delegatorsModule.init();
        } catch (error) {
            console.error('Failed to load delegators module:', error);
            router.navigate('/');
        }
    });

    // Delegator detail route
    router.addRoute('/delegator/:id', async (params) => {
        stopOtherPages('delegators');
        
        UI.displayView('delegator-detail');
        UI.hideProfileButtons();
        navigationController.updateActiveState('delegators');
        navigationController.updatePageTitle('delegators', 'Delegator Details');
        
        try {
            const delegatorsModule = await loadPage('delegators');
            delegatorsModule.setSharedState({ 
                dataPriceUSD: state.dataPriceUSD,
                historicalDataPriceMap: state.historicalDataPriceMap
            });
            delegatorsModule.showDelegatorDetail(params.id);
        } catch (error) {
            console.error('Failed to load delegators module:', error);
            router.navigate('/delegators');
        }
    });

    // Streams list route
    router.addRoute('/streams', async () => {
        stopOtherPages();
        
        UI.displayView('streams-list');
        UI.hideProfileButtons();
        navigationController.updateActiveState('streams');
        navigationController.updatePageTitle('streams');
        
        try {
            const streamsModule = await loadPage('streams');
            streamsModule.setSharedState({ 
                dataPriceUSD: state.dataPriceUSD
            });
            streamsModule.init();
        } catch (error) {
            console.error('Failed to load streams module:', error);
            router.navigate('/');
        }
    });
    
    // Stream detail route - use wildcard /* because stream IDs contain slashes
    router.addRoute('/stream/*', async (params) => {
        stopOtherPages();
        
        UI.displayView('stream-detail');
        UI.hideProfileButtons();
        navigationController.updateActiveState('streams');
        
        // Parse URL search params for sponsored flag
        const urlParams = new URLSearchParams(window.location.search);
        const isSponsored = urlParams.get('sponsored') === 'true';
        const sponsorshipId = urlParams.get('sponsorshipId');
        
        // Update page title based on whether it's sponsored or not
        navigationController.updatePageTitle('streams', isSponsored ? 'Sponsorship Details' : 'Stream Details');
        
        try {
            const streamsModule = await loadPage('streams');
            streamsModule.setSharedState({ 
                dataPriceUSD: state.dataPriceUSD
            });
            
            // Stream IDs can contain special characters, decode them
            const streamId = decodeURIComponent(params.id);
            
            streamsModule.loadStreamDetail(streamId, isSponsored, sponsorshipId);
        } catch (error) {
            console.error('Failed to load stream detail:', error);
            router.navigate('/streams');
        }
    });

    // Subgraph explorer routes - optionally with an entity (e.g. /subgraph/operators)
    const showSubgraph = async (entityName) => {
        stopOtherPages('subgraph');
        
        UI.displayView('subgraph');
        UI.hideProfileButtons();
        navigationController.updateActiveState('subgraph');
        
        try {
            const subgraphModule = await loadPage('subgraph');
            subgraphModule.show(entityName);
        } catch (error) {
            console.error('Failed to load subgraph module:', error);
            router.navigate('/');
        }
    };
    router.addRoute('/subgraph', () => showSubgraph());
    router.addRoute('/subgraph/:entity', (params) => showSubgraph(params.entity));

    // Governance routes - optionally with a flag open in the detail drawer
    const showGovernance = async (flagId) => {
        stopOtherPages('governance');

        UI.displayView('governance');
        UI.hideProfileButtons();
        navigationController.updateActiveState('governance');

        try {
            const governanceModule = await loadPage('governance');
            governanceModule.show(flagId);
        } catch (error) {
            console.error('Failed to load governance module:', error);
            router.navigate('/');
        }
    };
    router.addRoute('/governance', () => showGovernance());
    router.addRoute('/governance/flag/:id', (params) => showGovernance(params.id));

    // Market: the DATA market, its Swap and Liquidity tabs (stops itself when the route changes)
    const showMarket = async (tab) => {
        stopOtherPages();

        UI.displayView('swap');
        UI.hideProfileButtons();
        navigationController.updateActiveState('swap');

        try {
            const { SwapLogic } = await import('../features/swap.js');
            SwapLogic.show(tab);
        } catch (error) {
            console.error('Failed to load swap module:', error);
            UI.showToast({ type: 'error', title: 'Failed to load Market', message: error.message, duration: 5000 });
        }
    };
    router.addRoute('/market', () => showMarket('swap'));
    router.addRoute('/market/liquidity', () => showMarket('liquidity'));
    // The page's former address: links kept elsewhere still open it
    router.addRoute('/swap', () => {
        window.history.replaceState(window.history.state, '', '/market');
        return showMarket('swap');
    });

    // Bridge: DATA between Ethereum and Polygon (stops itself when the route changes)
    router.addRoute('/bridge', async () => {
        stopOtherPages();

        UI.displayView('bridge');
        UI.hideProfileButtons();
        navigationController.updateActiveState('bridge');

        try {
            const { BridgeLogic } = await import('../features/bridge.js');
            BridgeLogic.show();
        } catch (error) {
            console.error('Failed to load bridge module:', error);
            UI.showToast({ type: 'error', title: 'Failed to load Bridge', message: error.message, duration: 5000 });
        }
    });
}
