/**
 * One-shot Antigravity CLI (agy) subagent child lifecycle: spawn the native
 * agy executable with -p, stream stdout/stderr, respect cancellation signals,
 * and settle the terminal result as SubagentResult.
 *
 * @module @deepseek-ai/dsh-subagent-agy/run
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { brandString } from '@deepseek-ai/dsh-brand';
/**
 * Extracts plain text from the request prompt content blocks.
 *
 * @param request - Resolved subagent start request containing prompt blocks.
 * @returns Combined prompt text.
 */
export function extractPromptText(request) {
    return request.prompt
        .filter((b) => b.type === 'text')
        .map(b => b.text)
        .join('\n\n');
}
/**
 * Spawns an Antigravity CLI (agy) process and returns a managed SubagentRun handle.
 *
 * @param request - The resolved subagent start request with absolute cwd and prompt.
 * @param config - Options controlling binary path, model, mode, and process teardown.
 * @returns Managed subagent run handle.
 */
export function startAgyRun(request, config = {}) {
    const promptText = extractPromptText(request);
    const bin = config.binPath || 'agy';
    const args = [
        '-p', promptText,
        '--dangerously-skip-permissions',
        '--mode', config.mode || 'auto',
    ];
    if (config.model) {
        args.push('--model', config.model);
    }
    const child = spawn(bin, args, {
        cwd: request.cwd,
        env: { ...process.env, ...config.env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdoutText = '';
    let stderrText = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        stdoutText += chunk;
    });
    child.stderr.on('data', (chunk) => {
        stderrText += chunk;
    });
    let disposed = false;
    const dispose = () => {
        if (disposed)
            return Promise.resolve();
        disposed = true;
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            const graceMs = config.disposeGraceMs ?? 3000;
            const timer = setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                }
                catch {
                    // child process already exited
                }
            }, graceMs);
            timer.unref();
        }
        return Promise.resolve();
    };
    const onAbort = () => {
        void dispose();
    };
    request.signal.addEventListener('abort', onAbort, { once: true });
    const result = new Promise((resolve) => {
        child.on('close', (code, signal) => {
            request.signal.removeEventListener('abort', onAbort);
            if (request.signal.aborted || signal === 'SIGTERM' || signal === 'SIGKILL') {
                resolve({
                    output: stdoutText ? [{ type: 'text', text: stdoutText.trim() }] : [],
                    diagnostic: stderrText.trim() || 'Subagent execution was aborted',
                    stopReason: 'aborted',
                });
            }
            else if (code === 0) {
                resolve({
                    output: [{ type: 'text', text: stdoutText.trim() }],
                    stopReason: 'completed',
                });
            }
            else {
                resolve({
                    output: stdoutText ? [{ type: 'text', text: stdoutText.trim() }] : [],
                    diagnostic: stderrText.trim() || `agy exited with code ${code}`,
                    stopReason: 'error',
                });
            }
        });
        child.on('error', (err) => {
            request.signal.removeEventListener('abort', onAbort);
            resolve({
                output: [],
                diagnostic: `Failed to spawn agy: ${err.message}`,
                stopReason: 'error',
            });
        });
    });
    return {
        id: brandString(randomUUID()),
        result,
        dispose,
    };
}
//# sourceMappingURL=run.js.map