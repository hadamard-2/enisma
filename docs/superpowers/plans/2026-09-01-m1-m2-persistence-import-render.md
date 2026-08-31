# M1 + M2 — Persistence, PDF Import, and Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an imported PDF a real, persistent project whose actual pages render in the editor, replacing every mock data source on the Home and Editor screens.

**Architecture:** Rust owns a SQLite database and the imported PDF files under the app data directory, exposing typed Tauri commands over domain functions that take a `&Connection` and are unit-testable against in-memory SQLite. The webview reads PDF bytes through Tauri's asset protocol using range requests rather than pulling whole files across IPC. Work is split into two phases with a checkpoint: phase 1 (Tasks 1–8) delivers persistence and import and is independently shippable; phase 2 (Tasks 9–10) adds rendering and editor wiring.

**Tech Stack:** Rust / Tauri 2.11.0, `rusqlite` 0.40.2 (bundled), `lopdf` 0.44.0, `uuid` 1.26.0, `chrono` 0.4.45, `tauri-plugin-dialog` 2.7.3; React 19 + TypeScript, Vite 7, `pdfjs-dist` 6.3.289, `vitest` 4.1.11.

**Spec:** [docs/superpowers/specs/2026-09-01-m1-m2-persistence-import-render-design.md](../specs/2026-09-01-m1-m2-persistence-import-render-design.md)

## Global Constraints

- **Fully offline.** No network calls at runtime. Nothing in this plan may reach the network.
- **User-facing strings say "Enisma".** Internal identifiers stay "HearBook" / `hear-book` / `hear_book_lib`. Never change the bundle identifier `com.eyob-g.hear-book`.
- **Routing uses `HashRouter`, never `BrowserRouter`.**
- **Package manager is Bun.** Use `bun add`, `bun run`, never npm or yarn.
- **Language codes stored in the database are exactly `en`, `am`, `ti`, `om`.** Display labels live in one table in `src/lib/languages.ts`.
- **Markdown prose is never hard-wrapped** — one line per paragraph.
- **Conventional Commits** for every commit: `<type>: <subject>`.
- **Do not `git push`.** Commits only.
- `projects.status` is **derived, never stored**. There is no `status` column.
- Every domain function takes `&Connection` or `&mut Connection` so it is testable without a Tauri `AppHandle`.

---

## File Structure

**Rust (`src-tauri/src/`)**

| File | Responsibility |
| --- | --- |
| `db.rs` | Connection opening, `PRAGMA` setup, the `user_version` migration runner, the v1 schema |
| `project.rs` | Project and page domain operations, the serializable DTOs, and the Tauri commands |
| `pdf.rs` | Page counting and copy-into-app-data; the only module that knows about `lopdf` |
| `import.rs` | Import orchestration — validate, count, copy, insert, compensate on failure |
| `lib.rs` | Registers commands, opens the database into managed state, grants the asset scope |
| `sidecar.rs` | Unchanged |

**Frontend (`src/`)**

| File | Responsibility |
| --- | --- |
| `lib/api.ts` | Typed `invoke` wrappers — the only file that names a Tauri command |
| `lib/languages.ts` | The four supported languages as `{ code, label }`, plus lookup helpers |
| `lib/cover.ts` | Deterministic id → palette hash |
| `lib/time.ts` | `updated_at` → relative-time string |
| `lib/data.ts` | Keeps the `Project` / `ProjectStatus` / `CoverPalette` types; loses `PROJECTS` |
| `lib/editor-data.ts` | **Deleted** in Task 10 |
| `components/ui/dialog.tsx` | shadcn dialog primitive (added in Task 8) |
| `components/home/import-dialog.tsx` | Title + language modal |
| `components/editor/pdf-canvas.tsx` | pdf.js canvas renderer with render-task cancellation |

---

# Phase 1 — Persistence and Import

### Task 1: Database module and migration runner

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod db;`)

**Interfaces:**
- Consumes: nothing
- Produces: `db::open(path: &Path) -> rusqlite::Result<Connection>`, `db::migrate(conn: &Connection) -> rusqlite::Result<()>`, and `db::open_in_memory() -> rusqlite::Result<Connection>` (test-only, used by Tasks 2–5)

- [ ] **Step 1: Add the dependencies**

```bash
cd src-tauri
cargo add rusqlite@0.40.2 --features bundled
cargo add uuid@1.26.0 --features v4
cargo add chrono@0.4.45
```

`bundled` compiles SQLite from source rather than linking a system `libsqlite3`, which is what keeps the packaged app self-contained.

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/db.rs` containing only the test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn migrate_from_empty_reaches_version_1() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let v: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, 1);
    }

    #[test]
    fn migrate_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let v: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, 1);
    }

    #[test]
    fn foreign_keys_are_enforced() {
        let conn = open_in_memory().unwrap();
        let err = conn.execute(
            "INSERT INTO pages (id, project_id, page_no) VALUES ('p', 'nonexistent', 1)",
            [],
        );
        assert!(err.is_err(), "FK violation should be rejected");
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test db::`
Expected: FAIL — `cannot find function 'migrate' in this scope`.

- [ ] **Step 4: Write the implementation**

Put this above the test module in `src-tauri/src/db.rs`:

```rust
//! SQLite storage: connection setup, schema, and the migration runner.

use std::path::Path;

use rusqlite::Connection;

const V1_SCHEMA: &str = r#"
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  language    TEXT NOT NULL,
  pdf_path    TEXT NOT NULL,
  page_count  INTEGER NOT NULL,
  tts_engine  TEXT,
  voice       TEXT,
  rate        REAL NOT NULL DEFAULT 1.0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE pages (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_no     INTEGER NOT NULL,
  source_text TEXT,
  edited_text TEXT,
  used_ocr    INTEGER NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0,
  audio_path  TEXT,
  UNIQUE(project_id, page_no)
);

CREATE INDEX pages_by_project ON pages(project_id, page_no);
"#;

/// Apply pending migrations. Versioned with `PRAGMA user_version` so later
/// milestones can add steps without rewriting this.
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(V1_SCHEMA)?;
        conn.pragma_update(None, "user_version", 1)?;
    }
    Ok(())
}

/// Open the database, enable foreign keys, and migrate.
///
/// SQLite defaults `foreign_keys` to OFF per connection, which would silently
/// neuter the `pages` → `projects` reference.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    Ok(conn)
}

