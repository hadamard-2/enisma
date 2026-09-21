"""The model manifest and the integrity checks around it.

Every test here is offline by construction: the manifest is a local JSON file,
and the download path is exercised against a file:// URL or a throwaway HTTP
server bound to loopback. Nothing in this file may reach the network — a test
that needs a remote to be up is a test that fails on the plane, which is where
this product is meant to work.

The loopback server exists because resumption cannot be tested over file://:
urllib's file handler ignores a Range header and hands back the whole file, so
the one behaviour under test would never fire.
"""

import hashlib
import http.server
import threading
import urllib.error

import pytest

import models


def test_every_language_in_the_manifest_has_files():
    for lang in ("en", "am", "ti", "om"):
        entries = models.files_for(lang)
        assert entries, f"{lang} has no files"
        for e in entries:
            assert e["url"].startswith("https://")
            assert e["path"].startswith(f"{lang}/")
            assert e["size"] > 0


def test_the_manifest_carries_a_real_hash_for_every_file():
    for lang in ("en", "am", "ti", "om"):
        for e in models.files_for(lang):
            assert len(e["sha256"]) == 64, f"{e['path']} has no real hash"
            int(e["sha256"], 16)  # hex, or this raises


def test_the_manifest_ships_only_fp32_kokoro_weights():
    # The quantized variants are slower on CPU and q8f16 segfaults onnxruntime.
    paths = [e["path"] for e in models.files_for("en")]
    assert "en/model.onnx" in paths
    assert not any("quantized" in p or "q8f16" in p or "fp16" in p for p in paths)


def test_english_carries_the_kokoro_voices():
    paths = [e["path"] for e in models.files_for("en")]
    assert "en/voices/af_heart.bin" in paths


def test_verify_accepts_a_matching_file(tmp_path):
    f = tmp_path / "x"
    f.write_bytes(b"hello")
    assert models.verify(str(f), hashlib.sha256(b"hello").hexdigest())


def test_verify_rejects_a_corrupt_file(tmp_path):
    f = tmp_path / "x"
    f.write_bytes(b"hello")
    assert not models.verify(str(f), "0" * 64)


def test_verify_rejects_a_missing_file(tmp_path):
    assert not models.verify(str(tmp_path / "nope"), "0" * 64)


def test_status_reports_a_language_absent_when_files_are_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path)
    assert models.status()["am"]["present"] is False


def test_status_reports_what_a_language_would_cost(tmp_path, monkeypatch):
    # The caller offers "114 MB" from this rather than keeping a second copy
    # of the manifest's figures.
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path)
    am = models.status()["am"]
    assert am["bytes"] == sum(e["size"] for e in models.files_for("am"))
    assert am["installedBytes"] == 0


def test_status_counts_the_bytes_an_interrupted_download_left_behind(
    tmp_path, monkeypatch
):
    # What makes a resumed download legible: neither absent nor present, with
    # scratch bytes a retry will continue from.
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path)
    entry = models.files_for("am")[0]
    part = tmp_path / (entry["path"] + ".part")
    part.parent.mkdir(parents=True, exist_ok=True)
    part.write_bytes(b"x" * 4096)

    am = models.status()["am"]
    assert am["present"] is False
    assert am["partialBytes"] == 4096


def _local_manifest(tmp_path, payload: bytes, sha256: str) -> dict:
    """A one-file manifest served from disk, so the fetch never leaves the box."""
    src = tmp_path / "remote" / "thing.bin"
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_bytes(payload)
    return {
        "languages": {
            "xx": [
                {
                    "url": src.as_uri(),
                    "path": "xx/thing.bin",
                    "size": len(payload),
                    "sha256": sha256,
                }
            ]
        },
        "voices": {"names": []},
    }


def test_fetch_installs_a_file_whose_hash_matches(tmp_path, monkeypatch):
    payload = b"model bytes"
    good = hashlib.sha256(payload).hexdigest()
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(
        models, "manifest", lambda: _local_manifest(tmp_path, payload, good)
    )

    seen = []
    models.fetch("xx", lambda path, fraction: seen.append((path, fraction)))

    assert (tmp_path / "models" / "xx" / "thing.bin").read_bytes() == payload
    assert seen and seen[-1][1] == pytest.approx(1.0)


