# Enisma — Backend Implementation Plan

> Internal name: **HearBook**. User-facing name: **Enisma**. This plan covers the backend: the PDF → text-extraction → text-to-speech → export pipeline, plus persistence. When it was written the front-end ran on mock data; M1–M6 replaced that with real, on-device functionality end to end, including export and download/packaging. Sections were revised on 2026-09-25 to describe what was actually built; each milestone's own design doc under `docs/superpowers/specs/` records how and why it diverged from the original plan.

## Goals & non-negotiables

- **Fully offline, on-device.** Apart from a one-time download of each language's voice model, the entire pipeline (extraction, TTS, export) runs locally with no network. User textbooks never leave the machine. No cloud OCR or hosted TTS — ever.
- **Languages:** English, Amharic, Tigrigna, Afaan Oromo.
- **Replace, don't rebuild.** The UI, routing, keyboard model, and panel layout stay as-is. We swap mock data for real data behind the existing components.

## Architecture

Three cooperating processes:

```
React (Tauri webview)  ──invoke──▶  Rust / Tauri core  ──loopback HTTP──▶  Python sidecar (frozen, offline)
  • UI                                • SQLite project store               • Kokoro on onnxruntime + espeak-ng → English TTS (multi-voice)
  • pdf.js rendering                  • spawns + supervises sidecar        • sherpa-onnx + uroman → MMS TTS (am / ti / om)
  • pdf.js text extraction (import)   • owns app-data files                • model download / install + verification
  • editor / settings / playback      • typed command wrappers             • MP3 stitch/encode for export (lameenc)
```

**Why a Python sidecar:** the proven MMS-TTS path (`../amharic-speech-models`) is `sherpa-onnx` + `uroman` in Python, and uroman exists only as a Python package, so Python is mandatory for three of the four languages. English runs in the same process so there is one inference runtime and one packaging story. (docling was the other original reason; it left in M3, when extraction moved to pdf.js in the webview.)

### Locked decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Kokoro (English TTS) runtime | **Python sidecar**, Kokoro's ONNX model driven directly on `onnxruntime`, with espeak-ng (via `phonemizer` + `espeakng-loader`) for G2P | One runtime, one packaging + model-download story. The M4 design named `kokoro-onnx`; the implementation drives the model directly from the files the `onnx-community` repo ships (`engine_kokoro.py`). misaki was rejected in the M4 spike; see §3. |
| Rust ↔ sidecar IPC | **Loopback HTTP** — FastAPI on `127.0.0.1:<ephemeral port>` with a startup handshake + bearer token; long work as **polled jobs** | Mirrors the `amharic-speech-models` reference. Jobs rather than streaming responses because synthesis reports through a callback a generator cannot yield from, and because long work must outlive one request. |
| Audiobook export format | **MP3** (single concatenated file) | Universally playable, modest bundle. (M4B-with-chapters was considered; deferred to keep the bundle lean.) |
| PDF rendering **and text extraction** | **pdf.js (`pdfjs-dist`)** in the webview | Rendering as originally planned. Extraction joined it in M3, replacing docling: already bundled, sub-second for a whole book, and no 1.4 GB torch dependency. |
| Project storage | **Rust-owned SQLite (`rusqlite`)** + typed Tauri commands; binaries on disk | Transactional logic stays in Rust, not in frontend SQL. |
| OCR scope (v0) | **No OCR in any language.** Text layer only, for all four languages | Originally Ge'ez-only; M3 extended it to English and Oromo when docling (and with it EasyOCR) was dropped. A page with no text layer is reported as such and stays empty. |
| Pitch control | **Dropped** | Neither Kokoro nor MMS/VITS exposes pitch natively; we won't fake it. Rate maps to each engine's speed. The pitch slider is removed from the UI. |
| Model delivery | **Download once per language, when a page first needs it**, via a manifest-driven handler with SHA-256 checks and resume, or **install from a folder** offline | Keeps the installer thin. Files are pinned by hash in `sidecar/models.json`; see §7 for where they are hosted and the one gap in how they are pinned. |

