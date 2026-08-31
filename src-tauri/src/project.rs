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
