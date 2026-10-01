// Security, on single modules of the app (served by the Vite dev server: the build has no /src)
import { test, expect } from '@playwright/test';
import { mockNetwork, openApp } from './support/network.mjs';

test.beforeEach(async ({ page }) => {
    await mockNetwork(page.context());
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
