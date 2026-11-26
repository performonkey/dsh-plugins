/** Cordis service mounting the Cluster Master reverse tunnel and relay on the WebServer. */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { WebSocketServer } from 'ws'
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_WORKER_TUNNEL_PATH,
  MAX_MISSED_PONGS,
} from '@deepseek-ai/dsh-cluster-protocol'
import { WorkerRegistry } from './registry.ts'
import { MasterRelay } from './relay.ts'

export interface Config {
  /** Pre-shared secret token required from workers during handshake. */
  readonly authToken: string
  /** WebSocket endpoint path for worker reverse connection. */
  readonly workerConnectPath?: string
  /** Cadence of heartbeat ping frames in milliseconds. */
  readonly heartbeatIntervalMs?: number
  /** Maximum consecutive unanswered pings before worker is pruned. */
  readonly maxMissedPongs?: number
  /** Whether to disable Master token authentication for Web UI and API (delegating auth to a reverse proxy such as Nginx basic auth). */
  readonly disableTokenAuth?: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cluster Master service instance. */
    clusterMaster: ClusterMasterService
  }
}

/** Cluster Master Cordis service managing remote worker registrations and proxying browser traffic. */
export class ClusterMasterService extends Service {
  static inject = ['webServer']
  static Config: z<Config> = z.object({
    authToken: z.string().default(process.env.DSH_CLUSTER_AUTH_TOKEN ?? 'default-cluster-token'),
    workerConnectPath: z.string().default(DEFAULT_WORKER_TUNNEL_PATH),
    heartbeatIntervalMs: z.number().default(DEFAULT_HEARTBEAT_INTERVAL_MS),
    maxMissedPongs: z.number().default(MAX_MISSED_PONGS),
    disableTokenAuth: z.boolean().default(
      process.env.DSH_DISABLE_TOKEN_AUTH === 'true' || process.env.DSH_DISABLE_TOKEN_AUTH === '1',
    ),
  })

  readonly registry: WorkerRegistry
  readonly relay: MasterRelay
  private readonly workerWss: WebSocketServer

