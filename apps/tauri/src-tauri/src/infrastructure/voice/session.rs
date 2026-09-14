// SPIKE #2876 — THROWAWAY POC — replaced by #2877/#2878
//!
//! One-session STT state machine + the recognition loop.
//!
//! `start` gates on the persisted voice preference, an already-active session,
//! and model presence, then starts a dedicated worker thread that lazily loads
//! the engine (never at app launch), opens the `cpal` capture stream, and drives
//! `stt:transcript` / `stt:state` events. `stop` commits the final partial;
//! `cancel` discards it. Every failure is a typed `VoiceError` — no panics
//! (R-5.6).

use std::path::Path;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::infrastructure::companion::models::{
    describe_file, resolve_models_dir, FileState, ModelManifest,
};
use crate::infrastructure::storage::AppStore;
use crate::infrastructure::voice::capture::{self, AudioMsg};
use crate::infrastructure::voice::engine::{self, Recognizer};
use crate::infrastructure::voice::manifest::resolve_stt_manifest;
use crate::infrastructure::voice::state::{
    SttErrorCode, SttStartResult, SttStateEvent, SttTranscriptEvent, VoiceError,
};

/// Persisted Companion preference (written by the ST-5 toggle, DEFAULT false).
pub const VOICE_ENABLED_KEY: &str = "Fredo_companion_voice_enabled";

/// Budget for engine load + capture open before `stt_start` gives up.
const START_TIMEOUT: Duration = Duration::from_secs(30);

/// Device facts reported back by the worker once it is ready.
#[derive(Clone, Debug)]
pub struct StartInfo {
    pub device_name: String,
    pub device_sample_rate: u32,
}

/// Event sink seam: the real path emits Tauri control-plane events; ST-6 can
/// inject a recording sink for hermetic session tests.
pub trait TranscriptSink: Send + Sync {
    fn transcript(&self, event: SttTranscriptEvent);
    fn state(&self, event: SttStateEvent);
}

/// Emits `stt:transcript` / `stt:state` via `AppHandle::emit` (CONTROL PLANE —
/// precedent `features/setup/commands.rs`; never the RTDB `EventBus`).
pub struct AppHandleSink {
    app: AppHandle,
}

impl AppHandleSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl TranscriptSink for AppHandleSink {
    fn transcript(&self, event: SttTranscriptEvent) {
        if let Err(error) = self.app.emit("stt:transcript", &event) {
            tracing::debug!("failed to emit stt:transcript: {error}");
        }
    }

    fn state(&self, event: SttStateEvent) {
        if let Err(error) = self.app.emit("stt:state", &event) {
            tracing::debug!("failed to emit stt:state: {error}");
        }
    }
}

struct ActiveSession {
    origin: String,
    control_tx: Sender<AudioMsg>,
    worker: std::thread::JoinHandle<()>,
}

/// Tauri-managed session state (Send + Sync: only Send fields inside a Mutex).
pub struct VoiceState {
    inner: Mutex<Option<ActiveSession>>,
}

impl VoiceState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

impl Default for VoiceState {
    fn default() -> Self {
        Self::new()
    }
}