## Components

### 1. Python sidecar

`sidecar/`, `uv`-managed, Python ≥ 3.12, frozen with PyInstaller into a onefile binary and shipped as a Tauri `externalBin`. [`sidecar/README.md`](../sidecar/README.md) is the authoritative reference for its environment, handshake, routes and frozen-build contents; this section is the overview.

```
sidecar/
  pyproject.toml          uv project (py>=3.12)
  server.py               FastAPI app; registers engines non-fatally; reports port+ready on stdout
  jobs.py                 background-job registry the routes start, poll and cancel
  tts.py                  engine registry and the synthesis contract
  engine_kokoro.py        English: Kokoro on onnxruntime, espeak-ng G2P, chunking
  engine_mms.py           am / ti / om: sherpa-onnx VITS
  prepare.py              text preparation: numbers to words, uroman, per-model alphabet strip
  guards.py               startup and pre-synthesis guards that turn silent failures into errors
  models.py, models.json  manifest, download / folder install, SHA-256 verification
  hearbook_sidecar.spec   PyInstaller spec
```

**HTTP contract (all bound to `127.0.0.1`, bearer token required).** Long work is a job: `POST` returns a `jobId` at once, `GET /jobs/{id}` reports progress, `DELETE /jobs/{id}` cancels.

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness + which language engines actually registered. |
| `POST /jobs/tts` | Synthesize one page's text to a WAV path Rust chooses. |
| `GET /voices/{language}` | Kokoro voice names for `en`; empty for the single-speaker MMS languages. |
| `GET /models/status` | Per language: present, total bytes, installed bytes, partial bytes to resume from. |
| `POST /jobs/fetch` | Download one language's models (resumable). |
| `POST /jobs/import` | Install one language's models from a local folder. |
| `GET` / `DELETE /jobs/{id}` | Poll or cancel any of the above. |

There is no extraction route: extraction runs in the webview (§2). Export's route is M5 work.

Rust spawns the sidecar at startup, reads the `port`/`ready` handshake from stdout, passes the bearer token and `HEARBOOK_MODELS_DIR` via env, waits for `/health`, restarts on crash, and kills it on app exit. The frontend never talks to the sidecar directly — it calls typed Tauri commands that proxy to it (keeps the token/port internal, avoids CORS).

### 2. Text extraction (pdf.js)

> Revised 2026-09-23. The original plan used docling with an EasyOCR fallback for Latin scripts. M3 evaluated docling 2.126.0 and replaced it: it would have taken the sidecar to ~1.4 GB (torch is unavoidable in that version) and run at 3.27 s/page. See the [M3 design](superpowers/specs/2026-09-12-m3-extraction-design.md) and [the docling spike](superpowers/specs/2026-09-12-m3-extraction-docling-spike.md).

- **Text layer only, all four languages.** No OCR anywhere in v0. A PDF with no text layer is warned about at import, and its pages say so in the editor rather than looking like they are still loading.
- **pdf.js in the webview, at import.** Rust reads the picked PDF and hands its raw bytes to the webview; `src/lib/extract.ts` runs `getTextContent()` per page, and the pure `src/lib/extract-assemble.ts` groups items into lines, reflows paragraphs and removes running headers and footers across the book. The assembled text goes back to Rust, which copies the PDF and creates the project, its pages and their `source_text` in one transaction. The whole 171-page sample book extracts in under a second.
- `pages.source_text` is NULL where extraction has not run and `''` where the page genuinely has no text; a project missing its text repairs itself from the stored PDF. User edits go to `pages.edited_text` and are never overwritten by extraction. `used_ocr` is written `0` and stays reserved.

### 3. Speech synthesis

Language → engine matrix:

