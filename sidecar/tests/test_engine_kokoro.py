import json

import numpy as np
import pytest

from engine_kokoro import KokoroEngine, list_voices


def _model_dir(tmp_path):
    (tmp_path / "voices").mkdir()
    for name in ("af_heart", "am_michael", "bm_george"):
        # 510 style rows of 256 float32, exactly as the real files are shaped.
        np.zeros((510, 1, 256), dtype=np.float32).tofile(
            tmp_path / "voices" / f"{name}.bin"
        )
    (tmp_path / "tokenizer.json").write_text(
        json.dumps({"model": {"vocab": {ch: i + 1 for i, ch in enumerate("abcdefgh .")}}})
    )
    return tmp_path


class FakeSession:
    def __init__(self, *_args, **_kwargs):
        self.calls = 0

    def run(self, _outputs, feeds):
        self.calls += 1
        # One second of silence per chunk at 24 kHz.
        return [np.zeros((1, 24000), dtype=np.float32)]


def _engine(tmp_path, monkeypatch):
    engine = KokoroEngine.__new__(KokoroEngine)
    engine._dir = _model_dir(tmp_path)
    engine._vocab = json.loads((engine._dir / "tokenizer.json").read_text())["model"]["vocab"]
    engine._session = FakeSession()
    engine._phonemize = lambda text: text.lower()
    return engine


def test_list_voices_returns_what_is_on_disk(tmp_path):
    d = _model_dir(tmp_path)
    assert list_voices(str(d)) == ["af_heart", "am_michael", "bm_george"]


def test_it_synthesizes_and_reports_24khz(tmp_path, monkeypatch):
    engine = _engine(tmp_path, monkeypatch)
    out = tmp_path / "p.wav"
    sample_rate, duration_ms = engine.synthesize(
        "abc def.", "af_heart", 1.0, str(out), lambda f: True
    )
    assert sample_rate == 24000
    assert duration_ms > 0
    assert out.exists()


def test_a_long_page_runs_more_than_one_chunk(tmp_path, monkeypatch):
    engine = _engine(tmp_path, monkeypatch)
    long_text = "abcdefgh abcdefgh. " * 60
    engine.synthesize(long_text, "af_heart", 1.0, str(tmp_path / "p.wav"), lambda f: True)
    assert engine._session.calls > 1


def test_cancelling_between_chunks_stops_the_run(tmp_path, monkeypatch):
    engine = _engine(tmp_path, monkeypatch)
    long_text = "abcdefgh abcdefgh. " * 60
    engine.synthesize(
        long_text, "af_heart", 1.0, str(tmp_path / "p.wav"), lambda f: False
    )
    assert engine._session.calls == 1


def test_an_unknown_voice_is_rejected_by_name(tmp_path, monkeypatch):
    engine = _engine(tmp_path, monkeypatch)
    with pytest.raises(FileNotFoundError) as exc:
        engine.synthesize("abc.", "no_such_voice", 1.0, str(tmp_path / "p.wav"), lambda f: True)
    assert "no_such_voice" in str(exc.value)
