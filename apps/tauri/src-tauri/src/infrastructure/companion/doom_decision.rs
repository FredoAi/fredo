//! Provider-agnostic Doom decision contract (Spec #2969, ST-2; plan contract
//! Spec #3039, ST-3).
//!
//! The Doom autoplay loop lives in `applications/doom`; the model-backed decision
//! source lives in `applications/llm_server`. Cross-application imports are forbidden
//! (`AGENTS.md`), so the shared contract BOTH compile against lives here — the
//! same provider-agnostic companion home as [`super::skills`], mirroring it.
//!
//! This module is the SINGLE producer of the Doom decision contract (G-255):
//! the plan value, the typed failure vocabulary, the decision-source trait, the
//! plan JSON parser, and the Tauri-managed holder. Nothing here performs I/O,
//! spawns a process, or speaks HTTP — the trait is the interface; a mechanism
//! adapter implements it (the model source in `applications/llm_server`; the
//! scripted lever in `applications/doom/decision.rs`).
//!
//! Spec #3039 ST-3 replaced the single `{tics, actions}` reply with the bounded
//! [`DoomPlan`]. [`DoomDecision`] is retained as the LEGACY single-hold value the
//! continuous loop collapses a plan to until the ST-4 executor lands, and
//! [`DoomPlanStep::Hold`] carries the same `{tics, actions}` shim.
//!
//! Spec #3032 ST-4 adds the ADDITIVE side-channel [`DoomDecisionTrace`] +
//! [`DoomDecisionSource::last_decision_trace`]: a source MAY record the model
//! metadata for its most recent decision (model id / server flags / prompt +
//! schema versions / the flag-gated, size-bounded raw reply + reasoning) so the
//! loop-side dataset assembler can carry it into a decision record. It never
//! changes [`DoomDecisionSource::decide`].

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Map, Value};

/// The `response_format.json_schema.name` of the Doom plan contract (ST-3).
pub const DOOM_PLAN_SCHEMA_NAME: &str = "doom_plan";

/// Maximum number of [`DoomPlanStep`]s in a [`DoomPlan`] (ST-3).
pub const DOOM_PLAN_MAX_STEPS: usize = 8;

/// Maximum `distance` (map units) of a [`DoomPlanStep::Move`] (ST-3).
pub const DOOM_PLAN_DISTANCE_MAX: i64 = 1024;

/// Maximum `tics` of a [`DoomPlanStep::Shoot`] / [`DoomPlanStep::Wait`] /
/// [`DoomPlanStep::Hold`] (ST-3; mirrors `applications/doom`'s
/// `DOOM_STEP_TICS_MAX`).
pub const DOOM_PLAN_TICS_MAX: i64 = 350;

/// One bounded route/move step of a [`DoomPlan`] (Spec #3039 ST-3).
///
/// Every field is range-checked by [`parse_doom_plan`]; the accepted range is
/// documented on each variant. `Hold` is the legacy `{tics, actions}` shim AND
/// the local/reflex fallback hold.
#[derive(Clone, Debug, PartialEq)]
pub enum DoomPlanStep {
    /// Face `bearing` (absolute degrees `0..=359`) and walk `distance` map units
    /// (`1..=DOOM_PLAN_DISTANCE_MAX`).
    Move { bearing: i64, distance: i64 },
    /// Face `bearing` (`0..=359`), press `use`, and wait for the door to report
    /// `state == "waiting"`.
    OpenDoor { bearing: i64 },
    /// Hold fire for `tics` (`1..=DOOM_PLAN_TICS_MAX`).
    Shoot { tics: i64 },
    /// Wait for `tics` (`1..=DOOM_PLAN_TICS_MAX`) with no action.
    Wait { tics: i64 },
    /// Hold the opaque `actions` array for `tics` (`1..=DOOM_PLAN_TICS_MAX`) —
    /// the legacy `{tics, actions}` reply AND the local/reflex fallback hold.
    Hold { tics: i64, actions: Vec<Value> },
}

