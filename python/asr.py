"""Parakeet TDT 0.6B v3 wrapper built on onnx-asr.

onnx-asr loads the ONNX export of NVIDIA Parakeet (including the TDT decoder)
and runs it on ONNX Runtime. The model is fetched from Hugging Face ONCE and
then lives in Whisper Free's own model folder (model_store.py); every later
start loads it straight from disk without touching the network.

Execution provider negotiation (in priority order):
  1. PARAKEET_PROVIDERS env override (set by EngineManager on NVIDIA machines)
  2. CUDA  (onnxruntime-gpu)  - RTF ~0.01 on an RTX 2080 Ti
  3. DirectML / WinML      - any DX12 GPU, no CUDA needed
  4. plain CPU             - always works (int8 helps here)
If the accelerated provider fails to actually run (e.g. DLL mismatch), loading
transparently retries on the default CPU path so the app never hard-fails.
"""

from __future__ import annotations

import os
import time
from typing import Optional

import numpy as np

import model_store
import protocol


def _accelerated_providers() -> Optional[list]:
    """Providers this onnxruntime build claims to support, best first."""
    try:
        import onnxruntime as ort
        avail = ort.get_available_providers()
    except Exception:
        return None
    ordered = []
    for name in ("CUDAExecutionProvider", "DmlExecutionProvider"):
        if name in avail:
            ordered.append(name)
    # TensorRT is deliberately excluded: it needs TensorRT libs installed and
    # its failed-load retries cost seconds at startup. Use PARAKEET_PROVIDERS
    # to force it explicitly if you want it.
    if not ordered:
        return None
    ordered.append("CPUExecutionProvider")
    return ordered


def _preload_cuda_dlls() -> None:
    """Make CUDA/cuDNN DLLs loadable before the first InferenceSession.

    ORT >= 1.21 ships `preload_dlls()` which locates the pip-installed CUDA
    runtime wheels (onnxruntime-gpu[cuda,cudnn]) and can reuse a torch install.
    Must run before any session is created; harmless no-op elsewhere.
    """
    try:
        import onnxruntime as ort
        preload = getattr(ort, "preload_dlls", None)
        if callable(preload):
            preload(cuda=True, cudnn=True, msvc=True)
            return
    except Exception:
        pass
    # Belt-and-braces: a torch cu12x install bundles the runtime DLLs too.
    try:
        import torch
        lib = os.path.join(os.path.dirname(torch.__file__), "lib")
        if os.path.isdir(lib):
            os.add_dll_directory(lib)
    except Exception:
        pass


# CUDA provider tuning:
#   HEURISTIC conv search   - avoids EXHAUSTIVE's per-new-shape latency spikes
#                             (the 300-400 ms hiccups mid-dictation)
#   kSameAsRequested arena  - less VRAM churn between decode bursts
#   bounded conv workspace  - keeps Turing's 11 GB comfortable with 2+ sessions
_CUDA_PROVIDER_OPTIONS = {
    "cudnn_conv_algo_search": "HEURISTIC",
    "cudnn_conv_use_max_workspace": 1,
    "arena_extend_strategy": "kSameAsRequested",
    "device_id": 0,
}


def _with_provider_options(providers):
    """Attach tuning options to bare CUDA provider names (env or auto)."""
    if not providers:
        return providers
    return [
        (p, dict(_CUDA_PROVIDER_OPTIONS)) if p == "CUDAExecutionProvider" else p
        for p in providers
    ]


def _onnx_asr_files(name: str, quant: Optional[str]) -> tuple[str, list[str], list[str]]:
    """(repo_id, required globs, download globs) for an onnx-asr model name.

    Mirrors onnx-asr's own resolver so the store holds exactly the files that
    `onnx_asr.load_model(name, path, quantization=...)` looks for.
    """
    from onnx_asr.loader import create_asr_resolver

    resolver = create_asr_resolver(name)  # name -> repo + model type, no I/O
    if not resolver.repo_id:
        raise RuntimeError(f"no download source known for {name}")
    required = list(resolver.model_type._get_model_files(quant).values())
    patterns = ["config.json", "config.yaml", *required,
                *(f[:-5] + ".onnx?data" for f in required if f.endswith(".onnx"))]
    return resolver.repo_id, required, patterns


