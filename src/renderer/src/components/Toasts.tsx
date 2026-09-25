import { useStore } from '../store'
import { CloseIcon } from './icons'

export function Toasts(): JSX.Element {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`animate-slidein pointer-events-auto flex items-start gap-2.5 rounded-xl bg-bg-elevated/95 px-3.5 py-3 text-sm shadow-pop backdrop-blur-xl ${
            t.fatal ? 'text-rec ring-1 ring-rec/30' : 'text-ink ring-1 ring-white/[0.07]'
          }`}
        >
          <div className="min-w-0 flex-1 break-words">{t.message}</div>
          <button
            className="shrink-0 text-ink-faint transition-colors hover:text-ink"
            onClick={() => dismiss(t.id)}
          >
            <CloseIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
