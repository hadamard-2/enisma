//! Driving a page conversion: effective text, the job, and the stored take.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
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

/// What holds the conversion slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Holder {
    /// One page, converted from the panel.
    Page,
    /// An export, for its whole run; `page_no` follows the page it is on.
    Export,
}

#[derive(Debug, Clone)]
pub struct ActiveJob {
    pub holder: Holder,
    pub project_id: String,
    pub page_no: i64,
    pub job_id: String,
}

/// The one conversion that may be running. One at a time by design, so a
/// single slot is the whole bookkeeping. `Arc` so an export's background task
/// can own its claim for the hours it runs.
#[derive(Default)]
pub struct ActiveConversion(pub Arc<Mutex<Option<ActiveJob>>>);

/// The job id to cancel for a given page, if that page is the one running.
///
/// The page check is load-bearing: a Cancel aimed at a page the user has since
/// navigated away from must not stop the conversion that is actually running.
/// Nor may a page's Cancel stop an export that happens to be on that page.
pub fn job_for(active: &Option<ActiveJob>, project_id: &str, page_no: i64) -> Option<String> {
    active
        .as_ref()
        .filter(|j| j.holder == Holder::Page)
        .filter(|j| j.project_id == project_id && j.page_no == page_no)
        // The slot is claimed before the sidecar has issued a job id, so a
        // cancel landing in that gap has nothing to name yet.
        .filter(|j| !j.job_id.is_empty())
        .map(|j| j.job_id.clone())
}

/// The sidecar job an export is waiting on right now, if one is.
// The export task (Task 6) is the first non-test caller.
#[allow(dead_code)]
pub fn export_job(active: &Option<ActiveJob>) -> Option<String> {
    active
        .as_ref()
        .filter(|j| j.holder == Holder::Export && !j.job_id.is_empty())
        .map(|j| j.job_id.clone())
}

/// The project being exported, if any.
pub fn exporting_project(active: &Option<ActiveJob>) -> Option<String> {
    active
        .as_ref()
        .filter(|j| j.holder == Holder::Export)
        .map(|j| j.project_id.clone())
}

/// What the user is told when a conversion is already running.
pub const BUSY_MESSAGE: &str =
    "another page is already being converted. Wait for it to finish, or cancel it first.";

/// What the user is told when an export holds the slot.
pub const EXPORT_BUSY_MESSAGE: &str =
    "an export is running. Wait for it to finish, or cancel it first.";

/// Exclusive hold on the single conversion slot, released on every exit path.
///
/// Releasing is `Drop`, not a statement at the end of the happy path: an early
/// `?` on a failed job must not leave the slot occupied, or the app would
/// refuse every later conversion until it is restarted.
#[derive(Debug)]
pub struct ConversionClaim(Arc<Mutex<Option<ActiveJob>>>);

impl ConversionClaim {
    /// Record the job id the sidecar issued, so a cancel can name it.
    pub fn set_job_id(&self, job_id: &str) {
        if let Some(job) = self.0.lock().unwrap().as_mut() {
            job.job_id = job_id.to_string();
        }
    }

    /// Record which page an export has moved on to.
    // The export task (Task 6) is the first non-test caller.
    #[allow(dead_code)]
    pub fn set_page(&self, page_no: i64) {
        if let Some(job) = self.0.lock().unwrap().as_mut() {
            job.page_no = page_no;
        }
    }
}

impl Drop for ConversionClaim {
    fn drop(&mut self) {
        *self.0.lock().unwrap() = None;
    }
}

/// Take the slot for `job`, or refuse with a message naming what holds it.
///
/// The check and the claim share one lock acquisition: testing the slot and
/// then claiming it separately would reintroduce the very race this closes.
fn take(slot: &Arc<Mutex<Option<ActiveJob>>>, job: ActiveJob) -> Result<ConversionClaim, String> {
    let mut guard = slot.lock().unwrap();
    if let Some(current) = guard.as_ref() {
        return Err(match current.holder {
            Holder::Page => BUSY_MESSAGE,
            Holder::Export => EXPORT_BUSY_MESSAGE,
        }
        .to_string());
    }
    *guard = Some(job);
    drop(guard);
    Ok(ConversionClaim(Arc::clone(slot)))
}

