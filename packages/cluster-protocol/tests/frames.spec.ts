import { describe, expect, it } from 'vitest'
import {
  parseClusterFrame,
  serializeClusterFrame,
  isControlHelloFrame,
  isControlReadyFrame,
  isHttpReqFrame,
  isHttpRespFrame,
  type ControlHelloFrame,
  type ControlReadyFrame,
  type HttpReqFrame,
  type HttpRespFrame,
  type PingFrame,
  type PongFrame,
  type StreamOpenFrame,
  type StreamItemFrame,
  type StreamUplinkFrame,
  type StreamCloseFrame,
  type WorkerId,
  type TunnelRequestId,
  type TunnelStreamId,
} from '../src/index.ts'

describe('cluster protocol frames', () => {
  it('serializes and parses control:hello frame', () => {
    const frame: ControlHelloFrame = {
      type: 'control:hello',
      token: 'secret-token-123',
      workerId: 'worker-node-1' as WorkerId,
      name: 'Local Dev Machine',
      workspaces: ['/home/user/project1', '/home/user/project2'],
      version: '0.2.2',
      timestamp: 1730419200000,
    }

    const serialized = serializeClusterFrame(frame)
    const parsed = parseClusterFrame(serialized)

    expect(parsed).toEqual(frame)
    expect(parsed && isControlHelloFrame(parsed)).toBe(true)
  })

  it('serializes and parses control:ready frame', () => {
    const frame: ControlReadyFrame = {
      type: 'control:ready',
      accepted: true,
      masterTime: 1730419201000,
    }

    const serialized = serializeClusterFrame(frame)
    const parsed = parseClusterFrame(serialized)

    expect(parsed).toEqual(frame)
    expect(parsed && isControlReadyFrame(parsed)).toBe(true)
  })

  it('serializes and parses ping and pong frames', () => {
    const ping: PingFrame = { type: 'ping', timestamp: 1000 }
    const pong: PongFrame = { type: 'pong', timestamp: 1001 }

    expect(parseClusterFrame(serializeClusterFrame(ping))).toEqual(ping)
    expect(parseClusterFrame(serializeClusterFrame(pong))).toEqual(pong)
  })

  it('serializes and parses http:req and http:resp frames', () => {
    const req: HttpReqFrame = {
      type: 'http:req',
      reqId: 'req-abc-123' as TunnelRequestId,
      method: 'POST',
      path: '/api',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'session.list' }),
    }

    const resp: HttpRespFrame = {
      type: 'http:resp',
      reqId: 'req-abc-123' as TunnelRequestId,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, sessions: [] }),
    }

    const parsedReq = parseClusterFrame(serializeClusterFrame(req))
    const parsedResp = parseClusterFrame(serializeClusterFrame(resp))

    expect(parsedReq).toEqual(req)
    expect(parsedReq && isHttpReqFrame(parsedReq)).toBe(true)
    expect(parseClusterFrame(JSON.stringify({ type: 'http:cancel', reqId: req.reqId }))).toEqual({ type: 'http:cancel', reqId: req.reqId })
    expect(parseClusterFrame(JSON.stringify({ type: 'http:cancel' }))).toBeUndefined()
    expect(parsedResp).toEqual(resp)
    expect(parsedResp && isHttpRespFrame(parsedResp)).toBe(true)
  })

  it('serializes and parses stream frames', () => {
    const open: StreamOpenFrame = {
      type: 'stream:open',
      streamId: 'stream-1' as TunnelStreamId,
      endpoint: 'session.follow',
      payload: { sessionId: 's1' },
    }
    const item: StreamItemFrame = {
      type: 'stream:item',
      streamId: 'stream-1' as TunnelStreamId,
      value: { chunk: 'Hello' },
    }
    const uplink: StreamUplinkFrame = {
      type: 'stream:uplink',
      streamId: 'stream-1' as TunnelStreamId,
      item: { input: 'ls -la\n' },
    }
    const close: StreamCloseFrame = {
      type: 'stream:close',
      streamId: 'stream-1' as TunnelStreamId,
      reason: 'completed',
    }

    expect(parseClusterFrame(serializeClusterFrame(open))).toEqual(open)
    expect(parseClusterFrame(serializeClusterFrame(item))).toEqual(item)
    expect(parseClusterFrame(serializeClusterFrame(uplink))).toEqual(uplink)
    expect(parseClusterFrame(serializeClusterFrame(close))).toEqual(close)
  })

  it('returns undefined for invalid payloads', () => {
    expect(parseClusterFrame('not-json')).toBeUndefined()
    expect(parseClusterFrame(null)).toBeUndefined()
    expect(parseClusterFrame(123)).toBeUndefined()
    expect(parseClusterFrame('{}')).toBeUndefined()
    expect(parseClusterFrame(JSON.stringify({ type: 'unknown:type' }))).toBeUndefined()
    expect(parseClusterFrame(JSON.stringify({ type: 'control:hello', token: 123 }))).toBeUndefined()
  })

  it('accepts Buffer inputs', () => {
    const ping: PingFrame = { type: 'ping', timestamp: 12345 }
    const buf = Buffer.from(serializeClusterFrame(ping))
    expect(parseClusterFrame(buf)).toEqual(ping)
  })
})
