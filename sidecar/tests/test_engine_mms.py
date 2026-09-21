import numpy as np

from engine_mms import MmsEngine


class FakeTts:
    """Stands in for sherpa_onnx.OfflineTts, including its callback contract."""

    sample_rate = 16000
    num_speakers = 0

    def __init__(self):
        self.last_text = None

    def generate(self, text, sid=0, speed=1.0, callback=None):
        self.last_text = text
        self.last_speed = speed
        sentences = [s for s in text.split(".") if s.strip()]
        samples = []
        for i, _ in enumerate(sentences):
            piece = np.zeros(8000, dtype=np.float32)
            samples.append(piece)
            if callback is not None and callback(piece, (i + 1) / len(sentences)) == 0:
                break

        class Result:
            pass

        r = Result()
        r.samples = np.concatenate(samples) if samples else np.zeros(0, dtype=np.float32)
        r.sample_rate = self.sample_rate
        return r


def _engine(monkeypatch, fake):
    engine = MmsEngine.__new__(MmsEngine)
    engine._tts = fake
    engine._language = "ti"
    engine._romanize = lambda text, lcode: text.replace("።", ".")
    return engine


def test_it_synthesizes_and_reports_the_sample_rate(monkeypatch, tmp_path):
    fake = FakeTts()
    engine = _engine(monkeypatch, fake)
    out = tmp_path / "p.wav"
    sample_rate, duration_ms = engine.synthesize(
        "hade neger። kalie neger።", "", 1.0, str(out), lambda f: True
    )
    assert sample_rate == 16000
    assert duration_ms > 0
    assert out.exists()


def test_progress_is_reported_per_sentence(monkeypatch, tmp_path):
    fake = FakeTts()
    engine = _engine(monkeypatch, fake)
    seen = []
    engine.synthesize(
        "one። two። three።", "", 1.0, str(tmp_path / "p.wav"),
        lambda f: seen.append(f) or True,
    )
    assert len(seen) == 3
    assert seen == sorted(seen)


def test_returning_false_stops_early(monkeypatch, tmp_path):
    fake = FakeTts()
    engine = _engine(monkeypatch, fake)
    calls = []

    def stop_after_one(fraction):
        calls.append(fraction)
        return False

    engine.synthesize(
        "one። two። three።", "", 1.0,
        str(tmp_path / "p.wav"), stop_after_one,
    )
    assert len(calls) == 1


def test_the_rate_is_passed_to_the_engine_as_speed(monkeypatch, tmp_path):
    fake = FakeTts()
    engine = _engine(monkeypatch, fake)
    engine.synthesize("one።", "", 1.5, str(tmp_path / "p.wav"), lambda f: True)
    assert fake.last_speed == 1.5


def test_what_reaches_sherpa_is_latin_only_with_periods_kept(monkeypatch, tmp_path):
    """The whole Ge'ez path rests on this: prepared text inside MMS's symbols.

    No digits, and no punctuation except the marks sherpa-onnx segments
    utterances on -- '.', '!' and '?'. Segmentation is what makes progress and
    cancellation possible at all, and it also keeps synthesis cost linear: one
    unbroken run past a few thousand characters stops scaling.

    'v' must not appear either. It is a letter, so it survives the symbol
    strip, but no MMS tokens.txt contains it and the frontend would skip it
    mid-word; prepare folds it onto 'b' before it can get here.
    """
    fake = FakeTts()
    engine = _engine(monkeypatch, fake)
    engine._language = "am"
    # A romanizer standing in for uroman: Ge'ez full stop -> '.', and the
    # numeral run '፪' -> '2' exactly as uroman resolves it, so the number
    # expansion that runs before romanization has something real to consume.
    engine._romanize = lambda text, lcode: text.replace("።", ".").replace("፪", "2")
    engine.synthesize(
        "selam 3 neger። video kalie, neger (፪)፤ new! des neger?",
        "", 1.0, str(tmp_path / "p.wav"), lambda f: True,
    )
    sent = fake.last_text
    assert "." in sent and "!" in sent and "?" in sent
    assert not any(ch.isdigit() for ch in sent)
    assert "v" not in sent and "V" not in sent
    assert set(sent) <= set(
        "abcdefghijklmnopqrstuwxyzABCDEFGHIJKLMNOPQRSTUWXYZ' .!?"
    ), sent
