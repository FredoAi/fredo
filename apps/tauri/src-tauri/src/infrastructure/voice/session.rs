//! One-session model-audio state machine.
//!
//! `start` gates on the persisted voice preference, an already-active session and
//! the model-audio capability snapshot, then starts a dedicated worker thread
//! that opens the `cpal` capture stream for the persisted input device and
//! accumulates the captured audio while emitting `stt:state`. There is exactly
//! ONE speech path: every session accumulates a bounded 16 kHz mono clip and
//! commits it on Stop. `stop` commits the clip; `cancel` discards it. There is
//! no recognizer, no engine and no transcript. Every failure is a typed
//! `VoiceError` — no panics.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::{AppHandle, Emitter, Manager};

use crate::infrastructure::storage::AppStore;
use crate::infrastructure::voice::capture::{self, AudioMsg};
use crate::infrastructure::voice::state::{
    SttAudioCapability, SttAudioCapabilityState, SttAudioClip, SttAudioClipResult, SttErrorCode,
    SttPhaseWire, SttStartResult, SttStateEvent, VoiceError, MAX_AUDIO_CLIP_MS,
};

/// Persisted Companion preference (written by the voice-input toggle, DEFAULT
/// false).
pub const VOICE_ENABLED_KEY: &str = "Fredo_companion_voice_enabled";

/// Persisted Companion preference: the selected input device. The value is a
/// `cpal` device name (`id` from `stt_list_devices`); unset/blank ⇒ the system
/// default.
pub const VOICE_DEVICE_KEY: &str = "Fredo_companion_voice_device_id";

/// Budget for capture open before `stt_start` gives up.
const START_TIMEOUT: Duration = Duration::from_secs(30);

/// Device facts reported back by the worker once it is ready.
#[derive(Clone, Debug)]
pub struct StartInfo {
    pub device_name: String,
    pub device_sample_rate: u32,
    /// Milliseconds from the `stt_start` receipt to capture-live, stamped by the
    /// worker at the instant capture went live (ST-3/R-1). Never a constant and
    /// never measured from anything but the receipt — a launch-window hold
    /// therefore includes that wait, so the residual is visible on the wire
    /// instead of masked.
    pub ready_ms: u64,
}

struct ActiveSession {
    origin: String,
    control_tx: Sender<AudioMsg>,
    worker: std::thread::JoinHandle<()>,
}

/// Tauri-managed session state (Send + Sync: only Send fields inside a Mutex).
pub struct VoiceState {
    inner: Mutex<Option<ActiveSession>>,
    /// #2897 ST-2: the bounded clip a stop committed, awaiting
    /// `stt_take_audio_clip` (which takes + clears it). `None` outside a
    /// session; never holds a recognizer or a device.
    clip: Mutex<Option<SttAudioClip>>,
    /// #2897 ST-5 (REQ-6): set by the worker the instant capture AUTO-STOPPED at
    /// [`MAX_AUDIO_CLIP_MS`]. An auto-stopped session is OVER — `stt_status`
    /// reports idle and the already-listening gate lets the next listen proceed
    /// (the stale entry is dropped), while a later `stt_stop` still re-emits the
    /// same terminal `processing`/`limitReached` state. A new session start
    /// clears it.
    auto_stopped: AtomicBool,
    /// #2897 ST-6 (REQ-7): the latest model-audio capability snapshot, written by
    /// the sanctioned `stt_audio_capability` probe (which lives in
    /// `features/llm_server`, the only network-capable module) and read by the
    /// pre-start gate below. `infrastructure/voice/` never probes the network
    /// itself — it only reads this value.
    capability: Mutex<Option<SttAudioCapability>>,
}

