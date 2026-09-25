import { useStore } from '../store'
import { MicIcon, StopIcon } from './icons'

export function RecordButton(): JSX.Element {
  const status = useStore((s) => s.status)
  const recording = useStore((s) => s.recording)
  const engineReady = useStore((s) => s.engineState === 'ready')

  const busy = status === 'transcribing' || status === 'inserting'
  const disabled = !engineReady || busy

  return (
    <div className="flex flex-col items-center gap-3.5">
      <button
        disabled={disabled}
        onClick={() => window.api.toggleRecording()}
        className={`no-drag relative flex h-28 w-28 items-center justify-center rounded-full transition-all duration-200 ${
          recording
            ? 'bg-[#2b1116] text-rec ring-2 ring-rec/70 shadow-rec cursor-pointer'
            : disabled
              ? 'cursor-not-allowed bg-white/[0.05] text-ink-faint ring-1 ring-white/[0.06]'
              : 'cursor-pointer text-white shadow-glow hover:scale-[1.04] active:scale-[0.97]'
        }`}
        style={
          !recording && engineReady
            ? { background: 'linear-gradient(135deg, #ff6b81 0%, #ff385c 55%, #e61e4d 100%)' }
            : undefined
        }
      >
        {recording && (
          <>
            <span className="absolute inset-0 rounded-full ring-2 ring-rec/40 animate-breathe" />
            <span className="absolute -inset-2.5 rounded-full ring-1 ring-rec/20" />
          </>
        )}
        <span className="relative">
          {recording ? <StopIcon size={38} /> : <MicIcon size={42} />}
        </span>
      </button>
      <div className="text-center">
        <div className="text-[13px] font-medium text-ink">
          {recording ? 'Listening — click or hotkey to stop' : busy ? 'Processing…' : 'Click or press the hotkey'}
        </div>
        {!engineReady && <div className="mt-0.5 text-xs text-warn">Engine warming up…</div>}
      </div>
    </div>
  )
}
