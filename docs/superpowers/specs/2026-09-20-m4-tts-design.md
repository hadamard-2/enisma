# M4 — TTS preview

> **Status:** design, pending review. **Date:** 2026-09-20. Covers milestone M4 (TTS preview) from [docs/implementation-plan.md](../../implementation-plan.md). Every environment fact below was measured in [the M4 TTS spike](./2026-09-15-m4-tts-spike.md) — read that for the evidence; this document does not re-argue it. Internal name **HearBook**; user-facing name **Enisma**.

## What changed since the implementation plan

Three things, all forced by measurement rather than preference.

**Synthesis is slow enough to change the UI's shape.** A page takes 40–100 seconds on CPU. The plan's "wire settings preview + per-page audio" assumes a preview button that just plays. Instead the panel becomes explicitly **two-stage**: nothing is synthesized until the user asks for it, and playback is disabled until a conversion exists.

**Voice and rate are not book settings.** The plan and the V1 schema treat them as per-project (`projects.voice`, `projects.rate`, panel subtitle "Applied to all pages in this project"). They are not. The right-hand panel is a **scratchpad for experimenting while editing**; the real voice and rate are chosen in the export flow, per export, alongside a page range.

**The English G2P risk was misidentified.** The plan flags misaki and manual espeak-ng data collection. `kokoro-onnx` depends on `espeakng-loader`, which ships the espeak-ng library and its data inside a wheel; misaki would pull spacy and torch. The real hazard is espeak-ng's 159-character data-path limit, which kills the process outright.

Unchanged from the plan: the pitch slider is already gone from the UI, and rate maps to each engine's native speed parameter.

## Goals

- A page can be converted to audio on demand, in all four languages, fully offline.
- The result is cached on disk and survives an app restart.
- The user can tell at a glance when the audio no longer matches the text or the settings.
- The cached audio is reusable by M5's export when the settings match, so preview work is not thrown away.

## Non-goals

- Export, page ranges, and MP3 encoding — M5. M4 must not assume a book has one voice.
- Playback beginning before synthesis finishes. Both engines can stream sentence-sized pieces (first audio at ~7 s), but the two-stage model makes that unnecessary for now. The capability is retained for progress and cancellation, not early playback.
- Batch or background conversion of multiple pages. One page at a time, foreground.
- The full M6 download experience. M4 pulls forward only what it needs (below).
- Number-to-words above 10⁹ for Tigrinya and Oromo. Parked by decision; such numbers go unread.

## Verified environment facts

From the spike, on Linux x86_64, CPU only. These drive the design and should be re-checked if versions move.

- **Speed:** English page (1473 chars) 41.6 s; Amharic page (2000 chars) 99.1 s. RTF ~0.45 both.
- **Kokoro caps at 510 tokens.** A page phonemizes to ~1586. English must be chunked by sentence and concatenated.
- **MMS segments on sentence punctuation.** Stripping it collapses a page into one atomic 90 s call with no progress and no cancellation; keeping `.` yields 15 callbacks, first at 7.0 s, cancellation working, same total time.
- **uroman maps `።` to `.`**, so keeping `.` after romanization preserves Ge'ez sentence boundaries.
- **MMS symbol tables are Latin-only**, 52–54 tokens, no digits and no punctuation. Numbers must be expanded to words or they are silently dropped.
- **uroman converts Ge'ez numerals to Latin digits** correctly (`፫`→`3`, `፻`→`100`); `abugida` 0.3.4 does not and is not used.
- **MMS synthesis is non-deterministic** (VITS stochastic duration). Audio can never be its own source of truth for freshness.
- **espeak-ng ignores its data path past 159 characters** and then terminates the process with no Python exception.
- **Kokoro quantized variants are worse on CPU**: int8 is 6.2× slower than fp32, and `model_q8f16.onnx` segfaults onnxruntime 1.30.0 on load. Ship fp32.
- **Dependency footprint: 203 MB**, no torch.

## Decisions

| Decision | Choice |
| --- | --- |
| Preview model | Two-stage. Explicit **Convert**, then playback. Nothing synthesizes implicitly. |
| Conversion scope | One page at a time. |
| During conversion | The editor is held (blocked) with progress until it finishes or is cancelled. |
| Takes kept per page | One. A new conversion replaces the old. |
| Staleness | Metadata-driven: source text, voice and rate are stored with the audio and compared. |
| Voice / rate ownership | Panel-local experimentation. Export chooses its own, per export. |
| Export reuse | Cache keyed by (text, voice, rate); export reuses a page's audio on a match, and defaults its settings to the panel's so matches are likely. |
| English G2P | espeak-ng via `espeakng-loader` + `phonemizer`. Not misaki. |
| Kokoro weights | `model.onnx` fp32, 326 MB. No quantized variants in the manifest. |
| Ge'ez numerals | uroman, applied per numeral run before expansion. Not abugida. |
| Tigrinya numbers | `num2words2` pinned to upstream `gladiaio/num2words2@b3c8211` by SHA — merged, unreleased. Temporary; see the plan's risk entry. |
| Number substitution | Spaced (`" {words} "`), confirmed acceptable by a native speaker even for bound prefixes like `ብ1985`. |
| Audio transport | The sidecar writes a WAV to a path Rust supplies; the webview plays it over the asset protocol. Audio bytes never cross IPC. |