def test_fetch_refuses_to_install_a_file_whose_hash_does_not_match(
    tmp_path, monkeypatch
):
    payload = b"tampered bytes"
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(
        models, "manifest", lambda: _local_manifest(tmp_path, payload, "0" * 64)
    )

    with pytest.raises(RuntimeError, match="checksum"):
        models.fetch("xx", lambda path, fraction: None)

    target = tmp_path / "models" / "xx" / "thing.bin"
    # Neither the file nor its scratch half-sibling survives: a model directory
    # is never left in a state the engine would try to load.
    assert not target.exists()
    assert not target.with_suffix(target.suffix + ".part").exists()


def _serve(payload: bytes, honour_range: bool = True):
    """A throwaway loopback HTTP server that can honour (or ignore) Range.

    Returns (base_url, ranges_seen, stop). `ranges_seen` is what makes the
    resume tests real: asserting on the final bytes alone would pass even if
    the whole file were re-downloaded every time.
    """
    ranges: list[str | None] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            header = self.headers.get("Range")
            ranges.append(header)
            body = payload
            if header and honour_range:
                start = int(header.split("=")[1].split("-")[0])
                body = payload[start:]
                self.send_response(206)
                self.send_header(
                    "Content-Range",
                    f"bytes {start}-{len(payload) - 1}/{len(payload)}",
                )
            else:
                self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address[:2]
    return f"http://{host}:{port}/thing.bin", ranges, server.shutdown


def _http_manifest(url: str, payload: bytes, sha256: str) -> dict:
    return {
        "languages": {
            "xx": [
                {"url": url, "path": "xx/thing.bin", "size": len(payload), "sha256": sha256}
            ]
        },
        "voices": {"names": []},
    }


def _serve_status(code: int, headers: dict[str, str] | None = None):
    """A loopback server that only ever fails, with the status asked for.

    The 429 headers mirror the shape the real host sends —
    `"resolvers";r=0;t=148` per the IETF RateLimit draft — so the parsing under
    test is parsing the real format and not one invented here.
    """

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(code)
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address[:2]
    return f"http://{host}:{port}/thing.bin", server.shutdown


def _serve_429(reset: str = '"resolvers";r=0;t=148'):
    return _serve_status(429, {"RateLimit": reset})


class _Headers(dict):
    """Stands in for an HTTPError's headers, which look up case-insensitively."""

    def get(self, key, default=None):
        for k, v in self.items():
            if k.lower() == key.lower():
                return v
        return default


def test_the_reset_time_is_read_from_the_rate_limit_header():
    assert models.rate_limit_wait(_Headers({"RateLimit": '"resolvers";r=0;t=148'})) == 148


def test_the_reset_time_falls_back_to_retry_after():
    assert models.rate_limit_wait(_Headers({"Retry-After": "90"})) == 90


def test_a_host_that_says_nothing_gives_no_reset_time():
    # Both headers are optional in practice, so every caller has to cope.
    assert models.rate_limit_wait(_Headers({})) is None
    assert models.rate_limit_wait(_Headers({"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"})) is None


def test_the_wait_is_described_for_someone_staring_at_a_stalled_download():
    assert models.describe_wait(148) == "Try again in about 2 minutes."
    assert models.describe_wait(20) == "Try again in about 20 seconds."
    assert models.describe_wait(None) == "Wait a few minutes and try again."


def test_a_rate_limited_download_says_how_long_to_wait(tmp_path, monkeypatch):
    # Without this the job dies with a bare "HTTP Error 429: Too Many
    # Requests", which tells the user neither what went wrong nor what to do.
    url, stop = _serve_429()
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(models, "manifest", lambda: _http_manifest(url, b"x" * 10, "0" * 64))

    try:
        with pytest.raises(RuntimeError, match="about 2 minutes") as caught:
            models.fetch("xx", lambda path, fraction: None)
    finally:
        stop()

    assert "rate limiting" in str(caught.value)


