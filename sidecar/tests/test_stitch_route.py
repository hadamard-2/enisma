import time
import wave

from fastapi.testclient import TestClient

import server

AUTH = {"Authorization": "Bearer test-token"}


def _client(monkeypatch):
    monkeypatch.setattr(server, "_token", "test-token")
    return TestClient(server.app)


def _wav(path, seconds=0.5, rate=16000):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(seconds * rate))
    return str(path)


def _await_terminal(client, job_id, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snap = client.get(f"/jobs/{job_id}", headers=AUTH).json()
        if snap["state"] != "running":
            return snap
        time.sleep(0.02)
    raise AssertionError("job never reached a terminal state")


def _body(tmp_path, wavs):
    return {
        "wavs": wavs,
        "gap_ms": 600,
        "bitrate_kbps": 64,
        "title": "Biology",
        "out_path": str(tmp_path / "book.mp3.part"),
    }


def test_stitching_requires_the_bearer_token(monkeypatch, tmp_path):
    client = _client(monkeypatch)
    r = client.post("/jobs/stitch", json=_body(tmp_path, [_wav(tmp_path / "a.wav")]))
    assert r.status_code == 401


def test_a_stitch_job_finishes_and_reports_the_length(monkeypatch, tmp_path):
    client = _client(monkeypatch)
    wavs = [_wav(tmp_path / "a.wav", 0.5), _wav(tmp_path / "b.wav", 1.0)]
    job_id = client.post("/jobs/stitch", headers=AUTH, json=_body(tmp_path, wavs)).json()["jobId"]
    snap = _await_terminal(client, job_id)
    assert snap["state"] == "done"
    assert snap["sampleRate"] == 16000
    assert snap["durationMs"] == 2100
    assert (tmp_path / "book.mp3.part").read_bytes()[:3] == b"ID3"


def test_a_refused_input_is_an_error_job_naming_the_file(monkeypatch, tmp_path):
    client = _client(monkeypatch)
    wavs = [_wav(tmp_path / "a.wav", rate=16000), _wav(tmp_path / "b.wav", rate=24000)]
    job_id = client.post("/jobs/stitch", headers=AUTH, json=_body(tmp_path, wavs)).json()["jobId"]
    snap = _await_terminal(client, job_id)
    assert snap["state"] == "error"
    assert snap["message"] == "b.wav: 24000 Hz, but a.wav is 16000 Hz"