  /**
   * @param ctx - Host context.
   * @param config - Cluster master configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'clusterMaster')

    this.registry = new WorkerRegistry({
      authToken: config.authToken,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      maxMissedPongs: config.maxMissedPongs,
    })

    this.relay = new MasterRelay({ registry: this.registry })
    this.workerWss = new WebSocketServer({ noServer: true })

    this.registry.on('worker:connected', (info) => {
      console.log(`[cluster-master] worker registered: ${info.name} (${info.id}) workspaces: ${info.workspaces.join(', ')}`)
    })
    this.registry.on('worker:disconnected', (info) => {
      console.log(`[cluster-master] worker disconnected: ${info.name} (${info.id})`)
    })

    // If token auth is disabled, delegate authentication to upstream reverse proxy
    if (config.disableTokenAuth) {
      const existingConn = ctx.get('connection')
      if (existingConn) {
        this.applyDisableTokenAuth(existingConn)
      }
      this.ctx.inject(['connection'], (connCtx) => {
        const conn = (connCtx as Context & { connection?: unknown }).connection ?? connCtx.get('connection')
        this.applyDisableTokenAuth(conn)
      })
    }

    const webCtx = ctx as Context & {
      webServer: {
        register: (route: unknown) => () => void
        registerUpgrade: (route: unknown) => () => void
      }
    }
    const webServer = webCtx.webServer as any

    // 1. Register worker reverse tunnel connection endpoint
    this.ctx.effect(() => {
      return webServer.registerUpgrade({
        path: config.workerConnectPath ?? DEFAULT_WORKER_TUNNEL_PATH,
        handler: (req: any, socket: any, head: any) => {
          this.workerWss.handleUpgrade(req, socket, head, (client) => {
            this.registry.handleConnection(client)
          })
        },
      })
    }, 'cluster-master: worker connect route')

    // 2. Intercept and register /api/remote.mux transparent stream relay
    const origRegisterUpgrade = typeof webServer.registerUpgrade === 'function' ? webServer.registerUpgrade.bind(webServer) : undefined
    const muxRoute = {
      path: '/api/remote.mux',
      handler: (req: any, socket: any, head: any) => {
        this.relay.handleMuxUpgrade(req, socket, head)
      },
    }

    if (origRegisterUpgrade) {
      let registeredMux = false
      webServer.registerUpgrade = (route: any) => {
        if (route.path === '/api/remote.mux') {
          registeredMux = true
          if (webServer.upgrades?.has?.('/api/remote.mux')) {
            webServer.upgrades.set('/api/remote.mux', muxRoute)
            return () => {
              webServer.upgrades?.delete?.('/api/remote.mux')
            }
          }
          return origRegisterUpgrade(muxRoute)
        }
        return origRegisterUpgrade(route)
      }

      this.ctx.effect(() => {
        if (!registeredMux && !webServer.upgrades?.has?.('/api/remote.mux')) {
          registeredMux = true
          return origRegisterUpgrade(muxRoute)
        }
        webServer.upgrades?.set?.('/api/remote.mux', muxRoute)
        return () => {
          webServer.upgrades?.delete?.('/api/remote.mux')
        }
      }, 'cluster-master: /api/remote.mux stream relay')
    }

    // 3. Intercept and register /api HTTP RPC relay
    const origRegister = typeof webServer.register === 'function' ? webServer.register.bind(webServer) : undefined
    const apiRoute = {
      kind: 'prefix',
      path: '/api',
      handler: (req: any, res: any) => {
        void this.relay.handleHttpRequest(req, res)
      },
    }

    if (origRegister) {
      let registeredApi = false
      webServer.register = (route: any) => {
        if (route.kind === 'prefix' && route.path === '/api') {
          registeredApi = true
          if (webServer.prefixes?.has?.('/api')) {
            webServer.prefixes.set('/api', apiRoute)
            return () => {
              webServer.prefixes?.delete?.('/api')
            }
          }
          return origRegister(apiRoute)
        }
        return origRegister(route)
      }

      this.ctx.effect(() => {
        if (!registeredApi && !webServer.prefixes?.has?.('/api')) {
          registeredApi = true
          return origRegister(apiRoute)
        }
        webServer.prefixes?.set?.('/api', apiRoute)
        return () => {
          webServer.prefixes?.delete?.('/api')
        }
      }, 'cluster-master: /api http relay')
    }
    // 4. Auto-dispose on context fiber unload
    this.ctx.effect(() => {
      return () => {
        this.dispose()
      }
    }, 'cluster-master: teardown')
  }

  /**
   * Disables Master launch token and cookie validation, delegating admission
   * control to an upstream reverse proxy (such as Nginx HTTP Basic Auth).
   * @param connection - Connection host service instance.
   */
  private applyDisableTokenAuth(connection: any): void {
    if (!connection) return

    // 1. Bypass index page authentication so any browser visitor can load index.html without token/cookie
    connection.authorizeIndex = () => true

    // 2. Automatically admit any request to browserPeer without requiring token/cookie
    connection.admit = () => {
      if (connection.disposed) return { rejection: 401 }
      return { peer: connection.browserPeer }
    }

    connection.admitConnection = () => {
      if (connection.disposed) return { rejection: 401 }
      return { peer: connection.browserPeer, release: () => Promise.resolve() }
    }

    connection.requestRejection = () => undefined

    // 3. Print clean URL without launch token query parameter
    connection.authenticatedUrl = (baseUrl: string) => baseUrl

    console.log('[cluster-master] Master token authentication disabled (delegating auth to reverse proxy / HTTP Basic Auth)')
  }

  /** Tear down relay, web socket server and worker registry connections. */
  dispose(): void {
    this.relay.close()
    this.workerWss.close()
    void this.registry.close()
  }
}

export default ClusterMasterService
