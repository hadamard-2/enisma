"""Model locations, the download manifest, and integrity checks.

This is the slice of M6 that M4 needs and no more. Deliberately NOT here:
HTTP range resumption, retry with backoff, surviving an app restart mid-download,
and gating project creation on model presence.

`fetch` is the single place in this product that touches the network. Every
other path — OCR, synthesis, export — runs entirely on-device.
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

OnProgress = Callable[[str, float], None]


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


def status() -> dict[str, bool]:
    """Which languages are fully present and verified on disk."""
    out = {}
    for lang in manifest()["languages"]:
        out[lang] = all(
            verify(str(MODELS_ROOT / e["path"]), e["sha256"]) for e in files_for(lang)
        )
    return out


def fetch(language: str, on_progress: OnProgress) -> None:
    """Download a language's files, verifying each before it lands.

    Downloads to `<path>.part` and renames only after the hash matches, so a
    model directory is never left half-populated for the engine to load.
    """
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
        try:
            with urllib.request.urlopen(entry["url"]) as response, part.open("wb") as out:
                while chunk := response.read(1024 * 256):
                    out.write(chunk)
                    done += len(chunk)
                    on_progress(entry["path"], min(done / total, 1.0))

            if not verify(str(part), entry["sha256"]):
                raise RuntimeError(
                    f"downloaded {entry['path']} failed its checksum; not installing it"
                )
        except BaseException:
            # Any exit but success leaves no scratch file behind, so a retry
            # starts clean rather than appending to a truncated download.
            part.unlink(missing_ok=True)
            raise

        shutil.move(str(part), str(target))
