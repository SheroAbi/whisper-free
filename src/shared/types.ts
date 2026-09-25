// ---------------------------------------------------------------------------
// Shared domain types. Used by main, preload and renderer. Keep this file free
// of any runtime/Node/DOM imports so it can be consumed from every process.
// ---------------------------------------------------------------------------

/** High level recording/application status surfaced to all UI surfaces. */
export type AppStatus =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'inserting'
  | 'paused'
  | 'error'

/** Lifecycle of the local Parakeet inference engine (Python sidecar). */
export type EngineState =
  | 'stopped'
  | 'starting'
  | 'resolving-runtime'
  | 'downloading-model'
  | 'loading-model'
  | 'warming-up'
  | 'ready'
  | 'error'

export type HotkeyMode = 'toggle' | 'push-to-talk'

/** Where the final transcript goes. */
export type InsertMode = 'insert' | 'copy'

/** Cascade strategy for getting text into a foreign window. */
export type InjectionStrategy = 'auto' | 'paste' | 'type'

/**
 * A hotkey is stored primarily as an Electron accelerator string (so the
 * built-in globalShortcut path always works) plus a friendly label for the UI.
 * The optional raw uiohook descriptor enables true push-to-talk (key up).
 */
export interface Hotkey {
  accelerator: string // e.g. "CommandOrControl+Shift+Space"
  label: string // e.g. "Ctrl + Shift + Space"
  /** uiohook keycode of the main (non-modifier) key, when captured natively. */
  keycode?: number
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
}

export interface Settings {
  // --- Hotkeys -------------------------------------------------------------
  hotkey: Hotkey
  hotkeyMode: HotkeyMode
  toggleWidgetHotkey: Hotkey | null
  pauseHotkey: Hotkey | null
  commandPaletteHotkey: Hotkey | null

  // --- Insertion behaviour -------------------------------------------------
  autoInsertAfterStop: boolean
  insertMode: InsertMode
  appendNewline: boolean
  pasteAsPlainText: boolean
  injectionStrategy: InjectionStrategy
  restoreClipboard: boolean

  // --- Audio / VAD ---------------------------------------------------------
  micDeviceId: string | null
  autoStopOnSilence: boolean
  silenceTimeoutMs: number
  vadThreshold: number // 0..1 normalized energy threshold
  partialIntervalMs: number
  /** Mic DSP: echo cancellation. Off = rawest signal, best for close-talk dictation. */
  echoCancellation: boolean
  /** Mic DSP: noise suppression. Off = maximum fidelity in quiet rooms. */
  noiseSuppression: boolean

  // --- Engine / model ------------------------------------------------------
  modelId: string
  quantization: 'int8' | 'fp32'
  language: string // 'auto' | 'de' | 'en' | ...

  // --- App / window --------------------------------------------------------
  launchAtStartup: boolean
  /** Start the headless engine daemon at Windows login so the app is instant. */
  warmEngineAtLogin: boolean
  startMinimized: boolean
  showWidgetOnMinimize: boolean
  alwaysShowWidget: boolean
  closeToTray: boolean
}

export interface HistoryItem {
  id: string
  text: string
  timestamp: number
  durationMs: number
  latencyMs: number
  targetApp: string | null
  inserted: boolean
  method: string | null
}

export interface InjectionTarget {
  hwnd: string
  pid: number
  title: string
  processName: string | null
}

export interface InjectionResult {
  ok: boolean
  method: 'paste' | 'type' | 'clipboard-only' | 'none'
  target: InjectionTarget | null
  error?: string
  elapsedMs: number
}

export interface EngineMetrics {
  modelLoadMs: number | null
  lastInferenceMs: number | null
  avgInferenceMs: number | null
  partialCount: number
  rtf: number | null // real-time factor of last final inference
}

export interface PerfMetrics {
  startupMs: number | null
  engineReadyMs: number | null
  lastEndToEndMs: number | null // hotkey-stop -> text inserted
  lastModelLoadMs: number | null
  lastInferenceMs: number | null
  avgInferenceMs: number | null
}

export interface Diagnostics {
  appVersion: string
  engineState: EngineState
  engineBackend: string | null // e.g. "onnxruntime-cpu"
  modelId: string
  modelLoaded: boolean
  pythonPath: string | null
  pythonVersion: string | null
  micActive: boolean
  hotkeyRegistered: boolean
  hotkeyBackend: 'globalShortcut' | 'uiohook' | 'none'
  lastInjectionTarget: InjectionTarget | null
  uiohookAvailable: boolean
  metrics: PerfMetrics
  modelDir: string
  logFile: string
}

export interface ModelDownloadProgress {
  state: 'idle' | 'downloading' | 'done' | 'error'
  file: string
  receivedBytes: number
  totalBytes: number
  percent: number
  message: string
}

export interface TranscriptEvent {
  type: 'partial' | 'final'
  text: string
  /** monotonically increasing utterance id from the engine */
  utteranceId: number
  inferenceMs?: number
}

/** Reasons a recording stopped, for analytics/feedback in the UI. */
export type StopReason = 'hotkey' | 'silence' | 'manual' | 'error' | 'shutdown'
