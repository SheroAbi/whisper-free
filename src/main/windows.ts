import { BrowserWindow, screen, shell } from 'electron'
import path from 'node:path'
import Store from 'electron-store'
import { WINDOW } from '../shared/constants'
import { getAppIcon } from './assets'
import { createLogger } from './logger'
import { settings } from './settings'

const logger = createLogger('windows')

interface WinState {
  widget?: { x: number; y: number }
  main?: { x: number; y: number; width: number; height: number }
}

/**
 * Owns the two surfaces: the main control window (frameless, custom chrome) and
 * the always-on-top mini widget. Handles minimize-to-widget and quit/close.
 */
export class WindowManager {
  private main: BrowserWindow | null = null
  private widget: BrowserWindow | null = null
  private store = new Store<WinState>({ name: 'window-state' })
  isQuitting = false

  private webPreferences() {
    return {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // Keep audio capture alive while the main window is hidden (widget mode).
      backgroundThrottling: false
    }
  }

  private loadSurface(win: BrowserWindow, page: 'index' | 'widget'): void {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) {
      void win.loadURL(`${devUrl}/${page}.html`)
    } else {
      void win.loadFile(path.join(__dirname, `../renderer/${page}.html`))
    }
  }

  createMain(startMinimized: boolean): BrowserWindow {
    if (this.main && !this.main.isDestroyed()) return this.main
    const saved = this.store.get('main')
    const win = new BrowserWindow({
      width: saved?.width ?? WINDOW.main.width,
      height: saved?.height ?? WINDOW.main.height,
      x: saved?.x,
      y: saved?.y,
      minWidth: WINDOW.main.minWidth,
      minHeight: WINDOW.main.minHeight,
      show: false,
      frame: false,
      backgroundColor: '#0b0d12',
      title: 'Whisper Free',
      icon: getAppIcon(),
      webPreferences: this.webPreferences()
    })
    this.main = win
    this.loadSurface(win, 'index')

    win.once('ready-to-show', () => {
      if (!startMinimized) win.show()
      else if (settings.get().showWidgetOnMinimize) this.showWidget()
    })

    win.on('close', (e) => {
      if (this.isQuitting) return
      if (settings.get().closeToTray) {
        e.preventDefault()
        this.minimizeToWidget()
      }
    })

    win.on('moved', () => this.persistMainBounds())
    win.on('resized', () => this.persistMainBounds())

    win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })

    return win
  }

  private persistMainBounds(): void {
    if (!this.main || this.main.isDestroyed()) return
    const b = this.main.getBounds()
    this.store.set('main', b)
  }

  createWidget(): BrowserWindow {
    if (this.widget && !this.widget.isDestroyed()) return this.widget
    const { width, height } = WINDOW.widget
    const display = screen.getPrimaryDisplay().workArea
    const saved = this.store.get('widget')
    const x = saved?.x ?? display.x + display.width - width - 24
    const y = saved?.y ?? display.y + display.height - height - 24

    const win = new BrowserWindow({
      width,
      height,
      x,
      y,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: this.webPreferences()
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    this.widget = win
    this.loadSurface(win, 'widget')

    win.on('moved', () => {
      if (!this.widget || this.widget.isDestroyed()) return
      const [wx, wy] = this.widget.getPosition()
      this.store.set('widget', { x: wx, y: wy })
    })
    return win
  }

  getMain(): BrowserWindow | null {
    return this.main && !this.main.isDestroyed() ? this.main : null
  }

  getWidget(): BrowserWindow | null {
    return this.widget && !this.widget.isDestroyed() ? this.widget : null
  }

  showMain(): void {
    const win = this.getMain() ?? this.createMain(false)
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  showWidget(): void {
    const win = this.getWidget() ?? this.createWidget()
    win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
  }

  hideWidget(): void {
    const w = this.getWidget()
    if (w && !settings.get().alwaysShowWidget) w.hide()
  }

  minimizeToWidget(): void {
    logger.info('minimize to widget')
    const main = this.getMain()
    if (main) main.hide()
    if (settings.get().showWidgetOnMinimize || settings.get().alwaysShowWidget) {
      this.showWidget()
    }
  }

  expandWindow(): void {
    logger.info('expand from widget')
    this.showMain()
    this.hideWidget()
  }

  moveWidget(dx: number, dy: number): void {
    const w = this.getWidget()
    if (!w) return
    const [x, y] = w.getPosition()
    w.setPosition(x + Math.round(dx), y + Math.round(dy))
  }

  /** Send an event to every live surface. */
  broadcast(channel: string, ...args: unknown[]): void {
    for (const win of [this.getMain(), this.getWidget()]) {
      if (win && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, ...args)
      }
    }
  }

  isOwnWindow(webContentsId: number): boolean {
    return [this.getMain(), this.getWidget()].some(
      (w) => w?.webContents.id === webContentsId
    )
  }

  destroyAll(): void {
    this.isQuitting = true
    for (const w of [this.getMain(), this.getWidget()]) {
      if (w && !w.isDestroyed()) w.destroy()
    }
  }
}
