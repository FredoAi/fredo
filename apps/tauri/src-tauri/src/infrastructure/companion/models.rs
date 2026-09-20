//! Shared companion model layout + acquisition model (Spec #2857, ST-9; #2856).
//!
//! This module is the single source of truth for the required GGUF model-file
//! layout (`<models_dir>/<subdir>/<file>`), the pinned acquisition manifest, the
//! honest on-disk classifier, and the "step is complete" aggregator. It is
//! consumed by BOTH `features/setup` (acquisition / readiness) and
//! `features/llm_server` (launch-config refusal via [`is_step_complete`] +
//! [`missing_files`]), so the two features never import each other and the layout
//! cannot drift (NFR-6).
//!
//! Originally authored for #2856 in `features/setup/model_download_state.rs`;
//! moved here by ST-9 so `features::setup::model_download_state` can re-export it
//! with the #2856 download wire/behavior unchanged.
//!
//! **Verification contract (binding):** `present` is the exact byte-size gate
//! (`on-disk len == expectedBytes`) for BOTH downloaded and manually-placed
//! files. `0 < size < expected` classifies as `missing` with a shortfall detail;
//! `size > expected` classifies as `error`. SHA-256 is NOT computed here — manual
//! files are size-gated only (3.67 GB must not be re-read on every probe); the
//! download path verifies the streaming hash itself.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::infrastructure::storage::AppStore;

/// AppStore key holding the user-configurable model base directory.
pub const MODELS_DIR_KEY: &str = "models_dir";

/// AppStore key holding an optional whole-manifest JSON override (#2856 test seam).
pub const MODEL_MANIFEST_PATH_KEY: &str = "model_manifest_path";

/// Fixed disk layout subfolder for the QAT model set (distinct from the legacy
/// in-process engine's `gemma-e2b-it` layout, which this slice MUST NOT touch).
pub const MODEL_SUBDIR: &str = "gemma-4-e2b-it-qat";

/// Revision pinned for reproducible bytes; the compiled URLs resolve against it.
pub const MODEL_REVISION: &str = "66a399f68ddd113b06dff02fca9523e55465d11d";

/// Per-file state vocabulary shared by the classifier and the progress events.
///
/// `Downloading` is never produced by the pure on-disk classifier (it is a live
/// in-flight state); it exists so the wire vocabulary is complete.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileState {
    Missing,
    Downloading,
    Present,
    Error,
}

/// One required file: where it comes from, where it lands, how big it is, and
/// (optionally) its pinned SHA-256. `sha256` is REQUIRED in the compiled default
/// and OPTIONAL in an override manifest (omitted ⇒ size-only verification).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFileSpec {
    /// Stable join key: `model` | `vision` | `mtp`.
    pub id: String,
    /// Path relative to the manifest `subdir`; may contain a `MTP/` segment.
    pub path: String,
    /// Fully-qualified download URL (HF resolve pinned to `revision`).
    pub url: String,
    /// Exact expected on-disk byte count — the `present` gate.
    pub expected_bytes: u64,
    /// Optional lowercase hex SHA-256; `None` ⇒ size-only verification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

impl ModelFileSpec {
    /// The basename of [`Self::path`] (handles both `/` and `\` separators).
    pub fn filename(&self) -> &str {
        self.path
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(self.path.as_str())
    }
}

/// The full acquisition manifest: a pinned revision, the layout subfolder, and
/// the ordered required files (`model` → `vision` → `mtp`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelManifest {
    #[serde(default)]
    pub revision: String,
    #[serde(default = "default_subdir")]
    pub subdir: String,
    #[serde(default)]
    pub files: Vec<ModelFileSpec>,
}

fn default_subdir() -> String {
    MODEL_SUBDIR.to_string()
}

/// Per-file status report returned to the UI (`ModelFilesStatus.files[]`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFileStatus {
    pub id: String,
    pub filename: String,
    /// `<subdir>/<path>` — stable identity for the UI row.
    pub relative_path: String,
    pub state: FileState,
    /// Bytes currently on disk (0 when absent/not inspectable).
    pub downloaded_bytes: u64,
    pub expected_bytes: u64,
    /// Human-readable qualifier, e.g. `Incomplete — 123 of 2620370976 bytes`.
    pub detail: Option<String>,
    /// Absolute path when a file exists on disk.
    pub path: Option<String>,
}

