//! Project and page domain operations.
//!
//! Every function takes a connection rather than an `AppHandle` so the logic is
//! testable against in-memory SQLite. The Tauri commands (Task 6) are thin
//! wrappers over these.

use chrono::Utc;
use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};
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
    page_texts: &[String],
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
        // `used_ocr` is 0 for every row: text-layer extraction is not OCR, and
        // the column stays reserved until OCR actually arrives.
        let mut stmt = tx.prepare(
            "INSERT INTO pages (id, project_id, page_no, source_text, used_ocr)
             VALUES (?1, ?2, ?3, ?4, 0)",
        )?;
        for n in 1..=page_count {
            let text = page_texts.get((n - 1) as usize).map(String::as_str);
            stmt.execute(params![Uuid::new_v4().to_string(), id, n, text])?;
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
    /// Relative path as stored in the database. The Tauri command wrapper
    /// resolves this to an absolute path before it reaches the webview.
    pub pdf_path: String,
    pub rate: f64,
    /// The right-hand panel's remembered voice, not a property of the book.
    /// Export chooses its own voice per export; this is only what the user
    /// last experimented with, and the default the export flow offers.
    pub voice: Option<String>,
    /// The page this project was last left on, or None if it never has been.
    /// Not validated against `page_count` here; the editor falls back when it
    /// names a page that does not exist.
    pub last_page: Option<i64>,
    pub pages: Vec<PageMeta>,
    /// How many pages have never been extracted (`source_text IS NULL`).
    /// Drives the editor's repair pass; `''` pages are extracted and do not
    /// count.
    pub pages_missing_text: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageText {
    pub source_text: Option<String>,
    pub edited_text: Option<String>,
}

pub fn get_project(conn: &Connection, id: &str) -> rusqlite::Result<ProjectDetail> {
    let (title, language, page_count, pdf_path, rate, voice, last_page, pages_missing_text) = conn
        .query_row(
            "SELECT title, language, page_count, pdf_path, rate, voice, last_page,
                    (SELECT COUNT(*) FROM pages WHERE project_id = p.id AND source_text IS NULL)
             FROM projects p WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?,
                    r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?,
                ))
            },
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

    Ok(ProjectDetail {
        id: id.to_string(),
        title,
        language,
        page_count,
        pdf_path,
        rate,
        voice,
        last_page,
        pages,
        pages_missing_text,
    })
}

/// Every page's text as the editor shows it: the user's edit where there is
/// one, the extraction otherwise. What book-wide search looks through.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageBody {
    pub page_no: i64,
    pub text: String,
}

pub fn list_page_texts(conn: &Connection, project_id: &str) -> rusqlite::Result<Vec<PageBody>> {
    let mut stmt = conn.prepare(
        "SELECT page_no, COALESCE(edited_text, source_text, '')
         FROM pages WHERE project_id = ?1 ORDER BY page_no",
    )?;
    let rows = stmt
        .query_map([project_id], |r| Ok(PageBody { page_no: r.get(0)?, text: r.get(1)? }))?
        .collect();
    rows
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
    let affected = conn.execute(
        "UPDATE pages SET edited_text = ?3 WHERE project_id = ?1 AND page_no = ?2",
        params![project_id, page_no, text],
    )?;
    if affected == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    touch(conn, project_id).map(|_| ())
}

pub fn set_page_done(
    conn: &Connection,
    project_id: &str,
    page_no: i64,
    done: bool,
) -> rusqlite::Result<()> {
    let affected = conn.execute(
        "UPDATE pages SET done = ?3 WHERE project_id = ?1 AND page_no = ?2",
        params![project_id, page_no, if done { 1 } else { 0 }],
    )?;
    if affected == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    touch(conn, project_id).map(|_| ())
}

