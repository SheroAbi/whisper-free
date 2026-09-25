# Architektur-Dokumentation — Whisper Free

> Vollständige technische Referenz: was wo liegt, was jede einzelne Datei tut,
> wie die Prozesse zusammenspielen und warum alles so gebaut ist. Das README
> bleibt absichtlich simpel — hier steht alles andere.

Stand: September 2026 · Windows 11 / macOS · Electron 31 · CPython 3.11 (venv)

---

## 1. System in einem Bild

```
┌──────────────────────────── Electron (Node/TS) ────────────────────────────┐
│  src/main/index.ts          Bootstrap, Single-Instance, CSP, UI-Shot-Hook  │
│  ┌────────────────────── controller.ts (Zentrale) ───────────────────────┐ │
│  │  EngineManager ──►  Python-Daemon (Loopback-Socket)                   │ │
│  │  TextInjector  ──►  PowerShell-Host (stdin/stdout)                    │ │
│  │  HotkeyManager, WindowManager, TrayManager, Settings, History, Logger │ │
│  │  daemonAutostart ──► HKCU-Run-Key (Engine warm bei Windows-Login)     │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
└───────▲ typed IPC (preload contextBridge) ───────────────┬─────────────────┘
        │                                                  │ framed binary
┌───────┴─────────────┐                    ┌───────────────▼─────────────────┐
│ Renderer (React)    │  16 kHz PCM 20 ms  │ Python-Daemon (engine.py --serve)│
│  Hauptfenster       │ ─────────────────► │  Silero-VAD (CPU, <1 ms/Frame)  │
│  Widget (overlay)   │ ◄───── JSON Events │  Parakeet TDT 0.6B v3 (CUDA fp32)│
│  AudioWorklet → PCM │                    │  Streaming-Partials + Spec-Finals│
└─────────────────────┘                    └─────────────────────────────────┘
```

Fünf Prozesse zur Laufzeit: Electron-Main, zwei Renderer (Fenster + Widget),
Python-Daemon (detached, überlebt die App), PowerShell-Win32-Host.

---

## 2. Datei-für-Datei-Referenz

### `src/main/` — Electron-Main-Prozess

