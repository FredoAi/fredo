//! The engine handle: the bounded command channel, the bounded start, the
//! process-scoped engine slot, and the status snapshot (Spec #3141, ST-1).
//!
//! Every caller (a Tauri command adapter, a future chat path) talks to the ONE
//! engine thread through [`CompanionEngineHandle`]. The handle owns:
//!
//! * the command sender (bounded — a `try_send` refusal is a typed `Busy`, never
//!   an unbounded queue),
//! * the shared `Arc<Mutex<EngineSlot>>` the thread publishes its status into,
//! * the join handle for the owned OS thread.
//!
//! ## Bounded start (NFR-3)
//!
//! [`CompanionEngineHandle::start`] sends a `Start` command and waits for the
//! thread's terminal outcome under a wall-clock budget. Exceeding the budget
//! yields [`CompanionEngineErrorCode::StartTimeout`] — the wizard can never hang
//! on a slow model load.
//!
//! ## The engine slot
//!
//! The thread publishes an [`EngineStatusSnapshot`] after every start/stop. The
//! handle reads it to build the status surface. The slot is a plain `Mutex` over
//! owned data — no engine (`!Send`) value ever enters it.

use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::paths;
use super::thread as engine_thread;
use super::{
    CompanionBackendKind, CompanionBackendMode, CompanionDeviceInfo, CompanionEngineErrorCode,
    CompanionEngineStartResult, EngineCommand, StartRequest,
};

/// The default wall-clock budget for one bounded start (NFR-3). The pinned
/// model is 2.6 GB and may load from a cold disk under CUDA; two minutes covers
/// the documented window without an unbounded wait.
pub const DEFAULT_START_BUDGET: Duration = Duration::from_secs(120);

/// The bounded command-channel capacity. The engine is single-flight, so a
/// small bound is enough (one in-flight start plus lifecycle).
pub const ENGINE_COMMAND_CAPACITY: usize = 8;

/// The terminal status the engine thread publishes after each start/stop and
/// after each turn (which is where the cumulative MTP counters move).
#[derive(Debug, Clone, Default)]
pub struct EngineStatusSnapshot {
    /// The engine is loaded and able to serve.
    pub loaded: bool,
    /// A start is IN FLIGHT (Spec #3180 ST-2).
    ///
    /// Published `true` BEFORE a `Start` command reaches the engine thread and
    /// cleared by the terminal snapshot, so a status read during a (up to
    /// [`DEFAULT_START_BUDGET`]) model load reports "starting" rather than
    /// "not running". Never the same thing as `!loaded`: idle is neither.
    pub starting: bool,
    /// The typed failure of the most recent start, if it failed.
    pub last_error_code: Option<CompanionEngineErrorCode>,
    /// Curated detail for the most recent failure.
    pub last_error: Option<String>,
    /// The backend ggml reports for the loaded set.
    pub backend: Option<CompanionBackendKind>,
    /// The device set ggml reports (post force-CPU coercion).
    pub devices: Vec<CompanionDeviceInfo>,
    /// The canonical model id (manifest `model` file stem).
    pub model_id: Option<String>,
    /// The cumulative MTP counters across every turn this PROCESS has served
    /// (ST-4 / R-19.1). `None` before the first load.
    ///
    /// "Cumulative" is for the life of the PROCESS: the engine thread carries the
    /// total forward across a restart, so a status read after a restart still
    /// reports what every turn proposed (Spec #3141 fix F2). It is never reset to
    /// `{0,0,0}` by a restart.
    pub mtp_stats: Option<super::mtp::MtpStats>,
    /// What the loaded projector reports about the model pair's input modalities
    /// (ST-5 / #2897 REQ-7). `None` before a projector is loaded — the capability
    /// answer is then the truthful "not running", never a guess.
    pub mtmd_capability: Option<super::multimodal::MtmdCapability>,
}

/// The shared engine slot: the published snapshot + the requested mode.
#[derive(Debug, Clone, Default)]
pub struct EngineSlot {
    /// The published status.
    pub snapshot: EngineStatusSnapshot,
    /// The most recently REQUESTED mode (never overwritten by a failure — AC-25.2).
    pub mode: CompanionBackendMode,
}

impl EngineSlot {
    /// Record the mode an engine start is about to use.
    ///
    /// This is the ONE place the requested mode is written, so an EXPLICIT start
    /// (the wizard's `launch_llama_server`) and a TURN-started (lazy) engine
    /// report the same truthful `backendMode` (AC-25.2's echo). It is never
    /// written on a failure, so a refused `gpu` start cannot overwrite the
    /// persisted/requested mode.
    ///
    /// A poisoned lock is recovered rather than propagated: the mode is a display
    /// echo, never a value the engine's correctness depends on.
    pub fn record_requested_mode(slot: &Arc<Mutex<Self>>, mode: CompanionBackendMode) {
        let mut guard = match slot.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.mode = mode;
    }
}

