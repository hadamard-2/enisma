"""MMS VITS via sherpa-onnx, for Amharic, Tigrigna and Afaan Oromo.

Single-speaker models at 16 kHz; the `voice` argument is accepted for contract
compatibility and ignored.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from prepare import prepare_geez
from tts import write_wav

log = logging.getLogger("engine.mms")


class MmsEngine:
    def __init__(self, model_dir: str, language: str) -> None:
        model = Path(model_dir) / "model.onnx"
        tokens = Path(model_dir) / "tokens.txt"
        if not model.exists() or not tokens.exists():
            raise FileNotFoundError(
                f"MMS model for {language} not found in {model_dir} "
                "(expected model.onnx and tokens.txt)"
            )
        # Imported here, not at module scope: both pull in native libraries and
        # multi-second table builds, and the module is imported by server.py and
        # by tests that never construct an engine.
        import sherpa_onnx
        import uroman as _uroman

        self._language = language
        self._tts = sherpa_onnx.OfflineTts(
            sherpa_onnx.OfflineTtsConfig(
                model=sherpa_onnx.OfflineTtsModelConfig(
                    vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                        model=str(model), tokens=str(tokens)
                    ),
                    num_threads=2,
                    provider="cpu",
                )
            )
        )
        # Building uroman's tables takes ~2s; do it once, not per request.
        self._uroman = _uroman.Uroman()
        self._romanize = lambda text, lcode: str(
            self._uroman.romanize_string(text, lcode=lcode)
        )

    def synthesize(self, text, voice, rate, out_path, on_progress):
        prepared = prepare_geez(text, self._language, self._romanize)
        if not prepared:
            raise RuntimeError("nothing left to speak after preparing the text")

        # sherpa-onnx calls back once per utterance, and it decides utterances
        # from the sentence punctuation we deliberately kept. Stripping that
        # punctuation would collapse the page into one atomic call: no
        # progress, and cancellation ignored.
        def callback(samples, progress) -> int:
            return 1 if on_progress(float(progress)) else 0

        result = self._tts.generate(prepared, sid=0, speed=rate, callback=callback)
        samples = np.asarray(result.samples, dtype=np.float32)
        duration_ms = write_wav(out_path, samples, result.sample_rate)
        return result.sample_rate, duration_ms
