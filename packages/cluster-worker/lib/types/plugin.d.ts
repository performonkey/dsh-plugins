/** Cordis service running on Worker nodes, connecting outbound to Master. */
import { Service, type Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { WorkerTunnelClient } from './client.ts';
import { WorkerStreamDispatcher } from './stream-dispatcher.ts';
export interface Principal {
    readonly kind: 'owner' | string;
}
export interface PeerScope {
    readonly id: string;
    readonly principal: Principal;
    readonly interactions?: string;
    dispose(): Promise<void>;
}
export interface Config {
    /** Master WebSocket tunnel endpoint (e.g. ws://master.example.com/api/worker/connect). */
    readonly masterUrl: string;
    /** Pre-shared secret token for authenticating with master. */
    readonly authToken: string;
    /** Stable worker node identifier. */
    readonly workerId?: string;
    /** Human-readable display label for this node. */
    readonly name?: string;
    /** Workspaces served by this worker. Defaults to [process.cwd()]. */
    readonly workspaces?: string[];
    /** Whether to automatically reconnect when tunnel drops. */
    readonly autoReconnect?: boolean;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Cluster Worker service instance. */
        clusterWorker: ClusterWorkerService;
    }
}
/** Cluster Worker Cordis service managing outbound reverse connection to Master. */
export declare class ClusterWorkerService extends Service {
    static inject: string[];
    static Config: z<Config>;
    readonly client: WorkerTunnelClient;
    readonly dispatcher: WorkerStreamDispatcher;
    /**
     * @param ctx - Host context carrying typertGateway.
     * @param config - Worker settings.
     */
    constructor(ctx: Context, config: Config);
    private applyDisableTokenAuth;
    /** Close local stream dispatcher and terminate tunnel client. */
    dispose(): Promise<void>;
}
export default ClusterWorkerService;
//# sourceMappingURL=plugin.d.ts.map