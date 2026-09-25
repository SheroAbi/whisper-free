"""Whisper Free - local inference sidecar.

Reads framed audio/control on stdin, runs Parakeet (onnx-asr) on a dedicated
inference thread so stdin handling never blocks, and emits newline-JSON events
on stdout.

Real-time strategy (v2):
  * Silero VAD (streaming, <1 ms / 32 ms frame on CPU) gates everything. During
    silence NO inference runs at all - the machine stays cool and quiet.
  * While speech is active, partials re-decode the utterance on a fixed cadence
    (default 250 ms); the interval self-adapts upward if inference is slower,
    so a slow machine throttles instead of melting (backpressure + heat guard).
  * The final pass always re-decodes the whole utterance cleanly on stop /
    silence endpoint. Pending partials never delay the final (the worker skips
    them), so stop->insert stays fast.

Run:  python engine.py --model <id> --quantization fp32 --language auto
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import socket
import sys
import threading
import time

import numpy as np

import protocol
from asr import ParakeetASR
from vad import EnergyVAD

SAMPLE_RATE = 16000

# Bumped whenever the engine protocol/CLI changes; a mismatching daemon is
# replaced by the app instead of spoken to.
PROTOCOL_VERSION = 3
PARTIAL_MIN_SAMPLES = int(0.32 * SAMPLE_RATE)
# Cap on the partial decode window. The extra guard is left-context audio: a
# token cut by the window edge decodes garbled, so the window starts 0.6 s
# earlier than the text seam and that seam zone re-decodes cleanly each time.
PARTIAL_MAX_SECONDS = 12.0
PARTIAL_GUARD_S = 0.6
PARTIAL_SEAM_S = 0.15
VOICE_RECENT_MS = 1500.0  # keep streaming this long after speech stops
TAIL_PARTIAL_DELAY_MS = 350.0  # one trailing partial to catch the last words
HEAT_GUARD_MS = 2500.0  # a single partial slower than this disables partials
# Speculative finals: start decoding the finished utterance at ~half the
# silence window, so the final text is already on the GPU->done pile when the
# silence endpoint fires. Cuts perceived stop->text latency to near zero.
SPEC_START_FRACTION = 0.5
SPEC_MIN_SILENCE_MS = 300.0


def make_asr(model_id: str, quantization: str, language: str):
    """Pick the inference backend for a model id.

    `qwen*` ids run on the GPU via the qwen-asr package; everything else uses
    the onnx-asr Parakeet path. QwenASR is imported lazily so machines without
    torch installed are unaffected unless a Qwen model is actually selected.
    """
    if model_id.lower().startswith("qwen"):
        from qwen_asr_backend import QwenASR
        return QwenASR(model_id, quantization, language)
    return ParakeetASR(model_id, quantization, language)


def backend_family(model_id: str) -> str:
    return "torch" if (model_id or "").lower().startswith("qwen") else "onnx"


def make_vad():
    """Instant energy VAD; Silero upgrades it in the loader thread.

    The energy VAD needs zero setup so the engine can spawn immediately. Once
    the model thread is running we swap in Silero (learned, precise) - long
    before the engine reports ready, so dictation always uses it. If Silero
    can't load (e.g. no network on very first run) the energy VAD stays.
    """
    return EnergyVAD(SAMPLE_RATE)


def _build_silero():
    from vad_silero import StreamingSileroVAD
    return StreamingSileroVAD(SAMPLE_RATE)


class Engine:
    def __init__(self, model_id: str, quantization: str, language: str):
        self.asr = make_asr(model_id, quantization, language)
        # Every model that has been built stays in memory, keyed by
        # (model_id, quantization). Switching back to one already loaded is then
        # instant - no reload, no loading screen. Cheap for our 2-3 models.
        self.asr_cache: dict[tuple[str, str], object] = {
            (model_id, quantization): self.asr
        }
        self.vad = make_vad()

        self.lock = threading.RLock()
        self.cv = threading.Condition(self.lock)

        self.buffer: list[np.ndarray] = []
        self.buffered_samples = 0

        self.recording = False
        self.ready = False
        self.shutdown = False
        self.had_fatal = False
        self.utterance_id = 0

        self.pending_partial = False
        self.pending_final = False
        self.final_auto = False
        # Speculative final: a full-utterance decode kicked off mid-silence.
        # {"text": str, "ms": float} or None; invalid the moment speech resumes.
        self.pending_spec = False
        self._spec = None

        # Streaming scheduler state.
        self.partial_interval_ms = 250.0
        self._last_partial_time = 0.0
        self._last_partial_ms = 0.0  # observed inference cost of the last partial
        self._last_voice_ms = float("-inf")  # wall time of last detected speech
        self._tail_partial_at: float | None = None
        self._partials_disabled = False
        # Token timeline of the previous partial (piece, abs_start, abs_end) for
        # stitching the live text across the sliding partial window.
        self._last_tokens: list[tuple[str, float, float]] = []

        # Default ON: after ~1 s of silence the utterance finalizes and inserts
        # by itself - speak, pause, text appears. Set from settings.autoStop.
        self.auto_stop = True

    # -- lifecycle ----------------------------------------------------------

    def start_threads(self) -> None:
        threading.Thread(target=self._load_model, name="loader", daemon=True).start()
        threading.Thread(target=self._inference_loop, name="infer", daemon=True).start()

    def _load_model(self) -> None:
        protocol.send({"type": "state", "state": "starting"})
        try:
            # Silero in parallel with the model load - whichever finishes first
            # wins the race to "ready"; dictation only starts after both.
            threading.Thread(target=self._upgrade_vad, name="vad", daemon=True).start()
            self.asr.load()
            self.asr.warmup(shapes=(1.0,))
            with self.cv:
                self.ready = True
            protocol.send({"type": "state", "state": "ready",
                           "backend": self.asr.backend,
                           "modelId": self.asr.model_id})
            # Post-ready: pre-plan the long-window shape so partials never pay
            # one-time kernel-selection cost mid-dictation.
            threading.Thread(
                target=lambda: self.asr.warmup(shapes=(7.0,)), name="warm2", daemon=True
            ).start()
        except ModuleNotFoundError as exc:
            self.had_fatal = True
            protocol.send({"type": "error", "fatal": True,
                           "message": f"missing python dependency: {exc}. "
                                      "Delete the python venv folder and restart the app to reinstall."})
        except Exception as exc:  # noqa: BLE001
            self.had_fatal = True
            protocol.send({"type": "error", "fatal": True,
                           "message": f"model load failed: {exc}"})

    def _upgrade_vad(self) -> None:
        try:
            silero = _build_silero()
        except Exception as exc:  # noqa: BLE001
            protocol.log("warn", f"Silero VAD unavailable ({exc}) - using energy VAD")
            return
        with self.cv:
            # The VAD is only read while recording, and recording requires
            # ready - swapping on any non-recording state is race-free.
            if not self.recording:
                self.vad = silero
                protocol.log("info", "VAD: Silero (ONNX, streaming)")
            else:
                protocol.log("info", "VAD: Silero arrived mid-recording - kept for next session")

    # -- audio ingest -------------------------------------------------------

    def on_audio(self, payload: bytes) -> None:
        if not self.recording or not self.ready:
            return
        if not payload:
            return
        samples = np.frombuffer(payload, dtype="<i2").astype(np.float32) / 32768.0
        now = time.perf_counter() * 1000.0

        endpoint = False
        voiced = False
        with self.lock:
            self.buffer.append(samples)
            self.buffered_samples += samples.size
            vad_res = self.vad.update(samples)
            voiced = bool(vad_res["voiced"])
            if voiced:
                # Speech resumed: a speculative decode of the buffer is stale.
                self._spec = None
                self._last_voice_ms = now
                self._tail_partial_at = None
            elif self._last_voice_ms > float("-inf"):
                silence = now - self._last_voice_ms
                # Schedule one trailing partial shortly after speech stops so
                # the preview catches the tail words before a (possible) final.
                if silence >= TAIL_PARTIAL_DELAY_MS and self._tail_partial_at is None \
                        and silence < VOICE_RECENT_MS:
                    self._tail_partial_at = now + TAIL_PARTIAL_DELAY_MS
                if self.auto_stop and vad_res["endpoint"]:
                    endpoint = True
                    self.recording = False
                    self.pending_final = True
                    self.final_auto = True
                    # A finished speculation makes the final instant.
                    self.pending_partial = False
                    self.pending_spec = False
                    self._tail_partial_at = None
                    self.cv.notify()

        if endpoint:
            return

        if not voiced:
            self._maybe_speculate(now)
        self._maybe_schedule_partial(now, voiced)

    def _maybe_speculate(self, now: float) -> None:
        """Kick off a full-utterance decode midway through the silence pause.

        By the time the VAD endpoint confirms the utterance really ended, the
        final text is usually already decoded and the final fires instantly.
        Any resumed speech invalidates the speculation (`_spec = None`).
        """
        if not self.auto_stop or self._spec is not None or self.pending_spec:
            return
        if self.pending_final or not self.recording:
            return
        if self._last_voice_ms == float("-inf"):
            return
        silence = now - self._last_voice_ms
        window = float(getattr(self.vad, "silence_ms", 1000))
        if silence < max(SPEC_MIN_SILENCE_MS, window * SPEC_START_FRACTION):
            return
        with self.cv:
            self.pending_spec = True
            self.cv.notify()

    def _maybe_schedule_partial(self, now: float, voiced: bool) -> None:
        voice_recent = voiced or (now - self._last_voice_ms) < VOICE_RECENT_MS
        if not voice_recent:
            return
        if self._partials_disabled:
            return
        # A pending/finished speculation already covers the tail of the
        # utterance at final quality - don't double-decode at the pause.
        if self.pending_spec or self._spec is not None:
            return

        # Adaptive cadence: the configured interval, but never faster than the
        # engine can keep up with (2x the last observed inference time, capped).
        interval = self.partial_interval_ms
        if self._last_partial_ms > 0:
            interval = max(interval, min(1000.0, 2.0 * self._last_partial_ms))

        due_partial = now - self._last_partial_time >= interval
        due_tail = (self._tail_partial_at is not None and now >= self._tail_partial_at)

        if due_partial or due_tail:
            with self.cv:
                if self.buffered_samples >= PARTIAL_MIN_SAMPLES:
                    self._last_partial_time = now
                    self._tail_partial_at = None
                    self.pending_partial = True
                    self.cv.notify()

    # -- control ------------------------------------------------------------

    def on_control(self, msg: dict) -> None:
        cmd = msg.get("cmd")
        if cmd == "start":
            self._start_recording(msg)
        elif cmd == "stop":
            self._stop_recording(auto=False)
        elif cmd == "cancel":
            self._cancel()
        elif cmd == "config":
            self._configure(msg)
        elif cmd == "reload":
            self._reload(msg)
        elif cmd == "shutdown":
            self._do_shutdown()
        else:
            protocol.log("warn", f"unknown control cmd: {cmd}")

    def _start_recording(self, msg: dict) -> None:
        if not self.ready:
            protocol.log("warn", "start ignored: model not ready")
            return
        self._configure(msg)
        with self.cv:
            self.utterance_id = int(msg.get("utteranceId", self.utterance_id + 1))
            self.buffer.clear()
            self.buffered_samples = 0
            self.pending_partial = False
            self.pending_final = False
            self.pending_spec = False
            self._spec = None
            self.vad.reset()
            self._last_partial_time = time.perf_counter() * 1000.0
            self._last_voice_ms = float("-inf")
            self._tail_partial_at = None
            self._last_tokens = []
            self.recording = True
        protocol.send({"type": "state", "state": "listening",
                       "utteranceId": self.utterance_id})

    def _stop_recording(self, auto: bool) -> None:
        with self.cv:
            if not self.recording and self.buffered_samples == 0:
                return
            self.recording = False
            self.pending_final = True
            self.final_auto = auto
            # A pending partial must not delay the final: the worker checks the
            # final flag first and skips the partial decode.
            self.pending_partial = False
            self.pending_spec = False
            self._tail_partial_at = None
            self.cv.notify()

    def _cancel(self) -> None:
        with self.cv:
            self.recording = False
            self.pending_partial = False
            self.pending_final = False
            self.pending_spec = False
            self._spec = None
            self.buffer.clear()
            self.buffered_samples = 0
            self.vad.reset()
            self._tail_partial_at = None
            self._last_voice_ms = float("-inf")
        protocol.send({"type": "state", "state": "cancelled",
                       "utteranceId": self.utterance_id})

    def _configure(self, msg: dict) -> None:
        if "partialIntervalMs" in msg:
            self.partial_interval_ms = max(100.0, float(msg["partialIntervalMs"]))
        if "autoStop" in msg:
            self.auto_stop = bool(msg["autoStop"])
        if "language" in msg and msg["language"]:
            self.asr.language = msg["language"]
        thr = msg.get("vadThreshold")
        sil = msg.get("silenceMs")
        if thr is not None or sil is not None:
            self.vad.configure(
                float(thr) if thr is not None else getattr(self.vad, "base_threshold", 0.012),
                int(sil) if sil is not None else getattr(self.vad, "silence_ms", 1000),
            )

    def _reload(self, msg: dict) -> None:
        model_id = msg.get("modelId", self.asr.model_id)
        quant = msg.get("quantization", self.asr.quantization)
        lang = msg.get("language", self.asr.language)
        key = (model_id, quant)

        with self.cv:
            self.recording = False
            self.pending_partial = False
            self.pending_final = False
            self.pending_spec = False
            self._spec = None
            self.buffer.clear()
            self.buffered_samples = 0
            self.vad.reset()

        # Already loaded once this session -> switch instantly, no reload screen.
        cached = self.asr_cache.get(key)
        if cached is not None and getattr(cached, "model", None) is not None:
            cached.language = lang
            with self.cv:
                self.asr = cached
                self.ready = True
            protocol.send({"type": "metrics",
                           "modelLoadMs": round(cached.model_load_ms or 0, 1),
                           "backend": cached.backend})
            protocol.send({"type": "state", "state": "ready",
                           "backend": cached.backend, "modelId": cached.model_id})
            protocol.log("info", f"switched to cached model {cached.model_id} (instant)")
            return

        # Crossing backends (ONNX Runtime <-> torch) inside one process is unsafe
        # on GPU: both ship their own cuDNN, and whichever loads second fails
        # with "WinError 127 ... cudnn_cnn64_9.dll". Ask the app for a fresh
        # process instead - it restarts the daemon with the new model.
        if backend_family(model_id) != backend_family(self.asr.model_id):
            with self.cv:
                self.ready = False
            protocol.send({"type": "restart-required", "modelId": model_id,
                           "quantization": quant, "language": lang})
            return

        # First use of this model in this process -> build (on the main thread,
        # so torch imports cleanly) and load it once.
        with self.cv:
            self.ready = False
        try:
            new_asr = make_asr(model_id, quant, lang)
        except Exception as exc:  # noqa: BLE001
            protocol.send({"type": "error", "fatal": True,
                           "message": f"failed to initialise {model_id}: {exc}"})
            return
        self.asr_cache[key] = new_asr
        self.asr = new_asr
        threading.Thread(target=self._load_model, name="loader", daemon=True).start()

    def _do_shutdown(self) -> None:
        with self.cv:
            self.shutdown = True
            self.cv.notify_all()

    # -- inference worker ---------------------------------------------------

    def _snapshot(self, clear: bool, cap_seconds: float | None) -> tuple[np.ndarray, int, float]:
        """Return (audio, utterance_id, window_offset_seconds).

        `window_offset` is how much audio was truncated from the front when
        capping (0.0 for finals and short partials) - it anchors token times.
        """
        with self.lock:
            if self.buffered_samples == 0:
                if clear:
                    self.buffer.clear()
                    self.buffered_samples = 0
                    self.vad.reset()
                return np.zeros(0, dtype=np.float32), self.utterance_id, 0.0
            audio = np.concatenate(self.buffer) if len(self.buffer) > 1 else self.buffer[0]
            uid = self.utterance_id
            if clear:
                self.buffer.clear()
                self.buffered_samples = 0
                self.vad.reset()
            else:
                # keep a single concatenated chunk to avoid unbounded list growth
                self.buffer = [audio]
        offset = 0.0
        if cap_seconds is not None:
            cap = int(cap_seconds * SAMPLE_RATE)
            if audio.size > cap:
                offset = (audio.size - cap) / SAMPLE_RATE
                audio = audio[-cap:]
        return audio, uid, offset

    def _inference_loop(self) -> None:
        while True:
            with self.cv:
                while not (self.pending_final or self.pending_partial or self.pending_spec) \
                        and not self.shutdown:
                    self.cv.wait()
                if self.shutdown:
                    return
                do_final = self.pending_final
                auto = self.final_auto
                # The final always wins: skip co-scheduled partial/speculation
                # work so stop latency is at most one decode, never a queue.
                do_spec = self.pending_spec and not do_final
                if do_final:
                    self.pending_final = False
                    self.pending_partial = False
                    self.pending_spec = False
                elif do_spec:
                    self.pending_spec = False
                else:
                    self.pending_partial = False

            try:
                if do_spec:
                    self._run_speculative()
                    continue

                audio, uid, offset_s = self._snapshot(
                    clear=do_final,
                    cap_seconds=None if do_final else PARTIAL_MAX_SECONDS + PARTIAL_GUARD_S,
                )
                if audio.size == 0:
                    if do_final:
                        self._spec = None
                        protocol.send({"type": "final", "text": "", "utteranceId": uid,
                                       "auto": auto, "empty": True})
                    continue

                if do_final:
                    # Reuse a finished speculation when no speech resumed since
                    # it was decoded: the final text is already ready.
                    spec = self._spec
                    self._spec = None
                    if spec is not None:
                        text, ms = spec["text"], spec["ms"]
                    else:
                        text, ms = self.asr.transcribe(audio)
                    rtf = (ms / 1000.0) / (audio.size / SAMPLE_RATE) if audio.size else None
                    protocol.send({"type": "final", "text": text, "utteranceId": uid,
                                   "auto": auto, "inferenceMs": round(ms, 1),
                                   "rtf": round(rtf, 3) if rtf else None,
                                   "speculative": spec is not None})
                    self._last_tokens = []
                    continue

                text, ms = self._partial_transcribe(audio, offset_s)
                self._last_partial_ms = ms
                if ms > HEAT_GUARD_MS:
                    # This machine cannot keep up with live partials - stop
                    # burning CPU on them; finals still run normally.
                    self._partials_disabled = True
                    protocol.log(
                        "warn",
                        f"partial inference too slow ({ms:.0f} ms) - live "
                        "partials disabled for this session (finals unaffected)")
                protocol.send({"type": "partial", "text": text, "utteranceId": uid,
                               "inferenceMs": round(ms, 1)})
            except Exception as exc:  # noqa: BLE001
                protocol.send({"type": "error", "fatal": False,
                               "message": f"inference error: {exc}"})

    def _run_speculative(self) -> None:
        """Decode the full buffer during the silence pause (speculative final)."""
        audio, uid, _ = self._snapshot(clear=False, cap_seconds=None)
        if audio.size == 0:
            return
        text, ms = self.asr.transcribe(audio)
        self._spec = {"text": text, "ms": ms}
        # Surface the speculative result as a live partial so the preview is
        # already final-quality while the silence window runs out. If the
        # utterance ended mid-decode, stay quiet - the final path reports it.
        if self.recording:
            protocol.send({"type": "partial", "text": text, "utteranceId": uid,
                           "inferenceMs": round(ms, 1)})

    def _partial_transcribe(self, audio: np.ndarray, offset_s: float) -> tuple[str, float]:
        """Decode the partial window, stitching text before the window.

        When the utterance outgrows the partial window, only its tail is
        re-decoded; the window starts PARTIAL_GUARD_S before the text seam so
        boundary words get full context. Tokens left of the seam stay frozen
        from the previous partial (TDT timestamps), tokens right of it come
        from this decode - the live text keeps growing without jumps or
        duplicated words.
        """
        if not hasattr(self.asr, "transcribe_tokens"):
            return self.asr.transcribe(audio)

        pieces, ms = self.asr.transcribe_tokens(audio)
        abs_tokens = [(t, s + offset_s, e + offset_s) for t, s, e in pieces]
        seam = offset_s + PARTIAL_SEAM_S
        committed = [x for x in self._last_tokens if x[2] <= seam]
        straddlers = [x for x in self._last_tokens if x[1] < seam < x[2]]
        visible = [x for x in abs_tokens if x[1] >= seam]
        self._last_tokens = committed + straddlers + visible

        joined = ("".join(x[0] for x in committed)
                  + "".join(x[0] for x in straddlers)
                  + "".join(x[0] for x in visible))
        return " ".join(joined.split()), ms


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="nemo-parakeet-tdt-0.6b-v3")
    parser.add_argument("--quantization", default="fp32")
    parser.add_argument("--language", default="auto")
    parser.add_argument("--serve", action="store_true",
                        help="run as a resident daemon on a loopback socket")
    parser.add_argument("--conn-file",
                        help="where to write {port, token, pid} for the app to find")
    parser.add_argument("--idle-timeout", type=float, default=1800.0,
                        help="exit after this many seconds without a client")
    args = parser.parse_args()

    try:
        engine = Engine(args.model, args.quantization, args.language)
    except ModuleNotFoundError as exc:
        protocol.send({"type": "error", "fatal": True,
                       "message": f"missing python dependency: {exc}. "
                                  "The GPU model needs torch + qwen-asr installed."})
        return
    except Exception as exc:  # noqa: BLE001
        protocol.send({"type": "error", "fatal": True,
                       "message": f"engine init failed: {exc}"})
        return
    engine.start_threads()

    if args.serve:
        _serve(engine, args.conn_file, args.idle_timeout)
        return

    try:
        for msg_type, payload in protocol.read_messages(sys.stdin.buffer):
            if msg_type == protocol.MSG_AUDIO:
                engine.on_audio(payload)
            elif msg_type == protocol.MSG_CONTROL:
                try:
                    engine.on_control(json.loads(payload.decode("utf-8")))
                except Exception as exc:  # noqa: BLE001
                    protocol.log("error", f"bad control message: {exc}")
    except KeyboardInterrupt:
        pass
    finally:
        engine._do_shutdown()


# ---------------------------------------------------------------------------
# Resident daemon mode: the model stays loaded across app restarts. The app
# connects over a loopback TCP socket, so a relaunch is "ready" in milliseconds
# instead of paying the ~5 s model load again. The daemon exits after
# --idle-timeout seconds without a client, so no resources are held forever.
# ---------------------------------------------------------------------------


class _SockWriter:
    """Adapter so protocol.send can write JSON lines to a socket."""

    def __init__(self, sock: socket.socket):
        self.sock = sock

    def write(self, s: str) -> None:
        self.sock.sendall(s.encode("utf-8", "replace"))

    def flush(self) -> None:
        pass


def _client_loop(engine: "Engine", conn: socket.socket, token: str) -> None:
    """Serve one connected app until it disconnects."""
    f = conn.makefile("rb")
    protocol.set_output(_SockWriter(conn))

    # Handshake: the first control message must carry the token from the
    # conn file (same-user, same-machine auth) and a matching protocol version.
    hello = None
    try:
        for msg_type, payload in protocol.read_messages(f):
            if msg_type != protocol.MSG_CONTROL:
                conn.close()
                return
            hello = json.loads(payload.decode("utf-8"))
            if hello.get("cmd") != "hello" or hello.get("token") != token:
                protocol.send({"type": "error", "fatal": True,
                               "message": "daemon handshake rejected (bad token)"})
                conn.close()
                return
            version = str(hello.get("version", ""))
            if version != str(PROTOCOL_VERSION):
                protocol.send({"type": "error", "fatal": True,
                               "message": f"daemon protocol {PROTOCOL_VERSION} != app {version}"})
                conn.close()
                return
            break
    except (OSError, ValueError):
        return
    if hello is None:
        return

    # Replay the current state so a freshly launched app is instantly informed.
    protocol.send({"type": "hello", "version": PROTOCOL_VERSION,
                   "modelId": engine.asr.model_id,
                   "quantization": engine.asr.quantization,
                   "backend": engine.asr.backend,
                   "ready": engine.ready})
    with engine.cv:
        if engine.ready:
            protocol.send({"type": "state", "state": "ready",
                           "backend": engine.asr.backend,
                           "modelId": engine.asr.model_id})
            protocol.send({"type": "metrics",
                           "modelLoadMs": round(engine.asr.model_load_ms or 0, 1),
                           "backend": engine.asr.backend})
        else:
            protocol.send({"type": "state", "state": "loading-model",
                           "detail": f"{engine.asr.model_id}"})

    # App wants a different model than the daemon booted with -> hot switch.
    if hello.get("modelId") and (hello["modelId"] != engine.asr.model_id
                                 or hello.get("quantization") != engine.asr.quantization):
        engine.on_control({"cmd": "reload",
                           "modelId": hello["modelId"],
                           "quantization": hello.get("quantization"),
                           "language": hello.get("language", "auto")})

    try:
        for msg_type, payload in protocol.read_messages(f):
            if engine.shutdown:
                break
            if msg_type == protocol.MSG_AUDIO:
                engine.on_audio(payload)
            elif msg_type == protocol.MSG_CONTROL:
                try:
                    engine.on_control(json.loads(payload.decode("utf-8")))
                except Exception as exc:  # noqa: BLE001
                    protocol.log("error", f"bad control message: {exc}")
    except OSError:
        pass  # client dropped
    finally:
        protocol.set_output(protocol.NullWriter())
        try:
            conn.close()
        except OSError:
            pass


def _serve(engine: "Engine", conn_file: str | None, idle_timeout: float) -> None:
    protocol.set_output(protocol.NullWriter())

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(4)
    port = srv.getsockname()[1]
    token = secrets.token_hex(16)

    if conn_file:
        tmp = conn_file + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"port": port, "token": token, "pid": os.getpid(),
                       "version": PROTOCOL_VERSION,
                       "modelId": engine.asr.model_id}, f)
        os.replace(tmp, conn_file)

    last_activity = time.time()
    fatal_at: float | None = None
    while not engine.shutdown:
        srv.settimeout(min(30.0, max(1.0, idle_timeout)))
        try:
            conn, _ = srv.accept()
        except socket.timeout:
            idle = time.time() - last_activity
            if fatal_at is not None and time.time() - fatal_at > 60:
                break  # fatal error and nobody came to look at it
            if idle >= idle_timeout:
                break
            continue
        except OSError:
            break

        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        conn.settimeout(None)
        fatal_at = None
        _client_loop(engine, conn, token)
        last_activity = time.time()
        if engine.had_fatal:
            fatal_at = time.time()

    srv.close()
    engine._do_shutdown()


if __name__ == "__main__":
    main()
