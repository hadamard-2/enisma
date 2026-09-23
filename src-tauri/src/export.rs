//! Export's decisions: what a page range needs, what to do next, and whether
//! what is left can be stitched. Pure over a connection, so the whole policy
//! is testable without a sidecar. Running it lives in `export_run`.

// Used by export_run (Task 6); remove this line there.
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::audio;

/// Why a page needs synthesizing. Only `OtherSettings` is worth a warning:
/// it replaces a take the user may have been previewing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NeedReason {
    /// No take at all.
    Missing,
    /// A take made with another language, voice or rate.
    OtherSettings,
    /// A take made with these settings from text that has since changed.
    Edited,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageState {
    /// Nothing to say. Skipped, and listed in the summary.
    Empty,
    /// The take already matches. Reused.
    Fresh,
    Needs(NeedReason),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Classified {
    pub page_no: i64,
    pub state: PageState,
    /// Hash of the text that would be spoken now; None for an empty page.
    pub text_hash: Option<String>,
}

/// A page that failed, and the text it failed on. The same text would only
/// fail again, so it is not retried until the text changes.
#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub text_hash: String,
    pub message: String,
}

pub type Failures = HashMap<i64, Failure>;

/// Judge every page in `first..=last` against an export's voice and rate.
///
/// Mirrors `convert::effective_text`'s precedence (the edit, else the
/// extraction) and uses `audio::is_fresh` itself, so export and the panel can
/// never disagree about whether a take is current.
pub fn classify(
    conn: &Connection,
    project_id: &str,
    voice: &str,
    rate: f64,
    first: i64,
    last: i64,
) -> rusqlite::Result<Vec<Classified>> {
    let language: String = conn.query_row(
        "SELECT language FROM projects WHERE id = ?1",
        [project_id],
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare(
        "SELECT page_no, edited_text, source_text,
                audio_path, audio_text_hash, audio_voice, audio_language,
                audio_rate, audio_sample_rate, audio_duration_ms, audio_created_at
           FROM pages
          WHERE project_id = ?1 AND page_no BETWEEN ?2 AND ?3
          ORDER BY page_no",
    )?;
    let rows = stmt.query_map(params![project_id, first, last], |r| {
        let edited: Option<String> = r.get(1)?;
        let source: Option<String> = r.get(2)?;
        Ok((
            r.get::<_, i64>(0)?,
            edited.or(source).unwrap_or_default(),
            audio::PageAudio {
                path: r.get(3)?,
                text_hash: r.get(4)?,
                voice: r.get(5)?,
                language: r.get(6)?,
                rate: r.get(7)?,
                sample_rate: r.get(8)?,
                duration_ms: r.get(9)?,
                created_at: r.get(10)?,
            },
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (page_no, text, take) = row?;
        out.push(judge(page_no, &text, &take, &language, voice, rate));
    }
    Ok(out)
}

fn judge(
    page_no: i64,
    text: &str,
    take: &audio::PageAudio,
    language: &str,
    voice: &str,
    rate: f64,
) -> Classified {
    if text.trim().is_empty() {
        return Classified { page_no, state: PageState::Empty, text_hash: None };
    }
    let state = if audio::is_fresh(take, text, language, voice, rate) {
        PageState::Fresh
    } else if take.path.as_deref().unwrap_or("").is_empty() {
        PageState::Needs(NeedReason::Missing)
    } else if take.language.as_deref() != Some(language)
        || take.voice.as_deref() != Some(voice)
        || take.rate.is_none_or(|r| (r - rate).abs() >= f64::EPSILON)
    {
        PageState::Needs(NeedReason::OtherSettings)
    } else {
        PageState::Needs(NeedReason::Edited)
    };
    Classified { page_no, state, text_hash: Some(audio::text_hash(text)) }
}

fn failed_on_this_text(c: &Classified, failed: &Failures) -> bool {
    failed.get(&c.page_no).map(|f| &f.text_hash) == c.text_hash.as_ref()
}

/// Pages to synthesize next: everything that needs it, except pages that
/// already failed on exactly the text they have now.
pub fn next_work(states: &[Classified], failed: &Failures) -> Vec<i64> {
    states
        .iter()
        .filter(|c| matches!(c.state, PageState::Needs(_)))
        .filter(|c| !failed_on_this_text(c, failed))
        .map(|c| c.page_no)
        .collect()
}

/// Pages that still need synthesis and last failed on the text they have now.
/// Any of these means the run ends without stitching.
pub fn outstanding_failures(states: &[Classified], failed: &Failures) -> Vec<i64> {
    states
        .iter()
        .filter(|c| matches!(c.state, PageState::Needs(_)))
        .filter(|c| failed_on_this_text(c, failed))
        .map(|c| c.page_no)
        .collect()
}

pub fn empty_pages(states: &[Classified]) -> Vec<i64> {
    states
        .iter()
        .filter(|c| c.state == PageState::Empty)
        .map(|c| c.page_no)
        .collect()
}

/// What the Export dialog shows before anything starts.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    pub total: usize,
    pub ready: usize,
    pub to_synthesize: usize,
    /// Of `to_synthesize`, how many replace a take in another voice or rate.
    pub replacing: usize,
    pub empty: Vec<i64>,
}

pub fn plan(states: &[Classified]) -> ExportPlan {
    let count = |f: fn(&PageState) -> bool| states.iter().filter(|c| f(&c.state)).count();
    ExportPlan {
        total: states.len(),
        ready: count(|s| *s == PageState::Fresh),
        to_synthesize: count(|s| matches!(s, PageState::Needs(_))),
        replacing: count(|s| *s == PageState::Needs(NeedReason::OtherSettings)),
        empty: empty_pages(states),
    }
}

pub fn validate_range(first: i64, last: i64, page_count: i64) -> Result<(), String> {
    if first < 1 || last > page_count || first > last {
        return Err(format!(
            "pages {first}–{last} are not a range within this book's {page_count} pages"
        ));
    }
    Ok(())
}

/// The WAVs to stitch, in page order, resolved against the data dir.
///
/// Every non-empty page must be fresh by now. Checking the sample rate the
/// rows record is the first of two checks; the sidecar re-reads the headers.
pub fn stitch_inputs(
    conn: &Connection,
    project_id: &str,
    states: &[Classified],
    data_dir: &Path,
) -> Result<Vec<PathBuf>, String> {
    let mut wavs = Vec::new();
    let mut first_rate: Option<(i64, i64)> = None;
    for c in states {
        match c.state {
            PageState::Empty => continue,
            PageState::Needs(_) => {
                return Err(format!("page {} has no current audio to stitch", c.page_no))
            }
            PageState::Fresh => {}
        }
        let take = audio::get_page_audio(conn, project_id, c.page_no).map_err(|e| e.to_string())?;
        let rate = take.sample_rate.unwrap_or(0);
        match first_rate {
            None => first_rate = Some((c.page_no, rate)),
            Some((page, r)) if r != rate => {
                return Err(format!(
                    "page {}'s audio is {rate} Hz, but page {page}'s is {r} Hz",
                    c.page_no
                ))
            }
            Some(_) => {}
        }
        wavs.push(data_dir.join(take.path.unwrap_or_default()));
    }
    if wavs.is_empty() {
        return Err("there is nothing to export: every page in this range is empty".into());
    }
    Ok(wavs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{audio, db, project};

    /// Three pages of text and one empty page, no takes.
    fn seed(conn: &mut Connection) {
        project::create_project_with_id(
            conn, "p1", "Biology", "en", "projects/p1/source.pdf", 4,
            &["one".into(), "two".into(), "".into(), "four".into()],
        )
        .unwrap();
    }

    fn take(conn: &Connection, page: i64, text: &str, voice: &str, rate: f64, sample_rate: i64) {
        audio::set_page_audio(
            conn, "p1", page, &format!("projects/p1/audio/page-{page}.wav"),
            &audio::text_hash(text), "en", voice, rate, sample_rate, 1000,
        )
        .unwrap();
    }

    fn states_of(conn: &Connection) -> Vec<(i64, PageState)> {
        classify(conn, "p1", "af_heart", 1.0, 1, 4)
            .unwrap()
            .into_iter()
            .map(|c| (c.page_no, c.state))
            .collect()
    }

    #[test]
    fn classify_sorts_every_page_into_its_state() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn);
        take(&conn, 1, "one", "af_heart", 1.0, 24000); // fresh
        take(&conn, 2, "two", "am_adam", 1.0, 24000); // another voice
        take(&conn, 4, "four", "af_heart", 1.0, 24000);
        project::save_page_text(&conn, "p1", 4, "four, corrected").unwrap(); // edited since

        assert_eq!(
            states_of(&conn),
            vec![
                (1, PageState::Fresh),
                (2, PageState::Needs(NeedReason::OtherSettings)),
                (3, PageState::Empty),
                (4, PageState::Needs(NeedReason::Edited)),
            ]
        );
    }

    #[test]
    fn a_page_with_no_take_is_missing_and_another_rate_is_other_settings() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn);
        take(&conn, 2, "two", "af_heart", 1.5, 24000);
        let s = states_of(&conn);
        assert_eq!(s[0], (1, PageState::Needs(NeedReason::Missing)));
        assert_eq!(s[1], (2, PageState::Needs(NeedReason::OtherSettings)));
    }

    #[test]
    fn a_page_emptied_by_an_edit_is_empty_even_with_an_old_take() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn);
        take(&conn, 1, "one", "af_heart", 1.0, 24000);
        project::save_page_text(&conn, "p1", 1, "   ").unwrap();
        assert_eq!(states_of(&conn)[0], (1, PageState::Empty));
    }

    #[test]
    fn classify_only_looks_inside_the_range() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn);
        let pages: Vec<i64> = classify(&conn, "p1", "af_heart", 1.0, 2, 3)
            .unwrap()
            .iter()
            .map(|c| c.page_no)
            .collect();
        assert_eq!(pages, vec![2, 3]);
    }

    fn needs(page: i64, text: &str) -> Classified {
        Classified { page_no: page, state: PageState::Needs(NeedReason::Missing), text_hash: Some(audio::text_hash(text)) }
    }

    fn failed(page: i64, text: &str) -> (i64, Failure) {
        (page, Failure { text_hash: audio::text_hash(text), message: "bad".into() })
    }

    #[test]
    fn next_work_skips_a_failed_page_until_its_text_changes() {
        let states = vec![needs(1, "one"), needs(2, "two")];
        let failures: Failures = [failed(2, "two")].into_iter().collect();
        assert_eq!(next_work(&states, &failures), vec![1]);

        let edited = vec![needs(1, "one"), needs(2, "two, fixed")];
        assert_eq!(next_work(&edited, &failures), vec![1, 2]);
    }

    #[test]
    fn next_work_ignores_fresh_and_empty_pages() {
        let states = vec![
            Classified { page_no: 1, state: PageState::Fresh, text_hash: Some(audio::text_hash("a")) },
            Classified { page_no: 2, state: PageState::Empty, text_hash: None },
        ];
        assert!(next_work(&states, &Failures::new()).is_empty());
    }

    #[test]
    fn outstanding_failures_are_pages_that_still_need_the_text_that_failed() {
        let failures: Failures = [failed(1, "one"), failed(2, "two")].into_iter().collect();
        let states = vec![
            needs(1, "one"),       // still the failing text
            needs(2, "two, fixed"), // edited: not outstanding, it is work
            Classified { page_no: 3, state: PageState::Empty, text_hash: None },
        ];
        assert_eq!(outstanding_failures(&states, &failures), vec![1]);
    }

    #[test]
    fn plan_counts_what_the_dialog_shows() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn);
        take(&conn, 1, "one", "af_heart", 1.0, 24000);
        take(&conn, 2, "two", "am_adam", 1.0, 24000);
        let p = plan(&classify(&conn, "p1", "af_heart", 1.0, 1, 4).unwrap());
        assert_eq!(p, ExportPlan { total: 4, ready: 1, to_synthesize: 2, replacing: 1, empty: vec![3] });
    }

    #[test]
    fn validate_range_accepts_the_book_and_rejects_the_rest() {
        assert!(validate_range(1, 4, 4).is_ok());
        assert!(validate_range(2, 2, 4).is_ok());
        assert!(validate_range(0, 4, 4).is_err());
        assert!(validate_range(1, 5, 4).is_err());
        assert!(validate_range(3, 2, 4).is_err());
    }

    #[test]
    fn stitch_inputs_are_the_fresh_takes_in_order_skipping_empty_pages() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn);
        for (page, text) in [(1, "one"), (2, "two"), (4, "four")] {
            take(&conn, page, text, "af_heart", 1.0, 24000);
        }
        let states = classify(&conn, "p1", "af_heart", 1.0, 1, 4).unwrap();
        let wavs = stitch_inputs(&conn, "p1", &states, Path::new("/data")).unwrap();
        assert_eq!(
            wavs,
            vec![
                PathBuf::from("/data/projects/p1/audio/page-1.wav"),
                PathBuf::from("/data/projects/p1/audio/page-2.wav"),
                PathBuf::from("/data/projects/p1/audio/page-4.wav"),
            ]
        );
    }

    #[test]
    fn stitch_inputs_refuse_a_mixed_sample_rate() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn);
        take(&conn, 1, "one", "af_heart", 1.0, 24000);
        take(&conn, 2, "two", "af_heart", 1.0, 16000);
        take(&conn, 4, "four", "af_heart", 1.0, 24000);
        let states = classify(&conn, "p1", "af_heart", 1.0, 1, 4).unwrap();
        let err = stitch_inputs(&conn, "p1", &states, Path::new("/data")).unwrap_err();
        assert_eq!(err, "page 2's audio is 16000 Hz, but page 1's is 24000 Hz");
    }

    #[test]
    fn stitch_inputs_refuse_a_page_that_is_not_ready() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn);
        take(&conn, 1, "one", "af_heart", 1.0, 24000);
        let states = classify(&conn, "p1", "af_heart", 1.0, 1, 4).unwrap();
        let err = stitch_inputs(&conn, "p1", &states, Path::new("/data")).unwrap_err();
        assert_eq!(err, "page 2 has no current audio to stitch");
    }

    #[test]
    fn stitch_inputs_refuse_a_range_with_nothing_to_say() {
        let mut conn = db::open_in_memory().unwrap();
        seed(&mut conn);
        let states = classify(&conn, "p1", "af_heart", 1.0, 3, 3).unwrap();
        let err = stitch_inputs(&conn, "p1", &states, Path::new("/data")).unwrap_err();
        assert_eq!(err, "there is nothing to export: every page in this range is empty");
    }
}
