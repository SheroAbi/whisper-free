import { app, BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from './logger'

const logger = createLogger('devRebuild')

/** Newest last-modified time (ms) found under a file or directory tree. */
function newestMtime(target: string): number {
  let st: fs.Stats
  try {
    st = fs.statSync(target)
  } catch {
    return 0
  }
  if (!st.isDirectory()) return st.mtimeMs

  let newest = st.mtimeMs
  let entries: string[]
  try {
    entries = fs.readdirSync(target)
  } catch {
    return newest
  }
  for (const name of entries) {
    const m = newestMtime(path.join(target, name))
    if (m > newest) newest = m
  }
  return newest
}

/**
 * Dev convenience for the "launch straight from the desktop icon" workflow.
 *
 * The shortcut starts Electron's GUI binary directly against the prebuilt
 * `out/` bundle and never rebuilds — so edits to the renderer/UI source would
 * stay invisible until a manual `npm run build`. This rebuilds the bundle in
 * the background (while the startup splash is showing) whenever the source is
 * newer than the build, then silently reloads the windows. The app is always
 * the latest source, with no terminal and no manual step.
 *
 * Safety:
 *  - No-op in a packaged build (`app.isPackaged`) — no toolchain is shipped.
 *  - No-op if the toolchain or the built marker is missing.
 *  - On build failure the existing (working) bundle is kept and nothing reloads.
 *  - Set WHISPER_FREE_NO_AUTOBUILD=1 to disable entirely.
 */
export function autoRebuildIfStale(getWindows: () => BrowserWindow[]): void {
  if (app.isPackaged || process.env.WHISPER_FREE_NO_AUTOBUILD) return

  const root = app.getAppPath()
  const evite = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
  const builtMarker = path.join(root, 'out', 'renderer', 'index.html')
  if (!fs.existsSync(evite) || !fs.existsSync(builtMarker)) return

  // Rebuild only when something the bundle is built from is newer than the build.
  const sources = [
    path.join(root, 'src'),
    path.join(root, 'electron.vite.config.ts'),
    path.join(root, 'tailwind.config.js'),
    path.join(root, 'postcss.config.js'),
    path.join(root, 'package.json')
  ]
  const srcNewest = Math.max(0, ...sources.map(newestMtime))
  const builtAt = newestMtime(builtMarker)
  if (srcNewest <= builtAt) {
    logger.info('bundle up to date — skipping rebuild')
    return
  }

  logger.info('source newer than bundle — rebuilding in background')

  // Run electron-vite via Electron-as-Node (no extra Node install, no console).
  const child = spawn(process.execPath, [evite, 'build'], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })

  let errTail = ''
  child.stderr?.on('data', (d) => {
    errTail = (errTail + String(d)).slice(-1200)
  })
  child.on('error', (e) => logger.warn('rebuild spawn failed', String(e)))
  child.on('exit', (code) => {
    if (code !== 0) {
      logger.warn('rebuild failed — keeping existing bundle', { code, err: errTail })
      return
    }
    logger.info('rebuild complete — reloading windows with the fresh bundle')
    for (const win of getWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.reloadIgnoringCache()
      }
    }
  })
}
