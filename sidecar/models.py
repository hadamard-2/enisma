"""Model locations, the download manifest, and integrity checks.

`fetch` is the single place in this product that touches the network. Every
other path — OCR, synthesis, export — runs entirely on-device, and
`install_from_dir` is the route for a machine that has no usable connection at
all: the same files, carried in on a stick and verified against the same hashes.

Retry is deliberately narrow: a connection that drops after bytes have started
arriving is retried a few times within one download, because that is a blip
the user should never have to see. Nothing is retried across launches, and a
machine that is offline from the start is told so at once. Gating project
creation on model presence is also not here.
"""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import re
import shutil
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

_HERE = Path(__file__).parent
MODELS_ROOT = Path(os.environ.get("ENISMA_MODELS_DIR", _HERE / "models"))

# Applied to the connection and to every read. Without it a stalled socket
# blocks the job thread forever, and because a wedged job never reaches a
# terminal state there is nothing left that can clear it but restarting the
# app. Generous enough to survive a slow link, short enough to end a dead one.
TIMEOUT_SECONDS = 30

# Cancel and progress are both checked once per chunk, so this is really a
# responsiveness budget: on a 100 KB/s link 256 KiB is a check every ~2.5s.
_CHUNK = 1024 * 256

# Waits before each retry of a connection that dropped mid-download: about 40
# seconds in all, enough for a Wi-Fi reconnect or a router hiccup and short
# enough that nobody stares at a stuck bar for minutes. The count resets
# whenever an attempt receives bytes, so separate blips across a long download
# do not add up to a failure.
RETRY_DELAYS: tuple[float, ...] = (2, 8, 30)

# How often a retry wait asks whether to keep going. Keeps Cancel as prompt
# during a wait as it is between chunks.
_WAIT_STEP = 0.25

OnProgress = Callable[[str, float], None]
# Asked between chunks whether to keep going. Default: always.
ShouldContinue = Callable[[], bool]


class Cancelled(Exception):
    """The caller asked for a stop, and got one at the next chunk boundary.

    Distinct from a failure: the partial download is deliberately kept, so
    asking again resumes rather than starting the file over.
    """


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


def manifest() -> dict:
    return json.loads((_HERE / "models.json").read_text())


def files_for(language: str) -> list[dict]:
    m = manifest()
    entries = list(m["languages"][language])
    if language == "en":
        v = m["voices"]
        for name in v["names"]:
            entries.append({
                "url": v["url_template"].format(name=name),
                "path": v["path_template"].format(name=name),
                "size": v["size"],
                "sha256": v["sha256"][name],
            })
    return entries


def model_dir(language: str) -> str:
    return str(MODELS_ROOT / language)


def verify(path: str, sha256: str) -> bool:
    p = Path(path)
    if not p.is_file():
        return False
    if not sha256:
        return p.stat().st_size > 0
    h = hashlib.sha256()
    with p.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest() == sha256


def status() -> dict[str, dict]:
    """What each language has on disk, and what it would cost to get it.

    `bytes` is the manifest's own total for the language, so the caller can
    offer "114 MB" without keeping a second copy of the figures. `partial` is
    what makes a resumed download legible: a language that is neither absent
    nor present has scratch files a retry would continue from.
    """
    out = {}
    for lang in manifest()["languages"]:
        entries = files_for(lang)
        installed = 0
        pending = 0
        for e in entries:
            target = MODELS_ROOT / e["path"]
            if verify(str(target), e["sha256"]):
                installed += e["size"]
                continue
            part = target.with_suffix(target.suffix + ".part")
            if part.is_file():
                pending += part.stat().st_size
        out[lang] = {
            "present": installed == sum(e["size"] for e in entries),
            "bytes": sum(e["size"] for e in entries),
            "installedBytes": installed,
            "partialBytes": pending,
        }
    return out


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


def _always() -> bool:
    return True


# The host advertises its limits per the IETF `RateLimit` draft, as
# `"resolvers";r=0;t=148` — `t` being the seconds until the window resets.
_RESET_SECONDS = re.compile(r"\bt=(\d+)")


