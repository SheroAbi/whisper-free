import { app, clipboard, shell } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EngineManager } from './engine/EngineManager'
import { applyWarmEngineAutostart } from './engine/daemonAutostart'
import { TextInjector } from './injection/TextInjector'
import { HotkeyManager } from './hotkeys'
import { WindowManager } from './windows'
import { TrayManager } from './tray'
import { settings } from './settings'
import { history } from './history'
import { createLogger, getLogFilePath, subscribeLogs } from './logger'
import { EVT } from '../shared/ipc'
import type { StatusPayload } from '../shared/ipc'
import type {
  AppStatus,
  Diagnostics,
  InjectionResult,
  InjectionTarget,
  PerfMetrics,
  Settings,
  StopReason
} from '../shared/types'

const logger = createLogger('controller')

function normalizeFinal(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Whisper Free's persistent model folder - must match python/model_store.py. */
function modelsDir(): string {
  if (process.env.WHISPER_FREE_MODELS_DIR) return process.env.WHISPER_FREE_MODELS_DIR
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'WhisperFree', 'models')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'WhisperFree', 'models')
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'whisper-free', 'models')
}

/**
 * The application brain. Holds the recording state machine and connects the
 * engine, audio stream, text injector, hotkeys, windows and tray.
 */
export class AppController {
  readonly engine = new EngineManager()
  readonly injector = new TextInjector()
  readonly hotkeys = new HotkeyManager()

  private tray: TrayManager | null = null

  private status: AppStatus = 'idle'
  private recording = false
  private paused = false
  private micActive = false
  private utteranceId = 0

  private currentTarget: InjectionTarget | null = null
  private lastTarget: InjectionTarget | null = null
  private lastFinalText = ''

  private recordStartTs = 0
  private recordStopTs = 0
  private perf: PerfMetrics = {
    startupMs: null,
    engineReadyMs: null,
    lastEndToEndMs: null,
    lastModelLoadMs: null,
    lastInferenceMs: null,
    avgInferenceMs: null
  }

  constructor(
    private windows: WindowManager,
    private appStartTs: number
  ) {}

  setTray(tray: TrayManager): void {
    this.tray = tray
  }

  init(): void {
    this.wireEngine()
    this.wireHotkeys()
    subscribeLogs((l) => this.windows.broadcast(EVT.log, l))

    this.injector.start()
    this.hotkeys.apply(settings.get())
    void this.engine.start(settings.get())
    // Register (or remove) the warm-engine login entry on every boot; also
    // serves as the migration path the first time the setting appears.
    applyWarmEngineAutostart(settings.get())

    settings.onChange((next, prev) => this.onSettingsChanged(next, prev))
    this.perf.startupMs = Date.now() - this.appStartTs
  }

  // -- wiring --------------------------------------------------------------

  private wireEngine(): void {
    this.engine.on('state', (state, detail) =>
      this.windows.broadcast(EVT.engineState, state, detail)
    )
    this.engine.on('ready', () => {
      this.perf.engineReadyMs = Date.now() - this.appStartTs
      this.perf.lastModelLoadMs = this.engine.modelLoadMs
      this.emitMetrics()
      this.windows.broadcast(EVT.engineState, 'ready')
    })
    this.engine.on('progress', (p) => this.windows.broadcast(EVT.modelProgress, p))
    this.engine.on('metrics', () => {
      this.perf.lastModelLoadMs = this.engine.modelLoadMs
      this.emitMetrics()
    })
    this.engine.on('partial', (p: { utteranceId: number; text: string; inferenceMs?: number }) => {
      if (!this.recording) return
      this.windows.broadcast(EVT.transcript, {
        type: 'partial',
        text: p.text,
        utteranceId: p.utteranceId,
        inferenceMs: p.inferenceMs
      })
    })
    this.engine.on('final', (f) => void this.onFinal(f))
    this.engine.on('error', (e: { message: string; fatal: boolean }) => {
      this.windows.broadcast(EVT.error, { scope: 'engine', message: e.message, fatal: e.fatal })
      if (e.fatal) this.setStatus('error', e.message)
    })
    this.engine.on('pylog', (l: { level: string; message: string }) =>
      this.windows.broadcast(EVT.log, {
        level: l.level,
        scope: 'python',
        message: l.message,
        ts: Date.now()
      })
    )
  }

  private wireHotkeys(): void {
    this.hotkeys.on('toggle', () => void this.toggle())
    this.hotkeys.on('ptt-down', () => void this.startRecording('hotkey'))
    this.hotkeys.on('ptt-up', () => void this.stopRecording('hotkey'))
    this.hotkeys.on('pause', () => this.togglePause())
    this.hotkeys.on('toggle-widget', () => this.toggleWidget())
    this.hotkeys.on('command-palette', () => {
      this.windows.showMain()
      this.windows.broadcast(EVT.commandPalette)
    })
  }

