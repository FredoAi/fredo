//! App-open transport (Spec #2893 ST-4).
//!
//! `fredo open-app <IDENTITY>` connects to the running app over the local IPC
//! pipe and routes through THIS module. The Rust side NEVER resolves identities
//! itself — there is exactly ONE resolution rule and it lives in the webview
//! (R-2.7). The server:
//!
//! 1. registers a pending request keyed by a fresh request id,
//! 2. emits `app-open-request` to the main window (`app.emit_to("main", …)`),
//! 3. waits a BOUNDED 5 s for the frontend's `confirm_app_open_request`,
//! 4. translates the confirmed outcome into the CLI response (exit 0 on
//!    `opened`, exit 1 with machine-readable data otherwise; app-not-running
//!    stays the unchanged exit-2 fallback in `cli::run_async`).
//!
//! The companion path reuses the same kernel opener: `run_open_app_cli` is a
//! thin spawn/bound/parse seam that runs `current_exe() ["open-app", identity]`
//! with a 10 s bound and reports the child's outcome. It never opens a window
//! itself.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::infrastructure::ipc::CliResponse;

/// Tauri event carrying one app-open request from the server to the main window.
pub const APP_OPEN_REQUEST_EVENT: &str = "app-open-request";

/// How long the IPC dispatch waits for the frontend to confirm a request before
/// degrading to `unavailable` (R-2.4 — the CLI never blocks unbounded).
pub const APP_OPEN_CONFIRM_TIMEOUT: Duration = Duration::from_secs(5);

/// How long `run_open_app_cli` waits for the spawned CLI child before killing
/// it and degrading to `unavailable`.
pub const APP_OPEN_CLI_TIMEOUT: Duration = Duration::from_secs(10);

/// Upper bound on in-flight pending requests. On overflow the oldest request is
/// evicted (its waiter resolves `unavailable`), so the registry can never grow
/// without bound.
pub const MAX_PENDING_APP_OPEN_REQUESTS: usize = 64;

// ── Wire vocabulary ───────────────────────────────────────────────────────────

/// The outcome vocabulary shared by the CLI, the IPC response, and the
/// frontend's `confirm_app_open_request` call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppOpenOutcome {
    /// Resolved uniquely — the window was opened/raised.
    Opened,
    /// No registered app matched the spoken name.
    Unknown,
    /// More than one registered app matched the spoken name.
    Ambiguous,
    /// The request could not be confirmed in time (or nothing could open it).
    Unavailable,
}

/// The request emitted to the main window. Serialized camelCase to match the
/// frontend's event payload contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppOpenRequest {
    pub request_id: String,
    pub identity: String,
}

/// The frontend's structured answer to one [`AppOpenRequest`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppOpenConfirmation {
    pub outcome: AppOpenOutcome,
    pub message: Option<String>,
    pub display_name: Option<String>,
    pub spoken_name: Option<String>,
    pub candidates: Option<Vec<String>>,
}

impl AppOpenConfirmation {
    /// Convenience constructor for the success outcome.
    pub fn opened(display_name: impl Into<String>) -> Self {
        Self {
            outcome: AppOpenOutcome::Opened,
            message: None,
            display_name: Some(display_name.into()),
            spoken_name: None,
            candidates: None,
        }
    }
}

/// Result of running `fredo open-app <identity>` as a child process, returned to
/// the webview by [`run_open_app_cli`]. Serialized camelCase across IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAppCliResult {
    pub exit_code: i32,
    pub outcome: AppOpenOutcome,
    pub message: Option<String>,
}

// ── Pending-request registry ──────────────────────────────────────────────────

#[derive(Debug, Default)]
struct AppOpenRegistryInner {
    pending: HashMap<String, oneshot::Sender<AppOpenConfirmation>>,
    order: VecDeque<String>,
}

/// The pending app-open request registry, managed as Tauri state. A request id
/// is registered by the IPC dispatcher and confirmed exactly once by the
/// webview through [`confirm_app_open_request`].
#[derive(Debug, Default)]
pub struct AppOpenRegistry {
    inner: Mutex<AppOpenRegistryInner>,
}