impl VoiceState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            clip: Mutex::new(None),
            auto_stopped: AtomicBool::new(false),
            capability: Mutex::new(None),
        }
    }

    /// #2897 ST-6 (REQ-7) — store the latest capability snapshot. Called by the
    /// `stt_audio_capability` command after its read-only probe.
    pub fn set_audio_capability(&self, capability: SttAudioCapability) {
        let mut guard = lock_capability(self);
        *guard = Some(capability);
    }

    /// #2897 ST-6 (REQ-7) — the latest capability snapshot, or `None` when no
    /// probe has run yet. The pre-start gate treats `None` as "not determined"
    /// (it never invents a verdict) and lets the reactive fallback handle a
    /// later failure.
    pub fn audio_capability(&self) -> Option<SttAudioCapability> {
        lock_capability(self).clone()
    }

    /// #2897 ST-6 (REQ-7) — drop the snapshot (voice was released). A cleared
    /// snapshot is "not determined", never a failure.
    pub fn clear_audio_capability(&self) {
        *lock_capability(self) = None;
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

/// #2897 ST-2 — the clip slot, recovered from a poisoned lock exactly like the
/// session slot (never a panic).
fn lock_clip(state: &VoiceState) -> MutexGuard<'_, Option<SttAudioClip>> {
    match state.clip.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// #2897 ST-6 (REQ-7) — the capability snapshot slot, recovered from a poisoned
/// lock exactly like the session slot (never a panic).
fn lock_capability(state: &VoiceState) -> MutexGuard<'_, Option<SttAudioCapability>> {
    match state.capability.lock() {
        Ok(guard) => guard,
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

/// The persisted opt-in flag, shared with the session start so the gate is ONE
/// rule.
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

fn emit_state(app: &AppHandle, event: &SttStateEvent) {
    if let Err(error) = app.emit("stt:state", event) {
        tracing::debug!("failed to emit stt:state: {error}");
    }
}

fn state_event_error(error: &VoiceError, origin: Option<&str>) -> SttStateEvent {
    SttStateEvent {
        listening: false,
        code: Some(error.code),
        detail: Some(error.detail.clone()),
        origin: origin.map(|value| value.to_string()),
        // An error path never captured and never reported a model-audio phase
        // (#2897 ST-2/ST-5).
        ready_ms: None,
        phase: None,
        limit_reached: None,
        limit_ms: None,
    }
}

/// The single builder for a truthful `stt:state`: `listening` is derived from
/// whether a session origin is installed, never hardcoded. `stt_status`, the
/// duplicate-start re-emit and the start success path all derive from this one
/// function, so the read path and the emit path can never disagree (R-5.3/AC5).
fn listening_state(origin: Option<String>) -> SttStateEvent {
    listening_state_with(origin, None, None, None)
}

/// The truthful `stt:state` builder WITH the timing observables: `ready_ms`
/// (start receipt → capture-live), the model-audio `phase`, and the pinned
/// `limit_ms` ceiling. ST-3 stamps `ready_ms` on the start-success path; the
/// limit flag is stop-only and is stamped by [`finish`].
fn listening_state_with(
    origin: Option<String>,
    ready_ms: Option<u64>,
    phase: Option<SttPhaseWire>,
    limit_ms: Option<u64>,
) -> SttStateEvent {
    SttStateEvent {
        listening: origin.is_some(),
        code: None,
        detail: None,
        origin,
        ready_ms,
        phase,
        limit_reached: None,
        limit_ms,
    }
}

/// #2897 ST-6 (REQ-7) — the PRE-START model-audio capability gate. When the last
/// sanctioned probe said the audio capability FAILED, the session must not
/// start: no capture is opened, so no audio is ever transmitted, and the typed
/// code travels out through the existing `stt:state` error channel.
/// `is_stop`/`is_cancel` never reach here.
///
/// `Ready` and `Unknown`/`None` proceed: an inconclusive probe is NOT a failure
/// (the reactive fallback owns a later delivery failure), and a probe that has
/// not run yet must not invent a verdict. `checking` is a UI-only value and is
/// treated exactly like `None`.
fn model_audio_start_gate(capability: Option<&SttAudioCapability>) -> Option<VoiceError> {
    let capability = capability?;
    match capability.state {
        SttAudioCapabilityState::Unsupported => Some(VoiceError::model_audio_unsupported(
            capability
                .detail
                .clone()
                .unwrap_or_else(|| "The installed companion model can't interpret audio.".to_string()),
        )),
        SttAudioCapabilityState::ServerUnavailable => Some(VoiceError::model_audio_unavailable(
            capability.detail.clone().unwrap_or_else(|| {
                "The local model server isn't running.".to_string()
            }),
        )),
        SttAudioCapabilityState::Checking
        | SttAudioCapabilityState::Ready
        | SttAudioCapabilityState::Unknown => None,
    }
}

/// #2897 ST-2 — take (and clear) the committed clip. Taking is destructive: a
/// second call returns `clip: None`. The clip is the WHOLE captured audio —
/// `truncated` is always false (REQ-6 non-lossy).
fn take_clip(state: &VoiceState) -> SttAudioClipResult {
    let mut guard = lock_clip(state);
    SttAudioClipResult {
        clip: guard.take(),
        code: None,
        detail: None,
    }
}

/// `stt_take_audio_clip` — take (and clear) the clip a stop committed (#2897
/// ST-2). The clip leaves via IPC only — `voice/` never transmits it (REQ-8).
pub(crate) fn take_audio_clip(app: &AppHandle) -> SttAudioClipResult {
    let state = app.state::<VoiceState>();
    take_clip(&state)
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
        listening_state_with(
            Some(active.origin.clone()),
            None,
            Some(SttPhaseWire::Capturing),
            Some(MAX_AUDIO_CLIP_MS),
        ),
    ))
}