#[cfg(test)]
pub fn open_in_memory() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    Ok(conn)
}
```

Add `mod db;` to the top of `src-tauri/src/lib.rs`, beside the existing `mod sidecar;`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test db::`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/db.rs src-tauri/src/lib.rs
git commit -m "feat(db): add SQLite schema and user_version migration runner"
```

---

### Task 2: Project queries with derived status

**Files:**
- Create: `src-tauri/src/project.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod project;`)

**Interfaces:**
- Consumes: `db::open_in_memory()` from Task 1
- Produces:
  - `project::derive_status(page_count: i64, reviewed: i64) -> &'static str`
  - `project::create_project_with_id(conn: &mut Connection, id: &str, title: &str, language: &str, pdf_path: &str, page_count: i64) -> rusqlite::Result<()>` — used by Task 4
  - `project::list_projects(conn: &Connection) -> rusqlite::Result<Vec<ProjectSummary>>`
  - `project::ProjectSummary { id, title, language, page_count, pages_reviewed, status, updated_at }`, all `camelCase` in JSON

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/project.rs` with only this test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn seed(conn: &mut rusqlite::Connection, id: &str, pages: i64) {
        create_project_with_id(conn, id, "Grade 7 Science", "en", "projects/x/source.pdf", pages)
            .unwrap();
    }

    #[test]
    fn derive_status_covers_all_three_states() {
        assert_eq!(derive_status(10, 0), "new");
        assert_eq!(derive_status(10, 4), "in-progress");
        assert_eq!(derive_status(10, 10), "done");
    }

    #[test]
    fn create_project_inserts_one_page_row_per_page() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn, "abc", 7);
        let pages: i64 = conn
            .query_row("SELECT COUNT(*) FROM pages WHERE project_id = 'abc'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pages, 7);
    }

    #[test]
    fn list_projects_reports_zero_reviewed_as_new() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn, "abc", 3);
        let list = list_projects(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].pages_reviewed, 0);
        assert_eq!(list[0].status, "new");
        assert_eq!(list[0].page_count, 3);
    }

    #[test]
    fn list_projects_counts_reviewed_pages() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn, "abc", 3);
        conn.execute("UPDATE pages SET done = 1 WHERE page_no <= 2", []).unwrap();
        let list = list_projects(&conn).unwrap();
        assert_eq!(list[0].pages_reviewed, 2);
        assert_eq!(list[0].status, "in-progress");
    }

    #[test]
    fn all_pages_done_reports_done() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn, "abc", 3);
        conn.execute("UPDATE pages SET done = 1", []).unwrap();
        assert_eq!(list_projects(&conn).unwrap()[0].status, "done");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test project::`
Expected: FAIL — `cannot find function 'derive_status'`.

- [ ] **Step 3: Write the implementation**

Above the test module in `src-tauri/src/project.rs`:

```rust
//! Project and page domain operations.
//!
//! Every function takes a connection rather than an `AppHandle` so the logic is
//! testable against in-memory SQLite. The Tauri commands (Task 6) are thin
//! wrappers over these.

use chrono::Utc;
use rusqlite::{params, Connection};
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub title: String,
    pub language: String,
    pub page_count: i64,
    pub pages_reviewed: i64,
    pub status: String,
    pub updated_at: String,
}

/// Status is derived, never stored: every input already lives in `pages`.
pub fn derive_status(page_count: i64, reviewed: i64) -> &'static str {
    if reviewed == 0 {
        "new"
    } else if reviewed >= page_count {
        "done"
    } else {
        "in-progress"
    }
}

/// Insert a project and its page rows in one transaction.
///
/// Takes the id from the caller so the import (Task 4) can name the on-disk
/// directory and the database row identically.
pub fn create_project_with_id(
    conn: &mut Connection,
    id: &str,
    title: &str,
    language: &str,
    pdf_path: &str,
    page_count: i64,
) -> rusqlite::Result<()> {
    let now = Utc::now().to_rfc3339();
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO projects
           (id, title, language, pdf_path, page_count, rate, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1.0, ?6, ?6)",
        params![id, title, language, pdf_path, page_count, now],
    )?;
    {
        let mut stmt =
            tx.prepare("INSERT INTO pages (id, project_id, page_no) VALUES (?1, ?2, ?3)")?;
        for n in 1..=page_count {
            stmt.execute(params![Uuid::new_v4().to_string(), id, n])?;
        }
    }
    tx.commit()
}

pub fn list_projects(conn: &Connection) -> rusqlite::Result<Vec<ProjectSummary>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.title, p.language, p.page_count, p.updated_at,
                (SELECT COUNT(*) FROM pages WHERE project_id = p.id AND done = 1)
         FROM projects p
         ORDER BY p.updated_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        let page_count: i64 = r.get(3)?;
        let pages_reviewed: i64 = r.get(5)?;
        Ok(ProjectSummary {
            id: r.get(0)?,
            title: r.get(1)?,
            language: r.get(2)?,
            page_count,
            updated_at: r.get(4)?,
            pages_reviewed,
            status: derive_status(page_count, pages_reviewed).to_string(),
        })
    })?;
    rows.collect()
}
```

Add `mod project;` to `src-tauri/src/lib.rs`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test project::`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/project.rs src-tauri/src/lib.rs
git commit -m "feat(project): add project creation and listing with derived status"
```

---

### Task 3: PDF page counting

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/pdf.rs`
- Create: `src-tauri/tests/fixtures/three-pages.pdf`
- Modify: `src-tauri/src/lib.rs` (add `mod pdf;`)

**Interfaces:**
- Consumes: nothing
- Produces: `pdf::count_pages(path: &Path) -> Result<i64, String>` — used by Task 4

- [ ] **Step 1: Add lopdf**

```bash
cd src-tauri && cargo add lopdf@0.44.0
```

- [ ] **Step 2: Generate the fixture PDF**

This exact command was run and its output independently confirmed at 3 pages by both `mutool info` and `pdfinfo`. It needs Ghostscript **only on the machine generating the fixture** — the resulting file is committed, so `cargo test` never needs it.

```bash
mkdir -p src-tauri/tests/fixtures && cd src-tauri/tests/fixtures && printf '/Helvetica findfont 24 scalefont setfont\n1 1 3 {\n  /n exch def\n  72 500 moveto (Fixture page ) show n 3 string cvs show\n  showpage\n} for\n' > mk.ps && gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -sOutputFile=three-pages.pdf mk.ps && rm mk.ps && ls -l three-pages.pdf
```

Expected: a file of roughly 3KB.

- [ ] **Step 3: Write the failing tests**

Create `src-tauri/src/pdf.rs` with only this test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
    }

    #[test]
    fn counts_pages_in_a_real_pdf() {
        assert_eq!(count_pages(&fixture("three-pages.pdf")).unwrap(), 3);
    }

    #[test]
    fn rejects_a_file_that_is_not_a_pdf() {
        let path = std::env::temp_dir().join("enisma-not-a.pdf");
        std::fs::write(&path, b"this is plainly not a PDF").unwrap();
        let err = count_pages(&path).unwrap_err();
        assert!(err.contains("PDF"), "error should mention PDF, got: {err}");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn rejects_a_missing_file() {
        assert!(count_pages(&fixture("does-not-exist.pdf")).is_err());
    }
}
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test pdf::`
Expected: FAIL — `cannot find function 'count_pages'`.

- [ ] **Step 5: Write the implementation**

Above the test module in `src-tauri/src/pdf.rs`:

