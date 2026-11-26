/**
 * Cloudflare Worker entrypoint routing traffic between Cloudflare Edge,
 * Workers Static Assets, and the ClusterMasterDO Durable Object.
 */

import {
  AUTH_COOKIE_NAME,
  unauthorizedResponse,
  verifyAuth,
} from './basic-auth.ts'
import { ClusterMasterDO } from './durable-object.ts'
import type { Env } from './types.ts'

export { ClusterMasterDO }

/**
 * Main Cloudflare Worker request handler.
 */
export default {
  async fetch(request: Request, env: Env, _ctx?: unknown): Promise<Response> {
    const url = new URL(request.url)
    const pathname = url.pathname

    // 1. Worker reverse tunnel endpoint: exempt from Basic Auth (authenticated via cluster handshake token)
    if (pathname === '/api/worker/connect') {
      const doId = env.CLUSTER_MASTER_DO.idFromName('global-master')
      const stub = env.CLUSTER_MASTER_DO.get(doId)
      return stub.fetch(request)
    }

    // 2. Public static assets (JS/CSS/Fonts/Icons/Preloads) from apps/web/dist
    // Exempt from Basic Auth to prevent browser stripping credentials on crossorigin="anonymous" subrequests
    const isPublicStatic =
      pathname.startsWith('/assets/') ||
      pathname === '/favicon.ico' ||
      pathname === '/favicon.svg' ||
      pathname === '/favicon-dark.svg' ||
      pathname === '/apple-touch-icon.png' ||
      pathname === '/manifest.webmanifest' ||
      pathname === '/preview.html'

    if (isPublicStatic && env.ASSETS) {
      try {
        const assetResp = await env.ASSETS.fetch(request)
        if (assetResp.status !== 404) {
          return assetResp
        }
      } catch {}
    }

    // 3. Authenticate UI and API access (checks Cookie first, then Basic Auth)
    const cookieHeader = request.headers.get('Cookie') ?? ''
    const hasDshAuthCookie = cookieHeader.includes('dsh-auth-')
    const hasTokenQuery = pathname === '/' && url.searchParams.has('token')

    let authResult: import('./basic-auth.ts').AuthResult
    if (hasDshAuthCookie || hasTokenQuery) {
      authResult = { authenticated: true, shouldSetCookie: false }
    } else {
      authResult = await verifyAuth(
        request,
        env.BASIC_AUTH_USER,
        env.BASIC_AUTH_PASS,
        env.AUTH_TOKEN,
      )
    }

    if (!authResult.authenticated) {
      // Only attach WWW-Authenticate: Basic on top-level page navigation (GET /)
      // On background fetch/subrequests, omit header so browser doesn't clear credentials or pop up modal
      const isTopLevelNavigation = pathname === '/' || pathname === '/index.html'
      return unauthorizedResponse('DeepSeek Harness', isTopLevelNavigation)
    }

    const withAuthCookie = (resp: Response): Response => {
      if (!authResult.shouldSetCookie || !authResult.cookieValue) {
        return resp
      }
      const newHeaders = new Headers(resp.headers)
      newHeaders.append(
        'Set-Cookie',
        `${AUTH_COOKIE_NAME}=${authResult.cookieValue}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
      )
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: newHeaders,
        webSocket: (resp as any).webSocket,
      } as any)
    }

    // 4. Dynamic /api endpoints, /plugins/* bundles, and dynamic root HTML -> route to Durable Object
    if (
      pathname.startsWith('/api') ||
      pathname.startsWith('/plugins') ||
      pathname.startsWith('/modules') ||
      pathname === '/' ||
      pathname === '/index.html'
    ) {
      const doId = env.CLUSTER_MASTER_DO.idFromName('global-master')
      const stub = env.CLUSTER_MASTER_DO.get(doId)
      const doResp = await stub.fetch(request)
      if (doResp.status !== 404 && doResp.status !== 503) {
        return withAuthCookie(doResp)
      }
      // If no worker is connected and root path was requested, show landing guide
      if (pathname === '/' || pathname === '/index.html') {
        return withAuthCookie(
          new Response(renderWelcomeHtml(url.origin), {
            status: 200,
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
            },
          }),
        )
      }
      return withAuthCookie(doResp)
    }

    // 5. Remaining static assets if configured with Workers Static Assets
    if (env.ASSETS) {
      try {
        const assetResp = await env.ASSETS.fetch(request)
        if (assetResp.status !== 404) {
          return withAuthCookie(assetResp)
        }
      } catch {}
    }

    return new Response('Not Found', { status: 404 })
  },
}

function renderWelcomeHtml(origin: string): string {
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
</html>`
}
