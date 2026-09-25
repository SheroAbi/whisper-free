"""Qwen3-ASR backend built on the `qwen-asr` package (transformers backend).

Mirrors the public surface of asr.ParakeetASR (load / warmup / transcribe +
the model_id / language / backend attributes) so engine.py can use either
backend interchangeably.

Device choice:
  * NVIDIA: cuda:0, float16 + SDPA attention (works back to Turing / RTX 20xx,
    which has no hardware bfloat16 and no FlashAttention-2)
  * Apple Silicon: mps, float16
  * otherwise CPU, float32 (works, but slow - Parakeet is the better CPU pick)

All heavy imports (torch, qwen_asr) are deferred into load() so that merely
importing this module on a Parakeet-only machine costs nothing and never fails.
"""

from __future__ import annotations

import os
import time
from typing import Optional

import numpy as np

import model_store
import protocol

# Hugging Face repo backing our internal model id.
HF_REPO = "Qwen/Qwen3-ASR-0.6B"


# Files that must exist in the store for the model to be loadable.
_REQUIRED = ["config.json", "*.safetensors"]


def _stub_unused_aligner_deps() -> list:
    """Skip ~2.8 s of import cost from a feature we never use.

    qwen_asr's package __init__ eagerly imports a forced-aligner that pulls in
    `nagisa` (a Japanese word segmenter) at import time. Whisper Free only
    ever calls ``Qwen3ASRModel.transcribe()`` — never the aligner — so we drop a
    lightweight `nagisa` stub into sys.modules before importing qwen_asr. The
    stub returns AttributeError for dunders (so library introspection stays
    happy) and raises only if its API is actually *called*, which never happens
    on the transcribe path. Returns the names we injected so the import site can
    roll them back if anything unexpected goes wrong.
    """
    import sys
    import types

    if "nagisa" in sys.modules:
        return []
    stub = types.ModuleType("nagisa")

    def _getattr(name: str):
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)

        def _guard(*_a, **_k):
            raise RuntimeError("nagisa is stubbed out; forced alignment is unused")

        return _guard

    stub.__getattr__ = _getattr  # type: ignore[attr-defined]
    sys.modules["nagisa"] = stub
    return ["nagisa"]


def _local_model_ready() -> bool:
    """True if the model is complete in Whisper Free's model folder.

    Pulls it in from the shared HF cache first if it happens to be there (no
    network). When it is ready we load fully offline and skip the per-file
    network checks `from_pretrained` otherwise makes (~2.5 s).
    """
    if model_store.has_files(HF_REPO, _REQUIRED) and model_store.is_marked_complete(HF_REPO):
        return True
    model_store.seed_from_hf_cache(HF_REPO)
    if model_store.has_files(HF_REPO, _REQUIRED):
        model_store.mark_complete(HF_REPO)
        return True
    return False

# App language code -> Qwen language name (Qwen wants the spoken name, or None
# for auto-detection across its 50+ supported languages).
_LANG_NAMES = {
    "de": "German",
    "en": "English",
    "fr": "French",
    "es": "Spanish",
    "it": "Italian",
    "nl": "Dutch",
    "pl": "Polish",
    "pt": "Portuguese",
    "ru": "Russian",
}


