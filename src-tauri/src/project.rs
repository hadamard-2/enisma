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
        update_project(&conn, "abc", Some("New Title"), None, None).unwrap();
        let detail = get_project(&conn, "abc").unwrap();
        assert_eq!(detail.title, "New Title");
        assert_eq!(detail.language, "en", "language must be untouched");
    }
}
