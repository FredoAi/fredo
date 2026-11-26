//! The host-owned per-application lifecycle state (Spec #3144, ST-1).
//!
//! Two facts live here, and nothing else:
//!
//! | Fact | Meaning |
//! |---|---|
//! | `disabled` | the user turned the application off — it can no longer be opened |
//! | `last_failure_code` | the code of the most recent open the HOST refused (cleared by a successful open) |
//!
//! They are recorded in ONE host-owned file, `<app_data_dir>/installed-apps-state.json`,
//! a SIBLING of the registry and of the consent file — never inside an
//! integrity-pinned `<id>/` tree, so recording a state never touches a package's
//! bytes.
//!
//! # Fail-closed reads (the security default)
//!
//! [`read_state`] never returns an error and never creates reach: a missing file,
//! unparseable bytes, or a `version` this build does not implement all read as an
//! EMPTY document ("nothing disabled, nothing failed"). The lifecycle state can
//! only ever REMOVE a refusal — it can never grant a capability, and it can never
//! hide an application from the listing.
//!
//! # Precedence (binding)
//!
//! `disabled > failing > working`. A turned-off application that also has a
//! recorded failure reports `Turned off` only — [`state_for`] returns no failure
//! code while disabled, so the failure is not shown until it is turned back on.
//! `working` is a claim about the host's RECORD ("no recorded failure"), never a
//! claim that the application is running.
//!
//! # Cost
//!
//! Writes happen only when the user acts (one tmp+rename of a small file). Reads
//! are one small file read per listing and one per `installed_app_open`, so a
//! disable takes effect on the NEXT call with no restart. Nothing here runs at
//! startup.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::store;
use super::{
    InstalledAppError, InstalledAppRefusalCode, InstalledAppResult, INSTALLED_APPS_STATE_FILENAME,
    INSTALLED_APPS_STATE_VERSION,
};

/// One application's lifecycle state.
///
/// Serialized `snake_case` (`working` / `failing` / `disabled`) — the wire values
/// the frontend's `INSTALLED_APP_STATES` keys on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstalledAppState {
    /// Enabled, and the host has recorded no failure.
    Working,
    /// Enabled, but the host has recorded a failure (a damaged install or a
    /// refused open).
    Failing,
    /// Turned off by the user.
    Disabled,
}

impl InstalledAppState {
    /// Every state, in the plan's documented order.
    pub const ALL: [Self; 3] = [Self::Working, Self::Failing, Self::Disabled];

    /// The wire string for this state.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::Failing => "failing",
            Self::Disabled => "disabled",
        }
    }
}

impl std::fmt::Display for InstalledAppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One application's lifecycle record.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstalledAppLifecycleRecord {
    /// The user turned the application off.
    #[serde(default)]
    pub disabled: bool,
    /// The most recent open the host refused. ABSENT KEY when no open has been
    /// attempted or the last open succeeded (`skip_serializing_if`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_failure_code: Option<InstalledAppRefusalCode>,
}

impl InstalledAppLifecycleRecord {
    /// An empty record is not a record: it carries no fact about the application.
    fn is_empty(&self) -> bool {
        !self.disabled && self.last_failure_code.is_none()
    }
}

/// The lifecycle state document as stored on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstalledAppStateDocument {
    /// [`INSTALLED_APPS_STATE_VERSION`].
    pub version: u32,
    /// Installed id → that application's lifecycle record. `BTreeMap` so the
    /// serialized form is deterministic (sorted keys).
    #[serde(default)]
    pub apps: BTreeMap<String, InstalledAppLifecycleRecord>,
}

impl Default for InstalledAppStateDocument {
    fn default() -> Self {
        Self {
            version: INSTALLED_APPS_STATE_VERSION,
            apps: BTreeMap::new(),
        }
    }
}

