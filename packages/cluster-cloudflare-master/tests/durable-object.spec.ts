import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ControlHelloFrame,
  ControlReadyFrame,
  HttpReqFrame,
  HttpRespFrame,
  StreamCloseFrame,
  StreamItemFrame,
  TunnelStreamId,
  WorkerId,
} from '@deepseek-ai/dsh-cluster-protocol'
import { ClusterMasterDO } from '../src/durable-object.ts'
import type { CloudflareDurableObjectState, Env } from '../src/types.ts'

class MockWebSocket {
  readyState = 1 // OPEN
  private readonly listeners: Record<string, ((event: any) => void)[]> = {}
  peer?: MockWebSocket

  accept(): void {}

  addEventListener(event: string, listener: any): void {
    this.listeners[event] = this.listeners[event] || []
    this.listeners[event].push(listener)
  }

  send(data: string): void {
    if (this.peer && this.peer.readyState === 1) {
      const listeners = this.peer.listeners['message'] || []
      for (const listener of listeners) {
        listener({ data })
      }
    }
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3 // CLOSED
    for (const listener of this.listeners['close'] || []) {
      listener({ code, reason })
    }
    if (this.peer && this.peer.readyState === 1) {
      this.peer.readyState = 3
      for (const listener of this.peer.listeners['close'] || []) {
        listener({ code, reason })
      }
    }
  }
}

function createMockWebSocketPair(): [MockWebSocket, MockWebSocket] {
  const client = new MockWebSocket()
  const server = new MockWebSocket()
  client.peer = server
  server.peer = client
  return [client, server]
}

