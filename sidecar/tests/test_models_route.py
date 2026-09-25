"""The model acquisition routes, over the job registry the client already polls.

Offline by construction: `models.fetch` and `models.install_from_dir` are
replaced with fakes here. What is under test is the wiring — that a cancel
reads as a cancel and not as a failure — not the downloader, which
test_models.py covers against a loopback server.
"""

import time

from fastapi.testclient import TestClient

import models
import server

AUTH = {"Authorization": "Bearer test-token"}


def _client(monkeypatch):
    monkeypatch.setattr(server, "_token", "test-token")
    return TestClient(server.app)


def _await_terminal(client, job_id, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snap = client.get(f"/jobs/{job_id}", headers=AUTH).json()
        if snap["state"] != "running":
            return snap
        time.sleep(0.02)
    raise AssertionError("job never reached a terminal state")


def test_status_reports_every_language_with_its_cost(monkeypatch):
    client = _client(monkeypatch)
    body = client.get("/models/status", headers=AUTH).json()
    assert set(body["languages"]) == {"en", "am", "ti", "om"}
    for lang, info in body["languages"].items():
        assert info["bytes"] > 0, lang
        assert isinstance(info["present"], bool)


def test_status_needs_the_bearer_token(monkeypatch):
    client = _client(monkeypatch)
    assert client.get("/models/status").status_code == 401


def test_a_download_runs_as_a_job(monkeypatch):
    seen = {}

    def fake_fetch(language, on_progress, should_continue=None):
        seen["language"] = language
        on_progress("am/model.onnx", 1.0)

    monkeypatch.setattr(models, "fetch", fake_fetch)
    client = _client(monkeypatch)

    job_id = client.post("/jobs/fetch", json={"language": "am"}, headers=AUTH).json()["jobId"]
    snap = _await_terminal(client, job_id)

    assert seen["language"] == "am"
    assert snap["state"] == "done"
    assert snap["progress"] == 1.0


def test_a_cancelled_download_reads_as_cancelled_not_failed(monkeypatch):
    # The registry decides `cancelled` from its flag and treats any exception
    # as an error, while `models` signals a cancel by raising. If the route
    # does not reconcile those, stopping a download on purpose is reported to
    # the user as a failure.
    started = __import__("threading").Event()

    def fake_fetch(language, on_progress, should_continue=None):
        started.set()
        while should_continue():
            time.sleep(0.01)
        raise models.Cancelled()

    monkeypatch.setattr(models, "fetch", fake_fetch)
    client = _client(monkeypatch)

    job_id = client.post("/jobs/fetch", json={"language": "am"}, headers=AUTH).json()["jobId"]
    assert started.wait(2.0)
    client.delete(f"/jobs/{job_id}", headers=AUTH)

    snap = _await_terminal(client, job_id)
    assert snap["state"] == "cancelled"
    assert snap["message"] is None


def test_an_import_runs_as_a_job_and_is_told_where_to_look(monkeypatch):
    seen = {}

    def fake_install(language, source_dir, on_progress, should_continue=None):
        seen.update(language=language, source_dir=source_dir)
        on_progress("am/model.onnx", 1.0)

    monkeypatch.setattr(models, "install_from_dir", fake_install)
    client = _client(monkeypatch)

    job_id = client.post(
        "/jobs/import",
        json={"language": "am", "source_dir": "/media/stick/am"},
        headers=AUTH,
    ).json()["jobId"]
    snap = _await_terminal(client, job_id)

    assert seen == {"language": "am", "source_dir": "/media/stick/am"}
    assert snap["state"] == "done"


def test_a_failed_import_reports_the_reason_verbatim(monkeypatch):
    # The message names the missing files, and the user needs to read it.
    def fake_install(language, source_dir, on_progress, should_continue=None):
        raise RuntimeError("/media/stick is missing 1 file(s) for am: model.onnx")

    monkeypatch.setattr(models, "install_from_dir", fake_install)
    client = _client(monkeypatch)

    job_id = client.post(
        "/jobs/import", json={"language": "am", "source_dir": "/media/stick"}, headers=AUTH
    ).json()["jobId"]
    snap = _await_terminal(client, job_id)

    assert snap["state"] == "error"
    assert "model.onnx" in snap["message"]


def test_a_finished_acquisition_brings_the_language_up_without_a_restart(monkeypatch):
    # Engines are otherwise built once at startup, so without this the user
    # downloads 114 MB and is told the language is still unavailable.
    registered = []
    monkeypatch.setattr(models, "fetch", lambda *a, **k: None)
    monkeypatch.setattr(server, "register_language", lambda lang: registered.append(lang))
    client = _client(monkeypatch)

    job_id = client.post("/jobs/fetch", json={"language": "ti"}, headers=AUTH).json()["jobId"]
    _await_terminal(client, job_id)

    assert registered == ["ti"]


def test_a_cancelled_acquisition_does_not_try_to_bring_the_language_up(monkeypatch):
    registered = []

    def fake_fetch(language, on_progress, should_continue=None):
        raise models.Cancelled()

    monkeypatch.setattr(models, "fetch", fake_fetch)
    monkeypatch.setattr(server, "register_language", lambda lang: registered.append(lang))
    client = _client(monkeypatch)

    job_id = client.post("/jobs/fetch", json={"language": "ti"}, headers=AUTH).json()["jobId"]
    _await_terminal(client, job_id)

    assert registered == []


def test_deleting_a_language_takes_its_engine_down_and_its_files_away(tmp_path, monkeypatch):
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path)
    (tmp_path / "am").mkdir()
    (tmp_path / "am" / "model.onnx").write_bytes(b"model")
    monkeypatch.setitem(server.ENGINES_BY_LANGUAGE, "am", object())
    client = _client(monkeypatch)

    resp = client.delete("/models/am", headers=AUTH)

    assert resp.status_code == 200
    assert resp.json() == {"removed": "am"}
    assert "am" not in server.ENGINES_BY_LANGUAGE
    assert not (tmp_path / "am").exists()
    assert "am" not in client.get("/health", headers=AUTH).json()["engines"]


def test_deleting_a_language_with_nothing_on_disk_succeeds(tmp_path, monkeypatch):
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path)
    client = _client(monkeypatch)
    assert client.delete("/models/ti", headers=AUTH).status_code == 200


def test_deleting_an_unknown_language_is_a_404(monkeypatch):
    client = _client(monkeypatch)
    assert client.delete("/models/xx", headers=AUTH).status_code == 404


def test_deleting_needs_the_bearer_token(monkeypatch):
    client = _client(monkeypatch)
    assert client.delete("/models/am").status_code == 401


def test_a_failed_delete_brings_the_engine_back_and_says_why(monkeypatch):
    # Most likely on Windows, where a file still open cannot be deleted. The
    # engine was taken down first, so it has to be put back or the language
    # would sit on disk unable to speak until a restart.
    def refuse(language):
        raise PermissionError("model.onnx is in use")

    registered = []
    monkeypatch.setattr(models, "remove", refuse)
    monkeypatch.setattr(server, "register_language", lambda lang: registered.append(lang))
    monkeypatch.setitem(server.ENGINES_BY_LANGUAGE, "am", object())
    client = _client(monkeypatch)

    resp = client.delete("/models/am", headers=AUTH)

    assert resp.status_code == 500
    assert "in use" in resp.json()["detail"]
    assert registered == ["am"]