```rust
//! PDF inspection. The only module that knows about `lopdf`.

use std::path::Path;

use lopdf::Document;

/// Count the pages in a PDF.
///
/// Doubles as import validation: this runs before anything is copied, so a
/// corrupt file or a `.pdf` that is not one fails having written nothing.
pub fn count_pages(path: &Path) -> Result<i64, String> {
    let doc = Document::load(path).map_err(|e| format!("not a readable PDF: {e}"))?;
    let n = doc.get_pages().len() as i64;
    if n == 0 {
        return Err("PDF contains no pages".into());
    }
    Ok(n)
}
```

`Document::load` takes `P: AsRef<Path>` and `get_pages()` returns a map of page number to object id, so `.len()` is the page count.

Add `mod pdf;` to `src-tauri/src/lib.rs`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test pdf::`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/pdf.rs src-tauri/src/lib.rs src-tauri/tests/fixtures/three-pages.pdf
git commit -m "feat(pdf): count pages with lopdf and validate the source file"
```

---

### Task 4: Import orchestration with failure cleanup

**Files:**
- Create: `src-tauri/src/import.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod import;`)

**Interfaces:**
- Consumes: `pdf::count_pages`, `project::create_project_with_id`, `db::open_in_memory`
- Produces: `import::import_project(conn: &mut Connection, data_dir: &Path, title: &str, language: &str, src: &Path) -> Result<String, String>` returning the new project id — used by Task 6

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/import.rs` with only this test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::path::PathBuf;

    fn fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/three-pages.pdf")
    }

    fn temp_data_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("enisma-test-{name}"));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn import_copies_the_pdf_and_creates_rows() {
        let mut conn = db::open_in_memory().unwrap();
        let data = temp_data_dir("ok");
        let id = import_project(&mut conn, &data, "Grade 7 Science", "en", &fixture()).unwrap();

        assert!(data.join("projects").join(&id).join("source.pdf").is_file());

        let (count, pages): (i64, i64) = conn
            .query_row(
                "SELECT page_count, (SELECT COUNT(*) FROM pages WHERE project_id = ?1)
                 FROM projects WHERE id = ?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(count, 3);
        assert_eq!(pages, 3);
    }

    #[test]
    fn import_stores_a_relative_pdf_path() {
        let mut conn = db::open_in_memory().unwrap();
        let data = temp_data_dir("relpath");
        let id = import_project(&mut conn, &data, "T", "am", &fixture()).unwrap();
        let stored: String = conn
            .query_row("SELECT pdf_path FROM projects WHERE id = ?1", [&id], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, format!("projects/{id}/source.pdf"));
    }

    #[test]
    fn a_non_pdf_leaves_no_directory_and_no_row() {
        let mut conn = db::open_in_memory().unwrap();
        let data = temp_data_dir("bad");
        let bad = data.join("not-really.pdf");
        std::fs::write(&bad, b"nope").unwrap();

        assert!(import_project(&mut conn, &data, "T", "en", &bad).is_err());

        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "no project row should survive a failed import");
        assert!(
            !data.join("projects").exists() || std::fs::read_dir(data.join("projects")).unwrap().count() == 0,
            "no project directory should be left behind"
        );
    }

    #[test]
    fn a_missing_source_is_rejected() {
        let mut conn = db::open_in_memory().unwrap();
        let data = temp_data_dir("missing");
        let err = import_project(&mut conn, &data, "T", "en", &data.join("ghost.pdf")).unwrap_err();
        assert!(err.contains("does not exist"), "got: {err}");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test import::`
Expected: FAIL — `cannot find function 'import_project'`.

- [ ] **Step 3: Write the implementation**

Above the test module in `src-tauri/src/import.rs`:

```rust
//! Import orchestration.
//!
//! Ordered so failures are cheap: the PDF is parsed before anything is copied,
//! and the directory is removed if the transaction fails. Together these keep
//! "a row exists" and "its PDF exists" from ever disagreeing — an invariant
//! every later milestone relies on.

use std::fs;
use std::path::Path;

use rusqlite::Connection;
use uuid::Uuid;

use crate::pdf;
use crate::project;

pub fn import_project(
    conn: &mut Connection,
    data_dir: &Path,
    title: &str,
    language: &str,
    src: &Path,
) -> Result<String, String> {
    if !src.is_file() {
        return Err("source file does not exist".into());
    }

    // Parse before copying: a corrupt file fails here, having written nothing.
    let page_count = pdf::count_pages(src)?;

    let id = Uuid::new_v4().to_string();
    let dir = data_dir.join("projects").join(&id);
    fs::create_dir_all(&dir).map_err(|e| format!("could not create project directory: {e}"))?;

    if let Err(e) = fs::copy(src, dir.join("source.pdf")) {
        let _ = fs::remove_dir_all(&dir);
        return Err(format!("could not copy PDF: {e}"));
    }

    let rel = format!("projects/{id}/source.pdf");
    if let Err(e) = project::create_project_with_id(conn, &id, title, language, &rel, page_count) {
        let _ = fs::remove_dir_all(&dir);
        return Err(format!("could not save project: {e}"));
    }

    Ok(id)
}
```

Add `mod import;` to `src-tauri/src/lib.rs`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test import::`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/import.rs src-tauri/src/lib.rs
git commit -m "feat(import): copy PDF into app data and create rows atomically"
```

> **⚠ Open item — needs a decision before this task is considered complete.** The spec lists four import errors to surface distinctly: not a PDF, unreadable, insufficient space, and **a path that has already been imported**. The first three are implemented above. The fourth cannot be: detecting a re-import requires remembering the *original* source path, and the v1 schema stores only the relative path of the copied file. The three options are (a) drop the requirement — re-importing the same textbook twice is arguably legitimate, since the copy makes them independent projects; (b) add `source_path TEXT` to the v1 schema in Task 1, which is free right now because v1 has not shipped, and warn on a match rather than blocking; (c) defer it to its own change later, which then costs a migration. **Do not pick one while executing — ask.** This plan implements (a) by omission and is internally consistent that way.

---

### Task 5: Page read and write operations

**Files:**
- Modify: `src-tauri/src/project.rs`

**Interfaces:**
- Consumes: `db::open_in_memory`, `project::create_project_with_id`
- Produces:
  - `project::ProjectDetail { id, title, language, page_count, pdf_path, rate, pages: Vec<PageMeta> }`
  - `project::PageMeta { page_no: i64, done: bool }`
  - `project::PageText { source_text: Option<String>, edited_text: Option<String> }`
  - `project::get_project(conn: &Connection, id: &str) -> rusqlite::Result<ProjectDetail>`
  - `project::get_page(conn: &Connection, project_id: &str, page_no: i64) -> rusqlite::Result<PageText>`
  - `project::save_page_text(conn: &Connection, project_id: &str, page_no: i64, text: &str) -> rusqlite::Result<()>`
  - `project::set_page_done(conn: &Connection, project_id: &str, page_no: i64, done: bool) -> rusqlite::Result<()>`
  - `project::update_project(conn: &Connection, id: &str, title: Option<&str>, language: Option<&str>, rate: Option<f64>) -> rusqlite::Result<()>`

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `src-tauri/src/project.rs`:

