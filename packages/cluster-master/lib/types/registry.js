/** Master-side registry and reverse WebSocket connection manager for distributed workers. */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DEFAULT_HEARTBEAT_INTERVAL_MS, MAX_MISSED_PONGS, parseClusterFrame, serializeClusterFrame, } from '@deepseek-ai/dsh-cluster-protocol';
/** Active connection state for a single worker node. */
export class WorkerConnection {
    id;
    name;
    workspaces;
    version;
    connectedAt;
    lastHeartbeat;
    missedPongs = 0;
    socket;
    pendingCalls = new Map();
    /**
     * @param hello - Initial worker hello frame.
     * @param socket - Established WebSocket connection.
     */
    constructor(hello, socket) {
        this.id = hello.workerId;
        this.name = hello.name;
        this.workspaces = hello.workspaces;
        this.version = hello.version;
        this.connectedAt = Date.now();
        this.lastHeartbeat = this.connectedAt;
        this.socket = socket;
    }
    /**
     * Send a typed frame over the worker socket.
     * @param frame - Frame to serialize and send.
     */
    send(frame) {
        if (this.socket.readyState === 1) {
            this.socket.send(serializeClusterFrame(frame));
        }
    }
    /**
     * Handle an incoming HTTP response frame from this worker.
     * @param frame - HTTP response frame.
     */
    handleHttpResp(frame) {
        const pending = this.pendingCalls.get(frame.reqId);
        if (pending) {
            clearTimeout(pending.timer);
            this.pendingCalls.delete(frame.reqId);
            pending.resolve(frame);
        }
    }
    /**
     * Dispatch an HTTP request frame through the reverse tunnel to this worker.
     * @param req - HTTP request parameters.
     * @param timeoutMs - Max response wait time.
     * @param signal - Abandons the call when the caller stops waiting for it.
     * @returns Resolves with worker's HTTP response, or a synthesized 499 when `signal` aborts.
     */
    sendHttpRequest(req, timeoutMs = 30_000, signal) {
        return new Promise((resolve, reject) => {
            const reqId = randomUUID();
            const frame = {
                type: 'http:req',
                reqId,
                method: req.method,
                path: req.path,
                headers: req.headers,
                body: req.body,
            };
            // A caller that stops waiting releases the worker immediately instead of holding the
            // tunnel until the timeout expires. The upstream convention for a request the client
            // closed is a 499, which is not an error the worker or the caller produced.
            const onAbandon = () => {
                if (!this.pendingCalls.delete(reqId))
                    return;
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbandon);
                this.send({ type: 'http:cancel', reqId });
                resolve({ type: 'http:resp', reqId, status: 499, headers: {}, body: undefined });
            };
            // Every exit drops the abort listener, so a caller reusing one long-lived signal across
            // requests does not accumulate listeners for calls that already settled.
            const detach = () => {
                signal?.removeEventListener('abort', onAbandon);
            };
            const timer = setTimeout(() => {
                if (!this.pendingCalls.delete(reqId))
                    return;
                detach();
                reject(new Error(`HTTP request ${reqId} to worker ${this.id} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            if (signal?.aborted) {
                // The caller was already gone before the request was sent: settle without sending,
                // so the worker is never asked to serve a request nobody is waiting to read.
                resolve({ type: 'http:resp', reqId, status: 499, headers: {}, body: undefined });
                return;
            }
            signal?.addEventListener('abort', onAbandon, { once: true });
            this.pendingCalls.set(reqId, {
                resolve: (resp) => {
                    this.pendingCalls.delete(reqId);
                    detach();
                    resolve(resp);
                },
                reject: (error) => {
                    this.pendingCalls.delete(reqId);
                    detach();
                    reject(error);
                },
                timer,
            });
            this.send(frame);
        });
    }
    /**
     * Terminate active socket and reject all pending calls.
     * @param reason - Diagnostic closure reason.
     */
    close(reason) {
        for (const [reqId, pending] of this.pendingCalls.entries()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(`Worker ${this.id} disconnected: ${reason ?? 'unknown'}`));
            this.pendingCalls.delete(reqId);
        }
        try {
            this.socket.close(1000, reason);
        }
        catch {
            // Ignore socket closing faults
        }
    }
    /**
     * Return detached snapshot information.
     * @returns Worker information object.
     */
    toInfo() {
        return {
            id: this.id,
            name: this.name,
            workspaces: this.workspaces,
            version: this.version,
            connectedAt: this.connectedAt,
            lastHeartbeat: this.lastHeartbeat,
        };
    }
}
/** Registry that accepts, authenticates, and manages reverse worker connections. */
export class WorkerRegistry extends EventEmitter {
    config;
    workers = new Map();
    heartbeatIntervalMs;
    maxMissedPongs;
    heartbeatTimer;
    isClosed = false;
    /**
     * @param config - Registry settings.
     */
    constructor(config) {
        super();
        this.config = config;
        this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
        this.maxMissedPongs = config.maxMissedPongs ?? MAX_MISSED_PONGS;
        this.startHeartbeat();
    }
    /**
     * Handle an accepted WebSocket connection for the reverse tunnel endpoint.
     * @param socket - Accepted WebSocket.
     */
    handleConnection(socket) {
        if (this.isClosed) {
            socket.close(1001, 'Master is shutting down');
            return;
        }
        let connection;
        const handshakeTimeout = setTimeout(() => {
            if (!connection) {
                socket.close(4001, 'Handshake timeout');
            }
        }, 10_000);
        socket.on('message', (data) => {
            const frame = parseClusterFrame(data);
            if (!frame)
                return;
            if (frame.type === 'control:hello') {
                clearTimeout(handshakeTimeout);
                if (frame.token !== this.config.authToken) {
                    const rejectFrame = {
                        type: 'control:ready',
                        accepted: false,
                        reason: 'Authentication failed: invalid token',
                        masterTime: Date.now(),
                    };
                    socket.send(serializeClusterFrame(rejectFrame));
                    socket.close(4003, 'Unauthorized');
                    return;
                }
                // Close any prior connection with the same workerId
                const existing = this.workers.get(frame.workerId);
                if (existing) {
                    existing.close('Replaced by new connection');
                    this.workers.delete(frame.workerId);
                }
                connection = new WorkerConnection(frame, socket);
                this.workers.set(connection.id, connection);
                const readyFrame = {
                    type: 'control:ready',
                    accepted: true,
                    masterTime: Date.now(),
                };
                connection.send(readyFrame);
                this.emit('worker:connected', connection.toInfo());
                return;
            }
            if (!connection) {
                socket.close(4002, 'Handshake required before message dispatch');
                return;
            }
            switch (frame.type) {
                case 'pong':
                    connection.lastHeartbeat = Date.now();
                    connection.missedPongs = 0;
                    break;
                case 'http:resp':
                    connection.handleHttpResp(frame);
                    break;
                default:
                    this.emit('frame', connection.id, frame);
                    break;
            }
        });
        socket.on('close', () => {
            clearTimeout(handshakeTimeout);
            if (connection) {
                const id = connection.id;
                connection.close('Socket closed');
                this.workers.delete(id);
                this.emit('worker:disconnected', id);
            }
        });
        socket.on('error', () => {
            clearTimeout(handshakeTimeout);
            if (connection) {
                const id = connection.id;
                connection.close('Socket error');
                this.workers.delete(id);
                this.emit('worker:disconnected', id);
            }
        });
    }
    /**
     * Retrieve list of currently online workers.
     * @returns Array of worker snapshots.
     */
    getWorkers() {
        return Array.from(this.workers.values()).map(w => w.toInfo());
    }
    /**
     * Find an active worker connection by workerId.
     * @param id - Target worker ID.
     * @returns Worker connection instance or undefined.
     */
    getWorker(id) {
        return this.workers.get(id);
    }
    /**
     * Dispatch an HTTP request to a specific worker.
     * @param workerId - Target worker ID.
     * @param req - HTTP request parameters.
     * @param timeoutMs - Max response wait time.
     * @param signal - Abandons the call when the caller stops waiting for it.
     * @returns Response frame.
     */
    sendHttpRequest(workerId, req, timeoutMs, signal) {
        const worker = this.getWorker(workerId);
        if (!worker) {
            return Promise.reject(new Error(`Worker ${workerId} is not connected`));
        }
        return worker.sendHttpRequest(req, timeoutMs, signal);
    }
    startHeartbeat() {
        this.heartbeatTimer = setInterval(() => {
            const ping = { type: 'ping', timestamp: Date.now() };
            for (const [id, worker] of this.workers.entries()) {
                worker.missedPongs++;
                if (worker.missedPongs > this.maxMissedPongs) {
                    worker.close('Heartbeat timeout (missed pongs exceeded limit)');
                    this.workers.delete(id);
                    this.emit('worker:disconnected', id);
                }
                else {
                    worker.send(ping);
                }
            }
        }, this.heartbeatIntervalMs);
    }
    /** Terminate all connections and close registry. */
    async close() {
        this.isClosed = true;
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        for (const [id, worker] of this.workers.entries()) {
            worker.close('Registry closed');
            this.workers.delete(id);
        }
    }
}
//# sourceMappingURL=registry.js.map