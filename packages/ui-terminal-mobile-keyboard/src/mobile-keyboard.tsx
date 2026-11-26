/** Phone input: a floating control strip that rides above the system keyboard. */
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './mobile-keyboard.module.css'
import {
  applyModifier,
  ARROW_ORDER,
  ARROW_SUFFIXES,
  type ArrowIndex,
  type KeyboardTranslate,
  type Modifier,
} from './mobile-keyboard-keys.ts'

export { applyModifier } from './mobile-keyboard-keys.ts'
export type { KeyboardTranslate } from './mobile-keyboard-keys.ts'

type KeyGlyph = { readonly viewBox: string; readonly d: string }

/**
 * Keystroke glyphs drawn in Apple SF Symbols style (MIT-licensed Cupertino Icons): the Tab,
 * Control, Option, Xmark (escape), Delete-left (backspace) and Doc-on-clipboard (paste) keys, plus the four chevrons.
 * Each path paints with `currentColor` inside its native viewBox on an opaque key chip.
 */
const KEY_ICONS = {
  tab: {
    viewBox: '-2 -383 382 382',
    d: 'M19 -173 Q0 -173 0 -192 Q0 -211 19 -211 L19 -211 L236 -211 L281 -209 L211 -274 L164 -322 Q158 -328 158 -336 Q158 -344 163.5 -349.5 Q169 -355 177 -355 L177 -355 Q182 -355 191 -348 L191 -348 L333 -206 Q338 -201 339 -196 L339 -196 L339 -336 Q339 -355 358 -355 L358 -355 Q366 -355 372 -349.5 Q378 -344 378 -336 L378 -336 L378 -47 Q378 -29 358 -29 L358 -29 Q339 -29 339 -47 L339 -47 L339 -188 Q338 -183 333 -178 L333 -178 L191 -36 Q184 -30 177 -30 L177 -30 Q158 -30 158 -48 L158 -48 Q158 -54 164 -62 L164 -62 L211 -110 L281 -174 L236 -173 L19 -173 Z',
  },
  ctrl: {
    viewBox: '-2 -380 376 376',
    d: 'M6 -121 L6 -121 L172 -291 Q178 -297 186 -297 L186 -297 Q195 -297 201 -291 L201 -291 L367 -121 Q372 -116 372 -107 L372 -107 Q372 -99 366.5 -93 Q361 -87 353 -87 L353 -87 Q347 -87 339 -93 L339 -93 L186 -249 L34 -93 Q26 -87 20 -87 L20 -87 Q12 -87 6 -93 Q0 -99 0 -107 Q0 -115 6 -121 Z',
  },
  alt: {
    viewBox: '-2 -413 442 442',
    d: 'M20 -388 L123 -388 Q154 -388 165 -362 L165 -362 L305 -45 Q310 -34 323 -34 L323 -34 L417 -34 Q425 -34 431.5 -28.5 Q438 -23 438 -15 Q438 -7 431.5 -1.5 Q425 4 417 4 L417 4 L313 4 Q284 4 272 -22 L272 -22 L131 -339 Q126 -350 114 -350 L114 -350 L20 -350 Q12 -350 6 -355.5 Q0 -361 0 -369 Q0 -377 6 -382.5 Q12 -388 20 -388 L20 -388 ZM279 -388 L417 -388 Q425 -388 431 -382.5 Q437 -377 437 -369 Q437 -361 431 -355.5 Q425 -350 417 -350 L417 -350 L279 -350 Q271 -350 265 -355.5 Q259 -361 259 -369 Q259 -377 265 -382.5 Q271 -388 279 -388 L279 -388 Z',
  },
  escape: {
    viewBox: '-2.75 -365 346 346',
    d: 'M6 -55 L6 -55 L143 -192 L6 -329 Q-7 -342 6 -356 Q19 -370 33 -356 L33 -356 L170 -219 L307 -356 Q320 -370 334 -356 L334 -356 Q348 -343 334 -329 L334 -329 L197 -192 L334 -55 Q347 -42 334 -28 L334 -28 Q320 -14 307 -28 L307 -28 L170 -165 L33 -28 Q20 -16 6 -28 L6 -28 Q-8 -41 6 -55 Z',
  },
  backspace: {
    viewBox: '-2 -426 468 468',
    d: 'M397 5 L397 5 L211 5 Q173 5 147 -21 L147 -21 L20 -152 Q0 -172 0 -192 L0 -192 Q0 -213 20 -233 L20 -233 L147 -364 Q171 -389 211 -389 L211 -389 L397 -389 Q464 -389 464 -323 L464 -323 L464 -61 Q464 5 397 5 ZM210 -29 L397 -29 Q430 -29 430 -63 L430 -63 L430 -321 Q430 -355 397 -355 L397 -355 L210 -355 Q186 -355 172 -341 L172 -341 L47 -211 Q38 -201 38 -192 L38 -192 Q38 -184 47 -174 L47 -174 L173 -45 Q188 -29 210 -29 L210 -29 ZM343 -104 L343 -104 Q337 -104 332 -109 L332 -109 L271 -169 L211 -109 Q206 -104 200 -104 L200 -104 Q193 -104 188 -109 Q183 -114 183 -121 L183 -121 Q183 -127 188 -132 L188 -132 L248 -192 L188 -252 Q183 -257 183 -264 Q183 -271 188 -276 Q193 -281 200 -281 L200 -281 Q206 -281 211 -276 L211 -276 L271 -215 L331 -276 Q336 -281 343 -281 Q350 -281 355 -276 Q360 -271 360 -264 L360 -264 Q360 -258 354 -252 L354 -252 L294 -192 L354 -132 Q360 -126 360 -121 L360 -121 Q360 -114 355 -109 Q350 -104 343 -104 Z',
  },
  paste: {
    viewBox: '-47.5 -450 516 516',
    d: 'M258 64 L62 64 Q0 64 0 1 L0 1 L0 -284 Q0 -347 62 -347 L62 -347 L102 -347 L102 -385 Q102 -448 164 -448 L164 -448 L359 -448 Q421 -448 421 -385 L421 -385 L421 -100 Q421 -37 359 -37 L359 -37 L320 -37 L320 1 Q320 64 258 64 L258 64 ZM212 -377 L212 -377 L311 -377 Q324 -377 324 -389 L324 -389 L324 -393 Q324 -405 311 -405 L311 -405 L212 -405 Q199 -405 199 -393 L199 -393 L199 -389 Q199 -377 212 -377 ZM64 32 L64 32 L255 32 Q287 32 287 0 L287 0 L287 -160 L172 -160 Q134 -160 134 -198 L134 -198 L134 -315 L64 -315 Q32 -315 32 -284 L32 -284 L32 0 Q32 32 64 32 ZM176 -191 L176 -191 L281 -191 L165 -309 L165 -202 Q165 -191 176 -191 Z',
  },
  up: {
    viewBox: '-2 -380 376 376',
    d: 'M6 -121 L6 -121 L172 -290 Q179 -297 186 -297 L186 -297 Q194 -297 201 -290 L201 -290 L367 -121 Q372 -117 372 -107 L372 -107 Q372 -99 366.5 -93 Q361 -87 353 -87 L353 -87 Q344 -87 339 -93 L339 -93 L186 -249 L34 -93 Q29 -87 20 -87 L20 -87 Q12 -87 6 -93 Q0 -99 0 -107 L0 -107 Q0 -116 6 -121 Z',
  },
  down: {
    viewBox: '-2 -380 376 376',
    d: 'M186 -87 L186 -87 Q178 -87 172 -93 L172 -93 L6 -263 Q0 -269 0 -277 Q0 -285 6 -291 Q12 -297 20 -297 L20 -297 Q26 -297 34 -291 L34 -291 L186 -135 L339 -291 Q347 -297 353 -297 L353 -297 Q361 -297 366.5 -291 Q372 -285 372 -277 L372 -277 Q372 -268 367 -263 L367 -263 L201 -93 Q195 -87 186 -87 Z',
  },
  left: {
    viewBox: '-83 -380 376 376',
    d: 'M176 -12 L176 -12 L6 -178 Q0 -184 0 -192 L0 -192 Q0 -201 6 -206 L6 -206 L176 -372 Q182 -378 190 -378 Q198 -378 204 -372 Q210 -366 210 -358 L210 -358 Q210 -352 204 -344 L204 -344 L48 -192 L204 -39 Q210 -31 210 -25 L210 -25 Q210 -17 204 -11.5 Q198 -6 190 -6 Q182 -6 176 -12 Z',
  },
  right: {
    viewBox: '-83 -380 376 376',
    d: 'M34 -12 Q28 -6 20 -6 Q12 -6 6 -12 Q0 -18 0 -26 L0 -26 Q0 -31 6 -39 L6 -39 L162 -192 L6 -345 Q0 -353 0 -359 L0 -359 Q0 -367 6 -372.5 Q12 -378 20 -378 Q28 -378 34 -372 L34 -372 L203 -206 Q210 -199 210 -192 Q210 -185 203 -178 L203 -178 L34 -12 Z',
  },
} as const

