# M1 + M2 — Persistence, PDF Import, and Rendering

> **Status:** design approved, pending implementation plan. **Date:** 2026-09-01. Covers milestones M1 (persistence + import) and M2 (PDF render) from [docs/implementation-plan.md](../../implementation-plan.md), planned together. Internal name **HearBook**; user-facing name **Enisma**.

## Why these two milestones are planned together

M1 on its own has no observable end state. Finishing it alone means a row appears in SQLite and a card appears in the library, while opening that project still shows mock text about photosynthesis from a different book. The success criterion would be entirely internal.

The two milestones also share a hard design coupling. `projects.page_count` and the per-page `pages` rows both require opening the PDF, and the renderer is the other component that opens it. Deciding who owns that read without M2 in view means deciding it blind.

Combined, the pair has a criterion a person can check in fifteen seconds: pick a PDF from disk, watch it appear in the library, open it, see that PDF's actual first page. The work is still tightly bounded — neither milestone touches the Python sidecar, models, or any download path.

The plan is one spec with **two internally sequenced phases and a checkpoint between them**. Phase 1 (persistence + import) is independently reviewable and committable. If pdf.js integration turns difficult, phase 1 still stands as a shippable increment rather than a stalled combined branch.

## Goals

- A PDF imported from disk becomes a real project that survives an app restart.
- The Home library reads real projects; the editor reads real pages and persists edits.
- The editor's preview panel renders the actual imported PDF.
- Every mock data source consumed by these two screens is deleted, not shadowed.

## Non-goals

- Text extraction and OCR (M3), TTS (M4), export (M5), model download (M6).
- Project deletion. The card's `…` menu stays inert; deletion is a destructive action wanting its own confirmation UX and belongs in its own change.
- Removing the pitch slider. The main plan drops it at M4 on the grounds that no engine exposes pitch natively; acting on that here would pre-empt a decision belonging to a milestone we are not doing.
- Multi-file or non-PDF import. v0 is PDF-only.

## Verified environment facts

These were checked against the installed source rather than recalled, because the design rests on them.

| Fact | Verified how |
| --- | --- |
| Tauri **2.11.0**, `@tauri-apps/api` **2.11.0** | `src-tauri/Cargo.lock`, `node_modules/@tauri-apps/api/package.json` |
| `convertFileSrc(filePath, protocol?)` exists in the installed API | `node_modules/@tauri-apps/api/core.d.ts:158` |
| The asset protocol is **feature-gated**: `protocol-asset = ["http-range"]` | `tauri-2.11.0/Cargo.toml:117` |
| `assetProtocol` is absent from the generated schema **because the feature is off**, not because it is unavailable — `src-tauri/Cargo.toml` currently has `features = []` | `src-tauri/gen/schemas/desktop-schema.json` |
| Config shape is `app.security.assetProtocol: { enable: bool, scope: FsScope }` | `tauri-utils-2.9.0/src/config.rs:2588` |
| `Manager::asset_protocol_scope()` returns a scope with `allow_directory(path, recursive)` and `allow_file(path)` | `tauri-2.11.0/src/lib.rs:761`, `tauri-2.11.0/src/scope/fs.rs:278` |
| `allow_directory` pushes **glob patterns** (`path`, and `path/**` when recursive) rather than snapshotting a listing, so directories created after the grant are covered | `tauri-2.11.0/src/scope/fs.rs:278` — reads `push_pattern(...)`, matched at request time |

Two consequences: enabling `protocol-asset` also brings HTTP range support, which lets pdf.js fetch byte ranges instead of whole files; and a single recursive grant on the projects root at startup covers every project imported later, so import needs no per-project scope call.

**Still to pin at implementation time** — treat as intent to verify, not as settled: the exact directory `app_data_dir()` resolves to on Linux given `productName: "Enisma"` and identifier `com.eyob-g.hear-book`; the `pdfjs-dist` worker setup under Vite against the version that actually resolves; the Rust PDF crate's page-count API; and the `rusqlite` / `tauri-plugin-dialog` versions.

## Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Import UX | **Full import modal** — file picker, then a modal for title + language before the project is created | Explicit; avoids silently labelling an Amharic textbook as English. Costs one new component. |
| Cover palette | **Derived from project id** — a deterministic string hash of the uuid, modulo the five palettes, computed at render time | No schema column, no import-time question, stable across restarts, every project looks distinct. The hash must be a plain deterministic function of the id string (FNV-1a or equivalent); anything seeded, time-dependent, or platform-dependent breaks the stability property silently. Gives up the ability to recolour a book later. |
| `page_count` source | **Rust, at import**, inside the import transaction | The process that owns the file owns the facts about it. Import stays atomic and testable with no webview involved. Costs one Rust dependency that, at M1, only counts pages. |
| PDF bytes → webview | **Asset protocol** + `convertFileSrc`, scope granted at runtime | Range requests mean a 300MB scan opens without loading 300MB. The alternative — a command returning `Vec<u8>` — holds the whole file in memory twice and crosses IPC as one payload. |
| Text panel before M3 | **Empty, editable, persisted** | Exercises and tests the exact write path M3 depends on, and stays coherent beside a real rendered page. |
| `projects.status` | **Derived, not stored** — a departure from the main plan | Every input already lives in `pages`; a stored column is a denormalization that can drift and must be recomputed on every toggle. Costs one aggregate over a few hundred rows. |
| Rust module structure | **Layered modules, thin commands** | Domain functions take `&Connection` and are testable against in-memory SQLite without a Tauri app handle. Matches how `sidecar.rs` is already factored. |

## Architecture

```
src-tauri/src/
  db.rs        connection, migration runner, row↔struct mapping
  project.rs   domain operations + the Tauri commands
  pdf.rs       page counting, copy-into-app-data
  sidecar.rs   unchanged
  lib.rs       registers the new commands, grants the asset scope at startup
```

Commands are thin wrappers over functions that take `&Connection`, so domain logic is unit-testable with `Connection::open_in_memory()`.

## Data layer

**Location.** `app_data_dir()/enisma.db`; PDFs at `app_data_dir()/projects/<id>/source.pdf`, matching the on-disk layout in the main plan.

**Migrations.** A hand-rolled runner keyed on `PRAGMA user_version`, applying ordered steps from a `migrate(&Connection)` function, starting at version 1. No dependency, and later milestones add columns without a rewrite. Each connection sets `PRAGMA foreign_keys = ON`, since SQLite defaults it off and would otherwise silently ignore the `pages` foreign key.

**Schema.** The main plan's tables, minus the fields we dropped, with columns for later milestones included now so M3–M5 do not each need a migration.

```sql
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,      -- uuid; also seeds the cover palette
  title       TEXT NOT NULL,
  language    TEXT NOT NULL,         -- 'en' | 'am' | 'ti' | 'om'
  pdf_path    TEXT NOT NULL,         -- relative to app_data_dir
  page_count  INTEGER NOT NULL,      -- counted by Rust at import
  tts_engine  TEXT,                  -- inert until M4
  voice       TEXT,                  -- inert until M4
  rate        REAL NOT NULL DEFAULT 1.0,
  created_at  TEXT NOT NULL,         -- ISO-8601
  updated_at  TEXT NOT NULL
);

CREATE TABLE pages (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_no     INTEGER NOT NULL,
  source_text TEXT,                  -- NULL until M3
  edited_text TEXT,
  used_ocr    INTEGER NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0,
  audio_path  TEXT,                  -- inert until M5
  UNIQUE(project_id, page_no)
);

CREATE INDEX pages_by_project ON pages(project_id, page_no);
```

**`publisher` is deliberately absent.** It exists in the mock `Project` type and in all six mock records but is never rendered by any component, so it is dead weight rather than a requirement.

