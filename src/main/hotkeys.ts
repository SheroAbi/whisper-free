import { globalShortcut } from 'electron'
import { EventEmitter } from 'node:events'
import { createLogger } from './logger'
import type { Hotkey, Settings } from '../shared/types'
import {
  buildNativeKeycodes,
  parseAccelerator,
  prefersNativeHook
} from '../shared/hotkeys'

const logger = createLogger('hotkeys')

/** Safety timeout: if a capture session never ends (dead renderer), resume. */
const CAPTURE_TIMEOUT_MS = 45_000

/* eslint-disable @typescript-eslint/no-var-requires */
function loadUiohook(): { uIOhook: any; UiohookKey: any } | null {
  try {
    const mod = require('uiohook-napi')
    if (mod?.uIOhook && mod?.UiohookKey) return { uIOhook: mod.uIOhook, UiohookKey: mod.UiohookKey }
    return null
  } catch (err) {
    logger.warn('uiohook-napi unavailable; native hook disabled, using globalShortcut only', String(err))
    return null
  }
}

interface UiohookEvent {
  keycode: number
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** A hotkey that is matched against raw native key events. */
interface NativeBinding {
  keycode: number
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  onDown: () => void
  onUp?: () => void
}

export class HotkeyManager extends EventEmitter {
  private uio = loadUiohook()
  private keycodes = this.uio ? buildNativeKeycodes(this.uio.UiohookKey) : null

  private uiohookStarted = false
  private uioBindings: NativeBinding[] = []
  private registered = false
  private backend: 'globalShortcut' | 'uiohook' | 'none' = 'none'
  private primaryBackend: 'globalShortcut' | 'uiohook' | 'none' = 'none'

  private current: Settings | null = null

  /** True while the settings UI records a new combo: all bindings suspended. */
  private capturing = false
  private captureTimer: NodeJS.Timeout | null = null

  /** keycodes currently held down — filters out key auto-repeat. */
  private heldKeys = new Set<number>()

  constructor() {
    super()
    if (this.uio) {
      this.uio.uIOhook.on('keydown', (e: UiohookEvent) => this.onNativeKeydown(e))
      this.uio.uIOhook.on('keyup', (e: UiohookEvent) => this.onNativeKeyup(e))
    }
  }

  isAvailableUiohook(): boolean {
    return !!this.uio
  }

  getBackend(): 'globalShortcut' | 'uiohook' | 'none' {
    return this.backend
  }

  isRegistered(): boolean {
    return this.registered
  }

  isCapturing(): boolean {
    return this.capturing
  }

  private ensureUiohookStarted(): boolean {
    if (!this.uio) return false
    if (this.uiohookStarted) return true
    try {
      this.uio.uIOhook.start()
      this.uiohookStarted = true
      logger.info('native hook started')
      return true
    } catch (err) {
      logger.error('failed to start native hook', err)
      return false
    }
  }

  // -- binding application ---------------------------------------------------

  /** (Re)apply all hotkey bindings from settings. */
  apply(settings: Settings): void {
    this.current = settings
    this.suspendBindings()
    if (this.capturing) {
      logger.info('capture session active; bindings stay suspended')
      return
    }

    const ptt = settings.hotkeyMode === 'push-to-talk'
    if (ptt && !this.uio) {
      logger.warn('push-to-talk requested but native hook unavailable; binding as toggle instead')
    }

    this.primaryBackend = 'none'
    this.registerBinding(
      settings.hotkey,
      {
        // Push-to-talk semantics exist only on the native hook; every other
        // combination of mode/backend is a plain toggle.
        forceNative: ptt && !!this.uio,
        native: ptt
          ? { onDown: () => this.emit('ptt-down'), onUp: () => this.emit('ptt-up') }
          : { onDown: () => this.emit('toggle') },
        global: { onDown: () => this.emit('toggle') }
      },
      true
    )

    this.registerBinding(settings.toggleWidgetHotkey, {
      native: { onDown: () => this.emit('toggle-widget') },
      global: { onDown: () => this.emit('toggle-widget') }
    })
    this.registerBinding(settings.pauseHotkey, {
      native: { onDown: () => this.emit('pause') },
      global: { onDown: () => this.emit('pause') }
    })
    this.registerBinding(settings.commandPaletteHotkey, {
      native: { onDown: () => this.emit('command-palette') },
      global: { onDown: () => this.emit('command-palette') }
    })

    this.registered = this.primaryBackend !== 'none'
    this.backend = this.primaryBackend
    logger.info(
      'bindings applied;',
      'primary backend:',
      this.backend,
      settings.hotkey.accelerator,
      '| native bindings:',
      this.uioBindings.length
    )
  }

