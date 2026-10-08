//! One-shot, idempotent removal of the legacy on-device sherpa STT model
//! (Spec #2914, SA-12/SA-13; NFR-3).
//!
//! The local `sherpa-onnx` speech engine was deleted in #2914, so a machine that
//! previously downloaded its model still carries dead artifacts under
//! `<models_dir>/<LEGACY_STT_MODEL_SUBDIR>`. This module owns the ONE cleanup
//! rule: [`remove_legacy_stt_model_dir`] deletes EXACTLY that path — called once,
//! off the startup critical path, from `lib.rs` setup.
//!
//! **Blast radius (NFR-3, binding).** The target is the single derived path
//! `models_dir.join(LEGACY_STT_MODEL_SUBDIR)` — never the parent, a sibling, a
//! glob, or a recursive walk of `models_dir`. An absent path is a no-op that
//! surfaces no error; every failure is logged and the function never panics.
//! The cleanup is un-gated and idempotent (no completion marker), so a restart
//! on an upgraded machine is the live trigger.

use std::path::Path;

/// The ONE legacy STT model subdirectory this module may ever remove.
///
/// This module is the sole owner of the literal: nothing else in the tree may
/// reconstruct or glob the retired layout.
pub const LEGACY_STT_MODEL_SUBDIR: &str = "sherpa-onnx-streaming-zipformer-en-2023-06-26";

/// Outcome of a cleanup attempt.
///
/// `Removed` means the legacy path was removed by THIS call. `Absent` means
/// nothing was removed: either the path did not exist (the idempotent no-op) or
/// the removal failed and was logged (never a surfaced error, never a panic).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LegacySttCleanup {
    /// No path was removed and no error is surfaced.
    Absent,
    /// The legacy path existed and was removed.
    Removed,
}

/// Remove EXACTLY `models_dir.join(LEGACY_STT_MODEL_SUBDIR)`.
///
/// - a directory (the shipped layout) -> [`std::fs::remove_dir_all`]
/// - a file (a legacy artifact variant) -> [`std::fs::remove_file`]
/// - absent -> [`LegacySttCleanup::Absent`] (no-op, no error)
/// - any error -> logged, returns [`LegacySttCleanup::Absent`]; never panics and
///   never touches another path.
///
/// The classification reads [`std::fs::symlink_metadata`], so a symlink is
/// removed as a link — the cleanup never follows it out of `models_dir`.
pub fn remove_legacy_stt_model_dir(models_dir: &Path) -> LegacySttCleanup {
    let target = models_dir.join(LEGACY_STT_MODEL_SUBDIR);

    let file_type = match std::fs::symlink_metadata(&target) {
        Ok(metadata) => metadata.file_type(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return LegacySttCleanup::Absent;
        }
        Err(error) => {
            tracing::warn!(
                target: "fredo::setup",
                path = %target.display(),
                error = %error,
                "legacy STT model cleanup could not inspect the path"
            );
            return LegacySttCleanup::Absent;
        }
    };

    let removal = if file_type.is_dir() {
        std::fs::remove_dir_all(&target)
    } else {
        std::fs::remove_file(&target)
    };

    match removal {
        Ok(()) => {
            tracing::info!(
                target: "fredo::setup",
                path = %target.display(),
                "removed the legacy sherpa STT model"
            );
            LegacySttCleanup::Removed
        }
        Err(error) => {
            tracing::warn!(
                target: "fredo::setup",
                path = %target.display(),
                error = %error,
                "legacy STT model cleanup failed — leaving the path untouched"
            );
            LegacySttCleanup::Absent
        }
    }
}

#[cfg(test)]
mod tests {
    //! Hermetic blast-radius pins over `tempfile` tempdirs: the legacy path is
    //! removed (directory OR file artifact), every sibling is byte-unchanged, an
    //! absent path is a silent no-op, and a locked path is reported without a
    //! panic and without a teardown. No real `models_dir` is ever read.

