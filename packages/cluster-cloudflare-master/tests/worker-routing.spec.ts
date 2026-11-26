import { describe, expect, it } from 'vitest'
import worker from '../src/index.ts'
import type { Env } from '../src/types.ts'

describe('Cloudflare Worker Top-level Router', () => {
  const mockStub = {
    fetch: async (req: Request | string) => {
      const url = typeof req === 'string' ? req : req.url
      return new Response(`Routed to DO: ${url}`, { status: 200 })
    },
  }

  const mockEnv: Env = {
    CLUSTER_MASTER_DO: {
      idFromName: () => ({ toString: () => 'global-id' }),
      get: () => mockStub as any,
    },
    BASIC_AUTH_USER: 'testuser',
    BASIC_AUTH_PASS: 'testpass',
  }

  it('exempts /api/worker/connect from Basic Auth', async () => {
    const req = new Request('https://dsh.example/api/worker/connect')
    const resp = await worker.fetch(req, mockEnv, {})
    expect(resp.status).toBe(200)
    const text = await resp.text()
    expect(text).toContain('Routed to DO: https://dsh.example/api/worker/connect')
  })

  it('requires Basic Auth for index.html when credentials are set', async () => {
    const req = new Request('https://dsh.example/')
    const resp = await worker.fetch(req, mockEnv, {})
    expect(resp.status).toBe(401)
    expect(resp.headers.get('www-authenticate')).toContain('Basic')
  })

  it('allows index.html when valid Basic Auth credentials are provided', async () => {
    const auth = Buffer.from('testuser:testpass').toString('base64')
    const req = new Request('https://dsh.example/', {
      headers: { Authorization: `Basic ${auth}` },
    })
    const resp = await worker.fetch(req, mockEnv, {})
    expect(resp.status).toBe(200)
    const text = await resp.text()
    expect(text).toContain('Routed to DO')
  })

  it('renders landing guide when index.html is requested with no worker connected (503)', async () => {
    const disconnectedEnv: Env = {
      ...mockEnv,
      CLUSTER_MASTER_DO: {
        idFromName: () => ({ toString: () => 'global-id' }),
        get: () => ({
          fetch: async () => new Response('No worker', { status: 503 }),
        }) as any,
      },
    }
    const auth = Buffer.from('testuser:testpass').toString('base64')
    const req = new Request('https://dsh.example/', {
      headers: { Authorization: `Basic ${auth}` },
    })
    const resp = await worker.fetch(req, disconnectedEnv, {})
    expect(resp.status).toBe(200)
    const text = await resp.text()
    expect(text).toContain('DeepSeek Harness Cluster Master')
  })

  it('routes authenticated /api endpoints to Durable Object', async () => {
    const auth = Buffer.from('testuser:testpass').toString('base64')
    const req = new Request('https://dsh.example/api/session', {
      headers: { Authorization: `Basic ${auth}` },
    })
    const resp = await worker.fetch(req, mockEnv, {})
    expect(resp.status).toBe(200)
    const text = await resp.text()
    expect(text).toContain('Routed to DO: https://dsh.example/api/session')
  })

  it('serves static assets when env.ASSETS is bound', async () => {
    const envWithAssets: Env = {
      ...mockEnv,
      ASSETS: {
        fetch: async () => new Response('Built Asset Content', { status: 200 }),
      },
    }

    const auth = Buffer.from('testuser:testpass').toString('base64')
    const req = new Request('https://dsh.example/bundle.js', {
      headers: { Authorization: `Basic ${auth}` },
    })
    const resp = await worker.fetch(req, envWithAssets, {})
    expect(resp.status).toBe(200)
    const text = await resp.text()
    expect(text).toBe('Built Asset Content')
  })
})
