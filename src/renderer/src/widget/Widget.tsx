import { useCallback, useRef, useState } from 'react'
import { useStore } from '../store'
import {
  MicIcon,
  StopIcon,
  PauseIcon,
  PlayIcon,
  ChevronRight,
  CopyIcon,
  CheckIcon
} from '../components/icons'

/* ── Sleek waveform that reacts to mic level ─────────────────────────── */
function MiniLevel({ active }: { active: boolean }): JSX.Element {
  const level = useStore((s) => s.level)
  return (
    <div className="flex h-3.5 items-center gap-[2.5px]">
      {[0.45, 0.75, 1, 0.85, 0.6].map((w, i) => {
        const h = active ? Math.max(0.18, Math.min(1, level * w * 1.35)) : 0.18
        return (
          <span
            key={i}
            className="w-[2.5px] rounded-full bg-current transition-[height] duration-100 ease-out"
            style={{ height: `${h * 100}%`, opacity: active ? 0.55 + h * 0.45 : 0.3 }}
          />
        )
      })}
    </div>
  )
}

type Phase = 'idle' | 'recording' | 'paused' | 'transcribing'

/* Color story per phase — an ULTRA-THIN snake of light that races FAST around
   the border in ONE direction (clockwise).

   The snake is a single SHORT bright segment (head + soft tail), followed by a
   long, very faint same-hue WAKE that trails it for a sense of speed, then a
   long transparent gap. So it reads as a snake racing around with a luminous
   slipstream — never a long band, never a hard stroke. Each phase is
   MONOCHROMATIC: one hue in a few luminance stages.

   recording  → red
   paused     → amber / gold
   transcrib. → teal / cyan
   idle       → the same moving snake, in green-white, so the widget stays findable */
const PHASE: Record<
  Phase,
  {
    /** The single conic "snake": faint wake → soft tail → bright head, rest clear */
    grad: string
    opacity: number
    /** seconds for one full lap around the border (small = fast) */
    speed: string
    /** glow breathe duration */
    pulse: string
    /** single-hue color for the bloom/halo */
    glow: string
    flow: string
    btn: string
  }
> = {
  idle: {
    // Same moving snake as the others, in GREEN-WHITE — it glides + breathes just
    // like the active states, so the dark widget is easy to spot at a glance.
    grad:
      'conic-gradient(from 0deg, rgba(150,240,190,0) 0deg, rgba(150,240,190,0) 264deg, rgba(165,243,200,0.12) 286deg, rgba(170,245,205,0.22) 298deg, rgba(176,247,210,0.4) 318deg, rgba(192,251,222,0.82) 335deg, rgba(212,255,235,1) 348deg, rgba(226,255,243,1) 355deg, rgba(170,245,205,0) 360deg)',
    opacity: 0.95,
    speed: '3.2s',
    pulse: '3.4s',
    glow: 'rgba(150,240,190,0.5)',
    flow: 'text-emerald',
    btn: 'frost'
  },
  recording: {
    // RED — faint wake (from 264°) → soft tail → bright head (~355°), fades by 360°.
    grad:
      'conic-gradient(from 0deg, rgba(255,55,55,0) 0deg, rgba(255,55,55,0) 264deg, rgba(255,68,68,0.12) 286deg, rgba(255,72,72,0.22) 298deg, rgba(255,72,72,0.35) 318deg, rgba(255,98,98,0.8) 335deg, rgba(255,128,128,1) 348deg, rgba(255,150,150,1) 355deg, rgba(255,90,90,0) 360deg)',
    opacity: 1,
    speed: '2.6s', // fast lap
    pulse: '2.4s',
    glow: 'rgba(255,72,72,0.92)',
    flow: 'text-[#ff5c5c]',
    btn: 'coral'
  },
  paused: {
    // AMBER — same shape, slightly calmer.
    grad:
      'conic-gradient(from 0deg, rgba(255,184,74,0) 0deg, rgba(255,184,74,0) 264deg, rgba(255,190,86,0.12) 286deg, rgba(255,193,94,0.22) 298deg, rgba(255,193,94,0.35) 318deg, rgba(255,204,120,0.8) 335deg, rgba(255,218,155,1) 348deg, rgba(255,230,180,1) 355deg, rgba(255,195,95,0) 360deg)',
    opacity: 0.9,
    speed: '3.8s',
    pulse: '3.4s',
    glow: 'rgba(255,190,90,0.8)',
    flow: 'text-[#ffb454]',
    btn: 'amber'
  },
  transcribing: {
    // TEAL — same shape, fastest lap.
    grad:
      'conic-gradient(from 0deg, rgba(40,224,206,0) 0deg, rgba(40,224,206,0) 264deg, rgba(46,226,208,0.12) 286deg, rgba(50,229,211,0.22) 298deg, rgba(50,229,211,0.35) 318deg, rgba(72,237,219,0.8) 335deg, rgba(122,246,230,1) 348deg, rgba(165,255,242,1) 355deg, rgba(60,232,214,0) 360deg)',
    opacity: 1,
    speed: '2.2s',
    pulse: '2s',
    glow: 'rgba(60,232,214,0.92)',
    flow: 'text-[#3fe0cc]',
    btn: 'teal'
  }
}

