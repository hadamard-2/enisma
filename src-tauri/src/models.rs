//! Getting the voice models onto the machine: download, or copy from a folder.
//!
//! Two facts about a language live in different places on purpose. What is on
//! disk and what it would cost comes from `/models/status`; whether the engine
//! actually loaded comes from `/health`. A model can be present and still not
//! load — a corrupt file, a missing native library — and collapsing the two
//! would let the panel say "installed" over a language that cannot speak.

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

use crate::sidecar::{self, SidecarState};

/// How often to ask how an acquisition is going. A download runs for minutes,
/// so this is about a progress bar that moves, not about precision.
const POLL_INTERVAL: Duration = Duration::from_millis(400);

/// What the user is told when an acquisition is already running.
pub const BUSY_MESSAGE: &str =
    "another voice model is already being installed. Wait for it to finish, or cancel it first.";

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub language: String,
    /// Every file present and hash-verified.
    pub present: bool,
    /// What the language costs in total, from the sidecar's manifest — so the
    /// webview can offer "114 MB" without keeping a second copy of the figures.
    pub bytes: i64,
    pub installed_bytes: i64,
    /// What an interrupted download left behind. Non-zero means asking again
    /// resumes from here rather than starting over, which is worth saying.
    pub partial_bytes: i64,
}

#[derive(Debug, Clone)]
pub struct ActiveModelJob {
    pub language: String,
    pub job_id: String,
}

/// The one acquisition that may be running. Separate from the conversion slot:
/// a download is network-bound and a conversion is CPU-bound, so there is no
/// reason one should block the other.
#[derive(Default)]
pub struct ActiveAcquisition(pub Mutex<Option<ActiveModelJob>>);

/// The job id to cancel for a given language, if that language is the one running.
pub fn job_for(active: &Option<ActiveModelJob>, language: &str) -> Option<String> {
    active
        .as_ref()
        .filter(|j| j.language == language)
        // The slot is claimed before the sidecar has issued a job id, so a
        // cancel landing in that gap has nothing to name yet.
        .filter(|j| !j.job_id.is_empty())
        .map(|j| j.job_id.clone())
}

/// Exclusive hold on the acquisition slot, released on every exit path.
///
/// Releasing is `Drop` rather than a statement at the end of the happy path:
/// an early `?` on a failed download must not leave the slot occupied, or the
/// app would refuse every later install until it was restarted.
#[derive(Debug)]
pub struct AcquisitionClaim<'a>(&'a Mutex<Option<ActiveModelJob>>);

impl AcquisitionClaim<'_> {
    pub fn set_job_id(&self, job_id: &str) {
        if let Some(job) = self.0.lock().unwrap().as_mut() {
            job.job_id = job_id.to_string();
        }
    }
}

impl Drop for AcquisitionClaim<'_> {
    fn drop(&mut self) {
        *self.0.lock().unwrap() = None;
    }
}

/// Take the acquisition slot, or refuse.
///
/// The check and the claim share one lock acquisition: testing the slot and
/// then claiming it separately would reintroduce the race this closes.
pub fn claim<'a>(
    slot: &'a Mutex<Option<ActiveModelJob>>,
    language: &str,
) -> Result<AcquisitionClaim<'a>, String> {
    let mut guard = slot.lock().unwrap();
    if guard.is_some() {
        return Err(BUSY_MESSAGE.to_string());
    }
    *guard = Some(ActiveModelJob {
        language: language.to_string(),
        job_id: String::new(),
    });
    drop(guard);
    Ok(AcquisitionClaim(slot))
}

/// What each language has on disk and what it would cost to get it.
///
/// Ordered by the manifest rather than by a map's iteration, so the list does
/// not reshuffle itself between calls under the user's cursor.
#[tauri::command]
pub async fn model_status_cmd(
    sidecar_state: State<'_, SidecarState>,
) -> Result<Vec<ModelStatus>, String> {
    let value = sidecar::get_json(&sidecar_state, "/models/status").await?;
    let languages = value["languages"]
        .as_object()
        .ok_or("sidecar did not return a language map")?;

    let mut out: Vec<ModelStatus> = languages
        .iter()
        .map(|(language, info)| ModelStatus {
            language: language.clone(),
            present: info["present"].as_bool().unwrap_or(false),
            bytes: info["bytes"].as_i64().unwrap_or(0),
            installed_bytes: info["installedBytes"].as_i64().unwrap_or(0),
            partial_bytes: info["partialBytes"].as_i64().unwrap_or(0),
        })
        .collect();
    out.sort_by(|a, b| a.language.cmp(&b.language));
    Ok(out)
}