fn lock_inner(state: &VoiceState) -> MutexGuard<'_, Option<ActiveSession>> {
    match state.inner.lock() {
        Ok(guard) => guard,
        // A poisoned lock still carries the session slot; recover instead of
        // panicking (R-5.6).
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Tolerant boolean parse for the persisted preference ("true"/"1" ⇒ enabled).
pub(crate) fn parse_enabled(value: Option<&str>) -> bool {
    matches!(
        value.map(str::trim),
        Some("true") | Some("True") | Some("TRUE") | Some("1")
    )
}

fn voice_enabled(app: &AppHandle) -> bool {
    let value = app
        .state::<std::sync::Arc<AppStore>>()
        .get(VOICE_ENABLED_KEY)
        .ok()
        .flatten();
    parse_enabled(value.as_deref())
}

/// Typed model gate: absent ⇒ `ModelMissing`; partial/oversize ⇒ `ModelCorrupt`
/// (R-5.4). Uses the shared `describe_file`/`classify_file` size rule (NFR-6).
pub(crate) fn model_error(models_dir: &Path, manifest: &ModelManifest) -> Option<VoiceError> {
    for spec in &manifest.files {
        let status = describe_file(models_dir, manifest, spec);
        match status.state {
            FileState::Present => {}
            FileState::Error => {
                return Some(VoiceError::model_corrupt(format!(
                    "{} has an unexpected size ({} of {} bytes)",
                    spec.filename(),
                    status.downloaded_bytes,
                    spec.expected_bytes
                )))
            }
            FileState::Missing | FileState::Downloading => {
                if status.downloaded_bytes > 0 {
                    return Some(VoiceError::model_corrupt(format!(
                        "{} is incomplete ({} of {} bytes)",
                        spec.filename(),
                        status.downloaded_bytes,
                        spec.expected_bytes
                    )));
                }
                return Some(VoiceError::model_missing(format!(
                    "{} is missing — download the STT model from Companion settings.",
                    spec.filename()
                )));
            }
        }
    }
    None
}

fn emit_state(app: &AppHandle, event: &SttStateEvent) {
    AppHandleSink::new(app.clone()).state(event.clone());
}

fn state_event_error(error: &VoiceError, origin: Option<&str>) -> SttStateEvent {
    SttStateEvent {
        listening: false,
        code: Some(error.code),
        detail: Some(error.detail.clone()),
        origin: origin.map(|value| value.to_string()),
    }
}

/// `stt_start`: gate → lazy engine + capture on a worker thread → report ready.
pub async fn start(app: &AppHandle, origin: &str) -> SttStartResult {
    // 1. Disabled gate (R-5.7 backend pin; ST-5 owns the toggle).
    if !voice_enabled(app) {
        let error = VoiceError::disabled();
        emit_state(app, &state_event_error(&error, Some(origin)));
        return error.into_start_result();
    }

    // 2. Already-listening gate.
    {
        let state = app.state::<VoiceState>();
        let guard = lock_inner(&state);
        if guard.is_some() {
            let error = VoiceError::already_listening();
            emit_state(app, &state_event_error(&error, Some(origin)));
            return error.into_start_result();
        }
    }

    // 3. Model presence gate.
    let manifest = resolve_stt_manifest();
    let models_dir = resolve_models_dir(app);
    if let Some(error) = model_error(&models_dir, &manifest) {
        emit_state(app, &state_event_error(&error, Some(origin)));
        return error.into_start_result();
    }

    // 4. Worker owns the engine AND the `cpal::Stream` (both stay on one thread).
    let (tx, rx) = mpsc::channel::<AudioMsg>();
    let (outcome_tx, outcome_rx) =
        tokio::sync::oneshot::channel::<Result<StartInfo, VoiceError>>();
    let session_id = uuid::Uuid::new_v4().to_string();
    let worker_app = app.clone();
    let worker_tx = tx.clone();
    let worker = match std::thread::Builder::new()
        .name("fredo-stt".to_string())
        .spawn(move || {
            worker_main(worker_app, session_id, models_dir, rx, worker_tx, outcome_tx);
        }) {
        Ok(handle) => handle,
        Err(error) => {
            let error = VoiceError::internal(format!("failed to spawn the voice worker: {error}"));
            emit_state(app, &state_event_error(&error, Some(origin)));
            return error.into_start_result();
        }
    };

    // 5. Await readiness off the main thread (engine load is the slow part).
    let outcome = match tokio::time::timeout(START_TIMEOUT, outcome_rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_recv)) => Err(VoiceError::internal(
            "the voice worker exited before reporting readiness",
        )),
        Err(_elapsed) => {
            let _ = tx.send(AudioMsg::Cancel);
            Err(VoiceError::new(
                SttErrorCode::EngineStartFailed,
                "timed out while loading the STT engine",
            ))
        }
    };

    match outcome {
        Ok(info) => {
            {
                let state = app.state::<VoiceState>();
                *lock_inner(&state) = Some(ActiveSession {
                    origin: origin.to_string(),
                    control_tx: tx,
                    worker,
                });
            }
            emit_state(
                app,
                &SttStateEvent {
                    listening: true,
                    code: None,
                    detail: None,
                    origin: Some(origin.to_string()),
                },
            );
            SttStartResult {
                started: true,
                code: None,
                detail: None,
                device_name: Some(info.device_name),
                sample_rate: Some(info.device_sample_rate),
            }
        }
        Err(error) => {
            let _ = worker.join();
            emit_state(app, &state_event_error(&error, Some(origin)));
            error.into_start_result()
        }
    }
}

/// `stt_stop` / `stt_cancel`: signal the worker, join it, and report idle.
async fn finish(app: &AppHandle, message: AudioMsg) -> SttStateEvent {
    let session = {
        let state = app.state::<VoiceState>();
        let mut guard = lock_inner(&state);
        guard.take()
    };
    let origin = session.as_ref().map(|session| session.origin.clone());

    if let Some(session) = session {
        let ActiveSession {
            control_tx, worker, ..
        } = session;
        let _ = control_tx.send(message);
        // Join off the async runtime thread: the worker flushes (stop) or
        // discards (cancel) before this resolves, so the final transcript is
        // emitted BEFORE the `listening:false` state event.
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let _ = worker.join();
        })
        .await;
    }

    let event = SttStateEvent {
        listening: false,
        code: None,
        detail: None,
        origin,
    };
    emit_state(app, &event);
    event
}

