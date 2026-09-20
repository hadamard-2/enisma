//! Cached page audio: what was made, from what, and whether it still matches.

use std::time::{SystemTime, UNIX_EPOCH};

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
    /// The language the take was synthesized with. Language selects the
    /// engine, so a take made under another one is a different recording.
    pub language: Option<String>,
    pub rate: Option<f64>,
    pub sample_rate: Option<i64>,
    pub duration_ms: Option<i64>,
    /// When this take was recorded, epoch milliseconds. Distinguishes one
    /// take from its replacement even when every other field is identical.
    pub created_at: Option<i64>,
}

/// Now, in epoch milliseconds. Saturates rather than panicking on a clock
/// before 1970, which would only make two takes share a stamp.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Whether a take still represents the given text and settings.
///
/// Stale audio is not deleted and stays playable — the user listens to the old
/// take while deciding whether to re-convert. Only this comparison decides;
/// the audio itself is never re-derived, because MMS synthesis is stochastic
/// and two runs of identical input differ.
pub fn is_fresh(
    a: &PageAudio,
    current_text: &str,
    language: &str,
    voice: &str,
    rate: f64,
) -> bool {
    let (Some(path), Some(hash), Some(lang), Some(v), Some(r)) =
        (&a.path, &a.text_hash, &a.language, &a.voice, a.rate)
    else {
        return false;
    };
    !path.is_empty()
        && *hash == text_hash(current_text)
        && lang == language
        && v == voice
        && (r - rate).abs() < f64::EPSILON
}