**Derived rather than stored:** `status` (zero done → `new`, all done → `done`, otherwise `in-progress`), `pages_reviewed` (a `COUNT(...) FILTER (WHERE done = 1)` aggregate in the list query), `cover` (hash of `id`, computed at render time), and `lastEdited` (a relative-time formatter over `updated_at`, replacing the mock's hardcoded strings).

## Command surface

| Command | Purpose |
| --- | --- |
| `list_projects()` | Summaries plus derived `pages_reviewed`, for Home |
| `get_project(id)` | Project row with an **absolute** `pdf_path`, plus page metadata (`page_no`, `done`) |
| `import_project(title, language, src_path)` | Full import; see below |
| `update_project(id, patch)` | Partial update; `patch` carries optional `title`, `language`, and `rate`, each applied only when present. Touches `updated_at` |
| `get_page(project_id, page_no)` | `source_text` / `edited_text` for the center panel |
| `save_page_text(project_id, page_no, text)` | Writes `edited_text` |
| `set_page_done(project_id, page_no, done)` | Writes `done` |

`get_project` resolves `pdf_path` to absolute in Rust, because the frontend needs it for `convertFileSrc` and should not be doing path arithmetic itself.

Commands return `Result<T, String>`, matching the existing `sidecar_health` convention.

## Import flow

Ordered so that failures are cheap and leave nothing behind.

1. The frontend opens the file picker (`tauri-plugin-dialog`, filtered to `.pdf`), then the import modal — title prefilled from the filename stem, plus a language select.
2. `import_project` validates that the source path exists and is a readable file.
3. **Pages are counted before anything is copied.** This doubles as validation: a corrupt file, or a `.pdf` that is not one, fails here having written nothing.
4. A UUID is generated, `projects/<id>/` is created, and the file is copied to `source.pdf`.
5. One transaction inserts the `projects` row plus `page_count` `pages` rows via a single prepared statement.
6. If the transaction fails, the created directory is removed before the error returns.

Steps 3 and 6 are what keep "a row exists" and "its PDF exists" from ever disagreeing. Every later milestone depends on that invariant to assume a project is complete.

**Error cases surfaced distinctly**, because the modal needs something actionable to display: not a PDF, unreadable file, insufficient disk space, and a path that has already been imported.

## Frontend

**Data access.** A new `src/lib/api.ts` holds typed `invoke` wrappers, following the style already established in `src/lib/platform.ts`. `src/lib/data.ts` keeps the `Project`, `ProjectStatus`, and `CoverPalette` types but loses the `PROJECTS` constant. `src/lib/editor-data.ts` is deleted.

Two things fall out of that deletion. `LANGUAGES` becomes a real `src/lib/languages.ts` holding the four supported languages as `{ code, label }` pairs, shared by the import modal and the settings panel — which also resolves the existing `"Tigrigna"` / `"Tigrinya"` inconsistency, where `VOICES` currently carries duplicate keys to paper over a mismatch between the mock records and the language list. With codes in the database and labels in one table, there is only one spelling. `VOICES` has no real source until M4 and survives as an explicitly named `PLACEHOLDER_VOICES`.

**Import modal.** A new `src/components/home/import-dialog.tsx`. No `dialog` primitive exists in `src/components/ui/` yet; one is added via the `shadcn` skill rather than hand-written, so it matches the existing primitives. `radix-ui` is already a dependency.

**Home.** Loads via `list_projects` on mount. The sidebar `NAV_ITEMS` counts are derived from the result instead of the currently hardcoded `3 / 3 / 2`. Both the sidebar button and `NewProjectTile` open the picker. The `PDF / EPUB / More` chips are removed — v0 is PDF-only, and advertising EPUB is a promise the roadmap does not make. Zero projects needs no special empty state: the grid renders just the new-project tile, which reads as one.

**PDF rendering.** `pdfjs-dist` replaces the fake `PdfPage` component in `center-panel.tsx` with a canvas renderer fed a `convertFileSrc` URL. Behavior: fit-to-width, `devicePixelRatio`-aware scaling so pages are not soft on HiDPI displays, and cancellation of in-flight render tasks when the user holds a paging key — an interaction the existing keyboard model actively encourages.

**Editor.** `EditorRoute` loads through `get_project` rather than `PROJECTS.find`. The page list, done flags, and counts come from real rows. The text panel loads via `get_page` and saves via `save_page_text` on a ~500ms debounce, which makes the existing `saved` / `unsaved changes` indicator truthful for the first time and gives the footer's advertised `Cmd+S` an actual handler. Mark-as-done, the title input, and the language select all persist. The initial `activePage` becomes the first not-done page rather than the hardcoded `18`.

## Testing

The repository currently has no tests of any kind, so part of this work is standing up the harness.

**Rust** — `#[cfg(test)]` modules against `Connection::open_in_memory()`, testing domain functions rather than commands:

- The migration runner reaches version 1 from empty, and re-running is a no-op.
- Import creates the project row plus exactly `page_count` page rows, in one transaction.
- Derived status: zero done → `new`, partial → `in-progress`, all → `done`.
- The `pages_reviewed` aggregate matches the rows.
- A failed transaction leaves no directory behind.
- Page counting against a small fixture PDF committed to the repository.

**Frontend** — vitest covering pure functions only: the cover-palette hash, the relative-time formatter, and the language code↔label mapping. No jsdom, no testing-library, no component tests; that is a substantially larger install for thinner returns at this stage. The cover hash in particular claims a property — stability across restarts — that would fail silently and invisibly.

**pdf.js rendering is verified manually.** It cannot be meaningfully unit-tested here, which is what the phase 2 criteria below are for.

## Acceptance criteria

### Phase 1 — persistence and import (the checkpoint)

1. `cargo test` passes, covering the six Rust cases above.
2. **New project** → picker → the modal appears with the title prefilled from the filename.
3. Confirming creates a library card showing the real page count and 0%.
4. **Quit and relaunch — the project is still there.** This is the milestone's entire point.
5. A non-PDF renamed to `.pdf` produces a readable error in the modal and leaves no directory under `projects/` and no row in the database.
6. Page count is correct for both a 3-page and a 300-page document.
7. The sidecar still starts and `/health` still answers — no M0 regression.

### Phase 2 — rendering and editor wiring

8. Opening a project renders page 1 of that PDF in the preview panel.
9. Holding the paging key through a dozen pages produces no torn or stale renders and no console errors.
10. Typing in the text panel flips the indicator to `unsaved changes`, then `saved`; after relaunch the text is still there.
11. Marking a page done updates the page-panel counts and survives relaunch.
12. The Home card's progress bar reflects that marked page.
13. Split view shows the real rendered page beside the real text panel.

If criteria 1–7 pass and pdf.js integration turns difficult, phase 1 stands alone as a shippable increment. That is the reason these milestones share one spec rather than one branch.

## Risks

- **pdf.js worker bundling under Vite and Tauri is the likeliest thing to stall this work.** It is the reason for the phase checkpoint.
- **Large scanned textbooks.** Range requests should keep memory flat, but this needs checking against a genuinely large file, not a small fixture.
- **`app_data_dir()` resolution** differs by platform and depends on identifier versus productName; confirm the real path before assuming the layout.
- **A Rust PDF crate that only counts pages** is a dependency carried for one function at M1. It may earn its keep later; if the crate proves heavy or unmaintained, reconsider rather than accept it by inertia.

## Follow-ups surfaced but not taken

These were found while reading the repository and are recorded so they are not lost. None are in scope here.

- `HEARBOOK_MODELS_DIR` is documented in `sidecar/README.md` as passed by the supervisor, but `build_command` in `src-tauri/src/sidecar.rs` never sets it. The documentation describes an environment variable that does not exist.
- `sidecarHealth()` in `src/lib/platform.ts` is defined but never called, so the webview→Rust half of the M0 harness is unexercised.
- `LangTag` in `src/components/ui/lang-tag.tsx` is defined but never used; language is not currently displayed on library cards at all.
- Project deletion — the card's `…` menu is inert.