  private onSettingsChanged(next: Settings, prev: Settings): void {
    this.windows.broadcast(EVT.settingsChanged, next)
    // Re-apply hotkeys if any binding/mode changed.
    const hk = (s: Settings) =>
      JSON.stringify([s.hotkey, s.hotkeyMode, s.toggleWidgetHotkey, s.pauseHotkey, s.commandPaletteHotkey])
    if (hk(next) !== hk(prev)) {
      this.hotkeys.apply(next)
      this.tray?.setHotkeyLabel(next.hotkey.label)
    }
    // Reload the model if engine-affecting settings changed.
    if (
      next.modelId !== prev.modelId ||
      next.quantization !== prev.quantization ||
      next.language !== prev.language
    ) {
      void this.engine.reload(next)
    }
    // Keep the Windows login entry for the warm-engine daemon in sync.
    if (
      next.warmEngineAtLogin !== prev.warmEngineAtLogin ||
      next.modelId !== prev.modelId ||
      next.quantization !== prev.quantization ||
      next.language !== prev.language
    ) {
      applyWarmEngineAutostart(next)
    }
    // Launch-at-startup toggle.
    if (next.launchAtStartup !== prev.launchAtStartup) {
      try {
        app.setLoginItemSettings({
          openAtLogin: next.launchAtStartup,
          args: next.startMinimized ? ['--minimized'] : []
        })
      } catch (err) {
        logger.warn('setLoginItemSettings failed', String(err))
      }
    }
  }

  // -- recording state machine --------------------------------------------

  private busy(): boolean {
    return this.status === 'transcribing' || this.status === 'inserting'
  }

  async toggle(): Promise<void> {
    if (this.recording) await this.stopRecording('hotkey')
    else await this.startRecording('hotkey')
  }

  async startRecording(_source: StopReason | 'ptt' | 'hotkey' | 'ui'): Promise<void> {
    if (this.recording || this.busy()) return
    if (!this.engine.isReady()) {
      const msg =
        this.engine.state === 'error'
          ? 'Speech engine error — see Diagnostics.'
          : 'Speech engine is still starting…'
      this.setStatus(this.engine.state === 'error' ? 'error' : 'idle', msg)
      this.windows.broadcast(EVT.error, { scope: 'engine', message: msg, fatal: false })
      return
    }

    // Capture the window that should receive the text BEFORE we steal focus.
    this.currentTarget = await this.injector.resolveTarget().catch(() => null)
    logger.info('record start; target=', this.currentTarget?.title ?? '(none)')

    this.recording = true
    this.paused = false
    this.utteranceId += 1
    this.lastFinalText = ''
    this.recordStartTs = Date.now()

    this.engine.startUtterance(this.utteranceId, settings.get())
    this.setStatus('listening')
    this.tray?.setRecording(true)
  }

  async stopRecording(reason: StopReason): Promise<void> {
    if (!this.recording) return
    this.recording = false
    this.paused = false
    this.recordStopTs = Date.now()
    logger.info('record stop; reason=', reason)
    this.setStatus('transcribing')
    this.tray?.setRecording(false)
    this.engine.stopUtterance()
  }

  cancelRecording(): void {
    if (!this.recording && this.status === 'idle') return
    this.recording = false
    this.paused = false
    this.engine.cancelUtterance()
    this.tray?.setRecording(false)
    this.setStatus('idle', 'cancelled')
    this.windows.broadcast(EVT.transcript, {
      type: 'final',
      text: '',
      utteranceId: this.utteranceId
    })
  }

  togglePause(): void {
    if (!this.recording) return
    this.paused = !this.paused
    this.setStatus(this.paused ? 'paused' : 'listening')
  }

  toggleWidget(): void {
    const w = this.windows.getWidget()
    if (w && w.isVisible()) this.windows.hideWidget()
    else this.windows.showWidget()
  }

  // -- audio plumbing ------------------------------------------------------

  onAudioFrame(buf: Buffer): void {
    if (this.recording && !this.paused) this.engine.sendAudio(buf)
  }

  onAudioStarted(rate: number): void {
    this.micActive = true
    logger.debug('mic active @', rate, 'Hz')
  }

  onAudioError(message: string): void {
    this.micActive = false
    logger.warn('audio error', message)
    this.windows.broadcast(EVT.error, { scope: 'audio', message, fatal: false })
    if (this.recording) void this.stopRecording('error')
  }

  onLevel(level: number): void {
    this.windows.broadcast(EVT.level, level)
  }

  // -- finalization + injection -------------------------------------------