/// The compiled default manifest — pinned URLs, exact byte sizes, and SHA-256
/// oids verified live against the Hugging Face tree (G-128).
pub static DEFAULT_MANIFEST: LazyLock<ModelManifest> = LazyLock::new(|| ModelManifest {
    revision: MODEL_REVISION.to_string(),
    subdir: MODEL_SUBDIR.to_string(),
    files: vec![
        ModelFileSpec {
            id: "model".to_string(),
            path: "gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf".to_string(),
            url: format!(
                "https://huggingface.co/unsloth/gemma-4-E2B-it-qat-GGUF/resolve/{MODEL_REVISION}/gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf"
            ),
            expected_bytes: 2_620_370_976,
            sha256: Some(
                "e531007218dfab990486a5de7676a6932d6ea8dea233d1f698d7c21cf8a16889".to_string(),
            ),
        },
        ModelFileSpec {
            id: "vision".to_string(),
            path: "mmproj-BF16.gguf".to_string(),
            url: format!(
                "https://huggingface.co/unsloth/gemma-4-E2B-it-qat-GGUF/resolve/{MODEL_REVISION}/mmproj-BF16.gguf"
            ),
            expected_bytes: 986_833_728,
            sha256: Some(
                "38b33846f56426cd650e0e574d78de125abdfcedf35c0d7f6929f6ffe26efe02".to_string(),
            ),
        },
        ModelFileSpec {
            id: "mtp".to_string(),
            path: "MTP/mtp-gemma-4-E2B-it-Q4_0.gguf".to_string(),
            url: format!(
                "https://huggingface.co/unsloth/gemma-4-E2B-it-qat-GGUF/resolve/{MODEL_REVISION}/MTP/mtp-gemma-4-E2B-it-Q4_0.gguf"
            ),
            expected_bytes: 59_235_648,
            sha256: Some(
                "586f2460b909008640981ec34060aa864e03c144fbabfb3173c4335087e4aae0".to_string(),
            ),
        },
    ],
});

/// A fresh clone of [`DEFAULT_MANIFEST`] (the compiled fallback).
pub fn default_manifest() -> ModelManifest {
    DEFAULT_MANIFEST.clone()
}

/// Parse an override manifest from JSON, validating the essential fields.
pub fn parse_manifest(json: &str) -> Result<ModelManifest> {
    let manifest: ModelManifest =
        serde_json::from_str(json).context("invalid model manifest JSON")?;
    if manifest.subdir.trim().is_empty() {
        return Err(anyhow!("model manifest 'subdir' must not be empty"));
    }
    for file in &manifest.files {
        if file.id.trim().is_empty() {
            return Err(anyhow!("model manifest file entry has an empty 'id'"));
        }
        if file.path.trim().is_empty() {
            return Err(anyhow!(
                "model manifest entry '{}' has an empty 'path'",
                file.id
            ));
        }
        if file.url.trim().is_empty() {
            return Err(anyhow!(
                "model manifest entry '{}' has an empty 'url'",
                file.id
            ));
        }
    }
    Ok(manifest)
}

/// Resolve the manifest: an override JSON when supplied (non-blank), else the
/// compiled default. `model_manifest_path` is the AppStore override key.
pub fn load_manifest(override_json: Option<&str>) -> Result<ModelManifest> {
    match override_json {
        Some(json) if !json.trim().is_empty() => parse_manifest(json),
        _ => Ok(default_manifest()),
    }
}

/// `<models_dir>/<manifest.subdir>` — the directory that holds the required files.
pub fn models_subdir(models_dir: &Path, manifest: &ModelManifest) -> PathBuf {
    models_dir.join(&manifest.subdir)
}

/// Absolute on-disk path for `spec` under `<models_dir>/<subdir>/<spec.path>`.
///
/// THE shared path rule (`features/setup`'s downloader and `features/llm_server`'s
/// launch-config resolver both derive from it — never re-implement the join).
pub fn file_path(models_dir: &Path, manifest: &ModelManifest, spec: &ModelFileSpec) -> PathBuf {
    models_subdir(models_dir, manifest).join(&spec.path)
}

/// Pure state classification for a path that is already on disk (or absent).
///
/// Absent ⇒ `Missing`; exact size ⇒ `Present`; oversize ⇒ `Error`; other IO
/// error ⇒ `Error`. The lookup uses the caller-supplied absolute path.
pub fn classify_file(path: &Path, spec: &ModelFileSpec) -> FileState {
    match std::fs::metadata(path) {
        Err(e) if e.kind() == ErrorKind::NotFound => FileState::Missing,
        Err(_) => FileState::Error,
        Ok(meta) => {
            let len = meta.len();
            if len == spec.expected_bytes {
                FileState::Present
            } else if len > spec.expected_bytes {
                FileState::Error
            } else {
                FileState::Missing
            }
        }
    }
}

