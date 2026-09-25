// Low-latency microphone capture. An AudioWorklet emits ~20 ms Float32 frames;
// we resample to 16 kHz mono, convert to Int16 PCM, stream to the main process,
// and report a smoothed input level for the meters. Runs in the (always-alive)
// main window renderer so capture survives minimize-to-widget.

const TARGET_RATE = 16000

const WORKLET_SRC = `
class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._count = 0;
    this._target = Math.max(128, Math.round(sampleRate * 0.02));
  }
  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (ch && ch.length) {
      this._chunks.push(Float32Array.from(ch));
      this._count += ch.length;
      if (this._count >= this._target) {
        const out = new Float32Array(this._count);
        let o = 0;
        for (const c of this._chunks) { out.set(c, o); o += c.length; }
        this._chunks = [];
        this._count = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('pcm-worklet', PCMWorklet);
`

function resampleTo16k(input: Float32Array, inRate: number): Float32Array {
  if (inRate === TARGET_RATE) return input
  const ratio = inRate / TARGET_RATE
  const outLen = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio
    const i0 = Math.floor(idx)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = idx - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

function floatToInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length)
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

function rms(f: Float32Array): number {
  let sum = 0
  for (let i = 0; i < f.length; i++) sum += f[i] * f[i]
  return Math.sqrt(sum / f.length)
}

export interface CaptureOptions {
  deviceId: string | null
  echoCancellation: boolean
  noiseSuppression: boolean
}

export class AudioCapture {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private active = false
  private smoothedLevel = 0
  private starting = false
  private currentDevice: string | null = null
  private currentDsp = 'ec+ns'
  /** True when the last start() had to ignore a stale device id. */
  usedFallbackDevice = false

  isActive(): boolean {
    return this.active
  }

  currentDeviceId(): string | null {
    return this.currentDevice
  }

  /** Identity of the active capture (device + DSP config) for change detection. */
  currentCaptureKey(): string {
    return `${this.currentDevice ?? 'default'}|${this.currentDsp}`
  }

  async start(opts: CaptureOptions): Promise<void> {
    const { deviceId, echoCancellation, noiseSuppression } = opts
    if (this.active || this.starting) return
    this.starting = true
    try {
      const baseAudio: MediaTrackConstraints = {
        channelCount: 1,
        echoCancellation,
        noiseSuppression,
        autoGainControl: true
      }
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { ...baseAudio, deviceId: { exact: deviceId } } : baseAudio,
        video: false
      }

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints)
      } catch (err) {
        // A stored device id goes stale whenever the mic is unplugged, renamed
        // or its driver changes. That used to kill every dictation attempt with
        // an empty error - fall back to the system default instead.
        const name = err instanceof DOMException ? err.name : ''
        const staleDevice =
          !!deviceId &&
          (name === 'NotFoundError' ||
            name === 'DevicesNotFoundError' ||
            name === 'OverconstrainedError')
        if (!staleDevice) throw err
        this.usedFallbackDevice = true
        stream = await navigator.mediaDevices.getUserMedia({
          audio: baseAudio,
          video: false
        })
      }
      this.stream = stream

      this.ctx = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: 'interactive' })
      if (this.ctx.state === 'suspended') await this.ctx.resume()

      const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' })
      const url = URL.createObjectURL(blob)
      try {
        await this.ctx.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }

      this.source = this.ctx.createMediaStreamSource(this.stream)
      this.node = new AudioWorkletNode(this.ctx, 'pcm-worklet')
      const inRate = this.ctx.sampleRate
      this.node.port.onmessage = (ev: MessageEvent<Float32Array>) => this.onFrame(ev.data, inRate)
      this.source.connect(this.node)
      // Keep the graph pulling without producing audible output.
      const sink = this.ctx.createGain()
      sink.gain.value = 0
      this.node.connect(sink)
      sink.connect(this.ctx.destination)

      this.active = true
      this.currentDevice = deviceId
      this.currentDsp = `${echoCancellation ? 'ec' : 'raw'}+${noiseSuppression ? 'ns' : 'raw'}`
      window.api.notifyAudioStarted(inRate)
    } catch (err) {
      this.cleanup()
      // Surface the error *name* too - getUserMedia often has an empty message
      // (e.g. NotFoundError) and an empty toast is undiagnosable.
      const name = err instanceof DOMException ? err.name : ''
      const message = err instanceof Error ? err.message : String(err)
      window.api.notifyAudioError(name ? `${name}${message ? `: ${message}` : ''}` : message)
      throw err
    } finally {
      this.starting = false
    }
  }

  private onFrame(frame: Float32Array, inRate: number): void {
    if (!this.active) return
    const resampled = resampleTo16k(frame, inRate)
    const pcm = floatToInt16(resampled)
    window.api.sendAudioFrame(pcm.buffer as ArrayBuffer)

    const level = Math.min(1, rms(resampled) * 6)
    this.smoothedLevel = this.smoothedLevel * 0.8 + level * 0.2
    window.api.reportLevel(this.smoothedLevel)
  }

  stop(): void {
    this.cleanup()
    window.api.reportLevel(0)
  }

  private cleanup(): void {
    this.active = false
    if (this.node) {
      try {
        this.node.port.onmessage = null
        this.node.disconnect()
      } catch {
        /* ignore */
      }
      this.node = null
    }
    if (this.source) {
      try {
        this.source.disconnect()
      } catch {
        /* ignore */
      }
      this.source = null
    }
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined)
      this.ctx = null
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop())
      this.stream = null
    }
    this.smoothedLevel = 0
  }
}

export const audioCapture = new AudioCapture()
