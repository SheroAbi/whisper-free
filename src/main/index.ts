const APP_START_TS = Date.now()

import './migrateLegacyData'
import { app, session, BrowserWindow, systemPreferences } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { initLogger, createLogger } from './logger'
import { settings } from './settings'
import { WindowManager } from './windows'
import { AppController } from './controller'
import { TrayManager } from './tray'
import { registerIpc } from './ipc'
import { autoRebuildIfStale } from './devRebuild'

initLogger()
const logger = createLogger('main')

// Single instance: focus the running app instead of launching a second copy.
// A second launch (e.g. double-clicking the desktop icon while it's open) must
// quit *immediately* — without running bootstrap — or it would spawn a duplicate
// engine and collide on the shared userData cache before exiting.
const gotLock = app.requestSingleInstanceLock()

let controller: AppController | null = null
let windows: WindowManager | null = null
let tray: TrayManager | null = null

app.setAppUserModelId('com.whisperfree.app')

// Predictable, low-latency audio in the renderer + harmless on machines without
// the matching GPU. Keeps capture stable across odd audio backends.
app.commandLine.appendSwitch('disable-renderer-backgrounding')

app.on('second-instance', () => {
  windows?.showMain()
})

// Strict CSP for packaged builds (all content is local; nothing remote loads).
function setupCSP(): void {
  if (!app.isPackaged) return
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "media-src 'self' blob: mediastream:",
    "worker-src 'self' blob:",
    "connect-src 'self'"
  ].join('; ')
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] }
    })
  })
}

// Allow microphone capture in our own (local) renderers; deny everything else.
function setupPermissions(): void {
  const allowed = new Set(['media', 'audioCapture'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(allowed.has(permission))
  )
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
}

// macOS gates the microphone per app (TCC): ask up front so the first
// dictation does not silently record nothing.
function requestMacMicAccess(): void {
  if (process.platform !== 'darwin') return
  if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return
  void systemPreferences.askForMediaAccess('microphone').catch(() => false)
}

// Dev harness: capture a PNG of every renderer view for visual review
// (`electron . --ui-shot`). Waits for the engine to be ready, then walks the
// views via the renderer's __setView hook and exits.
async function runUiShots(wm: WindowManager, ctrl: AppController): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const outDir = path.join(process.cwd(), '.ui-shots')
  fs.mkdirSync(outDir, { recursive: true })
  const win = wm.getMain()
  if (!win) return
  for (let i = 0; i < 300 && ctrl.engine.state !== 'ready'; i++) await sleep(200)
  await sleep(1200) // let the splash fade + first paint settle
  for (const view of ['home', 'history', 'settings', 'diagnostics']) {
    await win.webContents.executeJavaScript(
      `window.__setView && window.__setView(${JSON.stringify(view)})`
    )
    await sleep(450)
    const image = await win.webContents.capturePage()
    fs.writeFileSync(path.join(outDir, `${view}.png`), image.toPNG())
  }
  app.exit(0)
}

