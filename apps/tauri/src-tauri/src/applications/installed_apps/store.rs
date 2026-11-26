//! The on-disk install root: hash pinning, the atomic install, and the registry
//! listing (Spec #3147, ST-2).
//!
//! # Layout (backend-owned; the frontend never reads files)
//!
//! ```text
//! <app_data_dir>/installed-apps/            # root; DIRECTORIES ARE THE REGISTRY
//!   <id>/manifest.json                      # canonical normalized manifest copy
//!   <id>/record.json                        # InstalledAppRecord (files + per-file sha256)
//!   <id>/files/<entry.document, entry.module, assets...>
//! ```
//!
//! There is deliberately **no central index file**: each install is one
//! directory, so a corrupt record is corrupt for ONE application and every
//! other application still lists and opens (T-4.5's per-directory property).
//!
//! # Nothing is half-installed
//!
//! Every refusal happens **before** the first write (the archive index validates
//! names and budgets across the whole archive; the manifest is parsed before any
//! file is touched), and the write phase is a single **staging directory** that
//! is renamed into place only after `manifest.json`, `record.json` and every
//! payload byte are on disk. A failure anywhere removes the staging directory,
//! so the QA rows' "no new `<id>/`" assertion holds for every refusal path —
//! including a mid-copy I/O failure.
//!
//! # Integrity (AC-4.4 / R-4.4)
//!
//! Each package file is read **once**, hashed **as it is written**, and recorded
//! as `{path, sha256, bytes}` sorted by path, plus one aggregate digest over that
//! sorted set. ST-3 verifies the record at serve time; this module produces it.

use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use super::archive;use super::manifest::{self, AppManifest, InstalledAppCapabilities};
use super::lifecycle::InstalledAppState;
use super::{
    InstalledAppError, InstalledAppRefusalCode, InstalledAppResult, INSTALLED_APP_WINDOW_LABEL_PREFIX,
    INSTALLED_APPS_ROOT_SUBDIR, INSTALLED_FILES_SUBDIR, INSTALLED_MANIFEST_FILENAME,
    INSTALLED_RECORD_FILENAME, IO_CHUNK_BYTES, PACKAGE_MANIFEST_FILENAME,
};

/// One file's pin: where it lives inside `<id>/files`, what it hashes to, how big
/// it is. `path` is a relative POSIX path (always `'/'`-separated).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledFileRecord {
    pub path: String,
    /// Lowercase hex SHA-256 of the file's bytes.
    pub sha256: String,
    pub bytes: u64,
}

/// `<id>/record.json` — everything ST-3 needs to verify what it serves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAppRecord {
    pub id: String,
    pub version: String,
    pub manifest_version: u32,
    pub engines_fredo: String,
    pub entry_document: String,
    pub entry_module: String,
    /// RFC 3339 timestamp of the completed install.
    pub installed_at: String,
    /// One digest over the sorted `(path, sha256)` set.
    pub aggregate_sha256: String,
    /// Every recorded file, sorted by `path`.
    pub files: Vec<InstalledFileRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// `None` ⇒ the renderer falls back to `id` (an ABSENT key on the wire).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

/// What an installed application may reach, as the host currently understands it
/// (Spec #3146).
///
/// ALWAYS present in the list projection — never omitted, never `null`. Empty
/// arrays are a FACT ("this package declared no reach"), not an absence the
/// renderer has to guess about, which is what lets the settings surface read
/// `entry.capabilities.highRisk` directly with no fallback chain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAppCapabilityStatus {
    /// The installed application this status is about (the DERIVED id).
    pub app_id: String,
    /// Every declared capability id, sorted. Empty when the package declared none.
    pub declared: Vec<String>,
    /// The declared ids that require a per-application consent grant, sorted.
    /// This is the ONLY axis the settings surface offers a control over.
    pub high_risk: Vec<String>,
    /// The granted subset of `high_risk` for THIS application, sorted. A grant
    /// recorded for another application never appears here (R-4.2).
    pub consented: Vec<String>,
}

impl InstalledAppCapabilityStatus {
    /// Nothing declared — the fail-safe default (`capabilities` absent).
    pub fn undeclared(app_id: impl Into<String>) -> Self {
        Self {
            app_id: app_id.into(),
            declared: Vec::new(),
            high_risk: Vec::new(),
            consented: Vec::new(),
        }
    }

    /// Build the projection from a package's declaration. Nothing is consented
    /// at install time: a freshly installed application may reach no high-risk
    /// action until the user grants it.
    pub fn declared_by(app_id: &str, capabilities: Option<&InstalledAppCapabilities>) -> Self {
        match capabilities {
            None => Self::undeclared(app_id),
            Some(capabilities) => Self {
                app_id: app_id.to_string(),
                declared: capabilities.declared(),
                high_risk: capabilities.high_risk(),
                consented: Vec::new(),
            },
        }
    }

    /// Apply the host-owned consent record for this ONE application.
    ///
    /// Only ids that are BOTH declared and high-risk survive, so a stale or
    /// hand-edited consent file can never widen a package's declaration — the
    /// consent file records a decision about a declaration, it never creates one.
    pub fn with_consented(&self, granted: &[String]) -> Self {
        let mut consented: Vec<String> = granted
            .iter()
            .filter(|id| self.high_risk.contains(id))
            .cloned()
            .collect();
        consented.sort();
        consented.dedup();
        Self {
            consented,
            ..self.clone()
        }
    }

    /// Is `capability` consented for this application?
    pub fn is_consented(&self, capability: &str) -> bool {
        self.consented.iter().any(|id| id == capability)
    }
}

/// The list projection (plan §API Contracts) — what the launcher/settings show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAppEntry {
    pub id: String,
    pub display_name: String,
    pub version: String,
    /// The declared range, verbatim — never resolved to a boolean here.
    pub engines_fredo: String,
    pub installed_at: String,
    /// Derived: `installed-<id>`.
    pub window_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The declared/granted reach. Always present (Spec #3146).
    pub capabilities: InstalledAppCapabilityStatus,
    /// The lifecycle state (Spec #3144). Always present. `working` is a claim
    /// about the host's RECORD ("no recorded failure"), never a claim that the
    /// application is running.
    pub state: InstalledAppState,
    /// The host's witness code for a `failing` state (Spec #3144). ABSENT KEY
    /// when the state is not `failing`; `id_not_installed` is deliberately NOT
    /// landable here (an application with no install directory cannot be listed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<InstalledAppRefusalCode>,
}

impl InstalledAppEntry {
    /// Project a validated manifest into the list entry. `installed_at` is the
    /// RFC 3339 stamp the caller recorded.
    pub fn from_manifest(manifest: &AppManifest, installed_at: String) -> Self {
        Self {
            id: manifest.id.clone(),
            display_name: manifest.display_name.clone(),
            version: manifest.version.clone(),
            engines_fredo: manifest.engines.fredo.clone(),
            installed_at,
            window_label: window_label_for(&manifest.id),
            description: manifest.description.clone(),
            capabilities: InstalledAppCapabilityStatus::declared_by(
                &manifest.id,
                manifest.capabilities.as_ref(),
            ),
            state: InstalledAppState::Working,
            failure_code: None,
        }
    }

    /// Project a persisted install (its record plus its canonical manifest).
    ///
    /// The declaration is read from `<id>/manifest.json` — the canonical copy the
    /// installer wrote — rather than denormalised into `record.json`, so there is
    /// exactly ONE host-side copy of what a package declared.
    pub fn from_installed(record: &InstalledAppRecord, manifest: &AppManifest) -> Self {
        Self {
            id: record.id.clone(),
            display_name: record
                .display_name
                .clone()
                .unwrap_or_else(|| record.id.clone()),
            version: record.version.clone(),
            engines_fredo: record.engines_fredo.clone(),
            installed_at: record.installed_at.clone(),
            window_label: window_label_for(&record.id),
            description: record.description.clone(),
            capabilities: InstalledAppCapabilityStatus::declared_by(
                &record.id,
                manifest.capabilities.as_ref(),
            ),
            state: InstalledAppState::Working,
            failure_code: None,
        }
    }

    /// A `Failing` row for a directory whose `record.json` is unreadable.
    ///
    /// The id (the registry directory name) is the ONLY identity we can trust, so
    /// every other field falls back to its empty form, never invented
    /// (Adjudication 10.6): `displayName` = the id, `version`/`enginesFredo`/
    /// `installedAt` = `""`, `description` absent, `capabilities` = the fail-safe
    /// EMPTY projection. The reach fails closed because an unreadable install
    /// grants nothing.
    fn failing_from_id(id: &str, failure_code: InstalledAppRefusalCode) -> Self {
        Self {
            id: id.to_string(),
            display_name: id.to_string(),
            version: String::new(),
            engines_fredo: String::new(),
            installed_at: String::new(),
            window_label: window_label_for(id),
            description: None,
            capabilities: InstalledAppCapabilityStatus::undeclared(id),
            state: InstalledAppState::Failing,
            failure_code: Some(failure_code),
        }
    }

