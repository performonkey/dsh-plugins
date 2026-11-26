import { createServer, type Server } from 'node:http'
import { WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkerId } from '@deepseek-ai/dsh-cluster-protocol'
import { WorkerRegistry } from '../src/index.ts'
import { WorkerTunnelClient } from '../../cluster-worker/src/index.ts'

describe('Cluster Master-Worker Reverse Tunnel E2E', () => {
  let httpServer: Server
  let wss: WebSocketServer
  let registry: WorkerRegistry
  let port: number
  let masterUrl: string
  const AUTH_TOKEN = 'test-cluster-token-xyz'

  beforeEach(async () => {
    httpServer = createServer()
    wss = new WebSocketServer({ noServer: true })

    registry = new WorkerRegistry({
      authToken: AUTH_TOKEN,
      heartbeatIntervalMs: 500, // Fast interval for testing
      maxMissedPongs: 2,
    })

    httpServer.on('upgrade', (req, socket, head) => {
      if (req.url === '/api/worker/connect') {
        wss.handleUpgrade(req, socket, head, ws => {
          registry.handleConnection(ws)
        })
      } else {
        socket.destroy()
      }
    })

    await new Promise<void>(resolve => {
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address()
        if (typeof addr === 'object' && addr !== null) {
          port = addr.port
          masterUrl = `ws://127.0.0.1:${port}/api/worker/connect`
        }
        resolve()
      })
    })
  })

  afterEach(async () => {
    await registry.close()
    wss.close()
    await new Promise<void>(resolve => httpServer.close(() => resolve()))
  })

  it('authenticates, registers worker, and lists it', async () => {
    const workerId = 'worker-node-alpha' as WorkerId
    const client = new WorkerTunnelClient({
      masterUrl,
      token: AUTH_TOKEN,
      workerId,
      name: 'Alpha Worker',
      workspaces: ['/repo/deepseek-harness'],
      autoReconnect: false,
    })

    await client.start()
    expect(client.connected).toBe(true)

    const workers = registry.getWorkers()
    expect(workers).toHaveLength(1)
    expect(workers[0]!.id).toBe(workerId)
    expect(workers[0]!.name).toBe('Alpha Worker')
    expect(workers[0]!.workspaces).toEqual(['/repo/deepseek-harness'])

    await client.stop()
  })

  it('rejects worker with invalid authentication token', async () => {
    const client = new WorkerTunnelClient({
      masterUrl,
      token: 'WRONG_TOKEN',
      workerId: 'worker-node-bad' as WorkerId,
      name: 'Bad Worker',
      workspaces: [],
      autoReconnect: false,
    })

    await expect(client.start()).rejects.toThrow(/rejected by master/i)
    expect(registry.getWorkers()).toHaveLength(0)
    await client.stop()
  })

  it('relays HTTP request from master to worker and receives response', async () => {
    const workerId = 'worker-node-rpc' as WorkerId
    const client = new WorkerTunnelClient({
      masterUrl,
      token: AUTH_TOKEN,
      workerId,
      name: 'RPC Worker',
      workspaces: ['/work'],
      autoReconnect: false,
    })

    client.onRequest(async req => {
      expect(req.method).toBe('POST')
      expect(req.path).toBe('/api/session/create')
      const body = JSON.parse(req.body ?? '{}')
      expect(body.title).toBe('Distributed Task')

      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true, sessionId: 'session-distributed-999' }),
      }
    })

    await client.start()

    const resp = await registry.sendHttpRequest(workerId, {
      method: 'POST',
      path: '/api/session/create',
      body: JSON.stringify({ title: 'Distributed Task' }),
    })

    expect(resp.status).toBe(200)
    expect(resp.headers?.['content-type']).toBe('application/json')
    const respBody = JSON.parse(resp.body ?? '{}')
    expect(respBody.sessionId).toBe('session-distributed-999')

    await client.stop()
  })

  it('responds to heartbeat pings and keeps connection alive', async () => {
    const workerId = 'worker-node-heartbeat' as WorkerId
    const client = new WorkerTunnelClient({
      masterUrl,
      token: AUTH_TOKEN,
      workerId,
      name: 'Heartbeat Worker',
      workspaces: [],
      autoReconnect: false,
    })

    await client.start()
    const workerConn = registry.getWorker(workerId)
    expect(workerConn).toBeDefined()

    // Wait for at least 2 heartbeat cycles (heartbeatIntervalMs is 500ms)
    await new Promise(resolve => setTimeout(resolve, 1200))

    expect(client.connected).toBe(true)
    expect(registry.getWorkers()).toHaveLength(1)
    expect(workerConn?.missedPongs).toBe(0)

    await client.stop()
  })
})
