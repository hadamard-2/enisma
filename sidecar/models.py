"""Model locations, the download manifest, and integrity checks.

`fetch` is the single place in this product that touches the network. Every
other path — OCR, synthesis, export — runs entirely on-device, and
`install_from_dir` is the route for a machine that has no usable connection at
all: the same files, carried in on a stick and verified against the same hashes.

Deliberately NOT here: retry with backoff, and gating project creation on model
presence. A download that stops is resumed by asking for it again, not by this
module deciding on its own when to try.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import urllib.request
from pathlib import Path
from typing import Callable

_HERE = Path(__file__).parent
MODELS_ROOT = Path(os.environ.get("HEARBOOK_MODELS_DIR", _HERE / "models"))

# Applied to the connection and to every read. Without it a stalled socket
# blocks the job thread forever, and because a wedged job never reaches a
# terminal state there is nothing left that can clear it but restarting the
# app. Generous enough to survive a slow link, short enough to end a dead one.
TIMEOUT_SECONDS = 30

# Cancel and progress are both checked once per chunk, so this is really a
# responsiveness budget: on a 100 KB/s link 256 KiB is a check every ~2.5s.
_CHUNK = 1024 * 256

OnProgress = Callable[[str, float], None]
# Asked between chunks whether to keep going. Default: always.
ShouldContinue = Callable[[], bool]


class Cancelled(Exception):
    """The caller asked for a stop, and got one at the next chunk boundary.

    Distinct from a failure: the partial download is deliberately kept, so
    asking again resumes rather than starting the file over.
    """


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


def _always() -> bool:
    return True


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

    for entry in entries:
        target = MODELS_ROOT / entry["path"]
        if verify(str(target), entry["sha256"]):
            done += entry["size"]
            on_progress(entry["path"], min(done / total, 1.0))
            continue

        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_suffix(target.suffix + ".part")
        have = part.stat().st_size if part.is_file() else 0

        request = urllib.request.Request(entry["url"])
        if have:
            request.add_header("Range", f"bytes={have}-")

        # No cleanup handler: every exit but success deliberately leaves the
        # scratch file in place, because that is what the next attempt resumes
        # from — a cancel and a dropped connection alike. Only a checksum
        # failure destroys it, in `_install`.
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            # 206 means the server honoured the Range and is sending the
            # remainder. Anything else — a 200, or a file:// URL, which has no
            # status at all — is the whole file again, so the scratch file
            # starts over rather than being appended to.
            resuming = getattr(response, "status", None) == 206
            if not resuming:
                have = 0
            done += have
            on_progress(entry["path"], min(done / total, 1.0))

            with part.open("ab" if resuming else "wb") as out:
                while chunk := response.read(_CHUNK):
                    if not keep_going():
                        raise Cancelled()
                    out.write(chunk)
                    done += len(chunk)
                    on_progress(entry["path"], min(done / total, 1.0))

        _install(part, target, entry["sha256"])


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
