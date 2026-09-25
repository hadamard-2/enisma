# M6 — Download Completion + Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship unsigned release builds for Linux x64, Windows x64 and macOS arm64 from GitHub Actions, harden model downloads (commit-pinned URLs, retry on a dropped connection), and let the user download, install from a folder, cancel and delete each language's voice model from Settings.

**Architecture:** Three independent parts. (1) The sidecar's downloader gains pinned URLs and a bounded retry loop, and a `DELETE /models/{language}` route that Rust guards with a refusal rule. (2) A source-hash stamp next to the frozen sidecar lets `beforeBuildCommand` refuse a stale binary; two workflows run the tests on push and build, smoke-test and bundle each target on a tag. (3) The webview's model install state moves out of the editor into a root-level `ModelsProvider` that both the editor's panel and a new Settings → Voices section read.

**Tech Stack:** Python 3.12 sidecar (FastAPI, stdlib `urllib`), Rust (Tauri 2.11, rusqlite, reqwest), React 19 + TypeScript, i18next with ICU, Bun 1.3 (runs the stamp script), vitest, pytest, GitHub Actions (`actions/checkout@v7`, `oven-sh/setup-bun@v2`, `dtolnay/rust-toolchain@stable`, `Swatinem/rust-cache@v2`, `astral-sh/setup-uv@v10.2.0`, `tauri-apps/tauri-action@v1`, `actions/upload-artifact@v7`).

**Spec:** [docs/superpowers/specs/2026-09-25-m6-download-packaging-design.md](../specs/2026-09-25-m6-download-packaging-design.md). Read it first: this plan implements it and does not re-argue its decisions.

## Global Constraints

