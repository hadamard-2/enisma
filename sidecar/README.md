# HearBook sidecar

The offline inference sidecar for Enisma (internal name: HearBook). The Rust/Tauri core spawns and supervises this process; the React frontend never talks to it directly. As of **M0** it is just the harness — a FastAPI server with a single `/health` route. OCR (docling) and TTS (kokoro-onnx / sherpa-onnx) engines land in later milestones.

## Prerequisites

- Python ≥ 3.12 and [`uv`](https://docs.astral.sh/uv/) on `PATH`.
- `uv sync` to create the `.venv` and install dependencies.

In `tauri dev` the Rust supervisor launches the sidecar via `uv run python server.py`, so `uv` must be installed for development. Production builds run the PyInstaller-frozen binary instead (see below).

## Harness contract

The supervisor passes configuration via environment variables (never argv):

| Var | Meaning |
| --- | --- |
| `HEARBOOK_SIDECAR_TOKEN` | Per-spawn bearer token. **Required** — the sidecar refuses to start without it. Every request to a guarded route must send `Authorization: Bearer <token>`. |
| `HEARBOOK_SIDECAR_HOST` | Bind host. Always `127.0.0.1` (loopback only — never `0.0.0.0`). |
| `HEARBOOK_MODELS_DIR` | App-data models directory. Passed for forward-compatibility; unused at M0. |
| `PYTHONUNBUFFERED` | Set to `1` so the handshake line is not stuck in a buffer (matters for the frozen binary). |

### Startup handshake

The sidecar binds to an **ephemeral port** (`port=0`; the OS assigns it), then prints exactly one JSON line to stdout once it is actually listening:

```json
{"port": 49321, "token_ok": true, "ready": true}
```

On a fatal startup error it instead prints `{"ready": false, "error": "..."}` and exits non-zero. The supervisor parses this line to learn the port, then confirms readiness with a `GET /health` poll before considering the sidecar up.

### Single-process rule

Run uvicorn **in-process** (no `--reload`, no multiple workers). Those spawn child processes that a single `child.kill()` from the supervisor would orphan. The server is started programmatically from `server.py` precisely to keep it a single process.

## Routes (M0)

| Route | Auth | Response |
| --- | --- | --- |
| `GET /health` | Bearer | `{"status": "ok", "version": "0", "engines": {}}` |

## Building the frozen binary

```bash
# from the repo root
./scripts/build-sidecar.sh
```

This runs PyInstaller against `hearbook_sidecar.spec` and copies the result to `src-tauri/binaries/hearbook-sidecar-<target-triple>` (the suffix Tauri's `externalBin` resolution requires).
