//#region lib/types/constants.js
/** Shared constants for cluster master-worker tunnel communication. */
/** Default WebSocket endpoint path for worker reverse connection. */
const DEFAULT_WORKER_TUNNEL_PATH = "/api/worker/connect";
/** Default interval between heartbeat ping frames in milliseconds. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15e3;
/** Maximum consecutive unanswered pings before connection is dropped. */
const MAX_MISSED_PONGS = 2;
/** Initial backoff duration for worker reconnect in milliseconds. */
const INITIAL_RECONNECT_BACKOFF_MS = 1e3;
/** Maximum backoff duration for worker reconnect in milliseconds. */
const MAX_RECONNECT_BACKOFF_MS = 3e4;
//#endregion
//#region lib/types/frames.js
/** Wire frames and type discriminators for cluster master-worker tunnel communication. */
/**
* Serialize a cluster frame to a JSON string.
* @param frame - Frame to encode.
* @returns JSON serialized string.
*/
function serializeClusterFrame(frame) {
	return JSON.stringify(frame);
}
/**
* Validate and parse a raw wire payload into a typed cluster frame.
* @param raw - Raw string or buffer from socket.
* @returns Parsed cluster frame, or undefined if malformed or unknown type.
*/
function parseClusterFrame(raw) {
	if (typeof raw !== "string") if (Buffer.isBuffer(raw)) raw = raw.toString("utf-8");
	else return;
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null) return;
	const candidate = parsed;
	if (typeof candidate.type !== "string") return;
	switch (candidate.type) {
		case "control:hello": {
			const f = parsed;
			if (typeof f.token === "string" && typeof f.workerId === "string" && typeof f.name === "string" && Array.isArray(f.workspaces) && typeof f.version === "string" && typeof f.timestamp === "number") return f;
			return;
		}
		case "control:ready": {
			const f = parsed;
			if (typeof f.accepted === "boolean" && typeof f.masterTime === "number") return f;
			return;
		}
		case "ping": {
			const f = parsed;
			if (typeof f.timestamp === "number") return f;
			return;
		}
		case "pong": {
			const f = parsed;
			if (typeof f.timestamp === "number") return f;
			return;
		}
		case "http:req": {
			const f = parsed;
			if (typeof f.reqId === "string" && typeof f.method === "string" && typeof f.path === "string") return f;
			return;
		}
		case "http:cancel": {
			const f = parsed;
			return typeof f.reqId === "string" ? f : void 0;
		}
		case "http:resp": {
			const f = parsed;
			if (typeof f.reqId === "string" && typeof f.status === "number") return f;
			return;
		}
		case "stream:open": {
			const f = parsed;
			if (typeof f.streamId === "string" && typeof f.endpoint === "string") return f;
			return;
		}
		case "stream:item": {
			const f = parsed;
			if (typeof f.streamId === "string" && "value" in f) return f;
			return;
		}
		case "stream:uplink": {
			const f = parsed;
			if (typeof f.streamId === "string" && "item" in f) return f;
			return;
		}
		case "stream:close": {
			const f = parsed;
			if (typeof f.streamId === "string") return f;
			return;
		}
		default: return;
	}
}
/**
* Determine if a frame is a control hello frame.
* @param frame - Candidate frame.
* @returns True if frame is control hello.
*/
function isControlHelloFrame(frame) {
	return frame.type === "control:hello";
}
/**
* Determine if a frame is a control ready frame.
* @param frame - Candidate frame.
* @returns True if frame is control ready.
*/
function isControlReadyFrame(frame) {
	return frame.type === "control:ready";
}
/**
* Determine if a frame is an HTTP request frame.
* @param frame - Candidate frame.
* @returns True if frame is HTTP request.
*/
function isHttpReqFrame(frame) {
	return frame.type === "http:req";
}
/**
* Determine if a frame is an HTTP response frame.
* @param frame - Candidate frame.
* @returns True if frame is HTTP response.
*/
function isHttpRespFrame(frame) {
	return frame.type === "http:resp";
}
//#endregion
export { DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_WORKER_TUNNEL_PATH, INITIAL_RECONNECT_BACKOFF_MS, MAX_MISSED_PONGS, MAX_RECONNECT_BACKOFF_MS, isControlHelloFrame, isControlReadyFrame, isHttpReqFrame, isHttpRespFrame, parseClusterFrame, serializeClusterFrame };
