/**
 * Antigravity CLI (agy) subagent provider plugin for DeepSeek Harness.
 * Registers an out-of-process one-shot child provider on `ctx.subagents`
 * that directly interfaces with the agy CLI's stdin/stdout/stderr.
 *
 * @module @deepseek-ai/dsh-subagent-agy
 */
import z from '@deepseek-ai/schemastery';
import { NO_START_CAPABILITIES, assertUsableCwd, } from '@deepseek-ai/dsh-subagent';
import { startAgyRun, } from "./run.js";
export const name = 'subagent-agy';
export const inject = ['subagents'];
const DEFAULT_PROVIDER_NAME = 'agy';
export const Config = z.object({
    providerName: z.string().default(DEFAULT_PROVIDER_NAME),
    binPath: z.string().default('agy'),
    model: z.string(),
    mode: z.union(['auto', 'accept-edits', 'plan']).default('auto'),
    env: z.dict(z.string()).default({}),
    disposeGraceMs: z.number().default(3000),
});
class AgyProvider {
    name;
    config;
    capabilities = NO_START_CAPABILITIES;
    inheritsParentContext = false;
    constructor(name, config) {
        this.name = name;
        this.config = config;
    }
    start(request) {
        let cwd;
        try {
            cwd = assertUsableCwd('subagent-agy', 'child cwd', request.cwd);
        }
        catch (error) {
            if (request.signal.aborted) {
                throw new Error('subagent-agy: request was aborted before CLI startup');
            }
            throw error;
        }
        return Promise.resolve(startAgyRun({ ...request, cwd }, this.config));
    }
}
/**
 * Applies the agy subagent plugin into the Cordis context.
 *
 * @param ctx - The Cordis application context.
 * @param config - Provider configuration options.
 */
export function apply(ctx, config) {
    const resolved = {
        providerName: config.providerName || DEFAULT_PROVIDER_NAME,
        binPath: config.binPath || 'agy',
        mode: config.mode || 'auto',
        env: config.env || {},
        disposeGraceMs: config.disposeGraceMs ?? 3000,
        ...(config.model !== undefined ? { model: config.model } : {}),
    };
    ctx.subagents.registerProvider(new AgyProvider(resolved.providerName, resolved));
}
//# sourceMappingURL=index.js.map