/// Build the full per-file status (state + bytes + shortfall detail + abs path).
pub fn describe_file(
    models_dir: &Path,
    manifest: &ModelManifest,
    spec: &ModelFileSpec,
) -> ModelFileStatus {
    let absolute = file_path(models_dir, manifest, spec);
    let relative_path = format!("{}/{}", manifest.subdir, spec.path);
    // ONE classification rule (NFR-6): reuse `classify_file` for the `state`
    // instead of re-deriving the size gate here.
    let state = classify_file(&absolute, spec);

    let (downloaded_bytes, detail, exists) = match std::fs::metadata(&absolute) {
        Err(e) if e.kind() == ErrorKind::NotFound => (0, None, false),
        Err(e) => (0, Some(format!("Could not inspect file: {e}")), false),
        Ok(meta) => {
            let len = meta.len();
            if state == FileState::Present {
                (len, None, true)
            } else if len > spec.expected_bytes {
                (
                    len,
                    Some(format!(
                        "Unexpected size — {len} of {} bytes",
                        spec.expected_bytes
                    )),
                    true,
                )
            } else {
                (
                    len,
                    Some(format!("Incomplete — {len} of {} bytes", spec.expected_bytes)),
                    true,
                )
            }
        }
    };

    ModelFileStatus {
        id: spec.id.clone(),
        filename: spec.filename().to_string(),
        relative_path,
        state,
        downloaded_bytes,
        expected_bytes: spec.expected_bytes,
        detail,
        path: if exists {
            Some(absolute.to_string_lossy().into_owned())
        } else {
            None
        },
    }
}

/// Probe every required file in manifest order (`model` → `vision` → `mtp`).
pub fn probe_files(models_dir: &Path, manifest: &ModelManifest) -> Vec<ModelFileStatus> {
    manifest
        .files
        .iter()
        .map(|spec| describe_file(models_dir, manifest, spec))
        .collect()
}

/// Every required file that is NOT present (missing or errored) — the AC3
/// "name the missing file(s)" list.
pub fn missing_files(models_dir: &Path, manifest: &ModelManifest) -> Vec<ModelFileStatus> {
    probe_files(models_dir, manifest)
        .into_iter()
        .filter(|status| status.state != FileState::Present)
        .collect()
}

/// The step is complete **iff** every required file is `present` AND the manifest
/// declares at least one file. An empty/misconfigured manifest is never complete.
pub fn is_step_complete(models_dir: &Path, manifest: &ModelManifest) -> bool {
    !manifest.files.is_empty() && missing_files(models_dir, manifest).is_empty()
}

/// Resolve the configured `models_dir` from AppStore, falling back to
/// `{home}/fredo-models`. Shared by BOTH features (one rule).
pub fn resolve_models_dir(app: &AppHandle) -> PathBuf {
    let configured = app
        .state::<Arc<AppStore>>()
        .get(MODELS_DIR_KEY)
        .ok()
        .flatten();
    if let Some(dir) = configured {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    app.path()
        .home_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("fredo-models")
}

/// Resolve the acquisition manifest: the AppStore `model_manifest_path` JSON
/// override when present and valid, else the compiled [`default_manifest`].
/// An invalid override never breaks the probe — it logs and falls back.
pub fn resolve_manifest(app: &AppHandle) -> ModelManifest {
    let override_json = app
        .state::<Arc<AppStore>>()
        .get(MODEL_MANIFEST_PATH_KEY)
        .ok()
        .flatten();
    match load_manifest(override_json.as_deref()) {
        Ok(manifest) => manifest,
        Err(error) => {
            tracing::warn!(
                "invalid {MODEL_MANIFEST_PATH_KEY} override — using the compiled default manifest: {error}"
            );
            default_manifest()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_manifest_layout_is_the_pinned_three_files_in_the_shared_subdir() {
        let manifest = default_manifest();
        assert_eq!(manifest.subdir, MODEL_SUBDIR);
        let ids: Vec<&str> = manifest.files.iter().map(|spec| spec.id.as_str()).collect();
        assert_eq!(ids, vec!["model", "vision", "mtp"]);
        let paths: Vec<&str> = manifest.files.iter().map(|spec| spec.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf",
                "mmproj-BF16.gguf",
                "MTP/mtp-gemma-4-E2B-it-Q4_0.gguf",
            ]
        );
    }

    /// The shared path builder is the ONE rule both features resolve through.
    #[test]
    fn file_path_resolves_under_models_dir_and_the_shared_subdir() {
        let manifest = default_manifest();
        let models_dir = Path::new("C:/fredo-models");

        assert_eq!(models_subdir(models_dir, &manifest), models_dir.join(MODEL_SUBDIR));

        for spec in &manifest.files {
            assert_eq!(
                file_path(models_dir, &manifest, spec),
                models_dir.join(MODEL_SUBDIR).join(&spec.path)
            );
        }

        // The MTP draft file keeps its nested `MTP/` segment.
        assert_eq!(
            file_path(models_dir, &manifest, &manifest.files[2]),
            models_dir
                .join(MODEL_SUBDIR)
                .join("MTP")
                .join("mtp-gemma-4-E2B-it-Q4_0.gguf")
        );
    }
}