  /**
   * Bind one hotkey on the best available backend:
   * 1. native hook, when preferred (PTT, bare typing keys, CapsLock, numpad…)
   * 2. globalShortcut otherwise (swallows modifier combos cleanly)
   * 3. native hook fallback, if globalShortcut claims the combo is taken.
   * Each backend gets its own handlers — e.g. a push-to-talk key that can't
   * run on the native hook degrades to a toggle on globalShortcut instead of
   * getting stuck with a keydown that never sees its keyup.
   */
  private registerBinding(
    hotkey: Hotkey | null,
    opts: {
      forceNative?: boolean
      native: { onDown: () => void; onUp?: () => void }
      global: { onDown: () => void }
    },
    primary = false
  ): void {
    if (!hotkey?.accelerator) return
    const parsed = parseAccelerator(hotkey.accelerator)
    if (!parsed) {
      logger.warn('invalid accelerator, skipping:', hotkey.accelerator)
      return
    }

    const keycode = this.keycodes?.get(parsed.token)
    const nativePreferred =
      !!this.uio && keycode !== undefined && (opts.forceNative || prefersNativeHook(parsed, false))
    const bindNative = (): boolean => {
      if (keycode === undefined || !this.ensureUiohookStarted()) return false
      this.uioBindings.push({
        keycode,
        ctrl: parsed.ctrl,
        alt: parsed.alt,
        shift: parsed.shift,
        meta: parsed.meta,
        onDown: opts.native.onDown,
        onUp: opts.native.onUp
      })
      if (primary) this.primaryBackend = 'uiohook'
      return true
    }

    if (nativePreferred && bindNative()) return

    if (this.registerGlobal(hotkey.accelerator, opts.global.onDown)) {
      if (primary) this.primaryBackend = 'globalShortcut'
      return
    }

    if (!nativePreferred && bindNative()) {
      logger.warn('globalShortcut rejected', hotkey.accelerator, '— bound via native hook instead')
      return
    }

    logger.warn('could not bind hotkey on any backend:', hotkey.accelerator)
  }

  private registerGlobal(accelerator: string, cb: () => void): boolean {
    try {
      if (globalShortcut.isRegistered(accelerator)) globalShortcut.unregister(accelerator)
      const ok = globalShortcut.register(accelerator, cb)
      if (!ok) logger.warn('failed to register accelerator', accelerator)
      return ok
    } catch (err) {
      logger.warn('register error', accelerator, String(err))
      return false
    }
  }

  private suspendBindings(): void {
    this.uioBindings = []
    try {
      globalShortcut.unregisterAll()
    } catch {
      /* ignore */
    }
    this.registered = false
    this.backend = 'none'
  }

  // -- native key routing ----------------------------------------------------

  private matchesBinding(b: NativeBinding, e: UiohookEvent): boolean {
    return (
      e.keycode === b.keycode &&
      e.ctrlKey === b.ctrl &&
      e.altKey === b.alt &&
      e.shiftKey === b.shift &&
      e.metaKey === b.meta
    )
  }

  private onNativeKeydown(e: UiohookEvent): void {
    // First press only — ignore OS auto-repeat so toggles don't stutter.
    const firstPress = !this.heldKeys.has(e.keycode)
    this.heldKeys.add(e.keycode)
    if (this.capturing || !firstPress) return
    for (const b of this.uioBindings) {
      if (this.matchesBinding(b, e)) b.onDown()
    }
  }

  private onNativeKeyup(e: UiohookEvent): void {
    // Only a key that had a matching keydown gets a keyup — never fire twice.
    const wasHeld = this.heldKeys.delete(e.keycode)
    if (!wasHeld || this.capturing) return
    for (const b of this.uioBindings) {
      if (b.onUp && this.matchesBinding(b, e)) b.onUp()
    }
  }

  // -- capture session (settings UI) -----------------------------------------
  //
  // The renderer records the combo itself (DOM keydown) — that works
  // regardless of native-module availability and keeps the key from
  // re-triggering buttons. The manager's job during capture is to suspend
  // every binding, so the combo being re-bound neither fires nor gets
  // swallowed by Windows before it reaches the window.

  /** Suspend all hotkeys while the user records a new combination. */
  beginCapture(): boolean {
    if (!this.capturing) {
      this.suspendBindings()
      this.capturing = true
      logger.info('capture session started; all hotkeys suspended')
    }
    if (this.captureTimer) clearTimeout(this.captureTimer)
    this.captureTimer = setTimeout(() => {
      logger.warn('capture session timed out; resuming bindings')
      this.endCapture()
    }, CAPTURE_TIMEOUT_MS)
    return true
  }

  /** Resume normal hotkey handling (re-applies current settings). */
  endCapture(): void {
    if (this.captureTimer) {
      clearTimeout(this.captureTimer)
      this.captureTimer = null
    }
    if (!this.capturing) return
    this.capturing = false
    logger.info('capture session ended; re-applying bindings')
    if (this.current) this.apply(this.current)
  }

  unregisterAll(): void {
    this.suspendBindings()
  }

  dispose(): void {
    if (this.captureTimer) {
      clearTimeout(this.captureTimer)
      this.captureTimer = null
    }
    this.suspendBindings()
    if (this.uio && this.uiohookStarted) {
      try {
        this.uio.uIOhook.stop()
      } catch {
        /* ignore */
      }
      this.uiohookStarted = false
    }
  }
}