| Language | Engine | Voices | Notes |
| --- | --- | --- | --- |
| English | Kokoro on `onnxruntime` | **Multiple** (the `voices/*.bin` files in the manifest, e.g. `af_heart`) | 24 kHz. The settings-panel voice dropdown is real here. Needs a G2P step — see below. |
| Amharic | MMS-TTS (`sherpa-onnx` VITS) | Single-speaker | 16 kHz. **`uroman(amh)` romanization** before synthesis (Ge'ez → Latin; MMS vocab is Latin-only). |
| Tigrigna | MMS-TTS | Single-speaker | 16 kHz. `uroman(tir)`. |
| Afaan Oromo | MMS-TTS | Single-speaker | 16 kHz. `uroman(orm)` (Latin/Qubee → near-identity). |

- **English phonemization (G2P) is its own step.** Kokoro synthesizes from *phonemes*, not text. The plan originally chose misaki with an eSpeak-NG fallback; the M4 spike found misaki pulls spacy and torch, so `engine_kokoro.py` uses **espeak-ng only**, through `phonemizer` and `espeakng-loader` (whose wheel carries the library and its data). Phonemes are then chunked to Kokoro's token limit and synthesized chunk by chunk, which is also where cancellation is checked. The quality cost against misaki has never been measured. (The MMS languages don't use this; they romanize via `uroman` instead.)
- For the MMS languages the voice selector is replaced by the language's single named voice.
- `engine_mms.py` is adapted from the reference `../amharic-speech-models/tts.py`: load VITS on CPU, one model directory per language. Romanization, number expansion and the strip to each model's alphabet live in `prepare.py`.
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

There is no ceiling and no crash, and in the normal range MMS runs at about **twice realtime**. But Ge'ez→Latin romanization expands text by **~1.97×** (`ሰላም` → `salaame`), so a 2,500-character Amharic page becomes ~4,900 romanized characters — squarely past the knee, at four-plus minutes, with a single progress callback and no cancellation granularity. Delimiters bound utterance size, which makes them a cost property and not merely a prosodic one — so a page whose OCR dropped its `።` marks cannot rely on them. `prepare_geez` therefore caps every utterance at **500 romanized characters** (`MMS_UTTERANCE_LIMIT`), independent of the punctuation allowlist: a longer run between marks is cut into balanced pieces at the space nearest each even cut point, or hard-cut at the limit if it has no space at all. Runs within the limit are untouched. Measured on the am model, a 2,127-character unpunctuated Amharic page (4,404 romanized) became nine pieces of 483–494 characters, each generating in 8–12 s with its own progress callback, for **98 s** total — against ~254 s for one unbroken run of that size. Progress stays sherpa-onnx's own, which counts utterances rather than weighting them by length (measured: a short, a 22×-longer and a short utterance report 0.25, 0.5, 0.75), so the bar moves unevenly but monotonically. A forced split costs what a real sentence end does: a pause of ~175 ms (measured) and a fresh utterance, so a genuinely long sentence cut mid-way will sound as if it ended there.

**Oromo is not a uroman language.** §7.2 uses letter-based input for small-vocabulary languages and uroman only above 200 characters; footnote 30 names the uroman set as Amharic, Gumuz, Korean, Sebat Bet Gurage and Tigrinya. Oromo's Qubee is native Latin, so `orm` is letter-based. We run uroman over it anyway — harmless, because uroman is the identity on Qubee text (measured), but it is coincidence rather than design and should not be relied on if the preprocessing changes.

Two smaller mismatches, both benign and both left alone: `'` is in our allowlist but absent from ti's vocabulary (no Ethiopic character romanizes to it, so it only reaches ti via embedded Latin), and `-` is in ti's and om's vocabularies but we strip it before they see it. A trailing `.` also produces one extra utterance of ~0.15s of near-silence (peak 0.012 against speech peaks of 0.3–0.57) — inaudible, and pre-existing.

#### Known limitation — the MMS languages cannot speak symbols (deferred past v0)

The MMS symbol tables are Latin-letter only, so `prepare.py` strips everything outside `[A-Za-z'\s.!?]` **after** romanization. Two different failures come out of that, and neither is visible to the user today. Measured through the real `prepare_geez`:

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

