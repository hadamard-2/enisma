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