/// The process-scoped engine handle. Owns the engine thread + the shared slot.
///
/// Construct with [`CompanionEngineHandle::spawn`], start with
/// [`CompanionEngineHandle::start`]. The handle is `Send + Sync` (it holds a
/// channel sender and an `Arc<Mutex<_>>`), so it lives in Tauri state.
pub struct CompanionEngineHandle {
    commands: Option<SyncSender<EngineCommand>>,
    slot: Arc<Mutex<EngineSlot>>,
    /// The owned OS thread, joined on drop after the sender is dropped.
    thread: Mutex<Option<JoinHandle<()>>>,
    /// The wall-clock budget for one bounded start.
    budget: Duration,
}

impl CompanionEngineHandle {
    /// Spawn the engine thread and return a handle. The thread starts idle.
    pub fn spawn() -> Self {
        Self::spawn_with_budget(DEFAULT_START_BUDGET)
    }

    /// Spawn the engine thread with an explicit start budget.
    pub fn spawn_with_budget(budget: Duration) -> Self {
        let (commands, receiver) = mpsc::sync_channel(ENGINE_COMMAND_CAPACITY);
        let slot = Arc::new(Mutex::new(EngineSlot::default()));
        let thread_slot = Arc::clone(&slot);
        let thread_handle = thread::Builder::new()
            .name("companion-engine".to_string())
            .spawn(move || engine_thread::run(receiver, thread_slot))
            .ok();
        Self {
            commands: Some(commands),
            slot,
            thread: Mutex::new(thread_handle),
            budget,
        }
    }

    /// The shared engine slot (for status reads).
    pub fn slot(&self) -> Arc<Mutex<EngineSlot>> {
        Arc::clone(&self.slot)
    }

    /// Whether a start is already in flight or an engine is already loaded.
    ///
    /// The launch auto-start (Spec #3180 ST-2) consults this before it requests
    /// a start so a SECOND concurrent `Start` can never be queued behind the one
    /// in flight — the engine thread is single-flight and the slot is the ONE
    /// truthful source for both states.
    pub fn is_starting_or_loaded(&self) -> bool {
        let guard = match self.slot.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.snapshot.starting || guard.snapshot.loaded
    }

    /// Set the in-flight `starting` flag on the shared snapshot.
    ///
    /// Only the ONE boolean is written, so everything else the slot carries (a
    /// previous load's device set, the last typed failure) survives the
    /// transition. A poisoned lock is recovered rather than propagated: the flag
    /// is a display echo, never a value correctness depends on.
    fn record_starting(&self, starting: bool) {
        let mut guard = match self.slot.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.snapshot.starting = starting;
    }

    /// Request a bounded start and wait for the terminal outcome.
    ///
    /// Sends the `Start` command, then waits on the reply channel up to the
    /// start budget. A full command channel is a typed `Busy`; a reply that
    /// exceeds the budget is `StartTimeout`.
    pub fn start(
        &self,
        model_paths: paths::EnginePaths,
        mode: CompanionBackendMode,
    ) -> CompanionEngineStartResult {
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        let request = Box::new(StartRequest {
            paths: model_paths,
            mode,
            force_cpu: super::device::force_cpu(),
            reply: reply_tx,
        });
        // Record the requested mode up front so AC-25.2 holds: a failed start
        // never overwrites the persisted/requested mode. The write is shared with
        // the lazy (turn-started) path so both report a truthful `backendMode`.
        EngineSlot::record_requested_mode(&self.slot, mode);
        let Some(commands) = self.commands.as_ref() else {
            return CompanionEngineStartResult::failure(CompanionEngineErrorCode::BackendInitFailed);
        };
        // Publish the in-flight flag BEFORE the command is sent: the model load
        // can run for up to `DEFAULT_START_BUDGET`, and a status read in that
        // window must report `starting`, never "not running" (Spec #3180 ST-2).
        self.record_starting(true);
        if let Err(error) = commands.try_send(EngineCommand::Start(request)) {
            // Nothing reached the engine thread, so no start is in flight.
            self.record_starting(false);
            return match error {
                TrySendError::Full(_) => {
                    CompanionEngineStartResult::failure(CompanionEngineErrorCode::Busy)
                }
                TrySendError::Disconnected(_) => {
                    CompanionEngineStartResult::failure(CompanionEngineErrorCode::BackendInitFailed)
                }
            };
        }
        let outcome = match reply_rx.recv_timeout(self.budget) {
            Ok(outcome) => outcome,
            Err(_) => CompanionEngineStartResult::failure(CompanionEngineErrorCode::StartTimeout),
        };
        // The terminal outcome is known here: the engine thread's own publish is
        // racy with this return, so the in-flight flag is cleared on THIS side
        // too. Both writers set the same value, so the order does not matter.
        self.record_starting(false);
        outcome
    }

