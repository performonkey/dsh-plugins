import { describe, expect, it } from 'vitest'
import { timingSafeEqual, unauthorizedResponse, verifyBasicAuth } from '../src/basic-auth.ts'

describe('Cloudflare Master HTTP Basic Authentication', () => {
  it('performs constant-time string comparison', async () => {
    expect(await timingSafeEqual('hello', 'hello')).toBe(true)
    expect(await timingSafeEqual('password123', 'password123')).toBe(true)
    expect(await timingSafeEqual('hello', 'world')).toBe(false)
    expect(await timingSafeEqual('short', 'longer-string')).toBe(false)
  })

  it('allows request when basic auth credentials are not configured', async () => {
    const req = new Request('https://dsh.example/')
    expect(await verifyBasicAuth(req, undefined, undefined)).toBe(true)
    expect(await verifyBasicAuth(req, '', '')).toBe(true)
  })

  it('rejects request missing Authorization header', async () => {
    const req = new Request('https://dsh.example/')
    expect(await verifyBasicAuth(req, 'admin', 'secret')).toBe(false)
  })

  it('rejects request with wrong authorization scheme', async () => {
    const req = new Request('https://dsh.example/', {
      headers: { Authorization: 'Bearer my-token' },
    })
    expect(await verifyBasicAuth(req, 'admin', 'secret')).toBe(false)
  })

  it('rejects request with invalid or malformed base64', async () => {
    const req = new Request('https://dsh.example/', {
      headers: { Authorization: 'Basic not-valid-base64%%%' },
    })
    expect(await verifyBasicAuth(req, 'admin', 'secret')).toBe(false)
  })

  it('rejects request missing colon separator', async () => {
    const b64 = Buffer.from('onlyuserwithoutcolon').toString('base64')
    const req = new Request('https://dsh.example/', {
      headers: { Authorization: `Basic ${b64}` },
    })
    expect(await verifyBasicAuth(req, 'admin', 'secret')).toBe(false)
  })

  it('rejects request with wrong username or password', async () => {
    const wrongUser = Buffer.from('wrong:secret').toString('base64')
    const req1 = new Request('https://dsh.example/', {
      headers: { Authorization: `Basic ${wrongUser}` },
    })
    expect(await verifyBasicAuth(req1, 'admin', 'secret')).toBe(false)

    const wrongPass = Buffer.from('admin:wrongsecret').toString('base64')
    const req2 = new Request('https://dsh.example/', {
      headers: { Authorization: `Basic ${wrongPass}` },
    })
    expect(await verifyBasicAuth(req2, 'admin', 'secret')).toBe(false)
  })

  it('accepts request with correct username and password', async () => {
    const valid = Buffer.from('admin:secret123').toString('base64')
    const req = new Request('https://dsh.example/', {
      headers: { Authorization: `Basic ${valid}` },
    })
    expect(await verifyBasicAuth(req, 'admin', 'secret123')).toBe(true)
  })

  it('accepts request with valid session cookie without requiring Authorization header', async () => {
    const { computeAuthCookieValue, AUTH_COOKIE_NAME, verifyAuth } = await import('../src/basic-auth.ts')
    const cookieVal = await computeAuthCookieValue('admin', 'secret123', 'salt')
    const req = new Request('https://dsh.example/api/session', {
      headers: { Cookie: `${AUTH_COOKIE_NAME}=${cookieVal}; other=123` },
    })
    const res = await verifyAuth(req, 'admin', 'secret123', 'salt')
    expect(res.authenticated).toBe(true)
    expect(res.shouldSetCookie).toBe(false)
  })

  it('generates standard 401 response with optional WWW-Authenticate header', () => {
    const resp1 = unauthorizedResponse('Custom Realm', true)
    expect(resp1.status).toBe(401)
    expect(resp1.headers.get('www-authenticate')).toBe('Basic realm="Custom Realm"')

    const resp2 = unauthorizedResponse('Custom Realm', false)
    expect(resp2.status).toBe(401)
    expect(resp2.headers.get('www-authenticate')).toBeNull()
  })
})
