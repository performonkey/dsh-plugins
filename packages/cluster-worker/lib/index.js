import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { INITIAL_RECONNECT_BACKOFF_MS, MAX_RECONNECT_BACKOFF_MS, parseClusterFrame, serializeClusterFrame } from "@deepseek-ai/dsh-cluster-protocol";
import os from "node:os";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
//#region src/client.ts
/** Worker-side reverse WebSocket tunnel client connecting to master. */
const resolveProxyAgent = (url, explicitProxy) => {
	const env = process.env;
	const proxyStr = explicitProxy ?? (url.startsWith("wss://") || url.startsWith("https://") ? env.https_proxy || env.HTTPS_PROXY || env.all_proxy || env.ALL_PROXY : env.http_proxy || env.HTTP_PROXY || env.all_proxy || env.ALL_PROXY);
	if (proxyStr && (proxyStr.startsWith("http://") || proxyStr.startsWith("https://"))) return new HttpsProxyAgent(proxyStr);
};
const createTunnelSocket = (url, explicitProxy) => {
	const agent = resolveProxyAgent(url, explicitProxy);
	if (agent) return new WebSocket(url, { agent });
	return new WebSocket(url);
};
/** Reverse WebSocket tunnel client running on worker nodes. */
var WorkerTunnelClient = class extends EventEmitter {
	config;
	socket;
	isRunning = false;
	isConnected = false;
	reconnectTimer;
	currentBackoffMs;
	maxBackoffMs;
	httpHandler;
	generations = /* @__PURE__ */ new Set();
	/**
	* @param config - Tunnel connection configuration.
	*/
	constructor(config) {
		super();
		this.config = config;
		this.currentBackoffMs = config.initialReconnectBackoffMs ?? INITIAL_RECONNECT_BACKOFF_MS;
		this.maxBackoffMs = config.maxReconnectBackoffMs ?? MAX_RECONNECT_BACKOFF_MS;
	}
	/**
	* Register the HTTP request dispatcher handler.
	* @param handler - Function invoked for incoming http:req frames.
	*/
	onRequest(handler) {
		this.httpHandler = handler;
	}
	/**
	* Establish connection to Master and perform hello handshake.
	* @returns Resolves once registration is acknowledged.
	*/
	start() {
		this.isRunning = true;
		return this.connect();
	}
	connect() {
		return new Promise((resolve, reject) => {
			let settled = false;
			try {
				this.socket = createTunnelSocket(this.config.masterUrl, this.config.proxyUrl);
			} catch (err) {
				if (this.config.autoReconnect !== false && this.isRunning) this.scheduleReconnect();
				return reject(err);
			}
			const socket = this.socket;
			const requests = /* @__PURE__ */ new Map();
			const pending = /* @__PURE__ */ new Set();
			let closedResolve;
			const generation = {
				socket,
				requests,
				pending,
				closed: new Promise((resolveClosed) => {
					closedResolve = resolveClosed;
				})
			};
			this.generations.add(generation);
			socket.addEventListener("open", () => {
				if (this.socket !== socket || !this.isRunning) return;
				const hello = {
					type: "control:hello",
					token: this.config.token,
					workerId: this.config.workerId,
					name: this.config.name,
					workspaces: this.config.workspaces,
					version: this.config.version ?? "0.2.2",
					timestamp: Date.now()
				};
				this.send(hello);
			});
			socket.addEventListener("message", (event) => {
				if (this.socket !== socket || !this.isRunning) return;
				const frame = parseClusterFrame(event.data);
				if (!frame) return;
				if (frame.type === "control:ready") {
					const ready = frame;
					if (!ready.accepted) {
						const err = /* @__PURE__ */ new Error(`Connection rejected by master: ${ready.reason ?? "unknown reason"}`);
						if (!settled) {
							settled = true;
							reject(err);
						} else this.emit("error", err);
						socket.close();
						return;
					}
					this.isConnected = true;
					this.currentBackoffMs = this.config.initialReconnectBackoffMs ?? INITIAL_RECONNECT_BACKOFF_MS;
					if (!settled) {
						settled = true;
						resolve();
					}
					this.emit("connected");
					return;
				}
				switch (frame.type) {
					case "ping": {
						const pong = {
							type: "pong",
							timestamp: Date.now()
						};
						this.send(pong);
						break;
					}
					case "http:cancel":
						requests.get(frame.reqId)?.abort();
						break;
					case "http:req": {
						const handler = this.httpHandler;
						if (handler) {
							const controller = new AbortController();
							requests.set(frame.reqId, controller);
							const task = (async () => {
								try {
									const result = await handler(frame, controller.signal);
									const resp = {
										type: "http:resp",
										reqId: frame.reqId,
										status: result.status,
										headers: result.headers,
										body: result.body
									};
									if (!controller.signal.aborted) this.send(resp);
								} catch (handlerErr) {
									const resp = {
										type: "http:resp",
										reqId: frame.reqId,
										status: 500,
										body: JSON.stringify({ error: String(handlerErr) })
									};
									if (!controller.signal.aborted) this.send(resp);
								} finally {
									if (requests.get(frame.reqId) === controller) requests.delete(frame.reqId);
								}
							})();
							pending.add(task);
							task.finally(() => pending.delete(task));
						} else {
							const resp = {
								type: "http:resp",
								reqId: frame.reqId,
								status: 404,
								body: JSON.stringify({ error: "No handler registered on worker" })
							};
							this.send(resp);
						}
						break;
					}
					default:
						this.emit("frame", frame);
						break;
				}
			});
			socket.addEventListener("close", (event) => {
				closedResolve();
				for (const controller of requests.values()) controller.abort();
				Promise.all([...pending]).then(() => this.generations.delete(generation));
				if (!settled) {
					settled = true;
					const reasonMsg = event.reason ? `: ${event.reason}` : "";
					reject(/* @__PURE__ */ new Error(`Socket closed before registration ready (code: ${event.code ?? 1006}${reasonMsg})`));
				}
				if (this.socket !== socket) return;
				const wasConnected = this.isConnected;
				this.isConnected = false;
				if (wasConnected) this.emit("disconnected", {
					code: event.code,
					reason: event.reason
				});
				if (this.isRunning && this.config.autoReconnect !== false) this.scheduleReconnect();
			});
			socket.addEventListener("error", (event) => {
				if (this.socket !== socket) return;
				const err = event.error instanceof Error ? event.error : new Error(typeof event.message === "string" ? event.message : "WebSocket connection error");
				if (!settled) {
					settled = true;
					reject(err);
				} else this.emit("error", err);
			});
		});
	}
	scheduleReconnect() {
		if (this.reconnectTimer || !this.isRunning) return;
		const delay = this.currentBackoffMs;
		this.currentBackoffMs = Math.min(this.currentBackoffMs * 1.5, this.maxBackoffMs);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = void 0;
			if (this.isRunning) this.connect().catch(() => {});
		}, delay);
	}
	/**
	* Send a typed cluster frame to Master.
	* @param frame - Frame to encode and send.
	*/
	send(frame) {
		if (this.socket && this.socket.readyState === 1) this.socket.send(serializeClusterFrame(frame));
	}
	/**
	* Gracefully stop the client and close connection.
	*/
	async stop() {
		this.isRunning = false;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = void 0;
		}
		this.socket = void 0;
		this.isConnected = false;
		const generations = [...this.generations];
		for (const generation of generations) {
			for (const controller of generation.requests.values()) controller.abort();
			if (generation.socket.readyState < 2) generation.socket.close(1e3, "Worker shutting down");
		}
		await Promise.all(generations.map(async (generation) => {
			await Promise.all([generation.closed, ...generation.pending]);
			this.generations.delete(generation);
		}));
	}
	/**
	* Check if client is currently authenticated and connected.
	* @returns True if connected.
	*/
	get connected() {
		return this.isConnected;
	}
};
//#endregion
//#region src/stream-dispatcher.ts
/** Asynchronous FIFO queue providing an AsyncIterable interface for stream uplinks. */
var AsyncQueue = class {
	items = [];
	waiters = [];
	ended = false;
	/**
	* Push an item into the queue.
	* @param item - Value to enqueue.
	*/
	push(item) {
		if (this.ended) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter({
			value: item,
			done: false
		});
		else this.items.push(item);
	}
	/** Close the queue to further pushes. */
	end() {
		if (this.ended) return;
		this.ended = true;
		while (this.waiters.length > 0) this.waiters.shift()?.({
			value: void 0,
			done: true
		});
	}
	/**
	* Asynchronous iterator consuming enqueued items.
	* @returns AsyncIterator of items.
	*/
	async *[Symbol.asyncIterator]() {
		while (true) if (this.items.length > 0) yield this.items.shift();
		else if (this.ended) return;
		else {
			const result = await new Promise((resolve) => {
				this.waiters.push(resolve);
			});
			if (result.done) return;
			yield result.value;
		}
	}
};
/** Manages active streams on the worker side requested through the reverse tunnel. */
var WorkerStreamDispatcher = class {
	opener;
	sendFrame;
	activeStreams = /* @__PURE__ */ new Map();
	/**
	* @param opener - Local stream execution function.
	* @param sendFrame - Sender delivering frames back to Master.
	*/
	constructor(opener, sendFrame) {
		this.opener = opener;
		this.sendFrame = sendFrame;
	}
	/**
	* Handle an incoming cluster frame related to streams.
	* @param frame - Tunnel frame.
	*/
	async handleFrame(frame) {
		switch (frame.type) {
			case "stream:open":
				await this.handleOpen(frame);
				break;
			case "stream:uplink":
				this.handleUplink(frame);
				break;
			case "stream:close":
				this.handleClose(frame);
				break;
			default: break;
		}
	}
	async handleOpen(frame) {
		const streamId = frame.streamId;
		const controller = new AbortController();
		const uplinkQueue = new AsyncQueue();
		this.activeStreams.set(streamId, {
			controller,
			uplinkQueue
		});
		try {
			const downlink = await this.opener(frame.endpoint, frame.payload, uplinkQueue, controller.signal);
			for await (const item of downlink) {
				if (controller.signal.aborted) break;
				const itemFrame = {
					type: "stream:item",
					streamId,
					value: item
				};
				this.sendFrame(itemFrame);
			}
			if (!controller.signal.aborted) {
				const closeFrame = {
					type: "stream:close",
					streamId,
					reason: "completed"
				};
				this.sendFrame(closeFrame);
			}
		} catch (err) {
			if (!controller.signal.aborted) {
				const closeFrame = {
					type: "stream:close",
					streamId,
					reason: "error",
					error: {
						code: "stream/execution-failure",
						message: err instanceof Error ? err.message : String(err),
						details: {}
					}
				};
				this.sendFrame(closeFrame);
			}
		} finally {
			this.activeStreams.delete(streamId);
			uplinkQueue.end();
		}
	}
	handleUplink(frame) {
		const stream = this.activeStreams.get(frame.streamId);
		if (stream) stream.uplinkQueue.push(frame.item);
	}
	handleClose(frame) {
		const stream = this.activeStreams.get(frame.streamId);
		if (stream) {
			stream.controller.abort(frame.reason);
			stream.uplinkQueue.end();
			this.activeStreams.delete(frame.streamId);
		}
	}
	/** Abort and clean up all active streams (e.g. on disconnect). */
	close() {
		for (const [id, stream] of this.activeStreams.entries()) {
			stream.controller.abort("Worker stream dispatcher closed");
			stream.uplinkQueue.end();
			this.activeStreams.delete(id);
		}
	}
};
//#endregion
//#region src/plugin.ts
/** Cordis service running on Worker nodes, connecting outbound to Master. */
const DEFAULT_OWNER_PRINCIPAL = { kind: "owner" };
/** Cluster Worker Cordis service managing outbound reverse connection to Master. */
var ClusterWorkerService = class extends Service {
	static inject = ["typertGateway"];
	static Config = z.object({
		masterUrl: z.string().default(process.env.DSH_CLUSTER_MASTER_URL ?? "ws://127.0.0.1:8080/api/worker/connect"),
		authToken: z.string().default(process.env.DSH_CLUSTER_AUTH_TOKEN ?? "default-cluster-token"),
		workerId: z.string().default(process.env.DSH_CLUSTER_WORKER_ID ?? `worker-${os.hostname()}`),
		name: z.string().default(process.env.DSH_CLUSTER_WORKER_NAME ?? os.hostname()),
		workspaces: z.array(z.string()).default([process.cwd()]),
		autoReconnect: z.boolean().default(true)
	});
	client;
	dispatcher;
	/**
	* @param ctx - Host context carrying typertGateway.
	* @param config - Worker settings.
	*/
	constructor(ctx, config) {
		super(ctx, "clusterWorker");
		const workerId = config.workerId ?? `worker-${os.hostname()}`;
		this.client = new WorkerTunnelClient({
			masterUrl: config.masterUrl,
			token: config.authToken,
			workerId,
			name: config.name ?? os.hostname(),
			workspaces: config.workspaces ?? [process.cwd()],
			autoReconnect: config.autoReconnect
		});
		const existingConn = ctx.get("connection");
		if (existingConn) this.applyDisableTokenAuth(existingConn);
		this.ctx.inject(["connection"], (connCtx) => {
			const conn = connCtx.connection ?? connCtx.get("connection");
			this.applyDisableTokenAuth(conn);
		});
		const getOwnerPeer = () => {
			const connection = ctx.get("connection");
			if (connection?.browserPeer) return connection.browserPeer;
			return {
				id: "local-cluster-worker-peer",
				principal: DEFAULT_OWNER_PRINCIPAL,
				interactions: "answer",
				dispose: () => Promise.resolve()
			};
		};
		const typertGateway = ctx.get("typertGateway");
		this.dispatcher = new WorkerStreamDispatcher((endpoint, payload, uplink, signal) => {
			const peer = getOwnerPeer();
			return typertGateway.wireStream.open(endpoint, payload, uplink, peer, signal);
		}, (frame) => this.client.send(frame));
		this.client.on("frame", (frame) => {
			this.dispatcher.handleFrame(frame);
		});
		this.client.on("error", (err) => {
			console.warn("[cluster-worker] tunnel error:", err);
		});
		this.client.on("close", () => {
			console.log("[cluster-worker] tunnel disconnected from master");
		});
		this.client.onRequest(async (req, signal) => {
			if (req.path === "/plugins/events" || req.path.startsWith("/plugins/events?")) return {
				status: 204,
				headers: { "content-type": "text/plain; charset=utf-8" },
				body: ""
			};
			const connection = ctx.get("connection");
			if (req.path.startsWith("/api") && connection?.createSharedFetchHandler) {
				const fetchHandler = connection.createSharedFetchHandler("/api");
				const headers = {};
				if (req.headers) {
					for (const [k, v] of Object.entries(req.headers)) if (v !== void 0) headers[k] = v;
				}
				const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== void 0;
				const request = new Request(new URL(req.path, "http://dsh.internal"), {
					method: req.method,
					headers,
					signal,
					...hasBody ? { body: req.body } : {}
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
						body
					};
				}
			}
			const webServer = ctx.get("webServer");
			if (webServer?.port) try {
				const localUrl = `http://${webServer.host ?? "127.0.0.1"}:${webServer.port}${req.path}`;
				const headers = {};
				if (req.headers) {
					for (const [k, v] of Object.entries(req.headers)) if (v !== void 0 && k.toLowerCase() !== "host") headers[k] = v;
				}
				const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== void 0;
				const resp = await fetch(localUrl, {
					method: req.method,
					headers,
					signal: AbortSignal.any([signal, AbortSignal.timeout(1e4)]),
					...hasBody && req.body !== void 0 ? { body: req.body } : {}
				});
				const body = await resp.text();
				const respHeaders = {};
				resp.headers.forEach((v, k) => {
					respHeaders[k] = v;
				});
				return {
					status: resp.status,
					headers: respHeaders,
					body
				};
			} catch (fetchErr) {
				if (signal.aborted) throw fetchErr;
				console.error("[cluster-worker] failed to proxy HTTP to local webServer:", fetchErr);
			}
			if ("invoke" in typertGateway && typeof typertGateway.invoke === "function") try {
				const endpoint = req.path.replace(/^\/api\/?/, "");
				const payload = req.body ? JSON.parse(req.body) : {};
				const peer = getOwnerPeer();
				const result = await typertGateway.invoke({
					endpoint,
					payload,
					peer,
					signal
				});
				return {
					status: 200,
					headers: { "content-type": "application/json" },
					body: JSON.stringify(result)
				};
			} catch (err) {
				return {
					status: 500,
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ error: err?.message ?? String(err) })
				};
			}
			return {
				status: 404,
				body: JSON.stringify({ error: "Neither connection fetch handler nor typertGateway.invoke available on worker" })
			};
		});
		this.client.on("connected", () => {
			console.log(`[cluster-worker] connected to master: ${config.masterUrl}`);
		});
		this.client.on("disconnected", (detail) => {
			const extra = detail?.code ? ` (code: ${detail.code}${detail.reason ? `, reason: ${detail.reason}` : ""})` : "";
			console.log(`[cluster-worker] disconnected from master${extra}`);
		});
		this.client.start().catch((err) => {
			console.warn("[cluster-worker] initial connection attempt failed:", err);
		});
		this.ctx.effect(() => {
			return () => {
				return this.dispose();
			};
		}, "cluster-worker: teardown");
	}
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
		console.log("[cluster-worker] Worker local token authentication disabled (delegated to Master)");
	}
	/** Close local stream dispatcher and terminate tunnel client. */
	async dispose() {
		this.dispatcher.close();
		await this.client.stop();
	}
};
//#endregion
export { AsyncQueue, ClusterWorkerService, ClusterWorkerService as default, WorkerStreamDispatcher, WorkerTunnelClient };
