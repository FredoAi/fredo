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
//! # Integrity surface (S2/S3, AC2/AC4; Spec #3076 ST-2)
//!
//! On the `runtime-download` path (Windows x86_64) the archive is acquired
//! through Fredo's ONE SHA-256-pinned streaming engine ([`acquire_pg_archive`] →
//! `infrastructure::companion::download::download_missing_files`): skip-if-verified,
//! HTTP `Range` resume seeded from the on-disk prefix, a streaming digest over the
//! whole file, delete-on-mismatch, and a bounded retry budget. A mismatch or a
//! network failure deletes/does not extract the artifact and returns an actionable
//! `[pg:archive] …` error, so the supervisor never extracts a partial
//! distribution. The engine is reused verbatim (NFR-6) — never forked.
//!
//! **Fredo extracts the verified bytes itself.** [`ensure_verified_install`] is
//! the single choke point every owner path reaches through
//! [`super::runtime::PgRuntime::setup`]: when the install dir is not already
//! current for [`effective_pin`], it acquires the archive, then extracts THAT
//! file with [`super::extraction::extract_verified_archive`] (streaming tar/gz,
//! one-component strip, marker written only after success). `postgresql_embedded`
//! performs **no** download on this path: the runtime trusts the installation
//! dir and pins the exact version, so the crate's `install()`/`get_archive`
//! path is unreachable. The crate's own extractor is not used (it takes
//! `&Vec<u8>` — the whole archive in memory).
//!
//! **`bundled` is OUTSIDE Fredo's integrity surface (AC4).** The `bundled` crate
//! build option makes the crate's `build.rs` fetch the archive from
//! `theseus-rs/postgresql-binaries` at build time; that fetch is not verified by a
//! Fredo-owned SHA-256 pin (the pin below covers only the `runtime-download`
//! artifact). It is bounded by the pinned version ([`PG_VERSION`]) and
//! `Cargo.lock`, but it is a documented supply-chain gap until it is replaced by a
//! SHA-pinned resource under Fredo's control. `bundled` is deliberately NOT the
//! default (see the Cargo build option table). `bundled` keeps the crate's
//! embedded-archive install path byte-for-byte unchanged: trust/version are never
//! applied on that path.
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

// ── The trusted-install gate (Spec #3076 ST-2) ───────────────────────────────

/// The trusted-install path is only implemented for the pinned target
/// (Windows x86_64). Every other target keeps the crate's self-fetch behaviour —
/// a documented follow-up, never a silent behavioural change.
pub const TRUSTED_INSTALL_ENABLED: bool = cfg!(all(target_os = "windows", target_arch = "x86_64"));

/// THE conditional flag the whole slice keys on: the trusted install path is
/// active when it is implemented for this target AND the mode is
/// [`PgAcquisitionMode::RuntimeDownload`]. Used by BOTH
/// [`super::runtime::apply_acquisition_mode`] (settings) and
/// [`super::runtime::PgRuntime::setup`] (materialise-before-setup), so the two
/// can never diverge.
pub fn trusted_install_path_enabled(mode: PgAcquisitionMode) -> bool {
    TRUSTED_INSTALL_ENABLED && mode == PgAcquisitionMode::RuntimeDownload
}

/// The value every verification compares against. Owns the pin so callers and
/// tests can pass it explicitly instead of reading the environment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PgArchivePin {
    /// e.g. `"18.6.0"` (== [`PG_VERSION`]).
    pub version: String,
    /// 64 hex chars (== [`resolve_archive_sha256`]).
    pub sha256: String,
}

/// The ONE production pin: [`PG_VERSION`] + [`resolve_archive_sha256`] (the
/// non-blank `FREDO_PG_ARCHIVE_SHA256` override wins).
pub fn effective_pin() -> PgArchivePin {
    PgArchivePin {
        version: PG_VERSION.to_string(),
        sha256: resolve_archive_sha256(),
    }
}

/// G-222 serialization seam (cfg(test) only): the ONE lock every test that reads
/// OR mutates the process-global archive pin must hold. Shared by the acquisition
/// env tests and the runtime AC3 test so a concurrent override can never flake the
/// marker comparison. No production surface.
#[cfg(test)]
pub(crate) static PG_ARCHIVE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
/// bounded retry). `install_dir` is the CALLER's resolved installation directory
/// (the same path handed to [`super::runtime::PgRuntime`]), so the staged archive
/// and the extracted tree can never diverge. Returns the archive path on success;
/// on any failure the artifact is left absent/removed and an actionable
/// `[pg:archive] …` error is returned, so the caller MUST NOT proceed to extract.
pub async fn acquire_pg_archive(install_dir: &Path) -> Result<PathBuf> {
    let manifest = pg_archive_manifest();

    let transport = ReqwestTransport::new()
        .context("failed to initialize the PostgreSQL archive download client")?;

    let outcome = download_missing_files(
        &transport,
        &manifest,
        install_dir,
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

    Ok(pg_archive_path(install_dir))
}

/// The single choke point (Spec #3076 ST-2): materialise the trusted installation
/// directory from the archive Fredo itself verified.
///
/// A current install ([`super::extraction::trusted_install_is_current`] for
/// [`effective_pin`]) is a byte-identical no-op (R-1a). Otherwise the archive is
/// acquired (bounded streaming engine), and THAT returned path is bound and
/// extracted by [`super::extraction::extract_verified_archive`] — the returned
/// `PathBuf` is consumed, never discarded (the defect this slice closes).
///
/// The extraction is a 164 MB local-FS operation, so it runs off the async
/// reactor via [`tauri::async_runtime::spawn_blocking`] (never `tokio::spawn`).
/// Deliberately outside `PG_SETUP_BOUND`: the download leg keeps the streaming
/// engine's own bounded retry, and the extract's own bound is the process lifetime
/// (an accepted, declared posture — no unbounded NETWORK await is added).
pub async fn ensure_verified_install(install_dir: &Path) -> Result<()> {
    let pin = effective_pin();
    if super::extraction::trusted_install_is_current(install_dir, &pin) {
        return Ok(());
    }

    let archive = acquire_pg_archive(install_dir).await?;
    let install_dir = install_dir.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        super::extraction::extract_verified_archive(&archive, &install_dir, &pin)
    })
    .await
    .context("the PostgreSQL extraction task failed to join")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::pg_supervisor::extraction::seed_trusted_install;

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
        let _lock = PG_ARCHIVE_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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
        let _lock = PG_ARCHIVE_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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
        let _lock = PG_ARCHIVE_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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

    /// R-1a (Spec #3076): a CURRENT trusted install short-circuits
    /// `ensure_verified_install` — no acquisition, no extraction, no transport.
    /// The pin is read from the process-global seam, so the shared G-222 lock is
    /// held for the seed + assert.
    #[tokio::test]
    async fn ensure_verified_install_skips_when_the_marker_is_current() {
        let _lock = PG_ARCHIVE_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let pin = effective_pin();
        let dir = tempfile::tempdir().expect("tempdir");
        let install_dir = dir.path().join("postgres-install");
        seed_trusted_install(&install_dir, &pin).expect("seed a current trusted install");

        ensure_verified_install(&install_dir)
            .await
            .expect("a current marker must short-circuit");

        assert!(
            !install_dir.join(PG_ARCHIVE_SUBDIR).exists(),
            "a current install must not stage/acquire an archive"
        );
        assert!(
            super::super::extraction::trusted_install_is_current(&install_dir, &pin),
            "the install stays current"
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
