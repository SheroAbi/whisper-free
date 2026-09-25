"""Pause-aware segmentation of one dictation into model-sized pieces.

Speech models are trained on utterances of a few seconds up to ~20-30 s.
Feeding them one long recording in a single pass makes the text drift (wrong
words, switching to English, garbage) the longer it gets, and around 7 min the
ONNX Parakeet encoder fails outright. So a recording is never decoded in one
piece: it is cut at natural speech pauses into segments of SEG_MIN_S..SEG_MAX_S,
every segment is decoded on its own with full quality, and the texts are joined.

Cuts always land in the middle of the longest pause available in the allowed
window, so no word is ever split. Only when someone talks for SEG_MAX_S without
any pause does the cut fall back to the quietest moment (lowest energy).
"""

from __future__ import annotations

import numpy as np

SAMPLE_RATE = 16000

SEG_MIN_S = 8.0       # never cut shorter: the model needs context (language!)
SEG_TARGET_S = 14.0   # from here on, the next real pause closes the segment
SEG_MAX_S = 24.0      # hard cap for a single decode
PAUSE_COMMIT_S = 0.45  # a pause this long counts as a sentence break

SEG_MIN = int(SEG_MIN_S * SAMPLE_RATE)
SEG_TARGET = int(SEG_TARGET_S * SAMPLE_RATE)
SEG_MAX = int(SEG_MAX_S * SAMPLE_RATE)
PAUSE_COMMIT = int(PAUSE_COMMIT_S * SAMPLE_RATE)


class AudioBuffer:
    """Growable float32 buffer (amortised O(1) append, copy-out slices)."""

    def __init__(self) -> None:
        self._data = np.zeros(SAMPLE_RATE * 30, dtype=np.float32)
        self._n = 0

    def __len__(self) -> int:
        return self._n

    def append(self, x: np.ndarray) -> None:
        need = self._n + x.size
        if need > self._data.size:
            grown = np.zeros(max(need, self._data.size * 2), dtype=np.float32)
            grown[: self._n] = self._data[: self._n]
            self._data = grown
        self._data[self._n:need] = x
        self._n = need

    def slice(self, a: int, b: int) -> np.ndarray:
        a = max(0, min(a, self._n))
        b = max(a, min(b, self._n))
        return self._data[a:b].copy()

    def clear(self) -> None:
        self._n = 0


class SpeechTrack:
    """Per-frame VAD decision + energy, aligned to buffer sample positions."""

    def __init__(self) -> None:
        self._end: list[int] = []      # sample index where each frame ends
        self._voiced: list[bool] = []
        self._rms: list[float] = []
        self._pause_start: int | None = None

    def clear(self) -> None:
        self._end.clear()
        self._voiced.clear()
        self._rms.clear()
        self._pause_start = None

    def add(self, end_sample: int, voiced: bool, rms: float) -> None:
        if voiced:
            self._pause_start = None
        elif self._pause_start is None:
            self._pause_start = self._end[-1] if self._end else 0
        self._end.append(end_sample)
        self._voiced.append(voiced)
        self._rms.append(rms)

    def _start_of(self, i: int) -> int:
        return self._end[i - 1] if i > 0 else 0

    def _range(self, lo: int, hi: int) -> tuple[int, int]:
        """Indices [i0, i1) of frames lying completely inside [lo, hi]."""
        import bisect

        i0 = bisect.bisect_left(self._end, lo)
        while i0 < len(self._end) and self._start_of(i0) < lo:
            i0 += 1
        i1 = bisect.bisect_right(self._end, hi)
        return i0, max(i0, i1)

    def has_speech(self, lo: int, hi: int) -> bool:
        i0, i1 = self._range(lo, hi)
        if i1 == i0:
            # Frames straddle the range (tiny range): look at any overlap.
            import bisect
            j = bisect.bisect_left(self._end, lo)
            return j < len(self._voiced) and self._voiced[j]
        return any(self._voiced[i0:i1])

    def trailing_pause_start(self) -> int | None:
        """Sample where the current (still running) pause began, else None."""
        return self._pause_start

    def best_cut(self, lo: int, hi: int) -> int:
        """Best place to split inside [lo, hi]: middle of the longest pause,
        else the quietest ~100 ms."""
        if hi <= lo:
            return hi
        i0, i1 = self._range(lo, hi)
        if i1 <= i0:
            return hi
        best_len, best_mid = 0, None
        run_start = None
        for i in range(i0, i1 + 1):
            silent = i < i1 and not self._voiced[i]
            if silent and run_start is None:
                run_start = i
            elif not silent and run_start is not None:
                a, b = self._start_of(run_start), self._end[i - 1]
                if b - a >= best_len:  # ties -> later pause (longer segment)
                    best_len, best_mid = b - a, (a + b) // 2
                run_start = None
        if best_mid is not None:
            return best_mid
        rms = np.asarray(self._rms[i0:i1], dtype=np.float64)
        if rms.size >= 5:
            rms = np.convolve(rms, np.ones(5) / 5.0, mode="same")
        k = i0 + int(np.argmin(rms))
        return (self._start_of(k) + self._end[k]) // 2


def plan_segments(track: SpeechTrack, start: int, end: int) -> list[tuple[int, int]]:
    """Split [start, end) into decode-sized segments at pauses."""
    segments: list[tuple[int, int]] = []
    pos = start
    while end - pos > SEG_MAX:
        cut = track.best_cut(pos + SEG_MIN, pos + SEG_MAX)
        if cut <= pos:
            cut = pos + SEG_MAX
        segments.append((pos, cut))
        pos = cut
    if end > pos:
        segments.append((pos, end))
    return segments


def join_texts(parts: list[str]) -> str:
    return " ".join(" ".join(p.split()) for p in parts if p and p.strip())
