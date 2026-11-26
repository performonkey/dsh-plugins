import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { WorkerId } from '@deepseek-ai/dsh-cluster-protocol'
import { ClusterWorkerService } from '../src/plugin.ts'

/**
 * Drives the shipped service through a real tunnel and a real provider behind
 * the shared fetch handler, so deleting the signal forwarding in the plugin
 * turns this red instead of passing on a hand-written handler.
 */
describe('cluster worker composition with a shared fetch handler', () => {
  let ctx: Context | undefined
  let server: WebSocketServer | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
    if (server) {
      const closing = server
      server = undefined
      await new Promise<void>((resolve, reject) => closing.close(error => error ? reject(error) : resolve()))
    }
  })

  it('propagates tunnel cancellation to the provider and waits for teardown', async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (typeof address === 'string' || address === null) throw new Error('expected TCP address')

    let entered!: () => void
    const admitted = new Promise<void>(resolve => { entered = resolve })
    let aborted!: () => void
    const cancelled = new Promise<void>(resolve => { aborted = resolve })
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    let providerDone = false

    const received: Request[] = []
    ctx = new Context()
    ctx.provide('typertGateway', {})
    ctx.provide('connection', {
      createSharedFetchHandler: () => ({
        fetch: async (request: Request): Promise<Response> => {
          received.push(request)
          entered()
          await new Promise<void>(resolve => request.signal.addEventListener('abort', () => { aborted(); resolve() }, { once: true }))
          await barrier
          providerDone = true
          return new Response(JSON.stringify({ error: 'gateway/cancelled' }), { status: 499 })
        },
      }),
    })

    const service = new ClusterWorkerService(ctx, {
      masterUrl: `ws://127.0.0.1:${address.port}`,
      authToken: 'test',
      workerId: 'worker' as WorkerId,
      name: 'worker',
      workspaces: [],
      autoReconnect: false,
    })
    expect(service.client).toBeDefined()

    const connection = once(server, 'connection')
    // The service starts on its own effect mount; reconnect stays off so the
    // tunnel under test is the only one that can admit the request.
    const [socket] = await connection
    socket.send(JSON.stringify({ type: 'control:ready', accepted: true, masterTime: 0 }))
    await new Promise<void>(resolve => setImmediate(resolve))

    socket.send(JSON.stringify({ type: 'http:req', reqId: 'pick', method: 'POST', path: '/api/directoryPicker/pick', body: '{}' }))
    await admitted
    expect(received).toHaveLength(1)
    expect(received[0]!.signal.aborted).toBe(false)

    socket.send(JSON.stringify({ type: 'http:cancel', reqId: 'pick' }))
    await cancelled
    expect(received[0]!.signal.aborted).toBe(true)

    let disposed = false
    const disposing = ctx.fiber.dispose().then(() => { disposed = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(disposed).toBe(false)

    release()
    await disposing
    expect(disposed).toBe(true)
    expect(providerDone).toBe(true)
  })
})
