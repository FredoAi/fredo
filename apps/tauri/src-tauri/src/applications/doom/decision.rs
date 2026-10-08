//! Deterministic scripted decision lever + `FREDO_DOOM_AGENT_*` env seam
//! (Spec #2969, ST-2).
//!
//! [`ScriptedDecisionSource`] implements the SAME
//! [`DoomDecisionSource`](crate::infrastructure::companion::doom_decision::DoomDecisionSource)
//! interface the model path uses, reading a JSON script from
//! [`DOOM_AGENT_SCRIPT_ENV`]. It can emit a valid decision, a malformed decision
//! (`{"malformed": true}`), or a source error (`{"error": "..."}`), which makes
//! AC1/3/4/5 verifiable WITHOUT a live model (G-172).
//!
//! A valid entry's `tics` is deliberately returned **unvalidated**, so an
//! out-of-range value exercises the loop's own validation path (ST-3).
//!
//! This module also owns the `FREDO_DOOM_AGENT_*` env seam for the slice: every
//! seam is inert when unset (the consumer falls back to the [`super::autoplay`]
//! constants), so the production path is unchanged (G-275).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::Value;

use crate::infrastructure::companion::doom_decision::{
    DoomDecision, DoomDecisionError, DoomDecisionSource,
};

// ── Env seams (inert when unset) ─────────────────────────────────────────────

/// Selects the active decision source: `"model"` (default) or `"scripted"`.
pub const DOOM_AGENT_DECISION_SOURCE_ENV: &str = "FREDO_DOOM_AGENT_DECISION_SOURCE";
/// Path to the scripted decision JSON ([`ScriptedDecisionSource`]).
pub const DOOM_AGENT_SCRIPT_ENV: &str = "FREDO_DOOM_AGENT_SCRIPT";
/// Directory for the model request audit JSONL (ST-4).
pub const DOOM_AGENT_LOG_DIR_ENV: &str = "FREDO_DOOM_AGENT_LOG_DIR";
/// Override the total step budget ([`super::autoplay::DOOM_AUTOPLAY_MAX_STEPS`]).
pub const DOOM_AGENT_MAX_STEPS_ENV: &str = "FREDO_DOOM_AGENT_MAX_STEPS";
/// Override the consecutive-failure budget
/// ([`super::autoplay::DOOM_AUTOPLAY_MAX_FAILURES`]).
pub const DOOM_AGENT_MAX_FAILURES_ENV: &str = "FREDO_DOOM_AGENT_MAX_FAILURES";
/// Override the per-step tic count ([`super::autoplay::DOOM_AUTOPLAY_STEP_TICS`]).
pub const DOOM_AGENT_STEP_TICS_ENV: &str = "FREDO_DOOM_AGENT_STEP_TICS";

/// The model decision-source selector value.
pub const DOOM_AGENT_SOURCE_MODEL: &str = "model";
/// The scripted decision-source selector value.
pub const DOOM_AGENT_SOURCE_SCRIPTED: &str = "scripted";

/// Parse the decision-source selector from a raw value. An unrecognized or blank
/// value resolves to `"model"` — the production default — so the seam is inert
/// unless it explicitly selects `"scripted"`.
pub fn decision_source_from_value(raw: Option<&str>) -> String {
    match raw.map(str::trim) {
        Some(value) if value.eq_ignore_ascii_case(DOOM_AGENT_SOURCE_SCRIPTED) => {
            DOOM_AGENT_SOURCE_SCRIPTED.to_string()
        }
        _ => DOOM_AGENT_SOURCE_MODEL.to_string(),
    }
}

/// The effective decision-source selector from [`DOOM_AGENT_DECISION_SOURCE_ENV`].
pub fn decision_source_from_env() -> String {
    decision_source_from_value(std::env::var(DOOM_AGENT_DECISION_SOURCE_ENV).ok().as_deref())
}

/// Parse a `u32` override from a raw value; blank/invalid → `None` (inert).
pub fn parse_u32(raw: Option<&str>) -> Option<u32> {
    raw?.trim().parse().ok()
}

/// Parse an `i64` override from a raw value; blank/invalid → `None` (inert).
pub fn parse_i64(raw: Option<&str>) -> Option<i64> {
    raw?.trim().parse().ok()
}

/// A non-empty trimmed path from a raw value; unset/blank → `None` (inert).
fn path_from_value(raw: Option<&str>) -> Option<PathBuf> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// The total step-budget override from [`DOOM_AGENT_MAX_STEPS_ENV`], if set.
pub fn max_steps_from_env() -> Option<u32> {
    parse_u32(std::env::var(DOOM_AGENT_MAX_STEPS_ENV).ok().as_deref())
}