    /// A `Failing` row for a directory whose canonical `manifest.json` is
    /// unreadable but whose record is intact.
    ///
    /// The identity survives (it is in the record), but the declaration does not:
    /// `capabilities` falls back to the fail-safe EMPTY projection, exactly as an
    /// unreadable declaration must (never a stale or invented reach).
    fn failing_from_record(record: &InstalledAppRecord, failure_code: InstalledAppRefusalCode) -> Self {
        Self {
            id: record.id.clone(),
            display_name: record
                .display_name
                .clone()
                .unwrap_or_else(|| record.id.clone()),
            version: record.version.clone(),
            engines_fredo: record.engines_fredo.clone(),
            installed_at: record.installed_at.clone(),
            window_label: window_label_for(&record.id),
            description: record.description.clone(),
            capabilities: InstalledAppCapabilityStatus::undeclared(&record.id),
            state: InstalledAppState::Failing,
            failure_code: Some(failure_code),
        }
    }

    /// Apply a resolved lifecycle state (Spec #3144): the `disabled > failing >
    /// working` precedence is computed by [`super::lifecycle::state_for`]; this
    /// just writes the result onto the projection.
    pub fn with_lifecycle(
        mut self,
        state: InstalledAppState,
        failure_code: Option<InstalledAppRefusalCode>,
    ) -> Self {
        self.state = state;
        self.failure_code = failure_code;
        self
    }

    /// Apply this application's consent record to the projection.
    pub fn with_consented(&self, granted: &[String]) -> Self {
        Self {
            capabilities: self.capabilities.with_consented(granted),
            ..self.clone()
        }
    }
}

/// The window label for an installed application (`installed-<id>`).
///
/// This is the ONE derivation; ST-4 builds the window from it and the QA plan
/// reads the constant from here (T-2.6).
pub fn window_label_for(id: &str) -> String {
    format!("{INSTALLED_APP_WINDOW_LABEL_PREFIX}{id}")
}

/// `<app_data_dir>/installed-apps` — the registry root. Pure.
pub fn install_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(INSTALLED_APPS_ROOT_SUBDIR)
}

/// `<app_data_dir>/installed-apps/<id>`. Pure.
pub fn app_dir(root: &Path, id: &str) -> PathBuf {
    root.join(id)
}

/// `<app_data_dir>/installed-apps-staging` — where an install is assembled
/// before it is renamed into the registry.
///
/// Deliberately a SIBLING of the registry root, not a child: a staging
/// directory inside the registry would appear as an application to any reader
/// that lists directories, and "directories ARE the registry" must stay true.
/// Both live under `app_data_dir`, so the rename is a same-volume atomic move.
pub fn staging_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(format!("{INSTALLED_APPS_ROOT_SUBDIR}-staging"))
}

/// Recursively remove `path`, ignoring "already gone". Used for staging cleanup
/// so a failed install never leaves debris behind.
fn remove_dir_all_if_present(path: &Path) {
    if path.exists() {
        let _ = std::fs::remove_dir_all(path);
    }
}

/// Lowercase hex encoding (no extra crate dependency).
fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// SHA-256 of a byte slice as lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_encode(&hasher.finalize())
}

/// The aggregate digest over the SORTED `(path, sha256)` set.
///
/// The exact construction (`path` NUL `sha256` LF, repeated in path order) is
/// part of the record contract: ST-3 recomputes nothing here, but the QA row
/// T-N2 independently recomputes every per-file hash and can rebuild this value
/// from the record alone. Deterministic by construction — no map iteration, no
/// timestamps.
pub fn aggregate_digest(files: &[InstalledFileRecord]) -> String {
    let mut sorted: Vec<&InstalledFileRecord> = files.iter().collect();
    sorted.sort_by(|left, right| left.path.cmp(&right.path));

    let mut hasher = Sha256::new();
    for file in sorted {
        hasher.update(file.path.as_bytes());
        hasher.update([0u8]);
        hasher.update(file.sha256.as_bytes());
        hasher.update(*b"\n");
    }
    hex_encode(&hasher.finalize())
}

/// Read `<id>/record.json`.
///
/// A missing or unparseable record is [`IntegrityRecordCorrupt`] — a distinct
/// code from `io_error`, because "this application's integrity metadata is
/// damaged" is a different fact from "a write failed" (T-4.5 asserts the
/// specific code).
///
/// [`IntegrityRecordCorrupt`]: InstalledAppRefusalCode::IntegrityRecordCorrupt
pub fn read_record(app_dir: &Path) -> InstalledAppResult<InstalledAppRecord> {
    let path = app_dir.join(INSTALLED_RECORD_FILENAME);
    let bytes = std::fs::read(&path).map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::IntegrityRecordCorrupt,
            format!("{} could not be read: {error}", path.display()),
        )
    })?;
    let record: InstalledAppRecord = serde_json::from_slice(&bytes).map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::IntegrityRecordCorrupt,
            format!("{} is not a readable install record: {error}", path.display()),
        )
    })?;
    Ok(record)
}

/// Read `<id>/manifest.json` (the canonical normalized copy).
pub fn read_manifest_file(app_dir: &Path) -> InstalledAppResult<AppManifest> {
    let path = app_dir.join(INSTALLED_MANIFEST_FILENAME);
    let bytes = std::fs::read(&path).map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::IntegrityRecordCorrupt,
            format!("{} could not be read: {error}", path.display()),
        )
    })?;
    manifest::parse_manifest(&bytes).map_err(|error| InstalledAppError {
        code: InstalledAppRefusalCode::IntegrityRecordCorrupt,
        detail: format!(
            "{} is not a valid canonical manifest: {}",
            path.display(),
            error.detail
        ),
        field: error.field,
    })
}

/// List every installed application, sorted by id.
///
/// This is the ONLY reader of the registry, and nothing calls it at startup
/// (R-5.5). A directory whose name cannot be an app id (a leftover staging
/// directory, an OS artifact) is skipped.
///
/// **Per-directory resilient (Spec #3144, the shipped defect):** a directory that
/// DOES look like an install but whose `record.json` / `manifest.json` cannot be
/// read is surfaced as a `Failing` row, never dropped and never allowed to abort
/// the whole listing — one damaged install must not hide every other one (AC-1's
/// "no installed application missing", AC-5's "rather than silently absent").
pub fn list_installed(root: &Path) -> InstalledAppResult<Vec<InstalledAppEntry>> {
    list_installed_resilient(root)
}

/// List every installed application, with a damaged install surfaced as a
/// `Failing` row (Spec #3144, R-1.2 / R-5.3).
///
/// A directory whose `record.json` or canonical `manifest.json` cannot be read
/// yields a `Failing` row carrying the observed witness code, and every OTHER
/// application still lists. Only a root-level read failure (the registry itself
/// is unreadable) is an error.
pub fn list_installed_resilient(root: &Path) -> InstalledAppResult<Vec<InstalledAppEntry>> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(InstalledAppError::io(
                &format!("listing {}", root.display()),
                &error,
            ))
        }
    };

    let mut entries_found: Vec<InstalledAppEntry> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            InstalledAppError::io(&format!("listing {}", root.display()), &error)
        })?;

        let file_type = entry.file_type().map_err(|error| {
            InstalledAppError::io(
                &format!("inspecting {}", entry.path().display()),
                &error,
            )
        })?;
        if !file_type.is_dir() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().into_owned();
        // A directory that cannot be an app id is not a registry entry.
        if !manifest::is_valid_app_id(&name) {
            continue;
        }

        // A damaged record or manifest is a FACT about one application, not a
        // failure of the listing: it becomes a `Failing` row and the loop
        // continues so every other application still lists.
        let dir = entry.path();
        let listed = match read_record(&dir) {
            Ok(record) => match read_manifest_file(&dir) {
                Ok(manifest) => InstalledAppEntry::from_installed(&record, &manifest),
                Err(error) => InstalledAppEntry::failing_from_record(&record, error.code),
            },
            Err(error) => InstalledAppEntry::failing_from_id(&name, error.code),
        };
        entries_found.push(listed);
    }

    entries_found.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(entries_found)
}

