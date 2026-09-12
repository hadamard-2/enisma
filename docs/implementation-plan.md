# Enisma — Backend Implementation Plan

> Internal name: **HearBook**. User-facing name: **Enisma**. This plan covers the unimplemented backend: the PDF → text-extraction → text-to-speech → export pipeline, plus persistence. The front-end is already built and currently runs on mock data (`src/lib/data.ts`, `src/lib/editor-data.ts`); each milestone below progressively replaces that mock data with real, on-device functionality.

## Goals & non-negotiables

- **Fully offline, on-device.** Apart from a one-time model download on first launch, the entire pipeline (extraction, TTS, export) runs locally with no network. User textbooks never leave the machine. No cloud OCR or hosted TTS — ever.
- **Languages:** English, Amharic, Tigrigna, Afaan Oromo.
- **Replace, don't rebuild.** The UI, routing, keyboard model, and panel layout stay as-is. We swap mock data for real data behind the existing components.

## Architecture

Three cooperating processes:

```
React (Tauri webview)  ──invoke──▶  Rust / Tauri core  ──loopback HTTP──▶  Python sidecar (bundled, offline)
  • existing UI                       • SQLite project store               • docling      → text extraction (text-layer-first; OCR fallback)
  • pdf.js page rendering             • spawns + supervises sidecar        • kokoro-onnx  → English TTS (multi-voice)
  • editor / settings / preview       • owns app-data files                • sherpa-onnx + uroman → MMS TTS (am / ti / om)
                                      • typed command wrappers              • MP3 stitch/encode for export
```

**Why a Python sidecar:** docling is Python-only, and the proven MMS-TTS path (`../amharic-speech-models`) is `sherpa-onnx` + `uroman` in Python. Two of the three core engines mandate Python, so we unify all inference in one bundled Python process rather than maintaining multiple inference runtimes.

### Locked decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Kokoro (English TTS) runtime | **Python sidecar** via `kokoro-onnx` | One runtime, one packaging + model-download story, native ONNX Runtime speed. The provided `kokoro-js` snippet becomes its Python equivalent. |
| Rust ↔ sidecar IPC | **Loopback HTTP** — FastAPI on `127.0.0.1:<ephemeral port>` with a startup handshake + bearer token | Mirrors the `amharic-speech-models` reference exactly; trivial streaming for extraction progress and audio. |
| Audiobook export format | **MP3** (single concatenated file) | Universally playable, modest bundle. (M4B-with-chapters was considered; deferred to keep the bundle lean.) |
| PDF on-screen rendering | **pdf.js (`pdfjs-dist`)** in the webview | Interactive, offline, well-trodden. docling owns text; pdf.js owns pixels — clean split. *(My call, open to review.)* |
| Project storage | **Rust-owned SQLite (`rusqlite`)** + typed Tauri commands; binaries on disk | Transactional logic stays in Rust, not in frontend SQL. |
| OCR scope (v0) | **No Ge'ez OCR.** Text-layer-first everywhere; EasyOCR fallback for Latin-script projects only (English/Oromo); Amharic/Tigrigna are text-layer-only | Textbooks almost always ship a text layer, so OCR is a rare fallback. Ge'ez OCR is high-effort / low-ROI and is deferred — this also removes Tesseract and its cross-platform bundling risk from v0 entirely. |
| Pitch control | **Dropped** | Neither Kokoro nor MMS/VITS exposes pitch natively; we won't fake it. Rate maps to each engine's speed. The pitch slider is removed from the UI. |
| Model delivery | **Download on first launch** from **our own hosted copies** (HuggingFace model repo or a GitHub release), via a manifest-driven download handler with checksums + resume | Matches the "install, then download models" framing; keeps the installer thin; hosting our own copies makes the offline-critical download reliable instead of dependent on shifting upstream URLs. |

## Components

### 1. Python sidecar

Lives in a new top-level dir (e.g. `sidecar/`), `uv`-managed, Python ≥ 3.12, frozen with PyInstaller and shipped as a Tauri `externalBin`.

