//! Doom engine action vocabulary (Spec #2969, ST-1).
//!
//! The engine's accepted action-object vocabulary is **not vendored in-repo** —
//! it lives in the pinned `mkschreder/restful-doom` fork (commit
//! `eded41b5597b7738ec1fa06d24f62b53db982c2c`). This module pins the vocabulary
//! that the persona (ST-4) and the scripted decision lever (ST-2) consume, as
//! confirmed against a **live** `restful-doom.exe` in the Phase-0 probe:
//!
//! * `POST /api/step` `{ "tics": <1-350>, "actions": [<action objects>] }`
//! * `POST /api/player/actions` `<action object>` (the same parser; 201/400)
//!
//! Probe record: `spikes/2969-doom-agent/action-vocabulary.md`.
//! Source of truth: `src/doom/api_player_controller.c` (`API_PostPlayerAction`)
//! and `src/doom/api.c` (`API_RouteRequest`), at the pinned commit.
//!
//! **Do not invent action names.** Every [`DOOM_ACTION_*`] string here was
//! accepted by the live engine; every name absent here was rejected with HTTP
//! 400 `"invalid action type"`. The RAML `player_action.raml` `type` example is
//! stale — it omits `turn-to` and `run`, both of which the live engine accepts.
//!
//! # Field semantics (live-confirmed)
//!
//! * `amount` — hold duration in **tics** for the key-based actions
//!   (`forward`/`backward`/`turn-*`/`strafe-*`/`run`/`shoot`); defaults to
//!   [`DOOM_ACTION_AMOUNT_DEFAULT`] (10) when omitted. It must be a positive
//!   integer when present (`amount: 0` and a non-number are both 400).
//! * `switch-weapon` reuses `amount` as the **weapon slot** (1-8). Omitting it
//!   defaults to 10, which is out of range and rejected — so it is effectively
//!   required.
//! * `turn-to` takes `angle` (absolute map degrees, 0-359) and **not**
//!   `amount`; the servo closes the remaining angle over the following tics.
//! * `use` is resolved immediately on arrival and ignores `amount`/`angle`.
//! * `run` is a **modifier**, not a movement of its own: it does nothing alone
//!   and is sent in the same `actions` array as the `forward`/`strafe` it
//!   doubles.

use serde_json::{json, Value};

// ── Action type strings (exactly what the engine accepts) ────────────────────

/// `{"type": "forward"}` — hold the forward key for `amount` tics.
pub const DOOM_ACTION_FORWARD: &str = "forward";
/// `{"type": "backward"}` — hold the backward key for `amount` tics.
pub const DOOM_ACTION_BACKWARD: &str = "backward";
/// `{"type": "turn-left"}` — hold the turn-left key for `amount` tics.
pub const DOOM_ACTION_TURN_LEFT: &str = "turn-left";
/// `{"type": "turn-right"}` — hold the turn-right key for `amount` tics.
pub const DOOM_ACTION_TURN_RIGHT: &str = "turn-right";
/// `{"type": "strafe-left"}` — hold the strafe-left key for `amount` tics.
pub const DOOM_ACTION_STRAFE_LEFT: &str = "strafe-left";
/// `{"type": "strafe-right"}` — hold the strafe-right key for `amount` tics.
pub const DOOM_ACTION_STRAFE_RIGHT: &str = "strafe-right";
/// `{"type": "run"}` — hold the speed modifier; combine with a movement action.
pub const DOOM_ACTION_RUN: &str = "run";
/// `{"type": "switch-weapon", "amount": <1-8>}` — select a weapon by slot.
pub const DOOM_ACTION_SWITCH_WEAPON: &str = "switch-weapon";
/// `{"type": "turn-to", "angle": <0-359>}` — face an absolute map angle.
pub const DOOM_ACTION_TURN_TO: &str = "turn-to";
/// `{"type": "use"}` — press use, resolved immediately at the current facing.
pub const DOOM_ACTION_USE: &str = "use";
/// `{"type": "shoot"}` — hold the fire key for `amount` tics.
pub const DOOM_ACTION_SHOOT: &str = "shoot";

// ── Field bounds (live-confirmed; mirrored by the model request schema) ──────

/// Minimum accepted `angle` for `turn-to` (inclusive).
pub const DOOM_ACTION_ANGLE_MIN: i64 = 0;
/// Maximum accepted `angle` for `turn-to` (inclusive).
pub const DOOM_ACTION_ANGLE_MAX: i64 = 359;
/// Default hold duration when `amount` is omitted (engine default).
pub const DOOM_ACTION_AMOUNT_DEFAULT: i64 = 10;
/// Minimum accepted `amount` when present (0 is rejected).
pub const DOOM_ACTION_AMOUNT_MIN: i64 = 1;
/// Minimum accepted `switch-weapon` slot.
pub const DOOM_ACTION_WEAPON_SLOT_MIN: i64 = 1;
/// Maximum accepted `switch-weapon` slot.
pub const DOOM_ACTION_WEAPON_SLOT_MAX: i64 = 8;

