//! Installed applications — the package trust boundary (Spec #3147, ST-2).
//!
//! This module turns a user-picked `.zip` into a **validated, hashed, inert**
//! directory under `<app_data_dir>/installed-apps/<id>/`, or refuses it with one
//! of the frozen [`InstalledAppRefusalCode`]s. Nothing in the package is ever
//! executed here: the manifest is read with `serde_json` and nothing else, and
//! the only writes are plain files the installer itself copies.
//!
//! # Module map
//!
//! | Module | Owns |
//! |---|---|
//! | [`manifest`] | `fredo-app.json` decoding + every field rule, the reserved-id set, the `engines.fredo` range check against the running Fredo version |
//! | [`archive`] | ZIP reading, entry-name safety (zip-slip, reserved paths, non-regular entries) and the three archive budgets |
//! | [`store`] | the on-disk install root, `manifest.json`/`record.json`/`files/`, SHA-256 pinning, the atomic install transaction, and the registry listing |
//! | [`commands_install`] | exactly `installed_app_install` and `installed_apps_list` |
//! | [`scheme`] | the `fredoapp` URI-scheme handler: routing, path-escape refusal, verify-at-serve, MIME, the child document's CSP and the served document |
//! | [`window`] | the window lifecycle: `installed-<id>` labels, the served document URL, the verify-before-open gate, the singleton build/focus and the close |
//! | [`commands_window`] | exactly `installed_app_open` and `installed_app_close` |
//! | [`theme_state`] | the `ThemePayload`/`ThemeToken` transport types and the backend's in-memory theme mirror |
//!
//! # Why the refusal codes live here
//!
//! They are the command surface's `Err` vocabulary (AC-3: "refused with a
//! message naming the specific reason"), so they are shared by every module
//! above. The set is FROZEN at 22 by the plan — a read path that wants a new
//! code must reuse an existing one (see `docs/agentic-pipeline` risk #9 for
//! `io_error`), never extend it.
//!
//! # Non-goals this module keeps
//!
//! An installed window exists only after [`commands_window::installed_app_open`]
//! is called (ST-4), no theme is pushed (ST-5), no
//! registry/update/signature path exists, and no installed-app work happens at
//! startup (R-5.5) — [`commands_install::installed_apps_list`] is the only
//! reader of the install root and nothing calls it from `lib.rs`'s setup
//! closure. [`scheme`] serves bytes only (ST-3): registering the scheme
//! performs no read, [`window`] builds a window only from an explicit open, and
//! [`theme_state`] is empty until the host's theme effect pushes a value.

pub mod archive;
pub mod commands_install;
pub mod commands_window;
pub mod manifest;
pub mod scheme;
pub mod store;
pub mod theme_state;
pub mod window;

use serde::{Deserialize, Serialize};

/// The window-label prefix every installed application's window carries
/// (`installed-<id>`). ST-4 builds the label; the constant lives here because
/// ST-2 derives it into the list projection (R-1.1's `windowLabel`) and the QA
/// plan reads it from ONE place (T-2.6).
///
/// It provably cannot match any shipped capability's `windows` glob
/// (`main`, `terminal`, `doom`, `app-*`) nor the built-in
/// `GENERIC_APP_WINDOW_LABEL_PREFIX` (`app-`) — that non-overlap is what makes
/// AC-2's refusal real.
pub const INSTALLED_APP_WINDOW_LABEL_PREFIX: &str = "installed-";

/// Subdirectory of the resolved app-data dir that IS the installed-app registry.
pub const INSTALLED_APPS_ROOT_SUBDIR: &str = "installed-apps";

/// The manifest's file name at a package's ZIP root.
pub const PACKAGE_MANIFEST_FILENAME: &str = "fredo-app.json";

/// `<id>/manifest.json` — the canonical normalized copy of the validated manifest.
pub const INSTALLED_MANIFEST_FILENAME: &str = "manifest.json";

/// `<id>/record.json` — the integrity record ([`store::InstalledAppRecord`]).
pub const INSTALLED_RECORD_FILENAME: &str = "record.json";

