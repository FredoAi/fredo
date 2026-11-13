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

/// The terminal status the engine thread publishes after each start/stop.
#[derive(Debug, Clone, Default)]
pub struct EngineStatusSnapshot {
    /// The engine is loaded and able to serve.
    pub loaded: bool,
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
}

/// The shared engine slot: the published snapshot + the requested mode.
#[derive(Debug, Clone, Default)]
pub struct EngineSlot {
    /// The published status.
    pub snapshot: EngineStatusSnapshot,
    /// The most recently REQUESTED mode (never overwritten by a failure — AC-25.2).
    pub mode: CompanionBackendMode,
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
        // never overwrites the persisted/requested mode.
        if let Ok(mut slot) = self.slot.lock() {
            slot.mode = mode;
        }
        let Some(commands) = self.commands.as_ref() else {
            return CompanionEngineStartResult::failure(CompanionEngineErrorCode::BackendInitFailed);
        };
        if let Err(error) = commands.try_send(EngineCommand::Start(request)) {
            return match error {
                TrySendError::Full(_) => {
                    CompanionEngineStartResult::failure(CompanionEngineErrorCode::Busy)
                }
                TrySendError::Disconnected(_) => {
                    CompanionEngineStartResult::failure(CompanionEngineErrorCode::BackendInitFailed)
                }
            };
        }
        match reply_rx.recv_timeout(self.budget) {
            Ok(outcome) => outcome,
            Err(_) => CompanionEngineStartResult::failure(CompanionEngineErrorCode::StartTimeout),
        }
    }

    /// Request a stop (best-effort; lifecycle commands are rare).
    pub fn stop(&self) {
        if let Some(commands) = self.commands.as_ref() {
            let _ = commands.try_send(EngineCommand::Stop);
        }
        if let Ok(mut slot) = self.slot.lock() {
            slot.snapshot.loaded = false;
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
}
