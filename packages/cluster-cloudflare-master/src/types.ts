/** Type definitions for Cloudflare Workers & Durable Objects cluster master runtime. */

import type { WorkerId } from '@deepseek-ai/dsh-cluster-protocol'

/** Minimal Cloudflare DurableObjectState abstraction. */
export interface CloudflareDurableObjectState {
  readonly id: { toString(): string }
  waitUntil(promise: Promise<unknown>): void
  acceptWebSocket?(ws: WebSocket, tags?: string[]): void
  getWebSockets?(tag?: string): WebSocket[]
  setWebSocketAutoResponse?(response: unknown): void
}

/** Minimal Cloudflare DurableObjectNamespace abstraction. */
export interface CloudflareDurableObjectNamespace {
  idFromName(name: string): { toString(): string }
  get(id: { toString(): string }): {
    fetch(request: Request | string, init?: RequestInit): Promise<Response>
  }
}

/** Cloudflare Worker environment bindings. */
export interface Env {
  /** Durable Object namespace binding for the Cluster Master singleton. */
  readonly CLUSTER_MASTER_DO: CloudflareDurableObjectNamespace
  /** Pre-shared cluster authentication token required for worker reverse tunnel. */
  readonly AUTH_TOKEN?: string
  /** Optional HTTP Basic Auth username for web UI protection. */
  readonly BASIC_AUTH_USER?: string
  /** Optional HTTP Basic Auth password for web UI protection. */
  readonly BASIC_AUTH_PASS?: string
  /** Optional Workers Static Assets binding for frontend UI files. */
  readonly ASSETS?: {
    fetch(request: Request): Promise<Response>
  }
}

/** Connected worker node metadata. */
export interface ConnectedWorkerInfo {
  readonly id: WorkerId
  readonly name: string
  readonly workspaces: readonly string[]
  readonly connectedAt: number
}
