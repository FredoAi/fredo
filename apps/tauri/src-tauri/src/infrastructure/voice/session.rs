//! One-session STT state machine + the recognition loop.
//!
//! `start` gates on the persisted voice preference, an already-active session,
//! and model presence, then starts a dedicated worker thread that opens the
//! `cpal` capture stream for the persisted input device and drives
//! `stt:transcript` / `stt:state` events. The engine comes from the
//! process-resident slot whenever one is parked (ST-3); a hold that finds the
//! slot empty resolves through the backend's SINGLE-FLIGHT warm — it joins an
//! in-flight load, or becomes the registered load itself — so exactly ONE model
//! load can ever run (R-4) and a concurrent `stt_warm` can only join. At session
//! end the used engine is returned to the slot with a fresh stream, so the next
//! dictation starts warm (R-7). `stop` commits the final partial; `cancel`
//! discards it. Every failure is a typed `VoiceError` — no panics.

use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::{AppHandle, Emitter, Manager};

use crate::infrastructure::companion::models::{
    describe_file, resolve_models_dir, FileState, ModelManifest,
};
use crate::infrastructure::storage::AppStore;
use crate::infrastructure::voice::capture::{self, AudioMsg};
use crate::infrastructure::voice::engine::{self, Recognizer, ENGINE_SAMPLE_RATE};
use crate::infrastructure::voice::manifest::resolve_stt_manifest;
use crate::infrastructure::voice::resident::ResidentEngine;
use crate::infrastructure::voice::state::{
    SttAudioClip, SttAudioClipResult, SttErrorCode, SttPhaseWire, SttStartResult, SttStateEvent,
    SttTranscriptEvent, VoiceError, MAX_AUDIO_CLIP_MS,
};

/// Persisted Companion preference (written by the ST-5 toggle, DEFAULT false).
pub const VOICE_ENABLED_KEY: &str = "Fredo_companion_voice_enabled";

/// Persisted Companion preference: the selected input device. The value is a
/// `cpal` device name (`id` from `stt_list_devices`); unset/blank ⇒ the system
/// default.
pub const VOICE_DEVICE_KEY: &str = "Fredo_companion_voice_device_id";

/// Persisted Companion preference: the speech-handling mode written by the
/// Companion settings selector (#2897 ST-1). `"model"` hands the captured
/// utterance to the locally-managed companion model; every other value (unset,
/// stale, blank) heals to local transcription.
pub const VOICE_HANDLING_KEY: &str = "Fredo_companion_voice_handling";

/// Budget for engine load + capture open before `stt_start` gives up.
const START_TIMEOUT: Duration = Duration::from_secs(30);

/// Device facts reported back by the worker once it is ready.
#[derive(Clone, Debug)]
pub struct StartInfo {
    pub device_name: String,
    pub device_sample_rate: u32,
    /// Milliseconds from the `stt_start` receipt to capture-live, stamped by the
    /// worker at the instant capture went live (ST-3/R-1). Never a constant and
    /// never measured from anything but the receipt — a launch-window hold that
    /// joined an in-flight warm therefore includes that wait, so the residual is
    /// visible on the wire instead of masked.
    pub ready_ms: u64,
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
    /// #2897 ST-2: the speech-handling mode this session runs. Stored so the
    /// live/duplicate-start state can report the model-audio phase truthfully
    /// (`capturing` for model audio, `None` for local transcription).
    mode: VoiceHandling,
}

impl ActiveSession {
    /// #2897 ST-2 — the phase of this live session (model audio ⇒ `capturing`).
    fn phase(&self) -> Option<SttPhaseWire> {
        phase_for_handling(self.mode)
    }

    /// #2897 ST-5 (REQ-6) — the pinned ceiling this session is bounded by
    /// (`None` for the shipped local-transcription path).
    fn limit_ms(&self) -> Option<u64> {
        limit_for_handling(self.mode)
    }
}

/// Tauri-managed session state (Send + Sync: only Send fields inside a Mutex).
pub struct VoiceState {
    inner: Mutex<Option<ActiveSession>>,
    /// #2897 ST-2: the bounded clip a model-audio stop committed, awaiting
    /// `stt_take_audio_clip` (which takes + clears it). `None` outside a
    /// model-audio session; never holds a recognizer or a device.
    clip: Mutex<Option<SttAudioClip>>,
    /// #2897 ST-5 (REQ-6): set by the model-audio worker the instant capture
    /// AUTO-STOPPED at [`MAX_AUDIO_CLIP_MS`]. An auto-stopped session is OVER —
    /// `stt_status` reports idle and the already-listening gate lets the next
    /// listen proceed (the stale entry is dropped), while a later `stt_stop`
    /// still re-emits the same terminal `processing`/`limitReached` state. A new
    /// session start clears it.
    auto_stopped: AtomicBool,
}

impl VoiceState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            clip: Mutex::new(None),
            auto_stopped: AtomicBool::new(false),
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

/// #2897 ST-2 — the clip slot, recovered from a poisoned lock exactly like the
/// session slot (never a panic).
fn lock_clip(state: &VoiceState) -> MutexGuard<'_, Option<SttAudioClip>> {
    match state.clip.lock() {
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

/// The closed two-member speech-handling set (#2897 ST-1 / REQ-1). `Local` is
/// the shipped on-device transcription AND the healing default; `Model` routes
/// the captured utterance to the locally-managed multimodal model (ST-2 owns the
/// capture-worker branch that consumes it).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum VoiceHandling {
    Local,
    Model,
}

