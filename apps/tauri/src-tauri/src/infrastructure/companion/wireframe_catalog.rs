//! Wireframe companion catalog (Spec #3070, ST-7, C4).
//!
//! The ONE declaration of the `wireframe` skill: its name, its three declared
//! arguments and the 35-action catalog. The action ids + descriptions are
//! mirrored **character-for-character** from the frontend command table
//! (`apps/ui/src/applications/wireframe/actions/wireframeActions.ts`,
//! `WIREFRAME_ACTIONS`); the TS parity pin
//! (`__tests__/companionCatalog.parity.test.ts`) reads this source and asserts
//! the two lists are equal.
//!
//! Why one skill with an `action` argument (C4): the shipped registry validates
//! one JSON object per skill (`skills.rs`), so 35 declarations would mean 35
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
/// The first 22 rows are also the Slice-1 toolbar/hotkey command table; the 10
/// arrangement rows that follow them carry the two-step `g+` binding (Spec
/// #3071, ST-4); the last three are the document command plus the two
/// Companion-only commands.
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
    // ── Arrange (Spec #3071, ST-4) — the `g` namespace, all two-step ─────────
    ("wireframe.arrange.group", "Group the selected elements"),
    ("wireframe.arrange.ungroup", "Ungroup the selected group"),
    ("wireframe.arrange.toggleGroupLock", "Lock or unlock the selected group"),
    ("wireframe.arrange.toggleSnap", "Toggle snap to grid"),
    ("wireframe.arrange.alignLeft", "Align the selected elements to the left"),
    ("wireframe.arrange.alignCenter", "Align the selected elements to the centre"),
    ("wireframe.arrange.alignRight", "Align the selected elements to the right"),
    ("wireframe.arrange.distribute", "Distribute the selected elements with equal gaps"),
    ("wireframe.arrange.bringForward", "Bring the selected elements forward"),
    ("wireframe.arrange.sendBackward", "Send the selected elements backward"),
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
/// A DIRECTIVE, not a passive capability sentence (Spec #3070, ST-7b / F-47):
/// round 2's wording described what the app can do but never told the model
/// WHEN to call the skill, and the live model answered the binding request
/// ("let's create a new wireframe for our new Reporter app…") with prose and
/// zero actions. The offer now names the request class — "create, draft,
/// sketch, mock up or visualize" an app/screen/page/dashboard — and the action
/// that satisfies it (`wireframe.companion.draftApp` with `app_name`), so the
/// routing hint travels with the tool declaration itself.
///
/// Ids (not descriptions) keep the offer compact; the list reply carries the
/// human descriptions (R-6.1).
pub fn wireframe_skill_description() -> String {
    format!(
        "Create or edit a wireframe in the Fredo Wireframe app. Call this whenever the user asks to create, draft, sketch, mock up or visualize an app/screen/page/dashboard — including \"let's create a new wireframe for <app>\" or \"I would like a way to visualize <thing>\": use action=wireframe.companion.draftApp with app_name set to the app the user named, then the page is drafted for you. Use ONLY for Wireframe requests. Actions: {}.",
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
    fn the_catalog_has_the_35_c4_actions_in_order_with_unique_ids() {
        assert_eq!(WIREFRAME_ACTIONS.len(), 35);
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
        // A DIRECTIVE, not a passive capability sentence (ST-7b / F-47): the
        // offer must name the REQUEST CLASS the model has to recognise — a live
        // model that only reads "Control the app: list, run, or draft" answers
        // in prose. `sketch` + `visualize` are the words the round-2 wording
        // lacked, so this pin fails on it.
        for word in ["create", "draft", "sketch", "visualize"] {
            assert!(
                description.contains(word),
                "the description must name the request class ({word}): {description}"
            );
        }
        assert!(
            description.contains("wireframe.companion.draftApp"),
            "the description must name the draft action: {description}"
        );
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
