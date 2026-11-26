/**
 * Cloudflare Durable Object managing Worker reverse tunnel, browser WebSocket multiplexing,
 * and HTTP RPC relay in pure memory (0 storage reads/writes).
 */

import {
  DEFAULT_WORKER_TUNNEL_PATH,
  parseClusterFrame,
  type ClusterFrame,
  type ControlHelloFrame,
  type ControlReadyFrame,
  type HttpReqFrame,
  type HttpRespFrame,
  type PingFrame,
  type StreamCloseFrame,
  type StreamItemFrame,
  type StreamOpenFrame,
  type StreamUplinkFrame,
  type TunnelRequestId,
  type TunnelStreamId,
} from '@deepseek-ai/dsh-cluster-protocol'
import type { CloudflareDurableObjectState, ConnectedWorkerInfo, Env } from './types.ts'

class RelayFailure extends Error {
  constructor(readonly code: 'gateway/timeout' | 'gateway/worker-disconnected', message: string) {
    super(message)
  }
}

interface PendingHttpRequest {
  resolve: (resp: HttpRespFrame) => void
  reject: (err: Error) => void
  timer: any
}

function createWebSocketUpgradeResponse(webSocket: WebSocket): Response {
  try {
    return new Response(null, {
      status: 101,
      webSocket,
    } as any)
  } catch {
    // In Node.js / test environments where native Response rejects status 101
    return {
      status: 101,
      statusText: 'Switching Protocols',
      headers: new Headers(),
      webSocket,
    } as unknown as Response
  }
}

/**
 * Global singleton Durable Object instance running on Cloudflare's edge network.
 */
export class ClusterMasterDO {
  private workerWs: WebSocket | undefined
  private workerInfo: ConnectedWorkerInfo | undefined
  private missedPongs = 0
  private heartbeatTimer: any = undefined

  private readonly browserSockets = new Set<WebSocket>()
  private readonly streamToBrowser = new Map<TunnelStreamId, WebSocket>()
  private readonly browserToStreams = new Map<WebSocket, Set<TunnelStreamId>>()
  private readonly pendingHttpRequests = new Map<TunnelRequestId, PendingHttpRequest>()

  /**
   * @param ctx - Durable Object state context.
   * @param env - Cloudflare worker environment variables.
   */
  constructor(readonly ctx: CloudflareDurableObjectState, readonly env: Env) {}

