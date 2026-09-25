import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { IPC, EVT } from '../shared/ipc'
import type { Api } from '../shared/ipc'

/**
 * Wraps ipcRenderer.on so the renderer only ever receives the *payload*, never
 * the raw IpcRendererEvent (which would leak `sender`). Returns an unsubscribe.
 */
function subscribe<T extends any[]>(
  channel: string,
  cb: (...args: T) => void
): () => void {
  const listener = (_e: IpcRendererEvent, ...args: any[]) => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: Api = {
  // settings
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
  resetSettings: () => ipcRenderer.invoke(IPC.settingsReset),

  // recording
  toggleRecording: () => ipcRenderer.invoke(IPC.recToggle),
  startRecording: () => ipcRenderer.invoke(IPC.recStart),
  stopRecording: () => ipcRenderer.invoke(IPC.recStop),
  pauseRecording: () => ipcRenderer.invoke(IPC.recPause),
  cancelRecording: () => ipcRenderer.invoke(IPC.recCancel),

  // audio
  sendAudioFrame: (buffer) => ipcRenderer.send(IPC.audioFrame, buffer),
  notifyAudioStarted: (rate) => ipcRenderer.send(IPC.audioStarted, rate),
  notifyAudioError: (message) => ipcRenderer.send(IPC.audioError, message),
  reportLevel: (level) => ipcRenderer.send(IPC.audioLevel, level),

  // engine
  restartEngine: () => ipcRenderer.invoke(IPC.engineRestart),

  // injection
  testInjection: (text) => ipcRenderer.invoke(IPC.injectionTest, text),
  reinsertLast: () => ipcRenderer.invoke(IPC.reinsertLast),
  copyToClipboard: (text) => ipcRenderer.invoke(IPC.copyText, text),

  // diagnostics + history
  getDiagnostics: () => ipcRenderer.invoke(IPC.diagnosticsGet),
  getHistory: () => ipcRenderer.invoke(IPC.historyGet),
  clearHistory: () => ipcRenderer.invoke(IPC.historyClear),
  deleteHistoryItem: (id) => ipcRenderer.invoke(IPC.historyDelete, id),

  // hotkey capture
  beginHotkeyCapture: () => ipcRenderer.invoke(IPC.hotkeyCaptureStart),
  endHotkeyCapture: () => ipcRenderer.invoke(IPC.hotkeyCaptureCancel),

  // window
  minimizeToWidget: () => ipcRenderer.send(IPC.windowMinimizeToWidget),
  expandWindow: () => ipcRenderer.send(IPC.windowExpand),
  closeWindow: () => ipcRenderer.send(IPC.windowClose),
  quitApp: () => ipcRenderer.send(IPC.windowQuit),
  moveWidget: (dx, dy) => ipcRenderer.send(IPC.windowMoveWidget, dx, dy),
  openLogs: () => ipcRenderer.send(IPC.openLogs),
  openModelDir: () => ipcRenderer.send(IPC.openModelDir),
  whoAmI: () => ipcRenderer.invoke(IPC.whoAmI),

  // events
  onStatus: (cb) => subscribe(EVT.status, cb),
  onEngineState: (cb) => subscribe(EVT.engineState, cb),
  onTranscript: (cb) => subscribe(EVT.transcript, cb),
  onModelProgress: (cb) => subscribe(EVT.modelProgress, cb),
  onMetrics: (cb) => subscribe(EVT.metrics, cb),
  onSettingsChanged: (cb) => subscribe(EVT.settingsChanged, cb),
  onLevel: (cb) => subscribe(EVT.level, cb),
  onError: (cb) => subscribe(EVT.error, cb),
  onLog: (cb) => subscribe(EVT.log, cb),
  onCommandPalette: (cb) => subscribe(EVT.commandPalette, cb)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to expose preload API', error)
  }
} else {
  // contextIsolation is force-enabled in this app; this branch should never run.
  ;(globalThis as unknown as { api: Api }).api = api // eslint-disable-line no-extra-semi
}
