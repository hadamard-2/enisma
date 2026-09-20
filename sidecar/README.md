# HearBook sidecar

The offline inference sidecar for Enisma (internal name: HearBook). The Rust/Tauri core spawns and supervises this process; the React frontend never talks to it directly. It is a FastAPI server over loopback: the M0 harness (handshake, bearer token, `/health`) plus the M4 TTS routes — model acquisition, voices, and synthesis jobs. TTS runs English through Kokoro weights on `onnxruntime` (with `espeakng-loader` and `phonemizer` for grapheme-to-phoneme), and Amharic, Tigrigna and Oromo through MMS VITS models on `sherpa-onnx`. OCR is not here yet; it lands in a later milestone.

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

## Routes

Every route takes the bearer token; a missing or wrong one is `401`.

| Route | Response |
| --- | --- |
| `GET /health` | `{"status": "ok", "version": "0", "engines": {"<lang>": true, ...}}` — `engines` holds exactly the languages whose engine registered at startup. Registration is non-fatal, so an absent or unloadable model drops its language from this map rather than stopping the sidecar. |
| `POST /jobs/tts` | `{"jobId": "..."}` — returns immediately; poll `GET /jobs/{id}` for progress. |
| `POST /jobs/fetch` | `{"jobId": "..."}` — a model download is an ordinary job, with no status or cancel route of its own. Cancelling keeps what has already arrived; starting the same language again resumes from there with a `Range` request rather than from zero. |
| `POST /jobs/import` | `{"jobId": "..."}` — installs one language from a local folder, for a machine with no usable connection. Takes `{"language", "source_dir"}`, accepts either the manifest's nesting (`am/model.onnx`) or a flat folder of the files, and verifies against the same hashes a download does. |
| `GET /jobs/{id}` | `{"state", "progress", "sampleRate", "durationMs", "message"}`, or **404** for an unknown or pruned job. |
| `DELETE /jobs/{id}` | The same snapshot shape `GET` returns, and the same **404** for an unknown or pruned job — so a caller writes one not-found branch, not two. |
| `GET /models/status` | `{"languages": {"<lang>": {"present", "bytes", "installedBytes", "partialBytes"}}}` — `present` is true when every file verifies, `bytes` is what the language costs in total, and `partialBytes` is what an interrupted download left to resume from. Hashes every installed file, so call it on demand rather than on a timer. |
| `GET /voices/{language}` | `{"voices": [...]}` — names for `en`; empty for the single-speaker MMS languages. |

**`state` is the authoritative verdict on a job.** A *cancelled* job still reports a populated `sampleRate` and a non-zero `durationMs`, and leaves a truncated but structurally valid WAV at `out_path`. A client that branches on the data fields rather than on `state` will treat a truncated take as a success.

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
| `sherpa_onnx/lib/*.so` (`collect_dynamic_libs`) | `libsherpa-onnx-c-api.so` and the compiled `_sherpa_onnx` extension both list `libonnxruntime.so` as a link-time `NEEDED` entry, resolved through the extension's `$ORIGIN` rpath when the dynamic linker loads the extension module. Sherpa's own code never names the library; it is a link-time dependency, not a runtime `dlopen`. Either way **no `import` statement mentions it**, so PyInstaller's import-graph analysis cannot see it and it must be collected explicitly or it is simply absent from the bundle. |
| `sherpa_onnx.lib._sherpa_onnx` (hidden import) | `sherpa_onnx/lib/` has no `__init__.py`, so it is a namespace package the analysis does not reliably walk into from the `sherpa_onnx` hidden import alone. |
| `onnxruntime` (`collect_dynamic_libs`) | Resolves only to `libonnxruntime_providers_shared.so`, and that is the right result. The wheel does also ship a 28 MB `onnxruntime/capi/libonnxruntime.so.1.30.0` — the file exists — but **nothing links to or loads it**: `readelf -d` on `onnxruntime_pybind11_state…so` lists no `libonnxruntime` among its `NEEDED` entries (this wheel links ONNX Runtime **statically** into that module), and `libonnxruntime_providers_shared.so` does not need it either. It is dead weight, so it is left out because nothing uses it — not because it is absent. |
| `espeakng_loader` (data **and** dynamic libs) | `get_library_path()` ctypes-loads `libespeak-ng.so` from `Path(__file__).parent`, and `get_data_path()` returns `Path(__file__).parent / 'espeak-ng-data'` and raises if it is absent. Both have to land inside the frozen `espeakng_loader/` directory, which is why the libraries are collected with a package-relative destination rather than at the bundle root. |
| `uroman` data (`collect_data_files`) | ~3.9 MB of romanization tables loaded from the package directory at `Uroman()` construction. See the failure mode below. |
| `models.json` | Read from disk beside `server.py` at runtime. |

### Two failures that do not look like failures

**uroman's tables going missing is silent.** `load_rom_file` does not raise on a missing file — it writes one line to stderr and returns. A bundle without the tables therefore constructs `Uroman()` fine, registers all three Ge'ez engines fine, and then romanizes nothing: the Ge'ez passes through unchanged, `prepare._UNSPEAKABLE` strips all of it, and every Amharic/Tigrigna/Oromo page fails with `nothing left to speak after preparing the text` — an error that points at the user's text. It works in dev and breaks only in a release build. Testing that the files *appear* in the bundle is not enough; synthesize a Ge'ez sentence from the frozen binary.

**espeak-ng's data path has a 159-character limit.** Past it espeak-ng ignores the path handed to it, falls back to one compiled into the wheel that exists only on the build machine, and then **terminates the process** — no Python exception, no traceback, buffered stdout lost. The signature is the sidecar exiting with no handshake line at all, which reads like a crash but is not one. `guards.assert_espeak_data_path` measures the resolved path first and raises a readable `RuntimeError` instead; because engine registration tolerates one bad engine, the sidecar still starts and only English goes missing.

This matters specifically for the frozen binary because a onefile bundle unpacks to `$TMPDIR/_MEIxxxxxx/` and the data path is then `$TMPDIR/_MEIxxxxxx/espeakng_loader/espeak-ng-data` — 42 characters more than `$TMPDIR`. With the usual `/tmp` that is 46 characters and there is ample headroom, but a `TMPDIR` longer than 117 characters pushes it over. Measured: `TMPDIR=/tmp` → 46 characters; a 175-character `TMPDIR` → 217 characters and the guard fires.
