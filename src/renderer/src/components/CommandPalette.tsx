import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'

interface Command {
  id: string
  label: string
  hint?: string
  run: () => void
}

export function CommandPalette(): JSX.Element | null {
  const open = useStore((s) => s.paletteOpen)
  const setPalette = useStore((s) => s.setPalette)
  const setView = useStore((s) => s.setView)
  const recording = useStore((s) => s.recording)
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const final = useStore((s) => s.final)
  const pushToast = useStore((s) => s.pushToast)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const commands = useMemo<Command[]>(() => {
    const close = () => setPalette(false)
    return [
      {
        id: 'toggle',
        label: recording ? 'Stop dictation' : 'Start dictation',
        hint: settings?.hotkey.label,
        run: () => {
          void window.api.toggleRecording()
          close()
        }
      },
      { id: 'pause', label: 'Pause / resume', run: () => { void window.api.pauseRecording(); close() } },
      { id: 'cancel', label: 'Cancel recording', run: () => { void window.api.cancelRecording(); close() } },
      { id: 'reinsert', label: 'Re-insert last transcript', run: () => { void window.api.reinsertLast(); close() } },
      {
        id: 'copy',
        label: 'Copy last transcript',
        run: () => {
          if (final) void window.api.copyToClipboard(final)
          pushToast({ scope: 'ui', message: 'Copied', fatal: false })
          close()
        }
      },
      {
        id: 'auto-insert',
        label: `${settings?.autoInsertAfterStop ? 'Disable' : 'Enable'} auto-insert after stop`,
        run: () => { void patchSettings({ autoInsertAfterStop: !settings?.autoInsertAfterStop }); close() }
      },
      {
        id: 'copy-mode',
        label: `Switch to ${settings?.insertMode === 'insert' ? 'copy-only' : 'insert'} mode`,
        run: () => {
          void patchSettings({ insertMode: settings?.insertMode === 'insert' ? 'copy' : 'insert' })
          close()
        }
      },
      {
        id: 'newline',
        label: `${settings?.appendNewline ? 'Disable' : 'Enable'} append newline`,
        run: () => { void patchSettings({ appendNewline: !settings?.appendNewline }); close() }
      },
      { id: 'widget', label: 'Minimize to widget', run: () => { window.api.minimizeToWidget(); close() } },
      { id: 'settings', label: 'Open settings', run: () => { setView('settings'); close() } },
      { id: 'diagnostics', label: 'Open diagnostics', run: () => { setView('diagnostics'); close() } },
      { id: 'restart-engine', label: 'Restart speech engine', run: () => { void window.api.restartEngine(); close() } }
    ]
  }, [recording, settings, final, setPalette, setView, patchSettings, pushToast])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => c.label.toLowerCase().includes(q))
  }, [commands, query])

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
      setTimeout(() => inputRef.current?.focus(), 10)
    }
  }, [open])

  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-28"
      onClick={() => setPalette(false)}
    >
      <div
        className="w-[520px] overflow-hidden rounded-2xl border border-line bg-bg-elevated shadow-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a command…"
          className="w-full bg-transparent px-4 py-3.5 text-[15px] text-ink outline-none placeholder:text-ink-faint"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(i + 1, filtered.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              filtered[index]?.run()
            }
          }}
        />
        <div className="max-h-80 overflow-y-auto border-t border-line py-1.5">
          {filtered.length === 0 && (
            <div className="px-4 py-3 text-sm text-ink-faint">No matching command</div>
          )}
          {filtered.map((c, i) => (
            <div
              key={c.id}
              onMouseEnter={() => setIndex(i)}
              onClick={() => c.run()}
              className={`mx-1.5 flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-sm ${
                i === index ? 'bg-brand-soft text-white' : 'text-ink-muted hover:bg-bg-hover'
              }`}
            >
              <span>{c.label}</span>
              {c.hint && <kbd className="font-mono text-[11px] opacity-70">{c.hint}</kbd>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