```rust
    #[test]
    fn get_project_returns_page_metadata_in_order() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn, "abc", 3);
        let detail = get_project(&conn, "abc").unwrap();
        assert_eq!(detail.page_count, 3);
        assert_eq!(detail.pages.len(), 3);
        assert_eq!(detail.pages[0].page_no, 1);
        assert_eq!(detail.pages[2].page_no, 3);
        assert!(!detail.pages[0].done);
    }

    #[test]
    fn saving_page_text_round_trips() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn, "abc", 2);
        save_page_text(&conn, "abc", 2, "corrected text").unwrap();
        let page = get_page(&conn, "abc", 2).unwrap();
        assert_eq!(page.edited_text.as_deref(), Some("corrected text"));
        assert_eq!(page.source_text, None, "extraction has not run yet");
    }

    #[test]
    fn marking_a_page_done_is_visible_in_the_summary() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn, "abc", 4);
        set_page_done(&conn, "abc", 1, true).unwrap();
        assert_eq!(list_projects(&conn).unwrap()[0].pages_reviewed, 1);
        set_page_done(&conn, "abc", 1, false).unwrap();
        assert_eq!(list_projects(&conn).unwrap()[0].pages_reviewed, 0);
    }

    #[test]
    fn update_project_applies_only_the_fields_present() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn, "abc", 1);
        update_project(&conn, "abc", Some("New Title"), None, None).unwrap();
        let detail = get_project(&conn, "abc").unwrap();
        assert_eq!(detail.title, "New Title");
        assert_eq!(detail.language, "en", "language must be untouched");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test project::`
Expected: FAIL — `cannot find function 'get_project'`.

- [ ] **Step 3: Write the implementation**

