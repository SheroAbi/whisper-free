import { useStore } from '../store'
import { MinimizeIcon, CloseIcon } from './icons'

const STATUS_COLORS: Record<string, string> = {
  idle: 'bg-ink-faint',
  listening: 'bg-rec animate-pulse2',
  transcribing: 'bg-warn animate-pulse2',
  inserting: 'bg-brand animate-pulse2',
  paused: 'bg-warn',
  error: 'bg-rec'
}

export function TitleBar(): JSX.Element {
  const status = useStore((s) => s.status)

  return (
    <header className="drag flex h-11 shrink-0 items-center justify-between px-4 select-none">
      <div className="flex items-center gap-2.5">
        <span className="text-[13px] font-semibold tracking-tight text-ink">Whisper Free</span>
        <span className="flex items-center gap-1.5 rounded-full bg-white/[0.04] px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-faint">
          <span className={`h-1.5 w-1.5 rounded-full ${STATUS_COLORS[status] ?? 'bg-ink-faint'}`} />
          <span className="capitalize">{status}</span>
        </span>
      </div>
      <div className="flex items-center gap-1">
        <button
          className="no-drag flex h-7 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
          title="Minimize to widget"
          onClick={() => window.api.minimizeToWidget()}
        >
          <MinimizeIcon size={15} />
        </button>
        <button
          className="no-drag flex h-7 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-rec hover:text-white"
          title="Close to tray"
          onClick={() => window.api.closeWindow()}
        >
          <CloseIcon size={15} />
        </button>
      </div>
    </header>
  )
}