/// `stt_stop` — commit the final partial.
pub async fn stop(app: &AppHandle) -> SttStateEvent {
    finish(app, AudioMsg::Stop).await
}

/// `stt_cancel` — discard the current partial.
pub async fn cancel(app: &AppHandle) -> SttStateEvent {
    finish(app, AudioMsg::Cancel).await
}

/// `stt_status` — read the current listening state.
pub fn status(app: &AppHandle) -> SttStateEvent {
    let state = app.state::<VoiceState>();
    let guard = lock_inner(&state);
    match guard.as_ref() {
        Some(session) => SttStateEvent {
            listening: true,
            code: None,
            detail: None,
            origin: Some(session.origin.clone()),
        },
        None => SttStateEvent {
            listening: false,
            code: None,
            detail: None,
            origin: None,
        },
    }
}

/// Worker thread body: lazily load the engine, open capture, report readiness,
/// then drive the recognition loop until Stop/Cancel. Owns the recognizer and
/// the `cpal::Stream` for its whole lifetime.
fn worker_main(
    app: AppHandle,
    session_id: String,
    models_dir: PathBuf,
    rx: Receiver<AudioMsg>,
    tx: Sender<AudioMsg>,
    outcome_tx: tokio::sync::oneshot::Sender<Result<StartInfo, VoiceError>>,
) {
    // Lazy engine creation on first start — never at app launch (R-5.1/R-2.1).
    let mut recognizer = match engine::load_recognizer(&models_dir) {
        Ok(recognizer) => recognizer,
        Err(error) => {
            let _ = outcome_tx.send(Err(error));
            return;
        }
    };

    let capture = match capture::start_capture(tx) {
        Ok(capture) => capture,
        Err(error) => {
            let _ = outcome_tx.send(Err(error));
            return;
        }
    };

    let info = StartInfo {
        device_name: capture.device_name.clone(),
        device_sample_rate: capture.device_sample_rate,
    };
    if outcome_tx.send(Ok(info)).is_err() {
        // The caller gave up; drop capture and exit.
        return;
    }

    let sink = AppHandleSink::new(app);
    run_recognition(&sink, &session_id, recognizer.as_mut(), &rx);
    // `capture` (and its device stream) drops here at end of scope.
}

fn elapsed_ms(since: Instant) -> u64 {
    since.elapsed().as_millis() as u64
}

/// The recognition loop: feed chunks, emit strictly-increasing partials per
/// segment, finalize on endpoint / Stop, discard on Cancel (R-3.1/R-3.3).
pub(crate) fn run_recognition(
    sink: &dyn TranscriptSink,
    session_id: &str,
    recognizer: &mut dyn Recognizer,
    rx: &Receiver<AudioMsg>,
) {
    let mut revision: u64 = 0;
    let mut segment_id: u32 = 0;
    let mut current_text = String::new();

    while let Ok(message) = rx.recv() {
        match message {
            AudioMsg::Samples(chunk) => {
                let accepted_at = Instant::now();
                recognizer.accept_waveform(&chunk);
                while recognizer.is_ready() {
                    recognizer.decode();
                    if let Some(text) = recognizer.result_text() {
                        if text != current_text {
                            current_text = text;
                            revision += 1;
                            sink.transcript(SttTranscriptEvent {
                                session_id: session_id.to_string(),
                                revision,
                                segment_id,
                                text: current_text.clone(),
                                is_final: false,
                                latency_ms: elapsed_ms(accepted_at),
                            });
                        }
                    }
                    if recognizer.is_endpoint() {
                        if !current_text.is_empty() {
                            revision += 1;
                            sink.transcript(SttTranscriptEvent {
                                session_id: session_id.to_string(),
                                revision,
                                segment_id,
                                text: current_text.clone(),
                                is_final: true,
                                latency_ms: elapsed_ms(accepted_at),
                            });
                        }
                        recognizer.reset();
                        segment_id = segment_id.wrapping_add(1);
                        current_text.clear();
                    }
                }
            }
            AudioMsg::Stop => {
                let flushed_at = Instant::now();
                recognizer.input_finished();
                while recognizer.is_ready() {
                    recognizer.decode();
                }
                if let Some(text) = recognizer.result_text() {
                    if !text.is_empty() {
                        current_text = text;
                    }
                }
                if !current_text.is_empty() {
                    revision += 1;
                    sink.transcript(SttTranscriptEvent {
                        session_id: session_id.to_string(),
                        revision,
                        segment_id,
                        text: current_text.clone(),
                        is_final: true,
                        latency_ms: elapsed_ms(flushed_at),
                    });
                }
                break;
            }
            AudioMsg::Cancel => break,
        }
    }
}
