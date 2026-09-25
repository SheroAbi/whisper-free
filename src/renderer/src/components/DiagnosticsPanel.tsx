import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { ExternalIcon, RefreshIcon, CpuIcon, CopyIcon } from './icons'
import { formatMs } from '../lib/format'

function Stat({ label, value, ok }: { label: string; value: string; ok?: boolean }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-ink-muted">{label}</span>
      <span
        className={`font-mono text-[13px] ${
          ok === undefined ? 'text-ink' : ok ? 'text-ok' : 'text-warn'
        } max-w-[260px] truncate`}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

const LEVEL_COLOR: Record<string, string> = {
  debug: 'text-ink-faint',
  info: 'text-ink-muted',
  warn: 'text-warn',
  error: 'text-rec'
}

export function DiagnosticsPanel(): JSX.Element {
  const diag = useStore((s) => s.diagnostics)
  const metrics = useStore((s) => s.metrics)
  const logs = useStore((s) => s.logs)
  const progress = useStore((s) => s.modelProgress)
  const refresh = useStore((s) => s.refreshDiagnostics)
  const pushToast = useStore((s) => s.pushToast)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 2000)
    return () => clearInterval(t)
  }, [refresh])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 px-8 py-7">
      <div className="flex items-center justify-between">
        <h1 className="text-[17px] font-semibold tracking-tight">Diagnostics</h1>
        <div className="flex gap-2">
          <button className="btn-subtle text-xs" onClick={() => window.api.openModelDir()}>
            <ExternalIcon size={13} /> Model folder
          </button>
          <button className="btn-subtle text-xs" onClick={() => window.api.openLogs()}>
            <ExternalIcon size={13} /> Logs
          </button>
          <button className="btn-subtle text-xs" onClick={() => window.api.restartEngine()}>
            <RefreshIcon size={13} /> Restart engine
          </button>
          <button
            className="btn-subtle text-xs"
            onClick={() => {
              void window.api.copyToClipboard(JSON.stringify({ diag, metrics }, null, 2))
              pushToast({ scope: 'ui', message: 'Diagnostics copied', fatal: false })
            }}
          >
            <CopyIcon size={13} /> Copy
          </button>
        </div>
      </div>

      {progress && progress.state !== 'done' && (
        <div className="card px-5 py-3.5">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-faint">Model / runtime</div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className={`h-full rounded-full bg-brand ${progress.percent < 0 ? 'animate-pulse2 w-1/3' : ''}`}
              style={progress.percent >= 0 ? { width: `${progress.percent}%` } : undefined}
            />
          </div>
          <div className="mt-1.5 truncate text-xs text-ink-muted">{progress.message}</div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <div className="card px-5 py-4">
          <h2 className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-faint">
            <CpuIcon size={13} /> Engine
          </h2>
          <div className="divide-y divide-white/[0.04]">
            <Stat label="Engine state" value={diag?.engineState ?? '—'} ok={diag?.engineState === 'ready'} />
            <Stat label="Model loaded" value={diag?.modelLoaded ? 'yes' : 'no'} ok={diag?.modelLoaded} />
            <Stat label="Model" value={diag?.modelId ?? '—'} />
            <Stat label="Backend" value={diag?.engineBackend ?? '—'} />
            <Stat label="Python" value={diag?.pythonVersion ?? 'not found'} ok={!!diag?.pythonVersion} />
            <Stat label="Path" value={diag?.pythonPath ?? '—'} />
          </div>
        </div>

        <div className="card px-5 py-4">
          <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-faint">Input & hotkeys</h2>
          <div className="divide-y divide-white/[0.04]">
            <Stat label="Microphone active" value={diag?.micActive ? 'yes' : 'no'} ok={diag?.micActive} />
            <Stat label="Hotkey registered" value={diag?.hotkeyRegistered ? 'yes' : 'no'} ok={diag?.hotkeyRegistered} />
            <Stat label="Hotkey backend" value={diag?.hotkeyBackend ?? '—'} />
            <Stat label="Native hook (PTT)" value={diag?.uiohookAvailable ? 'available' : 'unavailable'} ok={diag?.uiohookAvailable} />
            <Stat label="Last target" value={diag?.lastInjectionTarget?.title ?? '—'} />
          </div>
        </div>
      </div>

      <div className="card px-5 py-4">
        <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-faint">Performance</h2>
        <div className="grid grid-cols-2 gap-x-8 md:grid-cols-3">
          <Stat label="Startup" value={formatMs(metrics?.startupMs)} />
          <Stat label="Engine ready" value={formatMs(metrics?.engineReadyMs)} />
          <Stat label="Model load" value={formatMs(metrics?.lastModelLoadMs)} />
          <Stat label="Last inference" value={formatMs(metrics?.lastInferenceMs)} />
          <Stat label="Avg inference" value={formatMs(metrics?.avgInferenceMs)} />
          <Stat label="End-to-end" value={formatMs(metrics?.lastEndToEndMs)} />
        </div>
      </div>

      <div className="card flex min-h-0 flex-col px-5 py-4">
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-faint">Live log</h2>
        <div
          ref={logRef}
          className="text-selectable h-56 overflow-y-auto rounded-xl bg-white/[0.02] p-3 font-mono text-[11px] leading-relaxed ring-1 ring-inset ring-white/[0.03]"
        >
          {logs.length === 0 && <div className="text-ink-faint">No log output yet.</div>}
          {logs.map((l, i) => (
            <div key={i} className={LEVEL_COLOR[l.level] ?? 'text-ink-muted'}>
              <span className="text-ink-faint">[{l.scope}]</span> {l.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
