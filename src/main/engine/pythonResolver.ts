import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createLogger } from '../logger'

const logger = createLogger('python')

export interface PythonRuntime {
  /** executable to spawn (venv python, "python", or "py") */
  cmd: string
  /** args that must precede the script (e.g. ["-3.12"] for the py launcher) */
  prefixArgs: string[]
  version: string // "3.11.9"
  isVenv: boolean
}

/** Directory holding the engine sources (engine.py, asr.py, ...). */
export function getEngineDir(): string {
  // Probe the likely locations in order. Covers: launched-directly via
  // electron.exe <root> (cwd == root), electron-vite dev, and packaged builds.
  const candidates = [
    path.join(process.cwd(), 'python'), // electron.exe <root> / dev: cwd is the project root
    path.join(app.getAppPath(), 'python'), // app path == project root when run unpackaged
    path.join(app.getAppPath(), '..', 'python') // historical dev layout
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'engine.py'))) return dir
  }
  return path.join(process.resourcesPath, 'python')
}

/** Where we create / expect the virtual environment. */
export function getVenvDir(): string {
  if (app.isPackaged) return path.join(app.getPath('userData'), 'python-venv')
  return path.join(getEngineDir(), '.venv')
}

const IS_WIN = process.platform === 'win32'

export function getVenvPython(): string {
  return IS_WIN
    ? path.join(getVenvDir(), 'Scripts', 'python.exe')
    : path.join(getVenvDir(), 'bin', 'python3')
}

/** site-packages of the venv (layout differs between Windows and macOS/Linux). */
export function getVenvSitePackages(): string | null {
  if (IS_WIN) return path.join(getVenvDir(), 'Lib', 'site-packages')
  try {
    const lib = path.join(getVenvDir(), 'lib')
    const py = fs.readdirSync(lib).find((d) => d.startsWith('python3'))
    return py ? path.join(lib, py, 'site-packages') : null
  } catch {
    return null
  }
}

/**
 * The GUI-subsystem twin of a CPython executable (`pythonw.exe`), or the input
 * unchanged when there is none.
 *
 * Why this exists — the "a terminal window pops up" bug:
 * the engine daemon is spawned DETACHED (it must outlive the app so the model
 * stays warm in VRAM), which means it owns no console at all. A venv's
 * `Scripts\python.exe` is NOT the interpreter — it is CPython's
 * `venvlauncher.exe`, which re-launches the *base* interpreter as a child
 * process. That child is a console app with no console to inherit, so Windows
 * allocates a brand new one for it: a black console — on Windows 11 a full
 * Windows Terminal window — appears next to the app. Node's `windowsHide`
 * (CREATE_NO_WINDOW) cannot prevent this: it only applies to the process WE
 * spawn, never to the one the launcher spawns behind our back.
 *
 * `pythonw.exe` is linked /SUBSYSTEM:WINDOWS, so neither the launcher nor the
 * interpreter it starts can ever be given a console. Same interpreter, same
 * site-packages, zero terminal windows.
 */
export function toWindowlessPython(exe: string): string {
  if (!IS_WIN) return exe // console windows only pop up on Windows
  if (!/python(\.exe)?$/i.test(exe)) return exe
  const windowless = exe.replace(/python(\.exe)?$/i, (m) =>
    m.toLowerCase() === 'python' ? 'pythonw' : 'pythonw.exe'
  )
  // Only swap when it is really there — a missing interpreter is worse than a
  // console window. Bare names (no directory) are left alone: they cannot be
  // checked without resolving PATH, and findBaseInterpreter() already hands us
  // absolute paths.
  return path.isAbsolute(exe) && fs.existsSync(windowless) ? windowless : exe
}

/** Windowless interpreter of the venv (falls back to python.exe if absent). */
export function getVenvPythonw(): string {
  return toWindowlessPython(getVenvPython())
}

function probeVersion(cmd: string, prefixArgs: string[]): string | null {
  try {
    const res = spawnSync(cmd, [...prefixArgs, '--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 6000
    })
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim()
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/)
    if (res.status === 0 && m) return m[0]
    return null
  } catch {
    return null
  }
}

/**
 * Turn a PATH-relative candidate (`python`, `py -3.12`) into the absolute
 * interpreter it resolves to. Absolute paths are what makes the windowless
 * swap in toWindowlessPython() possible, and they also drop the `py` launcher
 * from the chain (it spawns python.exe as a child — another console source).
 * Called once, for the winning candidate only.
 */
function absolutize(rt: PythonRuntime): PythonRuntime {
  if (path.isAbsolute(rt.cmd)) return rt
  try {
    const res = spawnSync(rt.cmd, [...rt.prefixArgs, '-c', 'import sys;print(sys.executable)'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 6000
    })
    const exe = (res.stdout ?? '').trim()
    if (res.status === 0 && exe && fs.existsSync(exe)) {
      return { ...rt, cmd: exe, prefixArgs: [] }
    }
  } catch {
    /* keep the relative command — it works, it just may flash a console */
  }
  return rt
}

