//! The per-application consent store (Spec #3146, ST-2).
//!
//! A high-risk capability (`high-risk.database-query`, `high-risk.database-reset`,
//! `high-risk.process-spawn`) is DECLARED by the package and GRANTED by the user.
//! Those are two different facts and they live in two different places:
//!
//! | Fact | Owner | Location |
//! |---|---|---|
//! | what the package asks for | the package | `<id>/manifest.json` (`capabilities`) |
//! | what the user allowed | the user | `<app_data_dir>/installed-apps-consent.json` |
//!
//! Keying the grant by the installed id is what makes a grant to one application
//! unable to enable another (R-4.2): the document is a map, and a lookup names one
//! id.
//!
//! # Fail-closed reads (the security default)
//!
//! [`read_document`] never returns an error and never widens authority: a missing
//! file, unparseable bytes, or a `version` this build does not implement all read
//! as an EMPTY document. A consent file is only ever able to LIFT a refusal that
//! the declaration already permits, so "cannot read it" degrades to "nothing is
//! consented" — the same state as a fresh install. The one exception is a file we
//! refuse to trust: a corrupt or future-version document is reported through
//! `tracing::warn!` so the damage is diagnosable rather than invisible.
//!
//! # Grant is validated, revoke is not
//!
//! [`grant`] refuses a capability the package did not declare as high-risk
//! (R-4.5): a grant must name something real, and there is exactly one place that
//! decides what is real — the declaration. [`revoke`] deliberately does NOT run
//! that check: removing authority is always safe, so a revoke of a capability this
//! build no longer recognises still removes whatever grant was recorded.
//!
//! # Cost
//!
//! Writes happen only when the user clicks a control (one tmp+rename of a small
//! file). Reads are one small file read per HIGH-RISK call — the runtime re-reads
//! consent on every action (R-3.5), so no in-memory grant can survive as authority.
//! Nothing here runs at startup, and there is no background task.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::manifest::AppManifest;
use super::store::{self, InstalledAppCapabilityStatus};
use super::{
    InstalledAppError, InstalledAppRefusalCode, InstalledAppResult, CONSENT_STORE_FILENAME,
    CONSENT_STORE_VERSION,
};

/// `<app_data_dir>/installed-apps-consent.json` — the host-owned consent record.
///
/// Deliberately a SIBLING of `<app_data_dir>/installed-apps/`, never inside it: a
/// grant must be writable without touching a package's integrity-pinned bytes, and
/// a registry directory name would otherwise become an "application".
pub fn consent_store_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(CONSENT_STORE_FILENAME)
}

/// The consent document as stored on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsentDocument {
    /// [`CONSENT_STORE_VERSION`].
    pub version: u32,
    /// Installed id → the capability ids the user allowed for THAT application.
    /// `BTreeMap` so the serialized form is deterministic (sorted keys).
    #[serde(default)]
    pub grants: BTreeMap<String, Vec<String>>,
}

impl Default for ConsentDocument {
    fn default() -> Self {
        Self {
            version: CONSENT_STORE_VERSION,
            grants: BTreeMap::new(),
        }
    }
}

/// Read the consent document. Missing/corrupt/unknown-version ⇒ empty (fail
/// closed, see the module docs). Never errors, so no read path can be wedged by a
/// damaged consent file while the rest of the pane still works.
pub fn read_document(app_data_dir: &Path) -> ConsentDocument {
    let path = consent_store_path(app_data_dir);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    target: "fredo::installed_apps::consent",
                    "the consent record at {} could not be read, so nothing is consented: {error}",
                    path.display()
                );
            }
            return ConsentDocument::default();
        }
    };

    let document: ConsentDocument = match serde_json::from_slice(&bytes) {
        Ok(document) => document,
        Err(error) => {
            tracing::warn!(
                target: "fredo::installed_apps::consent",
                "the consent record at {} is not readable, so nothing is consented: {error}",
                path.display()
            );
            return ConsentDocument::default();
        }
    };

    if document.version != CONSENT_STORE_VERSION {
        tracing::warn!(
            target: "fredo::installed_apps::consent",
            "the consent record at {} declares version {}, which this Fredo does not implement \
             (it writes version {CONSENT_STORE_VERSION}); nothing is consented",
            path.display(),
            document.version
        );
        return ConsentDocument::default();
    }

    document
}

