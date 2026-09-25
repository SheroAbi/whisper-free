"""Lightweight, dependency-free voice activity detector.

Energy (RMS) based with an adaptive noise floor and a hangover window. Robust
enough for push-to-talk / toggle dictation and adds zero install weight. The
interface is intentionally small so a learned VAD (e.g. Silero ONNX) can be
swapped in later behind the same `update()` contract.
"""

from __future__ import annotations

import math


class EnergyVAD:
    def __init__(self, sample_rate: int = 16000, threshold: float = 0.012,
                 silence_ms: int = 1200):
        self.sample_rate = sample_rate
        self.base_threshold = threshold
        self.silence_ms = silence_ms
        self._noise_floor = threshold * 0.5
        self._elapsed_ms = 0.0
        self._last_voice_ms = -1.0
        self._has_voiced = False

    def reset(self) -> None:
        self._elapsed_ms = 0.0
        self._last_voice_ms = -1.0
        self._has_voiced = False
        self._noise_floor = self.base_threshold * 0.5

    def configure(self, threshold: float, silence_ms: int) -> None:
        self.base_threshold = threshold
        self.silence_ms = silence_ms

    @staticmethod
    def _rms(samples) -> float:
        if samples.size == 0:
            return 0.0
        # samples is float32 in [-1, 1]
        return float(math.sqrt(float((samples.astype("float64") ** 2).mean())))

    def update(self, samples) -> dict:
        """Feed a frame (float32). Returns {voiced, rms, endpoint}.

        `endpoint` is True exactly once when trailing silence after speech
        exceeds silence_ms (the signal to finalize an utterance on auto-stop).
        """
        frame_ms = 1000.0 * samples.size / self.sample_rate
        self._elapsed_ms += frame_ms
        rms = self._rms(samples)

        # Adaptive noise floor: track the quiet baseline slowly upward/downward.
        if rms < self._noise_floor:
            self._noise_floor = 0.95 * self._noise_floor + 0.05 * rms
        else:
            self._noise_floor = 0.995 * self._noise_floor + 0.005 * rms

        dynamic = max(self.base_threshold, self._noise_floor * 2.5)
        voiced = rms >= dynamic

        endpoint = False
        if voiced:
            self._last_voice_ms = self._elapsed_ms
            self._has_voiced = True
        elif self._has_voiced and self._last_voice_ms >= 0:
            if (self._elapsed_ms - self._last_voice_ms) >= self.silence_ms:
                endpoint = True
                # arm for the next utterance
                self._has_voiced = False
                self._last_voice_ms = -1.0

        return {"voiced": voiced, "rms": rms, "endpoint": endpoint}
