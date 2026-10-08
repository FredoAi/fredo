//! Provider-agnostic Doom decision contract (Spec #2969, ST-2).
//!
//! The Doom autoplay loop lives in `applications/doom`; the model-backed decision
//! source lives in `applications/llm_server`. Cross-application imports are forbidden
//! (`AGENTS.md`), so the shared contract BOTH compile against lives here — the
//! same provider-agnostic companion home as [`super::skills`], mirroring it.
//!
//! This module is the SINGLE producer of the Doom decision contract (G-255):
//! the decision value, the typed failure vocabulary, the decision-source trait,
//! and the Tauri-managed holder. Nothing here performs I/O, spawns a process, or
//! speaks HTTP — the trait is the interface; a mechanism adapter implements it
//! (the model source in `applications/llm_server`, ST-4; the scripted lever in
//! `applications/doom/decision.rs`, ST-2).
//!
//! The contract is deliberately free of the engine's action nouns: `actions` is
//! an opaque JSON array ([`serde_json::Value`]) validated against the live
//! vocabulary (`applications/doom/actions`) by the consumer, never here.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::Value;

/// One decision from a [`DoomDecisionSource`]: how many engine tics to advance
/// and the action objects to issue (the engine vocabulary is opaque here).
///
/// `tics` is an `i64` and is deliberately **not** clamped at this layer — range
/// validation (1-350) belongs to the loop (ST-3), so the contract never hides an
/// out-of-range value and the loop's validation path stays exercisable.
#[derive(Clone, Debug, PartialEq)]
pub struct DoomDecision {
    /// Number of engine tics to advance (the loop validates the 1-350 bound).
    pub tics: i64,
    /// The action objects to issue (engine vocabulary, opaque at this layer).
    pub actions: Vec<Value>,
}

/// Why a [`DoomDecisionSource`] could not produce a usable decision.
///
/// Every variant is typed and bounded: the loop maps each onto its consecutive-
/// failure path, so an unusable decision can never hang the run (R-4 / G-263).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DoomDecisionError {
    /// The source answered, but its decision was not a usable `{tics, actions}`
    /// object (bad JSON, or a missing/wrong-typed field).
    Malformed(String),
    /// The backing model is unavailable (not loaded, refused, or errored).
    ModelUnavailable(String),
    /// The decision did not arrive within the per-decision timeout.
    TimedOut,
}

impl std::fmt::Display for DoomDecisionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Malformed(detail) => write!(f, "malformed decision: {detail}"),
            Self::ModelUnavailable(detail) => write!(f, "model unavailable: {detail}"),
            Self::TimedOut => write!(f, "decision timed out"),
        }
    }
}

impl std::error::Error for DoomDecisionError {}

/// The decision source the Doom autoplay loop drives.
///
/// Implemented by the model-backed source (`applications/llm_server`, ST-4) and the
/// scripted lever (`applications/doom/decision.rs`, ST-2) — the SAME interface, so
/// AC1/3/4/5 are verifiable without a live model (G-172). `Send + Sync` makes
/// `Arc<dyn DoomDecisionSource>` storable in Tauri-managed state.
#[async_trait]
pub trait DoomDecisionSource: Send + Sync {
    /// Decide the next advance from the whole engine observation.
    async fn decide(&self, observation: &Value) -> Result<DoomDecision, DoomDecisionError>;
}

/// Tauri-managed holder of the active decision source.
///
/// `lib.rs` constructs the source and installs it once at startup (ST-5); the
/// autoplay loop reads it (ST-3). The `Mutex` guards only a short synchronous
/// critical section (clone the `Arc`) — it is NEVER held across an `.await`.
#[derive(Default)]
pub struct DoomDecisionSourceState(pub Mutex<Option<Arc<dyn DoomDecisionSource>>>);

impl DoomDecisionSourceState {
    /// Install `source` as the active decision source, replacing any previous
    /// one.
    pub fn set(&self, source: Arc<dyn DoomDecisionSource>) {
        *self
            .0
            .lock()
            .expect("decision source lock is not poisoned") = Some(source);
    }

    /// The active decision source, if one was installed.
    pub fn get(&self) -> Option<Arc<dyn DoomDecisionSource>> {
        self.0
            .lock()
            .expect("decision source lock is not poisoned")
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A trivial source proving the trait is object-safe (`Arc<dyn ...>`).
    struct FixedSource;

    #[async_trait]
    impl DoomDecisionSource for FixedSource {
        async fn decide(&self, _observation: &Value) -> Result<DoomDecision, DoomDecisionError> {
            Ok(DoomDecision {
                tics: 1,
                actions: vec![json!({ "type": "forward" })],
            })
        }
    }

    #[test]
    fn default_state_holds_no_source() {
        let state = DoomDecisionSourceState::default();
        assert!(state.get().is_none());
    }

    #[tokio::test]
    async fn state_round_trips_the_installed_source() {
        let state = DoomDecisionSourceState::default();
        state.set(Arc::new(FixedSource));
        let source = state.get().expect("source is installed");
        let decision = source.decide(&json!({})).await.expect("decide succeeds");
        assert_eq!(decision.tics, 1);
        assert_eq!(decision.actions, vec![json!({ "type": "forward" })]);
    }

    #[test]
    fn decision_error_displays_every_variant() {
        assert_eq!(
            DoomDecisionError::Malformed("bad".to_string()).to_string(),
            "malformed decision: bad"
        );
        assert_eq!(
            DoomDecisionError::ModelUnavailable("down".to_string()).to_string(),
            "model unavailable: down"
        );
        assert_eq!(DoomDecisionError::TimedOut.to_string(), "decision timed out");
    }
}
