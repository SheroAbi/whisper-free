"""Persistent, app-owned model store.

Every model Whisper Free uses (Parakeet ONNX, Qwen3-ASR, Silero VAD) lives as
plain files in ONE fixed folder that belongs to the app:

    Windows  %LOCALAPPDATA%\\WhisperFree\\models
    macOS    ~/Library/Application Support/WhisperFree/models
    Linux    $XDG_DATA_HOME/whisper-free/models  (~/.local/share/...)
    override WHISPER_FREE_MODELS_DIR=<dir>

Rules:
  * If the files are there, they are loaded straight from disk - no Hugging
    Face calls, no network, not even a HEAD request.
  * If a model is missing but already sits in the shared Hugging Face cache
    (~/.cache/huggingface), it is hard-linked (same drive: instant, no extra
    space) or copied into the store - no download.
  * Only a truly missing file is downloaded, exactly once, directly into the
    store. A marker file records a completed download so a half-finished one
    is resumed instead of being trusted.

This replaces the old "let the libraries use the HF cache" approach, which
re-downloaded whenever that cache was cleaned (disk cleanup tools love it) and
did network round-trips on every start.
"""

from __future__ import annotations

import fnmatch
import glob
import os
import shutil
import sys
from pathlib import Path
from typing import Callable, Iterable

_COMPLETE_MARKER = ".whisperfree-complete"


def models_dir() -> Path:
    override = os.environ.get("WHISPER_FREE_MODELS_DIR")
    if override:
        root = Path(override).expanduser()
    elif sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(Path.home(), "AppData", "Local")
        root = Path(base) / "WhisperFree" / "models"
    elif sys.platform == "darwin":
        root = Path.home() / "Library" / "Application Support" / "WhisperFree" / "models"
    else:
        base = os.environ.get("XDG_DATA_HOME") or os.path.join(Path.home(), ".local", "share")
        root = Path(base) / "whisper-free" / "models"
    root.mkdir(parents=True, exist_ok=True)
    # Canonical path: ONNX Runtime rejects external weight files (".onnx.data")
    # whose resolved path differs from the model folder it was given - which
    # happens under Windows app-container folder redirection and with symlinked
    # home folders on macOS/Linux.
    return root.resolve()


def repo_dir(repo_id: str) -> Path:
    """Folder for one Hugging Face repo inside the store (not created)."""
    return models_dir() / repo_id.replace("/", "--")


def _hf_cache_root() -> Path:
    if os.environ.get("HF_HUB_CACHE"):
        return Path(os.environ["HF_HUB_CACHE"])
    if os.environ.get("HF_HOME"):
        return Path(os.environ["HF_HOME"]) / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


def _matches(name: str, patterns: Iterable[str] | None) -> bool:
    if patterns is None:
        return True
    return any(fnmatch.fnmatch(name, p) for p in patterns)


def _link_or_copy(src: Path, dst: Path) -> None:
    src = src.resolve()  # HF snapshots are symlinks into blobs/
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".partial")
    if tmp.exists():
        tmp.unlink()
    try:
        os.link(src, tmp)  # same volume: instant and no extra disk space
    except OSError:
        shutil.copyfile(src, tmp)
    os.replace(tmp, dst)


def seed_from_hf_cache(repo_id: str, patterns: Iterable[str] | None = None) -> int:
    """Pull files for `repo_id` out of the shared HF cache into the store.

    Returns the number of files added. Never touches the network.
    """
    patterns = list(patterns) if patterns is not None else None
    folder = "models--" + repo_id.replace("/", "--")
    target = repo_dir(repo_id)
    added = 0
    for snap in sorted(glob.glob(str(_hf_cache_root() / folder / "snapshots" / "*"))):
        snap_path = Path(snap)
        for src in snap_path.rglob("*"):
            if not src.is_file():
                continue
            rel = src.relative_to(snap_path)
            if not _matches(rel.as_posix(), patterns):
                continue
            dst = target / rel
            if dst.exists():
                continue
            try:
                _link_or_copy(src, dst)
                added += 1
            except OSError:
                pass
    return added


def download(repo_id: str, patterns: Iterable[str] | None = None) -> Path:
    """Download (or resume) `repo_id` straight into the store. Network!"""
    from huggingface_hub import snapshot_download

    target = repo_dir(repo_id)
    target.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id,
        local_dir=str(target),
        allow_patterns=list(patterns) if patterns is not None else None,
    )
    return target


def mark_complete(repo_id: str, tag: str = "all") -> None:
    marker = repo_dir(repo_id) / _COMPLETE_MARKER
    tags = set(marker.read_text("utf-8").split()) if marker.exists() else set()
    tags.add(tag)
    marker.write_text("\n".join(sorted(tags)), "utf-8")


def is_marked_complete(repo_id: str, tag: str = "all") -> bool:
    marker = repo_dir(repo_id) / _COMPLETE_MARKER
    try:
        return tag in marker.read_text("utf-8").split()
    except OSError:
        return False


def has_files(repo_id: str, patterns: Iterable[str]) -> bool:
    """True when every glob pattern matches at least one file in the store."""
    target = repo_dir(repo_id)
    if not target.is_dir():
        return False
    return all(any(p.is_file() for p in target.glob(pattern)) for pattern in patterns)


def ensure(repo_id: str, required: list[str], patterns: list[str] | None = None,
           tag: str = "all", on_download: Callable[[], None] | None = None) -> Path:
    """Make `repo_id` available in the store and return its folder.

    `required` are glob patterns that must each match a file for the model to
    be usable; `patterns` limits what gets seeded/downloaded (None = whole
    repo); `tag` names this file set in the completion marker (e.g. one per
    quantization). `on_download` fires right before a real network download.
    Order: local store -> shared HF cache -> download.
    """
    if has_files(repo_id, required) and is_marked_complete(repo_id, tag):
        return repo_dir(repo_id)

    seed_from_hf_cache(repo_id, patterns)
    if has_files(repo_id, required) and not _needs_download_check(repo_id):
        mark_complete(repo_id, tag)
        return repo_dir(repo_id)

    if on_download is not None:
        on_download()
    try:
        download(repo_id, patterns)
    except Exception:
        # Offline but the files look usable: try them rather than failing.
        if has_files(repo_id, required):
            return repo_dir(repo_id)
        raise
    if not has_files(repo_id, required):
        raise FileNotFoundError(f"{repo_id}: download finished but model files are missing")
    mark_complete(repo_id, tag)
    return repo_dir(repo_id)


def _needs_download_check(repo_id: str) -> bool:
    """A leftover partial download inside the store means files may be torn."""
    meta = repo_dir(repo_id) / ".cache" / "huggingface" / "download"
    return meta.is_dir() and any(meta.rglob("*.incomplete"))
