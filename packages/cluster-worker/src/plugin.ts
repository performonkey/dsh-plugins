/** Cordis service running on Worker nodes, connecting outbound to Master. */

import os from 'node:os'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { WorkerId } from '@deepseek-ai/dsh-cluster-protocol'
import { WorkerTunnelClient } from './client.ts'
import { WorkerStreamDispatcher } from './stream-dispatcher.ts'

export interface Principal {
  readonly kind: 'owner' | string
}

export interface PeerScope {
  readonly id: string
  readonly principal: Principal
  readonly interactions?: string
  dispose(): Promise<void>
}

export interface Config {
  /** Master WebSocket tunnel endpoint (e.g. ws://master.example.com/api/worker/connect). */
  readonly masterUrl: string
  /** Pre-shared secret token for authenticating with master. */
  readonly authToken: string
  /** Stable worker node identifier. */
  readonly workerId?: string
  /** Human-readable display label for this node. */
  readonly name?: string
  /** Workspaces served by this worker. Defaults to [process.cwd()]. */
  readonly workspaces?: string[]
  /** Whether to automatically reconnect when tunnel drops. */
  readonly autoReconnect?: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cluster Worker service instance. */
    clusterWorker: ClusterWorkerService
  }
}

const DEFAULT_OWNER_PRINCIPAL: Principal = { kind: 'owner' }

/** Cluster Worker Cordis service managing outbound reverse connection to Master. */
export class ClusterWorkerService extends Service {
  static inject = ['typertGateway']
  static Config: z<Config> = z.object({
    masterUrl: z.string().default(process.env.DSH_CLUSTER_MASTER_URL ?? 'ws://127.0.0.1:8080/api/worker/connect'),
    authToken: z.string().default(process.env.DSH_CLUSTER_AUTH_TOKEN ?? 'default-cluster-token'),
    workerId: z.string().default(process.env.DSH_CLUSTER_WORKER_ID ?? `worker-${os.hostname()}`),
    name: z.string().default(process.env.DSH_CLUSTER_WORKER_NAME ?? os.hostname()),
    workspaces: z.array(z.string()).default([process.cwd()]),
    autoReconnect: z.boolean().default(true),
  })

  readonly client: WorkerTunnelClient
  readonly dispatcher: WorkerStreamDispatcher

