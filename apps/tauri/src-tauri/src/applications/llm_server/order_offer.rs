//! Spec #3243 ST-3 — the `order` companion skill: ONE static offer member that
//! lets the model *select* an action in the application Fredo is placed in.
//!
//! # Why this module exists (and why it is only a declaration)
//!
//! Spec #3152 deliberately deleted the per-application command path: the offer
//! became three static skills and the companion executed no application command.
//! This slice re-adds the minimum that makes AC-1 reachable at all — a FOURTH
//! static skill whose selection the frontend can act on. It re-adds **no**
//! publish path, no per-application registry and no application command relay:
//! `order` is a static declaration exactly like `open_app`.
//!
//! The declaration lives here, not in [`crate::infrastructure::companion::skills`],
//! so the registry module stays what it was — a mechanism-neutral container —
//! and each skill's own contract sits with the surface that owns it.
//!
//! # AC-7's offer-side construction
//!
//! The schema declares EXACTLY two properties, `action` and `arguments`, and no
//! confirmation-shaped property of any kind. That is structural, not a policy
//! the model is asked to honour: there is no key the model could fill to
//! authorise its own action. The pin at the bottom of this module asserts the
//! property set is closed (exact set equality, never a containment check), and a
//! mutation adding a `confirmed`-style property reddens it.
//!
//! `arguments` stays a free-form object on purpose: the ACTION's own arguments
//! are the frontend's business (the declared action table validates them), and a
//! nested property inside `arguments` still cannot mint a grant — the grant
//! exists only as a UI-minted value.

use serde_json::{json, Value};

/// The skill name the model selects to carry out one order.
pub const ORDER_SKILL: &str = "order";

/// The `order` argument naming the action id to carry out (e.g.
/// `wireframe.element.fill`).
pub const ORDER_ACTION_ARG: &str = "action";

/// The `order` argument carrying the action's own arguments object.
pub const ORDER_ARGUMENTS_ARG: &str = "arguments";

/// The capability sentence offered for `order` (mechanism-neutral).
///
/// Scoped by "in the application Fredo is placed in" and "ONE action" so the
/// model does not reach for it on unrelated requests — the same discipline the
/// shipped `open_app` / `doom_mode` descriptions carry.
pub const ORDER_SKILL_DESCRIPTION: &str =
    "Carry out ONE action in the application Fredo is placed in. Use ONLY when the user gives a \
     short order about that application.";

/// The declared input contract for `order`: EXACTLY `action` (required) and
/// `arguments` (optional). No confirmation-shaped property exists — see the
/// module docs (AC-7, structural half).
///
/// The two keys are built from [`ORDER_ACTION_ARG`] / [`ORDER_ARGUMENTS_ARG`] so
/// the published constant and the rendered schema cannot drift apart.
pub fn order_parameters() -> Value {
    let mut properties = serde_json::Map::new();
    properties.insert(ORDER_ACTION_ARG.to_string(), json!({ "type": "string" }));
    properties.insert(ORDER_ARGUMENTS_ARG.to_string(), json!({ "type": "object" }));
    json!({
        "type": "object",
        "properties": Value::Object(properties),
        "required": [ORDER_ACTION_ARG]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The declared property names, in schema declaration order — read straight
    /// from the rendered schema (there is no second enumeration to drift).
    fn property_names() -> Vec<String> {
        order_parameters()
            .get("properties")
            .and_then(Value::as_object)
            .map(|properties| properties.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// The binding names are exactly what the plan published — a consumer that
    /// hard-codes one of them cannot drift from this module silently.
    #[test]
    fn the_binding_names_are_exactly_the_published_ones() {
        assert_eq!(ORDER_SKILL, "order");
        assert_eq!(ORDER_ACTION_ARG, "action");
        assert_eq!(ORDER_ARGUMENTS_ARG, "arguments");
    }

    /// AC-7 offer-side: the property set is CLOSED at exactly `action` +
    /// `arguments`. Exact set equality — never `contains` — so an ADDED property
    /// fails as loudly as a removed one.
    #[test]
    fn the_offered_schema_declares_exactly_action_and_arguments() {
        let names = property_names();
        assert_eq!(
            names,
            vec![ORDER_ACTION_ARG.to_string(), ORDER_ARGUMENTS_ARG.to_string()],
            "the offered `order` schema must declare exactly `action` + `arguments`, in that order"
        );

        let schema = order_parameters();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["required"], json!([ORDER_ACTION_ARG]));
        assert_eq!(schema["properties"][ORDER_ACTION_ARG]["type"], "string");
        assert_eq!(schema["properties"][ORDER_ARGUMENTS_ARG]["type"], "object");
    }

    /// AC-7 offer-side, the negative half: NO property exists that a model could
    /// fill to authorise its own action. The defect world is a schema carrying a
    /// `confirmed` / `approved` / `grant` / `authoriz*` key — a confirmation
    /// channel dressed as an argument.
    #[test]
    fn the_offered_schema_carries_no_confirmation_shaped_property() {
        for name in property_names() {
            let lowered = name.to_ascii_lowercase();
            for forbidden in ["confirm", "approv", "grant", "authoriz"] {
                assert!(
                    !lowered.contains(forbidden),
                    "the `order` schema must carry no confirmation-shaped property — found `{name}`"
                );
            }
        }
    }

    /// The description is the ONLY prose the model sees about this skill, so it
    /// must scope the skill (one action, the placed application) rather than
    /// describe a general capability.
    #[test]
    fn the_description_scopes_the_skill_to_one_action_in_the_placed_application() {
        let lowered = ORDER_SKILL_DESCRIPTION.to_ascii_lowercase();
        assert!(lowered.contains("one action"), "{}", ORDER_SKILL_DESCRIPTION);
        assert!(
            lowered.contains("placed in"),
            "{}",
            ORDER_SKILL_DESCRIPTION
        );
        assert!(lowered.contains("only"), "{}", ORDER_SKILL_DESCRIPTION);
    }
}