describe('Cloudflare Master Durable Object Relay', () => {
  let originalWebSocketPair: any
  let masterDO: ClusterMasterDO
  let sockets: MockWebSocket[]
  const AUTH_TOKEN = 'cf-test-token-789'

  beforeEach(() => {
    sockets = []
    originalWebSocketPair = (globalThis as any).WebSocketPair
    ;(globalThis as any).WebSocketPair = class {
      0: MockWebSocket
      1: MockWebSocket
      constructor() {
        const [c, s] = createMockWebSocketPair()
        sockets.push(c)
        this[0] = c
        this[1] = s
      }
    }

    const mockState: CloudflareDurableObjectState = {
      id: { toString: () => 'test-do-id' },
      waitUntil: () => {},
    }

    const mockEnv: Env = {
      CLUSTER_MASTER_DO: {} as any,
      AUTH_TOKEN,
    }

    masterDO = new ClusterMasterDO(mockState, mockEnv)
  })

  afterEach(() => {
    for (const socket of sockets) if (socket.readyState !== 3) socket.close()
    ;(globalThis as any).WebSocketPair = originalWebSocketPair
  })

  it('rejects worker connection without WebSocket upgrade header', async () => {
    const req = new Request('https://dsh.example/api/worker/connect')
    const resp = await masterDO.fetch(req)
    expect(resp.status).toBe(426)
  })

  it('rejects worker handshake with incorrect authentication token', async () => {
    const req = new Request('https://dsh.example/api/worker/connect', {
      headers: { Upgrade: 'websocket' },
    })
    const resp = await masterDO.fetch(req)
    expect(resp.status).toBe(101)

    const clientWs = (resp as any).webSocket as MockWebSocket
    const receivedFrames: any[] = []
    clientWs.addEventListener('message', (e: any) => {
      receivedFrames.push(JSON.parse(e.data))
    })

    const hello: ControlHelloFrame = {
      type: 'control:hello',
      token: 'wrong-token',
      workerId: 'worker-1' as WorkerId,
      name: 'Test-Worker',
      workspaces: ['/test'],
      version: '0.2.2',
      timestamp: Date.now(),
    }
    clientWs.send(JSON.stringify(hello))

    expect(receivedFrames.length).toBe(1)
    expect(receivedFrames[0].type).toBe('control:ready')
    expect(receivedFrames[0].accepted).toBe(false)
    expect(clientWs.readyState).toBe(3)
  })

  it('accepts valid worker handshake and reports cluster status', async () => {
    const req = new Request('https://dsh.example/api/worker/connect', {
      headers: { Upgrade: 'websocket' },
    })
    const resp = await masterDO.fetch(req)
    expect(resp.status).toBe(101)

    const clientWs = (resp as any).webSocket as MockWebSocket
    const receivedFrames: any[] = []
    clientWs.addEventListener('message', (e: any) => {
      receivedFrames.push(JSON.parse(e.data))
    })

    const hello: ControlHelloFrame = {
      type: 'control:hello',
      token: AUTH_TOKEN,
      workerId: 'worker-node-alpha' as WorkerId,
      name: 'Alpha-Worker',
      workspaces: ['/workspace/alpha'],
      version: '0.2.2',
      timestamp: Date.now(),
    }
    clientWs.send(JSON.stringify(hello))

    expect(receivedFrames.length).toBe(1)
    const ready = receivedFrames[0] as ControlReadyFrame
    expect(ready.type).toBe('control:ready')
    expect(ready.accepted).toBe(true)

    // Check cluster status endpoint
    const statusReq = new Request('https://dsh.example/api/cluster/status')
    const statusResp = await masterDO.fetch(statusReq)
    expect(statusResp.status).toBe(200)
    const statusJson = await statusResp.json() as any
    expect(statusJson.status).toBe('connected')
    expect(statusJson.worker.id).toBe('worker-node-alpha')
    expect(statusJson.worker.name).toBe('Alpha-Worker')
  })

  it('relays HTTP requests to connected worker and returns response', async () => {
    // 1. Connect worker
    const workerReq = new Request('https://dsh.example/api/worker/connect', {
      headers: { Upgrade: 'websocket' },
    })
    const workerUpgradeResp = await masterDO.fetch(workerReq)
    const workerWs = (workerUpgradeResp as any).webSocket as MockWebSocket

    workerWs.addEventListener('message', (e: any) => {
      const frame = JSON.parse(e.data)
      if (frame.type === 'http:req') {
        const reqFrame = frame as HttpReqFrame
        const respFrame: HttpRespFrame = {
          type: 'http:resp',
          reqId: reqFrame.reqId,
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'Hello from worker', path: reqFrame.path }),
        }
        workerWs.send(JSON.stringify(respFrame))
      }
    })

    workerWs.send(JSON.stringify({
      type: 'control:hello',
      token: AUTH_TOKEN,
      workerId: 'worker-http' as WorkerId,
      name: 'Http-Worker',
      workspaces: ['/'],
      version: '0.2.2',
      timestamp: Date.now(),
    }))

    // 2. Send HTTP request through master
    const clientHttpReq = new Request('https://dsh.example/api/session/list?query=test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 10 }),
    })

    const clientHttpResp = await masterDO.fetch(clientHttpReq)
    expect(clientHttpResp.status).toBe(200)
    const clientRespJson = await clientHttpResp.json() as any
    expect(clientRespJson.message).toBe('Hello from worker')
    expect(clientRespJson.path).toBe('/api/session/list?query=test')
  })

  it('distinguishes timeout from worker disconnect and cancels timed out requests', async () => {
    vi.useFakeTimers()
    try {
      const upgrade = await masterDO.fetch(new Request('https://dsh.example/api/worker/connect', {
        headers: { Upgrade: 'websocket' },
      }))
      const worker = (upgrade as any).webSocket as MockWebSocket
      const frames: any[] = []
      worker.addEventListener('message', (event: any) => frames.push(JSON.parse(event.data)))
      worker.send(JSON.stringify({ type: 'control:hello', token: AUTH_TOKEN, workerId: 'worker',
        name: 'worker', workspaces: [], version: '1', timestamp: Date.now() }))
      const timed = masterDO.fetch(new Request('https://dsh.example/api/pick'))
      const request = frames.find(frame => frame.type === 'http:req')
      // Keep the heartbeat alive until the request watchdog fires.
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(15000)
        worker.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
      }
      const timeout = await timed
      expect(timeout.status).toBe(504)
      expect(await timeout.json()).toEqual({ code: 'gateway/timeout', error: 'Gateway timeout waiting for worker response' })
      expect(frames).toContainEqual({ type: 'http:cancel', reqId: request.reqId })
      const disconnected = masterDO.fetch(new Request('https://dsh.example/api/pick'))
      worker.close()
      const response = await disconnected
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ code: 'gateway/worker-disconnected', error: 'Worker disconnected' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a worker request the browser abandons before it responds', async () => {
    const upgrade = await masterDO.fetch(new Request('https://dsh.example/api/worker/connect', {
      headers: { Upgrade: 'websocket' },
    }))
    const worker = (upgrade as any).webSocket as MockWebSocket
    const frames: any[] = []
    worker.addEventListener('message', (event: any) => frames.push(JSON.parse(event.data)))
    worker.send(JSON.stringify({ type: 'control:hello', token: AUTH_TOKEN, workerId: 'worker-abandon',
      name: 'worker', workspaces: [], version: '1', timestamp: Date.now() }))

    const browser = new AbortController()
    const abandoned = masterDO.fetch(new Request('https://dsh.example/api/pick', { signal: browser.signal }))
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'http:req')).toBe(true))
    const request = frames.find(frame => frame.type === 'http:req')

    browser.abort()

    expect((await abandoned).status).toBe(499)
    expect(frames).toContainEqual({ type: 'http:cancel', reqId: request.reqId })
  })

  it('ignores a worker response that arrives after the browser abandoned the request', async () => {
    const upgrade = await masterDO.fetch(new Request('https://dsh.example/api/worker/connect', {
      headers: { Upgrade: 'websocket' },
    }))
    const worker = (upgrade as any).webSocket as MockWebSocket
    const frames: any[] = []
    worker.addEventListener('message', (event: any) => frames.push(JSON.parse(event.data)))
    worker.send(JSON.stringify({ type: 'control:hello', token: AUTH_TOKEN, workerId: 'worker-late',
      name: 'worker', workspaces: [], version: '1', timestamp: Date.now() }))

    const browser = new AbortController()
    const abandoned = masterDO.fetch(new Request('https://dsh.example/api/pick', { signal: browser.signal }))
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'http:req')).toBe(true))
    const request = frames.find(frame => frame.type === 'http:req')

    browser.abort()
    await abandoned
    worker.send(JSON.stringify({ type: 'http:resp', reqId: request.reqId, status: 200, headers: {}, body: '{}' }))

    // The relay stays usable: a later request still completes end to end.
    worker.addEventListener('message', (event: any) => {
      const frame = JSON.parse(event.data)
      if (frame.type === 'http:req') {
        worker.send(JSON.stringify({ type: 'http:resp', reqId: frame.reqId, status: 200,
          headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }))
      }
    })
    const followUp = await masterDO.fetch(new Request('https://dsh.example/api/after-abandon'))
    expect(followUp.status).toBe(200)
    expect(await followUp.json()).toEqual({ ok: true })
  })

  it('relays WebSocket mux streams between browser and worker', async () => {
    // 1. Connect worker
    const workerReq = new Request('https://dsh.example/api/worker/connect', {
      headers: { Upgrade: 'websocket' },
    })
    const workerUpgradeResp = await masterDO.fetch(workerReq)
    const workerWs = (workerUpgradeResp as any).webSocket as MockWebSocket

    const workerFrames: any[] = []
    workerWs.addEventListener('message', (e: any) => {
      const frame = JSON.parse(e.data)
      workerFrames.push(frame)

      if (frame.type === 'stream:open') {
        // Reply with stream items and close
        const item: StreamItemFrame = {
          type: 'stream:item',
          streamId: frame.streamId,
          value: { chunk: 'stream data chunk 1' },
        }
        workerWs.send(JSON.stringify(item))

        const close: StreamCloseFrame = {
          type: 'stream:close',
          streamId: frame.streamId,
        }
        workerWs.send(JSON.stringify(close))
      }
    })

    workerWs.send(JSON.stringify({
      type: 'control:hello',
      token: AUTH_TOKEN,
      workerId: 'worker-mux' as WorkerId,
      name: 'Mux-Worker',
      workspaces: ['/'],
      version: '0.2.2',
      timestamp: Date.now(),
    }))

    // 2. Connect browser WebSocket /api/remote.mux
    const browserMuxReq = new Request('https://dsh.example/api/remote.mux', {
      headers: { Upgrade: 'websocket' },
    })
    const browserUpgradeResp = await masterDO.fetch(browserMuxReq)
    expect(browserUpgradeResp.status).toBe(101)
    const browserWs = (browserUpgradeResp as any).webSocket as MockWebSocket

    const browserReceived: any[] = []
    browserWs.addEventListener('message', (e: any) => {
      browserReceived.push(JSON.parse(e.data))
    })

    // Browser opens a logical stream
    browserWs.send(JSON.stringify({
      type: 'open',
      streamId: 'stream-alpha-123' as TunnelStreamId,
      endpoint: '$events',
      payload: { args: {} },
    }))

    expect(workerFrames.some(f => f.type === 'stream:open' && f.streamId === 'stream-alpha-123')).toBe(true)

    // Browser sends uplink item (e.g. terminal keystrokes)
    browserWs.send(JSON.stringify({
      type: 'item',
      streamId: 'stream-alpha-123' as TunnelStreamId,
      value: { type: 'write', data: 'uname -a\n' },
    }))

    expect(workerFrames.some(f =>
      f.type === 'stream:uplink' &&
      f.streamId === 'stream-alpha-123' &&
      f.item.data === 'uname -a\n',
    )).toBe(true)

    // Check browser received forwarded items and end
    expect(browserReceived.some(f => f.type === 'item' && f.streamId === 'stream-alpha-123' && f.value.chunk === 'stream data chunk 1')).toBe(true)
    expect(browserReceived.some(f => f.type === 'end' && f.streamId === 'stream-alpha-123')).toBe(true)
  })

  it('rejects /api/remote.mux when no worker is online', async () => {
    const browserMuxReq = new Request('https://dsh.example/api/remote.mux', {
      headers: { Upgrade: 'websocket' },
    })
    const resp = await masterDO.fetch(browserMuxReq)
    expect(resp.status).toBe(503)
  })
})
