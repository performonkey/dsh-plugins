/**
 * Local reverse-tunnel bridge: connects to the deployed Cloudflare Worker master
 * as a cluster worker and relays tunnel http:req frames to the local DSH web GUI,
 * so a phone can open the GUI through the Worker URL.
 *
 * Usage:
 *   DSH_CLUSTER_MASTER_URL=wss://<worker>.workers.dev/api/worker/connect \
 *   DSH_CLUSTER_AUTH_TOKEN=<token> \
 *   pnpm exec tsx packages/experimental/cluster-cloudflare-master/scripts/worker-relay.ts
 */

const masterUrl = process.env.DSH_CLUSTER_MASTER_URL ?? 'wss://example-master.workers.dev/api/worker/connect'
const authToken = process.env.DSH_CLUSTER_AUTH_TOKEN ?? 'replace-with-your-auth-token'
const workerId = process.env.DSH_CLUSTER_WORKER_ID ?? 'worker-liujh-local'
const workerName = process.env.DSH_CLUSTER_WORKER_NAME ?? 'liujh-local'
const localHttp = process.env.DSH_LOCAL_HTTP ?? 'http://127.0.0.1:3080'

const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length'])

function log(...args: unknown[]): void {
  console.log(`[relay ${new Date().toISOString()}]`, ...args)
}

/**
 * Build the control:hello frame.
 * @returns JSON string ready to send.
 */
function helloFrame(): string {
  return JSON.stringify({
    type: 'control:hello',
    token: authToken,
    workerId,
    name: workerName,
    workspaces: [process.cwd()],
    version: 'relay-1',
    timestamp: Date.now(),
  })
}

let socket: WebSocket | undefined

/** Forward one http:req frame to the local DSH web server and reply with http:resp. */
async function handleHttpReq(frame: { reqId: string, method: string, path: string, headers?: Record<string, string>, body?: string }): Promise<void> {
  const url = new URL(frame.path, localHttp)
  const headers: Record<string, string> = {}
  if (frame.headers) {
    for (const [k, v] of Object.entries(frame.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v
    }
  }
  const hasBody = frame.method !== 'GET' && frame.method !== 'HEAD' && frame.body !== undefined
  try {
    const resp = await fetch(url, {
      method: frame.method,
      headers,
      ...(hasBody ? { body: frame.body } : {}),
      redirect: 'manual',
    })
    const body = Buffer.from(await resp.arrayBuffer()).toString('base64')
    const respHeaders: Record<string, string> = {}
    resp.headers.forEach((v, k) => {
      respHeaders[k] = v
    })
    socket?.send(JSON.stringify({
      type: 'http:resp',
      reqId: frame.reqId,
      status: resp.status,
      headers: { ...respHeaders, 'x-dsh-relay-encoding': 'base64' },
      body,
    }))
    log(`http ${frame.method} ${frame.path} -> ${resp.status}`)
  } catch (err) {
    socket?.send(JSON.stringify({
      type: 'http:resp',
      reqId: frame.reqId,
      status: 502,
      headers: { 'content-type': 'text/plain' },
      body: `relay fetch failed: ${String(err)}`,
    }))
    log(`http ${frame.method} ${frame.path} -> 502 ${String(err)}`)
  }
}

async function connect(): Promise<void> {
  log(`connecting to ${masterUrl}`)
  const ws = new WebSocket(masterUrl)
  socket = ws

  ws.onopen = () => {
    ws.send(helloFrame())
  }

  ws.onmessage = ev => {
    let frame: any
    try {
      frame = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (!frame || typeof frame.type !== 'string') return
    switch (frame.type) {
      case 'control:ready':
        if (frame.accepted) log('registered with master (accepted)')
        else log(`REJECTED by master: ${frame.reason ?? 'unknown reason'}`)
        break
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
        break
      case 'http:req':
        void handleHttpReq(frame)
        break
      case 'stream:open':
        log(`stream:open ${frame.endpoint} (not supported by relay)`)
        ws.send(JSON.stringify({
          type: 'stream:close',
          streamId: frame.streamId,
          error: { code: 'unsupported', message: 'relay bridge handles http:req only' },
        }))
        break
      default:
        break
    }
  }

  ws.onclose = ev => {
    log(`disconnected (code=${ev.code} reason=${ev.reason})`)
    socket = undefined
    setTimeout(() => void connect(), 3000)
  }

  ws.onerror = ev => {
    log('websocket error', String((ev as { error?: unknown }).error ?? 'unknown'))
  }
}

void connect()
log(`relay up; master=${masterUrl} workerId=${workerId} local=${localHttp}`)
