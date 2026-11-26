/** Master-side HTTP and WebSocket stream relay connecting browsers to remote workers. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WorkerId } from '@deepseek-ai/dsh-cluster-protocol';
import type { WorkerRegistry } from './registry.ts';
export interface MasterRelayConfig {
    /** Registry maintaining active worker connections. */
    readonly registry: WorkerRegistry;
    /** Strategy to select worker for incoming requests. Defaults to first available. */
    readonly selectWorker?: ((req: IncomingMessage) => WorkerId | undefined) | undefined;
}
/** Relays browser HTTP RPCs and /api/remote.mux WebSocket streams transparently to Workers. */
export declare class MasterRelay {
    private readonly config;
    private readonly registry;
    private readonly muxServer;
    private readonly activeClientSockets;
    /**
     * @param config - Relay configuration.
     */
    constructor(config: MasterRelayConfig);
    /**
     * Transparently forward an incoming HTTP request (e.g. POST /api) to an active worker.
     * @param req - Incoming HTTP request.
     * @param res - Server HTTP response.
     */
    handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
    /**
     * Handle an HTTP upgrade request for the /api/remote.mux endpoint.
     * @param req - Upgrade HTTP request.
     * @param socket - Upgraded network socket.
     * @param head - Buffer head.
     */
    handleMuxUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
    private resolveWorker;
    /** Close all active client connections. */
    close(): void;
}
//# sourceMappingURL=relay.d.ts.map