/// The capability ids the user allowed for `app_id` (empty when none).
pub fn grants_for(app_data_dir: &Path, app_id: &str) -> Vec<String> {
    read_document(app_data_dir)
        .grants
        .get(app_id)
        .cloned()
        .unwrap_or_default()
}

/// Is `capability` consented for `app_id`?
///
/// This is the ONE predicate the runtime gate asks per high-risk call. It reads
/// the file every time — a decision cached at subscribe/mount/window-open time
/// would be exactly the stale authority R-3.5 forbids.
pub fn is_consented(app_data_dir: &Path, app_id: &str, capability: &str) -> bool {
    grants_for(app_data_dir, app_id)
        .iter()
        .any(|id| id == capability)
}

/// The installed application's capability projection (declaration + this
/// application's grants).
pub fn capability_status(
    app_data_dir: &Path,
    app_id: &str,
) -> InstalledAppResult<InstalledAppCapabilityStatus> {
    let manifest = read_installed_manifest(app_data_dir, app_id)?;
    let status = InstalledAppCapabilityStatus::declared_by(app_id, manifest.capabilities.as_ref());
    Ok(status.with_consented(&grants_for(app_data_dir, app_id)))
}

/// Grant one declared high-risk capability to one application.
///
/// Refused when the id is not installed (`id_not_installed`) or when the package
/// did not declare `capability` as high-risk (`manifest_invalid_field`, naming
/// `capability`). A refusal records NOTHING — the file is written only after both
/// checks pass (R-4.5).
pub fn grant(
    app_data_dir: &Path,
    app_id: &str,
    capability: &str,
) -> InstalledAppResult<InstalledAppCapabilityStatus> {
    let status = capability_status(app_data_dir, app_id)?;
    if !status.high_risk.iter().any(|id| id == capability) {
        return Err(not_a_declared_high_risk_capability(&status, capability));
    }

    let mut document = read_document(app_data_dir);
    let mut granted = document.grants.remove(app_id).unwrap_or_default();
    granted.push(capability.to_string());
    granted.sort();
    granted.dedup();
    document.grants.insert(app_id.to_string(), granted);
    write_document(app_data_dir, &document)?;

    Ok(status.with_consented(&document.grants[app_id]))
}

/// Revoke one capability for one application. Idempotent and never refused for
/// an unrecognised capability (see the module docs): removing authority is safe.
///
/// A revoke never removes an application, never deletes its data, and never edits
/// its package.
pub fn revoke(
    app_data_dir: &Path,
    app_id: &str,
    capability: &str,
) -> InstalledAppResult<InstalledAppCapabilityStatus> {
    let status = capability_status(app_data_dir, app_id)?;

    let mut document = read_document(app_data_dir);
    let mut changed = false;
    if let Some(granted) = document.grants.get_mut(app_id) {
        let before = granted.len();
        granted.retain(|id| id != capability);
        changed = granted.len() != before;
        if granted.is_empty() {
            document.grants.remove(app_id);
        }
    }
    if changed {
        write_document(app_data_dir, &document)?;
    }

    Ok(status.with_consented(&grants_for(app_data_dir, app_id)))
}

/// The refusal for a grant naming something the package did not declare as
/// high-risk. Reuses the frozen install vocabulary (`manifest_invalid_field`
/// with `field: "capability"`) — the authority surface's separate six-code
/// vocabulary is for CALL-TIME refusals, never for a refused user control.
fn not_a_declared_high_risk_capability(
    status: &InstalledAppCapabilityStatus,
    capability: &str,
) -> InstalledAppError {
    InstalledAppError::field(
        InstalledAppRefusalCode::ManifestInvalidField,
        "capability",
        format!(
            "\"{capability}\" is not a high-risk capability \"{}\" declared, so there is nothing to \
             allow; it declared {:?}",
            status.app_id, status.high_risk
        ),
    )
}