impl InstalledAppStateDocument {
    /// Is `id` turned off?
    pub fn is_disabled(&self, id: &str) -> bool {
        self.apps.get(id).map(|record| record.disabled).unwrap_or(false)
    }

    /// The recorded failure code for `id`, if any.
    pub fn recorded_failure(&self, id: &str) -> Option<InstalledAppRefusalCode> {
        self.apps.get(id).and_then(|record| record.last_failure_code)
    }

    /// Resolve the state the inventory should show for one application.
    ///
    /// `listed` / `listed_failure` are what the RESILIENT LISTING found (a
    /// damaged install reports `Failing`); the recorded state adds "the user
    /// turned it off" and "a host refused an open". Precedence:
    /// `disabled > failing > working`.
    pub fn state_for(
        &self,
        id: &str,
        listed: InstalledAppState,
        listed_failure: Option<InstalledAppRefusalCode>,
    ) -> (InstalledAppState, Option<InstalledAppRefusalCode>) {
        if self.is_disabled(id) {
            // A turned-off application reports no failure: `Turned off` wins over
            // a recorded or listed failure.
            return (InstalledAppState::Disabled, None);
        }
        let failure = listed_failure.or_else(|| self.recorded_failure(id));
        if listed == InstalledAppState::Failing || failure.is_some() {
            (InstalledAppState::Failing, failure)
        } else {
            (InstalledAppState::Working, None)
        }
    }
}

/// `<app_data_dir>/installed-apps-state.json`.
pub fn state_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(INSTALLED_APPS_STATE_FILENAME)
}

/// Read the lifecycle state document. Missing/corrupt/unknown-version ⇒ empty
/// (fail closed, see the module docs). Never errors, so a damaged state file can
/// never wedge the listing or the open path.
pub fn read_state(app_data_dir: &Path) -> InstalledAppStateDocument {
    let path = state_path(app_data_dir);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    target: "fredo::installed_apps::lifecycle",
                    "the lifecycle state at {} could not be read, so nothing is disabled and \
                     nothing is failing: {error}",
                    path.display()
                );
            }
            return InstalledAppStateDocument::default();
        }
    };

    let document: InstalledAppStateDocument = match serde_json::from_slice(&bytes) {
        Ok(document) => document,
        Err(error) => {
            tracing::warn!(
                target: "fredo::installed_apps::lifecycle",
                "the lifecycle state at {} is not readable, so nothing is disabled and nothing \
                 is failing: {error}",
                path.display()
            );
            return InstalledAppStateDocument::default();
        }
    };

    if document.version != INSTALLED_APPS_STATE_VERSION {
        tracing::warn!(
            target: "fredo::installed_apps::lifecycle",
            "the lifecycle state at {} declares version {}, which this Fredo does not implement \
             (it writes version {INSTALLED_APPS_STATE_VERSION}); nothing is disabled and nothing \
             is failing",
            path.display(),
            document.version
        );
        return InstalledAppStateDocument::default();
    }

    document
}

/// Is `id` turned off? (One read of the state file.)
pub fn is_disabled(app_data_dir: &Path, id: &str) -> bool {
    read_state(app_data_dir).is_disabled(id)
}

/// Turn an application off (or back on). Idempotent: setting the state it is
/// already in writes nothing.
pub fn set_disabled(app_data_dir: &Path, id: &str, disabled: bool) -> InstalledAppResult<()> {
    let mut document = read_state(app_data_dir);
    let record = document.apps.entry(id.to_string()).or_default();
    if record.disabled == disabled {
        return Ok(());
    }
    record.disabled = disabled;
    if record.is_empty() {
        document.apps.remove(id);
    }
    write_state(app_data_dir, &document)
}