- Fully offline at runtime. The model download is the only network use, and only when the user asks. Nothing resumes or retries across launches.
- Targets: `x86_64-unknown-linux-gnu` on `ubuntu-22.04` (AppImage, deb), `x86_64-pc-windows-msvc` on `windows-latest` (NSIS), `aarch64-apple-darwin` on `macos-latest` (dmg). No signing: macOS `signingIdentity` is `"-"`; Windows is unsigned.
- Release workflow: on `v*` tag push → draft Release; on `workflow_dispatch` → run artifacts only. Test workflow: every push to `main`, Linux only.
- Retry schedule: waits of **2 s, 8 s, 30 s** (`RETRY_DELAYS = (2, 8, 30)`), only after the current `fetch` call has received at least one byte; the count resets whenever an attempt receives bytes; never for 4xx, 429, checksum failure or cancel. Wait polls cancel every **250 ms**.
- Pinned revisions (verified 2026-09-25 against the manifest's SHA-256 and sizes):
  - `onnx-community/Kokoro-82M-v1.0-ONNX` → `1939ad2a8e416c0acfeecc08a694d14ef25f2231`
  - `hadamard-2/mms-tts-amh-onnx` → `99a12b073f21bcf3872d16ef597bd8bb2ecf5e20`
  - `hadamard-2/mms-tts-tir-onnx` → `05ec7f935b921e4d5d2e755b6c9371aac0232cf9`
  - `hadamard-2/mms-tts-orm-onnx` → `ee7c5cabf11900e7ea784a2d942f2392dbdb158d`
- Backend error text stays in English and is shown untranslated (memory `project-errors-stay-english`).
- Every new UI string goes into all four catalogues (`src/locales/{en,am,ti,om}.json`) as `{ message, context }`. The parity test in `src/lib/i18n.test.ts` fails if a key is missing from any of them.
- User-facing name is **Enisma**; internal identifiers stay **HearBook**. Bundle identifier `com.eyob-g.hear-book` never changes.
- `HashRouter` only.
- Markdown: never hard-wrap prose.
- Existing suites stay green. Baseline on 2026-09-25: **194** frontend (`bun run test`), **122** Rust (`cd src-tauri && cargo test`), **131** sidecar (`cd sidecar && uv run pytest -q`). `bun run build` is the TypeScript typecheck.
- Commits follow Conventional Commits. **Never `git push`.** Anything that needs GitHub to run (Tasks 6 and 8) is handed to the maintainer, who pushes.

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `sidecar/models.json` | Modify | URLs pinned to commits. |
| `sidecar/models.py` | Modify | Retry loop in `fetch`; `remove(language)`. |
| `sidecar/tests/test_models.py` | Modify | Pinning, retry, `_wait`, `remove` tests. |
| `sidecar/server.py` | Modify | `DELETE /models/{language}`; `--check-espeak`. |
| `sidecar/tests/test_models_route.py` | Modify | Delete-route tests. |
| `sidecar/tests/test_check_espeak.py` | Create | `--check-espeak` test. |
| `sidecar/README.md` | Modify | Document the new route and flag. |
| `src-tauri/src/sidecar.rs` | Modify | Error messages carry FastAPI's `detail`. |
| `src-tauri/src/models.rs` | Modify | `removal_refusal`, `remove_model_cmd`. |
| `src-tauri/src/lib.rs` | Modify | Register `remove_model_cmd`. |
| `scripts/sidecar-stamp.ts` | Create | Hash the sidecar's sources; write or check the stamp. |
| `scripts/sidecar-stamp.test.ts` | Create | Tests for the above. |
| `scripts/build-sidecar.sh` | Modify | Write the stamp after installing the binary. |
| `scripts/smoke_sidecar.py` | Create | Start a frozen sidecar and exercise it end to end. |
| `package.json` | Modify | `check-sidecar` script. |
| `vite.config.ts` | Modify | vitest also runs `scripts/**/*.test.ts`. |
| `src-tauri/tauri.conf.json` | Modify | `beforeBuildCommand`; bundle targets; macOS ad-hoc; NSIS mode. |
| `.github/workflows/ci.yml` | Create | Tests on push; reusable by the release workflow. |
| `.github/workflows/release.yml` | Create | Test, freeze, smoke-test, bundle, per target. |
| `src/lib/api.ts` | Modify | `removeModel`. |
| `src/lib/model-state.ts` | Modify | `primaryAction`, `languageState`, `canDelete`. |
| `src/lib/model-state.test.ts` | Modify | Tests for the above. |
| `src/components/editor/model-panel.tsx` | Modify | Use `primaryAction`. |
| `src/components/models/models-provider.tsx` | Create | App-wide model state and actions. |
| `src/App.tsx` | Modify | Mount `ModelsProvider`. |
| `src/components/editor/editor.tsx` | Modify | Read model state from the provider. |
| `src/components/settings/voices-section.tsx` | Create | Settings → Voices rows. |
| `src/components/settings/delete-voice-dialog.tsx` | Create | Delete confirmation. |
| `src/components/settings/settings-dialog.tsx` | Modify | Place the Voices section. |
| `src/locales/*.json`, `docs/translations-needing-review.md` | Modify | Strings. |
| `README.md`, `AGENTS.md`, `docs/implementation-plan.md`, the M6 spec | Modify | Docs and results. |

---

### Task 1: Pin every model URL to a commit

**Files:**
- Modify: `sidecar/models.json`
- Test: `sidecar/tests/test_models.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `models.json` whose every URL (and `voices.url_template`) has the form `https://huggingface.co/<owner>/<repo>/resolve/<40-hex>/<path>`. Hashes and sizes unchanged.

- [ ] **Step 1: Write the failing test**

Add to `sidecar/tests/test_models.py`, after `test_english_carries_the_kokoro_voices`:

```python
_PINNED = re.compile(r"^https://huggingface\.co/[^/]+/[^/]+/resolve/[0-9a-f]{40}/")


def test_every_download_url_is_pinned_to_a_commit():
    # `resolve/main` is a moving branch: an upstream re-upload would not
    # install a wrong model (the hash stops that) but would make every new
    # download fail its checksum. A commit revision cannot move.
    m = models.manifest()
    urls = [e["url"] for entries in m["languages"].values() for e in entries]
    urls.append(m["voices"]["url_template"])
    assert [u for u in urls if not _PINNED.match(u)] == []
```

Add `import re` to the file's imports.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd sidecar && uv run pytest tests/test_models.py::test_every_download_url_is_pinned_to_a_commit -q`
Expected: FAIL, listing all nine `resolve/main` URLs.

- [ ] **Step 3: Pin the URLs**

```bash
cd sidecar && sed -i \
  -e 's#onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/#onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/#g' \
  -e 's#hadamard-2/mms-tts-amh-onnx/resolve/main/#hadamard-2/mms-tts-amh-onnx/resolve/99a12b073f21bcf3872d16ef597bd8bb2ecf5e20/#g' \
  -e 's#hadamard-2/mms-tts-tir-onnx/resolve/main/#hadamard-2/mms-tts-tir-onnx/resolve/05ec7f935b921e4d5d2e755b6c9371aac0232cf9/#g' \
  -e 's#hadamard-2/mms-tts-orm-onnx/resolve/main/#hadamard-2/mms-tts-orm-onnx/resolve/ee7c5cabf11900e7ea784a2d942f2392dbdb158d/#g' \
  models.json
grep -c 'resolve/main' models.json
```

Expected: `0`.

- [ ] **Step 4: Re-verify the pinned files against the manifest (network, one-off, downloads only the small files)**

```bash
cd sidecar && python3 - <<'EOF'
import hashlib, json, re, urllib.parse, urllib.request
m = json.load(open("models.json"))
entries = [e for l in m["languages"].values() for e in l]
v = m["voices"]
entries += [{"url": v["url_template"].format(name=n), "size": v["size"], "sha256": v["sha256"][n]} for n in v["names"]]
bad = 0
for e in entries:
    repo, rev, path = re.match(r"https://huggingface.co/([^/]+/[^/]+)/resolve/([0-9a-f]{40})/(.+)", e["url"]).groups()
    req = urllib.request.Request(f"https://huggingface.co/api/models/{repo}/paths-info/{rev}",
                                 data=urllib.parse.urlencode({"paths": path}).encode(), method="POST")
    info = json.load(urllib.request.urlopen(req))[0]
    if "lfs" in info:
        sha, size = info["lfs"]["oid"], info["lfs"]["size"]
    else:
        body = urllib.request.urlopen(e["url"]).read()
        sha, size = hashlib.sha256(body).hexdigest(), len(body)
    ok = sha == e["sha256"] and size == e["size"]
    bad += not ok
    print("OK " if ok else "BAD", repo, path)
print("ALL MATCH" if not bad else f"{bad} MISMATCH")
EOF
```

Expected: fifteen `OK` lines and `ALL MATCH`. On any `BAD`, stop and report — do not change a hash.

- [ ] **Step 5: Run the sidecar suite**

Run: `cd sidecar && uv run pytest -q`
Expected: all pass, 132 tests.

- [ ] **Step 6: Commit**

```bash
git add sidecar/models.json sidecar/tests/test_models.py
git commit -m "fix(models): pin every model URL to a commit revision"
```

---

### Task 2: Retry a download whose connection drops

**Files:**
- Modify: `sidecar/models.py`
- Test: `sidecar/tests/test_models.py`

**Interfaces:**
- Consumes: the existing `fetch(language, on_progress, should_continue=None)`, `_install`, `Cancelled`, `rate_limit_wait`, `describe_wait`, `TIMEOUT_SECONDS`, `_CHUNK`.
- Produces: `models.RETRY_DELAYS: tuple[float, ...] = (2, 8, 30)`; `models._wait(seconds: float, keep_going: Callable[[], bool]) -> None` (raises `Cancelled`); `fetch` retries as specified. `fetch`'s signature is unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `sidecar/tests/test_models.py`. Add `import socket` and `import time` to the imports.

```python
class _Script:
    """A loopback server that answers each request with the next scripted step.

    ("drop", n): send the first n bytes of what was asked for, then cut the
    connection. ("status", code): answer with that status and no body.
    ("serve",): send what was asked for. Range is honoured throughout, so a
    retry resumes from what the drop left on disk.
    """

    def __init__(self, payload: bytes, steps: list[tuple]):
        self.ranges: list[str | None] = []
        remaining = iter(steps)
        ranges = self.ranges

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                header = self.headers.get("Range")
                ranges.append(header)
                step = next(remaining)
                if step[0] == "status":
                    self.send_response(step[1])
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                start = int(header.split("=")[1].split("-")[0]) if header else 0
                body = payload[start:]
                if header:
                    self.send_response(206)
                    self.send_header(
                        "Content-Range", f"bytes {start}-{len(payload) - 1}/{len(payload)}"
                    )
                else:
                    self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if step[0] == "drop":
                    self.wfile.write(body[: step[1]])
                    self.wfile.flush()
                    self.close_connection = True
                    self.connection.shutdown(socket.SHUT_RDWR)
                    return
                self.wfile.write(body)

            def finish(self):
                try:
                    super().finish()
                except OSError:
                    pass  # the connection was cut on purpose

            def log_message(self, *args):
                pass

        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        host, port = self._server.server_address[:2]
        self.url = f"http://{host}:{port}/thing.bin"

    def stop(self):
        self._server.shutdown()


def _record_waits(monkeypatch) -> list[float]:
    waits: list[float] = []
    monkeypatch.setattr(models, "_wait", lambda seconds, keep_going: waits.append(seconds))
    return waits


def test_a_connection_that_drops_mid_file_is_resumed_on_its_own(
    tmp_path, monkeypatch, big_payload
):
    good = hashlib.sha256(big_payload).hexdigest()
    script = _Script(big_payload, [("drop", 500_000), ("serve",)])
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(models, "manifest", lambda: _http_manifest(script.url, big_payload, good))
    waits = _record_waits(monkeypatch)

    try:
        models.fetch("xx", lambda path, fraction: None)
    finally:
        script.stop()

    assert (tmp_path / "models" / "xx" / "thing.bin").read_bytes() == big_payload
    assert waits == [2]
    # The retry resumed; it did not start the file over.
    assert script.ranges[0] is None
    assert script.ranges[1] is not None and script.ranges[1] != "bytes=0-"


def test_a_machine_offline_from_the_start_is_told_at_once(tmp_path, monkeypatch):
    # Nothing has arrived, so this is not a dropped connection: waiting 40
    # seconds before saying "no connection" helps nobody.
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    url = f"http://127.0.0.1:{port}/thing.bin"
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(models, "manifest", lambda: _http_manifest(url, b"x" * 10, "0" * 64))
    waits = _record_waits(monkeypatch)

    with pytest.raises(urllib.error.URLError):
        models.fetch("xx", lambda path, fraction: None)

    assert waits == []


def test_a_host_that_keeps_failing_is_given_up_on_after_three_retries(
    tmp_path, monkeypatch, big_payload
):
    good = hashlib.sha256(big_payload).hexdigest()
    script = _Script(
        big_payload,
        [("drop", 300_000), ("status", 503), ("status", 503), ("status", 503)],
    )
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(models, "manifest", lambda: _http_manifest(script.url, big_payload, good))
    waits = _record_waits(monkeypatch)

    try:
        with pytest.raises(RuntimeError, match="kept dropping") as caught:
            models.fetch("xx", lambda path, fraction: None)
    finally:
        script.stop()

    assert waits == [2, 8, 30]
    assert "Nothing is lost" in str(caught.value)
    # What arrived before the host went down is kept for the next attempt.
    assert (tmp_path / "models" / "xx" / "thing.bin.part").stat().st_size > 0


def test_progress_between_failures_resets_the_retry_count(
    tmp_path, monkeypatch, big_payload
):
    # Three separate blips across a long download must not end a download that
    # is still making progress.
    good = hashlib.sha256(big_payload).hexdigest()
    script = _Script(
        big_payload,
        [
            ("drop", 300_000),
            ("status", 503),
            ("status", 503),
            ("drop", 300_000),
            ("status", 503),
            ("status", 503),
            ("serve",),
        ],
    )
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(models, "manifest", lambda: _http_manifest(script.url, big_payload, good))
    waits = _record_waits(monkeypatch)

    try:
        models.fetch("xx", lambda path, fraction: None)
    finally:
        script.stop()

    assert waits == [2, 8, 30, 2, 8, 30]
    assert (tmp_path / "models" / "xx" / "thing.bin").read_bytes() == big_payload


def test_a_client_error_after_progress_is_not_retried(tmp_path, monkeypatch, big_payload):
    # A 404 will not fix itself however long we wait.
    good = hashlib.sha256(big_payload).hexdigest()
    script = _Script(big_payload, [("drop", 300_000), ("status", 404)])
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path / "models")
    monkeypatch.setattr(models, "manifest", lambda: _http_manifest(script.url, big_payload, good))
    waits = _record_waits(monkeypatch)

    try:
        with pytest.raises(urllib.error.HTTPError) as caught:
            models.fetch("xx", lambda path, fraction: None)
    finally:
        script.stop()

    assert caught.value.code == 404
    assert waits == [2]


def test_a_wait_stops_as_soon_as_cancel_is_asked():
    started = time.monotonic()
    with pytest.raises(models.Cancelled):
        models._wait(30, lambda: False)
    assert time.monotonic() - started < 1


def test_a_wait_lasts_its_time_when_nobody_cancels():
    started = time.monotonic()
    models._wait(0.3, lambda: True)
    assert 0.3 <= time.monotonic() - started < 1
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd sidecar && uv run pytest tests/test_models.py -q -k "drop or offline or keeps_failing or resets or client_error or wait"`
Expected: FAIL — `models` has no `_wait`, and a dropped connection raises instead of retrying.

- [ ] **Step 3: Implement the retry**

In `sidecar/models.py`:

1. Replace the module docstring's last paragraph (from "Deliberately NOT here:") with:

```python
Retry is deliberately narrow: a connection that drops after bytes have started
arriving is retried a few times within one download, because that is a blip
the user should never have to see. Nothing is retried across launches, and a
machine that is offline from the start is told so at once. Gating project
creation on model presence is also not here.
```

2. Add `import http.client` and `import time` to the imports.

3. After `_CHUNK = 1024 * 256`, add:

```python
# Waits before each retry of a connection that dropped mid-download: about 40
# seconds in all, enough for a Wi-Fi reconnect or a router hiccup and short
# enough that nobody stares at a stuck bar for minutes. The count resets
# whenever an attempt receives bytes, so separate blips across a long download
# do not add up to a failure.
RETRY_DELAYS: tuple[float, ...] = (2, 8, 30)

# How often a retry wait asks whether to keep going. Keeps Cancel as prompt
# during a wait as it is between chunks.
_WAIT_STEP = 0.25
```

4. After `class Cancelled`, add:

```python
class _EndedEarly(ConnectionError):
    """The body stopped short of the file's size without the socket saying so."""


class _Tally:
    """Bytes this fetch call has received from the network, across files and attempts."""

    def __init__(self) -> None:
        self.bytes = 0


def _is_dropped_connection(exc: BaseException) -> bool:
    """Whether a failure is the kind that waiting and resuming can fix.

    A 5xx is the host having a bad moment. Every 4xx (and 429, which never
    reaches here as an HTTPError) is an answer that will not change.
    """
    if isinstance(exc, urllib.error.HTTPError):
        return 500 <= exc.code < 600
    return isinstance(
        exc,
        (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException),
    )


def _wait(seconds: float, keep_going: ShouldContinue) -> None:
    """Sleep before a retry, stopping at once if the user cancels."""
    deadline = time.monotonic() + seconds
    while True:
        if not keep_going():
            raise Cancelled()
        left = deadline - time.monotonic()
        if left <= 0:
            return
        time.sleep(min(_WAIT_STEP, left))
```

5. Replace the whole body of `fetch` from `keep_going = should_continue or _always` to its end with:

```python
    keep_going = should_continue or _always
    entries = files_for(language)
    total = sum(e["size"] for e in entries) or 1
    done = 0
    tally = _Tally()

    for entry in entries:
        target = MODELS_ROOT / entry["path"]
        if verify(str(target), entry["sha256"]):
            done += entry["size"]
            on_progress(entry["path"], min(done / total, 1.0))
            continue

        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_suffix(target.suffix + ".part")

        failures = 0
        while True:
            before = tally.bytes
            try:
                _download_file(entry, target, part, done, total, on_progress, keep_going, tally)
                break
            except Exception as exc:  # noqa: BLE001 - classified just below
                # Nothing received yet in this call means the connection was
                # never there: offline from the start, not dropped.
                if tally.bytes == 0 or not _is_dropped_connection(exc):
                    raise
                if tally.bytes > before:
                    failures = 0
                if failures == len(RETRY_DELAYS):
                    raise RuntimeError(
                        f"the connection kept dropping while downloading {target.name} "
                        f"({exc}). Nothing is lost — the download resumes where it stopped."
                    ) from exc
                _wait(RETRY_DELAYS[failures], keep_going)
                failures += 1

        _install(part, target, entry["sha256"])
        done += entry["size"]


def _download_file(
    entry: dict,
    target: Path,
    part: Path,
    base: int,
    total: int,
    on_progress: OnProgress,
    keep_going: ShouldContinue,
    tally: _Tally,
) -> None:
    """One attempt at one file, appending to its `.part` where the host allows.

    `base` is what the files before this one already account for, so progress
    stays whole-language. Raises on any failure; the caller decides whether
    that failure is worth another attempt.
    """
    have = part.stat().st_size if part.is_file() else 0

    request = urllib.request.Request(entry["url"])
    if have:
        request.add_header("Range", f"bytes={have}-")

    # No cleanup handler: every exit but success deliberately leaves the
    # scratch file in place, because that is what the next attempt resumes
    # from — a cancel, a rate limit and a dropped connection alike. Only a
    # checksum failure destroys it, in `_install`.
    try:
        opened = urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS)
    except urllib.error.HTTPError as err:
        if err.code != 429:
            raise
        # Deliberately not retried here. The window is measured in minutes,
        # and sleeping through it inside a several-hundred-megabyte download
        # is indistinguishable from the stall the timeout above exists to
        # prevent — so the user is told how long and left to decide, which
        # they can afford to do because nothing already downloaded is lost.
        raise RuntimeError(
            "the model host is rate limiting this connection. "
            f"{describe_wait(rate_limit_wait(err.headers))} "
            "Nothing is lost — the download resumes where it stopped."
        ) from err

    with opened as response:
        # 206 means the server honoured the Range and is sending the
        # remainder. Anything else — a 200, or a file:// URL, which has no
        # status at all — is the whole file again, so the scratch file starts
        # over rather than being appended to.
        resuming = getattr(response, "status", None) == 206
        if not resuming:
            have = 0
        on_progress(entry["path"], min((base + have) / total, 1.0))

        with part.open("ab" if resuming else "wb") as out:
            while chunk := response.read(_CHUNK):
                if not keep_going():
                    raise Cancelled()
                out.write(chunk)
                have += len(chunk)
                tally.bytes += len(chunk)
                on_progress(entry["path"], min((base + have) / total, 1.0))

    # A body cut short without a socket error would otherwise go on to fail
    # its checksum, and a checksum failure destroys the scratch file — turning
    # a resumable blip into starting the file over.
    if have < entry["size"]:
        raise _EndedEarly(f"{target.name} stopped after {have} of {entry['size']} bytes")
```

- [ ] **Step 4: Run the new tests, then the whole sidecar suite**

Run: `cd sidecar && uv run pytest -q`
Expected: all pass, 139 tests. The existing rate-limit, resume, restart-from-200, cancel, checksum and timeout tests must still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add sidecar/models.py sidecar/tests/test_models.py
git commit -m "feat(models): retry a download whose connection drops mid-way"
```

---

### Task 3: Sidecar route to delete a language's model

**Files:**
- Modify: `sidecar/models.py`, `sidecar/server.py`, `sidecar/README.md`
- Test: `sidecar/tests/test_models.py`, `sidecar/tests/test_models_route.py`

**Interfaces:**
- Consumes: `models.MODELS_ROOT`, `models.manifest()`, `server.ENGINES_BY_LANGUAGE`, `server.register_language`.
- Produces: `models.remove(language: str) -> None` (raises `KeyError` for a language not in the manifest, `OSError` if deletion fails); `DELETE /models/{language}` → `200 {"removed": "<language>"}`, `404` for an unknown language, `500` with `detail` when deletion fails.

- [ ] **Step 1: Write the failing tests**

Add to `sidecar/tests/test_models.py`:

```python
def test_every_file_of_a_language_lives_under_that_language_s_folder():
    # `remove` deletes one folder per language. That is only the whole
    # language if nothing it owns lives anywhere else.
    for lang in models.manifest()["languages"]:
        for entry in models.files_for(lang):
            assert entry["path"].startswith(f"{lang}/"), entry["path"]


def test_remove_deletes_finished_and_scratch_files_alike(tmp_path, monkeypatch):
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path)
    (tmp_path / "am").mkdir()
    (tmp_path / "am" / "model.onnx").write_bytes(b"model")
    (tmp_path / "am" / "tokens.txt.part").write_bytes(b"half")
    (tmp_path / "ti").mkdir()
    (tmp_path / "ti" / "model.onnx").write_bytes(b"other")

    models.remove("am")

    assert not (tmp_path / "am").exists()
    assert (tmp_path / "ti" / "model.onnx").exists()


