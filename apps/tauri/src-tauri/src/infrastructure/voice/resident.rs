//! The app-global resident STT engine: at most ONE engine per process (ST-2).
//!
//! Residency is **process-lifetime and engine-only** (R-6/R-7): this module
//! never opens the microphone and owns no audio path at all — the engine is
//! loaded once, from the earliest safe moment (backend setup, off the critical
//! path, never on the UI thread) and reused across sessions through
//! [`Recognizer::new_stream`]. There is no idle timeout, no persisted key and no
//! Settings surface; the engine is dropped only on the voice-disabled edge or at
//! process exit.
//!
//! **Single-flight is the point of this module.** A `warm` arriving while a warm
//! is IN FLIGHT *joins* it — never a second concurrent model load — and
//! residency is reported ONLY once the engine is genuinely in the slot. A failed
//! warm leaves the slot empty and clears the in-flight state, so the next
//! `stt_start` cold-loads (and reports its typed error) exactly as today.
//!
//! **BOTH edges of residency are generation-guarded.** [`ResidentEngine::release`]
//! bumps the slot generation: a warm that finishes afterwards is dropped rather
//! than parked, and a session that started before the release — it holds the
//! engine while the release lands — has its [`ResidentEngine::put_back`] refused,
//! so its engine is dropped too instead of re-parking what the voice-disabled
//! edge just reclaimed (R-6). Re-enabling voice warms again at the new generation
//! and parks normally, so the guard reclaims the memory without permanently
//! poisoning the module.
//!
//! # Layout
//!
//! [`ResidentEngine::warm_at_setup`] is the earliest-safe warm, called once from
//! `lib.rs` setup with the state already managed. [`ResidentEngine::warm`] is
//! the idempotent, single-flight command behind `stt_warm`.
//! [`ResidentEngine::take`]/[`ResidentEngine::put_back`] are the session seams
//! (wired by ST-3), and [`ResidentEngine::release`] is the voice-disabled edge.

use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use tauri::{AppHandle, Manager};
use tokio::sync::watch;

use crate::infrastructure::companion::models::resolve_models_dir;
use crate::infrastructure::voice::engine::{self, Recognizer};
use crate::infrastructure::voice::manifest::resolve_stt_manifest;
use crate::infrastructure::voice::session;
use crate::infrastructure::voice::state::{SttWarmResult, VoiceError};

/// The resident slot + the single-flight bookkeeping.
struct ResidentInner {
    /// The parked engine — `None` means "not resident" (the caller cold-loads).
    engine: Option<Box<dyn Recognizer>>,
    /// The load currently in flight, if any. Every concurrent `warm` joins it;
    /// while it is `Some`, the slot is not resident (never report residency the
    /// engine does not have).
    in_flight: Option<Arc<WarmFlight>>,
    /// Bumped by [`ResidentEngine::release`]. A load that finishes after a
    /// release must NOT re-park the engine: the voice-disabled edge reclaims the
    /// memory for good (R-6).
    generation: u64,
}

/// The app-global resident STT engine: at most ONE per process (mirrors
/// `VoiceState`).
pub struct ResidentEngine {
    inner: Mutex<ResidentInner>,
}

