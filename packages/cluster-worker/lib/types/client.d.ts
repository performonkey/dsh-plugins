/** Worker-side reverse WebSocket tunnel client connecting to master. */
import { EventEmitter } from 'node:events';
import { type ClusterFrame, type HttpReqFrame, type HttpRespFrame, type WorkerId } from '@deepseek-ai/dsh-cluster-protocol';
/** Configuration options for the worker tunnel client. */
export interface WorkerTunnelClientConfig {
    /** Master reverse WebSocket tunnel URL (e.g. ws://master.example.com/api/worker/connect). */
    readonly masterUrl: string;
    /** Pre-shared authentication token. */
    readonly token: string;
    /** Unique stable ID for this worker node. */
    readonly workerId: WorkerId;
    /** Human-readable display label. */
    readonly name: string;
    /** Initial workspace directories served by this worker. */
    readonly workspaces: readonly string[];
    /** Worker implementation version string. */
    readonly version?: string | undefined;
    /** Explicit HTTP/HTTPS proxy to route tunnel connection through. */
    readonly proxyUrl?: string | undefined;
    /** Whether to automatically reconnect when connection drops (default: true). */
    readonly autoReconnect?: boolean | undefined;
    /** Initial reconnect delay in milliseconds (default: 1000). */
    readonly initialReconnectBackoffMs?: number | undefined;
    /** Maximum reconnect delay in milliseconds (default: 30000). */
    readonly maxReconnectBackoffMs?: number | undefined;
}
/** Handles a forwarded request until its response or cancellation cleanup completes. */
export type HttpRequestHandler = (req: HttpReqFrame, signal: AbortSignal) => Promise<Omit<HttpRespFrame, 'type' | 'reqId'>>;
/** Reverse WebSocket tunnel client running on worker nodes. */
export declare class WorkerTunnelClient extends EventEmitter {
    private readonly config;
    private socket;
    private isRunning;
    private isConnected;
    private reconnectTimer;
    private currentBackoffMs;
    private readonly maxBackoffMs;
    private httpHandler;
    private readonly generations;
    /**
     * @param config - Tunnel connection configuration.
     */
    constructor(config: WorkerTunnelClientConfig);
    /**
     * Register the HTTP request dispatcher handler.
     * @param handler - Function invoked for incoming http:req frames.
     */
    onRequest(handler: HttpRequestHandler): void;
    /**
     * Establish connection to Master and perform hello handshake.
     * @returns Resolves once registration is acknowledged.
     */
    start(): Promise<void>;
    private connect;
    private scheduleReconnect;
    /**
     * Send a typed cluster frame to Master.
     * @param frame - Frame to encode and send.
     */
    send(frame: ClusterFrame): void;
    /**
     * Gracefully stop the client and close connection.
     */
    stop(): Promise<void>;
    /**
     * Check if client is currently authenticated and connected.
     * @returns True if connected.
     */
    get connected(): boolean;
}
//# sourceMappingURL=client.d.ts.map