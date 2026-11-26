import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_WORKER_TUNNEL_PATH, MAX_MISSED_PONGS, parseClusterFrame, serializeClusterFrame } from "@deepseek-ai/dsh-cluster-protocol";
import { WebSocket, WebSocketServer } from "ws";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
//#region src/registry.ts
/** Master-side registry and reverse WebSocket connection manager for distributed workers. */
/** Active connection state for a single worker node. */
var WorkerConnection = class {
	id;
	name;
	workspaces;
	version;
	connectedAt;
	lastHeartbeat;
	missedPongs = 0;
	socket;
	pendingCalls = /* @__PURE__ */ new Map();
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
		if (this.socket.readyState === 1) this.socket.send(serializeClusterFrame(frame));
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
	sendHttpRequest(req, timeoutMs = 3e4, signal) {
		return new Promise((resolve, reject) => {
			const reqId = randomUUID();
			const frame = {
				type: "http:req",
				reqId,
				method: req.method,
				path: req.path,
				headers: req.headers,
				body: req.body
			};
			const onAbandon = () => {
				if (!this.pendingCalls.delete(reqId)) return;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbandon);
				this.send({
					type: "http:cancel",
					reqId
				});
				resolve({
					type: "http:resp",
					reqId,
					status: 499,
					headers: {},
					body: void 0
				});
			};
			const detach = () => {
				signal?.removeEventListener("abort", onAbandon);
			};
			const timer = setTimeout(() => {
				if (!this.pendingCalls.delete(reqId)) return;
				detach();
				reject(/* @__PURE__ */ new Error(`HTTP request ${reqId} to worker ${this.id} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			if (signal?.aborted) {
				resolve({
					type: "http:resp",
					reqId,
					status: 499,
					headers: {},
					body: void 0
				});
				return;
			}
			signal?.addEventListener("abort", onAbandon, { once: true });
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
				timer
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
			pending.reject(/* @__PURE__ */ new Error(`Worker ${this.id} disconnected: ${reason ?? "unknown"}`));
			this.pendingCalls.delete(reqId);
		}
		try {
			this.socket.close(1e3, reason);
		} catch {}
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
			lastHeartbeat: this.lastHeartbeat
		};
	}
};
/** Registry that accepts, authenticates, and manages reverse worker connections. */
var WorkerRegistry = class extends EventEmitter {
	config;
	workers = /* @__PURE__ */ new Map();
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
			socket.close(1001, "Master is shutting down");
			return;
		}
		let connection;
		const handshakeTimeout = setTimeout(() => {
			if (!connection) socket.close(4001, "Handshake timeout");
		}, 1e4);
		socket.on("message", (data) => {
			const frame = parseClusterFrame(data);
			if (!frame) return;
			if (frame.type === "control:hello") {
				clearTimeout(handshakeTimeout);
				if (frame.token !== this.config.authToken) {
					const rejectFrame = {
						type: "control:ready",
						accepted: false,
						reason: "Authentication failed: invalid token",
						masterTime: Date.now()
					};
					socket.send(serializeClusterFrame(rejectFrame));
					socket.close(4003, "Unauthorized");
					return;
				}
				const existing = this.workers.get(frame.workerId);
				if (existing) {
					existing.close("Replaced by new connection");
					this.workers.delete(frame.workerId);
				}
				connection = new WorkerConnection(frame, socket);
				this.workers.set(connection.id, connection);
				const readyFrame = {
					type: "control:ready",
					accepted: true,
					masterTime: Date.now()
				};
				connection.send(readyFrame);
				this.emit("worker:connected", connection.toInfo());
				return;
			}
			if (!connection) {
				socket.close(4002, "Handshake required before message dispatch");
				return;
			}
			switch (frame.type) {
				case "pong":
					connection.lastHeartbeat = Date.now();
					connection.missedPongs = 0;
					break;
				case "http:resp":
					connection.handleHttpResp(frame);
					break;
				default:
					this.emit("frame", connection.id, frame);
					break;
			}
		});
		socket.on("close", () => {
			clearTimeout(handshakeTimeout);
			if (connection) {
				const id = connection.id;
				connection.close("Socket closed");
				this.workers.delete(id);
				this.emit("worker:disconnected", id);
			}
		});
		socket.on("error", () => {
			clearTimeout(handshakeTimeout);
			if (connection) {
				const id = connection.id;
				connection.close("Socket error");
				this.workers.delete(id);
				this.emit("worker:disconnected", id);
			}
		});
	}
	/**
	* Retrieve list of currently online workers.
	* @returns Array of worker snapshots.
	*/
	getWorkers() {
		return Array.from(this.workers.values()).map((w) => w.toInfo());
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
		if (!worker) return Promise.reject(/* @__PURE__ */ new Error(`Worker ${workerId} is not connected`));
		return worker.sendHttpRequest(req, timeoutMs, signal);
	}
	startHeartbeat() {
		this.heartbeatTimer = setInterval(() => {
			const ping = {
				type: "ping",
				timestamp: Date.now()
			};
			for (const [id, worker] of this.workers.entries()) {
				worker.missedPongs++;
				if (worker.missedPongs > this.maxMissedPongs) {
					worker.close("Heartbeat timeout (missed pongs exceeded limit)");
					this.workers.delete(id);
					this.emit("worker:disconnected", id);
				} else worker.send(ping);
			}
		}, this.heartbeatIntervalMs);
	}
	/** Terminate all connections and close registry. */
	async close() {
		this.isClosed = true;
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = void 0;
		}
		for (const [id, worker] of this.workers.entries()) {
			worker.close("Registry closed");
			this.workers.delete(id);
		}
	}
};
//#endregion
//#region src/relay.ts
/** Relays browser HTTP RPCs and /api/remote.mux WebSocket streams transparently to Workers. */
var MasterRelay = class {
	config;
	registry;
	muxServer;
	activeClientSockets = /* @__PURE__ */ new Set();
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
			res.writeHead(503, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "No worker available to serve request" }));
			return;
		}
		const chunks = [];
		for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		const body = Buffer.concat(chunks).toString("utf-8");
		const headers = {};
		for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
		else if (Array.isArray(v)) headers[k] = v.join(", ");
		const controller = new AbortController();
		const onClientGone = () => controller.abort();
		res.on("close", onClientGone);
		try {
			const resp = await this.registry.sendHttpRequest(workerId, {
				method: req.method ?? "GET",
				path: req.url ?? "/",
				headers,
				body: body.length > 0 ? body : void 0
			}, void 0, controller.signal);
			if (controller.signal.aborted) return;
			res.writeHead(resp.status, resp.headers);
			res.end(resp.body);
		} catch (err) {
			if (controller.signal.aborted) return;
			res.writeHead(502, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: String(err) }));
		} finally {
			res.off("close", onClientGone);
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
		const worker = workerId ? this.registry.getWorker(workerId) : void 0;
		if (!worker) {
			socket.destroy();
			return;
		}
		this.muxServer.handleUpgrade(req, socket, head, (clientWs) => {
			this.activeClientSockets.add(clientWs);
			const openStreamIds = /* @__PURE__ */ new Set();
			const frameHandler = (srcWorkerId, frame) => {
				if (srcWorkerId !== worker.id) return;
				if (frame.type === "stream:item" && openStreamIds.has(frame.streamId)) {
					if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify({
						type: "item",
						streamId: frame.streamId,
						value: frame.value
					}));
				} else if (frame.type === "stream:close" && openStreamIds.has(frame.streamId)) {
					openStreamIds.delete(frame.streamId);
					if (clientWs.readyState === WebSocket.OPEN) {
						if (frame.error) clientWs.send(JSON.stringify({
							type: "error",
							streamId: frame.streamId,
							error: frame.error
						}));
						clientWs.send(JSON.stringify({
							type: "end",
							streamId: frame.streamId
						}));
					}
				}
			};
			this.registry.on("frame", frameHandler);
			clientWs.on("message", (raw) => {
				try {
					const text = typeof raw === "string" ? raw : raw.toString("utf-8");
					const msg = JSON.parse(text);
					if (typeof msg.streamId !== "string") return;
					const streamId = msg.streamId;
					switch (msg.type) {
						case "open":
							if (typeof msg.endpoint === "string") {
								openStreamIds.add(streamId);
								const openFrame = {
									type: "stream:open",
									streamId,
									endpoint: msg.endpoint,
									payload: msg.payload
								};
								worker.send(openFrame);
							}
							break;
						case "item": {
							const uplinkFrame = {
								type: "stream:uplink",
								streamId,
								item: msg.value ?? msg.item
							};
							worker.send(uplinkFrame);
							break;
						}
						case "cancel": {
							openStreamIds.delete(streamId);
							const closeFrame = {
								type: "stream:close",
								streamId,
								reason: "cancelled"
							};
							worker.send(closeFrame);
							break;
						}
						default: break;
					}
				} catch {}
			});
			const cleanup = () => {
				this.registry.off("frame", frameHandler);
				this.activeClientSockets.delete(clientWs);
				for (const streamId of openStreamIds) worker.send({
					type: "stream:close",
					streamId,
					reason: "browser disconnected"
				});
				openStreamIds.clear();
			};
			clientWs.on("close", cleanup);
			clientWs.on("error", cleanup);
		});
	}
	resolveWorker(req) {
		if (this.config.selectWorker) {
			const selected = this.config.selectWorker(req);
			if (selected) return selected;
		}
		const workers = this.registry.getWorkers();
		return workers.length > 0 ? workers[0]?.id : void 0;
	}
	/** Close all active client connections. */
	close() {
		for (const ws of this.activeClientSockets) try {
			ws.close();
		} catch {}
		this.activeClientSockets.clear();
		this.muxServer.close();
	}
};
//#endregion
//#region src/plugin.ts
/** Cordis service mounting the Cluster Master reverse tunnel and relay on the WebServer. */
/** Cluster Master Cordis service managing remote worker registrations and proxying browser traffic. */
var ClusterMasterService = class extends Service {
	static inject = ["webServer"];
	static Config = z.object({
		authToken: z.string().default(process.env.DSH_CLUSTER_AUTH_TOKEN ?? "default-cluster-token"),
		workerConnectPath: z.string().default(DEFAULT_WORKER_TUNNEL_PATH),
		heartbeatIntervalMs: z.number().default(DEFAULT_HEARTBEAT_INTERVAL_MS),
		maxMissedPongs: z.number().default(MAX_MISSED_PONGS),
		disableTokenAuth: z.boolean().default(process.env.DSH_DISABLE_TOKEN_AUTH === "true" || process.env.DSH_DISABLE_TOKEN_AUTH === "1")
	});
	registry;
	relay;
	workerWss;
	/**
	* @param ctx - Host context.
	* @param config - Cluster master configuration.
	*/
	constructor(ctx, config) {
		super(ctx, "clusterMaster");
		this.registry = new WorkerRegistry({
			authToken: config.authToken,
			heartbeatIntervalMs: config.heartbeatIntervalMs,
			maxMissedPongs: config.maxMissedPongs
		});
		this.relay = new MasterRelay({ registry: this.registry });
		this.workerWss = new WebSocketServer({ noServer: true });
		this.registry.on("worker:connected", (info) => {
			console.log(`[cluster-master] worker registered: ${info.name} (${info.id}) workspaces: ${info.workspaces.join(", ")}`);
		});
		this.registry.on("worker:disconnected", (info) => {
			console.log(`[cluster-master] worker disconnected: ${info.name} (${info.id})`);
		});
		if (config.disableTokenAuth) {
			const existingConn = ctx.get("connection");
			if (existingConn) this.applyDisableTokenAuth(existingConn);
			this.ctx.inject(["connection"], (connCtx) => {
				const conn = connCtx.connection ?? connCtx.get("connection");
				this.applyDisableTokenAuth(conn);
			});
		}
		const webServer = ctx.webServer;
		this.ctx.effect(() => {
			return webServer.registerUpgrade({
				path: config.workerConnectPath ?? DEFAULT_WORKER_TUNNEL_PATH,
				handler: (req, socket, head) => {
					this.workerWss.handleUpgrade(req, socket, head, (client) => {
						this.registry.handleConnection(client);
					});
				}
			});
		}, "cluster-master: worker connect route");
		const origRegisterUpgrade = typeof webServer.registerUpgrade === "function" ? webServer.registerUpgrade.bind(webServer) : void 0;
		const muxRoute = {
			path: "/api/remote.mux",
			handler: (req, socket, head) => {
				this.relay.handleMuxUpgrade(req, socket, head);
			}
		};
		if (origRegisterUpgrade) {
			let registeredMux = false;
			webServer.registerUpgrade = (route) => {
				if (route.path === "/api/remote.mux") {
					registeredMux = true;
					if (webServer.upgrades?.has?.("/api/remote.mux")) {
						webServer.upgrades.set("/api/remote.mux", muxRoute);
						return () => {
							webServer.upgrades?.delete?.("/api/remote.mux");
						};
					}
					return origRegisterUpgrade(muxRoute);
				}
				return origRegisterUpgrade(route);
			};
			this.ctx.effect(() => {
				if (!registeredMux && !webServer.upgrades?.has?.("/api/remote.mux")) {
					registeredMux = true;
					return origRegisterUpgrade(muxRoute);
				}
				webServer.upgrades?.set?.("/api/remote.mux", muxRoute);
				return () => {
					webServer.upgrades?.delete?.("/api/remote.mux");
				};
			}, "cluster-master: /api/remote.mux stream relay");
		}
		const origRegister = typeof webServer.register === "function" ? webServer.register.bind(webServer) : void 0;
		const apiRoute = {
			kind: "prefix",
			path: "/api",
			handler: (req, res) => {
				this.relay.handleHttpRequest(req, res);
			}
		};
		if (origRegister) {
			let registeredApi = false;
			webServer.register = (route) => {
				if (route.kind === "prefix" && route.path === "/api") {
					registeredApi = true;
					if (webServer.prefixes?.has?.("/api")) {
						webServer.prefixes.set("/api", apiRoute);
						return () => {
							webServer.prefixes?.delete?.("/api");
						};
					}
					return origRegister(apiRoute);
				}
				return origRegister(route);
			};
			this.ctx.effect(() => {
				if (!registeredApi && !webServer.prefixes?.has?.("/api")) {
					registeredApi = true;
					return origRegister(apiRoute);
				}
				webServer.prefixes?.set?.("/api", apiRoute);
				return () => {
					webServer.prefixes?.delete?.("/api");
				};
			}, "cluster-master: /api http relay");
		}
		this.ctx.effect(() => {
			return () => {
				this.dispose();
			};
		}, "cluster-master: teardown");
	}
	/**
	* Disables Master launch token and cookie validation, delegating admission
	* control to an upstream reverse proxy (such as Nginx HTTP Basic Auth).
	* @param connection - Connection host service instance.
	*/
	applyDisableTokenAuth(connection) {
		if (!connection) return;
		connection.authorizeIndex = () => true;
		connection.admit = () => {
			if (connection.disposed) return { rejection: 401 };
			return { peer: connection.browserPeer };
		};
		connection.admitConnection = () => {
			if (connection.disposed) return { rejection: 401 };
			return {
				peer: connection.browserPeer,
				release: () => Promise.resolve()
			};
		};
		connection.requestRejection = () => void 0;
		connection.authenticatedUrl = (baseUrl) => baseUrl;
		console.log("[cluster-master] Master token authentication disabled (delegating auth to reverse proxy / HTTP Basic Auth)");
	}
	/** Tear down relay, web socket server and worker registry connections. */
	dispose() {
		this.relay.close();
		this.workerWss.close();
		this.registry.close();
	}
};
//#endregion
export { ClusterMasterService, ClusterMasterService as default, MasterRelay, WorkerConnection, WorkerRegistry };