function parseMinor(version: string): number {
  const parts = version.split('.')
  return Number(parts[1] ?? '0')
}

/** onnxruntime currently ships wheels for CPython 3.9 – 3.13. */
export function isVersionCompatible(version: string): boolean {
  const major = Number(version.split('.')[0])
  const minor = parseMinor(version)
  return major === 3 && minor >= 9 && minor <= 13
}

/**
 * The interpreter version recorded in pyvenv.cfg. Reading this file is instant;
 * spawning `python --version` (the fallback) costs ~0.4 s and blocks the main
 * process — wasteful on every boot when the answer never changes.
 */
function readVenvVersion(): string | null {
  try {
    const cfg = path.join(getVenvDir(), 'pyvenv.cfg')
    const m = fs.readFileSync(cfg, 'utf8').match(/version\s*=\s*(\d+\.\d+\.\d+)/i)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/** Returns the venv interpreter if it exists, else null. */
export function findVenvRuntime(): PythonRuntime | null {
  const venvPy = getVenvPython()
  if (!fs.existsSync(venvPy)) return null
  const version = readVenvVersion() ?? probeVersion(venvPy, [])
  if (!version) return null
  return { cmd: venvPy, prefixArgs: [], version, isVenv: true }
}

/**
 * uv installs CPython under %APPDATA%\uv\python\cpython-<ver>-...\python.exe and
 * the Windows `py` launcher does NOT list these, so a machine whose only usable
 * Python is uv-managed would otherwise fail the first-run bootstrap. Returns the
 * candidate executables, newest version first.
 */
function findUvPythons(): string[] {
  const out: string[] = []
  try {
    const uvRoot = IS_WIN
      ? path.join(process.env.APPDATA ?? '', 'uv', 'python')
      : path.join(process.env.HOME ?? '', '.local', 'share', 'uv', 'python')
    if (!fs.existsSync(uvRoot)) return out
    const dirs = fs
      .readdirSync(uvRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('cpython-3.'))
      .map((d) => d.name)
      .sort()
      .reverse()
    for (const name of dirs) {
      const exe = IS_WIN
        ? path.join(uvRoot, name, 'python.exe')
        : path.join(uvRoot, name, 'bin', 'python3')
      if (fs.existsSync(exe)) out.push(exe)
    }
  } catch {
    /* ignore — scanning is best-effort */
  }
  return out
}

/**
 * Best system interpreter to *build the venv from*. Prefers a version known to
 * have onnxruntime wheels (3.12 → 3.11 → 3.10 → 3.13 → 3.9), via the Windows
 * `py` launcher on Windows / Homebrew on macOS, falling back to uv-managed /
 * WHISPER_FREE_PYTHON / python3.
 */
export function findBaseInterpreter(): PythonRuntime | null {
  const candidates: { cmd: string; prefixArgs: string[] }[] = []

  const override = process.env.WHISPER_FREE_PYTHON || process.env.PARAKEET_PYTHON
  if (override) {
    candidates.push({ cmd: override, prefixArgs: [] })
  }
  for (const v of ['3.12', '3.11', '3.10', '3.13', '3.9']) {
    if (IS_WIN) {
      candidates.push({ cmd: 'py', prefixArgs: [`-${v}`] })
    } else {
      // Homebrew (Apple Silicon + Intel) and python.org installs on macOS.
      for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
        const exe = path.join(dir, `python${v}`)
        if (fs.existsSync(exe)) candidates.push({ cmd: exe, prefixArgs: [] })
      }
      candidates.push({ cmd: `python${v}`, prefixArgs: [] })
    }
  }
  // uv-managed CPythons that the `py` launcher does NOT expose as `py -3.x`.
  // Lets the first-run venv bootstrap succeed with zero terminal involvement.
  for (const exe of findUvPythons()) {
    candidates.push({ cmd: exe, prefixArgs: [] })
  }
  candidates.push({ cmd: 'python', prefixArgs: [] })
  candidates.push({ cmd: 'python3', prefixArgs: [] })
  if (IS_WIN) candidates.push({ cmd: 'py', prefixArgs: ['-3'] })

  let firstWorking: PythonRuntime | null = null
  for (const c of candidates) {
    const version = probeVersion(c.cmd, c.prefixArgs)
    if (!version) continue
    const rt: PythonRuntime = { ...c, version, isVenv: false }
    if (!firstWorking) firstWorking = rt
    if (isVersionCompatible(version)) {
      const abs = absolutize(rt)
      logger.info('selected base interpreter', abs.cmd, abs.prefixArgs.join(' '), version)
      return abs
    }
  }
  if (firstWorking) {
    logger.warn(
      'no onnxruntime-compatible Python (3.9-3.13) found; best available is',
      firstWorking.version
    )
    return absolutize(firstWorking)
  }
  return null
}
