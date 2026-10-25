// Operator avatars on IPFS: every source in turn (a thumbnail from Filebase, then Pinata), then the placeholder;
// the CIDs marked dead before the avatars moved to Pinata are forgotten
import { test, expect } from '@playwright/test';
import { mockNetwork, openApp } from './support/network.mjs';

const CID = 'bafkreibvdjqzq4q5zbxgk2y2y3a3u6y3h3m2n4w7m3c4u3z2k6qkq2o5ae';

test.beforeEach(async ({ page }) => {
    await mockNetwork(page.context());   // aborts every image request: all the sources fail
});

test('a failing IPFS avatar tries a Filebase thumbnail, then Pinata, then shows the placeholder', async ({ page }) => {
    await openApp(page, '/');
    const requested = [];
    page.on('request', r => { if (r.url().includes(CID)) requested.push(r.url()); });
    const result = await page.evaluate(async (cid) => {
        const utils = await import('/src/core/utils.js');
        const box = document.createElement('div');
        box.style.cssText = 'position:fixed;top:10px;left:10px;z-index:9999';   // in view: the avatar loads lazily
        document.body.appendChild(box);
        box.innerHTML = utils.avatarImgHtml(utils.ipfsAvatarUrl(cid, 64));
        const img = box.querySelector('img');
        for (let i = 0; i < 50 && !img.src.includes('placehold.co'); i++) await new Promise(r => setTimeout(r, 100));
        return { src: img.src, dead: utils.isDeadIpfsCid(cid) };
    }, CID);
    expect(result.src).toContain('placehold.co');
    expect(result.dead).toBe(true);
    expect(requested.map(u => decodeURIComponent(u).replace(/\?.*url=/, ' via ').split('&')[0])).toEqual([
        `https://wsrv.nl/ via https://ipfs.filebase.io/ipfs/${CID}`,
        `https://gateway.pinata.cloud/ipfs/${CID}`
    ]);
});

test('IPFS avatars marked dead before the move to Pinata are tried again', async ({ page }) => {
    await page.addInitScript((cid) => localStorage.setItem('deadIpfsAvatarCids', JSON.stringify({ [cid]: Date.now() })), CID);
    await openApp(page, '/');
    const result = await page.evaluate(async (cid) => {
        const utils = await import('/src/core/utils.js');
        const meta = JSON.stringify({ name: 'Op', imageIpfsCid: cid });
        return { dead: utils.isDeadIpfsCid(cid), imageUrl: utils.parseOperatorMetadata(meta).imageUrl, old: localStorage.getItem('deadIpfsAvatarCids') };
    }, CID);
    expect(result.dead).toBe(false);
    expect(result.imageUrl).toContain(encodeURIComponent(`https://ipfs.filebase.io/ipfs/${CID}`));
    expect(result.old).toBeNull();
});
