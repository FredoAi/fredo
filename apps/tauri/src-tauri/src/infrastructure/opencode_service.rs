//! Infrastructure/opencode_service — the ONE **install-file** rule both setup
//! paths call (Spec #3198; Names Block).
//!
//! **Why a module of its own.** There are TWO copy sites — the in-app setup
//! wizard (`applications::setup::commands`) and the `fredo setup
//! --install-plugin` CLI twin (`infrastructure::cli::commands::setup`) — and
//! `docs/ENGINEERING_RULES.md` forbids the application-to-application import a
//! per-surface copy would need. So the hash-guarded write lives here, once, and
//! both call it; a guard written twice would diverge exactly as the two install
//! paths did before.
//!
//! **Setup does not manage OpenCode's background service.** There is no probe,
//! no trigger and no lifecycle verb here: the install writes one file and
//! touches nothing else. The runtime loads the installed global plugin itself —
//! a copy written while a server is already running is picked up by that server
//! (round 2's controls: F-17(a) installed → captured, F-17(a′) a server started
//! *before* the write captured too, span count 6 → 8). Round 3 removed the
//! install-time restart its earlier premise implied, so no process is signalled,
//! restarted or terminated, no environment variable is written, and no turn in
//! progress can be interrupted by an install.
//!
//! **Idempotent, hash-guarded write.** [`install_plugin_file`] compares SHA-256
//! digests and writes **only** when the destination is absent or differs, then
//! stamps the install instant. A second identical run writes nothing and leaves
//! the file's timestamp untouched — that is what keeps NFR-1 (setup is
//! idempotent) intact.

use std::path::Path;
use std::time::SystemTime;

use sha2::{Digest, Sha256};

// ── The hash-guarded write (ONE rule for both install paths) ─────────────────

/// Copy `artifact` to `destination`, writing **only** when the bytes differ.
/// Returns `true` when this call wrote bytes.
///
/// One rule, because there are TWO copy sites (`applications::setup::commands`
/// and `infrastructure::cli::commands::setup`) and a guard written twice would
/// diverge. The digest comparison is what lets an unchanged install be a no-op:
/// no write, no mtime churn.
///
/// The install instant is stamped onto the destination only after a real write:
/// `std::fs::copy`/`write` leave the SOURCE's timestamp on Windows, so an
/// unstamped destination would carry `dist/index.js`'s build time.
///
/// The destination's **directory** is the caller's: both install paths create it
/// on their success path only, so a gated run still leaves no directory behind
/// (R-1c) and this function stays one responsibility.
pub fn install_plugin_file(artifact: &Path, destination: &Path) -> Result<bool, String> {
    let bytes = std::fs::read(artifact)
        .map_err(|e| format!("could not read {} ({e})", artifact.display()))?;
    let digest = sha256(&bytes);

    // A destination that cannot be read is "absent" for this decision: writing is
    // the safe outcome, and the write itself reports any real failure.
    let unchanged = std::fs::read(destination)
        .map(|existing| sha256(&existing) == digest)
        .unwrap_or(false);
    if unchanged {
        return Ok(false);
    }

    std::fs::write(destination, &bytes)
        .map_err(|e| format!("could not write {} ({e})", destination.display()))?;
    stamp_install_instant(destination);
    Ok(true)
}

/// The SHA-256 of `bytes` — the idempotency guard's whole input.
fn sha256(bytes: &[u8]) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().to_vec()
}

