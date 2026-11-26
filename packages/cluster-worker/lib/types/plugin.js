/** Cordis service running on Worker nodes, connecting outbound to Master. */
import os from 'node:os';
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { WorkerTunnelClient } from "./client.js";
import { WorkerStreamDispatcher } from "./stream-dispatcher.js";
const DEFAULT_OWNER_PRINCIPAL = { kind: 'owner' };
/** Cluster Worker Cordis service managing outbound reverse connection to Master. */
export class ClusterWorkerService extends Service {
    static inject = ['typertGateway'];
    static Config = z.object({
        masterUrl: z.string().default(process.env.DSH_CLUSTER_MASTER_URL ?? 'ws://127.0.0.1:8080/api/worker/connect'),
        authToken: z.string().default(process.env.DSH_CLUSTER_AUTH_TOKEN ?? 'default-cluster-token'),
        workerId: z.string().default(process.env.DSH_CLUSTER_WORKER_ID ?? `worker-${os.hostname()}`),
        name: z.string().default(process.env.DSH_CLUSTER_WORKER_NAME ?? os.hostname()),
        workspaces: z.array(z.string()).default([process.cwd()]),
        autoReconnect: z.boolean().default(true),
    });
    client;
    dispatcher;
    /**
     * @param ctx - Host context carrying typertGateway.
     * @param config - Worker settings.
     */
    constructor(ctx, config) {
        super(ctx, 'clusterWorker');
        const workerId = (config.workerId ?? `worker-${os.hostname()}`);
        this.client = new WorkerTunnelClient({
            masterUrl: config.masterUrl,
            token: config.authToken,
            workerId,
            name: config.name ?? os.hostname(),
            workspaces: config.workspaces ?? [process.cwd()],
            autoReconnect: config.autoReconnect,
        });
        // Disable local token authentication on worker so master tunnel requests are admitted
        const existingConn = ctx.get('connection');
        if (existingConn) {
            this.applyDisableTokenAuth(existingConn);
        }
        this.ctx.inject(['connection'], connCtx => {
            const conn = connCtx.connection ?? connCtx.get('connection');
            this.applyDisableTokenAuth(conn);
        });
        const getOwnerPeer = () => {
            const connection = ctx.get('connection');
            if (connection?.browserPeer) {
                return connection.browserPeer;
            }
            return {
                id: 'local-cluster-worker-peer',
                principal: DEFAULT_OWNER_PRINCIPAL,
                interactions: 'answer',
                dispose: () => Promise.resolve(),
            };
        };
        const typertGateway = ctx.get('typertGateway');
        this.dispatcher = new WorkerStreamDispatcher((endpoint, payload, uplink, signal) => {
            const peer = getOwnerPeer();
            return typertGateway.wireStream.open(endpoint, payload, uplink, peer, signal);
        }, frame => this.client.send(frame));
        this.client.on('frame', frame => {
            void this.dispatcher.handleFrame(frame);
        });
        this.client.on('error', err => {
            console.warn('[cluster-worker] tunnel error:', err);
        });
        this.client.on('close', () => {
            console.log('[cluster-worker] tunnel disconnected from master');
        });
        // Hook HTTP request dispatching
        this.client.onRequest(async (req, signal) => {
            // Short-circuit SSE events from client-hmr (which never terminates and causes proxy timeouts)
            if (req.path === '/plugins/events' || req.path.startsWith('/plugins/events?')) {
                return {
                    status: 204,
                    headers: { 'content-type': 'text/plain; charset=utf-8' },
                    body: '',
                };
            }
            const connection = ctx.get('connection');
            if (req.path.startsWith('/api') && connection?.createSharedFetchHandler) {
                const fetchHandler = connection.createSharedFetchHandler('/api');
                const headers = {};
                if (req.headers) {
                    for (const [k, v] of Object.entries(req.headers)) {
                        if (v !== undefined)
                            headers[k] = v;
                    }
                }
                const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined;
                const request = new Request(new URL(req.path, 'http://dsh.internal'), {
                    method: req.method,
                    headers,
                    signal,
                    ...(hasBody ? { body: req.body } : {}),
                });
                const peer = getOwnerPeer();
                const response = await fetchHandler.fetch(request, peer);
                if (response.status !== 404) {
                    const body = await response.text();
                    const respHeaders = {};
                    response.headers.forEach((v, k) => {
                        respHeaders[k] = v;
                    });
                    return {
                        status: response.status,
                        headers: respHeaders,
                        body,
                    };
                }
            }
            // If path is not /api or not handled, forward to local webServer (serves dynamic HTML injections & modules)
            const webServer = ctx.get('webServer');
            if (webServer?.port) {
                try {
                    const localUrl = `http://${webServer.host ?? '127.0.0.1'}:${webServer.port}${req.path}`;
                    const headers = {};
                    if (req.headers) {
                        for (const [k, v] of Object.entries(req.headers)) {
                            if (v !== undefined && k.toLowerCase() !== 'host') {
                                headers[k] = v;
                            }
                        }
                    }
                    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined;
                    const resp = await fetch(localUrl, {
                        method: req.method,
                        headers,
                        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
                        ...(hasBody && req.body !== undefined ? { body: req.body } : {}),
                    });
                    const body = await resp.text();
                    const respHeaders = {};
                    resp.headers.forEach((v, k) => {
                        respHeaders[k] = v;
                    });
                    return {
                        status: resp.status,
                        headers: respHeaders,
                        body,
                    };
                }
                catch (fetchErr) {
                    if (signal.aborted)
                        throw fetchErr;
                    console.error('[cluster-worker] failed to proxy HTTP to local webServer:', fetchErr);
                }
            }
            if ('invoke' in typertGateway && typeof typertGateway.invoke === 'function') {
                try {
                    const endpoint = req.path.replace(/^\/api\/?/, '');
                    const payload = req.body ? JSON.parse(req.body) : {};
                    const peer = getOwnerPeer();
                    const result = await typertGateway.invoke({
                        endpoint,
                        payload,
                        peer,
                        signal,
                    });
                    return {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify(result),
                    };
                }
                catch (err) {
                    return {
                        status: 500,
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ error: err?.message ?? String(err) }),
                    };
                }
            }
            return {
                status: 404,
                body: JSON.stringify({ error: 'Neither connection fetch handler nor typertGateway.invoke available on worker' }),
            };
        });
        // Start outbound connection
        this.client.on('connected', () => {
            console.log(`[cluster-worker] connected to master: ${config.masterUrl}`);
        });
        this.client.on('disconnected', (detail) => {
            const extra = detail?.code ? ` (code: ${detail.code}${detail.reason ? `, reason: ${detail.reason}` : ''})` : '';
            console.log(`[cluster-worker] disconnected from master${extra}`);
        });
        void this.client.start().catch((err) => {
            console.warn('[cluster-worker] initial connection attempt failed:', err);
        });
        this.ctx.effect(() => {
            return () => {
                return this.dispose();
            };
        }, 'cluster-worker: teardown');
    }
    applyDisableTokenAuth(connection) {
        if (!connection)
            return;
        connection.authorizeIndex = () => true;
        connection.admit = () => {
            if (connection.disposed)
                return { rejection: 401 };
            return { peer: connection.browserPeer };
        };
        connection.admitConnection = () => {
            if (connection.disposed)
                return { rejection: 401 };
            return { peer: connection.browserPeer, release: () => Promise.resolve() };
        };
        connection.requestRejection = () => undefined;
        connection.authenticatedUrl = (baseUrl) => baseUrl;
        console.log('[cluster-worker] Worker local token authentication disabled (delegated to Master)');
    }
    /** Close local stream dispatcher and terminate tunnel client. */
    async dispose() {
        this.dispatcher.close();
        await this.client.stop();
    }
}
export default ClusterWorkerService;
//# sourceMappingURL=plugin.js.map