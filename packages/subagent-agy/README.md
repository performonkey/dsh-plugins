# @deepseek-ai/dsh-subagent-agy

Direct Antigravity CLI (`agy`) one-shot subagent provider for DeepSeek Harness (`dsh`).

## Summary

`@deepseek-ai/dsh-subagent-agy` enables a parent DeepSeek Harness session to delegate tasks directly to a fresh, unattended Antigravity CLI (`agy`) instance in the parent session's workspace.

Unlike ACP-based integrations, this package directly bridges `agy` via subprocess stdio (`-p <prompt>`, `--mode auto`, `--dangerously-skip-permissions`):
- **Direct Input**: Injects prompt text from `request.prompt` and workspace directory `request.cwd`.
- **Direct Output**: Collects stdout as assistant output blocks and stderr as diagnostic messages.
- **Full Lifecycle**: Handles cancellation (`SIGTERM`/`SIGKILL`), exit codes, and Cordis provider registration on `ctx.subagents`.

## Configuration

| Field | Default | Description |
|---|---|---|
| `providerName` | `'agy'` | Unique provider name registered on `ctx.subagents` |
| `binPath` | `'agy'` | Path to the `agy` binary |
| `mode` | `'auto'` | Execution mode passed to agy (`'auto'`, `'accept-edits'`, `'plan'`) |
| `model` | (none) | Optional model override passed via `--model` |
| `env` | `{}` | Additional environment variables for the child process |
| `disposeGraceMs` | `3000` | Milliseconds before force-killing with SIGKILL on abort |

## Exposing the Tool

Add the following to your profile's `cordis.patch.yml` or global configuration:

```yaml
- insert:
    - id: subagent-agy
      name: '@deepseek-ai/dsh-subagent-agy'
      config:
        providerName: agy
        binPath: agy
        mode: auto

    - id: tool-subagent-agy
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: agy
        toolName: subagent_agy
        maxDepth: provider-managed
```
