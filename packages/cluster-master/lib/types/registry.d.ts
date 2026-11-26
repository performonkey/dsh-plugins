/** Master-side registry and reverse WebSocket connection manager for distributed workers. */
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { type ClusterFrame, type ControlHelloFrame, type HttpReqFrame, type HttpRespFrame, type WorkerId } from '@deepseek-ai/dsh-cluster-protocol';
/** Configuration options for the worker registry. */
export interface WorkerRegistryConfig {
    /** Pre-shared secret token required from workers during handshake. */
    readonly authToken: string;
    /** Cadence of heartbeat ping frames in milliseconds. */
    readonly heartbeatIntervalMs?: number | undefined;
    /** Maximum consecutive unanswered pings before worker is pruned. */
    readonly maxMissedPongs?: number | undefined;
}
/** Snapshot of an active connected worker. */
export interface WorkerInfo {
    readonly id: WorkerId;
    readonly name: string;
    readonly workspaces: readonly string[];
    readonly version: string;
    readonly connectedAt: number;
    readonly lastHeartbeat: number;
}
/** Active connection state for a single worker node. */
export declare class WorkerConnection {
    readonly id: WorkerId;
    readonly name: string;
    readonly workspaces: readonly string[];
    readonly version: string;
    readonly connectedAt: number;
    lastHeartbeat: number;
    missedPongs: number;
    private readonly socket;
    private readonly pendingCalls;
    /**
     * @param hello - Initial worker hello frame.
     * @param socket - Established WebSocket connection.
     */
    constructor(hello: ControlHelloFrame, socket: WebSocket);
    /**
     * Send a typed frame over the worker socket.
     * @param frame - Frame to serialize and send.
     */
    send(frame: ClusterFrame): void;
    /**
     * Handle an incoming HTTP response frame from this worker.
     * @param frame - HTTP response frame.
     */
    handleHttpResp(frame: HttpRespFrame): void;
    /**
     * Dispatch an HTTP request frame through the reverse tunnel to this worker.
     * @param req - HTTP request parameters.
     * @param timeoutMs - Max response wait time.
     * @param signal - Abandons the call when the caller stops waiting for it.
     * @returns Resolves with worker's HTTP response, or a synthesized 499 when `signal` aborts.
     */
    sendHttpRequest(req: Omit<HttpReqFrame, 'type' | 'reqId'>, timeoutMs?: number, signal?: AbortSignal): Promise<HttpRespFrame>;
    /**
     * Terminate active socket and reject all pending calls.
     * @param reason - Diagnostic closure reason.
     */
    close(reason?: string): void;
    /**
     * Return detached snapshot information.
     * @returns Worker information object.
     */
    toInfo(): WorkerInfo;
}
/** Registry that accepts, authenticates, and manages reverse worker connections. */
export declare class WorkerRegistry extends EventEmitter {
    private readonly config;
    private readonly workers;
    private readonly heartbeatIntervalMs;
    private readonly maxMissedPongs;
    private heartbeatTimer;
    private isClosed;
    /**
     * @param config - Registry settings.
     */
    constructor(config: WorkerRegistryConfig);
    /**
     * Handle an accepted WebSocket connection for the reverse tunnel endpoint.
     * @param socket - Accepted WebSocket.
     */
    handleConnection(socket: WebSocket): void;
    /**
     * Retrieve list of currently online workers.
     * @returns Array of worker snapshots.
     */
    getWorkers(): WorkerInfo[];
    /**
     * Find an active worker connection by workerId.
     * @param id - Target worker ID.
     * @returns Worker connection instance or undefined.
     */
    getWorker(id: WorkerId): WorkerConnection | undefined;
    /**
     * Dispatch an HTTP request to a specific worker.
     * @param workerId - Target worker ID.
     * @param req - HTTP request parameters.
     * @param timeoutMs - Max response wait time.
     * @param signal - Abandons the call when the caller stops waiting for it.
     * @returns Response frame.
     */
    sendHttpRequest(workerId: WorkerId, req: Omit<HttpReqFrame, 'type' | 'reqId'>, timeoutMs?: number, signal?: AbortSignal): Promise<HttpRespFrame>;
    private startHeartbeat;
    /** Terminate all connections and close registry. */
    close(): Promise<void>;
}
//# sourceMappingURL=registry.d.ts.map