/// Parse the persisted speech-handling mode. Anything that is not the exact
/// `"model"` literal (unset/stale/blank) heals to `Local` — the setting can
/// never leave the app without the shipped local engine.
pub(crate) fn parse_voice_handling(value: Option<&str>) -> VoiceHandling {
    match value.map(str::trim) {
        Some("model") => VoiceHandling::Model,
        _ => VoiceHandling::Local,
    }
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

/// The persisted speech-handling mode (#2897 ST-1 / REQ-1), read on EVERY
/// `stt_start` (mirroring the enable/device prefs above) so a settings change
/// applies to the NEXT listen with no app restart. An in-flight session is never
/// retro-switched — the mode is resolved once, here.
pub(crate) fn persisted_voice_handling(app: &AppHandle) -> VoiceHandling {
    let value = app
        .state::<std::sync::Arc<AppStore>>()
        .get(VOICE_HANDLING_KEY)
        .ok()
        .flatten();
    parse_voice_handling(value.as_deref())
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
        // An error path never captured, never consumed a resident engine, and
        // never reported a model-audio phase (#2897 ST-2/ST-5).
        ready_ms: None,
        engine_resident: false,
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
    listening_state_with(origin, None, false, None, None)
}

/// The truthful `stt:state` builder WITH the timing observables (ST-1):
/// `ready_ms` (start receipt → capture-live) and `engine_resident` (did the
/// session start from the resident slot). ST-3 stamps these on the start-success
/// path; every other path reports `None`/`false`, so residency is never
/// optimistic. #2897 ST-2 adds the model-audio `phase` (the limit flag is
/// stop-only and is stamped by [`finish_phase`]); #2897 ST-5 adds `limit_ms` —
/// the ONE pinned ceiling every model-audio `stt:state` carries (REQ-6).
fn listening_state_with(
    origin: Option<String>,
    ready_ms: Option<u64>,
    engine_resident: bool,
    phase: Option<SttPhaseWire>,
    limit_ms: Option<u64>,
) -> SttStateEvent {
    SttStateEvent {
        listening: origin.is_some(),
        code: None,
        detail: None,
        origin,
        ready_ms,
        engine_resident,
        phase,
        limit_reached: None,
        limit_ms,
    }
}

/// #2897 ST-2 — the model-audio phase of a live session: `Capturing` for a
/// model-audio capture, `None` for the shipped local-transcription path.
fn phase_for_handling(mode: VoiceHandling) -> Option<SttPhaseWire> {
    match mode {
        VoiceHandling::Model => Some(SttPhaseWire::Capturing),
        VoiceHandling::Local => None,
    }
}

/// #2897 ST-5 (REQ-6) — the pinned ceiling a session of this mode is bounded by.
/// `None` for the shipped local-transcription path (no clip, no bound).
fn limit_for_handling(mode: VoiceHandling) -> Option<u64> {
    match mode {
        VoiceHandling::Model => Some(MAX_AUDIO_CLIP_MS),
        VoiceHandling::Local => None,
    }
}

/// #2897 ST-2 — the terminal (`listening:false`) phase/limit pair for a finished
/// session. A model-audio STOP reports `processing` + the clip's at-ceiling flag
/// (REQ-6); a cancel, a local session, or an absent session reports neither.
fn finish_phase(
    mode: Option<VoiceHandling>,
    is_stop: bool,
    clip_at_limit: Option<bool>,
) -> (Option<SttPhaseWire>, Option<bool>) {
    if mode == Some(VoiceHandling::Model) && is_stop {
        (
            Some(SttPhaseWire::Processing),
            Some(clip_at_limit.unwrap_or(false)),
        )
    } else {
        (None, None)
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

/// `stt_take_audio_clip` — take (and clear) the clip a model-audio stop
/// committed (#2897 ST-2). The clip leaves via IPC only — `voice/` never
/// transmits it (REQ-8).
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
            false,
            active.phase(),
            active.limit_ms(),
        ),
    ))
}

/// Resolve the engine a starting session will use, plus the truthful
/// `engineResident` stamp that MUST travel with it (ST-3 / R-1, R-4).
///
/// 1. Take the parked resident engine — the one-time model load is already paid,
///    which is the whole point of the fast path. This, and ONLY this, is
///    residency.
/// 2. When the slot is empty, resolve the engine through the backend's
///    **single-flight warm** ([`ResidentEngine::warm`]): an in-flight load is
///    JOINED, and with nothing in flight this call BECOMES the registered load
///    — so a concurrent `stt_warm` (the summon-path retry) can only join it.
///    Exactly ONE model load can ever run (R-4). The loaded engine is then taken
///    from the slot, but the stamp stays `false`: the engine was NOT resident at
///    the receipt, so the launch residual is reported honestly, never hidden.
/// 3. A warm that fails leaves the slot empty, so the worker pays today's cold
///    load with the identical typed failures.
///
/// `engine_resident` is `true` ONLY for the genuine take in (1) — never on the
/// joined, self-started or cold path.
async fn acquire_engine(
    app: &AppHandle,
    resident: &ResidentEngine,
) -> (Option<Box<dyn Recognizer>>, bool) {
    acquire_engine_with(resident, || resident.warm(app)).await
}