    /// Request a stop (best-effort; lifecycle commands are rare).
    ///
    /// `Stop` releases the loaded engine state; the engine thread stays alive and
    /// parks, so a later [`Self::start`] re-initialises on the SAME thread
    /// (Spec #3141 fix D1).
    pub fn stop(&self) {
        if let Some(commands) = self.commands.as_ref() {
            let _ = commands.try_send(EngineCommand::Stop);
        }
        if let Ok(mut slot) = self.slot.lock() {
            slot.snapshot.loaded = false;
            slot.snapshot.starting = false;
        }
    }

    /// Send one generation command to the engine thread.
    ///
    /// A full command channel means a turn is already in flight: the command is
    /// refused as the typed [`CompanionEngineErrorCode::Busy`] rather than queued
    /// behind an unbounded wait. A disconnected channel means the engine thread
    /// is gone, which is a typed backend failure — never a hang.
    fn send(&self, command: EngineCommand) -> Result<(), (CompanionEngineErrorCode, String)> {
        let Some(commands) = self.commands.as_ref() else {
            return Err((
                CompanionEngineErrorCode::BackendInitFailed,
                "the companion engine is not running. Restart Fredo and try again.".to_string(),
            ));
        };
        match commands.try_send(command) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err((
                CompanionEngineErrorCode::Busy,
                CompanionEngineErrorCode::Busy.detail().to_string(),
            )),
            Err(TrySendError::Disconnected(_)) => Err((
                CompanionEngineErrorCode::BackendInitFailed,
                "the companion engine stopped. Restart Fredo and try again.".to_string(),
            )),
        }
    }

    /// Request one streaming turn on the engine thread.
    ///
    /// The engine starts itself when it is not loaded (the request carries the
    /// model paths + mode), so a chat turn after a cold boot needs no separate
    /// start round-trip.
    pub fn chat(
        &self,
        request: super::ChatRequest,
    ) -> Result<(), (CompanionEngineErrorCode, String)> {
        self.send(EngineCommand::Chat(Box::new(request)))
    }

    /// Request one bounded single reply on the engine thread (the Doom decision
    /// path).
    pub fn one_shot(
        &self,
        request: super::OneShotRequest,
    ) -> Result<(), (CompanionEngineErrorCode, String)> {
        self.send(EngineCommand::OneShot(Box::new(request)))
    }
}

