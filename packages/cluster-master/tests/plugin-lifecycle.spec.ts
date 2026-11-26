import { createServer, request as httpRequest, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClusterMasterService } from '../src/index.ts'
import { ClusterWorkerService } from '../../cluster-worker/src/index.ts'

describe('Cluster Master & Worker Cordis Plugins Lifecycle', () => {
  let masterCtx: Context
  let workerCtx: Context
  let masterService: ClusterMasterService | undefined
  let workerService: ClusterWorkerService | undefined
  let httpServer: Server
  let port: number
  let masterUrl: string
  const AUTH_TOKEN = 'lifecycle-token-456'

  beforeEach(async () => {
    httpServer = createServer()

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

    // Mock WebServer on Master Context
    masterCtx = new Context()
    const routes: Array<{ path: string; handler: (req: any, res: any) => void }> = []
    const upgradeRoutes: Array<{ path: string; handler: (req: any, socket: any, head: any) => void }> = []

    masterCtx.provide('webServer', {
      register: (route: { path: string; handler: any }) => {
        routes.push(route)
        return () => {
          const idx = routes.indexOf(route)
          if (idx >= 0) routes.splice(idx, 1)
        }
      },
      registerUpgrade: (route: { path: string; handler: any }) => {
        upgradeRoutes.push(route)
        return () => {
          const idx = upgradeRoutes.indexOf(route)
          if (idx >= 0) upgradeRoutes.splice(idx, 1)
        }
      },
    })

    httpServer.on('request', (req, res) => {
      for (const route of routes) {
        if (req.url?.startsWith(route.path)) {
          route.handler(req, res)
          return
        }
      }
      res.writeHead(404).end()
    })

    httpServer.on('upgrade', (req, socket, head) => {
      for (const route of upgradeRoutes) {
        if (req.url === route.path) {
          route.handler(req, socket, head)
          return
        }
      }
      socket.destroy()
    })
  })

  afterEach(async () => {
    workerService?.dispose()
    masterService?.dispose()
    if ('closeAllConnections' in httpServer) {
      (httpServer as any).closeAllConnections()
    }
    await new Promise<void>(resolve => httpServer.close(() => resolve()))
  })

  it('mounts master and worker plugins and relays requests seamlessly', async () => {
    // 1. Mount Master plugin
    masterService = new ClusterMasterService(masterCtx, {
      authToken: AUTH_TOKEN,
      heartbeatIntervalMs: 500,
    })

    expect(masterService.registry).toBeDefined()

    // 2. Mock services on Worker Context
    workerCtx = new Context()
    workerCtx.provide('typertGateway', {
      wireStream: {
        open: async (endpoint: string, payload: any) => {
          return (async function* () {
            yield { fromEndpoint: endpoint, payload }
          })()
        },
        failure: (err: any) => err,
      },
    })

    workerCtx.provide('connection', {
      browserPeer: { id: 'peer-1', principal: { kind: 'owner' } },
      createSharedFetchHandler: () => ({
        fetch: async (request: Request) => {
          const body = await request.text()
          return new Response(JSON.stringify({ receivedUrl: request.url, body }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
      }),
    })

    // 3. Mount Worker plugin
    workerService = new ClusterWorkerService(workerCtx, {
      masterUrl,
      authToken: AUTH_TOKEN,
      workerId: 'worker-cordis-1',
      name: 'Cordis Worker Node',
      autoReconnect: false,
    })

    // Wait for connection to establish
    await new Promise(resolve => setTimeout(resolve, 300))

    const onlineWorkers = masterService.registry.getWorkers()
    expect(onlineWorkers).toHaveLength(1)
    expect(onlineWorkers[0]!.id).toBe('worker-cordis-1')

    // 4. Send HTTP request to Master WebServer
    const postData = JSON.stringify({ action: 'create-session' })
    const resp = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        `http://127.0.0.1:${port}/api/session`,
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
    expect(json.body).toBe(postData)
    expect(json.receivedUrl).toBe('http://dsh.internal/api/session')
  })

  it('disables master token authentication when configured', () => {
    const testMasterCtx = new Context()
    testMasterCtx.provide('webServer', {
      register: () => () => {},
      registerUpgrade: () => () => {},
    })

    const mockBrowserPeer = { id: 'test-browser-peer', principal: { kind: 'owner' }, dispose: () => Promise.resolve() }
    const mockConnection: any = {
      browserPeer: mockBrowserPeer,
      authorizeIndex: () => false,
      admit: () => ({ rejection: 401 }),
      admitConnection: () => ({ rejection: 401 }),
      requestRejection: () => 401,
      authenticatedUrl: (url: string) => `${url}?token=12345`,
    }

    testMasterCtx.provide('connection', mockConnection)

    const service = new ClusterMasterService(testMasterCtx, {
      authToken: 'token',
      disableTokenAuth: true,
    })

    expect(mockConnection.authorizeIndex({} as any, {} as any)).toBe(true)
    expect(mockConnection.admit({} as any)).toEqual({ peer: mockBrowserPeer })
    expect(mockConnection.admitConnection({} as any)).toMatchObject({ peer: mockBrowserPeer })
    expect(mockConnection.requestRejection({} as any)).toBeUndefined()
    expect(mockConnection.authenticatedUrl('http://dsh.example/')).toBe('http://dsh.example/')

    service.dispose()
  })
})
