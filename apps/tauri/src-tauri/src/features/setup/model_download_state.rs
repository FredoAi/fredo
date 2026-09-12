//! Required-file model for Companion model acquisition (Spec #2856, ST-1).
//!
//! The implementation moved to [`crate::infrastructure::companion::models`] in
//! Spec #2857 ST-9 so `features/setup` and `features/llm_server` share the same
//! layout and presence rule (NFR-6; no cross-feature import). This module
//! re-exports the moved model — the #2856 download state's wire and behavior are
//! unchanged.
//!
//! **Verification contract (binding):** `present` is the exact byte-size gate
//! (`on-disk len == expectedBytes`) for BOTH downloaded and manually-placed files.
//! `0 < size < expected` classifies as `missing` with a shortfall detail;
//! `size > expected` classifies as `error`. SHA-256 is NOT computed here — manual
//! files are size-gated only (3.67 GB must not be re-read on every probe); the
//! download path verifies the streaming hash itself.

pub use crate::infrastructure::companion::models::{
    default_manifest, describe_file, file_path, is_step_complete, probe_files, FileState,
    ModelFileSpec, ModelFileStatus, ModelManifest,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::companion::models::{
        classify_file, load_manifest, missing_files, parse_manifest, MODEL_REVISION, MODEL_SUBDIR,
    };
    use std::path::Path;

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