/// One decision from a [`DoomDecisionSource`]: an ordered, bounded sequence of
/// [`DoomPlanStep`]s the loop executes tick-by-tick in real time (Spec #3039 R-2).
///
/// `steps` is never empty — [`parse_doom_plan`] rejects an empty plan as
/// [`DoomDecisionError::Malformed`].
#[derive(Clone, Debug, PartialEq)]
pub struct DoomPlan {
    /// The plan's steps (`1..=DOOM_PLAN_MAX_STEPS`).
    pub steps: Vec<DoomPlanStep>,
}

impl DoomPlan {
    /// The single legacy `{tics, actions}` advance the continuous loop executes
    /// for this plan.
    ///
    /// **ST-3 compatibility shim.** Until the ST-4 tick-by-tick executor lands,
    /// the loop executes a plan as ONE bounded hold: a plan that is exactly one
    /// [`DoomPlanStep::Hold`] (the legacy reply path) executes unchanged; any
    /// other plan collapses to a neutral one-tick hold (a no-op until ST-4).
    pub fn as_single_hold(&self) -> DoomDecision {
        match self.steps.as_slice() {
            [DoomPlanStep::Hold { tics, actions }] => DoomDecision {
                tics: *tics,
                actions: actions.clone(),
            },
            _ => DoomDecision {
                tics: 1,
                actions: Vec::new(),
            },
        }
    }
}

impl From<DoomDecision> for DoomPlan {
    /// Wrap a legacy `{tics, actions}` decision as a single
    /// [`DoomPlanStep::Hold`] step.
    fn from(decision: DoomDecision) -> Self {
        Self {
            steps: vec![DoomPlanStep::Hold {
                tics: decision.tics,
                actions: decision.actions,
            }],
        }
    }
}

/// The LEGACY single-step decision: how many engine tics to advance and the
/// action objects to issue (the engine vocabulary is opaque here).
///
/// Retained by Spec #3039 ST-3 as the value the continuous loop collapses a
/// [`DoomPlan`] to ([`DoomPlan::as_single_hold`]) until the ST-4 executor lands;
/// a legacy `{tics, actions}` reply maps to a single [`DoomPlanStep::Hold`].
///
/// `tics` is an `i64` and is deliberately **not** clamped at this layer — range
/// validation (1-350) belongs to the loop, so the contract never hides an
/// out-of-range value and the loop's validation path stays exercisable.
#[derive(Clone, Debug, PartialEq)]
pub struct DoomDecision {
    /// Number of engine tics to advance (the loop validates the 1-350 bound).
    pub tics: i64,
    /// The action objects to issue (engine vocabulary, opaque at this layer).
    pub actions: Vec<Value>,
}

/// Why a [`DoomDecisionSource`] could not produce a usable plan.
///
/// Every variant is typed and bounded: the loop maps each onto its consecutive-
/// failure path, so an unusable plan can never hang the run (R-4 / G-263).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DoomDecisionError {
    /// The source answered, but its reply was not a usable plan object (bad
    /// JSON, a missing/wrong-typed field, an unknown `op`, an out-of-bounds
    /// field, or more than [`DOOM_PLAN_MAX_STEPS`] steps).
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

/// The optional model-source metadata attached to a decision (Spec #3032 ST-4).
///
/// An ADDITIVE side-channel on the shared decision boundary: a source MAY record
/// the metadata for its most recent decision and the loop-side dataset assembler
/// reads it via [`DoomDecisionSource::last_decision_trace`]. It deliberately does
/// NOT change [`DoomDecisionSource::decide`] — every existing impl (scripted /
/// local) keeps its signature and defaults to `None`.
///
/// `raw_reply` and `reasoning` are populated ONLY when their own dataset capture
/// flags are on, and each is already size-bounded by the source
/// (`applications/llm_server`) before it enters the trace.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DoomDecisionTrace {
    /// Which source produced the decision: `"model"` | `"scripted"` | `"local"`.
    pub source: &'static str,
    /// The backing model's id (the served alias / model file stem), when known.
    pub model_id: Option<String>,
    /// The server flags the decision ran under (e.g. `reasoning=on`), when known.
    pub server_flags: Option<String>,
    /// The persona/prompt version the request was built with, when known.
    pub prompt_version: Option<String>,
    /// The response-schema contract name ([`DOOM_PLAN_SCHEMA_NAME`]).
    pub schema_version: &'static str,
    /// The decision's latency, stamped by the loop that drives the source (the
    /// source itself never reads a clock — R-1 / NFR-5).
    pub latency_ms: Option<u64>,
    /// The model's raw reply text — present only when raw capture is enabled.
    pub raw_reply: Option<String>,
    /// The model's hidden reasoning text — present only when its own capture
    /// flag is enabled (its own flag + size bound).
    pub reasoning: Option<String>,
}

