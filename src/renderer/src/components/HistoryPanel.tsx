import { useEffect } from 'react'
import { useStore } from '../store'
import { CopyIcon, TrashIcon, RefreshIcon, CheckIcon } from './icons'
import { formatRelative, formatMs, formatDuration } from '../lib/format'

export function HistoryPanel(): JSX.Element {
  const history = useStore((s) => s.history)
  const refreshHistory = useStore((s) => s.refreshHistory)
  const pushToast = useStore((s) => s.pushToast)

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  return (
    <div className="mx-auto max-w-2xl px-8 py-7">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-[17px] font-semibold tracking-tight">History</h1>
        <button
          className="btn-subtle text-xs"
          disabled={history.length === 0}
          onClick={async () => {
            await window.api.clearHistory()
            await refreshHistory()
          }}
        >
          <TrashIcon size={13} /> Clear all
        </button>
      </div>

      {history.length === 0 ? (
        <div className="card flex flex-col items-center gap-1.5 px-6 py-16 text-center">
          <div className="text-sm font-medium text-ink">No dictations yet</div>
          <div className="text-xs text-ink-faint">Everything you dictate shows up here.</div>
        </div>
      ) : (
        <ul className="card flex flex-col divide-y divide-white/[0.045] px-5 py-1">
          {history.map((h) => (
            <li key={h.id} className="group py-3.5">
              <div className="text-selectable text-[14.5px] leading-relaxed text-ink">{h.text}</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
                <span className="flex items-center gap-1">
                  {h.inserted ? <CheckIcon size={11} /> : null}
                  {h.inserted ? `inserted · ${h.method}` : h.method ?? 'not inserted'}
                </span>
                {h.targetApp && <span className="max-w-[200px] truncate">→ {h.targetApp}</span>}
                <span>{formatRelative(h.timestamp)}</span>
                {h.durationMs > 0 && <span>· {formatDuration(h.durationMs)}</span>}
                {h.latencyMs > 0 && <span>· {formatMs(h.latencyMs)}</span>}
                <span className="ml-auto flex gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                  <button
                    className="btn-ghost h-6 w-6 p-0"
                    title="Copy"
                    onClick={() => {
                      void window.api.copyToClipboard(h.text)
                      pushToast({ scope: 'ui', message: 'Copied', fatal: false })
                    }}
                  >
                    <CopyIcon size={12} />
                  </button>
                  <button
                    className="btn-ghost h-6 w-6 p-0"
                    title="Insert into focused field"
                    onClick={async () => {
                      await window.api.copyToClipboard(h.text)
                      const r = await window.api.testInjection(h.text)
                      pushToast({
                        scope: 'ui',
                        message: r.ok ? `Inserted via ${r.method}` : 'Insert failed (copied instead)',
                        fatal: false
                      })
                    }}
                  >
                    <RefreshIcon size={12} />
                  </button>
                  <button
                    className="btn-ghost h-6 w-6 p-0"
                    title="Delete"
                    onClick={async () => {
                      await window.api.deleteHistoryItem(h.id)
                      await refreshHistory()
                    }}
                  >
                    <TrashIcon size={12} />
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
