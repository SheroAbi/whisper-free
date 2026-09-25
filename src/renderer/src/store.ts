import { create } from 'zustand'
import type {
  Settings,
  AppStatus,
  EngineState,
  HistoryItem,
  Diagnostics,
  PerfMetrics,
  ModelDownloadProgress
} from '@shared/types'
import type { LogPayload } from '@shared/ipc'

export type View = 'home' | 'history' | 'settings' | 'diagnostics'

interface Toast {
  id: number
  scope: string
  message: string
  fatal: boolean
}

interface AppState {
  ready: boolean
  settings: Settings | null
  status: AppStatus
  statusMessage: string
  recording: boolean
  paused: boolean
  engineState: EngineState
  engineDetail: string
  modelProgress: ModelDownloadProgress | null
  partial: string
  final: string
  lastUtteranceId: number
  level: number
  history: HistoryItem[]
  diagnostics: Diagnostics | null
  metrics: PerfMetrics | null
  logs: LogPayload[]
  toasts: Toast[]
  view: View
  paletteOpen: boolean

  // actions
  setView: (v: View) => void
  setPalette: (open: boolean) => void
  refreshSettings: () => Promise<void>
  patchSettings: (patch: Partial<Settings>) => Promise<void>
  refreshHistory: () => Promise<void>
  refreshDiagnostics: () => Promise<void>
  pushToast: (t: Omit<Toast, 'id'>) => void
  dismissToast: (id: number) => void
  initBridge: () => void
}

let toastSeq = 1

export const useStore = create<AppState>((set, get) => ({
  ready: false,
  settings: null,
  status: 'idle',
  statusMessage: '',
  recording: false,
  paused: false,
  engineState: 'starting',
  engineDetail: '',
  modelProgress: null,
  partial: '',
  final: '',
  lastUtteranceId: 0,
  level: 0,
  history: [],
  diagnostics: null,
  metrics: null,
  logs: [],
  toasts: [],
  view: 'home',
  paletteOpen: false,

  setView: (v) => set({ view: v }),
  setPalette: (open) => set({ paletteOpen: open }),

  refreshSettings: async () => {
    const settings = await window.api.getSettings()
    set({ settings })
  },
  patchSettings: async (patch) => {
    const settings = await window.api.updateSettings(patch)
    set({ settings })
  },
  refreshHistory: async () => {
    const history = await window.api.getHistory()
    set({ history })
  },
  refreshDiagnostics: async () => {
    const diagnostics = await window.api.getDiagnostics()
    // Pull the live engine state too, so a fresh load/reload self-heals the
    // splash even if the onEngineState push was missed (e.g. after the
    // background dev-rebuild reloads the window).
    set({ diagnostics, engineState: diagnostics.engineState })
  },

  pushToast: (t) => {
    const id = toastSeq++
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }))
    setTimeout(() => get().dismissToast(id), t.fatal ? 12000 : 6000)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  initBridge: () => {
    const api = window.api

    api.onStatus((p) =>
      set({
        status: p.status,
        recording: p.recording,
        paused: p.paused,
        statusMessage: p.message ?? ''
      })
    )
    api.onEngineState((state, detail) => set({ engineState: state, engineDetail: detail ?? '' }))
    api.onTranscript((e) => {
      if (e.type === 'partial') {
        set({ partial: e.text, lastUtteranceId: e.utteranceId })
      } else {
        set({ final: e.text, partial: '', lastUtteranceId: e.utteranceId })
        void get().refreshHistory()
      }
    })
    api.onModelProgress((p) => set({ modelProgress: p }))
    api.onMetrics((m) => set({ metrics: m }))
    api.onSettingsChanged((settings) => set({ settings }))
    api.onLevel((level) => set({ level }))
    api.onError((e) => get().pushToast({ scope: e.scope, message: e.message, fatal: e.fatal }))
    api.onLog((l) =>
      set((s) => ({ logs: [...s.logs.slice(-299), l] }))
    )
    api.onCommandPalette(() => set({ paletteOpen: true }))

    void get().refreshSettings()
    void get().refreshHistory()
    void get().refreshDiagnostics()
    set({ ready: true })
  }
}))