| Datei | Aufgabe |
|---|---|
| `index.ts` | App-Bootstrap: Single-Instance-Lock, `setAppUserModelId`, CSP (nur packaged), Mikrofon-Permissions, Erzeugung von `WindowManager` → `AppController` → Tray → IPC. Enthält den UI-Shot-Harness (`--ui-shot`: rendert alle 4 Views als PNG nach `.ui-shots/` für visuelle Reviews) und startet `autoRebuildIfStale`. |
| `controller.ts` | **Die Zentrale.** Besitzt alle Subsysteme, hält den Recording-State-Machine (`idle → listening → transcribing → inserting → idle`), verdrahtet Engine-Events → UI-Broadcast, finalisiert Transcripts (`normalizeFinal`), ruft die Einfüge-Kaskade auf, führt Performance-Metriken, schreibt History-Einträge. Registriert beim Boot auch den Warm-Engine-Login-Eintrag und aktualisiert ihn bei Modell-Änderungen. |
| `engine/EngineManager.ts` | **Verwaltet den Python-Daemon** (siehe §4): async NVIDIA-Probe (`nvidia-smi`, blocking-frei), einmalige Installation von `onnxruntime-gpu[cuda,cudnn]` auf NVIDIA-Maschinen, venv-Bootstrap beim Erststart, Spawn des detached Daemons, Loopback-Socket-Handshake (Token + Protokoll-Version), Framing `[4B len][1B type][payload]`, Event-Dispatch (`partial`/`final`/`state`/`metrics`/`log`), Auto-Respawn bei Crash (max. 4, exponentiell 600–4000 ms), harte/weiche Dispose. |
| `engine/daemonAutostart.ts` | Schreibt den `HKCU\...\Run`-Eintrag `ParakeetDictationEngine` (pythonw headless mit `--serve`), damit die Engine schon beim Windows-Login lädt. Idempotent bei jedem App-Boot; `reg delete` wenn ausgeschaltet. |
| `engine/pythonResolver.ts` | Findet Interpreter: venv (`python/.venv` bzw. `%APPDATA%/.../python-venv` packaged) → `py -3.12/3.11/3.10/3.13/3.9` → uv-managed Pythons → `python`. Liest venv-Version instant aus `pyvenv.cfg` statt `python --version` zu spawnen. |
| `injection/TextInjector.ts` | Persistenter PowerShell-Host als FIFO-Command-Queue (`FG`, `PASTE`, `TYPE\|<b64>`, `ENTER`, `QUIT`). Verfolgt laufend das externe Vordergrundfenster (350 ms Poll). Einfüge-Kaskade: Clipboard-Paste → Unicode-`SendInput` → Clipboard-only; Wiederherstellung der alten Clipboard nach 400 ms. |
| `injection/win32-input.ps1` | Der Win32-Host selbst: P/Invoke-Interop einmal laden, `READY` senden, dann ein Line-Protocol (`OK\|hwnd\|pid\|base64-title`). `AttachThreadInput`+`SetForegroundWindow`-Technik, `SendInput` für Paste/Type. |
| `hotkeys.ts` | Globaler Hotkey-Manager: Binding-Policy pro Hotkey — Electron `globalShortcut` für Modifier-Combos und F-Tasten (schluckt die Taste sauber), `uiohook-napi` (optional, prebuilt) für Push-to-Talk (keyup!), einzelne Tasten (Buchstaben, Space, CapsLock, Numpad, Sonderzeichen) und als Fallback, wenn `globalShortcut` ablehnt. `beginCapture()`/`endCapture()` suspensieren während der Aufnahme im Settings-UI ALLE Bindings (45-s-Safety-Timeout); die Kombi-Aufnahme selbst macht der Renderer per DOM-Keydown (`shared/hotkeys.ts` liefert Token-Mapping + Policy für beide Prozesse). Auto-Repeat wird per held-keys-Set gefiltert. |
| `windows.ts` | Zwei Surfaces: Hauptfenster (frameless, Größe/Position persistiert) + Widget (transparent, always-on-top, skipTaskbar). `minimizeToWidget`, `expandWindow`, `broadcast()` an beide Renderer. Sichere `webPreferences` (sandbox, contextIsolation, backgroundThrottling off für Audio). |
| `tray.ts` | Tray-Icon (rot bei Aufnahme), Kontextmenü (Open/Start-Stop/Pause/Widget/Restart/Quit). |
| `settings.ts` | `electron-store` mit Merge über Defaults + Clamps + **Strip unbekannter Keys** (Altversionen hinterlassen keinen Müll). Emitted `changed`-Events. |
| `history.ts` | Ring-Buffer (max. 100) der Diktate in `history.json`. |
| `logger.ts` | `electron-log` (rotierend, 5 MB) + Fan-out eines getrimmten Payloads an UI-Subscriber (Diagnostics-Live-Log). |
| `assets.ts` | Erzeugt Tray-/App-Icons zur Laufzeit als handgebaute PNGs (Eigenen PNG-Encoder + Soft-Canvas) — keine Binärdateien im Repo. Brand-Farbe #FF385C. |
| `devRebuild.ts` | Desktop-Icon-Workflow: startet die App direkt aus `out/`? Wenn Source neuer ist als der Build, wird im Hintergrund `electron-vite build` via Electron-as-Node ausgeführt und die Fenster leise neu geladen. Off per `PARAKEET_NO_AUTOBUILD=1`, nie in packaged Builds. |

### `src/preload/` + `src/shared/`

| Datei | Aufgabe |
|---|---|
| `preload/index.ts` | `contextBridge.exposeInMainWorld('api', …)` — die Einzige Brücke. Wrapper trennt Payloads von `IpcRendererEvent`; jede `on*` gibt eine Unsubscribe-Funktion zurück. |
| `preload/index.d.ts` | Ambient-Typ für `window.api` (aus `shared/ipc`). |
| `shared/ipc.ts` | **Einzige Quelle der Wahrheit** für Channel-Namen (`IPC` = Renderer→Main, `EVT` = Main→Renderer) + das typisierte `Api`-Interface. Main und Preload können nie desynchronisieren. |
| `shared/types.ts` | Domain-Typen: `Settings`, `HistoryItem`, `InjectionResult`, `Diagnostics`, `PerfMetrics`, `TranscriptEvent`, … frei von Runtime-Imports. |
| `shared/constants.ts` | `ENGINE_PROTOCOL_VERSION` (muss mit `engine.py` übereinstimmen — invalidiert alte Daemons), `DAEMON_IDLE_TIMEOUT_S=1800`, Modell-Registry (`MODELS`: Parakeet v3 empfohlen, Parakeet v2 Fallback, Qwen3-ASR als Max-Accuracy), `DEFAULT_SETTINGS`, `WINDOW`-Größen, Sprachliste. |

