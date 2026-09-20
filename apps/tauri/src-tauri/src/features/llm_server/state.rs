//! Managed `llama-server` process state (Spec #2857, ST-3).
//!
//! The companion runtime owns AT MOST ONE managed server. The child process
//! handle lives here (behind the Tauri-managed [`LlamaServerState`]) so the
//! launch/stop/status commands share one source of truth. This module has no
//! I/O and no Tauri types beyond the `Send + Sync` wrapper.

use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;

/// A live child process managed by the companion runtime.
pub struct ManagedServer {
    /// The spawned child; stdout/stderr are redirected to `log_path`.
    pub child: Child,
    /// OS process id, kept separately for the persisted PID marker + `taskkill`.
    pub pid: u32,
    /// The port the server actually bound (configured, or the OS-assigned fallback).
    pub port: u16,
    /// Absolute path to the server's stdout/stderr log.
    pub log_path: PathBuf,
}

/// Tauri-managed wrapper around the single optional managed server.
///
/// The `Mutex` only ever guards a short critical section (spawn bookkeeping /
/// state read) — it is NEVER held across an `.await`.
pub struct LlamaServerState(pub Mutex<Option<ManagedServer>>);

impl Default for LlamaServerState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_state_holds_no_server() {
        let state = LlamaServerState::default();
        let guard = state.0.lock().expect("state lock is not poisoned");
        assert!(guard.is_none());
    }
}
