//! Python sidecar supervisor (M0 harness).
//!
//! Spawns the bundled FastAPI sidecar, parses its one-line stdout handshake to
//! learn the ephemeral loopback port, confirms readiness via `/health`, and
//! restarts it on crash. Every request carries a per-spawn bearer token. The
//! frontend never talks to the sidecar directly — it calls the `sidecar_health`
//! command, which proxies to `/health` so the port and token stay internal.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use rand::RngCore;
use serde::Deserialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const TOKEN_ENV: &str = "HEARBOOK_SIDECAR_TOKEN";
const HOST_ENV: &str = "HEARBOOK_SIDECAR_HOST";
const LOOPBACK: &str = "127.0.0.1";

/// Give up restarting after this many consecutive *failed-to-start* attempts
/// (a sidecar that ran healthy and later died does not count toward this).
const MAX_STARTUP_FAILURES: u32 = 5;
const BACKOFF_START: Duration = Duration::from_millis(500);
const BACKOFF_CAP: Duration = Duration::from_secs(5);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);

/// Managed application state for the sidecar harness.
pub struct SidecarState {
    inner: Mutex<Inner>,
    token: String,
    http: reqwest::Client,
    shutting_down: AtomicBool,
}

#[derive(Default)]
struct Inner {
    /// The current ephemeral port, or `None` while (re)starting.
    port: Option<u16>,
    /// The live child handle, taken and killed on app exit.
    child: Option<CommandChild>,
}

/// The JSON line the sidecar prints to stdout once listening (or on failure).
#[derive(Debug, Deserialize)]
struct Handshake {
    ready: bool,
    port: Option<u16>,
    #[serde(default)]
    error: Option<String>,
}

enum Outcome {
    /// Became healthy at least once before terminating.
    RanHealthy,
    /// Never reached a healthy state.
    FailedToStart,
}

impl SidecarState {
    pub fn new() -> Self {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let token = bytes.iter().map(|b| format!("{b:02x}")).collect();

        let http = reqwest::Client::builder()
            .timeout(HEALTH_TIMEOUT)
            .build()
            .expect("failed to build reqwest client");

        Self {
            inner: Mutex::new(Inner::default()),
            token,
            http,
            shutting_down: AtomicBool::new(false),
        }
    }

    /// Signal the supervisor to stop and kill the running child. Called on exit.
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        if let Some(child) = self.inner.lock().unwrap().child.take() {
            let _ = child.kill();
        }
    }
}

/// Launch the supervision loop on the async runtime. Returns immediately.
pub fn spawn_supervisor(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut backoff = BACKOFF_START;
        let mut startup_failures = 0u32;

        loop {
            if app
                .state::<SidecarState>()
                .shutting_down
                .load(Ordering::SeqCst)
            {
                break;
            }

            match run_once(&app).await {
                Outcome::RanHealthy => {
                    // A previously-healthy sidecar died; treat as transient and
                    // reset the crash-loop guard.
                    startup_failures = 0;
                    backoff = BACKOFF_START;
                }
                Outcome::FailedToStart => {
                    startup_failures += 1;
                    if startup_failures >= MAX_STARTUP_FAILURES {
                        eprintln!(
                            "[sidecar] giving up after {startup_failures} failed starts"
                        );
                        break;
                    }
                }
            }

            // Clear the port so `sidecar_health` reports "starting" during the gap.
            app.state::<SidecarState>().inner.lock().unwrap().port = None;

            if app
                .state::<SidecarState>()
                .shutting_down
                .load(Ordering::SeqCst)
            {
                break;
            }

            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(BACKOFF_CAP);
        }
    });
}

/// Run a single sidecar lifetime: spawn, handshake, health-check, supervise
/// until it terminates. Returns whether it ever became healthy.
async fn run_once(app: &AppHandle) -> Outcome {
    let token = app.state::<SidecarState>().token.clone();

    let command = match build_command(app, &token) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[sidecar] failed to build command: {e}");
            return Outcome::FailedToStart;
        }
    };

    let (mut rx, child) = match command.spawn() {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("[sidecar] spawn failed: {e}");
            return Outcome::FailedToStart;
        }
    };

    app.state::<SidecarState>().inner.lock().unwrap().child = Some(child);

    let mut became_healthy = false;
    let mut stdout_buf = String::new();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                stdout_buf.push_str(&String::from_utf8_lossy(&bytes));
                // The handshake is a single newline-terminated JSON line; a chunk
                // may carry several lines, so drain complete lines from the buffer.
                while let Some(nl) = stdout_buf.find('\n') {
                    let line = stdout_buf[..nl].trim().to_string();
                    stdout_buf.drain(..=nl);
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(hs) = serde_json::from_str::<Handshake>(&line) {
                        if hs.ready {
                            if let Some(port) = hs.port {
                                app.state::<SidecarState>().inner.lock().unwrap().port =
                                    Some(port);
                                if poll_health(app, port).await {
                                    became_healthy = true;
                                    eprintln!("[sidecar] ready on 127.0.0.1:{port}");
                                }
                            }
                        } else {
                            eprintln!(
                                "[sidecar] startup error: {}",
                                hs.error.unwrap_or_else(|| "unknown".into())
                            );
                        }
                    } else {
                        // Non-handshake output (uvicorn logs etc.) — forward for debugging.
                        eprintln!("[sidecar] {line}");
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                let line = line.trim();
                if !line.is_empty() {
                    eprintln!("[sidecar:err] {line}");
                }
            }
            CommandEvent::Error(e) => {
                eprintln!("[sidecar] process error: {e}");
            }
            CommandEvent::Terminated(payload) => {
                eprintln!("[sidecar] terminated: {payload:?}");
                break;
            }
            _ => {}
        }
    }

    // The child is gone (or being killed on shutdown); drop our handle.
    app.state::<SidecarState>().inner.lock().unwrap().child = None;

    if became_healthy {
        Outcome::RanHealthy
    } else {
        Outcome::FailedToStart
    }
}

