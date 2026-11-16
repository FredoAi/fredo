//! Companion performance-mode suppression contract (Spec #2970, ST-2).
//!
//! Doom Mode owns ONE provider-agnostic boolean that gates the companion's
//! voice/audio pipeline while the mode is active. It lives in the shared
//! `infrastructure/companion/` layer — mirroring [`super::doom_decision`] — so
//! the voice layer (`infrastructure::voice`) and the model-audio path
//! (`applications::llm_server`) can read it WITHOUT importing `applications::doom`
//! (cross-application imports are forbidden, `AGENTS.md`).
//!
//! This module is the SINGLE producer of the suppression contract (G-255): the
//! producer is [`DoomModeState`](crate::applications::doom::mode::DoomModeState)
//! through the `enter_doom_mode` / `exit_doom_mode` commands; ST-3 is the first
//! consumer (the `stt_start` gate and the `llm_chat_with_audio` gate).
//!
//! The value is **never persisted**: a fresh boot is always unsuppressed.

use std::sync::Mutex;

/// The companion performance-mode suppression gate (binding name, ST-2).
///
/// A single `bool` guarded by a short synchronous mutex. `set_suppressed(true)`
/// while Doom Mode is active, `set_suppressed(false)` on every exit/teardown
/// path; a poisoned lock is recovered rather than taking the app down.
#[derive(Default)]
pub struct PerformanceModeState(Mutex<bool>);

impl PerformanceModeState {
    /// Set the suppression gate. Idempotent.
    pub fn set_suppressed(&self, on: bool) {
        let mut guard = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = on;
    }

    /// Read the suppression gate. `false` unless Doom Mode is active.
    pub fn is_suppressed(&self) -> bool {
        let guard = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_unsuppressed() {
        let state = PerformanceModeState::default();
        assert!(!state.is_suppressed());
    }

    #[test]
    fn set_and_clear_round_trip() {
        let state = PerformanceModeState::default();
        state.set_suppressed(true);
        assert!(state.is_suppressed());
        // Idempotent re-set.
        state.set_suppressed(true);
        assert!(state.is_suppressed());
        state.set_suppressed(false);
        assert!(!state.is_suppressed());
    }
}
