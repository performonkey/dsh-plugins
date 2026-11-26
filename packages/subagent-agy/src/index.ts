/**
 * Antigravity CLI (agy) subagent provider plugin for DeepSeek Harness.
 * Registers an out-of-process one-shot child provider on `ctx.subagents`
 * that directly interfaces with the agy CLI's stdin/stdout/stderr.
 *
 * @module @deepseek-ai/dsh-subagent-agy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  NO_START_CAPABILITIES,
  assertUsableCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  startAgyRun,
  type AgyRunConfig,
} from './run.ts'

export const name = 'subagent-agy'
export const inject = ['subagents']

const DEFAULT_PROVIDER_NAME = 'agy'

/** Deployment configuration settings for the agy subagent provider. */
export interface Config extends AgyRunConfig {
  /** Registry name on `ctx.subagents` (default `agy`). */
  providerName?: string
}

export const Config: z<Config> = z.object({
  providerName: z.string().default(DEFAULT_PROVIDER_NAME),
  binPath: z.string().default('agy'),
  model: z.string(),
  mode: z.union(['auto', 'accept-edits', 'plan'] as const).default('auto'),
  env: z.dict(z.string()).default({}),
  disposeGraceMs: z.number().default(3000),
})

type ResolvedConfig = Required<Pick<Config, 'providerName' | 'binPath' | 'mode' | 'env' | 'disposeGraceMs'>> &
  Pick<Config, 'model'>

class AgyProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly config: ResolvedConfig,
  ) {}

  start(request: ResolvedSubagentStartRequest) {
    let cwd: string
    try {
      cwd = assertUsableCwd('subagent-agy', 'child cwd', request.cwd)
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error('subagent-agy: request was aborted before CLI startup')
      }
      throw error
    }

    return Promise.resolve(startAgyRun({ ...request, cwd }, this.config))
  }
}

/**
 * Applies the agy subagent plugin into the Cordis context.
 *
 * @param ctx - The Cordis application context.
 * @param config - Provider configuration options.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    providerName: config.providerName || DEFAULT_PROVIDER_NAME,
    binPath: config.binPath || 'agy',
    mode: config.mode || 'auto',
    env: config.env || {},
    disposeGraceMs: config.disposeGraceMs ?? 3000,
    ...(config.model !== undefined ? { model: config.model } : {}),
  }

  ctx.subagents.registerProvider(new AgyProvider(resolved.providerName, resolved))
}
