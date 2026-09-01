//! Import orchestration.
//!
//! Ordered so failures are cheap: the PDF is parsed before anything is copied.
//! If the copy or transaction fails, the project directory is removed to prevent
//! orphaned files. Together these keep "a row exists" and "its PDF exists" from
//! ever disagreeing — an invariant every later milestone relies on.
//! Note: cleanup failures are logged but do not prevent returning the original error.

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
    let id = Uuid::new_v4().to_string();
    import_with_id(conn, data_dir, &id, title, language, src)
}

fn import_with_id(
    conn: &mut Connection,
    data_dir: &Path,
    id: &str,
    title: &str,
    language: &str,
    src: &Path,
) -> Result<String, String> {
    if !src.is_file() {
        return Err("source file does not exist".into());
    }

    // Parse before copying: a corrupt file fails here, having written nothing.
    let page_count = pdf::count_pages(src)?;

    let dir = data_dir.join("projects").join(id);
    fs::create_dir_all(&dir).map_err(|e| format!("could not create project directory: {e}"))?;

    if let Err(e) = fs::copy(src, dir.join("source.pdf")) {
        if let Err(cleanup_err) = fs::remove_dir_all(&dir) {
            eprintln!("warning: failed to clean up {}: {}", dir.display(), cleanup_err);
        }
        return Err(format!("could not copy PDF: {e}"));
    }

    let rel = format!("projects/{id}/source.pdf");
    if let Err(e) = project::create_project_with_id(conn, id, title, language, &rel, page_count) {
        if let Err(cleanup_err) = fs::remove_dir_all(&dir) {
            eprintln!("warning: failed to clean up {}: {}", dir.display(), cleanup_err);
        }
        return Err(format!("could not save project: {e}"));
    }

    Ok(id.to_string())
}

#[cfg(test)]
mod tests {
    use super::{import_project, import_with_id};
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

    #[test]
    fn a_failed_copy_leaves_no_directory() {
        let mut conn = db::open_in_memory().unwrap();
        let data = temp_data_dir("copy-fail");
        let id = "copy-fail-test-id";

        // Pre-create source.pdf as a directory to force copy to fail.
        let source_dir = data.join("projects").join(id).join("source.pdf");
        std::fs::create_dir_all(&source_dir).unwrap();

        let err = import_with_id(&mut conn, &data, id, "T", "en", &fixture()).unwrap_err();
        assert!(err.contains("could not copy PDF"), "got: {err}");

        // Verify no project row was created.
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects WHERE id = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "no project row should survive a failed copy");

        // Verify the project directory was cleaned up.
        assert!(
            !data.join("projects").join(id).exists(),
            "project directory should be removed after failed copy"
        );
    }

    #[test]
    fn a_failed_transaction_leaves_no_directory() {
        let mut conn = db::open_in_memory().unwrap();
        let data = temp_data_dir("tx-fail");
        let id = "tx-fail-test-id";

        // Pre-insert a project row with this id to force the transaction to fail on primary key.
        let now = "2026-01-01T00:00:00Z";
        conn.execute(
            "INSERT INTO projects (id, title, language, pdf_path, page_count, rate, created_at, updated_at) VALUES (?1, 'Collision', 'en', 'fake/path.pdf', 1, 1.0, ?2, ?2)",
            [id, now],
        )
        .unwrap();

        let err = import_with_id(&mut conn, &data, id, "T", "en", &fixture()).unwrap_err();
        assert!(err.contains("could not save project"), "got: {err}");

        // Verify only the pre-inserted row exists (no second row from the failed import).
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects WHERE id = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "only the pre-inserted row should exist");

        // Verify the project directory was cleaned up.
        assert!(
            !data.join("projects").join(id).exists(),
            "project directory should be removed after failed transaction"
        );
    }
}