### `src/renderer/` — React-UI

| Datei | Aufgabe |
|---|---|
| `index.html` / `widget.html` | Zwei Vite-Eintrittspunkte (Hauptfenster, Widget). |
| `main.tsx` / `widget.tsx` | Roots; `main.tsx` exponiert zusätzlich `window.__setView` für den UI-Shot-Harness. |
| `App.tsx` | Layout (TitleBar/Sidebar/View/Splash/Toasts/Palette), `useAudioController`: startet/stoppt die Mikrofon-Aufnahme je nach Status; reagiert auf Device- **und** DSP-Änderungen. |
| `store.ts` | Zustand-Store (Zustand): Status, Partials, Finals, Level, Settings, History, Diagnostics, Logs, Toasts. `initBridge` abonniert alle Main-Events. |
| `audio/AudioCapture.ts` | AudioWorklet (20 ms Frames) → Resample auf 16 kHz → Int16 → Main. Fällt bei veralteter Geräte-ID automatisch aufs Standard-Mikrofon zurück (der alte „leerer Fehler"-Bug), meldet echte Fehlernamen, respektiert Echo-Cancel/Noise-Suppression-Toggles. |
| `components/SettingsPanel.tsx` | Sektionen Dictation/Insertion/Audio/Engine/App. Jede Zeile ein Einzeiler; Erklärungen im `InfoTip`-Popover statt Subtitle-Wänden. Hotkey-Slots erkennen Doppelbelegung (`sameCombo`) und zeigen eine Warnung. |
| `components/HomeView.tsx` | Bühne: Record-Button-Hero, LevelMeter, Transcript-Card (Live/Final), Performance-Streifen (4 Werte, Hairlines), Recent-Liste. |
| `components/RecordButton.tsx` | Gradient-CTA (#FF385C), Puls-Ringe bei Aufnahme, disabled während Engine bootet. |
| `components/InfoTip.tsx` | „i"-Button mit Popover (Hover + Click, Esc/Outside schließt, Pfeil, Blur). |
| `components/Controls.tsx` | `Row` (Label + InfoTip + Control), `Toggle`, `Select` (eigener Chevron), `Slider` (accent thumb), `Section` (Small-Caps-Header, Hairline-dividierte Zeilen). |
| `components/Sidebar.tsx`, `TitleBar.tsx` | Navigation (4 Views + Hotkey-Chip), Frameless-Titelzeile mit Status-Chip + Window-Controls. |
| `components/HistoryPanel.tsx` | Liste mit Hover-Actions (Copy/Re-Insert/Delete). |
| `components/DiagnosticsPanel.tsx` | Engine-/Input-Stats, Performance-Metriken, Live-Log, Buttons (Model-Cache, Logs, Restart, Copy). Pollt alle 2 s. |
| `components/StartupSplash.tsx` | Overlay mit **750 ms Grace**: Warm-Attach (~300 ms) zeigt keinen Splash — nur echte Kaltstarts. Fehler-State bietet „Open Diagnostics". |
| `components/CommandPalette.tsx` | Ctrl+K-Panel: Diktat-Steuerung, Quick-Toggles, Navigation. |
| `components/Toasts.tsx`, `icons.tsx`, `lib/format.ts` | Toasts (Blur, keine Scope-Wände), handgezeichnete SVG-Icon-Set, Einheits-Formatter (`ms`/`s` ohne Leerzeichen, `1m 49s`). |
| `index.css` + `tailwind.config.js` | Design-System: Brand #FF385C, Hairline-Ringe, `card/btn-*/nav-item/input/range`-Klassen, Snake-Glow-Ring des Widgets (CSS `conic-gradient` + transform-spin), Custom-Scrollbar. |

### `python/` — Inferenz-Engine

| Datei | Aufgabe |
|---|---|
| `engine.py` | **Daemon + State-Machine** (siehe §5): Audio-Ingest unter Lock, Silero-gated Streaming-Scheduler, adaptive Partial-Intervalle, Heat-Guard (≥2,5 s Partial → Partials aus), Timestamp-Stitching über das 12,6-s-Fenster, **spekulative Finals** (Dekodierung startet bei ~50 % der Stille-Fenster, Final ist instant), `--serve`-Mode (Loopback-Socket, Token-Handshake, State-Replay, Idle-Exit 30 min), `had_fatal`-Flag. `PROTOCOL_VERSION` (3) muss mit der App matchen. |
| `asr.py` | Parakeet-Wrapper: CUDA→DML→CPU-Provider-Aushandlung (env `PARAKEET_PROVIDERS` gewinnt), `onnxruntime.preload_dlls()` + torch-DLL-Fallback, lädt immer aus dem eigenen Modell-Ordner (`model_store.py`, kein Netzwerk beim Start), Fallback-Kette fp32/int8 × v3/v2, Multi-Shape-Warmup (`warmup(shapes)`), Backend-Erkennung (scannt alle InferenceSessions), `transcribe_tokens()` via rohe `recognize_batch`-API **ohne** Logprob-Berechnung (schnellere Partials). |
| `vad_silero.py` | Silero VAD v5, stateful: 512-Sample-Frames @16 kHz + 64-Sample-Kontext + (2,1,128)-State, Hysterese (start 0,5 / end −0,15), <1 ms/Frame auf CPU. Mappt den VAD-Sensitivity-Slider auf Start-Wahrscheinlichkeit. Exponiert `ms_since_voice()` fürs Partial-Gating. |
| `vad.py` | Energy-VAD (RMS + adaptiver Noise-Floor) als Fallback, falls Silero nicht ladbar — gleiches Interface. |
| `protocol.py` | Framing `[u32 BE][type][payload]`; `set_output()` für den Serve-Mode (Events → Client-Socket), `NullWriter` ohne Client, `send()` mit Single-Write + Crash-sicherem try. |
| `qwen_asr_backend.py` | Optionales Max-Accuracy-Backend: Qwen3-ASR 0.6B via transformers, fp16+SDPA auf CUDA (Turing-kompatibel), lädt aus dem Modell-Ordner, CUDA → Apple MPS → CPU, nagisa-Import-Stub (spart 2,8 s). Wird nur bei Auswahl des Qwen-Modells importiert. |
| `bench.py` | Dev-Benchmark (nicht von der App genutzt): `tts` erzeugt einen deutschen SAPI-Testclip, `vad` testet Silero, `engine` füttert den Daemon-Prozess in Echtzeit-Zeitlupe und misst Partial/Final/SPEC-Latenzen, `asr` misst RTF pro Provider/Präzision. |
| `requirements.txt` | `onnx-asr[cpu,hub]`, `numpy`. GPU-Runtime wird zur Laufzeit vom EngineManager dynamisch installiert (nur wenn NVIDIA vorhanden). |
| `requirements-qwen.txt` | torch+cu124, `qwen-asr` — nur fürs Qwen-Backend, on-demand installiert. |
| `.venv/` | Das Python-Venv (auto erzeugt; NICHT in Git/Installer). |

### `scripts/`, Root-Konfig

| Datei | Aufgabe |
|---|---|
| `scripts/setup-python.ps1` | Erstellt `python/.venv` + installiert `requirements.txt` (macht den Erststart instant statt Warteschlange). |
| `scripts/start.ps1` | Launcher: prüft/baut venv, startet Electron gegen `out/` (kein Dev-Server, kein Terminal). |
| `scripts/make-icon.js`, `create-shortcut.vbs` | Icon-Generierung + Desktop-Shortcut (`npm run shortcut`). |
| `electron-builder.yml` | NSIS-Installer; bundelt `python/*.py` als `extraResources` (ohne `.venv`), `win32-input.ps1`. `npmRebuild: false` (uiohook-Napi prebuilds). |
| `electron.vite.config.ts` | Main/Preload/Renderer-Builds, `@shared`-Alias, Sourcemaps. |
| `.npmrc` | `optional=true` (uiohook prebuilds), kein fund/audit. |
| `config.example.json` | Exakte Spiegel der aktuellen Defaults (Referenz für Hand-Edits). |

---

## 3. Der Engine-Daemon (Instant-Start)

**Problem:** 1,4 GB fp32-Gewichte brauchen ~5 s von der SSD in den VRAM — bei
jedem App-Start das Gleiche, obwohl das Modell eben noch geladen war.

**Lösung:** `engine.py --serve` läuft als detached Daemon:

1. **Spawn:** App startet `pythonw engine.py … --serve --conn-file
   <userData>/engine-conn.json --idle-timeout 1800` (detached + `unref` — der
   Daemon überlebt das App-Ende).
2. **Bekanntmachung:** Der Daemon bindet einen Loopback-Socket auf einem
   zufälligen Port und schreibt `{port, token, pid, version, modelId}` in die
   Conn-Datei (atomar via Temp-File + `os.replace`).
3. **Attach:** Die App liest die Conn-Datei, verbindet sich, sendet zuerst
   `{cmd:'hello', token, version, modelId, quantization, language}` — der
   Daemon prüft Token (Same-User-Auth) und Protokoll-Version, antwortet mit
   `hello` + **State-Replay** (`state: ready` + Metriken), damit eine frisch
   gestartete App sofort korrekt informiert ist. Warm-Attach gesamt: **~270 ms**.
4. **Modell-Mismatch:** Will die App ein anderes Modell, triggert das Hello ein
   in-process `reload` (Modell-Cache im Daemon macht Rückwechsel instant).
5. **Version-Mismatch:** Andere `ENGINE_PROTOCOL_VERSION` → `taskkill /T /F`
   auf die Daemon-PID, App spawnt ihren eigenen Daemon.
6. **App-Ende:** Socket schließt, Daemon bleibt warm (Idle-Timeout 30 min),
   schließt sich dann selbst. Modellwechsel im Settings aktualisiert den
   Run-Key-Eintrag, damit der *nächste* Login-Daemon das neue Modell lädt.
7. **Login-Wärme:** `warmEngineAtLogin` (Default an) registriert den
   HKCU-Run-Eintrag — beim Windows-Login lädt der Daemon headless, und *jede*
   später geöffnete App attached warm.
8. **Crash:** Socket `close`/`error` → Status gestoppt → Respawn mit Backoff
   (600 ms → 4 s, max. 4 Versuche), Conn-File wird vorher gelöscht.

**Boot-Zeiten (gemessen):** Kalt (Daemon muss geboren werden): ~6–9 s.
Warm (Daemon lebt): **~0,3 s**. Nach Login mit aktiviertem Autostart: immer warm.

---

## 4. Echtzeit-Pipeline

**Audio-Pfad:** AudioWorklet (20 ms Float32) → Linear-Resample 16 kHz → Int16 →
IPC → Main → Daemon. Context `latencyHint: 'interactive'`,
`backgroundThrottling: false` (Audio läuft weiter, wenn das Fenster hidden ist).

**VAD-Gating:** Silero klassifiziert jeden Frame (<1 ms). Während Stille läuft
**keine** Inferenz — null CPU/GPU-Last, null Lüfter. Partials nur, wenn in den
letzten 1500 ms Sprache war (+ ein Trailing-Partial 350 ms nach Sprachende).

**Streaming-Partials:** Alle `partialIntervalMs` (Default 250 ms) wird der
Puffer neu dekodiert. Das Intervall adaptiert: `max(Setting, 2×letzte
Inferenz)` — eine langsame Maschine throttled sich selbst statt zu
überhitzen. Ein einzelnes Partial >2,5 s deaktiviert Live-Partials für die
Session (Finals bleiben unaffected).

**Fenster-Stitching:** Ab 12,6 s Utterance-Länge dekodiert das Partial nur das
Ende (12 s + 0,6 s Vorlauf). Die Wort-Zeiten aus dem TDT-Decoder frieren den
Text vor dem Fenster ein (`_last_tokens`); Tokens in der 0,15-s-Nahtzone
kommen aus dem Fenster-Re-Dekod mit vollem Kontext. Ergebnis: der Live-Text
wächst monoton statt zu springen, ohne Duplikate.

**Spekulative Finals:** Nach ~50 % des Stille-Fensters (min. 300 ms) startet
eine **volle Dekodierung der Utterance** im Hintergrund. Bestätigt der VAD
dann den Endpunkt, ist das Final-Ergebnis meist schon fertig → der Final-Event
feuert instant (Feld `speculative: true`). Spricht man doch weiter, wird die
Spekulation verworfen (`_spec = None`) und normal weitergestreamt. Der Final
hat **immer** Vorrang vor wartenden Partials/Specs (eine Dekodierung max.).

**Stopp→Einfügen (gemessen):** ~200 ms Dekodierung (spekulativ oft 0 ms
zusätzlich) + ~80 ms Paste. Final-Text ist immer eine vollständige
Neu-Dekodierung der ganzen Äußerung — die Vorschau ist Optimierung, das
Ergebnis nicht.

**Qwen-Modus:** Autoregressiv → Partials deutlich träger (dokumentiert im
Model-Dropdown); Finals hochwertig bei schwerem Audio. Gleiche Pipeline, nur
`transcribe()` statt `transcribe_tokens()`.

---

## 5. Modell & GPU

- **Parakeet TDT 0.6B v3** (CC-BY-4.0): bestes offenes ≤1B-Modell für DE+EN
  (Open ASR Leaderboard, de CoVoST 4.13), RTFx ~100 auf der 2080 Ti →
  RTF ~0,01. ONNX von `istupakov/*-onnx`, inkl. TDT-Decoder + Log-Mel.
- **Provider-Aushandlung:** `PARAKEET_PROVIDERS` (App setzt bei NVIDIA
  `CUDAExecutionProvider,CPUExecutionProvider`) → sonst Auto-Detection →
  Fallback-Kette probiert Provider-Set × Quant × Modellname, dernier Rettung
  plain CPU. CUDA-Provider-Optionen: `cudnn_conv_algo_search=HEURISTIC`
  (tötet die 300–450 ms Latenz-Spikes bei neuen Audio-Längen),
  `arena_extend_strategy=kSameAsRequested`.
- **int8 nur für CPU** (auf GPU kein Gewinn, kleine Genauigkeitsrisiken —
  gemessen: int8 macht Deutsche Fehler wie „Wir mess jetzt").
- **Eigener Modell-Ordner (`model_store.py`):** Alle Modelle liegen als
  normale Dateien in einem festen App-Ordner (Windows
  `%LOCALAPPDATA%\WhisperFree\models`, macOS
  `~/Library/Application Support/WhisperFree/models`, Override
  `WHISPER_FREE_MODELS_DIR`). Reihenfolge: Ordner → (einmalig) Hardlink/Kopie
  aus dem HF-Cache → nur wenn wirklich nötig Download direkt in den Ordner.
  Geladen wird immer per lokalem Pfad (`onnx_asr.load_model(name, path)`,
  `Qwen3ASRModel.from_pretrained(path)`) — kein Netzwerk-Kontakt beim Start,
  auch nicht wenn jemand `~/.cache/huggingface` leert.
- **Warmup:** 1s-Shape vor `ready` (erster Diktat-Call instant), 7s-Shape
  danach im Hintergrund.
- **VRAM:** ~2,5 GB (Parakeet fp32) bzw. +2 GB (Qwen fp16, nur wenn
  ausgewählt) auf 11 GB.

---

## 6. Text-Einfügung

Persistenter PowerShell-Host (P/Invoke einmal geladen — keine .NET-Kosten pro
Keystroke), FIFO-Queue, 5 s Timeout pro Command. Vor der Aufnahme wird das
externe Vordergrundfenster getrackt; beim Final wird blind an die fokussierte
Stelle gepastet (der globale Hotkey stiehlt keinen Fokus).

**Focus-Restore:** Hat stattdessen eines der eigenen Fenster den Fokus (z. B.
nach einem Klick auf den Record-Button), würde der blinde Strg+V ins eigene
Fenster laufen — unsichtbar für den Nutzer. Der Injector erkennt das (PID-
Vergleich des Vordergrundfensters) und holt mit `FOCUS|<hwnd>` die zuletzt
genutzte externe App zurück, bevor gepastet wird.

Kaskade: `PASTE` (Ctrl+V) → `TYPE` (Unicode-SendInput, base64-utf16) → Text
bleibt in der Clipboard. Clipboard wird 400 ms nach dem Paste restored.
Admin-Ziel-Apps (UIPI) blockieren synthetische Eingabe → dann greift die
Clipboard-Fallback. Jeder Ausgang wird geloggt (`inject ok via paste/type`,
`inject failed - clipboard fallback`) und ist im Diagnostics-Live-Log sichtbar.

---

## 7. Daten & Speicherorte

| Pfad | Inhalt |
|---|---|
| `%APPDATA%/Whisper Free/settings.json` | Alle Einstellungen (App strimmt unbekannte Keys, clampt Zahlen) |
| `%APPDATA%/Whisper Free/history.json` | Letzte 100 Diktate |
| `%APPDATA%/Whisper Free/window-state.json` | Fenster-/Widget-Position |
| `%APPDATA%/Whisper Free/engine-conn.json` | Daemon-Endpunkt (Port/Token/PID) — wird bei jedem Spawn neu geschrieben |
| `%APPDATA%/Whisper Free/logs/whisper-free.log` | Rotierendes Log (5 MB), auch live in Diagnostics |
| `%LOCALAPPDATA%/WhisperFree/models` (macOS: `~/Library/Application Support/WhisperFree/models`) | Modelle (Parakeet ~2,4 GB fp32 bzw. ~0,7 GB int8, Silero 2 MB, optional Qwen 1,9 GB) — einmal geladen, nie wieder |
| `python/.venv` (dev) bzw. `%APPDATA%/…/python-venv` (packaged) | Python-Runtime inkl. onnxruntime-gpu |

`HKCU\...\Run\ParakeetDictationEngine` — Login-Eintrag für den Warm-Engine-Daemon
(nur bei aktivem `warmEngineAtLogin`).

---

## 8. Performance-Buch (gemessen auf Ryzen 3800X + RTX 2080 Ti)

| Metrik | Wert |
|---|---|
| App-Start warm (Daemon lebt) | **~0,3 s bis ready** |
| App-Start kalt (Daemon-Neustart) | ~6–9 s (Modell→VRAM ist der Preis) |
| 14 s Audio dekodieren | ~120–190 ms (RTF 0,009–0,013) vs. CPU int8 ~1000 ms |
| Live-Partials | alle ~270 ms, ~120–190 ms Inferenz, VAD-gegatet |
| Spekulative Finals | Final feuert bei Endpunkt-Bestätigung instant (`SPEC`) |
| Stille (App „hört zu") | 0 % GPU/CPU-Inferenz |
| VAD-Kosten | <1 ms pro 32 ms Frame, CPU |

---

## 9. Bekannte (harmlose) Log-Zeilen

- `No registered plugin EP device found for 'CUDAExecutionProvider'` — TensorRT
  fehlt (absichtlich nicht installiert); ORT fällt auf CUDA zurück, das direkt
  danach bestätigt wird (`Memcpy nodes … for CUDAExecutionProvider`).
- `engine stderr`-Zeilen mit Leerzeichen zwischen Zeichen — UTF-16-Stderr des
  ONNX-Runtime-Warnungs-Streams, rein kosmetisch.
- `Unauthenticated requests to the HF Hub` — nur beim allerersten Download.

---

## 10. Entwickeln

```powershell
npm install && npm run setup-python   # einmal
npm run dev                           # Dev-Server + Hot-Reload
npm run build                         # typecheck + Build nach out/
npm start                             # läuft aus out/ (Desktop-Icon-Workflow)
npx electron . --ui-shot              # rendert alle 4 Views nach .ui-shots/
python python/bench.py engine         # Echtzeit-Engine-Benchmark
```

Auto-Rebuild: Startest du die App direkt aus `out/` und der Source ist neuer,
baut `devRebuild.ts` im Hintergrund und lädt die Fenster neu
(`PARAKEET_NO_AUTOBUILD=1` schaltet ab).
