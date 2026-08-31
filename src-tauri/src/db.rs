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

#[cfg(test)]
mod tests {
    use super::{migrate, open_in_memory};
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