## Architecture

M4 is the **first real use** of the webview → Rust → sidecar path. M3 went to pdf.js and left the sidecar at its M0 harness state, so `sidecarHealth()` in `src/lib/platform.ts` is still defined and never called. That path carries progress events and a file path, never audio.

```
React panel ──invoke──▶ Rust ──loopback HTTP (job + poll)──▶ Python sidecar
   Convert / Cancel        owns paths, DB,                  kokoro-onnx (en, 24 kHz)
   progress via events     starts a job, polls it,          sherpa-onnx + uroman (am/ti/om, 16 kHz)
   <audio src=asset://>    writes DB metadata               synthesizes on a worker thread
```

Audio goes to `projects/<uuid>/audio/page-<n>.wav` under the app data directory, beside the existing `source.pdf`. Rust owns that path and passes it to the sidecar; the sidecar never invents paths.

## Sidecar HTTP surface

All routes bound to `127.0.0.1`, bearer token required, as the M0 harness already enforces.

| Route | Purpose |
| --- | --- |
| `GET /health` | Existing. `engines` gains which models are resident. |
| `GET /models/status` | Which model sets are present and verified on disk. |
| `POST /jobs/tts` | Start synthesis of text to a supplied path. Returns `{jobId}` at once. |
| `POST /jobs/fetch` | Start a language's model download. Returns `{jobId}` at once. |
| `GET /jobs/{id}` | `{state, progress, sampleRate, durationMs, message}` for any job. |
| `DELETE /jobs/{id}` | Ask a job to stop. |

**Long work is a polled job, not a streaming response.** The obvious design — stream SSE progress from `POST /tts` — cannot work here: `engine.synthesize()` is a blocking 40–100 second call that reports through a callback, and a Python generator cannot `yield` from inside a callback buried in a synchronous call stack. Any streaming route would therefore have to buffer every progress event until the work had already finished, which defeats both the progress bar and cancellation.

Running the work on a thread and exposing it as a job fixes both: progress is readable while the work runs, and `DELETE` sets a flag the engines' existing `on_progress` callback already polls — sherpa-onnx halts on a non-zero return from its callback, and the Kokoro loop checks between chunks. It also decouples the work's lifetime from one HTTP connection, which is what M5's multi-hour export over a page range will need; building it here means export inherits the transport rather than replacing it.

`progress` is 0–1, taken from sherpa-onnx's per-sentence callback on the MMS path and from chunk count for Kokoro.

## Text preparation

The step the plan does not mention and the spike proved is mandatory. Order matters throughout.

**Amharic, Tigrinya, Oromo:**

1. Expand Ge'ez numerals — match `[፩-፼]+`, romanize each run alone with uroman to get an integer.
2. Expand all numbers to words with `num2words2` in the project language, substituting with surrounding spaces.
3. Romanize the whole text with uroman at the project's `lcode`.
4. Strip to `[A-Za-z'\s.]`, **keeping `.`** — it is what segments the utterances, and uroman has already turned `።` into `.`.
5. Synthesize with sherpa-onnx at 16 kHz, `rate` passed as `speed`.

**English:**

1. Phonemize with espeak-ng, which expands numbers itself — no `num2words2` step.
2. Map phonemes to ids via the repo's `tokenizer.json` (115 entries).
3. Split into sentence-aligned chunks of ≤510 tokens.
4. Synthesize each chunk at 24 kHz with `speed`, concatenate.

A guard at sidecar startup asserts the espeak data path is ≤159 characters and fails loudly if not, rather than letting espeak kill the process silently. A second guard rejects converter output still containing digits, so the 10⁹ cliff surfaces as a logged omission instead of silence.

## Data layer

`pages.audio_path` already exists and is unused. Add, in a `user_version` 2 migration:

```sql
ALTER TABLE pages ADD COLUMN audio_text_hash  TEXT;   -- hash of the text synthesized
ALTER TABLE pages ADD COLUMN audio_voice      TEXT;
ALTER TABLE pages ADD COLUMN audio_rate       REAL;
ALTER TABLE pages ADD COLUMN audio_sample_rate INTEGER;
ALTER TABLE pages ADD COLUMN audio_duration_ms INTEGER;
```

Audio is **fresh** when `audio_path` exists on disk and `audio_text_hash` equals the hash of the page's current effective text and `audio_voice` / `audio_rate` equal the requested settings. Anything else is **stale**, and stale audio stays playable — the user can listen to the old take while deciding to re-convert. This is why freshness is metadata rather than a recomputation: synthesis is non-deterministic, so audio cannot be compared against a fresh render.