- **Import:** pick a PDF with the Tauri dialog plugin or drop it onto the library → `lopdf` counts its pages → the webview extracts its text (§2) and warns if it has no text layer → Rust copies it to `projects/<id>/source.pdf` and creates the project, pages and text in one transaction. Re-importing the same file creates an independent project.
- **Render:** `pdfjs-dist` in React renders pages for the "PDF preview" and "side-by-side" view modes, through Tauri's asset protocol, with zoom and a selectable text layer. No server, fully offline.

### 5. Persistence (SQLite, Rust-owned)

`src-tauri/src/db.rs` is authoritative; migrations are keyed on `PRAGMA user_version` (currently 3). A summary:

```sql
projects(
  id TEXT PRIMARY KEY,
  title TEXT, language TEXT,            -- en | am | ti | om
  pdf_path TEXT, page_count INTEGER,
  tts_engine TEXT,
  voice TEXT, rate REAL,                -- the settings panel's remembered position, not the book's voice (M4)
  last_page INTEGER,                    -- v3: where the project reopens
  created_at TEXT, updated_at TEXT
);                                      -- no status column: status is derived from pages
pages(
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  page_no INTEGER,
  source_text TEXT,                     -- pdf.js extraction; NULL = not extracted, '' = no text
  edited_text TEXT,                     -- user corrections
  used_ocr INTEGER,                     -- always 0 in v0; reserved for OCR
  done INTEGER,                         -- reviewed flag
  audio_path TEXT,                      -- the page's single current take
  audio_text_hash TEXT, audio_voice TEXT, audio_rate REAL,         -- v2: what the take was made from,
  audio_sample_rate INTEGER, audio_duration_ms INTEGER,            --     which decides freshness
  audio_language TEXT, audio_created_at INTEGER,
  UNIQUE(project_id, page_no)
);
```

On-disk layout under the app data dir:

```
<app data dir>/
  enisma.db
  projects/<id>/source.pdf
  projects/<id>/audio/page-<n>.wav
  models/{en, am, ti, om}/
```

Exports are written wherever the user saves them through the Save picker, so nothing lives under the project folder for them. The `projects` row instead gains five nullable `export_*` columns (migration v4): `export_voice TEXT, export_rate REAL, export_first_page INTEGER, export_last_page INTEGER, export_path TEXT`, written when an export starts and read back to prefill the dialog on the next one.

Home reads `projects`; the editor reads and writes `pages`; the settings panel persists its voice and rate to the `projects` row.

### 6. Export (MP3)

> Revised 2026-09-23 against what M4 actually built. The original text assumed per-page caching was still to do and that progress would stream over SSE; neither is true any more.

**Already in place from M4.** Every converted page is written to `projects/<id>/audio/page-<n>.wav`, and the page row records the text, voice and rate it was made from. That record — not the audio, since MMS is not deterministic — decides whether a take is still fresh. Synthesis runs as a polled, cancellable sidecar job (`POST /jobs/tts`, `GET`/`DELETE /jobs/{id}`), a transport that was chosen partly so a long export could outlive any single HTTP request. The only export UI today is a disabled **Export audiobook** item in the title-bar menu (`src/components/chrome/title-bar.tsx`); the `console.log` stub this section used to point at no longer exists.

**Decided in the M4 design, binding here.** Voice and rate are not book settings. The right-hand panel is a scratchpad; export chooses its own voice, rate and **page range** per export, defaulting to the panel's remembered voice and rate so that existing takes are likely to match and be reused.

**Scale.** The M4 spike extrapolated roughly **2 hours for English and 4.7 hours for Amharic** across the 171-page sample book. Making Kokoro chunks smaller made Stop quicker but did not change total time. An export is a multi-hour job, so cancelling, resuming and surviving an app restart are core requirements, not polish.

**Built in M5.** See [docs/superpowers/specs/2026-09-23-m5-export-design.md](./superpowers/specs/2026-09-23-m5-export-design.md) for the full design and its testing and acceptance criteria. In summary: each page's export take lives in the page's own slot, shared with Convert, so resuming is exporting again and comes free from the existing freshness check; Rust drives the page loop, running a sweep after the range finishes to catch pages edited behind it, and a further re-check after stitching that fails the run if a page reverted to a failed text meanwhile; `lameenc` in the sidecar encodes at 64 kbps CBR mono, at the takes' native sample rate, with an ID3v2.3 title frame; a page that fails to synthesize stops the run before stitching, with the failed pages listed; empty pages are skipped and listed in the summary rather than stopping the run.

