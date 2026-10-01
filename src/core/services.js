// The app's data and chain services, in their own files and reachable as Services.* from the modules
import { unsubscribeFromCoordinationStream, destroyStreamrClient } from './streamrClient.js';
import { stopPriceStreams } from './priceData.js';

export * from './rpc.js';
export * from './polygonscan.js';
export * from './subgraphApi.js';
export * from './priceData.js';
export * from './streamrClient.js';
export * from './transactions.js';

export async function cleanupClient() {
    await unsubscribeFromCoordinationStream();
    await stopPriceStreams();
    await destroyStreamrClient();
}
