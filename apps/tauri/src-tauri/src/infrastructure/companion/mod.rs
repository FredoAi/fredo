//! Shared companion runtime helpers (Spec #2857).
//!
//! The `llama-server` executable resolver AND the required model-file layout are
//! consumed by BOTH `features/setup` (readiness/acquisition) and
//! `features/llm_server` (launch/config refusal). Cross-feature imports are
//! forbidden (`AGENTS.md`), so they live here in the shared infrastructure layer
//! — one implementation, one resolution order, one path rule.

pub mod models;
pub mod resolver;

pub use models::{
    default_manifest, file_path, is_step_complete, load_manifest, missing_files, models_subdir,
    parse_manifest, probe_files, resolve_manifest, resolve_models_dir, FileState, ModelFileSpec,
    ModelFileStatus, ModelManifest, DEFAULT_MANIFEST, MODEL_MANIFEST_PATH_KEY, MODEL_REVISION,
    MODEL_SUBDIR, MODELS_DIR_KEY,
};
pub use resolver::{
    resolve_llama_server, resolve_llama_server_order, LLAMA_SERVER_BIN,
    LLAMA_SERVER_SETTING_KEY,
};
