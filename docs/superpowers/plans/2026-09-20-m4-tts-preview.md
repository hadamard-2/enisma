# M4 TTS Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user convert one page of a project to speech on demand, in English, Amharic, Tigrigna or Afaan Oromo, fully offline, with the result cached on disk and visibly marked stale when the text or settings change.

**Architecture:** The React panel calls a Tauri command; Rust owns the database and every filesystem path and talks to the Python sidecar over token-guarded loopback HTTP; the sidecar runs synthesis as a background job writing a WAV at a path Rust supplies, and Rust polls that job and re-emits its progress as Tauri events. Audio bytes never cross IPC — the webview plays the file over the asset protocol, exactly as it already does for the PDF.

**Tech Stack:** Tauri 2 / Rust (rusqlite, reqwest, sha2), Python 3.12 sidecar (FastAPI, kokoro-onnx, sherpa-onnx, uroman, num2words2), React 19 + TypeScript + Vitest.

**Spec:** [docs/superpowers/specs/2026-09-20-m4-tts-design.md](../specs/2026-09-20-m4-tts-design.md) — and the measurements it rests on are in [the M4 TTS spike](../specs/2026-09-15-m4-tts-spike.md). Executors should read the spec; this plan argues from it and does not restate its evidence.

## Global Constraints

- **Fully offline.** No network at runtime except the one-time model download. No cloud OCR or hosted TTS, ever.
- **User-facing strings say Enisma.** Internal identifiers stay HearBook. Never change the Tauri bundle identifier.
- **Backend error text stays in English** and is not translated. Do not introduce error codes.
- **New UI strings** go into all four locale files in the existing `{message, context}` shape, and the non-English ones are appended to `docs/translations-needing-review.md`.
- **Markdown is never hard-wrapped** — one line per paragraph.
- **Routing uses HashRouter**, never BrowserRouter.
- **Package manager is Bun** for the frontend, **uv** for the sidecar.
- **Commits follow Conventional Commits.** Never run `git push` — the user pushes.
- **espeak-ng data path must be ≤159 characters.** Past that, espeak-ng ignores the path and terminates the process with no Python exception.
- **Kokoro's usable context is 510 tokens**, and its style vector is indexed by token count.
- **MMS symbol tables are Latin-only** — no digits, no punctuation beyond apostrophe and hyphen. `.` must survive romanization because it is what segments utterances.
- **Ship Kokoro `model.onnx` (fp32, 326 MB) only.** `model_q8f16.onnx` segfaults onnxruntime 1.30.0; int8 is 6.2× slower than fp32 on CPU.
- **Existing tests must stay green:** 40 Rust tests (`cargo test` in `src-tauri`), 87 frontend tests (`bun run test`).

---

### Task 1: Schema migration to `user_version` 2

**Files:**
- Modify: `src-tauri/src/db.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: a `pages` table carrying `audio_text_hash TEXT`, `audio_voice TEXT`, `audio_rate REAL`, `audio_sample_rate INTEGER`, `audio_duration_ms INTEGER` alongside the existing `audio_path TEXT`. `db::migrate(&Connection)` leaves `user_version` at 2.

- [ ] **Step 1: Write the failing tests**

Append to the `#[cfg(test)] mod tests` block at the bottom of `src-tauri/src/db.rs`:

```rust
    #[test]
    fn migrate_brings_a_fresh_database_to_version_2() {
        let conn = open_in_memory().unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 2);
    }

    #[test]
    fn migrate_adds_the_audio_columns_to_an_existing_v1_database() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(V1_SCHEMA).unwrap();
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
        assert_eq!(version, 2);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test db::tests`
Expected: FAIL — `migrate_brings_a_fresh_database_to_version_2` asserts `2` but gets `1`, and the column assertions fail on `audio_text_hash`.

- [ ] **Step 3: Write the migration**

In `src-tauri/src/db.rs`, add the v2 step below the existing `V1_SCHEMA` constant:

```rust
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
"#;
```

Then extend `migrate`:

```rust
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
    Ok(())
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS — the 3 new tests plus the existing 40.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db.rs
git commit -m "feat(db): record what each page's audio was made from"
```

---

### Task 2: Audio metadata storage and the freshness rule

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/audio.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: the v2 schema from Task 1.
- Produces:
  - `audio::text_hash(text: &str) -> String` — lowercase hex SHA-256.
  - `audio::PageAudio { path: Option<String>, text_hash: Option<String>, voice: Option<String>, rate: Option<f64>, sample_rate: Option<i64>, duration_ms: Option<i64> }`, deriving `Debug, Serialize` with `#[serde(rename_all = "camelCase")]`.
  - `audio::is_fresh(a: &PageAudio, current_text: &str, voice: &str, rate: f64) -> bool`
  - `audio::get_page_audio(conn: &Connection, project_id: &str, page_no: i64) -> rusqlite::Result<PageAudio>`
  - `audio::set_page_audio(conn: &Connection, project_id: &str, page_no: i64, path: &str, text_hash: &str, voice: &str, rate: f64, sample_rate: i64, duration_ms: i64) -> rusqlite::Result<()>`

- [ ] **Step 1: Add the hashing dependency**

`sha2` is new. It is needed here to identify the text a take was made from, and again in Task 12 if Rust ever re-verifies a downloaded model. Add to `[dependencies]` in `src-tauri/Cargo.toml`, after `chrono`:

```toml
sha2 = "0.10"
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/audio.rs` containing only this test module for now:

```rust
//! Cached page audio: what was made, from what, and whether it still matches.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::project;

    fn seed(conn: &mut rusqlite::Connection) -> String {
        let id = "p1".to_string();
        project::create_project_with_id(
            conn, &id, "Biology", "en", "projects/p1/source.pdf", 3,
            &["one".into(), "two".into(), "three".into()],
        )
        .unwrap();
        id
    }

    #[test]
    fn a_page_with_no_audio_reports_every_field_empty() {
        let mut conn = db::open_in_memory().unwrap();
        let id = seed(&mut conn);
        let a = get_page_audio(&conn, &id, 1).unwrap();
        assert!(a.path.is_none());
        assert!(a.text_hash.is_none());
        assert!(!is_fresh(&a, "one", "af_heart", 1.0));
    }

    #[test]
    fn audio_is_fresh_when_text_voice_and_rate_all_match() {
        let mut conn = db::open_in_memory().unwrap();
        let id = seed(&mut conn);
        set_page_audio(
            &conn, &id, 1, "projects/p1/audio/page-1.wav",
            &text_hash("one"), "af_heart", 1.0, 24000, 5500,
        )
        .unwrap();
        let a = get_page_audio(&conn, &id, 1).unwrap();
        assert!(is_fresh(&a, "one", "af_heart", 1.0));
        assert_eq!(a.duration_ms, Some(5500));
        assert_eq!(a.sample_rate, Some(24000));
    }

    #[test]
    fn editing_the_text_makes_it_stale() {
        let mut conn = db::open_in_memory().unwrap();
        let id = seed(&mut conn);
        set_page_audio(
            &conn, &id, 1, "projects/p1/audio/page-1.wav",
            &text_hash("one"), "af_heart", 1.0, 24000, 5500,
        )
        .unwrap();
        let a = get_page_audio(&conn, &id, 1).unwrap();
        assert!(!is_fresh(&a, "one edited", "af_heart", 1.0));
    }

    #[test]
    fn changing_voice_or_rate_makes_it_stale() {
        let mut conn = db::open_in_memory().unwrap();
        let id = seed(&mut conn);
        set_page_audio(
            &conn, &id, 1, "projects/p1/audio/page-1.wav",
            &text_hash("one"), "af_heart", 1.0, 24000, 5500,
        )
        .unwrap();
        let a = get_page_audio(&conn, &id, 1).unwrap();
        assert!(!is_fresh(&a, "one", "am_michael", 1.0));
        assert!(!is_fresh(&a, "one", "af_heart", 1.5));
    }

    #[test]
    fn a_rewrite_replaces_the_previous_take() {
        let mut conn = db::open_in_memory().unwrap();
        let id = seed(&mut conn);
        set_page_audio(
            &conn, &id, 1, "projects/p1/audio/page-1.wav",
            &text_hash("one"), "af_heart", 1.0, 24000, 5500,
        )
        .unwrap();
        set_page_audio(
            &conn, &id, 1, "projects/p1/audio/page-1.wav",
            &text_hash("one edited"), "am_michael", 1.5, 24000, 6000,
        )
        .unwrap();
        let a = get_page_audio(&conn, &id, 1).unwrap();
        assert_eq!(a.voice.as_deref(), Some("am_michael"));
        assert_eq!(a.rate, Some(1.5));
        assert!(is_fresh(&a, "one edited", "am_michael", 1.5));
    }

    #[test]
    fn writing_audio_for_a_page_that_does_not_exist_is_rejected() {
        let mut conn = db::open_in_memory().unwrap();
        let id = seed(&mut conn);
        let err = set_page_audio(
            &conn, &id, 99, "projects/p1/audio/page-99.wav",
            &text_hash("nope"), "af_heart", 1.0, 24000, 1,
        );
        assert!(err.is_err());
    }

    #[test]
    fn the_hash_is_stable_and_distinguishes_different_text() {
        assert_eq!(text_hash("one"), text_hash("one"));
        assert_ne!(text_hash("one"), text_hash("One"));
        assert_eq!(text_hash("one").len(), 64);
    }
}
```

Register the module in `src-tauri/src/lib.rs`, beside the existing `mod` lines:

```rust
pub mod audio;
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test audio::`
Expected: FAIL to compile — `get_page_audio`, `set_page_audio`, `is_fresh`, `text_hash` and `PageAudio` are not defined.

- [ ] **Step 4: Write the implementation**

Insert above the test module in `src-tauri/src/audio.rs`:

```rust
use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Identifies the exact text a take was synthesized from.
pub fn text_hash(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageAudio {
    /// Relative path as stored; the command wrapper resolves it for the webview.
    pub path: Option<String>,
    pub text_hash: Option<String>,
    pub voice: Option<String>,
    pub rate: Option<f64>,
    pub sample_rate: Option<i64>,
    pub duration_ms: Option<i64>,
}

/// Whether a take still represents the given text and settings.
///
/// Stale audio is not deleted and stays playable — the user listens to the old
/// take while deciding whether to re-convert. Only this comparison decides;
/// the audio itself is never re-derived, because MMS synthesis is stochastic
/// and two runs of identical input differ.
pub fn is_fresh(a: &PageAudio, current_text: &str, voice: &str, rate: f64) -> bool {
    let (Some(path), Some(hash), Some(v), Some(r)) =
        (&a.path, &a.text_hash, &a.voice, a.rate)
    else {
        return false;
    };
    !path.is_empty()
        && *hash == text_hash(current_text)
        && v == voice
        && (r - rate).abs() < f64::EPSILON
}

pub fn get_page_audio(
    conn: &Connection,
    project_id: &str,
    page_no: i64,
) -> rusqlite::Result<PageAudio> {
    conn.query_row(
        "SELECT audio_path, audio_text_hash, audio_voice, audio_rate,
                audio_sample_rate, audio_duration_ms
         FROM pages WHERE project_id = ?1 AND page_no = ?2",
        params![project_id, page_no],
        |r| {
            Ok(PageAudio {
                path: r.get(0)?,
                text_hash: r.get(1)?,
                voice: r.get(2)?,
                rate: r.get(3)?,
                sample_rate: r.get(4)?,
                duration_ms: r.get(5)?,
            })
        },
    )
}

/// Record a completed take, replacing whatever the page had before. One take
/// per page by design: a new conversion supersedes the old one.
#[allow(clippy::too_many_arguments)]
pub fn set_page_audio(
    conn: &Connection,
    project_id: &str,
    page_no: i64,
    path: &str,
    text_hash: &str,
    voice: &str,
    rate: f64,
    sample_rate: i64,
    duration_ms: i64,
) -> rusqlite::Result<()> {
    let affected = conn.execute(
        "UPDATE pages
            SET audio_path = ?3, audio_text_hash = ?4, audio_voice = ?5,
                audio_rate = ?6, audio_sample_rate = ?7, audio_duration_ms = ?8
          WHERE project_id = ?1 AND page_no = ?2",
        params![
            project_id, page_no, path, text_hash, voice, rate, sample_rate, duration_ms
        ],
    )?;
    if affected == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS — 7 new tests plus everything from before.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/audio.rs src-tauri/src/lib.rs
git commit -m "feat(audio): decide a take's freshness from stored metadata"
```

---

### Task 3: Carry `voice` through the project record

**Files:**
- Modify: `src-tauri/src/project.rs`
- Modify: `src/lib/api.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ProjectDetail` gains `voice: Option<String>` (serialized `voice`); `project::update_project(conn, id, title, language, rate, voice)` takes a sixth argument `voice: Option<&str>`; `update_project_cmd` accepts an optional `voice`; the TS `ProjectDetail` gains `voice: string | null` and `updateProject`'s patch gains `voice?: string`.