/// The consecutive-failure-budget override from [`DOOM_AGENT_MAX_FAILURES_ENV`],
/// if set.
pub fn max_failures_from_env() -> Option<u32> {
    parse_u32(std::env::var(DOOM_AGENT_MAX_FAILURES_ENV).ok().as_deref())
}

/// The per-step tic override from [`DOOM_AGENT_STEP_TICS_ENV`], if set.
pub fn step_tics_from_env() -> Option<i64> {
    parse_i64(std::env::var(DOOM_AGENT_STEP_TICS_ENV).ok().as_deref())
}

/// The scripted-decision JSON path from [`DOOM_AGENT_SCRIPT_ENV`], if set.
pub fn script_path_from_env() -> Option<PathBuf> {
    path_from_value(std::env::var(DOOM_AGENT_SCRIPT_ENV).ok().as_deref())
}

/// The model request-audit directory from [`DOOM_AGENT_LOG_DIR_ENV`], if set.
pub fn log_dir_from_env() -> Option<PathBuf> {
    path_from_value(std::env::var(DOOM_AGENT_LOG_DIR_ENV).ok().as_deref())
}

// ── Scripted decision source ─────────────────────────────────────────────────

/// A deterministic [`DoomDecisionSource`] backed by a JSON script.
///
/// Script shape (the documented QA lever):
///
/// ```json
/// {
///   "decisions": [
///     { "tics": 1, "actions": [{ "type": "turn-to", "angle": 90 }] },
///     { "malformed": true },
///     { "error": "model unavailable" }
///   ],
///   "repeat": true
/// }
/// ```
///
/// Each call consumes the next entry: a valid `{tics, actions}` object yields a
/// decision (its `tics` is NOT range-checked here — the loop validates it), a
/// `{"malformed": true}` entry yields [`DoomDecisionError::Malformed`], and an
/// `{"error": "..."}` entry yields [`DoomDecisionError::ModelUnavailable`]. With
/// `repeat: true` the script wraps after the last entry; otherwise it fails
/// closed with [`DoomDecisionError::Malformed`] once exhausted.
pub struct ScriptedDecisionSource {
    entries: Vec<Value>,
    repeat: bool,
    cursor: Mutex<usize>,
}

impl ScriptedDecisionSource {
    /// Build from already-parsed entries (no I/O) — used by tests and by
    /// [`Self::from_script_json`].
    pub fn new(entries: Vec<Value>, repeat: bool) -> Self {
        Self {
            entries,
            repeat,
            cursor: Mutex::new(0),
        }
    }

    /// Load the script from a JSON file on disk.
    pub fn from_script_path(path: &Path) -> Result<Self, DoomDecisionError> {
        let text = std::fs::read_to_string(path).map_err(|error| {
            DoomDecisionError::Malformed(format!(
                "cannot read script {}: {error}",
                path.display()
            ))
        })?;
        Self::from_script_json(&text)
    }

    /// Parse the script from JSON text (the documented `{decisions, repeat}`
    /// object).
    pub fn from_script_json(text: &str) -> Result<Self, DoomDecisionError> {
        let value: Value = serde_json::from_str(text)
            .map_err(|error| DoomDecisionError::Malformed(format!("script is not valid JSON: {error}")))?;
        let object = value.as_object().ok_or_else(|| {
            DoomDecisionError::Malformed(
                "script must be a JSON object with a `decisions` array".to_string(),
            )
        })?;
        let entries = object
            .get("decisions")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| {
                DoomDecisionError::Malformed("script is missing a `decisions` array".to_string())
            })?;
        if entries.is_empty() {
            return Err(DoomDecisionError::Malformed(
                "script `decisions` array is empty".to_string(),
            ));
        }
        let repeat = object
            .get("repeat")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(Self::new(entries, repeat))
    }

    /// Load the script path from [`DOOM_AGENT_SCRIPT_ENV`].
    pub fn from_env() -> Result<Self, DoomDecisionError> {
        let path = script_path_from_env().ok_or_else(|| {
            DoomDecisionError::Malformed(format!("{DOOM_AGENT_SCRIPT_ENV} is not set"))
        })?;
        Self::from_script_path(&path)
    }

    /// Consume the next script entry, wrapping when `repeat` is set.
    fn next_entry(&self) -> Result<Value, DoomDecisionError> {
        let mut cursor = self
            .cursor
            .lock()
            .expect("script cursor lock is not poisoned");
        if *cursor >= self.entries.len() {
            if self.repeat {
                *cursor = 0;
            } else {
                return Err(DoomDecisionError::Malformed(
                    "scripted decision script exhausted".to_string(),
                ));
            }
        }
        let entry = self.entries[*cursor].clone();
        *cursor += 1;
        Ok(entry)
    }
}

