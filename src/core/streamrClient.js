// The Streamr client and the operator's coordination stream


let streamrClient = null;
let coordinationSubscription = null;

// --- Streamr SDK ---
export function setStreamrClient(client) {
    streamrClient = client;
}

export function getStreamrClient() {
    return streamrClient;
}

export async function setupStreamrSubscription(operatorId, onMessageCallback) {
    const streamId = `${operatorId}/operator/coordination`;
    await unsubscribeFromCoordinationStream();
    
    const indicatorEl = document.getElementById('stream-status-indicator');
    if (!indicatorEl || !streamrClient) return { subscription: null, error: new Error("Client not ready") };

    indicatorEl.className = 'w-3 h-3 rounded-full bg-yellow-500 animate-pulse';
    indicatorEl.title = `Connecting to ${streamId}...`;
    try {
        coordinationSubscription = await streamrClient.subscribe(streamId, (message) => {
            indicatorEl.className = 'w-3 h-3 rounded-full bg-green-500';
            indicatorEl.title = `Subscribed, receiving data.`;
            onMessageCallback(message);
        });
        indicatorEl.className = 'w-3 h-3 rounded-full bg-gray-400';
        indicatorEl.title = `Subscribed to stream. Awaiting first message...`;
        return { subscription: coordinationSubscription, error: null };
    } catch (error) {
        console.error(`[Streamr] Error subscribing to ${streamId}:`, error);
        indicatorEl.className = 'w-3 h-3 rounded-full bg-red-500';
        indicatorEl.title = `Error subscribing to stream.`;
        return { subscription: null, error };
    }
}

export async function unsubscribeFromCoordinationStream() {
    if (coordinationSubscription) {
        try { await coordinationSubscription.unsubscribe(); } catch (e) { /* ignore */ }
        coordinationSubscription = null;
    }
}

/** Destroys the Streamr client */
export async function destroyStreamrClient() {
    if (streamrClient) {
        try { await streamrClient.destroy(); } catch (e) { /* ignore */ }
        streamrClient = null;
    }
}