pub fn get_page_audio(
    conn: &Connection,
    project_id: &str,
    page_no: i64,
) -> rusqlite::Result<PageAudio> {
    conn.query_row(
        "SELECT audio_path, audio_text_hash, audio_voice, audio_language,
                audio_rate, audio_sample_rate, audio_duration_ms,
                audio_created_at
         FROM pages WHERE project_id = ?1 AND page_no = ?2",
        params![project_id, page_no],
        |r| {
            Ok(PageAudio {
                path: r.get(0)?,
                text_hash: r.get(1)?,
                voice: r.get(2)?,
                language: r.get(3)?,
                rate: r.get(4)?,
                sample_rate: r.get(5)?,
                duration_ms: r.get(6)?,
                created_at: r.get(7)?,
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
    language: &str,
    voice: &str,
    rate: f64,
    sample_rate: i64,
    duration_ms: i64,
) -> rusqlite::Result<()> {
    let affected = conn.execute(
        "UPDATE pages
            SET audio_path = ?3, audio_text_hash = ?4, audio_voice = ?5,
                audio_language = ?6, audio_rate = ?7, audio_sample_rate = ?8,
                audio_duration_ms = ?9, audio_created_at = ?10
          WHERE project_id = ?1 AND page_no = ?2",
        params![
            project_id,
            page_no,
            path,
            text_hash,
            voice,
            language,
            rate,
            sample_rate,
            duration_ms,
            now_ms()
        ],
    )?;
    if affected == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}

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
        assert!(!is_fresh(&a, "one", "en", "af_heart", 1.0));
    }

    #[test]
    fn audio_is_fresh_when_text_voice_and_rate_all_match() {
        let mut conn = db::open_in_memory().unwrap();
        let id = seed(&mut conn);
        set_page_audio(
            &conn, &id, 1, "projects/p1/audio/page-1.wav",
            &text_hash("one"), "en", "af_heart", 1.0, 24000, 5500,
        )
        .unwrap();
        let a = get_page_audio(&conn, &id, 1).unwrap();
        assert!(is_fresh(&a, "one", "en", "af_heart", 1.0));
        assert_eq!(a.duration_ms, Some(5500));
        assert_eq!(a.sample_rate, Some(24000));
    }

    #[test]
    fn editing_the_text_makes_it_stale() {
        let mut conn = db::open_in_memory().unwrap();
        let id = seed(&mut conn);
        set_page_audio(
            &conn, &id, 1, "projects/p1/audio/page-1.wav",
            &text_hash("one"), "en", "af_heart", 1.0, 24000, 5500,
        )
        .unwrap();
        let a = get_page_audio(&conn, &id, 1).unwrap();
        assert!(!is_fresh(&a, "one edited", "en", "af_heart", 1.0));
    }

    #[test]
    fn changing_the_language_makes_it_stale_even_when_the_voice_is_empty() {
        // The am -> ti trap: neither Ge'ez language offers a voice, so both
        // takes carry voice "". Only the language tells them apart, and
        // without it an Amharic recording would pass as Tigrigna audio with
        // no stale badge and a Convert button disabled for being fresh.
        let mut conn = db::open_in_memory().unwrap();
        let id = seed(&mut conn);
        set_page_audio(
            &conn, &id, 1, "projects/p1/audio/page-1.wav",
            &text_hash("one"), "am", "", 1.0, 16000, 5500,
        )
        .unwrap();
        let a = get_page_audio(&conn, &id, 1).unwrap();
        assert!(is_fresh(&a, "one", "am", "", 1.0));
        assert!(!is_fresh(&a, "one", "ti", "", 1.0));
    }

    #[test]
    fn a_take_records_when_it_was_made_and_a_rewrite_moves_it_forward() {
        let mut conn = db::open_in_memory().unwrap();
        let id = seed(&mut conn);
        set_page_audio(
            &conn, &id, 1, "projects/p1/audio/page-1.wav",
            &text_hash("one"), "en", "af_heart", 1.0, 24000, 5500,
        )
        .unwrap();
        let first = get_page_audio(&conn, &id, 1).unwrap().created_at.unwrap();
        assert!(first > 0);
        std::thread::sleep(std::time::Duration::from_millis(5));
        // Same text, same settings, same duration: only the stamp separates
        // this take from the one it replaced.
        set_page_audio(
            &conn, &id, 1, "projects/p1/audio/page-1.wav",
            &text_hash("one"), "en", "af_heart", 1.0, 24000, 5500,
        )
        .unwrap();
        let second = get_page_audio(&conn, &id, 1).unwrap().created_at.unwrap();
        assert!(second > first, "{second} should be later than {first}");
    }

    #[test]
    fn changing_voice_or_rate_makes_it_stale() {
        let mut conn = db::open_in_memory().unwrap();
        let id = seed(&mut conn);
        set_page_audio(
            &conn, &id, 1, "projects/p1/audio/page-1.wav",
            &text_hash("one"), "en", "af_heart", 1.0, 24000, 5500,
        )
        .unwrap();
        let a = get_page_audio(&conn, &id, 1).unwrap();
        assert!(!is_fresh(&a, "one", "en", "am_michael", 1.0));
        assert!(!is_fresh(&a, "one", "en", "af_heart", 1.5));
    }

    #[test]
    fn a_rewrite_replaces_the_previous_take() {
        let mut conn = db::open_in_memory().unwrap();
        let id = seed(&mut conn);
        set_page_audio(
            &conn, &id, 1, "projects/p1/audio/page-1.wav",
            &text_hash("one"), "en", "af_heart", 1.0, 24000, 5500,
        )
        .unwrap();
        set_page_audio(
            &conn, &id, 1, "projects/p1/audio/page-1.wav",
            &text_hash("one edited"), "en", "am_michael", 1.5, 24000, 6000,
        )
        .unwrap();
        let a = get_page_audio(&conn, &id, 1).unwrap();
        assert_eq!(a.voice.as_deref(), Some("am_michael"));
        assert_eq!(a.rate, Some(1.5));
        assert!(is_fresh(&a, "one edited", "en", "am_michael", 1.5));
    }

    #[test]
    fn writing_audio_for_a_page_that_does_not_exist_is_rejected() {
        let mut conn = db::open_in_memory().unwrap();
        let id = seed(&mut conn);
        let err = set_page_audio(
            &conn, &id, 99, "projects/p1/audio/page-99.wav",
            &text_hash("nope"), "en", "af_heart", 1.0, 24000, 1,
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
