//! Durable companion-offer suite (Spec #3152, ST-1).
//!
//! The Rust companion command-surface path is gone (Spec #3152): the model is
//! offered the three shipped static skills and nothing generated. Two contracts
//! are pinned here so a refactor cannot silently drift them:
//!
//! 1. **The rendered offer is exactly the three static skills.** Built from the
//!    public [`SkillRegistry::with_app_control_and_doom`] and rendered through the
//!    committed `render_companion_tools` seam (`lib.rs`), the `tools` array has
//!    exactly three elements, in offer order, each carrying the OpenAI-style
//!    `{type, function:{name, description, parameters}}` shape — and no function
//!    is named after an application.
//! 2. **Zero drift on the shipped static skills.** The three rendered tools
//!    deep-equal their pre-change baseline (name + description + parameters, in
//!    order) and still fail closed through the ONE `validate` rule — a durable
//!    assertion instead of a `git diff` reading.
//!
//! This target is a SEPARATE CRATE, so it can only reach the public
//! `SkillRegistry::with_app_control_and_doom()` constructor — not the
//! `pub(crate)` turn-path accessor. The turn path's own accessor is pinned by the
//! `applications::llm_server::status` unit test
//! `the_turn_offer_is_exactly_the_three_static_skills`.

use serde_json::{json, Value};

use fredo_lib::infrastructure::companion::skills::{
    validate, SkillRegistry, SkillValidationError,
};
use fredo_lib::render_companion_tools;

/// One-key arguments object (the key is runtime-chosen, so it cannot use the
/// `json!` key syntax).
fn with_argument(argument: &str, value: Value) -> Value {
    let mut object = serde_json::Map::new();
    object.insert(argument.to_string(), value);
    Value::Object(object)
}

/// The offered `function.name` values, in offer order.
fn offer_names(tools: &[Value]) -> Vec<&str> {
    tools
        .iter()
        .filter_map(|tool| tool["function"]["name"].as_str())
        .collect()
}

// ── 1. The rendered offer is exactly the three static skills ──────────────────

#[test]
fn the_rendered_offer_carries_only_the_three_static_skills() {
    let registry = SkillRegistry::with_app_control_and_doom();
    let tools = render_companion_tools(&registry);
    let tools = tools.as_array().expect("the offer renders a tools array");

    assert_eq!(tools.len(), 3, "exactly the three shipped static skills");
    assert_eq!(
        offer_names(tools),
        vec!["open_app", "close_app", "doom_mode"],
        "the rendered offer is the three static skills, in offer order"
    );

    // Every element keeps the shipped OpenAI-style tools shape.
    for tool in tools {
        assert_eq!(tool["type"], "function");
        assert!(
            tool["function"]["name"].is_string(),
            "every function declares a name: {tool}"
        );
        assert!(
            tool["function"]["description"].is_string(),
            "every function declares a description: {tool}"
        );
        assert!(
            tool["function"]["parameters"].is_object(),
            "every function declares a parameters object: {tool}"
        );
    }

    // No function is named after an application: the offer is not generated.
    for application in ["wireframe", "mission-monitor", "terminal", "database-client"] {
        assert!(
            registry.get(application).is_none(),
            "no application-named skill is offered: {application}"
        );
    }

    // The declared contracts survive verbatim.
    let open_app = &tools[0]["function"]["parameters"];
    assert_eq!(open_app["type"], "object");
    assert_eq!(open_app["required"], json!(["app"]));
    let close_app = &tools[1]["function"]["parameters"];
    assert_eq!(close_app["type"], "object");
    assert_eq!(close_app["required"], json!(["app"]));
    let doom_mode = &tools[2]["function"]["parameters"];
    assert_eq!(doom_mode["type"], "object");
    assert_eq!(doom_mode["required"], json!(["action"]));
}

// ── 2. Zero drift on the shipped static skills (D5) ───────────────────────────

/// The pre-change baseline of the three shipped static skills, captured as
/// literals (the shared TS golden fixture that used to carry this block was
/// retired with the frontend verb-manifest bridge in Spec #3151; the Rust
/// declarations are unchanged, so the baseline belongs here).
fn static_skill_baseline() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "open_app",
                "description": "Open a Fredo desktop app/application by the name the user said. Use ONLY for an explicit open request.",
                "parameters": {
                    "type": "object",
                    "properties": { "app": { "type": "string" } },
                    "required": ["app"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "close_app",
                "description": "Close an open Fredo desktop app/application by the name the user said. Use ONLY for an explicit close request.",
                "parameters": {
                    "type": "object",
                    "properties": { "app": { "type": "string" } },
                    "required": ["app"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "doom_mode",
                "description": "Use ONLY when the user explicitly asks Fredo to enter or leave Doom Mode.",
                "parameters": {
                    "type": "object",
                    "properties": { "action": { "type": "string" } },
                    "required": ["action"]
                }
            }
        }),
    ]
}

#[test]
fn static_skills_are_byte_identical_to_the_pre_change_baseline() {
    let baseline = static_skill_baseline();
    let registry = SkillRegistry::with_app_control_and_doom();
    let tools = render_companion_tools(&registry);
    let tools = tools.as_array().expect("the offer renders a tools array");

    assert_eq!(baseline.len(), 3, "the baseline has three static skills");
    for (index, expected) in baseline.iter().enumerate() {
        assert_eq!(
            &tools[index], expected,
            "static skill #{index} drifted from the pre-change baseline (name/description/parameters/order)"
        );
    }

    // The ONE validation rule still fails closed on each static skill.
    for (skill, argument) in [
        ("open_app", "app"),
        ("close_app", "app"),
        ("doom_mode", "action"),
    ] {
        assert_eq!(
            validate(&registry, skill, &json!({})),
            Err(SkillValidationError::MissingArgument(argument.to_string())),
            "{skill} must reject a missing required argument"
        );
        assert_eq!(
            validate(&registry, skill, &with_argument(argument, json!("   "))),
            Err(SkillValidationError::InvalidArgument(format!(
                "argument '{argument}' must not be empty"
            ))),
            "{skill} must reject a blank argument"
        );
        assert_eq!(
            validate(&registry, skill, &with_argument(argument, json!(42))),
            Err(SkillValidationError::InvalidArgument(format!(
                "argument '{argument}' must be a string"
            ))),
            "{skill} must reject a non-string argument"
        );
        let mut undeclared = with_argument(argument, json!("ok"));
        undeclared["force"] = json!(true);
        assert_eq!(
            validate(&registry, skill, &undeclared),
            Err(SkillValidationError::InvalidArgument(
                "unexpected argument 'force'".to_string()
            )),
            "{skill} must reject an undeclared argument key"
        );
    }
}
