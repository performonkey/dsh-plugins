/** Key sequences and modifier folding for the floating phone key strip. */
import type { LocaleKeysOf, Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** Key names reach the feature dictionary directly; a package test imports the dictionaries without the locale plugin merge. */
export type KeyboardTranslate = Translate<LocaleKeysOf<'sidebarTerminal'>>

/** Sticky modifier that prefixes the next key press and then clears. */
export type Modifier = 'ctrl' | 'alt' | undefined

/** Index into the four directions in ARROW_ORDER. */
export type ArrowIndex = 0 | 1 | 2 | 3

/** Direction names in the order arrows send and rotate: up, down, left, right. */
export const ARROW_ORDER = ['Up', 'Down', 'Left', 'Right'] as const

/** CSI final byte per direction in the same order as ARROW_ORDER. */
export const ARROW_SUFFIXES = ['A', 'B', 'D', 'C'] as const

/** A rendered key: the byte sequence it sends. */
export type Key = { readonly send: string }

/**
 * Apply a sticky modifier to one key press: Ctrl maps a letter to its control character
 * and an arrow to xterm's `CSI 1;5<suffix>` form, Alt prefixes Escape.
 * @param modifier - the lit modifier, if any.
 * @param key - the key the user pressed.
 * @param arrowSuffix - the arrow's CSI final byte when the pressed key is an arrow.
 * @returns the byte sequence to write to the terminal.
 */
export function applyModifier(modifier: Modifier, key: Key, arrowSuffix?: string): string {
  if (arrowSuffix !== undefined) return modifier === undefined ? `\x1b[${arrowSuffix}` : `\x1b[1;${modifier === 'ctrl' ? 5 : 3}${arrowSuffix}`
  if (modifier === undefined) return key.send
  if (modifier === 'alt') return `\x1b${key.send}`
  // Only letters fold to a control character; Escape and Tab pass through.
  /* v8 ignore next -- every Key.send is a non-empty sequence. */
  const code = key.send.codePointAt(0) ?? 0
  return code >= 97 && code <= 122 ? String.fromCodePoint(code - 96) : key.send
}
