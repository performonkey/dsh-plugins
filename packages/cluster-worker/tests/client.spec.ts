import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import type { WorkerId } from '@deepseek-ai/dsh-cluster-protocol'
import { WorkerTunnelClient } from '../src/client.ts'

describe('worker HTTP request lifetime', () => {
  it('waits for aborted handler cleanup before stopping', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (typeof address === 'string' || address === null) throw new Error('expected TCP address')
    const client = new WorkerTunnelClient({ masterUrl: `ws://127.0.0.1:${address.port}`, token: 'test',
      workerId: 'worker' as WorkerId, name: 'worker', workspaces: [], autoReconnect: false })
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const admitted = new Promise<void>(resolve => { entered = resolve })
    let aborted!: () => void
    const cancellation = new Promise<void>(resolve => { aborted = resolve })
    client.onRequest(async (_req, signal) => {
      entered()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted(); resolve() }, { once: true }))
      await barrier
      return { status: 499 }
    })
    try {
      const connection = once(server, 'connection')
      const started = client.start()
      const [socket] = await connection
      socket.send(JSON.stringify({ type: 'control:ready', accepted: true, masterTime: 0 }))
      await started
      socket.send(JSON.stringify({ type: 'http:req', reqId: 'held', method: 'POST', path: '/api/directoryPicker/pick' }))
      await admitted
      let stopped = false
      const stopping = client.stop().then(() => { stopped = true })
      await cancellation
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(stopped).toBe(false)
      release()
      await stopping
      expect(stopped).toBe(true)
    } finally {
      release()
      await client.stop()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('aborts an outstanding operation on cancellation and socket close', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (typeof address === 'string' || address === null) throw new Error('expected TCP address')
    const client = new WorkerTunnelClient({ masterUrl: `ws://127.0.0.1:${address.port}`, token: 'test',
      workerId: 'worker' as WorkerId, name: 'worker', workspaces: [], autoReconnect: false })
    const signals: AbortSignal[] = []
    let entered: (() => void) | undefined
    client.onRequest((_req, signal) => new Promise(resolve => {
      signals.push(signal)
      entered?.()
      signal.addEventListener('abort', () => resolve({ status: 499 }), { once: true })
    }))
    try {
      const connection = once(server, 'connection')
      const started = client.start()
      const [socket] = await connection
      socket.send(JSON.stringify({ type: 'control:ready', accepted: true, masterTime: 0 }))
      await started
      const dispatch = async (id: string): Promise<void> => {
        const ready = new Promise<void>(resolve => { entered = resolve })
        socket.send(JSON.stringify({ type: 'http:req', reqId: id, method: 'POST', path: '/api/directoryPicker/pick' }))
        await ready
      }
      await dispatch('one')
      const aborted = new Promise<void>(resolve => signals[0]!.addEventListener('abort', () => resolve(), { once: true }))
      socket.send(JSON.stringify({ type: 'http:cancel', reqId: 'one' }))
      await aborted
      expect(signals[0]!.aborted).toBe(true)
      await dispatch('two')
      const closed = new Promise<void>(resolve => signals[1]!.addEventListener('abort', () => resolve(), { once: true }))
      socket.close()
      await closed
      expect(signals[1]!.aborted).toBe(true)
    } finally {
      await client.stop()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('ignores a stale socket close when a newer connection owns the requests', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (typeof address === 'string' || address === null) throw new Error('expected TCP address')
    const client = new WorkerTunnelClient({ masterUrl: `ws://127.0.0.1:${address.port}`, token: 'test',
      workerId: 'worker' as WorkerId, name: 'worker', workspaces: [], autoReconnect: false })
    const signals: AbortSignal[] = []
    let entered: (() => void) | undefined
    client.onRequest((_req, signal) => new Promise(resolve => {
      signals.push(signal)
      entered?.()
      signal.addEventListener('abort', () => resolve({ status: 499 }), { once: true })
    }))
    const sockets: import('ws').WebSocket[] = []
    server.on('connection', socket => { sockets.push(socket) })
    try {
      // A reconnects without being stopped first, which leaves the superseded
      // tunnel open alongside the new one: its close lands only afterwards.
      const firstConnection = once(server, 'connection')
      const firstStarted = client.start()
      const [socketA] = await firstConnection
      socketA.send(JSON.stringify({ type: 'control:ready', accepted: true, masterTime: 0 }))
      await firstStarted

      // A carries a request of its own, admitted while it is still current, so
      // its later close has a cancellable target of its own generation.
      const stranded = new Promise<void>(resolve => { entered = resolve })
      socketA.send(JSON.stringify({ type: 'http:req', reqId: 'stranded', method: 'POST', path: '/api/directoryPicker/pick' }))
      await stranded
      expect(signals).toHaveLength(1)

      const secondConnection = once(server, 'connection')
      const secondStarted = client.start()
      const [socketB] = await secondConnection
      socketB.send(JSON.stringify({ type: 'control:ready', accepted: true, masterTime: 0 }))
      await secondStarted
      expect(sockets).toHaveLength(2)

      const ready = new Promise<void>(resolve => { entered = resolve })
      socketB.send(JSON.stringify({ type: 'http:req', reqId: 'fresh', method: 'POST', path: '/api/directoryPicker/pick' }))
      await ready
      expect(signals).toHaveLength(2)
      expect(signals[1]!.aborted).toBe(false)

      socketA.close()
      await once(socketA, 'close')
      // A's close aborts only its own generation's work, so observing that abort
      // proves the stale callback has run; the newer request must survive it.
      await vi.waitFor(() => { expect(signals[0]!.aborted).toBe(true) })
      expect(signals[1]!.aborted).toBe(false)
    } finally {
      await client.stop()
      for (const socket of sockets) socket.terminate()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('closes and drains every superseded tunnel on stop', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (typeof address === 'string' || address === null) throw new Error('expected TCP address')
    const client = new WorkerTunnelClient({ masterUrl: `ws://127.0.0.1:${address.port}`, token: 'test',
      workerId: 'worker' as WorkerId, name: 'worker', workspaces: [], autoReconnect: false })
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const entered: Array<() => void> = []
    const admitted = (index: number): Promise<void> => new Promise(resolve => { entered[index] = resolve })
    const signals: AbortSignal[] = []
    client.onRequest(async (_req, signal) => {
      signals.push(signal)
      entered[signals.length - 1]!()
      await barrier
      return { status: 200 }
    })
    const sockets: import('ws').WebSocket[] = []
    server.on('connection', socket => { sockets.push(socket) })
    try {
      const firstConnection = once(server, 'connection')
      const firstStarted = client.start()
      const [socketA] = await firstConnection
      socketA.send(JSON.stringify({ type: 'control:ready', accepted: true, masterTime: 0 }))
      await firstStarted

      // The stranded handler is admitted while A is still the current socket,
      // because a superseded socket's frames are ignored outright; only work
      // already running on it can outlive the reconnect.
      const stranded = admitted(0)
      socketA.send(JSON.stringify({ type: 'http:req', reqId: 'stranded', method: 'POST', path: '/api/directoryPicker/pick' }))
      await stranded

      const secondConnection = once(server, 'connection')
      const secondStarted = client.start()
      const [socketB] = await secondConnection
      socketB.send(JSON.stringify({ type: 'control:ready', accepted: true, masterTime: 0 }))
      await secondStarted

      const live = admitted(1)
      socketB.send(JSON.stringify({ type: 'http:req', reqId: 'live', method: 'POST', path: '/api/directoryPicker/pick' }))
      await live

      let stopped = false
      const stopping = client.stop().then(() => { stopped = true })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(signals).toHaveLength(2)
      expect(signals[0]!.aborted).toBe(true)
      expect(signals[1]!.aborted).toBe(true)
      // Both handlers still owe a response, so stop must keep waiting.
      expect(stopped).toBe(false)

      release()
      await stopping
      expect(stopped).toBe(true)
      expect(socketA.readyState).toBeGreaterThan(1)
      expect(socketB.readyState).toBeGreaterThan(1)
    } finally {
      release()
      await client.stop()
      for (const socket of sockets) socket.terminate()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