/// Stamp the install instant on the destination.
///
/// A stamp failure is reported and does **not** fail the install: the bytes are
/// already correct on disk and the idempotency guard is the digest, so the
/// timestamp is an anchor for readers, not a correctness input.
fn stamp_install_instant(destination: &Path) {
    let stamped = std::fs::File::options()
        .write(true)
        .open(destination)
        .and_then(|file| file.set_modified(SystemTime::now()));
    if let Err(error) = stamped {
        tracing::warn!(
            "could not stamp the install instant on {}: {error}",
            destination.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

    // ── the hash-guarded write ──────────────────────────────────────────────

    fn write_file(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create the parent dir");
        }
        fs::write(path, contents).expect("write the fixture");
    }

    /// Stamp `path` an hour into the past — the fixture that makes the install
    /// instant's receipt discriminating (`fs::copy` would carry this time over).
    fn stamp_into_the_past(path: &Path) {
        fs::File::options()
            .write(true)
            .open(path)
            .expect("open the fixture")
            .set_modified(SystemTime::now() - Duration::from_secs(3_600))
            .expect("stamp the fixture into the past");
    }

    /// absent → written; identical → NOT written (mtime untouched); different →
    /// written with the new bytes. The mtime cell is the anchor's receipt: the
    /// destination must carry the INSTALL instant, never the artifact's time.
    #[test]
    fn the_hash_guarded_write_writes_only_when_the_bytes_differ() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let artifact = dir.path().join("dist").join("index.js");
        let destination = dir.path().join("plugins").join("fredo.js");
        // Both install paths create the plugins directory on their success path
        // before calling the shared write rule.
        fs::create_dir_all(destination.parent().expect("the plugins dir")).expect("create plugins dir");

        // (1) absent destination → written.
        write_file(&artifact, "// bundle v1");
        assert_eq!(install_plugin_file(&artifact, &destination), Ok(true));
        assert_eq!(
            fs::read_to_string(&destination).expect("read the installed bundle"),
            "// bundle v1"
        );

        // (2) identical bytes → no write, and the destination's mtime is
        // untouched (a rewrite would move it).
        let before = fs::metadata(&destination)
            .expect("metadata")
            .modified()
            .expect("mtime");
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(
            install_plugin_file(&artifact, &destination),
            Ok(false),
            "an identical re-install writes nothing (NFR-1)"
        );
        assert_eq!(
            fs::metadata(&destination)
                .expect("metadata")
                .modified()
                .expect("mtime"),
            before,
            "the idempotent path must not touch the file at all"
        );

        // (3) different bytes → written, and the destination carries the INSTALL
        // instant rather than the artifact's own (the `fs::copy` mtime trap).
        write_file(&artifact, "// bundle v2");
        stamp_into_the_past(&artifact);
        let artifact_mtime = fs::metadata(&artifact)
            .expect("metadata")
            .modified()
            .expect("mtime");
        assert!(
            artifact_mtime < SystemTime::now() - Duration::from_secs(60),
            "the fixture artifact is in the past: {artifact_mtime:?}"
        );

        assert_eq!(install_plugin_file(&artifact, &destination), Ok(true));
        assert_eq!(
            fs::read_to_string(&destination).expect("read the installed bundle"),
            "// bundle v2"
        );
        let destination_mtime = fs::metadata(&destination)
            .expect("metadata")
            .modified()
            .expect("mtime");
        assert!(
            destination_mtime > artifact_mtime,
            "the install instant is stamped on the destination, not copied from the artifact: \
             destination {destination_mtime:?} vs artifact {artifact_mtime:?}"
        );
    }

    /// A missing artifact fails loud instead of writing an empty file.
    #[test]
    fn a_missing_artifact_is_an_error_and_writes_nothing() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let artifact = dir.path().join("dist").join("index.js");
        let destination = dir.path().join("plugins").join("fredo.js");

        let error = install_plugin_file(&artifact, &destination)
            .expect_err("a missing artifact is never a silent skip");
        assert!(error.contains("index.js"), "names the artifact: {error}");
        assert!(
            !destination.exists(),
            "no destination is written when the artifact is missing"
        );
    }

    /// G-430 absence guard: this module carries **no direct termination path** —
    /// and, since round 3, no lifecycle verb at all. The raw source is scanned
    /// (comments and doc comments included, because the AC's predicate is a raw
    /// grep) and every banned token is CONSTRUCTED here so the guard cannot match
    /// its own text.
    #[test]
    fn the_module_carries_no_direct_process_termination() {
        let source = include_str!("opencode_service.rs");

        // Non-vacuity: the universe is the real file and the matcher fires on a
        // token that IS present (the surviving rule this module owns).
        assert!(
            source.len() > 2_000,
            "the scan universe is the whole module ({} bytes)",
            source.len()
        );
        assert!(
            source.contains("install_plugin_file"),
            "the matcher fires on a token that is present"
        );

        let banned = [
            ["task", "kill"].concat(),
            ["service", " ", "stop"].concat(),
            ["child", ".", "kill"].concat(),
        ];
        for token in &banned {
            assert!(
                !source.contains(token.as_str()),
                "the install is a file write only — no lifecycle action: {token}"
            );
        }
    }
}