class ParakeetASR:
    def __init__(self, model_id: str, quantization: str = "int8",
                 language: str = "auto"):
        self.model_id = model_id
        self.quantization = quantization
        self.language = language
        self.model = None
        self.backend = "unknown"
        self.model_load_ms: Optional[float] = None
        self._supports_language = True

    # -- loading ------------------------------------------------------------

    def _providers(self):
        env = os.environ.get("PARAKEET_PROVIDERS")
        if env:
            return _with_provider_options(
                [p.strip() for p in env.split(",") if p.strip()]
            )
        return _with_provider_options(_accelerated_providers())

    def load(self) -> None:
        _preload_cuda_dlls()
        import onnx_asr  # imported lazily so import errors surface as events

        t0 = time.perf_counter()
        providers = self._providers()
        quant = None if self.quantization == "fp32" else self.quantization

        protocol.send({"type": "state", "state": "loading-model",
                       "detail": f"{self.model_id} ({self.quantization})"})

        model = self._load_with_fallback(onnx_asr, quant, providers)
        self.model = model
        self.model_load_ms = (time.perf_counter() - t0) * 1000.0

        try:
            self.backend = self._detect_backend(model)
        except Exception:
            self.backend = "onnxruntime"

        protocol.send({
            "type": "metrics",
            "modelLoadMs": round(self.model_load_ms, 1),
            "backend": self.backend,
        })

    @staticmethod
    def _detect_backend(model) -> str:
        """Collect the ORT providers actually backing the loaded model.

        onnx-asr stores its InferenceSessions in different attributes per model
        family (encoder/decoder/joint...), so scan shallowly and dedupe.
        """
        import onnxruntime as _ort

        found: list[str] = []

        def scan(obj, depth: int = 0) -> None:
            if depth > 3 or len(found) > 8:
                return
            if isinstance(obj, _ort.InferenceSession):
                for p in obj.get_providers():
                    if p not in found:
                        found.append(p)
                return
            if isinstance(obj, dict):
                for v in obj.values():
                    scan(v, depth + 1)
            elif isinstance(obj, (list, tuple)):
                for v in obj:
                    scan(v, depth + 1)
            elif hasattr(obj, "__dict__"):
                for v in vars(obj).values():
                    scan(v, depth + 1)

        scan(model)
        if not found:
            return "onnxruntime"
        short = {"CUDAExecutionProvider": "cuda", "DmlExecutionProvider": "directml",
                 "CPUExecutionProvider": "cpu", "TensorrtExecutionProvider": "tensorrt"}
        return ",".join(short.get(p, p.replace("ExecutionProvider", "").lower())
                        for p in found)

    def _ensure_local(self, name: str, quant: Optional[str]):
        """Folder with the model files for (name, quant); downloads only once."""
        repo, required, patterns = _onnx_asr_files(name, quant)

        def announce() -> None:
            protocol.send({"type": "state", "state": "downloading-model",
                           "detail": f"{name} (one-time download)"})

        return model_store.ensure(repo, required, patterns,
                                  tag=quant or "fp32", on_download=announce)

    def _load_with_fallback(self, onnx_asr, quant, providers):
        """Try v3, then v2; requested quantization, then fp32; GPU, then CPU."""
        attempts = [self.model_id]
        if "v3" in self.model_id:
            attempts.append(self.model_id.replace("v3", "v2"))

        provider_sets = [providers] if providers else []
        provider_sets.append(None)  # ORT default (CPU-only build or last resort)

        quant_sets = [quant, None] if quant else [None]

        last_err: Optional[Exception] = None
        have_files = False
        for name in attempts:
            # The fallback model is only for when the requested one cannot be
            # obtained at all - never download a different model just because
            # the one on disk failed to load (that error must surface).
            if have_files:
                break
            for q in quant_sets:
                try:
                    path = self._ensure_local(name, q)
                except Exception as exc:  # noqa: BLE001
                    last_err = exc
                    protocol.log("warn", f"model files unavailable for {name} "
                                         f"(quant={q or 'none'}): {exc}")
                    continue
                have_files = True
                for prov in provider_sets:
                    label = f"{name} (providers={prov}, quant={q or 'none'})"
                    try:
                        kwargs = {}
                        if q is not None:
                            kwargs["quantization"] = q
                        if prov is not None:
                            kwargs["providers"] = prov
                        model = onnx_asr.load_model(name, path, **kwargs)
                    except Exception as exc:  # noqa: BLE001
                        last_err = exc
                        protocol.log("warn", f"load failed for {label}: {exc}")
                        continue
                    if name != self.model_id:
                        protocol.log("warn",
                                     f"falling back to {name} ({self.model_id} unavailable)")
                        self.model_id = name
                    if prov is None and providers:
                        protocol.log("warn",
                                     "accelerated provider unusable - running on CPU")
                    protocol.log("info", f"model loaded from {path}")
                    return model
        raise RuntimeError(f"could not load any Parakeet model: {last_err}")

    def warmup(self, shapes: tuple[float, ...] = (1.0, 7.0)) -> None:
        if self.model is None:
            return
        # Absorb first-call costs (cuDNN kernel selection, memory-arena growth,
        # mel-preprocessor init). The short shape runs before "ready" so the
        # first dictation is instant; longer shapes can warm up post-ready.
        for seconds in shapes:
            silence = np.zeros(int(seconds * 16000), dtype=np.float32)
            try:
                self._recognize(silence)
            except Exception as exc:  # noqa: BLE001
                protocol.log("warn", f"warmup failed (non-fatal): {exc}")
                return

    # -- inference ----------------------------------------------------------

    def _recognize(self, audio_f32: np.ndarray) -> str:
        assert self.model is not None
        lang = self.language if self.language and self.language != "auto" else None

        result = None
        if lang and self._supports_language:
            try:
                result = self.model.recognize(audio_f32, language=lang)
            except TypeError:
                self._supports_language = False
        if result is None:
            result = self.model.recognize(audio_f32)

        return self._coerce_text(result)

    @staticmethod
    def _coerce_text(result) -> str:
        if result is None:
            return ""
        if isinstance(result, str):
            return result
        if isinstance(result, (list, tuple)):
            return " ".join(ParakeetASR._coerce_text(r) for r in result).strip()
        text = getattr(result, "text", None)
        return text if isinstance(text, str) else str(result)

    def transcribe(self, audio_f32: np.ndarray) -> tuple[str, float]:
        t0 = time.perf_counter()
        text = self._recognize(audio_f32)
        elapsed = (time.perf_counter() - t0) * 1000.0
        return text.strip(), elapsed
