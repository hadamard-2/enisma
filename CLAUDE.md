# CLAUDE.md

Guidance for working in this repository.

## What this is

A Tauri 2 + React 19 desktop app for turning scanned printed textbooks into audiobooks: import a PDF, OCR the pages, correct the extracted text page by page, pick a TTS voice, and export an audiobook. Sample content is Ethiopian school textbooks (English, Amharic, Tigrinya, Oromo).

## Two names: HearBook vs Enisma

- **HearBook** — internal/development name. Used for repo identifiers only: npm package (`hear-book`), Rust crate/lib (`hear-book` / `hear_book_lib`), Tauri bundle identifier (`com.eyob-g.hear-book`), README title.
- **Enisma** — external/user-facing name. Used everywhere a user sees the name: in-app wordmark, window title, `productName`.
- New user-facing strings use **Enisma**; internal identifiers stay **HearBook**. Don't change the bundle identifier — it's effectively permanent once published.

## Fully offline, on-device

Enisma is designed to run **fully offline**. Apart from a one-time model download on first launch, the entire pipeline runs on-device with no network connection — and user textbooks must never leave the machine. This is a hard architectural constraint, not a preference:

- OCR and TTS must use **local models**, not cloud APIs (no Google Vision, no hosted TTS, etc.).
- When designing backend work, default to bundled / first-run-downloaded models and local inference. If a task seems to need the network at runtime, flag it rather than silently reaching for a cloud service.

## Current state

The front-end is fully built and working **against mock data** (`src/lib/data.ts`, `src/lib/editor-data.ts`). The Rust/Tauri backend is essentially a stub (`src-tauri/src/lib.rs` has only the default `greet` command). Not yet implemented: PDF import/render, OCR, TTS, export, and any persistence (all state is in-memory React). See the README roadmap.

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
