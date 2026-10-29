//! Durable companion-offer suite (Spec #3099, ST-4).
//!
//! Two contracts are pinned here so a refactor cannot silently drift them:
//!
//! 1. **The golden fixture is the ONE shared truth.** The SAME
//!    `apps/ui/src/shared/companion/fixtures/wireframe.companion.golden.json` the
//!    TypeScript suite asserts is deserialized at compile time, run through the
//!    REAL Rust builder, and rendered by the REAL `render_tools`, so the generated
//!    `wireframe` tool must equal the fixture's `offer` verbatim.
//! 2. **Zero drift on the shipped static skills.** The first three rendered tools
//!    deep-equal `fixture.staticOffer` (name + description + parameters, in order)
//!    and still fail closed through the ONE `validate` rule — a durable assertion
//!    instead of a `git diff` reading.
//!
//! The published-surface registry contract is exercised too: read-after-publish
//! equality, the full rejection matrix (registry byte-identical after EVERY
//! `Err`), bounds, empty-publish NO-OP, zero-command skip, and removed-id
//! disappearance after a same-app re-publish.

use serde::Deserialize;
use serde_json::{json, Value};

use fredo_lib::infrastructure::companion::skills::{
    validate, SkillRegistry, SkillValidationError,
};
use fredo_lib::infrastructure::companion::surface_registry::{
    build_companion_skill_registry, surface_skill, AppCommandSurfaceRegistry,
    CompanionCommandArgManifest, CompanionCommandManifest, CompanionManifest,
    CompanionSurfaceManifest, APP_COMMAND_SURFACE_MAX_COMMANDS, APP_COMMAND_SURFACE_MAX_SURFACES,
    COMPANION_LIST_ACTIONS_ID, RESERVED_SKILL_NAMES,
};
use fredo_lib::render_companion_tools;

/// The ONE shared golden fixture (authored by the TypeScript builder, Spec #3099
/// ST-2/ST-3). `CARGO_MANIFEST_DIR` is `apps/tauri/src-tauri`, so `../../ui` is
/// `apps/ui`.
const GOLDEN_FIXTURE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../ui/src/shared/companion/fixtures/wireframe.companion.golden.json"
));

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenFixture {
    static_offer: Vec<Value>,
    manifest: CompanionManifest,
    offer: Value,
}

fn fixture() -> GoldenFixture {
    serde_json::from_str(GOLDEN_FIXTURE).expect("the shared golden fixture parses")
}

fn command(id: &str) -> CompanionCommandManifest {
    CompanionCommandManifest {
        id: id.to_string(),
        label: "Label".to_string(),
        description: format!("Do {id}"),
        args: Vec::new(),
    }
}

fn surface(app_id: &str) -> CompanionSurfaceManifest {
    CompanionSurfaceManifest {
        app_id: app_id.to_string(),
        app_name: app_id.to_string(),
        skill_name: app_id.to_string(),
        description: "A capability sentence.".to_string(),
        list_label: None,
        commands: vec![
            command(&format!("{app_id}.one")),
            command(&format!("{app_id}.two")),
        ],
    }
}

fn manifest(surfaces: Vec<CompanionSurfaceManifest>) -> CompanionManifest {
    CompanionManifest { surfaces }
}

/// One-key arguments object (the key is runtime-chosen, so it cannot use the
/// `json!` key syntax).
fn with_argument(argument: &str, value: Value) -> Value {
    let mut object = serde_json::Map::new();
    object.insert(argument.to_string(), value);
    Value::Object(object)
}

fn read(registry: &AppCommandSurfaceRegistry) -> CompanionManifest {
    CompanionManifest {
        surfaces: registry.surfaces(),
    }
}

fn tool_names(registry: &SkillRegistry) -> Vec<String> {
    registry.list().map(|skill| skill.name.clone()).collect()
}

fn action_enum(registry: &SkillRegistry, skill: &str) -> Vec<String> {
    registry
        .get(skill)
        .expect("the skill is offered")
        .parameters["properties"]["action"]["enum"]
        .as_array()
        .expect("the action enum is an array")
        .iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect()
}

// ── 1. The golden fixture drives the REAL renderer ────────────────────────────

