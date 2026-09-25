"""Developer benchmark for the dictation sidecar (not used by the app).

Modes:
  tts      - generate a German test WAV via Windows SAPI (16 kHz mono)
  vad      - sanity-check the streaming Silero VAD on the test WAV
  engine   - end-to-end: run engine.py as the app does, feed the WAV in
             real-time 20 ms frames, report partial/final latency profile
  asr      - direct ParakeetASR timing for a provider/quantization combo

Usage:
  python bench.py tts
  python bench.py vad
  python bench.py engine                 # uses env (PARAKEET_PROVIDERS etc.)
  PARAKEET_PROVIDERS=... python bench.py asr --quant fp32
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import subprocess
import sys
import time

import numpy as np

WAV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bench_tts.wav")
SAMPLE_RATE = 16000
GERMAN_TEXT = (
    "Hallo, das ist ein Test der neuen Echtzeit-Diktierfunktion. "
    "Wir messen jetzt, wie schnell die Spracherkennung auf der Grafikkarte ist. "
    "Und ob der Computer dabei leise und kühl bleibt."
)


def cmd_tts() -> None:
    ps = f"""
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $s.GetInstalledVoices() | ForEach-Object {{ $_.VoiceInfo }}
$de = $voices | Where-Object {{ $_.Culture -like 'de*' }} | Select-Object -First 1
if ($de) {{ $s.SelectVoice($de.Name) }}
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile('{WAV_PATH}', $fmt)
$s.Speak('{GERMAN_TEXT}')
$s.Dispose()
"""
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)
    print(f"wrote {WAV_PATH}")


def load_wav() -> np.ndarray:
    import soundfile as sf

    audio, sr = sf.read(WAV_PATH, dtype="float32")
    assert sr == SAMPLE_RATE, f"expected 16 kHz, got {sr}"
    if audio.ndim > 1:
        audio = audio[:, 0]
    return audio


def cmd_vad() -> None:
    from vad_silero import StreamingSileroVAD

    audio = load_wav()
    vad = StreamingSileroVAD(SAMPLE_RATE)
    vad.configure(0.012, 1000)

    n = int(0.02 * SAMPLE_RATE)
    endpoints = 0
    voiced_frames = 0
    t0 = time.perf_counter()
    for i in range(0, audio.size, n):
        res = vad.update(audio[i : i + n])
        voiced_frames += int(res["voiced"])
        endpoints += int(res["endpoint"])
    dt = (time.perf_counter() - t0) * 1000
    print(f"audio: {audio.size / SAMPLE_RATE:.2f}s | voiced frames: {voiced_frames} "
          f"| endpoints: {endpoints} | VAD total time: {dt:.1f} ms "
          f"({dt / (audio.size / SAMPLE_RATE * 1000):.4f} ms per 100 ms audio)")


def frame(payload: bytes, msg_type: int) -> bytes:
    return struct.pack(">I", len(payload) + 1) + bytes([msg_type]) + payload


def control(obj: dict) -> bytes:
    return frame(json.dumps(obj).encode("utf-8"), 0x02)


def cmd_engine() -> None:
    audio = load_wav()
    env = dict(os.environ)
    engine = subprocess.Popen(
        [sys.executable, "engine.py", "--model", "nemo-parakeet-tdt-0.6b-v3",
         "--quantization", os.environ.get("BENCH_QUANT", "fp32"), "--language", "auto"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=os.path.dirname(os.path.abspath(__file__)),
        env=env,
    )
    assert engine.stdin and engine.stdout

    events: list[dict] = []

    def pump() -> None:
        for line in engine.stdout:
            line = line.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                print("  [engine]", line[:200])
                continue
            events.append(ev)
            t = ev.get("type")
            if t in ("partial", "final"):
                print(f"  {t:7s} +{time.perf_counter() - T0:6.2f}s  "
                      f"inference={ev.get('inferenceMs', '-')}ms  "
                      f"{'SPEC ' if ev.get('speculative') else ''}"
                      f"rtf={ev.get('rtf', '-')}  text={str(ev.get('text', ''))[:70]!r}")
            elif t == "state":
                print(f"  state   +{time.perf_counter() - T0:6.2f}s  {ev.get('state')}  "
                      f"{ev.get('backend', '')} {ev.get('detail', '')}")
            elif t == "log":
                print(f"  [py] {ev.get('message', '')[:160]}")
            elif t == "error":
                print(f"  ERROR fatal={ev.get('fatal')} {ev.get('message', '')[:200]}")

    import threading

    T0 = time.perf_counter()
    reader = threading.Thread(target=pump, daemon=True)
    reader.start()

    # wait for ready
    ready = False
    while time.perf_counter() - T0 < 300:
        if any(e.get("type") == "state" and e.get("state") == "ready" for e in events):
            ready = True
            break
        time.sleep(0.1)
    if not ready:
        print("engine never became ready")
        engine.kill()
        return

    t_ready = time.perf_counter() - T0

    engine.stdin.write(control({
        "cmd": "start", "utteranceId": 1, "language": "auto",
        "partialIntervalMs": 250, "autoStop": True,
        "vadThreshold": 0.012, "silenceMs": 1000,
    }))
    engine.stdin.flush()

    n = int(0.02 * SAMPLE_RATE)
    lead_silence = np.zeros(int(0.4 * SAMPLE_RATE), dtype=np.float32)
    tail_silence = np.zeros(int(1.8 * SAMPLE_RATE), dtype=np.float32)
    speech_start_i = None
    speech_end_i = None
    i = 0
    t_stream_start = time.perf_counter()
    written = 0
    period = n / SAMPLE_RATE
    next_due = t_stream_start + period
    for chunk in (lead_silence, audio, tail_silence):
        for j in range(0, chunk.size, n):
            piece = chunk[j : j + n]
            if chunk is audio:
                if speech_start_i is None:
                    speech_start_i = time.perf_counter() - t_stream_start
                    print(f"  [bench] speech feed starts at +{speech_start_i:.2f}s")
                speech_end_i = time.perf_counter() - t_stream_start + piece.size / SAMPLE_RATE
            pcm = (np.clip(piece, -1, 1) * 32767).astype("<i2").tobytes()
            engine.stdin.write(frame(pcm, 0x01))
            engine.stdin.flush()
            written += 1
            if written % 250 == 0:
                print(f"  [bench] wrote {written} frames at "
                      f"+{time.perf_counter() - t_stream_start:.2f}s (stream clock)")
            # real-time pacing like the live app (schedule-based, no drift)
            delay = next_due - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
            next_due += period
    print(f"  [bench] feed done: {written} frames, "
          f"+{time.perf_counter() - t_stream_start:.2f}s wall, "
          f"{written * n / SAMPLE_RATE:.2f}s audio")

    # wait for the auto final
    final_ev = None
    deadline = time.perf_counter() + 30
    while time.perf_counter() < deadline:
        final_ev = next((e for e in events if e.get("type") == "final" and e.get("auto")), None)
        if final_ev:
            break
        time.sleep(0.05)

    # post-speech silence already elapsed during pacing; measure now
    time.sleep(0.3)
    engine.stdin.write(control({"cmd": "shutdown"}))
    engine.stdin.flush()
    try:
        engine.wait(5)
    except subprocess.TimeoutExpired:
        engine.kill()

    partials = [e for e in events if e.get("type") == "partial"]
    inf = [e["inferenceMs"] for e in partials if "inferenceMs" in e]
    print("\n=== BENCH SUMMARY ===")
    print(f"ready after:        {t_ready:6.2f}s")
    print(f"partials:           {len(partials)}")
    if inf:
        print(f"partial inference:  avg={sum(inf) / len(inf):.0f}ms  max={max(inf):.0f}ms")
    if final_ev:
        print(f"final inference:    {final_ev.get('inferenceMs')}ms  rtf={final_ev.get('rtf')}")
        print(f"final text:         {final_ev.get('text', '')!r}")
    print(f"backend events:     {[e.get('backend') for e in events if e.get('type') == 'state' and e.get('state') == 'ready']}")


def cmd_asr(quant: str) -> None:
    from asr import ParakeetASR

    audio = load_wav()
    asr = ParakeetASR("nemo-parakeet-tdt-0.6b-v3", quant, "auto")
    asr.load()
    asr.warmup()
    times = []
    text = ""
    for _ in range(5):
        text, ms = asr.transcribe(audio)
        times.append(ms)
    dur = audio.size / SAMPLE_RATE
    print(f"backend={asr.backend}  quant={quant}")
    print(f"audio={dur:.2f}s  text={text[:90]!r}")
    for i, ms in enumerate(times):
        print(f"  run{i + 1}: {ms:7.1f} ms  (rtf {ms / 1000 / dur:.4f})")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["tts", "vad", "engine", "asr"])
    parser.add_argument("--quant", default="fp32")
    args = parser.parse_args()

    if args.mode == "tts":
        cmd_tts()
    elif args.mode == "vad":
        cmd_vad()
    elif args.mode == "engine":
        cmd_engine()
    elif args.mode == "asr":
        cmd_asr(args.quant)


if __name__ == "__main__":
    main()
