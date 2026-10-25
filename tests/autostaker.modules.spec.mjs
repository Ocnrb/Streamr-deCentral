// Autostaker on V4 Operators: the unstakes and stakes go in one rebalanceStake; V3 Operators keep one transaction each
import { test, expect } from '@playwright/test';
import { ethers } from 'ethers';
import { mockNetwork, openApp, hex } from './support/network.mjs';

const OPERATOR = hex(0xa0000);
const LEAVE = hex(0xb001);   // left completely
const JOIN = hex(0xb002);    // staked into
const iface = new ethers.utils.Interface([
    'function version() view returns (uint256)', 'function queueIsEmpty() view returns (bool)',
    'function stakedInto(address) view returns (uint256)', 'function valueWithoutEarnings() view returns (uint256)',
    'function totalStakedIntoSponsorshipsWei() view returns (uint256)', 'function lockedStakeWei(address) view returns (uint256)',
    'function minimumStakeOf(address) view returns (uint256)',
    'function rebalanceStake(address[],uint256[],address[],uint256[])', 'function unstake(address)', 'function stake(address,uint256)'
]);
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

/** Runs executeActions with a wallet that answers the reads and records the transactions it sends */
async function runAutostaker(page, version, estimateError = null) {
    const answers = {
        [iface.getSighash('version')]: word(version), [iface.getSighash('queueIsEmpty')]: word(1),
        [iface.getSighash('stakedInto')]: word(5000n * 10n ** 18n), [iface.getSighash('valueWithoutEarnings')]: word(20000n * 10n ** 18n),
        [iface.getSighash('totalStakedIntoSponsorshipsWei')]: word(5000n * 10n ** 18n), [iface.getSighash('lockedStakeWei')]: word(0),
        [iface.getSighash('minimumStakeOf')]: word(10n ** 18n)
    };
    await openApp(page, '/');
    return page.evaluate(async ({ answers, operator, leave, join, estimateError }) => {
        const autostaker = await import('/src/features/autostaker.js');
        const { ethers } = window;   // the app's copy (libs.js), for its BigNumber
        const sent = [];
        const call = async (tx) => answers[tx.data.slice(0, 10)] || '0x';
        const provider = { _isProvider: true, call, getFeeData: async () => { throw new Error('no fee data'); } };
        const signer = {
            _isSigner: true, provider,
            getAddress: async () => '0x' + 'f'.repeat(40),
            call,
            estimateGas: async (tx) => {
                if (estimateError && tx.data.startsWith('0x38849a3a')) throw Object.assign(new Error('execution reverted'), { data: estimateError });
                return ethers.BigNumber.from('0x100000');
            },
            sendTransaction: async (tx) => {
                sent.push({ to: tx.to, data: tx.data });
                return { hash: '0x' + String(sent.length).padStart(64, '0'), wait: async () => ({ transactionHash: '0x' + String(sent.length).padStart(64, '0'), logs: [] }) };
            }
        };
        const actions = [
            { type: 'unstake', sponsorshipId: leave, amount: 5000n * 10n ** 18n, targetStake: 0n, currentStake: 5000n * 10n ** 18n },
            { type: 'stake', sponsorshipId: join, amount: 1000n * 10n ** 18n }
        ];
        const result = await autostaker.executeActions(actions, operator, signer, () => {});
        return { success: result.success, successful: result.results.successful.length, failed: result.results.failed.map(f => f.error), sent };
    }, { answers, operator: OPERATOR, leave: LEAVE, join: JOIN, estimateError });
}

test.beforeEach(async ({ page }) => {
    await mockNetwork(page.context());
});

test('a V4 Operator moves its stake in one rebalanceStake transaction', async ({ page }) => {
    const run = await runAutostaker(page, 4);
    expect(run.failed).toEqual([]);
    expect(run.successful).toBe(2);
    expect(run.sent).toHaveLength(1);
    expect(run.sent[0].to.toLowerCase()).toBe(OPERATOR);
    const call = iface.parseTransaction({ data: run.sent[0].data });
    expect(call.name).toBe('rebalanceStake');
    expect(call.args[0].map(a => a.toLowerCase())).toEqual([LEAVE]);
    expect(call.args[1].map(String)).toEqual(['0']);
    expect(call.args[2].map(a => a.toLowerCase())).toEqual([JOIN]);
    expect(call.args[3].map(String)).toEqual([(1000n * 10n ** 18n).toString()]);
});

test('a V3 Operator keeps one transaction per action, unstakes first', async ({ page }) => {
    test.setTimeout(30000);
    const run = await runAutostaker(page, 3);
    expect(run.failed).toEqual([]);
    expect(run.sent.map(tx => iface.parseTransaction({ data: tx.data }).name)).toEqual(['unstake', 'stake']);
});

test('a V4 rebalance that would revert sends nothing, not even one by one', async ({ page }) => {
    const run = await runAutostaker(page, 4, '0x7f2f3f9e');   // SponsorshipFull
    expect(run.sent).toHaveLength(0);
    expect(run.successful).toBe(0);
    expect(run.failed).toEqual(Array(2).fill('The sponsorship is full: it reached its maximum number of operators.'));
});
