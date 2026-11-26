/** Shared constants for cluster master-worker tunnel communication. */
/** Default WebSocket endpoint path for worker reverse connection. */
export declare const DEFAULT_WORKER_TUNNEL_PATH = "/api/worker/connect";
/** Default interval between heartbeat ping frames in milliseconds. */
export declare const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;
/** Maximum consecutive unanswered pings before connection is dropped. */
export declare const MAX_MISSED_PONGS = 2;
/** Initial backoff duration for worker reconnect in milliseconds. */
export declare const INITIAL_RECONNECT_BACKOFF_MS = 1000;
/** Maximum backoff duration for worker reconnect in milliseconds. */
export declare const MAX_RECONNECT_BACKOFF_MS = 30000;
//# sourceMappingURL=constants.d.ts.map