#[test]
fn the_rendered_offer_matches_the_shared_golden_fixture_verbatim() {
    let fixture = fixture();
    let registry = build_companion_skill_registry(&fixture.manifest.surfaces);
    let tools = render_companion_tools(&registry);
    let tools = tools.as_array().expect("the offer renders a tools array");

    assert_eq!(tools.len(), 4, "three static skills then the wireframe surface");
    assert_eq!(
        tools[3],
        json!({ "type": "function", "function": fixture.offer }),
        "the generated wireframe tool must equal the fixture's offer"
    );

    // Explicit sub-contract assertions (the values the dispatcher relies on).
    let function = &tools[3]["function"];
    assert_eq!(function["name"], fixture.offer["name"]);
    assert_eq!(function["description"], fixture.offer["description"]);
    assert_eq!(function["parameters"], fixture.offer["parameters"]);

    let parameters = &function["parameters"];
    assert_eq!(parameters["required"], json!(["action"]));
    assert_eq!(
        parameters["properties"]["arguments"],
        json!({ "type": "object" }),
        "arguments stays an OPEN object (its keys are validated by the app)"
    );
    let offered: Vec<&str> = parameters["properties"]["action"]["enum"]
        .as_array()
        .expect("the action enum is an array")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let expected: Vec<&str> = fixture.manifest.surfaces[0]
        .commands
        .iter()
        .map(|command| command.id.as_str())
        .chain(std::iter::once(COMPANION_LIST_ACTIONS_ID))
        .collect();
    assert_eq!(
        offered, expected,
        "every published id in declaration order, then the synthetic listActions"
    );
    assert_eq!(
        offered.last().copied(),
        Some(COMPANION_LIST_ACTIONS_ID),
        "the generated enum always ends with listActions"
    );

    // The generated description is exactly the documented format.
    let expected_description = format!(
        "{} Actions: {}.",
        fixture.manifest.surfaces[0].description,
        expected.join(", ")
    );
    assert_eq!(function["description"], expected_description.as_str());
}

// ── 2. Zero drift on the shipped static skills (D5) ───────────────────────────

