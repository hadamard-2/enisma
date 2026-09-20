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
| `HEARBOOK_MODELS_DIR` | Where downloaded inference models live. **Required in practice.** Rust sets it to `<app data dir>/models`, beside `enisma.db` and `projects/`. Without it `models.py` falls back to a directory beside its own `__file__`, which in the frozen binary is PyInstaller's extraction directory — deleted on exit, so every launch would re-download hundreds of megabytes. |
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

This runs PyInstaller against `hearbook_sidecar.spec` and copies the result to `src-tauri/binaries/hearbook-sidecar-<target-triple>` (the suffix Tauri's `externalBin` resolution requires). The result is a single ~160 MB file; the models it downloads at runtime are not in it.

## What the frozen binary carries

The TTS stacks reach most of what they need through filesystem paths rather than through `import`, so PyInstaller's import-graph analysis does not find it. Every entry in the spec file's `binaries`/`datas` is there because something breaks without it.

| Collected | Why it cannot be inferred |
| --- | --- |
| `sherpa_onnx/lib/*.so` (`collect_dynamic_libs`) | `libsherpa-onnx-c-api.so` and the compiled `_sherpa_onnx` extension both list `libonnxruntime.so` as a link-time `NEEDED` entry resolved through `$ORIGIN`. Nothing imports it, so only an explicit collection puts it in the bundle. This `libonnxruntime.so` comes from the `sherpa-onnx-core` package and is a **different library** from onnxruntime's own — both ship, and they must not be deduplicated. |
| `sherpa_onnx.lib._sherpa_onnx` (hidden import) | `sherpa_onnx/lib/` has no `__init__.py`, so it is a namespace package the analysis does not reliably walk into from the `sherpa_onnx` hidden import alone. |
| `onnxruntime` (`collect_dynamic_libs`) | Resolves only to `libonnxruntime_providers_shared.so`. The main runtime is linked **statically** into `onnxruntime_pybind11_state…so` in this wheel — `objdump -p` shows no `libonnxruntime` among its `NEEDED` entries — so there is no `libonnxruntime.so.1.30.0` to collect and none is needed. |
| `espeakng_loader` (data **and** dynamic libs) | `get_library_path()` ctypes-loads `libespeak-ng.so` from `Path(__file__).parent`, and `get_data_path()` returns `Path(__file__).parent / 'espeak-ng-data'` and raises if it is absent. Both have to land inside the frozen `espeakng_loader/` directory, which is why the libraries are collected with a package-relative destination rather than at the bundle root. |
| `uroman` data (`collect_data_files`) | ~3.9 MB of romanization tables loaded from the package directory at `Uroman()` construction. See the failure mode below. |
| `models.json` | Read from disk beside `server.py` at runtime. |

### Two failures that do not look like failures

**uroman's tables going missing is silent.** `load_rom_file` does not raise on a missing file — it writes one line to stderr and returns. A bundle without the tables therefore constructs `Uroman()` fine, registers all three Ge'ez engines fine, and then romanizes nothing: the Ge'ez passes through unchanged, `prepare._UNSPEAKABLE` strips all of it, and every Amharic/Tigrigna/Oromo page fails with `nothing left to speak after preparing the text` — an error that points at the user's text. It works in dev and breaks only in a release build. Testing that the files *appear* in the bundle is not enough; synthesize a Ge'ez sentence from the frozen binary.

**espeak-ng's data path has a 159-character limit.** Past it espeak-ng ignores the path handed to it, falls back to one compiled into the wheel that exists only on the build machine, and then **terminates the process** — no Python exception, no traceback, buffered stdout lost. The signature is the sidecar exiting with no handshake line at all, which reads like a crash but is not one. `guards.assert_espeak_data_path` measures the resolved path first and raises a readable `RuntimeError` instead; because engine registration tolerates one bad engine, the sidecar still starts and only English goes missing.

This matters specifically for the frozen binary because a onefile bundle unpacks to `$TMPDIR/_MEIxxxxxx/` and the data path is then `$TMPDIR/_MEIxxxxxx/espeakng_loader/espeak-ng-data` — 42 characters more than `$TMPDIR`. With the usual `/tmp` that is 46 characters and there is ample headroom, but a `TMPDIR` longer than 117 characters pushes it over. Measured: `TMPDIR=/tmp` → 46 characters; a 175-character `TMPDIR` → 217 characters and the guard fires.