Note the meaning: `projects.voice` and `projects.rate` are **not** the book's settings. They are the right-hand panel's remembered position — what the user last experimented with — restored when the project reopens, and offered as defaults when M5's export asks for a voice and rate.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/project.rs`:

```rust
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
```

Every existing call to `update_project` in the test module and in `update_project_cmd` needs the new sixth argument; the compiler will point at each one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test project::`
Expected: FAIL to compile — `ProjectDetail` has no field `voice`, and `update_project` takes 5 arguments, not 6.

- [ ] **Step 3: Write the implementation**

In `src-tauri/src/project.rs`, add the field to `ProjectDetail` directly after `rate`:

```rust
    /// The right-hand panel's remembered voice, not a property of the book.
    /// Export chooses its own voice per export; this is only what the user
    /// last experimented with, and the default the export flow offers.
    pub voice: Option<String>,
```

Widen the `get_project` query and its row mapping:

```rust
    let (title, language, page_count, pdf_path, rate, voice, pages_missing_text) = conn
        .query_row(
            "SELECT title, language, page_count, pdf_path, rate, voice,
                    (SELECT COUNT(*) FROM pages WHERE project_id = p.id AND source_text IS NULL)
             FROM projects p WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )?;
```

and add `voice,` to the `ProjectDetail { .. }` literal it returns.

Extend `update_project`:

```rust
pub fn update_project(
    conn: &mut Connection,
    id: &str,
    title: Option<&str>,
    language: Option<&str>,
    rate: Option<f64>,
    voice: Option<&str>,
) -> rusqlite::Result<()> {
```

and inside the transaction, beside the existing `rate` arm:

```rust
    if let Some(v) = voice {
        tx.execute("UPDATE projects SET voice = ?2 WHERE id = ?1", params![id, v])?;
    }
```

Extend the command:

```rust
#[tauri::command]
pub fn update_project_cmd(
    db: State<'_, Db>,
    id: String,
    title: Option<String>,
    language: Option<String>,
    rate: Option<f64>,
    voice: Option<String>,
) -> Result<(), String> {
    let mut conn = db.0.lock().unwrap();
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
```

In `src/lib/api.ts`, add `voice: string | null;` to `ProjectDetail` after `rate`, and widen the patch:

```ts
export const updateProject = (
  id: string,
  patch: { title?: string; language?: string; rate?: number; voice?: string },
) => invoke<void>("update_project_cmd", { id, ...patch });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test && cd .. && bun run build`
Expected: PASS, and the TypeScript build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/project.rs src/lib/api.ts
git commit -m "feat(project): remember the panel's voice alongside its rate"
```

---

### Task 4: Sidecar dependencies, test harness, and the startup guards

**Files:**
- Modify: `sidecar/pyproject.toml`
- Create: `sidecar/guards.py`
- Create: `sidecar/tests/test_guards.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `guards.assert_espeak_data_path(path: str) -> None` — raises `RuntimeError` when the path is longer than 159 characters.
  - `guards.assert_no_digits(text: str, context: str) -> None` — raises `RuntimeError` when expanded text still contains digits.
  - `ESPEAK_PATH_LIMIT = 159` exported from `guards`.
  - A runnable `pytest` suite under `sidecar/tests/`.

This is where the `num2words2` fork pin lands, per the project decision to defer it until M4 implementation starts. It is **temporary** — see the risk entry in `docs/implementation-plan.md` and revisit once the upstream PR is decided.

- [ ] **Step 1: Add the dependencies**

Replace the `[project]` dependency list and dev group in `sidecar/pyproject.toml`:

```toml
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    # English TTS: Kokoro weights run on onnxruntime; espeakng-loader ships the
    # espeak-ng shared library AND its data inside the wheel, so nothing has to
    # be collected by hand. misaki is deliberately NOT used — it pulls spacy and
    # torch for a G2P quality difference we have not measured.
    "onnxruntime>=1.20.1",
    "espeakng-loader>=0.2.4",
    "phonemizer>=3.4.0",
    # Ge'ez-language TTS: MMS VITS models, with uroman romanizing Ge'ez to the
    # Latin alphabet the models' symbol tables actually contain.
    "sherpa-onnx>=1.13.2",
    "uroman>=1.3.1.1",
    # Number-to-words. TEMPORARY git pin: the released num2words2 on PyPI
    # (1.0.20) returns Tigrigna in its own Latin transliteration, which
    # collides with uroman's romanization of the surrounding words and
    # produces audio a native speaker cannot follow. Fixed upstream and
    # merged, but not yet released — so the pin tracks upstream main by SHA,
    # never by branch. Drop it for a plain PyPI dependency as soon as a
    # release >= 1.0.21 lands; see the risk entry in
    # docs/implementation-plan.md. Building from git needs a Rust toolchain
    # and takes about two minutes on a warm cargo cache.
    "num2words2",
]

[tool.uv.sources]
num2words2 = { git = "https://github.com/gladiaio/num2words2", rev = "b3c82111c33a0a8f52450bfd6a57a0a327f0a02f" }

[dependency-groups]
dev = [
    "pyinstaller>=6.10",
    "httpx>=0.27",
    "pytest>=8.0",
    "soundfile>=0.12",
]
```

Then run `cd sidecar && uv sync` — expect a multi-minute Rust build the first time.

- [ ] **Step 2: Write the failing tests**

Create `sidecar/tests/test_guards.py`:

```python
import pytest

from guards import ESPEAK_PATH_LIMIT, assert_espeak_data_path, assert_no_digits


def test_a_short_espeak_path_is_accepted():
    assert_espeak_data_path("/opt/enisma/espeak-ng-data")


def test_the_longest_accepted_path_is_159_characters():
    path = "/a" + "b" * (ESPEAK_PATH_LIMIT - 2)
    assert len(path) == 159
    assert_espeak_data_path(path)


def test_a_160_character_path_is_rejected_before_espeak_can_kill_us():
    path = "/a" + "b" * (ESPEAK_PATH_LIMIT - 1)
    assert len(path) == 160
    with pytest.raises(RuntimeError) as exc:
        assert_espeak_data_path(path)
    assert "159" in str(exc.value)


def test_expanded_text_without_digits_passes():
    assert_no_digits("ሦስት መቶ", "am")


def test_expanded_text_still_holding_digits_is_rejected():
    with pytest.raises(RuntimeError) as exc:
        assert_no_digits("1000000000", "ti")
    assert "ti" in str(exc.value)
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd sidecar && uv run pytest tests/test_guards.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'guards'`.

- [ ] **Step 4: Write the guards**

Create `sidecar/guards.py`:

```python
"""Startup and pipeline assertions for failures that are otherwise silent.

Both guards here exist because the thing they catch does not raise on its own.
"""

from __future__ import annotations

import re

# espeak-ng keeps `path_home` in a fixed-size buffer and, when the data path it
# is handed does not fit, silently falls back to the path compiled into the
# library — which exists only on the machine that built the wheel. It then
# terminates the process rather than returning an error, so there is no Python
# exception, no traceback, and buffered stdout is lost: the sidecar simply dies.
# Measured boundary: 159 characters work, 160 do not.
ESPEAK_PATH_LIMIT = 159

_DIGITS = re.compile(r"\d")


def assert_espeak_data_path(path: str) -> None:
    """Fail loudly before espeak-ng can fail silently."""
    if len(path) > ESPEAK_PATH_LIMIT:
        raise RuntimeError(
            f"espeak-ng data path is {len(path)} characters; the limit is "
            f"{ESPEAK_PATH_LIMIT}. Stage the data at a shorter path — past the "
            f"limit espeak-ng ignores it and terminates the process. Path: {path}"
        )


def assert_no_digits(text: str, context: str) -> None:
    """Catch numbers the converter declined to turn into words.

    num2words2 has no branch above 10**9 for Tigrigna or Oromo and returns the
    raw digits instead. Those digits are not in the MMS symbol tables, so they
    would be dropped later and the number would go unspoken with no trace. We
    do not convert them — that is a deliberate v0 omission — but the omission
    should be visible rather than silent.
    """
    if _DIGITS.search(text):
        raise RuntimeError(
            f"number expansion left digits in {context} text, which the model "
            f"cannot speak: {text!r}"
        )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sidecar && uv run pytest tests/ -v`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add sidecar/pyproject.toml sidecar/uv.lock sidecar/guards.py sidecar/tests/test_guards.py
git commit -m "feat(sidecar): add the TTS dependencies and guard the silent failures

- pin num2words2 to the Tigrigna Ge'ez fork by SHA, temporarily
- reject an espeak-ng data path past 159 chars before it kills the process
- reject expanded text that still holds digits the models cannot speak"
```

---

### Task 5: Sidecar job registry and `/jobs/tts` with a fake engine

**Files:**
- Create: `sidecar/tts.py`
- Create: `sidecar/jobs.py`
- Modify: `sidecar/server.py`
- Create: `sidecar/tests/test_jobs.py`
- Create: `sidecar/tests/test_tts_route.py`

**Interfaces:**
- Consumes: `guards` from Task 4.
- Produces:
  - `tts.Engine` protocol: `synthesize(text: str, voice: str, rate: float, out_path: str, on_progress: Callable[[float], bool]) -> tuple[int, int]` returning `(sample_rate, duration_ms)`. `on_progress` returns `False` to ask the engine to stop.
  - `tts.write_wav(path: str, samples, sample_rate: int) -> int` returning duration in milliseconds.
  - `tts.FakeEngine` — writes a real silent WAV in four progress steps. Used by tests and by Task 6 so the Rust side can be built before either real engine exists.
  - `jobs.Job` and `jobs.JobRegistry` with `start(work) -> str`, `snapshot(job_id) -> dict | None`, `cancel(job_id) -> bool`.
  - `server.JOBS: JobRegistry` and `server.ENGINES_BY_LANGUAGE: dict[str, Engine]`.
  - `POST /jobs/tts` → `{"jobId": str}`; `GET /jobs/{job_id}` → `{"state", "progress", "sampleRate", "durationMs", "message"}`; `DELETE /jobs/{job_id}` → the same snapshot.

**Why a job rather than a streaming response.** Synthesis is a blocking 40–100 second call that reports through a callback, and a Python generator cannot `yield` from inside a callback buried in a synchronous call stack — so a streaming route would have to buffer every progress event until the work finished, which defeats both the progress bar and cancellation. Running the work on a thread and exposing it as a polled job also decouples the work's lifetime from one HTTP connection, which is what M5's multi-hour export over a page range will need.

- [ ] **Step 1: Write the failing job-registry tests**

Create `sidecar/tests/test_jobs.py`:

```python
import threading
import time

from jobs import JobRegistry


def _wait_until(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_a_finished_job_reports_done():
    jobs = JobRegistry()

    def work(job):
        job.progress = 1.0

    job_id = jobs.start(work)
    assert _wait_until(lambda: jobs.snapshot(job_id)["state"] == "done")
    assert jobs.snapshot(job_id)["progress"] == 1.0


def test_progress_is_visible_while_the_job_is_still_running():
    release = threading.Event()
    jobs = JobRegistry()

    def work(job):
        job.progress = 0.5
        release.wait(5)

    job_id = jobs.start(work)
    assert _wait_until(lambda: jobs.snapshot(job_id)["progress"] == 0.5)
    # The whole point: this is readable BEFORE the work finishes.
    assert jobs.snapshot(job_id)["state"] == "running"
    release.set()


def test_a_raising_job_reports_error_with_its_message():
    jobs = JobRegistry()

    def work(job):
        raise RuntimeError("no engine for 'xx'")

    job_id = jobs.start(work)
    assert _wait_until(lambda: jobs.snapshot(job_id)["state"] == "error")
    assert "xx" in jobs.snapshot(job_id)["message"]


def test_cancelling_sets_the_flag_the_work_polls():
    jobs = JobRegistry()
    saw_cancel = threading.Event()

    def work(job):
        for _ in range(500):
            if job.cancel.is_set():
                saw_cancel.set()
                return
            time.sleep(0.01)

    job_id = jobs.start(work)
    assert _wait_until(lambda: jobs.snapshot(job_id)["state"] == "running")
    assert jobs.cancel(job_id)
    assert saw_cancel.wait(5)
    assert _wait_until(lambda: jobs.snapshot(job_id)["state"] == "cancelled")


def test_cancelling_an_unknown_job_reports_false():
    assert JobRegistry().cancel("nope") is False


def test_an_unknown_job_has_no_snapshot():
    assert JobRegistry().snapshot("nope") is None


def test_finished_jobs_are_pruned_so_the_registry_stays_bounded():
    jobs = JobRegistry()
    ids = []
    for _ in range(JobRegistry.MAX_FINISHED + 5):
        job_id = jobs.start(lambda job: None)
        ids.append(job_id)
        assert _wait_until(lambda: jobs.snapshot(job_id) is None
                           or jobs.snapshot(job_id)["state"] == "done")
    live = [i for i in ids if jobs.snapshot(i) is not None]
    assert len(live) <= JobRegistry.MAX_FINISHED + 1
    # The most recent job always survives.
    assert jobs.snapshot(ids[-1]) is not None
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd sidecar && uv run pytest tests/test_jobs.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jobs'`.

- [ ] **Step 3: Write the job registry**

Create `sidecar/jobs.py`:

```python
"""Background jobs the client polls, rather than long streaming responses.

Synthesis is a blocking 40-100 second call that reports through a callback.
A generator cannot yield from inside that callback, so a streaming route would
have to buffer every event until the work was already finished — no usable
progress, and nothing to interrupt. Running the work on a thread and exposing
it as a polled job fixes both, and decouples the work from one HTTP connection
so a long export can outlive the request that started it.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Callable
from uuid import uuid4

RUNNING = "running"
DONE = "done"
ERROR = "error"
CANCELLED = "cancelled"


@dataclass
class Job:
    id: str
    state: str = RUNNING
    progress: float = 0.0
    sample_rate: int | None = None
    duration_ms: int | None = None
    message: str | None = None
    # Work polls this and stops when it is set. Engines already accept a
    # progress callback that returns False to stop, so this bridges to that.
    cancel: threading.Event = field(default_factory=threading.Event)
    started: float = field(default_factory=time.monotonic)


Work = Callable[[Job], None]


class JobRegistry:
    """Thread-per-job, with a bounded memory of finished ones."""

    MAX_FINISHED = 16

    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def start(self, work: Work) -> str:
        job = Job(id=uuid4().hex)
        with self._lock:
            self._prune_locked()
            self._jobs[job.id] = job
        threading.Thread(target=self._run, args=(job, work), daemon=True).start()
        return job.id

    def _run(self, job: Job, work: Work) -> None:
        try:
            work(job)
        except Exception as exc:  # noqa: BLE001 - surfaced to the client verbatim
            job.message = str(exc)
            job.state = ERROR
            return
        # Work that returned early because it saw the cancel flag finished
        # cleanly; the flag is what distinguishes the two.
        job.state = CANCELLED if job.cancel.is_set() else DONE

    def snapshot(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            return {
                "state": job.state,
                "progress": job.progress,
                "sampleRate": job.sample_rate,
                "durationMs": job.duration_ms,
                "message": job.message,
            }

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            return False
        job.cancel.set()
        return True

    def _prune_locked(self) -> None:
        finished = [j for j in self._jobs.values() if j.state != RUNNING]
        if len(finished) <= self.MAX_FINISHED:
            return
        finished.sort(key=lambda j: j.started)
        for job in finished[: len(finished) - self.MAX_FINISHED]:
            self._jobs.pop(job.id, None)
```

- [ ] **Step 4: Write the failing route tests**

Create `sidecar/tests/test_tts_route.py`:

```python
import os
import time

from fastapi.testclient import TestClient

import server
from tts import FakeEngine

AUTH = {"Authorization": "Bearer test-token"}


def _client(monkeypatch):
    monkeypatch.setattr(server, "_token", "test-token")
    monkeypatch.setitem(server.ENGINES_BY_LANGUAGE, "en", FakeEngine())
    return TestClient(server.app)


def _await_terminal(client, job_id, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snap = client.get(f"/jobs/{job_id}", headers=AUTH).json()
        if snap["state"] != "running":
            return snap
        time.sleep(0.02)
    raise AssertionError("job never reached a terminal state")


def _body(out):
    return {
        "text": "hello there", "language": "en", "voice": "af_heart",
        "rate": 1.0, "out_path": str(out),
    }


def test_starting_a_job_requires_the_bearer_token(monkeypatch, tmp_path):
    client = _client(monkeypatch)
    r = client.post("/jobs/tts", json=_body(tmp_path / "x.wav"))
    assert r.status_code == 401


def test_starting_a_job_returns_immediately_with_an_id(monkeypatch, tmp_path):
    client = _client(monkeypatch)
    r = client.post("/jobs/tts", headers=AUTH, json=_body(tmp_path / "p.wav"))
    assert r.status_code == 200
    assert r.json()["jobId"]


def test_the_job_finishes_and_reports_the_audio_it_wrote(monkeypatch, tmp_path):
    client = _client(monkeypatch)
    out = tmp_path / "p.wav"
    job_id = client.post("/jobs/tts", headers=AUTH, json=_body(out)).json()["jobId"]
    snap = _await_terminal(client, job_id)
    assert snap["state"] == "done"
    assert snap["sampleRate"] == 16000
    assert snap["durationMs"] > 0
    assert os.path.getsize(out) > 44  # a real WAV, not an empty file


def test_an_unknown_language_reports_an_error_job(monkeypatch, tmp_path):
    client = _client(monkeypatch)
    body = _body(tmp_path / "p.wav") | {"language": "xx"}
    job_id = client.post("/jobs/tts", headers=AUTH, json=body).json()["jobId"]
    snap = _await_terminal(client, job_id)
    assert snap["state"] == "error"
    assert "xx" in snap["message"]


def test_polling_an_unknown_job_is_a_404(monkeypatch):
    client = _client(monkeypatch)
    assert client.get("/jobs/nope", headers=AUTH).status_code == 404


def test_cancelling_an_unknown_job_is_a_404(monkeypatch):
    client = _client(monkeypatch)
    assert client.delete("/jobs/nope", headers=AUTH).status_code == 404


def test_a_cancelled_job_stops_and_says_so(monkeypatch, tmp_path):
    client = _client(monkeypatch)
    # A slow fake, so there is a window in which to cancel.
    monkeypatch.setitem(server.ENGINES_BY_LANGUAGE, "en", FakeEngine(step_seconds=0.2))
    job_id = client.post(
        "/jobs/tts", headers=AUTH, json=_body(tmp_path / "p.wav")
    ).json()["jobId"]
    assert client.delete(f"/jobs/{job_id}", headers=AUTH).status_code == 200
    snap = _await_terminal(client, job_id)
    assert snap["state"] == "cancelled"
```

- [ ] **Step 5: Run them to verify they fail**

Run: `cd sidecar && uv run pytest tests/test_tts_route.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tts'`.

- [ ] **Step 6: Write the engine contract and the fake**

Create `sidecar/tts.py`:

```python
"""TTS engine registry and the synthesis contract every engine implements.

The contract is deliberately narrow: an engine is handed text, a voice, a rate
and a path to write, and reports progress as it goes. Everything
language-specific — romanization, number expansion, chunking — lives inside the
engine, because it differs completely between Kokoro and MMS.

`on_progress` returning False asks the engine to stop early. Both engines can
honour that between units of work: sherpa-onnx takes a callback whose non-zero
return halts generation, and the Kokoro path checks between chunks.
"""

from __future__ import annotations

import struct
import time
import wave
from typing import Callable, Protocol

OnProgress = Callable[[float], bool]


class Engine(Protocol):
    def synthesize(
        self,
        text: str,
        voice: str,
        rate: float,
        out_path: str,
        on_progress: OnProgress,
    ) -> tuple[int, int]:
        """Write a WAV to out_path. Returns (sample_rate, duration_ms)."""
        ...


def write_wav(path: str, samples, sample_rate: int) -> int:
    """Write float samples as 16-bit PCM. Returns duration in milliseconds."""
    frames = bytearray()
    for s in samples:
        clamped = max(-1.0, min(1.0, float(s)))
        frames += struct.pack("<h", int(clamped * 32767))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(bytes(frames))
    return int(len(samples) / sample_rate * 1000)


class FakeEngine:
    """Silent audio at a believable length, for wiring the transport up.

    Exists so the webview -> Rust -> sidecar path can be built and tested before
    either real engine is in place. Not registered in production.
    """

    SAMPLE_RATE = 16000

    def __init__(self, step_seconds: float = 0.0) -> None:
        self._step_seconds = step_seconds

    def synthesize(self, text, voice, rate, out_path, on_progress):
        steps = 4
        samples = []
        per_step = int(self.SAMPLE_RATE * 0.25)
        for i in range(steps):
            if self._step_seconds:
                time.sleep(self._step_seconds)
            samples.extend([0.0] * per_step)
            if not on_progress((i + 1) / steps):
                break
        duration_ms = write_wav(out_path, samples, self.SAMPLE_RATE)
        return self.SAMPLE_RATE, duration_ms
```

- [ ] **Step 7: Wire the routes into the server**

In `sidecar/server.py`, add these imports beside the existing ones:

```python
from fastapi import HTTPException
from pydantic import BaseModel

from jobs import JobRegistry
from tts import Engine
```

Then, after the `health` route:

```python
JOBS = JobRegistry()

# Language code -> engine. Populated as the real engines land; tests inject a
# fake. An absent language becomes an error job the client can read, not a crash.
ENGINES_BY_LANGUAGE: dict[str, Engine] = {}


class TtsRequest(BaseModel):
    text: str
    language: str
    voice: str = ""
    rate: float = 1.0
    out_path: str


def _tts_work(req: TtsRequest):
    def work(job) -> None:
        engine = ENGINES_BY_LANGUAGE.get(req.language)
        if engine is None:
            raise RuntimeError(f"no TTS engine for language {req.language!r}")

        def on_progress(fraction: float) -> bool:
            job.progress = fraction
            return not job.cancel.is_set()

        sample_rate, duration_ms = engine.synthesize(
            req.text, req.voice, req.rate, req.out_path, on_progress
        )
        job.sample_rate = sample_rate
        job.duration_ms = duration_ms

    return work


@app.post("/jobs/tts")
def start_tts(req: TtsRequest, _: None = Depends(_require_token)) -> dict:
    """Start synthesis and return at once. Poll GET /jobs/{id} for progress."""
    return {"jobId": JOBS.start(_tts_work(req))}


@app.get("/jobs/{job_id}")
def job_status(job_id: str, _: None = Depends(_require_token)) -> dict:
    snapshot = JOBS.snapshot(job_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="no such job")
    return snapshot


@app.delete("/jobs/{job_id}")
def cancel_job(job_id: str, _: None = Depends(_require_token)) -> dict:
    if not JOBS.cancel(job_id):
        raise HTTPException(status_code=404, detail="no such job")
    return JOBS.snapshot(job_id)
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd sidecar && uv run pytest tests/ -v`
Expected: PASS — 7 job tests and 7 route tests on top of Task 4's 5.

- [ ] **Step 9: Commit**

```bash
git add sidecar/jobs.py sidecar/tts.py sidecar/server.py \
        sidecar/tests/test_jobs.py sidecar/tests/test_tts_route.py
git commit -m "feat(sidecar): run synthesis as a polled job

- a generator cannot yield from inside a blocking engine's progress callback,
  so a streaming route would buffer every event until the work had finished
- a thread-backed job makes progress readable while work runs and gives
  cancellation something to set
- decouples the work from one HTTP connection, which M5's export will need"
```

---

### Task 6: Rust conversion and cancellation over the job API

**Files:**
- Modify: `src-tauri/src/sidecar.rs`
- Create: `src-tauri/src/convert.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `audio::{PageAudio, get_page_audio, set_page_audio, text_hash, is_fresh}` (Task 2); `/jobs/tts`, `GET /jobs/{id}`, `DELETE /jobs/{id}` (Task 5).
- Produces:
  - `sidecar::get_json(state, route) -> Result<serde_json::Value, String>`
  - `sidecar::post_json(state, route, body) -> Result<serde_json::Value, String>`
  - `sidecar::delete_json(state, route) -> Result<serde_json::Value, String>`
  - `convert::ActiveConversion(pub Mutex<Option<ActiveJob>>)`, `convert::ActiveJob { project_id: String, page_no: i64, job_id: String }`, both registered with `.manage(...)`.
  - `convert::job_for(active: &Option<ActiveJob>, project_id: &str, page_no: i64) -> Option<String>`
  - `convert::PageAudioDto { path: Option<String>, duration_ms: Option<i64>, sample_rate: Option<i64>, stale: bool }`, `#[serde(rename_all = "camelCase")]`. `path` is **absolute**, resolved the way `get_project_cmd` already resolves `pdf_path`.
  - Commands `convert_page_cmd`, `cancel_conversion_cmd`, `get_page_audio_cmd`.
  - A Tauri event `tts://progress` carrying `{ projectId, pageNo, progress }`.

No `stream` feature is needed on `reqwest` — polling uses plain JSON GETs, and `tokio`'s existing `time` feature covers the wait between polls.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/convert.rs` with this test module:

```rust
//! Driving a page conversion: effective text, the job, and the stored take.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::project;

    fn seed(conn: &mut rusqlite::Connection) -> String {
        project::create_project_with_id(
            conn, "p1", "Biology", "en", "projects/p1/source.pdf", 2,
            &["extracted one".into(), "extracted two".into()],
        )
        .unwrap();
        "p1".to_string()
    }

    #[test]
    fn effective_text_prefers_the_users_correction() {
        let mut conn = db::open_in_memory().unwrap();
        let id = seed(&mut conn);
        project::save_page_text(&conn, &id, 1, "corrected one").unwrap();
        assert_eq!(effective_text(&conn, &id, 1).unwrap(), "corrected one");
    }

    #[test]
    fn effective_text_falls_back_to_the_extraction() {
        let mut conn = db::open_in_memory().unwrap();
        let id = seed(&mut conn);
        assert_eq!(effective_text(&conn, &id, 1).unwrap(), "extracted one");
    }

    #[test]
    fn a_page_with_nothing_to_say_is_rejected_rather_than_synthesized() {
        let mut conn = db::open_in_memory().unwrap();
        let id = seed(&mut conn);
        project::save_page_text(&conn, &id, 1, "   ").unwrap();
        assert!(effective_text(&conn, &id, 1).is_err());
    }

    #[test]
    fn the_dto_marks_audio_stale_after_an_edit() {
        let mut conn = db::open_in_memory().unwrap();
        let id = seed(&mut conn);
        crate::audio::set_page_audio(
            &conn, &id, 1, "projects/p1/audio/page-1.wav",
            &crate::audio::text_hash("extracted one"), "af_heart", 1.0, 24000, 4200,
        )
        .unwrap();

        let fresh =
            page_audio_dto(&conn, &id, 1, "af_heart", 1.0, std::path::Path::new("/data")).unwrap();
        assert!(!fresh.stale);
        assert_eq!(fresh.duration_ms, Some(4200));
        assert!(fresh.path.unwrap().ends_with("projects/p1/audio/page-1.wav"));

        project::save_page_text(&conn, &id, 1, "corrected one").unwrap();
        let stale =
            page_audio_dto(&conn, &id, 1, "af_heart", 1.0, std::path::Path::new("/data")).unwrap();
        assert!(stale.stale);
        // Stale audio stays playable.
        assert!(stale.path.is_some());
    }

    #[test]
    fn a_page_with_no_audio_is_stale_and_has_no_path() {
        let mut conn = db::open_in_memory().unwrap();
        let id = seed(&mut conn);
        let dto =
            page_audio_dto(&conn, &id, 1, "af_heart", 1.0, std::path::Path::new("/data")).unwrap();
        assert!(dto.stale);
        assert!(dto.path.is_none());
    }

    fn active(project_id: &str, page_no: i64) -> Option<ActiveJob> {
        Some(ActiveJob {
            project_id: project_id.to_string(),
            page_no,
            job_id: "job-abc".to_string(),
        })
    }

    #[test]
    fn a_cancel_finds_the_job_for_the_page_that_is_converting() {
        assert_eq!(job_for(&active("p1", 3), "p1", 3).as_deref(), Some("job-abc"));
    }

    #[test]
    fn a_cancel_aimed_at_another_page_matches_nothing() {
        // Cancelling page 4 must never stop page 3's conversion.
        assert!(job_for(&active("p1", 3), "p1", 4).is_none());
        assert!(job_for(&active("p1", 3), "p2", 3).is_none());
    }

    #[test]
    fn a_cancel_with_nothing_running_matches_nothing() {
        assert!(job_for(&None, "p1", 3).is_none());
    }
}
```

Register the module in `src-tauri/src/lib.rs`:

```rust
pub mod convert;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test convert::`
Expected: FAIL to compile — `effective_text`, `page_audio_dto`, `job_for` and `ActiveJob` are not defined.

- [ ] **Step 3: Write the sidecar JSON helpers**

Add to `src-tauri/src/sidecar.rs`. The port and token never leave Rust, exactly as with `/health`:

```rust
fn port_of(state: &SidecarState) -> Result<u16, String> {
    state
        .inner
        .lock()
        .unwrap()
        .port
        .ok_or_else(|| "sidecar starting".to_string())
}

async fn read_json(resp: reqwest::Response, route: &str) -> Result<serde_json::Value, String> {
    if !resp.status().is_success() {
        return Err(format!("{route} returned {}", resp.status()));
    }
    resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

pub async fn get_json(state: &SidecarState, route: &str) -> Result<serde_json::Value, String> {
    let url = format!("http://{LOOPBACK}:{}{route}", port_of(state)?);
    let resp = state
        .http
        .get(&url)
        .bearer_auth(&state.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    read_json(resp, route).await
}

pub async fn post_json(
    state: &SidecarState,
    route: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = format!("http://{LOOPBACK}:{}{route}", port_of(state)?);
    let resp = state
        .http
        .post(&url)
        .bearer_auth(&state.token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    read_json(resp, route).await
}

pub async fn delete_json(state: &SidecarState, route: &str) -> Result<serde_json::Value, String> {
    let url = format!("http://{LOOPBACK}:{}{route}", port_of(state)?);
    let resp = state
        .http
        .delete(&url)
        .bearer_auth(&state.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    read_json(resp, route).await
}
```

- [ ] **Step 4: Write the conversion module**

Insert above the test module in `src-tauri/src/convert.rs`:

```rust
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::Connection;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

use crate::audio;
use crate::sidecar::{self, SidecarState};
use crate::{DataDir, Db};

/// How often to ask the sidecar how a conversion is going. Synthesis runs for
/// 40-100 seconds, so this is about a responsive progress bar and a prompt
/// Cancel, not about precision.
const POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone)]
pub struct ActiveJob {
    pub project_id: String,
    pub page_no: i64,
    pub job_id: String,
}

/// The one conversion that may be running. Conversion is one page at a time by
/// design, so a single slot is the whole bookkeeping.
#[derive(Default)]
pub struct ActiveConversion(pub Mutex<Option<ActiveJob>>);

/// The job id to cancel for a given page, if that page is the one running.
///
/// The page check is load-bearing: a Cancel aimed at a page the user has since
/// navigated away from must not stop the conversion that is actually running.
pub fn job_for(active: &Option<ActiveJob>, project_id: &str, page_no: i64) -> Option<String> {
    active
        .as_ref()
        .filter(|j| j.project_id == project_id && j.page_no == page_no)
        .map(|j| j.job_id.clone())
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PageAudioDto {
    /// Absolute path for the webview's asset protocol, or None when no take exists.
    pub path: Option<String>,
    pub duration_ms: Option<i64>,
    pub sample_rate: Option<i64>,
    /// True when there is no take, or the take no longer matches the text and
    /// settings. A stale take is still playable — this only drives the badge.
    pub stale: bool,
}

/// What would actually be spoken: the user's correction when there is one, the
/// extraction otherwise. Mirrors the editor's own precedence.
pub fn effective_text(
    conn: &Connection,
    project_id: &str,
    page_no: i64,
) -> Result<String, String> {
    let page = crate::project::get_page(conn, project_id, page_no).map_err(|e| e.to_string())?;
    let text = page.edited_text.or(page.source_text).unwrap_or_default();
    if text.trim().is_empty() {
        return Err("this page has no text to read".into());
    }
    Ok(text)
}

pub fn page_audio_dto(
    conn: &Connection,
    project_id: &str,
    page_no: i64,
    voice: &str,
    rate: f64,
    data_dir: &Path,
) -> Result<PageAudioDto, String> {
    let stored = audio::get_page_audio(conn, project_id, page_no).map_err(|e| e.to_string())?;
    // A page with no text can never be fresh, and must not blow up the panel.
    let current = effective_text(conn, project_id, page_no).unwrap_or_default();
    let stale = !audio::is_fresh(&stored, &current, voice, rate);
    Ok(PageAudioDto {
        path: stored
            .path
            .as_ref()
            .map(|p| data_dir.join(p).to_string_lossy().into_owned()),
        duration_ms: stored.duration_ms,
        sample_rate: stored.sample_rate,
        stale,
    })
}

fn audio_rel_path(project_id: &str, page_no: i64) -> String {
    format!("projects/{project_id}/audio/page-{page_no}.wav")
}

#[tauri::command]
pub async fn convert_page_cmd(
    app: AppHandle,
    db: State<'_, Db>,
    data: State<'_, DataDir>,
    sidecar_state: State<'_, SidecarState>,
    active: State<'_, ActiveConversion>,
    project_id: String,
    page_no: i64,
    voice: String,
    rate: f64,
) -> Result<PageAudioDto, String> {
    let (text, language) = {
        let conn = db.0.lock().unwrap();
        let text = effective_text(&conn, &project_id, page_no)?;
        let detail =
            crate::project::get_project(&conn, &project_id).map_err(|e| e.to_string())?;
        (text, detail.language)
    };

    let rel = audio_rel_path(&project_id, page_no);
    let out_path: PathBuf = data.0.join(&rel);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let started = sidecar::post_json(
        &sidecar_state,
        "/jobs/tts",
        json!({
            "text": text,
            "language": language,
            "voice": voice,
            "rate": rate,
            "out_path": out_path.to_string_lossy(),
        }),
    )
    .await?;
    let job_id = started["jobId"]
        .as_str()
        .ok_or("sidecar did not return a job id")?
        .to_string();

    *active.0.lock().unwrap() = Some(ActiveJob {
        project_id: project_id.clone(),
        page_no,
        job_id: job_id.clone(),
    });

    let outcome = poll_job(&app, &sidecar_state, &job_id, &project_id, page_no).await;

    // Whatever happened, this page is no longer the one converting.
    *active.0.lock().unwrap() = None;

    let (sample_rate, duration_ms) = outcome?;

    let conn = db.0.lock().unwrap();
    audio::set_page_audio(
        &conn,
        &project_id,
        page_no,
        &rel,
        &audio::text_hash(&text),
        &voice,
        rate,
        sample_rate,
        duration_ms,
    )
    .map_err(|e| e.to_string())?;
    page_audio_dto(&conn, &project_id, page_no, &voice, rate, &data.0)
}

/// Watch one job to a terminal state, emitting progress as it goes.
async fn poll_job(
    app: &AppHandle,
    sidecar_state: &SidecarState,
    job_id: &str,
    project_id: &str,
    page_no: i64,
) -> Result<(i64, i64), String> {
    loop {
        tokio::time::sleep(POLL_INTERVAL).await;
        let snapshot = sidecar::get_json(sidecar_state, &format!("/jobs/{job_id}")).await?;
        match snapshot["state"].as_str() {
            Some("running") => {
                let _ = app.emit(
                    "tts://progress",
                    json!({
                        "projectId": project_id,
                        "pageNo": page_no,
                        "progress": snapshot["progress"].as_f64().unwrap_or(0.0),
                    }),
                );
            }
            Some("done") => {
                return Ok((
                    snapshot["sampleRate"].as_i64().unwrap_or(0),
                    snapshot["durationMs"].as_i64().unwrap_or(0),
                ))
            }
            Some("cancelled") => return Err("conversion cancelled".into()),
            Some("error") => {
                return Err(snapshot["message"]
                    .as_str()
                    .unwrap_or("synthesis failed")
                    .to_string())
            }
            other => return Err(format!("unexpected job state {other:?}")),
        }
    }
}

#[tauri::command]
pub async fn cancel_conversion_cmd(
    sidecar_state: State<'_, SidecarState>,
    active: State<'_, ActiveConversion>,
    project_id: String,
    page_no: i64,
) -> Result<(), String> {
    let job_id = {
        let guard = active.0.lock().unwrap();
        job_for(&guard, &project_id, page_no)
    };
    // Nothing running for this page is not an error — the conversion may have
    // finished between the user's click and this call.
    let Some(job_id) = job_id else { return Ok(()) };
    sidecar::delete_json(&sidecar_state, &format!("/jobs/{job_id}")).await?;
    Ok(())
}

#[tauri::command]
pub fn get_page_audio_cmd(
    db: State<'_, Db>,
    data: State<'_, DataDir>,
    project_id: String,
    page_no: i64,
    voice: String,
    rate: f64,
) -> Result<PageAudioDto, String> {
    let conn = db.0.lock().unwrap();
    page_audio_dto(&conn, &project_id, page_no, &voice, rate, &data.0)
}
```

- [ ] **Step 5: Register the state and the commands**

In `src-tauri/src/lib.rs`, add `.manage(convert::ActiveConversion::default())` beside the other `.manage(...)` calls, and add to `tauri::generate_handler!`:

```rust
            convert::convert_page_cmd,
            convert::cancel_conversion_cmd,
            convert::get_page_audio_cmd,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS — 8 new tests plus everything before.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/convert.rs src-tauri/src/sidecar.rs src-tauri/src/lib.rs
git commit -m "feat(tts): convert a page as a job, with real progress and cancel

- start a sidecar job and poll it, so progress arrives while work runs
- refuse a cancel aimed at a page other than the one converting
- record the take only when the job actually completed"
```

---

### Task 7: Panel state machine and the two-stage UI

**Files:**
- Create: `src/lib/audio-state.ts`
- Create: `src/lib/audio-state.test.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/components/editor/settings-panel.tsx`
- Modify: `src/components/editor/editor.tsx`

**Interfaces:**
- Consumes: `convert_page_cmd`, `cancel_conversion_cmd`, `get_page_audio_cmd` (Task 6), and the `tts://progress` event.
- Produces:
  - `audioStateFor(state: { path: string | null; stale: boolean; converting: boolean; hasText: boolean }): AudioPanelState` where `AudioPanelState = "converting" | "noText" | "absent" | "stale" | "fresh"`.
  - TS `PageAudio { path: string | null; durationMs: number | null; sampleRate: number | null; stale: boolean }`.
  - `convertPage(projectId, pageNo, voice, rate)`, `cancelConversion(projectId, pageNo)` and `getPageAudio(projectId, pageNo, voice, rate)` in `api.ts`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/audio-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { audioStateFor } from "./audio-state";

const base = { path: null, stale: true, converting: false, hasText: true };

describe("audioStateFor", () => {
  it("reports conversion above everything else", () => {
    expect(audioStateFor({ ...base, converting: true })).toBe("converting");
    expect(
      audioStateFor({ ...base, converting: true, hasText: false }),
    ).toBe("converting");
  });

  it("refuses to offer conversion for a page with no text", () => {
    expect(audioStateFor({ ...base, hasText: false })).toBe("noText");
  });

  it("reports absent when the page has never been converted", () => {
    expect(audioStateFor({ ...base, path: null })).toBe("absent");
  });

  it("reports stale when a take exists but no longer matches", () => {
    expect(
      audioStateFor({ ...base, path: "/data/page-1.wav", stale: true }),
    ).toBe("stale");
  });

  it("reports fresh when the take matches the text and settings", () => {
    expect(
      audioStateFor({ ...base, path: "/data/page-1.wav", stale: false }),
    ).toBe("fresh");
  });

  it("keeps a stale take playable rather than treating it as absent", () => {
    // The distinction the panel needs: 'stale' still has a path to play.
    expect(
      audioStateFor({ ...base, path: "/data/page-1.wav", stale: true }),
    ).not.toBe("absent");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test src/lib/audio-state.test.ts`
Expected: FAIL — cannot resolve `./audio-state`.

- [ ] **Step 3: Write the state machine**

Create `src/lib/audio-state.ts`:

```ts
/**
 * What the audio half of the settings panel should be showing.
 *
 * Conversion is explicit and two-stage: nothing is synthesized until the user
 * asks, and a page takes 40-100 seconds to convert. So the panel has to say
 * which of four resting states it is in, and "stale" is the one that matters
 * most — a take that no longer matches the text or settings is still worth
 * playing, so it must not collapse into "absent".
 */
export type AudioPanelState = "converting" | "noText" | "absent" | "stale" | "fresh";

export function audioStateFor(state: {
  /** Absolute path of the stored take, or null when there is none. */
  path: string | null;
  /** Whether the take no longer matches the current text, voice and rate. */
  stale: boolean;
  /** Whether a conversion is in flight for this page right now. */
  converting: boolean;
  /** Whether the page has anything to read at all. */
  hasText: boolean;
}): AudioPanelState {
  const { path, stale, converting, hasText } = state;

  // A conversion in flight outranks everything, including a page whose text
  // was emptied while it ran.
  if (converting) return "converting";

  // Nothing to read means nothing to offer; the Convert button is disabled.
  if (!hasText) return "noText";

  if (path === null) return "absent";

  return stale ? "stale" : "fresh";
}
```

- [ ] **Step 4: Add the API wrappers**

Append to `src/lib/api.ts`:

```ts
export interface PageAudio {
  /** Absolute path, already resolved by Rust; feed to convertFileSrc. */
  path: string | null;
  durationMs: number | null;
  sampleRate: number | null;
  /** No take, or one that no longer matches the text, voice and rate. */
  stale: boolean;
}

/**
 * Synthesize one page. Slow — 40-100s — and resolves only when the job reaches
 * a terminal state. Progress arrives meanwhile on the `tts://progress` event;
 * a cancelled conversion rejects with "conversion cancelled".
 */
export const convertPage = (
  projectId: string,
  pageNo: number,
  voice: string,
  rate: number,
) => invoke<PageAudio>("convert_page_cmd", { projectId, pageNo, voice, rate });

/** Stop the conversion running for this page. A no-op if none is. */
export const cancelConversion = (projectId: string, pageNo: number) =>
  invoke<void>("cancel_conversion_cmd", { projectId, pageNo });

export const getPageAudio = (
  projectId: string,
  pageNo: number,
  voice: string,
  rate: number,
) => invoke<PageAudio>("get_page_audio_cmd", { projectId, pageNo, voice, rate });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run test && bun run build`
Expected: PASS — 6 new tests on top of the existing 87, and a clean build.

- [ ] **Step 6: Wire the panel**

In `src/components/editor/editor.tsx`, delete the fake playback timer at the `useEffect` watching `playing` (the 4.5-second `setTimeout`), and replace the local audio state with real data: hold `audio: PageAudio | null` and `converting: boolean`, load via `getPageAudio` whenever the active page, voice or rate changes, and pass both down to `SettingsPanel` along with an `onConvert` handler that calls `convertPage` and sets `converting` around it.

In `src/components/editor/settings-panel.tsx`:

- Replace the `PLACEHOLDER_VOICES` import and lookup with a `voices: string[]` prop supplied by the editor.
- Hide the entire Voice `<Field>` when `voices.length === 0` — the MMS languages are single-speaker and have nothing to choose.
- Add a Convert button above the player card, labelled from `t("ttsPanel.convert")`, disabled unless `audioStateFor(...)` is `absent` or `stale`.
- Disable the play, rewind and forward controls unless a `path` exists.
- Replace the hardcoded `"0:14"` and `"1:42"` with the real playback position and `formatDuration(audio.durationMs)`.
- When the state is `stale`, render a badge beside the Convert button reading `t("ttsPanel.stale")`.
- When the state is `converting`, render the progress reported by the `tts://progress` event and a Cancel action, and have the editor block interaction while it runs.

- [ ] **Step 7: Add the strings**

Add to `src/locales/en.json` under `ttsPanel`, then translate into `am.json`, `ti.json` and `om.json`:

```json
"convert": {
  "message": "Convert to audio",
  "context": "Button that synthesizes the current page. Takes 40-100 seconds, so it is deliberately explicit rather than automatic."
},
"converting": {
  "message": "Converting page {n}…",
  "context": "Shown while synthesis runs and the editor is blocked."
},
"cancel": {
  "message": "Cancel",
  "context": "Stops a conversion that is in progress."
},
"stale": {
  "message": "Out of date",
  "context": "Badge on the audio player meaning the audio was made before the current text or settings. The audio still plays."
},
"noText": {
  "message": "Nothing to read on this page.",
  "context": "Replaces the Convert button when the page has no text at all."
}
```

Append the three non-English versions to `docs/translations-needing-review.md`.

- [ ] **Step 8: Verify nothing regressed**

Run: `bun run test && bun run build`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/audio-state.ts src/lib/audio-state.test.ts src/lib/api.ts \
        src/components/editor/settings-panel.tsx src/components/editor/editor.tsx \
        src/locales docs/translations-needing-review.md
git commit -m "feat(editor): convert a page to audio in two explicit stages

- add the fresh/stale/absent/noText state machine behind the panel
- replace the mock 4.5s playback timer with real stored audio
- keep a stale take playable and badge it rather than hiding it"
```

---

### Task 8: Text preparation for Amharic, Tigrigna and Oromo

**Files:**
- Create: `sidecar/prepare.py`
- Create: `sidecar/tests/test_prepare_geez.py`

**Interfaces:**
- Consumes: `guards.assert_no_digits` (Task 4).
- Produces:
  - `prepare.LCODE: dict[str, str]` mapping `{"am": "amh", "ti": "tir", "om": "orm"}`.
  - `prepare.expand_numbers(text: str, language: str, romanize: Callable[[str, str], str]) -> str`
  - `prepare.prepare_geez(text: str, language: str, romanize: Callable[[str, str], str]) -> str`

`romanize` is injected so these functions can be tested without loading uroman's tables.

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/test_prepare_geez.py`:

```python
import pytest

from prepare import expand_numbers, prepare_geez

# Stand-in for uroman: enough to exercise the numeral path without its tables.
GEEZ_DIGITS = {"፩": "1", "፫": "3", "፵": "40", "፯": "7", "፲": "10", "፻": "100"}


def fake_romanize(text: str, lcode: str) -> str:
    if all(ch in GEEZ_DIGITS for ch in text):
        # uroman turns a Ge'ez numeral run into its Arabic value.
        if text == "፵፯":
            return "47"
        if text == "፲፱፻፹፭":
            return "1985"
        return "".join(GEEZ_DIGITS[ch] for ch in text)
    return text.replace("።", ".")


def test_arabic_digits_become_words():
    out = expand_numbers("ምዕራፍ 3", "am", fake_romanize)
    assert "3" not in out
    assert "ሦስት" in out


def test_geez_numerals_become_the_same_words_as_arabic_digits():
    geez = expand_numbers("ምዕራፍ ፫", "am", fake_romanize)
    arabic = expand_numbers("ምዕራፍ 3", "am", fake_romanize)
    assert geez == arabic


def test_a_prefix_bound_to_a_number_survives_as_a_separate_word():
    # ብ1985 writes the preposition onto the numeral. Spaced substitution was
    # confirmed acceptable by a native speaker.
    out = expand_numbers("ብ1985 ዓመተ ምሕረት", "ti", fake_romanize)
    assert "ብ" in out
    assert "1985" not in out


def test_tigrigna_numbers_come_back_in_geez_script_not_latin():
    out = expand_numbers("ገጽ 47", "ti", fake_romanize)
    assert "arba" not in out.lower()
    assert any("ሀ" <= ch <= "፿" for ch in out)


def test_a_number_the_converter_declines_is_reported_not_swallowed():
    # num2words2 has no branch above 10**9 for ti/om and returns raw digits.
    with pytest.raises(RuntimeError):
        expand_numbers("ብ1000000000 ዓመተ ምሕረት", "ti", fake_romanize)


def test_prepare_keeps_the_sentence_period():
    # The period is what segments utterances in sherpa-onnx. Losing it collapses
    # a whole page into one atomic call with no progress and no cancellation.
    out = prepare_geez("ሓደ ነገር። ካልእ ነገር።", "ti", fake_romanize)
    assert out.count(".") == 2


def test_prepare_strips_what_the_symbol_table_cannot_speak():
    out = prepare_geez("ሓደ (ነገር) 50% ነው።", "ti", fake_romanize)
    assert "(" not in out and ")" not in out and "%" not in out


def test_prepare_collapses_the_gaps_left_by_stripping():
    out = prepare_geez("ሓደ  ((  ነገር።", "ti", fake_romanize)
    assert "  " not in out
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sidecar && uv run pytest tests/test_prepare_geez.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'prepare'`.

- [ ] **Step 3: Write the preparation pipeline**

Create `sidecar/prepare.py`:

```python
"""Turning stored page text into something each engine can actually speak.

Order is load-bearing throughout and is not interchangeable.
"""

from __future__ import annotations

import re
from typing import Callable

from num2words2 import num2words

from guards import assert_no_digits

# uroman's language codes, which are not the project's two-letter codes.
LCODE = {"am": "amh", "ti": "tir", "om": "orm"}

# Ethiopic numerals: ፩-፼.
_GEEZ_NUMERALS = re.compile(r"[፩-፼]+")
_ARABIC_DIGITS = re.compile(r"\d+")
# What the MMS character frontends actually contain, plus the sentence period
# that segments utterances.
_UNSPEAKABLE = re.compile(r"[^A-Za-z'\s.]+")
_WHITESPACE = re.compile(r"\s+")

Romanize = Callable[[str, str], str]


def expand_numbers(text: str, language: str, romanize: Romanize) -> str:
    """Replace every numeral with words in the project's own language.

    Runs BEFORE romanization, so the words it emits are in Ge'ez script and get
    romanized by the same pass as the surrounding text. Emitting them in Latin
    instead is what made Tigrigna unintelligible: the model is trained on
    uroman's conventions, and a second transliteration scheme in the same
    sentence is out-of-distribution spelling.
    """
    lcode = LCODE[language]

    def from_geez(match: re.Match[str]) -> str:
        # uroman is the numeral parser: it maps ፫ -> 3 and ፻ -> 100 correctly,
        # which is exactly where abugida 0.3.4 fails. Applied to the numeral
        # run alone, before the whole-text pass.
        value = romanize(match.group(), lcode).strip()
        if not value.isdigit():
            return match.group()
        return f" {num2words(int(value), lang=language)} "

    text = _GEEZ_NUMERALS.sub(from_geez, text)
    text = _ARABIC_DIGITS.sub(
        lambda m: f" {num2words(int(m.group()), lang=language)} ", text
    )
    text = _WHITESPACE.sub(" ", text).strip()
    assert_no_digits(text, language)
    return text


def prepare_geez(text: str, language: str, romanize: Romanize) -> str:
    """Full pipeline for the three MMS languages."""
    expanded = expand_numbers(text, language, romanize)
    romanized = romanize(expanded, LCODE[language])
    # uroman has already turned ። into '.', so keeping '.' preserves the Ge'ez
    # sentence boundaries that sherpa-onnx segments on.
    stripped = _UNSPEAKABLE.sub(" ", romanized)
    return _WHITESPACE.sub(" ", stripped).strip()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd sidecar && uv run pytest tests/ -v`
Expected: PASS — 8 new tests.

- [ ] **Step 5: Commit**

```bash
git add sidecar/prepare.py sidecar/tests/test_prepare_geez.py
git commit -m "feat(sidecar): expand numbers and romanize Ge'ez text for MMS

- expand numerals before romanizing so numbers share uroman's conventions
- use uroman as the Ge'ez numeral parser rather than abugida
- keep the sentence period, which is what segments utterances"
```

---

### Task 9: English text preparation and chunking

**Files:**
- Modify: `sidecar/prepare.py`
- Create: `sidecar/tests/test_prepare_english.py`

**Interfaces:**
- Consumes: `prepare` from Task 8.
- Produces:
  - `prepare.KOKORO_TOKEN_LIMIT = 510`
  - `prepare.tokenize(phonemes: str, vocab: dict[str, int]) -> list[int]`
  - `prepare.chunk_english(text: str, vocab: dict[str, int], phonemize: Callable[[str], str]) -> list[list[int]]`

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/test_prepare_english.py`:

```python
from prepare import KOKORO_TOKEN_LIMIT, chunk_english, tokenize

VOCAB = {ch: i + 1 for i, ch in enumerate("abcdefghijklmnopqrstuvwxyz .,")}


def fake_phonemize(text: str) -> str:
    # One "phoneme" per character keeps the token arithmetic legible.
    return text.lower()


def test_tokenize_drops_symbols_the_vocab_does_not_have():
    assert tokenize("ab!c", VOCAB) == [VOCAB["a"], VOCAB["b"], VOCAB["c"]]


def test_short_text_is_a_single_chunk():
    chunks = chunk_english("hello there.", VOCAB, fake_phonemize)
    assert len(chunks) == 1
    assert len(chunks[0]) <= KOKORO_TOKEN_LIMIT


def test_a_long_page_is_split_on_sentence_boundaries():
    sentence = "the cell is the basic unit of life. "
    chunks = chunk_english(sentence * 40, VOCAB, fake_phonemize)
    assert len(chunks) > 1


def test_no_chunk_exceeds_the_context_limit():
    sentence = "the cell is the basic unit of life. "
    for chunk in chunk_english(sentence * 60, VOCAB, fake_phonemize):
        assert len(chunk) <= KOKORO_TOKEN_LIMIT


def test_a_single_sentence_longer_than_the_limit_is_still_bounded():
    # No sentence boundary to split on; it must be truncated, not passed
    # through oversized — the style vector is indexed by token count and has
    # only 510 rows.
    monster = "word " * 400
    for chunk in chunk_english(monster, VOCAB, fake_phonemize):
        assert len(chunk) <= KOKORO_TOKEN_LIMIT


def test_empty_text_produces_no_chunks():
    assert chunk_english("   ", VOCAB, fake_phonemize) == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sidecar && uv run pytest tests/test_prepare_english.py -v`
Expected: FAIL — `ImportError: cannot import name 'chunk_english' from 'prepare'`.

- [ ] **Step 3: Write the chunker**

Append to `sidecar/prepare.py`:

```python
# Kokoro's context is 512, and its style vector has exactly 510 rows indexed by
# token count (each voices/*.bin is 510 x 1 x 256 float32). 510 is the usable
# ceiling, and a page phonemizes to roughly 1586 tokens, so chunking is not
# optional for English.
KOKORO_TOKEN_LIMIT = 510

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


def tokenize(phonemes: str, vocab: dict[str, int]) -> list[int]:
    """Map phoneme characters to Kokoro's ids, dropping anything unmapped."""
    return [vocab[ch] for ch in phonemes if ch in vocab]


def chunk_english(
    text: str,
    vocab: dict[str, int],
    phonemize: Callable[[str], str],
) -> list[list[int]]:
    """Split a page into sentence-aligned chunks that fit the context.

    espeak-ng expands numbers itself during phonemization, so there is no
    number-to-words step on this path.
    """
    if not text.strip():
        return []

    chunks: list[list[int]] = []
    current = ""
    for sentence in _SENTENCE_SPLIT.split(text.strip()):
        if not sentence:
            continue
        candidate = f"{current} {sentence}".strip()
        if len(tokenize(phonemize(candidate), vocab)) > KOKORO_TOKEN_LIMIT and current:
            chunks.append(tokenize(phonemize(current), vocab))
            current = sentence
        else:
            current = candidate
    if current:
        chunks.append(tokenize(phonemize(current), vocab))

    # A single sentence can still exceed the limit on its own; the style vector
    # simply has no row beyond 510, so it is truncated rather than rejected.
    return [c[:KOKORO_TOKEN_LIMIT] for c in chunks if c]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd sidecar && uv run pytest tests/ -v`
Expected: PASS — 6 new tests.

- [ ] **Step 5: Commit**

```bash
git add sidecar/prepare.py sidecar/tests/test_prepare_english.py
git commit -m "feat(sidecar): chunk English phonemes to Kokoro's 510-token ceiling"
```

---

### Task 10: The MMS engine

**Files:**
- Create: `sidecar/engine_mms.py`
- Create: `sidecar/tests/test_engine_mms.py`
- Modify: `sidecar/server.py`

**Interfaces:**
- Consumes: `prepare.prepare_geez` (Task 8), `tts.Engine`/`tts.write_wav` (Task 5), `models.model_dir` (Task 12 supplies the real one; this task takes the directory as a constructor argument).
- Produces: `engine_mms.MmsEngine(model_dir: str, language: str)` implementing `Engine`, at 16 kHz.

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/test_engine_mms.py`:

```python
import numpy as np
import pytest

from engine_mms import MmsEngine


class FakeTts:
    """Stands in for sherpa_onnx.OfflineTts, including its callback contract."""

    sample_rate = 16000
    num_speakers = 0

    def __init__(self):
        self.last_text = None

    def generate(self, text, sid=0, speed=1.0, callback=None):
        self.last_text = text
        self.last_speed = speed
        sentences = [s for s in text.split(".") if s.strip()]
        samples = []
        for i, _ in enumerate(sentences):
            piece = np.zeros(8000, dtype=np.float32)
            samples.append(piece)
            if callback is not None and callback(piece, (i + 1) / len(sentences)) == 0:
                break

        class Result:
            pass

        r = Result()
        r.samples = np.concatenate(samples) if samples else np.zeros(0, dtype=np.float32)
        r.sample_rate = self.sample_rate
        return r


def _engine(monkeypatch, fake):
    engine = MmsEngine.__new__(MmsEngine)
    engine._tts = fake
    engine._language = "ti"
    engine._romanize = lambda text, lcode: text.replace("።", ".")
    return engine


def test_it_synthesizes_and_reports_the_sample_rate(monkeypatch, tmp_path):
    fake = FakeTts()
    engine = _engine(monkeypatch, fake)
    out = tmp_path / "p.wav"
    sample_rate, duration_ms = engine.synthesize(
        "hade neger። kalie neger።", "", 1.0, str(out), lambda f: True
    )
    assert sample_rate == 16000
    assert duration_ms > 0
    assert out.exists()


def test_progress_is_reported_per_sentence(monkeypatch, tmp_path):
    fake = FakeTts()
    engine = _engine(monkeypatch, fake)
    seen = []
    engine.synthesize(
        "one። two። three።", "", 1.0, str(tmp_path / "p.wav"),
        lambda f: seen.append(f) or True,
    )
    assert len(seen) == 3
    assert seen == sorted(seen)


def test_returning_false_stops_early(monkeypatch, tmp_path):
    fake = FakeTts()
    engine = _engine(monkeypatch, fake)
    calls = []

    def stop_after_one(fraction):
        calls.append(fraction)
        return False

    engine.synthesize(
        "one। two। three।".replace("।", "።"), "", 1.0,
        str(tmp_path / "p.wav"), stop_after_one,
    )
    assert len(calls) == 1


def test_the_rate_is_passed_to_the_engine_as_speed(monkeypatch, tmp_path):
    fake = FakeTts()
    engine = _engine(monkeypatch, fake)
    engine.synthesize("one።", "", 1.5, str(tmp_path / "p.wav"), lambda f: True)
    assert fake.last_speed == 1.5
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sidecar && uv run pytest tests/test_engine_mms.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'engine_mms'`.

- [ ] **Step 3: Write the engine**

Create `sidecar/engine_mms.py`:

```python
"""MMS VITS via sherpa-onnx, for Amharic, Tigrigna and Afaan Oromo.

Single-speaker models at 16 kHz; the `voice` argument is accepted for contract
compatibility and ignored.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import sherpa_onnx
import uroman as _uroman

from prepare import LCODE, prepare_geez
from tts import write_wav

log = logging.getLogger("engine.mms")


class MmsEngine:
    def __init__(self, model_dir: str, language: str) -> None:
        model = Path(model_dir) / "model.onnx"
        tokens = Path(model_dir) / "tokens.txt"
        if not model.exists() or not tokens.exists():
            raise FileNotFoundError(
                f"MMS model for {language} not found in {model_dir} "
                "(expected model.onnx and tokens.txt)"
            )
        self._language = language
        self._tts = sherpa_onnx.OfflineTts(
            sherpa_onnx.OfflineTtsConfig(
                model=sherpa_onnx.OfflineTtsModelConfig(
                    vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                        model=str(model), tokens=str(tokens)
                    ),
                    num_threads=2,
                    provider="cpu",
                )
            )
        )
        # Building uroman's tables takes ~2s; do it once, not per request.
        self._uroman = _uroman.Uroman()
        self._romanize = lambda text, lcode: str(
            self._uroman.romanize_string(text, lcode=lcode)
        )

    def synthesize(self, text, voice, rate, out_path, on_progress):
        prepared = prepare_geez(text, self._language, self._romanize)
        if not prepared:
            raise RuntimeError("nothing left to speak after preparing the text")

        # sherpa-onnx calls back once per utterance, and it decides utterances
        # from the sentence punctuation we deliberately kept. Stripping that
        # punctuation would collapse the page into one atomic call: no
        # progress, and cancellation ignored.
        def callback(samples, progress) -> int:
            return 1 if on_progress(float(progress)) else 0

        result = self._tts.generate(prepared, sid=0, speed=rate, callback=callback)
        samples = np.asarray(result.samples, dtype=np.float32)
        duration_ms = write_wav(out_path, samples, result.sample_rate)
        return result.sample_rate, duration_ms
```

- [ ] **Step 4: Register it at startup**

In `sidecar/server.py`, inside `main()` before serving, populate the registry for the three MMS languages from the model directory (Task 12 provides `models.model_dir`):

```python
    for lang in ("am", "ti", "om"):
        try:
            ENGINES_BY_LANGUAGE[lang] = MmsEngine(models.model_dir(lang), lang)
        except FileNotFoundError:
            # Absent models are normal before the first download; /tts reports
            # the missing language rather than the sidecar failing to start.
            log.info("MMS model for %s not present yet", lang)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sidecar && uv run pytest tests/ -v`
Expected: PASS — 4 new tests.

- [ ] **Step 6: Commit**

```bash
git add sidecar/engine_mms.py sidecar/tests/test_engine_mms.py sidecar/server.py
git commit -m "feat(sidecar): synthesize Amharic, Tigrigna and Oromo through sherpa-onnx"
```

---

### Task 11: The Kokoro engine

**Files:**
- Create: `sidecar/engine_kokoro.py`
- Create: `sidecar/tests/test_engine_kokoro.py`
- Modify: `sidecar/server.py`

**Interfaces:**
- Consumes: `prepare.chunk_english` (Task 9), `tts.write_wav` (Task 5), `guards.assert_espeak_data_path` (Task 4).
- Produces:
  - `engine_kokoro.KokoroEngine(model_dir: str)` implementing `Engine`, at 24 kHz.
  - `engine_kokoro.list_voices(model_dir: str) -> list[str]` — the voice names present on disk, sorted.

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/test_engine_kokoro.py`:

```python
import json

import numpy as np
import pytest

from engine_kokoro import KokoroEngine, list_voices


def _model_dir(tmp_path):
    (tmp_path / "voices").mkdir()
    for name in ("af_heart", "am_michael", "bm_george"):
        # 510 style rows of 256 float32, exactly as the real files are shaped.
        np.zeros((510, 1, 256), dtype=np.float32).tofile(
            tmp_path / "voices" / f"{name}.bin"
        )
    (tmp_path / "tokenizer.json").write_text(
        json.dumps({"model": {"vocab": {ch: i + 1 for i, ch in enumerate("abcdefgh .")}}})
    )
    return tmp_path


class FakeSession:
    def __init__(self, *_args, **_kwargs):
        self.calls = 0

    def run(self, _outputs, feeds):
        self.calls += 1
        # One second of silence per chunk at 24 kHz.
        return [np.zeros((1, 24000), dtype=np.float32)]


def _engine(tmp_path, monkeypatch):
    engine = KokoroEngine.__new__(KokoroEngine)
    engine._dir = _model_dir(tmp_path)
    engine._vocab = json.loads((engine._dir / "tokenizer.json").read_text())["model"]["vocab"]
    engine._session = FakeSession()
    engine._phonemize = lambda text: text.lower()
    return engine


def test_list_voices_returns_what_is_on_disk(tmp_path):
    d = _model_dir(tmp_path)
    assert list_voices(str(d)) == ["af_heart", "am_michael", "bm_george"]


def test_it_synthesizes_and_reports_24khz(tmp_path, monkeypatch):
    engine = _engine(tmp_path, monkeypatch)
    out = tmp_path / "p.wav"
    sample_rate, duration_ms = engine.synthesize(
        "abc def.", "af_heart", 1.0, str(out), lambda f: True
    )
    assert sample_rate == 24000
    assert duration_ms > 0
    assert out.exists()


def test_a_long_page_runs_more_than_one_chunk(tmp_path, monkeypatch):
    engine = _engine(tmp_path, monkeypatch)
    long_text = "abcdefgh abcdefgh. " * 60
    engine.synthesize(long_text, "af_heart", 1.0, str(tmp_path / "p.wav"), lambda f: True)
    assert engine._session.calls > 1


def test_cancelling_between_chunks_stops_the_run(tmp_path, monkeypatch):
    engine = _engine(tmp_path, monkeypatch)
    long_text = "abcdefgh abcdefgh. " * 60
    engine.synthesize(
        long_text, "af_heart", 1.0, str(tmp_path / "p.wav"), lambda f: False
    )
    assert engine._session.calls == 1


def test_an_unknown_voice_is_rejected_by_name(tmp_path, monkeypatch):
    engine = _engine(tmp_path, monkeypatch)
    with pytest.raises(FileNotFoundError) as exc:
        engine.synthesize("abc.", "no_such_voice", 1.0, str(tmp_path / "p.wav"), lambda f: True)
    assert "no_such_voice" in str(exc.value)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sidecar && uv run pytest tests/test_engine_kokoro.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'engine_kokoro'`.

- [ ] **Step 3: Write the engine**

Create `sidecar/engine_kokoro.py`:

```python
"""Kokoro English TTS on onnxruntime, with espeak-ng for grapheme-to-phoneme.

Uses only what the onnx-community repo ships: model.onnx, voices/*.bin and
tokenizer.json. misaki is deliberately not used — it would pull spacy and torch
for an unmeasured quality difference.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from onnxruntime import InferenceSession

from guards import assert_espeak_data_path
from prepare import chunk_english
from tts import write_wav

SAMPLE_RATE = 24000


def list_voices(model_dir: str) -> list[str]:
    voices = Path(model_dir) / "voices"
    if not voices.is_dir():
        return []
    return sorted(p.stem for p in voices.glob("*.bin"))


def _make_phonemizer() -> "callable":
    import espeakng_loader
    from phonemizer.backend import EspeakBackend
    from phonemizer.backend.espeak.wrapper import EspeakWrapper

    data_path = espeakng_loader.get_data_path()
    # Past 159 characters espeak-ng ignores this path and kills the process
    # with no Python exception. Fail here, where the message is readable.
    assert_espeak_data_path(data_path)

    EspeakWrapper.set_library(espeakng_loader.get_library_path())
    EspeakWrapper.set_data_path(data_path)
    backend = EspeakBackend("en-us", preserve_punctuation=True, with_stress=True)
    return lambda text: backend.phonemize([text])[0].strip()


class KokoroEngine:
    def __init__(self, model_dir: str) -> None:
        self._dir = Path(model_dir)
        model = self._dir / "model.onnx"
        if not model.exists():
            raise FileNotFoundError(f"Kokoro model not found at {model}")
        self._vocab = json.loads((self._dir / "tokenizer.json").read_text())["model"]["vocab"]
        self._session = InferenceSession(str(model))
        self._phonemize = _make_phonemizer()

    def synthesize(self, text, voice, rate, out_path, on_progress):
        style_path = self._dir / "voices" / f"{voice}.bin"
        if not style_path.exists():
            raise FileNotFoundError(f"unknown Kokoro voice {voice!r}")
        # Indexed by token count: 510 rows of (1, 256).
        styles = np.fromfile(style_path, dtype=np.float32).reshape(-1, 1, 256)

        chunks = chunk_english(text, self._vocab, self._phonemize)
        if not chunks:
            raise RuntimeError("nothing left to speak after preparing the text")

        pieces = []
        for i, tokens in enumerate(chunks):
            out = self._session.run(
                None,
                {
                    "input_ids": np.array([[0, *tokens, 0]], dtype=np.int64),
                    "style": styles[len(tokens)],
                    "speed": np.array([rate], dtype=np.float32),
                },
            )[0]
            pieces.append(np.asarray(out, dtype=np.float32).squeeze())
            if not on_progress((i + 1) / len(chunks)):
                break

        samples = np.concatenate(pieces)
        duration_ms = write_wav(out_path, samples, SAMPLE_RATE)
        return SAMPLE_RATE, duration_ms
```

- [ ] **Step 4: Register it and expose the voice list**

In `sidecar/server.py`, register English beside the MMS languages in `main()`:

```python
    try:
        ENGINES_BY_LANGUAGE["en"] = KokoroEngine(models.model_dir("en"))
    except FileNotFoundError:
        log.info("Kokoro model not present yet")
```

and add a route so the panel can ask for real voices:

```python
@app.get("/voices/{language}")
def voices(language: str, _: None = Depends(_require_token)) -> dict:
    """Real voice names. Empty for the single-speaker MMS languages."""
    if language != "en":
        return {"voices": []}
    return {"voices": list_voices(models.model_dir("en"))}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sidecar && uv run pytest tests/ -v`
Expected: PASS — 5 new tests.

- [ ] **Step 6: Commit**

```bash
git add sidecar/engine_kokoro.py sidecar/tests/test_engine_kokoro.py sidecar/server.py
git commit -m "feat(sidecar): synthesize English with Kokoro on onnxruntime"
```

---

### Task 12: Model manifest, download and verification

**Files:**
- Create: `sidecar/models.py`
- Create: `sidecar/models.json`
- Create: `sidecar/tests/test_models.py`
- Modify: `sidecar/server.py`
- Modify: `src/lib/api.ts`
- Modify: `src-tauri/src/convert.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `models.model_dir(language: str) -> str`
  - `models.manifest() -> dict` — parsed `models.json`.
  - `models.files_for(language: str) -> list[dict]` — entries with `url`, `sha256`, `size`, `path`.
  - `models.verify(path: str, sha256: str) -> bool`
  - `models.status() -> dict[str, bool]` — language code to "all files present and verified".
  - `models.fetch(language, on_progress) -> None` — downloads to `<path>.part`, verifies, then renames.
  - Routes `GET /models/status` and `POST /models/fetch`.
  - Tauri command `list_voices_cmd(sidecar, language: String) -> Result<Vec<String>, String>`.

- [ ] **Step 1: Write the manifest**

Create `sidecar/models.json`. Sizes and hashes are the ones verified in the spike; only the fp32 Kokoro weights ship, because the quantized variants are slower on CPU and `model_q8f16.onnx` segfaults onnxruntime.

```json
{
  "version": 1,
  "languages": {
    "en": [
      {
        "url": "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx",
        "path": "en/model.onnx",
        "size": 325532232,
        "sha256": "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb"
      },
      {
        "url": "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/tokenizer.json",
        "path": "en/tokenizer.json",
        "size": 3497,
        "sha256": "FILL-IN-BEFORE-USE"
      }
    ],
    "am": [
      {
        "url": "https://huggingface.co/hadamard-2/mms-tts-amh-onnx/resolve/main/model.onnx",
        "path": "am/model.onnx",
        "size": 114029714,
        "sha256": "FILL-IN-BEFORE-USE"
      },
      {
        "url": "https://huggingface.co/hadamard-2/mms-tts-amh-onnx/resolve/main/tokens.txt",
        "path": "am/tokens.txt",
        "size": 246,
        "sha256": "FILL-IN-BEFORE-USE"
      }
    ],
    "ti": [
      {
        "url": "https://huggingface.co/hadamard-2/mms-tts-tir-onnx/resolve/main/model.onnx",
        "path": "ti/model.onnx",
        "size": 114028946,
        "sha256": "FILL-IN-BEFORE-USE"
      },
      {
        "url": "https://huggingface.co/hadamard-2/mms-tts-tir-onnx/resolve/main/tokens.txt",
        "path": "ti/tokens.txt",
        "size": 242,
        "sha256": "FILL-IN-BEFORE-USE"
      }
    ],
    "om": [
      {
        "url": "https://huggingface.co/hadamard-2/mms-tts-orm-onnx/resolve/main/model.onnx",
        "path": "om/model.onnx",
        "size": 114030482,
        "sha256": "FILL-IN-BEFORE-USE"
      },
      {
        "url": "https://huggingface.co/hadamard-2/mms-tts-orm-onnx/resolve/main/tokens.txt",
        "path": "om/tokens.txt",
        "size": 252,
        "sha256": "FILL-IN-BEFORE-USE"
      }
    ]
  },
  "voices": {
    "url_template": "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/{name}.bin",
    "path_template": "en/voices/{name}.bin",
    "size": 522240,
    "names": ["af_heart", "af_bella", "af_nicole", "am_michael", "am_adam", "bf_emma", "bm_george"]
  }
}
```

Every `FILL-IN-BEFORE-USE` must be replaced with the real SHA-256 before this task is considered done. Fetch each file once and hash it:

```bash
curl -sL "<url>" -o /tmp/f && sha256sum /tmp/f
```

The two Kokoro hashes already filled in were verified against HuggingFace's LFS oids during the spike.

- [ ] **Step 2: Write the failing tests**

Create `sidecar/tests/test_models.py`:

```python
import hashlib

import pytest

import models


def test_every_language_in_the_manifest_has_files():
    for lang in ("en", "am", "ti", "om"):
        entries = models.files_for(lang)
        assert entries, f"{lang} has no files"
        for e in entries:
            assert e["url"].startswith("https://")
            assert e["path"].startswith(f"{lang}/")
            assert e["size"] > 0


def test_the_manifest_carries_a_real_hash_for_every_file():
    for lang in ("en", "am", "ti", "om"):
        for e in models.files_for(lang):
            assert len(e["sha256"]) == 64, f"{e['path']} has no real hash"
            int(e["sha256"], 16)  # hex, or this raises


def test_the_manifest_ships_only_fp32_kokoro_weights():
    # The quantized variants are slower on CPU and q8f16 segfaults onnxruntime.
    paths = [e["path"] for e in models.files_for("en")]
    assert "en/model.onnx" in paths
    assert not any("quantized" in p or "q8f16" in p or "fp16" in p for p in paths)


def test_verify_accepts_a_matching_file(tmp_path):
    f = tmp_path / "x"
    f.write_bytes(b"hello")
    assert models.verify(str(f), hashlib.sha256(b"hello").hexdigest())


def test_verify_rejects_a_corrupt_file(tmp_path):
    f = tmp_path / "x"
    f.write_bytes(b"hello")
    assert not models.verify(str(f), "0" * 64)


def test_verify_rejects_a_missing_file(tmp_path):
    assert not models.verify(str(tmp_path / "nope"), "0" * 64)


def test_status_reports_a_language_absent_when_files_are_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(models, "MODELS_ROOT", tmp_path)
    assert models.status()["am"] is False
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd sidecar && uv run pytest tests/test_models.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'models'`.

- [ ] **Step 4: Write the model module**

Create `sidecar/models.py`:

```python
"""Model locations, the download manifest, and integrity checks.

This is the slice of M6 that M4 needs and no more. Deliberately NOT here:
HTTP range resumption, retry with backoff, surviving an app restart mid-download,
and gating project creation on model presence.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import urllib.request
from pathlib import Path
from typing import Callable

_HERE = Path(__file__).parent
MODELS_ROOT = Path(os.environ.get("HEARBOOK_MODELS_DIR", _HERE / "models"))

OnProgress = Callable[[str, float], None]


def manifest() -> dict:
    return json.loads((_HERE / "models.json").read_text())


def files_for(language: str) -> list[dict]:
    m = manifest()
    entries = list(m["languages"][language])
    if language == "en":
        v = m["voices"]
        for name in v["names"]:
            entries.append({
                "url": v["url_template"].format(name=name),
                "path": v["path_template"].format(name=name),
                "size": v["size"],
                "sha256": "",  # voices are small and fixed-size; size is the check
            })
    return entries


def model_dir(language: str) -> str:
    return str(MODELS_ROOT / language)


def verify(path: str, sha256: str) -> bool:
    p = Path(path)
    if not p.is_file():
        return False
    if not sha256:
        return p.stat().st_size > 0
    h = hashlib.sha256()
    with p.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest() == sha256


def status() -> dict[str, bool]:
    """Which languages are fully present and verified on disk."""
    out = {}
    for lang in manifest()["languages"]:
        out[lang] = all(
            verify(str(MODELS_ROOT / e["path"]), e["sha256"]) for e in files_for(lang)
        )
    return out


def fetch(language: str, on_progress: OnProgress) -> None:
    """Download a language's files, verifying each before it lands.

    Downloads to `<path>.part` and renames only after the hash matches, so a
    model directory is never left half-populated for the engine to load.
    """
    entries = files_for(language)
    total = sum(e["size"] for e in entries) or 1
    done = 0

    for entry in entries:
        target = MODELS_ROOT / entry["path"]
        if verify(str(target), entry["sha256"]):
            done += entry["size"]
            on_progress(entry["path"], done / total)
            continue

        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_suffix(target.suffix + ".part")
        with urllib.request.urlopen(entry["url"]) as response, part.open("wb") as out:
            while chunk := response.read(1024 * 256):
                out.write(chunk)
                done += len(chunk)
                on_progress(entry["path"], min(done / total, 1.0))

        if not verify(str(part), entry["sha256"]):
            part.unlink(missing_ok=True)
            raise RuntimeError(
                f"downloaded {entry['path']} failed its checksum; not installing it"
            )
        shutil.move(str(part), str(target))
```

- [ ] **Step 5: Add the routes and the voice command**

Model download has exactly the same shape as synthesis — a long blocking call that reports through a callback — so it reuses Task 5's job registry rather than a streaming response that would buffer every event until the download had already finished.

In `sidecar/server.py`:

```python
@app.get("/models/status")
def models_status(_: None = Depends(_require_token)) -> dict:
    return {"languages": models.status()}


class FetchRequest(BaseModel):
    language: str


def _fetch_work(req: FetchRequest):
    def work(job) -> None:
        def on_progress(path: str, fraction: float) -> None:
            job.progress = fraction

        models.fetch(req.language, on_progress)

    return work


@app.post("/jobs/fetch")
def start_fetch(req: FetchRequest, _: None = Depends(_require_token)) -> dict:
    """Start a model download. Poll GET /jobs/{id} exactly as for synthesis."""
    return {"jobId": JOBS.start(_fetch_work(req))}
```

Note there is no separate status or cancel route: `GET /jobs/{id}` and `DELETE /jobs/{id}` from Task 5 already serve any job. `models.fetch` does not yet check the cancel flag between files, so a download runs to completion; that is acceptable for M4 and is listed in the deferred set.

In `src-tauri/src/convert.rs`, add the voice-list command. It uses `sidecar::get_json`, which Task 6 already added:

```rust
#[tauri::command]
pub async fn list_voices_cmd(
    sidecar_state: State<'_, SidecarState>,
    language: String,
) -> Result<Vec<String>, String> {
    let value = sidecar::get_json(&sidecar_state, &format!("/voices/{language}")).await?;
    Ok(value["voices"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default())
}
```

Register `convert::list_voices_cmd` in `generate_handler!`, and add to `src/lib/api.ts`:

```ts
/** Real voices for a language. Empty for the single-speaker MMS languages. */
export const listVoices = (language: string) =>
  invoke<string[]>("list_voices_cmd", { language });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd sidecar && uv run pytest tests/ -v && cd ../src-tauri && cargo test && cd .. && bun run build`
Expected: PASS — 7 new Python tests, Rust green, TypeScript builds.

- [ ] **Step 7: Commit**

```bash
git add sidecar/models.py sidecar/models.json sidecar/tests/test_models.py \
        sidecar/server.py src-tauri/src/convert.rs src-tauri/src/sidecar.rs \
        src-tauri/src/lib.rs src/lib/api.ts
git commit -m "feat(models): fetch and verify TTS models from a pinned manifest

- pin every file by URL, size and SHA-256; verify before installing
- download to a .part file and rename only on a match, so a model dir is
  never half-populated
- ship only fp32 Kokoro weights; the quantized variants are slower on CPU
  and q8f16 segfaults onnxruntime"
```

---

### Task 13: Replace the placeholder voice list

**Files:**
- Delete: `src/lib/placeholder-voices.ts`
- Modify: `src/components/editor/editor.tsx`
- Modify: `src/components/editor/settings-panel.tsx`

**Interfaces:**
- Consumes: `listVoices` (Task 12).
- Produces: no placeholder voices anywhere in the tree.

- [ ] **Step 1: Find every reference**

Run: `grep -rn "PLACEHOLDER_VOICES\|placeholder-voices" src/`
Expected: hits in `editor.tsx` and `settings-panel.tsx` (the latter already removed in Task 7).

- [ ] **Step 2: Load real voices in the editor**

In `src/components/editor/editor.tsx`, replace the `PLACEHOLDER_VOICES` import and the `initialVoice` derivation with state loaded from the backend:

```tsx
  const [voices, setVoices] = useState<string[]>([]);
  const [voice, setVoice] = useState(project.voice ?? "");

  useEffect(() => {
    let cancelled = false;
    listVoices(language)
      .then((list) => {
        if (cancelled) return;
        setVoices(list);
        // Single-speaker languages have no voice to pick; a stale selection
        // from another language must not survive the switch.
        setVoice((current) => (list.includes(current) ? current : (list[0] ?? "")));
      })
      .catch(() => {
        if (!cancelled) setVoices([]);
      });
    return () => {
      cancelled = true;
    };
  }, [language]);
```

Persist the panel's position whenever it changes, so reopening the project restores it and M5's export can default to it:

```tsx
  useEffect(() => {
    if (!voice && !speed) return;
    updateProject(project.id, { voice: voice || undefined, rate: speed }).catch(() => {});
  }, [project.id, voice, speed]);
```

- [ ] **Step 3: Delete the placeholder module**

```bash
rm src/lib/placeholder-voices.ts
```

- [ ] **Step 4: Verify nothing references it**

Run: `grep -rn "PLACEHOLDER_VOICES\|placeholder-voices" src/ ; bun run test && bun run build`
Expected: no grep hits; tests and build pass.

- [ ] **Step 5: Commit**

```bash
git add -A src/
git commit -m "feat(editor): offer the real Kokoro voices instead of placeholders"
```

---

### Task 14: Freeze the sidecar with both runtimes

**Files:**
- Modify: `sidecar/hearbook_sidecar.spec`
- Modify: `sidecar/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a PyInstaller bundle that starts, answers `/health`, and synthesizes.

This is where the untested surface is. sherpa-onnx and onnxruntime each ship native libraries, espeak-ng's data has to be collected, and the frozen binary unpacks to a `_MEIxxxxxx` temp directory whose path can cross espeak's 159-character limit on its own.

- [ ] **Step 1: Collect the native data in the spec file**

In `sidecar/hearbook_sidecar.spec`, add to the `Analysis` call:

```python
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

datas = [
    *collect_data_files("espeakng_loader"),
    *collect_data_files("uroman"),
    ("models.json", "."),
]
binaries = [
    *collect_dynamic_libs("onnxruntime"),
    *collect_dynamic_libs("sherpa_onnx"),
    *collect_dynamic_libs("espeakng_loader"),
]
hiddenimports = ["sherpa_onnx", "onnxruntime", "num2words2", "uroman"]
```

- [ ] **Step 2: Build it**

Run: `cd sidecar && uv run pyinstaller hearbook_sidecar.spec --noconfirm`
Expected: a bundle under `sidecar/dist/hearbook-sidecar`.

- [ ] **Step 3: Verify the handshake still works**

Run:

```bash
cd sidecar && HEARBOOK_SIDECAR_TOKEN=probe ./dist/hearbook-sidecar/hearbook-sidecar
```

Expected: one JSON line on stdout of the shape `{"port": <n>, "token_ok": true, "ready": true}`. If the process exits silently with no line at all, suspect the espeak path guard — read the note in `guards.py` and check the length of the `_MEI` path.

- [ ] **Step 4: Verify synthesis from inside the bundle**

With the sidecar from Step 3 still running and its port in `$PORT`:

```bash
JOB=$(curl -s -X POST "http://127.0.0.1:$PORT/jobs/tts" \
  -H "Authorization: Bearer probe" -H "Content-Type: application/json" \
  -d '{"text":"The cell is the basic unit of life.","language":"en","voice":"af_heart","rate":1.0,"out_path":"/tmp/probe.wav"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["jobId"])')
until curl -s "http://127.0.0.1:$PORT/jobs/$JOB" -H "Authorization: Bearer probe" \
  | tee /dev/stderr | grep -q '"state": *"done"'; do sleep 1; done
```

Expected: the polled state moves through `running` with a rising `progress`, reaches `done`, and `/tmp/probe.wav` is playable.

- [ ] **Step 5: Record what the bundle needs**

Add a section to `sidecar/README.md` documenting the native dependencies the spec file collects, why each is needed, and the espeak path limit — specifically that a silent exit with no handshake line is the signature of that failure rather than a crash.

- [ ] **Step 6: Commit**

```bash
git add sidecar/hearbook_sidecar.spec sidecar/README.md
git commit -m "build(sidecar): freeze the TTS engines and their native data"
```

---

### Task 15: Manual verification

**Files:** none — this task changes nothing.

- [ ] **Step 1: Run the app**

Run: `bun run tauri dev`

- [ ] **Step 2: Walk the English path**

Import an English PDF. Open a page with real text. Confirm the voice dropdown lists real Kokoro voices, press Convert, and confirm progress advances rather than sitting at zero. When it finishes, press play and listen. **Listen specifically for audible seams** where the chunks were joined — a page splits into roughly four, and nobody has listened to a full page yet.

- [ ] **Step 3: Walk a Ge'ez path**

Create an Amharic or Tigrigna project. Confirm the Voice field is hidden — these models are single-speaker. Convert a page containing numbers and confirm the numbers are spoken, including Ge'ez numerals if the page has any.

- [ ] **Step 4: Check staleness**

With fresh audio on a page, edit the text. Confirm the "out of date" badge appears, the old audio still plays, and re-converting clears the badge. Then change the rate and confirm the badge returns.

- [ ] **Step 5: Check cancellation and persistence**

Start a conversion on a long page and cancel it partway; confirm it stops promptly rather than running to completion. Then convert a page fully, quit the app, reopen the project, and confirm the audio still plays and the panel's voice and rate came back.

- [ ] **Step 6: Check the offline promise**

Disconnect from the network entirely. Convert a page in each language whose models are already downloaded. Everything must work.

- [ ] **Step 7: Record what you found**

Append a short "Manual verification" section to the design spec recording what was tested, on what machine, and anything that behaved differently from the plan — especially the chunk seams and any real timing figures, which can be compared against the spike's 41.6 s and 99.1 s.

---

## Self-review notes

**Spec coverage.** Two-stage preview → Tasks 5–7. One page at a time, editor held → Task 7. Staleness → Tasks 2, 6, 7. Single take per page → Task 2. Settings-keyed cache for M5 reuse → Task 2 stores the key; M5 consumes it. Voice/rate as panel state → Tasks 3, 13. Text preparation → Tasks 8, 9. Both engines → Tasks 10, 11. Model acquisition → Task 12. Guards → Task 4. Frozen bundle → Task 14. Acceptance criteria → Task 15.

**Deliberately not covered, and why.** The spec's three open questions are unresolved by design: whether the waveform becomes real (Task 7 leaves it decorative), what Convert does on an empty page (Task 7 answers it with the `noText` state, extending the `page-placeholder.ts` truth table rather than guessing), and where conversion errors surface — the commands return `Result<_, String>` and the panel needs an error affordance that no task builds. **Raise that with the user before Task 7 ships.**

**Transport: jobs, not streaming (revised 2026-09-20).** An earlier draft of Tasks 5 and 6 used an SSE streaming response. That was wrong in both halves: the sidecar route collected progress into a list and yielded it only after `engine.synthesize()` returned, because a generator cannot yield from inside a blocking callback — so progress would have jumped from zero to done and there was nothing to interrupt. Rust compounded it by reading the whole body with `response.text()`.

Both are now a job: `POST /jobs/tts` starts work on a thread and returns an id, `GET /jobs/{id}` reports progress while it runs, `DELETE /jobs/{id}` sets the cancel flag the engines' `on_progress` already polls. Task 12's model download reuses the same registry for the same reason. Two consequences worth noting — `reqwest` needs **no** `stream` feature, and M5's multi-hour export over a page range now has a transport that outlives a single HTTP request rather than one it must replace.

**Deferred inside the job model.** `models.fetch` does not check the cancel flag between files, so a model download cannot be interrupted once started. Synthesis can. This is a gap in Task 12, not in the transport.
