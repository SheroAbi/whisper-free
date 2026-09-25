import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { getEngineDir, getVenvPython, getVenvPythonw } from './pythonResolver'
import type { Settings } from '../../shared/types'
import { DAEMON_IDLE_TIMEOUT_S } from '../../shared/constants'
import { createLogger } from '../logger'

const logger = createLogger('autostart')

/**
 * Keeps the speech engine warm from Windows login: an HKCU Run entry starts
 * the Python daemon headless (pythonw, no window) with the model pre-loaded.
 * Whenever the app launches afterwards it attaches to that daemon and is
 * ready in milliseconds - the "Loading model" splash only ever appears right
 * after boot, while the login daemon is still loading in parallel.
 *
 * The entry is rewritten on every apply() so model/quantization changes
 * propagate to the next login. Removing it is a single reg delete.
 */

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_NAME = 'WhisperFreeEngine'
// Entry name used before the rename - removed so it never starts a 2nd daemon.
const LEGACY_RUN_NAME = 'ParakeetDictationEngine'

function connFilePath(): string {
  return path.join(app.getPath('userData'), 'engine-conn.json')
}

function daemonCommand(settings: Settings): string | null {
  // Explorer starts Run entries without a console, so a console-subsystem
  // interpreter would get its own terminal window at every login. pythonw only.
  const pythonw = getVenvPythonw()
  const enginePy = path.join(getEngineDir(), 'engine.py')
  if (pythonw === getVenvPython() || !fs.existsSync(pythonw) || !fs.existsSync(enginePy)) return null
  return [
    `"${pythonw}"`,
    `"${enginePy}"`,
    '--model', settings.modelId,
    '--quantization', settings.quantization,
    '--language', settings.language,
    '--serve',
    '--conn-file', `"${connFilePath()}"`,
    '--idle-timeout', String(DAEMON_IDLE_TIMEOUT_S)
  ].join(' ')
}

/** Register (enabled) or remove (disabled) the login entry. Idempotent. */
export function applyWarmEngineAutostart(settings: Settings): void {
  // Windows-only (HKCU Run key). On macOS the daemon still stays warm between
  // app launches; it just is not pre-started at login.
  if (process.platform !== 'win32') return
  try {
    spawnSync('reg', ['delete', RUN_KEY, '/v', LEGACY_RUN_NAME, '/f'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    if (!settings.warmEngineAtLogin) {
      spawnSync('reg', ['delete', RUN_KEY, '/v', RUN_NAME, '/f'], { windowsHide: true })
      logger.info('warm-engine login entry removed')
      return
    }
    const cmd = daemonCommand(settings)
    if (!cmd) {
      logger.warn('warm-engine autostart skipped - runtime not ready yet')
      return
    }
    const res = spawnSync(
      'reg',
      ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', cmd, '/f'],
      { windowsHide: true }
    )
    if (res.status === 0) logger.info('warm-engine login entry registered')
    else logger.warn('warm-engine login entry failed', String(res.stderr))
  } catch (err) {
    logger.warn('warm-engine autostart error', String(err))
  }
}
