import { DEFAULT_WORKER_TUNNEL_PATH, parseClusterFrame } from "@deepseek-ai/dsh-cluster-protocol";
//#region src/basic-auth.ts
/** HTTP Basic Authentication verification using Web Crypto API. */
/**
* Constant-time string equality check using crypto.subtle.
* Prevents timing attacks on basic auth passwords.
* @param a - First string.
* @param b - Second string.
* @returns true if strings are identical.
*/
async function timingSafeEqual(a, b) {
	const encoder = new TextEncoder();
	const aBuf = encoder.encode(a);
	const bBuf = encoder.encode(b);
	if (aBuf.byteLength !== bBuf.byteLength) return false;
	const aHash = await crypto.subtle.digest("SHA-256", aBuf);
	const bHash = await crypto.subtle.digest("SHA-256", bBuf);
	const aView = new Uint8Array(aHash);
	const bView = new Uint8Array(bHash);
	let diff = 0;
	for (let i = 0; i < aView.length; i++) diff |= aView[i] ^ bView[i];
	return diff === 0;
}
/** Name of session cookie issued on successful basic auth. */
const AUTH_COOKIE_NAME = "dsh_auth";
/**
* Computes deterministic auth cookie token based on credentials and optional secret salt.
* @param user - Username.
* @param pass - Password.
* @param salt - Optional salt/token.
* @returns SHA-256 hex string.
*/
async function computeAuthCookieValue(user, pass, salt = "") {
	const data = new TextEncoder().encode(`${user}:${pass}:${salt}`);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function parseCookie(cookieHeader, name) {
	if (!cookieHeader) return void 0;
	const parts = cookieHeader.split(";");
	for (const part of parts) {
		const [k, ...v] = part.trim().split("=");
		if (k === name) return v.join("=");
	}
}
/**
* Checks whether the incoming request satisfies HTTP Basic Authentication or carries a valid auth cookie.
* @param request - Incoming HTTP request.
* @param expectedUser - Configured username.
* @param expectedPass - Configured password.
* @param salt - Salt for cookie generation (e.g. AUTH_TOKEN).
* @returns AuthResult indicating if authenticated and whether to issue a session cookie.
*/
async function verifyAuth(request, expectedUser, expectedPass, salt = "") {
	if (!expectedUser && !expectedPass) return {
		authenticated: true,
		shouldSetCookie: false
	};
	const expectedCookie = await computeAuthCookieValue(expectedUser ?? "", expectedPass ?? "", salt);
	const clientCookie = parseCookie(request.headers.get("Cookie"), AUTH_COOKIE_NAME);
	if (clientCookie && await timingSafeEqual(clientCookie, expectedCookie)) return {
		authenticated: true,
		shouldSetCookie: false
	};
	const authHeader = request.headers.get("Authorization");
	if (!authHeader || !authHeader.startsWith("Basic ")) return {
		authenticated: false,
		shouldSetCookie: false
	};
	const b64 = authHeader.slice(6).trim();
	let decoded;
	try {
		decoded = atob(b64);
	} catch {
		return {
			authenticated: false,
			shouldSetCookie: false
		};
	}
	const colonIdx = decoded.indexOf(":");
	if (colonIdx === -1) return {
		authenticated: false,
		shouldSetCookie: false
	};
	const user = decoded.slice(0, colonIdx);
	const pass = decoded.slice(colonIdx + 1);
	const userMatch = await timingSafeEqual(user, expectedUser ?? "");
	const passMatch = await timingSafeEqual(pass, expectedPass ?? "");
	if (userMatch && passMatch) return {
		authenticated: true,
		shouldSetCookie: true,
		cookieValue: expectedCookie
	};
	return {
		authenticated: false,
		shouldSetCookie: false
	};
}
/**
* Creates a standard 401 Unauthorized response with optional WWW-Authenticate header.
* @param realm - Authentication realm name.
* @param includeWwwAuthenticate - Whether to include the WWW-Authenticate header (default: true).
* @returns 401 HTTP Response.
*/
function unauthorizedResponse(realm = "DeepSeek Harness", includeWwwAuthenticate = true) {
	const headers = new Headers({ "content-type": "text/plain; charset=utf-8" });
	if (includeWwwAuthenticate) headers.set("www-authenticate", `Basic realm="${realm}"`);
	return new Response("401 Unauthorized - Authentication required\n", {
		status: 401,
		headers
	});
}
//#endregion
//#region src/durable-object.ts
/**
* Cloudflare Durable Object managing Worker reverse tunnel, browser WebSocket multiplexing,
* and HTTP RPC relay in pure memory (0 storage reads/writes).
*/
var RelayFailure = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
	}
};
function createWebSocketUpgradeResponse(webSocket) {
	try {
		return new Response(null, {
			status: 101,
			webSocket
		});
	} catch {
		return {
			status: 101,
			statusText: "Switching Protocols",
			headers: new Headers(),
			webSocket
		};
	}
}
/**
* Global singleton Durable Object instance running on Cloudflare's edge network.
*/
var ClusterMasterDO = class {
	ctx;
	env;
	workerWs;
	workerInfo;
	missedPongs = 0;
	heartbeatTimer = void 0;
	browserSockets = /* @__PURE__ */ new Set();
	streamToBrowser = /* @__PURE__ */ new Map();
	browserToStreams = /* @__PURE__ */ new Map();
	pendingHttpRequests = /* @__PURE__ */ new Map();
	/**
	* @param ctx - Durable Object state context.
	* @param env - Cloudflare worker environment variables.
	*/
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}
	/**
	* Main dispatch entry point for HTTP requests routed into this Durable Object.
	* @param request - Incoming fetch request.
	* @returns HTTP or WebSocket upgrade response.
	*/
	async fetch(request) {
		const pathname = new URL(request.url).pathname;
		if (pathname === DEFAULT_WORKER_TUNNEL_PATH || pathname === "/api/worker/connect") return this.handleWorkerConnect(request);
		if (pathname === "/api/remote.mux") return this.handleBrowserMux(request);
		if (pathname === "/api/cluster/status") return this.handleClusterStatus();
		if (this.workerWs && this.workerWs.readyState === 1) return this.handleHttpRequest(request);
		if (pathname.startsWith("/api")) return this.handleHttpRequest(request);
		return new Response("Not Found", { status: 404 });
	}
	/**
	* Returns current cluster connectivity and worker health.
	*/
	handleClusterStatus() {
		return new Response(JSON.stringify({
			status: this.workerWs ? "connected" : "waiting_for_worker",
			worker: this.workerInfo ?? null,
			activeBrowserSessions: this.browserSockets.size,
			activeStreams: this.streamToBrowser.size,
			timestamp: Date.now()
		}), {
			status: 200,
			headers: { "content-type": "application/json" }
		});
	}
	/**
	* Handles outbound reverse WebSocket tunnel from local worker.
	*/
	handleWorkerConnect(request) {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket upgrade", { status: 426 });
		const webSocketPair = new globalThis.WebSocketPair();
		const client = webSocketPair[0];
		const server = webSocketPair[1];
		server.accept();
		let isAuthenticated = false;
		const handshakeTimeout = setTimeout(() => {
			if (!isAuthenticated) try {
				server.close(4002, "Handshake timeout");
			} catch {}
		}, 1e4);
		server.addEventListener("message", (event) => {
			const frame = parseClusterFrame(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
			if (!frame) return;
			if (frame.type === "control:hello") {
				clearTimeout(handshakeTimeout);
				const hello = frame;
				const expectedToken = this.env.AUTH_TOKEN;
				if (expectedToken && hello.token !== expectedToken) {
					const rejectFrame = {
						type: "control:ready",
						accepted: false,
						reason: "Invalid cluster authentication token",
						masterTime: Date.now()
					};
					try {
						server.send(JSON.stringify(rejectFrame));
						server.close(4001, "Unauthorized");
					} catch {}
					return;
				}
				isAuthenticated = true;
				if (this.workerWs && this.workerWs !== server) {
					const previousWorker = this.workerWs;
					this.cleanupWorker();
					try {
						previousWorker.close(1e3, "Superseded by new worker connection");
					} catch {}
					for (const browser of this.browserSockets) try {
						browser.close(1012, "Worker superseded, reconnecting");
					} catch {}
					this.browserSockets.clear();
					this.streamToBrowser.clear();
					this.browserToStreams.clear();
				}
				this.workerWs = server;
				this.workerInfo = {
					id: hello.workerId,
					name: hello.name,
					workspaces: hello.workspaces,
					connectedAt: Date.now()
				};
				this.missedPongs = 0;
				const readyFrame = {
					type: "control:ready",
					accepted: true,
					masterTime: Date.now()
				};
				server.send(JSON.stringify(readyFrame));
				this.startHeartbeat();
				return;
			}
			if (!isAuthenticated) {
				try {
					server.close(4002, "Handshake required before message exchange");
				} catch {}
				return;
			}
			if (frame.type === "pong") {
				this.missedPongs = 0;
				return;
			}
			if (frame.type === "http:resp") {
				const respFrame = frame;
				const pending = this.pendingHttpRequests.get(respFrame.reqId);
				if (pending) {
					this.pendingHttpRequests.delete(respFrame.reqId);
					pending.resolve(respFrame);
				}
				return;
			}
			if (frame.type === "stream:item") {
				const itemFrame = frame;
				const targetBrowser = this.streamToBrowser.get(itemFrame.streamId);
				if (targetBrowser && targetBrowser.readyState === 1) try {
					targetBrowser.send(JSON.stringify({
						type: "item",
						streamId: itemFrame.streamId,
						value: itemFrame.value
					}));
				} catch {}
				return;
			}
			if (frame.type === "stream:close") {
				const closeFrame = frame;
				const targetBrowser = this.streamToBrowser.get(closeFrame.streamId);
				this.streamToBrowser.delete(closeFrame.streamId);
				if (targetBrowser && targetBrowser.readyState === 1) try {
					if (closeFrame.error) targetBrowser.send(JSON.stringify({
						type: "error",
						streamId: closeFrame.streamId,
						error: {
							code: closeFrame.error.code,
							message: closeFrame.error.message,
							details: closeFrame.error.details ?? {}
						}
					}));
					else targetBrowser.send(JSON.stringify({
						type: "end",
						streamId: closeFrame.streamId
					}));
				} catch {}
				return;
			}
		});
		server.addEventListener("close", () => {
			clearTimeout(handshakeTimeout);
			if (this.workerWs === server) this.cleanupWorker();
		});
		server.addEventListener("error", () => {
			clearTimeout(handshakeTimeout);
			if (this.workerWs === server) this.cleanupWorker();
		});
		return createWebSocketUpgradeResponse(client);
	}
	/**
	* Handles browser WebSocket connection to /api/remote.mux.
	*/
	handleBrowserMux(request) {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket upgrade", { status: 426 });
		if (!this.workerWs || this.workerWs.readyState !== 1) return new Response(JSON.stringify({ error: "No active worker connected to cluster master" }), {
			status: 503,
			headers: { "content-type": "application/json" }
		});
		const webSocketPair = new globalThis.WebSocketPair();
		const client = webSocketPair[0];
		const server = webSocketPair[1];
		server.accept();
		this.browserSockets.add(server);
		const ownedStreams = /* @__PURE__ */ new Set();
		this.browserToStreams.set(server, ownedStreams);
		server.addEventListener("message", (event) => {
			const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
			let msg;
			try {
				msg = JSON.parse(text);
			} catch {
				return;
			}
			if (!msg || typeof msg !== "object") return;
			if (msg.type === "open") {
				const streamId = msg.streamId;
				if (streamId) {
					ownedStreams.add(streamId);
					this.streamToBrowser.set(streamId, server);
					const openFrame = {
						type: "stream:open",
						streamId,
						endpoint: msg.endpoint ?? "",
						payload: msg.payload
					};
					this.sendToWorker(openFrame);
				}
				return;
			}
			if (msg.type === "item") {
				const streamId = msg.streamId;
				if (streamId) {
					const uplinkFrame = {
						type: "stream:uplink",
						streamId,
						item: msg.value ?? msg.item
					};
					this.sendToWorker(uplinkFrame);
				}
				return;
			}
			if (msg.type === "cancel" || msg.type === "close") {
				const streamId = msg.streamId;
				if (streamId) {
					ownedStreams.delete(streamId);
					this.streamToBrowser.delete(streamId);
					const closeFrame = {
						type: "stream:close",
						streamId,
						error: {
							code: "stream/cancelled",
							message: "Stream cancelled by client"
						}
					};
					this.sendToWorker(closeFrame);
				}
			}
		});
		const onBrowserClose = () => {
			this.browserSockets.delete(server);
			this.browserToStreams.delete(server);
			for (const streamId of ownedStreams) {
				this.streamToBrowser.delete(streamId);
				const closeFrame = {
					type: "stream:close",
					streamId,
					error: {
						code: "stream/cancelled",
						message: "Browser disconnected"
					}
				};
				this.sendToWorker(closeFrame);
			}
			ownedStreams.clear();
		};
		server.addEventListener("close", onBrowserClose);
		server.addEventListener("error", onBrowserClose);
		return createWebSocketUpgradeResponse(client);
	}
	/**
	* Transparently proxies an incoming HTTP request (e.g. POST /api/*) to the connected worker.
	*/
	async handleHttpRequest(request) {
		if (!this.workerWs || this.workerWs.readyState !== 1) return new Response(JSON.stringify({ error: "No active worker connected to cluster master" }), {
			status: 503,
			headers: { "content-type": "application/json" }
		});
		const url = new URL(request.url);
		const reqId = crypto.randomUUID();
		let body;
		if (request.method !== "GET" && request.method !== "HEAD") body = await request.text();
		const headers = {};
		request.headers.forEach((val, key) => {
			headers[key] = val;
		});
		const reqFrame = {
			type: "http:req",
			reqId,
			method: request.method,
			path: url.pathname + url.search,
			headers,
			body: body && body.length > 0 ? body : void 0
		};
		try {
			const resp = await new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					this.pendingHttpRequests.delete(reqId);
					this.sendToWorker({
						type: "http:cancel",
						reqId
					});
					reject(new RelayFailure("gateway/timeout", "Gateway timeout waiting for worker response"));
				}, 6e4);
				const onAbandon = () => {
					if (!this.pendingHttpRequests.has(reqId)) return;
					this.pendingHttpRequests.delete(reqId);
					clearTimeout(timer);
					this.sendToWorker({
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
				if (request.signal.aborted) onAbandon();
				else request.signal.addEventListener("abort", onAbandon, { once: true });
				this.pendingHttpRequests.set(reqId, {
					resolve: (val) => {
						request.signal.removeEventListener("abort", onAbandon);
						clearTimeout(timer);
						resolve(val);
					},
					reject: (err) => {
						request.signal.removeEventListener("abort", onAbandon);
						clearTimeout(timer);
						reject(err);
					},
					timer
				});
				this.sendToWorker(reqFrame);
			});
			const respHeaders = new Headers();
			if (resp.headers) {
				for (const [k, v] of Object.entries(resp.headers)) if (v !== void 0) respHeaders.set(k, v);
			}
			return new Response(resp.body ?? null, {
				status: resp.status,
				headers: respHeaders
			});
		} catch (err) {
			if (!(err instanceof RelayFailure)) throw err;
			return new Response(JSON.stringify({
				error: err.message,
				code: err.code
			}), {
				status: err.code === "gateway/timeout" ? 504 : 503,
				headers: { "content-type": "application/json" }
			});
		}
	}
	/**
	* Starts periodic heartbeat pings to detect worker liveness.
	*/
	startHeartbeat() {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = setInterval(() => {
			if (!this.workerWs || this.workerWs.readyState !== 1) {
				this.cleanupWorker();
				return;
			}
			this.missedPongs++;
			if (this.missedPongs > 4) {
				try {
					this.workerWs.close(4e3, "Heartbeat timeout");
				} catch {}
				this.cleanupWorker();
				return;
			}
			const ping = {
				type: "ping",
				timestamp: Date.now()
			};
			this.sendToWorker(ping);
		}, 15e3);
	}
	/**
	* Sends a typed cluster frame to the active worker.
	*/
	sendToWorker(frame) {
		if (this.workerWs && this.workerWs.readyState === 1) try {
			this.workerWs.send(JSON.stringify(frame));
		} catch {}
	}
	/**
	* Cleans up worker connection state upon disconnection.
	*/
	cleanupWorker() {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = void 0;
		}
		for (const reqId of this.pendingHttpRequests.keys()) this.sendToWorker({
			type: "http:cancel",
			reqId
		});
		this.workerWs = void 0;
		this.workerInfo = void 0;
		this.missedPongs = 0;
		for (const pending of this.pendingHttpRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(new RelayFailure("gateway/worker-disconnected", "Worker disconnected"));
		}
		this.pendingHttpRequests.clear();
		for (const browser of this.browserSockets) try {
			browser.close(1012, "Worker disconnected, reconnecting");
		} catch {}
		this.browserSockets.clear();
		this.streamToBrowser.clear();
		this.browserToStreams.clear();
	}
};
//#endregion
//#region src/index.ts
/**
* Cloudflare Worker entrypoint routing traffic between Cloudflare Edge,
* Workers Static Assets, and the ClusterMasterDO Durable Object.
*/
/**
* Main Cloudflare Worker request handler.
*/
var src_default = { async fetch(request, env, _ctx) {
	const url = new URL(request.url);
	const pathname = url.pathname;
	if (pathname === "/api/worker/connect") {
		const doId = env.CLUSTER_MASTER_DO.idFromName("global-master");
		return env.CLUSTER_MASTER_DO.get(doId).fetch(request);
	}
	if ((pathname.startsWith("/assets/") || pathname === "/favicon.ico" || pathname === "/favicon.svg" || pathname === "/favicon-dark.svg" || pathname === "/apple-touch-icon.png" || pathname === "/manifest.webmanifest" || pathname === "/preview.html") && env.ASSETS) try {
		const assetResp = await env.ASSETS.fetch(request);
		if (assetResp.status !== 404) return assetResp;
	} catch {}
	const authResult = await verifyAuth(request, env.BASIC_AUTH_USER, env.BASIC_AUTH_PASS, env.AUTH_TOKEN);
	if (!authResult.authenticated) return unauthorizedResponse("DeepSeek Harness", pathname === "/" || pathname === "/index.html");
	const withAuthCookie = (resp) => {
		if (!authResult.shouldSetCookie || !authResult.cookieValue) return resp;
		const newHeaders = new Headers(resp.headers);
		newHeaders.append("Set-Cookie", `${AUTH_COOKIE_NAME}=${authResult.cookieValue}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
		return new Response(resp.body, {
			status: resp.status,
			statusText: resp.statusText,
			headers: newHeaders,
			webSocket: resp.webSocket
		});
	};
	if (pathname.startsWith("/api") || pathname.startsWith("/plugins") || pathname.startsWith("/modules") || pathname === "/" || pathname === "/index.html") {
		const doId = env.CLUSTER_MASTER_DO.idFromName("global-master");
		const doResp = await env.CLUSTER_MASTER_DO.get(doId).fetch(request);
		if (doResp.status !== 404 && doResp.status !== 503) return withAuthCookie(doResp);
		if (pathname === "/" || pathname === "/index.html") return withAuthCookie(new Response(renderWelcomeHtml(url.origin), {
			status: 200,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store"
			}
		}));
		return withAuthCookie(doResp);
	}
	if (env.ASSETS) try {
		const assetResp = await env.ASSETS.fetch(request);
		if (assetResp.status !== 404) return withAuthCookie(assetResp);
	} catch {}
	return new Response("Not Found", { status: 404 });
} };
function renderWelcomeHtml(origin) {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DeepSeek Harness — Cloudflare Master</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1117; color: #e6edf3; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px; max-width: 560px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
    h1 { margin-top: 0; font-size: 22px; color: #58a6ff; display: flex; align-items: center; gap: 8px; }
    p { color: #8b949e; line-height: 1.6; }
    code { background: #0d1117; padding: 3px 6px; border-radius: 4px; font-size: 13px; color: #7ee787; }
    pre { background: #0d1117; padding: 14px; border-radius: 6px; overflow-x: auto; font-size: 13px; color: #c9d1d9; border: 1px solid #21262d; }
    .status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 500; background: #238636; color: #fff; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="status-badge">● Cloudflare Master Active</div>
    <h1>DeepSeek Harness Cluster Master</h1>
    <p>This Cloudflare Worker & Durable Object instance is ready to coordinate your distributed DSH cluster.</p>
    
    <p><strong>Connect your local worker:</strong></p>
    <pre>DSH_CLUSTER_MASTER_URL="wss://${new URL(origin).host}/api/worker/connect" \\
DSH_CLUSTER_AUTH_TOKEN="&lt;your-token&gt;" \\
dsh --profile web --patch packages/experimental/cluster-worker/cordis.patch.yml</pre>

    <p style="margin-top: 24px; font-size: 12px; color: #6e7681;">
      Check worker status: <code>/api/cluster/status</code>
    </p>
  </div>
</body>
</html>`;
}
//#endregion
export { ClusterMasterDO, src_default as default };
