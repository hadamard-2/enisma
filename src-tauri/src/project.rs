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
    // `touch` runs unconditionally against the same row, so its affected count
    // is what distinguishes a real id from a bogus one — no matter which of the
    // optional fields the caller supplied, or whether it supplied any.
    if touch(&tx, id)? == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    tx.commit()
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
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    update_project(&mut conn, &id, title.as_deref(), language.as_deref(), rate)
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
        update_project(&mut conn, "abc", Some("New Title"), None, None).unwrap();
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
        let result = update_project(&mut conn, "bogus-id", Some("Ghost"), None, None);
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
        update_project(&mut conn, "abc", Some("New Title"), Some("am"), Some(1.25)).unwrap();
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

        let result = update_project(&mut conn, "abc", Some("New Title"), Some("am"), Some(1.25));
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
}
