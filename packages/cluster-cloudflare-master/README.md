# DeepSeek Harness Cluster Master (Cloudflare Workers & Durable Objects)

English | [中文](README.zh.md)

Serverless implementation of the DeepSeek Harness (DSH) Cluster Master running entirely on **Cloudflare Workers** and a global singleton **Durable Object** (`ClusterMasterDO`).

This package provides a zero-maintenance, zero-server Master node with **zero storage reads and writes**, designed to run completely within the **Cloudflare Free Tier**.

---

## Highlights

- **Serverless & Global**: Runs on Cloudflare's Edge network across 300+ cities with automatic SSL/TLS termination and DDoS protection.
- **0 Storage Reads/Writes**: All reverse WebSocket tunnels, browser sessions, and HTTP RPC correlation IDs (`TunnelRequestId`) are managed in DO volatile memory. Never writes to DO disk storage.
- **Built-in HTTP Basic Authentication**: Protects the Web UI and API endpoints with timing-safe HTTP Basic Auth at the edge. The reverse tunnel endpoint (`/api/worker/connect`) is cleanly exempted and secured via pre-shared cluster token handshake.
- **Bidirectional RPC & WebSocket Muxing**: Multiplexes browser streams (`/api/remote.mux`) and dispatches unary HTTP requests (`/api/*`) through the worker reverse tunnel.
- **100% Free-Tier Friendly**:
  - Cloudflare Free Tier includes 100,000 Workers requests/day and standard Durable Objects allocation.
  - Zero storage usage means no DO read/write operation quotas are ever consumed.

---

## Architecture

```
                    Cloudflare Edge (Worker / DO)
┌────────────────┐      HTTPS / WSS (Basic Auth)      ┌─────────────────────────┐
│ Browser Client │ ─────────────────────────────────> │ Cloudflare Worker Edge  │
└────────────────┘                                    └────────────┬────────────┘
                                                                   │
                                                                   ▼
┌────────────────┐     WSS Reverse Tunnel (Cluster Token)   ┌─────────────────────┐
│  Local Worker  │ ───────────────────────────────────────> │  ClusterMasterDO    │
│  (promaxgb10)  │ <─────────────────────────────────────── │ (In-Memory Gateway) │
└────────────────┘                                          └─────────────────────┘
```

1. **Reverse Tunnel**: The local worker machine connects outbound to `wss://<your-worker>.workers.dev/api/worker/connect`. No public IP or port forwarding is required on the worker machine.
2. **Cluster Authentication**: Worker authenticates via `control:hello` handshake containing the `AUTH_TOKEN`.
3. **Web UI Access**: Users browse to `https://<your-worker>.workers.dev`. The edge Worker prompts for HTTP Basic Auth (`BASIC_AUTH_USER` / `BASIC_AUTH_PASS`).
4. **Relay**: Once authenticated, the browser's WebSocket multiplexer (`/api/remote.mux`) and HTTP RPC calls (`/api/*`) are transparently forwarded to the connected local worker.

---

## Configuration

Settings are declared in `wrangler.jsonc` or set via Cloudflare Secrets:

| Variable | Description | Default |
|---|---|---|
| `AUTH_TOKEN` | Pre-shared cluster token for worker handshake | Generated random hex |
| `BASIC_AUTH_USER` | HTTP Basic Auth username for Web UI / API | `admin` |
| `BASIC_AUTH_PASS` | HTTP Basic Auth password for Web UI / API | `dsh2026` |

To set production secrets securely without committing credentials:
```bash
npx wrangler secret put AUTH_TOKEN
npx wrangler secret put BASIC_AUTH_USER
npx wrangler secret put BASIC_AUTH_PASS
```

---

## Deployment

### 1. Prerequisites
Ensure you have Node.js and a Cloudflare account:
```bash
cd packages/experimental/cluster-cloudflare-master
```

### 2. Local Development & Testing
Run unit and integration tests:
```bash
pnpm test
```

Start the local Wrangler dev server:
```bash
pnpm dev
```

### 3. Deploy to Cloudflare
Deploy to your Cloudflare account:
```bash
npx wrangler deploy
```

Once deployed, Wrangler will output your live URL:
```text
Uploaded dsh-cluster-master (x.xx sec)
Deployed dsh-cluster-master triggers (x.xx sec)
  https://dsh-cluster-master.<your-subdomain>.workers.dev
```

---

## Connecting Your Worker Node

On your execution machine (e.g., local workstation or GPU server):

```bash
DSH_CLUSTER_MASTER_URL="wss://dsh-cluster-master.<your-subdomain>.workers.dev/api/worker/connect" \
DSH_CLUSTER_AUTH_TOKEN="<your-auth-token>" \
DSH_CLUSTER_WORKER_NAME="Promax-Worker" \
pnpm dsh --profile web --patch packages/experimental/cluster-worker/cordis.patch.yml
```

If your local environment uses an outbound HTTP/HTTPS proxy, `@deepseek-ai/dsh-cluster-worker` automatically respects `https_proxy` / `http_proxy` / `ALL_PROXY`.

---

## Request Lifecycle

Each browser HTTP request is relayed to the worker and settled by whichever happens first:

| Outcome | Signal to worker | Client sees |
|---|---|---|
| Worker answers in time | none | The worker's own status and body |
| Worker stays silent for 60s | `http:cancel` | `504` with `gateway/timeout` |
| Browser abandons the request | `http:cancel` | `499`; the caller already left |

A browser abandons a request by navigating away, reloading, or dismissing the pending dialog. The relay forwards that abandonment so the worker can stop the matching operation instead of holding it until the timeout. A worker answer arriving after abandonment is discarded.

---

## License

MIT
