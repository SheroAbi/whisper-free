import { useEffect } from 'react'
import { useStore } from './store'
import { audioCapture } from './audio/AudioCapture'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { HomeView } from './components/HomeView'
import { SettingsPanel } from './components/SettingsPanel'
import { HistoryPanel } from './components/HistoryPanel'
import { DiagnosticsPanel } from './components/DiagnosticsPanel'
import { CommandPalette } from './components/CommandPalette'
import { Toasts } from './components/Toasts'
import { StartupSplash } from './components/StartupSplash'

/** Drives the microphone from the global status: capture while listening/paused. */
function useAudioController(): void {
  const status = useStore((s) => s.status)
  const deviceId = useStore((s) => s.settings?.micDeviceId ?? null)
  const echoCancellation = useStore((s) => s.settings?.echoCancellation ?? true)
  const noiseSuppression = useStore((s) => s.settings?.noiseSuppression ?? true)
  const dspKey = `${echoCancellation ? 'ec' : 'raw'}+${noiseSuppression ? 'ns' : 'raw'}`

  useEffect(() => {
    const shouldCapture = status === 'listening' || status === 'paused'
    if (shouldCapture) {
      if (!audioCapture.isActive() || audioCapture.currentCaptureKey() !== `${deviceId ?? 'default'}|${dspKey}`) {
        if (audioCapture.isActive()) audioCapture.stop()
        void audioCapture.start({ deviceId, echoCancellation, noiseSuppression }).catch(() => undefined)
      }
    } else if (audioCapture.isActive()) {
      audioCapture.stop()
    }
  }, [status, deviceId, dspKey, echoCancellation, noiseSuppression])
}

export default function App(): JSX.Element {
  const view = useStore((s) => s.view)
  const setPalette = useStore((s) => s.setPalette)
  useAudioController()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette(true)
      }
      if (e.key === 'Escape') setPalette(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPalette])

  return (
    <div
      className="flex h-full flex-col text-ink"
      style={{ background: 'radial-gradient(135% 95% at 50% -8%, #13161f 0%, #0a0c11 55%)' }}
    >
      <TitleBar />
      <div className="relative flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto">
          {view === 'home' && <HomeView />}
          {view === 'settings' && <SettingsPanel />}
          {view === 'history' && <HistoryPanel />}
          {view === 'diagnostics' && <DiagnosticsPanel />}
        </main>
        {/* Full-screen loading overlay until the engine is ready (TitleBar stays usable). */}
        <StartupSplash />
      </div>
      <CommandPalette />
      <Toasts />
    </div>
  )
}