/// Interpret one script entry.
///
/// `{"error": "..."}` → [`DoomDecisionError::ModelUnavailable`];
/// `{"malformed": true}` → [`DoomDecisionError::Malformed`]; otherwise a
/// `{tics, actions}` decision. The `tics` range is NOT checked here — the loop
/// validates it, so an out-of-range value exercises that path.
fn parse_script_entry(entry: &Value) -> Result<DoomDecision, DoomDecisionError> {
    let object = entry.as_object().ok_or_else(|| {
        DoomDecisionError::Malformed("script entry is not a JSON object".to_string())
    })?;

    if let Some(error) = object.get("error") {
        let message = error
            .as_str()
            .map(str::trim)
            .filter(|message| !message.is_empty())
            .unwrap_or("scripted source error");
        return Err(DoomDecisionError::ModelUnavailable(message.to_string()));
    }

    if object.get("malformed").and_then(Value::as_bool) == Some(true) {
        return Err(DoomDecisionError::Malformed(
            "scripted malformed decision".to_string(),
        ));
    }

    let tics = object.get("tics").and_then(Value::as_i64).ok_or_else(|| {
        DoomDecisionError::Malformed("decision entry is missing an integer `tics`".to_string())
    })?;
    let actions = object
        .get("actions")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| {
            DoomDecisionError::Malformed("decision entry is missing an `actions` array".to_string())
        })?;

    Ok(DoomDecision { tics, actions })
}