An export meets every page in the book, not only the one the user is looking at, so an MMS page with no sentence marks is likelier to turn up here; the utterance cap in `prepare_geez` (see §3) keeps it bounded.

### 7. Model download, management & packaging

> Revised 2026-09-25. M4 built most of the download handler this section originally specified, and M3's move to pdf.js removed most of the models it listed. M6 closed out the rest; see the [M6 design doc](./superpowers/specs/2026-09-25-m6-download-packaging-design.md) for how.

**What gets downloaded — TTS models only.** Since M3, extraction runs on pdf.js, so there are no docling artifacts or EasyOCR models. English phonemization is espeak-ng through `espeakng-loader`, which is compiled into the sidecar binary, so misaki is not used. uroman's tables are also in the binary. The manifest (`sidecar/models.json`) covers:

- **en** — Kokoro fp32 `model.onnx` (326 MB) + `tokenizer.json` + one `voices/<name>.bin` per offered voice (seven, 522 KB each). This is not a single `voices-v1.0.bin`.
- **am / ti / om** — MMS `model.onnx` + `tokens.txt`, 114 MB each.

**Built in M4** (`sidecar/models.py`, `src-tauri/src/models.rs`):

- A versioned manifest with the URL, size and SHA-256 of every file.
- Each file downloads to `<file>.part`, is hashed, and is renamed into place only when the hash matches. A model directory is never half-populated.
- A `.part` left behind by a cancel, a dropped connection or a rate limit is resumed with an HTTP `Range` request the next time the download is asked for.
- Download runs as a cancellable, polled job on the same registry as synthesis. There is no SSE.
- A rate limit (HTTP 429) is reported with how long it lasts.
- **Install from a folder**, for machines with no usable connection, verified against the same hashes.
- The editor offers a download only when a page needs a language that isn't installed, next to Convert. A language comes up as soon as its model lands.
- Installed files are re-hashed whenever `/models/status` is asked.

**Hosting.** The MMS files come from the `hadamard-2/mms-tts-*-onnx` Hugging Face repos and Kokoro from upstream `onnx-community/Kokoro-82M-v1.0-ONNX`. Every URL points at `resolve/main`, a moving branch. The SHA-256 pins the *content* but not the *URL*, so an upstream re-upload would not install a wrong model — it would make every new download fail its checksum. Pinning each URL to a commit revision closes this gap.

**Packaging, built in M4.**

- `sidecar/hearbook_sidecar.spec` freezes the sidecar as a PyInstaller onefile binary of about 160 MB, with no torch.
- `scripts/build-sidecar.sh` installs it as `src-tauri/binaries/hearbook-sidecar-<target-triple>`, which is where Tauri's `externalBin` looks.
- The frozen binary was verified to start and to synthesize both English and Amharic.
- Rust hands the sidecar `HEARBOOK_MODELS_DIR`, so models survive the onefile's temp extraction.
- A guard turns espeak-ng's 159-character data-path limit into a readable error instead of a silent exit.

**Built in M6:**

