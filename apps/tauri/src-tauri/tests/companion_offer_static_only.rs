//! Durable companion-offer suite (Spec #3152 ST-1; re-cut to FOUR by Spec
//! #3243 ST-3).
//!
//! The Rust companion command-surface path is still gone (Spec #3152): the model
//! is offered STATIC skills and nothing generated. Spec #3243 added exactly one
//! more static skill (`order`), so two contracts are pinned here so a refactor
//! cannot silently drift them:
//!
//! 1. **The rendered offer is exactly the FOUR static skills.** Built from the
//!    public [`SkillRegistry::with_order_support`] and rendered through the
//!    committed `render_companion_tools` seam (`lib.rs`), the `tools` array has
//!    exactly four elements, in offer order, each carrying the OpenAI-style
//!    `{type, function:{name, description, parameters}}` shape — and no function
//!    is named after an application.
//! 2. **Zero drift on the three shipped static skills.** The three rendered
//!    tools deep-equal their pre-change baseline (name + description +
//!    parameters, in order) and still fail closed through the ONE `validate`
//!    rule — a durable assertion instead of a `git diff` reading. The fourth
//!    entry is the CLOSED `order` schema (AC-7's offer-side construction).
//!
//! This target is a SEPARATE CRATE, so it can only reach the public
//! `SkillRegistry::with_order_support()` constructor — not the `pub(crate)`
//! turn-path accessor. The turn path's own accessor is pinned by the
//! `applications::llm_server::status` unit test
//! `the_turn_offer_is_exactly_the_four_static_skills`.

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

// ── 1. The rendered offer is exactly the four static skills ──────────────────

#[test]
fn the_rendered_offer_carries_only_the_four_static_skills() {
    let registry = SkillRegistry::with_order_support();
    let tools = render_companion_tools(&registry);
    let tools = tools.as_array().expect("the offer renders a tools array");

    assert_eq!(tools.len(), 4, "exactly the four static skills");
    assert_eq!(
        offer_names(tools),
        vec!["open_app", "close_app", "doom_mode", "order"],
        "the rendered offer is the four static skills, in offer order"
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

    // The fourth entry is CLOSED at exactly `action` + `arguments` — exact set
    // equality, never a containment check (AC-7's offer-side construction).
    let order = &tools[3]["function"]["parameters"];
    assert_eq!(order["type"], "object");
    assert_eq!(order["required"], json!(["action"]));
    let properties = order["properties"]
        .as_object()
        .expect("the `order` schema declares an object of properties");
    let mut names: Vec<&str> = properties.keys().map(String::as_str).collect();
    names.sort_unstable();
    assert_eq!(
        names,
        vec!["action", "arguments"],
        "the offered `order` schema declares exactly action + arguments"
    );
    assert_eq!(order["properties"]["action"]["type"], "string");
    assert_eq!(order["properties"]["arguments"]["type"], "object");
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
    let registry = SkillRegistry::with_order_support();
    let tools = render_companion_tools(&registry);
    let tools = tools.as_array().expect("the offer renders a tools array");

    assert_eq!(baseline.len(), 3, "the baseline has three static skills");
    assert!(
        tools.len() > baseline.len(),
        "the widened offer still carries the three shipped skills plus `order`"
    );
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

// ── 3. The fourth skill validates through the SAME one rule ───────────────────

/// Spec #3243 ST-3 — the `order` skill is a static declaration exactly like the
/// shipped three, so it validates through the ONE [`validate`] rule and refuses
/// every shape it does not declare.
///
/// The negative half is AC-7's practical consequence: a confirmation-shaped
/// argument (`confirmed`, `approved`, `grant`) is an UNDECLARED key, so it is
/// refused outright rather than travelling into the dispatcher.
#[test]
fn the_order_skill_validates_through_the_one_shared_rule() {
    let registry = SkillRegistry::with_order_support();

    let invocation = validate(
        &registry,
        "order",
        &json!({ "action": "wireframe.element.fill", "arguments": { "fill": "#00ff00" } }),
    )
    .expect("a declared action with arguments is valid");
    assert_eq!(invocation.skill, "order");
    assert_eq!(
        invocation.arguments,
        json!({ "action": "wireframe.element.fill", "arguments": { "fill": "#00ff00" } })
    );

    // A missing / blank / non-string `action` fails closed.
    assert_eq!(
        validate(&registry, "order", &json!({})),
        Err(SkillValidationError::MissingArgument("action".to_string()))
    );
    assert_eq!(
        validate(&registry, "order", &json!({ "action": "   " })),
        Err(SkillValidationError::InvalidArgument(
            "argument 'action' must not be empty".to_string()
        ))
    );
    assert_eq!(
        validate(&registry, "order", &json!({ "action": 42 })),
        Err(SkillValidationError::InvalidArgument(
            "argument 'action' must be a string".to_string()
        ))
    );

    // AC-7: a confirmation-shaped argument is undeclared, so it never reaches
    // the dispatcher as something that could authorise the action.
    for argument in ["confirmed", "approved", "grant"] {
        let mut selection = with_argument("action", json!("wireframe.element.fill"));
        selection[argument] = json!(true);
        assert_eq!(
            validate(&registry, "order", &selection),
            Err(SkillValidationError::InvalidArgument(format!(
                "unexpected argument '{argument}'"
            ))),
            "a `{argument}` argument must be refused — the model cannot confirm its own action"
        );
    }

    // `arguments` is declared, so a nested key inside it is legal (the model
    // still cannot mint a grant: writing is a UI event, not an argument).
    let nested = validate(
        &registry,
        "order",
        &json!({ "action": "wireframe.element.fill", "arguments": { "confirmed": true } }),
    )
    .expect("a nested `arguments` key is legal — it authorises nothing");
    assert_eq!(nested.arguments["arguments"]["confirmed"], json!(true));
}
