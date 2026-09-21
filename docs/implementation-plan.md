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

#### What the MMS engines can and cannot do — measured

Everything in this subsection was measured against the installed `am` model and the real `uroman`, not inferred. The paper is [Pratap et al., *Scaling Speech Technology to 1,000+ Languages*, arXiv:2305.13516](https://arxiv.org/abs/2305.13516); section references below are to it.

**The alphabet is a closed set of ~28 characters, and that is the whole story.** Each model ships its own `tokens.txt`, and it is the complete vocabulary:

| | entries | distinct ids | letters | non-letters |
| --- | --- | --- | --- | --- |
| am | 53 | 28 | a–z **minus `v`** | space, `'`, `_` |
| ti | 52 | 27 | a–z **minus `v`** | space, `-` |
| om | 54 | 29 | a–z **minus `v`** | space, `'`, `-`, `_` |

Upper and lower case map to the *same* id (`c` and `C` are both 0 in am), so case is already irrelevant. The ids are per-language and **not** interchangeable — `c`→0 in am, `r`→0 in om, space→0 in ti — which is why `tokens.txt` must travel with its model file. Anything outside that set is dropped, so an exhaustive list of unspeakable characters is a *complement*, not an enumeration.

This is deliberate upstream, not an accident of the ONNX export: training text was NFKC-normalized, lowercased, and had punctuation removed (§3.1.2), and only `a`–`z` plus apostrophe were retained (§7.2). The model never saw a `%`, so there was never anything for it to say.

**Nothing crashes.** An out-of-vocabulary character is skipped by sherpa-onnx's character frontend with a line on stderr (`Skip unknown character. Unicode codepoint: \U+0025`) and no exception. Emoji, raw un-romanized Ge'ez, digits and symbols all produce clean audio with a hole in it. The failure mode is silent corruption, which is worse than a crash because it is undetectable from the return value.

**Only four characters affect the output at all: `.` `!` `?` `:`.** They are consumed as utterance delimiters *before* tokenization and are not themselves spoken. Every other punctuation mark yields a token sequence byte-identical to the one with no punctuation — verified by reconstructing the frontend and comparing ids, so a comma is not merely de-emphasized, it does not exist. `prepare.py` keeps `.`, `!` and `?`; it drops `:` deliberately, because uroman folds `፥`/`፦` onto it but it is also the separator in times and ratios.

**`v` is unspeakable and was silently corrupting loanwords.** uroman emits it for the ቨ-series, and because it is a letter it survived the symbol strip and was then skipped mid-word: `ቪዲዮ` → `vidiyo` → voiced `idiyo`. Sweeping the entire Ethiopic block (U+1200–137F plus all three extension blocks) through the real pipeline, **exactly eight characters** did this — `ቨ ቩ ቪ ቫ ቬ ቭ ቮ ቯ`, identically in all three languages, and nothing else. `prepare.py` now folds `v`→`b`, the substitution Ethiopian speakers make for the same sound.

**Synthesis is not deterministic.** The same text through the same process gave 35,177 samples one call and 29,361 the next — a 20% duration difference, from VITS's stochastic duration predictor. Re-converting a page yields a genuinely different take and a different `duration_ms`. Nothing may assume stable output: not caching, not idempotency, not a "has this changed?" comparison.

**Cost is linear until roughly 2,000 characters, then it is not.** One unbroken utterance, no delimiters, on the installed am model:

| romanized chars | audio | generate | RTF | vs previous doubling |
| --- | --- | --- | --- | --- |
| 263 | 17.6s | 9.0s | 0.51 | 1.33× |
| 1055 | 71.2s | 33.7s | 0.47 | 1.98× |
| 2111 | 143.8s | 70.5s | 0.49 | 2.09× |
| 4223 | 298.3s | 253.7s | 0.85 | **3.60×** |

There is no ceiling and no crash, and in the normal range MMS runs at about **twice realtime**. But Ge'ez→Latin romanization expands text by **~1.97×** (`ሰላም` → `salaame`), so a 2,500-character Amharic page becomes ~4,900 romanized characters — squarely past the knee, at four-plus minutes, with a single progress callback and no cancellation granularity. Delimiters are the only thing bounding utterance size, which makes them a cost property and not merely a prosodic one. **This is not yet defended against:** a page whose OCR dropped its `።` marks has no fallback. A length-based split at a word boundary would be the robust fix and is not implemented.

**Oromo is not a uroman language.** §7.2 uses letter-based input for small-vocabulary languages and uroman only above 200 characters; footnote 30 names the uroman set as Amharic, Gumuz, Korean, Sebat Bet Gurage and Tigrinya. Oromo's Qubee is native Latin, so `orm` is letter-based. We run uroman over it anyway — harmless, because uroman is the identity on Qubee text (measured), but it is coincidence rather than design and should not be relied on if the preprocessing changes.

Two smaller mismatches, both benign and both left alone: `'` is in our allowlist but absent from ti's vocabulary (no Ethiopic character romanizes to it, so it only reaches ti via embedded Latin), and `-` is in ti's and om's vocabularies but we strip it before they see it. A trailing `.` also produces one extra utterance of ~0.15s of near-silence (peak 0.012 against speech peaks of 0.3–0.57) — inaudible, and pre-existing.

#### Known limitation — the MMS languages cannot speak symbols (deferred past v0)

The MMS symbol tables are Latin-letter only, so `prepare.py` strips everything outside `[A-Za-z'\s.!?]` **after** romanization. Two different failures come out of that, and neither is visible to the user today. Measured on this branch through the real `prepare_geez`:

| page text | what the voice actually says |
| --- | --- |
| `ከተማይቱ 45% ሕዝብ አላት።` | `katamaayetu arebaa amesete hhezebe alaate.` — the `%` is gone |
| `3 + 4 = 7 ነው።` | `sosete araate sabaate nawe.` — "three four seven" |
| `ሙቀቱ 25°C ነው።` | `muqatu haayaa amesete C nawe.` — "twenty-five C" |
| `ዋጋኡ $20 እዩ።` | `waagaau eseraa eyu.` — the `$` is gone |

So `% + = × ÷ / $ € £ § ° µ` are **deleted in silence** — the audio is produced, sounds fine, and has a hole in it. Separately, any numeral `expand_numbers` cannot consume — `² ³ ½ ¼ ⁵ ① Ⅷ`, i.e. Unicode categories No and Nl — reaches `guards.assert_no_digits` and **aborts the page** with an error. `m²` is the case that surfaced this.

Ordinary punctuation is *mostly* unaffected, but less so than this section originally claimed. uroman folds Ethiopic `፣ ፤ ፥ ፦ ፧` onto `, ; : : ?` and `።` onto `.`. Of those only `.`, `?` and `:` segment anything, and until the fix described above the allowlist kept `.` alone — so Amharic questions were being glued onto the following sentence, not merely flattened. `.`, `!` and `?` now survive; `:` is still dropped on purpose. What is left over is not prosodic loss but *nothing at all*: a comma produces a token sequence identical to the one without it.

**English is not affected.** espeak-ng expands symbols before Kokoro sees them — measured: `25°C` → "twenty five degrees C", `45%` → "forty five percent", `3 + 4 = 7` → "three plus four equals seven", `$20` → "dollar twenty". Its worst case is a mispronunciation (`m²` → "em two"), not a deletion.

Two candidate fixes, both deliberately out of v0:

1. **Expand the substitution tables** in `prepare.py` with per-symbol words in each language (`m²` → `ካሬ ሜትር` / `ካሬ ሜተር` / `Kaaree meetira`). Needs a native-speaker-vetted translation per symbol per language, is unbounded, and silently mispronounces anything not yet in the table.
2. **A pre-flight check** that classifies the page's characters before synthesis starts and asks the user to edit them — blocking ones gating Convert, silently-dropped ones warning. Needs no translations at all. Roughly a day of work: a `POST /text/inspect` route reusing the real pipeline (~43 ms per page, so live debounced checking is affordable), a Tauri command, and an inline message under the editor. A prototype classifier was validated against real uroman; the crux is the list of dropped characters considered benign, since `_UNSPEAKABLE` deletes a comma exactly as thoroughly as a percent sign and warning on both makes the feature unusable.

(2) is the better route if this is picked up — it removes the translation bottleneck entirely.

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
- **Deferred — symbols in the MMS languages.** `% + = ° $` and friends are silently deleted, and `² ½` and other non-Nd numerals abort the page. Out of v0 by decision; see the known-limitation note under §3 for the measurements and the two candidate fixes.
- **Open — an MMS page with no sentence marks is unbounded work.** `.`, `!` and `?` are the only things that split a page into utterances, and they are also what keeps synthesis cost linear: past ~2,000 romanized characters a single unbroken run stops scaling (the 2,111→4,223 doubling cost 3.60×, not 2×). Romanization roughly doubles character count, so a 2,500-character Amharic page whose OCR dropped its `።` marks is ~4,900 characters in one call — four-plus minutes, one progress callback, and cancellation only at the very end. Nothing currently defends against this. The robust fix is a length-capped split at a word boundary in `prepare_geez`, independent of the punctuation allowlist; the threshold and the interaction with progress reporting are the open questions. See the measured table under §3.
- **Deferred — Ge'ez OCR.** Out of v0 by decision. Only revisit (and take on the Tesseract cross-platform bundling cost) if text-layer-less Amharic/Tigrigna PDFs turn out to be common in practice.
- **Temporary — `num2words2` is pinned to upstream `main` by SHA (added 2026-09-20; merged upstream 2026-09-20; waiting on a release).** The released `num2words2` on PyPI returns Tigrinya numbers as its own Latin transliteration, which collides with uroman's romanization of the surrounding words and produced audio a native speaker could not follow. The fix was contributed by us, merged upstream as [`b3c8211`](https://github.com/gladiaio/num2words2/commit/b3c82111c33a0a8f52450bfd6a57a0a327f0a02f), and closes [issue #133](https://github.com/gladiaio/num2words2/issues/133) — but it is **not on PyPI yet**: the latest release is `v1.0.20` (2026-07-27) and upstream `main` has since bumped to `1.0.21`. Switching to PyPI before a new release would silently restore the broken behaviour. The pin therefore tracks `gladiaio/num2words2` **by commit SHA**, never by branch. **The trigger to remove it:** a release `>= 1.0.21` appears on PyPI — then delete the `[tool.uv.sources]` entry and depend on the version normally. Release cadence is irregular (v1.0.17 May 1, v1.0.18 Jul 17, v1.0.20 Jul 27), so this may sit for a while. **Do not leave the git pin longer than that:** `num2words2` is a maturin/PyO3 Rust extension, so a git dependency is compiled from source — measured at 5m 24s cold, 1m 59s warm — and needs a Rust toolchain wherever the sidecar's dependencies are installed, CI included.

## Out of scope (for now)

- **Ge'ez-script OCR (Amharic/Tigrigna)** — text-layer-only in v0; no OCR fallback for these languages.
- **Speaking symbols in Amharic/Tigrigna/Oromo** — no unit expansion and no pre-flight warning in v0; see §3.
- M4B/chapters, multi-language books, cloud sync, voice cloning.
