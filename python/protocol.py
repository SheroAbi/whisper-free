"""Length-prefixed binary protocol between the Electron main process and this
sidecar.

Node -> Python (stdin or TCP socket, binary frames):
    [4 bytes big-endian length N][1 byte type][N-1 bytes payload]
        type 0x01 = PCM int16 little-endian audio @ 16 kHz mono
        type 0x02 = UTF-8 JSON control message

Python -> Node (newline-delimited JSON on stdout or the socket):
    one compact JSON object per line, always flushed.

In --serve mode the output stream is switched to the connected client socket
(protocol.set_output); before any client connects events are discarded via a
null writer.
"""

from __future__ import annotations

import json
import struct
import sys
import threading
from typing import Iterator, Tuple

MSG_AUDIO = 0x01
MSG_CONTROL = 0x02

_stdout_lock = threading.Lock()
_stdout = sys.stdout


class NullWriter:
    """Discards events (serve mode, no client connected yet)."""

    def write(self, _s: str) -> None:
        pass

    def flush(self) -> None:
        pass


def set_output(stream) -> None:
    """Route all future events to `stream` (needs .write(str)/.flush())."""
    global _stdout
    with _stdout_lock:
        _stdout = stream


def _read_exact(stream, n: int) -> bytes | None:
    """Read exactly n bytes, or None on EOF."""
    chunks = []
    remaining = n
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_messages(stream) -> Iterator[Tuple[int, bytes]]:
    """Yield (type, payload) tuples until the stream closes (peer gone)."""
    header = struct.Struct(">I")
    while True:
        head = _read_exact(stream, 4)
        if head is None:
            return
        (length,) = header.unpack(head)
        if length <= 0:
            continue
        body = _read_exact(stream, length)
        if body is None:
            return
        yield body[0], body[1:]


def send(event: dict) -> None:
    """Write one JSON event line (thread-safe, flushed, single write)."""
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"
    with _stdout_lock:
        try:
            _stdout.write(line)
            _stdout.flush()
        except Exception:
            # Client vanished mid-write (socket closed between messages): the
            # serve loop will notice on its next read; never crash a worker.
            pass


def log(level: str, message: str) -> None:
    send({"type": "log", "level": level, "message": message})