/// Minimum accepted `tics` for `POST /api/step` (inclusive).
pub const DOOM_STEP_TICS_MIN: i64 = 1;
/// Maximum accepted `tics` for `POST /api/step` (inclusive).
pub const DOOM_STEP_TICS_MAX: i64 = 350;

// ── Structured vocabulary (the list the persona / script consume) ────────────

/// One accepted action object in the engine's vocabulary.
///
/// This is the typed form of the vocabulary; [`action_vocabulary_json`] renders
/// it as the `allowedActions` array a model request carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DoomActionDefinition {
    /// The exact `type` string the engine accepts.
    pub action: &'static str,
    /// One-line description of what the action does (for the persona).
    pub summary: &'static str,
    /// Whether the action takes an `amount` (hold duration, or weapon slot for
    /// `switch-weapon`).
    pub takes_amount: bool,
    /// Whether `amount` is effectively required (only `switch-weapon`: the
    /// default 10 is out of the 1-8 slot range).
    pub amount_required: bool,
    /// Whether the action takes an `angle` (only `turn-to`).
    pub takes_angle: bool,
}

/// The complete live-confirmed vocabulary, in the order the persona should read
/// it (movement, then stance, then interaction).
pub const DOOM_ACTION_VOCABULARY: &[DoomActionDefinition] = &[
    DoomActionDefinition {
        action: DOOM_ACTION_FORWARD,
        summary: "Hold forward for `amount` tics (default 10); moves along facing.",
        takes_amount: true,
        amount_required: false,
        takes_angle: false,
    },
    DoomActionDefinition {
        action: DOOM_ACTION_BACKWARD,
        summary: "Hold backward for `amount` tics (default 10).",
        takes_amount: true,
        amount_required: false,
        takes_angle: false,
    },
    DoomActionDefinition {
        action: DOOM_ACTION_STRAFE_LEFT,
        summary: "Strafe left for `amount` tics (default 10).",
        takes_amount: true,
        amount_required: false,
        takes_angle: false,
    },
    DoomActionDefinition {
        action: DOOM_ACTION_STRAFE_RIGHT,
        summary: "Strafe right for `amount` tics (default 10).",
        takes_amount: true,
        amount_required: false,
        takes_angle: false,
    },
    DoomActionDefinition {
        action: DOOM_ACTION_TURN_LEFT,
        summary: "Hold turn-left for `amount` tics (default 10); a fixed turn per tic.",
        takes_amount: true,
        amount_required: false,
        takes_angle: false,
    },
    DoomActionDefinition {
        action: DOOM_ACTION_TURN_RIGHT,
        summary: "Hold turn-right for `amount` tics (default 10); a fixed turn per tic.",
        takes_amount: true,
        amount_required: false,
        takes_angle: false,
    },
    DoomActionDefinition {
        action: DOOM_ACTION_TURN_TO,
        summary: "Face an absolute map angle (0-359); the servo closes over following tics.",
        takes_amount: false,
        amount_required: false,
        takes_angle: true,
    },
    DoomActionDefinition {
        action: DOOM_ACTION_RUN,
        summary: "Hold the speed modifier for `amount` tics; combine with a movement action.",
        takes_amount: true,
        amount_required: false,
        takes_angle: false,
    },
    DoomActionDefinition {
        action: DOOM_ACTION_SHOOT,
        summary: "Hold fire for `amount` tics (default 10); the weapon state machine decides.",
        takes_amount: true,
        amount_required: false,
        takes_angle: false,
    },
    DoomActionDefinition {
        action: DOOM_ACTION_USE,
        summary: "Press use at the current facing; resolved immediately, ignores amount/angle.",
        takes_amount: false,
        amount_required: false,
        takes_angle: false,
    },
    DoomActionDefinition {
        action: DOOM_ACTION_SWITCH_WEAPON,
        summary: "Select weapon slot 1-8; `amount` is the slot and is required.",
        takes_amount: true,
        amount_required: true,
        takes_angle: false,
    },
];