/// Delete a project: its row, its pages, and the PDF copy Enisma made at import.
///
/// The row goes first and the folder second, deliberately. A folder left behind
/// is invisible and harmless; a row whose PDF has been deleted is a card in the
/// library that cannot be opened, which is a state the user actually hits.
///
/// Pages are not deleted by hand — `ON DELETE CASCADE` takes them, which works
/// only because `db` turns `foreign_keys` on for every connection.
pub fn delete_project(conn: &mut Connection, data_dir: &Path, id: &str) -> Result<(), String> {
    let pdf_path: String = conn
        .query_row("SELECT pdf_path FROM projects WHERE id = ?1", params![id], |r| r.get(0))
        .map_err(|e| format!("could not find project {id}: {e}"))?;

    // Resolve the folder before touching the database, so a path that does not
    // belong to us aborts with the project still intact rather than leaving the
    // library short of a row whose file is still on disk.
    let dir = project_dir(data_dir, &pdf_path)?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let affected = tx
        .execute("DELETE FROM projects WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if affected == 0 {
        return Err(format!("no project with id {id}"));
    }
    tx.commit().map_err(|e| e.to_string())?;

    // The row is gone, so the promise made to the user — this project is out of
    // your library — is already kept. A folder we could not remove is a leak
    // nobody can act on from a dialog, so it is reported to the log, not to the
    // user as a failed delete.
    if dir.exists() {
        if let Err(e) = fs::remove_dir_all(&dir) {
            eprintln!("warning: deleted project {id} but failed to remove {}: {e}", dir.display());
        }
    }
    Ok(())
}

/// The directory holding a project's copied PDF, refusing anything that escapes
/// `<data_dir>/projects/`.
///
/// `pdf_path` is written by import as `projects/<uuid>/source.pdf` and is never
/// user-supplied, so this guard is not defending against an attacker — it is
/// making sure a malformed or hand-edited row can never aim a recursive delete
/// at an arbitrary directory.
fn project_dir(data_dir: &Path, pdf_path: &str) -> Result<PathBuf, String> {
    let root = data_dir.join("projects");
    let dir = data_dir
        .join(pdf_path)
        .parent()
        .ok_or_else(|| format!("project path {pdf_path} has no directory"))?
        .to_path_buf();

    // Compare lexically: the folder may already be gone, and `canonicalize`
    // fails on a path that does not exist.
    let normalized = normalize(&dir);
    if !normalized.starts_with(normalize(&root)) || normalized == normalize(&root) {
        return Err(format!("project path {pdf_path} resolves outside the projects directory"));
    }
    Ok(normalized)
}

/// Resolve `.` and `..` lexically, without touching the filesystem.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// Apply a partial patch to one project.
///
/// One transaction, so a patch is all-or-nothing: a failure part-way through
/// cannot leave the row holding a new title next to an old language. And a
/// patch that matches no project is an error rather than a silent no-op,
/// matching `save_page_text` and `set_page_done`.
pub fn update_project(
    conn: &mut Connection,
    id: &str,
    title: Option<&str>,
    language: Option<&str>,
    rate: Option<f64>,
    voice: Option<&str>,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    if let Some(t) = title {
        tx.execute("UPDATE projects SET title = ?2 WHERE id = ?1", params![id, t])?;
    }
    if let Some(l) = language {
        tx.execute("UPDATE projects SET language = ?2 WHERE id = ?1", params![id, l])?;
    }
    if let Some(r) = rate {
        tx.execute("UPDATE projects SET rate = ?2 WHERE id = ?1", params![id, r])?;
    }
    if let Some(v) = voice {
        tx.execute("UPDATE projects SET voice = ?2 WHERE id = ?1", params![id, v])?;
    }
    // `touch` runs unconditionally against the same row, so its affected count
    // is what distinguishes a real id from a bogus one — no matter which of the
    // optional fields the caller supplied, or whether it supplied any.
    if touch(&tx, id)? == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    tx.commit()
}

/// Remember the page a project was left on.
///
/// Deliberately does NOT `touch` the project. `updated_at` orders the library
/// and feeds its "edited 3 minutes ago" label, and paging through a book is
/// reading it, not editing it — routing this through `update_project` would
/// float a project to the top of the library for every arrow-key press.
pub fn set_last_page(conn: &Connection, id: &str, page_no: i64) -> rusqlite::Result<()> {
    let n = conn.execute(
        "UPDATE projects SET last_page = ?2 WHERE id = ?1",
        params![id, page_no],
    )?;
    if n == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}

