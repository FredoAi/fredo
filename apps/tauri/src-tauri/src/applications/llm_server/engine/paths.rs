//! Model-path and log-path resolution for the in-process engine (Spec #3141,
//! ST-1; AC-18 / AC-27).
//!
//! ## The ONE path rule
//!
//! Every model file resolves through the shared #2856 manifest —
//! [`models::file_path`] (`<models_dir>/<manifest.subdir>/<spec.path>`) — never
//! a hardcoded path and never a persisted per-file settings override
//! (`AC-18`). The old `llama_server_model_path` / `_mmproj_path` /
//! `_mtp_path` keys are deliberately NOT read: a stale persisted value is inert,
//! and the manifest is the single source of truth.
//!
//! The manifest and the models directory themselves remain owned by
//! [`crate::infrastructure::companion::models`] (`resolve_manifest`,
//! `resolve_models_dir`) — this module only JOINS them, so the layout rule
//! lives in exactly one place.

use std::path::{Path, PathBuf};

use llama_cpp_4::model::params::LlamaModelParams;
use llama_cpp_4::model::LlamaModel;

use crate::infrastructure::companion::models::{
    file_path, missing_files, resolve_manifest, resolve_models_dir, ModelManifest,
};

use super::CompanionEngineErrorCode;

/// The engine log filename inside the companion directory.
pub const ENGINE_LOG_FILENAME: &str = "companion-engine.log";

/// The three absolute model paths the engine loads, plus the engine log file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnginePaths {
    /// The main quantized model (`manifest` id `model`).
    pub model: PathBuf,
    /// The multimodal projector (`manifest` id `vision`) — loaded in ST-5.
    pub mmproj: PathBuf,
    /// The MTP draft model (`manifest` id `mtp`) — loaded in ST-4.
    pub mtp: PathBuf,
    /// The engine log file (points llama.cpp's logger at the companion dir).
    pub log: Option<String>,
}

impl EnginePaths {
    /// Resolve the three model paths for `models_dir` + `manifest` through the
    /// SHARED manifest rule (never a literal, never a settings override).
    pub fn resolve(models_dir: &Path, manifest: &ModelManifest) -> Self {
        let path_for = |id: &str| {
            manifest
                .files
                .iter()
                .find(|spec| spec.id == id)
                .map(|spec| file_path(models_dir, manifest, spec))
                .unwrap_or_default()
        };
        Self {
            model: path_for("model"),
            mmproj: path_for("vision"),
            mtp: path_for("mtp"),
            log: None,
        }
    }

    /// Attach the engine log file path (rendered as a string, since that is what
    /// `runtime::log::set_file` takes).
    pub fn with_log(mut self, companion_dir: &Path) -> Self {
        self.log = Some(engine_log_path(companion_dir).to_string_lossy().into_owned());
        self
    }
}

/// Resolve [`EnginePaths`] for the app's current models dir + manifest and
/// refuse with the DEPARTMENT-SPECIFIC typed code when a required file is
/// absent or the wrong size (a missing projector is `MmprojInitFailed`, a
/// missing draft `MtpInitFailed`, anything else `ModelMissing`).
///
/// The models dir and manifest are resolved through the SHARED helpers, so the
/// engine honours the same override seam the setup surface uses.
pub fn resolve_for_app(
    models_dir: &Path,
    manifest: &ModelManifest,
) -> Result<EnginePaths, (CompanionEngineErrorCode, String)> {
    let missing = missing_files(models_dir, manifest);
    if !missing.is_empty() {
        let first_id = missing
            .first()
            .map(|status| status.id.as_str())
            .unwrap_or("model");
        let names: Vec<&str> = missing.iter().map(|status| status.relative_path.as_str()).collect();
        let detail = format!(
            "missing model file(s): {} — open Companion setup to download them.",
            names.join(", ")
        );
        return Err((CompanionEngineErrorCode::for_missing_file(first_id), detail));
    }
    Ok(EnginePaths::resolve(models_dir, manifest))
}

/// Resolve the models dir + manifest for an app handle, attach the engine log
/// path under the configured companion dir, then delegate to
/// [`resolve_for_app`].
///
/// The companion dir comes from the SHARED `process::resolve_companion_dir`, so
/// the per-environment `llama_server_companion_dir` override keeps working
/// unchanged (AC-27).
pub fn resolve_for_handle(
    app: &tauri::AppHandle,
) -> Result<EnginePaths, (CompanionEngineErrorCode, String)> {
    let paths = resolve_for_app(&resolve_models_dir(app), &resolve_manifest(app))?;
    match crate::applications::llm_server::process::resolve_companion_dir(app) {
        Ok(dir) => {
            // Best-effort: create the dir so llama.cpp can open the log file.
            let _ = std::fs::create_dir_all(&dir);
            Ok(paths.with_log(&dir))
        }
        // A companion-dir resolution failure degrades to stderr logging, never a
        // start refusal — the log path is not load-bearing.
        Err(_) => Ok(paths),
    }
}

/// The engine log file path inside the companion dir (an explicit path, so the
/// log lives with the other companion artifacts rather than in a temp dir).
pub fn engine_log_path(companion_dir: &Path) -> PathBuf {
    companion_dir.join(ENGINE_LOG_FILENAME)
}

/// The main model's id (the manifest `model` spec's file stem), for the status
/// surface's `modelId`.
///
/// A pure function of the resolved path (never a log parse).
pub fn model_id_for(path: &Path) -> Option<String> {
    path.file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .filter(|stem| !stem.is_empty())
}

