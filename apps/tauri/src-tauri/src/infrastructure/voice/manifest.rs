//! STT (speech-to-text) model manifest (Spec #2876, ST-2).
//!
//! Reuses the shared [`ModelFileSpec`] / [`ModelManifest`] vocabulary from
//! [`crate::infrastructure::companion::models`] so the streamed download +
//! SHA-256 verify engine (`features::setup::model_download`) is the ONE
//! acquisition rule for both the companion GGUF set and the STT model set
//! (NFR-6). This module owns only the STT pins — the companion
//! `DEFAULT_MANIFEST` / `MODEL_SUBDIR` / `MODEL_REVISION` are untouched.
//!
//! Every pin below was verified live against the Hugging Face resolve endpoint
//! by ST-0 (byte counts + SHA-256; `.opencode/tmp/2876/st-0-verification.md`).
//! The engine consuming these files (`sherpa-onnx` `OnlineRecognizer`) is added
//! by ST-3; this module is engine-agnostic.

use std::sync::LazyLock;

use crate::infrastructure::companion::models::{ModelFileSpec, ModelManifest};

/// Fixed disk layout subfolder for the STT model set — distinct from the
/// companion GGUF `MODEL_SUBDIR` (which this slice MUST NOT touch).
pub const STT_SUBDIR: &str = "sherpa-onnx-streaming-zipformer-en-2023-06-26";

/// Hugging Face revision pinned for reproducible bytes; every compiled URL
/// resolves against it.
pub const STT_REVISION: &str = "672fbf1b30579d6585301139bb363f42a0ad4a24";

/// Base URL form: `https://huggingface.co/csukuangfj/<STT_SUBDIR>/resolve/<STT_REVISION>/<path>`.
pub const STT_HF_REPO: &str = "csukuangfj";

/// The compiled STT manifest — the four pinned files of the streaming Zipformer
/// EN int8 set, ordered tokens → encoder → decoder → joiner. Total expected
/// bytes: **72,654,782**.
pub static STT_DEFAULT_MANIFEST: LazyLock<ModelManifest> = LazyLock::new(|| ModelManifest {
    revision: STT_REVISION.to_string(),
    subdir: STT_SUBDIR.to_string(),
    files: vec![
        ModelFileSpec {
            id: "sttTokens".to_string(),
            path: "tokens.txt".to_string(),
            url: format!(
                "https://huggingface.co/{STT_HF_REPO}/{STT_SUBDIR}/resolve/{STT_REVISION}/tokens.txt"
            ),
            expected_bytes: 5_048,
            sha256: Some(
                "49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb".to_string(),
            ),
        },
        ModelFileSpec {
            id: "sttEncoder".to_string(),
            path: "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx".to_string(),
            url: format!(
                "https://huggingface.co/{STT_HF_REPO}/{STT_SUBDIR}/resolve/{STT_REVISION}/encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx"
            ),
            expected_bytes: 71_083_163,
            sha256: Some(
                "563fde436d16cf7607cf408cd6b30909819d03162652ef389c2450ced3f45ac1".to_string(),
            ),
        },
        ModelFileSpec {
            id: "sttDecoder".to_string(),
            path: "decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx".to_string(),
            url: format!(
                "https://huggingface.co/{STT_HF_REPO}/{STT_SUBDIR}/resolve/{STT_REVISION}/decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx"
            ),
            expected_bytes: 1_307_236,
            sha256: Some(
                "98da299f471e38bb4e1a8df579b8cc9122d6039576a77e357b3c60f17dd83b02".to_string(),
            ),
        },
        ModelFileSpec {
            id: "sttJoiner".to_string(),
            path: "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx".to_string(),
            url: format!(
                "https://huggingface.co/{STT_HF_REPO}/{STT_SUBDIR}/resolve/{STT_REVISION}/joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx"
            ),
            expected_bytes: 259_335,
            sha256: Some(
                "d944208d660d67c8d72cd2acaeac971fa5ceb8c80e76c1968148846fedd6e297".to_string(),
            ),
        },
    ],
});

/// The total pinned byte count of the STT model set (computed from the pins so
/// the two can never drift).
pub const STT_TOTAL_BYTES: u64 = 72_654_782;

