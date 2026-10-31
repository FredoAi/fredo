//! Application command surface registry + generated companion offer (Spec #3099, ST-4).
//!
//! The frontend publishes every application's command surface (Spec #3099, ST-2),
//! and this module stores those published manifests as managed host state:
//!
//! * [`AppCommandSurfaceRegistry`] holds one [`CompanionSurfaceManifest`] per
//!   `appId`, in first-publish order. A publish **upserts** by `appId` — the same
//!   application replaces its entry in place (its command list may shrink), and
//!   every other application is untouched. A publish is validated first and then
//!   written under one lock, so a rejected publish never leaves a partial write.
//! * [`app_command_surfaces`] is the READ-ONLY view of that SAME registry, so the
//!   frontend dispatcher and the `listActions` reply resolve a surface from the
//!   PUBLISHED state (never a local rebuild).
//! * [`surface_skill`] / [`build_companion_skill_registry`] generate the offer: the
//!   three shipped static skills (`open_app`, `close_app`, `doom_mode`, unchanged)
//!   followed by ONE skill per published surface with at least one command.
//!
//! Why one generated skill per surface (never per command): the offer stays
//! compact — one `action` enum carrying every published command id (plus the
//! synthetic `listActions`), and an open `arguments` object whose keys are
//! validated by the owning application. Deleting the hand-written catalog is
//! deliberate (R-5a/G-412): there is exactly ONE source of the action list — the
//! published manifest.
//!
//! Nothing here executes an application command: execution stays in the owning
//! application's frontend.

use std::collections::HashSet;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::skills::{CompanionSkill, SkillRegistry};

/// The synthetic action id appended to EVERY generated `action` enum. It is never
/// a real command: it asks the application to list its published actions.
pub const COMPANION_LIST_ACTIONS_ID: &str = "listActions";

/// Skill names owned by the shipped static declarations. A published surface may
/// never claim one of these (it would double-dispatch on the one
/// `llm-skill-call` channel).
pub const RESERVED_SKILL_NAMES: [&str; 3] = ["open_app", "close_app", "doom_mode"];

/// Upper bound on the surfaces one publish may carry.
pub const APP_COMMAND_SURFACE_MAX_SURFACES: usize = 32;

/// Upper bound on the commands one surface may declare.
pub const APP_COMMAND_SURFACE_MAX_COMMANDS: usize = 512;

/// One declared command argument (wire shape, camelCase). `description` is a
/// human/model note only — the argument CONTRACT is `name` + `required`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionCommandArgManifest {
    pub name: String,
    pub required: bool,
    /// An absent description is an ABSENT key on the wire (never `null`) — the
    /// published TS type declares it optional (`description?: string`), so the
    /// serializer must match that contract (Spec #3099 fix round 2).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// One published command (wire shape, camelCase).
///
/// Spec #3120 (P6), ST-2 — the declaration's `risk` and `aliases` cross the wire:
///
/// * `risk` is `None` (and therefore an ABSENT KEY) for a legacy `commandSurface`
///   command, and `Some(..)` for a navigation-declared command.
/// * `aliases` is an ABSENT KEY when empty (never `null`), matching the TS
///   optional-field contract (G-413).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionCommandManifest {
    pub id: String,
    pub label: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk: Option<String>,
    pub args: Vec<CompanionCommandArgManifest>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
}

/// One published application surface (wire shape, camelCase). `skill_name` is
/// pinned to `app_id` — one identity, no alias.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionSurfaceManifest {
    pub app_id: String,
    pub app_name: String,
    pub skill_name: String,
    pub description: String,
    /// An absent override is an ABSENT key on the wire (never `null`) — the
    /// published TS type declares it optional (`listLabel?: string`), and the
    /// shared golden fixture omits it. A `null` here crashed the list formatter
    /// (`null.trim()`), the round-1 AC4 defect (Spec #3099 fix round 2).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list_label: Option<String>,
    pub commands: Vec<CompanionCommandManifest>,
}

/// The payload of `register_app_command_surfaces` and the return value of
/// `app_command_surfaces` (wire shape, camelCase).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionManifest {
    pub surfaces: Vec<CompanionSurfaceManifest>,
}

