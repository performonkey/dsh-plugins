/**
 * One-shot Antigravity CLI (agy) subagent child lifecycle: spawn the native
 * agy executable with -p, stream stdout/stderr, respect cancellation signals,
 * and settle the terminal result as SubagentResult.
 *
 * @module @deepseek-ai/dsh-subagent-agy/run
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ResolvedSubagentStartRequest,
  SubagentResult,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'

/** Supported execution modes for the Antigravity CLI. */
export type AgyExecutionMode = 'auto' | 'accept-edits' | 'plan'

/** Configuration options for spawning the agy subagent run. */
export interface AgyRunConfig {
  /** Path to the agy binary. Defaults to 'agy'. */
  binPath?: string
  /** Model name passed to agy via `--model`. */
  model?: string
  /** Agent execution mode passed to agy via `--mode`. Defaults to 'auto'. */
  mode?: AgyExecutionMode
  /** Additional environment variables passed to the child process. */
  env?: Record<string, string>
  /** Grace period in milliseconds before SIGKILL after SIGTERM. */
  disposeGraceMs?: number
}

/**
 * Extracts plain text from the request prompt content blocks.
 *
 * @param request - Resolved subagent start request containing prompt blocks.
 * @returns Combined prompt text.
 */
export function extractPromptText(request: ResolvedSubagentStartRequest): string {
  return request.prompt
    .filter((b: ContentBlock): b is ContentBlock & { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('\n\n')
}

/**
 * Spawns an Antigravity CLI (agy) process and returns a managed SubagentRun handle.
 *
 * @param request - The resolved subagent start request with absolute cwd and prompt.
 * @param config - Options controlling binary path, model, mode, and process teardown.
 * @returns Managed subagent run handle.
 */
export function startAgyRun(
  request: ResolvedSubagentStartRequest,
  config: AgyRunConfig = {},
): SubagentRun {
  const promptText = extractPromptText(request)
  const bin = config.binPath || 'agy'

  const args: string[] = [
    '-p', promptText,
    '--dangerously-skip-permissions',
    '--mode', config.mode || 'auto',
  ]
  if (config.model) {
    args.push('--model', config.model)
  }

  const child = spawn(bin, args, {
    cwd: request.cwd,
    env: { ...process.env, ...config.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdoutText = ''
  let stderrText = ''

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  child.stdout.on('data', (chunk: string) => {
    stdoutText += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    stderrText += chunk
  })

  let disposed = false
  const dispose = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    disposed = true
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const graceMs = config.disposeGraceMs ?? 3000
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // child process already exited
        }
      }, graceMs)
      timer.unref()
    }
    return Promise.resolve()
  }

  const onAbort = () => {
    void dispose()
  }
  request.signal.addEventListener('abort', onAbort, { once: true })

  const result = new Promise<SubagentResult>((resolve) => {
    child.on('close', (code, signal) => {
      request.signal.removeEventListener('abort', onAbort)

      if (request.signal.aborted || signal === 'SIGTERM' || signal === 'SIGKILL') {
        resolve({
          output: stdoutText ? [{ type: 'text', text: stdoutText.trim() }] : [],
          diagnostic: stderrText.trim() || 'Subagent execution was aborted',
          stopReason: 'aborted',
        })
      } else if (code === 0) {
        resolve({
          output: [{ type: 'text', text: stdoutText.trim() }],
          stopReason: 'completed',
        })
      } else {
        resolve({
          output: stdoutText ? [{ type: 'text', text: stdoutText.trim() }] : [],
          diagnostic: stderrText.trim() || `agy exited with code ${code}`,
          stopReason: 'error',
        })
      }
    })

    child.on('error', (err) => {
      request.signal.removeEventListener('abort', onAbort)
      resolve({
        output: [],
        diagnostic: `Failed to spawn agy: ${err.message}`,
        stopReason: 'error',
      })
    })
  })

  return {
    id: brandString<SessionId>(randomUUID()),
    result,
    dispose,
  }
}
