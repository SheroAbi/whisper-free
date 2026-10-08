import { spawn, execFile, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { clipboard, systemPreferences } from 'electron'
import { createLogger } from '../logger'
import type { InjectionResult, InjectionTarget, Settings } from '../../shared/types'

const logger = createLogger('inject')

interface Pending {
  resolve: (line: string) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  cmd: string
}

const COMMAND_TIMEOUT_MS = 5000
const POLL_INTERVAL_MS = 350

/**
 * The clipboard text to put back after pasting, or null when there is none
 * to restore: putting back only the text would replace a copied image or
 * file list (text/uri-list is the native file format) with plain text.
 */
async function readRestorableText(): Promise<string | null> {
  // Raw OS formats ("electron application/osclipboard;...") ride along with
  // ordinary text copies (a browser adds its source URL), so only images and
  // files decide that the clipboard must not be touched.
  const items = await clipboard.read()
  const holdsNonText = items.some((item) =>
    item.types.some((t) => t.startsWith('image/') || t === 'text/uri-list')
  )
  if (holdsNonText) return null
  const text = await clipboard.readText()
  return text === '' ? null : text
}

/** Puts the user's clipboard back once the paste has been consumed. */
function restoreClipboardLater(text: string): void {
  setTimeout(() => {
    clipboard.writeText(text).catch(() => undefined)
  }, 400)
}

/**
 * Windows: owns the persistent PowerShell Win32 helper and exposes a clean, promise
 * based API for: reading the foreground window, restoring focus, and injecting
 * text via the paste→type cascade. All commands are serialized through a FIFO
 * queue so the strict one-line-per-command protocol can never desync.
 * macOS: pastes via osascript / System Events instead (see injectMac).
 */
export class TextInjector {
  private proc: ChildProcessWithoutNullStreams | null = null
  private ready = false
  private readyWaiters: Array<(ok: boolean) => void> = []
  private queue: Pending[] = []
  private stdoutBuf = ''
  private lastExternalTarget: InjectionTarget | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private disposed = false
  private restartCount = 0

  start(): void {
    if (process.platform !== 'win32') {
      // macOS: no helper process - paste goes through System Events, which
      // needs the Accessibility permission. Ask once (shows the system prompt).
      if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(true)) {
        logger.warn('accessibility permission missing - auto-paste disabled until granted')
      }
      return
    }
    if (this.proc) return
    const scriptPath = this.resolveScriptPath()
    if (!fs.existsSync(scriptPath)) {
      logger.error('helper script missing', scriptPath)
      return
    }
    const psExe = this.resolvePowerShell()
    logger.info('starting win32 helper', psExe, scriptPath)

    try {
      this.proc = spawn(
        psExe,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      )
    } catch (err) {
      logger.error('failed to spawn helper', err)
      return
    }

    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (d: string) => logger.warn('helper stderr', d.trim()))
    this.proc.on('exit', (code) => this.onExit(code))
    this.proc.on('error', (err) => logger.error('helper proc error', err))
  }

  private resolveScriptPath(): string {
    // dev: source tree; prod: copied to resources by electron-builder.
    const devPath = path.join(__dirname, '../../src/main/injection/win32-input.ps1')
    if (fs.existsSync(devPath)) return devPath
    const here = path.join(__dirname, 'win32-input.ps1')
    if (fs.existsSync(here)) return here
    return path.join(process.resourcesPath, 'win32-input.ps1')
  }

  private resolvePowerShell(): string {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows'
    const ps = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return fs.existsSync(ps) ? ps : 'powershell.exe'
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    let idx: number
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).replace(/\r$/, '')
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1)
      this.onLine(line)
    }
  }

  private onLine(line: string): void {
    if (!this.ready) {
      if (line === 'READY') {
        this.ready = true
        this.restartCount = 0
        logger.info('win32 helper ready')
        this.readyWaiters.splice(0).forEach((w) => w(true))
        this.startPolling()
      }
      return
    }
    const pending = this.queue.shift()
    if (!pending) {
      logger.debug('unsolicited helper line', line)
      return
    }
    clearTimeout(pending.timer)
    pending.resolve(line)
  }

  private onExit(code: number | null): void {
    logger.warn('win32 helper exited', code)
    this.ready = false
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    const err = new Error('helper exited')
    this.queue.splice(0).forEach((p) => {
      clearTimeout(p.timer)
      p.reject(err)
    })
    this.readyWaiters.splice(0).forEach((w) => w(false))
    this.proc = null
    if (!this.disposed && this.restartCount < 5) {
      this.restartCount++
      const delay = Math.min(2000, 250 * this.restartCount)
      logger.info('restarting helper in', delay, 'ms')
      setTimeout(() => this.start(), delay)
    }
  }

  private whenReady(timeoutMs = 8000): Promise<boolean> {
    if (this.ready) return Promise.resolve(true)
    if (!this.proc) this.start()
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(this.ready), timeoutMs)
      this.readyWaiters.push((ok) => {
        clearTimeout(t)
        resolve(ok)
      })
    })
  }

  private send(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.ready) {
        reject(new Error('helper-not-ready'))
        return
      }
      const timer = setTimeout(() => {
        // The helper answers strictly in order. Dropping the timed-out entry
        // would hand its late reply to the next command and shift every reply
        // after it (FG answering PASTE, ...). Keep the entry, so a late reply
        // is consumed by the request it belongs to, and restart a helper that
        // has stopped answering; onExit fails whatever is still queued.
        reject(new Error(`helper-timeout: ${cmd.split('|')[0]}`))
        this.restartUnresponsiveHelper()
      }, COMMAND_TIMEOUT_MS)
      this.queue.push({ resolve, reject, timer, cmd })
      try {
        this.proc.stdin.write(cmd + '\n')
      } catch (err) {
        clearTimeout(timer)
        this.queue.pop()
        reject(err as Error)
      }
    })
  }

  private restartUnresponsiveHelper(): void {
    if (!this.proc || !this.ready) return
    logger.warn('win32 helper stopped answering - restarting it')
    this.ready = false
    try {
      this.proc.kill()
    } catch {
      /* onExit still runs */
    }
  }

  // --- foreground tracking ---------------------------------------------------

  private startPolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.pollForeground()
    }, POLL_INTERVAL_MS)
  }

  private async pollForeground(): Promise<void> {
    if (!this.ready) return
    try {
      const t = await this.getForeground()
      if (t && t.pid !== process.pid && t.title.trim() !== '') {
        const changed = this.lastExternalTarget?.hwnd !== t.hwnd
        this.lastExternalTarget = t
        if (changed) logger.debug('remembered external target', t.hwnd, t.title)
      }
    } catch {
      /* transient */
    }
  }

  async getForeground(): Promise<InjectionTarget | null> {
    const line = await this.send('FG')
    if (!line.startsWith('OK|')) return null
    const [, hwnd, pid, titleB64] = line.split('|')
    let title = ''
    try {
      title = Buffer.from(titleB64 ?? '', 'base64').toString('utf16le')
    } catch {
      title = ''
    }
    return { hwnd, pid: Number(pid), title, processName: null }
  }

  /** Best target for injection right now (foreground if external, else last). */
  async resolveTarget(): Promise<InjectionTarget | null> {
    const fg = await this.getForeground().catch(() => null)
    if (fg && fg.pid !== process.pid && fg.title.trim() !== '') return fg
    return this.lastExternalTarget
  }

  getLastExternalTarget(): InjectionTarget | null {
    return this.lastExternalTarget
  }

  isReady(): boolean {
    return this.ready
  }

  /** Never rejects: inject() promises not to throw. */
  copyToClipboard(text: string): Promise<void> {
    return clipboard.writeText(text).catch((err) => logger.warn('clipboard write failed', String(err)))
  }

  /**
   * "Just paste where I am." Drops the text on the clipboard and fires Ctrl+V
   * into whatever window currently has focus — no target hunting, no focus
   * stealing, no "no target" refusal. The global hotkey never steals focus and
   * the widget shows inactive, so the window the user was typing in is still the
   * foreground one. Falls back to Unicode-typing into the focused window, then
   * to leaving the text on the clipboard. Never throws.
   */
  async inject(
    text: string,
    target: InjectionTarget | null,
    settings: Settings
  ): Promise<InjectionResult> {
    const started = performance.now()
    const elapsed = () => Math.round(performance.now() - started)

    if (!text) {
      return { ok: false, method: 'none', target, error: 'empty-text', elapsedMs: elapsed() }
    }

    if (process.platform !== 'win32') return this.injectMac(text, target, settings, started)

    const okReady = await this.whenReady()
    if (!okReady) {
      await this.copyToClipboard(text)
      return {
        ok: false,
        method: 'clipboard-only',
        target,
        error: 'helper-unavailable',
        elapsedMs: elapsed()
      }
    }

    const strategy = settings.injectionStrategy
    const reportTarget = target ?? this.lastExternalTarget
    const willPaste = strategy !== 'type'
    const saved =
      willPaste && settings.restoreClipboard ? await readRestorableText().catch(() => null) : null
    // The old clipboard comes back only once the text was delivered; on the
    // clipboard-only fallback the dictation must stay there for Ctrl+V.
    let delivered = false
    if (willPaste) await this.copyToClipboard(text)
    logger.info('inject (blind paste) strategy', strategy)

    try {
      // Focus restore: if one of OUR windows has keyboard focus (user clicked
      // the record button / watched the transcript), a blind Ctrl+V would land
      // inside the app itself — invisible to the user. When we remember an
      // external target, bring IT back to the foreground before pasting.
      if (willPaste) {
        try {
          const fg = await this.getForeground()
          if (fg && fg.pid === process.pid) {
            const restore = reportTarget ?? this.lastExternalTarget
            if (restore && restore.pid !== process.pid) {
              const line = await this.send(`FOCUS|${restore.hwnd}`).catch((e) => String(e))
              if (/^OK\|True/i.test(line)) {
                logger.info('focus restored to external target', restore.title)
              } else {
                logger.warn('focus restore failed', line)
              }
            }
          }
        } catch {
          /* focus probe is best-effort — blind paste still applies */
        }
      }

      // 1) Ctrl+V into the focused window — the mandatory default path.
      if (willPaste) {
        const line = await this.send('PASTE').catch((e) => String(e))
        if (line.startsWith('OK')) {
          if (settings.appendNewline) await this.send('ENTER').catch(() => undefined)
          delivered = true
          logger.info(`inject ok via paste (${elapsed()} ms)`)
          return { ok: true, method: 'paste', target: reportTarget, elapsedMs: elapsed() }
        }
        logger.warn('blind paste failed, trying type fallback', line)
      }

      // 2) Unicode SendInput straight into the focused window.
      const payload = settings.appendNewline ? text + '\n' : text
      const b64 = Buffer.from(payload, 'utf16le').toString('base64')
      const line = await this.send(`TYPE|${b64}`).catch((e) => String(e))
      if (line.startsWith('OK')) {
        delivered = true
        logger.info(`inject ok via type (${elapsed()} ms)`)
        return { ok: true, method: 'type', target: reportTarget, elapsedMs: elapsed() }
      }

      // 3) Last resort: leave it on the clipboard for a manual Ctrl+V.
      await this.copyToClipboard(text)
      logger.warn('inject failed - clipboard fallback', line)
      return {
        ok: false,
        method: 'clipboard-only',
        target: reportTarget,
        error: line,
        elapsedMs: elapsed()
      }
    } finally {
      if (saved !== null && delivered) restoreClipboardLater(saved)
    }
  }

  /**
   * macOS: same "just paste where I am" contract - clipboard + Cmd+V into the
   * frontmost app via System Events (needs Accessibility permission for this
   * app). Without the permission the text stays on the clipboard.
   */
  private async injectMac(
    text: string,
    target: InjectionTarget | null,
    settings: Settings,
    started: number
  ): Promise<InjectionResult> {
    const elapsed = () => Math.round(performance.now() - started)
    const saved = settings.restoreClipboard ? await readRestorableText().catch(() => null) : null
    await this.copyToClipboard(text)
    const lines = ['tell application "System Events"', 'keystroke "v" using command down']
    if (settings.appendNewline) lines.push('key code 36')
    lines.push('end tell')
    const err = await new Promise<string | null>((resolve) => {
      execFile('osascript', lines.flatMap((l) => ['-e', l]), { timeout: COMMAND_TIMEOUT_MS }, (e) =>
        resolve(e ? String(e.message ?? e) : null)
      )
    })
    if (err) {
      // Keep the dictated text on the clipboard so the user can paste manually.
      logger.warn('mac paste failed - clipboard fallback', err)
      return { ok: false, method: 'clipboard-only', target, error: err, elapsedMs: elapsed() }
    }
    if (saved !== null) restoreClipboardLater(saved)
    logger.info(`inject ok via paste (${elapsed()} ms)`)
    return { ok: true, method: 'paste', target, elapsedMs: elapsed() }
  }

  dispose(): void {
    this.disposed = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    if (this.proc) {
      try {
        this.proc.stdin.write('QUIT\n')
      } catch {
        /* ignore */
      }
      try {
        this.proc.kill()
      } catch {
        /* ignore */
      }
      this.proc = null
    }
  }
}
