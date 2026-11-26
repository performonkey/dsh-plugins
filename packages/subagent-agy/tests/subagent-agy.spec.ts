import { chmodSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { NO_START_CAPABILITIES, type SubagentProvider } from '@deepseek-ai/dsh-subagent'
import * as subagentAgy from '../src/index.ts'
import { extractPromptText, startAgyRun } from '../src/run.ts'

describe('subagent-agy unit and integration tests', () => {
  describe('extractPromptText', () => {
    it('extracts and joins text blocks', () => {
      const prompt = extractPromptText({
        cwd: process.cwd(),
        prompt: [
          { type: 'text', text: 'First block' },
          { type: 'text', text: 'Second block' },
        ],
        parent: {} as Agent,
        signal: new AbortController().signal,
      })

      expect(prompt).toBe('First block\n\nSecond block')
    })

    it('returns empty string when no text blocks are present', () => {
      const prompt = extractPromptText({
        cwd: process.cwd(),
        prompt: [],
        parent: {} as Agent,
        signal: new AbortController().signal,
      })

      expect(prompt).toBe('')
    })
  })

  describe('startAgyRun with mock agy executable', () => {
    const mockScriptPath = join(tmpdir(), `mock-agy-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)

    // Create a mock executable simulating the agy CLI contract
    const mockScriptContent = `#!/usr/bin/env node
const args = process.argv.slice(2);
const pIdx = args.indexOf('-p');
const prompt = pIdx !== -1 ? args[pIdx + 1] : '';

if (process.env.MOCK_FAIL === '1') {
  console.error('mock error occurred');
  process.exit(1);
} else if (process.env.MOCK_HANG === '1') {
  setInterval(() => {}, 1000);
} else {
  console.log('Result for: ' + prompt);
  process.exit(0);
}
`
    writeFileSync(mockScriptPath, mockScriptContent, 'utf8')
    chmodSync(mockScriptPath, 0o755)

    afterAll(() => {
      try {
        unlinkSync(mockScriptPath)
      } catch {
        // file already deleted
      }
    })

    it('successfully collects output on clean exit', async () => {
      const controller = new AbortController()
      const run = startAgyRun(
        {
          cwd: process.cwd(),
          prompt: [{ type: 'text', text: 'hello agy' }],
          parent: {} as Agent,
          signal: controller.signal,
        },
        {
          binPath: mockScriptPath,
          mode: 'auto',
        },
      )

      expect(run.id).toBeDefined()
      const result = await run.result

      expect(result.stopReason).toBe('completed')
      expect(result.output).toEqual([
        { type: 'text', text: 'Result for: hello agy' },
      ])
      expect(result.diagnostic).toBeUndefined()
    })

    it('handles process error code and captures stderr as diagnostic', async () => {
      const controller = new AbortController()
      const run = startAgyRun(
        {
          cwd: process.cwd(),
          prompt: [{ type: 'text', text: 'failing task' }],
          parent: {} as Agent,
          signal: controller.signal,
        },
        {
          binPath: mockScriptPath,
          env: { MOCK_FAIL: '1' },
        },
      )

      const result = await run.result

      expect(result.stopReason).toBe('error')
      expect(result.diagnostic).toContain('mock error occurred')
    })

    it('handles abort signal and reports aborted stopReason', async () => {
      const controller = new AbortController()
      const run = startAgyRun(
        {
          cwd: process.cwd(),
          prompt: [{ type: 'text', text: 'long running task' }],
          parent: {} as Agent,
          signal: controller.signal,
        },
        {
          binPath: mockScriptPath,
          env: { MOCK_HANG: '1' },
          disposeGraceMs: 500,
        },
      )

      // Trigger abort while running
      setTimeout(() => {
        controller.abort()
      }, 50)

      const result = await run.result
      expect(result.stopReason).toBe('aborted')
    })

    it('dispose cleanly terminates process', async () => {
      const controller = new AbortController()
      const run = startAgyRun(
        {
          cwd: process.cwd(),
          prompt: [{ type: 'text', text: 'hang forever' }],
          parent: {} as Agent,
          signal: controller.signal,
        },
        {
          binPath: mockScriptPath,
          env: { MOCK_HANG: '1' },
          disposeGraceMs: 500,
        },
      )

      setTimeout(() => {
        void run.dispose()
      }, 50)

      const result = await run.result
      expect(['aborted', 'error']).toContain(result.stopReason)
    })
  })

  describe('Cordis plugin registration', () => {
    it('registers subagent-agy provider on ctx.subagents', () => {
      let registered: SubagentProvider | undefined
      const mockCtx = {
        subagents: {
          registerProvider: (p: SubagentProvider) => { registered = p },
        },
      } as never

      subagentAgy.apply(mockCtx, {
        providerName: 'agy-custom',
        binPath: 'agy',
        mode: 'auto',
      })

      expect(registered).toBeDefined()
      expect(registered?.name).toBe('agy-custom')
      expect(registered?.capabilities).toEqual(NO_START_CAPABILITIES)
      expect(registered?.inheritsParentContext).toBe(false)
    })

    it('rejects an invalid cwd before spawn', () => {
      let registered: SubagentProvider | undefined
      const mockCtx = {
        subagents: {
          registerProvider: (p: SubagentProvider) => { registered = p },
        },
      } as never

      subagentAgy.apply(mockCtx, {
        providerName: 'agy',
        binPath: 'agy',
      })

      expect(registered).toBeDefined()
      if (!registered) throw new Error('agy provider did not register')
      const provider = registered

      expect(() =>
        provider.start!({
          cwd: '/non/existent/path/for/dsh/test',
          prompt: [{ type: 'text', text: 'test' }],
          parent: {} as Agent,
          signal: new AbortController().signal,
        }),
      ).toThrow(/is not an accessible directory/)
    })
  })
})