/// `<app_data_dir>/installed-apps-removing` — where a removal renames a package
/// directory aside before deleting it (Spec #3144).
///
/// Deliberately a SIBLING of the registry root, never inside it: after the rename
/// the application is already absent from the inventory, and any leftover bytes
/// are debris under a non-registry directory, swept on the next removal.
pub fn removal_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(format!("{INSTALLED_APPS_ROOT_SUBDIR}-removing"))
}

/// Remove an installed application's directory (Spec #3144).
///
/// The registry stays consistent even when the bytes cannot be freed: the
/// `<registry>/<id>` directory is first RENAMED aside into [`removal_root`]
/// (a same-volume atomic move, so the application is absent from the inventory
/// the instant it succeeds), and only then deleted. A failure after the rename
/// leaves the application fully ABSENT (never half); the debris is swept the next
/// time a removal runs.
pub fn remove_install(data_dir: &Path, id: &str) -> InstalledAppResult<()> {
    let root = install_root(data_dir);
    let dir = app_dir(&root, id);
    if !dir.is_dir() {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::IdNotInstalled,
            "appId",
            format!("\"{id}\" is not installed, so there is nothing to remove"),
        ));
    }

    let removal = removal_root(data_dir);
    std::fs::create_dir_all(&removal).map_err(|error| {
        InstalledAppError::io(&format!("creating {}", removal.display()), &error)
    })?;

    // Sweep debris from any previous removal that could not free its bytes.
    sweep_removal_debris(data_dir);

    let target = removal.join(format!("{id}-{}", unique_suffix()));
    std::fs::rename(&dir, &target).map_err(|error| {
        InstalledAppError::io(
            &format!("removing {} (renaming it aside)", dir.display()),
            &error,
        )
    })?;

    // Past the rename the application is ABSENT from the registry: a failure here
    // leaves it absent (the desired never-half property) and reports the IO error.
    if let Err(error) = std::fs::remove_dir_all(&target) {
        return Err(InstalledAppError::io(
            &format!("clearing {}", target.display()),
            &error,
        ));
    }

    Ok(())
}

/// Best-effort sweep of leftover removal debris under [`removal_root`].
///
/// A directory that could not be freed during an earlier removal (a Windows file
/// lock) is retried here; a failure is swallowed because the debris is outside
/// the registry and never appears in the inventory.
fn sweep_removal_debris(data_dir: &Path) {
    let removal = removal_root(data_dir);
    let Ok(entries) = std::fs::read_dir(&removal) else {
        return;
    };
    for entry in entries.flatten() {
        let _ = std::fs::remove_dir_all(entry.path());
    }
}

/// Install one package archive into the registry.
///
/// The whole refusal vocabulary for the install path lives here or in the two
/// helpers above; every failure happens before the rename, so a refusal leaves
/// the registry byte-identical.
pub fn install_archive(app_data_dir: &Path, archive_path: &Path) -> InstalledAppResult<InstalledAppEntry> {
    let root = install_root(app_data_dir);

    // ---- 1. Index the archive (names + budgets, whole-archive, no payload) ----
    let mut archive = archive::open_archive(archive_path)?;
    let index = archive_index_in_place(&mut archive)?;

    // ---- 2. The manifest, read with serde_json and nothing else ----
    let Some(manifest_entry) = index.manifest_entry() else {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::NoManifest,
            format!(
                "the package has no {PACKAGE_MANIFEST_FILENAME} at its root; a package must \
                 declare itself before anything is installed"
            ),
        ));
    };
    let manifest_bytes = archive::read_entry_bytes(&mut archive, manifest_entry)?;
    let manifest = manifest::parse_manifest(&manifest_bytes)?;

    // ---- 3. Both entry files must exist in the archive ----
    require_entry_file(&index, &manifest.entry.document, "entry.document")?;
    require_entry_file(&index, &manifest.entry.module, "entry.module")?;

    // ---- 4. Refuse a re-install before writing anything ----
    let target = app_dir(&root, &manifest.id);
    if target.exists() {
        return Err(already_installed_error(&manifest.id));
    }

    // ---- 5. Assemble in a staging directory, then rename ----
    std::fs::create_dir_all(&root)
        .map_err(|error| InstalledAppError::io(&format!("creating {}", root.display()), &error))?;
    let staging_base = staging_root(app_data_dir);
    std::fs::create_dir_all(&staging_base).map_err(|error| {
        InstalledAppError::io(&format!("creating {}", staging_base.display()), &error)
    })?;

    let staging = staging_base.join(format!("{}-{}", manifest.id, unique_suffix()));
    remove_dir_all_if_present(&staging);

    let outcome = write_staged_install(&mut archive, &index, &manifest, &staging);
    let installed_at = match outcome {
        Ok(stamp) => stamp,
        Err(error) => {
            remove_dir_all_if_present(&staging);
            return Err(error);
        }
    };

    // A concurrent install of the same id may have won the race after step 4.
    if target.exists() {
        remove_dir_all_if_present(&staging);
        return Err(already_installed_error(&manifest.id));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            InstalledAppError::io(&format!("creating {}", parent.display()), &error)
        })?;
    }
    if let Err(error) = std::fs::rename(&staging, &target) {
        remove_dir_all_if_present(&staging);
        if target.exists() {
            return Err(already_installed_error(&manifest.id));
        }
        return Err(InstalledAppError::io(
            &format!("publishing {}", target.display()),
            &error,
        ));
    }

    Ok(InstalledAppEntry::from_manifest(&manifest, installed_at))
}

/// The refusal for an id whose directory already exists.
fn already_installed_error(id: &str) -> InstalledAppError {
    InstalledAppError::field(
        InstalledAppRefusalCode::AlreadyInstalled,
        "id",
        format!("\"{id}\" is already installed; nothing was changed"),
    )
}

/// A short unique suffix for the staging directory name. Uses the process id and
/// a monotonic counter — no `rand` dependency, and a collision only costs a
/// retry-on-next-call (the staging dir is removed before use).
fn unique_suffix() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}-{nanos}-{counter}", std::process::id())
}

/// Index the archive without consuming it, so the manifest and every payload can
/// still be read afterwards.
fn archive_index_in_place<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> InstalledAppResult<archive::ArchiveIndex> {
    archive::index_archive_in_place(archive)
}

/// Is `relative_path` a REGULAR FILE in the index? A directory of the same name
/// does not satisfy an `entry` claim.
fn require_entry_file(
    index: &archive::ArchiveIndex,
    relative_path: &str,
    field: &str,
) -> InstalledAppResult<()> {
    let found = index
        .entries
        .iter()
        .any(|entry| entry.is_file && entry.relative_path == relative_path);
    if found {
        return Ok(());
    }
    Err(InstalledAppError::field(
        InstalledAppRefusalCode::EntryMissing,
        field,
        format!("{field} names \"{relative_path}\", which is not a file in the package"),
    ))
}