// Dev harness: end-to-end self test through the REAL app process
// (`electron . --self-test`). Exercises the full insertion chain (preload →
// IPC → TextInjector → PowerShell host → SendInput) and a recording round
// trip (start → stop → final from the daemon). Results go to the log.
async function runSelfTest(wm: WindowManager, ctrl: AppController): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const win = wm.getMain()
  if (!win) return
  for (let i = 0; i < 300 && ctrl.engine.state !== 'ready'; i++) await sleep(200)
  logger.info('selftest: engine ready')

  // 1) Insertion chain.
  const inject = await win.webContents
    .executeJavaScript(
      `window.api.testInjection('Whisper Free Selbsttest ' + new Date().toLocaleTimeString())`,
      true
    )
    .catch((e) => String(e))
  logger.info('selftest: injection result', JSON.stringify(inject))

  // 2) Recording round trip: start, feed 1 s of quiet audio frames, stop.
  //    Without real speech the final is empty — we only verify it ARRIVES.
  await win.webContents.executeJavaScript(`window.api.startRecording()`, true)
  await sleep(400)
  await win.webContents.executeJavaScript(
    `(function feed(){
        const n = 50; // ~1 s of 20 ms frames
        const f = new Int16Array(320);
        for (let i = 0; i < n; i++) window.api.sendAudioFrame(f.buffer);
        return n;
      })()`,
    true
  )
  await sleep(200)
  await win.webContents.executeJavaScript(`window.api.stopRecording()`, true)
  await sleep(2500)
  logger.info('selftest: recording round trip done, status =', ctrl.getStatusSnapshot().status)

  // 3) Optional full speech run: `--self-test-speech` generates a German TTS
  //    clip, feeds it through the REAL pipeline in real time (VAD → auto-stop
  //    → final → insertion) and lets the log prove the outcome.
  if (process.argv.includes('--self-test-speech')) {
    const wav = path.join(process.cwd(), '.selftest-tts.wav')
    spawnSync(
      'powershell',
      [
        '-NoProfile', '-Command',
        `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
        `$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); ` +
        `$s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}', $fmt); ` +
        `$s.Speak('Hallo, das ist ein Selbsttest der automatischen Texteinfügung.'); $s.Dispose()`
      ],
      { windowsHide: true, timeout: 30000 }
    )
    if (!fs.existsSync(wav)) {
      logger.warn('selftest: TTS generation failed')
      app.exit(0)
      return
    }
    const buf = fs.readFileSync(wav)
    let off = 12
    let pcm = buf.subarray(44)
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4)
      const size = buf.readUInt32LE(off + 4)
      if (id === 'data') {
        pcm = buf.subarray(off + 8, off + 8 + size)
        break
      }
      off += 8 + size + (size % 2)
    }
    const b64 = pcm.toString('base64')
    logger.info('selftest: feeding speech clip,', pcm.length / 2 / 16000, 's')
    await win.webContents.executeJavaScript(
      `(async () => {
         const bin = atob(${JSON.stringify(b64)});
         const pcm = new Int16Array(bin.length / 2);
         for (let i = 0; i < pcm.length; i++) pcm[i] = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
         await window.api.startRecording();
         const frame = 320;
         for (let off = 0; off + frame <= pcm.length; off += frame) {
           window.api.sendAudioFrame(pcm.subarray(off, off + frame).slice().buffer);
           await new Promise((r) => setTimeout(r, 20));
         }
         return 'fed ' + Math.floor(pcm.length / frame) + ' frames';
       })()`,
      true
    ).then((r) => logger.info('selftest:', String(r)))
    // auto-stop fires ~0.9 s after speech ends; final + insertion follow.
    await sleep(5000)
    try {
      fs.unlinkSync(wav)
    } catch {
      /* ignore */
    }
    logger.info('selftest: speech run done, status =', ctrl.getStatusSnapshot().status)
  }
  app.exit(0)
}

function bootstrap(): void {
  setupCSP()
  setupPermissions()
  requestMacMicAccess()
  windows = new WindowManager()
  controller = new AppController(windows, APP_START_TS)
  registerIpc(controller, windows)

  const startMinimized =
    settings.get().startMinimized || process.argv.includes('--minimized')

  windows.createMain(startMinimized)
  if (settings.get().alwaysShowWidget) windows.showWidget()

  tray = new TrayManager({
    onOpen: () => windows?.showMain(),
    onToggleRecording: () => void controller?.toggle(),
    onTogglePause: () => controller?.togglePause(),
    onToggleWidget: () => controller?.toggleWidget(),
    onRestartEngine: () => void controller?.restartEngine(),
    onQuit: () => {
      if (windows) windows.isQuitting = true
      app.quit()
    }
  })
  tray.create(settings.get().hotkey.label)
  controller.setTray(tray)
  controller.init()

  // Visual-review harness: render every view, save PNGs, quit. No tray noise.
  if (process.argv.includes('--ui-shot')) {
    void runUiShots(windows, controller)
    return
  }
  // Self-test harness: drive the real insertion + recording chain, log, quit.
  if (process.argv.some((a) => a.startsWith('--self-test'))) {
    void runSelfTest(windows, controller)
    return
  }

  // Launched straight from the desktop icon? The icon loads the prebuilt out/
  // bundle and never rebuilds, so rebuild in the background (behind the splash)
  // when the source changed, then silently reload — always the latest UI, no
  // terminal, no manual build. No-op when packaged / up to date / disabled.
  autoRebuildIfStale(() => {
    const list: BrowserWindow[] = []
    const m = windows?.getMain()
    if (m) list.push(m)
    const w = windows?.getWidget()
    if (w) list.push(w)
    return list
  })

  // Reflect persisted launch-at-startup preference on every boot.
  try {
    app.setLoginItemSettings({
      openAtLogin: settings.get().launchAtStartup,
      args: settings.get().startMinimized ? ['--minimized'] : []
    })
  } catch (err) {
    logger.warn('setLoginItemSettings failed', String(err))
  }

  logger.info('bootstrap complete', { startMinimized })
}

if (!gotLock) {
  app.quit()
} else {
  app.whenReady().then(bootstrap)
}

app.on('activate', () => windows?.showMain())

// Tray app: keep running when all windows are hidden/closed.
app.on('window-all-closed', () => {
  // Intentionally do nothing on Windows — the app lives in the tray.
})

app.on('before-quit', () => {
  logger.info('before-quit: tearing down')
  if (windows) windows.isQuitting = true
  controller?.dispose()
})

process.on('uncaughtException', (err) => logger.error('uncaughtException', err))
process.on('unhandledRejection', (err) => logger.error('unhandledRejection', String(err)))
