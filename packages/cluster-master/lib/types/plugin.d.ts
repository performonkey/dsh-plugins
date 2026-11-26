/** Cordis service mounting the Cluster Master reverse tunnel and relay on the WebServer. */
import { Service, type Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { WorkerRegistry } from './registry.ts';
import { MasterRelay } from './relay.ts';
export interface Config {
    /** Pre-shared secret token required from workers during handshake. */
    readonly authToken: string;
    /** WebSocket endpoint path for worker reverse connection. */
    readonly workerConnectPath?: string;
    /** Cadence of heartbeat ping frames in milliseconds. */
    readonly heartbeatIntervalMs?: number;
    /** Maximum consecutive unanswered pings before worker is pruned. */
    readonly maxMissedPongs?: number;
    /** Whether to disable Master token authentication for Web UI and API (delegating auth to a reverse proxy such as Nginx basic auth). */
    readonly disableTokenAuth?: boolean;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Cluster Master service instance. */
        clusterMaster: ClusterMasterService;
    }
}
/** Cluster Master Cordis service managing remote worker registrations and proxying browser traffic. */
export declare class ClusterMasterService extends Service {
    static inject: string[];
    static Config: z<Config>;
    readonly registry: WorkerRegistry;
    readonly relay: MasterRelay;
    private readonly workerWss;
    /**
     * @param ctx - Host context.
     * @param config - Cluster master configuration.
     */
    constructor(ctx: Context, config: Config);
    /**
     * Disables Master launch token and cookie validation, delegating admission
     * control to an upstream reverse proxy (such as Nginx HTTP Basic Auth).
     * @param connection - Connection host service instance.
     */
    private applyDisableTokenAuth;
    /** Tear down relay, web socket server and worker registry connections. */
    dispose(): void;
}
export default ClusterMasterService;
//# sourceMappingURL=plugin.d.ts.map