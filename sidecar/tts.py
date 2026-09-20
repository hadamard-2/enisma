"""TTS engine registry and the synthesis contract every engine implements.

The contract is deliberately narrow: an engine is handed text, a voice, a rate
and a path to write, and reports progress as it goes. Everything
language-specific — romanization, number expansion, chunking — lives inside the
engine, because it differs completely between Kokoro and MMS.

`on_progress` returning False asks the engine to stop early. Both engines can
honour that between units of work: sherpa-onnx takes a callback whose return
value it reads as "keep going", so returning **zero halts** generation and
non-zero continues it, and the Kokoro path checks between chunks.

Beware: sherpa-onnx's own pybind docstring states the opposite (that a non-zero
return stops generation). It is stale relative to its own C++ at the pinned tag
v1.13.8, which does `should_continue = callback(...)` and loops while that is
truthy. The code here matches the implementation, not the docstring -- do not
"correct" it, or every page truncates after its first batch.
"""

from __future__ import annotations

import struct
import time
import wave
from typing import Callable, Protocol

OnProgress = Callable[[float], bool]


class Engine(Protocol):
    def synthesize(
        self,
        text: str,
        voice: str,
        rate: float,
        out_path: str,
        on_progress: OnProgress,
    ) -> tuple[int, int]:
        """Write a WAV to out_path. Returns (sample_rate, duration_ms)."""
        ...


def write_wav(path: str, samples, sample_rate: int) -> int:
    """Write float samples as 16-bit PCM. Returns duration in milliseconds."""
    frames = bytearray()
    for s in samples:
        clamped = max(-1.0, min(1.0, float(s)))
        frames += struct.pack("<h", int(clamped * 32767))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(bytes(frames))
    return int(len(samples) / sample_rate * 1000)


class FakeEngine:
    """Silent audio at a believable length, for wiring the transport up.

    Exists so the webview -> Rust -> sidecar path can be built and tested before
    either real engine is in place. Not registered in production.
    """

    SAMPLE_RATE = 16000

    def __init__(self, step_seconds: float = 0.0) -> None:
        self._step_seconds = step_seconds

    def synthesize(self, text, voice, rate, out_path, on_progress):
        steps = 4
        samples = []
        per_step = int(self.SAMPLE_RATE * 0.25)
        for i in range(steps):
            if self._step_seconds:
                time.sleep(self._step_seconds)
            samples.extend([0.0] * per_step)
            if not on_progress((i + 1) / steps):
                break
        duration_ms = write_wav(out_path, samples, self.SAMPLE_RATE)
        return self.SAMPLE_RATE, duration_ms