Append to `src-tauri/src/project.rs`, above the test module:

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMeta {
    pub page_no: i64,
    pub done: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDetail {
    pub id: String,
    pub title: String,
    pub language: String,
    pub page_count: i64,
    /// Absolute on disk. Resolved in Rust so the webview never does path
    /// arithmetic; the frontend passes it straight to `convertFileSrc`.
    pub pdf_path: String,
    pub rate: f64,
    pub pages: Vec<PageMeta>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageText {
    pub source_text: Option<String>,
    pub edited_text: Option<String>,
}

pub fn get_project(conn: &Connection, id: &str) -> rusqlite::Result<ProjectDetail> {
    let (title, language, page_count, pdf_path, rate) = conn.query_row(
        "SELECT title, language, page_count, pdf_path, rate FROM projects WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;

    let mut stmt = conn
        .prepare("SELECT page_no, done FROM pages WHERE project_id = ?1 ORDER BY page_no")?;
    let pages = stmt
        .query_map([id], |r| {
            Ok(PageMeta {
                page_no: r.get(0)?,
                done: r.get::<_, i64>(1)? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(ProjectDetail { id: id.to_string(), title, language, page_count, pdf_path, rate, pages })
}

pub fn get_page(conn: &Connection, project_id: &str, page_no: i64) -> rusqlite::Result<PageText> {
    conn.query_row(
        "SELECT source_text, edited_text FROM pages WHERE project_id = ?1 AND page_no = ?2",
        params![project_id, page_no],
        |r| Ok(PageText { source_text: r.get(0)?, edited_text: r.get(1)? }),
    )
}

pub fn save_page_text(
    conn: &Connection,
    project_id: &str,
    page_no: i64,
    text: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE pages SET edited_text = ?3 WHERE project_id = ?1 AND page_no = ?2",
        params![project_id, page_no, text],
    )?;
    touch(conn, project_id)
}

pub fn set_page_done(
    conn: &Connection,
    project_id: &str,
    page_no: i64,
    done: bool,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE pages SET done = ?3 WHERE project_id = ?1 AND page_no = ?2",
        params![project_id, page_no, if done { 1 } else { 0 }],
    )?;
    touch(conn, project_id)
}

pub fn update_project(
    conn: &Connection,
    id: &str,
    title: Option<&str>,
    language: Option<&str>,
    rate: Option<f64>,
) -> rusqlite::Result<()> {
    if let Some(t) = title {
        conn.execute("UPDATE projects SET title = ?2 WHERE id = ?1", params![id, t])?;
    }
    if let Some(l) = language {
        conn.execute("UPDATE projects SET language = ?2 WHERE id = ?1", params![id, l])?;
    }
    if let Some(r) = rate {
        conn.execute("UPDATE projects SET rate = ?2 WHERE id = ?1", params![id, r])?;
    }
    touch(conn, id)
}

/// Bump `updated_at`, which drives library ordering and the relative-time label.
fn touch(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE projects SET updated_at = ?2 WHERE id = ?1",
        params![id, Utc::now().to_rfc3339()],
    )?;
    Ok(())
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test project::`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/project.rs
git commit -m "feat(project): add page read/write and partial project update"
```

---

### Task 6: Tauri commands, managed state, and configuration

**Files:**
- Modify: `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/src/lib.rs`, `src-tauri/src/project.rs`
- Modify: `package.json`

**Interfaces:**
- Consumes: everything from Tasks 1–5
- Produces: the commands `list_projects`, `get_project`, `import_project`, `update_project`, `get_page`, `save_page_text`, `set_page_done` — consumed by Tasks 8 and 10

- [ ] **Step 1: Enable the asset protocol and add the dialog plugin**

```bash
cd src-tauri && cargo add tauri-plugin-dialog@2.7.3
cd .. && bun add @tauri-apps/plugin-dialog@2.7.3
```

In `src-tauri/Cargo.toml`, change the `tauri` dependency to enable the feature:

```toml
tauri = { version = "2", features = ["protocol-asset"] }
```

This is what makes `assetProtocol` available at all — it is feature-gated (`protocol-asset = ["http-range"]`), which is why the key is absent from the generated schema today. It also brings HTTP range support, which is what lets pdf.js fetch byte ranges instead of whole files in Task 9.

- [ ] **Step 2: Enable the protocol in the Tauri config**

In `src-tauri/tauri.conf.json`, replace the `app.security` block:

```json
    "security": {
      "csp": null,
      "assetProtocol": {
        "enable": true,
        "scope": []
      }
    }
```

The scope stays empty here because the app data path is only known at runtime; Step 4 grants it then.

- [ ] **Step 3: Allow the file-open dialog**

In `src-tauri/capabilities/default.json`, add `"dialog:allow-open"` to the `permissions` array, after `"opener:default"`.

- [ ] **Step 4: Wire state, the scope grant, and the commands**

Replace the body of `run()` in `src-tauri/src/lib.rs`:

```rust
mod db;
mod import;
mod pdf;
mod project;
mod sidecar;

use std::sync::Mutex;

use sidecar::SidecarState;
use tauri::{Manager, RunEvent};

/// The open database, guarded for use from command handlers.
pub struct Db(pub Mutex<rusqlite::Connection>);

/// The app data directory, resolved once at startup.
pub struct DataDir(pub std::path::PathBuf);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarState::new())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(data_dir.join("projects"))?;

            // Let the webview read project PDFs through the asset protocol.
            // `allow_directory` pushes glob patterns rather than snapshotting a
            // listing, so projects imported later are covered by this one grant.
            app.asset_protocol_scope()
                .allow_directory(data_dir.join("projects"), true)?;

            let conn = db::open(&data_dir.join("enisma.db"))?;
            app.manage(Db(Mutex::new(conn)));
            app.manage(DataDir(data_dir));

            sidecar::spawn_supervisor(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar::sidecar_health,
            project::list_projects_cmd,
            project::get_project_cmd,
            project::import_project_cmd,
            project::update_project_cmd,
            project::get_page_cmd,
            project::save_page_text_cmd,
            project::set_page_done_cmd,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                app_handle.state::<SidecarState>().shutdown();
            }
        });
}
```

- [ ] **Step 5: Add the command wrappers**

Append to `src-tauri/src/project.rs`, above the test module:

```rust
use tauri::State;

use crate::{DataDir, Db};

/// Commands are thin: they lock the connection and delegate. All domain logic
/// lives in the functions above, which are tested without Tauri.
#[tauri::command]
pub fn list_projects_cmd(db: State<'_, Db>) -> Result<Vec<ProjectSummary>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    list_projects(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_project_cmd(db: State<'_, Db>, data: State<'_, DataDir>, id: String) -> Result<ProjectDetail, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut detail = get_project(&conn, &id).map_err(|e| e.to_string())?;
    detail.pdf_path = data.0.join(&detail.pdf_path).to_string_lossy().into_owned();
    Ok(detail)
}

#[tauri::command]
pub fn import_project_cmd(
    db: State<'_, Db>,
    data: State<'_, DataDir>,
    title: String,
    language: String,
    src_path: String,
) -> Result<String, String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    crate::import::import_project(
        &mut conn,
        &data.0,
        &title,
        &language,
        std::path::Path::new(&src_path),
    )
}

#[tauri::command]
pub fn update_project_cmd(
    db: State<'_, Db>,
    id: String,
    title: Option<String>,
    language: Option<String>,
    rate: Option<f64>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    update_project(&conn, &id, title.as_deref(), language.as_deref(), rate)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_page_cmd(db: State<'_, Db>, project_id: String, page_no: i64) -> Result<PageText, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    get_page(&conn, &project_id, page_no).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_page_text_cmd(
    db: State<'_, Db>,
    project_id: String,
    page_no: i64,
    text: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    save_page_text(&conn, &project_id, page_no, &text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_page_done_cmd(
    db: State<'_, Db>,
    project_id: String,
    page_no: i64,
    done: bool,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    set_page_done(&conn, &project_id, page_no, done).map_err(|e| e.to_string())
}
```

- [ ] **Step 6: Verify it compiles and the suite still passes**

Run: `cd src-tauri && cargo test`
Expected: PASS, 19 tests (3 `db`, 9 `project`, 3 `pdf`, 4 `import`), no warnings about unused imports.

- [ ] **Step 7: Verify the app still launches and the sidecar is unaffected**

Run: `bun run tauri dev`
Expected: the window opens, and the terminal shows `[sidecar] ready on 127.0.0.1:<port>`. This is acceptance criterion 7. Confirm `enisma.db` was created — print the resolved path by temporarily adding `eprintln!("data dir: {data_dir:?}");` in `setup`, note it, then remove the line.

- [ ] **Step 8: Commit**

```bash
git add src-tauri package.json bun.lock
git commit -m "feat(commands): expose project and page commands over Tauri

- enable the protocol-asset feature and grant the projects dir at runtime
- add tauri-plugin-dialog and the dialog:allow-open permission
- open the database into managed state at startup"
```

---

### Task 7: Frontend pure helpers with vitest

**Files:**
- Modify: `package.json`, `vite.config.ts`
- Create: `src/lib/languages.ts`, `src/lib/cover.ts`, `src/lib/time.ts`
- Create: `src/lib/cover.test.ts`, `src/lib/time.test.ts`, `src/lib/languages.test.ts`

**Interfaces:**
- Consumes: `CoverPalette` from `src/lib/data.ts`
- Produces: `coverForId(id: string): CoverPalette`, `relativeTime(iso: string, now?: Date): string`, `LANGUAGES: Language[]`, `labelForCode(code: string): string`, `type LanguageCode = "en" | "am" | "ti" | "om"`

- [ ] **Step 1: Add vitest**

```bash
bun add -d vitest@4.1.11
```

Add to `package.json` scripts: `"test": "vitest run"`.

In `vite.config.ts`, add a `test` key to the exported config:

```ts
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
```

If TypeScript complains the key is unknown, add `/// <reference types="vitest/config" />` as the first line of the file.

- [ ] **Step 2: Write the failing tests**

`src/lib/cover.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { coverForId } from "./cover";

describe("coverForId", () => {
  it("is stable for the same id", () => {
    const id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    expect(coverForId(id)).toBe(coverForId(id));
  });

  it("always returns a known palette", () => {
    const known = ["warm", "teal", "rose", "amber", "slate"];
    for (let i = 0; i < 200; i++) {
      expect(known).toContain(coverForId(`id-${i}`));
    }
  });

  it("spreads ids across more than one palette", () => {
    const seen = new Set(Array.from({ length: 50 }, (_, i) => coverForId(`id-${i}`)));
    expect(seen.size).toBeGreaterThan(1);
  });
});
```

`src/lib/time.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { relativeTime } from "./time";

const NOW = new Date("2026-09-01T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("relativeTime", () => {
  it("reports seconds as just now", () => {
    expect(relativeTime(ago(30_000), NOW)).toBe("just now");
  });

  it("pluralises minutes correctly", () => {
    expect(relativeTime(ago(60_000), NOW)).toBe("1 minute ago");
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe("5 minutes ago");
  });

  it("reports hours", () => {
    expect(relativeTime(ago(2 * 3_600_000), NOW)).toBe("2 hours ago");
  });

  it("reports one day as yesterday", () => {
    expect(relativeTime(ago(25 * 3_600_000), NOW)).toBe("yesterday");
  });

  it("reports one week as last week", () => {
    expect(relativeTime(ago(8 * 24 * 3_600_000), NOW)).toBe("last week");
  });
});
```

`src/lib/languages.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LANGUAGES, labelForCode } from "./languages";

describe("languages", () => {
  it("covers exactly the four supported codes", () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual(["en", "am", "ti", "om"]);
  });

  it("uses the Tigrinya spelling", () => {
    expect(labelForCode("ti")).toBe("Tigrinya");
  });

  it("falls back to the raw code when unknown", () => {
    expect(labelForCode("zz")).toBe("zz");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun run test`
Expected: FAIL — cannot resolve `./cover`, `./time`, `./languages`.

- [ ] **Step 4: Write the implementations**

`src/lib/languages.ts`:

```ts
export type LanguageCode = "en" | "am" | "ti" | "om";

export interface Language {
  code: LanguageCode;
  label: string;
}

/** The four supported languages. This is the single source of spelling. */
export const LANGUAGES: Language[] = [
  { code: "en", label: "English" },
  { code: "am", label: "Amharic" },
  { code: "ti", label: "Tigrinya" },
  { code: "om", label: "Oromo" },
];

export function labelForCode(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code;
}
```

`src/lib/cover.ts`:

```ts
import type { CoverPalette } from "./data";

const PALETTES: CoverPalette[] = ["warm", "teal", "rose", "amber", "slate"];

/**
 * Pick a cover palette from the project id.
 *
 * Must stay a plain deterministic function of the string — FNV-1a here. Any
 * seeded, time-dependent, or platform-dependent hash would change a book's
 * colour between launches, which fails silently and looks like nothing.
 */
export function coverForId(id: string): CoverPalette {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return PALETTES[h % PALETTES.length]!;
}
```

`src/lib/time.ts`:

```ts
/** Format an ISO-8601 timestamp as the library's relative-time label. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const seconds = Math.floor((now.getTime() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;

  const weeks = Math.floor(days / 7);
  if (weeks === 1) return "last week";
  return `${weeks} weeks ago`;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run test`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock vite.config.ts src/lib/cover.ts src/lib/time.ts src/lib/languages.ts src/lib/cover.test.ts src/lib/time.test.ts src/lib/languages.test.ts
git commit -m "feat(lib): add cover hash, relative time, and language table with tests"
```

---

### Task 8: API wrappers, import dialog, and Home wiring

**Files:**
- Create: `src/lib/api.ts`, `src/components/ui/dialog.tsx`, `src/components/home/import-dialog.tsx`
- Modify: `src/components/home/home.tsx`, `src/components/home/project-card.tsx`, `src/components/home/project-cover.tsx`, `src/lib/data.ts`

**Interfaces:**
- Consumes: the commands from Task 6; `coverForId`, `relativeTime`, `LANGUAGES` from Task 7
- Produces: `api.listProjects()`, `api.importProject()`, `api.getProject()`, `api.getPage()`, `api.savePageText()`, `api.setPageDone()`, `api.updateProject()`, and the `ProjectSummary` / `ProjectDetail` / `PageMeta` / `PageText` TypeScript types — consumed by Task 10

- [ ] **Step 1: Write the API wrappers**

`src/lib/api.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import type { LanguageCode } from "./languages";

export interface ProjectSummary {
  id: string;
  title: string;
  language: LanguageCode;
  pageCount: number;
  pagesReviewed: number;
  status: "new" | "in-progress" | "done";
  updatedAt: string;
}

export interface PageMeta {
  pageNo: number;
  done: boolean;
}

export interface ProjectDetail {
  id: string;
  title: string;
  language: LanguageCode;
  pageCount: number;
  /** Absolute path, already resolved by Rust; feed to convertFileSrc. */
  pdfPath: string;
  rate: number;
  pages: PageMeta[];
}

export interface PageText {
  sourceText: string | null;
  editedText: string | null;
}

export const listProjects = () => invoke<ProjectSummary[]>("list_projects_cmd");

export const getProject = (id: string) => invoke<ProjectDetail>("get_project_cmd", { id });

export const importProject = (title: string, language: string, srcPath: string) =>
  invoke<string>("import_project_cmd", { title, language, srcPath });

export const updateProject = (
  id: string,
  patch: { title?: string; language?: string; rate?: number },
) => invoke<void>("update_project_cmd", { id, ...patch });

export const getPage = (projectId: string, pageNo: number) =>
  invoke<PageText>("get_page_cmd", { projectId, pageNo });

export const savePageText = (projectId: string, pageNo: number, text: string) =>
  invoke<void>("save_page_text_cmd", { projectId, pageNo, text });

export const setPageDone = (projectId: string, pageNo: number, done: boolean) =>
  invoke<void>("set_page_done_cmd", { projectId, pageNo, done });
```

- [ ] **Step 2: Add the shadcn dialog primitive**

```bash
bunx shadcn@latest add dialog
```

Confirm it wrote `src/components/ui/dialog.tsx` and that it matches the import style of the neighbouring primitives (`@/lib/utils` for `cn`). If the generator rewrites unrelated files, revert those — only `dialog.tsx` should be added.

- [ ] **Step 3: Write the import dialog**

`src/components/home/import-dialog.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LANGUAGES } from "@/lib/languages";
import { importProject } from "@/lib/api";

export function ImportDialog({
  srcPath,
  onCancel,
  onImported,
}: {
  srcPath: string | null;
  onCancel: () => void;
  onImported: (id: string) => void;
}) {
  const stem = srcPath?.split(/[/\\]/).pop()?.replace(/\.pdf$/i, "") ?? "";
  const [title, setTitle] = useState(stem);
  const [language, setLanguage] = useState<string>("en");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!srcPath || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onImported(await importProject(title.trim(), language, srcPath));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={srcPath !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-105">
        <DialogHeader>
          <DialogTitle className="font-serif">Import a textbook</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium uppercase tracking-widest text-ink-3">
              Title
            </label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium uppercase tracking-widest text-ink-3">
              Language
            </label>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l.code} value={l.code}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="truncate font-mono text-[11px] text-ink-3">{srcPath}</div>

          {error && (
            <div className="rounded-md border border-line bg-paper-2 px-3 py-2 text-[12.5px] text-amber-ink">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={busy || !title.trim()}>
            {busy ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Rewire Home to real data**

In `src/components/home/home.tsx`:

1. Delete the `import { PROJECTS } from "@/lib/data"` line and add `import { open } from "@tauri-apps/plugin-dialog"`, `import { listProjects, type ProjectSummary } from "@/lib/api"`, `import { relativeTime } from "@/lib/time"`, and `import { ImportDialog } from "./import-dialog"`.
2. Replace the module-level `NAV_ITEMS` constant with a `useMemo` inside the component that derives counts from loaded projects:

```tsx
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [pending, setPending] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listProjects().then(setProjects).catch(console.error);
  }, []);

  useEffect(refresh, [refresh]);

  async function pickFile() {
    const chosen = await open({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (typeof chosen === "string") setPending(chosen);
  }

  const navItems = useMemo(
    () => [
      { label: "All projects", key: "All" as const, icon: Layers, count: projects.length },
      {
        label: "Recent",
        key: "Recent" as const,
        icon: Clock,
        count: projects.filter((p) => Date.now() - new Date(p.updatedAt).getTime() < 86_400_000)
          .length,
      },
      {
        label: "In progress",
        key: "In progress" as const,
        icon: FileText,
        count: projects.filter((p) => p.status === "in-progress").length,
      },
      {
        label: "Completed",
        key: "Completed" as const,
        icon: Check,
        count: projects.filter((p) => p.status === "done").length,
      },
    ],
    [projects],
  );
```

3. Replace `PROJECTS.filter(...)` in the `filtered` memo with `projects.filter(...)`, replacing the `RECENT_LABELS` check with the same 24-hour `updatedAt` comparison used above, and the `pagesReviewed / pagesTotal` sort with `pagesReviewed / pageCount`. Delete the now-unused `RECENT_LABELS` constant.
4. Replace the hardcoded `· last activity 2 hours ago` in the subtitle with a value derived from the newest `updatedAt`: `{projects[0] ? ` · last activity ${relativeTime(projects[0].updatedAt)}` : ""}`.
5. Wire both entry points to `pickFile`: add `onClick={pickFile}` to the sidebar "New project" `Button` and pass it into `NewProjectTile` as a prop.
6. In `NewProjectTile`, accept `{ onClick }`, put it on the `button`, and delete the `["PDF", "EPUB", "More"]` chip row entirely — v0 is PDF-only.
7. Render the dialog just before the closing tag of the outer `div`:

```tsx
      <ImportDialog
        srcPath={pending}
        onCancel={() => setPending(null)}
        onImported={(id) => {
          setPending(null);
          refresh();
          navigate(`/project/${id}`);
        }}
      />
```

- [ ] **Step 5: Adapt the card and cover to the new shape**

In `src/lib/data.ts`, delete the `PROJECTS` constant and the `publisher` field from the `Project` interface, keeping `ProjectStatus` and `CoverPalette`.

In `src/components/home/project-card.tsx`, change the prop type to `ProjectSummary` from `@/lib/api`, replace `project.pagesTotal` with `project.pageCount`, and replace `project.lastEdited` with `relativeTime(project.updatedAt)`.

In `src/components/home/project-cover.tsx`, change the prop type to `ProjectSummary` and replace `palettes[project.cover]` with `palettes[coverForId(project.id)]`, importing `coverForId` from `@/lib/cover`.

- [ ] **Step 6: Verify the build typechecks**

Run: `bun run build`
Expected: no TypeScript errors. Fix any residual references to removed fields.

- [ ] **Step 7: Manual acceptance — phase 1 criteria 2–6**

Run: `bun run tauri dev`

Verify each in order:
- Clicking **New project** opens a file picker filtered to PDFs.
- Choosing a PDF opens the modal with the title prefilled from the filename.
- Confirming creates a card showing the real page count and 0%.
- **Quit the app and relaunch — the project is still listed.**
- Renaming a file to `.pdf` that is not a PDF, then importing it, shows a readable error in the modal and creates no card. Confirm no stray directory under `<data dir>/projects/`.
- Importing a 300-page PDF shows the correct page count.

- [ ] **Step 8: Commit**

```bash
git add src/lib/api.ts src/lib/data.ts src/components/ui/dialog.tsx src/components/home package.json bun.lock
git commit -m "feat(home): load real projects and add the PDF import flow"
```

---

## ✅ CHECKPOINT — end of phase 1

Phase 1 is independently shippable. Before starting phase 2, confirm all seven phase-1 acceptance criteria pass:

1. `cd src-tauri && cargo test` passes (19 tests).
2. `bun run test` passes (11 tests).
3. New project → picker → modal with the title prefilled.
4. Confirming creates a card with the real page count and 0%.
5. **Quit and relaunch — the project is still there.**
6. A non-PDF renamed to `.pdf` errors readably and leaves no directory and no row.
7. The sidecar still starts and logs `[sidecar] ready on 127.0.0.1:<port>`.

If pdf.js integration in phase 2 proves difficult, stop here — this is a complete increment.

---

# Phase 2 — Rendering and Editor Wiring

### Task 9: pdf.js canvas renderer

**Files:**
- Modify: `package.json`
- Create: `src/components/editor/pdf-canvas.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `<PdfCanvas url={string} page={number} />` — consumed by Task 10

- [ ] **Step 1: Add pdfjs-dist**

```bash
bun add pdfjs-dist@6.3.289
```

Version 6 is ESM-only: the package `main` is `build/pdf.mjs` and the worker is `build/pdf.worker.min.mjs`. Note two API details specific to v6, both verified against the installed type definitions — `RenderParameters.canvas` is the primary parameter and `canvasContext` is explicitly deprecated in its favour, and `RenderTask.cancel(extraDelay?)` is how an in-flight render is aborted.

- [ ] **Step 2: Write the renderer**

`src/components/editor/pdf-canvas.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

// Bundled by Vite from the installed package; no network fetch.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

export function PdfCanvas({ url, page }: { url: string; page: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const taskRef = useRef<RenderTask | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the document once per URL. Range requests are on by default, so a
  // large scan is fetched in chunks rather than all at once.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    const loading = pdfjs.getDocument({ url });
    loading.promise.then(
      (d) => {
        if (cancelled) {
          d.destroy();
          return;
        }
        setDoc(d);
      },
      (e: unknown) => {
        if (!cancelled) setError(String(e));
      },
    );
    return () => {
      cancelled = true;
      setDoc(null);
      loading.destroy();
    };
  }, [url]);

  // Render the active page, cancelling any render still in flight. Holding a
  // paging key otherwise queues overlapping renders onto one canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!doc || !canvas || !container) return;

    let cancelled = false;
    taskRef.current?.cancel();

    doc.getPage(page).then((p) => {
      if (cancelled) return;

      const dpr = window.devicePixelRatio || 1;
      const base = p.getViewport({ scale: 1 });
      const viewport = p.getViewport({
        scale: ((container.clientWidth || base.width) / base.width) * dpr,
      });

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
      canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;

      const task = p.render({ canvas, viewport });
      taskRef.current = task;
      task.promise.catch((e: unknown) => {
        // A cancelled render rejects; that is expected while paging fast.
        if (!cancelled && !String(e).includes("Rendering cancelled")) {
          setError(String(e));
        }
      });
    });

    return () => {
      cancelled = true;
      taskRef.current?.cancel();
    };
  }, [doc, page]);

  return (
    <div
      ref={containerRef}
      className="min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-surface shadow-paper-sm"
    >
      {error ? (
        <div className="p-6 text-[12.5px] text-amber-ink">Could not render this PDF: {error}</div>
      ) : (
        <canvas ref={canvasRef} className="mx-auto block" />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify it typechecks**

Run: `bun run build`
Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock src/components/editor/pdf-canvas.tsx
git commit -m "feat(editor): render PDF pages with pdf.js and cancel stale renders"
```

---

### Task 10: Editor wiring and mock removal

**Files:**
- Modify: `src/components/editor/editor.tsx`, `src/components/editor/center-panel.tsx`, `src/components/editor/settings-panel.tsx`, `src/components/editor/page-panel.tsx`
- Delete: `src/lib/editor-data.ts`
- Create: `src/lib/placeholder-voices.ts`

**Interfaces:**
- Consumes: `api.*` from Task 8, `<PdfCanvas />` from Task 9, `LANGUAGES` from Task 7
- Produces: nothing — this is the last task

- [ ] **Step 1: Move the placeholder voices out of the deleted file**

Create `src/lib/placeholder-voices.ts`:

```ts
import type { LanguageCode } from "./languages";

/**
 * NOT REAL VOICES. Cosmetic placeholders so the settings panel renders until
 * M4 wires the TTS engines and the real Kokoro voice list.
 */
export const PLACEHOLDER_VOICES: Record<LanguageCode, string[]> = {
  en: ["Aria — warm female", "Marcus — clear male", "Imani — neutral"],
  am: ["Selam — female"],
  ti: ["Hiwot — female"],
  om: ["Caaltuu — female"],
};
```

- [ ] **Step 2: Rewire the editor to load real data**

In `src/components/editor/editor.tsx`, replace `EditorRoute` with a loader:

```tsx
export function EditorRoute() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!id) return;
    getProject(id).then(setProject).catch(() => setMissing(true));
  }, [id]);

  if (missing) return <Navigate to="/" replace />;
  if (!project) return <div className="flex-1 bg-paper" />;

  return <Editor project={project} onBack={() => navigate("/")} />;
}
```

- [ ] **Step 3: Replace the editor's mock state**

Inside `Editor`, make these substitutions:

- `const [pages, setPages] = useState<PageMeta[]>(() => buildInitialPages())` becomes `useState<PageMeta[]>(project.pages)`, importing `PageMeta` from `@/lib/api`.
- `const [activePage, setActivePage] = useState(18)` becomes `useState(project.pages.find((p) => !p.done)?.pageNo ?? 1)`.
- `const [language, setLanguage] = useState(project.language || "English")` becomes `useState<string>(project.language)`.
- Delete the `content` memo and both effects that derive `text` from `content.body`. Replace with a loader that fetches the page text and tracks what was last saved:

```tsx
  const [text, setText] = useState("");
  const savedTextRef = useRef("");
  const [saved, setSaved] = useState(true);

  useEffect(() => {
    getPage(project.id, activePage).then((p) => {
      const value = p.editedText ?? p.sourceText ?? "";
      savedTextRef.current = value;
      setText(value);
      setSaved(true);
    });
  }, [project.id, activePage]);

  // Autosave on a short debounce; this is what finally makes the panel's
  // "saved / unsaved changes" indicator tell the truth.
  useEffect(() => {
    if (text === savedTextRef.current) {
      setSaved(true);
      return;
    }
    setSaved(false);
    const t = setTimeout(() => {
      savePageText(project.id, activePage, text)
        .then(() => {
          savedTextRef.current = text;
          setSaved(true);
        })
        .catch(console.error);
    }, 500);
    return () => clearTimeout(t);
  }, [text, project.id, activePage]);
```

- `toggleDone` writes through before updating local state:

```tsx
  function toggleDone(n: number) {
    const next = !(pages.find((p) => p.pageNo === n)?.done ?? false);
    setPages((ps) => ps.map((p) => (p.pageNo === n ? { ...p, done: next } : p)));
    setPageDone(project.id, n, next).catch(console.error);
  }
```

- Every `p.n` becomes `p.pageNo` in `counts`, `visiblePages`, `gotoPage`, and `activeDone`.
- The title input becomes controlled and persists on blur:

```tsx
        <input
          defaultValue={project.title}
          onBlur={(e) => updateProject(project.id, { title: e.target.value }).catch(console.error)}
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-0.5 font-serif text-[15px] font-medium text-ink outline-none focus:border-line"
        />
```

- The language setter persists too: pass `setLanguage={(l) => { setLanguage(l); updateProject(project.id, { language: l }).catch(console.error); }}` to `SettingsPanel`.
- Pass `pdfPath={project.pdfPath}` down to `CenterPanel`.

- [ ] **Step 4: Replace the fake page in the center panel**

In `src/components/editor/center-panel.tsx`:

- Delete the `PdfPage` function and the `PageContent` import entirely.
- Change the props to accept `pdfPath: string` instead of `content: PageContent`.
- Replace `<PdfPage page={page} content={content} />` with:

```tsx
            <PdfCanvas url={convertFileSrc(pdfPath)} page={page} />
```

importing `convertFileSrc` from `@tauri-apps/api/core` and `PdfCanvas` from `./pdf-canvas`.

- Add an empty state above the textarea so a not-yet-extracted page reads as intentional rather than broken:

```tsx
              {text === "" && (
                <div className="pointer-events-none absolute px-1 font-serif text-base text-ink-3 italic">
                  No extracted text yet — type here, or wait for extraction.
                </div>
              )}
```

Wrap the textarea's parent in `relative` so the absolute positioning anchors correctly.

- [ ] **Step 5: Point the settings panel at the real language table**

In `src/components/editor/settings-panel.tsx`, replace the `LANGUAGES, VOICES` import from `@/lib/editor-data` with `LANGUAGES` from `@/lib/languages` and `PLACEHOLDER_VOICES` from `@/lib/placeholder-voices`. The language `Select` now maps over `{ code, label }` pairs with `value={l.code}`, and `voices` becomes `PLACEHOLDER_VOICES[language as LanguageCode] ?? []`.

- [ ] **Step 6: Update the page panel field names**

In `src/components/editor/page-panel.tsx`, replace every `p.n` with `p.pageNo` and change the `PageMeta` import to come from `@/lib/api`.

- [ ] **Step 7: Delete the mock data**

```bash
rm src/lib/editor-data.ts
```

Run: `bun run build`
Expected: no TypeScript errors and no remaining imports of `editor-data`. Confirm with `grep -rn "editor-data" src/` returning nothing.

- [ ] **Step 8: Manual acceptance — phase 2 criteria 8–13**

Run: `bun run tauri dev`

- Opening a project renders page 1 of that PDF.
- Holding the down arrow through a dozen pages produces no torn or stale renders and no console errors.
- Typing in the text panel flips the indicator to `unsaved changes`, then `saved`; after relaunch the text is still there.
- Marking a page done updates the page-panel counts and survives relaunch.
- The Home card's progress bar reflects the marked page.
- Split view shows the real rendered page beside the real text panel.

- [ ] **Step 9: Commit**

```bash
git add src/ && git rm --cached src/lib/editor-data.ts 2>/dev/null; git add -A src/
git commit -m "feat(editor): load real pages, render the PDF, and persist edits

- replace mock editor data with get_project / get_page commands
- autosave page text on a debounce and persist mark-as-done
- delete src/lib/editor-data.ts"
```

---

## Done

All thirteen acceptance criteria from the spec pass, `cargo test` covers the Rust domain layer, `bun run test` covers the frontend pure functions, and no mock data source remains on either screen.
