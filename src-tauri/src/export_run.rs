//! Running an export: the background task, its status, and its commands.
//!
//! The task owns the conversion slot for its whole run. It synthesizes every
//! page that is not fresh through the same path Convert uses, re-checks until
//! nothing is stale, stitches, re-checks once more, and only then moves the
//! MP3 into place. Every finished page is committed as it lands, so a cancel,
//! a quit or a crash costs at most the page in progress, and exporting again
//! picks up the rest through the freshness check.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::convert::{self, ActiveConversion, ConversionClaim, JobFailure, TempOutput};
use crate::export::{self, ExportPlan, Failure, Failures};
use crate::sidecar::{self, SidecarState};
use crate::{DataDir, Db};

/// Silence between consecutive pages. A starting point, to be tuned by ear.
pub const PAGE_GAP_MS: u32 = 600;
/// Constant bitrate: reliable seeking and duration in every player, with no
/// dependence on a Xing header.
pub const BITRATE_KBPS: u32 = 64;

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// The first pass over the range.
    Synthesizing,
    /// Later passes: pages edited behind the loop, or during the stitch.
    Sweeping,
    Stitching,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageFailure {
    pub page_no: i64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Outcome {
    Done { path: String, duration_ms: i64, empty: Vec<i64> },
    /// Pages still failing on their current text. Nothing was stitched.
    Failed { pages: Vec<PageFailure>, empty: Vec<i64> },
    Cancelled { kept: usize },
    /// The run could not go on: the sidecar was lost, storage failed, or the
    /// range turned out to have nothing to say.
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ExportStatus {
    Running {
        project_id: String,
        title: String,
        phase: Phase,
        /// Pages finished in the current pass, out of `total`.
        done: usize,
        total: usize,
        page_no: Option<i64>,
        /// The current page's progress, or the stitch's.
        page_progress: f64,
        /// Pages synthesized so far in this run, across passes.
        synthesized: usize,
        started_at_ms: i64,
    },
    /// Kept until dismissed or the next export starts, so a run that finishes
    /// while the user is elsewhere still shows its result.
    Finished { project_id: String, title: String, outcome: Outcome },
}

#[derive(Default)]
pub struct ExportState {
    pub status: Mutex<Option<ExportStatus>>,
    pub cancel: AtomicBool,
}

struct ExportRequest {
    project_id: String,
    title: String,
    voice: String,
    rate: f64,
    first: i64,
    last: i64,
    out_path: PathBuf,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Writes status to `ExportState` and tells the webview.
struct Reporter {
    app: AppHandle,
    project_id: String,
    title: String,
    started_at_ms: i64,
    synthesized: usize,
}

impl Reporter {
    fn running(&self, phase: Phase, done: usize, total: usize, page_no: Option<i64>, page_progress: f64) {
        let status = ExportStatus::Running {
            project_id: self.project_id.clone(),
            title: self.title.clone(),
            phase,
            done,
            total,
            page_no,
            page_progress,
            synthesized: self.synthesized,
            started_at_ms: self.started_at_ms,
        };
        *self.app.state::<ExportState>().status.lock().unwrap() = Some(status.clone());
        let _ = self.app.emit("export://progress", status);
    }

    fn finish(&self, outcome: Outcome) {
        let status = ExportStatus::Finished {
            project_id: self.project_id.clone(),
            title: self.title.clone(),
            outcome,
        };
        *self.app.state::<ExportState>().status.lock().unwrap() = Some(status.clone());
        let _ = self.app.emit("export://finished", status);
    }
}

/// Fail in the first second, not after hours: create the scratch file the
/// stitch will write, then let `TempOutput`'s `Drop` remove it.
fn probe_writable(out_path: &Path) -> Result<(), String> {
    let probe = TempOutput::new(out_path);
    std::fs::File::create(probe.path())
        .map_err(|e| format!("cannot write to {}: {e}", out_path.display()))?;
    Ok(())
}

fn classify_now(db: &Db, req: &ExportRequest) -> Result<Vec<export::Classified>, String> {
    let conn = db.0.lock().unwrap();
    export::classify(&conn, &req.project_id, &req.voice, req.rate, req.first, req.last)
        .map_err(|e| e.to_string())
}

fn cancelled(app: &AppHandle) -> bool {
    app.state::<ExportState>().cancel.load(Ordering::SeqCst)
}

/// What the run does after looking at the range afresh.
#[derive(Debug, PartialEq)]
enum Step {
    /// These pages need synthesizing (again).
    Synthesize(Vec<i64>),
    /// Nothing is left to try, but these pages still fail on their current
    /// text. The run ends without stitching.
    Fail(Vec<i64>),
    /// Every non-empty page is fresh.
    Stitch,
}

/// The sweep's stopping rule: go on while anything is stale and untried on
/// its current text, and stop the moment nothing is.
fn next_step(states: &[export::Classified], failed: &Failures) -> Step {
    let work = export::next_work(states, failed);
    if !work.is_empty() {
        return Step::Synthesize(work);
    }
    let outstanding = export::outstanding_failures(states, failed);
    if !outstanding.is_empty() {
        return Step::Fail(outstanding);
    }
    Step::Stitch
}

/// The whole run. `Err` is a run-fatal failure, reported as `Outcome::Error`.
async fn run(
    app: &AppHandle,
    claim: &ConversionClaim,
    req: &ExportRequest,
    rep: &mut Reporter,
) -> Result<Outcome, String> {
    let db = app.state::<Db>();
    let data = app.state::<DataDir>();
    let sidecar_state = app.state::<SidecarState>();
    let mut failed: Failures = Failures::new();
    let mut phase = Phase::Synthesizing;

    loop {
        // Synthesize until a pass finds nothing left to do.
        let states = loop {
            let states = classify_now(db.inner(), req)?;
            let work = match next_step(&states, &failed) {
                Step::Synthesize(work) => work,
                Step::Fail(_) | Step::Stitch => break states,
            };
            let total = work.len();
            for (done, page_no) in work.into_iter().enumerate() {
                if cancelled(app) {
                    return Ok(Outcome::Cancelled { kept: rep.synthesized });
                }
                rep.running(phase, done, total, Some(page_no), 0.0);
                let text_hash = states
                    .iter()
                    .find(|c| c.page_no == page_no)
                    .and_then(|c| c.text_hash.clone())
                    .unwrap_or_default();
                claim.set_page(page_no);
                let result = convert::synthesize_page(
                    db.inner(),
                    &data.0,
                    &sidecar_state,
                    claim,
                    Some(&app.state::<ExportState>().cancel),
                    &req.project_id,
                    page_no,
                    &req.voice,
                    req.rate,
                    |p| rep.running(phase, done, total, Some(page_no), p),
                )
                .await;
                match result {
                    Ok(()) => {
                        rep.synthesized += 1;
                        failed.remove(&page_no);
                        let _ = app.emit(
                            "export://page-done",
                            json!({ "projectId": req.project_id, "pageNo": page_no }),
                        );
                    }
                    Err(JobFailure::Cancelled) => {
                        return Ok(Outcome::Cancelled { kept: rep.synthesized })
                    }
                    Err(JobFailure::Failed(message)) => {
                        failed.insert(page_no, Failure { text_hash, message });
                    }
                    Err(JobFailure::Lost(message)) => {
                        return Err(format!("export stopped: {message}"))
                    }
                }
            }
            phase = Phase::Sweeping;
        };

        if let Step::Fail(outstanding) = next_step(&states, &failed) {
            let pages = outstanding
                .into_iter()
                .map(|page_no| PageFailure {
                    page_no,
                    message: failed[&page_no].message.clone(),
                })
                .collect();
            return Ok(Outcome::Failed { pages, empty: export::empty_pages(&states) });
        }

        let wavs = {
            let conn = db.0.lock().unwrap();
            export::stitch_inputs(&conn, &req.project_id, &states, &data.0)?
        };
        if cancelled(app) {
            return Ok(Outcome::Cancelled { kept: rep.synthesized });
        }
        rep.running(Phase::Stitching, 0, 1, None, 0.0);
        // The last page's job is finished; a cancel must not aim at it.
        claim.set_job_id("");
        let output = TempOutput::new(&req.out_path);
        let cancel = &app.state::<ExportState>().cancel;
        let duration_ms = match stitch(&sidecar_state, claim, cancel, &wavs, &req.title, output.path(), |p| {
            rep.running(Phase::Stitching, 0, 1, None, p)
        })
        .await
        {
            Ok(d) => d,
            Err(JobFailure::Cancelled) => return Ok(Outcome::Cancelled { kept: rep.synthesized }),
            Err(JobFailure::Failed(m)) | Err(JobFailure::Lost(m)) => return Err(m),
        };

        // An edit that landed during the stitch makes the file stale before it
        // exists. Go round again for those pages; `output` is dropped, which
        // removes the stale `.part`.
        let states = classify_now(db.inner(), req)?;
        if next_step(&states, &failed) != Step::Stitch {
            phase = Phase::Sweeping;
            continue;
        }
        output.commit(&req.out_path)?;
        return Ok(Outcome::Done {
            path: req.out_path.to_string_lossy().into_owned(),
            duration_ms,
            empty: export::empty_pages(&states),
        });
    }
}

async fn stitch(
    sidecar_state: &SidecarState,
    claim: &ConversionClaim,
    cancel: &AtomicBool,
    wavs: &[PathBuf],
    title: &str,
    out: &Path,
    on_progress: impl FnMut(f64),
) -> Result<i64, JobFailure> {
    let started = sidecar::post_json(
        sidecar_state,
        "/jobs/stitch",
        json!({
            "wavs": wavs.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>(),
            "gap_ms": PAGE_GAP_MS,
            "bitrate_kbps": BITRATE_KBPS,
            "title": title,
            "out_path": out.to_string_lossy(),
        }),
    )
    .await
    .map_err(JobFailure::Lost)?;
    let job_id = started["jobId"]
        .as_str()
        .ok_or_else(|| JobFailure::Lost("sidecar did not return a job id".into()))?
        .to_string();
    claim.set_job_id(&job_id);
    convert::cancel_if_requested(sidecar_state, Some(cancel), &job_id).await;
    let (_sample_rate, duration_ms) = convert::poll_job(sidecar_state, &job_id, on_progress).await?;
    Ok(duration_ms)
}

fn dismiss(state: &ExportState) {
    let mut status = state.status.lock().unwrap();
    if matches!(*status, Some(ExportStatus::Finished { .. })) {
        *status = None;
    }
}

#[tauri::command]
pub fn export_plan_cmd(
    db: State<'_, Db>,
    project_id: String,
    voice: String,
    rate: f64,
    first_page: i64,
    last_page: i64,
) -> Result<ExportPlan, String> {
    let conn = db.0.lock().unwrap();
    let detail = crate::project::get_project(&conn, &project_id).map_err(|e| e.to_string())?;
    export::validate_range(first_page, last_page, detail.page_count)?;
    let states = export::classify(&conn, &project_id, &voice, rate, first_page, last_page)
        .map_err(|e| e.to_string())?;
    Ok(export::plan(&states))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn start_export_cmd(
    app: AppHandle,
    db: State<'_, Db>,
    active: State<'_, ActiveConversion>,
    export_state: State<'_, ExportState>,
    project_id: String,
    voice: String,
    rate: f64,
    first_page: i64,
    last_page: i64,
    out_path: String,
) -> Result<(), String> {
    // Claim first, then read the project. Deleting a project checks the slot
    // and removes the row under one hold of the slot's lock, so once the claim
    // is ours the project either is already gone (and `get_project` fails
    // here, dropping the claim) or cannot go while the export runs.
    let claim = convert::claim_export(&active.0, &project_id)?;
    // Reset while the claim is fresh: a cancel pressed from here on, even
    // before the run starts, must stick.
    export_state.cancel.store(false, Ordering::SeqCst);
    let title = {
        let conn = db.0.lock().unwrap();
        let detail = crate::project::get_project(&conn, &project_id).map_err(|e| e.to_string())?;
        export::validate_range(first_page, last_page, detail.page_count)?;
        detail.title
    };
    let out_path = PathBuf::from(out_path);
    probe_writable(&out_path)?;
    {
        let conn = db.0.lock().unwrap();
        crate::project::save_export_settings(
            &conn, &project_id, &voice, rate, first_page, last_page, &out_path.to_string_lossy(),
        )
        .map_err(|e| e.to_string())?;
    }

    let req = ExportRequest {
        project_id: project_id.clone(),
        title: title.clone(),
        voice,
        rate,
        first: first_page,
        last: last_page,
        out_path,
    };
    let mut rep = Reporter {
        app: app.clone(),
        project_id,
        title,
        started_at_ms: now_ms(),
        synthesized: 0,
    };
    rep.running(Phase::Synthesizing, 0, 0, None, 0.0);

    tauri::async_runtime::spawn(async move {
        let outcome = match run(&app, &claim, &req, &mut rep).await {
            Ok(outcome) => outcome,
            Err(message) => Outcome::Error { message },
        };
        // Release the slot before announcing the end, so a Convert pressed the
        // instant the summary appears is not refused.
        drop(claim);
        rep.finish(outcome);
    });
    Ok(())
}

/// Ask the running export to stop. Finished pages are kept.
#[tauri::command]
pub async fn cancel_export_cmd(
    sidecar_state: State<'_, SidecarState>,
    active: State<'_, ActiveConversion>,
    export_state: State<'_, ExportState>,
) -> Result<(), String> {
    export_state.cancel.store(true, Ordering::SeqCst);
    let job_id = convert::export_job(&active.0.lock().unwrap());
    let Some(job_id) = job_id else {
        return Ok(());
    };
    match sidecar::delete_json(&sidecar_state, &format!("/jobs/{job_id}")).await {
        Ok(_) => Ok(()),
        Err(e) if sidecar::is_not_found(&e) => Ok(()),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub fn export_status_cmd(export_state: State<'_, ExportState>) -> Option<ExportStatus> {
    export_state.status.lock().unwrap().clone()
}

#[tauri::command]
pub fn dismiss_export_cmd(export_state: State<'_, ExportState>) {
    dismiss(&export_state);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_running_status_serializes_to_the_shape_the_webview_reads() {
        let s = ExportStatus::Running {
            project_id: "p1".into(),
            title: "Biology".into(),
            phase: Phase::Synthesizing,
            done: 2,
            total: 10,
            page_no: Some(7),
            page_progress: 0.5,
            synthesized: 2,
            started_at_ms: 1000,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({
                "state": "running", "projectId": "p1", "title": "Biology",
                "phase": "synthesizing", "done": 2, "total": 10, "pageNo": 7,
                "pageProgress": 0.5, "synthesized": 2, "startedAtMs": 1000
            })
        );
    }

    #[test]
    fn outcomes_serialize_to_the_shapes_the_webview_reads() {
        let done = Outcome::Done { path: "/b.mp3".into(), duration_ms: 5, empty: vec![3] };
        assert_eq!(
            serde_json::to_value(&done).unwrap(),
            json!({"kind": "done", "path": "/b.mp3", "durationMs": 5, "empty": [3]})
        );
        let failed = Outcome::Failed {
            pages: vec![PageFailure { page_no: 4, message: "bad".into() }],
            empty: vec![],
        };
        assert_eq!(
            serde_json::to_value(&failed).unwrap(),
            json!({"kind": "failed", "pages": [{"pageNo": 4, "message": "bad"}], "empty": []})
        );
        assert_eq!(
            serde_json::to_value(Outcome::Cancelled { kept: 3 }).unwrap(),
            json!({"kind": "cancelled", "kept": 3})
        );
        assert_eq!(
            serde_json::to_value(Outcome::Error { message: "x".into() }).unwrap(),
            json!({"kind": "error", "message": "x"})
        );
    }

    #[test]
    fn a_finished_status_carries_its_outcome() {
        let s = ExportStatus::Finished {
            project_id: "p1".into(),
            title: "Biology".into(),
            outcome: Outcome::Cancelled { kept: 0 },
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({"state": "finished", "projectId": "p1", "title": "Biology",
                   "outcome": {"kind": "cancelled", "kept": 0}})
        );
    }

    #[test]
    fn a_writable_location_passes_the_probe_and_leaves_nothing_behind() {
        let dir = std::env::temp_dir().join("enisma-test-export-probe");
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("book.mp3");
        probe_writable(&out).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    }

    #[test]
    fn an_unwritable_location_fails_the_probe_at_once() {
        let out = std::env::temp_dir().join("enisma-no-such-dir").join("sub").join("book.mp3");
        let err = probe_writable(&out).unwrap_err();
        assert!(err.starts_with("cannot write to "), "{err}");
    }

    #[test]
    fn dismissing_clears_a_finished_run_but_never_a_running_one() {
        let state = ExportState::default();
        *state.status.lock().unwrap() = Some(ExportStatus::Finished {
            project_id: "p1".into(),
            title: "t".into(),
            outcome: Outcome::Cancelled { kept: 0 },
        });
        dismiss(&state);
        assert!(state.status.lock().unwrap().is_none());

        let running = ExportStatus::Running {
            project_id: "p1".into(), title: "t".into(), phase: Phase::Stitching,
            done: 0, total: 1, page_no: None, page_progress: 0.0, synthesized: 0, started_at_ms: 0,
        };
        *state.status.lock().unwrap() = Some(running.clone());
        dismiss(&state);
        assert_eq!(*state.status.lock().unwrap(), Some(running));
    }

    fn page(page_no: i64, state: export::PageState, hash: &str) -> export::Classified {
        export::Classified { page_no, state, text_hash: Some(hash.into()) }
    }

    #[test]
    fn the_sweep_stops_once_nothing_is_stale() {
        use export::{NeedReason, PageState};
        let failed = Failures::new();
        let stale = vec![
            page(1, PageState::Fresh, "a"),
            page(2, PageState::Needs(NeedReason::Edited), "b"),
        ];
        assert_eq!(next_step(&stale, &failed), Step::Synthesize(vec![2]));
        let fresh = vec![page(1, PageState::Fresh, "a"), page(2, PageState::Fresh, "b")];
        assert_eq!(next_step(&fresh, &failed), Step::Stitch);
    }

    #[test]
    fn a_page_that_failed_on_its_current_text_ends_the_sweep_without_stitching() {
        use export::{NeedReason, PageState};
        let mut failed = Failures::new();
        failed.insert(2, Failure { text_hash: "b".into(), message: "bad".into() });
        let same = vec![page(2, PageState::Needs(NeedReason::Missing), "b")];
        assert_eq!(next_step(&same, &failed), Step::Fail(vec![2]));
        // Edited since it failed: tried again rather than reported.
        let edited = vec![page(2, PageState::Needs(NeedReason::Edited), "c")];
        assert_eq!(next_step(&edited, &failed), Step::Synthesize(vec![2]));
    }

    #[test]
    fn the_run_s_claim_frees_the_slot_however_it_ends() {
        let active = ActiveConversion::default();
        let claim = convert::claim_export(&active.0, "p1").unwrap();
        claim.set_page(3);
        assert!(convert::claim_export(&active.0, "p1").is_err());
        // An early return drops the claim exactly as the task's end does.
        fn fails_early(_held: ConversionClaim) -> Result<(), String> {
            Err("storage failed".to_string())
        }
        assert!(fails_early(claim).is_err());
        assert!(active.0.lock().unwrap().is_none());
    }
}
