//! Embedded-PostgreSQL acquisition mode + integrity-pinned archive acquisition
//! (Spec #2978, S1/S2/S3).
//!
//! # Acquisition mode is build-time, never a runtime toggle (S1)
//!
//! The crate (`postgresql_embedded` 0.21) acquires the PostgreSQL distribution in
//! one of two ways, selected at **build** time by the `bundled` cargo build option
//! (`apps/tauri/src-tauri/Cargo.toml`):
//!
//! * **`runtime-download`** (the shipped default; `bundled` disabled) — the
//!   archive is fetched on first run and extracted into `<app_data_dir>`. The
//!   installer does not grow; the declared first-run price is
//!   [`PG_FIRST_RUN_DOWNLOAD_BYTES`].
//! * **`bundled`** — the archive is embedded in the binary at build time
//!   (`+`[`PG_INSTALLER_DELTA_BUNDLED_BYTES`] installer growth) and no runtime
//!   network is needed for the archive.
//!
//! [`ACQUISITION_MODE`] resolves this at compile time from `cfg!(feature =
//! "bundled")`; there is no runtime switch.
//!
//! # Integrity surface (S2/S3, AC2/AC4)
//!
//! On the `runtime-download` path the archive is acquired through Fredo's ONE
//! SHA-256-pinned streaming engine ([`acquire_pg_archive`] →
//! `infrastructure::companion::download::download_missing_files`): skip-if-verified,
//! HTTP `Range` resume seeded from the on-disk prefix, a streaming digest over the
//! whole file, delete-on-mismatch, and a bounded retry budget. A mismatch or a
//! network failure deletes/does not extract the artifact and returns an actionable
//! `[pg:archive] …` error, so the supervisor never extracts a partial
//! distribution. The engine is reused verbatim (NFR-6) — never forked.
//!
//! **`bundled` is OUTSIDE Fredo's integrity surface (AC4).** The `bundled` crate
//! build option makes the crate's `build.rs` fetch the archive from
//! `theseus-rs/postgresql-binaries` at build time; that fetch is not verified by a
//! Fredo-owned SHA-256 pin (the pin below covers only the `runtime-download`
//! artifact). It is bounded by the pinned version ([`PG_VERSION`]) and
//! `Cargo.lock`, but it is a documented supply-chain gap until it is replaced by a
//! SHA-pinned resource under Fredo's control. `bundled` is deliberately NOT the
//! default (see the Cargo build option table).
//!
//! # Test/QA induction seams (G-275; inert when unset)
//!
//! `FREDO_PG_ARCHIVE_URL` and `FREDO_PG_ARCHIVE_SHA256` override the pinned URL and
//! digest; `FREDO_PG_INSTALL_DIR` (owned by [`super`]) overrides the installation
//! directory the archive lands under. Each is inert when unset, so the default
//! path is byte-identical.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};

use crate::infrastructure::companion::download::{
    download_missing_files, DownloadProgress, ProgressReporter, ReqwestTransport, SystemClock,
};
use crate::infrastructure::companion::models::{ModelFileSpec, ModelManifest};

// ── Build-time acquisition mode (S1) ─────────────────────────────────────────

/// How the PostgreSQL distribution is acquired. Resolved at build time only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PgAcquisitionMode {
    /// Fetch + verify the archive on first run (the crate default; shipped default).
    RuntimeDownload,
    /// Compile-time-embedded archive; no runtime fetch.
    Bundled,
}

/// The ONE acquisition mode, resolved from the `bundled` cargo build option at compile
/// time. Never a runtime toggle.
pub const ACQUISITION_MODE: PgAcquisitionMode = if cfg!(feature = "bundled") {
    PgAcquisitionMode::Bundled
} else {
    PgAcquisitionMode::RuntimeDownload
};

// ── Priced declaration (AC1) ─────────────────────────────────────────────────

/// Declared first-run price of the `runtime-download` mode (bytes). This is the
/// #2948-declared first-run cost of the distribution; `bundled` moves the
/// acquisition point to build time.
pub const PG_FIRST_RUN_DOWNLOAD_BYTES: u64 = 164_026_008;
/// Installer growth of the `bundled` mode (the embedded archive, ~51.5 MiB).
pub const PG_INSTALLER_DELTA_BUNDLED_BYTES: u64 = 54_048_768;
/// Size of the pinned Windows x86_64 PostgreSQL archive (`OUT_DIR/postgresql.tar.gz`
/// for the `bundled` build — the SAME artifact the `runtime-download` path fetches).
pub const PG_BUNDLED_ARCHIVE_BYTES: u64 = 54_068_902;
/// Unpacked distribution size (~156 MiB) — identical in both modes (AC3).
pub const PG_EXTRACTED_PAYLOAD_BYTES: u64 = 164_026_008;
/// Steady-state data-dir regression baseline (~57.8 MiB) (AC5).
pub const PG_DATA_DIR_DELTA_BYTES: u64 = 60_565_072;

// ── The pinned archive (S2) ──────────────────────────────────────────────────