/// The managed published-surface registry. Insertion-ordered and `appId`-keyed.
#[derive(Debug, Default)]
pub struct AppCommandSurfaceRegistry {
    surfaces: Mutex<Vec<CompanionSurfaceManifest>>,
}

impl AppCommandSurfaceRegistry {
    /// An empty registry (the three static skills are still offered).
    pub fn new() -> Self {
        Self::default()
    }

    /// Store the published surfaces, **upserting** each by `appId`.
    ///
    /// Everything is validated BEFORE the lock is taken and before any write, so
    /// `Err` leaves the registry byte-identical (fail-closed, no partial write).
    /// An incoming surface replaces its `appId` entry IN PLACE (the previous
    /// command list is dropped, so a removed id disappears from the next offer);
    /// a new `appId` is appended. An empty `surfaces` array is accepted as a
    /// NO-OP — it never clears the registry.
    pub fn publish(&self, manifest: CompanionManifest) -> Result<(), String> {
        let incoming = manifest.surfaces;
        if incoming.is_empty() {
            return Ok(());
        }
        validate_surfaces(&incoming)?;

        let mut surfaces = self
            .surfaces
            .lock()
            .map_err(|_| "the app command surface registry is unavailable".to_string())?;
        for surface in incoming {
            match surfaces
                .iter_mut()
                .find(|existing| existing.app_id == surface.app_id)
            {
                Some(existing) => *existing = surface,
                None => surfaces.push(surface),
            }
        }
        Ok(())
    }

    /// The current surfaces in insertion order (a clone: callers hold no lock).
    pub fn surfaces(&self) -> Vec<CompanionSurfaceManifest> {
        self.surfaces
            .lock()
            .map(|surfaces| surfaces.clone())
            .unwrap_or_default()
    }
}

fn is_blank(value: &str) -> bool {
    value.trim().is_empty()
}

/// Validate ONE publish in full. Any failure rejects the WHOLE publish.
fn validate_surfaces(surfaces: &[CompanionSurfaceManifest]) -> Result<(), String> {
    if surfaces.len() > APP_COMMAND_SURFACE_MAX_SURFACES {
        return Err(format!(
            "a publish may carry at most {APP_COMMAND_SURFACE_MAX_SURFACES} surfaces"
        ));
    }

    let mut app_ids: HashSet<&str> = HashSet::new();
    for surface in surfaces {
        if is_blank(&surface.app_id) {
            return Err("a published surface needs an app id".to_string());
        }
        if is_blank(&surface.app_name) {
            return Err(format!("surface '{}' needs an app name", surface.app_id));
        }
        if is_blank(&surface.skill_name) {
            return Err(format!("surface '{}' needs a skill name", surface.app_id));
        }
        if is_blank(&surface.description) {
            return Err(format!(
                "surface '{}' needs a capability description",
                surface.app_id
            ));
        }
        if surface.skill_name != surface.app_id {
            return Err(format!(
                "surface '{}' must publish under its own app id as the skill name",
                surface.app_id
            ));
        }
        if RESERVED_SKILL_NAMES.contains(&surface.skill_name.as_str())
            || surface.skill_name == COMPANION_LIST_ACTIONS_ID
        {
            return Err(format!(
                "skill name '{}' is reserved by the shipped static skills",
                surface.skill_name
            ));
        }
        if !app_ids.insert(surface.app_id.as_str()) {
            return Err(format!(
                "a publish may not declare app id '{}' twice",
                surface.app_id
            ));
        }
        if surface.commands.len() > APP_COMMAND_SURFACE_MAX_COMMANDS {
            return Err(format!(
                "surface '{}' may declare at most {APP_COMMAND_SURFACE_MAX_COMMANDS} commands",
                surface.app_id
            ));
        }

        let mut command_ids: HashSet<&str> = HashSet::new();
        for command in &surface.commands {
            if is_blank(&command.id) {
                return Err(format!(
                    "surface '{}' declares a command without an id",
                    surface.app_id
                ));
            }
            if is_blank(&command.description) {
                return Err(format!(
                    "command '{}' needs a capability description",
                    command.id
                ));
            }
            if !command_ids.insert(command.id.as_str()) {
                return Err(format!(
                    "surface '{}' declares command id '{}' twice",
                    surface.app_id, command.id
                ));
            }
        }
    }

    Ok(())
}

