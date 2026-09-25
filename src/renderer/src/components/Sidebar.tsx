import { useStore, type View } from '../store'
import { MicIcon, HistoryIcon, SettingsIcon, ActivityIcon } from './icons'

const ITEMS: { id: View; label: string; icon: (p: any) => JSX.Element }[] = [
  { id: 'home', label: 'Dictate', icon: MicIcon },
  { id: 'history', label: 'History', icon: HistoryIcon },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
  { id: 'diagnostics', label: 'Diagnostics', icon: ActivityIcon }
]

export function Sidebar(): JSX.Element {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const hotkey = useStore((s) => s.settings?.hotkey.label ?? '—')

  return (
    <aside className="flex w-48 flex-col px-3 py-5">
      <nav className="flex flex-col gap-1">
        {ITEMS.map((it) => {
          const Icon = it.icon
          const active = view === it.id
          return (
            <div
              key={it.id}
              className={`nav-item ${active ? 'nav-item-active' : ''}`}
              onClick={() => setView(it.id)}
            >
              <span className={active ? 'text-brand' : 'text-ink-faint'}>
                <Icon size={17} />
              </span>
              <span>{it.label}</span>
            </div>
          )
        })}
      </nav>

      <div className="mt-auto rounded-xl bg-white/[0.03] px-3 py-2.5 ring-1 ring-white/[0.04]">
        <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
          Hotkey
        </div>
        <div className="mt-0.5 truncate font-mono text-[12.5px] text-ink">{hotkey}</div>
      </div>
    </aside>
  )
}
