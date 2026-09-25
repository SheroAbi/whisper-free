import { Tray, Menu } from 'electron'
import { getTrayIcon } from './assets'
import { createLogger } from './logger'

const logger = createLogger('tray')

export interface TrayHandlers {
  onOpen: () => void
  onToggleRecording: () => void
  onTogglePause: () => void
  onToggleWidget: () => void
  onRestartEngine: () => void
  onQuit: () => void
}

export class TrayManager {
  private tray: Tray | null = null
  private recording = false
  private hotkeyLabel = ''

  constructor(private handlers: TrayHandlers) {}

  create(hotkeyLabel: string): void {
    this.hotkeyLabel = hotkeyLabel
    const icon = getTrayIcon(false)
    icon.setTemplateImage(false)
    this.tray = new Tray(icon)
    this.tray.setToolTip('Whisper Free')
    this.tray.on('click', () => this.handlers.onOpen())
    this.tray.on('double-click', () => this.handlers.onOpen())
    this.rebuildMenu()
    logger.info('tray created')
  }

  private rebuildMenu(): void {
    if (!this.tray) return
    const menu = Menu.buildFromTemplate([
      { label: 'Open Whisper Free', click: () => this.handlers.onOpen() },
      { type: 'separator' },
      {
        label: this.recording ? 'Stop dictation' : `Start dictation  (${this.hotkeyLabel})`,
        click: () => this.handlers.onToggleRecording()
      },
      { label: 'Pause / resume', click: () => this.handlers.onTogglePause() },
      { label: 'Toggle widget', click: () => this.handlers.onToggleWidget() },
      { type: 'separator' },
      { label: 'Restart engine', click: () => this.handlers.onRestartEngine() },
      { type: 'separator' },
      { label: 'Quit', click: () => this.handlers.onQuit() }
    ])
    this.tray.setContextMenu(menu)
  }

  setRecording(recording: boolean): void {
    if (this.recording === recording) return
    this.recording = recording
    if (this.tray) {
      const icon = getTrayIcon(recording)
      icon.setTemplateImage(false)
      this.tray.setImage(icon)
      this.tray.setToolTip(recording ? 'Whisper Free — listening…' : 'Whisper Free')
    }
    this.rebuildMenu()
  }

  setHotkeyLabel(label: string): void {
    this.hotkeyLabel = label
    this.rebuildMenu()
  }

  setStatusTooltip(text: string): void {
    this.tray?.setToolTip(`Whisper Free — ${text}`)
  }

  destroy(): void {
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
    }
  }
}