class QwenASR:
    def __init__(self, model_id: str, quantization: str = "fp16",
                 language: str = "auto"):
        self.model_id = model_id
        self.quantization = quantization  # accepted for interface parity; Qwen runs fp16
        self.language = language
        self.model = None
        self.backend = "unknown"
        self.model_load_ms: Optional[float] = None

        # IMPORTANT (Windows): importing torch inside the engine's loader *thread*
        # deadlocks while the main thread is blocked in sys.stdin.read(). __init__
        # runs on the main thread (before the stdin loop starts), so we pull the
        # heavy imports in here. They only happen when a Qwen model is actually
        # selected, so Parakeet-only setups never load torch.
        os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
        os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
        os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
        # If the model is already on disk, force offline so the import + load skip
        # all network round-trips (saves ~2.5 s). huggingface_hub latches these
        # env vars at import time, so this must run before importing qwen_asr.
        self._offline = _local_model_ready()
        if self._offline:
            os.environ.setdefault("HF_HUB_OFFLINE", "1")
            os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

        injected = _stub_unused_aligner_deps()
        try:
            import torch
            from qwen_asr import Qwen3ASRModel
        except Exception:  # noqa: BLE001
            # The fast-import stub upset something: roll it back (plus any
            # half-imported qwen_asr submodules) and import for real so
            # correctness never depends on the optimisation.
            import sys
            for name in injected:
                sys.modules.pop(name, None)
            for name in [m for m in list(sys.modules)
                         if m == "qwen_asr" or m.startswith("qwen_asr.")]:
                sys.modules.pop(name, None)
            import torch
            from qwen_asr import Qwen3ASRModel
        self._torch = torch
        self._Qwen3ASRModel = Qwen3ASRModel

    # -- loading ------------------------------------------------------------

    def load(self) -> None:
        torch = self._torch
        Qwen3ASRModel = self._Qwen3ASRModel

        use_cuda = torch.cuda.is_available()
        mps = getattr(torch.backends, "mps", None)
        use_mps = not use_cuda and mps is not None and mps.is_available()  # Apple Silicon
        dtype = torch.float16 if (use_cuda or use_mps) else torch.float32
        device_map = "cuda:0" if use_cuda else ("mps" if use_mps else "cpu")
        dev_label = (torch.cuda.get_device_name(0) if use_cuda
                     else ("Apple GPU (MPS)" if use_mps else "CPU"))

        protocol.send({"type": "state", "state": "loading-model",
                       "detail": f"Qwen3-ASR 0.6B ({'fp16 GPU' if (use_cuda or use_mps) else 'cpu'})"})
        # Only the very first use fetches ~1.9 GB from Hugging Face, straight into
        # the model folder; every later start loads from disk (offline).
        def announce() -> None:
            protocol.send({"type": "state", "state": "downloading-model",
                           "detail": "Qwen3-ASR 0.6B (one-time download)"})

        local_path = str(model_store.ensure(HF_REPO, _REQUIRED, on_download=announce))

        t0 = time.perf_counter()
        model = None
        chosen_attn = "sdpa"
        for attn in ("sdpa", "eager"):
            try:
                model = Qwen3ASRModel.from_pretrained(
                    local_path,
                    dtype=dtype,
                    device_map=device_map,
                    attn_implementation=attn,
                    max_inference_batch_size=1,
                    max_new_tokens=256,
                )
                chosen_attn = attn
                break
            except Exception as exc:  # noqa: BLE001
                protocol.log("warn", f"Qwen load with attn={attn} failed: {exc}")
        if model is None:
            raise RuntimeError("could not load Qwen3-ASR-0.6B")

        self.model = model
        self.model_load_ms = (time.perf_counter() - t0) * 1000.0
        self.backend = (f"{device_map} fp16 {chosen_attn}" if (use_cuda or use_mps)
                        else f"cpu fp32 {chosen_attn}")

        protocol.send({"type": "metrics",
                       "modelLoadMs": round(self.model_load_ms, 1),
                       "backend": self.backend})
        protocol.log("info", f"Qwen3-ASR ready on {dev_label} "
                             f"({self.backend}, load {self.model_load_ms/1000:.1f}s"
                             f"{', offline cache' if getattr(self, '_offline', False) else ''})")

    def warmup(self) -> None:
        if self.model is None:
            return
        try:
            self.transcribe(np.zeros(int(0.5 * 16000), dtype=np.float32))
        except Exception as exc:  # noqa: BLE001
            protocol.log("warn", f"Qwen warmup failed (non-fatal): {exc}")

    # -- inference ----------------------------------------------------------

    def _lang_name(self) -> Optional[str]:
        if not self.language or self.language == "auto":
            return None
        return _LANG_NAMES.get(self.language)

    def transcribe(self, audio_f32: np.ndarray) -> tuple[str, float]:
        assert self.model is not None
        t0 = time.perf_counter()
        results = self.model.transcribe(
            audio=(np.ascontiguousarray(audio_f32, dtype=np.float32), 16000),
            language=self._lang_name(),
        )
        elapsed = (time.perf_counter() - t0) * 1000.0
        text = ""
        if results:
            text = getattr(results[0], "text", "") or ""
        return text.strip(), elapsed
