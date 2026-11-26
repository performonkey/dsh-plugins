/** Shared constants for cluster master-worker tunnel communication. */
/** Default WebSocket endpoint path for worker reverse connection. */
export const DEFAULT_WORKER_TUNNEL_PATH = '/api/worker/connect';
/** Default interval between heartbeat ping frames in milliseconds. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
/** Maximum consecutive unanswered pings before connection is dropped. */
export const MAX_MISSED_PONGS = 2;
/** Initial backoff duration for worker reconnect in milliseconds. */
export const INITIAL_RECONNECT_BACKOFF_MS = 1_000;
/** Maximum backoff duration for worker reconnect in milliseconds. */
export const MAX_RECONNECT_BACKOFF_MS = 30_000;
//# sourceMappingURL=constants.js.map