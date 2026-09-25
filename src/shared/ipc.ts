// ---------------------------------------------------------------------------
// Central IPC channel registry + the typed API surface exposed via the
// preload contextBridge. Importing the channel names from one place keeps the
// main and preload sides impossible to desync.
// ---------------------------------------------------------------------------

import type {
  Settings,
  Diagnostics,
  HistoryItem,
  InjectionResult,
  AppStatus,
  EngineState,
  TranscriptEvent,
  ModelDownloadProgress,
  PerfMetrics
} from './types'

/** Renderer -> Main (invoke / handle). */
export const IPC = {
  // settings
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsReset: 'settings:reset',

  // recording control
  recToggle: 'rec:toggle',
  recStart: 'rec:start',
  recStop: 'rec:stop',
  recPause: 'rec:pause',
  recCancel: 'rec:cancel',

  // audio stream (renderer -> main, fire and forget)
  audioFrame: 'audio:frame',
  audioStarted: 'audio:started',
  audioError: 'audio:error',
  audioLevel: 'audio:level',

  // engine
  engineRestart: 'engine:restart',
  engineState: 'engine:state',

  // injection
  injectionTest: 'injection:test',
  reinsertLast: 'injection:reinsert',
  copyText: 'injection:copy',

  // diagnostics / metrics
  diagnosticsGet: 'diag:get',

  // history
  historyGet: 'history:get',
  historyClear: 'history:clear',
  historyDelete: 'history:delete',

  // hotkey capture (settings UI)
  hotkeyCaptureStart: 'hotkey:capture:start',
  hotkeyCaptureCancel: 'hotkey:capture:cancel',

  // window control
  windowMinimizeToWidget: 'window:minimizeToWidget',
  windowExpand: 'window:expand',
  windowClose: 'window:close',
  windowQuit: 'window:quit',
  windowMoveWidget: 'window:moveWidget',
  openLogs: 'window:openLogs',
  openModelDir: 'window:openModelDir',

  // which surface am I? (main vs widget)
  whoAmI: 'window:whoAmI'
} as const

/** Main -> Renderer (send / on). */
export const EVT = {
  status: 'evt:status',
  engineState: 'evt:engineState',
  transcript: 'evt:transcript',
  modelProgress: 'evt:modelProgress',
  metrics: 'evt:metrics',
  settingsChanged: 'evt:settingsChanged',
  level: 'evt:level',
  error: 'evt:error',
  log: 'evt:log',
  commandPalette: 'evt:commandPalette'
} as const

export type SurfaceKind = 'main' | 'widget'

export interface StatusPayload {
  status: AppStatus
  recording: boolean
  paused: boolean
  message?: string
}

export interface ErrorPayload {
  scope: string
  message: string
  fatal: boolean
}

export interface LogPayload {
  level: 'debug' | 'info' | 'warn' | 'error'
  scope: string
  message: string
  ts: number
}

/**
 * The full bridge exposed on `window.api`. Mirrored as ambient types in
 * src/preload/index.d.ts so the renderer is fully type-safe.
 */
export interface Api {
  // settings
  getSettings(): Promise<Settings>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  resetSettings(): Promise<Settings>

  // recording
  toggleRecording(): Promise<void>
  startRecording(): Promise<void>
  stopRecording(): Promise<void>
  pauseRecording(): Promise<void>
  cancelRecording(): Promise<void>

  // audio (renderer is the capture source)
  sendAudioFrame(buffer: ArrayBuffer): void
  notifyAudioStarted(actualSampleRate: number): void
  notifyAudioError(message: string): void
  reportLevel(level: number): void

  // engine
  restartEngine(): Promise<void>

  // injection
  testInjection(text: string): Promise<InjectionResult>
  reinsertLast(): Promise<InjectionResult>
  copyToClipboard(text: string): Promise<boolean>

  // diagnostics + history
  getDiagnostics(): Promise<Diagnostics>
  getHistory(): Promise<HistoryItem[]>
  clearHistory(): Promise<void>
  deleteHistoryItem(id: string): Promise<void>

  // hotkey capture (renderer records the combo; main suspends bindings)
  beginHotkeyCapture(): Promise<boolean>
  endHotkeyCapture(): Promise<void>

  // window
  minimizeToWidget(): void
  expandWindow(): void
  closeWindow(): void
  quitApp(): void
  moveWidget(dx: number, dy: number): void
  openLogs(): void
  openModelDir(): void
  whoAmI(): Promise<SurfaceKind>

  // events (main -> renderer). Each returns an unsubscribe fn.
  onStatus(cb: (p: StatusPayload) => void): () => void
  onEngineState(cb: (state: EngineState, detail?: string) => void): () => void
  onTranscript(cb: (e: TranscriptEvent) => void): () => void
  onModelProgress(cb: (p: ModelDownloadProgress) => void): () => void
  onMetrics(cb: (m: PerfMetrics) => void): () => void
  onSettingsChanged(cb: (s: Settings) => void): () => void
  onLevel(cb: (level: number) => void): () => void
  onError(cb: (e: ErrorPayload) => void): () => void
  onLog(cb: (l: LogPayload) => void): () => void
  onCommandPalette(cb: () => void): () => void
}
