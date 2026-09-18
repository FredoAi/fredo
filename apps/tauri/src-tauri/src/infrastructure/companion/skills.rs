//! Provider-agnostic companion skill contract + registry (Spec #2893, ST-3).
//!
//! A *companion skill* is a named capability with a declared input contract
//! (`name` / `description` / JSON-Schema `parameters`). The registry is the ONE
//! source of truth for what the Companion can be asked to do; a mechanism
//! adapter (ST-5) is what renders a registered skill into a particular
//! inference request. **A mechanism change never changes this module** (R-3.5).
//!
//! Scope / non-goals:
//! - The vocabulary here is deliberately mechanism-neutral: a skill is declared
//!   as `name` / `description` / `parameters` and nothing more. The nouns of any
//!   particular wire format belong to the mechanism adapter (ST-5), never here.
//! - It imports no UI or feature module, performs **no execution** and does no
//!   window work: [`validate`] only checks a model-selected call against the
//!   registry; execution is bound by the caller (ST-5).
//!
//! Requirements covered: R-3.1/R-3.2 (offer ≥1 declared skill, `open_app`
//! first), R-3.4 (fail closed), R-3.5 (provider-agnostic contract).

use serde_json::{json, Value};

/// The name of the first registered companion skill (R-3.2).
pub const OPEN_APP_SKILL: &str = "open_app";

/// The `open_app` argument carrying the app identity the user named.
pub const OPEN_APP_ARGUMENT: &str = "app";

/// The capability sentence offered for `open_app` (mechanism-neutral).
pub const OPEN_APP_DESCRIPTION: &str =
    "Open a Fredo desktop app/feature by the name the user said. Use ONLY for an explicit open request.";

/// The declared input contract for `open_app`: exactly one required, non-empty
/// string argument (`app`) — no other argument is declared, so extra arguments
/// fail closed in [`validate`].
pub fn open_app_parameters() -> Value {
    json!({
        "type": "object",
        "properties": { "app": { "type": "string" } },
        "required": ["app"]
    })
}

/// A provider-agnostic declaration of one companion capability.
///
/// `parameters` is a JSON Schema fragment declaring the capability's inputs.
/// Nothing here names a transport or a wire format.
#[derive(Debug, Clone, PartialEq)]
pub struct CompanionSkill {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

impl CompanionSkill {
    /// Construct a declared capability.
    pub fn new(name: impl Into<String>, description: impl Into<String>, parameters: Value) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            parameters,
        }
    }
}

/// A skill registered in a [`SkillRegistry`]. The wrapper exists so execution
/// can be bound by the caller (ST-5) without changing the declaration.
#[derive(Debug, Clone, PartialEq)]
pub struct RegisteredSkill {
    pub skill: CompanionSkill,
}

impl RegisteredSkill {
    /// Wrap a declaration for registration.
    pub fn new(skill: CompanionSkill) -> Self {
        Self { skill }
    }
}

/// The companion skill registry: registration order is the offer order.
///
/// Deliberately has no transport/adapter knowledge — offering the registry to an
/// inference path is ST-5's job.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SkillRegistry {
    skills: Vec<RegisteredSkill>,
}

impl SkillRegistry {
    /// An empty registry (no skills offered).
    pub fn new() -> Self {
        Self { skills: Vec::new() }
    }

    /// The registry with the first (and, in this slice, only) skill: `open_app`
    /// with its declared `{ "app": string }` input contract (R-3.1/R-3.2).
    pub fn with_open_app() -> Self {
        let mut registry = Self::new();
        registry.register(CompanionSkill::new(
            OPEN_APP_SKILL,
            OPEN_APP_DESCRIPTION,
            open_app_parameters(),
        ));
        registry
    }

    /// Register a skill. A name already present is **replaced in place**, so the
    /// offer order of the remaining skills is stable.
    pub fn register(&mut self, skill: CompanionSkill) -> &mut Self {
        if let Some(existing) = self.skills.iter_mut().find(|r| r.skill.name == skill.name) {
            existing.skill = skill;
        } else {
            self.skills.push(RegisteredSkill::new(skill));
        }
        self
    }

    /// The skill registered under `name` — exact match, no aliases, no case
    /// folding.
    pub fn get(&self, name: &str) -> Option<&CompanionSkill> {
        self.skills
            .iter()
            .find(|r| r.skill.name == name)
            .map(|r| &r.skill)
    }

    /// The registered skills, in registration (offer) order.
    pub fn list(&self) -> impl Iterator<Item = &CompanionSkill> {
        self.skills.iter().map(|r| &r.skill)
    }

    /// Whether no skill is registered.
    pub fn is_empty(&self) -> bool {
        self.skills.is_empty()
    }

    /// The number of registered skills.
    pub fn len(&self) -> usize {
        self.skills.len()
    }
}

/// A validated skill selection: the canonical skill name and the arguments
/// exactly as the model produced them (normalization belongs to the caller).
#[derive(Debug, Clone, PartialEq)]
pub struct SkillInvocation {
    pub skill: String,
    pub arguments: Value,
}

