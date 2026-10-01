// Security: the CSP holds on every page, outside data shows as text
import { test, expect } from '@playwright/test';
import { mockNetwork, openApp } from './support/network.mjs';

const ROUTES = ['/', '/operators', '/streams', '/delegators', '/governance', '/visual', '/race', '/subgraph', '/swap', '/bridge', '/stream/streamr.eth%2Fdemo'];

test.beforeEach(async ({ page }) => {
    await mockNetwork(page.context());
});

test('no CSP violation or page error on any page', async ({ page }) => {
    const problems = [];
    let where = 'load';
    page.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) problems.push(`${where}: ${m.text()}`); });
    page.on('pageerror', e => problems.push(`${where}: ${e.message}`));
    await openApp(page, '/');
    for (const route of ROUTES) {
        where = route;
        await page.evaluate((path) => window.router.navigate(path), route);
        await page.waitForTimeout(800);
    }
    expect(problems).toEqual([]);
});

test('the CSP allows no inline scripts', async ({ page }) => {
    await openApp(page, '/');
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toMatch(/script-src 'self';/);
    // No inline <script> (other than JSON-LD) and no on* attributes in the page
    expect(await page.evaluate(() => [...document.querySelectorAll('script:not([src]):not([type="application/ld+json"])')].length)).toBe(0);
    expect(await page.evaluate(() => [...document.querySelectorAll('*')].filter(el => [...el.attributes].some(a => /^on/i.test(a.name))).length)).toBe(0);
});

test('tooltips show markup as text', async ({ page }) => {
    await openApp(page, '/');
    const show = async (content) => {
        await page.evaluate((text) => {
            document.getElementById('tip-probe')?.remove();
            const el = document.createElement('span');
            el.id = 'tip-probe';
            el.textContent = 'probe';
            el.style.cssText = 'position:fixed;top:300px;left:600px;z-index:9999;padding:10px;background:#333';
            el.setAttribute('data-tooltip-content', text);
            document.getElementById('main-container').appendChild(el);
        }, content);
        await page.mouse.move(5, 5);
        await page.hover('#tip-probe');
        return page.locator('#custom-tooltip');
    };
    const tip = await show('Nice operator<br><img src=x onerror="window.__xss=1">');
    await expect(tip).toContainText('<img src=x onerror="window.__xss=1">');
    expect(await tip.locator('img').count()).toBe(0);
    // The app's own marks still work: new lines and a bold first part
    await show("<span class='font-semibold'>Disclaimer</span><br>No fees.");
    await expect(page.locator('#custom-tooltip span.font-semibold')).toHaveText('Disclaimer');
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('toasts show error texts as text', async ({ page }) => {
    await openApp(page, '/');
    const html = await page.evaluate(async () => {
        const ui = await import('/src/ui/ui.js');
        ui.showToast({ type: 'error', title: '<img src=x onerror="window.__xss=1">', message: '<b>reverted</b>', duration: 0 });
        const toasts = document.querySelectorAll('.toast');
        return toasts[toasts.length - 1].querySelector('.toast-title').innerHTML;
    });
    expect(html).toContain('&lt;img');
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('a broken avatar falls back to the placeholder', async ({ page }) => {
    await openApp(page, '/');
    const src = await page.evaluate(async () => {
        const utils = await import('/src/core/utils.js');
        const box = document.createElement('div');
        box.style.cssText = 'position:fixed;top:10px;left:10px;z-index:9999';
        document.body.appendChild(box);
        box.innerHTML = utils.avatarImgHtml('https://broken.invalid/avatar.png');
        await new Promise(resolve => setTimeout(resolve, 1000));
        return box.querySelector('img').getAttribute('src');
    });
    expect(src).toContain('placehold.co');
});
