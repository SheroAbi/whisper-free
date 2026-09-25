import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { MicIcon } from './icons'

// Phase copy keyed by the engine lifecycle state. Shown full-screen on launch so
// the user sees "the app is opening + getting ready" instead of a half-live UI.
const PHASES: Record<string, { title: string; hint: string }> = {
  stopped: { title: 'Starting engine…', hint: 'Initialising the local speech engine' },
  starting: { title: 'Starting engine…', hint: 'Initialising the local speech engine' },
  'resolving-runtime': {
    title: 'Preparing local runtime',
    hint: 'One-time setup on the very first launch'
  },
  'downloading-model': {
    title: 'Downloading speech model',
    hint: 'Only happens on the very first launch'
  },
  'loading-model': { title: 'Loading model into memory', hint: 'Preparing the GPU' },
  'warming-up': { title: 'Warming up…', hint: 'Almost ready' },
  ready: { title: 'Ready', hint: '' },
  error: { title: 'Engine error', hint: 'See Diagnostics for details' }
}

/**
 * Full-window loading screen shown on launch until the local engine is ready.
 * Everything heavy (venv build, dependency install, model load, GPU bring-up)
 * happens in the background; this overlay reflects the live phase + progress so
 * the user never sees a terminal or a half-initialised UI.
 */
export function StartupSplash(): JSX.Element | null {
  const engineState = useStore((s) => s.engineState)
  const detail = useStore((s) => s.engineDetail)
  const progress = useStore((s) => s.modelProgress)
  const setView = useStore((s) => s.setView)

  // Grace period: a warm daemon attach resolves in ~300 ms - the splash must
  // not flash for it. Only cold starts (real loading) ever paint the overlay.
  const [visible, setVisible] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (engineState === 'ready') {
      // Brief fade window (CSS handles the opacity ramp), then unmount.
      const t = setTimeout(() => setVisible(false), 300)
      return () => clearTimeout(t)
    }
    if (engineState === 'error') {
      setVisible(true)
      return
    }
    const t = setTimeout(() => setVisible(true), 750)
    return () => clearTimeout(t)
  }, [engineState])

  if (dismissed || !visible) return null

  const isError = engineState === 'error'
  const ready = engineState === 'ready'
  const phase = PHASES[engineState] ?? PHASES.starting
  const sub = progress?.message || detail || phase.hint
  const pct = progress && progress.percent >= 0 ? progress.percent : null

  return (
    <div
      className={`absolute inset-0 z-50 flex flex-col items-center justify-center gap-6 transition-opacity duration-500 ${
        ready ? 'pointer-events-none opacity-0' : 'opacity-100'
      }`}
      style={{ background: 'radial-gradient(120% 90% at 50% 0%, #16142099 0%, #0a0c11 62%)' }}
    >
      {/* Logo with soft brand glow */}
      <div className="relative flex h-24 w-24 items-center justify-center">
        <div
          className={`absolute inset-0 rounded-[28px] blur-2xl ${
            isError ? 'bg-rec/30' : 'bg-brand/30 animate-breathe'
          }`}
        />
        <div
          className={`relative flex h-24 w-24 items-center justify-center rounded-[28px] text-white shadow-glow ${
            isError ? 'bg-rec' : 'bg-brand-soft'
          }`}
        >
          <MicIcon size={42} />
        </div>
      </div>

      <div className="text-center">
        <div className="text-xl font-semibold tracking-tight text-ink">Whisper Free</div>
        <div className={`mt-1.5 text-sm font-medium ${isError ? 'text-rec' : 'text-brand-glow'}`}>
          {phase.title}
        </div>
        {sub && <div className="mt-1 max-w-sm truncate px-6 text-xs text-ink-muted">{sub}</div>}
      </div>

      {/* Progress: determinate when we have a percent, otherwise an indeterminate sweep */}
      {!isError && (
        <div className="splash-bar-track h-1.5 w-64 rounded-full bg-bg-elevated">
          {pct === null ? (
            <div className="splash-bar-indeterminate h-full w-1/3 rounded-full bg-brand" />
          ) : (
            <div
              className="h-full rounded-full bg-brand transition-[width] duration-300"
              style={{ width: `${pct}%` }}
            />
          )}
        </div>
      )}

      {isError && (
        <div className="flex gap-2">
          <button
            className="btn-primary px-4 py-2 text-sm"
            onClick={() => {
              setView('diagnostics')
              setDismissed(true)
            }}
          >
            Open Diagnostics
          </button>
          <button className="btn-subtle px-4 py-2 text-sm" onClick={() => setDismissed(true)}>
            Continue anyway
          </button>
        </div>
      )}
    </div>
  )
}
