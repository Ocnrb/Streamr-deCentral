// early.js - Runs in <head>, before the page is drawn (no inline scripts: the CSP allows only the app's own files)

// Choices kept in this browser that change the first paint: the compact sidebar, the closed Overview intro
try {
    if (localStorage.getItem('sidebar.compact') === '1') document.documentElement.classList.add('sidebar-compact');
    if (localStorage.getItem('overview.hero.hidden')) document.documentElement.classList.add('hero-closed');
} catch (e) { /* storage blocked */ }

// Overview intro: closed for good (kept in this browser) and opened again. Handled here so the buttons work from
// the first paint, before the page's module has loaded; the module hears 'overview:hero' to resize its animation
document.addEventListener('click', (e) => {
    const close = e.target.closest?.('#overview-hero-close');
    const reopen = e.target.closest?.('#overview-hero-reopen button');
    if (!close && !reopen) return;
    const hidden = !!close;
    try {
        if (hidden) localStorage.setItem('overview.hero.hidden', '1');
        else localStorage.removeItem('overview.hero.hidden');
    } catch (err) { /* storage blocked: for this visit only */ }
    document.documentElement.classList.toggle('hero-closed', hidden);
    document.dispatchEvent(new CustomEvent('overview:hero', { detail: { hidden } }));
});

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