/// Pinned PostgreSQL release version (the crate `bundled`/`runtime-download` pin).
pub const PG_VERSION: &str = "18.6.0";
/// Pinned Windows x86_64 archive URL (the `theseus-rs/postgresql-binaries` release
/// the crate acquires from).
pub const PG_ARCHIVE_URL: &str = "https://github.com/theseus-rs/postgresql-binaries/releases/download/18.6.0/postgresql-18.6.0-x86_64-pc-windows-msvc.tar.gz";
/// SHA-256 of [`PG_ARCHIVE_URL`], captured from the release's published
/// `…tar.gz.sha256` at implementation time.
pub const PG_ARCHIVE_SHA256: &str =
    "7da44c2dbcda3b49688ea08ce8cf99cfe677adf565f53a9145bf9002c74db7d5";
/// Layout subdirectory under the installation dir that holds the staged archive.
pub const PG_ARCHIVE_SUBDIR: &str = "archives";
/// Staged archive filename (the crate's `postgresql.tar.gz`).
pub const PG_ARCHIVE_FILENAME: &str = "postgresql.tar.gz";

/// **G-275** induction seam: override the archive URL (point at an unreachable
/// endpoint to drive the first-run network-failure row). Inert when unset/blank.
pub const PG_ARCHIVE_URL_ENV: &str = "FREDO_PG_ARCHIVE_URL";
/// **G-275** induction seam: override the pinned digest (force a mismatch). Inert
/// when unset/blank.
pub const PG_ARCHIVE_SHA256_ENV: &str = "FREDO_PG_ARCHIVE_SHA256";

/// A non-blank environment value, trimmed; `None` when unset or blank.
fn non_blank_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// The effective archive URL: the non-blank [`PG_ARCHIVE_URL_ENV`] override, else
/// the pinned [`PG_ARCHIVE_URL`].
pub fn resolve_archive_url() -> String {
    non_blank_env(PG_ARCHIVE_URL_ENV).unwrap_or_else(|| PG_ARCHIVE_URL.to_string())
}

/// The effective pinned digest: the non-blank [`PG_ARCHIVE_SHA256_ENV`] override,
/// else the pinned [`PG_ARCHIVE_SHA256`].
pub fn resolve_archive_sha256() -> String {
    non_blank_env(PG_ARCHIVE_SHA256_ENV).unwrap_or_else(|| PG_ARCHIVE_SHA256.to_string())
}

/// The one-file manifest handed to the shared streaming engine. The final on-disk
/// path is `<install_dir>/archives/postgresql.tar.gz` — `models_dir` is the
/// resolved installation dir and `subdir` is [`PG_ARCHIVE_SUBDIR`].
pub fn pg_archive_manifest() -> ModelManifest {
    ModelManifest {
        revision: PG_VERSION.to_string(),
        subdir: PG_ARCHIVE_SUBDIR.to_string(),
        files: vec![ModelFileSpec {
            id: "postgresql".to_string(),
            path: PG_ARCHIVE_FILENAME.to_string(),
            url: resolve_archive_url(),
            expected_bytes: PG_BUNDLED_ARCHIVE_BYTES,
            sha256: Some(resolve_archive_sha256()),
        }],
    }
}

/// `<install_dir>/archives/postgresql.tar.gz` — the ONE path rule (mirrors the
/// manifest's `subdir`/`path`).
pub fn pg_archive_path(install_dir: &Path) -> PathBuf {
    install_dir.join(PG_ARCHIVE_SUBDIR).join(PG_ARCHIVE_FILENAME)
}

/// No-op progress sink: the archive is staged headlessly before the supervisor
/// reports status; progress is surfaced through `PgState`, not the Companion
/// `setup:download-progress` channel.
struct NoopReporter;

impl ProgressReporter for NoopReporter {
    fn report(&self, _progress: DownloadProgress) {}
}

