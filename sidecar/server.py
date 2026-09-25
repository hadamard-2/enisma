"""HearBook/Enisma sidecar — offline inference over loopback.

A FastAPI server that the Rust/Tauri core spawns and supervises. It binds to an
ephemeral loopback port, prints a one-line JSON handshake to stdout once it is
actually listening, and serves token-guarded routes for health, model
acquisition, voices, TTS jobs and MP3 stitching.

TTS is here: English through Kokoro weights on ``onnxruntime`` (with
``espeakng-loader`` + ``phonemizer`` for G2P), and Amharic, Tigrigna and Oromo
through MMS VITS models on ``sherpa-onnx``. OCR is not — it lands in a later
milestone.

Engine registration is deliberately non-fatal: a language whose model is
absent or unloadable is simply missing from ``ENGINES_BY_LANGUAGE``, and the
``engines`` map in the health response is how a client learns which languages
actually came up.

See README.md for the full harness contract (env vars + handshake format).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import sys
import threading
from typing import Callable

import uvicorn
from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

import models
from engine_kokoro import KokoroEngine, list_voices
from engine_mms import MmsEngine
from jobs import Job, JobRegistry
from stitch import stitch
from tts import Engine

log = logging.getLogger("sidecar")

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
    """Liveness, plus which language engines actually registered.

    Registration is non-fatal, so a corrupt model, an unreadable tokens file or
    a permissions error removes a language quietly. Reporting the registered
    set is the only way a client can learn that before spending a conversion
    on it.
    """
    return {
        "status": "ok",
        "version": "0",
        "engines": {lang: True for lang in ENGINES_BY_LANGUAGE},
    }


JOBS = JobRegistry()

# Language code -> engine. Populated as the real engines land; tests inject a
# fake. An absent language becomes an error job the client can read, not a crash.
ENGINES_BY_LANGUAGE: dict[str, Engine] = {}


class TtsRequest(BaseModel):
    text: str
    language: str
    voice: str = ""
    rate: float = 1.0
    out_path: str


def _tts_work(req: TtsRequest):
    def work(job: Job) -> None:
        engine = ENGINES_BY_LANGUAGE.get(req.language)
        if engine is None:
            raise RuntimeError(f"no TTS engine for language {req.language!r}")

        def on_progress(fraction: float) -> bool:
            job.progress = fraction
            return not job.cancel.is_set()

        sample_rate, duration_ms = engine.synthesize(
            req.text, req.voice, req.rate, req.out_path, on_progress
        )
        job.sample_rate = sample_rate
        job.duration_ms = duration_ms

    return work


@app.post("/jobs/tts")
def start_tts(req: TtsRequest, _: None = Depends(_require_token)) -> dict:
    """Start synthesis and return at once. Poll GET /jobs/{id} for progress."""
    return {"jobId": JOBS.start(_tts_work(req))}


class StitchRequest(BaseModel):
    wavs: list[str]
    gap_ms: int = 0
    bitrate_kbps: int = 64
    title: str = ""
    out_path: str


def _stitch_work(req: StitchRequest):
    def work(job: Job) -> None:
        def on_progress(fraction: float) -> bool:
            job.progress = fraction
            return not job.cancel.is_set()

        sample_rate, duration_ms = stitch(
            req.wavs, req.out_path, req.gap_ms, req.bitrate_kbps, req.title, on_progress
        )
        job.sample_rate = sample_rate
        job.duration_ms = duration_ms

    return work


@app.post("/jobs/stitch")
def start_stitch(req: StitchRequest, _: None = Depends(_require_token)) -> dict:
    """Join WAVs into one MP3, as a job. Poll GET /jobs/{id} exactly as for synthesis.

    Knows nothing about pages or projects: the caller sends the files in order,
    the gap, the bitrate and the title. A refused input (mixed rates, stereo,
    8-bit, a missing file) is an error job whose message names the file.
    """
    return {"jobId": JOBS.start(_stitch_work(req))}


@app.get("/voices/{language}")
def voices(language: str, _: None = Depends(_require_token)) -> dict:
    """Real voice names. Empty for the single-speaker MMS languages."""
    if language != "en":
        return {"voices": []}
    return {"voices": list_voices(models.model_dir("en"))}


@app.get("/models/status")
def models_status(_: None = Depends(_require_token)) -> dict:
    """What each language has on disk, and what acquiring it would cost.

    Cheap enough to call on demand — a full verify of all four languages is
    well under a second — but it does hash every installed file, so it belongs
    on a mount or after a job settles rather than on a timer.
    """
    return {"languages": models.status()}


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


class FetchRequest(BaseModel):
    language: str


class ImportRequest(BaseModel):
    language: str
    source_dir: str


def _acquisition_work(acquire, language: str):
    """Wrap a model acquisition as a job, absorbing a cancel into a clean stop.

    `models` signals a cancel by raising, because it has to unwind out of a
    read loop; the registry decides `cancelled` from the flag and treats any
    exception as an error. Catching it here is what reconciles the two — let it
    escape and a download the user stopped on purpose would be reported as a
    failure.
    """

    def work(job: Job) -> None:
        def on_progress(path: str, fraction: float) -> None:
            job.progress = fraction

        try:
            acquire(on_progress, lambda: not job.cancel.is_set())
        except models.Cancelled:
            return
        # A model that just arrived is useless until its engine exists, and
        # engines are otherwise built once at startup — so without this the
        # user downloads 114 MB and is told the language is still unavailable
        # until they restart the app. Non-fatal for the same reason startup
        # registration is: the files are installed either way, and /health is
        # where a client learns whether the engine actually came up.
        register_language(language)

    return work


@app.post("/jobs/fetch")
def start_fetch(req: FetchRequest, _: None = Depends(_require_token)) -> dict:
    """Start a model download. Poll GET /jobs/{id} exactly as for synthesis.

    There is no separate status or cancel route: a download is an ordinary job,
    so GET /jobs/{id} and DELETE /jobs/{id} already serve it. Cancelling keeps
    what has already been downloaded, and starting the same language again
    resumes from there rather than from zero.
    """
    return {
        "jobId": JOBS.start(
            _acquisition_work(
                lambda on_progress, keep_going: models.fetch(
                    req.language, on_progress, keep_going
                ),
                req.language,
            )
        )
    }


@app.post("/jobs/import")
def start_import(req: ImportRequest, _: None = Depends(_require_token)) -> dict:
    """Install a language from a folder the user already has, as a job.

    A job rather than a plain call because the source may be a slow stick and
    the files run to hundreds of megabytes, so this needs the same progress and
    cancellation a download gets. The files are checked against the same
    manifest hashes, so a folder holding a different build is refused rather
    than installed and left to fail at load time.
    """
    return {
        "jobId": JOBS.start(
            _acquisition_work(
                lambda on_progress, keep_going: models.install_from_dir(
                    req.language, req.source_dir, on_progress, keep_going
                ),
                req.language,
            )
        )
    }


@app.get("/jobs/{job_id}")
def job_status(job_id: str, _: None = Depends(_require_token)) -> dict:
    snapshot = JOBS.snapshot(job_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="no such job")
    return snapshot


@app.delete("/jobs/{job_id}")
def cancel_job(job_id: str, _: None = Depends(_require_token)) -> dict:
    if not JOBS.cancel(job_id):
        raise HTTPException(status_code=404, detail="no such job")
    snapshot = JOBS.snapshot(job_id)
    if snapshot is None:
        # Pruned between the cancel and the read — the job is gone either way.
        raise HTTPException(status_code=404, detail="no such job")
    return snapshot


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


def _builder(language: str) -> Callable[[], Engine] | None:
    if language == "en":
        return lambda: KokoroEngine(models.model_dir("en"))
    if language in ("am", "ti", "om"):
        return lambda: MmsEngine(models.model_dir(language), language)
    return None


def register_language(language: str) -> bool:
    """Try to build one language's engine. Never raises.

    Called at startup for every language, and again whenever a model arrives
    mid-session. Returns whether the engine is now available, but the honest
    answer for a client is the `engines` map in /health — this one is a
    convenience for the caller standing right here.
    """
    build = _builder(language)
    if build is None:
        return False
    try:
        ENGINES_BY_LANGUAGE[language] = build()
        return True
    except FileNotFoundError:
        # Absent models are normal before the first download; /tts reports the
        # missing language rather than the sidecar failing to start.
        log.info("TTS model for %s not present yet", language)
    except Exception as exc:  # noqa: BLE001 - one bad engine, not a dead app
        # A corrupt model, an unreadable tokens file, a missing native library:
        # diagnosable in the log, fatal only for this language.
        log.warning(
            "TTS engine for %s failed to load, so that language is "
            "unavailable: %s: %s",
            language,
            type(exc).__name__,
            exc,
        )
    return False


def _register_engines() -> None:
    """Construct every engine we can, and let the rest be merely unavailable.

    No single engine may stop the sidecar from starting. A language whose
    engine does not construct is simply absent from ENGINES_BY_LANGUAGE, so
    /jobs/tts reports it exactly as it reports an unknown language.
    """
    for lang in ("en", "am", "ti", "om"):
        register_language(lang)


def main() -> int:
    if not _token:
        _emit({"ready": False, "error": f"{TOKEN_ENV} not set"})
        return 1
    threading.Thread(target=_watch_stdin_eof, daemon=True).start()
    try:
        _register_engines()
        asyncio.run(_serve())
    except Exception as exc:  # noqa: BLE001 - last-resort handshake on any failure
        _emit({"ready": False, "error": str(exc)})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