/// `stt_start`: gate → capture on a worker thread → report ready with the
/// truthful `readyMs`. The session is the ONE model-audio path.
pub async fn start(app: &AppHandle, origin: &str) -> SttStartResult {
    // The `stt_start` receipt: `readyMs` is measured from HERE.
    let receipt = Instant::now();

    // 1. Disabled gate (R-5.7 backend pin; the toggle owns the preference).
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
        let mut guard = lock_inner(&state);
        // #2897 ST-5 (REQ-6 / E-55) — an AUTO-STOPPED session is over: its worker
        // ended at the pinned ceiling. Drop the stale entry so the next listen is
        // never refused as `alreadyListening` (and the clip is cleared below).
        if state.auto_stopped.load(Ordering::SeqCst) && guard.is_some() {
            *guard = None;
        }
        if let Some((result, event)) = already_listening_outcome(guard.as_ref()) {
            emit_state(app, &event);
            return result;
        }
    }

    // 3. Model-audio capability gate (#2897 ST-6 / REQ-7). The snapshot is
    // written ONLY by the sanctioned `stt_audio_capability` probe (which lives in
    // `features/llm_server`, the crate's network-capable module); this module
    // merely reads it, so `infrastructure/voice/` stays free of network symbols
    // (REQ-8 / voice_invariants). A failed capability check returns BEFORE any
    // capture is opened, so no audio is transmitted, and the typed code goes out
    // on the existing `stt:state` error channel.
    {
        let capability = app.state::<VoiceState>().audio_capability();
        if let Some(error) = model_audio_start_gate(capability.as_ref()) {
            emit_state(app, &state_event_error(&error, Some(origin)));
            return error.into_start_result();
        }
    }

    // 4. Worker owns the `cpal::Stream` for its whole lifetime. The persisted
    // device preference is resolved to a name here, but validated against the
    // live device set inside `capture` on the worker — a vanished device is the
    // typed `NoDevice` naming it (AC4), never a silent fallback.
    let selected_device = persisted_device(app);
    // #2897 ST-2 (E-55): a new listen invalidates any clip a previous session left
    // untaken, so a re-listen can never deliver stale audio. #2897 ST-5: the
    // auto-stop flag is reset with it — this session is live until it ends.
    {
        let state = app.state::<VoiceState>();
        *lock_clip(&state) = None;
        state.auto_stopped.store(false, Ordering::SeqCst);
    }
    let (tx, rx) = mpsc::channel::<AudioMsg>();
    let (outcome_tx, outcome_rx) =
        tokio::sync::oneshot::channel::<Result<StartInfo, VoiceError>>();
    let worker_app = app.clone();
    let worker_tx = tx.clone();
    // #2897 ST-5 — the auto-stop `stt:state` is emitted by the worker itself, so
    // it needs the session origin (owned: the worker is `'static`).
    let worker_origin = origin.to_string();
    let worker = match std::thread::Builder::new()
        .name("fredo-stt".to_string())
        .spawn(move || {
            worker_main(WorkerJob {
                app: worker_app,
                origin: worker_origin,
                selected_device,
                rx,
                tx: worker_tx,
                outcome_tx,
                receipt,
            });
        }) {
        Ok(handle) => handle,
        Err(error) => {
            let error = VoiceError::internal(format!("failed to spawn the voice worker: {error}"));
            emit_state(app, &state_event_error(&error, Some(origin)));
            return error.into_start_result();
        }
    };

    // 5. Await readiness off the main thread. `worker_reported` distinguishes the
    // paths on which the worker has already reported/returned (safe to join) from
    // the timeout path, where the worker may still be blocked inside the native
    // capture open (ST-7.2 / F-15) — which no `Cancel` can interrupt.
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
                    "timed out while starting the audio capture",
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
            // The honest observable: `ready_ms` is the true receipt →
            // capture-live elapsed time. A live session is `capturing` and
            // carries the ONE pinned ceiling.
            emit_state(
                app,
                &listening_state_with(
                    Some(origin.to_string()),
                    Some(info.ready_ms),
                    Some(SttPhaseWire::Capturing),
                    Some(MAX_AUDIO_CLIP_MS),
                ),
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
            // ST-7.2: never join a worker that never reported readiness. A worker
            // blocked inside the native open cannot be interrupted, so joining it
            // would hang `stt_start` (the round-1 F-15 wedge) instead of returning
            // the typed failure immediately (R-5.5: app stays responsive).
            // Dropping the handle detaches the worker; the `Cancel` sent above
            // makes it self-terminate if the native call ever returns
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
    let is_stop = matches!(message, AudioMsg::Stop);
    let session = {
        let state = app.state::<VoiceState>();
        let mut guard = lock_inner(&state);
        guard.take()
    };
    let origin = session.as_ref().map(|session| session.origin.clone());
    let had_session = session.is_some();

    if let Some(session) = session {
        let ActiveSession {
            control_tx, worker, ..
        } = session;
        let _ = control_tx.send(message);
        // Join off the async runtime thread: the worker commits (stop) or
        // discards (cancel) before this resolves, so the clip is committed BEFORE
        // the `listening:false` state event.
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let _ = worker.join();
        })
        .await;
    }

    // #2897 ST-2 — a STOP reports `processing` (the clip is committed, awaiting
    // interpretation) with the clip's at-ceiling flag (REQ-6): a cancel, or an
    // absent session, reports neither.
    let clip_at_limit = if had_session && is_stop {
        let state = app.state::<VoiceState>();
        let guard = lock_clip(&state);
        guard.as_ref().map(|clip| clip.at_limit)
    } else {
        None
    };
    // #2897 ST-5 (REQ-6) — a cancel DISCARDS the clip: after an auto-stop the clip
    // is already committed, so a later cancel must reclaim it, exactly as a
    // cancel inside the capture loop discards the in-flight accumulation.
    if had_session && !is_stop {
        let state = app.state::<VoiceState>();
        *lock_clip(&state) = None;
        state.auto_stopped.store(false, Ordering::SeqCst);
    }
    let (phase, limit_reached) = if had_session && is_stop {
        (
            Some(SttPhaseWire::Processing),
            Some(clip_at_limit.unwrap_or(false)),
        )
    } else {
        (None, None)
    };

    let event = SttStateEvent {
        listening: false,
        code: None,
        detail: None,
        origin,
        // Idle: no start happened, so there is no readiness to report.
        ready_ms: None,
        phase,
        limit_reached,
        // #2897 ST-5 — a stop carries the pinned ceiling the clip was bounded by,
        // so the limit copy always reads the real bound.
        limit_ms: had_session.then_some(MAX_AUDIO_CLIP_MS),
    };
    emit_state(app, &event);
    event
}

/// `stt_stop` — commit the bounded model-audio clip.
pub async fn stop(app: &AppHandle) -> SttStateEvent {
    finish(app, AudioMsg::Stop).await
}

/// `stt_cancel` — discard the accumulated audio.
pub async fn cancel(app: &AppHandle) -> SttStateEvent {
    finish(app, AudioMsg::Cancel).await
}

/// `stt_status` — read the current listening state. Derived from the SAME
/// builder the live `stt:state` emissions use, so the read path and the emit
/// path cannot disagree (R-5.3). A live session reports `capturing` (#2897
/// ST-2).
pub fn status(app: &AppHandle) -> SttStateEvent {
    let state = app.state::<VoiceState>();
    let guard = lock_inner(&state);
    // #2897 ST-5 (REQ-6) — an auto-stopped capture is OVER: the worker ended at
    // the pinned ceiling and the wire already reported `processing`. The read
    // path must agree with it, never claim a live capture that no longer exists.
    if state.auto_stopped.load(Ordering::SeqCst) {
        return listening_state(None);
    }
    match guard.as_ref() {
        Some(session) => listening_state_with(
            Some(session.origin.clone()),
            None,
            Some(SttPhaseWire::Capturing),
            Some(MAX_AUDIO_CLIP_MS),
        ),
        None => listening_state(None),
    }
}