def rate_limit_wait(headers) -> int | None:
    """Seconds until a rate limit clears, or None if the host did not say.

    Reads the `RateLimit` header first and falls back to the older standard
    `Retry-After`. Both are optional in practice, so every caller has to cope
    with not being told.
    """
    raw = headers.get("RateLimit")
    if raw:
        match = _RESET_SECONDS.search(raw)
        if match:
            return int(match.group(1))
    retry = (headers.get("Retry-After") or "").strip()
    return int(retry) if retry.isdigit() else None


def describe_wait(seconds: int | None) -> str:
    """How long to wait, in words, for someone staring at a stalled download.

    Rounded deliberately: the exact second is noise next to the decision the
    reader is actually making, which is whether to wait or walk away. The 90s
    boundary also keeps minutes plural, so there is no "1 minutes" to special
    case.
    """
    if seconds is None:
        return "Wait a few minutes and try again."
    if seconds >= 90:
        return f"Try again in about {round(seconds / 60)} minutes."
    return f"Try again in about {max(seconds, 1)} seconds."


def _install(part: Path, target: Path, sha256: str) -> None:
    """Promote a verified scratch file, or destroy it.

    The checksum is the only thing standing between a resumed download and a
    silently corrupt model, so a mismatch takes the scratch file with it:
    keeping it would make every later resume append to bytes already known to
    be wrong.
    """
    if not verify(str(part), sha256):
        part.unlink(missing_ok=True)
        raise RuntimeError(f"downloaded {target.name} failed its checksum; not installing it")
    shutil.move(str(part), str(target))


def fetch(
    language: str,
    on_progress: OnProgress,
    should_continue: ShouldContinue | None = None,
) -> None:
    """Download a language's files, verifying each before it lands.

    Downloads to `<path>.part` and renames only after the hash matches, so a
    model directory is never left half-populated for the engine to load.

    A `.part` left by an earlier attempt is resumed with a Range request rather
    than restarted. That is the difference between 329 MB being achievable and
    not on a connection that drops, and it is safe precisely because the
    checksum still gates installation: resumed bytes that do not add up are
    discarded exactly like corrupt ones.
    """
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


def install_from_dir(
    language: str,
    source_dir: str,
    on_progress: OnProgress,
    should_continue: ShouldContinue | None = None,
) -> None:
    """Install one language from a folder the user already has.

    For a machine with no usable connection, which is the case the offline-first
    design exists for. The files are verified against the same manifest hashes
    as a download, so a stick carrying the wrong build is refused rather than
    installed and then failing to load.

    Both layouts a stick is likely to use are accepted: the manifest's own
    nesting (`am/model.onnx`) and a flat folder of the files themselves
    (`model.onnx`), because the user has already said which language this is.
    """
    keep_going = should_continue or _always
    source = Path(source_dir)
    entries = files_for(language)
    total = sum(e["size"] for e in entries) or 1
    done = 0

    found = []
    missing = []
    for entry in entries:
        candidates = [source / entry["path"], source / Path(entry["path"]).name]
        match = next((c for c in candidates if c.is_file()), None)
        if match is None:
            missing.append(Path(entry["path"]).name)
        else:
            found.append((entry, match))

    if missing:
        # Named rather than counted: the user is looking at a file manager and
        # needs to know which files to go back for.
        raise RuntimeError(
            f"{source} is missing {len(missing)} file(s) for {language}: "
            f"{', '.join(sorted(missing))}"
        )

    for entry, match in found:
        if not keep_going():
            raise Cancelled()
        target = MODELS_ROOT / entry["path"]
        if verify(str(target), entry["sha256"]):
            done += entry["size"]
            on_progress(entry["path"], min(done / total, 1.0))
            continue

        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_suffix(target.suffix + ".part")
        # Copied to the same scratch path a download uses, so verification and
        # promotion are one code path and an interrupted copy leaves the same
        # recognisable debris.
        shutil.copyfile(match, part)
        _install(part, target, entry["sha256"])
        done += entry["size"]
        on_progress(entry["path"], min(done / total, 1.0))