/// [`acquire_engine`]'s single-flight core, parameterised by the warm so the
/// cold-fallback race is hermetically testable (no `AppHandle`, no model, no
/// device). See [`acquire_engine`] for the residency contract.
async fn acquire_engine_with<F, Fut, T>(
    resident: &ResidentEngine,
    warm: F,
) -> (Option<Box<dyn Recognizer>>, bool)
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = T>,
{
    if let Some(engine) = resident.take() {
        // A genuine slot take: the load was already paid before the receipt.
        return (Some(engine), true);
    }
    // The slot is empty. Awaiting the warm here is deliberate — the wait lands
    // inside the `readyMs` window measured from the receipt — and it is
    // SINGLE-FLIGHT: a concurrent `stt_warm` joins this load rather than
    // starting a second one (R-4).
    let _ = warm().await;
    // Whatever the (possibly joined) warm parked is the session's engine. It is
    // NOT residency: it was not in the slot at the receipt.
    (resident.take(), false)
}

/// Return a finished session's engine to the resident slot with a FRESH stream
/// (R-7): `put_back` renews the stream, so a recognizer that already went
/// through `input_finished` can serve the next session.
///
/// `generation` is the slot generation this session snapshotted when it started.
/// `put_back` refuses it if a `release()` (the voice-disabled edge) landed while
/// the session was live, dropping the engine instead of re-parking it (R-6) —
/// the return is the engine's last reference, so refusing IS the reclaim.
fn park_in_slot(resident: &ResidentEngine, recognizer: Box<dyn Recognizer>, generation: u64) {
    let _ = resident.put_back(recognizer, generation);
}

/// Resolve the managed resident state and park the engine there. Fail-soft: a
/// composition that manages no resident state simply drops the engine exactly
/// as before (the `warm_at_setup` precedent).
fn park_engine(app: &AppHandle, recognizer: Box<dyn Recognizer>, generation: u64) {
    if let Some(resident) = app.try_state::<ResidentEngine>() {
        park_in_slot(&resident, recognizer, generation);
    }
}