#[test]
fn static_skills_are_byte_identical_to_the_pre_change_baseline() {
    let fixture = fixture();
    let registry = build_companion_skill_registry(&fixture.manifest.surfaces);
    let tools = render_companion_tools(&registry);
    let tools = tools.as_array().expect("the offer renders a tools array");

    assert_eq!(fixture.static_offer.len(), 3, "the baseline has three static skills");
    for (index, expected) in fixture.static_offer.iter().enumerate() {
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

// ── 3. The published-surface registry contract ───────────────────────────────

/// Spec #3099 fix round 2 (AC4): an absent optional must be an ABSENT key on the
/// wire, never `null`. The published TS types declare `listLabel?: string` and
/// `description?: string`, the TS builder OMITS them, and the shared golden
/// fixture omits them — so the serializer must match that contract. Before this
/// fix `app_command_surfaces()` emitted `"listLabel": null` and the list
/// formatter (`null.trim()`) threw, leaving the turn unanswered.
#[test]
fn the_published_wire_omits_absent_optionals_instead_of_emitting_null() {
    // The shared golden fixture IS the published wire shape: re-serializing the
    // deserialized manifest must reproduce its `manifest` object verbatim.
    let fixture = fixture();
    let raw: Value = serde_json::from_str(GOLDEN_FIXTURE).expect("the fixture parses as JSON");
    assert_eq!(
        serde_json::to_value(&fixture.manifest).expect("the manifest serializes"),
        raw["manifest"],
        "the serialized manifest must equal the fixture's `manifest` verbatim \
         (an absent optional is an ABSENT key, never `null`)"
    );

    // `list_label: None` => no `listLabel` key at all.
    let absent = surface("alpha");
    assert!(absent.list_label.is_none(), "the helper surface declares no override");
    let wire = serde_json::to_value(&absent).expect("the surface serializes");
    assert!(
        !wire
            .as_object()
            .expect("the surface is an object")
            .contains_key("listLabel"),
        "an absent listLabel must be omitted, not serialized as `null`"
    );

    // A declared override must survive with its value intact.
    let mut present = surface("alpha");
    present.list_label = Some("Alpha capabilities".to_string());
    let wire = serde_json::to_value(&present).expect("the surface serializes");
    assert_eq!(
        wire["listLabel"], "Alpha capabilities",
        "a present listLabel must still be serialized"
    );

    // The identical rule for a declared argument's optional `description`.
    let mut with_args = surface("alpha");
    with_args.commands[0].args = vec![
        CompanionCommandArgManifest {
            name: "bare".to_string(),
            required: true,
            description: None,
        },
        CompanionCommandArgManifest {
            name: "documented".to_string(),
            required: false,
            description: Some("A human/model note.".to_string()),
        },
    ];
    let wire = serde_json::to_value(&with_args).expect("the surface serializes");
    let args = wire["commands"][0]["args"]
        .as_array()
        .expect("the command carries an args array");
    assert!(
        !args[0]
            .as_object()
            .expect("the argument is an object")
            .contains_key("description"),
        "an absent arg description must be omitted, not serialized as `null`"
    );
    assert_eq!(
        args[1]["description"], "A human/model note.",
        "a present arg description must still be serialized"
    );
}

#[test]
fn a_published_manifest_reads_back_exactly_and_an_empty_publish_is_a_no_op() {
    let registry = AppCommandSurfaceRegistry::new();
    assert_eq!(read(&registry), manifest(Vec::new()), "a fresh registry is empty");

    let published = manifest(vec![surface("alpha"), surface("beta")]);
    registry
        .publish(published.clone())
        .expect("a valid publish is accepted");
    assert_eq!(
        read(&registry),
        published,
        "the read returns exactly what publish stored"
    );

    registry
        .publish(manifest(Vec::new()))
        .expect("an empty publish is accepted");
    assert_eq!(
        read(&registry),
        published,
        "an empty publish is a NO-OP, never a registry clear"
    );
}

#[test]
fn an_upsert_replaces_in_place_and_leaves_other_apps_untouched() {
    let registry = AppCommandSurfaceRegistry::new();
    registry
        .publish(manifest(vec![surface("alpha"), surface("beta")]))
        .expect("a valid publish is accepted");

    let mut replacement = surface("alpha");
    replacement.commands = vec![command("alpha.replaced")];
    registry
        .publish(manifest(vec![replacement]))
        .expect("the same-app re-publish is accepted");

    let current = read(&registry);
    let app_ids: Vec<&str> = current.surfaces.iter().map(|s| s.app_id.as_str()).collect();
    assert_eq!(app_ids, vec!["alpha", "beta"], "insertion order is preserved");
    assert_eq!(current.surfaces[0].commands.len(), 1);
    assert_eq!(current.surfaces[0].commands[0].id, "alpha.replaced");
    assert_eq!(current.surfaces[1], surface("beta"), "beta is untouched");
}

/// Every rejection case asserts the registry is BYTE-IDENTICAL afterwards.
fn assert_rejected_without_mutation(candidate: CompanionManifest) {
    let registry = AppCommandSurfaceRegistry::new();
    registry
        .publish(manifest(vec![surface("alpha")]))
        .expect("the baseline publish is valid");
    let before = read(&registry);

    assert!(
        registry.publish(candidate).is_err(),
        "the candidate publish must be rejected"
    );
    assert_eq!(
        read(&registry),
        before,
        "a rejected publish must leave the previous registry intact"
    );
}

#[test]
fn the_rejection_matrix_leaves_the_registry_untouched() {
    // skillName != appId (one identity, no alias).
    let mut renamed = surface("alpha");
    renamed.skill_name = "beta".to_string();
    assert_rejected_without_mutation(manifest(vec![renamed]));

    // Every reserved static skill name, plus the synthetic listActions id.
    for reserved in RESERVED_SKILL_NAMES {
        let mut candidate = surface(reserved);
        candidate.skill_name = reserved.to_string();
        assert_rejected_without_mutation(manifest(vec![candidate]));
    }
    let mut list_actions = surface(COMPANION_LIST_ACTIONS_ID);
    list_actions.skill_name = COMPANION_LIST_ACTIONS_ID.to_string();
    assert_rejected_without_mutation(manifest(vec![list_actions]));

    // Duplicate appId within ONE publish.
    assert_rejected_without_mutation(manifest(vec![surface("alpha"), surface("alpha")]));

    // Duplicate command ids within one surface.
    let mut duplicate_commands = surface("alpha");
    duplicate_commands.commands = vec![command("alpha.one"), command("alpha.one")];
    assert_rejected_without_mutation(manifest(vec![duplicate_commands]));

    // Every blank identity / description.
    let mut blank_app_id = surface("alpha");
    blank_app_id.app_id = "   ".to_string();
    assert_rejected_without_mutation(manifest(vec![blank_app_id]));

    let mut blank_app_name = surface("alpha");
    blank_app_name.app_name = String::new();
    assert_rejected_without_mutation(manifest(vec![blank_app_name]));

    let mut blank_skill_name = surface("alpha");
    blank_skill_name.skill_name = "\t".to_string();
    assert_rejected_without_mutation(manifest(vec![blank_skill_name]));

    let mut blank_surface_description = surface("alpha");
    blank_surface_description.description = "  ".to_string();
    assert_rejected_without_mutation(manifest(vec![blank_surface_description]));

    let mut blank_command_id = surface("alpha");
    blank_command_id.commands[0].id = String::new();
    assert_rejected_without_mutation(manifest(vec![blank_command_id]));

    let mut blank_command_description = surface("alpha");
    blank_command_description.commands[0].description = "   ".to_string();
    assert_rejected_without_mutation(manifest(vec![blank_command_description]));
}

#[test]
fn the_registry_bounds_are_enforced_atomically() {
    let over_surface_bound: Vec<CompanionSurfaceManifest> = (0..=APP_COMMAND_SURFACE_MAX_SURFACES)
        .map(|index| surface(&format!("app{index}")))
        .collect();
    assert_rejected_without_mutation(manifest(over_surface_bound));

    let mut over_command_bound = surface("alpha");
    over_command_bound.commands = (0..=APP_COMMAND_SURFACE_MAX_COMMANDS)
        .map(|index| command(&format!("alpha.{index}")))
        .collect();
    assert_rejected_without_mutation(manifest(vec![over_command_bound]));

    // Exactly at each bound is accepted.
    let registry = AppCommandSurfaceRegistry::new();
    let at_surface_bound: Vec<CompanionSurfaceManifest> = (0..APP_COMMAND_SURFACE_MAX_SURFACES)
        .map(|index| surface(&format!("app{index}")))
        .collect();
    registry
        .publish(manifest(at_surface_bound))
        .expect("the surface bound itself is accepted");

    let mut at_command_bound = surface("alpha");
    at_command_bound.commands = (0..APP_COMMAND_SURFACE_MAX_COMMANDS)
        .map(|index| command(&format!("alpha.{index}")))
        .collect();
    let command_registry = AppCommandSurfaceRegistry::new();
    command_registry
        .publish(manifest(vec![at_command_bound]))
        .expect("the command bound itself is accepted");
    assert_eq!(
        read(&command_registry).surfaces[0].commands.len(),
        APP_COMMAND_SURFACE_MAX_COMMANDS
    );
}

#[test]
fn a_zero_command_surface_generates_no_skill_but_stays_published() {
    let registry = AppCommandSurfaceRegistry::new();
    let mut empty = surface("empty");
    empty.commands.clear();
    registry
        .publish(manifest(vec![empty]))
        .expect("a zero-command surface is still a valid publish");

    assert_eq!(
        registry.surfaces()[0].commands.len(),
        0,
        "the surface stays in the registry"
    );
    assert_eq!(
        tool_names(&build_companion_skill_registry(&registry.surfaces())),
        vec!["open_app", "close_app", "doom_mode"],
        "a surface with nothing to offer adds no generated skill"
    );
}

#[test]
fn a_removed_id_disappears_from_the_next_offer_after_a_same_app_republish() {
    let registry = AppCommandSurfaceRegistry::new();
    registry
        .publish(manifest(vec![surface("wireframe")]))
        .expect("the first publish is valid");
    let first = build_companion_skill_registry(&registry.surfaces());
    assert_eq!(
        action_enum(&first, "wireframe"),
        vec!["wireframe.one", "wireframe.two", COMPANION_LIST_ACTIONS_ID]
    );

    let mut smaller = surface("wireframe");
    smaller.commands = vec![command("wireframe.one")];
    registry
        .publish(manifest(vec![smaller]))
        .expect("the smaller re-publish is valid");

    let next = build_companion_skill_registry(&registry.surfaces());
    let offered = action_enum(&next, "wireframe");
    assert_eq!(offered, vec!["wireframe.one", COMPANION_LIST_ACTIONS_ID]);
    assert!(
        !offered.contains(&"wireframe.two".to_string()),
        "the removed id must not be offered on the next turn"
    );

    // The generated description follows the next offer too.
    let generated = surface_skill(&registry.surfaces()[0]);
    assert_eq!(
        generated.description,
        "A capability sentence. Actions: wireframe.one, listActions."
    );
}