export function Widget(): JSX.Element {
  const status = useStore((s) => s.status)
  const recording = useStore((s) => s.recording)
  const paused = useStore((s) => s.paused)
  const partial = useStore((s) => s.partial)
  const final = useStore((s) => s.final)
  const hotkey = useStore((s) => s.settings?.hotkey.label ?? '')
  const engineReady = useStore((s) => s.engineState === 'ready')

  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)

  const transcribing = status === 'transcribing' || status === 'inserting'
  const active = recording || paused
  const phase: Phase = transcribing
    ? 'transcribing'
    : paused
      ? 'paused'
      : recording
        ? 'recording'
        : 'idle'

  const p = PHASE[phase]
  const line = partial || final || ''
  const canCopy = !!final && !active

  const copy = useCallback(async () => {
    if (!final) return
    try {
      await window.api.copyToClipboard(final)
      setCopied(true)
      if (copyTimer.current) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(false), 1400)
    } catch {
      /* ignore */
    }
  }, [final])

  const statusText = !engineReady
    ? 'Starting…'
    : paused
      ? 'Paused'
      : recording
        ? 'Listening'
        : transcribing
          ? 'Transcribing…'
          : 'Ready'

  const placeholder = hotkey ? `Press ${hotkey} to dictate` : 'Whisper Free'

  // Mic / stop button styling per phase.
  const buttonClass = [
    'no-drag relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[14px]',
    'transition-all duration-200 active:scale-90 disabled:cursor-not-allowed disabled:opacity-35'
  ]
  if (p.btn === 'coral') {
    buttonClass.push(
      'bg-gradient-to-br from-[#ff6a5e] to-[#ff3d5e] text-white',
      'shadow-[0_0_0_1px_rgba(255,106,94,0.4),0_6px_18px_-4px_rgba(255,77,94,0.7)]'
    )
  } else if (p.btn === 'amber') {
    buttonClass.push(
      'bg-gradient-to-br from-[#ffc066] to-[#ff9b3d] text-white',
      'shadow-[0_0_0_1px_rgba(255,180,84,0.4),0_6px_18px_-5px_rgba(255,180,84,0.55)]'
    )
  } else if (p.btn === 'teal') {
    buttonClass.push(
      'bg-gradient-to-br from-[#3fe0cc] to-[#2fd6e0] text-white',
      'shadow-[0_0_0_1px_rgba(47,214,192,0.4),0_6px_18px_-5px_rgba(47,214,192,0.6)]'
    )
  } else {
    // idle — frosted glass with a faint ring.
    buttonClass.push(
      'bg-white/[0.07] text-[#e8ecf4] ring-1 ring-inset ring-white/10',
      'hover:bg-white/[0.12] shadow-[0_4px_14px_-6px_rgba(0,0,0,0.6)]'
    )
  }

  const dotColor =
    phase === 'recording'
      ? 'bg-[#ff6a5e]'
      : phase === 'paused'
        ? 'bg-[#ffb454]'
        : phase === 'transcribing'
          ? 'bg-[#2fd6c0]'
          : engineReady
            ? 'bg-[#39d98a]'
            : 'bg-ink-faint'

  return (
    <div className="drag flex h-full w-full p-2.5">
      <div
        className="relative flex h-full w-full items-center gap-2.5 rounded-[24px] px-3"
        style={{
          ['--aurora-opacity' as string]: String(p.opacity),
          ['--aurora-speed' as string]: p.speed,
          ['--pulse-speed' as string]: p.pulse,
          ['--ring-w' as string]: '1.5px',
          ['--ring-glow' as string]: p.glow,
          ['--snake-blur' as string]: '0.5px'
        }}
      >
        {/* Frosted-glass surface. The backdrop-blur sits on an INNER child while
            the rounding + overflow:hidden sit on the PARENT wrapper — Chromium
            ignores border-radius for backdrop-filter on the *same* element, so the
            blur has to be clipped by a parent. THIS is what makes the corners
            crisp. The outer container stays open so the snake's glow still spills
            out past the corners. */}
        <div
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-[24px] border border-white/[0.06]"
          aria-hidden
        >
          <div className="absolute inset-0 bg-gradient-to-b from-[#181c25] to-[#0c0e14] backdrop-blur-2xl" />
        </div>

        {/* ── THIN SNAKE GLOW RING ──────────────────────────────────────────
            One ultra-thin conic "snake" (bright head + soft tail + faint wake)
            masked to a hairline band, racing clockwise around the border via a
            real transform spin. Idle uses the same moving snake in green-white so
            the dark widget is easy to find. A small blur + a layered bloom give it
            a clean, smooth, luminous glow with a fade. */}
        <div className="aurora-ring" aria-hidden>
          <div
            className="aurora-layer"
            aria-hidden
            style={{ ['--aurora-grad' as string]: p.grad }}
          />
        </div>

        {/* glass top highlight */}
        <div className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />

        {/* primary: start / stop */}
        <button
          className={buttonClass.join(' ')}
          title={recording ? 'Stop dictation' : 'Start dictation'}
          disabled={!engineReady}
          onClick={() => window.api.toggleRecording()}
        >
          {/* breathing core glow while active */}
          {phase !== 'idle' && (
            <span
              className="pointer-events-none absolute inset-0 rounded-[14px]"
              style={{
                boxShadow: `inset 0 0 12px 1px ${p.glow}`,
                animation: 'core-breathe 2.6s ease-in-out infinite'
              }}
              aria-hidden
            />
          )}
          <span className="relative">
            {recording ? <StopIcon size={14} /> : <MicIcon size={16} />}
          </span>
        </button>

        {/* middle: status + transcript */}
        <div className="relative min-w-0 flex-1">
          {active ? (
            <div className={`flex items-center gap-1.5 ${p.flow}`}>
              <MiniLevel active={active} />
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em]">
                {statusText}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`}
                style={
                  phase !== 'idle'
                    ? { boxShadow: `0 0 6px 1px ${p.glow}` }
                    : undefined
                }
              />
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                {statusText}
              </span>
            </div>
          )}

          <div className="mt-px truncate text-[11.5px] leading-tight">
            {line ? (
              <span className={final && !partial ? 'text-ink' : 'text-ink-muted'}>
                {line}
              </span>
            ) : (
              <span className="text-ink-faint">{placeholder}</span>
            )}
          </div>
        </div>

        {/* actions */}
        <div className="relative no-drag flex shrink-0 items-center gap-1">
          {canCopy && (
            <button
              className={[
                'flex h-7 w-7 items-center justify-center rounded-[10px] transition-all duration-150 active:scale-90',
                copied
                  ? 'bg-[#39d98a]/15 text-[#39d98a]'
                  : 'bg-white/[0.06] text-ink-muted hover:bg-white/[0.12] hover:text-ink'
              ].join(' ')}
              title={copied ? 'Copied!' : 'Copy last result'}
              onClick={copy}
            >
              {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
            </button>
          )}

          {recording && (
            <button
              className="flex h-7 w-7 items-center justify-center rounded-[10px] text-ink-muted transition-colors hover:bg-white/[0.1] hover:text-ink"
              title={paused ? 'Resume' : 'Pause'}
              onClick={() => window.api.pauseRecording()}
            >
              {paused ? <PlayIcon size={13} /> : <PauseIcon size={13} />}
            </button>
          )}

          <button
            className="flex h-7 w-7 items-center justify-center rounded-[10px] text-ink-muted transition-colors hover:bg-white/[0.1] hover:text-ink"
            title="Open main window"
            onClick={() => window.api.expandWindow()}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