// ── Plan JSON parser (shared by the model path and the scripted lever) ────────

/// Parse a reply value into a [`DoomPlan`] (Spec #3039 ST-3).
///
/// Accepts either:
///
/// * the plan object `{ "steps": [ { "op": "move", "bearing": 90, "distance": 256 }, ... ] }`
///   (each step range-checked: `1..=DOOM_PLAN_MAX_STEPS` steps; known `op`;
///   `bearing` `0..=359`; `distance` `1..=DOOM_PLAN_DISTANCE_MAX`; `tics`
///   `1..=DOOM_PLAN_TICS_MAX`); or
/// * the legacy `doom_action` shape `{ "tics": N, "actions": [...] }` → a single
///   [`DoomPlanStep::Hold`]. The legacy `tics` is deliberately NOT range-checked
///   here — the loop's own validation path stays exercisable, exactly as before.
///
/// Any other shape is [`DoomDecisionError::Malformed`]: a non-object, a missing
/// `steps`/`tics`, an unknown `op`, an out-of-bounds field, an empty `steps`
/// array, or more than [`DOOM_PLAN_MAX_STEPS`] steps.
pub fn parse_doom_plan(value: &Value) -> Result<DoomPlan, DoomDecisionError> {
    let object = value.as_object().ok_or_else(|| {
        DoomDecisionError::Malformed("model reply is not a JSON object".to_string())
    })?;

    if let Some(steps) = object.get("steps") {
        return parse_plan_steps(steps);
    }

    // Legacy `{tics, actions}` reply → a single `Hold` step (the loop validates
    // the legacy `tics` range).
    let tics = object.get("tics").and_then(Value::as_i64).ok_or_else(|| {
        DoomDecisionError::Malformed("model reply is missing an integer `tics`".to_string())
    })?;
    let actions = object
        .get("actions")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| {
            DoomDecisionError::Malformed("model reply is missing an `actions` array".to_string())
        })?;
    Ok(DoomPlan {
        steps: vec![DoomPlanStep::Hold { tics, actions }],
    })
}

/// Parse the `steps` array of a plan object.
fn parse_plan_steps(steps: &Value) -> Result<DoomPlan, DoomDecisionError> {
    let array = steps.as_array().ok_or_else(|| {
        DoomDecisionError::Malformed("`steps` is not an array".to_string())
    })?;
    if array.is_empty() {
        return Err(DoomDecisionError::Malformed(
            "`steps` is empty (a plan needs at least one step)".to_string(),
        ));
    }
    if array.len() > DOOM_PLAN_MAX_STEPS {
        return Err(DoomDecisionError::Malformed(format!(
            "`steps` has {} entries, exceeding the maximum {DOOM_PLAN_MAX_STEPS}",
            array.len()
        )));
    }
    let mut parsed = Vec::with_capacity(array.len());
    for step in array {
        parsed.push(parse_plan_step(step)?);
    }
    Ok(DoomPlan { steps: parsed })
}

