// Bridge page: the transfer form beside DATA's supply by chain
import { test, expect } from '@playwright/test';
import { ethers } from 'ethers';
import { mockNetwork, openApp } from './support/network.mjs';

const ERC20 = new ethers.utils.Interface(['function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function upgradeAgent() view returns (address)']);
const XDATA = '0x0cf0ee63788a0849fe5297f3407f701e122cc023';
const MIGRATOR = '0x00000000000000000000000000000000000c0de1';
const ETH_DATA = '0x8f693ca8d21b157107184d29d398a8d082b38b76';
const POLYGON_DATA = '0x3a9a81d576d83ff21f26f325066054540720fc34';
const POLYGON_BRIDGE = '0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf';
const M = (n) => ethers.utils.parseEther(String(n * 1e6));

/** An RPC answering totalSupply / balanceOf / upgradeAgent of its tokens ({ address: { supply, balances, agent } }), chainId and block number */
function rpc(chainId, tokens) {
    return (route) => {
        const body = route.request().postDataJSON();
        const answer = (req) => {
            let result = null;
            const token = req.method === 'eth_call' ? tokens[req.params[0].to.toLowerCase()] : null;
            if (req.method === 'eth_chainId') result = ethers.utils.hexValue(chainId);
            else if (req.method === 'net_version') result = String(chainId);
            else if (req.method === 'eth_blockNumber') result = '0x100';
            else if (token) {
                const call = ERC20.parseTransaction({ data: req.params[0].data });
                result = call.name === 'totalSupply' ? ERC20.encodeFunctionResult('totalSupply', [token.supply])
                    : call.name === 'upgradeAgent' ? ERC20.encodeFunctionResult('upgradeAgent', [token.agent || ethers.constants.AddressZero])
                    : ERC20.encodeFunctionResult('balanceOf', [token.balances?.[call.args[0].toLowerCase()] || 0]);
            }
            return { jsonrpc: '2.0', id: req.id, result };
        };
        return route.fulfill({ json: Array.isArray(body) ? body.map(answer) : answer(body) });
    };
}

test('the bridge page shows DATA\'s whole supply by chain: each chain\'s supply, bridged or issued there, Ethereum the rest', async ({ page }) => {
    await mockNetwork(page.context());
    // Ethereum: 1 000 M DATA, 240 M of them held by the Polygon PoS bridge and 50 M by XDATA's migration contract for the
    // 50 M XDATA not migrated (4 M of them bridged to Gnosis)
    await page.route(url => /ethereum-rpc\.publicnode\.com|eth\.drpc\.org|1rpc\.io\/eth/.test(url.href), rpc(1, {
        [ETH_DATA]: { supply: M(1000), balances: { [POLYGON_BRIDGE]: M(240), [MIGRATOR]: M(50) } },
        [XDATA]: { supply: M(50), agent: MIGRATOR }
    }));
    // Polygon: 270 M (30 M more than its bridge holds); Gnosis 5 M and BNB Chain 2 M, none locked on Ethereum
    await page.route('**/*', (route) => {
        const body = route.request().postDataJSON?.();
        const call = body?.method === 'eth_call' ? body.params[0] : null;
        if (call?.to?.toLowerCase() !== POLYGON_DATA || call.data !== ERC20.getSighash('totalSupply')) return route.fallback();
        return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: ERC20.encodeFunctionResult('totalSupply', [M(270)]) } });
    });
    await page.route(url => /gnosischain\.com|gnosis-rpc\.publicnode\.com/.test(url.href), rpc(100, {
        '0x256eb8a51f382650b2a1e946b8811953640ee47d': { supply: M(5) },
        '0xe4a2620ede1058d61bee5f45f6414314fdf10548': { supply: M(4) }
    }));
    await page.route(url => /bsc-dataseed\.binance\.org|bsc-rpc\.publicnode\.com/.test(url.href), rpc(56, { '0x0864c156b3c5f69824564dec60c629ae6401bf2a': { supply: M(2) } }));
    await openApp(page, '/bridge');
    const legend = page.locator('#bridge-supply-legend');
    const rows = legend.locator(':scope > li');
    await expect(rows).toHaveCount(5, { timeout: 30000 });   // Ethereum, Polygon, Gnosis, BNB Chain, the total
    // Ethereum: its DATA less the bridges' and the migration's, and the XDATA not migrated (less Gnosis's)
    await expect(rows.nth(0)).toContainText('Ethereum');
    await expect(rows.nth(0)).toContainText('756 000 000 DATA');
    await expect(rows.nth(0)).toContainText('DATA710 000 000');
    await expect(rows.nth(0)).toContainText('XDATA, not migrated46 000 000');
    // Polygon: its supply, in its bridged and issued parts
    await expect(rows.nth(1)).toContainText('270 000 000 DATA');
    await expect(rows.nth(1)).toContainText('Via Polygon PoS bridge240 000 000');
    await expect(rows.nth(1)).toContainText('Issued on Polygon30 000 000');
    await expect(rows.nth(2)).toContainText('Gnosis');
    await expect(rows.nth(2)).toContainText('9 000 000 DATA');
    await expect(rows.nth(2)).toContainText('XDATA, not migrated4 000 000');
    await expect(rows.nth(3)).toContainText('BNB Chain');
    await expect(legend).toContainText('Total supply1 037 000 000 DATA');
    // The ring: a slice per part, with its chain, part and amount in the tooltip
    const hits = page.locator('#bridge-supply-chart [data-slice-hit]');
    await expect(hits).toHaveCount(7);   // Ethereum's DATA and XDATA, Polygon's two parts, Gnosis's two, BNB Chain
    await expect(hits.nth(3)).toHaveAttribute('data-tooltip-content', /Polygon.*Issued on Polygon.*30 000 000 DATA/);
    // Over a slice: its chain stands out, the ring stops floating (the tooltip stays put)
    await hits.nth(2).hover({ force: true });
    await expect(page.locator('#bridge-supply-chart g[data-slice="1"]').last()).toHaveAttribute('style', /translate/);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.supply-ring-float')).animationPlayState)).toBe('paused');
    await page.mouse.move(0, 0);
    // A legend row stands out with its slices
    await rows.nth(1).hover();
    await expect(page.locator('#bridge-supply-chart g[data-slice="1"]').last()).toHaveAttribute('style', /translate/);
    // The bridge times below the form, Polygon's with its longer case
    await expect(page.locator('#bridge-view [role="note"]')).toContainText('sometimes up to 20 minutes');
});
