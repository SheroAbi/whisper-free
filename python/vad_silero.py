"""Streaming Silero VAD (ONNX) for the dictation sidecar.

Silero VAD runs statefully on 512-sample frames @ 16 kHz (~32 ms of audio) and
costs well under 1 ms per frame on a single CPU thread. Speech probability
gates both the partial-inference scheduler and the auto-stop endpoint, so the
ASR model idles (zero GPU/CPU work) whenever nobody is speaking - that is what
keeps the machine cool and quiet while the app is "always listening".

The ONNX file (~2 MB) is fetched once from Hugging Face
(istupakov/silero-vad-onnx, the same source onnx-asr uses) into Whisper Free's
own model folder (model_store.py) and loaded from disk ever after. Any failure
raises, and engine.py falls back to the dependency-free energy VAD in vad.py.

I/O contract (verified against silero-vad utils_vad.py):
    input  [1, context(64) + 512] float32 @16 kHz
    state  [2, 1, 128] float32 (carried between frames)
    sr     int64 (=16000)
    output [1, 1] speech probability
"""

from __future__ import annotations

import math
import numpy as np


FRAME_SAMPLES = 512  # 32 ms @ 16 kHz - Silero's preferred chunk size
CONTEXT_SAMPLES = 64
STATE_SHAPE = (2, 1, 128)

_HF_REPO = "istupakov/silero-vad-onnx"
_HF_FILE = "silero_vad.onnx"


def _download_model() -> str:
    import model_store

    folder = model_store.ensure(_HF_REPO, [_HF_FILE], [_HF_FILE])
    return str(folder / _HF_FILE)


class StreamingSileroVAD:
    """Drop-in replacement for EnergyVAD: same update()/reset()/configure() API."""

    def __init__(self, sample_rate: int = 16000, threshold: float = 0.012,
                 silence_ms: int = 1000):
        import onnxruntime as ort

        self.sample_rate = sample_rate
        self.base_threshold = threshold
        self.silence_ms = silence_ms
        # Hysteresis around the speech probability (research-verified recipe):
        # speech starts at `start_prob`, ends only below `start_prob - 0.15`.
        self.start_prob = 0.5
        self.end_prob = 0.35
        self.prob = 0.0

        self._model_path = _download_model()
        self._session = ort.InferenceSession(
            self._model_path, providers=["CPUExecutionProvider"]
        )
        self.reset()

    def reset(self) -> None:
        self._state = np.zeros(STATE_SHAPE, dtype=np.float32)
        self._context = np.zeros((1, CONTEXT_SAMPLES), dtype=np.float32)
        self._remainder = np.zeros(0, dtype=np.float32)
        self._elapsed_ms = 0.0
        self._last_voice_ms = -1.0
        self._has_voiced = False
        self._in_speech = False

    def configure(self, threshold: float, silence_ms: int) -> None:
        self.base_threshold = threshold
        self.silence_ms = silence_ms
        # Map the UI "VAD sensitivity" (energy range ~0.001..0.2, default 0.012)
        # onto Silero's 0..1 probability: default -> 0.5, more sensitive -> lower.
        self.start_prob = float(np.clip(0.5 + (threshold - 0.012) * 2.0, 0.35, 0.8))
        self.end_prob = max(0.2, self.start_prob - 0.15)

    def _prob_for_frame(self, frame: np.ndarray) -> float:
        x = np.concatenate([self._context, frame[np.newaxis, :]], axis=1)
        output, new_state = self._session.run(
            None,
            {"input": x, "state": self._state, "sr": np.array(16000, dtype=np.int64)},
        )
        self._context = x[:, -CONTEXT_SAMPLES:]
        self._state = new_state
        return float(np.asarray(output).reshape(-1)[0])

    @staticmethod
    def _rms(samples: np.ndarray) -> float:
        if samples.size == 0:
            return 0.0
        return float(math.sqrt(float((samples.astype("float64") ** 2).mean())))

    def update(self, samples: np.ndarray) -> dict:
        """Feed a frame (float32). Returns {voiced, rms, endpoint, prob}.

        `endpoint` is True exactly once when trailing silence after speech
        exceeds silence_ms (the signal to finalize an utterance on auto-stop).
        """
        if samples.size:
            self._elapsed_ms += 1000.0 * samples.size / self.sample_rate
            self._remainder = np.concatenate([self._remainder, samples.astype(np.float32)])

        rms = self._rms(samples)
        # Process as many whole 512-sample frames as the buffer holds. With the
        # app's ~20 ms frames this runs roughly every other call.
        while self._remainder.size >= FRAME_SAMPLES:
            self.prob = self._prob_for_frame(self._remainder[:FRAME_SAMPLES])
            self._remainder = self._remainder[FRAME_SAMPLES:]

        voiced = self.prob >= (self.end_prob if self._in_speech else self.start_prob)
        if voiced:
            self._in_speech = True
            self._last_voice_ms = self._elapsed_ms
            self._has_voiced = True
        elif self._in_speech and self.prob < self.end_prob - 0.05:
            self._in_speech = False

        endpoint = False
        if self._has_voiced and self._last_voice_ms >= 0:
            if (self._elapsed_ms - self._last_voice_ms) >= self.silence_ms:
                endpoint = True
                # Arm for the next utterance.
                self._has_voiced = False
                self._last_voice_ms = -1.0
                self._in_speech = False

        return {"voiced": voiced, "rms": rms, "endpoint": endpoint, "prob": self.prob}

    # Extra signal engine.py uses to gate partial inference: milliseconds since
    # speech was last detected (np.inf before any speech).
    def ms_since_voice(self) -> float:
        if self._last_voice_ms < 0:
            return float("inf")
        return self._elapsed_ms - self._last_voice_ms