/// Build the spawn command: `uv run` in dev, the frozen externalBin in release.
fn build_command(
    app: &AppHandle,
    token: &str,
) -> Result<tauri_plugin_shell::process::Command, String> {
    let shell = app.shell();

    #[cfg(debug_assertions)]
    let command = {
        // Dev: run from the uv-managed venv. The sidecar source lives next to
        // src-tauri; CARGO_MANIFEST_DIR is the dev machine's src-tauri path.
        let sidecar_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecar");
        shell
            .command("uv")
            .args(["run", "python", "server.py"])
            .current_dir(sidecar_dir)
    };

    #[cfg(not(debug_assertions))]
    let command = shell
        .sidecar("hearbook-sidecar")
        .map_err(|e| e.to_string())?;

    Ok(command
        .env(TOKEN_ENV, token)
        .env(HOST_ENV, LOOPBACK)
        .env("PYTHONUNBUFFERED", "1"))
}

/// Confirm `/health` answers 200 with the bearer token. Retries briefly to cover
/// the gap between "socket bound" and "serving requests".
async fn poll_health(app: &AppHandle, port: u16) -> bool {
    let (client, token) = {
        let state = app.state::<SidecarState>();
        (state.http.clone(), state.token.clone())
    };
    let url = format!("http://{LOOPBACK}:{port}/health");
    for _ in 0..10 {
        if let Ok(resp) = client.get(&url).bearer_auth(&token).send().await {
            if resp.status().is_success() {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    false
}

/// Fetch the sidecar's `/health` with the bearer token. Shared by the command
/// and any internal caller; the port and token never leave Rust.
async fn query_health(state: &SidecarState) -> Result<serde_json::Value, String> {
    let port = match state.inner.lock().unwrap().port {
        Some(p) => p,
        None => return Err("sidecar starting".into()),
    };

    let url = format!("http://{LOOPBACK}:{port}/health");
    let resp = state
        .http
        .get(&url)
        .bearer_auth(&state.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("health check returned {}", resp.status()));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Suffix the JSON helpers put on the error for a sidecar 404, so a caller can
/// tell "no such job" from a transport failure without parsing a status line.
/// The sidecar answers 404 both for a job id it never had and for one its
/// bounded registry has since pruned — one condition, one branch.
const NOT_FOUND: &str = "not found";

/// Whether an error from the JSON helpers was the sidecar's 404.
pub fn is_not_found(err: &str) -> bool {
    err.ends_with(NOT_FOUND)
}

fn port_of(state: &SidecarState) -> Result<u16, String> {
    state
        .inner
        .lock()
        .unwrap()
        .port
        .ok_or_else(|| "sidecar starting".to_string())
}

async fn read_json(resp: reqwest::Response, route: &str) -> Result<serde_json::Value, String> {
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("{route} {NOT_FOUND}"));
    }
    if !resp.status().is_success() {
        return Err(format!("{route} returned {}", resp.status()));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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

/// Proxy to the sidecar's `/health`. The frontend calls this to verify the
/// backend is up.
#[tauri::command]
pub async fn sidecar_health(
    state: State<'_, SidecarState>,
) -> Result<serde_json::Value, String> {
    query_health(&state).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sidecar_404_is_recognisable_as_not_found() {
        assert!(is_not_found(&format!("/jobs/abc {NOT_FOUND}")));
    }

    #[test]
    fn other_failures_are_not_mistaken_for_not_found() {
        assert!(!is_not_found("/jobs/abc returned 500 Internal Server Error"));
        assert!(!is_not_found("sidecar starting"));
        assert!(!is_not_found("error sending request for url"));
    }
}