def test_removing_a_language_that_is_not_there_is_not_an_error(tmp_path, monkeypatch):
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path)
    models.remove("om")


def test_remove_refuses_a_language_the_manifest_does_not_know(tmp_path, monkeypatch):
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path)
    with pytest.raises(KeyError):
        models.remove("../etc")
```

Add to `sidecar/tests/test_models_route.py`:

```python
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd sidecar && uv run pytest tests/test_models.py tests/test_models_route.py -q -k "remove or delet or lives_under"`
Expected: FAIL — no `models.remove`, and the route answers 405.

- [ ] **Step 3: Implement `models.remove`**

Add to `sidecar/models.py`, after `status()`:

```python
def remove(language: str) -> None:
    """Delete everything a language has on disk: finished files and scratch alike.

    One folder per language holds all of it (a test pins that), so this is a
    single tree removal. A language with nothing on disk is not an error — the
    user asked for it to be gone, and it is. Refuses a name the manifest does
    not know, so a stray path segment can never reach `rmtree`.
    """
    if language not in manifest()["languages"]:
        raise KeyError(language)
    folder = MODELS_ROOT / language
    if folder.exists():
        shutil.rmtree(folder)
```

- [ ] **Step 4: Implement the route**

Add to `sidecar/server.py`, after `models_status`:

```python
@app.delete("/models/{language}")
def remove_model(language: str, _: None = Depends(_require_token)) -> dict:
    """Delete one language's voice model and take its engine down.

    The engine goes first, so no new synthesis can start on files that are
    about to vanish. If the files will not go — on Windows, a file still open
    cannot be deleted — the engine is rebuilt from whatever is left, so /health
    and the disk never disagree about whether the language can speak.
    """
    if language not in models.manifest()["languages"]:
        raise HTTPException(status_code=404, detail=f"no voice model for language {language!r}")
    ENGINES_BY_LANGUAGE.pop(language, None)
    try:
        models.remove(language)
    except OSError as exc:
        register_language(language)
        raise HTTPException(
            status_code=500,
            detail=f"could not delete the {language} voice model: {exc}",
        ) from exc
    return {"removed": language}
```

- [ ] **Step 5: Document the route**

In `sidecar/README.md`, under `## Routes`, add a row or bullet in the same form the file already uses for the other routes:

`DELETE /models/{language}` — delete that language's files (including `.part` scratch files) and take its engine down. 404 for a language not in the manifest; 500 with a `detail` if the files could not be deleted, in which case the engine is rebuilt from what is left.

- [ ] **Step 6: Run the sidecar suite**

Run: `cd sidecar && uv run pytest -q`
Expected: all pass, 148 tests.

- [ ] **Step 7: Commit**

```bash
git add sidecar/models.py sidecar/server.py sidecar/README.md sidecar/tests/test_models.py sidecar/tests/test_models_route.py
git commit -m "feat(sidecar): delete a language's voice model and take its engine down"
```

---

### Task 4: Rust command to delete a language, with its refusal rule

**Files:**
- Modify: `src-tauri/src/sidecar.rs`, `src-tauri/src/models.rs`, `src-tauri/src/lib.rs`, `src/lib/api.ts`

**Interfaces:**
- Consumes: `DELETE /models/{language}` (Task 3); `convert::{ActiveConversion, Holder}`; `models::ActiveAcquisition`; `crate::Db`; `sidecar::delete_json`.
- Produces:
  - Rust: `pub fn removal_refusal(language: &str, installing: Option<&str>, converting: Option<(Holder, &str)>) -> Option<&'static str>`; `#[tauri::command] pub async fn remove_model_cmd(..., language: String) -> Result<(), String>`; constants `REMOVE_WHILE_INSTALLING`, `REMOVE_WHILE_CONVERTING`, `REMOVE_WHILE_EXPORTING`.
  - Rust: `fn failure_message(route: &str, status: reqwest::StatusCode, body: Option<&serde_json::Value>) -> String` in `sidecar.rs`.
  - TS: `export const removeModel = (language: string) => invoke<void>("remove_model_cmd", { language })`.

**Ruling recorded here:** `read_json` in `sidecar.rs` is shared by every sidecar call. It currently drops the response body on a non-2xx status, which would reduce a Windows "file in use" failure to "`/models/am returned 500 Internal Server Error`". It gains FastAPI's `detail` when one is present. The 404 path, and so `is_not_found`, is unchanged.

- [ ] **Step 1: Write the failing Rust tests**

In `src-tauri/src/models.rs`'s `mod tests`, add (`Holder` comes into scope through the module's `use super::*;` once Step 4 imports it at the top of the file):

```rust
    #[test]
    fn a_language_being_installed_cannot_be_deleted() {
        assert_eq!(
            removal_refusal("am", Some("am"), None),
            Some(REMOVE_WHILE_INSTALLING)
        );
    }

    #[test]
    fn an_install_of_another_language_does_not_stop_a_delete() {
        assert_eq!(removal_refusal("am", Some("ti"), None), None);
    }

    #[test]
    fn a_language_a_page_is_being_converted_in_cannot_be_deleted() {
        assert_eq!(
            removal_refusal("am", None, Some((Holder::Page, "am"))),
            Some(REMOVE_WHILE_CONVERTING)
        );
    }

    #[test]
    fn a_language_being_exported_cannot_be_deleted() {
        assert_eq!(
            removal_refusal("en", None, Some((Holder::Export, "en"))),
            Some(REMOVE_WHILE_EXPORTING)
        );
    }

    #[test]
    fn a_conversion_in_another_language_does_not_stop_a_delete() {
        assert_eq!(removal_refusal("am", None, Some((Holder::Export, "en"))), None);
    }

    #[test]
    fn with_nothing_running_a_delete_goes_ahead() {
        assert_eq!(removal_refusal("om", None, None), None);
    }
```

In `src-tauri/src/sidecar.rs`'s `mod tests`, add:

```rust
    #[test]
    fn a_failure_carries_the_sidecar_s_own_reason_when_it_gives_one() {
        let body = serde_json::json!({ "detail": "could not delete the am voice model: in use" });
        assert_eq!(
            failure_message("/models/am", reqwest::StatusCode::INTERNAL_SERVER_ERROR, Some(&body)),
            "/models/am returned 500 Internal Server Error: could not delete the am voice model: in use"
        );
    }

    #[test]
    fn a_failure_without_a_reason_reads_as_before() {
        assert_eq!(
            failure_message("/jobs/abc", reqwest::StatusCode::INTERNAL_SERVER_ERROR, None),
            "/jobs/abc returned 500 Internal Server Error"
        );
    }
```

- [ ] **Step 2: Run them and watch them fail to compile**

Run: `cd src-tauri && cargo test 2>&1 | tail -5`
Expected: compile errors — `removal_refusal`, the constants and `failure_message` do not exist.

- [ ] **Step 3: Carry FastAPI's reason in sidecar errors**

In `src-tauri/src/sidecar.rs`, replace `read_json` with:

```rust
/// The error for a non-2xx answer, with the sidecar's own reason when it gave
/// one. FastAPI puts that reason in `detail`; without it a failure the user
/// could act on ("file in use") reaches them as a bare status line.
fn failure_message(
    route: &str,
    status: reqwest::StatusCode,
    body: Option<&serde_json::Value>,
) -> String {
    match body.and_then(|b| b.get("detail")).and_then(|d| d.as_str()) {
        Some(detail) => format!("{route} returned {status}: {detail}"),
        None => format!("{route} returned {status}"),
    }
}

async fn read_json(resp: reqwest::Response, route: &str) -> Result<serde_json::Value, String> {
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("{route} {NOT_FOUND}"));
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.json::<serde_json::Value>().await.ok();
        return Err(failure_message(route, status, body.as_ref()));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Implement the refusal rule and the command**

In `src-tauri/src/models.rs`:

1. Extend the imports:

```rust
use rusqlite::params;

use crate::convert::{ActiveConversion, Holder};
use crate::sidecar::{self, SidecarState};
use crate::Db;
```

(Replace the existing `use crate::sidecar::{self, SidecarState};` line rather than duplicating it.)

2. Add, after `cancel_model_acquisition_cmd`:

```rust
/// Why a language cannot be deleted right now.
pub const REMOVE_WHILE_INSTALLING: &str =
    "this voice is being installed. Cancel the install first, or wait for it to finish.";
pub const REMOVE_WHILE_CONVERTING: &str =
    "a page in this language is being converted. Wait for it to finish, or cancel it first.";
pub const REMOVE_WHILE_EXPORTING: &str =
    "an export in this language is running. Wait for it to finish, or cancel it first.";

/// Whether deleting `language` must be refused, and why.
///
/// `installing` is the language the acquisition slot holds, if any.
/// `converting` is who holds the conversion slot and the language of the
/// project they hold it for. An export holds the same slot, so one rule
/// covers both. Anything in another language is no reason to refuse.
pub fn removal_refusal(
    language: &str,
    installing: Option<&str>,
    converting: Option<(Holder, &str)>,
) -> Option<&'static str> {
    if installing == Some(language) {
        return Some(REMOVE_WHILE_INSTALLING);
    }
    match converting {
        Some((Holder::Page, lang)) if lang == language => Some(REMOVE_WHILE_CONVERTING),
        Some((Holder::Export, lang)) if lang == language => Some(REMOVE_WHILE_EXPORTING),
        _ => None,
    }
}

