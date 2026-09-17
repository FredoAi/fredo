//! One-session STT state machine + the recognition loop.
//!
//! `start` gates on the persisted voice preference, an already-active session,
//! and model presence, then starts a dedicated worker thread that lazily loads
//! the engine (never at app launch), opens the `cpal` capture stream for the
//! persisted input device, and drives `stt:transcript` / `stt:state` events.
//! `stop` commits the final partial; `cancel` discards it. Every failure is a
//! typed `VoiceError` — no panics.

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

/// Persisted Companion preference: the selected input device. The value is a
/// `cpal` device name (`id` from `stt_list_devices`); unset/blank ⇒ the system
/// default.
pub const VOICE_DEVICE_KEY: &str = "Fredo_companion_voice_device_id";

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

/// Parse the persisted device preference: trimmed, blank/unset ⇒ `None` (the
/// system default). Pure, so the "" default is hermetically pinned.
pub(crate) fn parse_device_id(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// The persisted opt-in flag, shared with the resident warm (ST-1/ST-2) so the
/// gate is ONE rule: `warm` and `stt_start` can never disagree about whether
/// voice input is enabled.
pub(crate) fn voice_enabled(app: &AppHandle) -> bool {
    let value = app
        .state::<std::sync::Arc<AppStore>>()
        .get(VOICE_ENABLED_KEY)
        .ok()
        .flatten();
    parse_enabled(value.as_deref())
}

/// The persisted input-device selection, trimmed. Unset or blank resolves to
/// `None` — the system default (the key's documented default is `""`). This is
/// only the KEY lookup: whether the named device still exists is decided by
/// [`capture::start_capture`] against the live device set, so a vanished device
/// is the typed `NoDevice` naming it instead of a silent fallback (AC4).
pub(crate) fn persisted_device(app: &AppHandle) -> Option<String> {
    let value = app
        .state::<std::sync::Arc<AppStore>>()
        .get(VOICE_DEVICE_KEY)
        .ok()
        .flatten();
    parse_device_id(value.as_deref())
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
        // An error path never captured and never consumed a resident engine.
        ready_ms: None,
        engine_resident: false,
    }
}

/// The single builder for a truthful `stt:state`: `listening` is derived from
/// whether a session origin is installed, never hardcoded. `stt_status`, the
/// duplicate-start re-emit and the start success path all derive from this one
/// function, so the read path and the emit path can never disagree (R-5.3/AC5).
fn listening_state(origin: Option<String>) -> SttStateEvent {
    listening_state_with(origin, None, false)
}

/// The truthful `stt:state` builder WITH the timing observables (ST-1):
/// `ready_ms` (start receipt → capture-live) and `engine_resident` (did the
/// session start from the resident slot). ST-3 stamps these on the start-success
/// path; every other path reports `None`/`false`, so residency is never
/// optimistic.
fn listening_state_with(
    origin: Option<String>,
    ready_ms: Option<u64>,
    engine_resident: bool,
) -> SttStateEvent {
    SttStateEvent {
        listening: origin.is_some(),
        code: None,
        detail: None,
        origin,
        ready_ms,
        engine_resident,
    }
}

/// The already-listening gate: `None` when no session is installed (the caller
/// may start), or — when an [`ActiveSession`] IS installed — the unchanged
/// idempotent `alreadyListening` result paired with the TRUE live state of the
/// **ACTIVE** session. Deriving the event from `active.origin` (never the newly
/// requested origin) keeps the live indicator on its correct surface while the
/// microphone keeps capturing. Pure so the duplicate-start contract is
/// hermetically pinned; the caller returns on `Some` before any worker spawn,
/// so no second session, handle, or `cpal::Stream` is ever created (R-4.1).
fn already_listening_outcome(
    active: Option<&ActiveSession>,
) -> Option<(SttStartResult, SttStateEvent)> {
    let active = active?;
    Some((
        VoiceError::already_listening().into_start_result(),
        listening_state(Some(active.origin.clone())),
    ))
}

