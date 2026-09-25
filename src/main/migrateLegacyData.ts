// One-time carry-over of user data from the app's previous name
// ("parakeet-dictation") into the Whisper Free data folder. Must be imported
// before anything that opens files in userData (logger, settings store).
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const LEGACY_DIR_NAMES = ['parakeet-dictation', 'Parakeet Dictation']
const CARRY_OVER = ['settings.json', 'history.json', 'window-state.json']

function migrate(): void {
  const userData = app.getPath('userData')
  if (fs.existsSync(path.join(userData, 'settings.json'))) return
  const appData = app.getPath('appData')
  for (const name of LEGACY_DIR_NAMES) {
    const legacy = path.join(appData, name)
    if (legacy === userData || !fs.existsSync(path.join(legacy, 'settings.json'))) continue
    fs.mkdirSync(userData, { recursive: true })
    for (const file of CARRY_OVER) {
      const src = path.join(legacy, file)
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(userData, file))
    }
    // The old build's resident engine daemon would otherwise idle on in VRAM.
    try {
      const conn = JSON.parse(fs.readFileSync(path.join(legacy, 'engine-conn.json'), 'utf8'))
      if (typeof conn.pid === 'number') process.kill(conn.pid)
    } catch {
      /* not running / already gone */
    }
    return
  }
}

try {
  migrate()
} catch {
  /* never block startup over a migration */
}