/// `stt_start`: gate → resident engine (or the single-flight warm, or the
/// cold-load fallback) + capture on a worker thread → report ready with the
/// truthful `readyMs`/`engineResident` observables.
pub async fn start(app: &AppHandle, origin: &str) -> SttStartResult {
    // The `stt_start` receipt: `readyMs` is measured from HERE. A hold that has
    // to wait on a warm (joined, or started by the acquire below) therefore
    // reports the whole wait — visible, never masked. The ceiling for a hold that
    // is NOT resident is T_LAUNCH_COLD_MAX_MS = 5320 ms
    // (= T_LAUNCH_WARM_MS.max + T_FIRST_CAPTURE_BUDGET_MS.max) — ONE model
    // load (≤ 5000 ms) plus the capture budget (≤ 320 ms).
    let receipt = Instant::now();

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

    // 3. Speech-handling mode + model presence gate. The mode is resolved on
    // EVERY start (#2897 ST-1/REQ-1) so a settings change applies to the NEXT
    // listen with no restart. The pinned sherpa model is the ENGINE's gate: a
    // model-audio session opens no recognizer, so it is neither gated by nor
    // loads that model (#2897 ST-2).
    let handling = persisted_voice_handling(app);
    tracing::debug!("stt_start speech handling: {handling:?}");
    let manifest = resolve_stt_manifest();
    let models_dir = resolve_models_dir(app);
    let model_gate = if handling == VoiceHandling::Local {
        model_error(&models_dir, &manifest)
    } else {
        None
    };
    if let Some(error) = model_gate {
        emit_state(app, &state_event_error(&error, Some(origin)));
        return error.into_start_result();
    }

    // 4. Engine acquisition (ST-3/R-1, R-4) — TRANSCRIPTION ONLY (#2897 ST-2).
    // Take the parked engine so the user-visible path only opens capture. When
    // the slot is empty the acquire resolves through the backend's SINGLE-FLIGHT
    // warm — it joins an in-flight load, or becomes it — so a concurrent
    // `stt_warm` can only join too: never a second concurrent model load.
    // `engine_resident` stays false on those paths, so residency on the wire is
    // never optimistic.
    //
    // A model-audio session opens NO recognizer and never consults the warm: the
    // resident slot is left exactly as it was.
    //
    // The slot generation is snapshotted HERE — before the engine is acquired and
    // before any wait — and every return path hands it back to `put_back`. A
    // `release()` (voice-disabled edge) landing at any point during this session's
    // life therefore invalidates the return, so the engine is dropped instead of
    // re-parked (R-6).
    let (engine, engine_resident, slot_generation) = if handling == VoiceHandling::Model {
        (None, false, 0)
    } else {
        let resident = app.state::<ResidentEngine>();
        let generation = resident.generation();
        let (engine, engine_resident) = acquire_engine(app, &resident).await;
        (engine, engine_resident, generation)
    };

    // 5. Worker owns the engine AND the `cpal::Stream` (both stay on one thread).
    // The persisted device preference is resolved to a name here, but validated
    // against the live device set inside `capture` on the worker — a vanished
    // device is the typed `NoDevice` naming it (AC4), never a silent fallback.
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
    // The engine handoff channel: the engine is handed to the worker only AFTER
    // the thread is spawned, so a failed spawn can re-park it (below) instead of
    // dropping the process-resident engine.
    let (engine_tx, engine_rx) = mpsc::channel::<Option<Box<dyn Recognizer>>>();
    let (outcome_tx, outcome_rx) =
        tokio::sync::oneshot::channel::<Result<StartInfo, VoiceError>>();
    let session_id = uuid::Uuid::new_v4().to_string();
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
                session_id,
                origin: worker_origin,
                models_dir,
                selected_device,
                rx,
                tx: worker_tx,
                engine_rx,
                outcome_tx,
                receipt,
                slot_generation,
                mode: handling,
            });
        }) {
        Ok(handle) => handle,
        Err(error) => {
            // Nothing was started: a spawn failure must never cost the residency
            // (R-7), so the taken engine goes straight back to the slot.
            if let Some(engine) = engine {
                park_engine(app, engine, slot_generation);
            }
            let error = VoiceError::internal(format!("failed to spawn the voice worker: {error}"));
            emit_state(app, &state_event_error(&error, Some(origin)));
            return error.into_start_result();
        }
    };

    // Hand the engine over (the worker blocks for it as its first act). If the
    // worker is already gone the value comes back and is re-parked.
    let returned = match engine_tx.send(engine) {
        Ok(()) => None,
        Err(mpsc::SendError(engine)) => engine,
    };
    if let Some(engine) = returned {
        park_engine(app, engine, slot_generation);
    }

    // 6. Await readiness off the main thread (engine load is the slow part).
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
                    mode: handling,
                });
            }
            // The two honest observables: `ready_ms` is the true receipt →
            // capture-live elapsed time (a joined launch-window wait included),
            // and `engine_resident` is true only for a genuine slot take.
            // #2897 ST-2: a model-audio session is `capturing`; a local session
            // reports no phase (legacy shape).
            emit_state(
                app,
                &listening_state_with(
                    Some(origin.to_string()),
                    Some(info.ready_ms),
                    engine_resident,
                    phase_for_handling(handling),
                    limit_for_handling(handling),
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
    let is_stop = matches!(message, AudioMsg::Stop);
    let session = {
        let state = app.state::<VoiceState>();
        let mut guard = lock_inner(&state);
        guard.take()
    };
    let origin = session.as_ref().map(|session| session.origin.clone());
    let mode = session.as_ref().map(|session| session.mode);

    if let Some(session) = session {
        let ActiveSession {
            control_tx, worker, ..
        } = session;
        let _ = control_tx.send(message);
        // Join off the async runtime thread: the worker flushes (stop) or
        // discards (cancel) before this resolves, so the final transcript is
        // emitted BEFORE the `listening:false` state event. For model audio the
        // worker has committed the clip by the time the join returns.
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let _ = worker.join();
        })
        .await;
    }

    // #2897 ST-2 — a model-audio STOP reports `processing` (the clip is
    // committed, awaiting interpretation) with the clip's at-ceiling flag
    // (REQ-6); a cancel, a local session, or an absent session reports neither.
    let clip_at_limit = if mode == Some(VoiceHandling::Model) && is_stop {
        let state = app.state::<VoiceState>();
        let guard = lock_clip(&state);
        guard.as_ref().map(|clip| clip.at_limit)
    } else {
        None
    };
    // #2897 ST-5 (REQ-6) — a cancel DISCARDS the clip: after an auto-stop the clip
    // is already committed, so a later cancel must reclaim it, exactly as a
    // cancel inside the capture loop discards the in-flight accumulation.
    if mode == Some(VoiceHandling::Model) && !is_stop {
        let state = app.state::<VoiceState>();
        *lock_clip(&state) = None;
        state.auto_stopped.store(false, Ordering::SeqCst);
    }
    let (phase, limit_reached) = finish_phase(mode, is_stop, clip_at_limit);

    let event = SttStateEvent {
        listening: false,
        code: None,
        detail: None,
        origin,
        // Idle: no start happened, so there is no readiness to report.
        ready_ms: None,
        engine_resident: false,
        phase,
        limit_reached,
        // #2897 ST-5 — a model-audio stop carries the pinned ceiling the clip was
        // bounded by, so the limit copy always reads the real bound.
        limit_ms: mode.and_then(limit_for_handling),
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
/// path cannot disagree (R-5.3). A live model-audio session reports `capturing`
/// (#2897 ST-2).
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
            false,
            session.phase(),
            session.limit_ms(),
        ),
        None => listening_state(None),
    }
}

/// Everything one worker thread needs for one session — bundled so the thread
/// body keeps a small signature (ST-3 added the engine handoff + the receipt).
struct WorkerJob {
    /// Owns the engine and the `cpal::Stream` for the session's whole lifetime.
    app: AppHandle,
    session_id: String,
    /// #2897 ST-5 — the session origin, echoed on the worker-emitted auto-stop
    /// `stt:state` (the reachability bound of the actual auto-stop event).
    origin: String,
    models_dir: PathBuf,
    selected_device: Option<String>,
    rx: Receiver<AudioMsg>,
    tx: Sender<AudioMsg>,
    /// The engine handoff from `start` (resident take / warm — joined or
    /// self-started / cold miss).
    engine_rx: Receiver<Option<Box<dyn Recognizer>>>,
    outcome_tx: tokio::sync::oneshot::Sender<Result<StartInfo, VoiceError>>,
    /// The `stt_start` receipt `readyMs` is measured from.
    receipt: Instant,
    /// The slot generation `start` snapshotted before acquisition. Every return
    /// path hands it back to `put_back`, so a `release()` landing while the
    /// session is live drops the engine instead of re-parking it (R-6).
    slot_generation: u64,
    /// #2897 ST-2: the resolved speech-handling mode. `Model` opens no recognizer
    /// and accumulates the clip; `Local` is the shipped recognition loop.
    mode: VoiceHandling,
}