/// Record that an open of `id` SUCCEEDED, clearing any recorded failure.
///
/// A no-op (no write) when there is nothing to clear.
pub fn record_open_success(app_data_dir: &Path, id: &str) -> InstalledAppResult<()> {
    let mut document = read_state(app_data_dir);
    let had_failure = document
        .apps
        .get(id)
        .map(|record| record.last_failure_code.is_some())
        .unwrap_or(false);
    if !had_failure {
        return Ok(());
    }
    if let Some(record) = document.apps.get_mut(id) {
        record.last_failure_code = None;
    }
    if document
        .apps
        .get(id)
        .map(InstalledAppLifecycleRecord::is_empty)
        .unwrap_or(false)
    {
        document.apps.remove(id);
    }
    write_state(app_data_dir, &document)
}

/// Record that an open of `id` was REFUSED by the host, so the next inventory
/// read shows it as `Failing` (R-5.4). A no-op when the same code is already
/// recorded.
pub fn record_open_failure(
    app_data_dir: &Path,
    id: &str,
    code: InstalledAppRefusalCode,
) -> InstalledAppResult<()> {
    let mut document = read_state(app_data_dir);
    let record = document.apps.entry(id.to_string()).or_default();
    if record.last_failure_code == Some(code) {
        return Ok(());
    }
    record.last_failure_code = Some(code);
    write_state(app_data_dir, &document)
}

/// Drop an application's lifecycle record entirely (used by removal).
///
/// The record is discarded because the application is gone; its grants are
/// dropped separately, and its stored DATA is kept.
pub fn forget(app_data_dir: &Path, id: &str) -> InstalledAppResult<()> {
    let mut document = read_state(app_data_dir);
    if document.apps.remove(id).is_some() {
        write_state(app_data_dir, &document)?;
    }
    Ok(())
}

/// Resolve one application's state: read the file, then apply the precedence.
///
/// The listing reads the document ONCE and calls
/// [`InstalledAppStateDocument::state_for`] per entry; this convenience form is
/// for a single lookup (e.g. a management command's response).
pub fn state_for(
    app_data_dir: &Path,
    id: &str,
    listed: InstalledAppState,
    listed_failure: Option<InstalledAppRefusalCode>,
) -> (InstalledAppState, Option<InstalledAppRefusalCode>) {
    read_state(app_data_dir).state_for(id, listed, listed_failure)
}