/// Delete one language's voice model, unless something is using it.
///
/// A conversion that starts in the moment between this check and the sidecar
/// taking the engine down fails with the sidecar's "language unavailable"
/// error. That window is accepted: closing it would need a new kind of slot
/// holder, and the error it produces is clear.
#[tauri::command]
pub async fn remove_model_cmd(
    sidecar_state: State<'_, SidecarState>,
    active: State<'_, ActiveAcquisition>,
    conversion: State<'_, ActiveConversion>,
    db: State<'_, Db>,
    language: String,
) -> Result<(), String> {
    let installing = active.0.lock().unwrap().as_ref().map(|j| j.language.clone());
    let holder = conversion
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map(|j| (j.holder, j.project_id.clone()));
    let converting = match holder {
        Some((h, project_id)) => {
            let conn = db.0.lock().unwrap();
            let lang: String = conn
                .query_row(
                    "SELECT language FROM projects WHERE id = ?1",
                    params![project_id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            Some((h, lang))
        }
        None => None,
    };
    if let Some(reason) = removal_refusal(
        &language,
        installing.as_deref(),
        converting.as_ref().map(|(h, l)| (*h, l.as_str())),
    ) {
        return Err(reason.to_string());
    }
    sidecar::delete_json(&sidecar_state, &format!("/models/{language}"))
        .await
        .map(|_| ())
}
```

Every lock guard is dropped before the `.await`: each is a temporary or scoped to the `match` arm.

3. In `src-tauri/src/lib.rs`, add `models::remove_model_cmd,` after `models::cancel_model_acquisition_cmd,` in `generate_handler!`.

- [ ] **Step 5: Add the TypeScript wrapper**

In `src/lib/api.ts`, after `cancelModelAcquisition`:

```ts
/**
 * Delete one language's voice model, scratch files included.
 *
 * Rejects, in English, while that language is being installed, converted or
 * exported, and with the sidecar's own reason if the files could not be
 * deleted. Audio already made is untouched.
 */
export const removeModel = (language: string) =>
  invoke<void>("remove_model_cmd", { language });
```

- [ ] **Step 6: Run the Rust suite and the typecheck**

Run: `cd src-tauri && cargo test 2>&1 | grep "test result"` then `bun run build`
Expected: Rust 130 passed; the typecheck and build succeed.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/sidecar.rs src-tauri/src/models.rs src-tauri/src/lib.rs src/lib/api.ts
git commit -m "feat(models): delete a language's voice model unless it is in use"
```

---

### Task 5: Refuse to bundle a stale sidecar

**Files:**
- Create: `scripts/sidecar-stamp.ts`, `scripts/sidecar-stamp.test.ts`
- Modify: `scripts/build-sidecar.sh`, `package.json`, `vite.config.ts`, `src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: the sidecar's top-level `*.py`, `pyproject.toml`, `uv.lock`, `hearbook_sidecar.spec`, `models.json`; `rustc --print host-tuple`.
- Produces:
  - `sidecarInputs(sidecarDir: string): string[]` — sorted file names.
  - `stampOf(files: { name: string; bytes: Uint8Array }[]): string` — hex SHA-256.
  - `binaryPath(repoRoot: string, triple: string): string` and `stampPath(repoRoot: string, triple: string): string`.
  - `checkStamp(repoRoot: string, triple: string): { ok: true } | { ok: false; message: string }`.
  - CLI: `bun scripts/sidecar-stamp.ts write` and `bun scripts/sidecar-stamp.ts check`.
  - `bun run check-sidecar`.

- [ ] **Step 1: Let vitest see tests under `scripts/`**

In `vite.config.ts`, change the test include to:

```ts
        include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
```

- [ ] **Step 2: Write the failing tests**

Create `scripts/sidecar-stamp.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { binaryPath, checkStamp, sidecarInputs, stampOf, stampPath, writeStamp } from "./sidecar-stamp";

const enc = (s: string) => new TextEncoder().encode(s);

/** A throwaway repo with a sidecar folder and an empty binaries folder. */
function repo(files: Record<string, string> = { "server.py": "print(1)", "uv.lock": "lock" }) {
  const root = mkdtempSync(join(tmpdir(), "stamp-"));
  mkdirSync(join(root, "sidecar", "tests"), { recursive: true });
  mkdirSync(join(root, "src-tauri", "binaries"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, "sidecar", name), body);
  return root;
}

describe("stampOf", () => {
  it("does not depend on the order files are given in", () => {
    const a = { name: "a.py", bytes: enc("1") };
    const b = { name: "b.py", bytes: enc("2") };
    expect(stampOf([a, b])).toBe(stampOf([b, a]));
  });

  it("changes when a file's content changes", () => {
    expect(stampOf([{ name: "a.py", bytes: enc("1") }])).not.toBe(
      stampOf([{ name: "a.py", bytes: enc("2") }]),
    );
  });

  it("changes when a file is renamed", () => {
    expect(stampOf([{ name: "a.py", bytes: enc("1") }])).not.toBe(
      stampOf([{ name: "b.py", bytes: enc("1") }]),
    );
  });
});

describe("sidecarInputs", () => {
  it("takes top-level Python and the named build inputs, not tests", () => {
    const root = repo({
      "server.py": "",
      "models.py": "",
      "pyproject.toml": "",
      "uv.lock": "",
      "hearbook_sidecar.spec": "",
      "models.json": "",
      "README.md": "",
    });
    writeFileSync(join(root, "sidecar", "tests", "test_x.py"), "");
    expect(sidecarInputs(join(root, "sidecar"))).toEqual([
      "hearbook_sidecar.spec",
      "models.json",
      "models.py",
      "pyproject.toml",
      "server.py",
      "uv.lock",
    ]);
  });
});

describe("checkStamp", () => {
  const triple = "x86_64-unknown-linux-gnu";

  it("fails when there is no binary", () => {
    const result = checkStamp(repo(), triple);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("scripts/build-sidecar.sh");
  });

  it("fails when the binary has no stamp", () => {
    const root = repo();
    writeFileSync(binaryPath(root, triple), "bin");
    const result = checkStamp(root, triple);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("no stamp");
  });

  it("passes right after a stamp is written", () => {
    const root = repo();
    writeFileSync(binaryPath(root, triple), "bin");
    writeStamp(root, triple);
    expect(checkStamp(root, triple)).toEqual({ ok: true });
  });

  it("fails once a source changes after the build", () => {
    const root = repo();
    writeFileSync(binaryPath(root, triple), "bin");
    writeStamp(root, triple);
    writeFileSync(join(root, "sidecar", "server.py"), "print(2)");
    const result = checkStamp(root, triple);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("different sidecar sources");
  });

  it("names the Windows binary with its extension", () => {
    expect(binaryPath("/r", "x86_64-pc-windows-msvc")).toMatch(/hearbook-sidecar-x86_64-pc-windows-msvc\.exe$/);
    expect(stampPath("/r", "x86_64-pc-windows-msvc")).toMatch(/hearbook-sidecar-x86_64-pc-windows-msvc\.stamp$/);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `bun run test scripts/sidecar-stamp.test.ts`
Expected: FAIL — cannot resolve `./sidecar-stamp`.

- [ ] **Step 4: Implement the stamp script**

Create `scripts/sidecar-stamp.ts`:

```ts
/**
 * A fingerprint of the sidecar's sources, kept next to the frozen binary.
 *
 * `tauri build` bundles whatever sits in `src-tauri/binaries/`, and that folder
 * is gitignored, so nothing else ties the binary to the code it was built
 * from. `scripts/build-sidecar.sh` writes the stamp right after freezing;
 * `beforeBuildCommand` checks it and refuses to bundle a binary built from
 * different sources. Only the host triple's binary is checked, because that is
 * the only one Tauri bundles.
 *
 * Usage: `bun scripts/sidecar-stamp.ts write|check`.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Build inputs besides the Python modules themselves. */
const NAMED_INPUTS = ["pyproject.toml", "uv.lock", "hearbook_sidecar.spec", "models.json"];

/** Every file whose change should force a rebuild, by name, sorted. Tests are not among them. */
export function sidecarInputs(sidecarDir: string): string[] {
  const modules = readdirSync(sidecarDir).filter((n) => n.endsWith(".py"));
  const named = NAMED_INPUTS.filter((n) => existsSync(join(sidecarDir, n)));
  return [...modules, ...named].sort();
}

/**
 * SHA-256 over each file's name, length and bytes, in name order. The name is
 * included so a rename changes the stamp; the length keeps one file's end from
 * running into the next file's start.
 */
export function stampOf(files: { name: string; bytes: Uint8Array }[]): string {
  const hash = createHash("sha256");
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const f of sorted) {
    hash.update(f.name);
    hash.update("\0");
    hash.update(String(f.bytes.length));
    hash.update("\0");
    hash.update(f.bytes);
  }
  return hash.digest("hex");
}

function currentStamp(repoRoot: string): string {
  const dir = join(repoRoot, "sidecar");
  return stampOf(sidecarInputs(dir).map((name) => ({ name, bytes: readFileSync(join(dir, name)) })));
}

export function binaryPath(repoRoot: string, triple: string): string {
  const ext = triple.includes("windows") ? ".exe" : "";
  return join(repoRoot, "src-tauri", "binaries", `hearbook-sidecar-${triple}${ext}`);
}

export function stampPath(repoRoot: string, triple: string): string {
  return join(repoRoot, "src-tauri", "binaries", `hearbook-sidecar-${triple}.stamp`);
}

export function writeStamp(repoRoot: string, triple: string): void {
  writeFileSync(stampPath(repoRoot, triple), currentStamp(repoRoot) + "\n");
}

const FIX = "Run scripts/build-sidecar.sh to rebuild it.";

export function checkStamp(
  repoRoot: string,
  triple: string,
): { ok: true } | { ok: false; message: string } {
  const bin = binaryPath(repoRoot, triple);
  if (!existsSync(bin)) {
    return { ok: false, message: `No sidecar binary at ${bin}. ${FIX}` };
  }
  const stamp = stampPath(repoRoot, triple);
  if (!existsSync(stamp)) {
    return { ok: false, message: `The sidecar binary at ${bin} has no stamp, so its sources are unknown. ${FIX}` };
  }
  if (readFileSync(stamp, "utf8").trim() !== currentStamp(repoRoot)) {
    return { ok: false, message: `The sidecar binary at ${bin} was built from different sidecar sources. ${FIX}` };
  }
  return { ok: true };
}

function hostTriple(): string {
  return execSync("rustc --print host-tuple", { encoding: "utf8" }).trim();
}

if (import.meta.main) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const command = process.argv[2];
  const triple = hostTriple();
  if (command === "write") {
    writeStamp(repoRoot, triple);
    console.log(`Stamped ${binaryPath(repoRoot, triple)}`);
  } else if (command === "check") {
    const result = checkStamp(repoRoot, triple);
    if (!result.ok) {
      console.error(result.message);
      process.exit(1);
    }
  } else {
    console.error("usage: bun scripts/sidecar-stamp.ts write|check");
    process.exit(2);
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `bun run test scripts/sidecar-stamp.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Wire it in**

1. In `scripts/build-sidecar.sh`, after the `cp` line and before the final `echo`, add:

```bash
# Tie the binary to the sources it was built from, so `tauri build` can refuse
# a stale one (see scripts/sidecar-stamp.ts).
bun "$REPO_ROOT/scripts/sidecar-stamp.ts" write
```

2. In `package.json` `scripts`, add `"check-sidecar": "bun scripts/sidecar-stamp.ts check",` after `"tauri": "tauri",`.

3. In `src-tauri/tauri.conf.json`, set `"beforeBuildCommand": "bun run check-sidecar && bun run build"`. Leave `beforeDevCommand` alone: `tauri dev` runs the sidecar from source through uv.

- [ ] **Step 7: Verify the guard for real**

The checkout's binary predates the stamp, so:

```bash
bun run check-sidecar; echo "exit=$?"
```
Expected: `... has no stamp ...`, `exit=1`.

```bash
scripts/build-sidecar.sh && bun run check-sidecar; echo "exit=$?"
```
Expected: the freeze completes (a few minutes), `Stamped ...`, then `exit=0`.

```bash
echo "# probe" >> sidecar/jobs.py && bun run check-sidecar; echo "exit=$?"; git checkout sidecar/jobs.py
```
Expected: `... different sidecar sources ...`, `exit=1`.

Then run `bun run test` — expected: 203 tests pass.

- [ ] **Step 8: Commit**

```bash
git add scripts/sidecar-stamp.ts scripts/sidecar-stamp.test.ts scripts/build-sidecar.sh package.json vite.config.ts src-tauri/tauri.conf.json
git commit -m "build: refuse to bundle a sidecar built from different sources"
```

---

### Task 6: Run the tests on every push

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the three suites; `bun run build`.
- Produces: a workflow named `CI` triggered by `push` to `main` and callable with `workflow_call` (Task 8 reuses it).

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  workflow_call:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v7

      - uses: oven-sh/setup-bun@v2

      - uses: dtolnay/rust-toolchain@stable

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      # The uv cache matters most: it holds num2words2, which is pinned to git
      # and compiled from source.
      - uses: astral-sh/setup-uv@v10.2.0
        with:
          enable-cache: true
          cache-dependency-glob: sidecar/uv.lock

      - name: System libraries for Tauri
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf xdg-utils

      - run: bun install --frozen-lockfile

      - name: Front-end tests
        run: bun run test

      - name: Typecheck and build the front end
        run: bun run build

      # tauri-build checks that every externalBin exists before it compiles
      # anything, and the tests do not use the sidecar, so an empty stand-in
      # is enough here.
      - name: Stand-in sidecar binary
        run: touch src-tauri/binaries/hearbook-sidecar-x86_64-unknown-linux-gnu

      - name: Rust tests
        working-directory: src-tauri
        run: cargo test

      - name: Sidecar tests
        working-directory: sidecar
        run: |
          uv sync
          uv run pytest -q
```

- [ ] **Step 2: Check it parses**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('ok')"`
Expected: `ok`. (If `actionlint` is on PATH, also run `actionlint .github/workflows/ci.yml` and fix what it reports.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run the three test suites on every push to main"
```

- [ ] **Step 4: Hand over**

The workflow runs only once it is on GitHub. Report to the maintainer that `ci.yml` is ready to push, and that the first run is the real verification. Do not push.

---

### Task 7: Smoke-test a frozen sidecar

**Files:**
- Modify: `sidecar/server.py`, `sidecar/README.md`
- Create: `sidecar/tests/test_check_espeak.py`, `scripts/smoke_sidecar.py`

**Interfaces:**
- Consumes: the frozen binary at `src-tauri/binaries/hearbook-sidecar-<triple>[.exe]`; its handshake (one JSON line with `ready` and `port`); `HEARBOOK_SIDECAR_TOKEN`, `HEARBOOK_MODELS_DIR`; routes `/health`, `/models/status`, `/jobs/fetch`, `/jobs/tts`, `/jobs/{id}`, `DELETE /models/{language}`.
- Produces: `server.main(argv: list[str] | None = None) -> int` accepting `--check-espeak`; `scripts/smoke_sidecar.py [binary]`, exit 0 on success, printing timings and appending them to `$GITHUB_STEP_SUMMARY` when set.

- [ ] **Step 1: Write the failing test**

Create `sidecar/tests/test_check_espeak.py`:

```python
"""The frozen binary's espeak-ng self-check.

English needs a 326 MB model to synthesize, which a build's smoke test does
not download. espeak-ng — the part most likely to break when frozen on a new
OS — needs no model at all, so it is checked on its own through this flag.
"""

import json

import server


def test_check_espeak_phonemizes_a_word_and_exits_cleanly(capsys):
    assert server.main(["--check-espeak"]) == 0
    printed = json.loads(capsys.readouterr().out.strip())
    assert isinstance(printed, str) and printed.strip()
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd sidecar && uv run pytest tests/test_check_espeak.py -q`
Expected: FAIL — `main()` takes no arguments.

- [ ] **Step 3: Implement the flag**

In `sidecar/server.py`, replace `def main() -> int:` and its first lines through the token check with:

```python
def _check_espeak() -> int:
    """Phonemize one word and print it as JSON, for a build's smoke test.

    JSON rather than the raw IPA: a Windows pipe is not UTF-8, and printing
    IPA to it would fail for reasons that have nothing to do with espeak-ng.
    """
    import engine_kokoro

    phonemes = engine_kokoro._make_phonemizer()("hello")
    print(json.dumps(phonemes))
    return 0 if phonemes.strip() else 1


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if "--check-espeak" in args:
        return _check_espeak()
    if not _token:
        _emit({"ready": False, "error": f"{TOKEN_ENV} not set"})
        return 1
```

Leave the rest of `main` as it is.

- [ ] **Step 4: Run the sidecar suite**

Run: `cd sidecar && uv run pytest -q`
Expected: all pass, 149 tests.

- [ ] **Step 5: Write the smoke script**

Create `scripts/smoke_sidecar.py`:

```python
#!/usr/bin/env python3
"""Smoke-test a frozen sidecar on the machine that just built it.

Standard library only, so it runs before anything else is installed. It is
what makes a Windows or macOS build more than "PyInstaller exited 0": it
starts the binary, installs one MMS language from the pinned URLs (114 MB),
synthesizes a sentence, checks espeak-ng separately, deletes the language, and
records how long startup and a model-status check took.

Usage: python scripts/smoke_sidecar.py [path/to/hearbook-sidecar-<triple>]
"""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LANGUAGE = "am"
SENTENCE = "ሰላም ለዓለም።"
JOB_TIMEOUT = 1800


def default_binary() -> Path:
    triple = subprocess.run(
        ["rustc", "--print", "host-tuple"], check=True, capture_output=True, text=True
    ).stdout.strip()
    ext = ".exe" if "windows" in triple else ""
    return REPO / "src-tauri" / "binaries" / f"hearbook-sidecar-{triple}{ext}"


def fail(message: str) -> None:
    raise SystemExit(f"SMOKE FAILED: {message}")


class Sidecar:
    def __init__(self, binary: Path, models_dir: Path) -> None:
        self.token = secrets.token_hex(16)
        env = {
            **os.environ,
            "HEARBOOK_SIDECAR_TOKEN": self.token,
            "HEARBOOK_MODELS_DIR": str(models_dir),
        }
        started = time.monotonic()
        # stdin stays open: the sidecar exits when it closes.
        self.proc = subprocess.Popen(
            [str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env
        )
        hello = None
        for raw in self.proc.stdout:
            try:
                parsed = json.loads(raw)
            except ValueError:
                continue
            if isinstance(parsed, dict) and "ready" in parsed:
                hello = parsed
                break
        self.startup_seconds = time.monotonic() - started
        if hello is None:
            fail(f"sidecar exited before its handshake (code {self.proc.wait()})")
        if not hello.get("ready"):
            fail(f"sidecar reported not ready: {hello}")
        self.base = f"http://127.0.0.1:{hello['port']}"

    def call(self, method: str, route: str, body: dict | None = None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(
            self.base + route,
            data=data,
            method=method,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=120) as response:
            raw = response.read()
        return json.loads(raw) if raw else None

    def run_job(self, route: str, body: dict) -> None:
        job = self.call("POST", route, body)["jobId"]
        deadline = time.monotonic() + JOB_TIMEOUT
        while time.monotonic() < deadline:
            snap = self.call("GET", f"/jobs/{job}")
            if snap["state"] == "done":
                return
            if snap["state"] != "running":
                fail(f"{route} ended {snap['state']}: {snap.get('message')}")
            time.sleep(1)
        fail(f"{route} did not finish within {JOB_TIMEOUT} s")

    def close(self) -> None:
        self.proc.stdin.close()
        try:
            self.proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def main() -> int:
    binary = Path(sys.argv[1]) if len(sys.argv) > 1 else default_binary()
    if not binary.is_file():
        fail(f"no binary at {binary}")

    espeak = subprocess.run([str(binary), "--check-espeak"], capture_output=True, timeout=300)
    if espeak.returncode != 0 or not espeak.stdout.strip():
        fail(f"espeak-ng check failed (code {espeak.returncode}): {espeak.stderr.decode(errors='replace')}")
    print(f"espeak-ng: {json.loads(espeak.stdout)}")

    with tempfile.TemporaryDirectory() as scratch:
        scratch_dir = Path(scratch)
        models_dir = scratch_dir / "models"
        sidecar = Sidecar(binary, models_dir)
        try:
            print(f"startup: {sidecar.startup_seconds:.1f} s")
            sidecar.call("GET", "/health")

            sidecar.run_job("/jobs/fetch", {"language": LANGUAGE})
            if LANGUAGE not in sidecar.call("GET", "/health")["engines"]:
                fail(f"{LANGUAGE} installed but its engine did not come up")

            started = time.monotonic()
            sidecar.call("GET", "/models/status")
            status_seconds = time.monotonic() - started
            print(f"/models/status with {LANGUAGE} installed: {status_seconds:.2f} s")

            wav = scratch_dir / "smoke.wav"
            sidecar.run_job(
                "/jobs/tts",
                {"text": SENTENCE, "language": LANGUAGE, "voice": "", "rate": 1.0, "out_path": str(wav)},
            )
            if not wav.is_file() or wav.stat().st_size <= 44:
                fail("synthesis finished but wrote no audio")
            print(f"synthesized {wav.stat().st_size} bytes")

            sidecar.call("DELETE", f"/models/{LANGUAGE}")
            if LANGUAGE in sidecar.call("GET", "/health")["engines"]:
                fail(f"{LANGUAGE} still listed after delete")
            if (models_dir / LANGUAGE).exists():
                fail(f"{models_dir / LANGUAGE} still on disk after delete")
        finally:
            sidecar.close()

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(
                "### Sidecar smoke test\n\n"
                f"| Measure | Seconds |\n| --- | --- |\n"
                f"| Startup to handshake | {sidecar.startup_seconds:.1f} |\n"
                f"| `/models/status`, {LANGUAGE} installed | {status_seconds:.2f} |\n"
            )
    print("SMOKE PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 6: Document the flag**

In `sidecar/README.md`, under `## Building the frozen binary`, add a paragraph: the frozen binary accepts `--check-espeak`, which phonemizes one word with espeak-ng, prints it as JSON and exits, needing no model and no token; `scripts/smoke_sidecar.py` runs it and then exercises a real install, synthesis and delete against the frozen binary.

- [ ] **Step 7: Run it for real on Linux**

The binary must include Tasks 2, 3 and 7:

```bash
scripts/build-sidecar.sh && uv run --no-project --python 3.12 python scripts/smoke_sidecar.py
```

Expected: `espeak-ng: ...`, `startup: N s`, a status timing, `synthesized N bytes`, then `SMOKE PASSED`. This downloads 114 MB. Keep the printed Linux timings for Task 10.

- [ ] **Step 8: Commit**

```bash
git add sidecar/server.py sidecar/README.md sidecar/tests/test_check_espeak.py scripts/smoke_sidecar.py
git commit -m "test(sidecar): smoke-test a frozen build end to end"
```

---

### Task 8: Build, smoke-test and bundle each target

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: `ci.yml` via `workflow_call` (Task 6); `scripts/build-sidecar.sh` with its stamp (Task 5); `scripts/smoke_sidecar.py` (Task 7).
- Produces: a `Release` workflow; bundles AppImage + deb, NSIS, dmg.

- [ ] **Step 1: Configure the bundles**

In `src-tauri/tauri.conf.json`, inside `"bundle"`:

1. Replace `"targets": "all"` with `"targets": ["appimage", "deb", "nsis", "app", "dmg"]`. Tauri builds only the targets that apply to the host OS.
2. Add:

```json
    "macOS": {
      "signingIdentity": "-"
    },
    "windows": {
      "nsis": {
        "installMode": "currentUser"
      }
    },
```

`currentUser` is already the installed CLI's default; it is set so the no-admin install is visible in the config.

- [ ] **Step 2: Verify the Linux bundles locally**

Run: `bun run tauri build`
Expected: the stamp check passes (Task 7 rebuilt the binary), and `src-tauri/target/release/bundle/appimage/*.AppImage` and `src-tauri/target/release/bundle/deb/*.deb` exist. No `.rpm` is built. If the AppImage step fails for a missing system tool, record the error and the fix in the ledger; do not change the target list.

- [ ] **Step 3: Write the workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags: ["v*"]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  test:
    uses: ./.github/workflows/ci.yml

  build:
    needs: test
    strategy:
      fail-fast: false
      matrix:
        runner: [ubuntu-22.04, windows-latest, macos-latest]
    runs-on: ${{ matrix.runner }}
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v7

      - uses: oven-sh/setup-bun@v2

      - uses: dtolnay/rust-toolchain@stable

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      - uses: astral-sh/setup-uv@v10.2.0
        with:
          enable-cache: true
          cache-dependency-glob: sidecar/uv.lock

      - name: System libraries for Tauri
        if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf xdg-utils

      - run: bun install --frozen-lockfile

      # PyInstaller cannot cross-compile, so each runner freezes its own.
      - name: Freeze the sidecar
        run: scripts/build-sidecar.sh

      - name: Smoke-test the frozen sidecar
        run: uv run --no-project --python 3.12 python scripts/smoke_sidecar.py

      - name: Build and bundle
        uses: tauri-apps/tauri-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tauriScript: bun run tauri
          # Empty on a manual run, so no Release is created.
          tagName: ${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || '' }}
          releaseName: Enisma ${{ github.ref_name }}
          releaseDraft: true
          releaseBody: Unsigned build. See "First launch on Windows and macOS" in the README.

      - name: Keep the bundles
        if: ${{ !startsWith(github.ref, 'refs/tags/') }}
        uses: actions/upload-artifact@v7
        with:
          name: enisma-${{ matrix.runner }}
          if-no-files-found: error
          path: |
            src-tauri/target/release/bundle/appimage/*.AppImage
            src-tauri/target/release/bundle/deb/*.deb
            src-tauri/target/release/bundle/nsis/*.exe
            src-tauri/target/release/bundle/dmg/*.dmg
```

- [ ] **Step 4: Check it parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('ok')"`
Expected: `ok`. Run `actionlint` too if it is on PATH.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml src-tauri/tauri.conf.json
git commit -m "ci: build, smoke-test and bundle Linux, Windows and macOS on a tag"
```

- [ ] **Step 6: Hand over, then iterate**

Tell the maintainer the workflow is ready. After they push, it runs from **Actions → Release → Run workflow**. Expect Windows and macOS to fail at first in `build-sidecar.sh` or the smoke test: PyInstaller's native-library collection was written on Linux. For each failure the maintainer reports (or that `gh run view --log-failed` shows), fix it in a separate `fix(build): …` commit and ask for another run. Repeat until all three targets are green on a manual run. **Do not push, and do not push a tag.** The first tag and publishing its draft Release are the maintainer's.

---

### Task 9: Pure helpers for a language's model state

**Files:**
- Modify: `src/lib/model-state.ts`, `src/lib/model-state.test.ts`, `src/components/editor/model-panel.tsx`

**Interfaces:**
- Consumes: `modelStateFor`, `ModelPanelState` (existing); `ModelStatus` from `@/lib/api`.
- Produces:
  - `export type PrimaryAction = "download" | "resume" | "retry" | "reinstall";`
  - `export function primaryAction(state: ModelPanelState): PrimaryAction | null`
  - `export interface ModelsSnapshot { rows: ModelStatus[] | null; engines: Record<string, unknown> | null; installing: string | null; error: { language: string; message: string } | null }`
  - `export function languageState(s: ModelsSnapshot, language: string): ModelPanelState`
  - `export function canDelete(row: ModelStatus | null, state: ModelPanelState): boolean`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/model-state.test.ts` (merge the import with the file's existing one from `./model-state`):

```ts
import { canDelete, languageState, primaryAction, type ModelsSnapshot } from "./model-state";
import type { ModelStatus } from "./api";

const row = (over: Partial<ModelStatus> = {}): ModelStatus => ({
  language: "am",
  present: false,
  bytes: 114_000_000,
  installedBytes: 0,
  partialBytes: 0,
  ...over,
});

const snap = (over: Partial<ModelsSnapshot> = {}): ModelsSnapshot => ({
  rows: [row()],
  engines: {},
  installing: null,
  error: null,
  ...over,
});

describe("primaryAction", () => {
  it("names the button each resting state offers", () => {
    expect(primaryAction("missing")).toBe("download");
    expect(primaryAction("partial")).toBe("resume");
    expect(primaryAction("error")).toBe("retry");
    expect(primaryAction("unloadable")).toBe("reinstall");
  });

  it("offers nothing while installing or once ready", () => {
    expect(primaryAction("installing")).toBeNull();
    expect(primaryAction("ready")).toBeNull();
  });
});

describe("languageState", () => {
  it("reads a language's row and engine", () => {
    const s = snap({ rows: [row({ present: true, installedBytes: 114_000_000 })], engines: { am: true } });
    expect(languageState(s, "am")).toBe("ready");
  });

  it("trusts the files while engine health is unknown", () => {
    const s = snap({ rows: [row({ present: true })], engines: null });
    expect(languageState(s, "am")).toBe("ready");
  });

  it("shows an install only for the language being installed", () => {
    expect(languageState(snap({ installing: "am" }), "am")).toBe("installing");
    expect(languageState(snap({ installing: "ti" }), "am")).toBe("missing");
  });

  it("shows an error only for the language it belongs to", () => {
    const error = { language: "ti", message: "checksum" };
    expect(languageState(snap({ error }), "am")).toBe("missing");
    expect(languageState(snap({ rows: [row({ language: "ti" })], error }), "ti")).toBe("error");
  });
});

describe("canDelete", () => {
  it("allows deleting anything on disk, finished or partial", () => {
    expect(canDelete(row({ installedBytes: 10 }), "ready")).toBe(true);
    expect(canDelete(row({ partialBytes: 10 }), "partial")).toBe(true);
    expect(canDelete(row({ installedBytes: 10 }), "unloadable")).toBe(true);
  });

  it("offers nothing to delete when nothing is there", () => {
    expect(canDelete(row(), "missing")).toBe(false);
    expect(canDelete(null, "missing")).toBe(false);
  });

  it("never deletes out from under an install", () => {
    expect(canDelete(row({ partialBytes: 10 }), "installing")).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun run test src/lib/model-state.test.ts`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/model-state.ts` (add `import type { ModelStatus } from "./api";` at the top):

```ts
/** The one button a language's resting state offers. */
export type PrimaryAction = "download" | "resume" | "retry" | "reinstall";

/**
 * Which button a state offers, shared by the editor's panel and Settings so
 * the same state is never labelled two ways. None while installing, and none
 * once the language is ready.
 */
export function primaryAction(state: ModelPanelState): PrimaryAction | null {
  switch (state) {
    case "missing":
      return "download";
    case "partial":
      return "resume";
    case "error":
      return "retry";
    case "unloadable":
      return "reinstall";
    default:
      return null;
  }
}

/** Everything the app knows about voice models at one moment. */
export interface ModelsSnapshot {
  /** From `modelStatus()`; null while the sidecar has not answered. */
  rows: ModelStatus[] | null;
  /** From `sidecarHealth().engines`; null while unknown. */
  engines: Record<string, unknown> | null;
  /** The language an install is running for, if any. */
  installing: string | null;
  /** The last failed install and the language it belongs to. */
  error: { language: string; message: string } | null;
}

/**
 * One language's state from the app-wide snapshot.
 *
 * With engine health unknown the files are trusted, rather than accusing a
 * working model of failing to load; a conversion would surface the truth.
 */
export function languageState(s: ModelsSnapshot, language: string): ModelPanelState {
  const row = s.rows?.find((r) => r.language === language) ?? null;
  const present = row?.present ?? false;
  return modelStateFor({
    present,
    partialBytes: row?.partialBytes ?? 0,
    engineUp: s.engines === null ? present : Boolean(s.engines[language]),
    installing: s.installing === language,
    error: s.error?.language === language ? s.error.message : null,
  });
}

/**
 * Whether a language has anything to delete. Partial downloads count, so
 * abandoned scratch files can be cleared too; an install in flight never.
 */
export function canDelete(row: ModelStatus | null, state: ModelPanelState): boolean {
  if (row === null || state === "installing") return false;
  return row.installedBytes + row.partialBytes > 0;
}
```

- [ ] **Step 4: Use `primaryAction` in the editor's panel**

In `src/components/editor/model-panel.tsx`, import `primaryAction` from `@/lib/model-state`, and replace the nested ternary inside the main `<Button onClick={onDownload} ...>` with:

```tsx
          {t(`modelPanel.${primaryAction(state) ?? "download"}`)}
```

The keys `modelPanel.download`, `.resume`, `.retry` and `.reinstall` already exist.

- [ ] **Step 5: Run the suite and the typecheck**

Run: `bun run test && bun run build`
Expected: 212 tests pass; the build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/lib/model-state.ts src/lib/model-state.test.ts src/components/editor/model-panel.tsx
git commit -m "refactor(models): derive a language's state and actions in one place"
```

---

### Task 10: Move model state into an app-wide provider

**Files:**
- Create: `src/components/models/models-provider.tsx`
- Modify: `src/App.tsx`, `src/components/editor/editor.tsx`

**Interfaces:**
- Consumes: `modelStatus`, `acquireModel`, `cancelModelAcquisition`, `removeModel`, `MODEL_INSTALL_CANCELLED`, `ModelStatus` from `@/lib/api`; `sidecarHealth` from `@/lib/platform`; `ModelsSnapshot`, `languageState` from `@/lib/model-state`; `open` from `@tauri-apps/plugin-dialog`.
- Produces: `ModelsProvider` and `useModels(): ModelsCtx` where

```ts
type Install = { language: string; progress: number; cancelling: boolean };
type ModelsCtx = {
  rows: ModelStatus[] | null;
  engines: Record<string, unknown> | null;
  install: Install | null;
  error: { language: string; message: string } | null;
  /** Bumped whenever what is installed may have changed. */
  version: number;
  snapshot: ModelsSnapshot;
  refresh: () => void;
  installModel: (language: string, sourceDir?: string) => Promise<void>;
  installFromFolder: (language: string) => Promise<void>;
  cancelInstall: () => void;
  /** Rejects with the backend's untranslated message. */
  removeLanguage: (language: string) => Promise<void>;
};
```

- [ ] **Step 1: Create the provider**

Create `src/components/models/models-provider.tsx`:

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  acquireModel,
  cancelModelAcquisition,
  MODEL_INSTALL_CANCELLED,
  modelStatus,
  removeModel,
  type ModelStatus,
} from "@/lib/api";
import type { ModelsSnapshot } from "@/lib/model-state";
import { sidecarHealth } from "@/lib/platform";

type Install = { language: string; progress: number; cancelling: boolean };

type ModelsCtx = {
  rows: ModelStatus[] | null;
  engines: Record<string, unknown> | null;
  install: Install | null;
  error: { language: string; message: string } | null;
  version: number;
  snapshot: ModelsSnapshot;
  refresh: () => void;
  installModel: (language: string, sourceDir?: string) => Promise<void>;
  installFromFolder: (language: string) => Promise<void>;
  cancelInstall: () => void;
  removeLanguage: (language: string) => Promise<void>;
};

const ModelsContext = createContext<ModelsCtx | null>(null);

export function useModels(): ModelsCtx {
  const ctx = useContext(ModelsContext);
  if (!ctx) throw new Error("useModels outside ModelsProvider");
  return ctx;
}

/**
 * Voice-model state for the whole app. Mounted at the root because an install
 * outlives the screen it was started from: one begun in a book keeps running
 * when the user goes back to Home, and Settings has to show it — and one begun
 * in Settings has to show in the book it was for.
 */
export function ModelsProvider({ children }: { children: React.ReactNode }) {
  const [rows, setRows] = useState<ModelStatus[] | null>(null);
  // Null while unknown: the sidecar rejects with "sidecar starting" during a
  // restart, and treating that as "no engines" would flash a load-failure
  // warning over a model that is perfectly fine.
  const [engines, setEngines] = useState<Record<string, unknown> | null>(null);
  const [install, setInstall] = useState<Install | null>(null);
  const [error, setError] = useState<{ language: string; message: string } | null>(null);
  const [version, setVersion] = useState(0);
  // The install in flight, readable synchronously so a double click cannot
  // start two and Cancel always names the right language.
  const installingRef = useRef<string | null>(null);

  const refresh = useCallback(() => {
    if (!isTauri()) return;
    // Two questions with two answers: what is on disk, and what actually
    // loaded. A model can verify and still fail to load.
    modelStatus().then(setRows, (e: unknown) => {
      console.error(e);
      setRows(null);
    });
    sidecarHealth().then(
      (h) => setEngines(h.engines ?? {}),
      () => setEngines(null),
    );
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<{ language: string; progress: number }>("models://progress", (e) => {
      setInstall((cur) =>
        cur && cur.language === e.payload.language ? { ...cur, progress: e.payload.progress } : cur,
      );
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const settled = useCallback(() => {
    // Whatever happened, what is on disk has moved: a cancel leaves resumable
    // bytes, a success brings the language up, a delete takes it away.
    refresh();
    setVersion((n) => n + 1);
  }, [refresh]);

  const installModel = useCallback(
    async (language: string, sourceDir?: string) => {
      if (installingRef.current !== null) return;
      installingRef.current = language;
      setError((cur) => (cur?.language === language ? null : cur));
      setInstall({ language, progress: 0, cancelling: false });
      try {
        await acquireModel(language, sourceDir);
      } catch (e: unknown) {
        const message = String(e);
        // A cancellation is an outcome the user asked for, not a failure.
        if (message !== MODEL_INSTALL_CANCELLED) setError({ language, message });
      } finally {
        installingRef.current = null;
        setInstall(null);
        settled();
      }
    },
    [settled],
  );

  const installFromFolder = useCallback(
    async (language: string) => {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string") await installModel(language, picked);
    },
    [installModel],
  );

  const cancelInstall = useCallback(() => {
    const language = installingRef.current;
    if (language === null) return;
    // Optimistic, as a conversion's cancel is: the request is what the user
    // performed. `installModel`'s `finally` is what ends the install.
    setInstall((cur) => (cur ? { ...cur, cancelling: true } : cur));
    cancelModelAcquisition(language).catch((e: unknown) => {
      console.error(e);
      setInstall((cur) => (cur ? { ...cur, cancelling: false } : cur));
    });
  }, []);

  const removeLanguage = useCallback(
    async (language: string) => {
      try {
        await removeModel(language);
        setError((cur) => (cur?.language === language ? null : cur));
      } finally {
        settled();
      }
    },
    [settled],
  );

  const snapshot = useMemo<ModelsSnapshot>(
    () => ({ rows, engines, installing: install?.language ?? null, error }),
    [rows, engines, install?.language, error],
  );

  const value = useMemo<ModelsCtx>(
    () => ({
      rows,
      engines,
      install,
      error,
      version,
      snapshot,
      refresh,
      installModel,
      installFromFolder,
      cancelInstall,
      removeLanguage,
    }),
    [rows, engines, install, error, version, snapshot, refresh, installModel, installFromFolder, cancelInstall, removeLanguage],
  );

  return <ModelsContext.Provider value={value}>{children}</ModelsContext.Provider>;
}
```

- [ ] **Step 2: Mount it**

In `src/App.tsx`, import `ModelsProvider` from `@/components/models/models-provider` and wrap `ExportProvider`:

```tsx
        <AppCommandsProvider>
          <ModelsProvider>
            <ExportProvider>
              {/* unchanged children */}
            </ExportProvider>
          </ModelsProvider>
        </AppCommandsProvider>
```

- [ ] **Step 3: Move the editor onto it**

In `src/components/editor/editor.tsx`:

1. Delete these, which the provider now owns: the `modelRows`, `engines`, `installing`, `installCancelling`, `installProgress` and `installError` states; `installingLanguageRef`; `refreshModels` (keep its explanatory comment's substance in the provider — already done above); the `models://progress` listener effect; the effect that clears `installError` on a language switch; `runAcquire`; `pickModelFolder`; `requestInstallCancel`; and the `modelsVersion` state (keep the comment above it, moved to where `models.version` is used). Remove imports left unused: `acquireModel`, `cancelModelAcquisition`, `modelStatus`, `MODEL_INSTALL_CANCELLED`, `ModelStatus` (if unused), `open` from the dialog plugin (if now unused — it may still be used elsewhere in the file; check), `modelStateFor`, and `sidecarHealth` (if now unused; check).

2. Add near the top of the component body:

```tsx
  const models = useModels();
```

with `import { useModels } from "@/components/models/models-provider";` and `import { languageState } from "@/lib/model-state";`.

3. Keep refreshing when the book's language changes:

```tsx
  useEffect(() => {
    models.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh is stable
  }, [language]);
```

(Omit the eslint comment if the project has no eslint config.)

4. In the voice-list effect's dependency list, replace `modelsVersion` with `models.version`.

5. Replace the `modelRow` memo and `modelState` computation with:

```tsx
  const modelRow = useMemo(
    () => models.rows?.find((m) => m.language === language) ?? null,
    [models.rows, language],
  );

  // Status unknown — the sidecar is down or restarting — is not evidence that
  // a model is missing. Claiming it is would replace Convert with a Download
  // button sized in blanks, over a language that may well be installed. Let
  // Convert be offered and fail with the real reason instead. An install in
  // flight is exempt: the panel must not vanish out from under it.
  const modelState =
    models.rows === null && models.install === null ? "ready" : languageState(models.snapshot, language);
  const installHere = models.install?.language === language ? models.install : null;
```

6. Replace the `model={{ ... }}` prop passed to the settings panel with:

```tsx
              model={{
                state: modelState,
                status: modelRow,
                progress: installHere?.progress ?? 0,
                error: models.error?.language === language ? models.error.message : null,
                cancelling: installHere?.cancelling ?? false,
                onDownload: () => void models.installModel(language),
                onImport: () => void models.installFromFolder(language),
                onCancel: models.cancelInstall,
              }}
```

Behaviour note: the editor's `ModelPanel` receives `state: "installing"` only for its own language (via `languageState`). While another language installs, this book's panel shows its resting state, and pressing Download there is refused by the provider's guard, as the Rust slot would refuse it anyway.

- [ ] **Step 4: Typecheck and test**

Run: `bun run build && bun run test`
Expected: build succeeds with no unused-import errors; 212 tests pass.

- [ ] **Step 5: Drive the app**

Run `bun run tauri dev` and verify, with a book whose language is not installed:
- the editor's panel offers Download; starting it shows progress; Cancel stops it and the panel offers Resume;
- Resume completes; Convert appears without a restart; for English the voice list fills in.

If the app cannot be driven from this session, say exactly what is missing and list only these checks for the maintainer.

- [ ] **Step 6: Commit**

```bash
git add src/components/models/models-provider.tsx src/App.tsx src/components/editor/editor.tsx
git commit -m "refactor(models): hold voice-model state app-wide instead of in the editor"
```

---

### Task 11: Settings → Voices

**Files:**
- Create: `src/components/settings/voices-section.tsx`, `src/components/settings/delete-voice-dialog.tsx`
- Modify: `src/components/settings/settings-dialog.tsx`, `src/locales/en.json`, `src/locales/am.json`, `src/locales/ti.json`, `src/locales/om.json`, `docs/translations-needing-review.md`

**Interfaces:**
- Consumes: `useModels()` (Task 10); `languageState`, `primaryAction`, `canDelete`, `formatBytes`, `installedFraction` from `@/lib/model-state`; `LANGUAGES`, `languageLabelKey` from `@/lib/languages`; existing `modelPanel.*` strings.
- Produces: `VoicesSection` (no props); `DeleteVoiceDialog({ language, size, onClose })`.

- [ ] **Step 1: Add the English strings**

In `src/locales/en.json`, inside `"settings"` after `"notTranslated"`, add:

```json
    "voices": { "message": "Voices", "context": "Small uppercase section heading above the list of voice models, one per textbook language." },
    "voicesUnavailable": { "message": "Voices can't be listed until the app has finished starting.", "context": "Shown in place of the voice list while the background engine is starting or restarting." },
    "voiceInstalled": { "message": "Installed · {size}", "context": "Status line under a language name when its voice is installed. {size} is a size such as '114 MB'." },
    "voiceMissing": { "message": "Not installed · {size} download", "context": "Status line when a language's voice is not installed. {size} is the download size such as '114 MB'." },
    "voicePartial": { "message": "{already} of {total} downloaded", "context": "Status line when an earlier download stopped part-way. {already} and {total} are sizes such as '40 MB'." },
    "voiceUnloadable": { "message": "Installed, but could not be loaded", "context": "Status line when the voice files are present but the engine failed to load them." },
    "voiceInstalling": { "message": "Installing… {percent}%", "context": "Status line while a voice downloads or is copied in. {percent} is a whole number 0-100." },
    "voiceDelete": { "message": "Delete", "context": "Button that deletes an installed or partly downloaded voice, to free disk space." }
```

Add a new top-level group after `"deleteProject"`:

```json
  "deleteVoice": {
    "title": { "message": "Delete voice?", "context": "Title of the dialog confirming that a language's voice model will be deleted." },
    "body": { "message": "Delete the {language} voice ({size})? Audio you've already made keeps playing; making new audio in {language} will need it again.", "context": "Dialog body. {language} is a language name, {size} a size such as '114 MB'. 'Making new audio' means converting pages or exporting." },
    "cancel": { "message": "Cancel", "context": "Closes the dialog without deleting." },
    "confirm": { "message": "Delete", "context": "Deletes the voice model." }
  },
```

- [ ] **Step 2: Translate them**

Add the same eight `settings.*` keys and the `deleteVoice` group to `am.json`, `ti.json` and `om.json`, following `_meta.rules` in `en.json`: translate `message`, copy `context` unchanged, keep every `{placeholder}` name. Reuse the terms these catalogues already use for "voice", "install", "download" and "delete" (see their `modelPanel` and `deleteProject` entries) so the new strings match.

Run: `bun run test src/lib/i18n.test.ts`
Expected: PASS, including the catalogue parity test.

In `docs/translations-needing-review.md`, add `## M6 voice management strings (2026-09-25)`, say these were written by Claude and need a native read, and add a table in the file's existing columns (`Key | English | Amharic | Tigrigna | Oromo`), one row per new key. Put anything you were unsure of under a "Priority" note at the top of the section, with the reason.

- [ ] **Step 3: The delete dialog**

Create `src/components/settings/delete-voice-dialog.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useModels } from "@/components/models/models-provider";
import { languageLabelKey } from "@/lib/languages";

/**
 * Confirm deleting a language's voice model.
 *
 * The body says plainly what is and is not lost: audio already made is plain
 * WAV and keeps playing, and only making new audio needs the model again.
 * Without that, deleting reads as though it might take the user's work with it.
 */
export function DeleteVoiceDialog({
  language,
  size,
  onClose,
}: {
  language: string;
  /** Already formatted, e.g. "114 MB". */
  size: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { removeLanguage } = useModels();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = t(languageLabelKey(language));

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await removeLanguage(language);
      onClose();
    } catch (e) {
      // The backend's own words, untranslated: "in use", or what is running.
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="grid-cols-1 sm:max-w-120">
        <DialogHeader>
          <DialogTitle className="font-serif">{t("deleteVoice.title")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            {t("deleteVoice.body", { language: name, size })}
          </p>
          {error && (
            <div className="rounded-md border border-line bg-paper-2 px-3 py-2 text-[12.5px] text-amber-ink">
              {error}
            </div>
          )}
        </div>
        <DialogFooter className="border-t-0">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("deleteVoice.cancel")}
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={busy}>
            {t("deleteVoice.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: The Voices section**

Create `src/components/settings/voices-section.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderInput, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useModels } from "@/components/models/models-provider";
import { LANGUAGES, languageLabelKey } from "@/lib/languages";
import {
  canDelete,
  formatBytes,
  installedFraction,
  languageState,
  primaryAction,
} from "@/lib/model-state";
import { DeleteVoiceDialog } from "./delete-voice-dialog";

/**
 * One row per textbook language: what its voice model has on disk, and the
 * few things that can be done about it. The editor offers the same install
 * next to Convert; this is where a model can be looked after without opening
 * a book in that language, and the only place one can be deleted.
 */
export function VoicesSection() {
  const { t } = useTranslation();
  const models = useModels();
  const [deleting, setDeleting] = useState<{ language: string; size: string } | null>(null);

  if (models.rows === null) {
    return <p className="m-0 text-[12.5px] text-ink-3">{t("settings.voicesUnavailable")}</p>;
  }

  // One install at a time, app-wide: the backend has a single slot for it.
  const busy = models.install !== null;

  return (
    <>
      <div className="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface">
        {LANGUAGES.map(({ code }) => {
          const row = models.rows?.find((r) => r.language === code) ?? null;
          if (row === null) return null;
          const state = languageState(models.snapshot, code);
          const action = primaryAction(state);
          const onDisk = formatBytes(row.installedBytes + row.partialBytes);
          const installing = models.install?.language === code ? models.install : null;
          const fraction = installing
            ? installing.progress > 0
              ? installing.progress
              : installedFraction(row)
            : 0;

          return (
            <div key={code} className="flex items-center gap-3 px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium text-ink">{t(languageLabelKey(code))}</div>
                <div className="mt-0.5 text-[11.5px] text-ink-3">
                  {state === "installing" &&
                    t("settings.voiceInstalling", { percent: Math.round(fraction * 100) })}
                  {state === "ready" && t("settings.voiceInstalled", { size: formatBytes(row.bytes) })}
                  {state === "missing" && t("settings.voiceMissing", { size: formatBytes(row.bytes) })}
                  {state === "partial" &&
                    t("settings.voicePartial", { already: onDisk, total: formatBytes(row.bytes) })}
                  {state === "unloadable" && (
                    <span className="text-amber-ink">{t("settings.voiceUnloadable")}</span>
                  )}
                  {/* The backend's own words, deliberately untranslated. */}
                  {state === "error" && models.error && (
                    <span className="text-amber-ink">
                      {t("modelPanel.failed", { error: models.error.message })}
                    </span>
                  )}
                </div>
                {state === "installing" && (
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-line-2">
                    <div
                      className="h-full rounded-full bg-teal transition-[width] duration-300"
                      style={{ width: `${Math.round(fraction * 100)}%` }}
                    />
                  </div>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                {installing ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={models.cancelInstall}
                    disabled={installing.cancelling}
                  >
                    {t(installing.cancelling ? "modelPanel.cancelling" : "modelPanel.cancel")}
                  </Button>
                ) : (
                  <>
                    {action && (
                      <Button size="sm" onClick={() => void models.installModel(code)} disabled={busy}>
                        {t(`modelPanel.${action}`)}
                      </Button>
                    )}
                    {state !== "ready" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void models.installFromFolder(code)}
                        disabled={busy}
                        title={t("modelPanel.importTooltip")}
                      >
                        <FolderInput />
                        {t("modelPanel.import")}
                      </Button>
                    )}
                    {canDelete(row, state) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleting({ language: code, size: onDisk })}
                        aria-label={t("settings.voiceDelete")}
                        title={t("settings.voiceDelete")}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {deleting && (
        <DeleteVoiceDialog
          language={deleting.language}
          size={deleting.size}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
```

Note: "Install from folder" is hidden once a language is ready (nothing to install); it stays for missing, partial, error and unloadable, where it doubles as the offline Reinstall.

- [ ] **Step 5: Place it in Settings**

In `src/components/settings/settings-dialog.tsx`, import `VoicesSection` from `./voices-section`, and after the Language `<Section>` add:

```tsx
          <Section title={t("settings.voices")}>
            <VoicesSection />
          </Section>
```

Also call `refresh` when the dialog opens, so the list is current: add `const { refresh } = useModels();` and

```tsx
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);
```

(import `useEffect` from `react` and `useModels` from `@/components/models/models-provider`).

- [ ] **Step 6: Typecheck and test**

Run: `bun run build && bun run test`
Expected: build succeeds; 212 tests pass.

- [ ] **Step 7: Drive the app**

Run `bun run tauri dev`, open Settings from Home, and verify:
1. Four rows, each with a correct state and size.
2. Download a missing MMS language: progress shows; Cancel stops it and the row offers Resume with the partial size; Resume completes and the row reads Installed.
3. While one installs, every other row's install buttons are disabled.
4. Start a download in a book's editor, go back to Home, open Settings: the same install shows with its progress.
5. Delete the language: the confirmation names it and its size; after confirming, the row reads Not installed, and opening a book in that language offers Download.
6. Start converting a page in that language, then try to delete it from Settings: the dialog shows the refusal message and nothing is deleted.
7. Install from folder with a folder holding that language's files: it installs.

If the app cannot be driven from this session, say exactly what is missing, report what was verified by tests, and list only the remaining checks for the maintainer.

- [ ] **Step 8: Commit**

```bash
git add src/components/settings src/locales docs/translations-needing-review.md
git commit -m "feat(settings): download, install, cancel and delete each language's voice"
```

---

### Task 12: Docs and results

**Files:**
- Modify: `README.md`, `AGENTS.md`, `docs/implementation-plan.md`, `docs/superpowers/specs/2026-09-25-m6-download-packaging-design.md`

**Interfaces:**
- Consumes: everything above; the Linux timings from Task 7 Step 7; any Windows/macOS timings from the job summaries the maintainer shares.

- [ ] **Step 1: README**

Add a `## First launch on Windows and macOS` section. Windows: the installer is unsigned, so SmartScreen shows "Windows protected your PC"; choose **More info → Run anyway** once. macOS: the app is ad-hoc signed, not notarized; after the first blocked launch, open **System Settings → Privacy & Security** and choose **Open Anyway**.

Add a `## Releasing` section: bump the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`; commit; push a `v<version>` tag; wait for the Release workflow; review and publish the draft Release. A manual run from Actions builds the same bundles as run artifacts without a Release. Note that `bun run tauri build` refuses a sidecar built from different sources and names `scripts/build-sidecar.sh` as the fix.

- [ ] **Step 2: AGENTS.md → Current state**

Replace the sentence "`bun run tauri build` does not rebuild the sidecar — run `scripts/build-sidecar.sh` first, or the bundle ships whatever binary is already in `src-tauri/binaries/`." with: `bun run tauri build` refuses to bundle a sidecar whose stamp does not match the sources (`scripts/sidecar-stamp.ts`); run `scripts/build-sidecar.sh` to rebuild it. Releases are built by `.github/workflows/release.yml` for Linux x64, Windows x64 and macOS arm64, unsigned.

In the **Models** bullet, add: URLs are pinned to commit revisions; a download whose connection drops after bytes have arrived retries three times (2 s, 8 s, 30 s), resetting on progress; Settings → Voices downloads, installs from a folder, cancels and deletes each language (`DELETE /models/{language}`, refused while that language is installing, converting or exporting). Change "M6 download completion plus packaging remains" in the Current state intro to say all milestones are done.

- [ ] **Step 3: Implementation plan**

In `docs/implementation-plan.md` §7, rewrite "Still open for M6" as "Built in M6", summarising: commit-pinned URLs; retry on a dropped connection; delete a language; the stale-sidecar stamp; CI and release workflows for three targets; the smoke test; startup measured. Correct the stale "21 MB binary dated 16 June" claim (it had been replaced by a current 161 MB build by 2026-09-25; the gap was the missing guard, now closed). Keep "Surviving a restart mid-download" and "Resuming on launch" as deliberately not done. Check off M6 in the Milestones list with a link to the M6 spec. Update the header note so it no longer says M6 remains.

- [ ] **Step 4: Spec status, deviations and results**

In the M6 spec: set **Status** to implemented. Add a "Deviations from this design, found during implementation" list under the status block, including at least: the "to verify" item about the export voice was resolved during planning — `reconcileVoice` already keeps the stored voice when the list is empty, so no change was needed; and any fixes Task 8's iteration required. Fill in **Results** with the startup and `/models/status` timings per OS (Linux from Task 7; Windows and macOS from the job summaries, or "not yet measured — awaiting the first green Release run" if the maintainer has not shared them).

- [ ] **Step 5: Run every suite once more**

Run: `bun run test && bun run build && (cd src-tauri && cargo test 2>&1 | grep "test result") && (cd sidecar && uv run pytest -q | tail -1)`
Expected: 212 frontend, 130 Rust, 149 sidecar, all passing.

- [ ] **Step 6: Commit**

```bash
git add README.md AGENTS.md docs/implementation-plan.md docs/superpowers/specs/2026-09-25-m6-download-packaging-design.md
git commit -m "docs: record M6 download completion and packaging as built"
```
