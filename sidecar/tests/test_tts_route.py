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