/// Everything one worker thread needs for one session — bundled so the thread
/// body keeps a small signature.
struct WorkerJob {
    /// Owns the `cpal::Stream` for the session's whole lifetime.
    app: AppHandle,
    /// #2897 ST-5 — the session origin, echoed on the worker-emitted auto-stop
    /// `stt:state` (the reachability bound of the actual auto-stop event).
    origin: String,
    selected_device: Option<String>,
    rx: Receiver<AudioMsg>,
    tx: Sender<AudioMsg>,
    outcome_tx: tokio::sync::oneshot::Sender<Result<StartInfo, VoiceError>>,
    /// The `stt_start` receipt `readyMs` is measured from.
    receipt: Instant,
}

/// Worker thread body: open capture for the persisted device, report readiness
/// with the true `readyMs`, then accumulate the bounded clip until Stop/Cancel.
/// Owns the `cpal::Stream` for its whole lifetime. There is exactly ONE arm —
/// every session runs the model-audio loop.
fn worker_main(job: WorkerJob) {
    let WorkerJob {
        app,
        origin,
        selected_device,
        rx,
        tx,
        outcome_tx,
        receipt,
    } = job;

    let capture = match capture::start_capture(tx, selected_device.as_deref()) {
        Ok(capture) => capture,
        Err(error) => {
            let _ = outcome_tx.send(Err(error));
            return;
        }
    };

    // Capture is LIVE here (the device stream is playing): `readyMs` is measured
    // to this instant, from the `stt_start` receipt — so the gate work, the spawn
    // and the capture open are all inside the number rather than hidden.
    let info = StartInfo {
        device_name: capture.device_name.clone(),
        device_sample_rate: capture.device_sample_rate,
        ready_ms: elapsed_ms(receipt),
    };
    if outcome_tx.send(Ok(info)).is_err() {
        // The caller gave up; drop capture and exit.
        return;
    }

    // No recognizer, no engine — accumulate the bounded clip and commit it on
    // Stop. `capture` (and its stream/feed) drops at scope end. #2897 ST-5:
    // reaching the pinned ceiling AUTO-STOPS the capture (the worker returns, so
    // the microphone is released at the bound) and emits the terminal warning
    // state itself — the user keeps holding, the clip is kept whole and
    // delivered.
    run_model_audio_session(&app, &rx, &origin);
}

/// #2897 ST-2 — the outcome of a model-audio capture session.
enum ModelAudioCaptureOutcome {
    /// Stop committed the clip: the accumulated samples + whether the pinned
    /// ceiling auto-stopped capture. `truncated` is always false (non-lossy).
    Clip { samples: Vec<f32>, at_limit: bool },
    /// Cancel discarded everything — no clip is produced.
    Discarded,
}

/// #2897 ST-2 — the model-audio loop: accumulate `AudioMsg::Samples` with NO
/// recognizer, bound the buffer at [`MAX_AUDIO_CLIP_MS`] (REQ-6), commit on Stop
/// / discard on Cancel.
///
/// #2897 ST-5 (REQ-6) — the bound is an AUTO-STOP, not a lossy cut: the moment
/// the pinned ceiling is reached the loop RETURNS the whole accumulation
/// (`at_limit:true`) instead of waiting for the user's gesture. Capture then
/// stops (the worker returns and drops the stream), so no captured audio is ever
/// discarded — the clip IS the entire capture.
fn run_model_audio_capture(rx: &Receiver<AudioMsg>) -> ModelAudioCaptureOutcome {
    let cap = ms_to_samples(MAX_AUDIO_CLIP_MS);
    let mut samples: Vec<f32> = Vec::new();

    while let Ok(message) = rx.recv() {
        match message {
            AudioMsg::Samples(chunk) => {
                // The remaining headroom at the pinned ceiling. `saturating_sub`
                // covers a chunk arriving after an exact fill (headroom 0): the
                // capture is already at the bound and auto-stops here.
                let remaining = cap.saturating_sub(samples.len());
                if chunk.len() >= remaining {
                    samples.extend_from_slice(&chunk[..remaining]);
                    // AUTO-STOP: the whole capture (exactly the bound) is kept and
                    // the loop ends — nothing past the bound was ever captured.
                    return ModelAudioCaptureOutcome::Clip {
                        samples,
                        at_limit: true,
                    };
                }
                samples.extend_from_slice(&chunk);
            }
            AudioMsg::Stop => {
                return ModelAudioCaptureOutcome::Clip {
                    samples,
                    at_limit: false,
                };
            }
            AudioMsg::Cancel => return ModelAudioCaptureOutcome::Discarded,
        }
    }

    // The sender dropped without Stop/Cancel (session teardown): commit what was
    // captured, honestly reporting whether the ceiling had been reached.
    let at_limit = samples.len() >= cap;
    ModelAudioCaptureOutcome::Clip { samples, at_limit }
}

