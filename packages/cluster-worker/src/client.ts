/** Worker-side reverse WebSocket tunnel client connecting to master. */

import { EventEmitter } from 'node:events'
import { WebSocket as WsLibrary } from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'
import {
  INITIAL_RECONNECT_BACKOFF_MS,
  MAX_RECONNECT_BACKOFF_MS,
  parseClusterFrame,
  serializeClusterFrame,
  type ClusterFrame,
  type ControlHelloFrame,
  type ControlReadyFrame,
  type HttpReqFrame,
  type HttpRespFrame,
  type TunnelRequestId,
  type PongFrame,
  type WorkerId,
} from '@deepseek-ai/dsh-cluster-protocol'

interface TunnelSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(event: 'open', listener: () => void): void
  addEventListener(event: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(event: 'close', listener: (event: { code?: number; reason?: string }) => void): void
  addEventListener(event: 'error', listener: (event: { error?: unknown; message?: string }) => void): void
}

const resolveProxyAgent = (url: string, explicitProxy?: string): HttpsProxyAgent<string> | undefined => {
  const env = process.env
  const proxyStr = explicitProxy ?? (
    url.startsWith('wss://') || url.startsWith('https://')
      ? (env.https_proxy || env.HTTPS_PROXY || env.all_proxy || env.ALL_PROXY)
      : (env.http_proxy || env.HTTP_PROXY || env.all_proxy || env.ALL_PROXY)
  )

  if (proxyStr && (proxyStr.startsWith('http://') || proxyStr.startsWith('https://'))) {
    return new HttpsProxyAgent(proxyStr)
  }
  return undefined
}

const createTunnelSocket = (url: string, explicitProxy?: string): TunnelSocket => {
  const agent = resolveProxyAgent(url, explicitProxy)
  if (agent) {
    return new WsLibrary(url, { agent })
  }
  return new WsLibrary(url)
}

/** Configuration options for the worker tunnel client. */
export interface WorkerTunnelClientConfig {
  /** Master reverse WebSocket tunnel URL (e.g. ws://master.example.com/api/worker/connect). */
  readonly masterUrl: string
  /** Pre-shared authentication token. */
  readonly token: string
  /** Unique stable ID for this worker node. */
  readonly workerId: WorkerId
  /** Human-readable display label. */
  readonly name: string
  /** Initial workspace directories served by this worker. */
  readonly workspaces: readonly string[]
  /** Worker implementation version string. */
  readonly version?: string | undefined
  /** Explicit HTTP/HTTPS proxy to route tunnel connection through. */
  readonly proxyUrl?: string | undefined
  /** Whether to automatically reconnect when connection drops (default: true). */
  readonly autoReconnect?: boolean | undefined
  /** Initial reconnect delay in milliseconds (default: 1000). */
  readonly initialReconnectBackoffMs?: number | undefined
  /** Maximum reconnect delay in milliseconds (default: 30000). */
  readonly maxReconnectBackoffMs?: number | undefined
}

/** Handles a forwarded request until its response or cancellation cleanup completes. */
export type HttpRequestHandler = (
  req: HttpReqFrame,
  signal: AbortSignal,
) => Promise<Omit<HttpRespFrame, 'type' | 'reqId'>>

/** Reverse WebSocket tunnel client running on worker nodes. */
export class WorkerTunnelClient extends EventEmitter {
  private socket: TunnelSocket | undefined
  private isRunning = false
  private isConnected = false
  private reconnectTimer: NodeJS.Timeout | undefined
  private currentBackoffMs: number
  private readonly maxBackoffMs: number
  private httpHandler: HttpRequestHandler | undefined
  private readonly generations = new Set<{ socket: TunnelSocket; requests: Map<TunnelRequestId, AbortController>; pending: Set<Promise<void>>; closed: Promise<void> }>()

  /**
   * @param config - Tunnel connection configuration.
   */
  constructor(private readonly config: WorkerTunnelClientConfig) {
    super()
    this.currentBackoffMs = config.initialReconnectBackoffMs ?? INITIAL_RECONNECT_BACKOFF_MS
    this.maxBackoffMs = config.maxReconnectBackoffMs ?? MAX_RECONNECT_BACKOFF_MS
  }

  /**
   * Register the HTTP request dispatcher handler.
   * @param handler - Function invoked for incoming http:req frames.
   */
  onRequest(handler: HttpRequestHandler): void {
    this.httpHandler = handler
  }