/// `<id>/files/` — every package file, at its archive-relative path.
pub const INSTALLED_FILES_SUBDIR: &str = "files";

/// A path segment a package may never claim: the host owns `__fredo/` inside a
/// served document (the injected bootstrap), so a package containing it is
/// refused with [`InstalledAppRefusalCode::ReservedPath`].
pub const RESERVED_PATH_SEGMENT: &str = "__fredo";

/// The one manifest schema this build understands (`manifestVersion`).
pub const SUPPORTED_MANIFEST_VERSION: u32 = 1;

/// The running Fredo version, used for the `engines.fredo` range check.
///
/// Source: the crate version (`CARGO_PKG_VERSION`, currently `0.1.0`) — the
/// same string the installer/updater stamps on a build, so a package author can
/// target the version the user actually runs.
pub const HOST_FREDO_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Archive budget: at most this many entries (files **and** directory entries).
pub const MAX_ARCHIVE_ENTRIES: u64 = 4_096;

/// Archive budget: at most this many uncompressed bytes across the whole archive.
pub const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 256 * 1024 * 1024;

/// Archive budget: at most this many uncompressed bytes in any single file.
pub const MAX_FILE_UNCOMPRESSED_BYTES: u64 = 64 * 1024 * 1024;

/// Buffer size for hashing and copying package files.
pub const IO_CHUNK_BYTES: usize = 64 * 1024;

/// The frozen refusal vocabulary (22 codes, plan §API Contracts).
///
/// Serialized `snake_case` — a deliberate exception to the repo's
/// `rename_all = "PascalCase"` enum rule, because the frontend's
/// `INSTALL_REFUSAL_COPY` map (ST-6) keys on exactly these strings and they are
/// part of the shipped contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstalledAppRefusalCode {
    /// The picked bytes are not a readable ZIP archive.
    NotAZip,
    /// The archive has no `fredo-app.json` at its root.
    NoManifest,
    /// `fredo-app.json` is not valid JSON (or not a JSON object).
    ManifestMalformed,
    /// The manifest carries a top-level key `manifestVersion: 1` does not define.
    ManifestUnknownField,
    /// A manifest field is present but fails its type/format rule.
    ManifestInvalidField,
    /// `manifestVersion` parsed but is not this build's version.
    UnsupportedManifestVersion,
    /// `id` violates the id pattern or the 96-char cap.
    IdInvalid,
    /// `id` names one of the built-in applications.
    IdReserved,
    /// `version` is not SemVer 2.0.0.
    VersionInvalid,
    /// `engines.fredo` is `*`, empty, or unparseable as a semver range.
    EnginesRangeInvalid,
    /// `engines.fredo` is well-formed but excludes the running Fredo version.
    HostIncompatible,
    /// A file `entry` names is absent from the archive.
    EntryMissing,
    /// An `entry` path violates the relative-POSIX/extension rule.
    EntryInvalid,
    /// An archive entry could escape the install root (zip-slip, absolute, UNC,
    /// drive prefix, symlink, or any non-regular type).
    UnsafePath,
    /// An archive entry claims the host-reserved `__fredo/` segment.
    ReservedPath,
    /// An archive budget (entries / total bytes / per-file bytes) was exceeded.
    ArchiveTooLarge,
    /// `<id>/` already exists in the install root.
    AlreadyInstalled,
    /// A filesystem operation failed.
    IoError,
    /// The bytes on disk differ from the recorded pin.
    IntegrityMismatch,
    /// `record.json` (or the canonical `manifest.json`) is unreadable/corrupt.
    IntegrityRecordCorrupt,
    /// The requested id has no install directory.
    IdNotInstalled,
    /// The requested id belongs to a built-in application.
    IdIsInstalledApp,
}

