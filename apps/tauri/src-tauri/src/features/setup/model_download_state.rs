//! Pure required-file model for Companion model acquisition (Spec #2856, ST-1).
//!
//! This module is the single source of truth for the three required model files
//! (paths / URLs / expected byte sizes / optional pinned SHA-256), the honest
//! on-disk classifier, and the "step is complete" aggregator. It is deliberately
//! free of network I/O, file writes, and Tauri types so it can be unit-tested in
//! isolation and reused verbatim by the streamed download engine ([`super::model_download`]).
//!
//! **Verification contract (binding):** `present` is the exact byte-size gate
//! (`on-disk len == expectedBytes`) for BOTH downloaded and manually-placed files.
//! `0 < size < expected` classifies as `missing` with a shortfall detail;
//! `size > expected` classifies as `error`. SHA-256 is NOT computed here — manual
//! files are size-gated only (3.67 GB must not be re-read on every probe); the
//! download path verifies the streaming hash itself.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

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
/// compiled default. ST-3 wires the AppStore `model_manifest_path` key here.
pub fn load_manifest(override_json: Option<&str>) -> Result<ModelManifest> {
    match override_json {
        Some(json) if !json.trim().is_empty() => parse_manifest(json),
        _ => Ok(default_manifest()),
    }
}

/// Absolute on-disk path for `spec` under `<models_dir>/<subdir>/<spec.path>`.
pub fn file_path(models_dir: &Path, manifest: &ModelManifest, spec: &ModelFileSpec) -> PathBuf {
    models_dir.join(&manifest.subdir).join(&spec.path)
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

    let (state, downloaded_bytes, detail, exists) = match std::fs::metadata(&absolute) {
        Err(e) if e.kind() == ErrorKind::NotFound => (FileState::Missing, 0, None, false),
        Err(e) => (
            FileState::Error,
            0,
            Some(format!("Could not inspect file: {e}")),
            false,
        ),
        Ok(meta) => {
            let len = meta.len();
            if len == spec.expected_bytes {
                (FileState::Present, len, None, true)
            } else if len > spec.expected_bytes {
                (
                    FileState::Error,
                    len,
                    Some(format!(
                        "Unexpected size — {len} of {} bytes",
                        spec.expected_bytes
                    )),
                    true,
                )
            } else {
                (
                    FileState::Missing,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A small KB-scale manifest so tests never touch the 3.67 GB default.
    fn test_manifest(sizes: &[(&str, &str, u64)]) -> ModelManifest {
        ModelManifest {
            revision: "test-rev".to_string(),
            subdir: "test-sub".to_string(),
            files: sizes
                .iter()
                .map(|(id, path, expected)| ModelFileSpec {
                    id: (*id).to_string(),
                    path: (*path).to_string(),
                    url: format!("https://example.invalid/{path}"),
                    expected_bytes: *expected,
                    sha256: None,
                })
                .collect(),
        }
    }

    fn write_sized(path: &Path, len: u64) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent dir");
        }
        let file = std::fs::File::create(path).expect("create file");
        file.set_len(len).expect("set file length");
    }

    #[test]
    fn classify_absent_is_missing() {
        let spec = ModelFileSpec {
            id: "model".into(),
            path: "a.bin".into(),
            url: "https://example.invalid/a.bin".into(),
            expected_bytes: 10,
            sha256: None,
        };
        assert_eq!(
            classify_file(Path::new("does/not/exist/a.bin"), &spec),
            FileState::Missing
        );
    }

    #[test]
    fn classify_exact_size_is_present() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("a.bin");
        write_sized(&path, 10);
        let spec = ModelFileSpec {
            id: "model".into(),
            path: "a.bin".into(),
            url: "https://example.invalid/a.bin".into(),
            expected_bytes: 10,
            sha256: None,
        };
        assert_eq!(classify_file(&path, &spec), FileState::Present);
    }

    #[test]
    fn classify_truncated_is_missing_with_shortfall_detail() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = test_manifest(&[("model", "a.bin", 10)]);
        write_sized(&dir.path().join("test-sub").join("a.bin"), 4);

        let status = describe_file(dir.path(), &manifest, &manifest.files[0]);
        assert_eq!(status.state, FileState::Missing);
        assert_eq!(status.downloaded_bytes, 4);
        let detail = status.detail.expect("shortfall detail");
        assert!(detail.contains("Incomplete"), "detail was {detail:?}");
        assert!(detail.contains("4 of 10"), "detail was {detail:?}");
    }

    #[test]
    fn classify_zero_byte_file_is_missing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = test_manifest(&[("mtp", "MTP/m.bin", 10)]);
        write_sized(&dir.path().join("test-sub").join("MTP").join("m.bin"), 0);

        let status = describe_file(dir.path(), &manifest, &manifest.files[0]);
        assert_eq!(status.state, FileState::Missing);
        assert_eq!(status.downloaded_bytes, 0);
    }

    #[test]
    fn classify_oversize_is_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = test_manifest(&[("vision", "a.bin", 10)]);
        write_sized(&dir.path().join("test-sub").join("a.bin"), 11);

        let status = describe_file(dir.path(), &manifest, &manifest.files[0]);
        assert_eq!(status.state, FileState::Error);
        assert_eq!(status.downloaded_bytes, 11);
    }

    #[test]
    fn step_complete_only_when_all_present() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = test_manifest(&[
            ("model", "model.bin", 4),
            ("vision", "vision.bin", 5),
            ("mtp", "MTP/mtp.bin", 6),
        ]);
        let base = dir.path().join("test-sub");
        write_sized(&base.join("model.bin"), 4);
        write_sized(&base.join("vision.bin"), 5);
        write_sized(&base.join("MTP").join("mtp.bin"), 6);

        assert!(is_step_complete(dir.path(), &manifest));
        assert!(missing_files(dir.path(), &manifest).is_empty());
        assert!(probe_files(dir.path(), &manifest)
            .iter()
            .all(|s| s.state == FileState::Present));
    }

    #[test]
    fn two_of_three_is_never_complete_and_names_the_missing_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = test_manifest(&[
            ("model", "model.bin", 4),
            ("vision", "vision.bin", 5),
            ("mtp", "MTP/mtp.bin", 6),
        ]);
        let base = dir.path().join("test-sub");
        write_sized(&base.join("model.bin"), 4);
        write_sized(&base.join("vision.bin"), 5);

        assert!(!is_step_complete(dir.path(), &manifest));
        let missing = missing_files(dir.path(), &manifest);
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].id, "mtp");
        assert_eq!(missing[0].relative_path, "test-sub/MTP/mtp.bin");
    }

    #[test]
    fn truncated_file_is_never_complete_even_when_others_present() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = test_manifest(&[
            ("model", "model.bin", 4),
            ("vision", "vision.bin", 5),
            ("mtp", "MTP/mtp.bin", 6),
        ]);
        let base = dir.path().join("test-sub");
        write_sized(&base.join("model.bin"), 4);
        write_sized(&base.join("vision.bin"), 5);
        write_sized(&base.join("MTP").join("mtp.bin"), 1); // truncated

        assert!(!is_step_complete(dir.path(), &manifest));
        let missing = missing_files(dir.path(), &manifest);
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].id, "mtp");
    }

    #[test]
    fn extra_unrelated_file_does_not_satisfy_a_required_slot() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = test_manifest(&[("model", "model.bin", 4)]);
        let base = dir.path().join("test-sub");
        write_sized(&base.join("other.bin"), 4);

        assert!(!is_step_complete(dir.path(), &manifest));
        assert_eq!(missing_files(dir.path(), &manifest).len(), 1);
    }

    #[test]
    fn empty_manifest_is_never_complete() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = test_manifest(&[]);
        assert!(!is_step_complete(dir.path(), &manifest));
    }

    #[test]
    fn relative_path_and_filename_derivation() {
        let manifest = test_manifest(&[("mtp", "MTP/mtp-gemma-4-E2B-it-Q4_0.gguf", 6)]);
        let spec = &manifest.files[0];
        assert_eq!(spec.filename(), "mtp-gemma-4-E2B-it-Q4_0.gguf");
        let status = describe_file(Path::new("C:/models"), &manifest, spec);
        assert_eq!(
            status.relative_path,
            "test-sub/MTP/mtp-gemma-4-E2B-it-Q4_0.gguf"
        );
    }

    #[test]
    fn default_manifest_is_the_pinned_three_file_set() {
        let manifest = default_manifest();
        assert_eq!(manifest.revision, MODEL_REVISION);
        assert_eq!(manifest.subdir, MODEL_SUBDIR);
        assert_eq!(manifest.files.len(), 3);
        let ids: Vec<&str> = manifest.files.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, vec!["model", "vision", "mtp"]);
        assert_eq!(manifest.files[0].expected_bytes, 2_620_370_976);
        assert_eq!(manifest.files[1].expected_bytes, 986_833_728);
        assert_eq!(manifest.files[2].expected_bytes, 59_235_648);
        for file in &manifest.files {
            let sha = file.sha256.as_deref().expect("compiled default pins sha256");
            assert_eq!(sha.len(), 64);
            assert!(sha.chars().all(|c| c.is_ascii_hexdigit()));
            assert!(file.url.contains(MODEL_REVISION));
        }
    }

    #[test]
    fn parse_manifest_accepts_optional_sha256() {
        let json = r#"{
            "revision": "rev",
            "subdir": "test-sub",
            "files": [
                { "id": "model", "path": "a.bin", "url": "http://127.0.0.1/a.bin", "expectedBytes": 3 }
            ]
        }"#;
        let manifest = parse_manifest(json).expect("valid override");
        assert_eq!(manifest.files.len(), 1);
        assert_eq!(manifest.files[0].expected_bytes, 3);
        assert_eq!(manifest.files[0].sha256, None);
    }

    #[test]
    fn parse_manifest_rejects_empty_id_path_url() {
        let json = r#"{
            "subdir": "test-sub",
            "files": [
                { "id": "", "path": "a.bin", "url": "http://127.0.0.1/a.bin", "expectedBytes": 3 }
            ]
        }"#;
        assert!(parse_manifest(json).is_err());
    }

    #[test]
    fn load_manifest_falls_back_to_default_without_override() {
        let loaded = load_manifest(None).expect("default");
        assert_eq!(loaded.files.len(), 3);
        let blank = load_manifest(Some("   ")).expect("blank override uses default");
        assert_eq!(blank.files.len(), 3);
    }
}