/// Build the model parameters for `mode`'s projection, enabling MTP weight
/// loading (the pinned GGUF ships MTP layers; ST-4 drives the session).
///
/// `gpu_layers` is the caller's projection (`0` for CPU-only, `u32::MAX` for
/// full offload), so the offload request is decided by [`super::device::project`]
/// — never re-derived here.
pub fn model_params(gpu_layers: u32) -> LlamaModelParams {
    LlamaModelParams::default()
        .with_n_gpu_layers(gpu_layers)
        .with_load_mtp(true)
}

/// Load the main model from the resolved path with `params`.
pub fn load_model(
    backend: &llama_cpp_4::llama_backend::LlamaBackend,
    model_path: &Path,
    params: &LlamaModelParams,
) -> Result<LlamaModel, (CompanionEngineErrorCode, String)> {
    LlamaModel::load_from_file(backend, model_path, params).map_err(|error| {
        (
            CompanionEngineErrorCode::ModelLoadFailed,
            format!(
                "the model file {} could not be loaded: {error}",
                model_path.display()
            ),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::companion::models::default_manifest;

    #[test]
    fn engine_paths_resolve_through_the_shared_manifest_rule() {
        let manifest = default_manifest();
        let models_dir = Path::new("C:/fredo-models");
        let paths = EnginePaths::resolve(models_dir, &manifest);

        // The main model is exactly the shared `file_path` join.
        let model_spec = manifest.files.iter().find(|spec| spec.id == "model").expect("model spec");
        assert_eq!(paths.model, file_path(models_dir, &manifest, model_spec));

        // And the mmproj / mtp ids map to their own manifest entries.
        let vision_spec = manifest.files.iter().find(|spec| spec.id == "vision").expect("vision");
        let mtp_spec = manifest.files.iter().find(|spec| spec.id == "mtp").expect("mtp");
        assert_eq!(paths.mmproj, file_path(models_dir, &manifest, vision_spec));
        assert_eq!(paths.mtp, file_path(models_dir, &manifest, mtp_spec));

        // The MTP file keeps its nested `MTP/` segment (never a flattened path).
        assert!(paths.mtp.ends_with("MTP/mtp-gemma-4-E2B-it-Q4_0.gguf"));

        // No log file is attached unless the caller supplies a companion dir.
        assert!(paths.log.is_none());
    }

    #[test]
    fn main_model_is_the_default_manifest_model_file() {
        let manifest = default_manifest();
        let path = EnginePaths::resolve(Path::new("C:/fredo-models"), &manifest).model;
        assert!(path.ends_with("gemma-4-e2b-it-qat/gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf"));
    }

    /// The log path is compared as a `Path`, not as a string: `Path::join` on
    /// Windows legitimately renders a base with forward slashes as
    /// `C:/data/companion\companion-engine.log` (mixed separators, still one
    /// valid absolute path). The product has no string consumer — the only
    /// reader is `set_file` → `fopen`, which accepts mixed separators — so the
    /// pin is Path equality against the product's own function.
    #[test]
    fn with_log_attaches_the_engine_log_in_the_companion_dir() {
        let manifest = default_manifest();
        let paths = EnginePaths::resolve(Path::new("C:/fredo-models"), &manifest)
            .with_log(Path::new("C:/data/companion"));
        let log = paths.log.as_deref().expect("a companion dir must attach a log path");
        assert_eq!(Path::new(log), engine_log_path(Path::new("C:/data/companion")));
    }

    #[test]
    fn model_id_is_the_file_stem_of_the_resolved_path() {
        let path = Path::new("C:/fredo-models/gemma-4-e2b-it-qat/gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf");
        assert_eq!(
            model_id_for(path).as_deref(),
            Some("gemma-4-E2B-it-qat-UD-Q4_K_XL")
        );
        assert_eq!(model_id_for(Path::new("")), None);
    }

    #[test]
    fn engine_log_lives_in_the_companion_dir() {
        let path = engine_log_path(Path::new("C:/data/companion"));
        assert_eq!(path, Path::new("C:/data/companion/companion-engine.log"));
    }

    #[test]
    fn resolve_for_app_names_every_absent_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = default_manifest();
        let (_code, detail) = resolve_for_app(dir.path(), &manifest).expect_err("refusal");
        assert!(detail.starts_with("missing model file(s): "), "detail: {detail}");
        assert!(detail.contains("gemma-4-e2b-it-qat/gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf"));
        assert!(detail.contains("gemma-4-e2b-it-qat/mmproj-BF16.gguf"));
        assert!(detail.contains("gemma-4-e2b-it-qat/MTP/mtp-gemma-4-E2B-it-Q4_0.gguf"));
    }

    #[test]
    fn resolve_for_app_refuses_when_a_required_file_is_absent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = default_manifest();
        let error = resolve_for_app(dir.path(), &manifest).expect_err("a missing model must refuse");
        // The main model is first in the manifest, so the classification is the
        // main-model code (a missing projector/draft would map to its subsystem).
        assert_eq!(error.0, CompanionEngineErrorCode::ModelMissing);
        assert!(error.1.contains("missing model file(s)"));
    }

    #[test]
    fn model_params_request_the_given_offload_and_load_mtp_weights() {
        let cpu = model_params(0);
        assert_eq!(cpu.n_gpu_layers(), 0);
        assert!(cpu.load_mtp());

        let full = model_params(u32::MAX);
        // The crate clamps to i32::MAX = every layer.
        assert_eq!(full.n_gpu_layers(), i32::MAX);
        assert!(full.load_mtp());
    }
}