/// Install one language, either by downloading it or by copying a folder.
///
/// `source_dir` decides which: `None` downloads, `Some` copies from there.
/// One command rather than two because everything after the first request is
/// identical — the same job, the same polling, the same terminal states — and
/// the caller's own UI treats them as one action with two sources.
#[tauri::command]
pub async fn acquire_model_cmd(
    app: AppHandle,
    sidecar_state: State<'_, SidecarState>,
    active: State<'_, ActiveAcquisition>,
    language: String,
    source_dir: Option<String>,
) -> Result<(), String> {
    // Claimed before any work, so a second install is refused rather than
    // silently overwriting the slot and stranding the first job's Cancel.
    let _claim = claim(&active.0, &language)?;

    let (route, body) = match &source_dir {
        Some(dir) => (
            "/jobs/import",
            json!({ "language": language, "source_dir": dir }),
        ),
        None => ("/jobs/fetch", json!({ "language": language })),
    };

    let started = sidecar::post_json(&sidecar_state, route, body).await?;
    let job_id = started["jobId"]
        .as_str()
        .ok_or("sidecar did not return a job id")?
        .to_string();

    _claim.set_job_id(&job_id);

    // `_claim` releases the slot when this function returns, however it returns.
    poll_job(&app, &sidecar_state, &job_id, &language).await
}

/// Watch one acquisition to a terminal state, emitting progress as it goes.
///
/// `state` is the only verdict, for the same reason it is in a conversion: a
/// cancelled job still carries whatever progress it had reached.
async fn poll_job(
    app: &AppHandle,
    sidecar_state: &SidecarState,
    job_id: &str,
    language: &str,
) -> Result<(), String> {
    loop {
        tokio::time::sleep(POLL_INTERVAL).await;
        let snapshot = sidecar::get_json(sidecar_state, &format!("/jobs/{job_id}")).await?;
        match snapshot["state"].as_str() {
            Some("running") => {
                let _ = app.emit(
                    "models://progress",
                    json!({
                        "language": language,
                        "progress": snapshot["progress"].as_f64().unwrap_or(0.0),
                    }),
                );
            }
            Some("done") => return Ok(()),
            Some("cancelled") => return Err(CANCELLED.to_string()),
            Some("error") => {
                return Err(snapshot["message"]
                    .as_str()
                    .unwrap_or("installing the voice model failed")
                    .to_string())
            }
            other => return Err(format!("unexpected job state {other:?}")),
        }
    }
}

/// What `acquire_model_cmd` rejects with when a cancel actually won.
pub const CANCELLED: &str = "installation cancelled";

/// Ask the sidecar to stop installing this language.
///
/// Like a conversion's cancel this *requests* a stop rather than reporting
/// one, but unlike a conversion it is cheap to act on: the downloader checks
/// between chunks, and what has already arrived is kept, so asking again
/// resumes rather than starting over.
#[tauri::command]
pub async fn cancel_model_acquisition_cmd(
    sidecar_state: State<'_, SidecarState>,
    active: State<'_, ActiveAcquisition>,
    language: String,
) -> Result<(), String> {
    let job_id = {
        let guard = active.0.lock().unwrap();
        job_for(&guard, &language)
    };
    // Nothing running for this language is not an error — it may have finished
    // between the user's click and this call.
    let Some(job_id) = job_id else {
        return Ok(());
    };
    match sidecar::delete_json(&sidecar_state, &format!("/jobs/{job_id}")).await {
        Ok(_) => Ok(()),
        // Finished and pruned in the same gap. Same nothing-to-stop.
        Err(e) if sidecar::is_not_found(&e) => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn active(language: &str) -> Option<ActiveModelJob> {
        Some(ActiveModelJob {
            language: language.to_string(),
            job_id: "job-abc".to_string(),
        })
    }

    #[test]
    fn a_cancel_finds_the_job_for_the_language_being_installed() {
        assert_eq!(job_for(&active("am"), "am").as_deref(), Some("job-abc"));
    }

    #[test]
    fn a_cancel_aimed_at_another_language_matches_nothing() {
        assert!(job_for(&active("am"), "ti").is_none());
    }

    #[test]
    fn a_cancel_with_nothing_running_matches_nothing() {
        assert!(job_for(&None, "am").is_none());
    }

    #[test]
    fn a_cancel_before_the_sidecar_issues_a_job_id_matches_nothing() {
        let slot = Mutex::new(None);
        let _claim = claim(&slot, "am").unwrap();
        assert!(job_for(&slot.lock().unwrap(), "am").is_none());
    }

    #[test]
    fn a_second_install_is_refused_while_one_is_running() {
        let slot = Mutex::new(None);
        let _first = claim(&slot, "am").unwrap();
        // A different language is refused too: the slot holds one install, not
        // one per language.
        assert_eq!(claim(&slot, "ti").unwrap_err(), BUSY_MESSAGE);
    }

    #[test]
    fn the_slot_is_released_even_when_an_install_fails() {
        fn failing(slot: &Mutex<Option<ActiveModelJob>>) -> Result<(), String> {
            let _claim = claim(slot, "am")?;
            // Stands in for a download that errors mid-poll: an early `?`.
            Err("installing the voice model failed".to_string())
        }

        let slot = Mutex::new(None);
        assert!(failing(&slot).is_err());
        assert!(slot.lock().unwrap().is_none());
        claim(&slot, "am").expect("slot free after a failure");
    }

    #[test]
    fn a_status_row_reaches_the_webview_with_camel_case_keys() {
        let json = serde_json::to_string(&ModelStatus {
            language: "am".into(),
            present: false,
            bytes: 114_029_960,
            installed_bytes: 0,
            partial_bytes: 4096,
        })
        .unwrap();
        assert!(json.contains(r#""installedBytes":0"#));
        assert!(json.contains(r#""partialBytes":4096"#));
    }
}