/// Why a model-selected skill call was refused. Every variant is fail-closed:
/// the caller must execute nothing and open no window (R-3.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillValidationError {
    /// The selected skill name is not declared in the registry.
    UnknownSkill(String),
    /// A required argument is absent (or explicitly `null`).
    MissingArgument(String),
    /// A declared argument has the wrong type / is empty, or the arguments
    /// object carries an undeclared key or is not an object at all.
    InvalidArgument(String),
}

impl std::fmt::Display for SkillValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownSkill(name) => write!(f, "unknown skill '{name}'"),
            Self::MissingArgument(argument) => {
                write!(f, "missing required argument '{argument}'")
            }
            Self::InvalidArgument(detail) => write!(f, "invalid argument: {detail}"),
        }
    }
}

impl std::error::Error for SkillValidationError {}

/// The required argument names declared by a skill's `parameters` schema.
fn required_arguments(parameters: &Value) -> Vec<String> {
    parameters
        .get("required")
        .and_then(Value::as_array)
        .map(|required| {
            required
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Validate a model-selected skill call against `registry` **before** any
/// execution (R-3.3). Fail-closed (R-3.4): an unknown skill, a missing/non-string
/// or empty declared argument, an undeclared argument key, or a non-object
/// arguments value all return `Err` and execute nothing.
pub fn validate(
    registry: &SkillRegistry,
    skill: &str,
    arguments: &Value,
) -> Result<SkillInvocation, SkillValidationError> {
    let registered = registry
        .get(skill)
        .ok_or_else(|| SkillValidationError::UnknownSkill(skill.to_string()))?;

    // `null` is the "no arguments supplied" shape; anything else non-object is
    // a malformed selection. Both fail closed, but with distinct reasons.
    let args = match arguments.as_object() {
        Some(args) => args,
        None if arguments.is_null() => {
            let required = required_arguments(&registered.parameters);
            return Err(match required.first() {
                Some(argument) => SkillValidationError::MissingArgument(argument.clone()),
                None => SkillValidationError::InvalidArgument(
                    "arguments must be a JSON object".to_string(),
                ),
            });
        }
        None => {
            return Err(SkillValidationError::InvalidArgument(
                "arguments must be a JSON object".to_string(),
            ))
        }
    };

    // Every declared required argument must be present and non-null.
    for argument in required_arguments(&registered.parameters) {
        match args.get(&argument) {
            None | Some(Value::Null) => {
                return Err(SkillValidationError::MissingArgument(argument))
            }
            Some(_) => {}
        }
    }

    // Declared string arguments must be non-blank; undeclared keys fail closed.
    let properties = registered.parameters.get("properties").and_then(Value::as_object);
    for (key, value) in args {
        match properties.and_then(|declared| declared.get(key)) {
            None => {
                return Err(SkillValidationError::InvalidArgument(format!(
                    "unexpected argument '{key}'"
                )))
            }
            Some(schema) if schema.get("type").and_then(Value::as_str) == Some("string") => {
                match value.as_str() {
                    Some(text) if !text.trim().is_empty() => {}
                    Some(_) => {
                        return Err(SkillValidationError::InvalidArgument(format!(
                            "argument '{key}' must not be empty"
                        )))
                    }
                    None => {
                        return Err(SkillValidationError::InvalidArgument(format!(
                            "argument '{key}' must be a string"
                        )))
                    }
                }
            }
            Some(_) => {}
        }
    }

    Ok(SkillInvocation {
        skill: registered.name.clone(),
        arguments: arguments.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> SkillRegistry {
        SkillRegistry::with_open_app()
    }

    #[test]
    fn with_open_app_registers_open_app_first_with_a_declared_input_contract() {
        let registry = registry();
        assert_eq!(registry.len(), 1);
        let first = registry.list().next().expect("open_app is registered");
        assert_eq!(first.name, OPEN_APP_SKILL);
        assert_eq!(first.description, OPEN_APP_DESCRIPTION);
        assert_eq!(first.parameters["type"], "object");
        assert_eq!(first.parameters["required"], json!(["app"]));
        assert_eq!(first.parameters["properties"]["app"]["type"], "string");
        assert_eq!(registry.list().count(), 1, "exactly one skill in this slice");
    }

    #[test]
    fn get_returns_the_skill_by_exact_name_and_rejects_anything_else() {
        let registry = registry();
        let skill = registry.get("open_app").expect("registered under its name");
        assert_eq!(skill.name, OPEN_APP_SKILL);
        assert!(registry.get("Open_App").is_none(), "no case folding");
        assert!(registry.get("open app").is_none(), "no aliases");
        assert!(registry.get("nope").is_none());
    }

    #[test]
    fn an_empty_registry_rejects_every_skill() {
        let registry = SkillRegistry::new();
        assert!(registry.is_empty());
        assert!(registry.get(OPEN_APP_SKILL).is_none());
        assert_eq!(
            validate(&registry, "open_app", &json!({ "app": "Mission Monitor" })),
            Err(SkillValidationError::UnknownSkill("open_app".to_string()))
        );
    }

    #[test]
    fn validate_happy_path_returns_the_invocation() {
        let invocation = validate(&registry(), "open_app", &json!({ "app": "Mission Monitor" }))
            .expect("a declared non-empty app is valid");
        assert_eq!(invocation.skill, "open_app");
        assert_eq!(invocation.arguments, json!({ "app": "Mission Monitor" }));
    }

    #[test]
    fn validate_preserves_the_argument_verbatim_for_caller_normalization() {
        let invocation = validate(&registry(), "open_app", &json!({ "app": "  Mission Monitor  " }))
            .expect("non-blank after trim");
        assert_eq!(invocation.arguments["app"], "  Mission Monitor  ");
    }

    #[test]
    fn validate_rejects_an_unknown_skill() {
        assert_eq!(
            validate(&registry(), "open_the_pod_bay", &json!({ "app": "Mission Monitor" })),
            Err(SkillValidationError::UnknownSkill(
                "open_the_pod_bay".to_string()
            ))
        );
    }

    #[test]
    fn validate_rejects_a_missing_or_null_app() {
        assert_eq!(
            validate(&registry(), "open_app", &json!({})),
            Err(SkillValidationError::MissingArgument("app".to_string()))
        );
        assert_eq!(
            validate(&registry(), "open_app", &json!(null)),
            Err(SkillValidationError::MissingArgument("app".to_string()))
        );
        assert_eq!(
            validate(&registry(), "open_app", &json!({ "app": null })),
            Err(SkillValidationError::MissingArgument("app".to_string()))
        );
    }

    #[test]
    fn validate_rejects_a_non_string_app() {
        assert_eq!(
            validate(&registry(), "open_app", &json!({ "app": 42 })),
            Err(SkillValidationError::InvalidArgument(
                "argument 'app' must be a string".to_string()
            ))
        );
        assert_eq!(
            validate(&registry(), "open_app", &json!({ "app": ["Mission Monitor"] })),
            Err(SkillValidationError::InvalidArgument(
                "argument 'app' must be a string".to_string()
            ))
        );
    }

    #[test]
    fn validate_rejects_an_empty_or_whitespace_app() {
        for blank in ["", "   ", "\t\n"] {
            assert_eq!(
                validate(&registry(), "open_app", &json!({ "app": blank })),
                Err(SkillValidationError::InvalidArgument(
                    "argument 'app' must not be empty".to_string()
                )),
                "blank app {blank:?} must fail closed"
            );
        }
    }

    #[test]
    fn validate_rejects_unexpected_argument_shapes() {
        // An undeclared key fails closed — the contract declares only `app`.
        assert_eq!(
            validate(&registry(), "open_app", &json!({ "app": "Mission Monitor", "force": true })),
            Err(SkillValidationError::InvalidArgument(
                "unexpected argument 'force'".to_string()
            ))
        );
        // A non-object arguments value fails closed.
        assert_eq!(
            validate(&registry(), "open_app", &json!(["Mission Monitor"])),
            Err(SkillValidationError::InvalidArgument(
                "arguments must be a JSON object".to_string()
            ))
        );
        assert_eq!(
            validate(&registry(), "open_app", &json!("Mission Monitor")),
            Err(SkillValidationError::InvalidArgument(
                "arguments must be a JSON object".to_string()
            ))
        );
    }

    #[test]
    fn register_replaces_a_duplicate_name_in_place_preserving_offer_order() {
        let mut registry = SkillRegistry::new();
        registry
            .register(CompanionSkill::new("alpha", "first", json!({})))
            .register(CompanionSkill::new("beta", "second", json!({})))
            .register(CompanionSkill::new("alpha", "replaced", json!({})));

        let names: Vec<&str> = registry.list().map(|skill| skill.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "beta"]);
        assert_eq!(
            registry.get("alpha").map(|skill| skill.description.as_str()),
            Some("replaced")
        );
    }

    #[test]
    fn the_declaration_is_mechanism_neutral_name_description_parameters_only() {
        let declaration = json!({
            "name": OPEN_APP_SKILL,
            "description": OPEN_APP_DESCRIPTION,
            "parameters": open_app_parameters(),
        });

        // The declaration carries exactly the provider-agnostic trio.
        let mut keys: Vec<&str> = declaration
            .as_object()
            .expect("declaration object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["description", "name", "parameters"]);

        // The input schema declares exactly one string property.
        let schema = declaration["parameters"].as_object().expect("schema object");
        let mut schema_keys: Vec<&str> = schema.keys().map(String::as_str).collect();
        schema_keys.sort_unstable();
        assert_eq!(schema_keys, vec!["properties", "required", "type"]);

        let properties = schema["properties"].as_object().expect("properties object");
        assert_eq!(
            properties.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["app"]
        );
    }
}