/// Render [`DOOM_ACTION_VOCABULARY`] as the structured `allowedActions` array a
/// model request carries (ST-4) and the scripted lever documents (ST-2).
///
/// Shape per entry:
///
/// ```json
/// {
///   "type": "forward",
///   "summary": "Hold forward for `amount` tics (default 10); moves along facing.",
///   "amount": { "min": 1, "default": 10, "required": false, "unit": "tics" },
///   "angle": null
/// }
/// ```
///
/// For `turn-to`, `amount` is `null` and `angle` carries
/// `{ "min": 0, "max": 359, "required": true, "unit": "degrees" }`. For
/// `switch-weapon`, `amount` carries `{ "min": 1, "max": 8, ... }`.
pub fn action_vocabulary_json() -> Value {
    Value::Array(
        DOOM_ACTION_VOCABULARY
            .iter()
            .map(|definition| {
                let amount = if definition.takes_amount {
                    let (min, max) = if definition.action == DOOM_ACTION_SWITCH_WEAPON {
                        (DOOM_ACTION_WEAPON_SLOT_MIN, DOOM_ACTION_WEAPON_SLOT_MAX)
                    } else {
                        (DOOM_ACTION_AMOUNT_MIN, i64::MAX)
                    };
                    json!({
                        "min": min,
                        "max": max,
                        "default": if definition.action == DOOM_ACTION_SWITCH_WEAPON {
                            Value::Null
                        } else {
                            json!(DOOM_ACTION_AMOUNT_DEFAULT)
                        },
                        "required": definition.amount_required,
                        "unit": if definition.action == DOOM_ACTION_SWITCH_WEAPON {
                            "slot"
                        } else {
                            "tics"
                        },
                    })
                } else {
                    Value::Null
                };
                let angle = if definition.takes_angle {
                    json!({
                        "min": DOOM_ACTION_ANGLE_MIN,
                        "max": DOOM_ACTION_ANGLE_MAX,
                        "required": true,
                        "unit": "degrees",
                    })
                } else {
                    Value::Null
                };
                json!({
                    "type": definition.action,
                    "summary": definition.summary,
                    "amount": amount,
                    "angle": angle,
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vocabulary_is_exactly_the_live_accepted_types() {
        let names: Vec<&str> = DOOM_ACTION_VOCABULARY
            .iter()
            .map(|definition| definition.action)
            .collect();
        assert_eq!(
            names,
            vec![
                "forward",
                "backward",
                "strafe-left",
                "strafe-right",
                "turn-left",
                "turn-right",
                "turn-to",
                "run",
                "shoot",
                "use",
                "switch-weapon",
            ],
            "the vocabulary must stay the live-confirmed set (do not invent action names)"
        );
    }

    #[test]
    fn vocabulary_types_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for definition in DOOM_ACTION_VOCABULARY {
            assert!(
                seen.insert(definition.action),
                "duplicate action type {}",
                definition.action
            );
        }
    }

    #[test]
    fn only_turn_to_takes_an_angle_and_only_switch_weapon_requires_amount() {
        for definition in DOOM_ACTION_VOCABULARY {
            assert_eq!(
                definition.takes_angle,
                definition.action == DOOM_ACTION_TURN_TO,
                "{} angle flag",
                definition.action
            );
            assert_eq!(
                definition.amount_required,
                definition.action == DOOM_ACTION_SWITCH_WEAPON,
                "{} amount_required flag",
                definition.action
            );
        }
    }

    #[test]
    fn engine_bounds_are_pinned() {
        // Live-confirmed: angle 360 -> 400, tics 0/351 -> 400, amount 0 -> 400,
        // switch-weapon 9 -> 400.
        assert_eq!(DOOM_ACTION_ANGLE_MIN, 0);
        assert_eq!(DOOM_ACTION_ANGLE_MAX, 359);
        assert_eq!(DOOM_ACTION_AMOUNT_DEFAULT, 10);
        assert_eq!(DOOM_ACTION_AMOUNT_MIN, 1);
        assert_eq!(DOOM_ACTION_WEAPON_SLOT_MIN, 1);
        assert_eq!(DOOM_ACTION_WEAPON_SLOT_MAX, 8);
        assert_eq!(DOOM_STEP_TICS_MIN, 1);
        assert_eq!(DOOM_STEP_TICS_MAX, 350);
    }

    #[test]
    fn vocabulary_json_renders_type_and_field_bounds() {
        let vocabulary = action_vocabulary_json();
        let entries = vocabulary.as_array().expect("array");
        assert_eq!(entries.len(), DOOM_ACTION_VOCABULARY.len());

        let turn_to = entries
            .iter()
            .find(|entry| entry["type"] == DOOM_ACTION_TURN_TO)
            .expect("turn-to present");
        assert!(turn_to["amount"].is_null(), "turn-to takes no amount");
        assert_eq!(turn_to["angle"]["min"], 0);
        assert_eq!(turn_to["angle"]["max"], 359);
        assert_eq!(turn_to["angle"]["required"], true);

        let switch_weapon = entries
            .iter()
            .find(|entry| entry["type"] == DOOM_ACTION_SWITCH_WEAPON)
            .expect("switch-weapon present");
        assert_eq!(switch_weapon["amount"]["min"], 1);
        assert_eq!(switch_weapon["amount"]["max"], 8);
        assert_eq!(switch_weapon["amount"]["required"], true);
        assert!(switch_weapon["amount"]["default"].is_null());
        assert!(switch_weapon["angle"].is_null());

        let forward = entries
            .iter()
            .find(|entry| entry["type"] == DOOM_ACTION_FORWARD)
            .expect("forward present");
        assert_eq!(forward["amount"]["default"], 10);
        assert_eq!(forward["amount"]["required"], false);
        assert!(forward["angle"].is_null());
    }
}
