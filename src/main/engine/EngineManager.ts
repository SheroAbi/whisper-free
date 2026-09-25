import { spawn, spawnSync, execFile, ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { createLogger } from '../logger'
import {
  getEngineDir,
  getVenvDir,
  getVenvPython,
  getVenvSitePackages,
  findVenvRuntime,
  findBaseInterpreter,
  isVersionCompatible,
  toWindowlessPython,
  type PythonRuntime
} from './pythonResolver'
import type { EngineState, Settings, ModelDownloadProgress } from '../../shared/types'
import { modelBackend, ENGINE_PROTOCOL_VERSION, DAEMON_IDLE_TIMEOUT_S } from '../../shared/constants'

const logger = createLogger('engine')

const MSG_AUDIO = 0x01
const MSG_CONTROL = 0x02

interface StartConfig {
  modelId: string
  quantization: 'int8' | 'fp32'
  language: string
}

interface ConnFile {
  port: number
  token: string
  pid: number
  version: number
  modelId?: string
}

/**
 * Supervises the Python inference sidecar. On first run it transparently builds
 * a virtual environment and installs dependencies (streaming progress to the
 * UI), then spawns engine.py as a RESIDENT DAEMON and brokers the binary
 * audio / JSON event streams over a loopback socket.
 *
 * The daemon keeps the model loaded across app restarts (it survives the app
 * quitting and exits after DAEMON_IDLE_TIMEOUT_S without a client), so a
 * relaunch attaches to the warm daemon and is ready in milliseconds.
 */
export class EngineManager extends EventEmitter {
  private proc: ChildProcess | null = null
  private sock: net.Socket | null = null
  private eventBuf = ''
  private disposed = false
  private restartCount = 0
  private restartTimer: NodeJS.Timeout | null = null

  state: EngineState = 'stopped'
  backend: string | null = null
  modelId = ''
  pythonPath: string | null = null
  pythonVersion: string | null = null
  modelLoadMs: number | null = null
  lastInferenceMs: number | null = null
  avgInferenceMs: number | null = null
  private inferenceSamples = 0
  private bootstrapping = false
  private recording = false

  private config: StartConfig = { modelId: '', quantization: 'int8', language: 'auto' }
  private nvidiaGpu: boolean | null = null
  private nvidiaProbe: Promise<boolean> | null = null

  isReady(): boolean {
    return this.state === 'ready'
  }

  /**
   * Is an NVIDIA GPU present? Probed via nvidia-smi (a few hundred ms) —
   * asynchronously, so the probe never blocks the main process during boot.
   * Kicked off at construction so it overlaps with venv resolution and the
   * Python interpreter start.
   */
  private probeNvidia(): Promise<boolean> {
    if (this.nvidiaGpu !== null) return Promise.resolve(this.nvidiaGpu)
    if (!this.nvidiaProbe) {
      this.nvidiaProbe = new Promise<boolean>((resolve) => {
        execFile(
          'nvidia-smi',
          ['--query-gpu=name', '--format=csv,noheader'],
          { timeout: 6000, windowsHide: true },
          (err) => {
            this.nvidiaGpu = !err
            if (this.nvidiaGpu) logger.info('NVIDIA GPU detected - CUDA execution enabled')
            resolve(this.nvidiaGpu)
          }
        )
      })
    }
    return this.nvidiaProbe
  }

  /** Resolved probe result (false while the async probe is still running). */
  private nvidiaKnown(): boolean {
    return this.nvidiaGpu === true
  }

  /**
   * Proof that the GPU build of ONNX Runtime is actually the one installed:
   * only onnxruntime-gpu ships the CUDA provider DLL. (A bare dist-info check
   * can be fooled by the CPU package being reinstalled on top.)
   */
  private gpuRuntimePresent(runtime: PythonRuntime): boolean {
    if (!runtime.isVenv || process.platform !== 'win32') return false
    const site = getVenvSitePackages()
    if (!site) return false
    return fs.existsSync(path.join(site, 'onnxruntime', 'capi', 'onnxruntime_providers_cuda.dll'))
  }

  /**
   * One-time install of the GPU build of ONNX Runtime (CUDA 13 + cuDNN 9 pip
   * wheels, ~600 MB). Non-fatal: if it fails we silently continue on CPU.
   */
  private async ensureGpuRuntime(runtime: PythonRuntime): Promise<void> {
    if (!(await this.probeNvidia())) return
    if (modelBackend(this.config.modelId) !== 'onnx-asr') return
    if (this.gpuRuntimePresent(runtime)) return

    this.setState('downloading-model', 'installing GPU runtime (one-time)')
    this.emit('pylog', {
      level: 'info',
      message: 'Installing GPU runtime for ONNX (onnxruntime-gpu + CUDA/cuDNN, one-time ~600 MB)…'
    })
    try {
      await this.run(
        runtime.cmd,
        [...runtime.prefixArgs, '-m', 'pip', 'uninstall', '-y', 'onnxruntime'],
        'gpu-deps'
      )
      await this.run(
        runtime.cmd,
        [...runtime.prefixArgs, '-m', 'pip', 'install', 'onnxruntime-gpu[cuda,cudnn]'],
        'gpu-deps'
      )
    } catch (err) {
      this.emit('pylog', {
        level: 'warn',
        message: `GPU runtime install failed (${String(err)}) - engine continues on CPU`
      })
      return
    }
    if (this.gpuRuntimePresent(runtime)) {
      this.emit('pylog', { level: 'info', message: 'GPU runtime installed - CUDA inference enabled' })
    } else {
      this.emit('pylog', {
        level: 'warn',
        message: 'GPU runtime not found after install - engine continues on CPU'
      })
    }
  }

  private setState(state: EngineState, detail?: string): void {
    if (this.state === state) return
    this.state = state
    logger.info('state', state, detail ?? '')
    this.emit('state', state, detail)
  }

  async start(settings: Settings): Promise<void> {
    if (this.proc || this.bootstrapping) return
    this.config = {
      modelId: settings.modelId,
      quantization: settings.quantization,
      language: settings.language
    }
    this.modelId = settings.modelId
    this.setState('starting')

    // GPU probe runs in parallel with everything below (non-blocking).
    void this.probeNvidia()

    let runtime = findVenvRuntime()
    if (!runtime) {
      runtime = await this.bootstrap().catch((err) => {
        logger.error('bootstrap failed', err)
        this.emitFatal(String(err?.message ?? err))
        return null
      })
    }
    if (!runtime) return
    this.pythonPath = runtime.cmd
    this.pythonVersion = runtime.version

    const depsOk = await this.ensureModelDeps(runtime, this.config.modelId)
    if (!depsOk) return

    await this.ensureGpuRuntime(runtime)

    // 1) A warm daemon from a previous run: attach to it (ready in ms).
    if (await this.attachWarmDaemon()) return
    // 2) Otherwise spawn the daemon and connect once it listens.
    this.spawnEngine(runtime)
    await this.connectUntilReady()
  }

  private connFilePath(): string {
    return path.join(app.getPath('userData'), 'engine-conn.json')
  }

  private readConnFile(): ConnFile | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.connFilePath(), 'utf8')) as ConnFile
      if (typeof raw.port === 'number' && typeof raw.token === 'string') return raw
    } catch {
      /* not there / corrupt -> cold start */
    }
    return null
  }

  /**
   * Try to attach to a resident daemon (model already in VRAM). Resolves true
   * when the handshake succeeded and the event stream is live.
   */
  private attachWarmDaemon(): Promise<boolean> {
    const conn = this.readConnFile()
    if (!conn) return Promise.resolve(false)
    return this.connectToDaemon(conn, 600).then((ok) => {
      if (ok) logger.info('attached to warm engine daemon - instant ready')
      return ok
    })
  }

  /** After spawning: poll the conn file + socket until the daemon answers. */
  private async connectUntilReady(): Promise<void> {
    for (let i = 0; i < 90 && !this.disposed; i++) {
      await new Promise((r) => setTimeout(r, 300))
      const conn = this.readConnFile()
      if (!conn) continue
      if (await this.connectToDaemon(conn, 400)) return
    }
    if (!this.disposed && !this.sock) {
      this.emitFatal('engine daemon did not come up (see logs)')
    }
  }

  private connectToDaemon(conn: ConnFile, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.disposed || this.sock) return resolve(!!this.sock)
      if (conn.version !== ENGINE_PROTOCOL_VERSION) {
        logger.info('daemon protocol mismatch - replacing daemon')
        this.killDaemonPid(conn.pid)
        return resolve(false)
      }
      let settled = false
      let handshakeBuf = ''
      let sock: net.Socket | null = null

      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        sock?.off('data', onHandshake)
        if (!ok) sock?.destroy()
        resolve(ok)
      }

      const onHandshake = (chunk: string) => {
        handshakeBuf += chunk
        let idx: number
        while ((idx = handshakeBuf.indexOf('\n')) >= 0) {
          const line = handshakeBuf.slice(0, idx).trim()
          handshakeBuf = handshakeBuf.slice(idx + 1)
          if (!line) continue
          let msg: any
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }
          if (msg.type === 'hello') {
            if (String(msg.version) !== String(ENGINE_PROTOCOL_VERSION)) {
              logger.warn('daemon protocol mismatch at handshake')
              return finish(false)
            }
            if (!sock) return finish(false)
            const s = sock
            s.off('data', onHandshake)
            this.wireSocket(s, handshakeBuf)
            this.restartCount = 0
            return finish(true)
          }
          if (msg.type === 'error') {
            logger.warn('daemon rejected handshake', String(msg.message ?? ''))
            return finish(false)
          }
        }
      }

      sock = net.connect({ host: '127.0.0.1', port: conn.port })
      const s = sock
      s.setNoDelay(true)
      const timer = setTimeout(() => finish(false), Math.max(timeoutMs, 4000))

      s.on('connect', () => {
        // Send OUR hello first: the daemon replies only after seeing it
        // (token check) — waiting for its reply before speaking deadlocks.
        const hello = {
          cmd: 'hello',
          token: conn.token,
          version: ENGINE_PROTOCOL_VERSION,
          modelId: this.config.modelId,
          quantization: this.config.quantization,
          language: this.config.language
        }
        this.writeFrameTo(s, Buffer.from(JSON.stringify(hello), 'utf8'))
        s.setEncoding('utf8')
        s.on('data', onHandshake)
      })
      s.on('error', () => finish(false))
      s.on('close', () => finish(false))
    })
  }

  /** Route daemon JSON events + lifecycle through the existing handlers. */
  private wireSocket(sock: net.Socket, leftover = ''): void {
    this.sock = sock
    this.eventBuf = leftover
    sock.on('data', (c: string) => this.feedEvents(c))
    sock.on('close', () => this.onDaemonLost())
    sock.on('error', (err) => logger.warn('daemon socket error', String(err)))
    this.restartCount = 0
    // The handshake reply and the state replay usually arrive in ONE chunk;
    // drain whatever followed the hello line immediately instead of waiting
    // for a further data event that may never come.
    if (leftover) this.feedEvents('')
  }

  private feedEvents(chunk: string): void {
    this.eventBuf += chunk
    let idx: number
    while ((idx = this.eventBuf.indexOf('\n')) >= 0) {
      const line = this.eventBuf.slice(0, idx).trim()
      this.eventBuf = this.eventBuf.slice(idx + 1)
      if (line) this.handleEvent(line)
    }
  }

  private onDaemonLost(): void {
    if (this.sock) this.sock = null
    this.recording = false
    if (this.disposed) return
    logger.warn('daemon connection lost')
    if (this.state !== 'error') this.setState('stopped')
    this.scheduleRespawn()
  }

  private scheduleRespawn(): void {
    if (this.restartCount >= 4) {
      this.emitFatal('engine daemon crashed repeatedly; check logs and Python setup')
      return
    }
    this.restartCount += 1
    const delay = Math.min(4000, 600 * this.restartCount)
    logger.info('respawning engine daemon in', delay, 'ms')
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => {
      if (this.disposed) return
      const runtime = findVenvRuntime()
      if (!runtime) {
        this.emitFatal('Python runtime vanished - restart the app')
        return
      }
      this.spawnEngine(runtime)
      void this.connectUntilReady()
    }, delay)
  }

  private killDaemonPid(pid: number): void {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
      } else {
        process.kill(pid, 'SIGKILL')
      }
    } catch {
      /* best effort */
    }
  }

  /**
   * Make sure the backend a model needs is importable. Parakeet (onnx-asr) is
   * always present from the base requirements; the Qwen GPU backend pulls heavy
   * torch + qwen-asr deps that we install on first selection so the model is
   * "ready the moment it's picked". No-op (and instant) once installed.
   */
  private async ensureModelDeps(runtime: PythonRuntime, modelId: string): Promise<boolean> {
    if (modelBackend(modelId) !== 'qwen-asr') return true
    if (this.qwenDepsPresent(runtime)) return true

    this.setState('downloading-model', 'installing Qwen runtime (first use)')
    this.emit('pylog', {
      level: 'info',
      message: 'Installing Qwen3-ASR dependencies (torch + qwen-asr, up to ~2.5 GB, one-time)…'
    })
    // CUDA build of torch on NVIDIA machines, the plain (CPU / Apple MPS) build
    // everywhere else - the cu124 wheels do not exist for macOS.
    const reqFile =
      process.platform !== 'darwin' && (await this.probeNvidia())
        ? 'requirements-qwen.txt'
        : 'requirements-qwen-cpu.txt'
    const req = path.join(getEngineDir(), reqFile)
    if (!fs.existsSync(req)) {
      this.emitFatal(`Qwen requirements not found at ${req}`)
      return false
    }
    try {
      await this.run(
        runtime.cmd,
        [...runtime.prefixArgs, '-m', 'pip', 'install', '-r', req],
        'qwen-deps'
      )
    } catch (err) {
      this.emitFatal(`Failed to install Qwen3-ASR GPU dependencies: ${String(err)}`)
      return false
    }
    if (!this.importable(runtime, 'import torch, qwen_asr')) {
      this.emitFatal('Qwen3-ASR dependencies installed but still not importable')
      return false
    }
    return true
  }

  /**
   * Are the heavy Qwen deps (torch + qwen_asr) already installed? The hot path
   * is a pure filesystem probe of the venv's site-packages — checking this by
   * spawning `python -c "import torch"` costs ~5 s on Windows (and blocks the
   * main process), which we paid on *every* launch. We only fall back to the
   * authoritative import when the package dirs aren't found (e.g. non-venv).
   */
  private qwenDepsPresent(runtime: PythonRuntime): boolean {
    const sitePackages = runtime.isVenv ? getVenvSitePackages() : null
    if (sitePackages) {
      const present = (pkg: string) => fs.existsSync(path.join(sitePackages, pkg))
      if (present('torch') && present('qwen_asr')) return true
    }
    return this.importable(runtime, 'import torch, qwen_asr')
  }

  private importable(runtime: PythonRuntime, code: string): boolean {
    try {
      const res = spawnSync(runtime.cmd, [...runtime.prefixArgs, '-c', code], {
        windowsHide: true,
        timeout: 30000
      })
      return res.status === 0
    } catch {
      return false
    }
  }

  private spawnEngine(runtime: PythonRuntime): void {
    const engineDir = getEngineDir()
    const script = path.join(engineDir, 'engine.py')
    if (!fs.existsSync(script)) {
      this.emitFatal(`engine.py not found at ${script}`)
      return
    }
    // Remove a stale conn file so we never race an old daemon's port.
    try {
      fs.unlinkSync(this.connFilePath())
    } catch {
      /* fine */
    }
    const args = [
      ...runtime.prefixArgs,
      script,
      '--model',
      this.config.modelId,
      '--quantization',
      this.config.quantization,
      '--language',
      this.config.language,
      '--serve',
      '--conn-file',
      this.connFilePath(),
      '--idle-timeout',
      String(DAEMON_IDLE_TIMEOUT_S)
    ]
    // pythonw.exe, never python.exe: the daemon is spawned DETACHED, so the
    // console-subsystem interpreter (or the venv launcher's child interpreter)
    // would be handed a brand-new console window by Windows. See
    // toWindowlessPython() for the full story.
    const exe = toWindowlessPython(runtime.cmd)
    logger.info('spawning engine daemon', exe)

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      HF_HUB_DISABLE_TELEMETRY: '1'
    }
    // Hint the sidecar at CUDA when an NVIDIA GPU is present (onnx-asr honours
    // PARAKEET_PROVIDERS; an explicit user setting always wins). By spawn time
    // the async probe has resolved (ensureGpuRuntime awaited it).
    if (
      this.nvidiaKnown() &&
      modelBackend(this.config.modelId) === 'onnx-asr' &&
      !env.PARAKEET_PROVIDERS
    ) {
      env.PARAKEET_PROVIDERS = 'CUDAExecutionProvider,CPUExecutionProvider'
    }

    try {
      // Detached: the daemon must SURVIVE the app quitting (that is the whole
      // point - the model stays in VRAM for the next launch). stderr is kept
      // for crash diagnostics; events flow over the socket, not stdio.
      this.proc = spawn(exe, args, {
        cwd: engineDir,
        windowsHide: true,
        detached: true,
        env,
        stdio: ['ignore', 'ignore', 'pipe']
      })
      this.proc.unref()
    } catch (err) {
      this.emitFatal(`failed to launch engine: ${String(err)}`)
      return
    }

    const proc = this.proc
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (d: string) => {
      const text = d.trim()
      if (text) logger.warn('engine stderr', text)
    })
    proc.on('exit', (code) => this.onExit(code))
    proc.on('error', (err) => {
      logger.error('engine proc error', err)
      this.emitFatal(`engine process error: ${String(err)}`)
    })
  }

  handleEvent(line: string): void {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      logger.warn('non-json engine line', line)
      return
    }
    switch (msg.type) {
      case 'hello':
        // Daemon handshake reply: adopt its identity before any state events.
        if (typeof msg.backend === 'string' && msg.backend !== 'unknown') this.backend = msg.backend
        if (typeof msg.modelId === 'string') this.modelId = msg.modelId
        this.pythonPath = this.pythonPath ?? findVenvRuntime()?.cmd ?? null
        this.pythonVersion = this.pythonVersion ?? findVenvRuntime()?.version ?? null
        break
      case 'state':
        this.handleStateEvent(msg)
        break
      case 'partial':
        this.emit('partial', {
          utteranceId: msg.utteranceId,
          text: msg.text,
          inferenceMs: msg.inferenceMs
        })
        break
      case 'final':
        if (typeof msg.inferenceMs === 'number') this.recordInference(msg.inferenceMs)
        this.emit('final', {
          utteranceId: msg.utteranceId,
          text: msg.text,
          auto: !!msg.auto,
          inferenceMs: msg.inferenceMs ?? null,
          rtf: msg.rtf ?? null,
          empty: !!msg.empty
        })
        break
      case 'metrics':
        if (typeof msg.modelLoadMs === 'number') this.modelLoadMs = msg.modelLoadMs
        if (typeof msg.backend === 'string') this.backend = msg.backend
        this.emit('metrics')
        break
      case 'error':
        if (msg.fatal) this.emitFatal(msg.message)
        else this.emit('error', { message: msg.message, fatal: false })
        break
      case 'restart-required':
        // The daemon cannot switch between ONNX Runtime and torch in-process
        // (conflicting cuDNN builds) - boot a fresh one with the new model.
        logger.info('daemon requested restart for backend switch', String(msg.modelId ?? ''))
        void this.restartWithConfig()
        break
      case 'log':
        logger.info('[py]', msg.message)
        this.emit('pylog', { level: msg.level ?? 'info', message: msg.message })
        break
      default:
        logger.debug('unhandled engine event', msg.type)
    }
  }

  private handleStateEvent(msg: any): void {
    switch (msg.state) {
      case 'starting':
        this.setState('starting')
        break
      case 'downloading-model':
        this.setState('downloading-model', msg.detail)
        this.emitProgress('downloading', msg.detail ?? 'model')
        break
      case 'loading-model':
        this.setState('loading-model', msg.detail)
        break
      case 'ready':
        if (msg.backend) this.backend = msg.backend
        if (msg.modelId) this.modelId = msg.modelId
        this.restartCount = 0
        this.setState('ready')
        this.emitProgress('done', 'ready')
        this.emit('ready')
        break
      // 'listening' / 'cancelled' are recording-level; surfaced via 'final'/controller
      default:
        break
    }
  }

  private recordInference(ms: number): void {
    this.lastInferenceMs = ms
    this.inferenceSamples += 1
    this.avgInferenceMs =
      this.avgInferenceMs === null
        ? ms
        : this.avgInferenceMs + (ms - this.avgInferenceMs) / Math.min(this.inferenceSamples, 20)
  }

  private emitProgress(state: ModelDownloadProgress['state'], message: string): void {
    const progress: ModelDownloadProgress = {
      state,
      file: '',
      receivedBytes: 0,
      totalBytes: 0,
      percent: state === 'done' ? 100 : -1,
      message
    }
    this.emit('progress', progress)
  }

  private emitFatal(message: string): void {
    this.recording = false
    this.setState('error', message)
    this.emit('error', { message, fatal: true })
  }

  private onExit(code: number | null): void {
    logger.warn('engine daemon exited', code)
    this.proc = null
    if (this.disposed) return
    // A healthy daemon dying means the socket is gone too; the socket 'close'
    // handler drives the respawn. Only handle the case it hasn't fired.
    if (this.sock) return
    if (this.state !== 'error') this.setState('stopped')
    this.scheduleRespawn()
  }

  // -- bootstrap (first-run venv + deps) ----------------------------------

  private async bootstrap(): Promise<PythonRuntime | null> {
    this.bootstrapping = true
    this.setState('resolving-runtime', 'preparing local Python runtime')
    try {
      const base = findBaseInterpreter()
      if (!base) {
        throw new Error(
          'No Python interpreter found. Install Python 3.12 (python.org, or "brew install python@3.12" on macOS) and relaunch.'
        )
      }
      if (!isVersionCompatible(base.version)) {
        throw new Error(
          `Found Python ${base.version}, but the speech engine needs CPython 3.9–3.13 ` +
            `(onnxruntime has no wheels for ${base.version}). Install Python 3.12 and relaunch.`
        )
      }
      const venvDir = getVenvDir()
      const venvPy = getVenvPython()
      this.emit('pylog', { level: 'info', message: `Creating venv at ${venvDir}` })
      await this.run(base.cmd, [...base.prefixArgs, '-m', 'venv', venvDir], 'venv')

      this.emitProgress('downloading', 'installing dependencies (first run)')
      await this.run(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip'], 'pip')
      const req = path.join(getEngineDir(), 'requirements.txt')
      await this.run(venvPy, ['-m', 'pip', 'install', '-r', req], 'deps')

      const rt = findVenvRuntime()
      if (!rt) throw new Error('venv created but interpreter not found')
      this.emit('pylog', { level: 'info', message: 'Python runtime ready' })
      return rt
    } finally {
      this.bootstrapping = false
    }
  }

  private run(cmd: string, args: string[], tag: string): Promise<void> {
    return new Promise((resolve, reject) => {
      logger.info('bootstrap', tag, cmd, args.join(' '))
      const child = spawn(cmd, args, { windowsHide: true, env: process.env })
      const onData = (d: Buffer) => {
        const text = d.toString('utf8').trim()
        if (!text) return
        const last = text.split('\n').pop()!.slice(0, 160)
        this.emit('pylog', { level: 'info', message: `[${tag}] ${last}` })
        this.emitProgress('downloading', last)
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`${tag} step exited with code ${code}`))
      })
    })
  }

  // -- outbound (control + audio) -----------------------------------------

  private writeFrameTo(sock: net.Socket, payload: Buffer, type: number = MSG_CONTROL): void {
    // One atomic write per frame: length + type + payload.
    const frame = Buffer.allocUnsafe(5 + payload.length)
    frame.writeUInt32BE(payload.length + 1, 0)
    frame[4] = type
    payload.copy(frame, 5)
    try {
      sock.write(frame)
    } catch (err) {
      logger.warn('writeFrame failed', err)
    }
  }

  private writeFrame(type: number, payload: Buffer): void {
    if (!this.sock || !this.sock.writable) return
    this.writeFrameTo(this.sock, payload, type)
  }

  sendControl(obj: Record<string, unknown>): void {
    this.writeFrame(MSG_CONTROL, Buffer.from(JSON.stringify(obj), 'utf8'))
  }

  sendAudio(pcm: Buffer): void {
    if (!this.recording) return
    this.writeFrame(MSG_AUDIO, pcm)
  }

  // High level helpers used by the controller -----------------------------

  startUtterance(utteranceId: number, settings: Settings): void {
    this.recording = true
    this.sendControl({
      cmd: 'start',
      utteranceId,
      language: settings.language,
      partialIntervalMs: settings.partialIntervalMs,
      autoStop: settings.autoStopOnSilence,
      vadThreshold: settings.vadThreshold,
      silenceMs: settings.silenceTimeoutMs
    })
  }

  stopUtterance(): void {
    this.recording = false
    this.sendControl({ cmd: 'stop' })
  }

  cancelUtterance(): void {
    this.recording = false
    this.sendControl({ cmd: 'cancel' })
  }

  async reload(settings: Settings): Promise<void> {
    this.config = {
      modelId: settings.modelId,
      quantization: settings.quantization,
      language: settings.language
    }
    this.modelId = settings.modelId

    // No live daemon -> start fresh (also runs first-run dep install).
    if (!this.sock) {
      await this.restart(settings)
      return
    }

    // First-ever selection of the GPU backend, before torch/qwen-asr are
    // installed, needs the bootstrap/install path (a full restart). Once the
    // deps are present we never restart again.
    if (modelBackend(settings.modelId) === 'qwen-asr') {
      const runtime = findVenvRuntime()
      if (runtime && !this.qwenDepsPresent(runtime)) {
        await this.restart(settings)
        return
      }
    }
    // Same for the CUDA runtime of the ONNX models on NVIDIA machines: the
    // provider DLLs must be on disk before the engine spawns, or it would run
    // on CPU for the whole process lifetime.
    if (modelBackend(settings.modelId) === 'onnx-asr' && this.nvidiaKnown()) {
      const runtime = findVenvRuntime()
      if (runtime && !this.gpuRuntimePresent(runtime)) {
        await this.restart(settings)
        return
      }
    }

    // Live process + deps present -> hot switch in place. The engine keeps every
    // model it has loaded warm in a cache, so a model it already loaded this
    // session switches back instantly (no reload, no loading screen).
    this.sendControl({
      cmd: 'reload',
      modelId: settings.modelId,
      quantization: settings.quantization,
      language: settings.language
    })
  }

  async restart(settings: Settings): Promise<void> {
    // Hard restart: the daemon is killed (unlike an app quit, where it stays
    // warm) so a fresh one boots with the new configuration.
    this.dispose(true)
    this.disposed = false
    this.restartCount = 0
    this.state = 'stopped'
    await this.start(settings)
  }

  /** Hard restart with the current model config (start() only reads these). */
  private restartWithConfig(): Promise<void> {
    return this.restart({ ...this.config } as unknown as Settings)
  }

  /**
   * @param hard true = kill the daemon (explicit restart); false (app quit) =
   *             leave it running warm so the next launch is instant. It exits
   *             by itself after DAEMON_IDLE_TIMEOUT_S without a client.
   */
  dispose(hard = false): void {
    this.disposed = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (hard) {
      if (this.sock) {
        try {
          this.sendControl({ cmd: 'shutdown' })
        } catch {
          /* ignore */
        }
      }
      if (this.proc && this.proc.pid) this.killDaemonPid(this.proc.pid)
      try {
        this.proc?.kill()
      } catch {
        /* ignore */
      }
      this.proc = null
    }
    if (this.sock) {
      this.sock.removeAllListeners('close')
      this.sock.destroy()
      this.sock = null
    }
  }
}