  /**
   * Main dispatch entry point for HTTP requests routed into this Durable Object.
   * @param request - Incoming fetch request.
   * @returns HTTP or WebSocket upgrade response.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const pathname = url.pathname

    // 1. Worker reverse WebSocket tunnel endpoint
    if (pathname === DEFAULT_WORKER_TUNNEL_PATH || pathname === '/api/worker/connect') {
      return this.handleWorkerConnect(request)
    }

    // 2. Browser WebSocket multiplexer endpoint
    if (pathname === '/api/remote.mux') {
      return this.handleBrowserMux(request)
    }

    // 3. Cluster status query endpoint
    if (pathname === '/api/cluster/status') {
      return this.handleClusterStatus()
    }

    // 4. HTTP RPC and dynamic routes (e.g. /api/*, /modules/*, /, /index.html)
    if (this.workerWs && this.workerWs.readyState === 1 /* OPEN */) {
      return this.handleHttpRequest(request)
    }

    if (pathname.startsWith('/api')) {
      return this.handleHttpRequest(request)
    }

    return new Response('Not Found', { status: 404 })
  }

  /**
   * Returns current cluster connectivity and worker health.
   */
  private handleClusterStatus(): Response {
    return new Response(
      JSON.stringify({
        status: this.workerWs ? 'connected' : 'waiting_for_worker',
        worker: this.workerInfo ?? null,
        activeBrowserSessions: this.browserSockets.size,
        activeStreams: this.streamToBrowser.size,
        timestamp: Date.now(),
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    )
  }

  /**
   * Handles outbound reverse WebSocket tunnel from local worker.
   */
  private handleWorkerConnect(request: Request): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }

    const webSocketPair = new (globalThis as any).WebSocketPair()
    const client = webSocketPair[0]
    const server = webSocketPair[1]

    server.accept()

    let isAuthenticated = false
    const handshakeTimeout = setTimeout(() => {
      if (!isAuthenticated) {
        try {
          server.close(4002, 'Handshake timeout')
        } catch {}
      }
    }, 10000)

    server.addEventListener('message', (event: any) => {
      const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
      const frame = parseClusterFrame(data)
      if (!frame) return

      if (frame.type === 'control:hello') {
        clearTimeout(handshakeTimeout)
        const hello = frame as ControlHelloFrame

        // Verify pre-shared cluster auth token
        const expectedToken = this.env.AUTH_TOKEN
        if (expectedToken && hello.token !== expectedToken) {
          const rejectFrame: ControlReadyFrame = {
            type: 'control:ready',
            accepted: false,
            reason: 'Invalid cluster authentication token',
            masterTime: Date.now(),
          }
          try {
            server.send(JSON.stringify(rejectFrame))
            server.close(4001, 'Unauthorized')
          } catch {}
          return
        }

        // Accept connection
        isAuthenticated = true

        // Clean up previous worker if connected
        if (this.workerWs && this.workerWs !== server) {
          const previousWorker = this.workerWs
          this.cleanupWorker()
          try {
            previousWorker.close(1000, 'Superseded by new worker connection')
          } catch {}
          // Also close existing browser sessions so they cleanly re-establish streams with the new worker
          for (const browser of this.browserSockets) {
            try {
              browser.close(1012, 'Worker superseded, reconnecting')
            } catch {}
          }
          this.browserSockets.clear()
          this.streamToBrowser.clear()
          this.browserToStreams.clear()
        }

        this.workerWs = server
        this.workerInfo = {
          id: hello.workerId,
          name: hello.name,
          workspaces: hello.workspaces,
          connectedAt: Date.now(),
        }
        this.missedPongs = 0

        const readyFrame: ControlReadyFrame = {
          type: 'control:ready',
          accepted: true,
          masterTime: Date.now(),
        }
        server.send(JSON.stringify(readyFrame))
        this.startHeartbeat()
        return
      }

      if (!isAuthenticated) {
        try {
          server.close(4002, 'Handshake required before message exchange')
        } catch {}
        return
      }

      // Handle heartbeat pong
      if (frame.type === 'pong') {
        this.missedPongs = 0
        return
      }

      // Handle transparent HTTP response from worker
      if (frame.type === 'http:resp') {
        const respFrame = frame as HttpRespFrame
        const pending = this.pendingHttpRequests.get(respFrame.reqId)
        if (pending) {
          this.pendingHttpRequests.delete(respFrame.reqId)
          pending.resolve(respFrame)
        }
        return
      }

      // Handle stream items forwarded from worker
      if (frame.type === 'stream:item') {
        const itemFrame = frame as StreamItemFrame
        const targetBrowser = this.streamToBrowser.get(itemFrame.streamId)
        if (targetBrowser && targetBrowser.readyState === 1 /* OPEN */) {
          try {
            targetBrowser.send(
              JSON.stringify({
                type: 'item',
                streamId: itemFrame.streamId,
                value: itemFrame.value,
              }),
            )
          } catch {}
        }
        return
      }

      // Handle stream close forwarded from worker
      if (frame.type === 'stream:close') {
        const closeFrame = frame as StreamCloseFrame
        const targetBrowser = this.streamToBrowser.get(closeFrame.streamId)
        this.streamToBrowser.delete(closeFrame.streamId)

        if (targetBrowser && targetBrowser.readyState === 1 /* OPEN */) {
          try {
            if (closeFrame.error) {
              targetBrowser.send(
                JSON.stringify({
                  type: 'error',
                  streamId: closeFrame.streamId,
                  error: {
                    code: closeFrame.error.code,
                    message: closeFrame.error.message,
                    details: closeFrame.error.details ?? {},
                  },
                }),
              )
            } else {
              targetBrowser.send(
                JSON.stringify({
                  type: 'end',
                  streamId: closeFrame.streamId,
                }),
              )
            }
          } catch {}
        }
        return
      }
    })

    server.addEventListener('close', () => {
      clearTimeout(handshakeTimeout)
      if (this.workerWs === server) {
        this.cleanupWorker()
      }
    })

    server.addEventListener('error', () => {
      clearTimeout(handshakeTimeout)
      if (this.workerWs === server) {
        this.cleanupWorker()
      }
    })

    return createWebSocketUpgradeResponse(client)
  }

  /**
   * Handles browser WebSocket connection to /api/remote.mux.
   */
  private handleBrowserMux(request: Request): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }

    if (!this.workerWs || this.workerWs.readyState !== 1 /* OPEN */) {
      return new Response(
        JSON.stringify({ error: 'No active worker connected to cluster master' }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      )
    }

    const webSocketPair = new (globalThis as any).WebSocketPair()
    const client = webSocketPair[0]
    const server = webSocketPair[1]

    server.accept()

    this.browserSockets.add(server)
    const ownedStreams = new Set<TunnelStreamId>()
    this.browserToStreams.set(server, ownedStreams)

    server.addEventListener('message', (event: any) => {
      const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
      let msg: any
      try {
        msg = JSON.parse(text)
      } catch {
        return
      }

      if (!msg || typeof msg !== 'object') return

      if (msg.type === 'open') {
        const streamId = msg.streamId as TunnelStreamId
        if (streamId) {
          ownedStreams.add(streamId)
          this.streamToBrowser.set(streamId, server)

          const openFrame: StreamOpenFrame = {
            type: 'stream:open',
            streamId,
            endpoint: msg.endpoint ?? '',
            payload: msg.payload,
          }
          this.sendToWorker(openFrame)
        }
        return
      }

      if (msg.type === 'item') {
        const streamId = msg.streamId as TunnelStreamId
        if (streamId) {
          const uplinkFrame: StreamUplinkFrame = {
            type: 'stream:uplink',
            streamId,
            item: msg.value ?? msg.item,
          }
          this.sendToWorker(uplinkFrame)
        }
        return
      }

      if (msg.type === 'cancel' || msg.type === 'close') {
        const streamId = msg.streamId as TunnelStreamId
        if (streamId) {
          ownedStreams.delete(streamId)
          this.streamToBrowser.delete(streamId)

          const closeFrame: StreamCloseFrame = {
            type: 'stream:close',
            streamId,
            error: {
              code: 'stream/cancelled',
              message: 'Stream cancelled by client',
            },
          }
          this.sendToWorker(closeFrame)
        }
      }
    })

    const onBrowserClose = (): void => {
      this.browserSockets.delete(server)
      this.browserToStreams.delete(server)

      // Notify worker to cancel all open streams belonging to this browser
      for (const streamId of ownedStreams) {
        this.streamToBrowser.delete(streamId)
        const closeFrame: StreamCloseFrame = {
          type: 'stream:close',
          streamId,
          error: {
            code: 'stream/cancelled',
            message: 'Browser disconnected',
          },
        }
        this.sendToWorker(closeFrame)
      }
      ownedStreams.clear()
    }

    server.addEventListener('close', onBrowserClose)
    server.addEventListener('error', onBrowserClose)

    return createWebSocketUpgradeResponse(client)
  }

  /**
   * Transparently proxies an incoming HTTP request (e.g. POST /api/*) to the connected worker.
   */
  private async handleHttpRequest(request: Request): Promise<Response> {
    if (!this.workerWs || this.workerWs.readyState !== 1 /* OPEN */) {
      return new Response(
        JSON.stringify({ error: 'No active worker connected to cluster master' }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      )
    }

    const url = new URL(request.url)
    const reqId = crypto.randomUUID() as TunnelRequestId

    let body: string | undefined
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      body = await request.text()
    }

    const headers: Record<string, string> = {}
    request.headers.forEach((val, key) => {
      headers[key] = val
    })

    const reqFrame: HttpReqFrame = {
      type: 'http:req',
      reqId,
      method: request.method,
      path: url.pathname + url.search,
      headers,
      body: body && body.length > 0 ? body : undefined,
    }

    try {
      const resp = await new Promise<HttpRespFrame>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingHttpRequests.delete(reqId)
          this.sendToWorker({ type: 'http:cancel', reqId })
          reject(new RelayFailure('gateway/timeout', 'Gateway timeout waiting for worker response'))
        }, 60000)

        // A browser that navigates away or dismisses the dialog abandons the request without the
        // tunnel learning about it; forward that abandonment so the worker stops waiting on it.
        const onAbandon = (): void => {
          if (!this.pendingHttpRequests.has(reqId)) return
          this.pendingHttpRequests.delete(reqId)
          clearTimeout(timer)
          this.sendToWorker({ type: 'http:cancel', reqId })
          resolve({ type: 'http:resp', reqId, status: 499, headers: {}, body: undefined })
        }
        if (request.signal.aborted) {
          onAbandon()
        } else {
          request.signal.addEventListener('abort', onAbandon, { once: true })
        }

        this.pendingHttpRequests.set(reqId, {
          resolve: (val) => {
            request.signal.removeEventListener('abort', onAbandon)
            clearTimeout(timer)
            resolve(val)
          },
          reject: (err) => {
            request.signal.removeEventListener('abort', onAbandon)
            clearTimeout(timer)
            reject(err)
          },
          timer,
        })

        this.sendToWorker(reqFrame)
      })

      const respHeaders = new Headers()
      if (resp.headers) {
        for (const [k, v] of Object.entries(resp.headers)) {
          if (v !== undefined) respHeaders.set(k, v)
        }
      }

      return new Response(resp.body ?? null, {
        status: resp.status,
        headers: respHeaders,
      })
    } catch (err: unknown) {
      if (!(err instanceof RelayFailure)) throw err
      return new Response(
        JSON.stringify({ error: err.message, code: err.code }),
        { status: err.code === 'gateway/timeout' ? 504 : 503, headers: { 'content-type': 'application/json' } },
      )
    }
  }

  /**
   * Starts periodic heartbeat pings to detect worker liveness.
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
    }

    this.heartbeatTimer = setInterval(() => {
      if (!this.workerWs || this.workerWs.readyState !== 1 /* OPEN */) {
        this.cleanupWorker()
        return
      }

      this.missedPongs++
      if (this.missedPongs > 4) {
        try {
          this.workerWs.close(4000, 'Heartbeat timeout')
        } catch {}
        this.cleanupWorker()
        return
      }

      const ping: PingFrame = { type: 'ping', timestamp: Date.now() }
      this.sendToWorker(ping)
    }, 15000)
  }

  /**
   * Sends a typed cluster frame to the active worker.
   */
  private sendToWorker(frame: ClusterFrame): void {
    if (this.workerWs && this.workerWs.readyState === 1 /* OPEN */) {
      try {
        this.workerWs.send(JSON.stringify(frame))
      } catch {}
    }
  }

  /**
   * Cleans up worker connection state upon disconnection.
   */
  private cleanupWorker(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }

    for (const reqId of this.pendingHttpRequests.keys()) {
      this.sendToWorker({ type: 'http:cancel', reqId })
    }
    this.workerWs = undefined
    this.workerInfo = undefined
    this.missedPongs = 0

    // Reject all pending HTTP requests
    for (const pending of this.pendingHttpRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new RelayFailure('gateway/worker-disconnected', 'Worker disconnected'))
    }
    this.pendingHttpRequests.clear()

    // Close all browser WebSocket connections with restart code so browser automatically reconnects
    for (const browser of this.browserSockets) {
      try {
        browser.close(1012, 'Worker disconnected, reconnecting')
      } catch {}
    }
    this.browserSockets.clear()
    this.streamToBrowser.clear()
    this.browserToStreams.clear()
  }
}