/// Worker thread body: take the engine handed over by `start` (the resident one,
/// or the one the single-flight warm parked), open capture for the persisted
/// device, report readiness with the true `readyMs`, then drive the recognition
/// loop until Stop/Cancel and return the engine to the resident slot. Owns the
/// recognizer and the `cpal::Stream` for its whole lifetime.
///
/// #2897 ST-2: a model-audio session (`mode == Model`) takes NO engine and NEVER
/// consults the warm — it opens the SAME capture, accumulates the chunks with no
/// recognizer, and commits one bounded WAV clip on Stop.
fn worker_main(job: WorkerJob) {
    let WorkerJob {
        app,
        session_id,
        origin,
        models_dir,
        selected_device,
        rx,
        tx,
        engine_rx,
        outcome_tx,
        receipt,
        slot_generation,
        mode,
    } = job;

    // The engine `start` acquired: the resident take, or the one the
    // single-flight warm (joined or self-started) parked. `None` ⇒ the warm
    // left the slot empty ⇒ the one-time cold load, with the identical typed
    // failures.
    //
    // #2897 ST-2 — TRANSCRIPTION ONLY: a model-audio session opens no recognizer
    // and never touches the resident slot, so the engine handoff is skipped
    // entirely.
    let recognizer: Option<Box<dyn Recognizer>> = if mode == VoiceHandling::Model {
        None
    } else {
        let resident_engine = engine_rx.recv().ok().flatten();
        match resident_engine {
            Some(recognizer) => Some(recognizer),
            None => match engine::load_recognizer(&models_dir) {
                Ok(recognizer) => Some(recognizer),
                Err(error) => {
                    let _ = outcome_tx.send(Err(error));
                    return;
                }
            },
        }
    };

    let capture = match capture::start_capture(tx, selected_device.as_deref()) {
        Ok(capture) => capture,
        Err(error) => {
            // The engine is still good — park it before reporting the failure so
            // a failed device open never costs the residency (R-7).
            if let Some(recognizer) = recognizer {
                park_engine(&app, recognizer, slot_generation);
            }
            let _ = outcome_tx.send(Err(error));
            return;
        }
    };

    // Capture is LIVE here (the device stream is playing): `readyMs` is measured
    // to this instant, from the `stt_start` receipt — so the gate work, a joined
    // launch-window wait, the spawn and the cold load are all inside the number
    // rather than hidden.
    let info = StartInfo {
        device_name: capture.device_name.clone(),
        device_sample_rate: capture.device_sample_rate,
        ready_ms: elapsed_ms(receipt),
    };
    if outcome_tx.send(Ok(info)).is_err() {
        // The caller gave up; park the engine, drop capture and exit.
        if let Some(recognizer) = recognizer {
            park_engine(&app, recognizer, slot_generation);
        }
        return;
    }

    match mode {
        VoiceHandling::Local => {
            if let Some(mut recognizer) = recognizer {
                let sink = AppHandleSink::new(app.clone());
                run_recognition(&sink, &session_id, recognizer.as_mut(), &rx);
                park_engine(&app, recognizer, slot_generation);
            }
        }
        // #2897 ST-2: no recognizer, no engine — accumulate the bounded clip and
        // commit it on Stop. `capture` (and its stream/feed) drops at scope end.
        // #2897 ST-5: reaching the pinned ceiling AUTO-STOPS the capture (the
        // worker returns, so the microphone is released at the bound) and emits
        // the terminal warning state itself — the user keeps holding, the clip is
        // kept whole and delivered.
        VoiceHandling::Model => run_model_audio_session(&app, &rx, &origin),
    }
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
        engine_resident: false,
        phase: Some(SttPhaseWire::Processing),
        limit_reached: Some(true),
        limit_ms: Some(MAX_AUDIO_CLIP_MS),
    }
}

/// #2897 ST-2 — samples for a millisecond duration at the 16 kHz engine rate.
fn ms_to_samples(ms: u64) -> usize {
    (ms * ENGINE_SAMPLE_RATE as u64 / 1_000) as usize
}

/// #2897 ST-2 — the duration of a sample run at the 16 kHz engine rate.
fn samples_to_ms(samples: usize) -> u64 {
    samples as u64 * 1_000 / ENGINE_SAMPLE_RATE as u64
}