/// Acquire + verify the PostgreSQL archive into
/// `<install_dir>/archives/postgresql.tar.gz` through the ONE streaming engine
/// (skip-if-verified, `Range` resume, streaming SHA-256, delete-on-mismatch,
/// bounded retry). Returns the archive path on success; on any failure the
/// artifact is left absent/removed and an actionable `[pg:archive] …` error is
/// returned, so the caller MUST NOT proceed to extract.
pub async fn acquire_pg_archive(app_data_dir: &Path) -> Result<PathBuf> {
    let install_dir = super::resolve_install_dir(app_data_dir);
    let manifest = pg_archive_manifest();

    let transport = ReqwestTransport::new()
        .context("failed to initialize the PostgreSQL archive download client")?;

    let outcome = download_missing_files(
        &transport,
        &manifest,
        &install_dir,
        &NoopReporter,
        &SystemClock,
    )
    .await;

    if !outcome.success {
        let detail = outcome
            .error
            .unwrap_or_else(|| format!("acquisition of {PG_ARCHIVE_FILENAME} failed"));
        return Err(anyhow!(
            "[pg:archive] {detail} — the PostgreSQL distribution was not extracted; \
             retry the first-run acquisition once the network is available"
        ));
    }

    Ok(pg_archive_path(&install_dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serializes every test that mutates the process-global environment so the
    /// assertions are deterministic under any suite order (G-222).
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Removes the named env vars on drop (even on a panic).
    struct EnvGuard(&'static [&'static str]);

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for name in self.0 {
                std::env::remove_var(name);
            }
        }
    }

    #[test]
    fn manifest_pins_the_release_archive_and_the_shared_engine_layout() {
        // The manifest reads the process-global archive overrides, so this pin
        // must serialize with the env-mutating test and assert the UNSET default
        // path deterministically under any suite order (G-222).
        let _lock = ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        std::env::remove_var(PG_ARCHIVE_URL_ENV);
        std::env::remove_var(PG_ARCHIVE_SHA256_ENV);

        let manifest = pg_archive_manifest();

        assert_eq!(manifest.revision, PG_VERSION);
        assert_eq!(manifest.subdir, PG_ARCHIVE_SUBDIR);
        assert_eq!(manifest.files.len(), 1);
        let spec = &manifest.files[0];
        assert_eq!(spec.id, "postgresql");
        assert_eq!(spec.path, PG_ARCHIVE_FILENAME);
        assert_eq!(spec.url, PG_ARCHIVE_URL);
        assert_eq!(spec.expected_bytes, PG_BUNDLED_ARCHIVE_BYTES);
        assert_eq!(spec.sha256.as_deref(), Some(PG_ARCHIVE_SHA256));
        assert_eq!(PG_ARCHIVE_SHA256.len(), 64);
        assert!(PG_ARCHIVE_SHA256.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn archive_path_matches_the_manifest_layout() {
        let install = Path::new("C:/app/postgres-install");
        assert_eq!(
            pg_archive_path(install),
            install.join(PG_ARCHIVE_SUBDIR).join(PG_ARCHIVE_FILENAME)
        );
    }

    #[test]
    fn archive_env_overrides_are_inert_when_unset_and_applied_when_set() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let _guard = EnvGuard(&[PG_ARCHIVE_URL_ENV, PG_ARCHIVE_SHA256_ENV]);
        std::env::remove_var(PG_ARCHIVE_URL_ENV);
        std::env::remove_var(PG_ARCHIVE_SHA256_ENV);

        // Unset -> pinned defaults (the byte-identical path).
        assert_eq!(resolve_archive_url(), PG_ARCHIVE_URL);
        assert_eq!(resolve_archive_sha256(), PG_ARCHIVE_SHA256);
        // Blank is inert too.
        std::env::set_var(PG_ARCHIVE_URL_ENV, "   ");
        std::env::set_var(PG_ARCHIVE_SHA256_ENV, "");
        assert_eq!(resolve_archive_url(), PG_ARCHIVE_URL);
        assert_eq!(resolve_archive_sha256(), PG_ARCHIVE_SHA256);

        // Set -> the override drives the manifest.
        std::env::set_var(PG_ARCHIVE_URL_ENV, "http://127.0.0.1:9/offline.tar.gz");
        std::env::set_var(PG_ARCHIVE_SHA256_ENV, "0".repeat(64));
        assert_eq!(resolve_archive_url(), "http://127.0.0.1:9/offline.tar.gz");
        assert_eq!(resolve_archive_sha256(), "0".repeat(64));
        let manifest = pg_archive_manifest();
        assert_eq!(manifest.files[0].url, "http://127.0.0.1:9/offline.tar.gz");
        assert_eq!(manifest.files[0].sha256.as_deref(), Some("0".repeat(64).as_str()));
    }

    #[test]
    fn resolve_install_dir_falls_back_and_honours_the_override() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let _guard = EnvGuard(&[super::super::PG_INSTALL_DIR_ENV]);
        let app_data_dir = Path::new("C:/app");

        std::env::remove_var(super::super::PG_INSTALL_DIR_ENV);
        assert_eq!(
            super::super::resolve_install_dir(app_data_dir),
            app_data_dir.join(super::super::PG_INSTALL_SUBDIR)
        );

        std::env::set_var(super::super::PG_INSTALL_DIR_ENV, "  C:/tmp/pg-install  ");
        assert_eq!(
            super::super::resolve_install_dir(app_data_dir),
            PathBuf::from("C:/tmp/pg-install")
        );

        // Blank is inert (default path unchanged).
        std::env::set_var(super::super::PG_INSTALL_DIR_ENV, "   ");
        assert_eq!(
            super::super::resolve_install_dir(app_data_dir),
            app_data_dir.join(super::super::PG_INSTALL_SUBDIR)
        );
    }

    #[cfg(not(feature = "bundled"))]
    #[test]
    fn the_shipped_default_is_runtime_download() {
        assert_eq!(ACQUISITION_MODE, PgAcquisitionMode::RuntimeDownload);
        assert_eq!(
            serde_json::to_value(PgAcquisitionMode::RuntimeDownload).expect("serialize"),
            "runtimeDownload"
        );
        assert_eq!(
            serde_json::to_value(PgAcquisitionMode::Bundled).expect("serialize"),
            "bundled"
        );
    }

    #[cfg(feature = "bundled")]
    #[test]
    fn the_bundled_build_selects_bundled_mode() {
        assert_eq!(ACQUISITION_MODE, PgAcquisitionMode::Bundled);
    }
}
