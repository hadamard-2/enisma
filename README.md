# Enisma

A desktop app for turning printed textbooks into audiobooks. Import a textbook PDF, review and correct the extracted text page by page, pick a text-to-speech voice, and export an audiobook.

Enisma is aimed at making educational material more accessible — its sample content is drawn from Ethiopian school textbooks across English, Amharic, Tigrigna, and Oromo.

Enisma runs **fully offline**. Apart from a one-time download of each language's voice model, the entire pipeline — text extraction, text-to-speech, and export — runs on your machine, and your textbooks never leave it.

> **Status:** early. PDF import, text extraction, page rendering, text editing, per-page text-to-speech, and audiobook export work end to end. There is no OCR yet: text comes from the PDF's own text layer, so a scanned PDF imports with empty pages. See [Roadmap](#roadmap).

## Download

Get the latest build from [Releases](https://github.com/hadamard-2/enisma/releases):

| Platform | File |
|---|---|
| Windows (x64) | `Enisma_<version>_x64-setup.exe` |
| macOS (Apple Silicon) | `Enisma_<version>_aarch64.dmg` |
| Linux (x64) | `Enisma_<version>_amd64.AppImage` or `.deb` |

The builds are unsigned, so the first launch needs one extra step:

- **Windows:** SmartScreen shows "Windows protected your PC". Choose **More info → Run anyway** once.
- **macOS:** after the first blocked launch, open **System Settings → Privacy & Security** and choose **Open Anyway**.

## Features

- **Project library** — import a PDF textbook (pick it or drop it onto the library) and see every project with its language, review status, and page-by-page progress. Projects are saved on your machine, and can be renamed or deleted.
- **Three-panel editor:**
  - **Pages** — navigate every page in the book, filter by done/remaining, and mark pages as reviewed.
  - **Document** — switch between PDF preview, side-by-side, and extracted-text-only views. The preview is zoomable and its text selectable; the text is edited inline with a live word count and estimated spoken duration, undo/redo, and find, and saved automatically. A project reopens on the page you left it on.
  - **Audio** — choose language, voice, and speaking rate, convert the page to speech with progress and cancel, and play it back with a waveform. English offers several Kokoro voices; Amharic, Tigrigna, and Oromo each have one MMS voice. Each language's voice model is downloaded the first time a page needs it, or installed from a folder on a machine with no connection.
- **Audiobook export** — synthesize the whole book or a page range to a single MP3, reusing pages already converted.
- **Interface in four languages** — English, Amharic, Tigrigna, and Oromo.
- **Keyboard-driven** — arrow keys to move between pages, `Cmd/Ctrl + \` to toggle the side panels, `Cmd/Ctrl + ←/→` to cycle document views, `Cmd/Ctrl + S` to save, `Cmd/Ctrl + F` to find on the page and `Cmd/Ctrl + Shift + F` to search the whole book, `Cmd/Ctrl + Z` / `Cmd/Ctrl + Shift + Z` to undo and redo, and `Cmd/Ctrl + =/-/0` (or `Cmd/Ctrl` + scroll) to zoom the PDF preview.
- Resizable, collapsible panels with layout that persists between sessions, and light/dark themes.

## Roadmap

Every item below runs on-device — extraction and TTS use local code and models, not cloud services.

- [x] PDF import and rendering
- [x] Text extraction from the PDF's text layer
- [x] Persistent project storage
- [x] Text-to-speech, page by page
- [x] Voice model download, resumable and verified, or install from a folder
- [x] Audiobook export
- [x] Release builds for Linux, Windows and macOS
- [ ] OCR for scanned pages

## Development

### Tech stack

- [Tauri 2](https://tauri.app/) (Rust) — desktop shell, storage, PDF import, sidecar supervision
- [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/), [Vite](https://vite.dev/), [Tailwind CSS v4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/)
- A Python [FastAPI](https://fastapi.tiangolo.com/) sidecar for on-device text-to-speech, frozen with PyInstaller for release (see [sidecar/README.md](sidecar/README.md))

### Prerequisites

- [Node.js](https://nodejs.org/) and [Bun](https://bun.sh/)
- The [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform (Rust toolchain and system webview dependencies)
- [uv](https://docs.astral.sh/uv/), which `tauri dev` uses to run the Python sidecar

### Run

```bash
bun install
```

```bash
bun run tauri dev
```

`bun run dev` serves just the web front-end in a browser. Project data comes from the Rust backend, so there the library and editor cannot load projects; use it for layout and styling work.

### Build

`tauri build` bundles the sidecar binary already in `src-tauri/binaries/` but does not build it, so freeze the sidecar first:

```bash
./scripts/build-sidecar.sh
```

```bash
bun run tauri build
```

Releases are built by CI; see [docs/releasing.md](docs/releasing.md).

### Project structure

```
src/                      React front-end
  components/
    home/                 Project library screen
    editor/               Three-panel page editor
    ui/                   shadcn/ui primitives
  lib/                    Backend API wrappers, types, and helpers
  locales/                Interface translations
src-tauri/                Tauri (Rust) backend: SQLite storage, PDF import, sidecar supervision, conversion, models
sidecar/                  Python sidecar for on-device text-to-speech and model downloads
```

## License

Enisma is licensed under the [GNU General Public License v3.0](LICENSE).

### Third-party components and models

The app bundles open-source components under their own licenses, among them [espeak-ng](https://github.com/espeak-ng/espeak-ng) and [phonemizer](https://github.com/bootphon/phonemizer) (GPL-3.0), [LAME](https://lame.sourceforge.io/) via lameenc and num2words2 (LGPL), [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) and [ONNX Runtime](https://onnxruntime.ai/) (Apache-2.0 / MIT), and [uroman](https://github.com/isi-nlp/uroman) (MIT-style).

Voice models are not bundled; the app downloads them on request:

- **English:** [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX), Apache-2.0.
- **Amharic, Tigrigna, Oromo:** ONNX conversions of Meta's [MMS-TTS](https://huggingface.co/facebook/mms-tts) models, **CC BY-NC 4.0** — these voices may not be used for commercial purposes.
