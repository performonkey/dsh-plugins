/** Master-side HTTP and WebSocket stream relay connecting browsers to remote workers. */
import { WebSocketServer, WebSocket } from 'ws';
/** Relays browser HTTP RPCs and /api/remote.mux WebSocket streams transparently to Workers. */
export class MasterRelay {
    config;
    registry;
    muxServer;
    activeClientSockets = new Set();
    /**
     * @param config - Relay configuration.
     */
    constructor(config) {
        this.config = config;
        this.registry = config.registry;
        this.muxServer = new WebSocketServer({ noServer: true });
    }
    /**
     * Transparently forward an incoming HTTP request (e.g. POST /api) to an active worker.
     * @param req - Incoming HTTP request.
     * @param res - Server HTTP response.
     */
    async handleHttpRequest(req, res) {
        const workerId = this.resolveWorker(req);
        if (!workerId) {
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'No worker available to serve request' }));
            return;
        }
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks).toString('utf-8');
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === 'string') {
                headers[k] = v;
            }
            else if (Array.isArray(v)) {
                headers[k] = v.join(', ');
            }
        }
        // The browser dropping the call ends the upstream wait: without this the worker keeps
        // serving a request nobody reads and the tunnel holds the slot until the timeout expires.
        const controller = new AbortController();
        const onClientGone = () => controller.abort();
        res.on('close', onClientGone);
        try {
            const resp = await this.registry.sendHttpRequest(workerId, {
                method: req.method ?? 'GET',
                path: req.url ?? '/',
                headers,
                body: body.length > 0 ? body : undefined,
            }, undefined, controller.signal);
            if (controller.signal.aborted)
                return;
            res.writeHead(resp.status, resp.headers);
            res.end(resp.body);
        }
        catch (err) {
            if (controller.signal.aborted)
                return;
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: String(err) }));
        }
        finally {
            res.off('close', onClientGone);
        }
    }
    /**
     * Handle an HTTP upgrade request for the /api/remote.mux endpoint.
     * @param req - Upgrade HTTP request.
     * @param socket - Upgraded network socket.
     * @param head - Buffer head.
     */
    handleMuxUpgrade(req, socket, head) {
        const workerId = this.resolveWorker(req);
        const worker = workerId ? this.registry.getWorker(workerId) : undefined;
        if (!worker) {
            socket.destroy();
            return;
        }
        this.muxServer.handleUpgrade(req, socket, head, (clientWs) => {
            this.activeClientSockets.add(clientWs);
            const openStreamIds = new Set();
            // Forward worker frames back to this browser socket
            const frameHandler = (srcWorkerId, frame) => {
                if (srcWorkerId !== worker.id)
                    return;
                if (frame.type === 'stream:item' && openStreamIds.has(frame.streamId)) {
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({
                            type: 'item',
                            streamId: frame.streamId,
                            value: frame.value,
                        }));
                    }
                }
                else if (frame.type === 'stream:close' && openStreamIds.has(frame.streamId)) {
                    openStreamIds.delete(frame.streamId);
                    if (clientWs.readyState === WebSocket.OPEN) {
                        if (frame.error) {
                            clientWs.send(JSON.stringify({
                                type: 'error',
                                streamId: frame.streamId,
                                error: frame.error,
                            }));
                        }
                        clientWs.send(JSON.stringify({
                            type: 'end',
                            streamId: frame.streamId,
                        }));
                    }
                }
            };
            this.registry.on('frame', frameHandler);
            // Forward browser socket messages through the reverse tunnel to worker
            clientWs.on('message', (raw) => {
                try {
                    const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
                    const msg = JSON.parse(text);
                    if (typeof msg.streamId !== 'string')
                        return;
                    const streamId = msg.streamId;
                    switch (msg.type) {
                        case 'open': {
                            if (typeof msg.endpoint === 'string') {
                                openStreamIds.add(streamId);
                                const openFrame = {
                                    type: 'stream:open',
                                    streamId,
                                    endpoint: msg.endpoint,
                                    payload: msg.payload,
                                };
                                worker.send(openFrame);
                            }
                            break;
                        }
                        case 'item': {
                            const uplinkFrame = {
                                type: 'stream:uplink',
                                streamId,
                                item: msg.value ?? msg.item,
                            };
                            worker.send(uplinkFrame);
                            break;
                        }
                        case 'cancel': {
                            openStreamIds.delete(streamId);
                            const closeFrame = {
                                type: 'stream:close',
                                streamId,
                                reason: 'cancelled',
                            };
                            worker.send(closeFrame);
                            break;
                        }
                        default:
                            break;
                    }
                }
                catch {
                    // Ignore malformed browser frame
                }
            });
            const cleanup = () => {
                this.registry.off('frame', frameHandler);
                this.activeClientSockets.delete(clientWs);
                // Clean up any in-flight streams on this socket
                for (const streamId of openStreamIds) {
                    worker.send({
                        type: 'stream:close',
                        streamId,
                        reason: 'browser disconnected',
                    });
                }
                openStreamIds.clear();
            };
            clientWs.on('close', cleanup);
            clientWs.on('error', cleanup);
        });
    }
    resolveWorker(req) {
        if (this.config.selectWorker) {
            const selected = this.config.selectWorker(req);
            if (selected)
                return selected;
        }
        const workers = this.registry.getWorkers();
        return workers.length > 0 ? workers[0]?.id : undefined;
    }
    /** Close all active client connections. */
    close() {
        for (const ws of this.activeClientSockets) {
            try {
                ws.close();
            }
            catch {
                // Ignore close faults
            }
        }
        this.activeClientSockets.clear();
        this.muxServer.close();
    }
}
//# sourceMappingURL=relay.js.map