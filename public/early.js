// early.js - Runs in <head>, before the page is drawn (no inline scripts: the CSP allows only the app's own files)

// Choices kept in this browser that change the first paint: the compact sidebar, the closed Overview intro
try {
    if (localStorage.getItem('sidebar.compact') === '1') document.documentElement.classList.add('sidebar-compact');
    if (localStorage.getItem('overview.hero.hidden')) document.documentElement.classList.add('hero-closed');
} catch (e) { /* storage blocked */ }

// PWA install prompt: caught early, shown later by the app
window.deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.deferredInstallPrompt = e;
});
window.addEventListener('appinstalled', () => {
    window.deferredInstallPrompt = null;
});

// Service worker (offline cache of the app's own files)
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(error => {
            console.error('Service Worker registration failed:', error);
        });
    });
}