`projects.voice` and `projects.rate` stop meaning "the book's voice" and become the panel's remembered position — the settings the user last experimented with, restored when they reopen the project, and the defaults M5's export offers. `ProjectDetail` gains `voice` alongside its existing `rate`.

## Command surface

Four new Tauri commands, wrapped in `src/lib/api.ts` as the existing ones are:

- `convert_page_cmd(projectId, pageNo, voice, rate)` — starts a sidecar job, polls it, emits `tts://progress` as it advances, writes the file's metadata to the row on success. Returns the audio path and duration.
- `cancel_conversion_cmd(projectId, pageNo)` — `DELETE`s the job running for that page. A no-op when the page is not the one converting, which also prevents a stale Cancel from stopping a different page's conversion.
- `get_page_audio_cmd(projectId, pageNo)` — path, duration, sample rate, and a computed `stale` flag.
- `list_voices_cmd(language)` — the real Kokoro voice list for English, empty for the single-speaker MMS languages.

`update_project_cmd` gains `voice` alongside `rate`.

## Frontend

`settings-panel.tsx` keeps its layout. What changes:

- `PLACEHOLDER_VOICES` is deleted; voices come from `list_voices_cmd`. The voice field is hidden for am/ti/om, which are single-speaker.
- A **Convert** button appears above the player. The player's controls are disabled until audio exists for the page.
- The hardcoded `0:14` / `1:42` become the real position and the stored duration. The waveform stays decorative unless it is cheap to make real.
- While converting, the editor is blocked with a progress indicator and a Cancel action.
- When audio exists but is stale, the player stays enabled and a **stale badge** appears next to Convert, saying the audio is older than the current text or settings.
- The 4.5-second `setTimeout` fake in `editor.tsx:439` is removed.

All new strings follow the existing `{message, context}` catalogue shape, in all four locales, with the non-English ones added to `translations-needing-review.md`.

## Model acquisition

The minimum of M6 that M4 needs, and no more.

A versioned `models.json` manifest pins each file by URL, byte size and SHA-256, tagged with the language that requires it. Files download to a temp path, are SHA-256 verified, and are then moved into place, so a model directory is never half-populated. The download runs as a job on the same registry as synthesis, so progress is polled the same way. Converting a page in a language whose models are absent triggers the fetch first, with a clear "preparing models" state.

Deferred to M6: HTTP range resumption, retry with backoff, surviving an app restart mid-download, and blocking project creation on model presence.

Per-language download sizes: English 326 MB (Kokoro fp32 + English voices), each of am/ti/om 114 MB.

## Testing

- **Rust:** migration from `user_version` 1 to 2; freshness computation across each way audio can go stale; the new commands' success and rejection paths. Existing 40 tests must stay green.
- **Python:** text preparation is pure and gets the bulk of the coverage — Ge'ez numeral expansion, number-to-words per language, the strip that keeps `.`, sentence chunking against the 510-token ceiling, and the two startup guards. A fake engine stands in so tests do not need model files.
- **Frontend:** the stale/fresh/absent state machine for the panel, mirroring `page-placeholder.ts`'s truth-table style.
- **Not automated:** anything needing real models. They are too large for CI and non-deterministic besides.

## Acceptance criteria

- Converting a page in each of the four languages produces audio that plays in the editor, offline, with no network after the model download.
- Numbers are spoken in all four languages, including Ge'ez numerals, and including `ብ1985`.
- Progress advances during conversion and Cancel stops it promptly rather than at the end.
- Audio survives an app restart; reopening a project restores the panel's last voice and rate.
- Editing a page's text, or changing voice or rate, marks its audio stale while leaving it playable.
- A frozen (PyInstaller) sidecar does all of the above, including from a path long enough to have broken espeak.

## Risks

- **The sidecar path is unproven.** Nothing has ever crossed webview → Rust → sidecar beyond `/health`. Starting a job, polling it, and surfacing progress to the panel is the most likely source of integration surprises, and should be built first against a stub engine before either real engine is wired in.
- **PyInstaller with two ONNX runtimes.** sherpa-onnx and onnxruntime both ship native libraries, and espeak-ng's data must be collected and staged at a short path. The spike ran unfrozen throughout; none of this is verified.
- **The num2words2 git pin costs ~2 minutes of Rust compilation on every clean install**, CI included, and needs a Rust toolchain there. It is temporary by design.
- **Kokoro chunk seams.** Concatenating four independently synthesized chunks may be audible. No one has listened to a full page yet.
- **No real Ethiopian textbook prose has ever been through this.** The fixtures are the app's own UI strings. This remains the largest untested surface, carried over from M3.

## Open questions

- **Is the waveform worth making real?** It is decorative today. Real peaks need decoding the WAV in the webview. Cosmetic, cheap to defer.
- **What does Convert do when the page has no text?** Probably disabled with the same reasoning as `page-placeholder.ts`, but that truth table needs extending rather than guessing.
- **Where does a conversion failure surface?** Errors stay in English per project convention, but the panel has no error affordance today.
