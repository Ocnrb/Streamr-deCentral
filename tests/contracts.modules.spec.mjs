// Streamr contract errors: the app's selectors match the contracts' signatures, and errors show their message
import { test, expect } from '@playwright/test';
import { ethers } from 'ethers';
import { mockNetwork, openApp } from './support/network.mjs';

// The custom errors of the Operator, OperatorFactory and Sponsorship contracts (network-contracts 9.2.0)
const SIGNATURES = [
    'OperatorAlreadyDeployed(address)', 'PolicyNotTrusted()', 'StakedInSponsorships()', 'InvalidOperatorsCut(uint256)',
    'AccessDeniedOperatorOnly()', 'AccessDeniedNodesOnly()', 'AccessDeniedStreamrOperatorOnly()', 'CannotTriggerOwnWithdraw()',
    'ArrayLengthMismatch()', 'SponsorshipFull(address)', 'CannotStakeForOthers(address,address)', 'NotMyStakedSponsorship()',
    'NoEarnings()', 'FirstEmptyQueueThenStake()', 'SelfDelegationTooLow(uint256,uint256)', 'DelegationBelowMinimum(uint256,uint256)',
    'ZeroUndelegation()'
];

test.beforeEach(async ({ page }) => {
    await mockNetwork(page.context());
});

test('every contract error selector is the one of its signature', async ({ page }) => {
    await openApp(page, '/');
    const table = await page.evaluate(async () => (await import('/src/core/constants.js')).CONTRACT_ERROR_MESSAGES);
    const expected = Object.fromEntries(SIGNATURES.map(s => [ethers.utils.id(s).slice(0, 10), s.split('(')[0]]));
    expect(Object.fromEntries(Object.entries(table).map(([selector, [name]]) => [selector, name]))).toEqual(expected);
});

test('contract errors show their message, also inside a module call and by name', async ({ page }) => {
    await openApp(page, '/');
    const sponsorshipFull = ethers.utils.id('SponsorshipFull(address)').slice(0, 10) + '0'.repeat(64);
    const moduleCallError = ethers.utils.id('ModuleCallError(address,bytes)').slice(0, 10) + '0'.repeat(128) + sponsorshipFull.slice(2);
    const messages = await page.evaluate(async ({ sponsorshipFull, moduleCallError }) => {
        const utils = await import('/src/core/utils.js');
        return [
            utils.getFriendlyErrorMessage({ code: 'CALL_EXCEPTION', error: { data: sponsorshipFull } }),
            utils.getFriendlyErrorMessage({ code: 'UNPREDICTABLE_GAS_LIMIT', error: { error: { data: moduleCallError } } }),
            utils.getFriendlyErrorMessage({ message: 'execution reverted: custom error CannotStakeForOthers(address,address)' }),
            utils.getFriendlyErrorMessage({ code: 4001 }),
            utils.getFriendlyErrorMessage({ message: 'something else' })
        ];
    }, { sponsorshipFull, moduleCallError });
    expect(messages).toEqual([
        'The sponsorship is full: it reached its maximum number of operators.',
        'The sponsorship is full: it reached its maximum number of operators.',
        'Only the Operator itself can stake into this sponsorship.',
        'Transaction rejected in your wallet.',
        'something else'
    ]);
});