/** One keystroke glyph: a solid currentColor path inside an opaque key chip. */
function KeyIcon({ icon }: { icon: KeyGlyph }): ReactNode {
  return <span className={css.glyph} aria-hidden="true">
    <svg viewBox={icon.viewBox} width="20" height="20" focusable="false"><path fill="currentColor" d={icon.d} /></svg>
  </span>
}

/** Keys whose press must not move focus, so the system keyboard stays open. */
function keepFocus(event: MouseEvent): void {
  event.preventDefault()
}

/**
 * Measure how much of the viewport the on-screen keyboard covers.
 * On Android the layout viewport shrinks with the keyboard (innerHeight drops);
 * on iOS the layout viewport stays fixed while the visual viewport rises (offsetTop grows).
 * @returns callback reporting the current covered height in pixels.
 */
export function createKeyboardHeightObserver(): (report: (height: number) => void) => () => void {
  return (report) => {
    const measure = (): void => {
      // jsdom leaves visualViewport undefined despite the non-nullable DOM type.
      const visual = window.visualViewport as VisualViewport | undefined | null
      /* v8 ignore next -- jsdom reports innerHeight 768 while visualViewport reports 0. */
      const layoutGap = visual === undefined || visual === null ? 0 : window.innerHeight - visual.height
      report(Math.max(layoutGap, visual?.offsetTop ?? 0))
    }
    measure()
    const viewport = window.visualViewport as VisualViewport | undefined | null
    viewport?.addEventListener('resize', measure)
    viewport?.addEventListener('scroll', measure)
    window.addEventListener('resize', measure)
    return () => {
      viewport?.removeEventListener('resize', measure)
      viewport?.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }
}

/**
 * Render the floating strip: Tab, Ctrl, Alt, Escape, Backspace, Paste, and the four arrow keys,
 * each drawn as a keyboard keycap glyph. It pins to the viewport bottom flush with the system
 * keyboard — the keyboard covers the browser's own bottom inset, so the strip adds no gap of its
 * own — and keeps the cursor row visible above itself.
 * @param props.onKey - writes one key sequence to the terminal model.
 * @param props.onPaste - reads the clipboard and writes its text to the terminal model.
 * @param props.t - copy for the key names.
 * @param props.observer - keyboard-height observer seam, overridable in tests.
 * @returns the strip element.
 */
export function MobileKeyStrip({ onKey, onPaste, t, observer = createKeyboardHeightObserver() }: {
  /** @param data - the byte sequence produced by the pressed key. */
  onKey: (data: string) => void
  /** Writes clipboard text to the terminal. */
  onPaste: () => void
  t: KeyboardTranslate
  observer?: (report: (height: number) => void) => () => void
}): ReactNode {
  const [covered, setCovered] = useState(0)
  const [modifier, setModifier] = useState<Modifier>()
  useEffect(() => observer(setCovered), [observer])
  const press = (send: string): void => {
    onKey(applyModifier(modifier, { send }))
    setModifier(undefined)
  }
  const pressArrow = (index: ArrowIndex): void => {
    onKey(applyModifier(modifier, { send: '' }, ARROW_SUFFIXES[index]))
    setModifier(undefined)
  }
  const toggle = (next: Modifier): void => { setModifier(current => current === next ? undefined : next) }
  return <div className={css.strip} style={{ bottom: covered }} role="group" aria-label={t('screenKeyboard')}>
    <Button variant="outline" size="sm" className={css.key} onMouseDown={keepFocus} onClick={() => { press('\t') }}
      aria-label={t('keyboardTab')} title={t('keyboardTab')}><KeyIcon icon={KEY_ICONS.tab} /></Button>
    <Button variant="outline" size="sm" className={css.key} aria-pressed={modifier === 'ctrl'}
      onMouseDown={keepFocus} onClick={() => { toggle('ctrl') }}
      aria-label={t('keyboardCtrl')} title={t('keyboardCtrl')}><KeyIcon icon={KEY_ICONS.ctrl} /></Button>
    <Button variant="outline" size="sm" className={css.key} aria-pressed={modifier === 'alt'}
      onMouseDown={keepFocus} onClick={() => { toggle('alt') }}
      aria-label={t('keyboardAlt')} title={t('keyboardAlt')}><KeyIcon icon={KEY_ICONS.alt} /></Button>
    <Button variant="outline" size="sm" className={css.key} onMouseDown={keepFocus} onClick={() => { press('\x1b') }}
      aria-label={t('keyboardEscape')} title={t('keyboardEscape')}><KeyIcon icon={KEY_ICONS.escape} /></Button>
    <Button variant="outline" size="sm" className={css.key} onMouseDown={keepFocus} onClick={() => { press('\x7f') }}
      aria-label={t('keyboardBackspace')} title={t('keyboardBackspace')}><KeyIcon icon={KEY_ICONS.backspace} /></Button>
    <Button variant="outline" size="sm" className={css.key} onMouseDown={keepFocus} onClick={onPaste}
      aria-label={t('keyboardPaste')} title={t('keyboardPaste')}><KeyIcon icon={KEY_ICONS.paste} /></Button>
    {ARROW_ORDER.map((direction, index) => {
      const suffix = ARROW_SUFFIXES[index as ArrowIndex]
      const icon = suffix === 'A' ? KEY_ICONS.up : suffix === 'B' ? KEY_ICONS.down : suffix === 'D' ? KEY_ICONS.left : KEY_ICONS.right
      return <Button variant="outline" size="sm" className={css.key} key={direction}
        aria-label={t('keyboardArrow', { direction: t(`keyboardDirection${direction}`) })}
        onMouseDown={keepFocus} onClick={() => { pressArrow(index as ArrowIndex) }}><KeyIcon icon={icon} /></Button>
    })}
  </div>
}
