import { createServer, request as httpRequest, type Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkerId } from '@deepseek-ai/dsh-cluster-protocol'
import { MasterRelay, WorkerRegistry } from '../src/index.ts'
import { WorkerStreamDispatcher, WorkerTunnelClient } from '../../cluster-worker/src/index.ts'

describe('Cluster Seams End-to-End Integration (Milestone 3 & 4)', () => {
  let server: Server
  let workerWss: WebSocketServer
  let registry: WorkerRegistry
  let relay: MasterRelay
  let port: number
  let masterWorkerUrl: string
  let masterHttpUrl: string
  let masterMuxWsUrl: string
  const AUTH_TOKEN = 'test-seams-token'

  beforeEach(async () => {
    server = createServer()
    workerWss = new WebSocketServer({ noServer: true })

    registry = new WorkerRegistry({
      authToken: AUTH_TOKEN,
      heartbeatIntervalMs: 500,
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

  it('relays remote Directory Picker listing from worker filesystem to browser', async () => {
    const workerId = 'worker-fs-node' as WorkerId
    const worker = new WorkerTunnelClient({
      masterUrl: masterWorkerUrl,
      token: AUTH_TOKEN,
      workerId,
      name: 'Filesystem Worker',
      workspaces: ['/home/dev/my-project'],
      autoReconnect: false,
    })

    // Worker handles DirectoryPickerController list request
    worker.onRequest(async req => {
      expect(req.path).toBe('/api/directoryPicker/list')
      const body = JSON.parse(req.body ?? '{}')
      expect(body.path).toBe('/home/dev/my-project')

      // Emulate worker DirectoryListing response
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: '/home/dev/my-project',
          entries: [
            { name: 'src', path: '/home/dev/my-project/src', isDirectory: true, hidden: false },
            { name: 'package.json', path: '/home/dev/my-project/package.json', isDirectory: false, hidden: false },
            { name: 'README.md', path: '/home/dev/my-project/README.md', isDirectory: false, hidden: false },
          ],
        }),
      }
    })

    await worker.start()

    // Browser queries Master /api/directoryPicker/list
    const postData = JSON.stringify({ path: '/home/dev/my-project' })
    const resp = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const clientReq = httpRequest(
        `${masterHttpUrl}/api/directoryPicker/list`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(postData),
          },
        },
        res => {
          let data = ''
          res.on('data', chunk => { data += chunk })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
        },
      )
      clientReq.on('error', reject)
      clientReq.write(postData)
      clientReq.end()
    })

    expect(resp.status).toBe(200)
    const listing = JSON.parse(resp.body)
    expect(listing.path).toBe('/home/dev/my-project')
    expect(listing.entries).toHaveLength(3)
    expect(listing.entries[0].name).toBe('src')

    await worker.stop()
  })

  it('relays interactive PTY terminal session with bidirectional streaming and resize', async () => {
    const workerId = 'worker-pty-node' as WorkerId
    const worker = new WorkerTunnelClient({
      masterUrl: masterWorkerUrl,
      token: AUTH_TOKEN,
      workerId,
      name: 'PTY Worker',
      workspaces: [],
      autoReconnect: false,
    })

    const terminalInputs: unknown[] = []

    // Terminal stream dispatcher on worker
    const dispatcher = new WorkerStreamDispatcher(
      async (endpoint, payload, uplink) => {
        expect(endpoint).toBe('terminal.attach')
        expect((payload as any).cols).toBe(80)
        expect((payload as any).rows).toBe(24)

        return (async function* () {
          // Send initial PTY prompt
          yield { type: 'data', text: 'user@remote-worker:~$ ' }

          for await (const input of uplink) {
            terminalInputs.push(input)
            const cmd = (input as any)?.command ?? input
            if (cmd === 'ls') {
              yield { type: 'data', text: 'src/  package.json\r\nuser@remote-worker:~$ ' }
            } else if ((input as any)?.type === 'resize') {
              yield { type: 'ack', cols: (input as any).cols, rows: (input as any).rows }
            } else if (cmd === 'exit') {
              yield { type: 'exit', code: 0 }
              break
            }
          }
        })()
      },
      frame => worker.send(frame),
    )

    worker.on('frame', frame => void dispatcher.handleFrame(frame))
    await worker.start()

    // Browser connects to Master Mux WebSocket
    const browserWs = new WebSocket(masterMuxWsUrl)
    await new Promise(resolve => browserWs.on('open', resolve))

    const termOutputs: unknown[] = []
    const termExited = new Promise<void>(resolve => {
      browserWs.on('message', raw => {
        const msg = JSON.parse(raw.toString('utf-8'))
        if (msg.type === 'item') {
          termOutputs.push(msg.value)
        } else if (msg.type === 'end') {
          resolve()
        }
      })
    })

    // 1. Browser attaches to terminal
    browserWs.send(JSON.stringify({
      type: 'open',
      streamId: 'pty-stream-001',
      endpoint: 'terminal.attach',
      payload: { cols: 80, rows: 24 },
    }))

    // Wait for initial prompt
    await new Promise(resolve => setTimeout(resolve, 50))

    // 2. Browser executes 'ls'
    browserWs.send(JSON.stringify({
      type: 'item',
      streamId: 'pty-stream-001',
      value: { command: 'ls' },
    }))

    // 3. Browser resizes terminal window
    browserWs.send(JSON.stringify({
      type: 'item',
      streamId: 'pty-stream-001',
      value: { type: 'resize', cols: 120, rows: 40 },
    }))

    // 4. Browser sends exit
    browserWs.send(JSON.stringify({
      type: 'item',
      streamId: 'pty-stream-001',
      value: { command: 'exit' },
    }))

    await termExited

    expect(termOutputs).toContainEqual({ type: 'data', text: 'user@remote-worker:~$ ' })
    expect(termOutputs).toContainEqual({ type: 'data', text: 'src/  package.json\r\nuser@remote-worker:~$ ' })
    expect(termOutputs).toContainEqual({ type: 'ack', cols: 120, rows: 40 })
    expect(termOutputs).toContainEqual({ type: 'exit', code: 0 })

    browserWs.close()
    dispatcher.close()
    await worker.stop()
  })

  it('returns structured 503 error when worker is offline and recovers upon reconnection', async () => {
    // 1. Request when no worker is connected
    const resp1 = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const clientReq = httpRequest(
        `${masterHttpUrl}/api/session/create`,
        { method: 'POST', headers: { 'content-type': 'application/json' } },
        res => {
          let data = ''
          res.on('data', chunk => { data += chunk })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
        },
      )
      clientReq.on('error', reject)
      clientReq.end()
    })

    expect(resp1.status).toBe(503)
    const errBody = JSON.parse(resp1.body)
    expect(errBody.error).toBe('No worker available to serve request')

    // 2. Worker connects
    const worker = new WorkerTunnelClient({
      masterUrl: masterWorkerUrl,
      token: AUTH_TOKEN,
      workerId: 'worker-reconnect' as WorkerId,
      name: 'Reconnect Worker',
      workspaces: [],
      autoReconnect: false,
    })

    worker.onRequest(async () => {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-online-123' }),
      }
    })

    await worker.start()

    // 3. Request succeeds immediately
    const resp2 = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const clientReq = httpRequest(
        `${masterHttpUrl}/api/session/create`,
        { method: 'POST', headers: { 'content-type': 'application/json' } },
        res => {
          let data = ''
          res.on('data', chunk => { data += chunk })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
        },
      )
      clientReq.on('error', reject)
      clientReq.end()
    })

    expect(resp2.status).toBe(200)
    const successBody = JSON.parse(resp2.body)
    expect(successBody.sessionId).toBe('session-online-123')

    await worker.stop()
  })
})
