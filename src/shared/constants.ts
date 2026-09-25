import type { Settings } from './types'

/**
 * Engine protocol version (must match PROTOCOL_VERSION in engine.py). Bumping
 * it invalidates resident daemons from older builds: the app replaces them.
 */
export const ENGINE_PROTOCOL_VERSION = 3

/** How long the resident engine daemon stays alive after the app quits. */
export const DAEMON_IDLE_TIMEOUT_S = 1800

/** Default model — NVIDIA Parakeet TDT 0.6B v3 (multilingual, 25 EU languages). */
export const DEFAULT_MODEL_ID = 'nemo-parakeet-tdt-0.6b-v3'

/** Fallback model used if v3 is unavailable in the local onnx-asr registry. */
export const FALLBACK_MODEL_ID = 'nemo-parakeet-tdt-0.6b-v2'

/** GPU model — Qwen3-ASR 0.6B (Alibaba, 50+ languages) via the qwen-asr package. */
export const QWEN_MODEL_ID = 'qwen3-asr-0.6b'

/** Inference backend a model runs on. */
export type ModelBackend = 'onnx-asr' | 'qwen-asr'

export interface ModelDef {
  id: string
  label: string
  desc: string
  backend: ModelBackend
  /** true when the model runs on the NVIDIA GPU and needs the heavy torch deps. */
  gpu: boolean
}

/** Single source of truth for selectable speech models (UI + engine wiring). */
export const MODELS: ModelDef[] = [
  {
    id: DEFAULT_MODEL_ID,
    label: 'Parakeet TDT 0.6B v3 — recommended (GPU/CPU)',
    desc: 'NVIDIA Parakeet, 25 EU languages. Best German+English accuracy at realtime speed. Runs on your NVIDIA GPU when present, CPU otherwise.',
    backend: 'onnx-asr',
    gpu: false
  },
  {
    id: FALLBACK_MODEL_ID,
    label: 'Parakeet TDT 0.6B v2 (English · CPU)',
    desc: 'NVIDIA Parakeet, English-only. Runs on CPU via ONNX Runtime.',
    backend: 'onnx-asr',
    gpu: false
  },
  {
    id: QWEN_MODEL_ID,
    label: 'Qwen3-ASR 0.6B (GPU · max accuracy · slower live view)',
    desc: 'Highest accuracy on hard audio, 50+ languages, runs on your NVIDIA GPU in FP16. Autoregressive decoding: live partials lag noticeably; best for final-quality-only dictation.',
    backend: 'qwen-asr',
    gpu: true
  }
]

export function getModelDef(id: string): ModelDef | undefined {
  return MODELS.find((m) => m.id === id)
}

/** Backend for a model id — defaults to onnx-asr for unknown ids. */
export function modelBackend(id: string): ModelBackend {
  if (id.toLowerCase().startsWith('qwen')) return 'qwen-asr'
  return getModelDef(id)?.backend ?? 'onnx-asr'
}

export const DEFAULT_SETTINGS: Settings = {
  hotkey: {
    accelerator: 'CommandOrControl+Shift+Space',
    label: 'Ctrl + Shift + Space'
  },
  hotkeyMode: 'toggle',
  toggleWidgetHotkey: {
    accelerator: 'CommandOrControl+Shift+W',
    label: 'Ctrl + Shift + W'
  },
  pauseHotkey: {
    accelerator: 'CommandOrControl+Shift+P',
    label: 'Ctrl + Shift + P'
  },
  commandPaletteHotkey: {
    accelerator: 'CommandOrControl+Shift+K',
    label: 'Ctrl + Shift + K'
  },

  autoInsertAfterStop: true,
  insertMode: 'insert',
  appendNewline: false,
  pasteAsPlainText: true,
  injectionStrategy: 'auto',
  restoreClipboard: true,

  micDeviceId: null,
  // ON by default: after ~0.9 s of trailing silence the utterance finalizes and
  // inserts itself - speak, pause, text appears. Turn off for manual stop.
  autoStopOnSilence: true,
  silenceTimeoutMs: 900,
  vadThreshold: 0.012,
  // Live partial refresh cadence. The engine self-throttles when inference is
  // slower than this, so a low value never melts a slow machine.
  partialIntervalMs: 250,
  // Mic DSP defaults mirror the browser standard. Power users can turn echo
  // cancellation off for maximum dictation fidelity in quiet rooms.
  echoCancellation: true,
  noiseSuppression: true,

  modelId: DEFAULT_MODEL_ID,
  // fp32 is the right choice on GPU (int8 gains nothing there and risks
  // accuracy); int8 remains available for CPU-only machines.
  quantization: 'fp32',
  language: 'auto',

  launchAtStartup: false,
  // ON by default: the engine daemon starts with Windows (headless, ~2 GB RAM,
  // no CPU when idle) so the app NEVER waits for "Loading model" after boot.
  warmEngineAtLogin: true,
  startMinimized: false,
  showWidgetOnMinimize: true,
  alwaysShowWidget: false,
  closeToTray: true
}

export const WINDOW = {
  main: { width: 980, height: 720, minWidth: 760, minHeight: 560 },
  widget: { width: 356, height: 86 }
} as const

export const SUPPORTED_LANGUAGES: { code: string; label: string }[] = [
  { code: 'auto', label: 'Auto-detect' },
  { code: 'de', label: 'Deutsch' },
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'it', label: 'Italiano' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' }
]