  private async onFinal(f: {
    utteranceId: number
    text: string
    auto: boolean
    inferenceMs: number | null
    rtf: number | null
    empty: boolean
  }): Promise<void> {
    // Silence endpoint while still recording: mirror a manual stop.
    if (f.auto && this.recording) {
      this.recording = false
      this.paused = false
      this.recordStopTs = Date.now()
      this.setStatus('transcribing')
      this.tray?.setRecording(false)
    }

    const text = normalizeFinal(f.text || '')
    this.lastFinalText = text
    if (typeof f.inferenceMs === 'number') {
      this.perf.lastInferenceMs = f.inferenceMs
      this.perf.avgInferenceMs = this.engine.avgInferenceMs
    }
    logger.debug(
      'final received',
      JSON.stringify({ uid: f.utteranceId, auto: f.auto, chars: text.length })
    )
    this.windows.broadcast(EVT.transcript, {
      type: 'final',
      text,
      utteranceId: f.utteranceId,
      inferenceMs: f.inferenceMs ?? undefined
    })

    if (!text) {
      this.setStatus('idle')
      this.micActive = false
      return
    }

    const s = settings.get()

    if (s.insertMode === 'copy') {
      clipboard.writeText(s.appendNewline ? text + '\n' : text)
      this.recordHistory(text, false, 'copy', null)
      this.setStatus('idle', 'Copied to clipboard')
      this.finishMetrics()
      return
    }

    if (!s.autoInsertAfterStop) {
      clipboard.writeText(text)
      this.recordHistory(text, false, 'manual', null)
      this.setStatus('idle', 'Ready to paste')
      this.finishMetrics()
      return
    }

    this.setStatus('inserting')
    const target = this.currentTarget ?? (await this.injector.resolveTarget().catch(() => null))
    const result = await this.injector.inject(text, target, s)
    this.lastTarget = result.target ?? target ?? this.lastTarget

    this.recordHistory(text, result.ok, result.method, this.lastTarget)
    this.finishMetrics()

    if (!result.ok) {
      this.windows.broadcast(EVT.error, {
        scope: 'inject',
        message: 'Auto-paste did not go through — the text is on your clipboard, press Ctrl+V.',
        fatal: false
      })
    }
    this.setStatus('idle', result.ok ? `Inserted via ${result.method}` : 'Copied to clipboard')
    this.micActive = false
  }

  private finishMetrics(): void {
    if (this.recordStopTs) this.perf.lastEndToEndMs = Date.now() - this.recordStopTs
    this.perf.avgInferenceMs = this.engine.avgInferenceMs
    this.emitMetrics()
  }

  private recordHistory(
    text: string,
    inserted: boolean,
    method: string | null,
    target: InjectionTarget | null
  ): void {
    history.add({
      id: randomUUID(),
      text,
      timestamp: Date.now(),
      durationMs: this.recordStopTs && this.recordStartTs ? this.recordStopTs - this.recordStartTs : 0,
      latencyMs: this.perf.lastEndToEndMs ?? this.perf.lastInferenceMs ?? 0,
      targetApp: target?.title ?? null,
      inserted,
      method
    })
  }

  // -- reinsert / copy helpers (UI) ---------------------------------------

  async reinsertLast(): Promise<InjectionResult> {
    if (!this.lastFinalText) {
      return { ok: false, method: 'none', target: null, error: 'no-text', elapsedMs: 0 }
    }
    const target = await this.injector.resolveTarget().catch(() => null)
    const result = await this.injector.inject(this.lastFinalText, target, settings.get())
    this.lastTarget = result.target ?? target ?? this.lastTarget
    return result
  }

  copyText(text: string): boolean {
    clipboard.writeText(text)
    return true
  }

  // -- status broadcast ----------------------------------------------------

  private setStatus(status: AppStatus, message?: string): void {
    this.status = status
    const payload: StatusPayload = {
      status,
      recording: this.recording,
      paused: this.paused,
      message
    }
    this.windows.broadcast(EVT.status, payload)
    this.tray?.setStatusTooltip(message ?? status)
  }

  private emitMetrics(): void {
    this.windows.broadcast(EVT.metrics, this.perf)
  }

  getPerf(): PerfMetrics {
    return { ...this.perf, avgInferenceMs: this.engine.avgInferenceMs }
  }

  // -- diagnostics / paths -------------------------------------------------

  getDiagnostics(): Diagnostics {
    return {
      appVersion: app.getVersion(),
      engineState: this.engine.state,
      engineBackend: this.engine.backend,
      modelId: this.engine.modelId || settings.get().modelId,
      modelLoaded: this.engine.isReady(),
      pythonPath: this.engine.pythonPath,
      pythonVersion: this.engine.pythonVersion,
      micActive: this.micActive,
      hotkeyRegistered: this.hotkeys.isRegistered(),
      hotkeyBackend: this.hotkeys.getBackend(),
      lastInjectionTarget: this.lastTarget,
      uiohookAvailable: this.hotkeys.isAvailableUiohook(),
      metrics: this.getPerf(),
      modelDir: modelsDir(),
      logFile: getLogFilePath()
    }
  }

  openLogs(): void {
    try {
      shell.showItemInFolder(getLogFilePath())
    } catch {
      void shell.openPath(path.dirname(getLogFilePath()))
    }
  }

  openModelDir(): void {
    const dir = modelsDir()
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* openPath reports the problem */
    }
    void shell.openPath(dir)
  }

  async restartEngine(): Promise<void> {
    await this.engine.restart(settings.get())
  }

  getStatusSnapshot(): StatusPayload {
    return { status: this.status, recording: this.recording, paused: this.paused }
  }

  dispose(): void {
    this.hotkeys.dispose()
    this.engine.dispose()
    this.injector.dispose()
    this.tray?.destroy()
  }
}