/// Take the conversion slot for one page, or refuse.
pub fn claim(
    slot: &Arc<Mutex<Option<ActiveJob>>>,
    project_id: &str,
    page_no: i64,
) -> Result<ConversionClaim, String> {
    take(
        slot,
        ActiveJob {
            holder: Holder::Page,
            project_id: project_id.to_string(),
            page_no,
            job_id: String::new(),
        },
    )
}

/// Take the conversion slot for a whole export, or refuse.
// The export task (Task 6) is the first non-test caller.
#[allow(dead_code)]
pub fn claim_export(
    slot: &Arc<Mutex<Option<ActiveJob>>>,
    project_id: &str,
) -> Result<ConversionClaim, String> {
    take(
        slot,
        ActiveJob {
            holder: Holder::Export,
            project_id: project_id.to_string(),
            page_no: 0,
            job_id: String::new(),
        },
    )
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PageAudioDto {
    /// Absolute path for the webview's asset protocol, or None when no take exists.
    pub path: Option<String>,
    pub duration_ms: Option<i64>,
    pub sample_rate: Option<i64>,
    /// When this take was recorded, epoch milliseconds, or None when there is
    /// no take. The webview hangs it off the audio URL so that a re-conversion
    /// — which reuses the same deterministic path — still reads as a new
    /// source and actually reloads.
    pub created_at: Option<i64>,
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
    language: &str,
    voice: &str,
    rate: f64,
    data_dir: &Path,
) -> Result<PageAudioDto, String> {
    let stored = audio::get_page_audio(conn, project_id, page_no).map_err(|e| e.to_string())?;
    // A page with no text can never be fresh, and must not blow up the panel.
    let current = effective_text(conn, project_id, page_no).unwrap_or_default();
    let stale = !audio::is_fresh(&stored, &current, language, voice, rate);
    Ok(PageAudioDto {
        // Resolved against the data dir exactly as `get_project_cmd` resolves
        // `pdf_path`, so both land inside the one asset-protocol grant.
        path: stored
            .path
            .as_ref()
            .map(|p| data_dir.join(p).to_string_lossy().into_owned()),
        duration_ms: stored.duration_ms,
        sample_rate: stored.sample_rate,
        created_at: stored.created_at,
        stale,
    })
}

fn audio_rel_path(project_id: &str, page_no: i64) -> String {
    format!("projects/{project_id}/audio/page-{page_no}.wav")
}

/// The scratch file a conversion writes to before it has earned the final path.
///
/// The sidecar writes straight to the path it is handed, and a cancelled or
/// failed run still writes the samples it had. Letting that land on the final
/// path would destroy the previous good take while the database row still
/// described it — the row saying 4200 ms over a clipped file, with no stale
/// badge to warn anyone. So synthesis writes here, and only a `done` job
/// renames into place.
///
/// Cleanup is `Drop`, not a statement on the failure paths: an early `?`
/// anywhere between starting the job and the rename must not leave scratch
/// files accumulating in the project's audio directory.
#[derive(Debug)]
pub struct TempOutput {
    path: PathBuf,
}

impl TempOutput {
    /// A scratch path beside the final one, so the rename stays within one
    /// filesystem and is therefore atomic.
    pub fn new(final_path: &Path) -> Self {
        let mut name = final_path.file_name().unwrap_or_default().to_os_string();
        name.push(".part");
        Self {
            path: final_path.with_file_name(name),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Move the finished take into place, replacing any previous one.
    ///
    /// The rename is atomic, so the final path never holds partial bytes: a
    /// reader sees either the whole old take or the whole new one.
    pub fn commit(self, final_path: &Path) -> Result<(), String> {
        std::fs::rename(&self.path, final_path).map_err(|e| e.to_string())?;
        // Renamed away: nothing left for Drop to remove.
        std::mem::forget(self);
        Ok(())
    }
}

impl Drop for TempOutput {
    fn drop(&mut self) {
        // A scratch file that was never written is the normal case for a job
        // that failed early, and a cleanup failure must not mask the real
        // error already on its way out.
        let _ = std::fs::remove_file(&self.path);
    }
}

/// How a sidecar job can fail, split by what the caller should do about it.
#[derive(Debug, Clone, PartialEq)]
pub enum JobFailure {
    /// Stopped on request.
    Cancelled,
    /// The job ran and failed on this input; the sidecar's own words. An export
    /// records it against the page and carries on.
    Failed(String),
    /// The sidecar could not be reached, or no longer knows the job because it
    /// restarted, or local storage failed. Nothing later will go better.
    Lost(String),
}

impl JobFailure {
    /// The single string Convert has always rejected with.
    pub fn into_message(self) -> String {
        match self {
            JobFailure::Cancelled => "conversion cancelled".to_string(),
            JobFailure::Failed(m) | JobFailure::Lost(m) => m,
        }
    }
}

/// Follow a sidecar job to its end, reporting progress on the way.
///
/// `state` is the only verdict. A cancelled job still carries a populated
/// `sampleRate` and a non-zero `durationMs` over a truncated WAV, so deciding
/// success by the presence of those fields would store a clipped take as if it
/// were a finished one.
pub async fn poll_job(
    sidecar_state: &SidecarState,
    job_id: &str,
    mut on_progress: impl FnMut(f64),
) -> Result<(i64, i64), JobFailure> {
    loop {
        tokio::time::sleep(POLL_INTERVAL).await;
        let snapshot = sidecar::get_json(sidecar_state, &format!("/jobs/{job_id}"))
            .await
            .map_err(JobFailure::Lost)?;
        match snapshot["state"].as_str() {
            Some("running") => on_progress(snapshot["progress"].as_f64().unwrap_or(0.0)),
            Some("done") => {
                return Ok((
                    snapshot["sampleRate"].as_i64().unwrap_or(0),
                    snapshot["durationMs"].as_i64().unwrap_or(0),
                ))
            }
            Some("cancelled") => return Err(JobFailure::Cancelled),
            Some("error") => {
                return Err(JobFailure::Failed(
                    snapshot["message"]
                        .as_str()
                        .unwrap_or("synthesis failed")
                        .to_string(),
                ))
            }
            other => return Err(JobFailure::Lost(format!("unexpected job state {other:?}"))),
        }
    }
}

/// Synthesize one page into its own slot and record what it was made from.
///
/// The one path both Convert and export take, so the two cannot drift apart.
/// The caller holds the claim; this only names the job on it.
#[allow(clippy::too_many_arguments)]
pub async fn synthesize_page(
    db: &Db,
    data_dir: &Path,
    sidecar_state: &SidecarState,
    claim: &ConversionClaim,
    project_id: &str,
    page_no: i64,
    voice: &str,
    rate: f64,
    on_progress: impl FnMut(f64),
) -> Result<(), JobFailure> {
    let (text, language) = {
        let conn = db.0.lock().unwrap();
        let text = effective_text(&conn, project_id, page_no).map_err(JobFailure::Failed)?;
        let detail = crate::project::get_project(&conn, project_id)
            .map_err(|e| JobFailure::Lost(e.to_string()))?;
        (text, detail.language)
    };

    let rel = audio_rel_path(project_id, page_no);
    let out_path: PathBuf = data_dir.join(&rel);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| JobFailure::Lost(e.to_string()))?;
    }
    let temp = TempOutput::new(&out_path);

    let started = sidecar::post_json(
        sidecar_state,
        "/jobs/tts",
        json!({
            "text": text,
            "language": language,
            "voice": voice,
            "rate": rate,
            "out_path": temp.path().to_string_lossy(),
        }),
    )
    .await
    .map_err(JobFailure::Lost)?;
    let job_id = started["jobId"]
        .as_str()
        .ok_or_else(|| JobFailure::Lost("sidecar did not return a job id".into()))?
        .to_string();

    // Named before polling, so a cancel issued during synthesis can find it.
    claim.set_job_id(&job_id);

    let (sample_rate, duration_ms) = poll_job(sidecar_state, &job_id, on_progress).await?;

    // Only a finished job earns the final path; see `TempOutput`. The rename
    // and the row write commit together, so the bytes at `out_path` and the
    // row describing them can never disagree.
    temp.commit(&out_path).map_err(JobFailure::Lost)?;

    let conn = db.0.lock().unwrap();
    audio::set_page_audio(
        &conn,
        project_id,
        page_no,
        &rel,
        &audio::text_hash(&text),
        &language,
        voice,
        rate,
        sample_rate,
        duration_ms,
    )
    .map_err(|e| JobFailure::Lost(e.to_string()))
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
    // silently overwriting the slot and stranding the first job's Cancel. The
    // claim releases the slot when this function returns, however it returns.
    let claim = claim(&active.0, &project_id, page_no)?;
    synthesize_page(
        db.inner(),
        &data.0,
        &sidecar_state,
        &claim,
        &project_id,
        page_no,
        &voice,
        rate,
        |progress| {
            let _ = app.emit(
                "tts://progress",
                json!({ "projectId": project_id, "pageNo": page_no, "progress": progress }),
            );
        },
    )
    .await
    .map_err(JobFailure::into_message)?;

    let conn = db.0.lock().unwrap();
    let language = crate::project::get_project(&conn, &project_id)
        .map_err(|e| e.to_string())?
        .language;
    page_audio_dto(&conn, &project_id, page_no, &language, &voice, rate, &data.0)
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

/// The voices the engine for this language actually offers.
///
/// Empty for the single-speaker MMS languages, which is a legitimate answer
/// rather than a failure: the caller shows no voice picker for them.
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

#[tauri::command]
pub fn get_page_audio_cmd(
    db: State<'_, Db>,
    data: State<'_, DataDir>,
    project_id: String,
    page_no: i64,
    language: String,
    voice: String,
    rate: f64,
) -> Result<PageAudioDto, String> {
    let conn = db.0.lock().unwrap();
    page_audio_dto(&conn, &project_id, page_no, &language, &voice, rate, &data.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::project;
    use std::sync::Arc;

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
            &crate::audio::text_hash("extracted one"), "en", "af_heart", 1.0, 24000, 4200,
        )
        .unwrap();

        let fresh =
            page_audio_dto(&conn, &id, 1, "en", "af_heart", 1.0, std::path::Path::new("/data")).unwrap();
        assert!(!fresh.stale);
        assert_eq!(fresh.duration_ms, Some(4200));
        assert!(fresh.path.unwrap().ends_with("projects/p1/audio/page-1.wav"));

        project::save_page_text(&conn, &id, 1, "corrected one").unwrap();
        let stale =
            page_audio_dto(&conn, &id, 1, "en", "af_heart", 1.0, std::path::Path::new("/data")).unwrap();
        assert!(stale.stale);
        // Stale audio stays playable.
        assert!(stale.path.is_some());
    }

    #[test]
    fn a_page_with_no_audio_is_stale_and_has_no_path() {
        let mut conn = db::open_in_memory().unwrap();
        let id = seed(&mut conn);
        let dto =
            page_audio_dto(&conn, &id, 1, "en", "af_heart", 1.0, std::path::Path::new("/data")).unwrap();
        assert!(dto.stale);
        assert!(dto.path.is_none());
    }

    fn active(project_id: &str, page_no: i64) -> Option<ActiveJob> {
        Some(ActiveJob {
            holder: Holder::Page,
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
        let slot = Arc::new(Mutex::new(None));
        let _claim = claim(&slot, "p1", 3).unwrap();
        assert!(job_for(&slot.lock().unwrap(), "p1", 3).is_none());
    }

    #[test]
    fn a_claim_names_the_job_once_the_sidecar_issues_an_id() {
        let slot = Arc::new(Mutex::new(None));
        let claimed = claim(&slot, "p1", 3).unwrap();
        claimed.set_job_id("job-abc");
        assert_eq!(
            job_for(&slot.lock().unwrap(), "p1", 3).as_deref(),
            Some("job-abc")
        );
    }

    #[test]
    fn a_second_conversion_is_refused_while_one_is_running() {
        let slot = Arc::new(Mutex::new(None));
        let _first = claim(&slot, "p1", 3).unwrap();
        // A different page is refused too: the slot holds one conversion, not
        // one per page.
        assert_eq!(claim(&slot, "p1", 4).unwrap_err(), BUSY_MESSAGE);
        assert_eq!(claim(&slot, "p2", 3).unwrap_err(), BUSY_MESSAGE);
    }

    #[test]
    fn the_slot_is_released_when_a_conversion_ends() {
        let slot = Arc::new(Mutex::new(None));
        {
            let _first = claim(&slot, "p1", 3).unwrap();
        }
        // Released, so the next page may convert. This is what proves a
        // completed conversion does not wedge the app into permanent refusal.
        let _second = claim(&slot, "p1", 4).expect("slot free after the first ended");
    }

    /// A conversion's shape, minus the sidecar: write scratch bytes, then
    /// either commit them or return early. `Ok` stands for a `done` job,
    /// `Err` for the cancel and error branches of `poll_job`.
    fn convert_into(final_path: &Path, bytes: &[u8], outcome: Result<(), String>) -> Result<(), String> {
        let temp = TempOutput::new(final_path);
        std::fs::write(temp.path(), bytes).unwrap();
        outcome?;
        temp.commit(final_path)
    }

    fn temp_audio_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("enisma-test-{name}"));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn temp_of(final_path: &Path) -> PathBuf {
        TempOutput::new(final_path).path().to_path_buf()
    }

    #[test]
    fn a_cancelled_conversion_leaves_the_previous_take_byte_identical() {
        let dir = temp_audio_dir("convert-cancelled");
        let final_path = dir.join("page-1.wav");
        std::fs::write(&final_path, b"the good take").unwrap();

        let err = convert_into(&final_path, b"clipped", Err("conversion cancelled".into()))
            .unwrap_err();
        assert_eq!(err, "conversion cancelled");
        // The row still describes this take, so these bytes must still be it.
        assert_eq!(std::fs::read(&final_path).unwrap(), b"the good take");
        assert!(!temp_of(&final_path).exists(), "scratch file left behind");
    }

    #[test]
    fn a_failed_conversion_leaves_the_previous_take_byte_identical() {
        let dir = temp_audio_dir("convert-failed");
        let final_path = dir.join("page-1.wav");
        std::fs::write(&final_path, b"the good take").unwrap();

        let err =
            convert_into(&final_path, b"clipped", Err("synthesis failed".into())).unwrap_err();
        assert_eq!(err, "synthesis failed");
        assert_eq!(std::fs::read(&final_path).unwrap(), b"the good take");
        assert!(!temp_of(&final_path).exists(), "scratch file left behind");
    }

    #[test]
    fn a_finished_conversion_replaces_the_previous_take() {
        let dir = temp_audio_dir("convert-done");
        let final_path = dir.join("page-1.wav");
        std::fs::write(&final_path, b"the old take").unwrap();

        convert_into(&final_path, b"the new take", Ok(())).unwrap();
        assert_eq!(std::fs::read(&final_path).unwrap(), b"the new take");
        assert!(!temp_of(&final_path).exists(), "scratch file left behind");
    }

    #[test]
    fn synthesis_never_writes_to_the_final_path() {
        // The whole point of the scratch file: the sidecar is handed a path
        // that is not the one the database row names.
        let final_path = Path::new("/data/projects/p1/audio/page-1.wav");
        let temp = TempOutput::new(final_path);
        assert_ne!(temp.path(), final_path);
        // Beside it, so the rename is a same-filesystem atomic move.
        assert_eq!(temp.path().parent(), final_path.parent());
    }

    #[test]
    fn the_slot_is_released_even_when_the_conversion_fails() {
        fn failing(slot: &Arc<Mutex<Option<ActiveJob>>>) -> Result<(), String> {
            let _claim = claim(slot, "p1", 3)?;
            // Stands in for a job that errors mid-poll: an early `?` return.
            Err("synthesis failed".to_string())
        }

        let slot = Arc::new(Mutex::new(None));
        assert_eq!(failing(&slot).unwrap_err(), "synthesis failed");
        assert!(slot.lock().unwrap().is_none());
        claim(&slot, "p1", 3).expect("slot free after a failure");
    }

    #[test]
    fn an_export_refuses_a_page_conversion_with_the_export_message() {
        let slot = Arc::new(Mutex::new(None));
        let _export = claim_export(&slot, "p1").unwrap();
        assert_eq!(claim(&slot, "p1", 3).unwrap_err(), EXPORT_BUSY_MESSAGE);
        assert_eq!(claim(&slot, "p2", 1).unwrap_err(), EXPORT_BUSY_MESSAGE);
    }

    #[test]
    fn a_page_conversion_refuses_an_export() {
        let slot = Arc::new(Mutex::new(None));
        let _page = claim(&slot, "p1", 3).unwrap();
        assert_eq!(claim_export(&slot, "p1").unwrap_err(), BUSY_MESSAGE);
    }

    #[test]
    fn a_second_export_is_refused() {
        let slot = Arc::new(Mutex::new(None));
        let _first = claim_export(&slot, "p1").unwrap();
        assert_eq!(claim_export(&slot, "p2").unwrap_err(), EXPORT_BUSY_MESSAGE);
    }

    #[test]
    fn a_page_cancel_never_stops_an_export() {
        let slot = Arc::new(Mutex::new(None));
        let export = claim_export(&slot, "p1").unwrap();
        export.set_page(3);
        export.set_job_id("job-exp");
        assert!(job_for(&slot.lock().unwrap(), "p1", 3).is_none());
        assert_eq!(export_job(&slot.lock().unwrap()).as_deref(), Some("job-exp"));
    }

    #[test]
    fn export_job_ignores_a_page_conversion() {
        let slot = Arc::new(Mutex::new(None));
        let page = claim(&slot, "p1", 3).unwrap();
        page.set_job_id("job-page");
        assert!(export_job(&slot.lock().unwrap()).is_none());
    }

    #[test]
    fn exporting_project_names_only_an_export() {
        let slot = Arc::new(Mutex::new(None));
        {
            let _page = claim(&slot, "p1", 3).unwrap();
            assert!(exporting_project(&slot.lock().unwrap()).is_none());
        }
        let _export = claim_export(&slot, "p2").unwrap();
        assert_eq!(exporting_project(&slot.lock().unwrap()).as_deref(), Some("p2"));
    }

    #[test]
    fn an_export_claim_is_released_when_dropped_on_another_thread() {
        let slot = Arc::new(Mutex::new(None));
        let export = claim_export(&slot, "p1").unwrap();
        std::thread::spawn(move || drop(export)).join().unwrap();
        claim(&slot, "p1", 1).expect("slot free after the export task ended");
    }

    #[test]
    fn job_failures_read_as_the_messages_convert_always_returned() {
        assert_eq!(JobFailure::Cancelled.into_message(), "conversion cancelled");
        assert_eq!(JobFailure::Failed("bad numeral".into()).into_message(), "bad numeral");
        assert_eq!(JobFailure::Lost("sidecar starting".into()).into_message(), "sidecar starting");
    }
}