/// Adapt one published surface into a generated companion skill.
///
/// `description` is `<surface description> Actions: <ids in order>, listActions.`
/// and the parameters declare the ONE required `action` string (every command id
/// plus the synthetic `listActions`) plus an open `arguments` object.
pub fn surface_skill(surface: &CompanionSurfaceManifest) -> CompanionSkill {
    let ids: Vec<&str> = surface
        .commands
        .iter()
        .map(|command| command.id.as_str())
        .chain(std::iter::once(COMPANION_LIST_ACTIONS_ID))
        .collect();
    let description = format!("{} Actions: {}.", surface.description, ids.join(", "));
    let parameters = json!({
        "type": "object",
        "properties": {
            "action": { "type": "string", "enum": ids },
            "arguments": { "type": "object" }
        },
        "required": ["action"]
    });
    CompanionSkill::new(surface.skill_name.clone(), description, parameters)
}

/// Build the companion offer: the three shipped static skills FIRST (unchanged),
/// then one generated skill per surface in registration order. A surface with no
/// commands generates no skill (it has nothing to offer).
pub fn build_companion_skill_registry(surfaces: &[CompanionSurfaceManifest]) -> SkillRegistry {
    let mut registry = SkillRegistry::with_app_control_and_doom();
    for surface in surfaces.iter().filter(|surface| !surface.commands.is_empty()) {
        registry.register(surface_skill(surface));
    }
    registry
}

/// Persist a published manifest (upsert by `appId`). Fail-closed: `Err` means
/// nothing was written and the previous registry is intact.
#[tauri::command]
pub fn register_app_command_surfaces(
    state: tauri::State<'_, AppCommandSurfaceRegistry>,
    manifest: CompanionManifest,
) -> Result<(), String> {
    state.publish(manifest)
}

