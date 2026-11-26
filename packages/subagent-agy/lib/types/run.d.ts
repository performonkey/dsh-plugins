/**
 * One-shot Antigravity CLI (agy) subagent child lifecycle: spawn the native
 * agy executable with -p, stream stdout/stderr, respect cancellation signals,
 * and settle the terminal result as SubagentResult.
 *
 * @module @deepseek-ai/dsh-subagent-agy/run
 */
import type { ResolvedSubagentStartRequest, SubagentRun } from '@deepseek-ai/dsh-subagent';
/** Supported execution modes for the Antigravity CLI. */
export type AgyExecutionMode = 'auto' | 'accept-edits' | 'plan';
/** Configuration options for spawning the agy subagent run. */
export interface AgyRunConfig {
    /** Path to the agy binary. Defaults to 'agy'. */
    binPath?: string;
    /** Model name passed to agy via `--model`. */
    model?: string;
    /** Agent execution mode passed to agy via `--mode`. Defaults to 'auto'. */
    mode?: AgyExecutionMode;
    /** Additional environment variables passed to the child process. */
    env?: Record<string, string>;
    /** Grace period in milliseconds before SIGKILL after SIGTERM. */
    disposeGraceMs?: number;
}
/**
 * Extracts plain text from the request prompt content blocks.
 *
 * @param request - Resolved subagent start request containing prompt blocks.
 * @returns Combined prompt text.
 */
export declare function extractPromptText(request: ResolvedSubagentStartRequest): string;
/**
 * Spawns an Antigravity CLI (agy) process and returns a managed SubagentRun handle.
 *
 * @param request - The resolved subagent start request with absolute cwd and prompt.
 * @param config - Options controlling binary path, model, mode, and process teardown.
 * @returns Managed subagent run handle.
 */
export declare function startAgyRun(request: ResolvedSubagentStartRequest, config?: AgyRunConfig): SubagentRun;
//# sourceMappingURL=run.d.ts.map