/// `stt_start`: gate → lazy engine + capture on a worker thread → report ready.
pub async fn start(app: &AppHandle, origin: &str) -> SttStartResult {
    // 1. Disabled gate (R-5.7 backend pin; ST-5 owns the toggle).
    if !voice_enabled(app) {
        let error = VoiceError::disabled();
        emit_state(app, &state_event_error(&error, Some(origin)));
        return error.into_start_result();
    }

    // 2. Already-listening gate. A duplicate start stays idempotent (R-4.1) and
    // MUST NOT emit a false idle: the still-active session keeps its indicator
    // and Stop control until `stt_stop`/`stt_cancel` (R-5.3/AC5). The re-emit
    // carries the ACTIVE session's origin, never the newly requested one.
    {
        let state = app.state::<VoiceState>();
        let guard = lock_inner(&state);
        if let Some((result, event)) = already_listening_outcome(guard.as_ref()) {
            emit_state(app, &event);
            return result;
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
    // The persisted device preference is resolved to a name here, but validated
    // against the live device set inside `capture` on the worker — a vanished
    // device is the typed `NoDevice` naming it (AC4), never a silent fallback.
    let selected_device = persisted_device(app);
    let (tx, rx) = mpsc::channel::<AudioMsg>();
    let (outcome_tx, outcome_rx) =
        tokio::sync::oneshot::channel::<Result<StartInfo, VoiceError>>();
    let session_id = uuid::Uuid::new_v4().to_string();
    let worker_app = app.clone();
    let worker_tx = tx.clone();
    let worker = match std::thread::Builder::new()
        .name("fredo-stt".to_string())
        .spawn(move || {
            worker_main(
                worker_app,
                session_id,
                models_dir,
                selected_device,
                rx,
                worker_tx,
                outcome_tx,
            );
        }) {
        Ok(handle) => handle,
        Err(error) => {
            let error = VoiceError::internal(format!("failed to spawn the voice worker: {error}"));
            emit_state(app, &state_event_error(&error, Some(origin)));
            return error.into_start_result();
        }
    };

    // 5. Await readiness off the main thread (engine load is the slow part).
    // `worker_reported` distinguishes the paths on which the worker has already
    // reported/returned (safe to join) from the timeout path, where the worker
    // may still be blocked inside the native `OnlineRecognizer::create` FFI frame
    // — which no `Cancel` can interrupt (ST-7.2 / F-15).
    let (outcome, worker_reported) = match tokio::time::timeout(START_TIMEOUT, outcome_rx).await {
        Ok(Ok(result)) => (result, true),
        Ok(Err(_recv)) => (
            Err(VoiceError::internal(
                "the voice worker exited before reporting readiness",
            )),
            true,
        ),
        Err(_elapsed) => {
            let _ = tx.send(AudioMsg::Cancel);
            (
                Err(VoiceError::new(
                    SttErrorCode::EngineStartFailed,
                    "timed out while loading the STT engine",
                )),
                false,
            )
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
            emit_state(app, &listening_state(Some(origin.to_string())));
            SttStartResult {
                started: true,
                code: None,
                detail: None,
                device_name: Some(info.device_name),
                sample_rate: Some(info.device_sample_rate),
            }
        }
        Err(error) => {
            // ST-7.2: never join a worker that never reported readiness. A worker
            // blocked inside the native `create` cannot be interrupted, so joining
            // it would hang `stt_start` (the round-1 F-15 wedge) instead of
            // returning the typed failure immediately (R-5.5: app stays
            // responsive). Dropping the handle detaches the worker; the `Cancel`
            // sent above makes it self-terminate if the FFI call ever returns
            // (`outcome_tx.send(..).is_err()` → early return in `worker_main`).
            if worker_reported {
                let _ = worker.join();
            } else {
                drop(worker);
            }
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
        // Idle: no start happened, so there is no readiness to report.
        ready_ms: None,
        engine_resident: false,
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

/// `stt_status` — read the current listening state. Derived from the SAME
/// builder the live `stt:state` emissions use, so the read path and the emit
/// path cannot disagree (R-5.3).
pub fn status(app: &AppHandle) -> SttStateEvent {
    let state = app.state::<VoiceState>();
    let guard = lock_inner(&state);
    match guard.as_ref() {
        Some(session) => listening_state(Some(session.origin.clone())),
        None => listening_state(None),
    }
}

/// Worker thread body: lazily load the engine, open capture for the persisted
/// device, report readiness, then drive the recognition loop until Stop/Cancel.
/// Owns the recognizer and the `cpal::Stream` for its whole lifetime.
fn worker_main(
    app: AppHandle,
    session_id: String,
    models_dir: PathBuf,
    selected_device: Option<String>,
    rx: Receiver<AudioMsg>,
    tx: Sender<AudioMsg>,
    outcome_tx: tokio::sync::oneshot::Sender<Result<StartInfo, VoiceError>>,
) {
    // Lazy engine creation on first start — never at app launch.
    let mut recognizer = match engine::load_recognizer(&models_dir) {
        Ok(recognizer) => recognizer,
        Err(error) => {
            let _ = outcome_tx.send(Err(error));
            return;
        }
    };

    let capture = match capture::start_capture(tx, selected_device.as_deref()) {
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

#[cfg(test)]
mod tests {
    //! Hermetic session pins: the recognition loop's state machine runs against a
    //! scripted [`FakeStep`]-driven [`FakeRecognizer`] — no model, no mic, no
    //! network, no `AppHandle`. The pure gates (`parse_enabled`,
    //! `parse_device_id`, `model_error`) and the full typed failure vocabulary are
    //! pinned here too.

    use super::*;

    use std::collections::VecDeque;

    use crate::infrastructure::companion::models::{file_path, ModelFileSpec};

    /// One decoded step the fake yields: the cumulative hypothesis it would
    /// report (`None` = no hypothesis yet) and whether the segment ended.
    #[derive(Clone, Copy, Debug)]
    struct FakeStep {
        text: Option<&'static str>,
        endpoint: bool,
    }

    impl FakeStep {
        const fn partial(text: &'static str) -> Self {
            Self {
                text: Some(text),
                endpoint: false,
            }
        }

        const fn final_step(text: &'static str) -> Self {
            Self {
                text: Some(text),
                endpoint: true,
            }
        }

        const fn empty() -> Self {
            Self {
                text: None,
                endpoint: false,
            }
        }
    }

    /// Deterministic [`Recognizer`] seam: one scripted step list per accepted
    /// chunk, drained by the recognition loop's `decode` calls. `tail` is what
    /// `input_finished` releases (the trailing flush on Stop).
    struct FakeRecognizer {
        chunks: VecDeque<Vec<FakeStep>>,
        pending: VecDeque<FakeStep>,
        tail: Option<FakeStep>,
        text: Option<String>,
        endpoint: bool,
        accepted_chunks: u32,
        decode_calls: u32,
        reset_calls: u32,
        input_finished_calls: u32,
    }

    impl FakeRecognizer {
        fn new(chunks: Vec<Vec<FakeStep>>, tail: Option<FakeStep>) -> Self {
            Self {
                chunks: chunks.into(),
                pending: VecDeque::new(),
                tail,
                text: None,
                endpoint: false,
                accepted_chunks: 0,
                decode_calls: 0,
                reset_calls: 0,
                input_finished_calls: 0,
            }
        }
    }

    impl Recognizer for FakeRecognizer {
        fn accept_waveform(&mut self, _samples: &[f32]) {
            self.accepted_chunks += 1;
            self.pending = self.chunks.pop_front().unwrap_or_default().into();
        }

        fn is_ready(&self) -> bool {
            !self.pending.is_empty()
        }

        fn decode(&mut self) {
            self.decode_calls += 1;
            if let Some(step) = self.pending.pop_front() {
                self.text = step.text.map(str::to_string);
                self.endpoint = step.endpoint;
            }
        }

        fn result_text(&self) -> Option<String> {
            self.text.clone().filter(|text| !text.is_empty())
        }

        fn is_endpoint(&self) -> bool {
            self.endpoint
        }

        fn reset(&mut self) {
            self.reset_calls += 1;
            self.text = None;
            self.endpoint = false;
            self.pending.clear();
        }

        fn input_finished(&mut self) {
            self.input_finished_calls += 1;
            // The trailing flush becomes one more decodable step, so the loop's
            // `while is_ready { decode }` drains it and then stops.
            if let Some(step) = self.tail.take() {
                self.pending.push_back(step);
            }
        }

        fn new_stream(&mut self) {
            // A fresh stream carries no hypothesis, no endpoint and no pending
            // decodes — the reuse seam the resident engine hands a new session.
            self.text = None;
            self.endpoint = false;
            self.pending.clear();
        }
    }

    /// Records every emit so ordering / monotonicity can be asserted.
    #[derive(Default)]
    struct RecordingSink {
        transcripts: Mutex<Vec<SttTranscriptEvent>>,
        states: Mutex<Vec<SttStateEvent>>,
    }

    impl RecordingSink {
        fn transcripts(&self) -> Vec<SttTranscriptEvent> {
            self.transcripts.lock().expect("sink lock").clone()
        }

        fn states(&self) -> Vec<SttStateEvent> {
            self.states.lock().expect("sink lock").clone()
        }
    }

    impl TranscriptSink for RecordingSink {
        fn transcript(&self, event: SttTranscriptEvent) {
            self.transcripts.lock().expect("sink lock").push(event);
        }

        fn state(&self, event: SttStateEvent) {
            self.states.lock().expect("sink lock").push(event);
        }
    }

    /// Drive `run_recognition` with the pre-filled channel dropped before the
    /// call, so `recv()` ends deterministically.
    fn drive(recognizer: &mut FakeRecognizer, messages: Vec<AudioMsg>) -> RecordingSink {
        let sink = RecordingSink::default();
        let (tx, rx) = mpsc::channel::<AudioMsg>();
        for message in messages {
            tx.send(message).expect("channel send");
        }
        drop(tx);
        run_recognition(&sink, "sess-1", recognizer, &rx);
        sink
    }

    fn assert_strictly_increasing_revisions(events: &[SttTranscriptEvent]) {
        assert!(!events.is_empty(), "expected at least one transcript event");
        for pair in events.windows(2) {
            assert!(
                pair[1].revision > pair[0].revision,
                "revision must strictly increase: {} then {}",
                pair[0].revision,
                pair[1].revision
            );
        }
    }

    #[test]
    fn recognition_emits_partial_partial_final_with_increasing_revisions() {
        let mut recognizer = FakeRecognizer::new(
            vec![vec![
                FakeStep::partial("hello"),
                FakeStep::partial("hello world"),
                FakeStep::final_step("hello world"),
            ]],
            None,
        );
        let sink = drive(
            &mut recognizer,
            vec![AudioMsg::Samples(vec![0.0_f32; 4]), AudioMsg::Stop],
        );

        let events = sink.transcripts();
        assert_eq!(events.len(), 3, "two partials then one final");
        assert!(!events[0].is_final);
        assert_eq!(events[0].text, "hello");
        assert!(!events[1].is_final);
        assert_eq!(events[1].text, "hello world");
        assert!(events[2].is_final);
        assert_eq!(events[2].text, "hello world");
        assert_eq!(events[0].revision, 1);
        for event in &events {
            assert_eq!(event.session_id, "sess-1");
            assert_eq!(event.segment_id, 0);
        }
        assert_strictly_increasing_revisions(&events);

        assert_eq!(recognizer.accepted_chunks, 1);
        assert_eq!(recognizer.decode_calls, 3);
        assert_eq!(recognizer.reset_calls, 1);
        assert_eq!(recognizer.input_finished_calls, 1);
    }

    #[test]
    fn recognition_advances_segment_id_on_each_endpoint() {
        let mut recognizer = FakeRecognizer::new(
            vec![
                vec![FakeStep::partial("first"), FakeStep::final_step("first")],
                vec![FakeStep::partial("second"), FakeStep::final_step("second")],
            ],
            None,
        );
        let sink = drive(
            &mut recognizer,
            vec![
                AudioMsg::Samples(vec![0.0_f32; 4]),
                AudioMsg::Samples(vec![0.0_f32; 4]),
                AudioMsg::Stop,
            ],
        );

        let events = sink.transcripts();
        let segments: Vec<u32> = events.iter().map(|event| event.segment_id).collect();
        assert_eq!(segments, vec![0, 0, 1, 1]);
        let finals: Vec<bool> = events.iter().map(|event| event.is_final).collect();
        assert_eq!(finals, vec![false, true, false, true]);
        assert_strictly_increasing_revisions(&events);
        assert_eq!(recognizer.reset_calls, 2);
    }

    #[test]
    fn cancel_discards_the_in_flight_partial_without_a_final() {
        let mut recognizer =
            FakeRecognizer::new(vec![vec![FakeStep::partial("half a thought")]], None);
        let sink = drive(
            &mut recognizer,
            vec![AudioMsg::Samples(vec![0.0_f32; 4]), AudioMsg::Cancel],
        );

        let events = sink.transcripts();
        assert_eq!(events.len(), 1);
        assert!(!events[0].is_final);
        assert_eq!(events[0].text, "half a thought");
        assert_eq!(recognizer.input_finished_calls, 0, "cancel never flushes");
        assert!(sink.states().is_empty(), "run_recognition is state-free");
    }

    #[test]
    fn stop_commits_the_pending_partial_as_the_final() {
        let mut recognizer =
            FakeRecognizer::new(vec![vec![FakeStep::partial("never ended")]], None);
        let sink = drive(
            &mut recognizer,
            vec![AudioMsg::Samples(vec![0.0_f32; 4]), AudioMsg::Stop],
        );

        let events = sink.transcripts();
        assert_eq!(events.len(), 2);
        assert!(!events[0].is_final);
        assert!(events[1].is_final);
        assert_eq!(events[1].text, "never ended");
        assert_strictly_increasing_revisions(&events);
    }

    #[test]
    fn stop_flushes_the_trailing_tail_released_by_input_finished() {
        let mut recognizer = FakeRecognizer::new(
            vec![vec![FakeStep::partial("the quick brown")]],
            Some(FakeStep::partial("the quick brown fox")),
        );
        let sink = drive(
            &mut recognizer,
            vec![AudioMsg::Samples(vec![0.0_f32; 4]), AudioMsg::Stop],
        );

        let events = sink.transcripts();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].text, "the quick brown fox");
        assert!(events[1].is_final);
        assert_eq!(recognizer.input_finished_calls, 1);
        assert_eq!(recognizer.decode_calls, 2, "one chunk step + one tail step");
    }

    #[test]
    fn unchanged_and_empty_hypotheses_never_emit() {
        let mut recognizer = FakeRecognizer::new(
            vec![vec![
                FakeStep::partial("same"),
                FakeStep::partial("same"),
                FakeStep::empty(),
            ]],
            None,
        );
        let sink = drive(
            &mut recognizer,
            vec![AudioMsg::Samples(vec![0.0_f32; 4]), AudioMsg::Cancel],
        );

        let events = sink.transcripts();
        assert_eq!(events.len(), 1, "only the first distinct hypothesis emits");
        assert_eq!(events[0].revision, 1);
        assert_eq!(recognizer.decode_calls, 3);
    }

    /// Every failure code carries its pinned wire name and shapes an
    /// `started:false` result with a non-empty human-readable detail.
    #[test]
    fn every_failure_code_is_pinned_to_its_wire_name_and_start_result() {
        let cases: Vec<(VoiceError, SttErrorCode, &str)> = vec![
            (VoiceError::no_device(), SttErrorCode::NoDevice, "noDevice"),
            (
                VoiceError::permission_denied("microphone access was denied"),
                SttErrorCode::PermissionDenied,
                "permissionDenied",
            ),
            (
                VoiceError::model_missing("tokens.txt is missing"),
                SttErrorCode::ModelMissing,
                "modelMissing",
            ),
            (
                VoiceError::model_corrupt("tokens.txt is incomplete"),
                SttErrorCode::ModelCorrupt,
                "modelCorrupt",
            ),
            (
                VoiceError::engine_start_failed("OnlineRecognizer::create returned None"),
                SttErrorCode::EngineStartFailed,
                "engineStartFailed",
            ),
            (
                VoiceError::already_listening(),
                SttErrorCode::AlreadyListening,
                "alreadyListening",
            ),
            (VoiceError::disabled(), SttErrorCode::Disabled, "disabled"),
            (
                VoiceError::internal("voice worker exited early"),
                SttErrorCode::Internal,
                "internal",
            ),
        ];

        for (error, code, wire) in cases {
            assert_eq!(error.code, code);
            assert!(
                !error.detail.trim().is_empty(),
                "{wire} needs a human-readable detail"
            );

            let json = serde_json::to_string(&code).expect("serialize error code");
            assert_eq!(json, format!("\"{wire}\""));

            let result = error.into_start_result();
            assert!(!result.started);
            assert_eq!(result.code, Some(code));
            assert!(result.detail.is_some());
            assert!(result.device_name.is_none());
            assert!(result.sample_rate.is_none());
        }
    }

    /// R-5.3/AC5: the single state builder derives `listening` from the ACTUAL
    /// session state — a live origin ⇒ listening, no origin ⇒ idle — so no path
    /// can publish a false idle while a session is alive.
    #[test]
    fn listening_state_pins_live_truth_and_idle() {
        let live = listening_state(Some("companion".to_string()));
        assert!(live.listening);
        assert!(live.code.is_none());
        assert!(live.detail.is_none());
        assert_eq!(live.origin.as_deref(), Some("companion"));

        let idle = listening_state(None);
        assert!(!idle.listening);
        assert!(idle.code.is_none());
        assert!(idle.detail.is_none());
        assert!(idle.origin.is_none());
    }

    /// F-38: a duplicate `stt_start` MUST keep the `alreadyListening` result
    /// unchanged (R-4.1) while emitting the TRUE live state of the ACTIVE
    /// session — `listening:true` with the active origin, never the requested
    /// one — and MUST NOT enter the start path (no second session/handle).
    #[test]
    fn duplicate_start_reemits_the_active_state_and_keeps_the_idempotent_result() {
        let (control_tx, _control_rx) = mpsc::channel::<AudioMsg>();
        let active = ActiveSession {
            origin: "launcher".to_string(),
            control_tx,
            worker: std::thread::spawn(|| {}),
        };

        // The gate yields on an installed session: the caller returns before the
        // worker spawn, so a second `ActiveSession` is never created. An empty
        // slot yields `None` so a genuine start proceeds.
        let (result, event) = already_listening_outcome(Some(&active))
            .expect("an installed session must yield the duplicate-start outcome");
        assert!(
            already_listening_outcome(None).is_none(),
            "an empty slot must let the start proceed"
        );

        // (a) TRUE active state, with the ACTIVE origin (a request for
        // "companion" would still re-emit this "launcher" session).
        assert!(event.listening);
        assert_eq!(event.origin.as_deref(), Some("launcher"));
        assert!(event.code.is_none());
        assert!(event.detail.is_none());

        // (b) `stt_status` derives from the SAME builder for the SAME session, so
        // the read path and the emitted state are the identical shape.
        let from_status = listening_state(Some(active.origin.clone()));
        assert_eq!(event.listening, from_status.listening);
        assert_eq!(event.origin, from_status.origin);
        assert_eq!(event.code, from_status.code);
        assert_eq!(event.detail, from_status.detail);

        // (c) the duplicate-start result is byte-for-byte the pinned idempotence
        // contract — unchanged by this fix.
        assert!(!result.started);
        assert_eq!(result.code, Some(SttErrorCode::AlreadyListening));
        assert_eq!(
            result.detail.as_deref(),
            Some("A listening session is already active.")
        );
        assert!(result.device_name.is_none());
        assert!(result.sample_rate.is_none());
    }

    #[test]
    fn parse_enabled_pins_the_disabled_gate() {
        for value in [
            None,
            Some("false"),
            Some("FALSE"),
            Some("0"),
            Some(""),
            Some("yes"),
            Some("  "),
        ] {
            assert!(!parse_enabled(value), "{value:?} must resolve disabled");
        }
        for value in [Some("true"), Some("True"), Some("TRUE"), Some("1"), Some(" true ")] {
            assert!(parse_enabled(value), "{value:?} must resolve enabled");
        }
    }

    /// R-1.2/R-3.2: the persisted device key's documented default is `""` — an
    /// unset or blank value means the system default (`None`), and a real name
    /// round-trips trimmed.
    #[test]
    fn parse_device_id_treats_unset_and_blank_as_the_system_default() {
        for value in [None, Some(""), Some("   "), Some("\t")] {
            assert_eq!(parse_device_id(value), None, "{value:?} must mean default");
        }
        assert_eq!(
            parse_device_id(Some("Iriun Webcam")),
            Some("Iriun Webcam".to_string())
        );
        assert_eq!(
            parse_device_id(Some("  Microphone (USB)  ")),
            Some("Microphone (USB)".to_string())
        );
    }

    fn manifest_with(files: Vec<ModelFileSpec>) -> ModelManifest {
        ModelManifest {
            revision: "test".to_string(),
            subdir: "stt-test".to_string(),
            files,
        }
    }

    fn spec(path: &str, expected_bytes: u64) -> ModelFileSpec {
        ModelFileSpec {
            id: path.to_string(),
            path: path.to_string(),
            url: format!("https://example.invalid/{path}"),
            expected_bytes,
            sha256: None,
        }
    }

    fn write_sized(
        dir: &Path,
        manifest: &ModelManifest,
        spec: &ModelFileSpec,
        bytes: u64,
    ) {
        let path = file_path(dir, manifest, spec);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        let file = std::fs::File::create(&path).expect("create");
        file.set_len(bytes).expect("set_len");
    }

    #[test]
    fn model_error_classifies_missing_incomplete_oversize_and_present() {
        let manifest = manifest_with(vec![spec("model.onnx", 100)]);
        let dir = tempfile::tempdir().expect("tempdir");
        let file = &manifest.files[0];

        // Absent ⇒ ModelMissing.
        let error = model_error(dir.path(), &manifest).expect("missing model must error");
        assert_eq!(error.code, SttErrorCode::ModelMissing);
        assert!(error.detail.contains("model.onnx"));

        // Truncated ⇒ ModelCorrupt (partial download).
        write_sized(dir.path(), &manifest, file, 60);
        let error = model_error(dir.path(), &manifest).expect("partial model must error");
        assert_eq!(error.code, SttErrorCode::ModelCorrupt);
        assert!(error.detail.contains("60"));

        // Oversize ⇒ ModelCorrupt (unexpected size).
        write_sized(dir.path(), &manifest, file, 120);
        let error = model_error(dir.path(), &manifest).expect("oversize model must error");
        assert_eq!(error.code, SttErrorCode::ModelCorrupt);
        assert!(error.detail.contains("120"));

        // Exact pinned size ⇒ no error (the shared exact-byte gate).
        write_sized(dir.path(), &manifest, file, 100);
        assert!(model_error(dir.path(), &manifest).is_none());
    }

    #[test]
    fn model_error_reports_the_first_broken_file_of_the_pinned_stt_manifest() {
        let manifest = resolve_stt_manifest();
        let dir = tempfile::tempdir().expect("tempdir");

        // Nothing on disk ⇒ the first pinned file (tokens.txt) is the missing one.
        let error = model_error(dir.path(), &manifest).expect("empty models dir must error");
        assert_eq!(error.code, SttErrorCode::ModelMissing);
        assert!(error.detail.contains("tokens.txt"));

        // tokens present, encoder truncated ⇒ ModelCorrupt names the encoder.
        let tokens = &manifest.files[0];
        write_sized(dir.path(), &manifest, tokens, tokens.expected_bytes);
        let encoder = &manifest.files[1];
        write_sized(dir.path(), &manifest, encoder, 10);
        let error = model_error(dir.path(), &manifest).expect("truncated encoder must error");
        assert_eq!(error.code, SttErrorCode::ModelCorrupt);
        assert!(error.detail.contains(encoder.filename()));
    }
}
