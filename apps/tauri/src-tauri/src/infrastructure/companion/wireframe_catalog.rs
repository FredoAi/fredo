//! Wireframe companion catalog (Spec #3070, ST-7, C4).
//!
//! The ONE declaration of the `wireframe` skill: its name, its three declared
//! arguments and the 25-action catalog. The action ids + descriptions are
//! mirrored **character-for-character** from the frontend command table
//! (`apps/ui/src/applications/wireframe/actions/wireframeActions.ts`,
//! `WIREFRAME_ACTIONS`); the TS parity pin
//! (`__tests__/companionCatalog.parity.test.ts`) reads this source and asserts
//! the two lists are equal.
//!
//! Why one skill with an `action` argument (C4): the shipped registry validates
//! one JSON object per skill (`skills.rs`), so 25 declarations would mean 25
//! offer rows in every request body. The fail-closed rule is preserved — an
//! undeclared argument key still fails in [`validate`](super::skills::validate),
//! while an unknown *action value* is executed by the frontend, which reports
//! `performed: []` so the reply stays honest (R-6.4).
//!
//! Nothing here executes anything: this module is declaration + pure helpers.

use serde_json::{json, Value};

/// The skill name (binding, C9).
pub const WIREFRAME_SKILL: &str = "wireframe";

/// The required `action` argument carrying one catalog action id.
pub const WIREFRAME_ACTION_ARG: &str = "action";

/// The optional `app_name` argument (required in practice by `draftApp`).
pub const WIREFRAME_APP_NAME_ARG: &str = "app_name";

/// The optional `summary` argument (context only; the draft stays deterministic).
pub const WIREFRAME_SUMMARY_ARG: &str = "summary";

/// The C4 catalog, in catalog order. `(id, human description)`.
///
/// The first 22 rows are also the toolbar/hotkey command table; the last three
/// are the document command plus the two Companion-only commands.
pub const WIREFRAME_ACTIONS: &[(&str, &str)] = &[
    ("wireframe.add.text", "Add a text element (body or heading style)"),
    ("wireframe.add.button", "Add a button element"),
    ("wireframe.add.input", "Add an input field element"),
    ("wireframe.add.image", "Add an image placeholder frame"),
    ("wireframe.add.icon", "Add an icon from the curated set"),
    ("wireframe.add.card", "Add a card/container element"),
    (
        "wireframe.add.section",
        "Add a site frame section (header, nav bar, sidebar, footer)",
    ),
    ("wireframe.add.shape", "Add a basic shape"),
    ("wireframe.add.line", "Add a line"),
    ("wireframe.element.duplicate", "Duplicate the selected element"),
    ("wireframe.element.delete", "Delete the selected element"),
    ("wireframe.element.toggleLock", "Lock or unlock the selected element"),
    ("wireframe.edit.undo", "Undo the last change"),
    ("wireframe.edit.redo", "Redo the last undone change"),
    ("wireframe.zoom.in", "Zoom in"),
    ("wireframe.zoom.out", "Zoom out"),
    ("wireframe.view.fitPage", "Fit the page to the screen"),
    ("wireframe.view.resetView", "Reset to 100% and centre the page"),
    ("wireframe.view.togglePan", "Toggle the pan tool"),
    ("wireframe.file.saveAs", "Save the document to a new file"),
    ("wireframe.file.open", "Open a saved wireframe document"),
    ("wireframe.file.exportPng", "Export the page as a PNG"),
    ("wireframe.document.new", "Start a new empty wireframe"),
    (
        "wireframe.companion.listActions",
        "List the Wireframe actions with ids and descriptions",
    ),
    (
        "wireframe.companion.draftApp",
        "Draft a starter wireframe for a named app (app_name, optional summary)",
    ),
];

/// Every catalog id, joined by `", "`, in catalog order.
pub fn wireframe_action_ids() -> String {
    WIREFRAME_ACTIONS
        .iter()
        .map(|(id, _)| *id)
        .collect::<Vec<_>>()
        .join(", ")
}

/// The capability sentence offered to the model, ending with the id list.
///
/// Ids (not descriptions) keep the offer compact; the list reply carries the
/// human descriptions (R-6.1).
pub fn wireframe_skill_description() -> String {
    format!(
        "Control the Fredo Wireframe app: list its actions, run one action, or draft a starter wireframe for a named app. Use ONLY for an explicit Wireframe request. Actions: {}.",
        wireframe_action_ids()
    )
}

/// The declared input contract: `action` is required and non-empty; `app_name`
/// and `summary` are optional strings (any other key fails closed in
/// [`validate`](super::skills::validate)).
pub fn wireframe_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": { "type": "string" },
            "app_name": { "type": "string" },
            "summary": { "type": "string" }
        },
        "required": ["action"]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_binding_names_are_pinned() {
        assert_eq!(WIREFRAME_SKILL, "wireframe");
        assert_eq!(WIREFRAME_ACTION_ARG, "action");
        assert_eq!(WIREFRAME_APP_NAME_ARG, "app_name");
        assert_eq!(WIREFRAME_SUMMARY_ARG, "summary");
    }

    #[test]
    fn the_catalog_has_the_25_c4_actions_in_order_with_unique_ids() {
        assert_eq!(WIREFRAME_ACTIONS.len(), 25);
        let ids: Vec<&str> = WIREFRAME_ACTIONS.iter().map(|(id, _)| *id).collect();
        let mut unique = ids.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), ids.len(), "catalog ids must be unique");

        assert_eq!(ids.first().copied(), Some("wireframe.add.text"));
        assert_eq!(ids.last().copied(), Some("wireframe.companion.draftApp"));
        for id in &ids {
            assert!(id.starts_with("wireframe."), "unexpected id {id}");
        }
        assert!(WIREFRAME_ACTIONS
            .iter()
            .all(|(_, description)| !description.trim().is_empty()));
    }

    #[test]
    fn the_description_names_the_capability_and_every_action_id() {
        let description = wireframe_skill_description();
        assert!(description.contains("Fredo Wireframe"));
        for (id, _) in WIREFRAME_ACTIONS {
            assert!(description.contains(id), "description is missing {id}");
        }
    }

    #[test]
    fn the_parameters_declare_action_required_and_three_string_arguments() {
        let parameters = wireframe_parameters();
        assert_eq!(parameters["type"], "object");
        assert_eq!(parameters["required"], json!(["action"]));

        let properties = parameters["properties"]
            .as_object()
            .expect("properties object");
        let mut keys: Vec<&str> = properties.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["action", "app_name", "summary"]);
        for key in keys {
            assert_eq!(properties[key]["type"], "string");
        }
    }
}
