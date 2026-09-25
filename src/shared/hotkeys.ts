// ---------------------------------------------------------------------------
// Pure hotkey helpers shared by main and renderer: accelerator parsing,
// browser key -> accelerator token mapping, and the backend policy that
// decides whether a combo is bound via Electron's globalShortcut or the
// native keyboard hook. No runtime imports — safe in every process.
// ---------------------------------------------------------------------------

import type { Hotkey } from './types'

export interface ParsedAccelerator {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  /** Main (non-modifier) key token, e.g. "F9", "Space", "A", ",". */
  token: string
}

const CTRL_RE = /^(commandorcontrol|cmdorctrl|control|ctrl)$/i
const ALT_RE = /^(alt|option|optionoralt)$/i
const SHIFT_RE = /^shift$/i
const META_RE = /^(super|meta|cmd|command)$/i
const MODIFIER_ONLY_RE =
  /^(commandorcontrol|cmdorctrl|control|ctrl|alt|option|optionoralt|shift|super|meta|cmd|command)$/i

/**
 * Parse an Electron accelerator into modifier flags + main key token.
 * Returns null for garbage like "", "Ctrl+" or "Alt+Shift" (no main key) so
 * a corrupt settings file can never register a modifier-only "hotkey".
 */
export function parseAccelerator(accelerator: string): ParsedAccelerator | null {
  if (typeof accelerator !== 'string') return null
  const parts = accelerator
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.length === 0) return null
  const token = parts[parts.length - 1]
  if (MODIFIER_ONLY_RE.test(token)) return null
  const mods = parts.slice(0, -1)
  return {
    ctrl: mods.some((m) => CTRL_RE.test(m)),
    alt: mods.some((m) => ALT_RE.test(m)),
    shift: mods.some((m) => SHIFT_RE.test(m)),
    meta: mods.some((m) => META_RE.test(m)),
    token
  }
}

/** True when the two hotkeys bind the exact same key combination. */
export function sameCombo(a: Hotkey | null, b: Hotkey | null): boolean {
  if (!a || !b) return false
  const pa = parseAccelerator(a.accelerator)
  const pb = parseAccelerator(b.accelerator)
  if (!pa || !pb) return false
  return (
    pa.token.toUpperCase() === pb.token.toUpperCase() &&
    pa.ctrl === pb.ctrl &&
    pa.alt === pb.alt &&
    pa.shift === pb.shift &&
    pa.meta === pb.meta
  )
}

// ---------------------------------------------------------------------------
// Tokens <-> uiohook key names (main process)
// ---------------------------------------------------------------------------

/**
 * Accelerator token -> candidate uiohook key name(s). Letters, digits and
 * F-keys share their name; everything else is listed explicitly.
 */
const NATIVE_NAMES: Record<string, string[]> = {
  Space: ['Space'],
  Enter: ['Enter', 'Return'],
  Tab: ['Tab'],
  Escape: ['Escape', 'Esc'],
  Backspace: ['Backspace'],
  Delete: ['Delete'],
  Insert: ['Insert'],
  Home: ['Home'],
  End: ['End'],
  PageUp: ['PageUp'],
  PageDown: ['PageDown'],
  Up: ['ArrowUp'],
  Down: ['ArrowDown'],
  Left: ['ArrowLeft'],
  Right: ['ArrowRight'],
  CapsLock: ['CapsLock'],
  PrintScreen: ['PrintScreen'],
  ScrollLock: ['ScrollLock'],
  NumLock: ['NumLock'],
  ',': ['Comma'],
  '.': ['Period'],
  '/': ['Slash'],
  '\\': ['Backslash'],
  ';': ['Semicolon'],
  "'": ['Quote'],
  '[': ['BracketLeft'],
  ']': ['BracketRight'],
  '-': ['Minus'],
  '=': ['Equal'],
  '`': ['Backquote'],
  numadd: ['NumpadAdd'],
  numsub: ['NumpadSubtract'],
  nummult: ['NumpadMultiply'],
  numdiv: ['NumpadDivide'],
  numdec: ['NumpadDecimal'],
  numenter: ['NumpadEnter']
}

/** Token -> first uiohook keycode (built lazily by buildNativeMaps). */
export function buildNativeKeycodes(
  UiohookKey: Record<string, number>
): Map<string, number> {
  const map = new Map<string, number>()
  const add = (token: string, names: string[]) => {
    for (const name of names) {
      const code = UiohookKey[name]
      if (typeof code === 'number') {
        map.set(token, code)
        return
      }
    }
  }
  for (let i = 0; i < 26; i++) {
    const ch = String.fromCharCode(65 + i)
    add(ch, [ch])
  }
  for (let i = 0; i <= 9; i++) add(String(i), [String(i)])
  for (let i = 1; i <= 24; i++) add(`F${i}`, [`F${i}`])
  for (let i = 0; i <= 9; i++) add(`num${i}`, [`Numpad${i}`])
  for (const [token, names] of Object.entries(NATIVE_NAMES)) add(token, names)
  return map
}

