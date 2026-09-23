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

/// v2 adds the metadata that makes a page's cached audio self-describing:
/// which text it was made from, and with which voice and rate. Freshness is
/// decided by comparing these, never by re-synthesizing — VITS is stochastic,
/// so the same text produces different audio every run and the bytes can never
/// be their own source of truth.
const V2_MIGRATION: &str = r#"
ALTER TABLE pages ADD COLUMN audio_text_hash   TEXT;
ALTER TABLE pages ADD COLUMN audio_voice       TEXT;
ALTER TABLE pages ADD COLUMN audio_rate        REAL;
ALTER TABLE pages ADD COLUMN audio_sample_rate INTEGER;
ALTER TABLE pages ADD COLUMN audio_duration_ms INTEGER;
ALTER TABLE pages ADD COLUMN audio_language    TEXT;
ALTER TABLE pages ADD COLUMN audio_created_at  INTEGER;
"#;

/// v3 remembers the page a project was last left on, so reopening it resumes
/// there. NULL means never opened, or opened before this column existed.
const V3_MIGRATION: &str = r#"
ALTER TABLE projects ADD COLUMN last_page INTEGER;
"#;

/// v4 remembers the last export's settings, so reopening the Export dialog
/// offers them again. That is the whole of resuming: finished takes live in
/// the page rows, and exporting again with the same settings reuses them.
/// NULL means the project has never been exported.
const V4_MIGRATION: &str = r#"
ALTER TABLE projects ADD COLUMN export_voice      TEXT;
ALTER TABLE projects ADD COLUMN export_rate       REAL;
ALTER TABLE projects ADD COLUMN export_first_page INTEGER;
ALTER TABLE projects ADD COLUMN export_last_page  INTEGER;
ALTER TABLE projects ADD COLUMN export_path       TEXT;
"#;

/// Apply pending migrations. Versioned with `PRAGMA user_version` so later
/// milestones can add steps without rewriting this.
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(V1_SCHEMA)?;
        conn.pragma_update(None, "user_version", 1)?;
    }
    if version < 2 {
        conn.execute_batch(V2_MIGRATION)?;
        conn.pragma_update(None, "user_version", 2)?;
    }
    if version < 3 {
        conn.execute_batch(V3_MIGRATION)?;
        conn.pragma_update(None, "user_version", 3)?;
    }
    if version < 4 {
        conn.execute_batch(V4_MIGRATION)?;
        conn.pragma_update(None, "user_version", 4)?;
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

#[cfg(test)]
mod tests {
    use super::{migrate, open_in_memory};
    use rusqlite::Connection;

    #[test]
    fn foreign_keys_are_enforced() {
        let conn = open_in_memory().unwrap();
        let err = conn.execute(
            "INSERT INTO pages (id, project_id, page_no) VALUES ('p', 'nonexistent', 1)",
            [],
        );
        assert!(err.is_err(), "FK violation should be rejected");
    }

    #[test]
    fn migrate_brings_a_fresh_database_to_version_4() {
        let conn = open_in_memory().unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 4);
    }

    #[test]
    fn migrate_adds_last_page_to_an_existing_v2_database() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(super::V1_SCHEMA).unwrap();
        conn.execute_batch(super::V2_MIGRATION).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        conn.execute(
            "INSERT INTO projects (id, title, language, pdf_path, page_count, created_at, updated_at)
             VALUES ('p', 't', 'en', 'x.pdf', 3, '', '')",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        // An existing project survives with no remembered page.
        let last: Option<i64> = conn
            .query_row("SELECT last_page FROM projects WHERE id = 'p'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(last, None);
    }

    #[test]
    fn migrate_adds_the_audio_columns_to_an_existing_v1_database() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(super::V1_SCHEMA).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();

        migrate(&conn).unwrap();

        // A v1 row must survive the migration with NULL audio metadata.
        let cols: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('pages')")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        for expected in [
            "audio_path",
            "audio_text_hash",
            "audio_voice",
            "audio_rate",
            "audio_sample_rate",
            "audio_duration_ms",
            "audio_language",
            "audio_created_at",
        ] {
            assert!(cols.iter().any(|c| c == expected), "missing column {expected}");
        }
    }

    #[test]
    fn migrate_is_idempotent() {
        let conn = open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 4);
    }

    #[test]
    fn migrate_adds_the_export_columns_to_an_existing_v3_database() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(super::V1_SCHEMA).unwrap();
        conn.execute_batch(super::V2_MIGRATION).unwrap();
        conn.execute_batch(super::V3_MIGRATION).unwrap();
        conn.pragma_update(None, "user_version", 3).unwrap();
        conn.execute(
            "INSERT INTO projects (id, title, language, pdf_path, page_count, created_at, updated_at)
             VALUES ('p', 't', 'en', 'x.pdf', 3, '', '')",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        // An existing project has never been exported.
        let (voice, path): (Option<String>, Option<String>) = conn
            .query_row("SELECT export_voice, export_path FROM projects WHERE id = 'p'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((voice, path), (None, None));
    }
}
