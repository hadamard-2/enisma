import os
import time

from fastapi.testclient import TestClient

import server
from tts import FakeEngine

AUTH = {"Authorization": "Bearer test-token"}


def _client(monkeypatch):
    monkeypatch.setattr(server, "_token", "test-token")
    monkeypatch.setitem(server.ENGINES_BY_LANGUAGE, "en", FakeEngine())
    return TestClient(server.app)


def _await_terminal(client, job_id, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snap = client.get(f"/jobs/{job_id}", headers=AUTH).json()
        if snap["state"] != "running":
            return snap
        time.sleep(0.02)
    raise AssertionError("job never reached a terminal state")


def _body(out):
    return {
        "text": "hello there", "language": "en", "voice": "af_heart",
        "rate": 1.0, "out_path": str(out),
    }


def test_starting_a_job_requires_the_bearer_token(monkeypatch, tmp_path):
    client = _client(monkeypatch)
    r = client.post("/jobs/tts", json=_body(tmp_path / "x.wav"))
    assert r.status_code == 401


def test_starting_a_job_returns_immediately_with_an_id(monkeypatch, tmp_path):
    client = _client(monkeypatch)
    r = client.post("/jobs/tts", headers=AUTH, json=_body(tmp_path / "p.wav"))
    assert r.status_code == 200
    assert r.json()["jobId"]


def test_the_job_finishes_and_reports_the_audio_it_wrote(monkeypatch, tmp_path):
    client = _client(monkeypatch)
    out = tmp_path / "p.wav"
    job_id = client.post("/jobs/tts", headers=AUTH, json=_body(out)).json()["jobId"]
    snap = _await_terminal(client, job_id)
    assert snap["state"] == "done"
    assert snap["sampleRate"] == 16000
    assert snap["durationMs"] > 0
    assert os.path.getsize(out) > 44  # a real WAV, not an empty file


def test_an_unknown_language_reports_an_error_job(monkeypatch, tmp_path):
    client = _client(monkeypatch)
    body = _body(tmp_path / "p.wav") | {"language": "xx"}
    job_id = client.post("/jobs/tts", headers=AUTH, json=body).json()["jobId"]
    snap = _await_terminal(client, job_id)
    assert snap["state"] == "error"
    assert "xx" in snap["message"]


def test_health_names_the_languages_whose_engines_registered(monkeypatch):
    # Registration is non-fatal: a language whose model is missing or corrupt
    # is simply absent. /health is the only place a client can see that, so
    # the map has to reflect the registry rather than a fixed shape.
    monkeypatch.setattr(server, "_token", "test-token")
    monkeypatch.setattr(
        server, "ENGINES_BY_LANGUAGE", {"en": FakeEngine(), "am": FakeEngine()}
    )
    body = TestClient(server.app).get("/health", headers=AUTH).json()
    assert body["status"] == "ok"
    assert body["version"] == "0"
    assert body["engines"] == {"en": True, "am": True}


def test_health_reports_no_engines_when_none_registered(monkeypatch):
    monkeypatch.setattr(server, "_token", "test-token")
    monkeypatch.setattr(server, "ENGINES_BY_LANGUAGE", {})
    body = TestClient(server.app).get("/health", headers=AUTH).json()
    assert body["engines"] == {}


def test_polling_an_unknown_job_is_a_404(monkeypatch):
    client = _client(monkeypatch)
    assert client.get("/jobs/nope", headers=AUTH).status_code == 404


def test_cancelling_an_unknown_job_is_a_404(monkeypatch):
    client = _client(monkeypatch)
    assert client.delete("/jobs/nope", headers=AUTH).status_code == 404


def test_a_cancelled_job_stops_and_says_so(monkeypatch, tmp_path):
    client = _client(monkeypatch)
    # A slow fake, so there is a window in which to cancel.
    monkeypatch.setitem(server.ENGINES_BY_LANGUAGE, "en", FakeEngine(step_seconds=0.2))
    job_id = client.post(
        "/jobs/tts", headers=AUTH, json=_body(tmp_path / "p.wav")
    ).json()["jobId"]
    assert client.delete(f"/jobs/{job_id}", headers=AUTH).status_code == 200
    snap = _await_terminal(client, job_id)
    assert snap["state"] == "cancelled"


def test_one_engine_failing_to_construct_does_not_stop_the_others(monkeypatch):
    """A bad engine costs its own language, never the whole sidecar.

    Anything other than a missing model -- a corrupt model.onnx, an unreadable
    tokens.txt, a native library that will not load -- used to escape the
    registration loop and kill the process before it could emit a handshake,
    which the Rust supervisor reads as a failed start and retries forever.
    """
    monkeypatch.setattr(server, "ENGINES_BY_LANGUAGE", {})
    monkeypatch.setattr(server.models, "model_dir", lambda lang: f"/nowhere/{lang}")

    def fake_engine(model_dir, language):
        if language == "ti":
            raise RuntimeError("libonnxruntime.so: cannot open shared object file")
        return FakeEngine()

    monkeypatch.setattr(server, "MmsEngine", fake_engine)

    server._register_engines()

    assert "ti" not in server.ENGINES_BY_LANGUAGE
    assert sorted(server.ENGINES_BY_LANGUAGE) == ["am", "om"]


def _voice_dir(tmp_path):
    (tmp_path / "voices").mkdir()
    for name in ("bm_george", "af_heart"):
        (tmp_path / "voices" / f"{name}.bin").write_bytes(b"")
    return tmp_path


def test_listing_voices_requires_the_bearer_token(monkeypatch):
    client = _client(monkeypatch)
    assert client.get("/voices/en").status_code == 401


def test_a_non_english_language_has_no_voices_to_choose(monkeypatch):
    """MMS is single-speaker, so an empty list is the right answer, not a 404."""
    client = _client(monkeypatch)
    r = client.get("/voices/am", headers=AUTH)
    assert r.status_code == 200
    assert r.json() == {"voices": []}


def test_english_reports_the_voice_files_on_disk_sorted(monkeypatch, tmp_path):
    """The route path and the "voices" key are the whole contract with the Rust
    side's list_voices_cmd, which targets /voices/{language} by string."""
    client = _client(monkeypatch)
    monkeypatch.setattr(
        server.models, "model_dir", lambda lang: str(_voice_dir(tmp_path))
    )
    r = client.get("/voices/en", headers=AUTH)
    assert r.status_code == 200
    assert r.json()["voices"] == ["af_heart", "bm_george"]
