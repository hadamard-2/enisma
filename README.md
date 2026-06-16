# HearBook

> **HearBook** is the internal/development name for this project. The app ships to users as **Enisma** — that's the name you'll see in the UI, window title, and bundled app.

A desktop app for turning printed textbooks into audiobooks. Import a scanned textbook PDF, review and correct the extracted text page by page, pick a text-to-speech voice, and export an audiobook.

Enisma is aimed at making educational material more accessible — its sample content is drawn from Ethiopian school textbooks across English, Amharic, Tigrinya, and Oromo.

> **Status:** early development. The full front-end is built and working against mock data; the backend (PDF import, OCR, TTS, export, persistence) is not yet implemented. See [Roadmap](#roadmap).

## Features

- **Project library** — a home screen listing your textbooks, each with its language, review status, and page-by-page progress.
- **Three-panel editor:**
  - **Pages** — navigate every page in the book, filter by done/remaining, and mark pages as reviewed.
  - **Document** — switch between PDF preview, side-by-side, and extracted-text-only views, and correct the OCR text inline with a live word count and estimated spoken duration.
  - **Audio settings** — choose language, voice, speaking rate, and pitch, and preview the result.
- **Keyboard-driven** — arrow keys to move between pages, `Cmd/Ctrl + \` to toggle the side panels, and `Cmd/Ctrl + ←/→` to cycle document views.
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

### Build

Produce a production desktop binary:

```bash
bun run tauri build
```

## Project structure

```
src/                      React front-end
  components/
    home/                 Project library screen
    editor/               Three-panel page editor
    ui/                   shadcn/ui primitives
  lib/                    Mock data, theme, and helpers
src-tauri/                Tauri (Rust) backend
```

## Roadmap

The interface is in place; the engine behind it is not. Planned work:

- [ ] PDF import and rendering
- [ ] OCR / text extraction
- [ ] Text-to-speech integration
- [ ] Audiobook export
- [ ] Persistent project storage (currently all state is in-memory)
