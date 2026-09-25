import { useEffect, useRef, useState } from 'react'

/**
 * Tiny "i" that explains a setting in a popover on hover (desktop) or click
 * (sticky until dismissed). Replaces inline subtitle walls — the settings
 * surface stays a clean single line per row, explanations live on demand.
 */
export function InfoTip({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const hideTimer = useRef<number | null>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)

  const cancelHide = () => {
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }
  const scheduleHide = () => {
    cancelHide()
    hideTimer.current = window.setTimeout(() => setOpen(false), 140)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [open])

  return (
    <span
      ref={wrapRef}
      className="relative inline-flex no-drag"
      onMouseEnter={() => {
        cancelHide()
        setOpen(true)
      }}
      onMouseLeave={scheduleHide}
    >
      <button
        type="button"
        aria-label="What is this?"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        className={`flex h-[15px] w-[15px] items-center justify-center rounded-full text-[9px] font-bold leading-none transition-colors duration-150 ${
          open
            ? 'bg-brand/25 text-brand-glow'
            : 'bg-white/[0.08] text-ink-faint hover:bg-white/[0.16] hover:text-ink'
        }`}
      >
        i
      </button>
      {open && (
        <span
          role="tooltip"
          className="animate-slidein absolute right-0 top-[22px] z-40 block w-64 rounded-xl bg-bg-elevated/95 p-3 text-xs font-normal leading-relaxed text-ink-muted shadow-pop backdrop-blur-xl"
        >
          {text}
          <span className="absolute -top-1 right-3.5 h-2 w-2 rotate-45 rounded-[1px] border-l border-t border-white/10 bg-bg-elevated/95" />
        </span>
      )}
    </span>
  )
}
