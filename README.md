# HearBook

> **HearBook** is the internal/development name for this project. The app ships to users as **Enisma** — that's the name you'll see in the UI, window title, and bundled app.

A desktop app for turning printed textbooks into audiobooks. Import a textbook PDF, review and correct the extracted text page by page, pick a text-to-speech voice, and export an audiobook.

Enisma is aimed at making educational material more accessible — its sample content is drawn from Ethiopian school textbooks across English, Amharic, Tigrigna, and Oromo.

Enisma is designed to run **fully offline**. Apart from a one-time download of each language's voice model, the entire pipeline — text extraction, text-to-speech, and export — runs on-device with no network connection required, and your textbooks never leave your machine.

> **Status:** early development. Projects are stored locally, and PDF import, text extraction, page rendering, text editing, per-page text-to-speech, and audiobook export work end to end. There is no OCR yet: text comes from the PDF's own text layer, so a scanned PDF imports with empty pages. See [Roadmap](#roadmap).

## Features

- **Project library** — import a PDF textbook (pick it or drop it onto the library) and see every project with its language, review status, and page-by-page progress. Projects are saved on your machine, and can be renamed or deleted.
- **Three-panel editor:**
  - **Pages** — navigate every page in the book, filter by done/remaining, and mark pages as reviewed.
  - **Document** — switch between PDF preview, side-by-side, and extracted-text-only views. The preview is zoomable and its text selectable; the text is edited inline with a live word count and estimated spoken duration, undo/redo, and find, and saved automatically. A project reopens on the page you left it on.
  - **Audio** — choose language, voice, and speaking rate, convert the page to speech with progress and cancel, and play it back with a waveform. English offers several Kokoro voices; Amharic, Tigrigna, and Oromo each have one MMS voice. Each language's voice model is downloaded the first time a page needs it, or installed from a folder on a machine with no connection.
- **Keyboard-driven** — arrow keys to move between pages, `Cmd/Ctrl + \` to toggle the side panels, `Cmd/Ctrl + ←/→` to cycle document views, `Cmd/Ctrl + S` to save, `Cmd/Ctrl + F` to find on the page and `Cmd/Ctrl + Shift + F` to search the whole book, `Cmd/Ctrl + Z` / `Cmd/Ctrl + Shift + Z` to undo and redo, and `Cmd/Ctrl + =/-/0` (or `Cmd/Ctrl` + scroll) to zoom the PDF preview.
- Resizable, collapsible panels with layout that persists between sessions, and light/dark themes.

## Tech stack

- [Tauri 2](https://tauri.app/) (Rust) — desktop shell
- [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- [Vite](https://vite.dev/) — build tooling
- [Tailwind CSS v4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) — UI
- [React Router](https://reactrouter.com/) (HashRouter)

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) and [Bun](https://bun.sh/)
- The [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform (Rust toolchain and system webview dependencies)
- [uv](https://docs.astral.sh/uv/), which `tauri dev` uses to run the Python sidecar (see [sidecar/README.md](sidecar/README.md))

### Install

```bash
bun install
```

### Develop

Run the app in development with hot reload:

```bash
bun run tauri dev
```

To work on just the web front-end in a browser:

```bash
bun run dev
```

Project data comes from the Rust backend, so in a plain browser the library and editor cannot load projects; use this for layout and styling work.

### Build

`tauri build` bundles the sidecar binary already in `src-tauri/binaries/` but does not build it, so freeze the sidecar first (see [sidecar/README.md](sidecar/README.md)):

```bash
./scripts/build-sidecar.sh
```

Then produce a production desktop binary:

```bash
bun run tauri build
```

## First launch on Windows and macOS

Release builds are unsigned (see [Releasing](#releasing)), so the first launch needs one extra click.

- **Windows:** the installer is unsigned, so SmartScreen shows "Windows protected your PC". Choose **More info → Run anyway** once.
- **macOS:** the app is ad-hoc signed, not notarized. After the first blocked launch, open **System Settings → Privacy & Security** and choose **Open Anyway**.

## Releasing

1. Bump the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`.
2. Commit, then push a `v<version>` tag.
3. Wait for the Release workflow (`.github/workflows/release.yml`) to build and smoke-test Linux, Windows and macOS.
4. Review and publish the resulting draft Release.

A manual run from Actions (workflow dispatch, no tag) builds the same three bundles as downloadable run artifacts without creating a Release — useful for checking a change before tagging.

`bun run tauri build` refuses to bundle a sidecar built from different sources than what's on disk; if it does, run `scripts/build-sidecar.sh` to rebuild it.

## Project structure

```
src/                      React front-end
  components/
    home/                 Project library screen
    editor/               Three-panel page editor
    ui/                   shadcn/ui primitives
  lib/                    Backend API wrappers, types, and helpers
src-tauri/                Tauri (Rust) backend: SQLite storage, PDF import, sidecar supervision, conversion, models
sidecar/                  Python sidecar for on-device text-to-speech and model downloads
```

## Roadmap

Every item below is built to run on-device, in keeping with the fully-offline goal above — extraction and TTS use local code and models, not cloud services:

- [x] PDF import and rendering
- [x] Text extraction from the PDF's text layer
- [ ] OCR for scanned pages
- [x] Text-to-speech, page by page (on-device)
- [x] Voice model download, resumable and verified, or install from a folder
- [x] Audiobook export
- [x] Release packaging (CI-built sidecar, Linux/Windows/macOS release workflow; Windows and macOS legs await their first green run)
- [x] Persistent project storage