impl Drop for CompanionEngineHandle {
    fn drop(&mut self) {
        // Drop the sender FIRST so the thread's `recv()` yields `Err` and its
        // loop ends; then join. A blocking model load finishes before the join,
        // which is the accepted-loss posture (NFR-8: no process-level fault
        // containment).
        self.commands = None;
        if let Ok(mut guard) = self.thread.lock() {
            if let Some(handle) = guard.take() {
                let _ = handle.join();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_handle_reports_not_loaded_and_no_backend() {
        let handle = CompanionEngineHandle::spawn();
        let slot = handle.slot();
        let guard = slot.lock().expect("slot lock");
        assert!(!guard.snapshot.loaded);
        assert!(guard.snapshot.backend.is_none());
        assert!(guard.snapshot.devices.is_empty());
        assert_eq!(guard.mode, CompanionBackendMode::Auto);
        drop(guard);
        handle.stop();
    }

    /// A start request for a path that does not exist is a typed failure, never
    /// a panic and never a hang — the bounded-start contract (NFR-3).
    #[test]
    fn a_start_for_a_missing_model_returns_a_typed_failure_within_the_budget() {
        let handle = CompanionEngineHandle::spawn_with_budget(Duration::from_secs(10));
        let paths = paths::EnginePaths {
            model: std::path::PathBuf::from("C:/definitely/not/a/model.gguf"),
            mmproj: std::path::PathBuf::from("C:/definitely/not/a/mmproj.gguf"),
            mtp: std::path::PathBuf::from("C:/definitely/not/a/mtp.gguf"),
            log: None,
        };
        let started = std::time::Instant::now();
        let result = handle.start(paths, CompanionBackendMode::Auto);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "start must be bounded"
        );
        assert!(!result.success);
        assert!(result.code.is_some(), "a failure must carry a typed code");
        handle.stop();
    }

    /// AC-25.2: a failed start must not overwrite the requested/persisted mode.
    #[test]
    fn a_failed_start_preserves_the_requested_mode() {
        let handle = CompanionEngineHandle::spawn_with_budget(Duration::from_secs(10));
        let paths = paths::EnginePaths {
            model: std::path::PathBuf::from("C:/definitely/not/a/model.gguf"),
            mmproj: std::path::PathBuf::new(),
            mtp: std::path::PathBuf::new(),
            log: None,
        };
        let _ = handle.start(paths, CompanionBackendMode::Gpu);
        let slot = handle.slot();
        let guard = slot.lock().expect("slot lock");
        assert_eq!(
            guard.mode,
            CompanionBackendMode::Gpu,
            "a failed start must not overwrite the requested mode"
        );
        drop(guard);
        handle.stop();
    }

    // ── Spec #3180 ST-2: the in-flight `starting` state ──────────────────────

    /// `starting` brackets a start: it is published BEFORE the command reaches
    /// the engine thread, and the terminal snapshot clears it.
    ///
    /// The worker below stands in for the engine thread so the in-flight window
    /// is deterministic (a real load would be racy to observe): the command is
    /// only read AFTER `start()` recorded the flag, so the handshake proves the
    /// publication ordering, not a timing coincidence.
    #[test]
    fn a_start_publishes_starting_before_the_command_and_clears_it_after() {
        let (commands, receiver) = mpsc::sync_channel(ENGINE_COMMAND_CAPACITY);
        let slot = Arc::new(Mutex::new(EngineSlot::default()));
        let handle = Arc::new(CompanionEngineHandle {
            commands: Some(commands),
            slot: Arc::clone(&slot),
            thread: Mutex::new(None),
            budget: Duration::from_secs(5),
        });

        let (seen_tx, seen_rx) = mpsc::sync_channel::<()>(1);
        let (finish_tx, finish_rx) = mpsc::sync_channel::<()>(1);
        let worker_slot = Arc::clone(&slot);
        let worker = thread::spawn(move || {
            let EngineCommand::Start(request) = receiver.recv().expect("a start command") else {
                panic!("expected a Start command");
            };
            let _ = seen_tx.send(());
            let _ = finish_rx.recv();
            let _ = request.reply.send(CompanionEngineStartResult::failure(
                CompanionEngineErrorCode::ModelMissing,
            ));
            // The terminal snapshot the engine thread publishes.
            let mut guard = worker_slot.lock().expect("worker slot");
            guard.snapshot = EngineStatusSnapshot::default();
        });

        let paths = paths::EnginePaths {
            model: std::path::PathBuf::from("C:/definitely/not/a/model.gguf"),
            mmproj: std::path::PathBuf::new(),
            mtp: std::path::PathBuf::new(),
            log: None,
        };
        let starter = Arc::clone(&handle);
        let start_thread = thread::spawn(move || starter.start(paths, CompanionBackendMode::Cpu));

        seen_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the engine thread saw the start");
        assert!(
            handle.is_starting_or_loaded(),
            "an in-flight start must be visible to the launch guard"
        );
        assert!(
            slot.lock().expect("slot").snapshot.starting,
            "`starting` must be true while the start is in flight"
        );

        let _ = finish_tx.send(());
        let outcome = start_thread.join().expect("the start thread must not panic");
        assert!(!outcome.success);
        worker.join().expect("the worker must not panic");
        assert!(
            !slot.lock().expect("slot").snapshot.starting,
            "the terminal snapshot must clear `starting`"
        );
        assert!(!handle.is_starting_or_loaded());
    }

    /// The launch guard covers BOTH a load in flight and an already-loaded
    /// engine, so a second start can never be sent behind the first.
    #[test]
    fn the_start_guard_covers_a_load_in_flight_and_a_loaded_engine() {
        let handle = CompanionEngineHandle::spawn();
        assert!(!handle.is_starting_or_loaded(), "a fresh handle is idle");
        {
            let slot = handle.slot();
            let mut guard = slot.lock().expect("slot");
            guard.snapshot.starting = true;
        }
        assert!(handle.is_starting_or_loaded(), "in flight ⇒ guarded");
        {
            let slot = handle.slot();
            let mut guard = slot.lock().expect("slot");
            guard.snapshot.starting = false;
            guard.snapshot.loaded = true;
        }
        assert!(handle.is_starting_or_loaded(), "loaded ⇒ guarded");
        handle.stop();
        assert!(!handle.is_starting_or_loaded(), "stopped ⇒ not guarded");
    }
}