/// Write every payload file + `manifest.json` + `record.json` into `staging`.
///
/// Returns the RFC 3339 install timestamp. On error the caller removes the whole
/// staging directory, so a partial write can never be published.
fn write_staged_install<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    index: &archive::ArchiveIndex,
    manifest: &AppManifest,
    staging: &Path,
) -> InstalledAppResult<String> {
    let files_root = staging.join(INSTALLED_FILES_SUBDIR);
    std::fs::create_dir_all(&files_root).map_err(|error| {
        InstalledAppError::io(&format!("creating {}", files_root.display()), &error)
    })?;

    let mut files: Vec<InstalledFileRecord> = Vec::new();
    let mut chunk = vec![0u8; IO_CHUNK_BYTES];

    for entry in index.file_entries() {
        // The manifest is re-serialized as the canonical copy; it is not itself
        // a payload file, so it never appears in `files`.
        if entry.archive_name == PACKAGE_MANIFEST_FILENAME {
            continue;
        }

        let destination = archive::join_under_root(&files_root, &entry.relative_path)?;
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                InstalledAppError::io(&format!("creating {}", parent.display()), &error)
            })?;
        }

        let mut source = archive.by_name(&entry.archive_name).map_err(|error| {
            InstalledAppError::new(
                InstalledAppRefusalCode::NotAZip,
                format!("re-opening entry {:?}: {error}", entry.archive_name),
            )
        })?;

        let mut sink = File::create(&destination).map_err(|error| {
            InstalledAppError::io(&format!("creating {}", destination.display()), &error)
        })?;

        let mut hasher = Sha256::new();
        let mut written: u64 = 0;
        loop {
            let read = source.read(&mut chunk).map_err(|error| {
                InstalledAppError::new(
                    InstalledAppRefusalCode::IoError,
                    format!("reading entry {:?}: {error}", entry.archive_name),
                )
            })?;
            if read == 0 {
                break;
            }

            written = written.checked_add(read as u64).ok_or_else(|| {
                InstalledAppError::new(
                    InstalledAppRefusalCode::ArchiveTooLarge,
                    format!("entry {:?} exceeds the size counter", entry.archive_name),
                )
            })?;

            // Enforce the per-file declared size as we write: a declared size is
            // a claim, and a lying archive must not fill the disk.
            if written > entry.uncompressed_bytes {
                return Err(InstalledAppError::new(
                    InstalledAppRefusalCode::ArchiveTooLarge,
                    format!(
                        "entry {:?} decompressed past its declared {} bytes",
                        entry.archive_name, entry.uncompressed_bytes
                    ),
                ));
            }

            hasher.update(&chunk[..read]);
            sink.write_all(&chunk[..read]).map_err(|error| {
                InstalledAppError::io(&format!("writing {}", destination.display()), &error)
            })?;
        }

        sink.flush().map_err(|error| {
            InstalledAppError::io(&format!("flushing {}", destination.display()), &error)
        })?;

        if written != entry.uncompressed_bytes {
            return Err(InstalledAppError::new(
                InstalledAppRefusalCode::ArchiveTooLarge,
                format!(
                    "entry {:?} declared {} bytes but yielded {written}",
                    entry.archive_name, entry.uncompressed_bytes
                ),
            ));
        }

        files.push(InstalledFileRecord {
            path: entry.relative_path.clone(),
            sha256: hex_encode(&hasher.finalize()),
            bytes: written,
        });
    }

    files.sort_by(|left, right| left.path.cmp(&right.path));

    // `manifest.json` — the canonical normalized copy of what was validated.
    let canonical_manifest = serde_json::to_vec_pretty(manifest).map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::IoError,
            format!("serializing the canonical manifest: {error}"),
        )
    })?;
    let manifest_path = staging.join(INSTALLED_MANIFEST_FILENAME);
    std::fs::write(&manifest_path, &canonical_manifest).map_err(|error| {
        InstalledAppError::io(&format!("writing {}", manifest_path.display()), &error)
    })?;

    let installed_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let record = InstalledAppRecord {
        id: manifest.id.clone(),
        version: manifest.version.clone(),
        manifest_version: manifest.manifest_version,
        engines_fredo: manifest.engines.fredo.clone(),
        entry_document: manifest.entry.document.clone(),
        entry_module: manifest.entry.module.clone(),
        installed_at: installed_at.clone(),
        aggregate_sha256: aggregate_digest(&files),
        files,
        description: manifest.description.clone(),
        display_name: Some(manifest.display_name.clone()),
    };

    let record_json = serde_json::to_vec_pretty(&record).map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::IoError,
            format!("serializing the install record: {error}"),
        )
    })?;
    let record_path = staging.join(INSTALLED_RECORD_FILENAME);
    std::fs::write(&record_path, &record_json).map_err(|error| {
        InstalledAppError::io(&format!("writing {}", record_path.display()), &error)
    })?;

    Ok(installed_at)
}

/// Re-hash one installed file and compare it to its pin. The verify-at-serve
/// half is ST-3's; this is the primitive it shares (and the QA row T-N2's
/// independent recomputation target).
pub fn verify_file(app_dir: &Path, file: &InstalledFileRecord) -> InstalledAppResult<()> {
    let root = app_dir.join(INSTALLED_FILES_SUBDIR);
    let path = archive::join_under_root(&root, &file.path)?;
    let bytes = std::fs::read(&path).map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::IntegrityMismatch,
            format!("{} could not be read: {error}", path.display()),
        )
    })?;
    let actual = sha256_hex(&bytes);
    if actual != file.sha256 || bytes.len() as u64 != file.bytes {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::IntegrityMismatch,
            format!(
                "{} changed since install: recorded {} ({} bytes), found {} ({} bytes)",
                file.path,
                file.sha256,
                file.bytes,
                actual,
                bytes.len()
            ),
        ));
    }
    Ok(())
}

/// Read one installed file's bytes, verifying its pin first.
pub fn read_verified_file(app_dir: &Path, file: &InstalledFileRecord) -> InstalledAppResult<Vec<u8>> {
    let root = app_dir.join(INSTALLED_FILES_SUBDIR);
    let path = archive::join_under_root(&root, &file.path)?;
    let bytes = std::fs::read(&path).map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::IntegrityMismatch,
            format!("{} could not be read: {error}", path.display()),
        )
    })?;
    if sha256_hex(&bytes) != file.sha256 {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::IntegrityMismatch,
            format!("{} does not match its recorded hash", file.path),
        ));
    }
    Ok(bytes)
}

/// Read a package archive from a `BufReader` (test seam).
pub fn open_from_reader<R: Read + std::io::Seek>(reader: R) -> InstalledAppResult<ZipArchive<R>> {
    ZipArchive::new(reader).map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::NotAZip,
            format!("not a readable ZIP archive: {error}"),
        )
    })
}

