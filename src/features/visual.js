import { formatBigNumber } from '../core/utils.js';
import { getGraphUrl } from '../core/constants.js';

const COLOR_SPONSORSHIP = '#f97316'; 
const COLOR_SPONSORSHIP_LOW = '#ef4444'; 
const COLOR_OPERATOR = '#3b82f6'; 
const COLOR_LINK = '#BFC8D9'; 
const COLOR_LIVE_NODE = '#10b981'; 
const COLOR_DELEGATOR = '#f97316'; 

const LAUNCH_DATE_TS = 1701388800; 
const AVG_BLOCK_TIME = 2.2; 

const NODE_RADIUS = 5;
const NODE_COLOR = COLOR_LIVE_NODE;

export const VisualLogic = {
    nodes: [],
    links: [],
    simulation: null,
    canvas: null,
    ctx: null,
    transform: null, 
    width: window.innerWidth,
    height: window.innerHeight,
    hoveredNode: null,
    onNavigateToOperator: null, 
    
    nodeMap: new Map(), // For quick node lookup
    
    latestBlock: 0,
    latestTimestamp: 0,
    currentViewTimestamp: 0,
    isPlaying: false,
    sliderValue: 100,
    isLiveMode: false,
    isP2PMode: false,
    isShowDelegators: false, 
    
    streamrClient: null,
    coordinationSubscriptions: new Map(), 
    operatorNodeCounts: new Map(),      
    operatorNodeMetadata: new Map(),    
    operatorSponsorshipLinks: new Map(),
    nodeHeartbeats: new Map(),          
    nodeSponsorshipAssignments: new Map(), 
    p2pTopologyState: new Map(),        
    
    operatorSearchIndex: [], 
    selectedOperatorId: null, 
    
    operatorSubscriptionQueue: [],      
    activeOperatorSubscriptions: new Set(), 
    nodeHeartbeatCounts: new Map(),     
    MAX_CONCURRENT_SUBSCRIPTIONS: 75,
    targetNodeDegree: 4, 
    
    timeJumpStep: 0.50, 
    refreshDelayMs: 150,
    
    phyGravity: 0.050,
    phyFriction: 0.05,
    phyRepulsion: 2.0,
    phyTension: 0.05,
    
    dataCache: new Map(),
    imageCache: new Map(),
    metadataCache: new Map(),
    isProcessing: false,

    selectedNodeId: null,
    renderRequested: false,
    isDragging: false,
    isActive: false,

    boundResize: null,
    boundKeydown: null,
    eventListeners: [], 

    setClient: function(client) {
        this.streamrClient = client;
    },

    resetSettings: function() {
        // Internal State Defaults
        this.sliderValue = 100;
        this.isLiveMode = false;
        this.isP2PMode = false;
        this.isShowDelegators = false;
        this.MAX_CONCURRENT_SUBSCRIPTIONS = 75;
        this.targetNodeDegree = 4;
        this.timeJumpStep = 0.50;
        this.refreshDelayMs = 150;
        this.phyGravity = 0.050;
        this.phyFriction = 0.05;
        this.phyRepulsion = 2.0;
        this.phyTension = 0.05;

        // UI Defaults Helpers
        const setVal = (id, val) => { const el = document.getElementById(id); if(el) el.value = val; };
        const setCheck = (id, val) => { const el = document.getElementById(id); if(el) el.checked = val; };
        const setText = (id, txt) => { const el = document.getElementById(id); if(el) el.textContent = txt; };

        // Apply UI Defaults
        setVal('vis-time-slider', 100);
        
        setCheck('vis-live-mode-toggle', false);
        setCheck('vis-p2p-mode-toggle', false);
        setCheck('vis-delegator-mode-toggle', false);

        // Physics Sliders
        setVal('vis-gravity-slider', 50); 
        setText('vis-gravity-display', '0.050');

        setVal('vis-friction-slider', 5); 
        setText('vis-friction-display', '0.05');

        setVal('vis-repulsion-slider', 20); 
        setText('vis-repulsion-display', '2.0x');

        setVal('vis-tension-slider', 5); 
        setText('vis-tension-display', '0.05');

        // Other Settings
        setVal('vis-max-subs-slider', 75);
        setText('vis-max-subs-display', '75');

        setVal('vis-degree-slider', 4);
        setText('vis-degree-display', '4');

        setVal('vis-jump-slider', 5); 
        setText('vis-jump-display', '0.5%');

        setVal('vis-delay-slider', 150);
        setText('vis-delay-display', '150ms');
        
        // Reset UI visibility based on mode (Live mode toggles visibility of groups)
        const timeControls = document.getElementById('vis-time-controls-group');
        const timelineSettings = document.getElementById('vis-timeline-settings-group');
        const discoverySettings = document.getElementById('vis-discovery-settings-group');
        const simulationSettings = document.getElementById('vis-simulation-settings-group');
        const p2pContainer = document.getElementById('vis-p2p-mode-container');
        const delegatorSettings = document.getElementById('vis-delegator-settings-container');
        const delegatorCounter = document.getElementById('vis-delegator-counter');
        const liveInfoIcon = document.getElementById('vis-live-info-icon');
        
        // Default is Historical Mode (Live Mode = false)
        if (timeControls) timeControls.classList.remove('hidden');
        if (delegatorSettings) delegatorSettings.classList.remove('hidden');
        if (delegatorCounter) delegatorCounter.classList.remove('hidden');
        if (timelineSettings) timelineSettings.classList.remove('hidden');
        if (discoverySettings) discoverySettings.classList.add('hidden');
        if (simulationSettings) simulationSettings.classList.add('hidden');
        if (p2pContainer) p2pContainer.classList.add('hidden');
        if (liveInfoIcon) liveInfoIcon.classList.add('hidden');
        
        // Reset Title
        const modeTitle = document.getElementById('vis-control-title');
        const modeIcon = document.getElementById('vis-mode-icon');
        if (modeTitle) {
             modeTitle.textContent = "Live Node View";
             modeTitle.className = "text-xs font-medium text-gray-300";
        }
        if(modeIcon) {
            modeIcon.setAttribute('data-lucide', 'network');
            modeIcon.classList.replace('text-green-400', 'text-gray-400');
        }
    },

    init: async function() {
        if (this.isActive) return;
        this.isActive = true;

        this.resetSettings();
        
        // Ensure play button is in correct initial state
        this.isPlaying = false;
        const playBtn = document.getElementById('vis-btn-play');
        if (playBtn) {
            playBtn.innerHTML = '<i data-lucide="play" class="w-3 h-3 ml-0.5 fill-current"></i>';
            playBtn.classList.remove('pulse-active');
        }

        document.body.classList.add('visual-mode-active');

        this.canvas = document.getElementById('vis-network-canvas');

        this.ctx = this.canvas.getContext('2d'); 
        this.transform = d3.zoomIdentity;
        
        this.boundResize = () => this.resize();
        this.boundKeydown = (e) => this.handleKeydown(e);
        
        window.addEventListener('resize', this.boundResize);
        document.addEventListener('keydown', this.boundKeydown);
        
        this.resize();

        // D3 Setup
        const zoomBehavior = d3.zoom()
            .scaleExtent([0.1, 8])
            .on("zoom", event => this.zoomed(event));

        d3.select(this.canvas)
            .call(d3.drag()
                .container(this.canvas)
                .subject(event => this.dragSubject(event))
                .on("start", event => this.dragStarted(event))
                .on("drag", event => this.dragged(event))
                .on("end", event => this.dragEnded(event)))
            .call(zoomBehavior)
			.on("dblclick.zoom", null)
            .on("click", (event) => this.handleCanvasClick(event)) 
            .call(zoomBehavior.transform, d3.zoomIdentity
                .translate(this.width / 2, this.height / 2)
                .scale(0.2) 
                .translate(-this.width / 2, -this.height / 2))
            .on("mousemove", event => this.mouseMoved(event));

        // Event Listeners for UI Controls 
        this.addSafeListener('vis-time-slider', 'input', (e) => this.handleSliderInput(e));
        this.addSafeListener('vis-time-slider', 'change', (e) => this.handleSliderChange(e));
        this.addSafeListener('vis-btn-play', 'click', () => this.togglePlay());
        
        // Close selection button
        this.addSafeListener('vis-btn-close-sel', 'click', () => {
            this.selectedNodeId = null;
            this.selectedOperatorId = null; 
            this.updateSelectionUI(null);
            this.requestRender();
        });
        
        // Go to operator details button
        this.addSafeListener('vis-btn-goto-operator', 'click', (e) => {
            const operatorId = e.target.closest('button').dataset.operatorId;
            if (operatorId && this.onNavigateToOperator) {
                this.onNavigateToOperator(operatorId);
            }
        });
        
        // Settings Toggle
        this.addSafeListener('vis-btn-settings', 'click', () => {
            const panel = document.getElementById('vis-settings-panel');
            if (panel) {
                panel.classList.toggle('hidden');
                
                if (!panel.classList.contains('hidden') && window.lucide) {
                    setTimeout(() => window.lucide.createIcons(), 0);
                }
            }
            
            const helpBtn = document.getElementById('vis-btn-help');
            if (helpBtn) helpBtn.classList.toggle('hidden');
        });
        
        // Search Logic
        const searchInput = document.getElementById('vis-search-input');
        const btnClearSearch = document.getElementById('vis-btn-clear-search');
        const searchToggle = document.getElementById('vis-btn-search-toggle');
        const searchBar = document.getElementById('vis-search-bar');
        
        if (searchToggle && searchBar && searchInput) {
            const toggleHandler = () => {
                const isExpanded = searchBar.classList.contains('w-64');
                if (!isExpanded) {
                    searchBar.classList.remove('w-10', 'rounded-full');
                    searchBar.classList.add('w-64', 'rounded-xl');
                    searchInput.classList.remove('w-0', 'opacity-0');
                    searchInput.classList.add('w-full', 'opacity-100', 'ml-2');
                    searchInput.focus();
                } else {
                    searchInput.focus();
                }
            };
            searchToggle.addEventListener('click', toggleHandler);
            this.eventListeners.push({ el: searchToggle, event: 'click', handler: toggleHandler });
        }

        if (searchInput) {
            const inputHandler = (e) => this.handleSearch(e.target.value);
            const focusHandler = () => {
                const results = document.getElementById('vis-search-results');
                if(searchInput.value.length > 0 && results) results.classList.remove('hidden');
            };
            searchInput.addEventListener('input', inputHandler);
            searchInput.addEventListener('focus', focusHandler);
            this.eventListeners.push({ el: searchInput, event: 'input', handler: inputHandler });
            this.eventListeners.push({ el: searchInput, event: 'focus', handler: focusHandler });
        }
        
        // Global click for closing search 
        this.searchCloser = (e) => {
            if (!this.isActive) return;
            const searchWrapper = document.getElementById('vis-search-wrapper');
            const results = document.getElementById('vis-search-results');
            
            if (searchWrapper && results && !searchWrapper.contains(e.target)) {
                results.classList.add('hidden');
                
                if (searchInput && searchInput.value === '' && searchBar) {
                    searchBar.classList.remove('w-64', 'rounded-xl');
                    searchBar.classList.add('w-10', 'rounded-full');
                    searchInput.classList.remove('w-full', 'opacity-100', 'ml-2');
                    searchInput.classList.add('w-0', 'opacity-0');
                }
            }
        };
        document.addEventListener('click', this.searchCloser);

        if (btnClearSearch && searchInput) {
            const clearHandler = () => {
                searchInput.value = '';
                const results = document.getElementById('vis-search-results');
                if (results) results.classList.add('hidden');
                btnClearSearch.classList.add('hidden');
                searchInput.focus();
                this.requestRender();
            };
            btnClearSearch.addEventListener('click', clearHandler);
            this.eventListeners.push({ el: btnClearSearch, event: 'click', handler: clearHandler });
        }
        
        this.addSafeListener('vis-live-mode-toggle', 'change', (e) => this.toggleLiveMode(e.target.checked));
        
        this.addSafeListener('vis-p2p-mode-toggle', 'change', (e) => {
            this.isP2PMode = e.target.checked;
            this.regenerateLiveNodes();
            this.requestRender();
        });

        this.addSafeListener('vis-delegator-mode-toggle', 'change', (e) => {
            this.isShowDelegators = e.target.checked;
            this.loadData(); 
        });
        
        this.initSettingsSliders();

        if (window.lucide) lucide.createIcons();
        await this.fetchMetadata();
        this.loadData(); 
    },

    stop: function() {
        this.isActive = false;
        document.body.classList.remove('visual-mode-active');
        
        // Stop play mode and reset button state
        if (this.isPlaying) {
            this.isPlaying = false;
            const btn = document.getElementById('vis-btn-play');
            if (btn) {
                btn.innerHTML = '<i data-lucide="play" class="w-3 h-3 ml-0.5 fill-current"></i>';
                btn.classList.remove('pulse-active');
            }
        }
        
        // Stop D3 Simulation
        if (this.simulation) {
            this.simulation.stop();
            this.simulation = null;
        }

        // Cleanup Event Listeners
        if (this.boundResize) window.removeEventListener('resize', this.boundResize);
        if (this.boundKeydown) document.removeEventListener('keydown', this.boundKeydown);
        if (this.searchCloser) document.removeEventListener('click', this.searchCloser);
        
        // Remove all tracked event listeners
        this.eventListeners.forEach(({ el, event, handler }) => {
            if (el) el.removeEventListener(event, handler);
        });
        this.eventListeners = [];

        // Cleanup Streamr
        this.cleanupLiveMode();

        // Clear State
        this.nodes = [];
        this.links = [];
        this.nodeMap.clear();
        this.imageCache.clear();
        this.dataCache.clear();
        
    },

    addSafeListener: function(id, event, handler) {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener(event, handler);
            // Store reference for cleanup
            this.eventListeners.push({ el, event, handler });
        }
    },

    handleKeydown: function(e) {
        if (!this.isActive) return;
        if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;

        switch(e.key.toLowerCase()) {
            case 'h':
                this.toggleUI();
                break;
            case 's':
                this.cycleSponsorshipSelection();
                break;
            case 'o':
                this.cycleOperatorSelection();
                break;
        }
    },

    toggleUI: function() {
        const uiLayer = document.getElementById('vis-ui-layer');
        if (uiLayer) uiLayer.classList.toggle('hidden');
    },

    cycleSponsorshipSelection: function() {
        const sponsorships = this.nodes.filter(n => n.type === 'sponsorship');
        if (sponsorships.length === 0) return;

        let nextIndex = 0;
        if (this.selectedNodeId) {
            const currentIndex = sponsorships.findIndex(n => n.id === this.selectedNodeId);
            if (currentIndex !== -1) {
                nextIndex = (currentIndex + 1) % sponsorships.length;
            }
        }
        const targetNode = sponsorships[nextIndex];
        this.selectNode(targetNode);
    },

    cycleOperatorSelection: function() {
        let targets = [];
        if (this.isLiveMode) {
            const seenOps = new Set();
            this.nodes.forEach(n => {
                if (n.type === 'live-node' && !seenOps.has(n.operatorId)) {
                    seenOps.add(n.operatorId);
                    targets.push(n);
                }
            });
        } else {
            targets = this.nodes.filter(n => n.type === 'operator');
        }

        if (targets.length === 0) return;

        let nextIndex = 0;
        if (this.selectedOperatorId) {
            const currentIndex = targets.findIndex(n => {
                if (this.isLiveMode) return n.operatorId === this.selectedOperatorId;
                return n.id === this.selectedOperatorId;
            });
            if (currentIndex !== -1) {
                nextIndex = (currentIndex + 1) % targets.length;
            }
        }
        this.selectNode(targets[nextIndex]);
    },

    findNodeUnderPointer: function(event) {
        const [mx, my] = d3.pointer(event, this.canvas);
        const wx = (mx - this.transform.x) / this.transform.k;
        const wy = (my - this.transform.y) / this.transform.k;
        
        for (let i = this.nodes.length - 1; i >= 0; i--) {
            const node = this.nodes[i];
            const isTouch = (event.sourceEvent && event.sourceEvent.type && event.sourceEvent.type.startsWith('touch')) || (event.pointerType === 'touch');
            const touchBuffer = isTouch ? 40 : 10; 
            
            const hitRadius = node.radius + (node.type === 'live-node' ? 20 : 0) + touchBuffer;
            
            if ((wx - node.x)**2 + (wy - node.y)**2 < hitRadius**2) {
                return { node, wx, wy }; 
            }
        }
        return null;
    },

    dragSubject: function(event) {
        const hit = this.findNodeUnderPointer(event);
        if (hit) {
            if (hit.node.id === this.selectedNodeId) {
                hit.node.x = hit.wx;
                hit.node.y = hit.wy;
                return hit.node;
            }
        }
        return null; 
    },

    dragStarted: function(event) {
        this.isDragging = true;
        
        if (this.simulation) {
            if (!event.active) this.simulation.alphaTarget(0.3).restart();
        }
        
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
    },

    dragged: function(event) {
        event.subject.fx = event.x;
        event.subject.fy = event.y;
        event.subject.x = event.x;
        event.subject.y = event.y;
        
        // Immediate render for responsiveness
        this.requestRender();
    },

    dragEnded: function(event) {
        this.isDragging = false;
        
        const keepFixed = this.isLiveMode && event.subject.type === 'sponsorship';
        
        if (this.simulation) {
            if (!event.active) this.simulation.alphaTarget(0.01);
        }

        if (keepFixed) {
            event.subject.fx = event.x;
            event.subject.fy = event.subject.y;
        } else {
            event.subject.fx = null;
            event.subject.fy = null;
        }
    },

    handleCanvasClick: function(event) {
        if (this.isDragging) return;
        const hit = this.findNodeUnderPointer(event);
        if (hit) {
            this.selectNode(hit.node);
        } else {
            this.selectNode(null);
        }
    },

    selectNode: function(node) {
        if (node) {
            this.selectedNodeId = node.id;
            if (node.type === 'live-node') {
                this.selectedOperatorId = node.operatorId;
            } else if (node.type === 'operator') {
                this.selectedOperatorId = node.id;
            } else {
                this.selectedOperatorId = null;
            }
            this.updateSelectionUI(node);
        } else {
            this.selectedNodeId = null;
            this.selectedOperatorId = null;
            this.updateSelectionUI(null);
        }
        this.requestRender();
    },
    
    handleSearch: function(query) {
        const resultsContainer = document.getElementById('vis-search-results');
        const btnClear = document.getElementById('vis-btn-clear-search');
        
        if (!query || query.trim() === '') {
            resultsContainer.classList.add('hidden');
            btnClear.classList.add('hidden');
            return;
        }
        
        btnClear.classList.remove('hidden');
        
        const lowerQuery = query.toLowerCase();
        const matches = this.operatorSearchIndex.filter(item => 
            item.name.toLowerCase().includes(lowerQuery) || 
            item.id.toLowerCase().includes(lowerQuery)
        ).slice(0, 10); 

        if (matches.length === 0) {
            resultsContainer.innerHTML = '<div class="p-3 text-gray-500 text-xs text-center">No results found</div>';
        } else {
            resultsContainer.innerHTML = matches.map(item => `
                <div class="search-item p-3 hover:bg-white/5 cursor-pointer flex items-center gap-3 transition-colors border-b border-white/5 last:border-none" data-id="${item.id}">
                    <div class="w-8 h-8 rounded-full ${item.type === 'operator' ? 'bg-blue-500/20 text-blue-400' : 'bg-orange-500/20 text-orange-400'} border border-white/10 flex items-center justify-center text-[10px] font-bold shrink-0">
                        ${item.type === 'operator' ? 'OP' : 'DEL'}
                    </div>
                    <div class="min-w-0 flex-1">
                        <div class="text-xs font-bold text-white truncate">${item.name}</div>
                        <div class="text-[10px] font-mono text-gray-500 truncate">${item.id.substring(0, 16)}...</div>
                    </div>
                    <i data-lucide="chevron-right" class="w-3 h-3 text-gray-600"></i>
                </div>
            `).join('');
            
            if (window.lucide) window.lucide.createIcons({ root: resultsContainer });

            resultsContainer.querySelectorAll('.search-item').forEach(item => {
                item.addEventListener('click', () => {
                    const id = item.getAttribute('data-id');
                    this.selectEntityFromSearch(id);
                    resultsContainer.classList.add('hidden');
                    document.getElementById('vis-search-input').value = matches.find(m => m.id === id).name;
                });
            });
        }
        resultsContainer.classList.remove('hidden');
    },

    selectEntityFromSearch: function(id) {
        let targetNode = this.nodes.find(n => n.id === id);
        
        if (targetNode) {
            this.selectNode(targetNode);
            
            const scale = 2;
            const x = -targetNode.x * scale + this.width / 2;
            const y = -targetNode.y * scale + this.height / 2;
            
            d3.select(this.canvas).transition().duration(750).call(
                d3.zoom().transform, 
                d3.zoomIdentity.translate(x, y).scale(scale)
            );
        } else if (this.isLiveMode) {
            this.selectOperatorFromSearch(id);
        }
        
        this.requestRender();
    },

    selectOperatorFromSearch: function(operatorId) {
        this.selectedOperatorId = operatorId;
        
        let targetNode = null;
        
        targetNode = this.nodes.find(n => n.id === operatorId);
        
        if (!targetNode) {
            targetNode = this.nodes.find(n => n.type === 'live-node' && n.operatorId === operatorId);
        }

        if (targetNode) {
            this.selectedNodeId = targetNode.id;
            this.updateSelectionUI(targetNode);
            
            const scale = 2;
            const x = -targetNode.x * scale + this.width / 2;
            const y = -targetNode.y * scale + this.height / 2;
            
            d3.select(this.canvas).transition().duration(750).call(
                d3.zoom().transform, 
                d3.zoomIdentity.translate(x, y).scale(scale)
            );
        } else {
            const meta = this.operatorNodeMetadata.get(operatorId);
            if (meta) {
                const dummyNode = {
                    id: operatorId,
                    type: 'operator', 
                    label: meta.label,
                    val: 0, 
                    operatorId: operatorId 
                };
                if (this.isLiveMode) dummyNode.type = 'live-node';
                
                this.updateSelectionUI(dummyNode);
            }
        }
        this.requestRender();
    },
    
    toggleLiveMode: async function(activate) {
        if (activate === this.isLiveMode) return; 

        this.isLiveMode = activate;
        this.isPlaying = false; 
        
        const modeTitle = document.getElementById('vis-control-title');
        const modeIcon = document.getElementById('vis-mode-icon');
        const liveInfoIcon = document.getElementById('vis-live-info-icon');
        
        const timeControls = document.getElementById('vis-time-controls-group');
        const timelineSettings = document.getElementById('vis-timeline-settings-group');
        const discoverySettings = document.getElementById('vis-discovery-settings-group');
        const simulationSettings = document.getElementById('vis-simulation-settings-group');
        const p2pContainer = document.getElementById('vis-p2p-mode-container');
        const entityCounter = document.getElementById('vis-entity-counter');
        const delegatorSettings = document.getElementById('vis-delegator-settings-container');
        const delegatorCounter = document.getElementById('vis-delegator-counter'); 
        
        if(activate) {
            modeTitle.textContent = "Live Node View";
            modeTitle.className = "text-xs font-medium text-green-400";
            if(modeIcon) {
                modeIcon.setAttribute('data-lucide', 'network');
                modeIcon.classList.replace('text-gray-400', 'text-green-400');
            }
            
            if (liveInfoIcon) liveInfoIcon.classList.remove('hidden');
            
            entityCounter.innerHTML = '<div class="flex items-center gap-2"><div class="w-3 h-3 border-2 border-gray-500 border-t-transparent rounded-full animate-spin"></div><span>CONNECTING</span></div>';
            
            if (timeControls) timeControls.classList.add('hidden');
            if (delegatorSettings) delegatorSettings.classList.add('hidden');
            if (delegatorCounter) delegatorCounter.classList.add('hidden');

            if(timelineSettings) timelineSettings.classList.add('hidden');
            if(discoverySettings) discoverySettings.classList.remove('hidden');
            if(simulationSettings) simulationSettings.classList.remove('hidden');
            
            if(p2pContainer) p2pContainer.classList.remove('hidden'); 
        } else {
            modeTitle.textContent = "Live Node View";
            modeTitle.className = "text-xs font-medium text-gray-300";
            if(modeIcon) {
                modeIcon.setAttribute('data-lucide', 'network');
                modeIcon.classList.replace('text-green-400', 'text-gray-400');
            }
            
            if (liveInfoIcon) liveInfoIcon.classList.add('hidden');
            
            if (timeControls) timeControls.classList.remove('hidden');
            if (delegatorSettings) delegatorSettings.classList.remove('hidden');

            if(timelineSettings) timelineSettings.classList.remove('hidden');
            if(discoverySettings) discoverySettings.classList.add('hidden');
            if(simulationSettings) simulationSettings.classList.add('hidden');
            
            if(p2pContainer) p2pContainer.classList.add('hidden'); 
        }
        
        if (window.lucide) window.lucide.createIcons();
        
        if (activate) {
            if (!this.streamrClient) {
                console.warn("VisualLogic: StreamrClient not set via setClient(). Live mode may fail.");
            }
            this.loadData(); 
        } else {
            await this.cleanupLiveMode();
            this.loadData(); 
        }
    },
    
    cleanupLiveMode: async function() {
        this.isLiveMode = false;

        this.operatorSubscriptionQueue = [];
        this.activeOperatorSubscriptions.clear();

        const promises = [];
        this.coordinationSubscriptions.forEach((sub) => {
            promises.push(sub.unsubscribe());
        });
        await Promise.all(promises);
        this.coordinationSubscriptions.clear();
        
        this.operatorNodeCounts.clear();
        this.operatorNodeMetadata.clear();
        this.operatorSponsorshipLinks.clear(); 
        this.nodeHeartbeats.clear();
        this.nodeSponsorshipAssignments.clear();
        this.p2pTopologyState.clear();
        this.nodeHeartbeatCounts.clear();
        
        // Do not destroy the client here, as it is shared with the main app.
        // The main app (services.js) manages the client lifecycle.
    },
    
    subscribeToOperator: async function(operatorId) {
        if (this.coordinationSubscriptions.has(operatorId) || !this.isLiveMode || !this.streamrClient) {
            return;
        }
        
        const streamId = `${operatorId}/operator/coordination`;
        this.operatorNodeCounts.set(operatorId, new Set());
        
        this.nodeHeartbeatCounts.set(operatorId, new Map());
        
        setTimeout(() => {
            if (this.isLiveMode && this.activeOperatorSubscriptions.has(operatorId)) {
                this.rotateOperatorSubscription(operatorId);
            }
        }, 45000);
        
        try {
            if (!this.streamrClient) return;

            const subscription = await this.streamrClient.subscribe(streamId, (message) => {
                this.handleCoordinationMessage(operatorId, message);
            });
            
            if (!this.isLiveMode) {
                await subscription.unsubscribe();
                return;
            }

            this.coordinationSubscriptions.set(operatorId, subscription);
        } catch (error) {
            if (error?.code === 'CLIENT_DESTROYED' || error?.message?.includes('destroyed')) {
                return;
            }
            console.error(`Error subscribing to ${streamId}:`, error);
            this.coordinationSubscriptions.delete(operatorId);
        }
    },
    
    handleCoordinationMessage: function(operatorId, message) {
        if (message?.msgType === 'heartbeat' && message?.peerDescriptor?.nodeId) {
            const nodeId = message.peerDescriptor.nodeId;
            const now = Date.now();
            
            this.nodeHeartbeats.set(nodeId, now);
            
            const nodes = this.operatorNodeCounts.get(operatorId);
            if (nodes && !nodes.has(nodeId)) {
                nodes.add(nodeId);
            }
            
            let opHeartbeats = this.nodeHeartbeatCounts.get(operatorId);
            if (!opHeartbeats) {
                opHeartbeats = new Map();
                this.nodeHeartbeatCounts.set(operatorId, opHeartbeats);
            }
            
            const currentCount = (opHeartbeats.get(nodeId) || 0) + 1;
            opHeartbeats.set(nodeId, currentCount);
            
            if (opHeartbeats.size > 0) {
                let allNodesSufficient = true;
                for (const count of opHeartbeats.values()) {
                    if (count < 2) {
                        allNodesSufficient = false;
                        break;
                    }
                }
                
                if (allNodesSufficient) {
                    this.rotateOperatorSubscription(operatorId);
                }
            }
            
            this.regenerateLiveNodes();
            this.requestRender();
        }
    },
    
    rotateOperatorSubscription: async function(oldOperatorId) {
        const sub = this.coordinationSubscriptions.get(oldOperatorId);
        if (sub) {
            await sub.unsubscribe();
            this.coordinationSubscriptions.delete(oldOperatorId);
        }
        this.activeOperatorSubscriptions.delete(oldOperatorId);
        this.nodeHeartbeatCounts.delete(oldOperatorId); 
        
        this.manageSubscriptions();
    },
    
    manageSubscriptions: function() {
        while (this.activeOperatorSubscriptions.size > this.MAX_CONCURRENT_SUBSCRIPTIONS) {
            const [toRemove] = this.activeOperatorSubscriptions;
            const sub = this.coordinationSubscriptions.get(toRemove);
            if (sub) sub.unsubscribe();
            
            this.coordinationSubscriptions.delete(toRemove);
            this.activeOperatorSubscriptions.delete(toRemove);
            this.nodeHeartbeatCounts.delete(toRemove);
        }

        while (this.activeOperatorSubscriptions.size < this.MAX_CONCURRENT_SUBSCRIPTIONS && this.operatorSubscriptionQueue.length > 0) {
            const nextOpId = this.operatorSubscriptionQueue.shift();
            this.operatorSubscriptionQueue.push(nextOpId); 
            this.activeOperatorSubscriptions.add(nextOpId);
            this.subscribeToOperator(nextOpId);
        }
    },
    
    regenerateLiveNodes: function() {
        if (!this.isLiveMode) return;

        const newNodes = [];
        const newLinks = [];

        
        const sponsorshipGroups = new Map(); 

        const sponsorships = this.nodes.filter(n => n.type === 'sponsorship');
        
        newNodes.push(...sponsorships);
        
        this.operatorNodeCounts.forEach((nodesSet, operatorId) => {
            
            const baseMetadata = this.operatorNodeMetadata.get(operatorId);
            if (!baseMetadata) return; 
            
            const knownNodesIds = Array.from(nodesSet).filter(nodeId => this.nodeHeartbeats.has(nodeId));
            
            const linkedSponsorships = Array.from(this.operatorSponsorshipLinks.get(operatorId) || []);
            const redundancyFactor = baseMetadata.redundancyFactor || 1; 

            knownNodesIds.forEach((nodeId, index) => {
                const nodeKey = `node-${nodeId}`;
                
                let existingNode = this.nodes.find(n => n.id === nodeKey);

                const node = existingNode || {
                    id: nodeKey,
                    type: 'live-node',
                    operatorId: operatorId,
                    radius: NODE_RADIUS,
                    label: `Node ${nodeId.slice(0, 4)}`,
                    x: baseMetadata.x + (index % 5 - 2) * 20, 
                    y: baseMetadata.y + (Math.floor(index / 5) - 2) * 20,
                    nodeIndex: index + 1 
                };
                
                if (existingNode) node.nodeIndex = index + 1;
                
                if (existingNode) {
                    node.vx = existingNode.vx;
                    node.vy = existingNode.vy;
                } else {
                    node.x = baseMetadata.x + (Math.random() - 0.5) * 10;
                    node.y = baseMetadata.y + (Math.random() - 0.5) * 10;
                    node.vx = baseMetadata.vx || 0;
                    node.vy = baseMetadata.vy || 0;
                }

                newNodes.push(node);
                
                let targetSponsorships = [];
                
                if (this.nodeSponsorshipAssignments.has(nodeKey)) {
                    targetSponsorships = this.nodeSponsorshipAssignments.get(nodeKey);
                } else {
                    if (linkedSponsorships.length > 0) {
                        if (linkedSponsorships.length <= redundancyFactor) {
                            targetSponsorships = linkedSponsorships;
                        } else {
                            const shuffled = [...linkedSponsorships].sort(() => 0.5 - Math.random());
                            targetSponsorships = shuffled.slice(0, redundancyFactor);
                        }
                    }
                    this.nodeSponsorshipAssignments.set(nodeKey, targetSponsorships);
                }

                const activeSponsorshipIds = new Set(sponsorships.map(s => s.id));
                const validOperatorSponsorships = new Set(linkedSponsorships);
                
                targetSponsorships = targetSponsorships.filter(id => 
                    activeSponsorshipIds.has(id) && validOperatorSponsorships.has(id)
                );
                
                if (targetSponsorships.length < this.nodeSponsorshipAssignments.get(nodeKey)?.length) {
                        this.nodeSponsorshipAssignments.set(nodeKey, targetSponsorships);
                }

                if (this.isP2PMode) {
                    targetSponsorships.forEach(spId => {
                        if (!sponsorshipGroups.has(spId)) sponsorshipGroups.set(spId, []);
                        sponsorshipGroups.get(spId).push(nodeKey);
                    });
                } else {
                    targetSponsorships.forEach(sponsorshipId => {
                        newLinks.push({ 
                            source: nodeKey, 
                            target: sponsorshipId, 
                            value: 1 
                        });
                    });
                }
            });
        });
        
        if (this.isP2PMode) {
            sponsorshipGroups.forEach((nodeKeys, sponsorshipId) => {
                let edges = this.p2pTopologyState.get(sponsorshipId);
                if (!edges) {
                    edges = new Set();
                    this.p2pTopologyState.set(sponsorshipId, edges);
                }

                const degrees = new Map(); 
                nodeKeys.forEach(k => degrees.set(k, 0));

                const validEdges = new Set();
                const adjacency = new Map(); 
                nodeKeys.forEach(k => adjacency.set(k, []));

                edges.forEach(edgeStr => {
                    const [a, b] = edgeStr.split('|');
                    if (degrees.has(a) && degrees.has(b)) {
                        if (degrees.get(a) < this.targetNodeDegree && degrees.get(b) < this.targetNodeDegree) {
                            degrees.set(a, degrees.get(a) + 1);
                            degrees.set(b, degrees.get(b) + 1);
                            validEdges.add(edgeStr);
                            
                            adjacency.get(a).push(b);
                            adjacency.get(b).push(a);
                        }
                    }
                });

                const visited = new Set();
                const components = []; 

                nodeKeys.forEach(startNode => {
                    if (!visited.has(startNode)) {
                        const component = [];
                        const queue = [startNode];
                        visited.add(startNode);
                        
                        while(queue.length > 0) {
                            const u = queue.shift();
                            component.push(u);
                            const neighbors = adjacency.get(u) || [];
                            neighbors.forEach(v => {
                                if(!visited.has(v)) {
                                    visited.add(v);
                                    queue.push(v);
                                }
                            });
                        }
                        components.push(component);
                    }
                });

                if (components.length > 1) {
                    for(let i = 0; i < components.length - 1; i++) {
                        const compA = components[i];
                        const compB = components[i+1];
                        
                        const candidatesA = compA.filter(n => degrees.get(n) < this.targetNodeDegree);
                        const candidatesB = compB.filter(n => degrees.get(n) < this.targetNodeDegree);
                        
                        const nodeA = candidatesA.length ? candidatesA[Math.floor(Math.random() * candidatesA.length)] : compA[Math.floor(Math.random() * compA.length)];
                        const nodeB = candidatesB.length ? candidatesB[Math.floor(Math.random() * candidatesB.length)] : compB[Math.floor(Math.random() * compB.length)];
                        
                        const edgeKey = nodeA < nodeB ? `${nodeA}|${nodeB}` : `${nodeB}|${nodeA}`;
                        
                        if (!validEdges.has(edgeKey)) {
                            validEdges.add(edgeKey);
                            degrees.set(nodeA, degrees.get(nodeA) + 1);
                            degrees.set(nodeB, degrees.get(nodeB) + 1);
                        }
                    }
                }

                const shuffledNodes = [...nodeKeys].sort(() => Math.random() - 0.5);
                
                for (let i = 0; i < shuffledNodes.length; i++) {
                    const nodeA = shuffledNodes[i];
                    if (degrees.get(nodeA) >= this.targetNodeDegree) continue;

                    for (let j = 0; j < shuffledNodes.length; j++) {
                        if (i === j) continue;
                        const nodeB = shuffledNodes[j];
                        
                        if (degrees.get(nodeB) >= this.targetNodeDegree) continue;
                        
                        const edgeKey = nodeA < nodeB ? `${nodeA}|${nodeB}` : `${nodeB}|${nodeA}`;
                        
                        if (!validEdges.has(edgeKey)) {
                            validEdges.add(edgeKey);
                            degrees.set(nodeA, degrees.get(nodeA) + 1);
                            degrees.set(nodeB, degrees.get(nodeB) + 1);
                            
                            if (degrees.get(nodeA) >= this.targetNodeDegree) break; 
                        }
                    }
                }

                this.p2pTopologyState.set(sponsorshipId, validEdges);
                
                validEdges.forEach(edgeStr => {
                    const [source, target] = edgeStr.split('|');
                    newLinks.push({ source, target, value: 1 });
                });
            });
        }
        
        const liveNodeCount = newNodes.filter(n => n.type === 'live-node').length;
        const entityCounter = document.getElementById('vis-entity-counter');
        
        if (liveNodeCount === 0 && this.isLiveMode) {
            entityCounter.innerHTML = '<div class="flex items-center gap-2"><div class="w-3 h-3 border-2 border-gray-500 border-t-transparent rounded-full animate-spin"></div><span>SEARCHING</span></div>';
        } else if (this.isLiveMode) {
            entityCounter.textContent = `${liveNodeCount} LIVE NODES`;
        }

        this.nodes = newNodes;
        this.links = newLinks;
        
        if (!this.simulation) { 
            this.initSimulation();
        } else {
            this.simulation.nodes(this.nodes);
            this.simulation.force("link").links(this.links);
            this.simulation.alpha(0.3).restart();
        }

        if (this.selectedNodeId) {
            const updatedSelectedNode = this.nodes.find(n => n.id === this.selectedNodeId);
            this.updateSelectionUI(updatedSelectedNode);
        }
    },
    
    initSettingsSliders: function() {
        this.addSafeListener('vis-max-subs-slider', 'input', (e) => {
            const val = parseInt(e.target.value);
            this.MAX_CONCURRENT_SUBSCRIPTIONS = val;
            const display = document.getElementById('vis-max-subs-display');
            if (display) display.textContent = val;
            if (this.isLiveMode) this.manageSubscriptions();
        });

        this.addSafeListener('vis-degree-slider', 'input', (e) => {
            const val = parseInt(e.target.value);
            this.targetNodeDegree = val;
            const display = document.getElementById('vis-degree-display');
            if (display) display.textContent = val;
            if (this.isLiveMode) this.regenerateLiveNodes();
        });

        this.addSafeListener('vis-btn-release-nodes', 'click', () => {
            this.nodes.forEach(n => { n.fx = null; n.fy = null; });
            this.simulation.alpha(0.3).restart();
        });

        this.addSafeListener('vis-jump-slider', 'input', (e) => {
            const val = parseInt(e.target.value);
            this.timeJumpStep = val / 10; 
            const display = document.getElementById('vis-jump-display');
            if (display) display.textContent = this.timeJumpStep.toFixed(1) + '%';
        });
        
        this.addSafeListener('vis-delay-slider', 'input', (e) => {
            const val = parseInt(e.target.value);
            this.refreshDelayMs = val;
            const display = document.getElementById('vis-delay-display');
            if (display) display.textContent = val + 'ms';
        });

        this.addSafeListener('vis-gravity-slider', 'input', (e) => {
            this.phyGravity = parseInt(e.target.value) / 1000;
            const display = document.getElementById('vis-gravity-display');
            if (display) display.textContent = this.phyGravity.toFixed(3);
            this.updatePhysics();
        });

        this.addSafeListener('vis-friction-slider', 'input', (e) => {
            this.phyFriction = parseInt(e.target.value) / 100;
            const display = document.getElementById('vis-friction-display');
            if (display) display.textContent = this.phyFriction.toFixed(2);
            this.updatePhysics();
        });

        this.addSafeListener('vis-repulsion-slider', 'input', (e) => {
            this.phyRepulsion = parseInt(e.target.value) / 10;
            const display = document.getElementById('vis-repulsion-display');
            if (display) display.textContent = this.phyRepulsion.toFixed(1) + 'x';
            this.updatePhysics();
        });

        this.addSafeListener('vis-tension-slider', 'input', (e) => {
            this.phyTension = parseInt(e.target.value) / 100;
            const display = document.getElementById('vis-tension-display');
            if (display) display.textContent = this.phyTension.toFixed(2);
            this.updatePhysics();
        });
    },

    updatePhysics: function() {
        if (!this.simulation) return;
        
        this.simulation.velocityDecay(this.phyFriction);
        
        this.simulation.force("charge")
            .strength(d => {
                const base = (d.type === 'sponsorship' ? -3000 : (d.type === 'operator' ? -800 : -100)); 
                return base * this.phyRepulsion;
            });
        
        this.simulation.force("x")
            .strength(this.phyGravity);
        
        this.simulation.force("y")
            .strength(this.phyGravity);
        
        this.simulation.force("link")
            .strength(this.phyTension);

        this.simulation.alpha(0.3).restart();
        this.requestRender();
    },

    resize: function() {
        this.updateDimensions();
        setTimeout(() => this.updateDimensions(), 300);
    },

    updateDimensions: function() {
        if (!this.canvas) return;
        this.width = window.innerWidth;
        this.height = window.innerHeight;
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        
        if (this.simulation) {
            this.simulation.force("center", d3.forceCenter(this.width / 2, this.height / 2));
            this.simulation.alpha(0.3).restart();
        }
        
        this.requestRender();
    },

    updateSelectionUI: function(node) {
        const card = document.getElementById('vis-selection-card');
        if (!card) return;
        
        if (!node || node.type === 'live-node') {
            if (node && node.type === 'live-node') {
                card.classList.remove('hidden');
            } else {
                card.classList.add('hidden');
                return;
            }
        } else {
            card.classList.remove('hidden');
        }

        const typeLabel = document.getElementById('vis-sel-type-label');
        const valElem = document.getElementById('vis-sel-val');
        const extraRow = document.getElementById('vis-sel-extra-row');
        const delegatorsRow = document.getElementById('vis-sel-delegators-row');
        const avatarElem = document.getElementById('vis-sel-avatar');
        const selValLabel = document.getElementById('vis-sel-val-label');
        const titleElem = document.getElementById('vis-sel-title');
        const tooltipElem = document.getElementById('vis-sel-title-tooltip');
        const gotoOperatorBtn = document.getElementById('vis-btn-goto-operator');
        
        const countRow = document.getElementById('vis-sel-count-row');
        const countLabel = document.getElementById('vis-sel-count-label');
        const countVal = document.getElementById('vis-sel-count');

        avatarElem.classList.add('hidden');
        countRow.classList.remove('hidden');
        delegatorsRow.classList.add('hidden');
        gotoOperatorBtn.classList.add('hidden');
        
        if (node.type === 'sponsorship') {
            titleElem.textContent = node.label;
            tooltipElem.textContent = node.label; 
            
            const stakedCount = this.links.filter(l => (l.target.id === node.id || l.target === node.id)).length;
            countLabel.textContent = this.isLiveMode ? "Staked Nodes" : "Staked Operators";
            countVal.textContent = stakedCount;

            selValLabel.textContent = 'Remaining Balance';
            valElem.textContent = Math.floor(node.val).toLocaleString() + ' DATA';
            valElem.className = "text-xs font-bold text-orange-400"; 
            
            extraRow.classList.remove('hidden');
            document.getElementById('vis-sel-extra').textContent = node.daysLeft.toFixed(1) + ' days';
            
            typeLabel.textContent = 'SPONSORSHIP';
            typeLabel.className = 'text-[9px] text-yellow-500 uppercase tracking-widest font-bold mb-0 leading-none';
            card.className = card.className.replace(/border-l-\w+/, 'border-l-yellow-500');

        } else if (node.type === 'operator' && !this.isLiveMode) { 
            titleElem.textContent = node.label;
            tooltipElem.textContent = node.label; 
            
            countLabel.textContent = "Sponsorships";
            
            const sponsCount = this.links.filter(l => (l.source.id === node.id || l.source === node.id) && l.target.type !== 'operator').length;
            countVal.textContent = sponsCount; 

            // Show Delegator Count
            delegatorsRow.classList.remove('hidden');
            const meta = this.operatorNodeMetadata.get(node.id);
            const delegatorCount = (meta && meta.delegatorCount) ? Math.max(0, meta.delegatorCount - 1) : 0;
            document.getElementById('vis-sel-delegators-count').textContent = delegatorCount;

            selValLabel.textContent = 'Total Stake';
            valElem.textContent = Math.floor(node.val).toLocaleString() + ' DATA';
            valElem.className = "text-xs font-bold text-blue-400"; 
            extraRow.classList.add('hidden');
            
            typeLabel.textContent = 'OPERATOR';
            typeLabel.className = 'text-[9px] text-blue-500 uppercase tracking-widest font-bold mb-0 leading-none';
            card.className = card.className.replace(/border-l-\w+/, 'border-l-blue-500');
            
            // Show goto operator button and store operator ID
            gotoOperatorBtn.classList.remove('hidden');
            gotoOperatorBtn.dataset.operatorId = node.id;
            
            // Initialize Lucide icons for the new button
            if (window.lucide) {
                setTimeout(() => window.lucide.createIcons(), 0);
            }
            
            const imgCache = this.imageCache.get(node.id);
            if(imgCache && imgCache.loaded) {
                avatarElem.classList.remove('hidden');
                avatarElem.style.backgroundImage = `url(${imgCache.img.src})`;
            }

        } else if (node.type === 'live-node') {
            const operatorId = node.operatorId;
            const opMetadata = this.operatorNodeMetadata.get(operatorId);
            const parentLabel = opMetadata ? opMetadata.label : operatorId.substring(0, 12) + '...';
            
            titleElem.textContent = parentLabel;
            tooltipElem.textContent = opMetadata ? opMetadata.label : operatorId; // Set Full Name in Tooltip
            
            let fleetSize = 0;
            const opNodes = this.operatorNodeCounts.get(node.operatorId);
            if (opNodes) fleetSize = opNodes.size;
            
            countLabel.textContent = "Fleet Size";
            countVal.textContent = fleetSize;

            selValLabel.textContent = 'Node ID';
            valElem.textContent = `Node #${node.nodeIndex}`;
            valElem.className = "text-xs font-bold text-white"; 
            
            extraRow.classList.add('hidden');
            
            typeLabel.textContent = 'LIVE NODE';
            typeLabel.className = 'text-[9px] text-green-500 uppercase tracking-widest font-bold mb-0 leading-none';
            card.className = card.className.replace(/border-l-\w+/, 'border-l-green-500');

        } else if (node.type === 'delegator') {
            titleElem.textContent = node.label;
            tooltipElem.textContent = node.id;
            
            countRow.classList.add('hidden');
            
            selValLabel.textContent = 'Delegated';
            valElem.textContent = Math.floor(node.val).toLocaleString() + ' DATA';
            valElem.className = "text-xs font-bold text-orange-400";
            
            extraRow.classList.add('hidden');
            
            typeLabel.textContent = 'DELEGATOR';
            typeLabel.className = 'text-[9px] text-orange-500 uppercase tracking-widest font-bold mb-0 leading-none';
            card.className = card.className.replace(/border-l-\w+/, 'border-l-orange-500');
        }
    },

    fetchMetadata: async function() {
        const query = `{ _meta { block { number timestamp } } }`;
        try {
            const res = await fetch(getGraphUrl(), { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({query}) });
            const json = await res.json();
            this.latestBlock = json.data._meta.block.number;
            this.latestTimestamp = json.data._meta.block.timestamp;
            this.currentViewTimestamp = this.latestTimestamp;
            this.updateDateDisplay(this.latestTimestamp);
        } catch(e) { console.error(e); }
    },

    handleSliderInput: function(e) {
        const percent = parseFloat(e.target.value);
        this.sliderValue = percent;
        if(e.isTrusted && this.isPlaying) this.togglePlay(); 
        this.updateDateFromPercent(percent);
    },

    updateDateFromPercent: function(percent) {
        const totalDuration = this.latestTimestamp - LAUNCH_DATE_TS;
        const targetTs = LAUNCH_DATE_TS + (totalDuration * (percent / 100));
        this.updateDateDisplay(targetTs);
        this.currentViewTimestamp = targetTs;
        return targetTs;
    },

    handleSliderChange: function(e) {
        this.fetchDataForPercent(parseFloat(e.target.value));
    },

    fetchDataForPercent: function(percent) {
        const targetTs = this.updateDateFromPercent(percent);
        
        if (targetTs >= this.latestTimestamp - 3600) { 
            this.loadData();
        } else {
            const timeDiffFromLatest = this.latestTimestamp - targetTs;
            const blocksToRewind = Math.floor(timeDiffFromLatest / AVG_BLOCK_TIME);
            const targetBlock = Math.max(0, this.latestBlock - blocksToRewind);
            this.loadData(targetBlock);
        }
    },

    updateDateDisplay: function(ts) {
        const date = new Date(ts * 1000);
        const display = document.getElementById('vis-current-date-display');
        if (display) {
            display.textContent = date.toLocaleDateString('en-GB', {
                day: '2-digit', month: 'short', year: 'numeric'
            });
        }
    },

    togglePlay: function() {
        if(this.isLiveMode) return; 
        
        this.isPlaying = !this.isPlaying;
        const btn = document.getElementById('vis-btn-play');
        
        if(this.isPlaying) {
            btn.innerHTML = '<i data-lucide="pause" class="w-3 h-3 fill-current"></i>';
            btn.classList.add('pulse-active');
            // Recreate Lucide icons after innerHTML change
            if (window.lucide) window.lucide.createIcons();
            const slider = document.getElementById('vis-time-slider');
            if(parseFloat(slider.value) >= 100) {
                slider.value = 0;
                this.sliderValue = 0;
                this.updateDateFromPercent(0);
                this.fetchDataForPercent(0);
            } else {
                this.advanceTimeline();
            }
        } else {
            btn.innerHTML = '<i data-lucide="play" class="w-3 h-3 ml-0.5 fill-current"></i>';
            btn.classList.remove('pulse-active');
            // Recreate Lucide icons after innerHTML change
            if (window.lucide) window.lucide.createIcons();
        }
        if (window.lucide) window.lucide.createIcons();
    },

    advanceTimeline: function() {
        if(!this.isPlaying || this.isLiveMode) return;
        const slider = document.getElementById('vis-time-slider');
        
        let newVal = this.sliderValue + this.timeJumpStep; 
        
        if(newVal >= 100) {
            newVal = 100;
            slider.value = newVal;
            this.sliderValue = newVal;
            this.updateDateFromPercent(newVal);
            if (this.isPlaying) this.togglePlay(); 
            this.loadData(); 
            return; 
        }

        newVal = Math.round(newVal * 100) / 100;

        slider.value = newVal;
        this.sliderValue = newVal;
        this.updateDateFromPercent(newVal);
        this.fetchDataForPercent(newVal); 
    },

    loadData: async function(blockNumber = null) {
        const loader = document.getElementById('vis-loading-indicator');
        const loadingText = document.getElementById('vis-loading-text');
        
        if (loader) {
            loader.classList.remove('hidden');
            loader.style.display = 'flex';
        }
        if (loadingText) {
            loadingText.textContent = blockNumber ? `Block #${blockNumber}...` : (this.isLiveMode ? "Fetching Live Operators..." : "Syncing...");
        }

        try {
            const delegationQuery = this.isShowDelegators ? `
                delegations(first: 1000, where: { isSelfDelegation: false }) {
                    id
                    delegator { id }
                    _valueDataWei
                }
            ` : '';

            if (this.isLiveMode && !blockNumber) {
                const queryOps = `
                    query GetEntities {
                        operators(first: 1000, skip: 0, orderBy: valueWithoutEarnings, orderDirection: desc, subgraphError: allow) {
                            id metadataJsonString contractVersion delegatorCount
                            ${delegationQuery}
                        }
                    }
                `;
                const querySpons = `
                    query {
                        sponsorships(first: 100, orderBy: totalStakedWei, orderDirection: desc, where: { isRunning: true }) {
                            id, stream { id }, remainingWei, totalStakedWei, projectedInsolvency
                            stakes(first: 1000, where: { amountWei_gt: "0" }) {
                                operator { id, valueWithoutEarnings, metadataJsonString, delegatorCount, ${delegationQuery} }, amountWei
                            }
                        }
                    }
                `;

                const [resOps, resSpons] = await Promise.all([
                    fetch(getGraphUrl(), { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({query: queryOps}) }),
                    fetch(getGraphUrl(), { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({query: querySpons}) })
                ]);

                const jsonOps = await resOps.json();
                const jsonSpons = await resSpons.json();

                if (jsonOps.data && jsonOps.data.operators) {
                    this.processOperators(jsonOps.data.operators);
                }
                
                if (jsonSpons.data && jsonSpons.data.sponsorships) {
                    this.processData(jsonSpons.data.sponsorships, null);
                }

            } else {
                // HISTORICAL MODE
                if (blockNumber !== null && this.dataCache.has(blockNumber + (this.isShowDelegators ? '_del' : ''))) {
                    if (loadingText) loadingText.innerHTML = `Block #${blockNumber} <span class="text-emerald-400 ml-2">⚡ CACHE</span>`;
                    const cachedData = this.dataCache.get(blockNumber + (this.isShowDelegators ? '_del' : ''));
                    this.processData(cachedData, blockNumber);
                    return;
                }

                if (blockNumber !== null && loadingText) {
                    loadingText.innerHTML = `Block #${blockNumber} <span class="text-blue-400 ml-2">🌐 API</span>`;
                }

                const blockArg = blockNumber !== null ? `, block: { number: ${blockNumber} }` : "";
                const query = `
                    query {
                        sponsorships(first: 100, orderBy: totalStakedWei, orderDirection: desc, where: { isRunning: true } ${blockArg}) {
                            id, stream { id }, remainingWei, totalStakedWei, projectedInsolvency
                            stakes(first: 1000, where: { amountWei_gt: "0" }) {
                                operator { id, valueWithoutEarnings, metadataJsonString, delegatorCount, ${delegationQuery} }, amountWei
                            }
                        }
                    }
                `;

                const res = await fetch(getGraphUrl(), { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({query}) });
                const json = await res.json();
                
                if (blockNumber !== null) this.dataCache.set(blockNumber + (this.isShowDelegators ? '_del' : ''), json.data.sponsorships);
                this.processData(json.data.sponsorships, blockNumber);
            }

        } catch (err) {
            console.error(err);
        } finally {
            if(!this.isPlaying && loader) setTimeout(() => { loader.style.display = 'none'; }, 200);
            if(this.isPlaying) setTimeout(() => this.advanceTimeline(), this.refreshDelayMs); 
        }
    },

    processOperators: function(operators) {
        this.operatorSearchIndex = [];
        this.operatorSubscriptionQueue = operators.map(op => op.id);
        this.activeOperatorSubscriptions.clear();
        
        operators.forEach(op => {
            const opId = op.id;
            let name = `Op ${opId.slice(0,5)}`;
            let redundancyFactor = 1;
            
            try {
                if(op.metadataJsonString) {
                    const meta = JSON.parse(op.metadataJsonString);
                    if(meta.name) name = meta.name;
                    if(meta.redundancyFactor) {
                        const rf = parseInt(meta.redundancyFactor);
                        if (!isNaN(rf) && rf >= 1) redundancyFactor = rf;
                    }
                }
            } catch(e) {}
            
            this.operatorSearchIndex.push({
                id: opId,
                name: name,
                type: 'operator'
            });
            
            const existing = this.operatorNodeMetadata.get(opId) || {};
            
            this.operatorNodeMetadata.set(opId, {
                x: existing.x || (this.width/2 + (Math.random() - 0.5) * 200),
                y: existing.y || (this.height/2 + (Math.random() - 0.5) * 200),
                vx: existing.vx || 0,
                vy: existing.vy || 0,
                label: name,
                redundancyFactor: redundancyFactor,
                delegatorCount: op.delegatorCount || 0,
                delegations: op.delegations || [] 
            });
        });
        
        this.manageSubscriptions();
    },

    processData: function(sponsorships, blockNumber) {
        const nodesMap = new Map();
        const links = [];
        const now = this.currentViewTimestamp || (Date.now() / 1000);
        const processedDelegationOps = new Set(); 
        
        if (!this.isLiveMode) {
            this.operatorSearchIndex = [];
        } else {
            this.operatorSponsorshipLinks.clear(); 
        }

        sponsorships.forEach(s => {
            const sId = s.id;
            const remaining = parseFloat(s.remainingWei) / 1e18;
            let radius = Math.max(15, Math.min(Math.sqrt(remaining) * 0.36, 400)); 
            let daysLeft = 0;
            const insolvency = parseInt(s.projectedInsolvency);
            if (insolvency) daysLeft = Math.max(0, (insolvency - now) / (24 * 3600));

            const label = s.stream && s.stream.id ? s.stream.id : `Stream ${sId.slice(0,6)}`;

            if (!nodesMap.has(sId)) {
                nodesMap.set(sId, {
                    id: sId, type: 'sponsorship', val: remaining, radius: radius, 
                    label: label, daysLeft: daysLeft,
                    x: this.width/2 + (Math.random() - 0.5) * 50,
                    y: this.height/2 + (Math.random() - 0.5) * 50
                });
            } else {
                const existing = nodesMap.get(sId);
                existing.val = remaining; existing.radius = radius; existing.daysLeft = daysLeft;
                existing.label = label;
            }

            s.stakes.forEach(stake => {
                const op = stake.operator;
                const opId = op.id;
                const opStakeTotal = parseFloat(op.valueWithoutEarnings) / 1e18;
                const stakeAmount = parseFloat(stake.amountWei) / 1e18;

                let name = `Op ${opId.slice(0,5)}`;
                let imageUrl = null;
                let redundancyFactor = 1;

                // Use cached metadata to avoid repeated JSON parsing
                let meta = this.metadataCache.get(opId);
                if (!meta && op.metadataJsonString) {
                    try {
                        meta = JSON.parse(op.metadataJsonString);
                        this.metadataCache.set(opId, meta);
                    } catch(e) {
                        meta = null;
                    }
                }
                
                if (meta) {
                    if(meta.name) name = meta.name;
                    if(meta.imageIpfsCid) {
                        imageUrl = `https://wsrv.nl/?url=https://ipfs.io/ipfs/${meta.imageIpfsCid}&w=120&h=120&output=webp`;
                    }
                    if(meta.redundancyFactor) {
                        const rf = parseInt(meta.redundancyFactor);
                        if (!isNaN(rf) && rf >= 1) redundancyFactor = rf;
                    }
                }

                if (!this.isLiveMode) {
                    if (!this.operatorSearchIndex.find(i => i.id === opId)) {
                        this.operatorSearchIndex.push({ id: opId, name: name, type: 'operator' });
                    }
                }

                if(imageUrl && !this.imageCache.has(opId)) {
                    const img = new Image();
                    img.crossOrigin = "Anonymous";
                    img.src = imageUrl;
                    this.imageCache.set(opId, { loaded: false, img: img });
                    img.onload = () => {
                        this.imageCache.set(opId, { loaded: true, img: img });
                        this.requestRender();
                    };
                }
                
                const operatorNodeExists = nodesMap.has(opId);
                
                const initialX = this.width/2 + (Math.random() - 0.5) * 200;
                const initialY = this.height/2 + (Math.random() - 0.5) * 200;

                if (!operatorNodeExists && !this.isLiveMode) {
                    let opRadius = Math.max(5, Math.min(Math.sqrt(opStakeTotal) * 0.05, 150));
                    nodesMap.set(opId, {
                        id: opId, type: 'operator', val: opStakeTotal, radius: opRadius, label: name,
                        x: initialX, y: initialY
                    });
                }
                
                // Get existing metadata or use node from map, fallback to empty object
                const currentMeta = this.operatorNodeMetadata.get(opId);
                const nodeInMap = nodesMap.get(opId);
                const sourceNode = nodeInMap || currentMeta || {};

                this.operatorNodeMetadata.set(opId, {
                    x: sourceNode.x || initialX,
                    y: sourceNode.y || initialY,
                    vx: sourceNode.vx || 0,
                    vy: sourceNode.vy || 0,
                    label: name,
                    redundancyFactor: redundancyFactor,
                    delegatorCount: op.delegatorCount || 0,
                    delegations: op.delegations || [] 
                });
                
                if (!this.isLiveMode) {
                    if(operatorNodeExists) {
                        const existing = nodesMap.get(opId);
                        existing.val = opStakeTotal; 
                        existing.radius = Math.max(5, Math.min(Math.sqrt(opStakeTotal) * 0.05, 150));
                    }
                    links.push({ source: opId, target: sId, value: stakeAmount });

                    if (this.isShowDelegators && op.delegations && !processedDelegationOps.has(opId)) {
                        processedDelegationOps.add(opId);
                        op.delegations.forEach(d => {
                            const delegatorId = d.delegator.id;
                            const amount = parseFloat(d._valueDataWei) / 1e18;
                            
                            if (!nodesMap.has(delegatorId)) {
                                nodesMap.set(delegatorId, {
                                    id: delegatorId,
                                    type: 'delegator',
                                    label: `Del ${delegatorId.slice(0,4)}`,
                                    val: 0,
                                    radius: 4, 
                                    x: sourceNode.x + (Math.random() - 0.5) * 50,
                                    y: sourceNode.y + (Math.random() - 0.5) * 50
                                });
                                
                                if (!this.operatorSearchIndex.find(i => i.id === delegatorId)) {
                                    this.operatorSearchIndex.push({
                                        id: delegatorId,
                                        name: `Delegator ${delegatorId.slice(0,6)}...`,
                                        type: 'delegator'
                                    });
                                }
                            }

                            const delegatorNode = nodesMap.get(delegatorId);
                            delegatorNode.val += amount;
                            delegatorNode.radius = Math.max(4, Math.min(Math.sqrt(delegatorNode.val) * 0.3, 20));

                            links.push({
                                source: delegatorId,
                                target: opId,
                                value: amount,
                                type: 'delegation'
                            });
                        });
                    }
                } else {
                    if (!this.operatorSponsorshipLinks.has(opId)) {
                        this.operatorSponsorshipLinks.set(opId, new Set());
                    }
                    this.operatorSponsorshipLinks.get(opId).add(sId);
                }
            });
        });

        let newNodes = Array.from(nodesMap.values());
        let finalLinks = links;

        if (this.simulation) {
            const oldNodesMap = new Map(this.nodes.map(n => [n.id, n]));
            
            // Optimize position restoration - only process nodes that exist in old map
            for (const n of newNodes) {
                const old = oldNodesMap.get(n.id);
                if (old) {
                    n.x = old.x; n.y = old.y; n.vx = old.vx; n.vy = old.vy;
                    
                    if ((n.type === 'operator' || n.type === 'sponsorship')) {
                        const meta = this.operatorNodeMetadata.get(n.id);
                        if (meta) {
                            meta.x = n.x; meta.y = n.y;
                            meta.vx = n.vx; meta.vy = n.vy;
                        }
                    }
                }
            }
        }
        

        if (!this.isLiveMode) {
            // Count operators and delegators in single pass
            let opCount = 0, delCount = 0;
            for (const n of newNodes) {
                if (n.type === 'operator') opCount++;
                else if (n.type === 'delegator') delCount++;
            }
            
            let displayText = `${opCount} OPERATORS`;
            if (this.isShowDelegators) {
                displayText = `${opCount} OPS, ${delCount} DELEGATORS`;
            }
            
            const counterEl = document.getElementById('vis-entity-counter');
            if(counterEl) counterEl.textContent = displayText;
        }		

        this.nodes = newNodes;
        this.links = finalLinks;

        if (this.isLiveMode) {
            this.simulation?.stop(); 
            this.regenerateLiveNodes(); 
        }

        if (this.selectedNodeId) {
            const updatedSelectedNode = this.nodes.find(n => n.id === this.selectedNodeId);
            this.updateSelectionUI(updatedSelectedNode);
        }
        
        if (!this.simulation) {
            this.initSimulation();
        } else {
            // Update existing simulation
            this.simulation.nodes(this.nodes);
            this.simulation.force("link").links(this.links);
            this.simulation.alpha(0.3).restart();
        }
    },

    /**
     * Initialize physics simulation using D3
     */
    initSimulation: function() {
        // Build node map for quick lookups
        this.nodeMap.clear();
        for (const node of this.nodes) {
            this.nodeMap.set(node.id, node);
        }
        
        if(this.simulation) this.simulation.stop();
        
        this.simulation = d3.forceSimulation(this.nodes)
            .velocityDecay(this.phyFriction)
            .force("link", d3.forceLink(this.links).id(d => d.id).distance(d => {
                if (d.type === 'delegation') return 30; 
                if (this.isLiveMode && d.source.type === 'live-node') {
                    return d.source.radius + d.target.radius + 15;
                }
                return d.source.radius + d.target.radius + 50;
            }).strength(d => {
                
                const baseTension = this.phyTension; 
                
                if (!d.value) return baseTension;

                const multiplier = 1 + (Math.log1p(d.value) * 0.1);
                
                return Math.min(baseTension * multiplier, 1.0);
            }))
            .force("charge", d3.forceManyBody().strength(d => {
                if (d.type === 'delegator') return -50;
                const baseRepulsion = (d.type === 'sponsorship' ? -3000 : (d.type === 'operator' ? -800 : -100));
                return baseRepulsion * this.phyRepulsion;
            }))
            .force("collide", d3.forceCollide().radius(d => d.radius + (this.isLiveMode && d.type === 'live-node' ? 1 : 10)).iterations(2))
            .force("center", d3.forceCenter(this.width / 2, this.height / 2))
            .force("x", d3.forceX(this.width / 2).strength(this.phyGravity))
            .force("y", d3.forceY(this.height / 2).strength(this.phyGravity))
            .alpha(0.3)
            .alphaTarget(0.02)
            .alphaDecay(0.03) // Faster decay to settle physics sooner
            .restart()
            .on("tick", () => {
                if (this.isLiveMode) { 
                        this.nodes.filter(n => n.type === 'sponsorship').forEach(n => {
                            const meta = this.operatorNodeMetadata.get(n.id);
                            if (meta) {
                            meta.x = n.x; meta.y = n.y;
                            meta.vx = n.vx; meta.vy = n.vy;
                            this.operatorNodeMetadata.set(n.id, meta); 
                            }
                        });
                }
                this.requestRender();
            });
    },

    requestRender: function() {
        if (!this.renderRequested) {
            this.renderRequested = true;
            requestAnimationFrame(() => {
                this.render();
                this.renderRequested = false;
                
                // Continue rendering in live mode for smooth animations
                if (this.isLiveMode) {
                    this.requestRender();
                }
            });
        }
    },

    render: function() {
        const ctx = this.ctx;
        if (!ctx) return; // Safety check
        ctx.save();
        ctx.clearRect(0, 0, this.width, this.height);
        
        ctx.translate(this.transform.x, this.transform.y);
        ctx.scale(this.transform.k, this.transform.k);

        const selectedNode = this.nodes.find(n => n.id === this.selectedNodeId);
        
        const isSelectionActive = !!selectedNode;
        const selectedSponsorshipEdges = (selectedNode && selectedNode.type === 'sponsorship' && this.isP2PMode) ? this.p2pTopologyState.get(selectedNode.id) : null;

        const linksStandard = [];
        const linksHighlightSponsorship = []; 
        const linksHighlightDelegation = [];  

        this.links.forEach(link => {
            let isHighlighted = false;
            const src = link.source;
            const tgt = link.target;
            const srcId = src.id || src;
            const tgtId = tgt.id || tgt;

            if (isSelectionActive) {
                
                if (srcId === this.selectedNodeId || tgtId === this.selectedNodeId) {
                    isHighlighted = true;
                }

                if (selectedNode.type === 'sponsorship' && this.isP2PMode) {
                    const key = srcId < tgtId ? `${srcId}|${tgtId}` : `${tgtId}|${srcId}`;
                    if (selectedSponsorshipEdges && selectedSponsorshipEdges.has(key)) {
                        isHighlighted = true;
                    }
                }

                
                if (this.isLiveMode && this.selectedOperatorId) {
                    const isSrcFleet = src.operatorId === this.selectedOperatorId;
                    const isTgtFleet = tgt.operatorId === this.selectedOperatorId;
                    
                    if (isSrcFleet || isTgtFleet) {
                        isHighlighted = true;
                    }
                }
            }
            
            
            if (isHighlighted) {
                if (link.type === 'delegation') {
                    linksHighlightDelegation.push(link);
                } else {
                    linksHighlightSponsorship.push(link);
                }
            } else {
                linksStandard.push(link);
            }
        });

        
        if (linksStandard.length > 0) {
            ctx.beginPath();
            linksStandard.forEach(link => {
                ctx.moveTo(link.source.x, link.source.y);
                ctx.lineTo(link.target.x, link.target.y);
            });
            ctx.strokeStyle = COLOR_LINK;
            ctx.lineWidth = 1.5; 
            ctx.stroke();
        }

        
        if (linksHighlightSponsorship.length > 0) {
            ctx.save();
            ctx.beginPath();
            linksHighlightSponsorship.forEach(link => {
                ctx.moveTo(link.source.x, link.source.y);
                ctx.lineTo(link.target.x, link.target.y);
            });
            
            // --- CONTROL: OPERATOR <-> SPONSORSHIP ---
            ctx.shadowBlur = 30;                          // <--- INTENSIDADE DO BRILHO
            ctx.shadowColor = "rgba(255, 255, 255, 0.9)"; // <--- COR DO BRILHO
            ctx.strokeStyle = "#ffffff";                  // <--- COR DA LINHA
            ctx.lineWidth = 5.5;                          // <--- ESPESSURA
            
            ctx.stroke();
            ctx.restore();
        }

        //DELEGATOR 
        if (linksHighlightDelegation.length > 0) {
            ctx.save();
            ctx.beginPath();
            linksHighlightDelegation.forEach(link => {
                ctx.moveTo(link.source.x, link.source.y);
                ctx.lineTo(link.target.x, link.target.y);
            });
            
            // --- CONTROL: OPERATOR <-> DELEGATOR ---
            ctx.shadowBlur = 6;                          // <--- INTENSIDADE DO BRILHO
            ctx.shadowColor = "rgba(255, 255, 255, 0.4)"; // <--- COR DO BRILHO
            ctx.strokeStyle = "#c4c4c4";                  // <--- COR DA LINHA
            ctx.lineWidth = 2.0;                          // <--- ESPESSURA

            ctx.stroke();
            ctx.restore();
        }

        this.nodes.forEach(node => {
            let hasImage = false;
            const imgData = this.imageCache.get(node.id);
            
            let isFleetMember = false;
            if (this.selectedOperatorId) {
                if (node.type === 'live-node' && node.operatorId === this.selectedOperatorId) isFleetMember = true;
                if (node.type === 'operator' && node.id === this.selectedOperatorId) isFleetMember = true;
            }

            if (node.type === 'live-node') {
                const isSelected = this.selectedNodeId === node.id;
                ctx.beginPath();
                
                if (isSelected) ctx.fillStyle = '#fbbf24'; 
                else if (isFleetMember) ctx.fillStyle = '#60a5fa'; 
                else ctx.fillStyle = NODE_COLOR; 
                
                ctx.arc(node.x, node.y, node.radius, 0, 2 * Math.PI);
                ctx.fill();

                if (isSelected || isFleetMember) {
                    
                    
                    const pulse = Math.sin(Date.now() / 100) * 0.5 + 2;
                    ctx.beginPath();
                    ctx.arc(node.x, node.y, node.radius + pulse, 0, 2 * Math.PI);
                    ctx.strokeStyle = isSelected ? "rgba(251, 191, 36, 0.5)" : "rgba(96, 165, 250, 0.5)"; 
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                    
                }
                
            } else if (node.type === 'operator' && imgData && imgData.loaded && !this.isLiveMode) {
                hasImage = true;
                ctx.save();
                ctx.beginPath();
                ctx.arc(node.x, node.y, node.radius, 0, 2 * Math.PI);
                ctx.closePath();
                ctx.clip(); 
                try {
                    ctx.drawImage(imgData.img, node.x - node.radius, node.y - node.radius, node.radius * 2, node.radius * 2);
                } catch(e) {
                    ctx.fillStyle = COLOR_OPERATOR;
                    ctx.fill();
                }
                ctx.restore();
                
            } else if (node.type === 'sponsorship') {
                ctx.beginPath();

                const isLow = node.daysLeft < 7;
                const baseColor = isLow ? COLOR_SPONSORSHIP_LOW : COLOR_SPONSORSHIP;
                
                const highlightColor = isLow ? '#fca5a5' : '#fdba74'; 
                const gradient = ctx.createRadialGradient(
                    node.x - node.radius / 3, 
                    node.y - node.radius / 3, 
                    node.radius / 10,         
                    node.x,                   
                    node.y,                   
                    node.radius               
                );
                gradient.addColorStop(0, highlightColor); 
                gradient.addColorStop(1, baseColor);      
                ctx.fillStyle = gradient;
                

                ctx.arc(node.x, node.y, node.radius, 0, 2 * Math.PI);
                ctx.fill(); 
                
                
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = "rgba(255, 255, 255, 0.4)"; 
                ctx.stroke();
                

            } else if (node.type === 'delegator') {
                // TRIANGLE DRAW
                ctx.beginPath();
                ctx.moveTo(node.x, node.y - node.radius);
                ctx.lineTo(node.x + node.radius * 0.866, node.y + node.radius * 0.5);
                ctx.lineTo(node.x - node.radius * 0.866, node.y + node.radius * 0.5);
                ctx.closePath();
                ctx.fillStyle = COLOR_DELEGATOR;
                ctx.fill();
            } else if (node.type === 'operator' && !this.isLiveMode) {
                ctx.beginPath();
                ctx.fillStyle = COLOR_OPERATOR;
                ctx.arc(node.x, node.y, node.radius, 0, 2 * Math.PI);
                ctx.fill();
            }


            if (node.type !== 'live-node') {
                if (this.selectedNodeId === node.id || isFleetMember) {
                    ctx.lineWidth = 4;
                    ctx.strokeStyle = (this.selectedNodeId === node.id) ? "#fbbf24" : "#60a5fa";

                    if (node.type === 'delegator') {
                        // Triangle highlight
                        ctx.beginPath();
                        ctx.moveTo(node.x, node.y - node.radius);
                        ctx.lineTo(node.x + node.radius * 0.866, node.y + node.radius * 0.5);
                        ctx.lineTo(node.x - node.radius * 0.866, node.y + node.radius * 0.5);
                        ctx.closePath();
                        ctx.stroke();
                    } else {
                        ctx.beginPath();
                        ctx.arc(node.x, node.y, node.radius, 0, 2 * Math.PI);
                        ctx.stroke();
                    }

                    // Pulse effect for circles only 
                    if (node.type !== 'delegator') {
                        const pulse = Math.sin(Date.now() / 200) * 2 + 6;
                        ctx.beginPath();
                        ctx.arc(node.x, node.y, node.radius + pulse, 0, 2 * Math.PI);
                        ctx.strokeStyle = (this.selectedNodeId === node.id) ? "rgba(251, 191, 36, 0.5)" : "rgba(96, 165, 250, 0.5)";
                        ctx.lineWidth = 2;
                        ctx.stroke();
                    }

                } else if (this.hoveredNode === node) {
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = '#fff';
                    
                    if (node.type === 'delegator') {
                        ctx.beginPath();
                        ctx.moveTo(node.x, node.y - node.radius);
                        ctx.lineTo(node.x + node.radius * 0.866, node.y + node.radius * 0.5);
                        ctx.lineTo(node.x - node.radius * 0.866, node.y + node.radius * 0.5);
                        ctx.closePath();
                        ctx.stroke();
                    } else {
                        ctx.beginPath();
                        ctx.arc(node.x, node.y, node.radius, 0, 2 * Math.PI);
                        ctx.shadowBlur = 15;
                        ctx.shadowColor = node.type === 'operator' ? COLOR_OPERATOR : COLOR_SPONSORSHIP;
                        ctx.stroke();
                        ctx.shadowBlur = 0; 
                    }

                } else if (hasImage) {
                    ctx.beginPath();
                    ctx.arc(node.x, node.y, node.radius, 0, 2 * Math.PI);
                    ctx.strokeStyle = COLOR_OPERATOR;
                    ctx.lineWidth = 2;
                    ctx.stroke();
                }
            }
        });

        ctx.fillStyle = "#fff";
        ctx.font = "500 10px Inter";
        ctx.textAlign = "center";
        this.nodes.forEach(node => {
            const isFleetMember = (this.selectedOperatorId && ((node.type === 'live-node' && node.operatorId === this.selectedOperatorId) || (node.type === 'operator' && node.id === this.selectedOperatorId)));

            if (node.type === 'sponsorship' || node.type === 'operator' || this.hoveredNode === node || this.selectedNodeId === node.id || isFleetMember || this.transform.k > 2) {
            
                if (node.type === 'delegator' && this.transform.k < 2.5 && this.hoveredNode !== node) return;

                if(node.type === 'live-node' && this.transform.k < 2.5 && this.hoveredNode !== node && this.selectedNodeId !== node.id && !isFleetMember) return;
                if (node.type === 'live-node' && !isFleetMember && this.selectedNodeId !== node.id && this.hoveredNode !== node) return; 
                
                if (this.selectedNodeId === node.id) ctx.font = "bold 12px Inter";
                else ctx.font = "500 10px Inter";
                
                let labelToDraw = node.label;
                if (node.type === 'live-node' && isFleetMember) {
                        const meta = this.operatorNodeMetadata.get(node.operatorId);
                        if (meta) labelToDraw = meta.label;
                }

                ctx.fillText(labelToDraw.substring(0, 18), node.x, node.y + node.radius + 14);
            }
        });

        ctx.restore();
        
        if (this.selectedNodeId || this.isLiveMode || this.selectedOperatorId) {
            this.requestRender();
        }
    },

    zoomed: function(event) {
        this.transform = event.transform;
        this.requestRender();
    },

    mouseMoved: function(event) {
        const [mx, my] = d3.pointer(event, this.canvas);
        const wx = (mx - this.transform.x) / this.transform.k;
        const wy = (my - this.transform.y) / this.transform.k;

        let found = null;
        for (let i = this.nodes.length - 1; i >= 0; i--) {
            const node = this.nodes[i];
            const hitRadius = node.radius + (node.type === 'live-node' ? 20 : 0); 
            const dx = wx - node.x;
            const dy = wy - node.y;
            if (dx*dx + dy*dy < hitRadius*hitRadius) {
                found = node;
                break;
            }
        }

        if (found !== this.hoveredNode) {
            this.hoveredNode = found;
            this.requestRender();
            this.updateTooltip(found, event.clientX, event.clientY);
        } else if (found) {
            this.updateTooltip(found, event.clientX, event.clientY);
        } else {
            const tooltip = document.getElementById('vis-tooltip');
            if(tooltip) tooltip.style.opacity = 0;
        }
    },
    
    updateTooltip: function(node, x, y) {
        if (window.matchMedia("(pointer: coarse)").matches) {
            const tooltip = document.getElementById('vis-tooltip');
            if(tooltip) tooltip.style.opacity = 0;
            return;
        }

        if (node && this.selectedNodeId === node.id) {
            const tooltip = document.getElementById('vis-tooltip');
            if(tooltip) tooltip.style.opacity = 0;
            return;
        }
        
        const el = document.getElementById('vis-tooltip');
        if (!el) return;
        
        if (!node) { el.style.opacity = 0; return; }

        let html = '';
        if (node.type === 'sponsorship') {
            html = `<div class="font-bold text-orange-400 mb-1 text-sm">${node.label}</div>
                    <div class="text-gray-300">Balance: <span class="text-white font-mono">${Math.floor(node.val).toLocaleString()}</span></div>`;
        } else if (node.type === 'operator') {
            const opMetadata = this.operatorNodeMetadata.get(node.id);
            const delegatorCount = (opMetadata && opMetadata.delegatorCount) ? Math.max(0, opMetadata.delegatorCount - 1) : 0;

            html = `<div class="font-bold text-blue-400 mb-1 text-sm">${node.label}</div>
                    <div class="text-gray-300">Stake: <span class="text-white font-mono">${Math.floor(node.val).toLocaleString()}</span></div>
                    <div class="text-gray-300">Delegators: <span class="text-white font-mono">${delegatorCount}</span></div>`;
        } else if (node.type === 'delegator') {
                html = `<div class="font-bold text-orange-400 mb-1 text-sm">Delegator</div>
                    <div class="text-xs text-gray-500 mb-1 font-mono">${node.id.substring(0,10)}...</div>
                    <div class="text-gray-300">Delegated: <span class="text-white font-mono">${Math.floor(node.val).toLocaleString()}</span></div>`;
        } else if (node.type === 'live-node') {
            const parentMetadata = this.operatorNodeMetadata.get(node.operatorId);
            const parentLabel = parentMetadata ? parentMetadata.label : node.operatorId.substring(0, 12) + '...';
            const rfDisplay = parentMetadata?.redundancyFactor ? `<div class="text-gray-300">Redundancy Factor: <span class="text-white font-mono">${parentMetadata.redundancyFactor}</span></div>` : '';
            
            const nodeIdDisplay = `Node #${node.nodeIndex}`;
            
            let fleetSize = 0;
            const opNodes = this.operatorNodeCounts.get(node.operatorId);
            if (opNodes) {
                fleetSize = opNodes.size;
            }

            html = `<div class="font-bold text-green-400 mb-1 text-sm">${parentLabel}</div>
                    <div class="text-gray-300">ID: <span class="text-white font-mono">${nodeIdDisplay}</span></div>
                    ${rfDisplay}
                    <div class="text-gray-300">Fleet Size: <span class="text-white font-mono">${fleetSize}</span></div>`;
        }

        el.innerHTML = html;
        let left = x + 15; let top = y + 15;
        if (left + 200 > window.innerWidth) left = x - 215;
        if (top + 80 > window.innerHeight) top = y - 95;
        el.style.left = left + 'px'; el.style.top = top + 'px';
        el.style.opacity = 1;
    }
};