impl InstalledAppRefusalCode {
    /// The wire string for this code. Kept beside the enum so a test can assert
    /// it equals the serde derivation (the frontend keys on the serde form).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotAZip => "not_a_zip",
            Self::NoManifest => "no_manifest",
            Self::ManifestMalformed => "manifest_malformed",
            Self::ManifestUnknownField => "manifest_unknown_field",
            Self::ManifestInvalidField => "manifest_invalid_field",
            Self::UnsupportedManifestVersion => "unsupported_manifest_version",
            Self::IdInvalid => "id_invalid",
            Self::IdReserved => "id_reserved",
            Self::VersionInvalid => "version_invalid",
            Self::EnginesRangeInvalid => "engines_range_invalid",
            Self::HostIncompatible => "host_incompatible",
            Self::EntryMissing => "entry_missing",
            Self::EntryInvalid => "entry_invalid",
            Self::UnsafePath => "unsafe_path",
            Self::ReservedPath => "reserved_path",
            Self::ArchiveTooLarge => "archive_too_large",
            Self::AlreadyInstalled => "already_installed",
            Self::IoError => "io_error",
            Self::IntegrityMismatch => "integrity_mismatch",
            Self::IntegrityRecordCorrupt => "integrity_record_corrupt",
            Self::IdNotInstalled => "id_not_installed",
            Self::IdIsInstalledApp => "id_is_installed_app",
        }
    }

    /// Every code, in the plan's documented order. The copy map (ST-6) and this
    /// enum must stay in lockstep; `all_codes_are_exactly_the_frozen_set` pins
    /// both this count and the wire strings.
    pub const ALL: [Self; 22] = [
        Self::NotAZip,
        Self::NoManifest,
        Self::ManifestMalformed,
        Self::ManifestUnknownField,
        Self::ManifestInvalidField,
        Self::UnsupportedManifestVersion,
        Self::IdInvalid,
        Self::IdReserved,
        Self::VersionInvalid,
        Self::EnginesRangeInvalid,
        Self::HostIncompatible,
        Self::EntryMissing,
        Self::EntryInvalid,
        Self::UnsafePath,
        Self::ReservedPath,
        Self::ArchiveTooLarge,
        Self::AlreadyInstalled,
        Self::IoError,
        Self::IntegrityMismatch,
        Self::IntegrityRecordCorrupt,
        Self::IdNotInstalled,
        Self::IdIsInstalledApp,
    ];
}

impl std::fmt::Display for InstalledAppRefusalCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The `Err` side of every installed-app command (plan §API Contracts).
///
/// `field` is `Option<String>` with `skip_serializing_if`, so an unset optional
/// is an **absent key, never an explicit `null`** (G-413).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAppError {
    pub code: InstalledAppRefusalCode,
    /// Human-readable detail. Rendered, never parsed.
    pub detail: String,
    /// Present iff the refusal concerns one manifest field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

impl InstalledAppError {
    /// A refusal with a detail and no field.
    pub fn new(code: InstalledAppRefusalCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
            field: None,
        }
    }

    /// A field-scoped refusal, naming the manifest field that failed.
    pub fn field(
        code: InstalledAppRefusalCode,
        field: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            code,
            detail: detail.into(),
            field: Some(field.into()),
        }
    }

    /// Wrap a filesystem error as [`InstalledAppRefusalCode::IoError`].
    pub fn io(context: &str, error: &std::io::Error) -> Self {
        Self::new(
            InstalledAppRefusalCode::IoError,
            format!("{context}: {error}"),
        )
    }
}

impl std::fmt::Display for InstalledAppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.field {
            Some(field) => write!(f, "[{}] {} (field {field})", self.code, self.detail),
            None => write!(f, "[{}] {}", self.code, self.detail),
        }
    }
}

impl std::error::Error for InstalledAppError {}

