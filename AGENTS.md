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

Persistence, PDF import, and PDF rendering are real; OCR, TTS, and export are not. See the README roadmap.

- **Persistence:** SQLite via `rusqlite` (`src-tauri/src/db.rs`), in the app data directory as `enisma.db`, with schema migrations keyed on `PRAGMA user_version`. Projects and pages are stored; a project's status is derived from its pages, never stored. The front-end reaches it only through the Tauri commands in `src-tauri/src/project.rs`, wrapped in `src/lib/api.ts`.
- **Import:** a picked PDF is page-counted with `lopdf` (`src-tauri/src/pdf.rs`) and copied to `projects/<uuid>/source.pdf` under the app data directory, and its project and page rows are created in one transaction (`src-tauri/src/import.rs`). Re-importing the same file creates an independent project.
- **Editor:** renders the stored PDF with pdf.js through Tauri's asset protocol (`src/components/editor/pdf-viewer.tsx`: one page at a time, zoom, selectable text layer), autosaves each page's edited text, and persists the page-done flag, project title, and language.
- **Not implemented yet:** OCR (pages start with no extracted text), TTS (voice list is a placeholder in `src/lib/placeholder-voices.ts`; voice, rate, and pitch are not saved; the audio preview is a mock), and export (the Export button is a stub). The Python sidecar (`sidecar/`) is supervised by the Rust core but only serves `/health`; it is where the on-device OCR and TTS engines will run.

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
