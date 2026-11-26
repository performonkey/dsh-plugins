// @vitest-environment jsdom
/** The floating strip sends its fixed key set and rides above the measured keyboard height. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { applyModifier, MobileKeyStrip } from '../src/client/mobile-keyboard.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function mount(covered = 0) {
  const onKey = vi.fn()
  const onPaste = vi.fn()
  const observer = vi.fn((report: (height: number) => void) => {
    report(covered)
    return () => undefined
  })
  const view = render(<MobileKeyStrip onKey={onKey} onPaste={onPaste} t={makeTranslate(en)} observer={observer} />)
  const pressed = (index: number): string => onKey.mock.calls[index]![0] as string
  return { view, onKey, onPaste, pressed, observer }
}

it('shows Tab, Ctrl, Alt, Escape, Backspace, Paste and the four arrow keys in one row', () => {
  const { view } = mount()
  for (const name of [en.keyboardTab, en.keyboardCtrl, en.keyboardAlt, en.keyboardEscape, en.keyboardBackspace, en.keyboardPaste]) {
    expect(view.getByRole('button', { name })).toBeDefined()
  }
  for (const direction of [en.keyboardDirectionUp, en.keyboardDirectionDown, en.keyboardDirectionLeft, en.keyboardDirectionRight]) {
    expect(view.getByRole('button', { name: en.keyboardArrow.replace('{direction}', direction) })).toBeDefined()
  }
  expect(view.getByRole('group', { name: en.screenKeyboard })).toBeDefined()
})

it('renders icon buttons without text so only their names carry meaning', () => {
  const { view } = mount()
  const name = (key: 'keyboardTab' | 'keyboardCtrl' | 'keyboardAlt' | 'keyboardEscape' | 'keyboardBackspace' | 'keyboardPaste'): string => en[key]
  for (const key of ['keyboardTab', 'keyboardCtrl', 'keyboardAlt', 'keyboardEscape', 'keyboardBackspace', 'keyboardPaste'] as const) {
    const button = view.getByRole('button', { name: name(key) })
    expect(button.textContent).toBe('')
    // The glyph paints as a solid currentColor path so it stays legible against any background.
    const path = button.querySelector('path')
    expect(path).not.toBeNull()
    expect(path!.getAttribute('fill')).toBe('currentColor')
    const svg = button.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg!.getAttribute('viewBox')).toBeTruthy()
  }
  for (const direction of [en.keyboardDirectionUp, en.keyboardDirectionDown, en.keyboardDirectionLeft, en.keyboardDirectionRight]) {
    const button = view.getByRole('button', { name: en.keyboardArrow.replace('{direction}', direction) })
    expect(button.textContent).toBe('')
    expect(button.querySelector('path')).not.toBeNull()
    const svg = button.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg!.getAttribute('viewBox')).toBeTruthy()
  }
  const ctrlPath = view.getByRole('button', { name: en.keyboardCtrl }).querySelector('path')?.getAttribute('d')
  const altPath = view.getByRole('button', { name: en.keyboardAlt }).querySelector('path')?.getAttribute('d')
  expect(ctrlPath).toBeDefined()
  expect(altPath).toBeDefined()
  expect(ctrlPath).not.toBe(altPath)
})

it('keeps the system keyboard open by cancelling focus-stealing mousedowns on every key', () => {
  const { view } = mount()
  for (const button of view.getAllByRole('button')) {
    const down = fireEvent.mouseDown(button)
    expect(down).toBe(false)
  }
})

it('sends Tab, Escape, Backspace and each arrow as its terminal sequence', () => {
  const { view, pressed, onKey } = mount()
  fireEvent.click(view.getByRole('button', { name: en.keyboardTab }))
  fireEvent.click(view.getByRole('button', { name: en.keyboardEscape }))
  fireEvent.click(view.getByRole('button', { name: en.keyboardBackspace }))
  const arrows = [en.keyboardDirectionUp, en.keyboardDirectionDown, en.keyboardDirectionLeft, en.keyboardDirectionRight]
  const sequences = ['\x1b[A', '\x1b[B', '\x1b[D', '\x1b[C']
  for (let index = 0; index < 4; index += 1) {
    fireEvent.click(view.getByRole('button', { name: en.keyboardArrow.replace('{direction}', arrows[index]!) }))
  }
  expect([0, 1, 2, 3, 4, 5, 6].map(pressed)).toEqual(['\t', '\x1b', '\x7f', ...sequences])
  expect(onKey).toHaveBeenCalledTimes(7)
})

it('keeps Ctrl sticky, folds the next arrow and plain key, then clears the light', () => {
  const { view, pressed, onKey } = mount()
  const control = view.getByRole('button', { name: en.keyboardCtrl })
  fireEvent.click(control)
  expect(control.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(view.getByRole('button', { name: en.keyboardArrow.replace('{direction}', en.keyboardDirectionLeft) }))
  expect(pressed(0)).toBe('\x1b[1;5D')
  expect(control.getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(control)
  fireEvent.click(view.getByRole('button', { name: en.keyboardTab }))
  expect(pressed(1)).toBe('\t')
  expect(control.getAttribute('aria-pressed')).toBe('false')
  expect(onKey).toHaveBeenCalledTimes(2)
})

it('keeps Alt sticky, sends the escape-prefixed key and modified arrow, then clears the light', () => {
  const { view, pressed, onKey } = mount()
  const alt = view.getByRole('button', { name: en.keyboardAlt })
  const control = view.getByRole('button', { name: en.keyboardCtrl })
  fireEvent.click(alt)
  expect(alt.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(view.getByRole('button', { name: en.keyboardBackspace }))
  expect(pressed(0)).toBe('\x1b\x7f')
  expect(alt.getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(alt)
  fireEvent.click(control)
  expect(alt.getAttribute('aria-pressed')).toBe('false')
  expect(control.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(view.getByRole('button', { name: en.keyboardArrow.replace('{direction}', en.keyboardDirectionRight) }))
  expect(pressed(1)).toBe('\x1b[1;5C')
  fireEvent.click(alt)
  fireEvent.click(view.getByRole('button', { name: en.keyboardArrow.replace('{direction}', en.keyboardDirectionRight) }))
  expect(pressed(2)).toBe('\x1b[1;3C')
  expect(onKey).toHaveBeenCalledTimes(3)
})

it('cancels a lit Ctrl when its own key is pressed again', () => {
  const { view, pressed, onKey } = mount()
  const control = view.getByRole('button', { name: en.keyboardCtrl })
  fireEvent.click(control)
  fireEvent.click(control)
  expect(control.getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(view.getByRole('button', { name: en.keyboardEscape }))
  expect(pressed(0)).toBe('\x1b')
  expect(onKey).toHaveBeenCalledTimes(1)
})

it('pastes through the paste callback without sending key bytes', () => {
  const { view, onPaste, onKey } = mount()
  fireEvent.click(view.getByRole('button', { name: en.keyboardPaste }))
  expect(onPaste).toHaveBeenCalledTimes(1)
  expect(onKey).not.toHaveBeenCalled()
})

it('lifts the strip above the measured keyboard height and restores cleanup', () => {
  const { view, observer } = mount(312)
  const strip = view.getByRole('group', { name: en.screenKeyboard })
  expect(strip.style.bottom).toBe('312px')
  cleanup()
  const report = observer.mock.calls[0]![0]
  const teardown = observer.mock.results[0]!.value as () => void
  expect(() => { report(120); teardown() }).not.toThrow()
})

it('observes both viewport and window resize without a visual viewport', () => {
  const original = window.visualViewport
  Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true })
  try {
    const { observer } = mount(0)
    const report = observer.mock.calls[0]![0]
    const teardown = observer.mock.results[0]!.value as () => void
    expect(() => { report(80); teardown(); teardown() }).not.toThrow()
  } finally {
    Object.defineProperty(window, 'visualViewport', { value: original, configurable: true })
  }
})

it('maps a lit Ctrl onto every key kind', () => {
  expect(applyModifier(undefined, { send: 'a' })).toBe('a')
  expect(applyModifier('ctrl', { send: 'a' })).toBe('\x01')
  expect(applyModifier('ctrl', { send: 'z' })).toBe('\x1a')
  // Escape, Tab and Backspace have no letter to fold into a control character.
  expect(applyModifier('ctrl', { send: '\x1b' })).toBe('\x1b')
  expect(applyModifier('ctrl', { send: '\t' })).toBe('\t')
  expect(applyModifier('ctrl', { send: '\x7f' })).toBe('\x7f')
  expect(applyModifier('alt', { send: 'a' })).toBe('\x1ba')
  expect(applyModifier('alt', { send: '\x7f' })).toBe('\x1b\x7f')
  expect(applyModifier(undefined, { send: '' }, 'A')).toBe('\x1b[A')
  expect(applyModifier(undefined, { send: '' }, 'B')).toBe('\x1b[B')
  expect(applyModifier(undefined, { send: '' }, 'D')).toBe('\x1b[D')
  expect(applyModifier(undefined, { send: '' }, 'C')).toBe('\x1b[C')
  expect(applyModifier('ctrl', { send: '' }, 'C')).toBe('\x1b[1;5C')
  expect(applyModifier('alt', { send: '' }, 'D')).toBe('\x1b[1;3D')
})
