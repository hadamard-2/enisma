# AGENTS.md

Guidance for working in this repository.

## What this is

A Tauri 2 + React 19 desktop app for turning scanned printed textbooks into audiobooks: import a PDF, OCR the pages, correct the extracted text page by page, pick a TTS voice, and export an audiobook. Sample content is Ethiopian school textbooks (English, Amharic, Tigrigna, Oromo).

## Two names: HearBook vs Enisma

- **HearBook** — internal/development name. Used for repo identifiers only: npm package (`hear-book`), Rust crate/lib (`hear-book` / `hear_book_lib`), Tauri bundle identifier (`com.eyob-g.hear-book`), README title.
- **Enisma** — external/user-facing name. Used everywhere a user sees the name: in-app wordmark, window title, `productName`.
- New user-facing strings use **Enisma**; internal identifiers stay **HearBook**. Don't change the bundle identifier — it's effectively permanent once published.

## Fully offline, on-device

Enisma is designed to run **fully offline**. Apart from a one-time model download on first launch, the entire pipeline runs on-device with no network connection — and user textbooks must never leave the machine. This is a hard architectural constraint, not a preference:

- OCR and TTS must use **local models**, not cloud APIs (no Google Vision, no hosted TTS, etc.).
- When designing backend work, default to bundled / first-run-downloaded models and local inference. If a task seems to need the network at runtime, flag it rather than silently reaching for a cloud service.

## Current state

Persistence, PDF import, text extraction from the PDF's text layer, PDF rendering, and per-page TTS are real; OCR and export are not. See the README roadmap, and `docs/implementation-plan.md` for the milestones (M5 export and M6 download completion plus packaging remain).

- **Persistence:** SQLite via `rusqlite` (`src-tauri/src/db.rs`), in the app data directory as `enisma.db`, with schema migrations keyed on `PRAGMA user_version`. Projects and pages are stored; a project's status is derived from its pages, never stored. The front-end reaches it only through the Tauri commands in `src-tauri/src/project.rs`, wrapped in `src/lib/api.ts`.
- **Import:** a picked PDF is page-counted with `lopdf` (`src-tauri/src/pdf.rs`) and copied to `projects/<uuid>/source.pdf` under the app data directory, and its project and page rows are created in one transaction (`src-tauri/src/import.rs`). Re-importing the same file creates an independent project.
- **Extraction:** runs in the webview at import, before the project row exists. Rust hands the PDF's raw bytes over; pdf.js pulls each page's text layer (`src/lib/extract.ts`) and a pure assembler groups lines, reflows paragraphs and strips running headers and footers (`src/lib/extract-assemble.ts`). The text is stored as `pages.source_text` in the import transaction — NULL means not extracted, `''` means the page has no text. A PDF without a text layer is warned about at import; there is no OCR, and no sidecar involvement.
- **Editor:** renders the stored PDF with pdf.js through Tauri's asset protocol (`src/components/editor/pdf-viewer.tsx`: one page at a time, zoom, selectable text layer), autosaves each page's edited text, and persists the page-done flag, project title, language, and the page the project was last left on, which is where it reopens.
- **Sidecar:** a Python FastAPI process (`sidecar/`, managed with **uv**) that the Rust core spawns and supervises over loopback with a per-spawn bearer token (`src-tauri/src/sidecar.rs`). Long work runs as polled jobs: `POST /jobs/tts`, `/jobs/fetch`, `/jobs/import`, then `GET`/`DELETE /jobs/{id}`. `/health` reports which language engines actually came up — registration is non-fatal, so a missing or broken model just removes that language.
- **TTS:** English uses Kokoro (`sidecar/engine_kokoro.py`, 24 kHz, several voices); Amharic, Tigrigna and Oromo use single-speaker MMS VITS models on sherpa-onnx (`sidecar/engine_mms.py`, 16 kHz, no voice choice). `sidecar/prepare.py` turns page text into something each engine can say: numbers to words, uroman romanization, and a strip to each model's small alphabet. Converting a page writes `projects/<uuid>/audio/page-<n>.wav` (`src-tauri/src/convert.rs`), one page at a time and cancellable; other pages stay open for reading and editing meanwhile. The voice and rate are saved on the project, and each page's audio records which text, voice and rate it was made from. That record, not the audio itself, decides whether the audio is still fresh — MMS is not deterministic, so the same text never produces the same bytes twice. There is no pitch control; neither engine supports it.
- **Playback:** the player fetches a take, decodes the WAV itself (`src/lib/waveform.ts`), and plays it through Web Audio — never through an `<audio>` element. WebKitGTK's media stack on Linux refuses Tauri's `asset:` scheme, and even given a `blob:` URL it misplaces seeks: it reports the requested position while sounding from somewhere else. The same samples feed the waveform.
- **Models:** downloaded once per language from Hugging Face, or installed from a folder for machines with no connection (`sidecar/models.py`, `src-tauri/src/models.rs`). Files are checked against SHA-256 hashes in `sidecar/models.json`, downloads resume where they stopped, and they go in `models/<lang>/` under the app data directory — Rust passes this path in as `HEARBOOK_MODELS_DIR`. The editor offers the download only when a page needs a language that isn't installed.
- **MMS limits:** the MMS languages cannot speak symbols (`%`, `$`, `°` are silently dropped) or superscript/fraction numerals (they stop the page with an error). Their properties are measured in the §3 notes of `docs/implementation-plan.md` — read that before changing `prepare.py`.
- **Not implemented yet:** OCR in any language (a page with no text layer stays empty) and export (the **Export audiobook** menu item is disabled). `bun run tauri build` does not rebuild the sidecar — run `scripts/build-sidecar.sh` first, or the bundle ships whatever binary is already in `src-tauri/binaries/`.

## Tech stack & conventions

- **Frontend:** React 19 + TypeScript, Vite, Tailwind CSS v4, shadcn/ui, Lucide icons.
- **Routing:** `react-router-dom` v7 — use **`HashRouter`, never `BrowserRouter`**. Tauri serves the production app over the `tauri://` protocol with no HTTP server; `BrowserRouter` works in `tauri dev` but breaks on direct route loads in production builds. `HashRouter` keeps routing client-side via the URL fragment.
- **Backend:** Tauri 2 (Rust). Expose backend functionality as Tauri commands.

## Commands

Package manager is **Bun**.

- `bun install` — install dependencies
- `bun run tauri dev` — run the full desktop app with hot reload
- `bun run dev` — front-end only, in a browser (fast UI iteration)
- `bun run tauri build` — production desktop binary

## Repo notes

- Don't hard-wrap prose in Markdown — one line per paragraph; let the editor soft-wrap.
- Solo project: committing to `main` is fine, but only commit/push when explicitly asked. Follow Conventional Commits for messages and branch names.
