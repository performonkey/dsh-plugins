/**
 * Antigravity CLI (agy) subagent provider plugin for DeepSeek Harness.
 * Registers an out-of-process one-shot child provider on `ctx.subagents`
 * that directly interfaces with the agy CLI's stdin/stdout/stderr.
 *
 * @module @deepseek-ai/dsh-subagent-agy
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type AgyRunConfig } from './run.ts';
export declare const name = "subagent-agy";
export declare const inject: string[];
/** Deployment configuration settings for the agy subagent provider. */
export interface Config extends AgyRunConfig {
    /** Registry name on `ctx.subagents` (default `agy`). */
    providerName?: string;
}
export declare const Config: z<Config>;
/**
 * Applies the agy subagent plugin into the Cordis context.
 *
 * @param ctx - The Cordis application context.
 * @param config - Provider configuration options.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map