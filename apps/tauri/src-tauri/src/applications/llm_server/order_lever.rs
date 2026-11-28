//! Spec #3243 ST-8 — the in-repo order-selection lever.
//!
//! # Why a lever exists at all
//!
//! AC-6 and AC-8 need a `changing`/`destructive` selection to act on, and the only
//! other way to get one is a live model that happens to choose `order` (the very
//! unknown #3244 exists to measure) or a human clicking a real app. G-275 says an
//! AC whose only lever is a human clicking is not drivable, so this module
//! produces the selection deterministically.
//!
//! # INERT unless explicitly armed (G-469)
//!
//! **An armed-by-default lever makes every AC-6/AC-8 row prove nothing** — the
//! round would "pass" whether or not the real path works. So:
//!
//! * `FREDO_ORDER_SKILL_LEVER` must be exactly `1`/`true`/`on` (case-insensitive);
//!   anything else — including unset — is INERT and [`take_order_selection`]
//!   returns `None`;
//! * `FREDO_ORDER_SKILL_SCRIPT` names a JSON file whose entries are consumed ONE
//!   per call, so a round can arm a single selection and then observe the lever
//!   return nothing (the unarmed read is the control run FIRST in the same round).
//!
//! This mirrors `ScriptedDecisionSource` (`applications/doom/decision.rs`), the
//! precedent the plan names: the same env-gated, file-scripted, inert-when-unset
//! shape, so an operator learns one mechanism rather than two.
//!
//! # It emits on the SAME `llm-skill-call` channel
//!
//! The lever is a SELECTION PRODUCER, not a second dispatcher: it returns the
//! validated payload shape the model's selection has and the frontend emits it on
//! the channel the backend already uses. Nothing here executes an order, and
//! there is no path from here to an executor that bypasses the gate — which is
//! what keeps the lever honest evidence for AC-6 rather than a shortcut around it.
//!
//! # It produces a CLASSIFIED selection
//!
//! The command returns the selection together with the app id it is aimed at, so
//! the caller drives the SAME `classifyOrder` / `resolveOrderConfirmation` path a
//! model selection drives. A lever that produced an unclassified selection could
//! not exercise AC-6 at all — which is why this module was withheld until the
//! classification surface landed.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Arm the lever. Absent/any other value ⇒ INERT.
pub const ORDER_SKILL_LEVER_ENV: &str = "FREDO_ORDER_SKILL_LEVER";
/// The JSON script file the lever consumes, one entry per call.
pub const ORDER_SKILL_SCRIPT_ENV: &str = "FREDO_ORDER_SKILL_SCRIPT";

/// One scripted selection: the payload the model would have produced.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderSkillSelection {
    /// The app the selection is aimed at (the placed app).
    pub app_id: String,
    /// The `order` skill's `action` argument.
    pub action: String,
    /// The `order` skill's `arguments` argument (string-valued, as the schema
    /// declares). Absent ⇒ no arguments.
    #[serde(default)]
    pub arguments: Value,
}

/// What a takeover returned.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderSkillLeverTake {
    /// True iff the lever is ARMED and produced a selection. A `false` here is the
    /// unarmed control reading, never an error.
    pub armed: bool,
    /// The selection, when armed.
    pub selection: Option<OrderSkillSelection>,
}

/// Parse the arm switch. `1` / `true` / `on` (case-insensitive) arm it; everything
/// else — including a blank value and an absent variable — leaves it INERT.
pub fn is_lever_armed(raw: Option<&str>) -> bool {
    match raw.map(str::trim) {
        Some(value) => {
            value.eq_ignore_ascii_case("1")
                || value.eq_ignore_ascii_case("true")
                || value.eq_ignore_ascii_case("on")
        }
        None => false,
    }
}

/// The effective arm state from [`ORDER_SKILL_LEVER_ENV`].
pub fn lever_armed_from_env() -> bool {
    is_lever_armed(std::env::var(ORDER_SKILL_LEVER_ENV).ok().as_deref())
}

/// The script path from [`ORDER_SKILL_SCRIPT_ENV`], when set and non-blank.
pub fn script_path_from_env() -> Option<PathBuf> {
    let raw = std::env::var(ORDER_SKILL_SCRIPT_ENV).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

/// Read the script's entries. A missing/unreadable/malformed file yields an EMPTY
/// list rather than an error: the lever is a test seam, and a broken script must
/// degrade to "no selection" (the unarmed reading) instead of failing a turn.
pub fn read_script(path: &PathBuf) -> Vec<OrderSkillSelection> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<OrderSkillSelection>>(&text).unwrap_or_default()
}

