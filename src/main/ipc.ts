import { ipcMain, app, IpcMainInvokeEvent } from 'electron'
import { IPC } from '../shared/ipc'
import { settings } from './settings'
import { history } from './history'
import { AppController } from './controller'
import { WindowManager } from './windows'
import { createLogger } from './logger'

const logger = createLogger('ipc')

function toBuffer(arg: unknown): Buffer {
  if (Buffer.isBuffer(arg)) return arg
  if (arg instanceof ArrayBuffer) return Buffer.from(arg)
  if (ArrayBuffer.isView(arg)) return Buffer.from(arg.buffer, arg.byteOffset, arg.byteLength)
  return Buffer.alloc(0)
}

export function registerIpc(controller: AppController, windows: WindowManager): void {
  // --- settings ---
  ipcMain.handle(IPC.settingsGet, () => settings.get())
  ipcMain.handle(IPC.settingsUpdate, (_e, patch) => settings.update(patch))
  ipcMain.handle(IPC.settingsReset, () => settings.reset())

  // --- recording ---
  ipcMain.handle(IPC.recToggle, () => controller.toggle())
  ipcMain.handle(IPC.recStart, () => controller.startRecording('ui'))
  ipcMain.handle(IPC.recStop, () => controller.stopRecording('manual'))
  ipcMain.handle(IPC.recPause, () => controller.togglePause())
  ipcMain.handle(IPC.recCancel, () => controller.cancelRecording())

  // --- audio (fire and forget) ---
  ipcMain.on(IPC.audioFrame, (_e, buf) => controller.onAudioFrame(toBuffer(buf)))
  ipcMain.on(IPC.audioStarted, (_e, rate: number) => controller.onAudioStarted(rate))
  ipcMain.on(IPC.audioError, (_e, msg: string) => controller.onAudioError(msg))
  ipcMain.on(IPC.audioLevel, (_e, level: number) => controller.onLevel(level))

  // --- engine ---
  ipcMain.handle(IPC.engineRestart, () => controller.restartEngine())

  // --- injection ---
  ipcMain.handle(IPC.injectionTest, async (_e, text: string) => {
    const target = await controller.injector.resolveTarget().catch(() => null)
    return controller.injector.inject(text, target, settings.get())
  })
  ipcMain.handle(IPC.reinsertLast, () => controller.reinsertLast())
  ipcMain.handle(IPC.copyText, (_e, text: string) => controller.copyText(text))

  // --- diagnostics + history ---
  ipcMain.handle(IPC.diagnosticsGet, () => controller.getDiagnostics())
  ipcMain.handle(IPC.historyGet, () => history.list())
  ipcMain.handle(IPC.historyClear, () => history.clear())
  ipcMain.handle(IPC.historyDelete, (_e, id: string) => history.remove(id))

  // --- hotkey capture ---
  ipcMain.handle(IPC.hotkeyCaptureStart, () => controller.hotkeys.beginCapture())
  ipcMain.handle(IPC.hotkeyCaptureCancel, () => controller.hotkeys.endCapture())

  // --- window control ---
  ipcMain.on(IPC.windowMinimizeToWidget, () => windows.minimizeToWidget())
  ipcMain.on(IPC.windowExpand, () => windows.expandWindow())
  ipcMain.on(IPC.windowClose, () => {
    if (settings.get().closeToTray) windows.minimizeToWidget()
    else quit()
  })
  ipcMain.on(IPC.windowQuit, () => quit())
  ipcMain.on(IPC.windowMoveWidget, (_e, dx: number, dy: number) => windows.moveWidget(dx, dy))
  ipcMain.on(IPC.openLogs, () => controller.openLogs())
  ipcMain.on(IPC.openModelDir, () => controller.openModelDir())

  ipcMain.handle(IPC.whoAmI, (e: IpcMainInvokeEvent) => {
    const widget = windows.getWidget()
    return widget && e.sender.id === widget.webContents.id ? 'widget' : 'main'
  })

  logger.info('ipc handlers registered')
}

function quit(): void {
  app.quit()
}