/// Read the installed package's canonical manifest, refusing an unknown id with
/// the frozen `id_not_installed` code.
fn read_installed_manifest(app_data_dir: &Path, app_id: &str) -> InstalledAppResult<AppManifest> {
    let dir = store::app_dir(&store::install_root(app_data_dir), app_id);
    if !dir.is_dir() {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::IdNotInstalled,
            "appId",
            format!("\"{app_id}\" is not installed, so there is no capability to consent to"),
        ));
    }
    store::read_manifest_file(&dir)
}

/// Write the document atomically: a tmp file in the same directory, then a rename.
/// A half-written consent file can therefore never be read.
fn write_document(app_data_dir: &Path, document: &ConsentDocument) -> InstalledAppResult<()> {
    std::fs::create_dir_all(app_data_dir).map_err(|error| {
        InstalledAppError::io(
            &format!("creating {}", app_data_dir.display()),
            &error,
        )
    })?;

    let path = consent_store_path(app_data_dir);
    let tmp = app_data_dir.join(format!(
        "{CONSENT_STORE_FILENAME}.{}.tmp",
        std::process::id()
    ));

    let bytes = serde_json::to_vec_pretty(document).map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::IoError,
            format!("serializing the consent record: {error}"),
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

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    /// Install a package directory with a canonical manifest, exactly as the
    /// installer would leave it (only the parts consent reads).
    fn install_stub(app_data_dir: &Path, id: &str, capabilities: Option<&str>) {
        let dir = store::app_dir(&store::install_root(app_data_dir), id);
        std::fs::create_dir_all(&dir).expect("create app dir");
        let capabilities_key = match capabilities {
            Some(json) => format!(",\n  \"capabilities\": {json}"),
            None => String::new(),
        };
        let manifest = format!(
            r#"{{
  "manifestVersion": 1,
  "id": "{id}",
  "displayName": "QA3146 {id}",
  "version": "1.0.0",
  "engines": {{ "fredo": ">=0.0.0" }},
  "entry": {{ "document": "index.html", "module": "main.js" }}{capabilities_key}
}}"#
        );
        std::fs::write(dir.join(super::super::INSTALLED_MANIFEST_FILENAME), manifest)
            .expect("write manifest");
    }

    const DECLARED: &str = r#"{ "version": 1, "highRisk": ["high-risk.database-query", "high-risk.database-reset"] }"#;

    #[test]
    fn a_missing_consent_file_consents_nothing() {
        let data = data_dir();
        let document = read_document(data.path());
        assert_eq!(document.version, CONSENT_STORE_VERSION);
        assert!(document.grants.is_empty());
        assert!(!is_consented(data.path(), "qa3146-app-a", "high-risk.database-query"));
        assert!(!consent_store_path(data.path()).exists(), "reading never creates the file");
    }

    #[test]
    fn the_consent_file_lives_outside_the_integrity_pinned_install_root() {
        let data = data_dir();
        let path = consent_store_path(data.path());
        let registry = store::install_root(data.path());
        assert_eq!(path, data.path().join(CONSENT_STORE_FILENAME));
        assert!(
            !path.starts_with(&registry),
            "a grant inside <id>/ could never be written without an integrity mismatch"
        );
        assert_eq!(path.file_name().and_then(|name| name.to_str()), Some(CONSENT_STORE_FILENAME));
    }

    #[test]
    fn a_grant_is_recorded_under_one_id_and_round_trips() {
        let data = data_dir();
        install_stub(data.path(), "qa3146-consent-a", Some(DECLARED));

        let status = grant(data.path(), "qa3146-consent-a", "high-risk.database-query")
            .expect("grant");
        assert_eq!(status.app_id, "qa3146-consent-a");
        assert_eq!(status.consented, ["high-risk.database-query"]);
        assert!(status.is_consented("high-risk.database-query"));
        assert!(!status.is_consented("high-risk.database-reset"));

        // The file on disk is versioned, keyed by installed id, values sorted.
        let raw = std::fs::read_to_string(consent_store_path(data.path())).expect("read file");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(value["version"], 1);
        assert_eq!(
            value["grants"]["qa3146-consent-a"],
            serde_json::json!(["high-risk.database-query"])
        );

        // A second grant for the same app accumulates, sorted.
        let status = grant(data.path(), "qa3146-consent-a", "high-risk.database-reset")
            .expect("second grant");
        assert_eq!(
            status.consented,
            ["high-risk.database-query", "high-risk.database-reset"]
        );
        // Idempotent: granting twice adds nothing.
        let status = grant(data.path(), "qa3146-consent-a", "high-risk.database-query")
            .expect("repeat grant");
        assert_eq!(status.consented.len(), 2);

        assert!(is_consented(data.path(), "qa3146-consent-a", "high-risk.database-query"));
    }

    /// THE leak proof (R-4.2): a grant to A must not enable B, even though both
    /// declare the identical capability.
    #[test]
    fn a_grant_to_one_application_never_enables_another() {
        let data = data_dir();
        install_stub(data.path(), "qa3146-consent-a", Some(DECLARED));
        install_stub(data.path(), "qa3146-consent-b", Some(DECLARED));

        grant(data.path(), "qa3146-consent-a", "high-risk.database-query").expect("grant A");

        assert!(is_consented(data.path(), "qa3146-consent-a", "high-risk.database-query"));
        assert!(
            !is_consented(data.path(), "qa3146-consent-b", "high-risk.database-query"),
            "consent is per application"
        );

        let b = capability_status(data.path(), "qa3146-consent-b").expect("status B");
        assert_eq!(b.declared, capability_status(data.path(), "qa3146-consent-a").expect("A").declared);
        assert!(b.consented.is_empty(), "B declares the same capability and is still refused");
    }

    #[test]
    fn a_grant_for_an_undeclared_capability_is_refused_and_records_nothing() {
        let data = data_dir();
        install_stub(data.path(), "qa3146-app-a", Some(DECLARED));

        for capability in [
            "high-risk.process-spawn", // a real capability the package did not declare
            "data.tables",             // never consentable
            "high-risk.everything",    // not a capability at all
        ] {
            let error = grant(data.path(), "qa3146-app-a", capability)
                .expect_err("refused grant");
            assert_eq!(
                error.code,
                InstalledAppRefusalCode::ManifestInvalidField,
                "{capability} must be refused"
            );
            assert_eq!(error.field.as_deref(), Some("capability"));
            assert!(
                !consent_store_path(data.path()).exists(),
                "a refused grant must record nothing"
            );
        }
    }

    #[test]
    fn a_grant_for_an_unknown_application_is_id_not_installed() {
        let data = data_dir();
        let error = grant(data.path(), "qa3146-ghost", "high-risk.database-query")
            .expect_err("unknown app");
        assert_eq!(error.code, InstalledAppRefusalCode::IdNotInstalled);
        assert_eq!(error.field.as_deref(), Some("appId"));
        assert!(!consent_store_path(data.path()).exists());
    }

    #[test]
    fn a_package_that_declares_nothing_has_nothing_to_grant() {
        let data = data_dir();
        install_stub(data.path(), "qa3146-no-capabilities", None);

        let status = capability_status(data.path(), "qa3146-no-capabilities").expect("status");
        assert!(status.declared.is_empty());
        assert!(status.high_risk.is_empty());
        assert!(status.consented.is_empty());

        let error = grant(data.path(), "qa3146-no-capabilities", "high-risk.database-query")
            .expect_err("nothing declared");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestInvalidField);
    }

    #[test]
    fn a_revoke_removes_only_that_pair_and_leaves_the_rest() {
        let data = data_dir();
        install_stub(data.path(), "qa3146-consent-a", Some(DECLARED));
        install_stub(data.path(), "qa3146-consent-b", Some(DECLARED));
        grant(data.path(), "qa3146-consent-a", "high-risk.database-query").expect("a1");
        grant(data.path(), "qa3146-consent-a", "high-risk.database-reset").expect("a2");
        grant(data.path(), "qa3146-consent-b", "high-risk.database-query").expect("b1");

        let status = revoke(data.path(), "qa3146-consent-a", "high-risk.database-query")
            .expect("revoke");
        assert_eq!(status.consented, ["high-risk.database-reset"]);
        assert!(!is_consented(data.path(), "qa3146-consent-a", "high-risk.database-query"));
        assert!(
            is_consented(data.path(), "qa3146-consent-b", "high-risk.database-query"),
            "revoking A's grant leaves B's untouched"
        );

        // Revoking is idempotent and never refuses an unrecognised capability.
        revoke(data.path(), "qa3146-consent-a", "high-risk.database-query").expect("repeat");
        revoke(data.path(), "qa3146-consent-a", "high-risk.everything").expect("unrecognised");
        assert_eq!(
            capability_status(data.path(), "qa3146-consent-a").expect("status").consented,
            ["high-risk.database-reset"]
        );
    }

    #[test]
    fn revoking_the_last_grant_drops_the_apps_key_entirely() {
        let data = data_dir();
        install_stub(data.path(), "qa3146-consent-a", Some(DECLARED));
        grant(data.path(), "qa3146-consent-a", "high-risk.database-query").expect("grant");
        revoke(data.path(), "qa3146-consent-a", "high-risk.database-query").expect("revoke");

        let document = read_document(data.path());
        assert!(
            !document.grants.contains_key("qa3146-consent-a"),
            "an empty grant list is not a record: {document:?}"
        );
    }

    #[test]
    fn a_corrupt_consent_file_consents_nothing_and_never_widens() {
        let data = data_dir();
        install_stub(data.path(), "qa3146-consent-a", Some(DECLARED));
        std::fs::write(consent_store_path(data.path()), b"{ not json").expect("write");

        assert!(!is_consented(data.path(), "qa3146-consent-a", "high-risk.database-query"));
        assert_eq!(
            capability_status(data.path(), "qa3146-consent-a").expect("status").consented,
            Vec::<String>::new()
        );
    }

    #[test]
    fn an_unknown_consent_version_consents_nothing() {
        let data = data_dir();
        install_stub(data.path(), "qa3146-consent-a", Some(DECLARED));
        std::fs::write(
            consent_store_path(data.path()),
            br#"{ "version": 2, "grants": { "qa3146-consent-a": ["high-risk.database-query"] } }"#,
        )
        .expect("write");

        assert!(
            !is_consented(data.path(), "qa3146-consent-a", "high-risk.database-query"),
            "a document this build cannot read must not grant"
        );
    }

    #[test]
    fn the_status_carries_the_declaration_and_the_grant() {
        let data = data_dir();
        install_stub(data.path(), "qa3146-consent-a", Some(DECLARED));
        grant(data.path(), "qa3146-consent-a", "high-risk.database-reset").expect("grant");

        let status = capability_status(data.path(), "qa3146-consent-a").expect("status");
        assert_eq!(
            status.declared,
            ["high-risk.database-query", "high-risk.database-reset"],
            "sorted declared ids"
        );
        assert_eq!(status.high_risk, status.declared);
        assert_eq!(status.consented, ["high-risk.database-reset"]);

        // The wire shape is camelCase with the four documented keys.
        let value = serde_json::to_value(&status).expect("serialize");
        for key in ["appId", "declared", "highRisk", "consented"] {
            assert!(value.get(key).is_some(), "{key} must be on the wire: {value}");
        }
    }

    #[test]
    fn no_tmp_file_is_left_behind_after_a_write() {
        let data = data_dir();
        install_stub(data.path(), "qa3146-consent-a", Some(DECLARED));
        grant(data.path(), "qa3146-consent-a", "high-risk.database-query").expect("grant");

        let leftovers: Vec<String> = std::fs::read_dir(data.path())
            .expect("read dir")
            .filter_map(std::result::Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "atomic write must not leave {leftovers:?}");
    }
}