#[async_trait]
impl DoomDecisionSource for ScriptedDecisionSource {
    async fn decide(&self, _observation: &Value) -> Result<DoomDecision, DoomDecisionError> {
        parse_script_entry(&self.next_entry()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    fn source(entries: Vec<Value>, repeat: bool) -> ScriptedDecisionSource {
        ScriptedDecisionSource::new(entries, repeat)
    }

    #[tokio::test]
    async fn a_valid_entry_yields_a_decision() {
        let scripted = source(
            vec![json!({ "tics": 1, "actions": [{ "type": "turn-to", "angle": 90 }] })],
            false,
        );
        let decision = scripted.decide(&json!({})).await.expect("valid entry");
        assert_eq!(decision.tics, 1);
        assert_eq!(decision.actions, vec![json!({ "type": "turn-to", "angle": 90 })]);
    }

    #[tokio::test]
    async fn out_of_range_tics_pass_through_unvalidated() {
        // The loop (ST-3) owns range validation; the lever must NOT hide it.
        let scripted = source(vec![json!({ "tics": 9999, "actions": [] })], false);
        let decision = scripted.decide(&json!({})).await.expect("valid entry");
        assert_eq!(decision.tics, 9999);
        assert!(decision.actions.is_empty());
    }

    #[tokio::test]
    async fn a_malformed_entry_yields_malformed() {
        let scripted = source(vec![json!({ "malformed": true })], false);
        assert!(matches!(
            scripted.decide(&json!({})).await,
            Err(DoomDecisionError::Malformed(_))
        ));
    }

    #[tokio::test]
    async fn an_error_entry_yields_model_unavailable() {
        let scripted = source(vec![json!({ "error": "model unavailable" })], false);
        assert_eq!(
            scripted.decide(&json!({})).await,
            Err(DoomDecisionError::ModelUnavailable(
                "model unavailable".to_string()
            ))
        );
    }

    #[tokio::test]
    async fn a_missing_actions_array_yields_malformed() {
        let scripted = source(vec![json!({ "tics": 1 })], false);
        assert!(matches!(
            scripted.decide(&json!({})).await,
            Err(DoomDecisionError::Malformed(_))
        ));
    }

    #[tokio::test]
    async fn repeat_wraps_the_script() {
        let scripted = source(
            vec![
                json!({ "tics": 1, "actions": [] }),
                json!({ "tics": 2, "actions": [] }),
            ],
            true,
        );
        assert_eq!(scripted.decide(&json!({})).await.expect("first").tics, 1);
        assert_eq!(scripted.decide(&json!({})).await.expect("second").tics, 2);
        assert_eq!(scripted.decide(&json!({})).await.expect("wrapped").tics, 1);
    }

    #[tokio::test]
    async fn without_repeat_the_script_fails_closed_once_exhausted() {
        let scripted = source(vec![json!({ "tics": 1, "actions": [] })], false);
        assert!(scripted.decide(&json!({})).await.is_ok());
        assert!(matches!(
            scripted.decide(&json!({})).await,
            Err(DoomDecisionError::Malformed(_))
        ));
    }

    #[tokio::test]
    async fn the_source_is_object_safe() {
        let source: Arc<dyn DoomDecisionSource> =
            Arc::new(source(vec![json!({ "tics": 1, "actions": [] })], true));
        assert_eq!(source.decide(&json!({})).await.expect("decision").tics, 1);
    }

    #[test]
    fn from_script_json_parses_the_documented_shape() {
        let text = r#"{
            "decisions": [
                { "tics": 1, "actions": [{ "type": "shoot" }] },
                { "malformed": true },
                { "error": "down" }
            ],
            "repeat": true
        }"#;
        let scripted = ScriptedDecisionSource::from_script_json(text).expect("valid script");
        assert!(scripted.repeat);
        assert_eq!(scripted.entries.len(), 3);
    }

    #[test]
    fn from_script_json_defaults_repeat_to_false_and_rejects_bad_shapes() {
        let scripted = ScriptedDecisionSource::from_script_json(
            r#"{ "decisions": [{ "tics": 1, "actions": [] }] }"#,
        )
        .expect("valid script");
        assert!(!scripted.repeat);

        assert!(ScriptedDecisionSource::from_script_json("not json").is_err());
        assert!(ScriptedDecisionSource::from_script_json(r#"{ "repeat": true }"#).is_err());
        assert!(ScriptedDecisionSource::from_script_json(r#"{ "decisions": [] }"#).is_err());
        assert!(ScriptedDecisionSource::from_script_json(r#"[{ "tics": 1, "actions": [] }]"#).is_err());
    }

    #[test]
    fn from_script_path_reads_a_file_and_reports_a_missing_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("agent-script.json");
        std::fs::write(&path, r#"{ "decisions": [{ "tics": 3, "actions": [] }], "repeat": true }"#)
            .expect("write script");
        let scripted = ScriptedDecisionSource::from_script_path(&path).expect("load script");
        assert!(scripted.repeat);
        assert_eq!(scripted.entries.len(), 1);

        let missing = dir.path().join("absent.json");
        assert!(matches!(
            ScriptedDecisionSource::from_script_path(&missing),
            Err(DoomDecisionError::Malformed(_))
        ));
    }

    #[test]
    fn the_env_seam_is_inert_when_unset() {
        assert_eq!(decision_source_from_value(None), DOOM_AGENT_SOURCE_MODEL);
        assert_eq!(decision_source_from_value(Some("  ")), DOOM_AGENT_SOURCE_MODEL);
        assert_eq!(
            decision_source_from_value(Some("nonsense")),
            DOOM_AGENT_SOURCE_MODEL
        );
        assert_eq!(
            decision_source_from_value(Some("scripted")),
            DOOM_AGENT_SOURCE_SCRIPTED
        );
        assert_eq!(
            decision_source_from_value(Some(" SCRIPTED ")),
            DOOM_AGENT_SOURCE_SCRIPTED
        );

        assert_eq!(parse_u32(None), None);
        assert_eq!(parse_u32(Some("")), None);
        assert_eq!(parse_u32(Some("nope")), None);
        assert_eq!(parse_u32(Some(" 42 ")), Some(42));
        assert_eq!(parse_i64(Some("-1")), Some(-1));
        assert_eq!(parse_i64(Some("1.5")), None);

        assert_eq!(path_from_value(None), None);
        assert_eq!(path_from_value(Some("   ")), None);
        assert_eq!(path_from_value(Some(" a/b ")), Some(PathBuf::from("a/b")));
    }

    #[test]
    fn the_env_seam_constants_are_pinned() {
        assert_eq!(
            DOOM_AGENT_DECISION_SOURCE_ENV,
            "FREDO_DOOM_AGENT_DECISION_SOURCE"
        );
        assert_eq!(DOOM_AGENT_SCRIPT_ENV, "FREDO_DOOM_AGENT_SCRIPT");
        assert_eq!(DOOM_AGENT_LOG_DIR_ENV, "FREDO_DOOM_AGENT_LOG_DIR");
        assert_eq!(DOOM_AGENT_MAX_STEPS_ENV, "FREDO_DOOM_AGENT_MAX_STEPS");
        assert_eq!(DOOM_AGENT_MAX_FAILURES_ENV, "FREDO_DOOM_AGENT_MAX_FAILURES");
        assert_eq!(DOOM_AGENT_STEP_TICS_ENV, "FREDO_DOOM_AGENT_STEP_TICS");
    }
}