/// Write the document atomically: a tmp file in the same directory, then a
/// rename. A half-written state file can therefore never be read.
fn write_state(app_data_dir: &Path, document: &InstalledAppStateDocument) -> InstalledAppResult<()> {
    std::fs::create_dir_all(app_data_dir).map_err(|error| {
        InstalledAppError::io(&format!("creating {}", app_data_dir.display()), &error)
    })?;

    let path = state_path(app_data_dir);
    let tmp = app_data_dir.join(format!(
        "{INSTALLED_APPS_STATE_FILENAME}.{}.tmp",
        std::process::id()
    ));

    let bytes = serde_json::to_vec_pretty(document).map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::IoError,
            format!("serializing the lifecycle state: {error}"),
        )
    })?;

    std::fs::write(&tmp, &bytes)
        .map_err(|error| InstalledAppError::io(&format!("writing {}", tmp.display()), &error))?;

    if let Err(error) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(InstalledAppError::io(
            &format!("publishing {}", path.display()),
            &error,
        ));
    }

    // The state file is a sibling of the registry, so it is never confused with
    // an installed application's directory.
    debug_assert!(!path.starts_with(store::install_root(app_data_dir)));

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn the_state_file_is_a_sibling_of_the_registry_not_inside_it() {
        let data = data_dir();
        let path = state_path(data.path());
        assert_eq!(path, data.path().join("installed-apps-state.json"));
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some(INSTALLED_APPS_STATE_FILENAME)
        );
        assert!(
            !path.starts_with(store::install_root(data.path())),
            "a lifecycle write must never touch a package's pinned bytes"
        );
    }

    #[test]
    fn the_state_values_are_the_wire_spellings_and_are_pinned() {
        assert_eq!(InstalledAppState::ALL.len(), 3);
        for (state, wire) in [
            (InstalledAppState::Working, "working"),
            (InstalledAppState::Failing, "failing"),
            (InstalledAppState::Disabled, "disabled"),
        ] {
            assert_eq!(state.as_str(), wire);
            assert_eq!(serde_json::to_string(&state).expect("serialize"), format!("\"{wire}\""));
        }
        assert_eq!(
            InstalledAppState::ALL.map(InstalledAppState::as_str),
            ["working", "failing", "disabled"]
        );
    }

    #[test]
    fn a_missing_state_file_reads_as_nothing_disabled_and_nothing_failed() {
        let data = data_dir();
        let document = read_state(data.path());
        assert_eq!(document.version, INSTALLED_APPS_STATE_VERSION);
        assert!(document.apps.is_empty());
        assert!(!is_disabled(data.path(), "qa3144-app"));
        assert!(!state_path(data.path()).exists(), "reading never creates the file");
    }

    #[test]
    fn a_corrupt_state_file_reads_as_nothing_disabled_and_nothing_failed() {
        let data = data_dir();
        std::fs::write(state_path(data.path()), b"{ not json").expect("write");
        let document = read_state(data.path());
        assert!(document.apps.is_empty());
        assert!(!is_disabled(data.path(), "qa3144-app"));
    }

    #[test]
    fn an_unknown_version_reads_as_nothing_disabled_and_nothing_failed() {
        let data = data_dir();
        std::fs::write(
            state_path(data.path()),
            br#"{ "version": 2, "apps": { "qa3144-app": { "disabled": true } } }"#,
        )
        .expect("write");
        let document = read_state(data.path());
        assert!(document.apps.is_empty());
        assert!(
            !is_disabled(data.path(), "qa3144-app"),
            "a document this build cannot read must not disable anything"
        );
    }

    #[test]
    fn disable_then_enable_round_trips_and_is_idempotent() {
        let data = data_dir();
        set_disabled(data.path(), "qa3144-app", true).expect("disable");
        assert!(is_disabled(data.path(), "qa3144-app"));

        let raw = std::fs::read_to_string(state_path(data.path())).expect("read");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(value["version"], 1);
        assert_eq!(value["apps"]["qa3144-app"]["disabled"], true);
        assert!(
            value["apps"]["qa3144-app"].get("lastFailureCode").is_none(),
            "an absent key, never null: {value}"
        );

        // Idempotent: setting the same value writes nothing (no tmp churn).
        let before = std::fs::read(state_path(data.path())).expect("read bytes");
        set_disabled(data.path(), "qa3144-app", true).expect("repeat");
        let after = std::fs::read(state_path(data.path())).expect("read bytes");
        assert_eq!(before, after);

        set_disabled(data.path(), "qa3144-app", false).expect("enable");
        assert!(!is_disabled(data.path(), "qa3144-app"));
        // The now-empty record is dropped entirely.
        assert!(
            !read_state(data.path()).apps.contains_key("qa3144-app"),
            "an empty record is not a record"
        );
    }

    #[test]
    fn a_recorded_failure_round_trips_and_a_success_clears_it() {
        let data = data_dir();
        record_open_failure(data.path(), "qa3144-app", InstalledAppRefusalCode::IntegrityMismatch)
            .expect("record failure");

        let raw = std::fs::read_to_string(state_path(data.path())).expect("read");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(
            value["apps"]["qa3144-app"]["lastFailureCode"],
            "integrity_mismatch"
        );

        let (state, failure) = state_for(
            data.path(),
            "qa3144-app",
            InstalledAppState::Working,
            None,
        );
        assert_eq!(state, InstalledAppState::Failing);
        assert_eq!(failure, Some(InstalledAppRefusalCode::IntegrityMismatch));

        record_open_success(data.path(), "qa3144-app").expect("clear");
        let (state, failure) = state_for(
            data.path(),
            "qa3144-app",
            InstalledAppState::Working,
            None,
        );
        assert_eq!(state, InstalledAppState::Working);
        assert_eq!(failure, None);
        assert!(
            !read_state(data.path()).apps.contains_key("qa3144-app"),
            "a cleared, non-disabled record is dropped"
        );
    }

    #[test]
    fn forgetting_drops_the_record_but_a_disable_survives_another_app() {
        let data = data_dir();
        set_disabled(data.path(), "qa3144-a", true).expect("disable a");
        record_open_failure(data.path(), "qa3144-b", InstalledAppRefusalCode::IntegrityRecordCorrupt)
            .expect("fail b");

        forget(data.path(), "qa3144-b").expect("forget b");
        let document = read_state(data.path());
        assert!(!document.apps.contains_key("qa3144-b"));
        assert!(
            document.is_disabled("qa3144-a"),
            "forgetting one record must not touch another"
        );
    }

    /// THE PRECEDENCE (R-1.4): `disabled > failing > working`.
    #[test]
    fn disabled_beats_failing_beats_working() {
        let data = data_dir();

        // Turned off AND with a recorded failure: reports `Turned off` with NO code.
        set_disabled(data.path(), "qa3144-app", true).expect("disable");
        record_open_failure(data.path(), "qa3144-app", InstalledAppRefusalCode::IntegrityMismatch)
            .expect("record failure");
        let (state, failure) = state_for(
            data.path(),
            "qa3144-app",
            InstalledAppState::Failing,
            Some(InstalledAppRefusalCode::IntegrityRecordCorrupt),
        );
        assert_eq!(state, InstalledAppState::Disabled);
        assert_eq!(failure, None, "a turned-off app shows no failure");

        // Turned back on: the recorded failure resurfaces.
        set_disabled(data.path(), "qa3144-app", false).expect("enable");
        let (state, failure) = state_for(
            data.path(),
            "qa3144-app",
            InstalledAppState::Working,
            None,
        );
        assert_eq!(state, InstalledAppState::Failing);
        assert_eq!(failure, Some(InstalledAppRefusalCode::IntegrityMismatch));

        // A listed failure (a damaged install) also reports `Failing`.
        let (state, failure) = state_for(
            data.path(),
            "qa3144-healthy",
            InstalledAppState::Failing,
            Some(InstalledAppRefusalCode::IntegrityRecordCorrupt),
        );
        assert_eq!(state, InstalledAppState::Failing);
        assert_eq!(failure, Some(InstalledAppRefusalCode::IntegrityRecordCorrupt));

        // Nothing recorded, nothing listed: `Working`.
        let (state, failure) =
            state_for(data.path(), "qa3144-pristine", InstalledAppState::Working, None);
        assert_eq!(state, InstalledAppState::Working);
        assert_eq!(failure, None);
    }

    #[test]
    fn a_write_leaves_no_tmp_file_behind() {
        let data = data_dir();
        set_disabled(data.path(), "qa3144-app", true).expect("disable");
        let leftovers: Vec<String> = std::fs::read_dir(data.path())
            .expect("read dir")
            .filter_map(std::result::Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "atomic write must not leave {leftovers:?}");
    }

    #[test]
    fn the_state_document_round_trips_through_serde() {
        let mut document = InstalledAppStateDocument::default();
        document.apps.insert(
            "qa3144-valid".to_string(),
            InstalledAppLifecycleRecord {
                disabled: true,
                last_failure_code: None,
            },
        );
        document.apps.insert(
            "qa3144-tamper".to_string(),
            InstalledAppLifecycleRecord {
                disabled: false,
                last_failure_code: Some(InstalledAppRefusalCode::IntegrityMismatch),
            },
        );
        let json = serde_json::to_string(&document).expect("serialize");
        let parsed: InstalledAppStateDocument = serde_json::from_str(&json).expect("parse");
        assert_eq!(parsed, document);
    }
}
