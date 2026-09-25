import { useState } from 'react'
import { useStore } from '../store'
import { Section, Row, Toggle, Select, Slider } from './Controls'
import { HotkeyRecorder } from './HotkeyRecorder'
import { MicSelect } from './MicSelect'
import { SUPPORTED_LANGUAGES, MODELS, getModelDef } from '@shared/constants'
import { sameCombo } from '@shared/hotkeys'
import type { Hotkey, Settings } from '@shared/types'

/** Name of another hotkey slot bound to the same combo, if any. */
function hotkeyConflict(slots: [string, Hotkey | null][], name: string): string | null {
  const mine = slots.find(([n]) => n === name)?.[1] ?? null
  if (!mine) return null
  const other = slots.find(([n, h]) => n !== name && sameCombo(mine, h))
  return other?.[0] ?? null
}

export function SettingsPanel(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const patch = useStore((s) => s.patchSettings)
  const pushToast = useStore((s) => s.pushToast)
  const [testText, setTestText] = useState('Hallo Welt — Whisper Free works!')

  if (!settings) return <div className="px-8 py-6 text-ink-faint">Loading settings…</div>
  const s = settings
  const set = (p: Partial<Settings>) => void patch(p)
  const hotkeySlots: [string, Hotkey | null][] = [
    ['Dictation', s.hotkey],
    ['Widget', s.toggleWidgetHotkey],
    ['Pause', s.pauseHotkey],
    ['Quick panel', s.commandPaletteHotkey]
  ]

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-7">
      <h1 className="text-[17px] font-semibold tracking-tight">Settings</h1>

      <Section title="Dictation">
        <Row
          title="Hotkey"
          info="Global key to start and stop dictation — works in any app. A single key (F9, CapsLock, Space…) or any combination."
        >
          <HotkeyRecorder
            hotkey={s.hotkey}
            conflict={hotkeyConflict(hotkeySlots, 'Dictation')}
            onChange={(h) => h && set({ hotkey: h })}
          />
        </Row>
        <Row
          title="Mode"
          info="Toggle: press once to start, press again to stop. Push-to-talk: text is captured while you hold the key (needs the native hook)."
        >
          <Select
            value={s.hotkeyMode}
            options={[
              { value: 'toggle', label: 'Toggle' },
              { value: 'push-to-talk', label: 'Push-to-talk' }
            ]}
            onChange={(v) => set({ hotkeyMode: v })}
          />
        </Row>
        <Row title="Widget" info="Show and hide the floating mini widget. Optional — clear it with the × button.">
          <HotkeyRecorder
            hotkey={s.toggleWidgetHotkey}
            conflict={hotkeyConflict(hotkeySlots, 'Widget')}
            clearable
            onChange={(h) => set({ toggleWidgetHotkey: h })}
          />
        </Row>
        <Row title="Pause" info="Pause the current recording without ending it. Optional — clear it with the × button.">
          <HotkeyRecorder
            hotkey={s.pauseHotkey}
            conflict={hotkeyConflict(hotkeySlots, 'Pause')}
            clearable
            onChange={(h) => set({ pauseHotkey: h })}
          />
        </Row>
        <Row title="Quick panel" info="Opens the command palette with recent dictations and actions. Optional — clear it with the × button.">
          <HotkeyRecorder
            hotkey={s.commandPaletteHotkey}
            conflict={hotkeyConflict(hotkeySlots, 'Quick panel')}
            clearable
            onChange={(h) => set({ commandPaletteHotkey: h })}
          />
        </Row>
      </Section>

      <Section title="Insertion">
        <Row
          title="Auto-insert"
          info="Type the finished transcript straight into the field that had focus before you started dictating."
        >
          <Toggle checked={s.autoInsertAfterStop} onChange={(v) => set({ autoInsertAfterStop: v })} />
        </Row>
        <Row title="Output" info="Insert the text into the active field, or only place it on the clipboard.">
          <Select
            value={s.insertMode}
            options={[
              { value: 'insert', label: 'Insert into field' },
              { value: 'copy', label: 'Copy to clipboard' }
            ]}
            onChange={(v) => set({ insertMode: v })}
          />
        </Row>
        <Row
          title="Injection strategy"
          info="Auto pastes via clipboard and falls back to simulated typing where paste is blocked."
        >
          <Select
            value={s.injectionStrategy}
            options={[
              { value: 'auto', label: 'Auto (paste → type)' },
              { value: 'paste', label: 'Clipboard paste only' },
              { value: 'type', label: 'Simulated typing only' }
            ]}
            onChange={(v) => set({ injectionStrategy: v })}
          />
        </Row>
        <Row title="Append newline" info="Send Enter after inserting — e.g. to send a chat message directly.">
          <Toggle checked={s.appendNewline} onChange={(v) => set({ appendNewline: v })} />
        </Row>
        <Row title="Paste as plain text" info="Strip any formatting from the clipboard payload.">
          <Toggle checked={s.pasteAsPlainText} onChange={(v) => set({ pasteAsPlainText: v })} />
        </Row>
        <Row title="Restore clipboard" info="Put your previous clipboard contents back after pasting.">
          <Toggle checked={s.restoreClipboard} onChange={(v) => set({ restoreClipboard: v })} />
        </Row>
        <Row title="Test" info="Click, then focus any text field within 1–2 s — the text is inserted there.">
          <div className="flex gap-2">
            <input
              className="input w-56"
              value={testText}
              onChange={(e) => setTestText(e.target.value)}
            />
            <button
              className="btn-primary text-xs"
              onClick={async () => {
                const r = await window.api.testInjection(testText)
                pushToast({
                  scope: 'inject',
                  message: r.ok
                    ? `Inserted via ${r.method} → ${r.target?.title ?? 'target'}`
                    : `Failed (${r.error ?? 'no target'}) — copied instead`,
                  fatal: false
                })
              }}
            >
              Test
            </button>
          </div>
        </Row>
      </Section>

      <Section title="Audio">
        <Row title="Microphone">
          <MicSelect value={s.micDeviceId} onChange={(id) => set({ micDeviceId: id })} />
        </Row>
        <Row
          title="Auto-stop"
          info="Ends the utterance by itself after a short pause and inserts — speak, pause, text appears."
        >
          <Toggle checked={s.autoStopOnSilence} onChange={(v) => set({ autoStopOnSilence: v })} />
        </Row>
        <Row title="Silence timeout" info="How long a pause ends the utterance (auto-stop only).">
          <Slider
            value={s.silenceTimeoutMs}
            min={400}
            max={4000}
            step={100}
            suffix="ms"
            onChange={(v) => set({ silenceTimeoutMs: v })}
          />
        </Row>
        <Row title="VAD sensitivity" info="Lower = reacts to quieter speech. Higher = only clear speech starts dictation.">
          <Slider
            value={Math.round(s.vadThreshold * 1000)}
            min={4}
            max={80}
            step={1}
            onChange={(v) => set({ vadThreshold: v / 1000 })}
          />
        </Row>
        <Row
          title="Live refresh"
          info="How often the live preview updates while you speak. The engine slows the cadence by itself on slower machines."
        >
          <Slider
            value={s.partialIntervalMs}
            min={150}
            max={1500}
            step={50}
            suffix="ms"
            onChange={(v) => set({ partialIntervalMs: v })}
          />
        </Row>
        <Row
          title="Echo cancellation"
          info="Browser microphone processing. Off = rawest signal — noticeably more accurate dictation in quiet rooms or with headphones."
        >
          <Toggle checked={s.echoCancellation} onChange={(v) => set({ echoCancellation: v })} />
        </Row>
        <Row title="Noise suppression" info="Cleans up background noise. Off = maximum fidelity for the ASR model.">
          <Toggle checked={s.noiseSuppression} onChange={(v) => set({ noiseSuppression: v })} />
        </Row>
      </Section>

      <Section title="Engine">
        <Row title="Model" info={getModelDef(s.modelId)?.desc ?? 'Speech recognition model.'}>
          <Select
            value={s.modelId}
            options={MODELS.map((m) => ({ value: m.id, label: m.label }))}
            onChange={(v) => set({ modelId: v })}
          />
        </Row>
        {getModelDef(s.modelId)?.backend === 'qwen-asr' ? (
          <Row title="Acceleration" info="Qwen3-ASR always runs on your NVIDIA GPU in FP16 — no setting needed.">
            <span className="rounded-md bg-brand/15 px-2 py-1 text-xs text-brand-glow">GPU · FP16</span>
          </Row>
        ) : (
          <Row
            title="Precision"
            info="fp32 is the best and recommended setting on GPU. int8 is the compact, fast option for CPU-only machines."
          >
            <Select
              value={s.quantization}
              options={[
                { value: 'fp32', label: 'fp32 (GPU · recommended)' },
                { value: 'int8', label: 'int8 (CPU · fastest)' }
              ]}
              onChange={(v) => set({ quantization: v })}
            />
          </Row>
        )}
        <Row title="Language" info="Auto-detect, or pin a language for best accuracy in noisy conditions.">
          <Select
            value={s.language}
            options={SUPPORTED_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
            onChange={(v) => set({ language: v })}
          />
        </Row>
        <Row title="Restart engine" info="Reloads the model — use after errors or to apply GPU runtime changes.">
          <button className="btn-subtle text-xs" onClick={() => window.api.restartEngine()}>
            Restart
          </button>
        </Row>
      </Section>

      <Section title="App">
        <Row
          title="Warm engine at login"
          info="Starts the speech engine with Windows (headless, no window, no CPU when idle). The app then opens instantly — no 'Loading model' wait, ever."
        >
          <Toggle checked={s.warmEngineAtLogin} onChange={(v) => set({ warmEngineAtLogin: v })} />
        </Row>
        <Row title="Launch app at login" info="Start the full app (minimized to tray) with Windows.">
          <Toggle checked={s.launchAtStartup} onChange={(v) => set({ launchAtStartup: v })} />
        </Row>
        <Row title="Start minimized" info="Start hidden in the tray instead of showing the window.">
          <Toggle checked={s.startMinimized} onChange={(v) => set({ startMinimized: v })} />
        </Row>
        <Row title="Close to tray" info="The X button hides to the tray instead of quitting; the engine stays warm.">
          <Toggle checked={s.closeToTray} onChange={(v) => set({ closeToTray: v })} />
        </Row>
        <Row title="Widget on minimize" info="Show the floating mini widget when the main window is minimized.">
          <Toggle checked={s.showWidgetOnMinimize} onChange={(v) => set({ showWidgetOnMinimize: v })} />
        </Row>
        <Row title="Always show widget" info="Keep the floating widget visible at all times.">
          <Toggle checked={s.alwaysShowWidget} onChange={(v) => set({ alwaysShowWidget: v })} />
        </Row>
      </Section>
    </div>
  )
}
