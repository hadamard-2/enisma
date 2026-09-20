//! Driving a page conversion: effective text, the job, and the stored take.

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
        // The slot is claimed before the sidecar has issued a job id, so a
        // cancel landing in that gap has nothing to name yet.
        .filter(|j| !j.job_id.is_empty())
        .map(|j| j.job_id.clone())
}

/// What the user is told when a conversion is already running.
pub const BUSY_MESSAGE: &str =
    "another page is already being converted. Wait for it to finish, or cancel it first.";

/// Exclusive hold on the single conversion slot, released on every exit path.
///
/// Releasing is `Drop`, not a statement at the end of the happy path: an early
/// `?` on a failed job must not leave the slot occupied, or the app would
/// refuse every later conversion until it is restarted.
#[derive(Debug)]
pub struct ConversionClaim<'a>(&'a Mutex<Option<ActiveJob>>);

impl ConversionClaim<'_> {
    /// Record the job id the sidecar issued, so a cancel can name it.
    pub fn set_job_id(&self, job_id: &str) {
        if let Some(job) = self.0.lock().unwrap().as_mut() {
            job.job_id = job_id.to_string();
        }
    }
}

impl Drop for ConversionClaim<'_> {
    fn drop(&mut self) {
        *self.0.lock().unwrap() = None;
    }
}

/// Take the conversion slot for this page, or refuse.
///
/// The check and the claim share one lock acquisition: testing the slot and
/// then claiming it separately would reintroduce the very race this closes.
/// Conversion is one page at a time by design, so a second start is an invalid
/// state to refuse rather than a queue to build.
pub fn claim<'a>(
    slot: &'a Mutex<Option<ActiveJob>>,
    project_id: &str,
    page_no: i64,
) -> Result<ConversionClaim<'a>, String> {
    let mut guard = slot.lock().unwrap();
    if guard.is_some() {
        return Err(BUSY_MESSAGE.to_string());
    }
    *guard = Some(ActiveJob {
        project_id: project_id.to_string(),
        page_no,
        job_id: String::new(),
    });
    drop(guard);
    Ok(ConversionClaim(slot))
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
pub fn effective_text(conn: &Connection, project_id: &str, page_no: i64) -> Result<String, String> {
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
        // Resolved against the data dir exactly as `get_project_cmd` resolves
        // `pdf_path`, so both land inside the one asset-protocol grant.
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
#[allow(clippy::too_many_arguments)]
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
    // Claimed before any work, so a second conversion is refused rather than
    // silently overwriting the slot and stranding the first job's Cancel.
    let _claim = claim(&active.0, &project_id, page_no)?;

    let (text, language) = {
        let conn = db.0.lock().unwrap();
        let text = effective_text(&conn, &project_id, page_no)?;
        let detail = crate::project::get_project(&conn, &project_id).map_err(|e| e.to_string())?;
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

    _claim.set_job_id(&job_id);

    // `_claim` releases the slot when this function returns, however it returns.
    let (sample_rate, duration_ms) =
        poll_job(&app, &sidecar_state, &job_id, &project_id, page_no).await?;

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
///
/// `state` is the only verdict. A cancelled job still carries a populated
/// `sampleRate` and a non-zero `durationMs` over a truncated WAV, so deciding
/// success by the presence of those fields would store a clipped take as if it
/// were a finished one.
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

/// Ask the sidecar to stop the conversion of this page.
///
/// This *requests* a stop; it does not report one. An engine only checks the
/// cancel flag between units of work, so the job keeps running — and keeps
/// reporting `running` — for up to a minute after the sidecar answers 200. The
/// authoritative "it has actually stopped" is `convert_page_cmd` rejecting with
/// "conversion cancelled"; until then the caller is in a cancelling state and
/// progress events keep arriving, which is the truth about the file being
/// written.
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
    let Some(job_id) = job_id else {
        return Ok(());
    };
    match sidecar::delete_json(&sidecar_state, &format!("/jobs/{job_id}")).await {
        Ok(_) => Ok(()),
        // The job finished and was pruned in the same gap. Same nothing-to-stop.
        Err(e) if sidecar::is_not_found(&e) => Ok(()),
        Err(e) => Err(e),
    }
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

    #[test]
    fn a_cancel_before_the_sidecar_issues_a_job_id_matches_nothing() {
        let slot = Mutex::new(None);
        let _claim = claim(&slot, "p1", 3).unwrap();
        assert!(job_for(&slot.lock().unwrap(), "p1", 3).is_none());
    }

    #[test]
    fn a_claim_names_the_job_once_the_sidecar_issues_an_id() {
        let slot = Mutex::new(None);
        let claimed = claim(&slot, "p1", 3).unwrap();
        claimed.set_job_id("job-abc");
        assert_eq!(
            job_for(&slot.lock().unwrap(), "p1", 3).as_deref(),
            Some("job-abc")
        );
    }

    #[test]
    fn a_second_conversion_is_refused_while_one_is_running() {
        let slot = Mutex::new(None);
        let _first = claim(&slot, "p1", 3).unwrap();
        // A different page is refused too: the slot holds one conversion, not
        // one per page.
        assert_eq!(claim(&slot, "p1", 4).unwrap_err(), BUSY_MESSAGE);
        assert_eq!(claim(&slot, "p2", 3).unwrap_err(), BUSY_MESSAGE);
    }

    #[test]
    fn the_slot_is_released_when_a_conversion_ends() {
        let slot = Mutex::new(None);
        {
            let _first = claim(&slot, "p1", 3).unwrap();
        }
        // Released, so the next page may convert. This is what proves a
        // completed conversion does not wedge the app into permanent refusal.
        let _second = claim(&slot, "p1", 4).expect("slot free after the first ended");
    }

    #[test]
    fn the_slot_is_released_even_when_the_conversion_fails() {
        fn failing(slot: &Mutex<Option<ActiveJob>>) -> Result<(), String> {
            let _claim = claim(slot, "p1", 3)?;
            // Stands in for a job that errors mid-poll: an early `?` return.
            Err("synthesis failed".to_string())
        }

        let slot = Mutex::new(None);
        assert_eq!(failing(&slot).unwrap_err(), "synthesis failed");
        assert!(slot.lock().unwrap().is_none());
        claim(&slot, "p1", 3).expect("slot free after a failure");
    }
}