/// Parse one plan step, range-checking every typed field.
fn parse_plan_step(step: &Value) -> Result<DoomPlanStep, DoomDecisionError> {
    let object = step.as_object().ok_or_else(|| {
        DoomDecisionError::Malformed("plan step is not a JSON object".to_string())
    })?;
    let op = object.get("op").and_then(Value::as_str).ok_or_else(|| {
        DoomDecisionError::Malformed("plan step is missing a string `op`".to_string())
    })?;
    match op {
        "move" => {
            let bearing = require_bounded(object, "bearing", 0, 359)?;
            let distance = require_bounded(object, "distance", 1, DOOM_PLAN_DISTANCE_MAX)?;
            Ok(DoomPlanStep::Move { bearing, distance })
        }
        "open-door" => {
            let bearing = require_bounded(object, "bearing", 0, 359)?;
            Ok(DoomPlanStep::OpenDoor { bearing })
        }
        "shoot" => Ok(DoomPlanStep::Shoot {
            tics: require_tics(object)?,
        }),
        "wait" => Ok(DoomPlanStep::Wait {
            tics: require_tics(object)?,
        }),
        "hold" => {
            let tics = require_tics(object)?;
            let actions = object
                .get("actions")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| {
                    DoomDecisionError::Malformed(
                        "`hold` step is missing an `actions` array".to_string(),
                    )
                })?;
            Ok(DoomPlanStep::Hold { tics, actions })
        }
        other => Err(DoomDecisionError::Malformed(format!(
            "unknown plan op `{other}`"
        ))),
    }
}

/// Read an integer `key` from `object`, erroring when absent/non-integer or out
/// of `min..=max`.
fn require_bounded(
    object: &Map<String, Value>,
    key: &str,
    min: i64,
    max: i64,
) -> Result<i64, DoomDecisionError> {
    let value = object.get(key).and_then(Value::as_i64).ok_or_else(|| {
        DoomDecisionError::Malformed(format!("plan step is missing an integer `{key}`"))
    })?;
    if value < min || value > max {
        return Err(DoomDecisionError::Malformed(format!(
            "plan step `{key}` {value} is out of range {min}..={max}"
        )));
    }
    Ok(value)
}

/// Read the `tics` field of a step, bounded `1..=DOOM_PLAN_TICS_MAX`.
fn require_tics(object: &Map<String, Value>) -> Result<i64, DoomDecisionError> {
    require_bounded(object, "tics", 1, DOOM_PLAN_TICS_MAX)
}

/// The decision source the Doom autoplay loop drives.
///
/// Implemented by the model-backed source (`applications/llm_server`) and the
/// scripted lever (`applications/doom/decision.rs`) — the SAME interface, so
/// AC1/3/4/5 are verifiable without a live model (G-172). `Send + Sync` makes
/// `Arc<dyn DoomDecisionSource>` storable in Tauri-managed state.
#[async_trait]
pub trait DoomDecisionSource: Send + Sync {
    /// Decide the next [`DoomPlan`] from the whole engine observation.
    async fn decide(&self, observation: &Value) -> Result<DoomPlan, DoomDecisionError>;

    /// The MOST RECENT decision's optional [`DoomDecisionTrace`] (Spec #3032
    /// ST-4). The default is `None`: the scripted and local sources carry no
    /// model metadata, and this method MUST NOT change `decide`'s contract.
    fn last_decision_trace(&self) -> Option<DoomDecisionTrace> {
        None
    }
}