/** uiohook keycode -> token (inverse of buildNativeKeycodes). */
export function buildTokenLookup(keycodes: Map<string, number>): Map<number, string> {
  const inverse = new Map<number, string>()
  for (const [token, code] of keycodes) {
    if (!inverse.has(code)) inverse.set(code, token)
  }
  return inverse
}

// ---------------------------------------------------------------------------
// Browser KeyboardEvent.code -> accelerator token (renderer capture)
// ---------------------------------------------------------------------------

const CODE_DIRECT: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  CapsLock: 'CapsLock',
  PrintScreen: 'PrintScreen',
  ScrollLock: 'ScrollLock',
  NumLock: 'NumLock',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  IntlBackslash: '\\',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
  NumpadEnter: 'numenter'
}

/** Modifier-only browser codes — never become a hotkey's main key. */
export const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'AltGraph'
])

/** Map a browser KeyboardEvent.code to an accelerator token, or null. */
export function tokenFromBrowserCode(code: string): string | null {
  if (!code) return null
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  const np = /^Numpad([0-9])$/.exec(code)
  if (np) return `num${np[1]}`
  return CODE_DIRECT[code] ?? null
}

/** Friendly display name for a token (used in labels). */
export function tokenLabel(token: string): string {
  if (/^num\d$/.test(token)) return `Num ${token.slice(3)}`
  const labels: Record<string, string> = {
    Up: '↑',
    Down: '↓',
    Left: '←',
    Right: '→',
    Escape: 'Esc',
    PageUp: 'PgUp',
    PageDown: 'PgDn',
    Backspace: 'Backspace',
    Delete: 'Del',
    Insert: 'Ins',
    numadd: 'Num +',
    numsub: 'Num −',
    nummult: 'Num *',
    numdiv: 'Num /',
    numdec: 'Num .',
    numenter: 'Num Enter'
  }
  return labels[token] ?? token
}

/** Build a Hotkey from a browser keydown event's code + modifier flags. */
export function buildHotkey(
  code: string,
  ctrl: boolean,
  alt: boolean,
  shift: boolean,
  meta: boolean
): Hotkey | null {
  const token = tokenFromBrowserCode(code)
  if (!token) return null
  const mods: string[] = []
  const labels: string[] = []
  if (ctrl) {
    mods.push('CommandOrControl')
    labels.push('Ctrl')
  }
  if (alt) {
    mods.push('Alt')
    labels.push('Alt')
  }
  if (shift) {
    mods.push('Shift')
    labels.push('Shift')
  }
  if (meta) {
    mods.push('Super')
    labels.push('Win')
  }
  return {
    accelerator: [...mods, token].join('+'),
    label: [...labels, tokenLabel(token)].join(' + '),
    ctrl,
    alt,
    shift,
    meta
  }
}

// ---------------------------------------------------------------------------
// Backend policy: globalShortcut vs native hook
// ---------------------------------------------------------------------------

/**
 * Tokens Electron's globalShortcut can register on Windows. Bare
 * letters/digits/punctuation are deliberately absent: registering them would
 * swallow the key system-wide (typing "a" anywhere would never reach any
 * app), so those go through the passive native hook instead.
 */
const GLOBAL_REGISTRABLE = new Set<string>([
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
  ...Array.from({ length: 10 }, (_, i) => String(i)),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  'Space',
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Up',
  'Down',
  'Left',
  'Right'
])

/**
 * Decide which backend should TRY first for a hotkey.
 * - Push-to-talk always needs the native hook (it is the only source of keyup).
 * - A bare main key (no modifier) that is a "typing" key goes native so we
 *   never eat the alphabet system-wide; bare F-keys are fine to swallow.
 * - Tokens globalShortcut cannot register (CapsLock, numpad, punctuation)
 *   always go native.
 */
export function prefersNativeHook(acc: ParsedAccelerator, pushToTalk: boolean): boolean {
  if (pushToTalk) return true
  const bare = !acc.ctrl && !acc.alt && !acc.shift && !acc.meta
  if (bare && !/^F([1-9]|1[0-9]|2[0-4])$/.test(acc.token)) return true
  return !GLOBAL_REGISTRABLE.has(acc.token)
}
