/**
 * Cloudflare Durable Object managing Worker reverse tunnel, browser WebSocket multiplexing,
 * and HTTP RPC relay in pure memory (0 storage reads/writes).
 */
import type { CloudflareDurableObjectState, Env } from './types.ts';
/**
 * Global singleton Durable Object instance running on Cloudflare's edge network.
 */
export declare class ClusterMasterDO {
    readonly ctx: CloudflareDurableObjectState;
    readonly env: Env;
    private workerWs;
    private workerInfo;
    private missedPongs;
    private heartbeatTimer;
    private readonly browserSockets;
    private readonly streamToBrowser;
    private readonly browserToStreams;
    private readonly pendingHttpRequests;
    /**
     * @param ctx - Durable Object state context.
     * @param env - Cloudflare worker environment variables.
     */
    constructor(ctx: CloudflareDurableObjectState, env: Env);
    /**
     * Main dispatch entry point for HTTP requests routed into this Durable Object.
     * @param request - Incoming fetch request.
     * @returns HTTP or WebSocket upgrade response.
     */
    fetch(request: Request): Promise<Response>;
    /**
     * Returns current cluster connectivity and worker health.
     */
    private handleClusterStatus;
    /**
     * Handles outbound reverse WebSocket tunnel from local worker.
     */
    private handleWorkerConnect;
    /**
     * Handles browser WebSocket connection to /api/remote.mux.
     */
    private handleBrowserMux;
    /**
     * Transparently proxies an incoming HTTP request (e.g. POST /api/*) to the connected worker.
     */
    private handleHttpRequest;
    /**
     * Starts periodic heartbeat pings to detect worker liveness.
     */
    private startHeartbeat;
    /**
     * Sends a typed cluster frame to the active worker.
     */
    private sendToWorker;
    /**
     * Cleans up worker connection state upon disconnection.
     */
    private cleanupWorker;
}
//# sourceMappingURL=durable-object.d.ts.map