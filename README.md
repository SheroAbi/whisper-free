# 🎙️ Whisper Free

**The free, open-source, 100 % local alternative to Wispr Flow.**
Press a hotkey, talk, and your words appear in whatever app you're typing in.
No subscription. No account. No cloud. Your voice never leaves your computer.

- 💸 **Free forever:** no monthly fee, no word limits, no "pro" tier.
- 🔒 **Private by design:** speech recognition runs on your own machine, fully offline once set up.
- 🎯 **Very accurate:** uses NVIDIA **Parakeet TDT 0.6B v3**, one of the most accurate open speech models, plus optional **Qwen3-ASR** for tricky audio.
- ⚡ **Fast:** live transcript while you speak, text is in place ~0.4 s after you stop (with an NVIDIA GPU).
- 🌍 **Multilingual:** 25 European languages (German, English, French, Spanish, …), auto-detected.
- ⌨️ **Works everywhere:** Word, Slack, browser, IDE, email. If you can type there, you can dictate there.

> Wispr Flow is a great product, but it's a paid cloud service. Whisper Free does
> the core job (hotkey → speak → text is pasted) locally and for free.
> *(Not affiliated with Wispr Flow or OpenAI Whisper.)*

---

## ✨ How it works

1. Put your cursor in any text field.
2. Press **Ctrl + Shift + Space** (macOS: **⌘ + Shift + Space**) and speak.
3. Press it again. The text is pasted where your cursor is.

| Hotkey (Windows / macOS) | Action |
|---|---|
| Ctrl/⌘ + Shift + Space | Start / stop dictation |
| Ctrl/⌘ + Shift + W | Show / hide the floating widget |
| Ctrl/⌘ + Shift + P | Pause |
| Ctrl/⌘ + Shift + K | Quick panel |

Every hotkey can be changed in **Settings**, including push-to-talk mode.

---

## 🪟 Windows (main platform)

**You need:** Windows 10/11 (64-bit), [Node.js](https://nodejs.org) 18+, [Python](https://www.python.org/downloads/) **3.10 – 3.12** (64-bit).
An NVIDIA GPU is optional but makes it much faster.

```bash
git clone https://github.com/SheroAbi/whisper-free.git
cd whisper-free
npm install
npm start
```

Optional: `npm run shortcut` creates a Desktop and Start-Menu icon, so the app opens without a terminal.

**First start** (one-time, a few minutes): the app creates its own Python environment and downloads the speech model (~2.4 GB, plus ~600 MB of CUDA runtime if you have an NVIDIA GPU). After that, **everything works offline** and starts in seconds.

Good to know:
- 🚀 **"Warm engine at login"** (on by default) keeps the model ready in the background, so the app is instantly ready after a reboot. Turn it off in Settings → App.
- 🛡️ If an app runs **as Administrator**, Windows blocks pasting into it. Start Whisper Free as Admin too, or paste manually (the text is on your clipboard).
- 📦 Installer: `npm run build:win` creates a setup `.exe` in `release/`.

---

## 🍎 macOS (Apple Silicon & Intel)

> ⚠️ **macOS support is new.** Windows is where it's tested daily. The macOS
> code paths are implemented (Python setup, paste via Cmd+V, permissions) but
> haven't had much real-world testing yet. Bug reports are very welcome!

**You need:** macOS 12+, [Homebrew](https://brew.sh), then:

```bash
brew install node python@3.12
git clone https://github.com/SheroAbi/whisper-free.git
cd whisper-free
npm install
npm run start:mac
```

**Grant two permissions** (macOS will ask on first start):
1. 🎤 **Microphone**: so it can hear you.
2. ♿ **Accessibility** (System Settings → Privacy & Security → Accessibility): so it can paste the text into other apps. Without it the text still lands on your clipboard, so just press ⌘V.

Notes:
- Speech runs on the CPU with Parakeet, which is fast enough on Apple Silicon for real-time dictation. The optional Qwen3-ASR model uses the Apple GPU (Metal/MPS).
- "Warm engine at login" is Windows-only. On macOS the engine stays warm while the app is running (closing the window keeps it in the menu bar).
- App bundle: `npm run build:mac` (run it on a Mac) creates a `.dmg` in `release/`.

---

## 📦 Where the models live (downloaded only once)

Models are downloaded **once** and kept in Whisper Free's own folder. Every
start after that loads them straight from disk, with no internet needed and no
re-downloading.

| OS | Model folder |
|---|---|
| Windows | `%LOCALAPPDATA%\WhisperFree\models` |
| macOS | `~/Library/Application Support/WhisperFree/models` |

- Want them somewhere else (e.g. a bigger drive)? Set the environment variable `WHISPER_FREE_MODELS_DIR`.
- Already have the models in the Hugging Face cache (`~/.cache/huggingface`)? They're reused automatically (hard-linked, so no extra disk space).
- **Diagnostics → Model folder** opens it.

---

## 🧠 Models

| Model | Best for | Runs on |
|---|---|---|
| **Parakeet TDT 0.6B v3** *(default)* | Everyday dictation, 25 EU languages, best speed/accuracy balance | NVIDIA GPU or CPU |
| Parakeet TDT 0.6B v2 | English only | CPU |
| Qwen3-ASR 0.6B | Hard audio, 50+ languages; slower live preview | NVIDIA GPU / Apple GPU (installs ~2.5 GB extra on first use) |

---

## 🛠️ Troubleshooting

| Problem | Fix |
|---|---|
| "Install Python 3.12" | Install 64-bit Python 3.10–3.12 and restart the app. (3.13+ may lack the needed packages.) |
| Text isn't pasted | Windows: target app runs as Admin → run Whisper Free as Admin. macOS: grant Accessibility permission. The text is always on the clipboard as a fallback. |
| Engine error | Settings → Diagnostics shows the live log. "Restart engine" restarts everything. |
| Microphone not found | Pick it in Settings. An unplugged mic automatically falls back to the default one. |

---

## 🧩 Under the hood

Electron + React UI, and a small Python engine running the model with ONNX Runtime (CUDA / CPU) or PyTorch.
Silero VAD makes sure nothing is computed while you're silent.
Full technical docs (German): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```text
src/main       Electron main process (engine manager, paste, hotkeys, tray)
src/renderer   React UI (main window + floating widget)
python/        Speech engine (Parakeet / Qwen3-ASR, VAD, model store)
scripts/       Setup & launch helpers
```

---

## 🇩🇪 Kurz auf Deutsch

Whisper Free ist die **kostenlose, lokale Alternative zu Wispr Flow**: Hotkey drücken, sprechen, der Text landet dort, wo dein Cursor ist. Alles läuft auf deinem Rechner, ohne Abo, ohne Cloud. Die Modelle werden **einmal** heruntergeladen und liegen danach dauerhaft im Modell-Ordner (siehe oben). Jeder weitere Start ist offline und schnell.
Windows: `npm install` → `npm start`. macOS: `brew install node python@3.12` → `npm install` → `npm run start:mac`.

---

## 📄 License

[MIT](LICENSE): free to use, modify and share.
The speech models have their own licenses: Parakeet (CC-BY-4.0, NVIDIA), Qwen3-ASR (Apache-2.0), Silero VAD (MIT).
