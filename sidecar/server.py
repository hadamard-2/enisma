"""HearBook/Enisma sidecar — M0 harness.

A minimal FastAPI server that the Rust/Tauri core spawns and supervises. It
binds to an ephemeral loopback port, prints a one-line JSON handshake to stdout
once it is actually listening, and serves a single token-guarded ``/health``
route. No OCR/TTS engines yet — those land in later milestones. The empty
``engines`` map in the health response is the forward-compatible slot they fill.

See README.md for the full harness contract (env vars + handshake format).
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
import threading

import uvicorn
from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

TOKEN_ENV = "HEARBOOK_SIDECAR_TOKEN"
HOST_ENV = "HEARBOOK_SIDECAR_HOST"

# The bearer token is supplied per-spawn by the Rust supervisor via the
# environment (never argv, which is visible in process listings).
_token = os.environ.get(TOKEN_ENV, "")
_bearer = HTTPBearer(auto_error=False)


def _require_token(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> None:
    """Reject any request whose bearer token doesn't match the spawn token."""
    supplied = creds.credentials if creds else ""
    if not _token or not secrets.compare_digest(supplied, _token):
        raise HTTPException(status_code=401, detail="invalid or missing bearer token")


app = FastAPI(title="HearBook sidecar", version="0")


@app.get("/health")
def health(_: None = Depends(_require_token)) -> dict:
    return {"status": "ok", "version": "0", "engines": {}}


def _watch_stdin_eof() -> None:
    """Exit when stdin closes — i.e. when the supervising app goes away.

    The Rust supervisor holds the write end of our stdin pipe. When the app
    exits (gracefully or by crash) that end closes and our read returns EOF, so
    we never outlive it. This is the load-bearing anti-orphan mechanism: in dev
    we run under ``uv`` and when frozen under the PyInstaller bootloader, so the
    real Python process is a *grandchild* of the app — killing the intermediate
    process alone would orphan us, but the inherited stdin pipe still EOFs.
    """
    try:
        while sys.stdin.buffer.read(1) != b"":
            pass
    except Exception:  # noqa: BLE001 - stdin gone is itself the exit signal
        pass
    os._exit(0)


def _emit(payload: dict) -> None:
    """Write one JSON handshake line to stdout and flush immediately.

    The explicit flush matters for the PyInstaller-frozen binary, whose stdout
    is block-buffered by default; without it the supervisor would never see the
    line until the process exits.
    """
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


async def _serve() -> None:
    host = os.environ.get(HOST_ENV, "127.0.0.1")
    config = uvicorn.Config(app, host=host, port=0, log_level="warning")
    server = uvicorn.Server(config)

    serve_task = asyncio.create_task(server.serve())

    # Wait until uvicorn has bound the socket and finished startup before we
    # report the port — otherwise the supervisor could race a not-yet-listening
    # socket. `server.started` flips True only after the bind + lifespan startup.
    while not server.started:
        if serve_task.done():
            await serve_task  # re-raise whatever killed it
            raise RuntimeError("sidecar exited before startup completed")
        await asyncio.sleep(0.01)

    sock = server.servers[0].sockets[0]
    port = sock.getsockname()[1]
    _emit({"port": port, "token_ok": bool(_token), "ready": True})

    await serve_task


def main() -> int:
    if not _token:
        _emit({"ready": False, "error": f"{TOKEN_ENV} not set"})
        return 1
    threading.Thread(target=_watch_stdin_eof, daemon=True).start()
    try:
        asyncio.run(_serve())
    except Exception as exc:  # noqa: BLE001 - last-resort handshake on any failure
        _emit({"ready": False, "error": str(exc)})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
