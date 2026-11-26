/**
 * Cloudflare Worker entrypoint routing traffic between Cloudflare Edge,
 * Workers Static Assets, and the ClusterMasterDO Durable Object.
 */
import { ClusterMasterDO } from './durable-object.ts';
import type { Env } from './types.ts';
export { ClusterMasterDO };
/**
 * Main Cloudflare Worker request handler.
 */
declare const _default: {
    fetch(request: Request, env: Env, _ctx?: unknown): Promise<Response>;
};
export default _default;
//# sourceMappingURL=index.d.ts.map