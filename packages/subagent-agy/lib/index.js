import z from "@deepseek-ai/schemastery";
import { NO_START_CAPABILITIES, assertUsableCwd } from "@deepseek-ai/dsh-subagent";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { brandString } from "@deepseek-ai/dsh-brand";
//#region lib/types/run.js
/**
* One-shot Antigravity CLI (agy) subagent child lifecycle: spawn the native
* agy executable with -p, stream stdout/stderr, respect cancellation signals,
* and settle the terminal result as SubagentResult.
*
* @module @deepseek-ai/dsh-subagent-agy/run
*/
/**
* Extracts plain text from the request prompt content blocks.
*
* @param request - Resolved subagent start request containing prompt blocks.
* @returns Combined prompt text.
*/
function extractPromptText(request) {
	return request.prompt.filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
}
/**
* Spawns an Antigravity CLI (agy) process and returns a managed SubagentRun handle.
*
* @param request - The resolved subagent start request with absolute cwd and prompt.
* @param config - Options controlling binary path, model, mode, and process teardown.
* @returns Managed subagent run handle.
*/
function startAgyRun(request, config = {}) {
	const promptText = extractPromptText(request);
	const bin = config.binPath || "agy";
	const args = [
		"-p",
		promptText,
		"--dangerously-skip-permissions",
		"--mode",
		config.mode || "auto"
	];
	if (config.model) args.push("--model", config.model);
	const child = spawn(bin, args, {
		cwd: request.cwd,
		env: {
			...process.env,
			...config.env
		},
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		]
	});
	let stdoutText = "";
	let stderrText = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdoutText += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderrText += chunk;
	});
	let disposed = false;
	const dispose = () => {
		if (disposed) return Promise.resolve();
		disposed = true;
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			const graceMs = config.disposeGraceMs ?? 3e3;
			setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
			}, graceMs).unref();
		}
		return Promise.resolve();
	};
	const onAbort = () => {
		dispose();
	};
	request.signal.addEventListener("abort", onAbort, { once: true });
	const result = new Promise((resolve) => {
		child.on("close", (code, signal) => {
			request.signal.removeEventListener("abort", onAbort);
			if (request.signal.aborted || signal === "SIGTERM" || signal === "SIGKILL") resolve({
				output: stdoutText ? [{
					type: "text",
					text: stdoutText.trim()
				}] : [],
				diagnostic: stderrText.trim() || "Subagent execution was aborted",
				stopReason: "aborted"
			});
			else if (code === 0) resolve({
				output: [{
					type: "text",
					text: stdoutText.trim()
				}],
				stopReason: "completed"
			});
			else resolve({
				output: stdoutText ? [{
					type: "text",
					text: stdoutText.trim()
				}] : [],
				diagnostic: stderrText.trim() || `agy exited with code ${code}`,
				stopReason: "error"
			});
		});
		child.on("error", (err) => {
			request.signal.removeEventListener("abort", onAbort);
			resolve({
				output: [],
				diagnostic: `Failed to spawn agy: ${err.message}`,
				stopReason: "error"
			});
		});
	});
	return {
		id: brandString(randomUUID()),
		result,
		dispose
	};
}
//#endregion
//#region lib/types/index.js
/**
* Antigravity CLI (agy) subagent provider plugin for DeepSeek Harness.
* Registers an out-of-process one-shot child provider on `ctx.subagents`
* that directly interfaces with the agy CLI's stdin/stdout/stderr.
*
* @module @deepseek-ai/dsh-subagent-agy
*/
const name = "subagent-agy";
const inject = ["subagents"];
const DEFAULT_PROVIDER_NAME = "agy";
const Config = z.object({
	providerName: z.string().default(DEFAULT_PROVIDER_NAME),
	binPath: z.string().default("agy"),
	model: z.string(),
	mode: z.union([
		"auto",
		"accept-edits",
		"plan"
	]).default("auto"),
	env: z.dict(z.string()).default({}),
	disposeGraceMs: z.number().default(3e3)
});
var AgyProvider = class {
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
			cwd = assertUsableCwd("subagent-agy", "child cwd", request.cwd);
		} catch (error) {
			if (request.signal.aborted) throw new Error("subagent-agy: request was aborted before CLI startup");
			throw error;
		}
		return Promise.resolve(startAgyRun({
			...request,
			cwd
		}, this.config));
	}
};
/**
* Applies the agy subagent plugin into the Cordis context.
*
* @param ctx - The Cordis application context.
* @param config - Provider configuration options.
*/
function apply(ctx, config) {
	const resolved = {
		providerName: config.providerName || DEFAULT_PROVIDER_NAME,
		binPath: config.binPath || "agy",
		mode: config.mode || "auto",
		env: config.env || {},
		disposeGraceMs: config.disposeGraceMs ?? 3e3,
		...config.model !== void 0 ? { model: config.model } : {}
	};
	ctx.subagents.registerProvider(new AgyProvider(resolved.providerName, resolved));
}
//#endregion
export { Config, apply, inject, name };