/// #2897 ST-2 — encode one bounded capture as the clip wire type. `truncated` is
/// ALWAYS false: the clip is the WHOLE captured audio (REQ-6 non-lossy).
fn encode_clip(samples: &[f32], at_limit: bool) -> SttAudioClip {
    let wav = encode_wav_16k_mono(samples);
    SttAudioClip {
        base64: STANDARD.encode(&wav),
        format: "wav".to_string(),
        sample_rate: ENGINE_SAMPLE_RATE as u32,
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
    let sample_rate = ENGINE_SAMPLE_RATE as u32;
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

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
        /// Shared so the count survives boxing (the resident-slot round trip).
        new_stream_calls: Arc<AtomicUsize>,
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
                new_stream_calls: Arc::new(AtomicUsize::new(0)),
            }
        }

        /// The stream-renewal counter, cloned BEFORE boxing the fake.
        fn stream_counter(&self) -> Arc<AtomicUsize> {
            Arc::clone(&self.new_stream_calls)
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
            self.new_stream_calls.fetch_add(1, Ordering::SeqCst);
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

    /// The warm seam for pins that only exercise a genuine slot take: being
    /// reached means the acquire consulted the warm on a take — a bug.
    async fn must_not_warm() {
        panic!("the acquire consulted the warm on a genuine slot take");
    }

    /// A release-gated warm (the `resident.rs` single-flight race harness shape):
    /// `enter` fires when the loader is inside the load and the load then blocks
    /// until the test releases it, so a concurrent caller can be proven to JOIN
    /// rather than load.
    struct WarmGate {
        entered_tx: tokio::sync::watch::Sender<bool>,
        entered_rx: tokio::sync::watch::Receiver<bool>,
        release_tx: tokio::sync::watch::Sender<bool>,
        release_rx: tokio::sync::watch::Receiver<bool>,
    }

    impl WarmGate {
        fn new() -> Self {
            let (entered_tx, entered_rx) = tokio::sync::watch::channel(false);
            let (release_tx, release_rx) = tokio::sync::watch::channel(false);
            Self {
                entered_tx,
                entered_rx,
                release_tx,
                release_rx,
            }
        }

        fn enter(&self) {
            let _ = self.entered_tx.send(true);
        }

        fn release(&self) {
            let _ = self.release_tx.send(true);
        }

        async fn wait_entered(&self) {
            let mut rx = self.entered_rx.clone();
            while !*rx.borrow_and_update() {
                let _ = rx.changed().await;
            }
        }

        async fn wait_release(&self) {
            let mut rx = self.release_rx.clone();
            while !*rx.borrow_and_update() {
                let _ = rx.changed().await;
            }
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
        // The default builder claims neither readiness nor residency (ST-3):
        // only the start-success path may stamp them.
        assert!(live.ready_ms.is_none());
        assert!(!live.engine_resident);

        let idle = listening_state(None);
        assert!(!idle.listening);
        assert!(idle.code.is_none());
        assert!(idle.detail.is_none());
        assert!(idle.origin.is_none());
        assert!(idle.ready_ms.is_none());
        assert!(!idle.engine_resident);
    }

    /// ST-3/R-1: the start-success `stt:state` carries the TRUE receipt-based
    /// `readyMs` and the honest residency stamp. A joined launch-window start
    /// reports its whole (longer) wait but is NOT marked resident — the residual
    /// is visible on the wire, never masked.
    #[test]
    fn start_success_state_carries_the_receipt_based_ready_ms_and_residency() {
        let resident = listening_state_with(Some("launcher".to_string()), Some(137), true, None, None);
        assert!(resident.listening);
        assert_eq!(resident.origin.as_deref(), Some("launcher"));
        assert_eq!(resident.ready_ms, Some(137));
        assert!(resident.engine_resident);
        assert!(resident.code.is_none());
        assert!(resident.detail.is_none());
        // #2897 ST-2/#2897 ST-5 — a local (no-phase) start reports neither a
        // model-audio phase nor a pinned ceiling.
        assert!(resident.phase.is_none());
        assert!(resident.limit_reached.is_none());
        assert!(resident.limit_ms.is_none());

        // The join shape: a large, honest wait that includes the joined warm.
        let joined =
            listening_state_with(Some("launcher".to_string()), Some(2_940), false, None, None);
        assert!(joined.listening);
        assert_eq!(
            joined.ready_ms,
            Some(2_940),
            "the joined launch-window wait must be reported, never masked"
        );
        assert!(
            !joined.engine_resident,
            "a joined warm is NOT a resident start (never an optimistic stamp)"
        );

        // #2897 ST-2 — a model-audio start reports `capturing`.
        let model = listening_state_with(
            Some("launcher".to_string()),
            Some(80),
            false,
            Some(SttPhaseWire::Capturing),
            Some(MAX_AUDIO_CLIP_MS),
        );
        assert_eq!(model.phase, Some(SttPhaseWire::Capturing));
        assert!(model.limit_reached.is_none());
        // #2897 ST-5 (REQ-6) — the capture advertises the ONE pinned ceiling, so
        // the UI's countdown derives the real bound from the backend constant.
        assert_eq!(model.limit_ms, Some(MAX_AUDIO_CLIP_MS));
    }

    /// ST-3/R-1: no error path may claim readiness or residency — the two
    /// observables stay `None`/`false` off the start-success path.
    #[test]
    fn error_states_never_report_readiness_or_residency() {
        let error = state_event_error(
            &VoiceError::engine_start_failed("OnlineRecognizer::create returned None"),
            Some("launcher"),
        );
        assert!(!error.listening);
        assert_eq!(error.code, Some(SttErrorCode::EngineStartFailed));
        assert!(error.ready_ms.is_none());
        assert!(!error.engine_resident);
    }

    /// ST-3/R-4: a parked engine is taken for the session and reported as
    /// resident, and the slot is empty while the session owns it. A genuine take
    /// never consults the warm (the loader panics if it is ever reached).
    #[tokio::test]
    async fn acquire_engine_takes_the_resident_engine_and_reports_residency() {
        let resident = ResidentEngine::new();
        let parked = FakeRecognizer::new(Vec::new(), None);
        let streams = parked.stream_counter();
        resident.put_back(Box::new(parked), resident.generation());
        assert_eq!(
            streams.load(Ordering::SeqCst),
            1,
            "parking renews the stream exactly once"
        );

        let (engine, engine_resident) = acquire_engine_with(&resident, must_not_warm).await;
        assert!(engine.is_some(), "the parked engine is handed to the session");
        assert!(engine_resident, "a genuine slot take IS residency");
        assert!(
            !resident.is_resident(),
            "at most ONE engine per process: the slot is empty while the session holds it"
        );
        assert!(
            acquire_engine_with(&resident, || async {}).await.0.is_none(),
            "a second acquirer finds no parked engine"
        );
    }

    /// ST-3/R-4 + F2: an empty slot is resolved through the backend's
    /// SINGLE-FLIGHT warm — the acquire becomes the registered load, takes what
    /// it parks, and reports the honest `false` residency stamp (it was NOT
    /// resident at the receipt).
    #[tokio::test]
    async fn acquire_engine_starts_the_single_flight_warm_when_the_slot_is_empty() {
        let resident = ResidentEngine::new();
        let loads = Arc::new(AtomicUsize::new(0));

        let (engine, engine_resident) = acquire_engine_with(&resident, || {
            resident.warm_with({
                let loads = Arc::clone(&loads);
                move || async move {
                    loads.fetch_add(1, Ordering::SeqCst);
                    Ok(Box::new(FakeRecognizer::new(Vec::new(), None)) as Box<dyn Recognizer>)
                }
            })
        })
        .await;

        assert!(
            engine.is_some(),
            "the single-flight warm's engine serves the session"
        );
        assert!(
            !engine_resident,
            "a self-started warm is NOT residency — never an optimistic stamp"
        );
        assert_eq!(loads.load(Ordering::SeqCst), 1, "exactly one load on this path");
        assert!(
            !resident.is_resident(),
            "the session holds the engine the warm parked"
        );
    }

    /// ST-3/R-4 + F2: when the warm FAILS the slot stays empty, so the worker
    /// pays today's cold load with the identical typed failures — the acquire
    /// never wedges the session on a failed warm.
    #[tokio::test]
    async fn acquire_engine_falls_back_to_the_cold_load_after_a_failed_warm() {
        let resident = ResidentEngine::new();
        let (engine, engine_resident) = acquire_engine_with(&resident, || async {}).await;
        assert!(
            engine.is_none(),
            "a failed warm leaves the slot empty ⇒ the worker cold-loads as today"
        );
        assert!(!engine_resident, "never an optimistic residency stamp");
        assert!(!resident.is_resident());
    }

    /// ST-3/R-4 + F2: the cold-fallback acquire registers its load in the
    /// single-flight slot, so a concurrent `stt_warm` (the summon-path retry)
    /// JOINs it — exactly ONE model load ever runs. The joined session still
    /// reports `engineResident:false` and its `readyMs` is the true receipt-based
    /// elapsed wait, never a constant.
    #[tokio::test]
    async fn a_cold_fallback_acquire_joins_a_concurrent_warm_with_one_load() {
        let resident = Arc::new(ResidentEngine::new());
        let loads = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(WarmGate::new());
        let receipt = Instant::now();

        // The hold arrives at an empty slot: `acquire` starts the single-flight
        // warm itself and blocks on it (the gate holds the load open).
        let acquire = {
            let resident = Arc::clone(&resident);
            let loads = Arc::clone(&loads);
            let gate = Arc::clone(&gate);
            tokio::spawn(async move {
                acquire_engine_with(&resident, || {
                    resident.warm_with({
                        let loads = Arc::clone(&loads);
                        let gate = Arc::clone(&gate);
                        move || async move {
                            loads.fetch_add(1, Ordering::SeqCst);
                            gate.enter();
                            gate.wait_release().await;
                            Ok(Box::new(FakeRecognizer::new(Vec::new(), None))
                                as Box<dyn Recognizer>)
                        }
                    })
                })
                .await
            })
        };

        gate.wait_entered().await;
        assert_eq!(
            loads.load(Ordering::SeqCst),
            1,
            "the acquire registered ONE single-flight load"
        );
        assert!(
            !acquire.is_finished(),
            "the hold is waiting on its own in-flight warm"
        );

        // The concurrent `stt_warm` arrives now. It must JOIN the acquire's
        // load — its loader panics if it is ever reached.
        let concurrent = {
            let resident = Arc::clone(&resident);
            tokio::spawn(async move {
                resident
                    .warm_with(|| async {
                        panic!("a concurrent warm must JOIN the in-flight load, never load")
                    })
                    .await
            })
        };
        tokio::task::yield_now().await;
        assert_eq!(
            loads.load(Ordering::SeqCst),
            1,
            "never a second concurrent model load"
        );
        assert!(
            !concurrent.is_finished(),
            "the concurrent warm joined the in-flight single flight"
        );

        gate.release();
        let (engine, engine_resident) = acquire.await.expect("acquire task");
        let joined = concurrent.await.expect("concurrent warm task");

        assert!(
            engine.is_some(),
            "the single load's engine is handed to the session"
        );
        assert!(
            !engine_resident,
            "a self-started/joined warm is NOT residency (never an optimistic stamp)"
        );
        assert_eq!(
            loads.load(Ordering::SeqCst),
            1,
            "exactly ONE model load for both callers"
        );
        assert!(
            joined.warm_ms.is_none(),
            "the joining warm performed no load of its own"
        );
        assert!(!resident.is_resident(), "the session holds the engine");

        // `readyMs` is the receipt → capture-live elapsed time (worker_main
        // stamps it from the `stt_start` receipt), so the whole joined wait is
        // inside it and the value can never be a constant.
        tokio::time::sleep(Duration::from_millis(10)).await;
        let ready_ms = elapsed_ms(receipt);
        assert!(
            ready_ms >= 5,
            "readyMs measures the joined wait; got {ready_ms} ms"
        );
        let state = listening_state_with(
            Some("launcher".to_string()),
            Some(ready_ms),
            engine_resident,
            None,
            None,
        );
        assert_eq!(state.ready_ms, Some(ready_ms));
        assert!(
            !state.engine_resident,
            "the joined start is never stamped resident on the wire"
        );
    }

    /// ST-3/R-7: the engine used by a session is RETURNED to the slot with a
    /// fresh stream, so the next dictation starts warm instead of re-paying the
    /// one-time model load.
    #[tokio::test]
    async fn a_used_engine_is_returned_to_the_slot_with_a_fresh_stream() {
        let resident = ResidentEngine::new();
        let parked = FakeRecognizer::new(Vec::new(), None);
        let streams = parked.stream_counter();
        let generation = resident.generation();
        resident.put_back(Box::new(parked), generation);

        let (engine, engine_resident) = acquire_engine_with(&resident, must_not_warm).await;
        assert!(engine_resident);
        let engine = engine.expect("the parked engine was taken");

        park_in_slot(&resident, engine, generation);
        assert!(resident.is_resident(), "retained across the session boundary");
        assert_eq!(
            streams.load(Ordering::SeqCst),
            2,
            "the returned engine got a fresh stream (one park + one return)"
        );
    }

    /// R-6 defect pin at the session seam: the generation `start` snapshots
    /// travels with the session, so a `release()` landing while the session is
    /// live makes the return a DROP — residency stays false and the engine is
    /// never re-parked. (The `resident.rs` pins cover the slot mechanics; this
    /// one pins that the session seam passes the generation through.)
    #[tokio::test]
    async fn a_session_that_started_before_a_release_drops_its_engine_on_return() {
        let resident = ResidentEngine::new();
        let parked = FakeRecognizer::new(Vec::new(), None);
        let streams = parked.stream_counter();
        let generation = resident.generation();
        resident.put_back(Box::new(parked), generation);

        // Session start: snapshot + take (exactly what `start` does).
        let (engine, engine_resident) = acquire_engine_with(&resident, must_not_warm).await;
        assert!(engine_resident);
        let engine = engine.expect("the parked engine was taken");

        // The voice-disabled edge lands while the session is live.
        assert!(!resident.release(), "the session holds the only engine");

        // Session end: the return drops the engine (R-6), never re-parks it.
        park_in_slot(&resident, engine, generation);
        assert!(
            !resident.is_resident(),
            "a pre-release session's return must not re-establish residency"
        );
        assert_eq!(
            streams.load(Ordering::SeqCst),
            1,
            "the park's renewal only — a refused return renews nothing"
        );
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
            mode: VoiceHandling::Local,
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
        // ST-3: the duplicate-start re-emit reports no new start, so it claims
        // neither readiness nor residency.
        assert!(event.ready_ms.is_none());
        assert!(!event.engine_resident);

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

    /// #2897 ST-1 (REQ-1): the speech-handling key is a closed two-member set —
    /// only the exact `"model"` literal selects model audio; every other stored
    /// value (unset/stale/blank) heals to local transcription, so an existing
    /// install (no key) keeps the shipped behaviour.
    #[test]
    fn parse_voice_handling_heals_everything_but_model_to_local() {
        for value in [
            None,
            Some(""),
            Some("   "),
            Some("local"),
            Some("Local"),
            Some("bogus"),
            Some("modell"),
        ] {
            assert_eq!(
                parse_voice_handling(value),
                VoiceHandling::Local,
                "{value:?} must heal to local"
            );
        }
        assert_eq!(
            parse_voice_handling(Some("model")),
            VoiceHandling::Model,
            "the exact `model` literal must select model audio"
        );
        assert_eq!(
            parse_voice_handling(Some("  model  ")),
            VoiceHandling::Model,
            "a trimmed `model` literal must select model audio"
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
        assert_eq!(MAX_AUDIO_CLIP_MS, 30_000, "the provisional pinned ceiling");
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
        assert!(!state.engine_resident);
    }

    /// #2897 ST-5 (REQ-6): only a model-audio session is bounded by the pinned
    /// ceiling; the shipped local-transcription path advertises none.
    #[test]
    fn limit_for_handling_bounds_only_model_audio() {
        assert_eq!(limit_for_handling(VoiceHandling::Model), Some(MAX_AUDIO_CLIP_MS));
        assert_eq!(limit_for_handling(VoiceHandling::Local), None);
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
    /// the 16 kHz engine rate.
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
        assert_eq!(clip.sample_rate, ENGINE_SAMPLE_RATE as u32);
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

    /// #2897 ST-2: only a model-audio session reports `capturing`; the local
    /// transcription path keeps the legacy (no-phase) shape.
    #[test]
    fn phase_for_handling_marks_only_model_audio_capturing() {
        assert_eq!(
            phase_for_handling(VoiceHandling::Model),
            Some(SttPhaseWire::Capturing)
        );
        assert_eq!(phase_for_handling(VoiceHandling::Local), None);
    }

    /// #2897 ST-2 (REQ-4/REQ-6): the terminal event reports `processing` + the
    /// at-ceiling flag ONLY for a model-audio STOP; cancel/local stay phase-less.
    #[test]
    fn finish_phase_reports_processing_only_for_a_model_audio_stop() {
        assert_eq!(
            finish_phase(Some(VoiceHandling::Model), true, Some(true)),
            (Some(SttPhaseWire::Processing), Some(true))
        );
        assert_eq!(
            finish_phase(Some(VoiceHandling::Model), true, Some(false)),
            (Some(SttPhaseWire::Processing), Some(false))
        );
        assert_eq!(
            finish_phase(Some(VoiceHandling::Model), false, None),
            (None, None),
            "a cancel never reports processing"
        );
        assert_eq!(
            finish_phase(Some(VoiceHandling::Local), true, None),
            (None, None),
            "a local stop keeps the legacy shape"
        );
        assert_eq!(finish_phase(None, true, None), (None, None));
    }
}