/// #2897 ST-2 — run a model-audio worker session to completion: accumulate, then
/// encode + stash the clip on Stop. The clip leaves via IPC
/// (`stt_take_audio_clip`) only — `voice/` never transmits it (REQ-8).
///
/// #2897 ST-5 (REQ-6) — an at-ceiling auto-stop additionally marks the session
/// ended (`auto_stopped`) and emits the terminal `processing`/`limitReached:true`
/// state itself, so the bound is surfaced without waiting for the user's release.
/// The clip is committed FIRST, so the state is never visible before the audio
/// it describes is takeable (non-lossy).
fn run_model_audio_session(app: &AppHandle, rx: &Receiver<AudioMsg>, origin: &str) {
    let ModelAudioCaptureOutcome::Clip { samples, at_limit } = run_model_audio_capture(rx) else {
        // Cancel: no clip, nothing stashed (the clip was cleared at start).
        return;
    };
    let clip = encode_clip(&samples, at_limit);
    let state = app.state::<VoiceState>();
    {
        let mut guard = lock_clip(&state);
        *guard = Some(clip);
    }
    if at_limit {
        // Surface the auto-stop immediately (the user may still be holding). The
        // flag is stored AFTER the emit so a start cannot be admitted — and clear
        // the stale entry — before the terminal state has been published.
        emit_state(app, &auto_stop_state(origin));
        state.auto_stopped.store(true, Ordering::SeqCst);
    }
}

/// #2897 ST-5 (REQ-6) — the terminal `stt:state` an at-ceiling auto-stop emits:
/// the capture ended normally (`listening:false`), the whole clip is committed
/// for interpretation (`processing`), the bound was reached (`limitReached`), and
/// the pinned ceiling travels with it so the UI copy reads the real bound. This
/// is a NORMAL terminal capture state — never an error.
fn auto_stop_state(origin: &str) -> SttStateEvent {
    SttStateEvent {
        listening: false,
        code: None,
        detail: None,
        origin: Some(origin.to_string()),
        ready_ms: None,
        phase: Some(SttPhaseWire::Processing),
        limit_reached: Some(true),
        limit_ms: Some(MAX_AUDIO_CLIP_MS),
    }
}

/// #2897 ST-2 — samples for a millisecond duration at the 16 kHz audio rate.
fn ms_to_samples(ms: u64) -> usize {
    (ms * capture::AUDIO_SAMPLE_RATE as u64 / 1_000) as usize
}

/// #2897 ST-2 — the duration of a sample run at the 16 kHz audio rate.
fn samples_to_ms(samples: usize) -> u64 {
    samples as u64 * 1_000 / capture::AUDIO_SAMPLE_RATE as u64
}

/// #2897 ST-2 — encode one bounded capture as the clip wire type. `truncated` is
/// ALWAYS false: the clip is the WHOLE captured audio (REQ-6 non-lossy).
fn encode_clip(samples: &[f32], at_limit: bool) -> SttAudioClip {
    let wav = encode_wav_16k_mono(samples);
    SttAudioClip {
        base64: STANDARD.encode(&wav),
        format: "wav".to_string(),
        sample_rate: capture::AUDIO_SAMPLE_RATE,
        duration_ms: samples_to_ms(samples.len()),
        limit_ms: MAX_AUDIO_CLIP_MS,
        at_limit,
        truncated: false,
    }
}