/// Bump `updated_at`, which drives library ordering and the relative-time label.
///
/// Returns the number of project rows matched; callers use it to reject a write
/// aimed at a project that does not exist.
fn touch(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE projects SET updated_at = ?2 WHERE id = ?1",
        params![id, Utc::now().to_rfc3339()],
    )
}

/// Replace every page's `source_text` for one project, in one transaction.
///
/// The repair path's only write. It deliberately does not touch `edited_text`,
/// `done`, or the project's `updated_at`: a repair restores what extraction
/// should have produced, and is not something the user did.
pub fn replace_source_text(
    conn: &mut Connection,
    project_id: &str,
    page_texts: &[String],
) -> Result<(), String> {
    let page_count: i64 = conn
        .query_row(
            "SELECT page_count FROM projects WHERE id = ?1",
            params![project_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    if page_texts.len() as i64 != page_count {
        return Err(format!(
            "cannot re-read this book: the PDF now yields {} pages, but the project was imported with {page_count}",
            page_texts.len()
        ));
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("UPDATE pages SET source_text = ?3 WHERE project_id = ?1 AND page_no = ?2")
            .map_err(|e| e.to_string())?;
        for (index, text) in page_texts.iter().enumerate() {
            stmt.execute(params![project_id, (index + 1) as i64, text])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

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

/// `async` so this runs off the IPC dispatch thread. Import parses the whole
/// PDF and then copies it, which is seconds of work on a large scan — long
/// enough that a blocking command would freeze the window, spinner included.
/// The body has no `.await`, so the `MutexGuard` it holds never spans a
/// suspension point and the future stays `Send`.
#[tauri::command(async)]
pub fn import_project_cmd(
    db: State<'_, Db>,
    data: State<'_, DataDir>,
    title: String,
    language: String,
    src_path: String,
    page_texts: Vec<String>,
) -> Result<String, String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    crate::import::import_project(
        &mut conn,
        &data.0,
        &title,
        &language,
        std::path::Path::new(&src_path),
        &page_texts,
    )
}

#[tauri::command]
pub fn update_project_cmd(
    db: State<'_, Db>,
    id: String,
    title: Option<String>,
    language: Option<String>,
    rate: Option<f64>,
    voice: Option<String>,
) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    update_project(
        &mut conn,
        &id,
        title.as_deref(),
        language.as_deref(),
        rate,
        voice.as_deref(),
    )
    .map_err(|e| e.to_string())
}

/// Delete a project and the PDF copy made for it. Irreversible.
///
/// `async` so a recursive directory removal does not block the IPC thread.
#[tauri::command(async)]
pub fn delete_project_cmd(
    db: State<'_, Db>,
    data: State<'_, DataDir>,
    id: String,
) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    delete_project(&mut conn, &data.0, &id)
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

/// Replace a project's extracted text. Used by the editor's repair pass.
///
/// `async` so re-writing a few hundred rows does not block the IPC thread.
#[tauri::command(async)]
pub fn save_page_source_text_cmd(
    db: State<'_, Db>,
    project_id: String,
    page_texts: Vec<String>,
) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    replace_source_text(&mut conn, &project_id, &page_texts)
}

#[tauri::command]
pub fn list_page_texts_cmd(db: State<'_, Db>, project_id: String) -> Result<Vec<PageBody>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    list_page_texts(&conn, &project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_last_page_cmd(db: State<'_, Db>, id: String, page_no: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    set_last_page(&conn, &id, page_no).map_err(|e| e.to_string())
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

/// Hand a picked PDF's bytes to the webview so pdf.js can extract its text.
///
/// Returns `tauri::ipc::Response`, which travels as raw bytes rather than
/// JSON — an 11 MB textbook encoded as a JSON number array would not be
/// acceptable. `async` so a large read does not block the IPC dispatch thread.
#[tauri::command(async)]
pub fn read_pdf_bytes_cmd(path: String) -> Result<tauri::ipc::Response, String> {
    crate::pdf::read_source_bytes(std::path::Path::new(&path)).map(tauri::ipc::Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn temp_data_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("enisma-test-{name}"));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed(conn: &mut rusqlite::Connection, id: &str, pages: i64) {
        create_project_with_id(
            conn,
            id,
            "Grade 7 Science",
            "en",
            "projects/x/source.pdf",
            pages,
            &[],
        )
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
        update_project(&mut conn, "abc", Some("New Title"), None, None, None).unwrap();
        let detail = get_project(&conn, "abc").unwrap();
        assert_eq!(detail.title, "New Title");
        assert_eq!(detail.language, "en", "language must be untouched");
    }

    #[test]
    fn save_page_text_with_out_of_range_page_no_returns_error() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn, "abc", 2);
        let result = save_page_text(&conn, "abc", 99, "text");
        assert!(result.is_err(), "save_page_text should error for non-existent page");
    }

    #[test]
    fn rejected_save_page_text_does_not_bump_updated_at() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn, "abc", 2);
        let before: String = conn
            .query_row("SELECT updated_at FROM projects WHERE id = 'abc'", [], |r| r.get(0))
            .unwrap();
        // Wait a tiny bit to ensure time difference if touch were called
        std::thread::sleep(std::time::Duration::from_millis(10));
        let result = save_page_text(&conn, "abc", 99, "text");
        assert!(result.is_err());
        let after: String = conn
            .query_row("SELECT updated_at FROM projects WHERE id = 'abc'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, after, "updated_at must not be bumped on rejected write");
    }

    #[test]
    fn update_project_with_unknown_id_is_rejected() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn, "abc", 1);
        let result = update_project(&mut conn, "bogus-id", Some("Ghost"), None, None, None);
        assert!(result.is_err(), "a patch that matches no project must not report success");
        assert_eq!(
            get_project(&conn, "abc").unwrap().title,
            "Grade 7 Science",
            "the real project must be untouched"
        );
    }

    #[test]
    fn update_project_applies_a_multi_field_patch() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn, "abc", 1);
        update_project(&mut conn, "abc", Some("New Title"), Some("am"), Some(1.25), None).unwrap();
        let detail = get_project(&conn, "abc").unwrap();
        assert_eq!(detail.title, "New Title");
        assert_eq!(detail.language, "am");
        assert_eq!(detail.rate, 1.25);
    }

    #[test]
    fn update_project_rolls_back_a_partial_patch() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn, "abc", 1);
        // Make the third statement of the patch fail. A trigger is the only way
        // to make a well-formed UPDATE abort here, and it is what lets this test
        // observe the transaction rather than just assert it exists.
        conn.execute_batch(
            "CREATE TRIGGER reject_rate BEFORE UPDATE OF rate ON projects
             BEGIN SELECT RAISE(ABORT, 'rate rejected'); END",
        )
        .unwrap();

        let result = update_project(&mut conn, "abc", Some("New Title"), Some("am"), Some(1.25), None);
        assert!(result.is_err(), "the failing statement must fail the whole patch");

        let detail = get_project(&conn, "abc").unwrap();
        assert_eq!(detail.title, "Grade 7 Science", "title must roll back");
        assert_eq!(detail.language, "en", "language must roll back");
    }

    #[test]
    fn set_page_done_with_unknown_project_id_returns_error() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn, "abc", 2);
        let result = set_page_done(&conn, "nonexistent", 1, true);
        assert!(result.is_err(), "set_page_done should error for non-existent project");
    }

    #[test]
    fn replace_source_text_overwrites_every_page_and_spares_edits() {
        let mut conn = db::open_in_memory().unwrap();
        create_project_with_id(&mut conn, "p1", "T", "en", "projects/p1/source.pdf", 3,
            &[String::new(), String::new(), String::new()]).unwrap();
        save_page_text(&conn, "p1", 2, "my correction").unwrap();

        super::replace_source_text(
            &mut conn,
            "p1",
            &["one".to_string(), "two".to_string(), "three".to_string()],
        )
        .unwrap();

        let mut stmt = conn
            .prepare("SELECT source_text, edited_text FROM pages WHERE project_id = 'p1' ORDER BY page_no")
            .unwrap();
        let rows: Vec<(Option<String>, Option<String>)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(rows[0].0, Some("one".to_string()));
        assert_eq!(rows[1].0, Some("two".to_string()));
        assert_eq!(rows[2].0, Some("three".to_string()));
        // The correction is what the user typed; a repair must never touch it.
        assert_eq!(rows[1].1, Some("my correction".to_string()));
    }

    #[test]
    fn replace_source_text_rejects_a_page_count_disagreement() {
        let mut conn = db::open_in_memory().unwrap();
        create_project_with_id(&mut conn, "p1", "T", "en", "projects/p1/source.pdf", 3,
            &[String::new(), String::new(), String::new()]).unwrap();

        let err = super::replace_source_text(&mut conn, "p1", &["only one".to_string()]).unwrap_err();
        assert!(err.contains("1"), "error should name the counts: {err}");
    }

    #[test]
    fn replace_source_text_leaves_updated_at_alone() {
        let mut conn = db::open_in_memory().unwrap();
        create_project_with_id(&mut conn, "p1", "T", "en", "projects/p1/source.pdf", 1,
            &[String::new()]).unwrap();
        let before: String = conn
            .query_row("SELECT updated_at FROM projects WHERE id = 'p1'", [], |r| r.get(0))
            .unwrap();

        super::replace_source_text(&mut conn, "p1", &["text".to_string()]).unwrap();

        let after: String = conn
            .query_row("SELECT updated_at FROM projects WHERE id = 'p1'", [], |r| r.get(0))
            .unwrap();
        // Repair is not an edit. Touching the timestamp would reorder the
        // library as though the user had just worked on the book.
        assert_eq!(before, after);
    }

    #[test]
    fn list_page_texts_prefers_the_edit_and_keeps_page_order() {
        let mut conn = db::open_in_memory().unwrap();
        create_project_with_id(&mut conn, "p1", "T", "en", "projects/p1/source.pdf", 3,
            &["one".into(), "two".into(), "three".into()]).unwrap();
        save_page_text(&conn, "p1", 2, "two, corrected").unwrap();
        conn.execute("UPDATE pages SET source_text = NULL WHERE page_no = 3", []).unwrap();

        let pages = super::list_page_texts(&conn, "p1").unwrap();
        let got: Vec<(i64, &str)> = pages.iter().map(|p| (p.page_no, p.text.as_str())).collect();
        assert_eq!(got, vec![(1, "one"), (2, "two, corrected"), (3, "")]);
    }

    #[test]
    fn last_page_round_trips_and_starts_empty() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn, "abc", 5);
        assert_eq!(get_project(&conn, "abc").unwrap().last_page, None);

        super::set_last_page(&conn, "abc", 4).unwrap();
        assert_eq!(get_project(&conn, "abc").unwrap().last_page, Some(4));
    }

    #[test]
    fn set_last_page_leaves_updated_at_alone() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn, "abc", 5);
        let before: String = conn
            .query_row("SELECT updated_at FROM projects WHERE id = 'abc'", [], |r| r.get(0))
            .unwrap();

        super::set_last_page(&conn, "abc", 3).unwrap();

        let after: String = conn
            .query_row("SELECT updated_at FROM projects WHERE id = 'abc'", [], |r| r.get(0))
            .unwrap();
        // Paging through a book is reading it. Touching the timestamp would
        // reorder the library on every page turn.
        assert_eq!(before, after);
    }

    #[test]
    fn set_last_page_rejects_an_unknown_project() {
        let conn = db::open_in_memory().unwrap();
        assert!(super::set_last_page(&conn, "nope", 1).is_err());
    }

    #[test]
    fn get_project_counts_pages_with_no_source_text() {
        let mut conn = db::open_in_memory().unwrap();
        create_project_with_id(&mut conn, "p1", "T", "en", "projects/p1/source.pdf", 3,
            &[String::new(), String::new(), String::new()]).unwrap();
        assert_eq!(get_project(&conn, "p1").unwrap().pages_missing_text, 0);

        conn.execute("UPDATE pages SET source_text = NULL WHERE page_no = 2", []).unwrap();
        assert_eq!(get_project(&conn, "p1").unwrap().pages_missing_text, 1);
    }

    #[test]
    fn delete_project_removes_the_row_its_pages_and_its_folder() {
        let mut conn = db::open_in_memory().unwrap();
        let data = temp_data_dir("delete-ok");
        let dir = data.join("projects").join("abc");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("source.pdf"), b"%PDF-1.7").unwrap();
        create_project_with_id(&mut conn, "abc", "T", "en", "projects/abc/source.pdf", 2, &[])
            .unwrap();

        delete_project(&mut conn, &data, "abc").unwrap();

        let projects: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects WHERE id = 'abc'", [], |r| r.get(0))
            .unwrap();
        let pages: i64 = conn
            .query_row("SELECT COUNT(*) FROM pages WHERE project_id = 'abc'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(projects, 0);
        // Pages go via ON DELETE CASCADE, which only fires because `db` turns
        // `foreign_keys` on; this asserts the cascade, not just the row.
        assert_eq!(pages, 0, "pages should cascade away with their project");
        assert!(!dir.exists(), "the project folder should be gone");
    }

    #[test]
    fn delete_project_rejects_an_unknown_id() {
        let mut conn = db::open_in_memory().unwrap();
        let data = temp_data_dir("delete-unknown");
        assert!(delete_project(&mut conn, &data, "ghost").is_err());
    }

    #[test]
    fn delete_project_leaves_other_projects_and_their_folders_alone() {
        let mut conn = db::open_in_memory().unwrap();
        let data = temp_data_dir("delete-neighbour");
        for id in ["abc", "xyz"] {
            let dir = data.join("projects").join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("source.pdf"), b"%PDF-1.7").unwrap();
            create_project_with_id(
                &mut conn,
                id,
                "T",
                "en",
                &format!("projects/{id}/source.pdf"),
                1,
                &[],
            )
            .unwrap();
        }

        delete_project(&mut conn, &data, "abc").unwrap();

        let survivors: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
            .unwrap();
        assert_eq!(survivors, 1);
        assert!(data.join("projects").join("xyz").join("source.pdf").is_file());
    }

    #[test]
    fn delete_project_refuses_a_pdf_path_that_escapes_the_data_dir() {
        let mut conn = db::open_in_memory().unwrap();
        let data = temp_data_dir("delete-escape");
        let outside = data.join("not-projects");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("source.pdf"), b"%PDF-1.7").unwrap();
        create_project_with_id(
            &mut conn,
            "abc",
            "T",
            "en",
            "../not-projects/source.pdf",
            1,
            &[],
        )
        .unwrap();

        let err = delete_project(&mut conn, &data, "abc").unwrap_err();

        assert!(err.contains("outside"), "unexpected error: {err}");
        // The row survives too: refusing to touch the disk must not leave a
        // project deleted from the library with its file still on disk.
        let projects: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects WHERE id = 'abc'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(projects, 1);
        assert!(outside.join("source.pdf").is_file(), "nothing outside should be removed");
    }

    #[test]
    fn a_new_project_has_no_remembered_voice() {
        let mut conn = db::open_in_memory().unwrap();
        create_project_with_id(
            &mut conn, "p1", "Biology", "en", "projects/p1/source.pdf", 1,
            &["one".into()],
        )
        .unwrap();
        let d = get_project(&conn, "p1").unwrap();
        assert_eq!(d.voice, None);
        assert_eq!(d.rate, 1.0);
    }

    #[test]
    fn update_project_remembers_the_panel_voice() {
        let mut conn = db::open_in_memory().unwrap();
        create_project_with_id(
            &mut conn, "p1", "Biology", "en", "projects/p1/source.pdf", 1,
            &["one".into()],
        )
        .unwrap();
        update_project(&mut conn, "p1", None, None, Some(1.25), Some("am_michael")).unwrap();
        let d = get_project(&conn, "p1").unwrap();
        assert_eq!(d.voice.as_deref(), Some("am_michael"));
        assert_eq!(d.rate, 1.25);
    }

    #[test]
    fn update_project_leaves_the_voice_alone_when_not_supplied() {
        let mut conn = db::open_in_memory().unwrap();
        create_project_with_id(
            &mut conn, "p1", "Biology", "en", "projects/p1/source.pdf", 1,
            &["one".into()],
        )
        .unwrap();
        update_project(&mut conn, "p1", None, None, None, Some("af_heart")).unwrap();
        update_project(&mut conn, "p1", Some("Renamed"), None, None, None).unwrap();
        let d = get_project(&conn, "p1").unwrap();
        assert_eq!(d.voice.as_deref(), Some("af_heart"));
        assert_eq!(d.title, "Renamed");
    }
}
