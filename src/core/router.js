// router.js - Client-side routing for the Streamr Operators application

export class Router {
    constructor() {
        this.routes = new Map();
        this.currentRoute = null;
        
        // Listen for browser back/forward navigation
        window.addEventListener('popstate', (e) => {
            this.handleRoute(window.location.pathname, false);
        });
        
        // Intercept clicks on internal links to use client-side routing
        document.addEventListener('click', (e) => {
            // Find if click was on a link or inside a link
            const link = e.target.closest('a[href]');
            if (!link) return;
            
            const href = link.getAttribute('href');
            
            // Skip external links, hash links, and links with target
            if (!href || 
                href.startsWith('http') || 
                href.startsWith('//') || 
                href.startsWith('#') || 
                href.startsWith('mailto:') ||
                link.hasAttribute('target') ||
                link.hasAttribute('download')) {
                return;
            }
            
            // Check if it's an internal route (starts with /)
            if (href.startsWith('/')) {
                e.preventDefault();
                this.navigate(href);
            }
        });
    }

    /**
     * Register a route handler
     * @param {string} pattern 
     * @param {Function} handler 
     */
    addRoute(pattern, handler) {
        this.routes.set(pattern, handler);
    }

    /**
     * Navigate to a specific path
     * @param {string} path - The path to navigate to
     * @param {boolean} pushState - Whether to add to browser history (default: true)
     */
    async navigate(path, pushState = true) {
        if (pushState) {
            // inApp marks entries created inside the app (used by the header back button)
            window.history.pushState({ inApp: true }, '', path);
        }
        await this.handleRoute(path, false);
    }

    /**
     * Handle the current route
     * @param {string} path - The path to handle
     * @param {boolean} pushState - Whether to add to browser history
     */
    async handleRoute(path, pushState = true) {
        // Normalize path - strip query string for matching
        path = path || '/';
        const queryIndex = path.indexOf('?');
        if (queryIndex !== -1) {
            path = path.substring(0, queryIndex);
        }
        if (path !== '/' && path.endsWith('/')) {
            path = path.slice(0, -1);
        }

        this.currentRoute = path;
        window.dispatchEvent(new CustomEvent('app:routechange', { detail: { path } }));

        // Try to match exact routes first
        for (const [pattern, handler] of this.routes) {
            const params = this.matchRoute(pattern, path);
            if (params !== null) {
                try {
                    await handler(params);
                } catch (error) {
                    console.error('Route handler error:', error);
                }
                return;
            }
        }

        // If no route matched, default to home
        const homeHandler = this.routes.get('/');
        if (homeHandler) {
            if (pushState) {
                window.history.pushState({}, '', '/');
            }
            await homeHandler({});
        }
    }

    /**
     * Match a route pattern against a path
     * @param {string} pattern - Route pattern
     * @param {string} path - Current path
     * @returns {Object|null} - Matched parameters or null
     */
    matchRoute(pattern, path) {
        // Exact match
        if (pattern === path) {
            return {};
        }

        // Special handling for wildcard patterns like /stream/*
        // This captures everything after /stream/ as the 'id' parameter
        if (pattern.endsWith('/*')) {
            const prefix = pattern.slice(0, -1); // Remove the *
            if (path.startsWith(prefix)) {
                const wildcardValue = path.slice(prefix.length);
                if (wildcardValue) {
                    return { id: wildcardValue };
                }
            }
            return null;
        }

        // Pattern with parameters (e.g., /operator/:id)
        const patternParts = pattern.split('/').filter(p => p);
        const pathParts = path.split('/').filter(p => p);

        if (patternParts.length !== pathParts.length) {
            return null;
        }

        const params = {};
        for (let i = 0; i < patternParts.length; i++) {
            const patternPart = patternParts[i];
            const pathPart = pathParts[i];

            if (patternPart.startsWith(':')) {
                // Parameter
                const paramName = patternPart.slice(1);
                params[paramName] = pathPart;
            } else if (patternPart !== pathPart) {
                // No match
                return null;
            }
        }

        return params;
    }

    /**
     * Get the current route path
     * @returns {string}
     */
    getCurrentPath() {
        return this.currentRoute || window.location.pathname;
    }

    /**
     * Initialize the router and handle the initial route
     */
    init() {
        this.handleRoute(window.location.pathname, false);
    }
}