impl AppOpenRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a pending request and return the receiver the dispatcher awaits.
    /// Evicts the oldest pending request when [`MAX_PENDING_APP_OPEN_REQUESTS`]
    /// is exceeded.
    pub fn register(&self, request_id: String) -> oneshot::Receiver<AppOpenConfirmation> {
        let (tx, rx) = oneshot::channel();
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        while inner.order.len() >= MAX_PENDING_APP_OPEN_REQUESTS {
            match inner.order.pop_front() {
                Some(oldest) => {
                    inner.pending.remove(&oldest);
                }
                None => break,
            }
        }
        inner.pending.insert(request_id.clone(), tx);
        inner.order.push_back(request_id);
        rx
    }

    /// Confirm a pending request by id. `Err` when no request is pending (the
    /// waiter already timed out or the id was never registered).
    pub fn confirm(
        &self,
        request_id: &str,
        confirmation: AppOpenConfirmation,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match inner.pending.remove(request_id) {
            Some(tx) => {
                inner.order.retain(|id| id != request_id);
                tx.send(confirmation).map_err(|_| {
                    format!("App-open request \"{request_id}\" is no longer waiting")
                })
            }
            None => Err(format!(
                "No pending app-open request with id \"{request_id}\""
            )),
        }
    }

    /// Drop a pending request — idempotent cleanup for the timeout path.
    pub fn remove(&self, request_id: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.pending.remove(request_id);
        inner.order.retain(|id| id != request_id);
    }

    /// Number of requests currently awaiting confirmation.
    pub fn pending_len(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending
            .len()
    }
}

fn next_request_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("app-open-{millis}-{n}")
}

// ── IPC dispatch ──────────────────────────────────────────────────────────────

/// Handle one `CliCommand::OpenApp` from the IPC server: emit the request to the
/// main window, wait (bounded) for the frontend confirmation, and translate it
/// into the CLI response.
pub async fn dispatch_open_app(identity: String, app: &AppHandle) -> CliResponse {
    let registry = app.state::<AppOpenRegistry>();
    let request_id = next_request_id();
    let rx = registry.register(request_id.clone());

    let request = AppOpenRequest {
        request_id: request_id.clone(),
        identity: identity.clone(),
    };

    if let Err(error) = app.emit_to("main", APP_OPEN_REQUEST_EVENT, &request) {
        registry.remove(&request_id);
        tracing::warn!(
            target: "fredo::app_open",
            error = %error,
            "failed to emit app-open-request to the main window"
        );
        return unavailable_response(&identity, None);
    }

    match tokio::time::timeout(APP_OPEN_CONFIRM_TIMEOUT, rx).await {
        Ok(Ok(confirmation)) => {
            registry.remove(&request_id);
            response_from_confirmation(confirmation)
        }
        Ok(Err(_)) => {
            // The sender was dropped (evicted by the registry bound).
            registry.remove(&request_id);
            unavailable_response(&identity, None)
        }
        Err(_) => {
            registry.remove(&request_id);
            tracing::warn!(
                target: "fredo::app_open",
                identity = %identity,
                "app-open request was not confirmed within the bound"
            );
            unavailable_response(&identity, None)
        }
    }
}

/// Build the CLI response for a frontend confirmation.
pub fn response_from_confirmation(confirmation: AppOpenConfirmation) -> CliResponse {
    let mut data = serde_json::Map::new();
    data.insert("outcome".into(), serde_json::json!(confirmation.outcome));
    if let Some(display_name) = confirmation.display_name {
        data.insert("displayName".into(), serde_json::Value::String(display_name));
    }
    if let Some(spoken_name) = confirmation.spoken_name {
        data.insert("spokenName".into(), serde_json::Value::String(spoken_name));
    }
    if let Some(candidates) = confirmation.candidates {
        data.insert("candidates".into(), serde_json::json!(candidates));
    }
    let data = serde_json::Value::Object(data);

    if confirmation.outcome == AppOpenOutcome::Opened {
        CliResponse::ok(data)
    } else {
        CliResponse {
            ok: false,
            message: confirmation.message,
            data: Some(data),
        }
    }
}