    use super::*;

    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    /// Every FILE under `root`, keyed by its path relative to `root`, with its
    /// bytes — the blast-radius oracle. After a cleanup ONLY the legacy path may
    /// differ; every other entry must be byte-identical.
    fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut files = BTreeMap::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                let path = entry.path();
                if file_type.is_dir() {
                    stack.push(path);
                } else {
                    let bytes = std::fs::read(&path).unwrap_or_default();
                    let relative = path
                        .strip_prefix(root)
                        .map(Path::to_path_buf)
                        .unwrap_or_else(|_| path.clone());
                    files.insert(relative, bytes);
                }
            }
        }
        files
    }

    /// The snapshot with every legacy-path entry dropped — what MUST survive.
    fn surviving(before: &BTreeMap<PathBuf, Vec<u8>>) -> BTreeMap<PathBuf, Vec<u8>> {
        before
            .iter()
            .filter(|(path, _)| !path.starts_with(Path::new(LEGACY_STT_MODEL_SUBDIR)))
            .map(|(path, bytes)| (path.clone(), bytes.clone()))
            .collect()
    }

    #[test]
    fn removes_the_legacy_directory_and_leaves_every_sibling_byte_unchanged() {
        let root = tempfile::tempdir().expect("tempdir");
        let legacy = root.path().join(LEGACY_STT_MODEL_SUBDIR);
        std::fs::create_dir_all(legacy.join("nested")).expect("legacy dir");
        std::fs::write(legacy.join("nested").join("model.onnx"), b"dead-sherpa-bytes")
            .expect("legacy file");
        std::fs::write(legacy.join("tokens.txt"), b"tokens").expect("legacy file");

        // Unrelated siblings in the SAME parent: a like-named backup (a glob
        // would catch it), the surviving QAT model dir, and a plain file.
        let backup = root.path().join(format!("{LEGACY_STT_MODEL_SUBDIR}-backup"));
        std::fs::create_dir_all(&backup).expect("backup dir");
        std::fs::write(backup.join("keep.bin"), b"keep-me").expect("backup file");
        let qat = root.path().join("gemma-4-e2b-it-qat");
        std::fs::create_dir_all(&qat).expect("qat dir");
        std::fs::write(qat.join("model.gguf"), b"gguf-bytes").expect("qat file");
        std::fs::write(root.path().join("other.txt"), b"other").expect("sibling file");

        let before = snapshot(root.path());
        let expected = surviving(&before);
        assert!(
            before.len() > expected.len(),
            "the fixture seeds at least one legacy file to remove"
        );

        let outcome = remove_legacy_stt_model_dir(root.path());

        assert_eq!(outcome, LegacySttCleanup::Removed);
        assert!(!legacy.exists(), "the legacy model directory is gone");
        assert!(root.path().exists(), "the parent models_dir is never removed");
        assert_eq!(
            snapshot(root.path()),
            expected,
            "only the legacy subdir changed; every sibling is byte-identical"
        );
    }

    #[test]
    fn removes_a_legacy_file_artifact_and_touches_nothing_else() {
        let root = tempfile::tempdir().expect("tempdir");
        let legacy_file = root.path().join(LEGACY_STT_MODEL_SUBDIR);
        std::fs::write(&legacy_file, b"legacy-file-artifact").expect("legacy file");
        std::fs::write(root.path().join("keep.txt"), b"keep").expect("sibling file");

        let before = snapshot(root.path());
        let expected = surviving(&before);

        let outcome = remove_legacy_stt_model_dir(root.path());

        assert_eq!(outcome, LegacySttCleanup::Removed);
        assert!(!legacy_file.exists(), "the legacy file artifact is gone");
        assert_eq!(
            snapshot(root.path()),
            expected,
            "a file artifact removal touches no sibling"
        );
    }

    #[test]
    fn an_absent_legacy_path_is_a_noop_with_no_error() {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::write(root.path().join("keep.txt"), b"keep").expect("sibling file");
        let before = snapshot(root.path());

        let outcome = remove_legacy_stt_model_dir(root.path());

        assert_eq!(outcome, LegacySttCleanup::Absent);
        assert_eq!(
            snapshot(root.path()),
            before,
            "an absent legacy path is a no-op that touches nothing"
        );
    }

    #[test]
    fn an_absent_models_dir_is_a_noop_with_no_error() {
        let root = tempfile::tempdir().expect("tempdir");
        let missing = root.path().join("no-such-models-dir");

        let outcome = remove_legacy_stt_model_dir(&missing);

        assert_eq!(outcome, LegacySttCleanup::Absent);
        assert!(!missing.exists(), "cleanup never creates the models dir");
    }

    /// Windows-only: deny every other opener (share mode 0) so the child file
    /// cannot be deleted and `remove_dir_all` fails. The cleanup must return
    /// instead of panicking, must not report `Removed`, and must leave the path
    /// as it was. The target holds ONLY the locked file, so a partial teardown
    /// is unobservable: if the directory survives, nothing was removed.
    #[cfg(windows)]
    #[test]
    fn a_locked_legacy_path_is_reported_absent_and_never_torn_down() {
        use std::os::windows::fs::OpenOptionsExt;

        let root = tempfile::tempdir().expect("tempdir");
        let legacy = root.path().join(LEGACY_STT_MODEL_SUBDIR);
        std::fs::create_dir_all(&legacy).expect("legacy dir");
        let locked = legacy.join("locked.bin");
        std::fs::write(&locked, b"locked-bytes").expect("seed locked file");

        // Read the bytes BEFORE locking: the share-mode-0 handle denies a fresh
        // opener (including this test's own later `read`), so the byte check
        // runs after the guard is dropped.
        let expected = std::fs::read(&locked).expect("read the seeded file");

        let guard = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&locked)
            .expect("lock the child file");

        let outcome = remove_legacy_stt_model_dir(root.path());

        assert_eq!(
            outcome,
            LegacySttCleanup::Absent,
            "a failed removal is never reported as Removed"
        );
        assert!(legacy.exists(), "the locked legacy directory survives");
        assert!(locked.exists(), "the locked child file survives");

        drop(guard);

        assert_eq!(
            std::fs::read(&locked).expect("read the locked file"),
            expected,
            "the locked child file is byte-unchanged"
        );
    }
}