def test_a_rate_limit_keeps_what_has_already_been_downloaded(tmp_path, monkeypatch):
    # The message promises the download resumes where it stopped, so the
    # scratch file has to still be there for that to be true.
    url, stop = _serve_429()
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(models, "manifest", lambda: _http_manifest(url, b"x" * 10, "0" * 64))

    part = tmp_path / "models" / "xx" / "thing.bin.part"
    part.parent.mkdir(parents=True, exist_ok=True)
    part.write_bytes(b"already here")

    try:
        with pytest.raises(RuntimeError, match="rate limiting"):
            models.fetch("xx", lambda path, fraction: None)
    finally:
        stop()

    assert part.read_bytes() == b"already here"


def test_a_non_429_http_error_is_not_dressed_up_as_a_rate_limit(tmp_path, monkeypatch):
    # A 404 means the manifest points somewhere wrong, which is a different
    # problem with a different fix; telling the user to wait would waste it.
    url, stop = _serve_status(404)
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(models, "manifest", lambda: _http_manifest(url, b"x" * 10, "0" * 64))

    try:
        with pytest.raises(urllib.error.HTTPError) as caught:
            models.fetch("xx", lambda path, fraction: None)
    finally:
        stop()

    assert caught.value.code == 404
    assert "rate limiting" not in str(caught.value)


@pytest.fixture
def big_payload():
    # Larger than one read chunk, so a download has a seam to be cancelled at
    # and resumed from.
    return bytes(range(256)) * 4000


def test_fetch_resumes_a_partial_download_instead_of_starting_over(
    tmp_path, monkeypatch, big_payload
):
    good = hashlib.sha256(big_payload).hexdigest()
    url, ranges, stop = _serve(big_payload)
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(models, "manifest", lambda: _http_manifest(url, big_payload, good))

    part = tmp_path / "models" / "xx" / "thing.bin.part"
    part.parent.mkdir(parents=True, exist_ok=True)
    part.write_bytes(big_payload[:300_000])

    try:
        models.fetch("xx", lambda path, fraction: None)
    finally:
        stop()

    assert ranges == ["bytes=300000-"]
    assert (tmp_path / "models" / "xx" / "thing.bin").read_bytes() == big_payload


def test_fetch_starts_over_when_the_server_will_not_honour_the_range(
    tmp_path, monkeypatch, big_payload
):
    # A server that answers 200 is sending the whole file, so appending would
    # produce a file that is too long and fails its checksum. The scratch file
    # has to be truncated instead.
    good = hashlib.sha256(big_payload).hexdigest()
    url, ranges, stop = _serve(big_payload, honour_range=False)
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(models, "manifest", lambda: _http_manifest(url, big_payload, good))

    part = tmp_path / "models" / "xx" / "thing.bin.part"
    part.parent.mkdir(parents=True, exist_ok=True)
    part.write_bytes(big_payload[:300_000])

    try:
        models.fetch("xx", lambda path, fraction: None)
    finally:
        stop()

    assert (tmp_path / "models" / "xx" / "thing.bin").read_bytes() == big_payload


def test_a_cancelled_download_keeps_what_it_already_has(
    tmp_path, monkeypatch, big_payload
):
    good = hashlib.sha256(big_payload).hexdigest()
    url, ranges, stop = _serve(big_payload)
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(models, "manifest", lambda: _http_manifest(url, big_payload, good))

    calls = []

    def should_continue():
        calls.append(1)
        return len(calls) <= 1

    try:
        with pytest.raises(models.Cancelled):
            models.fetch("xx", lambda path, fraction: None, should_continue)
    finally:
        stop()

    target = tmp_path / "models" / "xx" / "thing.bin"
    part = tmp_path / "models" / "xx" / "thing.bin.part"
    assert not target.exists(), "a cancelled download must not install anything"
    # Kept deliberately: this is what the next attempt resumes from. Deleting
    # it would make cancelling a 329 MB download cost the whole download again.
    assert part.exists() and part.stat().st_size > 0


