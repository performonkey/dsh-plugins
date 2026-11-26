import { createServer, request as httpRequest, type Server } from 'node:http'
import { getEventListeners } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlHelloFrame, WorkerId } from '@deepseek-ai/dsh-cluster-protocol'
import { MasterRelay, WorkerConnection, WorkerRegistry } from '../src/index.ts'
import { WorkerStreamDispatcher, WorkerTunnelClient } from '../../cluster-worker/src/index.ts'

const AUTH_TOKEN = 'test-cluster-relay-token'

/** Builds the hello frame the master stores for a directly constructed connection. */
function helloFrame(id: string, name: string): ControlHelloFrame {
  return {
    type: 'control:hello',
    token: AUTH_TOKEN,
    workerId: id as WorkerId,
    name,
    workspaces: [],
    version: 'test',
    timestamp: Date.now(),
  }
}

describe('Cluster Master-Worker Transparent Relay E2E (Milestone 2)', () => {
  let server: Server
  let workerWss: WebSocketServer
  let registry: WorkerRegistry
  let relay: MasterRelay
  let port: number
  let masterWorkerUrl: string
  let masterHttpUrl: string
  let masterMuxWsUrl: string

  beforeEach(async () => {
    server = createServer()
    workerWss = new WebSocketServer({ noServer: true })

    registry = new WorkerRegistry({
      authToken: AUTH_TOKEN,
      heartbeatIntervalMs: 1000,
      maxMissedPongs: 2,
    })

    relay = new MasterRelay({ registry })

    server.on('request', (req, res) => {
      if (req.url?.startsWith('/api')) {
        void relay.handleHttpRequest(req, res)
      } else {
        res.writeHead(404).end('Not Found')
      }
    })

    server.on('upgrade', (req, socket, head) => {
      if (req.url === '/api/worker/connect') {
        workerWss.handleUpgrade(req, socket, head, ws => {
          registry.handleConnection(ws)
        })
      } else if (req.url === '/api/remote.mux') {
        relay.handleMuxUpgrade(req, socket, head)
      } else {
        socket.destroy()
      }
    })

    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (typeof addr === 'object' && addr !== null) {
          port = addr.port
          masterWorkerUrl = `ws://127.0.0.1:${port}/api/worker/connect`
          masterHttpUrl = `http://127.0.0.1:${port}`
          masterMuxWsUrl = `ws://127.0.0.1:${port}/api/remote.mux`
        }
        resolve()
      })
    })
  })

  afterEach(async () => {
    relay.close()
    await registry.close()
    workerWss.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('relays HTTP POST /api to worker and streams back response', async () => {
    const workerId = 'worker-http-node' as WorkerId
    const worker = new WorkerTunnelClient({
      masterUrl: masterWorkerUrl,
      token: AUTH_TOKEN,
      workerId,
      name: 'HTTP Worker',
      workspaces: ['/workspace/project'],
      autoReconnect: false,
    })

    worker.onRequest(async req => {
      expect(req.method).toBe('POST')
      expect(req.path).toBe('/api/session/prompt')
      const body = JSON.parse(req.body ?? '{}')
      expect(body.prompt).toBe('Refactor code')

      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true, turnId: 'turn-001' }),
      }
    })

    await worker.start()

    // Send HTTP POST to Master as browser would
    const postData = JSON.stringify({ prompt: 'Refactor code' })
    const resp = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        `${masterHttpUrl}/api/session/prompt`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(postData),
          },
        },
        res => {
          const chunks: Buffer[] = []
          res.on('data', chunk => chunks.push(chunk))
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 500,
              body: Buffer.concat(chunks).toString('utf-8'),
            })
          })
        },
      )
      req.on('error', reject)
      req.write(postData)
      req.end()
    })

    expect(resp.status).toBe(200)
    const json = JSON.parse(resp.body)
    expect(json.ok).toBe(true)
    expect(json.turnId).toBe('turn-001')

    await worker.stop()
  })

  it('answers 503 if no worker is connected when HTTP request arrives', async () => {
    const resp = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(`${masterHttpUrl}/api/any`, { method: 'GET' }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 500,
            body: Buffer.concat(chunks).toString('utf-8'),
          })
        })
      })
      req.on('error', reject)
      req.end()
    })

    expect(resp.status).toBe(503)
    const json = JSON.parse(resp.body)
    expect(json.error).toMatch(/no worker available/i)
  })

  it('cancels the worker request when the browser abandons the call', async () => {
    const workerId = 'worker-abandon-node' as WorkerId
    const worker = new WorkerTunnelClient({
      masterUrl: masterWorkerUrl,
      token: AUTH_TOKEN,
      workerId,
      name: 'Abandon Worker',
      workspaces: [],
      autoReconnect: false,
    })

    let handlerSawAbort = false
    let releaseHandler: (() => void) | undefined
    const handlerGate = new Promise<void>(resolve => { releaseHandler = resolve })

    worker.onRequest(async (_req, signal) => {
      signal.addEventListener('abort', () => { handlerSawAbort = true }, { once: true })
      await handlerGate
      return { status: 200, headers: {}, body: JSON.stringify({ ok: true }) }
    })

    await worker.start()

    // Browser starts the call, then drops the connection before the worker answers.
    const client = httpRequest(`${masterHttpUrl}/api/directoryPicker/pick`, { method: 'POST' })
    client.on('error', () => {})
    client.end()
    await vi.waitFor(() => { expect(client.socket).toBeTruthy() })
    client.destroy()

    // The worker observes the cancel instead of being held until the relay timeout.
    await vi.waitFor(() => { expect(handlerSawAbort).toBe(true) }, { timeout: 10_000 })

    releaseHandler?.()
    await worker.stop()
  }, 30_000)

  it('settles an already-abandoned call at once and sends no request frame', async () => {
    // A caller already gone when the call starts must not make the worker serve it, and must
    // not wait out the timeout: it settles as the synthesized 499 the relay expects.
    const sentFrames: string[] = []
    const connection = new WorkerConnection(
      helloFrame('worker-pregone-node', 'Pre-gone'),
      {
        readyState: 1,
        send: (data: string) => { sentFrames.push(data) },
        close: () => {},
      } as unknown as WebSocket,
    )

    const controller = new AbortController()
    controller.abort()

    const startedAt = Date.now()
    const response = await connection.sendHttpRequest(
      { method: 'POST', path: '/api/directoryPicker/pick', headers: {} },
      30_000,
      controller.signal,
    )

    expect(response.status).toBe(499)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(sentFrames.some(frame => frame.includes('"http:req"'))).toBe(false)
  }, 30_000)

  it('settles an abandoned in-flight call as 499, cancels the worker, and detaches', async () => {
    const sentFrames: string[] = []
    const connection = new WorkerConnection(
      helloFrame('worker-abandon-unit', 'Abandon'),
      {
        readyState: 1,
        send: (data: string) => { sentFrames.push(data) },
        close: () => {},
      } as unknown as WebSocket,
    )

    const controller = new AbortController()
    const listenerCount = (): number =>
      (getEventListeners(controller.signal, 'abort') as unknown[]).length

    const pending = connection.sendHttpRequest(
      { method: 'POST', path: '/api/directoryPicker/pick', headers: {} },
      30_000,
      controller.signal,
    )
    expect(listenerCount()).toBe(1)

    controller.abort()
    const response = await pending

    expect(response.status).toBe(499)
    expect(sentFrames.some(frame => frame.includes('"http:cancel"'))).toBe(true)
    expect(listenerCount()).toBe(0)
  }, 30_000)

  it('drops the abort listener when the call completes normally', async () => {
    // Completion must detach too: a caller that reuses one signal would otherwise accumulate
    // a listener for every call that resolved.
    const sentFrames: string[] = []
    const connection = new WorkerConnection(
      helloFrame('worker-complete-unit', 'Complete'),
      {
        readyState: 1,
        send: (data: string) => { sentFrames.push(data) },
        close: () => {},
      } as unknown as WebSocket,
    )

    const controller = new AbortController()
    const listenerCount = (): number =>
      (getEventListeners(controller.signal, 'abort') as unknown[]).length

    const pending = connection.sendHttpRequest(
      { method: 'GET', path: '/api/quick', headers: {} },
      30_000,
      controller.signal,
    )
    expect(listenerCount()).toBe(1)

    const requestFrame = sentFrames.find(frame => frame.includes('"http:req"'))
    expect(requestFrame).toBeTruthy()
    const reqId = JSON.parse(requestFrame as string).reqId as string

    // Answer it the way the tunnel would, with no abort and no timeout involved.
    connection.handleHttpResp({
      type: 'http:resp',
      reqId: reqId as never,
      status: 200,
      headers: {},
      body: undefined,
    })

    const response = await pending
    expect(response.status).toBe(200)
    expect(listenerCount()).toBe(0)
    expect(sentFrames.some(frame => frame.includes('"http:cancel"'))).toBe(false)
  }, 30_000)

  it('drops the abort listener when the call ends by timeout', async () => {
    // The timeout path must detach too, or a caller reusing one long-lived signal accumulates
    // a listener per timed-out call.
    const connection = new WorkerConnection(
      helloFrame('worker-timeout-node', 'Timeout'),
      {
        readyState: 1,
        send: () => {},
        close: () => {},
      } as unknown as WebSocket,
    )

    const controller = new AbortController()
    const listenerCount = (): number =>
      (getEventListeners(controller.signal, 'abort') as unknown[]).length
    expect(listenerCount()).toBe(0)

    await expect(
      connection.sendHttpRequest(
        { method: 'GET', path: '/api/slow', headers: {} },
        50,
        controller.signal,
      ),
    ).rejects.toThrow(/timed out/)

    expect(listenerCount()).toBe(0)
  }, 30_000)

  it('does not write to the departed client when the worker answers late', async () => {
    // The worker may answer after the browser left. The relay must not resurrect the dead
    // response, and must still serve the next caller normally.
    const workerId = 'worker-late-node' as WorkerId
    const worker = new WorkerTunnelClient({
      masterUrl: masterWorkerUrl,
      token: AUTH_TOKEN,
      workerId,
      name: 'Late Worker',
      workspaces: [],
      autoReconnect: false,
    })

    let releaseHandler: (() => void) | undefined
    const handlerGate = new Promise<void>(resolve => { releaseHandler = resolve })
    let handlerEntered = false

    worker.onRequest(async req => {
      handlerEntered = true
      if (req.path === '/api/after-abandon') {
        return { status: 200, headers: {}, body: JSON.stringify({ ok: true }) }
      }
      // Hold the first call open until the browser has already gone.
      await handlerGate
      return { status: 200, headers: {}, body: JSON.stringify({ late: true }) }
    })

    await worker.start()

    const client = httpRequest(`${masterHttpUrl}/api/directoryPicker/pick`, { method: 'POST' })
    client.on('error', () => {})
    client.end()
    await vi.waitFor(() => { expect(client.socket).toBeTruthy() })
    await vi.waitFor(() => { expect(handlerEntered).toBe(true) }, { timeout: 10_000 })
    client.destroy()

    // Let the abandoned call finish now that nobody is listening for it.
    releaseHandler?.()

    // The next caller still gets a real answer: the relay survived the late response.
    const resp = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(`${masterHttpUrl}/api/after-abandon`, { method: 'GET' }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString('utf-8') })
        })
      })
      req.on('error', reject)
      req.end()
    })

    expect(resp.status).toBe(200)
    expect(JSON.parse(resp.body)).toEqual({ ok: true })

    await worker.stop()
  }, 30_000)

  it('relays /api/remote.mux streaming session chunks and completion', async () => {
    const workerId = 'worker-stream-node' as WorkerId
    const worker = new WorkerTunnelClient({
      masterUrl: masterWorkerUrl,
      token: AUTH_TOKEN,
      workerId,
      name: 'Streaming Worker',
      workspaces: [],
      autoReconnect: false,
    })

    // Set up local stream opener on worker that simulates LLM chunks
    const dispatcher = new WorkerStreamDispatcher(
      async (endpoint, payload) => {
        expect(endpoint).toBe('session.follow')
        expect(payload).toEqual({ sessionId: 'session-alpha' })

        return (async function* () {
          yield { type: 'chunk', text: 'Hello' }
          yield { type: 'chunk', text: ' World' }
          yield { type: 'tool_call', name: 'bash', command: 'git status' }
        })()
      },
      frame => worker.send(frame),
    )

    worker.on('frame', frame => void dispatcher.handleFrame(frame))
    await worker.start()

    // Browser connects to /api/remote.mux WebSocket on Master
    const browserWs = new WebSocket(masterMuxWsUrl)
    await new Promise(resolve => browserWs.on('open', resolve))

    const receivedMessages: Array<{ type: string; streamId: string; value?: unknown }> = []
    const streamDone = new Promise<void>(resolve => {
      browserWs.on('message', raw => {
        const msg = JSON.parse(raw.toString('utf-8'))
        receivedMessages.push(msg)
        if (msg.type === 'end') {
          resolve()
        }
      })
    })

    // Browser initiates session.follow
    browserWs.send(JSON.stringify({
      type: 'open',
      streamId: 'stream-follow-001',
      endpoint: 'session.follow',
      payload: { sessionId: 'session-alpha' },
    }))

    await streamDone

    expect(receivedMessages).toHaveLength(4)
    expect(receivedMessages[0]).toEqual({
      type: 'item',
      streamId: 'stream-follow-001',
      value: { type: 'chunk', text: 'Hello' },
    })
    expect(receivedMessages[1]).toEqual({
      type: 'item',
      streamId: 'stream-follow-001',
      value: { type: 'chunk', text: ' World' },
    })
    expect(receivedMessages[2]).toEqual({
      type: 'item',
      streamId: 'stream-follow-001',
      value: { type: 'tool_call', name: 'bash', command: 'git status' },
    })
    expect(receivedMessages[3]).toEqual({
      type: 'end',
      streamId: 'stream-follow-001',
    })

    browserWs.close()
    dispatcher.close()
    await worker.stop()
  })

  it('relays interactive uplink (e.g. terminal / waterfall input)', async () => {
    const workerId = 'worker-uplink-node' as WorkerId
    const worker = new WorkerTunnelClient({
      masterUrl: masterWorkerUrl,
      token: AUTH_TOKEN,
      workerId,
      name: 'Uplink Worker',
      workspaces: [],
      autoReconnect: false,
    })

    // Stream opener that echoes uplink items to downlink
    const dispatcher = new WorkerStreamDispatcher(
      async (endpoint, _payload, uplink) => {
        expect(endpoint).toBe('terminal.stream')
        return (async function* () {
          for await (const input of uplink) {
            yield { echo: input }
            if (input === 'exit') break
          }
        })()
      },
      frame => worker.send(frame),
    )

    worker.on('frame', frame => void dispatcher.handleFrame(frame))
    await worker.start()

    const browserWs = new WebSocket(masterMuxWsUrl)
    await new Promise(resolve => browserWs.on('open', resolve))

    const echoes: unknown[] = []
    const done = new Promise<void>(resolve => {
      browserWs.on('message', raw => {
        const msg = JSON.parse(raw.toString('utf-8'))
        if (msg.type === 'item') {
          echoes.push(msg.value)
        } else if (msg.type === 'end') {
          resolve()
        }
      })
    })

    // Browser opens terminal stream
    browserWs.send(JSON.stringify({
      type: 'open',
      streamId: 'term-stream-001',
      endpoint: 'terminal.stream',
    }))

    // Wait a tick for stream to establish
    await new Promise(resolve => setTimeout(resolve, 50))

    // Browser sends keystrokes
    browserWs.send(JSON.stringify({
      type: 'item',
      streamId: 'term-stream-001',
      value: 'ls -la',
    }))

    browserWs.send(JSON.stringify({
      type: 'item',
      streamId: 'term-stream-001',
      value: 'exit',
    }))

    await done

    expect(echoes).toEqual([
      { echo: 'ls -la' },
      { echo: 'exit' },
    ])

    browserWs.close()
    dispatcher.close()
    await worker.stop()
  })
})