/// Read `buf` from a file into memory (helper for tests + ST-3).
pub fn read_file_bytes(path: &Path) -> InstalledAppResult<Vec<u8>> {
    let file = File::open(path)
        .map_err(|error| InstalledAppError::io(&format!("opening {}", path.display()), &error))?;
    let mut reader = BufReader::new(file);
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|error| InstalledAppError::io(&format!("reading {}", path.display()), &error))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::installed_apps::archive::{index_archive, read_entry_bytes};
    use std::io::{Cursor, Seek};

    // ── Deterministic stored-entry zip builder (mirrors the fixture generator) ──

    fn crc32(data: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for byte in data {
            crc ^= *byte as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 { 0xedb8_8320 ^ (crc >> 1) } else { crc >> 1 };
            }
        }
        crc ^ 0xffff_ffff
    }

    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out: Vec<u8> = Vec::new();
        let mut central: Vec<u8> = Vec::new();

        for (name, data) in entries {
            let offset = out.len() as u32;
            let crc = crc32(data);
            let size = data.len() as u32;
            let name_bytes = name.as_bytes();
            let name_len = name_bytes.len() as u16;

            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&20u16.to_le_bytes());
            out.extend_from_slice(&0x0800u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0x0000u16.to_le_bytes());
            out.extend_from_slice(&0x0021u16.to_le_bytes());
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&name_len.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name_bytes);
            out.extend_from_slice(data);

            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&0x0800u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0x0000u16.to_le_bytes());
            central.extend_from_slice(&0x0021u16.to_le_bytes());
            central.extend_from_slice(&crc.to_le_bytes());
            central.extend_from_slice(&size.to_le_bytes());
            central.extend_from_slice(&size.to_le_bytes());
            central.extend_from_slice(&name_len.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u32.to_le_bytes());
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name_bytes);
        }

        let central_offset = out.len() as u32;
        let central_size = central.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&central_size.to_le_bytes());
        out.extend_from_slice(&central_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    /// A valid manifest body matching the entry pair used by [`valid_package`].
    fn manifest_json(id: &str) -> String {
        format!(
            r#"{{
  "manifestVersion": 1,
  "id": "{id}",
  "displayName": "QA3147 Sample",
  "version": "1.2.3",
  "engines": {{ "fredo": ">=0.0.0" }},
  "entry": {{ "document": "index.html", "module": "main.js" }},
  "description": "A sample package."
}}"#
        )
    }

    fn valid_package(id: &str) -> Vec<u8> {
        let manifest = manifest_json(id);
        build_zip(&[
            (PACKAGE_MANIFEST_FILENAME, manifest.as_bytes()),
            ("index.html", b"<!doctype html><html><body>hi</body></html>"),
            ("main.js", b"export function mount(ctx) { ctx.root.textContent = 'hi'; }"),
            ("assets/logo.png", b"\x89PNG\r\n\x1a\n-fake-"),
        ])
    }

    /// Write `bytes` to a temp `.zip` and return (tempdir, path).
    fn staged_zip(bytes: &[u8]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("package.zip");
        std::fs::write(&path, bytes).expect("write zip");
        (dir, path)
    }

    fn data_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    // ── Layout + projection ────────────────────────────────────────────────

    #[test]
    fn the_install_root_is_installed_apps_under_the_data_dir() {
        let root = install_root(Path::new("C:/data"));
        assert_eq!(root, Path::new("C:/data").join("installed-apps"));
        assert!(root.ends_with("installed-apps"));
    }

    #[test]
    fn the_staging_root_is_a_sibling_of_the_registry_not_a_child() {
        let data = Path::new("C:/data");
        let registry = install_root(data);
        let staging = staging_root(data);
        assert!(!staging.starts_with(&registry), "staging must not be inside the registry");
        assert_eq!(staging.parent(), registry.parent());
    }

    #[test]
    fn the_window_label_is_the_prefixed_id() {
        assert_eq!(window_label_for("qa3147-sample"), "installed-qa3147-sample");
    }

    #[test]
    fn the_entry_projection_carries_every_axis() {
        let manifest = manifest::parse_manifest(manifest_json("qa3147-sample").as_bytes())
            .expect("manifest");
        let entry = InstalledAppEntry::from_manifest(&manifest, "2026-01-01T00:00:00Z".to_string());
        assert_eq!(entry.id, "qa3147-sample");
        assert_eq!(entry.display_name, "QA3147 Sample");
        assert_eq!(entry.version, "1.2.3");
        assert_eq!(entry.engines_fredo, ">=0.0.0");
        assert_eq!(entry.installed_at, "2026-01-01T00:00:00Z");
        assert_eq!(entry.window_label, "installed-qa3147-sample");
        assert_eq!(entry.description.as_deref(), Some("A sample package."));
        // Spec #3146: the capability status is always carried, empty when undeclared.
        assert_eq!(entry.capabilities.app_id, "qa3147-sample");
        assert!(entry.capabilities.declared.is_empty());
    }

    #[test]
    fn the_entry_projection_omits_description_when_unset() {
        let json = r#"{
            "manifestVersion": 1,
            "id": "qa3147-nodesc",
            "displayName": "No Description",
            "version": "1.0.0",
            "engines": { "fredo": ">=0.0.0" },
            "entry": { "document": "index.html", "module": "main.js" }
        }"#;
        let manifest = manifest::parse_manifest(json.as_bytes()).expect("manifest");
        let entry = InstalledAppEntry::from_manifest(&manifest, "2026-01-01T00:00:00Z".into());
        let value = serde_json::to_value(&entry).expect("serialize");
        assert!(
            !value.as_object().expect("object").contains_key("description"),
            "an unset description must be an ABSENT key: {value}"
        );
    }

    #[test]
    fn the_entry_projection_falls_back_to_the_id_when_the_record_has_no_display_name() {
        let record = InstalledAppRecord {
            id: "qa3147-fallback".into(),
            version: "1.0.0".into(),
            manifest_version: 1,
            engines_fredo: ">=0.0.0".into(),
            entry_document: "index.html".into(),
            entry_module: "main.js".into(),
            installed_at: "2026-01-01T00:00:00Z".into(),
            aggregate_sha256: aggregate_digest(&[]),
            files: Vec::new(),
            description: None,
            display_name: None,
        };
        let manifest = manifest::parse_manifest(manifest_json("qa3147-fallback").as_bytes())
            .expect("manifest");
        let entry = InstalledAppEntry::from_installed(&record, &manifest);
        assert_eq!(entry.display_name, "qa3147-fallback");
        assert_eq!(entry.window_label, "installed-qa3147-fallback");
    }

    // ── The capability projection (Spec #3146) ─────────────────────────────

    fn declared_manifest(id: &str) -> AppManifest {
        let json = format!(
            r#"{{
                "manifestVersion": 1,
                "id": "{id}",
                "displayName": "Declared {id}",
                "version": "1.0.0",
                "engines": {{ "fredo": ">=0.0.0" }},
                "entry": {{ "document": "index.html", "module": "main.js" }},
                "capabilities": {{
                    "version": 1,
                    "highRisk": ["high-risk.database-query", "high-risk.database-reset"]
                }}
            }}"#
        );
        manifest::parse_manifest(json.as_bytes()).expect("manifest")
    }

    #[test]
    fn an_undeclared_package_projects_three_empty_arrays_that_are_always_present() {
        let manifest =
            manifest::parse_manifest(manifest_json("qa3146-none").as_bytes()).expect("manifest");
        let entry = InstalledAppEntry::from_manifest(&manifest, "2026-01-01T00:00:00Z".into());

        assert_eq!(entry.capabilities.app_id, "qa3146-none");
        assert!(entry.capabilities.declared.is_empty());
        assert!(entry.capabilities.high_risk.is_empty());
        assert!(entry.capabilities.consented.is_empty());

        let value = serde_json::to_value(&entry).expect("serialize");
        let capabilities = value
            .get("capabilities")
            .expect("`capabilities` is the wire key and is ALWAYS present")
            .as_object()
            .expect("object");
        assert!(
            !value
                .as_object()
                .expect("entry")
                .contains_key("installedAppCapabilities"),
            "the stale projection spelling must never appear on the wire"
        );
        assert_eq!(capabilities.len(), 4, "appId + three arrays: {value}");
        for key in ["appId", "declared", "highRisk", "consented"] {
            assert!(capabilities.contains_key(key), "{key} must be present: {value}");
        }
    }

    #[test]
    fn a_declared_package_projects_sorted_declared_and_high_risk_arrays() {
        let manifest = declared_manifest("qa3146-app-a");
        let entry = InstalledAppEntry::from_manifest(&manifest, "2026-01-01T00:00:00Z".into());

        assert_eq!(
            entry.capabilities.declared,
            ["high-risk.database-query", "high-risk.database-reset"],
            "sorted; no data.tables because `capabilities.data` is absent"
        );
        assert_eq!(entry.capabilities.high_risk, entry.capabilities.declared);
        assert!(
            entry.capabilities.consented.is_empty(),
            "installing never consents"
        );
    }

    #[test]
    fn consent_never_leaks_from_one_application_to_another() {
        let app_a = InstalledAppEntry::from_manifest(
            &declared_manifest("qa3146-consent-a"),
            "2026-01-01T00:00:00Z".into(),
        );
        let app_b = InstalledAppEntry::from_manifest(
            &declared_manifest("qa3146-consent-b"),
            "2026-01-01T00:00:01Z".into(),
        );

        // The user grants ONE capability to A.
        let granted = vec!["high-risk.database-query".to_string()];
        let a = app_a.with_consented(&granted);
        let b = app_b.with_consented(&[]);

        assert_eq!(a.capabilities.consented, ["high-risk.database-query"]);
        assert!(a.capabilities.is_consented("high-risk.database-query"));
        assert!(!a.capabilities.is_consented("high-risk.database-reset"));

        // B declares the same capability and stays refused.
        assert!(
            b.capabilities.consented.is_empty(),
            "a grant to A must never enable B"
        );
        assert!(!b.capabilities.is_consented("high-risk.database-query"));
    }

    #[test]
    fn a_consent_record_cannot_widen_a_declaration() {
        let entry = InstalledAppEntry::from_manifest(
            &declared_manifest("qa3146-narrow"),
            "2026-01-01T00:00:00Z".into(),
        );
        // A hand-edited consent file naming an undeclared id, a non-high-risk id
        // and a duplicate: only the declared high-risk id survives, once.
        let granted = vec![
            "high-risk.process-spawn".to_string(),
            "data.tables".to_string(),
            "high-risk.database-reset".to_string(),
            "high-risk.database-reset".to_string(),
        ];
        let projected = entry.with_consented(&granted);
        assert_eq!(
            projected.capabilities.consented,
            ["high-risk.database-reset"],
            "consent records a decision about a declaration; it never creates one"
        );
    }

    // ── Hashing + aggregate ────────────────────────────────────────────────

    #[test]
    fn sha256_hex_matches_the_known_digest_of_an_empty_and_a_known_input() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn the_aggregate_digest_is_order_independent_and_path_sensitive() {
        let a = InstalledFileRecord {
            path: "a.txt".into(),
            sha256: "11".repeat(32),
            bytes: 1,
        };
        let b = InstalledFileRecord {
            path: "b.txt".into(),
            sha256: "22".repeat(32),
            bytes: 2,
        };

        let forwards = aggregate_digest(&[a.clone(), b.clone()]);
        let backwards = aggregate_digest(&[b.clone(), a.clone()]);
        assert_eq!(forwards, backwards, "the digest is over the SORTED set");

        let mut changed = a.clone();
        changed.path = "c.txt".into();
        assert_ne!(
            aggregate_digest(&[a.clone(), b.clone()]),
            aggregate_digest(&[changed, b]),
            "the path participates in the digest"
        );
    }

    #[test]
    fn the_aggregate_digest_of_an_empty_set_is_the_empty_sha256() {
        assert_eq!(aggregate_digest(&[]), sha256_hex(b""));
    }

    // ── The install happy path ─────────────────────────────────────────────

    #[test]
    fn a_valid_package_installs_with_the_documented_layout() {
        let data = data_dir();
        let (_zip_dir, zip_path) = staged_zip(&valid_package("qa3147-sample"));

        let entry = install_archive(data.path(), &zip_path).expect("install");
        assert_eq!(entry.id, "qa3147-sample");
        assert_eq!(entry.display_name, "QA3147 Sample");
        assert_eq!(entry.window_label, "installed-qa3147-sample");

        let root = install_root(data.path());
        let dir = app_dir(&root, "qa3147-sample");
        assert!(dir.join(INSTALLED_MANIFEST_FILENAME).is_file(), "manifest.json");
        assert!(dir.join(INSTALLED_RECORD_FILENAME).is_file(), "record.json");
        let files = dir.join(INSTALLED_FILES_SUBDIR);
        assert!(files.join("index.html").is_file());
        assert!(files.join("main.js").is_file());
        assert!(files.join("assets").join("logo.png").is_file());
        assert!(
            !files.join(PACKAGE_MANIFEST_FILENAME).exists(),
            "the manifest is the canonical copy, not a payload file"
        );

        // Staging is cleaned up.
        let staging = staging_root(data.path());
        let leftovers: Vec<_> = std::fs::read_dir(&staging)
            .map(|entries| entries.filter_map(std::result::Result::ok).collect())
            .unwrap_or_default();
        assert!(leftovers.is_empty(), "staging must be empty after success");
    }

    #[test]
    fn the_record_pins_every_file_sorted_with_an_aggregate_digest() {
        let data = data_dir();
        let (_zip_dir, zip_path) = staged_zip(&valid_package("qa3147-pinned"));
        install_archive(data.path(), &zip_path).expect("install");

        let dir = app_dir(&install_root(data.path()), "qa3147-pinned");
        let record = read_record(&dir).expect("record");

        let paths: Vec<&str> = record.files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, vec!["assets/logo.png", "index.html", "main.js"]);
        let mut sorted = paths.clone();
        sorted.sort_unstable();
        assert_eq!(paths, sorted, "files are sorted by path");

        for file in &record.files {
            let on_disk = dir.join(INSTALLED_FILES_SUBDIR).join(&file.path);
            let bytes = std::fs::read(&on_disk).expect("read");
            assert_eq!(sha256_hex(&bytes), file.sha256, "{} pin", file.path);
            assert_eq!(bytes.len() as u64, file.bytes, "{} size", file.path);
        }

        assert_eq!(record.aggregate_sha256, aggregate_digest(&record.files));
        assert_eq!(record.entry_document, "index.html");
        assert_eq!(record.entry_module, "main.js");
        assert_eq!(record.manifest_version, 1);
        assert_eq!(record.engines_fredo, ">=0.0.0");
        assert!(chrono::DateTime::parse_from_rfc3339(&record.installed_at).is_ok());
    }

    #[test]
    fn the_canonical_manifest_copy_round_trips() {
        let data = data_dir();
        let (_zip_dir, zip_path) = staged_zip(&valid_package("qa3147-canonical"));
        install_archive(data.path(), &zip_path).expect("install");

        let dir = app_dir(&install_root(data.path()), "qa3147-canonical");
        let manifest = read_manifest_file(&dir).expect("canonical manifest");
        assert_eq!(manifest.id, "qa3147-canonical");
        assert_eq!(manifest.display_name, "QA3147 Sample");
        assert_eq!(manifest.entry.document, "index.html");
        assert_eq!(manifest.entry.module, "main.js");
    }

    #[test]
    fn verify_file_accepts_an_untouched_install_and_the_record_listing_round_trips() {
        let data = data_dir();
        let (_zip_dir, zip_path) = staged_zip(&valid_package("qa3147-verified"));
        install_archive(data.path(), &zip_path).expect("install");

        let dir = app_dir(&install_root(data.path()), "qa3147-verified");
        let record = read_record(&dir).expect("record");
        for file in &record.files {
            verify_file(&dir, file).expect("untouched file verifies");
        }

        let listed = list_installed(&install_root(data.path())).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "qa3147-verified");
    }

    // ── Integrity detection (the record ST-3 checks against) ───────────────

    #[test]
    fn a_mutated_byte_is_integrity_mismatch() {
        let data = data_dir();
        let (_zip_dir, zip_path) = staged_zip(&valid_package("qa3147-tamper"));
        install_archive(data.path(), &zip_path).expect("install");

        let dir = app_dir(&install_root(data.path()), "qa3147-tamper");
        let record = read_record(&dir).expect("record");
        let target = dir.join(INSTALLED_FILES_SUBDIR).join("main.js");

        let mut bytes = std::fs::read(&target).expect("read");
        bytes[0] ^= 0xff;
        std::fs::write(&target, &bytes).expect("write");

        let file = record
            .files
            .iter()
            .find(|file| file.path == "main.js")
            .expect("main.js record");
        let error = verify_file(&dir, file).expect_err("mutated");
        assert_eq!(error.code, InstalledAppRefusalCode::IntegrityMismatch);
        assert!(error.detail.contains("main.js"));

        let error = read_verified_file(&dir, file).expect_err("mutated read");
        assert_eq!(error.code, InstalledAppRefusalCode::IntegrityMismatch);
    }

    #[test]
    fn a_truncated_record_is_integrity_record_corrupt() {
        let data = data_dir();
        let (_zip_dir, zip_path) = staged_zip(&valid_package("qa3147-corrupt"));
        install_archive(data.path(), &zip_path).expect("install");

        let dir = app_dir(&install_root(data.path()), "qa3147-corrupt");
        let record_path = dir.join(INSTALLED_RECORD_FILENAME);
        let bytes = std::fs::read(&record_path).expect("read");
        std::fs::write(&record_path, &bytes[..bytes.len() / 2]).expect("truncate");

        let error = read_record(&dir).expect_err("truncated");
        assert_eq!(
            error.code,
            InstalledAppRefusalCode::IntegrityRecordCorrupt,
            "a damaged record is NOT a generic io_error (T-4.5)"
        );
    }

    // ── Refusals leave the registry untouched ──────────────────────────────

    /// Assert no `<id>/` exists and staging is empty after a refusal.
    fn assert_nothing_installed(data: &Path, id: &str) {
        let root = install_root(data);
        assert!(
            !app_dir(&root, id).exists(),
            "refusal must leave no {id}/ behind"
        );
        let staging = staging_root(data);
        let leftovers: Vec<_> = std::fs::read_dir(&staging)
            .map(|entries| entries.filter_map(std::result::Result::ok).collect())
            .unwrap_or_default();
        assert!(leftovers.is_empty(), "refusal must leave no staging debris");
    }

    #[test]
    fn a_package_without_a_manifest_is_no_manifest_and_installs_nothing() {
        let data = data_dir();
        let (_zip_dir, zip_path) = staged_zip(&build_zip(&[("index.html", b"<html></html>")]));

        let error = install_archive(data.path(), &zip_path).expect_err("no manifest");
        assert_eq!(error.code, InstalledAppRefusalCode::NoManifest);
        assert_nothing_installed(data.path(), "qa3147-sample");
    }

    #[test]
    fn a_non_zip_file_is_not_a_zip_and_installs_nothing() {
        let data = data_dir();
        let (_zip_dir, zip_path) = staged_zip(b"this is definitely not a zip archive");

        let error = install_archive(data.path(), &zip_path).expect_err("not a zip");
        assert_eq!(error.code, InstalledAppRefusalCode::NotAZip);
        assert_eq!(
            install_root(data.path()).read_dir().map(|d| d.count()).unwrap_or(0),
            0,
            "no install root content"
        );
    }

    #[test]
    fn an_unparseable_manifest_is_manifest_malformed_and_installs_nothing() {
        let data = data_dir();
        let (_zip_dir, zip_path) = staged_zip(&build_zip(&[
            (PACKAGE_MANIFEST_FILENAME, b"{ this is not json"),
            ("index.html", b"<html></html>"),
            ("main.js", b"//"),
        ]));

        let error = install_archive(data.path(), &zip_path).expect_err("bad manifest");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestMalformed);
        assert_nothing_installed(data.path(), "qa3147-sample");
    }

    /// INVERTED IN PLACE (Spec #3146): `capabilities` used to be the canonical
    /// unknown key. It is now a defined top-level key, so the SAME property — an
    /// unknown manifest key refuses the install with `manifest_unknown_field`
    /// naming the key, and nothing is installed — is asserted against a key that
    /// is still unknown.
    #[test]
    fn an_unknown_manifest_key_is_manifest_unknown_field() {
        let data = data_dir();
        let manifest = r#"{
            "manifestVersion": 1,
            "id": "qa3147-unknown",
            "displayName": "Unknown",
            "version": "1.0.0",
            "engines": { "fredo": ">=0.0.0" },
            "entry": { "document": "index.html", "module": "main.js" },
            "sandbox": ["read"]
        }"#;
        let (_zip_dir, zip_path) = staged_zip(&build_zip(&[
            (PACKAGE_MANIFEST_FILENAME, manifest.as_bytes()),
            ("index.html", b"<html></html>"),
            ("main.js", b"//"),
        ]));

        let error = install_archive(data.path(), &zip_path).expect_err("unknown key");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestUnknownField);
        assert_eq!(error.field.as_deref(), Some("sandbox"));
        assert_nothing_installed(data.path(), "qa3147-unknown");
    }

    #[test]
    fn an_unsupported_manifest_version_is_unsupported_and_installs_nothing() {
        let data = data_dir();
        let manifest = r#"{
            "manifestVersion": 7,
            "id": "qa3147-future",
            "displayName": "Future",
            "version": "1.0.0",
            "engines": { "fredo": ">=0.0.0" },
            "entry": { "document": "index.html", "module": "main.js" }
        }"#;
        let (_zip_dir, zip_path) = staged_zip(&build_zip(&[
            (PACKAGE_MANIFEST_FILENAME, manifest.as_bytes()),
            ("index.html", b"<html></html>"),
            ("main.js", b"//"),
        ]));

        let error = install_archive(data.path(), &zip_path).expect_err("future version");
        assert_eq!(
            error.code,
            InstalledAppRefusalCode::UnsupportedManifestVersion
        );
        assert_nothing_installed(data.path(), "qa3147-future");
    }

    #[test]
    fn a_reserved_built_in_id_is_id_reserved() {
        let data = data_dir();
        let (_zip_dir, zip_path) = staged_zip(&build_zip(&[
            (PACKAGE_MANIFEST_FILENAME, manifest_json("terminal").as_bytes()),
            ("index.html", b"<html></html>"),
            ("main.js", b"//"),
        ]));

        let error = install_archive(data.path(), &zip_path).expect_err("reserved id");
        assert_eq!(error.code, InstalledAppRefusalCode::IdReserved);
        assert_nothing_installed(data.path(), "terminal");
    }

    #[test]
    fn an_entry_naming_an_absent_file_is_entry_missing() {
        let data = data_dir();
        let manifest = r#"{
            "manifestVersion": 1,
            "id": "qa3147-missing-entry",
            "displayName": "Missing Entry",
            "version": "1.0.0",
            "engines": { "fredo": ">=0.0.0" },
            "entry": { "document": "index.html", "module": "absent.js" }
        }"#;
        let (_zip_dir, zip_path) = staged_zip(&build_zip(&[
            (PACKAGE_MANIFEST_FILENAME, manifest.as_bytes()),
            ("index.html", b"<html></html>"),
        ]));

        let error = install_archive(data.path(), &zip_path).expect_err("missing module");
        assert_eq!(error.code, InstalledAppRefusalCode::EntryMissing);
        assert_eq!(error.field.as_deref(), Some("entry.module"));
        assert_nothing_installed(data.path(), "qa3147-missing-entry");
    }

    #[test]
    fn a_zip_slip_entry_is_unsafe_path_and_installs_nothing() {
        let data = data_dir();
        let (_zip_dir, zip_path) = staged_zip(&build_zip(&[
            (PACKAGE_MANIFEST_FILENAME, manifest_json("qa3147-slip").as_bytes()),
            ("index.html", b"<html></html>"),
            ("main.js", b"//"),
            ("../../escaped.txt", b"owned"),
        ]));

        let error = install_archive(data.path(), &zip_path).expect_err("zip slip");
        assert_eq!(error.code, InstalledAppRefusalCode::UnsafePath);
        assert_nothing_installed(data.path(), "qa3147-slip");
        // And nothing landed next to the app-data dir.
        assert!(!data.path().parent().expect("parent").join("escaped.txt").exists());
    }

    #[test]
    fn a_reserved_fredo_path_is_reserved_path_and_installs_nothing() {
        let data = data_dir();
        let (_zip_dir, zip_path) = staged_zip(&build_zip(&[
            (PACKAGE_MANIFEST_FILENAME, manifest_json("qa3147-reserved").as_bytes()),
            ("index.html", b"<html></html>"),
            ("main.js", b"//"),
            ("__fredo/bootstrap.js", b"// host-owned"),
        ]));

        let error = install_archive(data.path(), &zip_path).expect_err("reserved path");
        assert_eq!(error.code, InstalledAppRefusalCode::ReservedPath);
        assert_nothing_installed(data.path(), "qa3147-reserved");
    }

    #[test]
    fn an_incompatible_engines_range_is_host_incompatible_and_installs_nothing() {
        let data = data_dir();
        let manifest = r#"{
            "manifestVersion": 1,
            "id": "qa3147-incompatible",
            "displayName": "Incompatible",
            "version": "1.0.0",
            "engines": { "fredo": ">=999.0.0" },
            "entry": { "document": "index.html", "module": "main.js" }
        }"#;
        let (_zip_dir, zip_path) = staged_zip(&build_zip(&[
            (PACKAGE_MANIFEST_FILENAME, manifest.as_bytes()),
            ("index.html", b"<html></html>"),
            ("main.js", b"//"),
        ]));

        let error = install_archive(data.path(), &zip_path).expect_err("incompatible");
        assert_eq!(error.code, InstalledAppRefusalCode::HostIncompatible);
        assert_eq!(error.field.as_deref(), Some("engines.fredo"));
        assert_nothing_installed(data.path(), "qa3147-incompatible");
    }

    #[test]
    fn a_star_engines_range_is_engines_range_invalid() {
        let data = data_dir();
        let manifest = r#"{
            "manifestVersion": 1,
            "id": "qa3147-star",
            "displayName": "Star",
            "version": "1.0.0",
            "engines": { "fredo": "*" },
            "entry": { "document": "index.html", "module": "main.js" }
        }"#;
        let (_zip_dir, zip_path) = staged_zip(&build_zip(&[
            (PACKAGE_MANIFEST_FILENAME, manifest.as_bytes()),
            ("index.html", b"<html></html>"),
            ("main.js", b"//"),
        ]));

        let error = install_archive(data.path(), &zip_path).expect_err("star range");
        assert_eq!(error.code, InstalledAppRefusalCode::EnginesRangeInvalid);
        assert_nothing_installed(data.path(), "qa3147-star");
    }

    #[test]
    fn a_second_install_of_the_same_id_is_already_installed_and_preserves_the_first() {
        let data = data_dir();
        let (_zip_a, zip_a) = staged_zip(&valid_package("qa3147-twice"));
        install_archive(data.path(), &zip_a).expect("first install");

        let dir = app_dir(&install_root(data.path()), "qa3147-twice");
        let before = std::fs::read(dir.join(INSTALLED_RECORD_FILENAME)).expect("record before");

        let (_zip_b, zip_b) = staged_zip(&valid_package("qa3147-twice"));
        let error = install_archive(data.path(), &zip_b).expect_err("second install");
        assert_eq!(error.code, InstalledAppRefusalCode::AlreadyInstalled);

        let after = std::fs::read(dir.join(INSTALLED_RECORD_FILENAME)).expect("record after");
        assert_eq!(before, after, "the first installation is byte-identical");
        assert_eq!(list_installed(&install_root(data.path())).expect("list").len(), 1);
    }

    // ── Listing ────────────────────────────────────────────────────────────

    #[test]
    fn an_absent_install_root_lists_as_empty_not_an_error() {
        let data = data_dir();
        let listed = list_installed(&install_root(data.path())).expect("absent root is empty");
        assert!(listed.is_empty());
    }

    #[test]
    fn listing_returns_every_install_sorted_by_id() {
        let data = data_dir();
        for id in ["qa3147-zulu", "qa3147-alpha"] {
            let (_zip_dir, zip_path) = staged_zip(&valid_package(id));
            install_archive(data.path(), &zip_path).expect("install");
        }
        let listed = list_installed(&install_root(data.path())).expect("list");
        let ids: Vec<&str> = listed.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(ids, vec!["qa3147-alpha", "qa3147-zulu"]);
    }

    #[test]
    fn a_directory_that_cannot_be_an_app_id_is_not_a_registry_entry() {
        let data = data_dir();
        let root = install_root(data.path());
        std::fs::create_dir_all(root.join("Not An Id")).expect("dir");
        std::fs::create_dir_all(root.join(".hidden")).expect("dir");

        let listed = list_installed(&root).expect("list");
        assert!(listed.is_empty(), "non-id directories are skipped");
    }

    #[test]
    fn a_damaged_install_is_a_failing_row_and_the_others_still_list() {
        let data = data_dir();
        for id in ["qa3144-good-a", "qa3144-good-b"] {
            let (_zip_dir, zip_path) = staged_zip(&valid_package(id));
            install_archive(data.path(), &zip_path).expect("install");
        }
        let (_zip_dir, zip_path) = staged_zip(&valid_package("qa3144-damaged"));
        install_archive(data.path(), &zip_path).expect("install");

        let dir = app_dir(&install_root(data.path()), "qa3144-damaged");
        std::fs::write(dir.join(INSTALLED_RECORD_FILENAME), b"").expect("truncate record");

        // The listing does NOT abort: every application is present, and the
        // damaged one is a Failing row (Spec #3144 — the shipped defect fix).
        let listed = list_installed(&install_root(data.path())).expect("listing survives damage");
        let ids: Vec<&str> = listed.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["qa3144-damaged", "qa3144-good-a", "qa3144-good-b"],
            "one damaged record must not hide the others"
        );

        let damaged = listed
            .iter()
            .find(|entry| entry.id == "qa3144-damaged")
            .expect("the damaged app is still listed");
        assert_eq!(damaged.state, InstalledAppState::Failing);
        assert_eq!(
            damaged.failure_code,
            Some(InstalledAppRefusalCode::IntegrityRecordCorrupt)
        );
        // Identity falls back to the registry id, and the reach fails closed.
        assert_eq!(damaged.display_name, "qa3144-damaged");
        assert_eq!(damaged.version, "");
        assert_eq!(damaged.engines_fredo, "");
        assert_eq!(damaged.installed_at, "");
        assert!(damaged.description.is_none());
        assert!(damaged.capabilities.declared.is_empty());

        for good in ["qa3144-good-a", "qa3144-good-b"] {
            let entry = listed.iter().find(|entry| entry.id == good).expect(good);
            assert_eq!(entry.state, InstalledAppState::Working);
            assert!(entry.failure_code.is_none());
            assert_eq!(entry.display_name, "QA3147 Sample");
        }
    }

    #[test]
    fn a_damaged_manifest_is_also_a_failing_row_with_empty_capabilities() {
        let data = data_dir();
        let (_zip_dir, zip_path) = staged_zip(&valid_package("qa3144-manifest-damaged"));
        install_archive(data.path(), &zip_path).expect("install");

        let dir = app_dir(&install_root(data.path()), "qa3144-manifest-damaged");
        std::fs::write(dir.join(INSTALLED_MANIFEST_FILENAME), b"{ not a manifest")
            .expect("corrupt manifest");

        let listed = list_installed_resilient(&install_root(data.path())).expect("listing");
        assert_eq!(listed.len(), 1);
        let entry = &listed[0];
        assert_eq!(entry.state, InstalledAppState::Failing);
        assert_eq!(
            entry.failure_code,
            Some(InstalledAppRefusalCode::IntegrityRecordCorrupt)
        );
        // The identity survives (it is in the record); the reach fails closed.
        assert_eq!(entry.display_name, "QA3147 Sample");
        assert_eq!(entry.version, "1.2.3");
        assert!(entry.capabilities.declared.is_empty());
    }

    #[test]
    fn the_entry_wire_shape_carries_state_and_omits_failure_code_when_not_failing() {
        let manifest =
            manifest::parse_manifest(manifest_json("qa3147-sample").as_bytes()).expect("manifest");
        let entry = InstalledAppEntry::from_manifest(&manifest, "2026-01-01T00:00:00Z".into());
        let value = serde_json::to_value(&entry).expect("serialize");
        assert_eq!(value.get("state").and_then(|v| v.as_str()), Some("working"));
        assert!(
            !value.as_object().expect("object").contains_key("failureCode"),
            "a non-failing entry has an ABSENT failureCode key: {value}"
        );

        let failing =
            entry.with_lifecycle(InstalledAppState::Failing, Some(InstalledAppRefusalCode::IntegrityMismatch));
        let value = serde_json::to_value(&failing).expect("serialize");
        assert_eq!(value.get("state").and_then(|v| v.as_str()), Some("failing"));
        assert_eq!(
            value.get("failureCode").and_then(|v| v.as_str()),
            Some("integrity_mismatch")
        );
    }

    // ── Removal primitives (Spec #3144) ────────────────────────────────────

    #[test]
    fn the_removal_root_is_a_sibling_of_the_registry_not_a_child() {
        let data = Path::new("C:/data");
        let registry = install_root(data);
        let removal = removal_root(data);
        assert!(!removal.starts_with(&registry));
        assert_eq!(removal.parent(), registry.parent());
        assert!(removal.ends_with("installed-apps-removing"));
    }

    #[test]
    fn remove_install_drops_the_directory_and_leaves_no_debris() {
        let data = data_dir();
        let (_zip_dir, zip_path) = staged_zip(&valid_package("qa3144-remove"));
        install_archive(data.path(), &zip_path).expect("install");

        remove_install(data.path(), "qa3144-remove").expect("remove");
        assert!(
            !app_dir(&install_root(data.path()), "qa3144-remove").exists(),
            "the install directory is gone"
        );
        assert!(
            list_installed(&install_root(data.path())).expect("list").is_empty(),
            "nothing is listed"
        );
        let debris: Vec<_> = std::fs::read_dir(removal_root(data.path()))
            .map(|entries| entries.filter_map(std::result::Result::ok).collect())
            .unwrap_or_default();
        assert!(debris.is_empty(), "no debris remains");
    }

    #[test]
    fn remove_install_of_an_unknown_id_is_id_not_installed() {
        let data = data_dir();
        let error = remove_install(data.path(), "qa3144-ghost").expect_err("nothing to remove");
        assert_eq!(error.code, InstalledAppRefusalCode::IdNotInstalled);
        assert_eq!(error.field.as_deref(), Some("appId"));
    }

    #[test]
    fn a_declared_install_keeps_its_declaration_and_lists_it() {
        let data = data_dir();
        let manifest = r#"{
            "manifestVersion": 1,
            "id": "qa3146-declared",
            "displayName": "Declared",
            "version": "1.0.0",
            "engines": { "fredo": ">=0.0.0" },
            "entry": { "document": "index.html", "module": "main.js" },
            "capabilities": {
                "version": 1,
                "highRisk": ["high-risk.database-reset", "high-risk.database-query"]
            }
        }"#;
        let (_zip_dir, zip_path) = staged_zip(&build_zip(&[
            (PACKAGE_MANIFEST_FILENAME, manifest.as_bytes()),
            ("index.html", b"<html></html>"),
            ("main.js", b"//"),
        ]));

        let installed = install_archive(data.path(), &zip_path).expect("install");
        assert_eq!(
            installed.capabilities.high_risk,
            ["high-risk.database-query", "high-risk.database-reset"],
            "the install result carries the sorted declaration"
        );

        // The canonical manifest is the declaration's ONE host-side copy.
        let dir = app_dir(&install_root(data.path()), "qa3146-declared");
        let canonical = std::fs::read_to_string(dir.join(INSTALLED_MANIFEST_FILENAME))
            .expect("read canonical manifest");
        assert!(
            canonical.contains("\"capabilities\""),
            "the canonical copy records the declaration: {canonical}"
        );

        let listed = list_installed(&install_root(data.path())).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(
            listed[0].capabilities.declared,
            ["high-risk.database-query", "high-risk.database-reset"]
        );
        assert!(
            listed[0].capabilities.consented.is_empty(),
            "listing alone never consents"
        );
    }

    // ── Test-sea helpers stay honest ───────────────────────────────────────

    #[test]
    fn the_in_memory_zip_builder_and_the_crate_agree_on_the_index() {
        let bytes = valid_package("qa3147-index");
        let archive = open_from_reader(Cursor::new(bytes)).expect("open");
        let index = index_archive(archive).expect("index");
        assert_eq!(index.entries.len(), 4);
        assert!(index.manifest_entry().is_some());

        let mut archive = open_from_reader(Cursor::new(valid_package("qa3147-index"))).expect("open");
        let manifest_entry = index
            .entries
            .iter()
            .find(|entry| entry.archive_name == PACKAGE_MANIFEST_FILENAME)
            .expect("manifest entry")
            .clone();
        let read = read_entry_bytes(&mut archive, &manifest_entry).expect("read manifest");
        assert!(std::str::from_utf8(&read).expect("utf8").contains("qa3147-index"));

        // Keep the unused-import checker honest about `Seek`.
        fn _assert_seek<T: Seek>() {}
        _assert_seek::<Cursor<Vec<u8>>>();
    }
}