impl ResidentEngine {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(ResidentInner {
                engine: None,
                in_flight: None,
                generation: 0,
            }),
        }
    }

    /// The earliest-safe warm: called ONCE from `lib.rs` setup, after the state
    /// is managed. Returns IMMEDIATELY — the load runs on a background thread, so
    /// app startup is never blocked or delayed (fire-and-forget: nothing on the
    /// setup path awaits this). Gated on the persisted opt-in flag + model
    /// presence and silent on failure — the next `stt_start` cold-loads and
    /// reports the typed error exactly as today.
    pub fn warm_at_setup(app: &AppHandle) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            // Deliberately dropped: a failed launch warm is silent.
            let _ = warm_at_setup_task(&app).await;
        });
    }

    /// Idempotent + SINGLE-FLIGHT warm. Resolves the gates and loads the engine
    /// off the async-runtime thread. NEVER opens the microphone.
    pub async fn warm(&self, app: &AppHandle) -> SttWarmResult {
        self.warm_with(|| load(app)).await
    }

    /// The single-flight core, parameterised by the loader so it is hermetically
    /// testable (no `AppHandle`, no model, no device). `pub(crate)` so the
    /// session-seam pins in `session.rs` can drive the REAL single-flight
    /// bookkeeping while pinning the cold-fallback acquire race.
    pub(crate) async fn warm_with<F, Fut>(&self, load: F) -> SttWarmResult
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Box<dyn Recognizer>, VoiceError>>,
    {
        enum Path {
            /// The engine is genuinely in the slot.
            Resident,
            /// Another warm is loading — join it; never start a second load.
            Join(Arc<WarmFlight>),
            /// This call owns the load, with the generation it must still see to
            /// park the engine (`release` invalidates it).
            Load(Arc<WarmFlight>, u64),
        }

        let path = {
            let mut guard = lock_inner(self);
            if guard.engine.is_some() {
                Path::Resident
            } else if let Some(flight) = guard.in_flight.clone() {
                Path::Join(flight)
            } else {
                let flight = Arc::new(WarmFlight::new());
                guard.in_flight = Some(Arc::clone(&flight));
                Path::Load(flight, guard.generation)
            }
        };

        match path {
            Path::Resident => SttWarmResult::resident(None),
            // A join reports the TRUE outcome of the load it waited on, and
            // `warmed:true` only if the engine is really in the slot now.
            Path::Join(flight) => match flight.wait().await {
                Ok(_) if self.is_resident() => SttWarmResult::resident(None),
                Ok(_) => SttWarmResult::failed(&VoiceError::internal(
                    "the joined warm finished without an engine in the resident slot",
                )),
                Err(error) => SttWarmResult::failed(&error),
            },
            Path::Load(flight, generation) => {
                let started = Instant::now();
                let outcome = load().await;
                let result = match outcome {
                    Ok(recognizer) => {
                        let mut guard = lock_inner(self);
                        let released = guard.generation != generation;
                        if !released {
                            guard.engine = Some(recognizer);
                        }
                        guard.in_flight = None;
                        drop(guard);
                        if released {
                            Err(VoiceError::internal(
                                "the resident engine was released while this warm was in flight",
                            ))
                        } else {
                            Ok(elapsed_ms(started))
                        }
                    }
                    Err(error) => {
                        lock_inner(self).in_flight = None;
                        Err(error)
                    }
                };
                // Publish AFTER the slot is settled so every joiner observes the
                // true residency.
                flight.complete(result.clone());
                match result {
                    Ok(warm_ms) => SttWarmResult::resident(Some(warm_ms)),
                    Err(error) => SttWarmResult::failed(&error),
                }
            }
        }
    }

    /// Await the in-flight warm if one exists, else return immediately. Returns
    /// true iff the engine is genuinely resident once the (possibly absent) warm
    /// settled — `stt_start` uses this so a hold inside the launch window JOINS
    /// the load instead of starting a second one. A joiner NEVER reports
    /// residency it does not have.
    pub async fn join_in_flight(&self) -> bool {
        let flight = { lock_inner(self).in_flight.clone() };
        match flight {
            Some(flight) => flight.wait().await.is_ok() && self.is_resident(),
            None => false,
        }
    }

    /// Take the resident engine for a session. `None` ⇒ the caller cold-loads as
    /// today; `None` also means "not yet resident", and callers MUST NOT report
    /// `engineResident:true` on that path.
    pub fn take(&self) -> Option<Box<dyn Recognizer>> {
        lock_inner(self).engine.take()
    }

    /// The slot's current generation. A session snapshots this **before** it
    /// acquires its engine and passes the same value back to
    /// [`ResidentEngine::put_back`] on every return path.
    ///
    /// [`ResidentEngine::release`] bumps the generation, so a session that started
    /// before a release can never re-park its engine afterwards — R-6's memory
    /// reclaim survives a live session's return.
    pub fn generation(&self) -> u64 {
        lock_inner(self).generation
    }

    /// Return a used engine to the slot with a FRESH stream (R-7: retention), but
    /// ONLY while the slot still sits at `generation` — the value the session
    /// snapshotted with [`ResidentEngine::generation`] when it started. A
    /// recognizer that already went through `input_finished` is not reusable
    /// without the renewal.
    ///
    /// - **Match** ⇒ the engine is parked exactly as before (the normal path).
    /// - **Mismatch** ⇒ a [`ResidentEngine::release`] landed while the session was
    ///   live, so the engine is **dropped here** and the slot stays as the release
    ///   left it (R-6). The stream is deliberately NOT renewed on this path.
    ///
    /// Returns `true` iff the engine was parked. Callers must not retry a refused
    /// engine — dropping it IS the contract.
    pub fn put_back(&self, mut recognizer: Box<dyn Recognizer>, generation: u64) -> bool {
        let mut guard = lock_inner(self);
        if guard.generation != generation {
            return false;
        }
        recognizer.new_stream();
        guard.engine = Some(recognizer);
        true
    }

    /// Drop the resident engine and reclaim its memory (the voice-disabled edge,
    /// R-6). Idempotent: returns whether an engine was actually dropped. Always
    /// invalidates any in-flight warm, so a load that finishes after this point
    /// cannot re-park an engine while voice input is disabled.
    pub fn release(&self) -> bool {
        let mut guard = lock_inner(self);
        guard.generation = guard.generation.wrapping_add(1);
        guard.engine.take().is_some()
    }

    /// True iff the engine is parked in the slot right now.
    pub fn is_resident(&self) -> bool {
        lock_inner(self).engine.is_some()
    }
}

