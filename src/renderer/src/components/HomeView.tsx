import { useEffect } from 'react'
import { useStore } from '../store'
import { RecordButton } from './RecordButton'
import { LevelMeter } from './LevelMeter'
import { CopyIcon, RefreshIcon, ChevronRight } from './icons'
import { formatMs, formatRelative } from '../lib/format'

function EngineBanner(): JSX.Element | null {
  const engineState = useStore((s) => s.engineState)
  const detail = useStore((s) => s.engineDetail)
  const progress = useStore((s) => s.modelProgress)
  if (engineState === 'ready') return null

  const messages: Record<string, string> = {
    stopped: 'Engine stopped',
    starting: 'Starting local engine…',
    'resolving-runtime': 'Preparing the local Python runtime (first run only)…',
    'downloading-model': 'Downloading the speech model (first run only)…',
    'loading-model': 'Loading model into memory…',
    'warming-up': 'Warming up…',
    error: 'Engine error — open Diagnostics for details'
  }
  const isError = engineState === 'error'
  return (
    <div
      className={`mb-5 flex items-center gap-3 rounded-2xl px-4 py-3 text-sm ring-1 ${
        isError ? 'bg-rec/[0.08] text-rec ring-rec/20' : 'bg-white/[0.03] text-ink-muted ring-white/[0.05]'
      }`}
    >
      {!isError && (
        <span className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin" />
      )}
      <div className="min-w-0">
        <div className="font-medium">{messages[engineState] ?? engineState}</div>
        {(progress?.message || detail) && (
          <div className="truncate text-xs opacity-70">{progress?.message || detail}</div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-0.5">
      <span className="font-mono text-[12.5px] text-ink">{value}</span>
      <span className="text-[9.5px] uppercase tracking-[0.1em] text-ink-faint">{label}</span>
    </div>
  )
}

export function HomeView(): JSX.Element {
  const recording = useStore((s) => s.recording)
  const paused = useStore((s) => s.paused)
  const partial = useStore((s) => s.partial)
  const final = useStore((s) => s.final)
  const statusMessage = useStore((s) => s.statusMessage)
  const metrics = useStore((s) => s.metrics)
  const backend = useStore((s) => s.diagnostics?.engineBackend)
  const history = useStore((s) => s.history)
  const engineState = useStore((s) => s.engineState)
  const refreshDiagnostics = useStore((s) => s.refreshDiagnostics)
  const setView = useStore((s) => s.setView)
  const pushToast = useStore((s) => s.pushToast)

  useEffect(() => {
    void refreshDiagnostics()
  }, [engineState, final, refreshDiagnostics])

  const liveText = partial || final
  const active = recording || paused
  const backendName = backend ? backend.split(',')[0].replace('ExecutionProvider', '') : '—'

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 px-8 py-7">
      <EngineBanner />

      {/* Stage */}
      <section className="card relative flex flex-col items-center gap-4 overflow-hidden px-6 pb-6 pt-9">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 left-1/2 h-48 w-96 -translate-x-1/2 rounded-full bg-brand/[0.07] blur-3xl"
        />
        <RecordButton />
        <div className="w-full max-w-[240px]">
          <LevelMeter active={active} />
        </div>
        {statusMessage && (
          <div className="animate-slidein text-xs text-ink-faint">{statusMessage}</div>
        )}
        {paused && <div className="text-xs font-medium text-warn">Paused</div>}
      </section>

      {/* Transcript */}
      <section className="card px-5 py-4">
        <div className="mb-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                recording ? 'bg-rec animate-pulse2' : final ? 'bg-ok' : 'bg-ink-faint'
              }`}
            />
            <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-faint">
              {recording ? 'Live' : 'Transcript'}
            </span>
          </div>
          <div className="flex gap-1">
            <button
              className="btn-ghost h-7 w-7 p-0"
              disabled={!final}
              title="Copy"
              onClick={async () => {
                await window.api.copyToClipboard(final)
                pushToast({ scope: 'ui', message: 'Copied to clipboard', fatal: false })
              }}
            >
              <CopyIcon size={14} />
            </button>
            <button
              className="btn-ghost h-7 w-7 p-0"
              disabled={!final}
              title="Re-insert into focused field"
              onClick={async () => {
                const r = await window.api.reinsertLast()
                pushToast({
                  scope: 'ui',
                  message: r.ok ? `Re-inserted via ${r.method}` : 'Insert failed (copied instead)',
                  fatal: false
                })
              }}
            >
              <RefreshIcon size={14} />
            </button>
          </div>
        </div>
        <div className="text-selectable min-h-[68px] rounded-xl bg-white/[0.02] p-3.5 text-[15px] leading-relaxed ring-1 ring-inset ring-white/[0.03]">
          {liveText ? (
            <span>
              {final && <span className="text-ink">{final}</span>}
              {!final && partial && <span className="text-ink-muted">{partial}</span>}
            </span>
          ) : (
            <span className="text-ink-faint">Your dictated text appears here.</span>
          )}
        </div>
      </section>

      {/* Perf strip */}
      <div className="flex items-stretch rounded-2xl bg-white/[0.02] px-2 py-3 ring-1 ring-white/[0.04]">
        <Stat label="Model load" value={formatMs(metrics?.lastModelLoadMs)} />
        <div className="w-px bg-white/[0.05]" />
        <Stat label="Inference" value={formatMs(metrics?.lastInferenceMs)} />
        <div className="w-px bg-white/[0.05]" />
        <Stat label="End-to-end" value={formatMs(metrics?.lastEndToEndMs)} />
        <div className="w-px bg-white/[0.05]" />
        <Stat label="Backend" value={backendName} />
      </div>

      {history.length > 0 && (
        <section className="card px-5 py-1.5">
          <ul className="divide-y divide-white/[0.045]">
            {history.slice(0, 3).map((h) => (
              <li
                key={h.id}
                className="flex items-center gap-3 py-2.5 text-sm hover:bg-white/[0.015]"
              >
                <span className="truncate text-ink-muted">{h.text}</span>
                <span className="ml-auto shrink-0 text-[11px] text-ink-faint">
                  {formatRelative(h.timestamp)}
                </span>
              </li>
            ))}
          </ul>
          <button
            className="flex w-full items-center justify-center gap-1 border-t border-white/[0.045] py-2.5 text-xs font-medium text-ink-muted transition-colors hover:bg-white/[0.02] hover:text-ink"
            onClick={() => setView('history')}
          >
            View all <ChevronRight size={13} />
          </button>
        </section>
      )}
    </div>
  )
}