def test_a_resumed_download_that_does_not_add_up_is_discarded(
    tmp_path, monkeypatch, big_payload
):
    # The scratch file held bytes from something else. The checksum is the only
    # thing that catches that, and once it fires the scratch file must go — or
    # every later resume appends to bytes already known to be wrong.
    good = hashlib.sha256(big_payload).hexdigest()
    url, ranges, stop = _serve(big_payload)
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(models, "manifest", lambda: _http_manifest(url, big_payload, good))

    part = tmp_path / "models" / "xx" / "thing.bin.part"
    part.parent.mkdir(parents=True, exist_ok=True)
    part.write_bytes(b"\x00" * 300_000)

    try:
        with pytest.raises(RuntimeError, match="checksum"):
            models.fetch("xx", lambda path, fraction: None)
    finally:
        stop()

    assert not part.exists()
    assert not (tmp_path / "models" / "xx" / "thing.bin").exists()


def test_fetch_asks_for_a_timeout(monkeypatch, tmp_path):
    # A stalled socket with no timeout wedges the job thread forever, and a job
    # that never reaches a terminal state cannot be cleared without restarting
    # the app. This asserts the timeout is actually passed, not merely defined.
    payload = b"model bytes"
    good = hashlib.sha256(payload).hexdigest()
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(models, "manifest", lambda: _local_manifest(tmp_path, payload, good))

    seen = {}
    real = models.urllib.request.urlopen

    def spy(request, timeout=None):
        seen["timeout"] = timeout
        return real(request, timeout=timeout)

    monkeypatch.setattr(models.urllib.request, "urlopen", spy)
    models.fetch("xx", lambda path, fraction: None)
    assert seen["timeout"] == models.TIMEOUT_SECONDS


def _stick(tmp_path, payload: bytes, name: str = "xx/thing.bin"):
    """A folder standing in for the user's USB stick."""
    f = tmp_path / "stick" / name
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(payload)
    return tmp_path / "stick"


def test_import_installs_a_language_from_a_folder(tmp_path, monkeypatch):
    payload = b"model bytes"
    good = hashlib.sha256(payload).hexdigest()
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(models, "manifest", lambda: _local_manifest(tmp_path, payload, good))

    seen = []
    models.install_from_dir(
        "xx", str(_stick(tmp_path, payload)), lambda p, f: seen.append(f)
    )

    assert (tmp_path / "models" / "xx" / "thing.bin").read_bytes() == payload
    assert seen and seen[-1] == pytest.approx(1.0)


def test_import_accepts_a_flat_folder_of_the_files_themselves(tmp_path, monkeypatch):
    # The user has already said which language this is, so a stick holding
    # `model.onnx` rather than `am/model.onnx` is not ambiguous.
    payload = b"model bytes"
    good = hashlib.sha256(payload).hexdigest()
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(models, "manifest", lambda: _local_manifest(tmp_path, payload, good))

    models.install_from_dir(
        "xx", str(_stick(tmp_path, payload, name="thing.bin")), lambda p, f: None
    )
    assert (tmp_path / "models" / "xx" / "thing.bin").read_bytes() == payload


def test_import_names_the_files_the_folder_is_missing(tmp_path, monkeypatch):
    # The user is looking at a file manager and needs to know what to go back
    # for, so the message names files rather than counting them.
    payload = b"model bytes"
    good = hashlib.sha256(payload).hexdigest()
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(models, "manifest", lambda: _local_manifest(tmp_path, payload, good))
    empty = tmp_path / "stick"
    empty.mkdir()

    with pytest.raises(RuntimeError, match="thing.bin"):
        models.install_from_dir("xx", str(empty), lambda p, f: None)


def test_import_refuses_a_folder_holding_the_wrong_build(tmp_path, monkeypatch):
    # A stick carrying a different build of the model would load and then
    # produce wrong audio. The hash is what separates that from the right one.
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(
        models, "manifest", lambda: _local_manifest(tmp_path, b"expected", hashlib.sha256(b"expected").hexdigest())
    )

    with pytest.raises(RuntimeError, match="checksum"):
        models.install_from_dir("xx", str(_stick(tmp_path, b"something else")), lambda p, f: None)

    assert not (tmp_path / "models" / "xx" / "thing.bin").exists()
    assert not (tmp_path / "models" / "xx" / "thing.bin.part").exists()