impl Default for ResidentEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// A poisoned lock still carries the resident slot; recover instead of panicking
/// (the `session::lock_inner` precedent, R-5.6).
fn lock_inner(state: &ResidentEngine) -> MutexGuard<'_, ResidentInner> {
    match state.inner.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Resolve the resident state and warm it. Split out of the spawned task so the
/// borrowed `State` never has to outlive the owned `AppHandle` inside the
/// closure, and fail-soft if the state is somehow not managed.
async fn warm_at_setup_task(app: &AppHandle) -> SttWarmResult {
    match app.try_state::<ResidentEngine>() {
        Some(resident) => resident.warm(app).await,
        None => SttWarmResult::failed(&VoiceError::internal(
            "the resident STT engine state is not managed",
        )),
    }
}

/// Gate + load, off the async-runtime thread (never the UI thread). The gates
/// reuse the SAME helpers (and therefore the same `VoiceError` vocabulary) as
/// `session::start`, so `warm` and `stt_start` can never disagree.
async fn load(app: &AppHandle) -> Result<Box<dyn Recognizer>, VoiceError> {
    if !session::voice_enabled(app) {
        return Err(VoiceError::disabled());
    }
    let manifest = resolve_stt_manifest();
    let models_dir = resolve_models_dir(app);
    if let Some(error) = session::model_error(&models_dir, &manifest) {
        return Err(error);
    }
    tauri::async_runtime::spawn_blocking(move || engine::load_recognizer(&models_dir))
        .await
        .map_err(|error| {
            VoiceError::internal(format!("the resident warm task failed to join: {error}"))
        })?
}

fn elapsed_ms(since: Instant) -> u64 {
    since.elapsed().as_millis() as u64
}

/// One in-flight load, shared with every joiner. The watch channel RETAINS the
/// outcome, so a joiner arriving after completion resolves immediately and never
/// blocks on a finished warm.
struct WarmFlight {
    tx: watch::Sender<Option<Result<u64, VoiceError>>>,
    rx: watch::Receiver<Option<Result<u64, VoiceError>>>,
}

impl WarmFlight {
    fn new() -> Self {
        let (tx, rx) = watch::channel(None);
        Self { tx, rx }
    }

    /// Publish the outcome to every current and future joiner.
    fn complete(&self, outcome: Result<u64, VoiceError>) {
        let _ = self.tx.send(Some(outcome));
    }

