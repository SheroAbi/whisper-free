import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Hotkey } from '@shared/types'
import { buildHotkey, MODIFIER_CODES } from '@shared/hotkeys'
import { KeyboardIcon, CloseIcon } from './icons'

const MOD_LABELS: [string, string][] = [
  ['ControlLeft', 'Ctrl'],
  ['ControlRight', 'Ctrl'],
  ['AltLeft', 'Alt'],
  ['AltRight', 'Alt'],
  ['AltGraph', 'Alt'],
  ['ShiftLeft', 'Shift'],
  ['ShiftRight', 'Shift'],
  ['MetaLeft', 'Win'],
  ['MetaRight', 'Win']
]

/**
 * Records a hotkey directly in the renderer: a window-level keydown listener
 * swallows every keystroke (so no button re-fires and nothing gets typed),
 * which makes BOTH bare single keys (F9, Space, CapsLock, letters) and any
 * modifier combination assignable. The main process suspends all registered
 * shortcuts for the duration so the combo being replaced can't fire.
 */
export function HotkeyRecorder({
  hotkey,
  conflict,
  clearable,
  onChange
}: {
  hotkey: Hotkey | null
  /** Name of another action bound to the same combo, if any. */
  conflict?: string | null
  /** Show a × button to remove an optional hotkey entirely. */
  clearable?: boolean
  onChange: (h: Hotkey | null) => void
}): JSX.Element {
  const [recording, setRecording] = useState(false)
  const [liveMods, setLiveMods] = useState<string[]>([])
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const stop = useCallback(() => setRecording(false), [])

  useEffect(() => {
    if (!recording) return
    let done = false
    const held = new Set<string>()

    const finish = (h: Hotkey | null) => {
      if (done) return
      done = true
      if (h) onChangeRef.current(h)
      setRecording(false)
    }

    const modLabels = () => {
      const labels: string[] = []
      for (const [code, label] of MOD_LABELS) {
        if (held.has(code) && !labels.includes(label)) labels.push(label)
      }
      return labels
    }

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      if (MODIFIER_CODES.has(e.code)) {
        held.add(e.code)
        setLiveMods(modLabels())
        return
      }
      // Bare Esc cancels; Esc inside a real combo is bindable.
      if (e.code === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        finish(null)
        return
      }
      finish(buildHotkey(e.code, e.ctrlKey, e.altKey, e.shiftKey, e.metaKey))
    }

    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (MODIFIER_CODES.has(e.code)) {
        held.delete(e.code)
        setLiveMods(modLabels())
      }
    }

    const onBlur = () => finish(null)

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    void window.api.beginHotkeyCapture()

    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      void window.api.endHotkeyCapture()
    }
  }, [recording])

  const label = hotkey?.label ?? 'Set hotkey'

  return (
    <div className="flex items-center gap-2">
      {conflict && !recording && (
        <span className="max-w-[200px] text-[11px] leading-tight text-warn">
          Same key as “{conflict}”
        </span>
      )}
      <button
        onClick={() => (recording ? stop() : setRecording(true))}
        className={`btn-subtle min-w-[150px] font-mono text-[13px] ${
          recording ? 'border-brand text-brand-glow' : ''
        }`}
      >
        <KeyboardIcon size={14} />
        {recording ? 'Press keys…' : label}
      </button>
      {clearable && hotkey && !recording && (
        <button
          onClick={() => onChange(null)}
          title="Remove this hotkey"
          className="btn-subtle px-2 text-ink-faint hover:text-warn"
        >
          <CloseIcon size={12} />
        </button>
      )}

      {recording &&
        createPortal(
          <div
            onMouseDown={stop}
            className="fixed inset-0 z-[999] flex items-center justify-center bg-black/70 backdrop-blur-sm"
          >
            <div
              className="card flex w-[340px] flex-col items-center gap-4 px-8 py-7 text-center shadow-pop"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-brand/15 text-brand-glow">
                <KeyboardIcon size={22} />
              </div>
              <div>
                <div className="text-[15px] font-semibold">Press a key or combination</div>
                <div className="mt-1 text-[12px] leading-relaxed text-ink-muted">
                  One single key (e.g. <span className="font-mono">F9</span> or{' '}
                  <span className="font-mono">CapsLock</span>) or any combo like{' '}
                  <span className="font-mono">Ctrl + Shift + Space</span>.
                </div>
              </div>
              <div className="flex h-9 min-w-[200px] items-center justify-center rounded-lg border border-line bg-bg-soft px-3 font-mono text-[13px] text-brand-glow">
                {liveMods.length ? `${liveMods.join(' + ')} + …` : '…'}
              </div>
              <button
                onClick={stop}
                className="btn-subtle flex items-center gap-1.5 text-[11px] text-ink-muted"
              >
                <CloseIcon size={12} />
                Cancel (Esc)
              </button>
            </div>
        </div>,
        document.body
      )}
    </div>
  )
}
