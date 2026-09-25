import Store from 'electron-store'
import { EventEmitter } from 'node:events'
import { DEFAULT_SETTINGS } from '../shared/constants'
import { parseAccelerator } from '../shared/hotkeys'
import type { Hotkey, Settings } from '../shared/types'
import { createLogger } from './logger'

const logger = createLogger('settings')

/**
 * Persistent, validated settings. Built on electron-store (atomic JSON writes
 * in userData). Unknown keys from older versions are merged onto the current
 * defaults so upgrades never crash on a missing field.
 */
class SettingsManager extends EventEmitter {
  private store: Store<{ settings: Settings }>
  private cache: Settings

  constructor() {
    super()
    this.store = new Store<{ settings: Settings }>({
      name: 'settings',
      defaults: { settings: DEFAULT_SETTINGS },
      clearInvalidConfig: true
    })
    this.cache = this.normalize(this.store.get('settings'))
    this.store.set('settings', this.cache)
  }

  /** Merge persisted values over defaults so new fields always exist. */
  private normalize(raw: Partial<Settings> | undefined): Settings {
    const merged: Settings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) }
    // Drop keys that no longer exist (removed settings from older versions)
    // so the store never accumulates dead entries.
    for (const key of Object.keys(merged) as (keyof Settings)[]) {
      if (!(key in DEFAULT_SETTINGS)) delete merged[key]
    }
    // Defensive clamps so a corrupt file can't put the engine in a bad state.
    merged.silenceTimeoutMs = clamp(merged.silenceTimeoutMs, 300, 10_000)
    merged.partialIntervalMs = clamp(merged.partialIntervalMs, 150, 2_000)
    merged.vadThreshold = clamp(merged.vadThreshold, 0.001, 0.2)
    const primary = validHotkey(merged.hotkey, DEFAULT_SETTINGS.hotkey)
    if (primary) merged.hotkey = primary
    merged.toggleWidgetHotkey = validHotkey(merged.toggleWidgetHotkey, null)
    merged.pauseHotkey = validHotkey(merged.pauseHotkey, null)
    merged.commandPaletteHotkey = validHotkey(merged.commandPaletteHotkey, null)
    if (!merged.modelId) merged.modelId = DEFAULT_SETTINGS.modelId
    return merged
  }

  get(): Settings {
    return this.cache
  }

  update(patch: Partial<Settings>): Settings {
    const next = this.normalize({ ...this.cache, ...patch })
    const prev = this.cache
    this.cache = next
    this.store.set('settings', next)
    logger.info('updated', Object.keys(patch))
    this.emit('changed', next, prev)
    return next
  }

  reset(): Settings {
    this.cache = { ...DEFAULT_SETTINGS }
    this.store.set('settings', this.cache)
    logger.info('reset to defaults')
    this.emit('changed', this.cache, this.cache)
    return this.cache
  }

  onChange(cb: (next: Settings, prev: Settings) => void): () => void {
    this.on('changed', cb)
    return () => this.off('changed', cb)
  }
}

function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v) || typeof v !== 'number') return min
  return Math.min(max, Math.max(min, v))
}

/** Keep only well-formed hotkeys: a real accelerator plus a display label. */
function validHotkey(h: Hotkey | null | undefined, fallback: Hotkey | null): Hotkey | null {
  if (!h || typeof h.accelerator !== 'string' || !parseAccelerator(h.accelerator)) return fallback
  if (typeof h.label !== 'string' || !h.label.trim()) return { ...h, label: h.accelerator }
  return h
}

export const settings = new SettingsManager()