/// A fresh clone of [`STT_DEFAULT_MANIFEST`] — the STT acquisition manifest.
pub fn resolve_stt_manifest() -> ModelManifest {
    STT_DEFAULT_MANIFEST.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::companion::models::{
        classify_file, describe_file, file_path, is_step_complete, FileState,
    };
    use std::path::Path;

    #[test]
    fn stt_default_manifest_is_the_pinned_four_file_set() {
        let manifest = resolve_stt_manifest();
        assert_eq!(manifest.revision, STT_REVISION);
        assert_eq!(manifest.subdir, STT_SUBDIR);

        let ids: Vec<&str> = manifest.files.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, vec!["sttTokens", "sttEncoder", "sttDecoder", "sttJoiner"]);

        let paths: Vec<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "tokens.txt",
                "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
                "decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
                "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
            ]
        );

        let sizes: Vec<u64> = manifest.files.iter().map(|f| f.expected_bytes).collect();
        assert_eq!(sizes, vec![5_048, 71_083_163, 1_307_236, 259_335]);
    }

    #[test]
    fn stt_total_bytes_is_the_pinned_sum() {
        let manifest = resolve_stt_manifest();
        let total: u64 = manifest.files.iter().map(|f| f.expected_bytes).sum();
        assert_eq!(total, 72_654_782);
        assert_eq!(total, STT_TOTAL_BYTES);
    }

    #[test]
    fn stt_sha256_pins_are_lowercase_hex_64_chars() {
        let manifest = resolve_stt_manifest();
        for file in &manifest.files {
            let sha = file
                .sha256
                .as_deref()
                .unwrap_or_else(|| panic!("{} must pin a sha256", file.id));
            assert_eq!(sha.len(), 64, "{} sha length", file.id);
            assert!(
                sha.chars()
                    .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)),
                "{} sha must be lowercase hex: {sha}",
                file.id
            );
        }
    }

    #[test]
    fn stt_urls_pin_the_hf_repo_revision_and_subdir() {
        let manifest = resolve_stt_manifest();
        let base =
            format!("https://huggingface.co/{STT_HF_REPO}/{STT_SUBDIR}/resolve/{STT_REVISION}/");
        for file in &manifest.files {
            assert_eq!(file.url, format!("{base}{}", file.path));
            assert!(file.url.contains(STT_REVISION), "{} url must pin the revision", file.id);
            assert!(file.url.contains(STT_SUBDIR), "{} url must pin the subdir", file.id);
        }
    }

    /// The presence gate reuses the shared exact-size `classify_file` rule
    /// (NFR-6) — no duplicated size logic in the voice module.
    #[test]
    fn classify_file_presence_gate_uses_the_pinned_stt_sizes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = resolve_stt_manifest();

        // Absent everywhere → the whole set is missing.
        for spec in &manifest.files {
            assert_eq!(
                classify_file(&file_path(dir.path(), &manifest, spec), spec),
                FileState::Missing,
                "{} must classify Missing before any file exists",
                spec.id
            );
        }
        assert!(!is_step_complete(dir.path(), &manifest));

        // Seed tokens.txt at its exact pinned size → Present.
        let tokens = &manifest.files[0];
        let tokens_path = file_path(dir.path(), &manifest, tokens);
        std::fs::create_dir_all(tokens_path.parent().expect("parent")).expect("mkdir");
        let file = std::fs::File::create(&tokens_path).expect("create");
        file.set_len(tokens.expected_bytes).expect("set_len");
        drop(file);

        assert_eq!(classify_file(&tokens_path, tokens), FileState::Present);
        let status = describe_file(dir.path(), &manifest, tokens);
        assert_eq!(status.state, FileState::Present);
        assert_eq!(status.downloaded_bytes, 5_048);

        // The remaining three are still Missing and the set is not complete.
        assert!(!is_step_complete(dir.path(), &manifest));
        for spec in &manifest.files[1..] {
            assert_eq!(
                describe_file(dir.path(), &manifest, spec).state,
                FileState::Missing
            );
        }

        // A truncated tokens.txt is NOT present (still Missing).
        let truncated = std::fs::File::create(&tokens_path).expect("recreate");
        truncated.set_len(5_047).expect("set_len truncated");
        drop(truncated);
        assert_eq!(classify_file(&tokens_path, tokens), FileState::Missing);
    }

    /// The manifest resolves through the shared path rule under
    /// `<models_dir>/<STT_SUBDIR>/<path>` — never a hand-rolled join.
    #[test]
    fn stt_files_resolve_under_the_shared_subdir_layout() {
        let manifest = resolve_stt_manifest();
        let models_dir = Path::new("C:/fredo-models");
        for spec in &manifest.files {
            assert_eq!(
                file_path(models_dir, &manifest, spec),
                models_dir.join(STT_SUBDIR).join(&spec.path)
            );
        }
    }
}