- **Commit-pinned URLs.** Every model URL in `sidecar/models.json` points at a commit revision instead of `resolve/main`, so an upstream re-upload can no longer silently swap what a checksum-verified download installs.
- **Retry on a dropped connection.** A download that loses its connection after bytes have arrived retries three times (2 s, 8 s, 30 s), resetting the backoff on any further progress. A stopped download still only resumes when the user asks again; nothing resumes on its own at launch (deliberately, see below).
- **Removing an installed language.** Settings → Voices can download, install from a folder, cancel, and now delete each language's model (`DELETE /models/{language}`, refused while that language is installing, converting or exporting).
- **The stale-sidecar stamp.** `bun run tauri build` now refuses to bundle a sidecar whose stamp (`scripts/sidecar-stamp.ts`) doesn't match the current sources, closing the gap that on 2026-09-23 let a stale 21 MB binary (predating the TTS engines) sit in `src-tauri/binaries/` and would have shipped in a release. That binary has since been replaced by a current ~160 MB build; the guard exists so this can't recur silently.
- **CI and release workflows for three targets.** `.github/workflows/ci.yml` runs the test suites on every push; `.github/workflows/release.yml` builds, freezes its own sidecar, smoke-tests it, and bundles Linux x64, Windows x64 and macOS arm64 on a `v*` tag push or manual dispatch — unsigned, as a draft GitHub Release.
- **The smoke test.** `scripts/smoke_sidecar.py` starts the frozen binary end to end (health check, a real synthesis) and is run per-target in the release workflow before bundling.
- **Startup measured.** On Linux x64: frozen sidecar startup 2.0 s; `/models/status` with one language (Amharic) installed 0.20 s. Windows x64 and macOS arm64 are not yet measured — they await the release workflow's first green run on GitHub.

**Still deliberately not done:**

- **Surviving a restart mid-download.** The `.part` file survives a crash or restart and resumes from where it left off, but only when the user asks for that language again — nothing watches for an interrupted download and restarts it on its own.
- **Resuming on launch.** Enisma does not automatically resume an interrupted download when the app starts; this was scoped out of M6 as a non-goal (see the M6 design doc).

## Frontend wiring

All of the original hook points are wired:

- `src/components/home/home.tsx` — real `projects`; import by button or drop; rename and delete. **Done.**
- `src/components/editor/center-panel.tsx` — pdf.js render, extracted/edited text, autosave, undo/redo, find on page. **Done.**
- `src/components/editor/settings-panel.tsx` — real voice list (English; a single named voice for MMS), rate, per-page conversion with progress and cancel, Web Audio playback with a waveform; pitch slider removed. **Done.**
- `src/components/editor/page-panel.tsx` — real done/remaining counts from `pages.done`. **Done.**
- Export — the title-bar menu's **Export audiobook…** item, the export dialog, progress view and title-bar pill. **Done.**

## Milestones (each independently reviewable & testable)

- [x] **M0 — Sidecar harness.** Bundle the Python sidecar; Rust spawns/supervises it; `/health` handshake; remove the `greet` stub.
- [x] **M1 — Persistence + import.** SQLite schema + commands; wire Home to real projects; PDF import (dialog → copy → create project).
- [x] **M2 — PDF render.** pdf.js in the preview/side-by-side panels (real pages, not mock).
- [x] **M3 — Extraction.** *Narrowed:* pdf.js text-layer extraction at import for all four languages, with paragraph reflow and header/footer removal; no docling and no OCR. See §2.
- [x] **M4 — TTS preview.** Kokoro (en) + MMS (am/ti/om) as polled jobs; per-page conversion with progress, cancel and freshness tracking; real English voice list; Web Audio playback; the download slice of M6 (resumable, verified, install from folder); a frozen sidecar.
- [x] **M5 — Export.** Per-export voice, rate and page range; synthesize missing or stale pages, reuse fresh ones; stitch and encode to MP3; progress and cancel across a multi-hour run. Per-page caching already exists from M4. See §6 and the [M5 design doc](./superpowers/specs/2026-09-23-m5-export-design.md).
- [x] **M6 — Download completion + packaging.** Revision-pinned URLs; retry with backoff on a dropped connection; removing a language from Settings; a stale-sidecar build guard; CI and release workflows building Linux, Windows and macOS; a frozen-binary smoke test; startup measured on Linux (Windows/macOS await their first green release run). See §7 and the [M6 design doc](./superpowers/specs/2026-09-25-m6-download-packaging-design.md).

## Risks & things to verify at implementation time