  /**
   * @param ctx - Host context carrying typertGateway.
   * @param config - Worker settings.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'clusterWorker')

    const workerId = (config.workerId ?? `worker-${os.hostname()}`) as WorkerId
    this.client = new WorkerTunnelClient({
      masterUrl: config.masterUrl,
      token: config.authToken,
      workerId,
      name: config.name ?? os.hostname(),
      workspaces: config.workspaces ?? [process.cwd()],
      autoReconnect: config.autoReconnect,
    })

    // Disable local token authentication on worker so master tunnel requests are admitted
    const existingConn = ctx.get('connection')
    if (existingConn) {
      this.applyDisableTokenAuth(existingConn)
    }
    this.ctx.inject(['connection'], connCtx => {
      const conn = (connCtx as Context & { connection?: unknown }).connection ?? connCtx.get('connection')
      this.applyDisableTokenAuth(conn)
    })

    const getOwnerPeer = (): PeerScope => {
      const connection = ctx.get('connection') as { browserPeer?: PeerScope } | undefined
      if (connection?.browserPeer) {
        return connection.browserPeer
      }
      return {
        id: 'local-cluster-worker-peer' as PeerScope['id'],
        principal: DEFAULT_OWNER_PRINCIPAL,
        interactions: 'answer',
        dispose: () => Promise.resolve(),
      }
    }

    const typertGateway = ctx.get('typertGateway') as {
      wireStream: {
        open: (endpoint: string, payload: unknown, uplink: AsyncIterable<unknown>, peer: PeerScope, signal: AbortSignal) => Promise<AsyncIterable<unknown>>
      }
    }

    this.dispatcher = new WorkerStreamDispatcher(
      (endpoint, payload, uplink, signal) => {
        const peer = getOwnerPeer()
        return typertGateway.wireStream.open(endpoint, payload, uplink, peer, signal)
      },
      frame => this.client.send(frame),
    )

    this.client.on('frame', frame => {
      void this.dispatcher.handleFrame(frame)
    })

    this.client.on('error', err => {
      console.warn('[cluster-worker] tunnel error:', err)
    })

    this.client.on('close', () => {
      console.log('[cluster-worker] tunnel disconnected from master')
    })

    // Hook HTTP request dispatching
    this.client.onRequest(async (req, signal) => {
      // Short-circuit SSE events from client-hmr (which never terminates and causes proxy timeouts)
      if (req.path === '/plugins/events' || req.path.startsWith('/plugins/events?')) {
        return {
          status: 204,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: '',
        }
      }

      const connection = ctx.get('connection') as {
        createSharedFetchHandler?: (channel: string) => {
          fetch: (request: Request, peer: PeerScope) => Promise<Response>
        }
        browserPeer?: PeerScope
      } | undefined

      if (req.path.startsWith('/api') && connection?.createSharedFetchHandler) {
        const fetchHandler = connection.createSharedFetchHandler('/api')
        const headers: Record<string, string> = {}
        if (req.headers) {
          for (const [k, v] of Object.entries(req.headers)) {
            if (v !== undefined) headers[k] = v
          }
        }
        const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined
        const request = new Request(new URL(req.path, 'http://dsh.internal'), {
          method: req.method,
          headers,
          signal,
          ...(hasBody ? { body: req.body } : {}),
        })
        const peer = getOwnerPeer()
        const response = await fetchHandler.fetch(request, peer)
        if (response.status !== 404) {
          const body = await response.text()
          const respHeaders: Record<string, string> = {}
          response.headers.forEach((v, k) => {
            respHeaders[k] = v
          })
          return {
            status: response.status,
            headers: respHeaders,
            body,
          }
        }
      }

      // If path is not /api or not handled, forward to local webServer (serves dynamic HTML injections & modules)
      const webServer = ctx.get('webServer') as { host?: string; port?: number } | undefined
      if (webServer?.port) {
        try {
          const localUrl = `http://${webServer.host ?? '127.0.0.1'}:${webServer.port}${req.path}`
          const headers: Record<string, string> = {}
          if (req.headers) {
            for (const [k, v] of Object.entries(req.headers)) {
              if (v !== undefined && k.toLowerCase() !== 'host') {
                headers[k] = v
              }
            }
          }
          const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined
          const resp = await fetch(localUrl, {
            method: req.method,
            headers,
            redirect: 'manual',
            signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
            ...(hasBody && req.body !== undefined ? { body: req.body } : {}),
          })
          const body = await resp.text()
          const respHeaders: Record<string, string> = {}
          resp.headers.forEach((v, k) => {
            respHeaders[k] = v
          })
          const cookies = typeof (resp.headers as any).getSetCookie === 'function'
            ? (resp.headers as any).getSetCookie()
            : undefined
          return {
            status: resp.status,
            headers: respHeaders,
            cookies: cookies && cookies.length > 0 ? cookies : undefined,
            body,
          }
        } catch (fetchErr) {
          if (signal.aborted) throw fetchErr
          console.error('[cluster-worker] failed to proxy HTTP to local webServer:', fetchErr)
        }
      }

      if ('invoke' in typertGateway && typeof (typertGateway as any).invoke === 'function') {
        try {
          const endpoint = req.path.replace(/^\/api\/?/, '')
          const payload = req.body ? JSON.parse(req.body) : {}
          const peer = getOwnerPeer()
          const result = await (typertGateway as any).invoke({
            endpoint,
            payload,
            peer,
            signal,
          })
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(result),
          }
        } catch (err: any) {
          return {
            status: 500,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ error: err?.message ?? String(err) }),
          }
        }
      }

      return {
        status: 404,
        body: JSON.stringify({ error: 'Neither connection fetch handler nor typertGateway.invoke available on worker' }),
      }
    })

    let lastPrintedBannerToken: string | undefined
    const printAccessBanner = (token?: string) => {
      const resolvedToken = token ?? extractToken(ctx)
      if (resolvedToken && resolvedToken === lastPrintedBannerToken) return
      if (resolvedToken) lastPrintedBannerToken = resolvedToken

      let masterOrigin = config.masterUrl
      try {
        const httpUrl = config.masterUrl.startsWith('wss:')
          ? config.masterUrl.replace(/^wss:/, 'https:')
          : config.masterUrl.replace(/^ws:/, 'http:')
        masterOrigin = new URL(httpUrl).origin
      } catch {}

      console.log('')
      console.log('='.repeat(72))
      console.log(`[cluster-worker] Connected to Master : ${config.masterUrl}`)
      if (resolvedToken) {
        console.log(`[cluster-worker] Web Access URL    : ${masterOrigin}/?token=${resolvedToken}`)
        console.log(`[cluster-worker] Login Token       : ${resolvedToken}`)
      } else {
        console.log(`[cluster-worker] Web Master URL    : ${masterOrigin}`)
      }
      console.log('='.repeat(72))
      console.log('')
    }

    // Start outbound connection
    this.client.on('connected', () => {
      lastPrintedBannerToken = undefined
      const token = extractToken(ctx)
      if (token) {
        printAccessBanner(token)
      } else {
        setTimeout(() => printAccessBanner(), 500)
        setTimeout(() => printAccessBanner(), 2000)
      }
    })
    ctx.on('webserver/entry-url', (_baseUrl, entries) => {
      queueMicrotask(() => {
        for (const entry of entries) {
          try {
            const token = new URL(entry.url).searchParams.get('token')
            if (token) {
              printAccessBanner(token)
              break
            }
          } catch {}
        }
      })
    })
    this.client.on('disconnected', (detail?: { code?: number; reason?: string }) => {
      const extra = detail?.code ? ` (code: ${detail.code}${detail.reason ? `, reason: ${detail.reason}` : ''})` : ''
      console.log(`[cluster-worker] disconnected from master${extra}`)
    })

    void this.client.start().catch((err: unknown) => {
      console.warn('[cluster-worker] initial connection attempt failed:', err)
    })

    this.ctx.effect(() => {
      return () => {
        return this.dispose()
      }
    }, 'cluster-worker: teardown')
  }

  private applyDisableTokenAuth(connection: any): void {
    if (!connection) return
    connection.authorizeIndex = () => true
    connection.admit = () => {
      if (connection.disposed) return { rejection: 401 }
      return { peer: connection.browserPeer }
    }
    connection.admitConnection = () => {
      if (connection.disposed) return { rejection: 401 }
      return { peer: connection.browserPeer, release: () => Promise.resolve() }
    }
    connection.requestRejection = () => undefined
    connection.authenticatedUrl = (baseUrl: string) => baseUrl
    console.log('[cluster-worker] Worker local token authentication disabled (delegated to Master)')
  }

  /** Close local stream dispatcher and terminate tunnel client. */
  async dispose(): Promise<void> {
    this.dispatcher.close()
    await this.client.stop()
  }
}

function extractToken(ctx: Context): string | undefined {
  const entries: { label: string; url: string; open?: boolean }[] = []
  try {
    const webServer = ctx.get('webServer') as any
    if (webServer) {
      ctx.emit(webServer, 'webserver/entry-url', 'http://127.0.0.1:3080/', entries)
    } else {
      ctx.emit('webserver/entry-url', 'http://127.0.0.1:3080/', entries)
    }
    for (const entry of entries) {
      const token = new URL(entry.url).searchParams.get('token')
      if (token) return token
    }
  } catch {}
  return undefined
}

export default ClusterWorkerService