```
sidecar/
  pyproject.toml        uv project (py>=3.12)
  server.py             FastAPI app; lifespan lazily loads engines; reports port+ready on stdout
  extract.py            docling wrapper (text-layer-first + OCR fallback)
  tts_kokoro.py         kokoro-onnx engine (English, multi-voice)
  tts_mms.py            sherpa-onnx VITS + uroman (adapted from the reference tts.py)
  export.py             per-page audio concatenation → MP3
  models.py             model paths, presence checks, first-run download (SSE progress)
```

**HTTP contract (all bound to `127.0.0.1`, bearer token required):**

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness + which engines/models are loaded. |
| `GET /models/status` | Which model sets are present locally. |
| `POST /models/download` | Fetch missing models; **SSE** progress stream. |
| `POST /extract` | Body `{pdf_path, ocr_engine, langs, force_full_page_ocr}`. **SSE** stream of `{page_no, text, used_ocr}`. |
| `GET /tts/voices?engine=kokoro` | Kokoro voice list (`get_voices()`). |
| `POST /tts` | Body `{engine, lang, voice, text}` → audio bytes (page preview and export reuse this). |

Rust spawns the sidecar at startup, reads the `port`/`ready` handshake from stdout, passes the model dir and bearer token via env/args, waits for `/health`, restarts on crash, and kills it on app exit. The frontend never talks to the sidecar directly — it calls typed Tauri commands that proxy to it (keeps the token/port internal, avoids CORS).

### 2. Text extraction (docling)