- **Pin every package/API against the actually-installed version** before coding (per project convention). M5's encoder is `lameenc` 1.8.4 in the sidecar, verified against the frozen binary (see the M5 design doc's Verified environment facts). Treat names in this plan as intent to verify, not gospel — M3 and M4 both ended up without a library this plan named (docling, `kokoro-onnx`, misaki).
- **Bundle size.** *Largely retired.* This was a docling/PyTorch concern, and docling left in M3. The frozen TTS sidecar is about 160 MB with no torch. Models are first-run downloads: 326 MB for English and 114 MB for each MMS language. What is still unmeasured is the onefile's per-launch unpack cost (§7).
- **TTS romanization quality.** *Mostly retired.* The M4 spike found uroman transliterates Ge'ez cleanly and Oromo is already Latin; the problems that actually surfaced were dropped digits, `v`, lost sentence marks and symbols, all recorded under §3. What remains open is listening to real Ethiopian textbook prose, which has still barely been through the pipeline.
- **English G2P / phonemizer bundling.** *Retired in M4.* misaki was not adopted, because it pulls in spacy and torch. English uses espeak-ng through `espeakng-loader`, whose wheel carries both the library and its data, and the frozen spec collects them explicitly. What was left of this risk turned out to be the 159-character data-path limit, which is now guarded (§7).
- **Download robustness is itself a feature.** Large files over flaky networks is the failure mode that most hurts an offline-first app's first impression — it's why the download handler above is specced in detail rather than treated as a `curl`.
- **Sample-rate mismatch** (Kokoro 24 kHz vs MMS 16 kHz) is avoided by single-language books, but the export/encode path should assert one rate per book.
- **Deferred — symbols in the MMS languages.** `% + = ° $` and friends are silently deleted, and `² ½` and other non-Nd numerals abort the page. Out of v0 by decision; see the known-limitation note under §3 for the measurements and the two candidate fixes.
- **An MMS page with no sentence marks was unbounded work.** *Retired.* `.`, `!` and `?` were the only things splitting a page into utterances, so a page whose OCR dropped its `።` marks was one call past the ~2,000-character cost knee — minutes of work, one progress callback, and cancellation only at the end. `prepare_geez` now caps every utterance at 500 romanized characters at a word boundary, independent of the punctuation allowlist; progress stays count-based. Numbers and trade-offs under §3.
- **Deferred — OCR, in every language.** Out of v0 by decision: Ge'ez from the start, English and Oromo since M3. Only revisit if text-layer-less PDFs turn out to be common in practice; Ge'ez OCR additionally carries the Tesseract cross-platform bundling cost.
- **Temporary — `num2words2` is pinned to upstream `main` by SHA (added 2026-09-20; merged upstream 2026-09-20; waiting on a release).** The released `num2words2` on PyPI returns Tigrinya numbers as its own Latin transliteration, which collides with uroman's romanization of the surrounding words and produced audio a native speaker could not follow. The fix was contributed by us, merged upstream as [`b3c8211`](https://github.com/gladiaio/num2words2/commit/b3c82111c33a0a8f52450bfd6a57a0a327f0a02f), and closes [issue #133](https://github.com/gladiaio/num2words2/issues/133) — but it is **not on PyPI yet**: the latest release is `v1.0.20` (2026-07-27) and upstream `main` has since bumped to `1.0.21`. Switching to PyPI before a new release would silently restore the broken behaviour. The pin therefore tracks `gladiaio/num2words2` **by commit SHA**, never by branch. **The trigger to remove it:** a release `>= 1.0.21` appears on PyPI — then delete the `[tool.uv.sources]` entry and depend on the version normally. Release cadence is irregular (v1.0.17 May 1, v1.0.18 Jul 17, v1.0.20 Jul 27), so this may sit for a while. **Do not leave the git pin longer than that:** `num2words2` is a maturin/PyO3 Rust extension, so a git dependency is compiled from source — measured at 5m 24s cold, 1m 59s warm — and needs a Rust toolchain wherever the sidecar's dependencies are installed, CI included.

## Out of scope (for now)

- **OCR in any language** — text-layer-only in v0; a scanned page stays empty.
- **Speaking symbols in Amharic/Tigrigna/Oromo** — no unit expansion and no pre-flight warning in v0; see §3.
- M4B/chapters, multi-language books, cloud sync, voice cloning.