/// The refusal-aware result alias used across this module.
///
/// `anyhow::Result` is the repo's rule for *unexpected* errors; here every
/// failure must arrive at the frontend as a named code, so the error type is
/// the typed [`InstalledAppError`] instead of an opaque chain.
pub type InstalledAppResult<T> = std::result::Result<T, InstalledAppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_codes_are_exactly_the_frozen_set() {
        assert_eq!(InstalledAppRefusalCode::ALL.len(), 22, "the plan freezes 22 codes");

        let mut seen = Vec::new();
        for code in InstalledAppRefusalCode::ALL {
            let wire = serde_json::to_string(&code).expect("serialize code");
            let quoted = format!("\"{}\"", code.as_str());
            assert_eq!(
                wire, quoted,
                "as_str() and the serde snake_case derivation must agree for {code:?}"
            );
            assert!(
                code.as_str()
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "{code:?} must be snake_case"
            );
            assert!(!seen.contains(&wire), "duplicate wire code {wire}");
            seen.push(wire);
        }
        assert_eq!(seen.len(), 22, "every code has a distinct wire string");
    }

    #[test]
    fn the_frozen_wire_strings_are_the_plans_names() {
        let expected = [
            "not_a_zip",
            "no_manifest",
            "manifest_malformed",
            "manifest_unknown_field",
            "manifest_invalid_field",
            "unsupported_manifest_version",
            "id_invalid",
            "id_reserved",
            "version_invalid",
            "engines_range_invalid",
            "host_incompatible",
            "entry_missing",
            "entry_invalid",
            "unsafe_path",
            "reserved_path",
            "archive_too_large",
            "already_installed",
            "io_error",
            "integrity_mismatch",
            "integrity_record_corrupt",
            "id_not_installed",
            "id_is_installed_app",
        ];
        let actual: Vec<&str> = InstalledAppRefusalCode::ALL
            .iter()
            .map(|code| code.as_str())
            .collect();
        assert_eq!(actual, expected.to_vec());
    }

    #[test]
    fn error_omits_the_field_key_when_unset() {
        let value = serde_json::to_value(InstalledAppError::new(
            InstalledAppRefusalCode::NoManifest,
            "no fredo-app.json",
        ))
        .expect("serialize");
        let object = value.as_object().expect("object");
        assert_eq!(object.len(), 2, "code + detail only: {value}");
        assert!(
            !object.contains_key("field"),
            "an unset field must be an ABSENT key, never null"
        );
        assert_eq!(object.get("code").and_then(|v| v.as_str()), Some("no_manifest"));
    }

    #[test]
    fn error_carries_the_field_key_when_set() {
        let value = serde_json::to_value(InstalledAppError::field(
            InstalledAppRefusalCode::ManifestInvalidField,
            "displayName",
            "displayName must be 1..64 chars",
        ))
        .expect("serialize");
        assert_eq!(value.get("field").and_then(|v| v.as_str()), Some("displayName"));
        assert_eq!(
            value.get("code").and_then(|v| v.as_str()),
            Some("manifest_invalid_field")
        );
    }

    #[test]
    fn contract_constants_are_the_plans_values() {
        assert_eq!(INSTALLED_APP_WINDOW_LABEL_PREFIX, "installed-");
        assert_eq!(INSTALLED_APPS_ROOT_SUBDIR, "installed-apps");
        assert_eq!(PACKAGE_MANIFEST_FILENAME, "fredo-app.json");
        assert_eq!(INSTALLED_MANIFEST_FILENAME, "manifest.json");
        assert_eq!(INSTALLED_RECORD_FILENAME, "record.json");
        assert_eq!(INSTALLED_FILES_SUBDIR, "files");
        assert_eq!(RESERVED_PATH_SEGMENT, "__fredo");
        assert_eq!(SUPPORTED_MANIFEST_VERSION, 1);
    }

    #[test]
    fn archive_budget_caps_are_the_plans_values() {
        assert_eq!(MAX_ARCHIVE_ENTRIES, 4_096);
        assert_eq!(MAX_TOTAL_UNCOMPRESSED_BYTES, 268_435_456, "256 MiB");
        assert_eq!(MAX_FILE_UNCOMPRESSED_BYTES, 67_108_864, "64 MiB");
    }

    #[test]
    fn the_host_version_is_a_parseable_semver() {
        let parsed = semver::Version::parse(HOST_FREDO_VERSION)
            .expect("CARGO_PKG_VERSION must be SemVer for the engines check");
        assert!(parsed.major == 0, "unexpected major bump: {parsed}");
    }
}