/// READ-ONLY view of the current registry. The dispatcher resolves a surface and
/// composes `listActions` from THIS read, so a publish from any webview is
/// immediately visible to the same validation path.
#[tauri::command]
pub fn app_command_surfaces(
    state: tauri::State<'_, AppCommandSurfaceRegistry>,
) -> CompanionManifest {
    CompanionManifest {
        surfaces: state.surfaces(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(id: &str) -> CompanionCommandManifest {
        CompanionCommandManifest {
            id: id.to_string(),
            label: "Label".to_string(),
            description: format!("Do {id}"),
            risk: None,
            args: Vec::new(),
            aliases: Vec::new(),
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

    fn skill_names(registry: &SkillRegistry) -> Vec<String> {
        registry.list().map(|skill| skill.name.clone()).collect()
    }

    fn action_enum(registry: &SkillRegistry, skill: &str) -> Vec<String> {
        registry
            .get(skill)
            .expect("generated skill is offered")
            .parameters["properties"]["action"]["enum"]
            .as_array()
            .expect("the action enum is an array")
            .iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect()
    }

    #[test]
    fn publishing_upserts_in_place_and_leaves_other_apps_untouched() {
        let registry = AppCommandSurfaceRegistry::new();
        registry
            .publish(manifest(vec![surface("alpha"), surface("beta")]))
            .expect("the first publish is valid");

        let mut replacement = surface("alpha");
        replacement.commands = vec![command("alpha.replaced")];
        registry
            .publish(manifest(vec![replacement]))
            .expect("the same app re-publish is valid");

        let surfaces = registry.surfaces();
        let app_ids: Vec<&str> = surfaces.iter().map(|s| s.app_id.as_str()).collect();
        assert_eq!(app_ids, vec!["alpha", "beta"], "insertion order preserved");
        assert_eq!(surfaces[0].commands.len(), 1);
        assert_eq!(surfaces[0].commands[0].id, "alpha.replaced");
        assert_eq!(surfaces[1].commands.len(), 2, "beta is untouched");

        // A new app id is appended.
        registry
            .publish(manifest(vec![surface("gamma")]))
            .expect("the new app publish is valid");
        let app_ids: Vec<String> = registry
            .surfaces()
            .iter()
            .map(|s| s.app_id.clone())
            .collect();
        assert_eq!(app_ids, vec!["alpha", "beta", "gamma"]);
    }

    #[test]
    fn an_empty_publish_is_a_no_op_never_a_clear() {
        let registry = AppCommandSurfaceRegistry::new();
        registry
            .publish(manifest(vec![surface("alpha")]))
            .expect("the first publish is valid");
        let before = registry.surfaces();

        registry
            .publish(manifest(Vec::new()))
            .expect("an empty publish is accepted");
        assert_eq!(registry.surfaces(), before);
    }

    fn assert_rejected_without_mutation(candidate: CompanionManifest) {
        let registry = AppCommandSurfaceRegistry::new();
        registry
            .publish(manifest(vec![surface("alpha")]))
            .expect("the baseline publish is valid");
        let before = registry.surfaces();
        assert!(registry.publish(candidate).is_err());
        assert_eq!(
            registry.surfaces(),
            before,
            "a rejected publish must leave the registry byte-identical"
        );
    }

    #[test]
    fn a_skill_name_that_is_not_the_app_id_is_rejected() {
        let mut candidate = surface("alpha");
        candidate.skill_name = "beta".to_string();
        assert_rejected_without_mutation(manifest(vec![candidate]));
    }

    #[test]
    fn every_reserved_skill_name_is_rejected() {
        for reserved in [
            "open_app",
            "close_app",
            "doom_mode",
            COMPANION_LIST_ACTIONS_ID,
        ] {
            let mut candidate = surface(reserved);
            candidate.skill_name = reserved.to_string();
            assert_rejected_without_mutation(manifest(vec![candidate]));
        }
    }

    #[test]
    fn a_duplicate_app_id_within_one_publish_is_rejected() {
        assert_rejected_without_mutation(manifest(vec![surface("alpha"), surface("alpha")]));
    }

    #[test]
    fn duplicate_command_ids_within_one_surface_are_rejected() {
        let mut candidate = surface("alpha");
        candidate.commands = vec![command("alpha.one"), command("alpha.one")];
        assert_rejected_without_mutation(manifest(vec![candidate]));
    }

    #[test]
    fn every_blank_identity_or_description_is_rejected() {
        let mut blank_app_id = surface("alpha");
        blank_app_id.app_id = "   ".to_string();
        assert_rejected_without_mutation(manifest(vec![blank_app_id]));

        let mut blank_app_name = surface("alpha");
        blank_app_name.app_name = String::new();
        assert_rejected_without_mutation(manifest(vec![blank_app_name]));

        let mut blank_skill_name = surface("alpha");
        blank_skill_name.skill_name = "   ".to_string();
        assert_rejected_without_mutation(manifest(vec![blank_skill_name]));

        let mut blank_surface_description = surface("alpha");
        blank_surface_description.description = "   ".to_string();
        assert_rejected_without_mutation(manifest(vec![blank_surface_description]));

        let mut blank_command_id = surface("alpha");
        blank_command_id.commands[0].id = "   ".to_string();
        assert_rejected_without_mutation(manifest(vec![blank_command_id]));

        let mut blank_command_description = surface("alpha");
        blank_command_description.commands[0].description = "   ".to_string();
        assert_rejected_without_mutation(manifest(vec![blank_command_description]));
    }

    #[test]
    fn the_surface_bound_is_enforced_atomically() {
        let surfaces: Vec<CompanionSurfaceManifest> = (0..=APP_COMMAND_SURFACE_MAX_SURFACES)
            .map(|index| surface(&format!("app{index}")))
            .collect();
        assert_eq!(surfaces.len(), APP_COMMAND_SURFACE_MAX_SURFACES + 1);
        assert_rejected_without_mutation(manifest(surfaces));

        // Exactly the bound is accepted.
        let registry = AppCommandSurfaceRegistry::new();
        let at_bound: Vec<CompanionSurfaceManifest> = (0..APP_COMMAND_SURFACE_MAX_SURFACES)
            .map(|index| surface(&format!("app{index}")))
            .collect();
        registry
            .publish(manifest(at_bound))
            .expect("the surface bound itself is accepted");
        assert_eq!(
            registry.surfaces().len(),
            APP_COMMAND_SURFACE_MAX_SURFACES
        );
    }

    #[test]
    fn the_command_bound_is_enforced_atomically() {
        let mut too_many = surface("alpha");
        too_many.commands = (0..=APP_COMMAND_SURFACE_MAX_COMMANDS)
            .map(|index| command(&format!("alpha.{index}")))
            .collect();
        assert_eq!(too_many.commands.len(), APP_COMMAND_SURFACE_MAX_COMMANDS + 1);
        assert_rejected_without_mutation(manifest(vec![too_many]));

        // Exactly the bound is accepted.
        let registry = AppCommandSurfaceRegistry::new();
        let mut at_bound = surface("alpha");
        at_bound.commands = (0..APP_COMMAND_SURFACE_MAX_COMMANDS)
            .map(|index| command(&format!("alpha.{index}")))
            .collect();
        registry
            .publish(manifest(vec![at_bound]))
            .expect("the command bound itself is accepted");
        assert_eq!(
            registry.surfaces()[0].commands.len(),
            APP_COMMAND_SURFACE_MAX_COMMANDS
        );
    }

    #[test]
    fn a_zero_command_surface_generates_no_skill() {
        let mut empty = surface("empty");
        empty.commands.clear();
        let registry = build_companion_skill_registry(&[empty]);
        assert_eq!(
            skill_names(&registry),
            vec!["open_app", "close_app", "doom_mode"],
            "a surface with nothing to offer adds no skill"
        );
    }

    #[test]
    fn the_generated_skill_declares_every_id_then_list_actions() {
        let registry = build_companion_skill_registry(&[surface("alpha")]);
        assert_eq!(
            skill_names(&registry),
            vec!["open_app", "close_app", "doom_mode", "alpha"]
        );
        assert_eq!(
            action_enum(&registry, "alpha"),
            vec!["alpha.one", "alpha.two", COMPANION_LIST_ACTIONS_ID]
        );

        let skill = surface_skill(&surface("alpha"));
        assert_eq!(
            skill.description,
            "A capability sentence. Actions: alpha.one, alpha.two, listActions."
        );
        assert_eq!(skill.parameters["type"], "object");
        assert_eq!(skill.parameters["required"], json!(["action"]));
        assert_eq!(
            skill.parameters["properties"]["arguments"],
            json!({ "type": "object" })
        );
    }

    #[test]
    fn a_removed_id_disappears_from_the_next_offer_after_a_same_app_republish() {
        let registry = AppCommandSurfaceRegistry::new();
        registry
            .publish(manifest(vec![surface("wireframe")]))
            .expect("the first publish is valid");
        assert!(action_enum(
            &build_companion_skill_registry(&registry.surfaces()),
            "wireframe"
        )
        .contains(&"wireframe.two".to_string()));

        let mut smaller = surface("wireframe");
        smaller.commands = vec![command("wireframe.one")];
        registry
            .publish(manifest(vec![smaller]))
            .expect("the re-publish is valid");

        let offer = action_enum(&build_companion_skill_registry(&registry.surfaces()), "wireframe");
        assert_eq!(offer, vec!["wireframe.one", COMPANION_LIST_ACTIONS_ID]);
        assert!(
            !offer.contains(&"wireframe.two".to_string()),
            "the removed id must disappear from the next offer"
        );
    }

    /* ── Spec #3120 (P6) ST-2 — risk/aliases across the wire (G-413) ── */

    fn navigation_command() -> CompanionCommandManifest {
        CompanionCommandManifest {
            id: "journal.undo".to_string(),
            label: "Undo".to_string(),
            description: "Undo the newest change.".to_string(),
            risk: Some("mutating".to_string()),
            args: vec![CompanionCommandArgManifest {
                name: "actor".to_string(),
                required: false,
                description: None,
            }],
            aliases: vec!["undo".to_string(), "revert".to_string()],
        }
    }

    #[test]
    fn a_navigation_command_serializes_risk_and_aliases_and_round_trips() {
        let command = navigation_command();
        let wire = serde_json::to_value(&command).expect("the command serializes");
        let object = wire.as_object().expect("the command is a JSON object");

        assert_eq!(wire["risk"], "mutating", "risk is present for a navigation command");
        assert_eq!(
            wire["aliases"],
            json!(["undo", "revert"]),
            "aliases are present when declared"
        );
        assert!(object.contains_key("risk"));
        assert!(object.contains_key("aliases"));

        // Consuming side: the wire shape deserializes back to the same value.
        let parsed: CompanionCommandManifest =
            serde_json::from_value(wire).expect("the navigation wire shape parses");
        assert_eq!(parsed, command);
    }

    #[test]
    fn a_navigation_command_with_no_aliases_omits_the_key_never_null() {
        let mut command = navigation_command();
        command.risk = Some("safe".to_string());
        command.aliases.clear();

        let wire = serde_json::to_value(&command).expect("the command serializes");
        let object = wire.as_object().expect("the command is a JSON object");
        assert_eq!(wire["risk"], "safe", "risk stays present for a navigation command");
        assert!(
            !object.contains_key("aliases"),
            "an empty aliases list is an ABSENT key, never `null`"
        );
        assert!(wire.get("aliases").is_none());

        let parsed: CompanionCommandManifest =
            serde_json::from_value(wire).expect("a navigation wire shape without aliases parses");
        assert_eq!(parsed.risk.as_deref(), Some("safe"));
        assert!(parsed.aliases.is_empty());
    }

    #[test]
    fn a_legacy_command_omits_risk_and_aliases() {
        let legacy = command("alpha.one");
        let wire = serde_json::to_value(&legacy).expect("the legacy command serializes");
        let object = wire.as_object().expect("the command is a JSON object");
        assert!(
            !object.contains_key("risk"),
            "a legacy command-surface command carries no risk key"
        );
        assert!(
            !object.contains_key("aliases"),
            "a legacy command-surface command carries no aliases key"
        );
    }

    #[test]
    fn both_wire_shapes_deserialize_and_publish_through_the_registry() {
        // One surface declared by the navigation engine (risk present; aliases present
        // on `journal.undo`, absent on a verb with none) and one legacy surface (neither
        // key at all) — the exact two shapes a live webview publishes.
        let raw = json!({
            "surfaces": [
                {
                    "appId": "wireframe",
                    "appName": "Wireframe",
                    "skillName": "wireframe",
                    "description": "Draw and arrange wireframe pages.",
                    "commands": [
                        {
                            "id": "journal.undo",
                            "label": "Undo",
                            "description": "Undo the newest change.",
                            "risk": "mutating",
                            "args": [
                                { "name": "actor", "required": false },
                                { "name": "count", "required": false }
                            ],
                            "aliases": ["undo", "revert"]
                        },
                        {
                            "id": "wireframe.view.fitPage",
                            "label": "Fit page",
                            "description": "Fit the page to the screen.",
                            "risk": "safe",
                            "args": []
                        }
                    ]
                },
                {
                    "appId": "legacy",
                    "appName": "Legacy",
                    "skillName": "legacy",
                    "description": "A legacy command surface.",
                    "commands": [
                        {
                            "id": "legacy.one",
                            "label": "One",
                            "description": "Do one thing.",
                            "args": []
                        }
                    ]
                }
            ]
        });

        let manifest: CompanionManifest =
            serde_json::from_value(raw).expect("both wire shapes parse");
        let registry = AppCommandSurfaceRegistry::new();
        registry.publish(manifest).expect("both wire shapes publish");

        let surfaces = registry.surfaces();
        assert_eq!(surfaces[0].commands[0].risk.as_deref(), Some("mutating"));
        assert_eq!(surfaces[0].commands[0].aliases, vec!["undo", "revert"]);
        assert_eq!(surfaces[0].commands[1].risk.as_deref(), Some("safe"));
        assert!(surfaces[0].commands[1].aliases.is_empty());
        assert!(surfaces[1].commands[0].risk.is_none());
        assert!(surfaces[1].commands[0].aliases.is_empty());

        // The read view (`app_command_surfaces` returns the same registry) keeps the
        // optional-field contract on the outbound wire.
        let wire = serde_json::to_value(CompanionManifest {
            surfaces: registry.surfaces(),
        })
        .expect("the registry read serializes");
        assert_eq!(wire["surfaces"][0]["commands"][0]["risk"], "mutating");
        assert_eq!(
            wire["surfaces"][0]["commands"][0]["aliases"],
            json!(["undo", "revert"])
        );
        assert!(wire["surfaces"][0]["commands"][1].get("aliases").is_none());
        assert!(wire["surfaces"][1]["commands"][0].get("risk").is_none());
        assert!(wire["surfaces"][1]["commands"][0].get("aliases").is_none());
    }
}
