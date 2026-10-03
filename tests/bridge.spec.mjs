// Bridge page: the transfer form beside DATA's supply by chain
import { test, expect } from '@playwright/test';
import { ethers } from 'ethers';
import { mockNetwork, openApp } from './support/network.mjs';

const ERC20 = new ethers.utils.Interface(['function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
const ETH_DATA = '0x8f693ca8d21b157107184d29d398a8d082b38b76';
const POLYGON_BRIDGE = '0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf';

test('the bridge page shows where DATA\'s supply is: each chain\'s bridge balance, Ethereum the rest', async ({ page }) => {
    await mockNetwork(page.context());
    // Ethereum: 1 000 M DATA, 240 M held by the Polygon PoS bridge, none by the Gnosis OmniBridge
    await page.route(url => /ethereum-rpc\.publicnode\.com|eth\.drpc\.org|1rpc\.io\/eth/.test(url.href), (route) => {
        const body = route.request().postDataJSON();
        const answer = (req) => {
            let result = null;
            if (req.method === 'eth_chainId') result = '0x1';
            else if (req.method === 'net_version') result = '1';
            else if (req.method === 'eth_blockNumber') result = '0x100';
            else if (req.method === 'eth_call' && req.params[0].to.toLowerCase() === ETH_DATA) {
                const call = ERC20.parseTransaction({ data: req.params[0].data });
                result = call.name === 'totalSupply'
                    ? ERC20.encodeFunctionResult('totalSupply', [ethers.utils.parseEther('1000000000')])
                    : ERC20.encodeFunctionResult('balanceOf', [call.args[0].toLowerCase() === POLYGON_BRIDGE ? ethers.utils.parseEther('240000000') : 0]);
            }
            return { jsonrpc: '2.0', id: req.id, result };
        };
        return route.fulfill({ json: Array.isArray(body) ? body.map(answer) : answer(body) });
    });
    await openApp(page, '/bridge');
    const legend = page.locator('#bridge-supply-legend');
    await expect(legend.locator('li')).toHaveCount(3, { timeout: 30000 });   // Ethereum, Polygon, the total (no Gnosis: its bridge holds none)
    await expect(legend.locator('li').nth(0)).toContainText('Ethereum');
    await expect(legend.locator('li').nth(0)).toContainText('76.0%');
    await expect(legend.locator('li').nth(0)).toContainText('760 000 000 DATA');
    await expect(legend.locator('li').nth(1)).toContainText('Polygon');
    await expect(legend.locator('li').nth(1)).toContainText('24.0%');
    await expect(legend).toContainText('Total supply1 000 000 000 DATA');
    const slices = await page.evaluate(() => window.Chart.getChart(document.querySelector('#bridge-supply-chart canvas')).data.datasets[0].data);
    expect(slices).toEqual([760000000, 240000000]);
    // The bridge times below the form, Polygon's with its longer case
    await expect(page.locator('#bridge-view [role="note"]')).toContainText('sometimes up to 20 minutes');
});