/// Tauri-managed holder of the active decision source.
///
/// `lib.rs` constructs the source and installs it once at startup; the autoplay
/// loop reads it. The `Mutex` guards only a short synchronous critical section
/// (clone the `Arc`) — it is NEVER held across an `.await`.
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
        async fn decide(&self, _observation: &Value) -> Result<DoomPlan, DoomDecisionError> {
            Ok(DoomPlan {
                steps: vec![DoomPlanStep::Hold {
                    tics: 1,
                    actions: vec![json!({ "type": "forward" })],
                }],
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
        let plan = source.decide(&json!({})).await.expect("decide succeeds");
        assert_eq!(
            plan,
            DoomPlan {
                steps: vec![DoomPlanStep::Hold {
                    tics: 1,
                    actions: vec![json!({ "type": "forward" })],
                }],
            }
        );
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

    // ── ST-4 decision-trace contract pins ─────────────────────────────────────

    /// The trace side-channel is defaulted: a source that does not override it
    /// (the scripted/local shape) reports no trace, and `decide` stays unchanged.
    #[test]
    fn the_default_decision_trace_is_absent() {
        assert!(FixedSource.last_decision_trace().is_none());
    }

    /// A source MAY override [`DoomDecisionSource::last_decision_trace`] to carry
    /// the model metadata, without touching `decide`.
    #[test]
    fn a_source_may_override_the_decision_trace() {
        struct TracedSource;

        #[async_trait]
        impl DoomDecisionSource for TracedSource {
            async fn decide(&self, _observation: &Value) -> Result<DoomPlan, DoomDecisionError> {
                Ok(DoomPlan {
                    steps: vec![DoomPlanStep::Wait { tics: 1 }],
                })
            }

            fn last_decision_trace(&self) -> Option<DoomDecisionTrace> {
                Some(DoomDecisionTrace {
                    source: "model",
                    model_id: Some("Gemma-4-E2B".to_string()),
                    server_flags: Some("reasoning=on".to_string()),
                    prompt_version: Some("1".to_string()),
                    schema_version: DOOM_PLAN_SCHEMA_NAME,
                    latency_ms: Some(12),
                    raw_reply: Some("{}".to_string()),
                    reasoning: None,
                })
            }
        }

        let trace = TracedSource
            .last_decision_trace()
            .expect("the override yields a trace");
        assert_eq!(trace.source, "model");
        assert_eq!(trace.model_id.as_deref(), Some("Gemma-4-E2B"));
        assert_eq!(trace.server_flags.as_deref(), Some("reasoning=on"));
        assert_eq!(trace.prompt_version.as_deref(), Some("1"));
        assert_eq!(trace.schema_version, "doom_plan");
        assert_eq!(trace.latency_ms, Some(12));
        assert!(trace.reasoning.is_none());
    }

    // ── ST-3 plan contract pins ───────────────────────────────────────────────

    #[test]
    fn the_plan_contract_constants_are_pinned() {
        assert_eq!(DOOM_PLAN_SCHEMA_NAME, "doom_plan");
        assert_eq!(DOOM_PLAN_MAX_STEPS, 8);
        assert_eq!(DOOM_PLAN_DISTANCE_MAX, 1024);
        assert_eq!(DOOM_PLAN_TICS_MAX, 350);
    }

    #[test]
    fn parse_doom_plan_accepts_a_full_plan() {
        let plan = parse_doom_plan(&json!({
            "steps": [
                { "op": "move", "bearing": 90, "distance": 256 },
                { "op": "open-door", "bearing": 270 },
                { "op": "shoot", "tics": 20 },
                { "op": "wait", "tics": 35 },
            ]
        }))
        .expect("a valid plan");
        assert_eq!(
            plan,
            DoomPlan {
                steps: vec![
                    DoomPlanStep::Move {
                        bearing: 90,
                        distance: 256,
                    },
                    DoomPlanStep::OpenDoor { bearing: 270 },
                    DoomPlanStep::Shoot { tics: 20 },
                    DoomPlanStep::Wait { tics: 35 },
                ],
            }
        );
    }

    #[test]
    fn parse_doom_plan_accepts_the_bounds() {
        let plan = parse_doom_plan(&json!({
            "steps": [
                { "op": "move", "bearing": 0, "distance": 1 },
                { "op": "move", "bearing": 359, "distance": DOOM_PLAN_DISTANCE_MAX },
                { "op": "shoot", "tics": 1 },
                { "op": "wait", "tics": DOOM_PLAN_TICS_MAX },
            ]
        }))
        .expect("inclusive bounds are accepted");
        assert_eq!(plan.steps.len(), 4);
    }

    #[test]
    fn parse_doom_plan_maps_a_legacy_reply_to_a_single_hold() {
        let plan = parse_doom_plan(&json!({
            "tics": 7,
            "actions": [{ "type": "forward" }],
        }))
        .expect("the legacy shape parses");
        assert_eq!(
            plan,
            DoomPlan {
                steps: vec![DoomPlanStep::Hold {
                    tics: 7,
                    actions: vec![json!({ "type": "forward" })],
                }],
            }
        );
        // The legacy `tics` passes through unvalidated (the loop checks it).
        let out_of_range = parse_doom_plan(&json!({ "tics": 9999, "actions": [] }))
            .expect("the legacy tics is not range-checked here");
        assert_eq!(out_of_range.as_single_hold().tics, 9999);
    }

    #[test]
    fn parse_doom_plan_is_malformed_on_bad_shapes() {
        // Non-object.
        assert!(matches!(
            parse_doom_plan(&json!([1, 2])),
            Err(DoomDecisionError::Malformed(_))
        ));
        // Missing `steps` and `tics`.
        assert!(matches!(
            parse_doom_plan(&json!({ "actions": [] })),
            Err(DoomDecisionError::Malformed(_))
        ));
        // `steps` not an array.
        assert!(matches!(
            parse_doom_plan(&json!({ "steps": 3 })),
            Err(DoomDecisionError::Malformed(_))
        ));
        // Empty `steps`.
        assert!(matches!(
            parse_doom_plan(&json!({ "steps": [] })),
            Err(DoomDecisionError::Malformed(_))
        ));
        // Over the step maximum.
        let too_many: Vec<Value> = (0..=DOOM_PLAN_MAX_STEPS)
            .map(|_| json!({ "op": "wait", "tics": 1 }))
            .collect();
        assert!(matches!(
            parse_doom_plan(&json!({ "steps": too_many })),
            Err(DoomDecisionError::Malformed(_))
        ));
        // Unknown `op`.
        assert!(matches!(
            parse_doom_plan(&json!({ "steps": [{ "op": "teleport" }] })),
            Err(DoomDecisionError::Malformed(_))
        ));
        // Missing `op`.
        assert!(matches!(
            parse_doom_plan(&json!({ "steps": [{ "bearing": 90 }] })),
            Err(DoomDecisionError::Malformed(_))
        ));
        // Out-of-bounds bearing (both ends).
        assert!(matches!(
            parse_doom_plan(&json!({ "steps": [{ "op": "move", "bearing": 360, "distance": 1 }] })),
            Err(DoomDecisionError::Malformed(_))
        ));
        assert!(matches!(
            parse_doom_plan(&json!({ "steps": [{ "op": "move", "bearing": -1, "distance": 1 }] })),
            Err(DoomDecisionError::Malformed(_))
        ));
        // Out-of-bounds distance (both ends).
        assert!(matches!(
            parse_doom_plan(&json!({ "steps": [{ "op": "move", "bearing": 0, "distance": 0 }] })),
            Err(DoomDecisionError::Malformed(_))
        ));
        assert!(matches!(
            parse_doom_plan(&json!({ "steps": [{ "op": "move", "bearing": 0, "distance": DOOM_PLAN_DISTANCE_MAX + 1 }] })),
            Err(DoomDecisionError::Malformed(_))
        ));
        // Out-of-bounds tics.
        assert!(matches!(
            parse_doom_plan(&json!({ "steps": [{ "op": "wait", "tics": 0 }] })),
            Err(DoomDecisionError::Malformed(_))
        ));
        assert!(matches!(
            parse_doom_plan(&json!({ "steps": [{ "op": "shoot", "tics": DOOM_PLAN_TICS_MAX + 1 }] })),
            Err(DoomDecisionError::Malformed(_))
        ));
        // A non-integer field is malformed.
        assert!(matches!(
            parse_doom_plan(&json!({ "steps": [{ "op": "move", "bearing": 90, "distance": 1.5 }] })),
            Err(DoomDecisionError::Malformed(_))
        ));
    }

    #[test]
    fn as_single_hold_collapses_a_multi_step_plan_to_a_neutral_hold() {
        let plan = DoomPlan {
            steps: vec![
                DoomPlanStep::Move {
                    bearing: 90,
                    distance: 256,
                },
                DoomPlanStep::Shoot { tics: 20 },
            ],
        };
        assert_eq!(
            plan.as_single_hold(),
            DoomDecision {
                tics: 1,
                actions: Vec::new(),
            }
        );
    }

    #[test]
    fn a_legacy_decision_round_trips_through_a_plan() {
        let decision = DoomDecision {
            tics: 5,
            actions: vec![json!({ "type": "forward" })],
        };
        let plan = DoomPlan::from(decision.clone());
        assert_eq!(plan.as_single_hold(), decision);
    }
}