- **Text-layer-first.** Most textbooks ship an embedded text layer, so OCR is the exception, not the rule. docling uses the text layer where present and only reaches for OCR on pages/regions that lack one.
- **OCR scope in v0, by script:**
  - **Latin (English, Afaan Oromo):** `do_ocr=True` with **EasyOCR** (docling's default engine) as the fallback for any page missing a text layer.
  - **Ge'ez (Amharic, Tigrigna):** **no OCR** — `do_ocr=False`, text-layer only. EasyOCR has no Amharic model and Tesseract Ge'ez is unreliable, so Ge'ez OCR is deferred past v0 (high effort, low ROI). OCR enablement is therefore decided per project by its language.
- **Picking the Latin OCR engine is a dev-time call, not a UI toggle.** We default to EasyOCR and, if it underperforms on real textbook pages during dogfooding, swap it (e.g. RapidOCR) — there is no user-facing OCR-engine switch.
- **Offline:** prefetch with `docling-tools models download` (or `docling.utils.model_downloader.download_models()`); point `artifacts_path` / `DOCLING_ARTIFACTS_PATH` at the app-data model dir.
- Per-page text streams back over SSE and is persisted as `pages.source_text`; user edits become `pages.edited_text`. This feeds the editor's existing text panel and the live word-count / duration estimate.

### 3. Speech synthesis

Language → engine matrix:

| Language | Engine | Voices | Notes |
| --- | --- | --- | --- |
| English | Kokoro (`kokoro-onnx`) | **Multiple** (`get_voices()`, default e.g. `af_heart`) | 24 kHz. The settings-panel voice dropdown is real here. Needs a G2P step — see below. |
| Amharic | MMS-TTS (`sherpa-onnx` VITS) | Single-speaker | 16 kHz. **`uroman(amh)` romanization** before synthesis (Ge'ez → Latin; MMS vocab is Latin-only). |
| Tigrigna | MMS-TTS | Single-speaker | 16 kHz. `uroman(tir)`. |
| Afaan Oromo | MMS-TTS | Single-speaker | 16 kHz. `uroman(orm)` (Latin/Qubee → near-identity). |

- **English phonemization (G2P) is its own step.** Kokoro synthesizes from *phonemes*, not text. `kokoro-onnx` (v1.0+) recommends **misaki** as the primary English G2P with **eSpeak-NG as misaki's fallback** for out-of-vocabulary words: run G2P in `tts_kokoro.py`, then call `kokoro.create(phonemes, voice, is_phonemes=True)`. So the English path must bundle misaki (+ its data) **and** eSpeak-NG (library + data) offline — not just the model/voices files. A lighter alternative is the built-in `Tokenizer().phonemize()` (eSpeak-NG only, no misaki) at some English-quality cost. (The MMS languages don't use this; they romanize via `uroman` instead.)
- For the MMS languages the voice selector should be hidden/disabled (single-speaker), matching the product note.
- The `tts_mms.py` engine is adapted directly from the reference `../amharic-speech-models/tts.py`: load VITS on CPU, romanize, strip characters outside the model vocab, return PCM. Generalize the hardcoded `amh` to a per-language model dir + `lcode`.
- **Rate** maps to each engine's speed parameter. **Pitch is dropped** — neither Kokoro nor MMS/VITS exposes it natively and we won't fake it; the pitch slider is removed from the settings panel.

### 4. PDF import & render

- **Import:** Tauri dialog plugin to pick a PDF → copy into the project's app-data dir → create the `projects` row → kick off extraction.
- **Render:** `pdfjs-dist` in React renders pages for the existing "PDF preview" and "side-by-side" view modes. No server, fully offline.

### 5. Persistence (SQLite, Rust-owned)

```sql
projects(
  id TEXT PRIMARY KEY,
  title TEXT, language TEXT,            -- en | am | ti | om
  pdf_path TEXT, page_count INTEGER,
  tts_engine TEXT, voice TEXT, rate REAL,
  status TEXT,                          -- drives the Home library filters
  created_at TEXT, updated_at TEXT
);
pages(
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  page_no INTEGER,
  source_text TEXT,                     -- docling output (text layer or OCR)
  edited_text TEXT,                     -- user corrections
  used_ocr INTEGER,                     -- bool: was OCR needed for this page
  done INTEGER,                         -- reviewed flag
  audio_path TEXT,                      -- cached per-page synthesis
  UNIQUE(project_id, page_no)
);
```

On-disk layout under the app data dir:

```
Enisma/
  enisma.db
  projects/<id>/source.pdf
  projects/<id>/audio/page-0001.{wav cache}
  projects/<id>/export/<title>.mp3
  models/{docling, kokoro, mms-amh, mms-tir, mms-orm, tesseract}/
```

This replaces every in-memory React state source: Home reads `projects`; the editor reads/writes `pages`; settings persist to the `projects` row.

### 6. Export (MP3)

Reuse cached per-page audio (synthesize any missing pages first), concatenate, encode to a single MP3 with a progress stream. Because a book is single-language, all pages share one engine and one sample rate — no cross-rate mixing. Encoding happens in the sidecar (the audio already lives there) via a libmp3lame-based encoder; ffmpeg is the fallback if needed. Replaces the current `console.log` export stub in `src/components/editor/editor.tsx`.

### 7. First-run model download & management

A thin installer; on first launch (or when `GET /models/status` reports gaps), fetch into `…/models/`:

- docling artifacts (layout, tableformer, etc.)
- EasyOCR models for Latin scripts (English/Oromo fallback)
- Kokoro: model (`kokoro-v1.0.onnx`) + voices binary (`voices-v1.0.bin` — one blob holding every voice's style vectors, not a file per voice)
- English phonemizer for Kokoro: **misaki** English G2P data/dictionary **+ eSpeak-NG** library & data (misaki's out-of-vocabulary fallback)
- 3 × MMS models (am / ti / om — `model.onnx` + `tokens.txt`)
- `uroman` data (ships with the pip package)

**Hosting.** We host our own copies at a stable home — a HuggingFace model repo (free, resumable, CDN-backed) or a GitHub release on the hear-book repo — described by a versioned manifest. docling/EasyOCR/Kokoro can still originate from HuggingFace upstream, but we mirror the MMS models (which currently exist only as local zips) and pin *every* file in the manifest, so the download never depends on a shifting upstream URL.

**Download handler — requirements (the "very good" part):**

- **Manifest-driven** — a versioned `models.json` listing each file: URL, byte size, SHA-256, target path, and which feature/language needs it.
- **Integrity** — SHA-256-verify every file after download and re-check on launch; partial or corrupt files are re-fetched, never used.
- **Resumable** — HTTP range requests so an interrupted transfer continues instead of restarting (these are 100+ MB files).
- **Atomic install** — download to a temp path, verify, then move into place; a model dir is never left half-populated.
- **Progress** — per-file and overall bytes/percent streamed to the UI over SSE, with clear states (queued / downloading / verifying / done / failed).
- **Resilience** — retry with exponential backoff on transient failures; offer a retry action on hard failure; survive an app restart mid-download.
- **Gating** — project creation is blocked with a clear "preparing models" state until the set required for the chosen language is present (an English project needs Kokoro + docling + EasyOCR; an Amharic project needs MMS-amh + docling).

## Frontend wiring

No new screens. Hook points into existing components:

- `src/components/home/home.tsx` → load real `projects`; the "new project" button opens the import flow.
- `src/components/editor/editor.tsx` → load real `pages`; export button calls the MP3 export command.
- `src/components/editor/center-panel.tsx` → pdf.js render + real extracted/edited text; persist edits.
- `src/components/editor/settings-panel.tsx` → real voice list (English only; hidden for MMS single-speaker languages), rate→speed, audio preview via `/tts`; **remove the pitch slider**; persist settings.
- `src/components/editor/page-panel.tsx` → real done/remaining counts from `pages.done`.

## Milestones (each independently reviewable & testable)

- [ ] **M0 — Sidecar harness.** Bundle the Python sidecar; Rust spawns/supervises it; `/health` handshake; remove the `greet` stub.
- [ ] **M1 — Persistence + import.** SQLite schema + commands; wire Home to real projects; PDF import (dialog → copy → create project).
- [ ] **M2 — PDF render.** pdf.js in the preview/side-by-side panels (real pages, not mock).
- [ ] **M3 — Extraction.** docling `/extract` SSE; text-layer-first; EasyOCR fallback for Latin-script projects (English/Oromo), no OCR for Ge'ez (Amharic/Tigrigna); stream per-page text into the editor; offline `artifacts_path`.
- [ ] **M4 — TTS preview.** Kokoro (en) + MMS (am/ti/om) `/tts`; wire settings preview + per-page audio; real English voice list.
- [ ] **M5 — Export.** Per-page synth caching + MP3 stitch/encode with progress.
- [ ] **M6 — First-run download UX + packaging.** Model download flow; bundle-size and startup polish.

## Risks & things to verify at implementation time

- **Pin every package/API against the actually-installed version** before coding (per project convention): `docling`, `kokoro-onnx` (vs the `kokoro` PyTorch package; note its API is `get_voices()` and `create(..., is_phonemes=True)`), `misaki` (English G2P) + `espeak-ng`, `sherpa-onnx`, `uroman`, and the MP3 encoder. Treat the names here as intent to verify, not gospel.
- **Bundle size.** docling pulls CPU PyTorch; PyInstaller + ONNX Runtime + Torch makes a large sidecar. Acceptable for desktop, but plan installer/runtime size and consider what's bundled vs first-run-downloaded.
- **TTS romanization quality.** Validate `uroman` output for Amharic/Tigrigna (Ge'ez) and the Latin handling for Oromo on real textbook text; this is the TTS area most likely to need iteration.
- **English G2P / phonemizer bundling.** The Kokoro path needs a phonemizer bundled offline — recommended misaki + eSpeak-NG fallback (or the lighter built-in eSpeak-only tokenizer). Verify the exact misaki extras (`misaki[en]`, the heavier `trf=True` transformer variant vs `trf=False`) and that PyInstaller actually collects misaki's data files **and** the eSpeak-NG library + data. This is the English analogue of the `uroman` romanization risk, and adds to bundle size.
- **Download robustness is itself a feature.** Large files over flaky networks is the failure mode that most hurts an offline-first app's first impression — it's why the download handler above is specced in detail rather than treated as a `curl`.
- **Sample-rate mismatch** (Kokoro 24 kHz vs MMS 16 kHz) is avoided by single-language books, but the export/encode path should assert one rate per book.
- **Deferred — Ge'ez OCR.** Out of v0 by decision. Only revisit (and take on the Tesseract cross-platform bundling cost) if text-layer-less Amharic/Tigrigna PDFs turn out to be common in practice.

## Out of scope (for now)

- **Ge'ez-script OCR (Amharic/Tigrigna)** — text-layer-only in v0; no OCR fallback for these languages.
- M4B/chapters, multi-language books, cloud sync, voice cloning.
