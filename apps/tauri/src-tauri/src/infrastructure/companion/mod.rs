//! Shared companion runtime helpers (Spec #2857; runtime resolution retired by
//! Spec #3141 ST-6).
//!
//! The required model-file layout is consumed by BOTH `applications/setup`
//! (readiness/acquisition) and `applications/llm_server` (engine path
//! resolution). Cross-application imports are forbidden (`AGENTS.md`), so it
//! lives here in the shared infrastructure layer — one manifest, one path rule.
//!
//! The `llama-server` executable resolver was DELETED with the out-of-process
//! runtime (#3141): inference runs in-process on the linked `llama-cpp-4`
//! bindings, so nothing resolves an external binary or reads
//! `llama_server_path` (a stale persisted value is inert).

pub mod doom_decision;
pub mod download;
pub mod models;
pub mod performance_mode;
pub mod skills;

pub use doom_decision::{
    DoomDecision, DoomDecisionError, DoomDecisionSource, DoomDecisionSourceState,
};
pub use performance_mode::PerformanceModeState;
pub use models::{
    default_manifest, file_path, is_step_complete, load_manifest, missing_files, models_subdir,
    parse_manifest, probe_files, resolve_manifest, resolve_models_dir, FileState, ModelFileSpec,
    ModelFileStatus, ModelManifest, DEFAULT_MANIFEST, MODEL_MANIFEST_PATH_KEY, MODEL_REVISION,
    MODEL_SUBDIR, MODELS_DIR_KEY,
};
pub use skills::{
    open_app_parameters, validate, CompanionSkill, RegisteredSkill, SkillInvocation, SkillRegistry,
    SkillValidationError, OPEN_APP_ARGUMENT, OPEN_APP_DESCRIPTION, OPEN_APP_SKILL,
};