/// Build the `unavailable` CLI response (emit failure / confirm timeout).
pub fn unavailable_response(identity: &str, message: Option<String>) -> CliResponse {
    CliResponse {
        ok: false,
        message: message.or_else(|| {
            Some(format!(
                "App-open request for \"{identity}\" was not confirmed by the running app"
            ))
        }),
        data: Some(serde_json::json!({
            "outcome": AppOpenOutcome::Unavailable,
            "spokenName": identity,
        })),
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Confirm a pending app-open request with the frontend's resolved outcome.
#[tauri::command]
pub fn confirm_app_open_request(
    registry: tauri::State<'_, AppOpenRegistry>,
    request_id: String,
    outcome: AppOpenOutcome,
    message: Option<String>,
    display_name: Option<String>,
    spoken_name: Option<String>,
    candidates: Option<Vec<String>>,
) -> Result<(), String> {
    registry.confirm(
        &request_id,
        AppOpenConfirmation {
            outcome,
            message,
            display_name,
            spoken_name,
            candidates,
        },
    )
}

/// Thin spawn/bound/parse seam for the companion path: run the shipped CLI
/// (`current_exe() ["open-app", identity]`) and report its result. Never opens
/// a window itself.
#[tauri::command]
pub async fn run_open_app_cli(identity: String) -> Result<OpenAppCliResult, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Failed to resolve the Fredo executable: {e}"))?;

    let child = tokio::process::Command::new(exe)
        .arg("open-app")
        .arg(&identity)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to spawn `fredo open-app`: {e}"))?;

    match tokio::time::timeout(APP_OPEN_CLI_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => {
            let exit_code = output.status.code().unwrap_or(-1);
            Ok(parse_open_app_result(exit_code, &output.stdout, &output.stderr))
        }
        Ok(Err(e)) => Err(format!("`fredo open-app` failed: {e}")),
        Err(_) => Err(format!(
            "`fredo open-app {identity}` exceeded the {} s bound",
            APP_OPEN_CLI_TIMEOUT.as_secs()
        )),
    }
}

/// Parse a finished `fredo open-app` child into the typed result. Pure (bytes +
/// exit code in, result out) so the exit-code/outcome mapping is unit-testable.
pub fn parse_open_app_result(exit_code: i32, stdout: &[u8], stderr: &[u8]) -> OpenAppCliResult {
    let stdout_text = String::from_utf8_lossy(stdout);
    let parsed: Option<serde_json::Value> = serde_json::from_str(stdout_text.trim()).ok();

    let outcome = parsed
        .as_ref()
        .and_then(|value| value.get("outcome"))
        .and_then(|value| serde_json::from_value::<AppOpenOutcome>(value.clone()).ok())
        .unwrap_or(match exit_code {
            0 => AppOpenOutcome::Opened,
            _ => AppOpenOutcome::Unavailable,
        });

    let message = parsed
        .as_ref()
        .and_then(|value| value.get("displayName"))
        .and_then(|value| value.as_str())
        .map(|display_name| format!("Opening {display_name}"))
        .or_else(|| {
            let stderr_text = String::from_utf8_lossy(stderr);
            let trimmed = stderr_text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        });

    OpenAppCliResult {
        exit_code,
        outcome,
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn outcome_serializes_to_the_wire_vocabulary() {
        for (outcome, expected) in [
            (AppOpenOutcome::Opened, "opened"),
            (AppOpenOutcome::Unknown, "unknown"),
            (AppOpenOutcome::Ambiguous, "ambiguous"),
            (AppOpenOutcome::Unavailable, "unavailable"),
        ] {
            assert_eq!(
                serde_json::to_value(outcome).expect("outcome serializes"),
                serde_json::json!(expected)
            );
        }
    }

    #[test]
    fn request_serializes_camel_case() {
        let request = AppOpenRequest {
            request_id: "req-1".into(),
            identity: "Mission Monitor".into(),
        };
        assert_eq!(
            serde_json::to_value(&request).expect("request serializes"),
            serde_json::json!({ "requestId": "req-1", "identity": "Mission Monitor" })
        );
    }

    #[test]
    fn response_for_opened_is_ok_with_display_name() {
        let response = response_from_confirmation(AppOpenConfirmation::opened("Mission Monitor"));
        assert!(response.ok, "opened maps to a successful CLI response");
        assert_eq!(
            response.data,
            Some(serde_json::json!({ "outcome": "opened", "displayName": "Mission Monitor" }))
        );
    }

    #[test]
    fn response_for_unknown_is_error_with_spoken_name() {
        let response = response_from_confirmation(AppOpenConfirmation {
            outcome: AppOpenOutcome::Unknown,
            message: Some("unknown".into()),
            display_name: None,
            spoken_name: Some("Narnia".into()),
            candidates: None,
        });
        assert!(!response.ok, "unknown maps to a failing CLI response");
        assert_eq!(
            response.data,
            Some(serde_json::json!({ "outcome": "unknown", "spokenName": "Narnia" }))
        );
    }

    #[test]
    fn response_for_ambiguous_carries_candidates() {
        let response = response_from_confirmation(AppOpenConfirmation {
            outcome: AppOpenOutcome::Ambiguous,
            message: None,
            display_name: None,
            spoken_name: Some("monitor".into()),
            candidates: Some(vec!["Mission Monitor".into(), "Monitor Two".into()]),
        });
        assert!(!response.ok);
        assert_eq!(
            response.data,
            Some(serde_json::json!({
                "outcome": "ambiguous",
                "spokenName": "monitor",
                "candidates": ["Mission Monitor", "Monitor Two"],
            }))
        );
    }

    #[test]
    fn unavailable_response_carries_identity() {
        let response = unavailable_response("mission-monitor", None);
        assert!(!response.ok);
        assert_eq!(
            response.data,
            Some(serde_json::json!({ "outcome": "unavailable", "spokenName": "mission-monitor" }))
        );
    }

    // ── Registry bounds ───────────────────────────────────────────────────────

    #[test]
    fn registry_confirm_delivers_outcome_to_waiter() {
        let registry = AppOpenRegistry::new();
        let receiver = registry.register("req-1".into());
        let confirmation = AppOpenConfirmation {
            outcome: AppOpenOutcome::Unknown,
            message: None,
            display_name: None,
            spoken_name: Some("Narnia".into()),
            candidates: None,
        };

        registry
            .confirm("req-1", confirmation.clone())
            .expect("a registered request confirms");

        assert_eq!(
            receiver.blocking_recv().expect("confirmation delivered"),
            confirmation
        );
        assert_eq!(registry.pending_len(), 0, "confirmed requests are removed");
    }

    #[test]
    fn registry_confirm_unknown_request_is_error() {
        let registry = AppOpenRegistry::new();
        let error = registry
            .confirm("missing", AppOpenConfirmation::opened("x"))
            .expect_err("an unregistered request id must be rejected");
        assert!(error.contains("missing"));
    }

    #[test]
    fn registry_remove_drops_pending_request() {
        let registry = AppOpenRegistry::new();
        let mut receiver = registry.register("req-timeout".into());
        assert_eq!(registry.pending_len(), 1);
        registry.remove("req-timeout");
        assert_eq!(registry.pending_len(), 0);
        assert!(
            receiver.try_recv().is_err(),
            "a removed request can no longer be confirmed"
        );
    }

    #[test]
    fn registry_evicts_oldest_when_bound_exceeded() {
        let registry = AppOpenRegistry::new();
        let mut receivers: Vec<_> = (0..MAX_PENDING_APP_OPEN_REQUESTS)
            .map(|i| registry.register(format!("req-{i}")))
            .collect();
        assert_eq!(registry.pending_len(), MAX_PENDING_APP_OPEN_REQUESTS);

        let mut overflow = registry.register("req-overflow".into());
        assert_eq!(
            registry.pending_len(),
            MAX_PENDING_APP_OPEN_REQUESTS,
            "the registry never exceeds its bound"
        );

        // The OLDEST request was evicted: its sender was dropped, so the
        // receiver reports a closed channel even though it was never confirmed.
        assert!(matches!(
            receivers.remove(0).try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Closed)
        ));

        // The newest request is live and confirmable.
        registry
            .confirm("req-overflow", AppOpenConfirmation::opened("Mission Monitor"))
            .expect("the newest request stays pending");
        assert_eq!(
            overflow.try_recv().expect("newest confirmed").outcome,
            AppOpenOutcome::Opened
        );
    }

    // ── CLI child parse / exit-code mapping ───────────────────────────────────

    #[test]
    fn parse_open_app_result_maps_success() {
        let result = parse_open_app_result(
            0,
            br#"{"outcome":"opened","displayName":"Mission Monitor"}"#,
            b"",
        );
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.outcome, AppOpenOutcome::Opened);
        assert_eq!(result.message.as_deref(), Some("Opening Mission Monitor"));
    }

    #[test]
    fn parse_open_app_result_maps_unknown_failure() {
        let result = parse_open_app_result(1, br#"{"outcome":"unknown","spokenName":"Narnia"}"#, b"");
        assert_eq!(result.exit_code, 1);
        assert_eq!(result.outcome, AppOpenOutcome::Unknown);
    }

    #[test]
    fn parse_open_app_result_maps_not_running_to_unavailable() {
        let result = parse_open_app_result(2, b"", b"Fredo app is not running.\n");
        assert_eq!(result.exit_code, 2);
        assert_eq!(result.outcome, AppOpenOutcome::Unavailable);
        assert_eq!(result.message.as_deref(), Some("Fredo app is not running."));
    }

    #[test]
    fn parse_open_app_result_fails_closed_on_garbage_stdout() {
        // No parseable outcome + a non-zero exit must NEVER be treated as opened.
        let result = parse_open_app_result(1, b"not json", b"");
        assert_eq!(result.outcome, AppOpenOutcome::Unavailable);
    }

    // ── CLI surface ───────────────────────────────────────────────────────────

    #[test]
    fn open_app_args_accept_one_positional_identity() {
        use crate::infrastructure::cli::commands::open_app::OpenAppArgs;

        for raw in ["mission-monitor", "Mission Monitor", "OPEN MISSION MONITOR"] {
            let args: OpenAppArgs = OpenAppArgs::try_parse_from(["open-app", raw])
                .unwrap_or_else(|e| panic!("identity {raw:?} must parse: {e}"));
            assert_eq!(args.identity, raw, "the identity is carried verbatim");
        }
    }

    #[test]
    fn open_app_args_reject_missing_or_extra_positionals() {
        use crate::infrastructure::cli::commands::open_app::OpenAppArgs;

        assert!(
            OpenAppArgs::try_parse_from(["open-app"]).is_err(),
            "the identity positional is required"
        );
        assert!(
            OpenAppArgs::try_parse_from(["open-app", "a", "b"]).is_err(),
            "only ONE positional is accepted"
        );
    }
}
