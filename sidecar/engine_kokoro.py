"""Kokoro English TTS on onnxruntime, with espeak-ng for grapheme-to-phoneme.

Uses only what the onnx-community repo ships: model.onnx, voices/*.bin and
tokenizer.json. misaki is deliberately not used — it would pull spacy and torch
for an unmeasured quality difference.

Only the fp32 model.onnx is loaded. The quantized model_q8f16.onnx segfaults
onnxruntime 1.30.0, the version resolved here, and int8 is 6.2x slower than
fp32 on CPU — there is no variant worth reaching for.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

import numpy as np
from onnxruntime import InferenceSession

from guards import assert_espeak_data_path
from prepare import chunk_english
from tts import write_wav

SAMPLE_RATE = 24000


def list_voices(model_dir: str) -> list[str]:
    voices = Path(model_dir) / "voices"
    if not voices.is_dir():
        return []
    return sorted(p.stem for p in voices.glob("*.bin"))


def _make_phonemizer() -> Callable[[str], str]:
    import espeakng_loader
    from phonemizer.backend import EspeakBackend
    from phonemizer.backend.espeak.wrapper import EspeakWrapper

    data_path = espeakng_loader.get_data_path()
    # Past 159 characters espeak-ng ignores this path and kills the process
    # with no Python exception. Fail here, where the message is readable —
    # and before EspeakBackend can initialize the library with it.
    assert_espeak_data_path(data_path)

    EspeakWrapper.set_library(espeakng_loader.get_library_path())
    EspeakWrapper.set_data_path(data_path)
    backend = EspeakBackend("en-us", preserve_punctuation=True, with_stress=True)
    return lambda text: backend.phonemize([text])[0].strip()


class KokoroEngine:
    def __init__(self, model_dir: str) -> None:
        self._dir = Path(model_dir)
        model = self._dir / "model.onnx"
        if not model.exists():
            raise FileNotFoundError(f"Kokoro model not found at {model}")
        self._vocab = json.loads((self._dir / "tokenizer.json").read_text())["model"]["vocab"]
        self._session = InferenceSession(str(model))
        self._phonemize = _make_phonemizer()

    def synthesize(self, text, voice, rate, out_path, on_progress):
        style_path = self._dir / "voices" / f"{voice}.bin"
        if not style_path.exists():
            raise FileNotFoundError(f"unknown Kokoro voice {voice!r}")
        # Indexed by token count: 510 rows of (1, 256).
        styles = np.fromfile(style_path, dtype=np.float32).reshape(-1, 1, 256)

        chunks = chunk_english(text, self._vocab, self._phonemize)
        if not chunks:
            raise RuntimeError("nothing left to speak after preparing the text")

        pieces = []
        for i, tokens in enumerate(chunks):
            out = self._session.run(
                None,
                {
                    "input_ids": np.array([[0, *tokens, 0]], dtype=np.int64),
                    "style": styles[len(tokens)],
                    "speed": np.array([rate], dtype=np.float32),
                },
            )[0]
            pieces.append(np.asarray(out, dtype=np.float32).squeeze())
            # The Python contract: False means stop. Checked between chunks,
            # which is the only seam this engine has — a chunk is one atomic
            # onnxruntime call.
            if not on_progress((i + 1) / len(chunks)):
                break

        samples = np.concatenate(pieces)
        duration_ms = write_wav(out_path, samples, SAMPLE_RATE)
        return SAMPLE_RATE, duration_ms