  /**
   * Establish connection to Master and perform hello handshake.
   * @returns Resolves once registration is acknowledged.
   */
  start(): Promise<void> {
    this.isRunning = true
    return this.connect()
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false

      try {
        this.socket = createTunnelSocket(this.config.masterUrl, this.config.proxyUrl)
      } catch (err) {
        if (this.config.autoReconnect !== false && this.isRunning) {
          this.scheduleReconnect()
        }
        return reject(err)
      }

      const socket = this.socket
      const requests = new Map<TunnelRequestId, AbortController>()
      const pending = new Set<Promise<void>>()
      let closedResolve!: () => void
      const closed = new Promise<void>(resolveClosed => { closedResolve = resolveClosed })
      const generation = { socket, requests, pending, closed }
      this.generations.add(generation)

      socket.addEventListener('open', () => {
        if (this.socket !== socket || !this.isRunning) return
        const hello: ControlHelloFrame = {
          type: 'control:hello',
          token: this.config.token,
          workerId: this.config.workerId,
          name: this.config.name,
          workspaces: this.config.workspaces,
          version: this.config.version ?? '0.2.2',
          timestamp: Date.now(),
        }
        this.send(hello)
      })

      socket.addEventListener('message', (event) => {
        if (this.socket !== socket || !this.isRunning) return
        const frame = parseClusterFrame(event.data)
        if (!frame) return

        if (frame.type === 'control:ready') {
          const ready = frame as ControlReadyFrame
          if (!ready.accepted) {
            const err = new Error(`Connection rejected by master: ${ready.reason ?? 'unknown reason'}`)
            if (!settled) {
              settled = true
              reject(err)
            } else {
              this.emit('error', err)
            }
            socket.close()
            return
          }

          this.isConnected = true
          this.currentBackoffMs = this.config.initialReconnectBackoffMs ?? INITIAL_RECONNECT_BACKOFF_MS
          if (!settled) {
            settled = true
            resolve()
          }
          this.emit('connected')
          return
        }

        switch (frame.type) {
          case 'ping': {
            const pong: PongFrame = { type: 'pong', timestamp: Date.now() }
            this.send(pong)
            break
          }
          case 'http:cancel':
            requests.get(frame.reqId)?.abort()
            break
          case 'http:req': {
            const handler = this.httpHandler
            if (handler) {
              const controller = new AbortController()
              requests.set(frame.reqId, controller)
              const task = (async () => {
              try {
                const result = await handler(frame, controller.signal)
                const resp: HttpRespFrame = {
                  type: 'http:resp',
                  reqId: frame.reqId,
                  status: result.status,
                  headers: result.headers,
                  body: result.body,
                }
                if (!controller.signal.aborted) this.send(resp)
              } catch (handlerErr) {
                const resp: HttpRespFrame = {
                  type: 'http:resp',
                  reqId: frame.reqId,
                  status: 500,
                  body: JSON.stringify({ error: String(handlerErr) }),
                }
                if (!controller.signal.aborted) this.send(resp)
              } finally {
                if (requests.get(frame.reqId) === controller) requests.delete(frame.reqId)
              }
              })()
              pending.add(task)
              void task.finally(() => pending.delete(task))
            } else {
              const resp: HttpRespFrame = {
                type: 'http:resp',
                reqId: frame.reqId,
                status: 404,
                body: JSON.stringify({ error: 'No handler registered on worker' }),
              }
              this.send(resp)
            }
            break
          }
          default:
            this.emit('frame', frame)
            break
        }
      })

      socket.addEventListener('close', (event) => {
        closedResolve()
        for (const controller of requests.values()) controller.abort()
        void Promise.all([...pending]).then(() => this.generations.delete(generation))
        if (!settled) {
          settled = true
          const reasonMsg = event.reason ? `: ${event.reason}` : ''
          reject(new Error(`Socket closed before registration ready (code: ${event.code ?? 1006}${reasonMsg})`))
        }
        if (this.socket !== socket) return
        const wasConnected = this.isConnected
        this.isConnected = false
        if (wasConnected) {
          this.emit('disconnected', { code: event.code, reason: event.reason })
        }
        if (this.isRunning && this.config.autoReconnect !== false) {
          this.scheduleReconnect()
        }
      })

      socket.addEventListener('error', (event) => {
        if (this.socket !== socket) return
        const err = event.error instanceof Error
          ? event.error
          : new Error(typeof event.message === 'string' ? event.message : 'WebSocket connection error')
        if (!settled) {
          settled = true
          reject(err)
        } else {
          this.emit('error', err)
        }
      })
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.isRunning) return
    const delay = this.currentBackoffMs
    this.currentBackoffMs = Math.min(this.currentBackoffMs * 1.5, this.maxBackoffMs)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.isRunning) {
        this.connect().catch(() => {
          // Errors will trigger next reconnect attempt in 'close' listener
        })
      }
    }, delay)
  }

  /**
   * Send a typed cluster frame to Master.
   * @param frame - Frame to encode and send.
   */
  send(frame: ClusterFrame): void {
    if (this.socket && this.socket.readyState === 1) {
      this.socket.send(serializeClusterFrame(frame))
    }
  }

  /**
   * Gracefully stop the client and close connection.
   */
  async stop(): Promise<void> {
    this.isRunning = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.socket = undefined
    this.isConnected = false
    const generations = [...this.generations]
    for (const generation of generations) {
      for (const controller of generation.requests.values()) controller.abort()
      if (generation.socket.readyState < 2) generation.socket.close(1000, 'Worker shutting down')
    }
    await Promise.all(generations.map(async generation => {
      await Promise.all([generation.closed, ...generation.pending])
      this.generations.delete(generation)
    }))
  }

  /**
   * Check if client is currently authenticated and connected.
   * @returns True if connected.
   */
  get connected(): boolean {
    return this.isConnected
  }
}