    async fn wait(&self) -> Result<u64, VoiceError> {
        let mut rx = self.rx.clone();
        loop {
            let current = {
                let borrowed = rx.borrow_and_update();
                borrowed.clone()
            };
            if let Some(outcome) = current {
                return outcome;
            }
            if rx.changed().await.is_err() {
                return Err(VoiceError::internal(
                    "the resident warm ended without reporting an outcome",
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    //! Hermetic resident-lifecycle pins: the single-flight contract, the honest
    //! residency reporting, the stream renewal on `put_back`, the release-during-
    //! load guard, and the generation-guarded session return (a pre-release
    //! session can never re-park the engine) all run against an injected loader
    //! and a fake [`Recognizer`] — no `AppHandle`, no model, no device, no network.

    use super::*;

    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::infrastructure::voice::state::SttErrorCode;

    /// Deterministic [`Recognizer`] that counts the stream renewals `put_back`
    /// must perform. The counter is shared so it outlives the boxed engine.
    struct FakeRecognizer {
        new_streams: Arc<AtomicUsize>,
    }

    impl Recognizer for FakeRecognizer {
        fn accept_waveform(&mut self, _samples: &[f32]) {}
        fn is_ready(&self) -> bool {
            false
        }
        fn decode(&mut self) {}
        fn result_text(&self) -> Option<String> {
            None
        }
        fn is_endpoint(&self) -> bool {
            false
        }
        fn reset(&mut self) {}
        fn input_finished(&mut self) {}
        fn new_stream(&mut self) {
            self.new_streams.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Two-signal gate: the loader signals `entered` when it is inside the load
    /// and blocks until `release`, so a concurrent `warm` can be proven to JOIN
    /// rather than load.
    struct Gate {
        entered_tx: watch::Sender<bool>,
        entered_rx: watch::Receiver<bool>,
        release_tx: watch::Sender<bool>,
        release_rx: watch::Receiver<bool>,
    }

    impl Gate {
        fn new() -> Self {
            let (entered_tx, entered_rx) = watch::channel(false);
            let (release_tx, release_rx) = watch::channel(false);
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

    /// The injected loader: counts every load, signals entry, blocks until the
    /// gate releases, then hands back a fake engine.
    async fn gated_load(
        loads: Arc<AtomicUsize>,
        new_streams: Arc<AtomicUsize>,
        gate: Arc<Gate>,
    ) -> Result<Box<dyn Recognizer>, VoiceError> {
        loads.fetch_add(1, Ordering::SeqCst);
        gate.enter();
        gate.wait_release().await;
        Ok(Box::new(FakeRecognizer { new_streams }))
    }

    fn boxed_fake(new_streams: Arc<AtomicUsize>) -> Box<dyn Recognizer> {
        Box::new(FakeRecognizer { new_streams })
    }

    #[tokio::test]
    async fn warm_reports_residency_and_its_own_duration_only_after_the_load() {
        let engine = ResidentEngine::new();
        assert!(!engine.is_resident(), "a fresh engine is not resident");

        let loads = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&loads);
        let streams = Arc::new(AtomicUsize::new(0));
        let result = engine
            .warm_with({
                let streams = Arc::clone(&streams);
                move || {
                    counted.fetch_add(1, Ordering::SeqCst);
                    async move { Ok(boxed_fake(streams)) }
                }
            })
            .await;

        assert!(result.warmed);
        assert!(result.code.is_none());
        assert!(result.detail.is_none());
        assert!(
            result.warm_ms.is_some(),
            "the loading call reports its own duration (the B10 observable)"
        );
        assert!(engine.is_resident(), "the engine is genuinely in the slot");
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        assert!(lock_inner(&engine).in_flight.is_none());
    }

    #[tokio::test]
    async fn warm_is_idempotent_and_never_a_second_load_while_already_resident() {
        let engine = ResidentEngine::new();
        let first = engine
            .warm_with(|| async { Ok(boxed_fake(Arc::new(AtomicUsize::new(0)))) })
            .await;
        assert!(first.warmed);
        assert!(first.warm_ms.is_some());

        let second = engine
            .warm_with(|| async {
                panic!("an already-resident warm must never load again")
            })
            .await;
        assert!(second.warmed);
        assert!(
            second.warm_ms.is_none(),
            "a no-op warm reports no duration"
        );
        assert!(engine.is_resident());
    }

    #[tokio::test]
    async fn a_warm_arriving_during_an_in_flight_load_joins_it() {
        let engine = Arc::new(ResidentEngine::new());
        let loads = Arc::new(AtomicUsize::new(0));
        let streams = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Gate::new());

        let first = {
            let engine = Arc::clone(&engine);
            let (loads, streams, gate) =
                (Arc::clone(&loads), Arc::clone(&streams), Arc::clone(&gate));
            tokio::spawn(async move {
                engine
                    .warm_with(move || gated_load(loads, streams, gate))
                    .await
            })
        };
        gate.wait_entered().await;
        assert!(
            !engine.is_resident(),
            "an in-flight load is never residency"
        );

        // A concurrent warm must JOIN the load, never start a second one.
        let second = {
            let engine = Arc::clone(&engine);
            let (loads, streams, gate) =
                (Arc::clone(&loads), Arc::clone(&streams), Arc::clone(&gate));
            tokio::spawn(async move {
                engine
                    .warm_with(move || gated_load(loads, streams, gate))
                    .await
            })
        };
        tokio::task::yield_now().await;
        assert!(
            !second.is_finished(),
            "the joiner must still be waiting on the single in-flight load"
        );
        assert_eq!(
            loads.load(Ordering::SeqCst),
            1,
            "never a second concurrent model load"
        );

        gate.release();
        let first = first.await.expect("first warm task");
        let second = second.await.expect("second warm task");
        assert!(first.warmed);
        assert!(second.warmed);
        assert!(
            second.warm_ms.is_none(),
            "the joining call performed no load of its own"
        );
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        assert!(engine.is_resident());
    }

    #[tokio::test]
    async fn join_in_flight_is_a_noop_when_nothing_is_in_flight() {
        let engine = ResidentEngine::new();
        assert!(!engine.join_in_flight().await);
        assert!(!engine.is_resident());
    }

    #[tokio::test]
    async fn join_in_flight_awaits_the_in_flight_load_and_reports_true_residency() {
        let engine = Arc::new(ResidentEngine::new());
        let loads = Arc::new(AtomicUsize::new(0));
        let streams = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Gate::new());

        let warm = {
            let engine = Arc::clone(&engine);
            let (loads, streams, gate) =
                (Arc::clone(&loads), Arc::clone(&streams), Arc::clone(&gate));
            tokio::spawn(async move {
                engine
                    .warm_with(move || gated_load(loads, streams, gate))
                    .await
            })
        };
        gate.wait_entered().await;

        let joiner = {
            let engine = Arc::clone(&engine);
            tokio::spawn(async move { engine.join_in_flight().await })
        };
        tokio::task::yield_now().await;
        assert!(
            !joiner.is_finished(),
            "join_in_flight must await the in-flight load"
        );

        gate.release();
        assert!(joiner.await.expect("joiner task"));
        assert!(warm.await.expect("warm task").warmed);
        assert!(engine.is_resident());
    }

    #[tokio::test]
    async fn a_failed_warm_leaves_the_slot_empty_and_the_next_warm_cold_loads() {
        let engine = ResidentEngine::new();
        let attempts = Arc::new(AtomicUsize::new(0));

        let failed = engine
            .warm_with({
                let attempts = Arc::clone(&attempts);
                move || {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    async move { Err(VoiceError::model_missing("tokens.txt is missing")) }
                }
            })
            .await;

        assert!(!failed.warmed, "a failed warm never claims residency");
        assert_eq!(failed.code, Some(SttErrorCode::ModelMissing));
        assert!(failed.detail.is_some());
        assert!(failed.warm_ms.is_none());
        assert!(!engine.is_resident());
        assert!(
            lock_inner(&engine).in_flight.is_none(),
            "the failed warm must clear the in-flight state"
        );

        // The next warm is not blocked by stale single-flight state.
        let retry = engine
            .warm_with(|| async { Ok(boxed_fake(Arc::new(AtomicUsize::new(0)))) })
            .await;
        assert!(retry.warmed);
        assert!(engine.is_resident());
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn take_and_put_back_renew_the_stream_and_keep_the_engine_resident() {
        let engine = ResidentEngine::new();
        let streams = Arc::new(AtomicUsize::new(0));
        let loaded = Arc::clone(&streams);
        assert!(
            engine
                .warm_with(move || async move { Ok(boxed_fake(loaded)) })
                .await
                .warmed
        );

        let generation = engine.generation();
        let taken = engine.take().expect("the slot holds the engine");
        assert!(!engine.is_resident(), "take empties the slot");
        assert!(engine.take().is_none(), "at most ONE engine per process");

        assert!(
            engine.put_back(taken, generation),
            "a session at the current generation parks normally"
        );
        assert!(engine.is_resident(), "put_back parks the engine again");
        assert_eq!(
            streams.load(Ordering::SeqCst),
            1,
            "put_back renews the stream exactly once before parking"
        );
    }

    /// R-6 defect pin: a session that started BEFORE the voice-disabled release
    /// hands the engine back after the release. The generation-guarded `put_back`
    /// must REFUSE it — the engine is dropped (memory reclaimed), residency stays
    /// false, and it is never re-parked.
    #[tokio::test]
    async fn a_put_back_from_a_pre_release_session_is_dropped_and_never_re_parks() {
        let engine = ResidentEngine::new();
        let streams = Arc::new(AtomicUsize::new(0));
        let loaded = Arc::clone(&streams);
        assert!(
            engine
                .warm_with(move || async move { Ok(boxed_fake(loaded)) })
                .await
                .warmed
        );

        // The session starts: snapshot the generation and take the engine.
        let session = engine.generation();
        let taken = engine.take().expect("the slot holds the engine");
        assert!(!engine.is_resident(), "the live session owns the engine");

        // The voice-disabled edge lands mid-session: nothing is parked to drop,
        // but the release must still invalidate this session's claim.
        assert!(
            !engine.release(),
            "release finds the slot empty while the session holds the engine"
        );

        // The session ends: its engine is dropped, never re-parked.
        assert!(
            !engine.put_back(taken, session),
            "a pre-release session's return must be refused"
        );
        assert!(
            !engine.is_resident(),
            "residency stays false — the release's reclaim is not undone (R-6)"
        );
        assert!(engine.take().is_none(), "nothing was re-parked");
        assert_eq!(
            streams.load(Ordering::SeqCst),
            0,
            "a refused return never renews the stream (it never parks)"
        );
    }

    /// The normal path must keep working across the release boundary: a session
    /// that starts after a subsequent re-warm snapshots the NEW generation and
    /// parks normally.
    #[tokio::test]
    async fn a_put_back_from_a_session_started_after_the_re_warm_parks_normally() {
        let engine = ResidentEngine::new();

        // The voice-disabled edge bumps the generation...
        assert!(!engine.release(), "nothing was resident yet");

        // ...voice is re-enabled and a fresh warm establishes residency again.
        let streams = Arc::new(AtomicUsize::new(0));
        let loaded = Arc::clone(&streams);
        assert!(
            engine
                .warm_with(move || async move { Ok(boxed_fake(loaded)) })
                .await
                .warmed
        );

        // A session that starts now snapshots the post-release generation.
        let session = engine.generation();
        let taken = engine.take().expect("the re-warmed engine is parked");

        assert!(
            engine.put_back(taken, session),
            "a post-release session parks normally"
        );
        assert!(engine.is_resident(), "residency is re-established legitimately");
        assert_eq!(
            streams.load(Ordering::SeqCst),
            1,
            "the normal park path renews the stream exactly once"
        );
    }

    /// Case 3: `release()` stays idempotent (an empty slot yields `false` every
    /// time) and the generation match is EXACT — a stale pre-release stamp can
    /// never re-park, even while a newer, legitimate engine occupies the slot.
    #[tokio::test]
    async fn release_is_idempotent_and_a_stale_generation_can_never_re_park() {
        let engine = ResidentEngine::new();
        let streams = Arc::new(AtomicUsize::new(0));
        let loaded = Arc::clone(&streams);
        assert!(
            engine
                .warm_with(move || async move { Ok(boxed_fake(loaded)) })
                .await
                .warmed
        );

        let stale = engine.generation();
        let stale_return = engine.take().expect("the slot holds the engine");
        assert!(!engine.release(), "release #1: the session holds the engine");
        assert!(!engine.release(), "release #2 is a no-op — release is idempotent");
        assert!(!engine.is_resident());

        // A later, legitimate occupant arrives at the new generation.
        let fresh = boxed_fake(Arc::clone(&streams));
        assert!(
            engine.put_back(fresh, engine.generation()),
            "the current generation parks normally"
        );
        assert!(engine.is_resident());

        // The stale return is still refused, and the legitimate engine survives.
        assert!(
            !engine.put_back(stale_return, stale),
            "an old generation can never displace a newer resident engine"
        );
        assert!(engine.is_resident(), "the legitimate engine is untouched");
    }

    /// Case 4: a release never poisons the module — re-enabling voice warms
    /// again (a genuine load at the new generation), and that engine serves the
    /// next session through the normal take/put_back round trip.
    #[tokio::test]
    async fn a_release_never_poisons_the_module_and_a_later_warm_serves_the_next_session() {
        let engine = ResidentEngine::new();
        let loads = Arc::new(AtomicUsize::new(0));
        let streams = Arc::new(AtomicUsize::new(0));

        // Voice enabled: warm #1 loads.
        let counted = Arc::clone(&loads);
        let loaded = Arc::clone(&streams);
        assert!(
            engine
                .warm_with(move || {
                    counted.fetch_add(1, Ordering::SeqCst);
                    async move { Ok(boxed_fake(loaded)) }
                })
                .await
                .warmed
        );

        // A live session takes it; the user disables voice mid-session.
        let generation = engine.generation();
        let taken = engine.take().expect("the slot holds the engine");
        assert!(!engine.release());
        assert!(
            !engine.put_back(taken, generation),
            "the pre-release session cannot re-park the engine"
        );
        assert!(!engine.is_resident(), "the memory is reclaimed while disabled");

        // Voice re-enabled: a fresh warm LOADS again and parks at the new
        // generation — the module is not permanently poisoned.
        let counted = Arc::clone(&loads);
        let loaded = Arc::clone(&streams);
        let rewarm = engine
            .warm_with(move || {
                counted.fetch_add(1, Ordering::SeqCst);
                async move { Ok(boxed_fake(loaded)) }
            })
            .await;
        assert!(rewarm.warmed, "voice re-enabled warms again");
        assert!(
            rewarm.warm_ms.is_some(),
            "the re-warm really paid a load, it did not inherit the dropped one"
        );
        assert!(engine.is_resident(), "residency is re-established");
        assert_eq!(loads.load(Ordering::SeqCst), 2, "exactly one load per warm");

        // And that engine serves the next session through the normal path.
        let session = engine.generation();
        let taken = engine.take().expect("the re-warmed engine is parked");
        assert!(engine.put_back(taken, session));
        assert!(engine.is_resident());
    }

    #[tokio::test]
    async fn release_drops_the_engine_and_is_idempotent() {
        let engine = ResidentEngine::new();
        let streams = Arc::new(AtomicUsize::new(0));
        let loaded = Arc::clone(&streams);
        assert!(
            engine
                .warm_with(move || async move { Ok(boxed_fake(loaded)) })
                .await
                .warmed
        );

        assert!(engine.release(), "the resident engine is dropped");
        assert!(!engine.is_resident());
        assert!(!engine.release(), "a second release is a no-op");
    }

    #[tokio::test]
    async fn a_release_during_an_in_flight_load_never_re_parks_the_engine() {
        let engine = Arc::new(ResidentEngine::new());
        let loads = Arc::new(AtomicUsize::new(0));
        let streams = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Gate::new());

        let warm = {
            let engine = Arc::clone(&engine);
            let (loads, streams, gate) =
                (Arc::clone(&loads), Arc::clone(&streams), Arc::clone(&gate));
            tokio::spawn(async move {
                engine
                    .warm_with(move || gated_load(loads, streams, gate))
                    .await
            })
        };
        gate.wait_entered().await;

        // The voice-disabled edge lands while the load is in flight.
        assert!(!engine.release(), "nothing was resident yet");
        gate.release();

        let result = warm.await.expect("warm task");
        assert!(
            !result.warmed,
            "a warm released mid-flight must not report residency"
        );
        assert!(!engine.is_resident(), "the memory is reclaimed for good");
        assert!(lock_inner(&engine).in_flight.is_none());
    }

    /// R-6 (privacy): the warm path is ENGINE-ONLY — this module owns no audio
    /// path at all, so a warm can never open the microphone. Pinned structurally
    /// because a device-open is unobservable hermetically (the CI host has no
    /// input device): the module source must not reference the capture entry
    /// point nor the audio backend crate. The needles are split so these assert
    /// lines do not match themselves.
    #[test]
    fn warm_is_engine_only_and_has_no_audio_path() {
        const SOURCE: &str = include_str!("resident.rs");
        assert!(
            !SOURCE.contains(concat!("start", "_capture")),
            "resident.rs must never reference the capture entry point (R-6)"
        );
        assert!(
            !SOURCE.contains(concat!("c", "pal")),
            "resident.rs must never reference the audio backend crate (R-6)"
        );
    }
}