/// #2897 ST-2 — encode 16 kHz mono f32 samples as a 16-bit PCM RIFF/WAVE. Pure
/// over the samples (no audio device, no file): the bytes are the clip handed
/// over IPC. Samples are clamped to [-1, 1] before the 16-bit conversion.
fn encode_wav_16k_mono(samples: &[f32]) -> Vec<u8> {
    let sample_rate = capture::AUDIO_SAMPLE_RATE;
    let data_len = (samples.len() * 2) as u32;
    let mut bytes = Vec::with_capacity(44 + data_len as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM
    bytes.extend_from_slice(&1u16.to_le_bytes()); // mono
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
    bytes.extend_from_slice(&2u16.to_le_bytes()); // block align
    bytes.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    for &sample in samples {
        let pcm = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
        bytes.extend_from_slice(&pcm.to_le_bytes());
    }
    bytes
}

fn elapsed_ms(since: Instant) -> u64 {
    since.elapsed().as_millis() as u64
}

#[cfg(test)]
mod tests {
    //! Hermetic session pins: the model-audio accumulator's state machine runs
    //! without a model, a mic, a network or an `AppHandle`. The pure gates
    //! (`parse_enabled`, `parse_device_id`) and the full typed failure vocabulary
    //! are pinned here too.

    use super::*;

    /// R-1.2: the persisted enable key's boolean parse.
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

    /// NFR-2: the relocated audio constants keep their shipped values.
    #[test]
    fn relocated_audio_constants_keep_their_values() {
        assert_eq!(capture::AUDIO_SAMPLE_RATE, 16_000);
        assert_eq!(capture::CAPTURE_CHUNK_SAMPLES, 3200);
        assert_eq!(MAX_AUDIO_CLIP_MS, 30_000);
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
                VoiceError::engine_start_failed("timed out while starting the audio capture"),
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
            (
                VoiceError::model_audio_unsupported("the model has no audio encoder"),
                SttErrorCode::ModelAudioUnsupported,
                "modelAudioUnsupported",
            ),
            (
                VoiceError::model_audio_unavailable("the model server is not running"),
                SttErrorCode::ModelAudioUnavailable,
                "modelAudioUnavailable",
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
        // The default builder claims no readiness (ST-3): only the start-success
        // path may stamp it.
        assert!(live.ready_ms.is_none());

        let idle = listening_state(None);
        assert!(!idle.listening);
        assert!(idle.code.is_none());
        assert!(idle.detail.is_none());
        assert!(idle.origin.is_none());
        assert!(idle.ready_ms.is_none());
    }

    /// ST-3/R-1: the start-success `stt:state` carries the TRUE receipt-based
    /// `readyMs` and the model-audio phase + pinned ceiling.
    #[test]
    fn start_success_state_carries_the_receipt_based_ready_ms_and_model_phase() {
        let capturing = listening_state_with(
            Some("launcher".to_string()),
            Some(137),
            Some(SttPhaseWire::Capturing),
            Some(MAX_AUDIO_CLIP_MS),
        );
        assert!(capturing.listening);
        assert_eq!(capturing.origin.as_deref(), Some("launcher"));
        assert_eq!(capturing.ready_ms, Some(137));
        assert_eq!(capturing.phase, Some(SttPhaseWire::Capturing));
        assert!(capturing.limit_reached.is_none());
        assert_eq!(capturing.limit_ms, Some(MAX_AUDIO_CLIP_MS));
        assert!(capturing.code.is_none());
        assert!(capturing.detail.is_none());

        // The joined launch-window wait is reported, never masked.
        let joined = listening_state_with(
            Some("launcher".to_string()),
            Some(2_940),
            Some(SttPhaseWire::Capturing),
            Some(MAX_AUDIO_CLIP_MS),
        );
        assert_eq!(
            joined.ready_ms,
            Some(2_940),
            "the joined launch-window wait must be reported, never masked"
        );
    }

    /// ST-3/R-1: no error path may claim readiness — the observable stays `None`
    /// off the start-success path.
    #[test]
    fn error_states_never_report_readiness() {
        let error = state_event_error(
            &VoiceError::engine_start_failed("timed out while starting the audio capture"),
            Some("launcher"),
        );
        assert!(!error.listening);
        assert_eq!(error.code, Some(SttErrorCode::EngineStartFailed));
        assert!(error.ready_ms.is_none());
        assert!(error.phase.is_none());
        assert!(error.limit_reached.is_none());
        assert!(error.limit_ms.is_none());
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
        assert_eq!(event.phase, Some(SttPhaseWire::Capturing));
        assert_eq!(event.limit_ms, Some(MAX_AUDIO_CLIP_MS));
        // The duplicate-start re-emit reports no new start, so it claims no
        // readiness.
        assert!(event.ready_ms.is_none());

        // (b) `stt_status` derives from the SAME builder for the SAME session, so
        // the read path and the emitted state are the identical shape.
        let from_status = listening_state(Some(active.origin.clone()));
        assert_eq!(event.listening, from_status.listening);
        assert_eq!(event.origin, from_status.origin);
        assert_eq!(event.code, from_status.code);
        assert_eq!(event.detail, from_status.detail);

        // (c) the duplicate-start result is byte-for-byte the pinned idempotence
        // contract — unchanged.
        assert!(!result.started);
        assert_eq!(result.code, Some(SttErrorCode::AlreadyListening));
        assert_eq!(
            result.detail.as_deref(),
            Some("A listening session is already active.")
        );
        assert!(result.device_name.is_none());
        assert!(result.sample_rate.is_none());
    }

    // -----------------------------------------------------------------------
    // #2897 ST-2 — the model-audio capture session
    // -----------------------------------------------------------------------

    /// Drive the model-audio accumulator with the pre-filled channel dropped
    /// before the call, so `recv()` ends deterministically.
    fn drive_model_audio(messages: Vec<AudioMsg>) -> ModelAudioCaptureOutcome {
        let (tx, rx) = mpsc::channel::<AudioMsg>();
        for message in messages {
            tx.send(message).expect("channel send");
        }
        drop(tx);
        run_model_audio_capture(&rx)
    }

    /// #2897 ST-2: chunks accumulate with NO recognizer and a manual Stop commits
    /// the whole capture with `at_limit:false`.
    #[test]
    fn model_audio_accumulates_every_chunk_and_commits_on_stop() {
        let outcome = drive_model_audio(vec![
            AudioMsg::Samples(vec![0.25_f32; 4]),
            AudioMsg::Samples(vec![0.5_f32; 4]),
            AudioMsg::Stop,
        ]);
        match outcome {
            ModelAudioCaptureOutcome::Clip { samples, at_limit } => {
                assert_eq!(samples.len(), 8, "both chunks accumulate");
                assert_eq!(samples[0], 0.25);
                assert_eq!(samples[7], 0.5);
                assert!(!at_limit, "a manual stop under the ceiling is not at-limit");
            }
            ModelAudioCaptureOutcome::Discarded => panic!("stop must commit the clip"),
        }
    }

    /// #2897 ST-2 (REQ-4): cancel discards everything — no clip is produced.
    #[test]
    fn model_audio_cancel_discards_with_no_clip() {
        let outcome = drive_model_audio(vec![
            AudioMsg::Samples(vec![0.0_f32; 4]),
            AudioMsg::Cancel,
        ]);
        assert!(
            matches!(outcome, ModelAudioCaptureOutcome::Discarded),
            "cancel must discard the capture"
        );
    }

    /// #2897 ST-2/#2897 ST-5 (REQ-6): the accumulation is bounded by the SINGLE
    /// pinned `MAX_AUDIO_CLIP_MS`, the captured prefix is kept sample-for-sample,
    /// and reaching the ceiling IS the auto-stop (`at_limit:true`) — the whole
    /// capture, no truncation of what was captured.
    #[test]
    fn model_audio_bounds_accumulation_at_the_pinned_ceiling() {
        let cap = ms_to_samples(MAX_AUDIO_CLIP_MS);
        assert_eq!(MAX_AUDIO_CLIP_MS, 30_000, "the decided pinned ceiling (R2-2: documented ~30 s per-input limit)");
        assert_eq!(cap, 480_000, "30 s at 16 kHz");
        assert_eq!(cap % 3200, 0, "the ceiling lands on a whole capture chunk");

        // 2× the ceiling: capture auto-stops AT the cap; the prefix survives.
        let mut messages = Vec::new();
        for _ in 0..(cap / 3200 * 2) {
            messages.push(AudioMsg::Samples(vec![0.5_f32; 3200]));
        }
        messages.push(AudioMsg::Stop);

        match drive_model_audio(messages) {
            ModelAudioCaptureOutcome::Clip { samples, at_limit } => {
                assert_eq!(samples.len(), cap, "bounded at the pinned ceiling");
                assert!(at_limit, "reaching the ceiling IS the at-limit flag");
                assert!(
                    samples.iter().all(|&sample| sample == 0.5),
                    "no captured prefix sample may be dropped"
                );
            }
            ModelAudioCaptureOutcome::Discarded => panic!("stop must commit the clip"),
        }
    }

    /// #2897 ST-5 (REQ-6): the bound is an AUTO-STOP, not a lossy cut — the loop
    /// RETURNS the instant the ceiling is reached, so a chunk that would exceed it
    /// is never consumed and the clip is exactly the whole capture (no dropped
    /// tail, no partial chunk).
    #[test]
    fn model_audio_auto_stops_at_the_ceiling_without_consuming_the_tail() {
        let cap = ms_to_samples(MAX_AUDIO_CLIP_MS);
        let mut messages = Vec::new();
        for _ in 0..(cap / 3200) {
            messages.push(AudioMsg::Samples(vec![0.5_f32; 3200]));
        }
        // The tail has a distinct value: if it were consumed the clip would differ.
        messages.push(AudioMsg::Samples(vec![0.9_f32; 3200]));
        messages.push(AudioMsg::Stop);

        match drive_model_audio(messages) {
            ModelAudioCaptureOutcome::Clip { samples, at_limit } => {
                assert_eq!(samples.len(), cap, "the whole capture, exactly the bound");
                assert!(at_limit, "the ceiling auto-stops the capture");
                assert!(
                    samples.iter().all(|&sample| sample == 0.5),
                    "the tail past the bound is never consumed"
                );
            }
            ModelAudioCaptureOutcome::Discarded => panic!("auto-stop must commit the clip"),
        }
    }

    /// #2897 ST-5 (REQ-6): the auto-stop terminal state is a NORMAL warning — the
    /// capture ended (`listening:false`), the whole clip is processing, the bound
    /// is flagged, and the pinned ceiling travels with it. Never an error.
    #[test]
    fn auto_stop_state_is_a_normal_terminal_warning() {
        let state = auto_stop_state("launcher");
        assert!(!state.listening, "the capture is over");
        assert!(state.code.is_none(), "reaching the bound is NEVER an error");
        assert!(state.detail.is_none());
        assert_eq!(state.origin.as_deref(), Some("launcher"));
        assert_eq!(state.phase, Some(SttPhaseWire::Processing));
        assert_eq!(state.limit_reached, Some(true));
        assert_eq!(state.limit_ms, Some(MAX_AUDIO_CLIP_MS));
        assert!(state.ready_ms.is_none());
    }

    /// #2897 ST-2 (REQ-6): exactly-at-the-ceiling is also `at_limit:true`, and
    /// the clip is the full ceiling — never a sample short.
    #[test]
    fn model_audio_marks_the_exact_ceiling_at_limit_with_the_full_clip() {
        let cap = ms_to_samples(MAX_AUDIO_CLIP_MS);
        let mut messages = Vec::new();
        for _ in 0..(cap / 3200) {
            messages.push(AudioMsg::Samples(vec![0.1_f32; 3200]));
        }
        messages.push(AudioMsg::Stop);

        match drive_model_audio(messages) {
            ModelAudioCaptureOutcome::Clip { samples, at_limit } => {
                assert_eq!(samples.len(), cap);
                assert!(at_limit);
            }
            ModelAudioCaptureOutcome::Discarded => panic!("stop must commit the clip"),
        }
    }

    /// #2897 ST-2: the duration helpers are the ONE sample↔ms rule, derived from
    /// the 16 kHz audio rate.
    #[test]
    fn clip_duration_helpers_round_trip_at_16khz() {
        assert_eq!(ms_to_samples(30_000), 480_000);
        assert_eq!(samples_to_ms(480_000), 30_000);
        assert_eq!(ms_to_samples(1_600), 25_600);
        assert_eq!(samples_to_ms(25_600), 1_600);
    }

    /// #2897 ST-2: the clip is a 16 kHz mono 16-bit PCM RIFF/WAVE, sample-for-
    /// sample, with clamping at the extremes.
    #[test]
    fn model_audio_clip_encodes_a_16k_mono_16bit_wav() {
        let samples = vec![0.0_f32, 0.5, -0.5, 1.0];
        let wav = encode_wav_16k_mono(&samples);

        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes([wav[4], wav[5], wav[6], wav[7]]), 36 + 8);
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u32::from_le_bytes([wav[16], wav[17], wav[18], wav[19]]), 16);
        assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1, "PCM");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1, "mono");
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            16_000,
            "16 kHz"
        );
        assert_eq!(
            u32::from_le_bytes([wav[28], wav[29], wav[30], wav[31]]),
            32_000,
            "byte rate = 16 kHz × 2 bytes"
        );
        assert_eq!(u16::from_le_bytes([wav[32], wav[33]]), 2, "block align");
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16, "16-bit");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(
            u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]),
            8,
            "4 samples × 2 bytes"
        );
        assert_eq!(wav.len(), 44 + 8);

        assert_eq!(i16::from_le_bytes([wav[44], wav[45]]), 0);
        assert_eq!(
            i16::from_le_bytes([wav[46], wav[47]]),
            (0.5_f32 * i16::MAX as f32).round() as i16
        );
        assert_eq!(
            i16::from_le_bytes([wav[48], wav[49]]),
            (-0.5_f32 * i16::MAX as f32).round() as i16
        );
        assert_eq!(i16::from_le_bytes([wav[50], wav[51]]), i16::MAX);

        // Out-of-range input clamps instead of wrapping.
        let clamped = encode_wav_16k_mono(&[2.0, -2.0]);
        assert_eq!(i16::from_le_bytes([clamped[44], clamped[45]]), i16::MAX);
        assert_eq!(i16::from_le_bytes([clamped[46], clamped[47]]), -i16::MAX);
    }

    /// #2897 ST-2 (REQ-6): the clip always reports the pinned limit, the real
    /// duration, and `truncated:false` — even at the ceiling (non-lossy).
    #[test]
    fn model_audio_clip_reports_the_pinned_limit_and_never_truncates() {
        let samples = vec![0.0_f32; ms_to_samples(1_600)];
        let clip = encode_clip(&samples, false);
        assert_eq!(clip.format, "wav");
        assert_eq!(clip.sample_rate, capture::AUDIO_SAMPLE_RATE);
        assert_eq!(clip.duration_ms, 1_600);
        assert_eq!(clip.limit_ms, MAX_AUDIO_CLIP_MS);
        assert!(!clip.at_limit);
        assert!(!clip.truncated, "truncated is ALWAYS false (REQ-6 non-lossy)");
        assert!(!clip.base64.is_empty());

        let at_limit = encode_clip(&vec![0.0_f32; ms_to_samples(MAX_AUDIO_CLIP_MS)], true);
        assert_eq!(at_limit.duration_ms, MAX_AUDIO_CLIP_MS);
        assert!(at_limit.at_limit);
        assert!(
            !at_limit.truncated,
            "even an at-ceiling clip is the WHOLE capture — never truncated"
        );
    }

    /// #2897 ST-2: taking the clip is destructive and clears the slot, so a
    /// second take (or a take with nothing committed) yields `clip: None`.
    #[test]
    fn take_audio_clip_is_destructive_and_clears_the_slot() {
        let state = VoiceState::new();
        let clip = encode_clip(&[0.0_f32; 16], false);

        assert!(
            take_clip(&state).clip.is_none(),
            "an empty slot yields no clip"
        );

        *lock_clip(&state) = Some(clip.clone());
        let taken = take_clip(&state);
        let taken_clip = taken.clip.expect("the committed clip is taken");
        assert_eq!(taken_clip.base64, clip.base64);
        assert_eq!(taken_clip.limit_ms, MAX_AUDIO_CLIP_MS);
        assert!(!taken_clip.truncated);

        assert!(
            take_clip(&state).clip.is_none(),
            "taking is destructive: a second call has nothing"
        );
    }

    // ── #2897 ST-6 (REQ-7) — the pre-start capability gate ────────────────────

    /// A failed capability check BLOCKS a start with the typed code (the caller
    /// returns before any capture is opened, so no audio is transmitted); a
    /// `ready` / undetermined snapshot never blocks.
    #[test]
    fn model_audio_start_gate_blocks_only_a_failed_capability_check() {
        let unsupported = SttAudioCapability::unsupported(
            Some("Gemma-4-E2B".to_string()),
            "HTTP 400: unsupported content part",
        );
        let error = model_audio_start_gate(Some(&unsupported))
            .expect("an unsupported capability must block the start");
        assert_eq!(error.code, SttErrorCode::ModelAudioUnsupported);
        assert!(error.detail.contains("HTTP 400"));

        let unavailable = SttAudioCapability::server_unavailable("connection refused");
        let error = model_audio_start_gate(Some(&unavailable))
            .expect("an unreachable server must block the start");
        assert_eq!(error.code, SttErrorCode::ModelAudioUnavailable);
        assert!(error.detail.contains("connection refused"));

        // Indeterminate / not-yet-probed is NOT a failure: the reactive fallback
        // owns a later delivery failure, and a probe that never ran must not
        // invent a verdict.
        assert!(model_audio_start_gate(Some(&SttAudioCapability::ready(None))).is_none());
        assert!(
            model_audio_start_gate(Some(&SttAudioCapability::unknown(None, "HTTP 500"))).is_none()
        );
        assert!(model_audio_start_gate(None).is_none());
    }

    /// The gate's emitted state event carries the typed code on the EXISTING
    /// error channel and claims no capture phase/limit (no session ever started).
    #[test]
    fn gated_start_error_state_carries_the_typed_code_and_no_capture_phase() {
        let error = VoiceError::model_audio_unsupported("the model rejected audio");
        let event = state_event_error(&error, Some("launcher"));
        assert!(!event.listening);
        assert_eq!(event.code, Some(SttErrorCode::ModelAudioUnsupported));
        assert_eq!(event.origin.as_deref(), Some("launcher"));
        assert_eq!(event.phase, None);
        assert_eq!(event.limit_reached, None);
        assert_eq!(event.limit_ms, None);
    }

    /// The capability snapshot is written by the sanctioned probe and read back
    /// by the gate; clearing it returns the "not determined" state.
    #[test]
    fn audio_capability_snapshot_round_trips_and_clears() {
        let state = VoiceState::new();
        assert!(state.audio_capability().is_none());

        state.set_audio_capability(SttAudioCapability::ready(Some("model-x".to_string())));
        let stored = state.audio_capability().expect("the probe stored a snapshot");
        assert_eq!(stored.state, SttAudioCapabilityState::Ready);
        assert_eq!(stored.model.as_deref(), Some("model-x"));

        state.clear_audio_capability();
        assert!(state.audio_capability().is_none());
        // A cleared snapshot is "not determined", never a failure.
        assert!(model_audio_start_gate(state.audio_capability().as_ref()).is_none());
    }
}