/// Take the NEXT scripted entry, leaving the remainder in the file.
///
/// One entry per call, so a round can arm exactly one selection and then read the
/// lever again to prove it has nothing left. Returns `None` when the lever is
/// unarmed or the script is exhausted — the same `None` both times, which is what
/// makes "inert unless armed" a single observable.
pub fn take_order_selection() -> Option<OrderSkillLeverTake> {
    if !lever_armed_from_env() {
        return Some(OrderSkillLeverTake {
            armed: false,
            selection: None,
        });
    }
    let Some(path) = script_path_from_env() else {
        // Armed with no script: armed, but nothing to produce. Reported as armed
        // so a row can tell "I forgot to arm it" from "I armed it and the script
        // was empty" — the two failures need different fixes.
        return Some(OrderSkillLeverTake {
            armed: true,
            selection: None,
        });
    };
    let mut entries = read_script(&path);
    if entries.is_empty() {
        return Some(OrderSkillLeverTake {
            armed: true,
            selection: None,
        });
    }
    let next = entries.remove(0);
    // Rewrite the remaining entries. A write failure is logged and ignored: the
    // selection still travels, and a repeated entry is the worst case.
    if let Ok(text) = serde_json::to_string_pretty(&entries) {
        if let Err(error) = std::fs::write(&path, text) {
            tracing::warn!(
                target: "fredo::llm_server",
                error = %error,
                "the order lever could not rewrite its script"
            );
        }
    }
    Some(OrderSkillLeverTake {
        armed: true,
        selection: Some(next),
    })
}

/// The Tauri command. Inert by construction: with the lever unarmed it returns
/// `{ armed: false, selection: null }` and nothing else happens.
#[tauri::command]
pub async fn order_skill_lever_take() -> Result<OrderSkillLeverTake, String> {
    take_order_selection().ok_or_else(|| "the order lever returned no reading".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every non-arm spelling leaves the lever INERT — the property that makes
    /// every AC-6/AC-8 row mean something (G-469).
    #[test]
    fn the_lever_is_inert_for_every_non_arm_value() {
        for raw in [
            None,
            Some(""),
            Some("0"),
            Some("false"),
            Some("off"),
            Some("yes"),
            Some("armed"),
            Some("2"),
        ] {
            assert!(
                !is_lever_armed(raw),
                "{} must not arm the lever",
                raw.unwrap_or("<unset>")
            );
        }
    }

    /// The three documented arm spellings all arm it, case-insensitively.
    #[test]
    fn the_lever_arms_for_the_documented_values() {
        for raw in ["1", "true", "TRUE", "On", " on "] {
            assert!(is_lever_armed(Some(raw)), "{raw} must arm the lever");
        }
    }

    /// A blank script path is the same as an absent one.
    #[test]
    fn a_blank_script_path_is_absent() {
        assert_eq!(script_path_from_env(), None);
    }

    /// A missing script file degrades to ZERO entries, never an error — a broken
    /// test seam must not fail a turn.
    #[test]
    fn a_missing_script_reads_as_empty() {
        let path = PathBuf::from("C:/nonexistent/order-lever-script.json");
        assert!(read_script(&path).is_empty());
    }

    /// A malformed script also reads as empty (the unarmed reading).
    #[test]
    fn a_malformed_script_reads_as_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("script.json");
        std::fs::write(&path, "{ not json ]").expect("write");
        assert!(read_script(&path).is_empty());
    }

    /// The script parses the published selection shape, INCLUDING the absent
    /// `arguments` key (never an explicit null requirement).
    #[test]
    fn the_script_parses_entries_with_and_without_arguments() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("script.json");
        std::fs::write(
            &path,
            r#"[
              {"appId":"wireframe","action":"wireframe.element.fill",
               "arguments":{"elementId":"el-1","fill":"accent"}},
              {"appId":"wireframe","action":"wireframe.document.new"}
            ]"#,
        )
        .expect("write");

        let entries = read_script(&path);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].action, "wireframe.element.fill");
        assert_eq!(entries[0].arguments["fill"], "accent");
        // The second entry omits `arguments` entirely and still parses.
        assert_eq!(entries[1].action, "wireframe.document.new");
        assert!(entries[1].arguments.is_null());
    }

    /// The take reading serialises to the camelCase wire the webview reads.
    #[test]
    fn the_reading_serialises_as_camel_case() {
        let unarmed = OrderSkillLeverTake {
            armed: false,
            selection: None,
        };
        let json = serde_json::to_value(&unarmed).expect("serialise");
        assert_eq!(json["armed"], false);
        assert!(json["selection"].is_null());

        let armed = OrderSkillLeverTake {
            armed: true,
            selection: Some(OrderSkillSelection {
                app_id: "wireframe".to_string(),
                action: "wireframe.element.fill".to_string(),
                arguments: serde_json::json!({"elementId": "el-1"}),
            }),
        };
        let json = serde_json::to_value(&armed).expect("serialise");
        assert_eq!(json["armed"], true);
        assert_eq!(json["selection"]["appId"], "wireframe");
        assert_eq!(json["selection"]["action"], "wireframe.element.fill");
        assert_eq!(json["selection"]["arguments"]["elementId"], "el-1");
    }
}
