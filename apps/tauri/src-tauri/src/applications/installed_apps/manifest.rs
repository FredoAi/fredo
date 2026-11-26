//! `fredo-app.json` decoding and every manifest field rule (Spec #3147, ST-2).
//!
//! # The one hard rule
//!
//! The manifest is read with `serde_json` **only**. No other parser, no
//! evaluation, no macro, no `eval` of any kind touches the archive's bytes — so
//! AC-3's "nothing is executed" holds by construction rather than by discipline.
//!
//! # Error precedence (binding, and tested)
//!
//! A package with several defects must produce ONE stable code, so the checks
//! run in this order and the first failure wins:
//!
//! 1. the bytes are not JSON at all ⇒ [`ManifestMalformed`]
//! 2. not a JSON object ⇒ [`ManifestMalformed`]
//! 3. an unknown **top-level** key ⇒ [`ManifestUnknownField`]
//! 4. `manifestVersion` present but not a number ⇒ [`ManifestInvalidField`]
//! 5. `manifestVersion` missing ⇒ [`ManifestInvalidField`]
//! 6. `manifestVersion` not `1` ⇒ [`UnsupportedManifestVersion`]
//! 7. `id` / `displayName` / `version` / `entry` failures ⇒ their own codes
//! 8. `capabilities` defects ⇒ [`ManifestUnknownField`] (an unknown key inside
//!    the object) or [`ManifestInvalidField`] (a wrong major, an unknown
//!    high-risk id, a needless `source`, an unusable table), always naming the
//!    exact path (`capabilities.version`, `capabilities.highRisk[1]`, …)
//! 9. `engines.fredo` `*`/empty/unparseable ⇒ [`EnginesRangeInvalid`]
//! 10. a well-formed range excluding the host ⇒ [`HostIncompatible`]
//!
//! [`ManifestMalformed`]: super::InstalledAppRefusalCode::ManifestMalformed
//! [`ManifestUnknownField`]: super::InstalledAppRefusalCode::ManifestUnknownField
//! [`ManifestInvalidField`]: super::InstalledAppRefusalCode::ManifestInvalidField
//! [`UnsupportedManifestVersion`]: super::InstalledAppRefusalCode::UnsupportedManifestVersion
//! [`EnginesRangeInvalid`]: super::InstalledAppRefusalCode::EnginesRangeInvalid
//! [`HostIncompatible`]: super::InstalledAppRefusalCode::HostIncompatible
//!
//! # Why unknown keys are refused
//!
//! `manifestVersion: 1` is a closed schema. Accepting an unknown key would let a
//! package declare something this build silently ignores, which reads to the
//! author as accepted consent. `capabilities` is the ONE additive answer to that
//! (Spec #3146): it is a **declaration of reach**, it is versioned on its own,
//! and its absence means NO access — never "everything except a deny list".

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::infrastructure::application_data::declaration::{
    ApplicationDataDeclaration, ApplicationDataTableDeclaration,
};

use super::authority::CapabilityId;
use super::{
    InstalledAppError, InstalledAppRefusalCode, InstalledAppResult, CAPABILITY_MANIFEST_VERSION,
    HOST_FREDO_VERSION, SUPPORTED_MANIFEST_VERSION,
};

/// The built-in applications a package may never claim (R-3.2 / `id_reserved`).
///
/// These are exactly the eight ids `retainedApplicationSet.test.ts` pins as the
/// built-in set; a package that could install under one of them would shadow a
/// shipped application.
pub const RESERVED_APP_IDS: [&str; 8] = [
    "wireframe",
    "terminal",
    "mission-monitor",
    "database-client",
    "theming",
    "setup",
    "settings",
    "dev-mode",
];

/// `id` maximum length, in characters.
pub const MAX_APP_ID_CHARS: usize = 96;
/// `displayName` maximum length, in characters.
pub const MAX_DISPLAY_NAME_CHARS: usize = 64;
/// `description` maximum length, in characters.
pub const MAX_DESCRIPTION_CHARS: usize = 280;

/// The document-extension rule for `entry.document`.
pub const ENTRY_DOCUMENT_EXTENSION: &str = ".html";
/// The module-extension rule for `entry.module`.
pub const ENTRY_MODULE_EXTENSION: &str = ".js";

/// Every top-level key `manifestVersion: 1` defines. Any other key is
/// [`InstalledAppRefusalCode::ManifestUnknownField`].
///
/// `capabilities` is the 8th key (Spec #3146): optional, additive, and the only
/// declaration of an installed application's backend reach.
pub const MANIFEST_TOP_LEVEL_KEYS: [&str; 8] = [
    "manifestVersion",
    "id",
    "displayName",
    "version",
    "engines",
    "entry",
    "description",
    "capabilities",
];

/// `entry` object keys.
pub const MANIFEST_ENTRY_KEYS: [&str; 2] = ["document", "module"];
/// `engines` object keys.
pub const MANIFEST_ENGINES_KEYS: [&str; 1] = ["fredo"];

/// `capabilities` object keys. Closed: an unknown key is refused with the exact
/// path (`capabilities.<key>`), because a declaration this build does not read
/// must never look accepted.
pub const MANIFEST_CAPABILITIES_KEYS: [&str; 3] = ["version", "data", "highRisk"];
/// `capabilities.data` object keys.
pub const MANIFEST_CAPABILITY_DATA_KEYS: [&str; 1] = ["tables"];
/// One `capabilities.data.tables[i]` object's keys.
///
/// `source` is deliberately ABSENT: a declared `source` reads a CANONICAL table
/// (the user's own chats/tool calls/agent sessions), so an installed package may
/// never declare one. The refusal is a named rule below, not a generic
/// unknown-key hit, so the author sees WHY.
pub const MANIFEST_CAPABILITY_TABLE_KEYS: [&str; 4] = ["name", "primaryKey", "columns", "retention"];

/// The `capabilities` object: what an installed application asks to reach.
///
/// Absent ⇒ zero declared capabilities (fail-safe). Every field is validated at
/// install; the normalized form is what `<id>/manifest.json` records and what
/// the runtime re-reads on every call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstalledAppCapabilities {
    /// The capability-contract major (`CAPABILITY_MANIFEST_VERSION`).
    pub version: u32,
    /// Presence declares the `data.tables` capability.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<CapabilityDataDeclaration>,
    /// The declared `high-risk.*` ids, sorted by wire spelling.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub high_risk: Vec<CapabilityId>,
}

/// The `capabilities.data` object: the declared tables.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityDataDeclaration {
    pub tables: Vec<ApplicationDataTableDeclaration>,
}

impl InstalledAppCapabilities {
    /// The declared ids as typed vocabulary values, ordered by wire spelling.
    ///
    /// This is what the runtime gate reads (`authority::read_authority_grants`),
    /// so the authority path never re-derives a capability from a string.
    pub fn declared_ids(&self) -> Vec<CapabilityId> {
        let mut declared: Vec<CapabilityId> = Vec::new();
        if self.data.is_some() {
            declared.push(CapabilityId::DataTables);
        }
        declared.extend(self.high_risk.iter().copied());
        declared.sort_by_key(|id| id.as_str());
        declared.dedup();
        declared
    }

    /// Every declared capability id in its WIRE spelling, sorted — the
    /// projection's `declared` array.
    pub fn declared(&self) -> Vec<String> {
        self.declared_ids()
            .into_iter()
            .map(|id| id.as_str().to_string())
            .collect()
    }

    /// The declared HIGH-RISK ids in wire spelling, sorted — the projection's
    /// `highRisk` array, and exactly the set that needs a consent grant.
    pub fn high_risk(&self) -> Vec<String> {
        let mut high_risk: Vec<&str> = self.high_risk.iter().map(|id| id.as_str()).collect();
        high_risk.sort_unstable();
        high_risk.into_iter().map(str::to_string).collect()
    }

    /// The declared data tables (empty when `capabilities.data` is absent).
    pub fn data_tables(&self) -> &[ApplicationDataTableDeclaration] {
        match &self.data {
            Some(data) => &data.tables,
            None => &[],
        }
    }

    /// The tables in the ONE declaration model the application-data registry
    /// materialises, or `None` when the package declares no table at all.
    ///
    /// This is the shape the window-open path hands to
    /// `DeclarationRegistry::declare` (Spec #3146, W-1): the package's declared
    /// tables, in manifest order, under `app_id`'s namespace and at the SAME
    /// `declaration_revision` the install validator records
    /// ([`data_declaration_revision`]) — so the open path and the install
    /// validator can never disagree about the revision.
    ///
    /// `None` — not an empty declaration — for a package with no declared table:
    /// the open path then does no database work at all.
    pub fn data_declaration(
        &self,
        app_id: &str,
        app_version: &str,
    ) -> Option<ApplicationDataDeclaration> {
        let data = self.data.as_ref()?;
        if data.tables.is_empty() {
            return None;
        }
        Some(ApplicationDataDeclaration {
            feature_id: app_id.to_string(),
            declaration_revision: data_declaration_revision(app_version),
            tables: data.tables.clone(),
        })
    }
}

/// The declaration revision every declared table of a package carries.
///
/// ONE helper: the install validator ([`read_capability_data`]) and the
/// window-open composer ([`InstalledAppCapabilities::data_declaration`]) both
/// read it here, because a revision that disagreed would make the same package
/// look changed on every open (G-494).
pub fn data_declaration_revision(app_version: &str) -> String {
    format!("manifest:{app_version}")
}

/// A validated `fredo-app.json`.
///
/// Produced only by [`parse_manifest`], so holding one means every rule below
/// has already passed. Field names are the manifest's own (`camelCase` on the
/// wire) because this type is ALSO written verbatim as
/// `<id>/manifest.json` — the canonical normalized copy.
///
/// `PartialEq` only (no `Eq`): the declared tables carry a JSON `source` model
/// whose `Value` members are not `Eq`; the table model itself refuses `source`
/// for installed packages, but the shared declaration type keeps its full shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppManifest {
    pub manifest_version: u32,
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub engines: EnginesDeclaration,
    pub entry: EntryDeclaration,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The declared backend reach. An ABSENT key on the wire when the package
    /// declared none — never `null`, never `{}` (R-8.4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<InstalledAppCapabilities>,
}

/// The `engines` object (`{ fredo: string }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnginesDeclaration {
    /// A semver RANGE, kept verbatim — never resolved to a boolean here.
    pub fredo: String,
}

/// The `entry` object (`{ document, module }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntryDeclaration {
    pub document: String,
    pub module: String,
}

/// The id pattern: `^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$`.
///
/// Implemented by hand rather than with a regex crate: the rule is three
/// clauses, the repo has no `regex` dependency it uses for validation of this
/// kind, and a hand-written scan gives an exact error message per clause.
pub fn is_valid_app_id(id: &str) -> bool {
    if id.is_empty() || id.chars().count() > MAX_APP_ID_CHARS {
        return false;
    }
    // Split on '.', then validate each dot-separated segment: it must start
    // with [a-z0-9] and continue with [a-z0-9-].
    for segment in id.split('.') {
        if segment.is_empty() {
            return false;
        }
        let mut chars = segment.chars();
        let first = chars.next().unwrap_or_default();
        if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
            return false;
        }
        if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
            return false;
        }
    }
    true
}

/// Is `id` one of the built-in application ids?
pub fn is_reserved_app_id(id: &str) -> bool {
    RESERVED_APP_IDS.contains(&id)
}

/// Validate an `entry` path: relative POSIX, no `..`, no absolute/drive/UNC
/// form, and ending with `extension`.
///
/// The archive-safety rule proper lives in [`super::archive`] (it must run over
/// every entry, not just the two the manifest names); this is the narrower
/// *manifest-level* rule that makes a bad `entry` value a
/// [`InstalledAppRefusalCode::EntryInvalid`] rather than a later `unsafe_path`.
pub fn validate_entry_path(path: &str, extension: &str) -> std::result::Result<(), &'static str> {
    if path.is_empty() {
        return Err("must not be empty");
    }
    if path.contains('\\') {
        return Err("must use POSIX separators ('/'), not backslashes");
    }
    if path.starts_with('/') {
        return Err("must be relative, not absolute");
    }
    if path.contains(':') {
        return Err("must not carry a drive or scheme prefix");
    }
    if path.split('/').any(|segment| segment == "..") {
        return Err("must not contain a '..' component");
    }
    if path.split('/').any(str::is_empty) {
        return Err("must not contain an empty path segment");
    }
    if !path.ends_with(extension) {
        return Err(match extension {
            ENTRY_DOCUMENT_EXTENSION => "must end with '.html'",
            ENTRY_MODULE_EXTENSION => "must end with '.js'",
            _ => "must carry the required extension",
        });
    }
    Ok(())
}

/// Parse + validate a `fredo-app.json` payload.
///
/// Errors carry the specific [`InstalledAppRefusalCode`] for the FIRST failing
/// rule (see the module docs for the binding order).
pub fn parse_manifest(bytes: &[u8]) -> InstalledAppResult<AppManifest> {
    let value: Value = serde_json::from_slice(bytes).map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::ManifestMalformed,
            format!("fredo-app.json is not valid JSON: {error}"),
        )
    })?;

    let Value::Object(object) = value else {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::ManifestMalformed,
            "fredo-app.json must contain a JSON object",
        ));
    };

    reject_unknown_keys(&object, &MANIFEST_TOP_LEVEL_KEYS, "fredo-app.json", "")?;

    let manifest_version = read_manifest_version(&object)?;

    let id = read_string_field(&object, "id")?;
    if !is_valid_app_id(&id) {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::IdInvalid,
            "id",
            format!(
                "id \"{id}\" must match ^[a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)*$ and be at most \
                 {MAX_APP_ID_CHARS} characters"
            ),
        ));
    }
    if is_reserved_app_id(&id) {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::IdReserved,
            "id",
            format!("\"{id}\" is a built-in Fredo application id and cannot be installed"),
        ));
    }

    let display_name = read_string_field(&object, "displayName")?;
    let display_name_chars = display_name.chars().count();
    if !(1..=MAX_DISPLAY_NAME_CHARS).contains(&display_name_chars) {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::ManifestInvalidField,
            "displayName",
            format!("displayName must be 1..{MAX_DISPLAY_NAME_CHARS} characters (found {display_name_chars})"),
        ));
    }

    let version = read_string_field(&object, "version")?;
    if version.starts_with('v') || semver::Version::parse(&version).is_err() {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::VersionInvalid,
            "version",
            format!("version \"{version}\" must be SemVer 2.0.0 with no \"v\" prefix"),
        ));
    }

    let engines = read_engines(&object)?;
    let entry = read_entry(&object)?;
    let capabilities = read_capabilities(&object, &id, &version)?;

    let description = match object.get("description") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => {
            let chars = text.chars().count();
            if chars > MAX_DESCRIPTION_CHARS {
                return Err(InstalledAppError::field(
                    InstalledAppRefusalCode::ManifestInvalidField,
                    "description",
                    format!("description must be at most {MAX_DESCRIPTION_CHARS} characters (found {chars})"),
                ));
            }
            Some(text.clone())
        }
        Some(_) => {
            return Err(InstalledAppError::field(
                InstalledAppRefusalCode::ManifestInvalidField,
                "description",
                "description must be a string when present",
            ))
        }
    };

    // The range checks run LAST so a package with both a bad field and a bad
    // range reports the field (the more actionable defect).
    check_engines_range(&engines.fredo)?;

    Ok(AppManifest {
        manifest_version,
        id,
        display_name,
        version,
        engines,
        entry,
        description,
        capabilities,
    })
}

/// Reject any key in `object` that is not in `allowed`.
///
/// `field_prefix` is the dotted path of the object being scanned (`""` at the
/// top level, `"capabilities."` for the capability object), so a refusal names
/// the exact manifest path rather than a bare key.
fn reject_unknown_keys(
    object: &Map<String, Value>,
    allowed: &[&str],
    where_: &str,
    field_prefix: &str,
) -> InstalledAppResult<()> {
    let allowed: BTreeSet<&str> = allowed.iter().copied().collect();
    for key in object.keys() {
        if !allowed.contains(key.as_str()) {
            return Err(InstalledAppError::field(
                InstalledAppRefusalCode::ManifestUnknownField,
                format!("{field_prefix}{key}"),
                format!(
                    "{where_} carries the unknown field \"{key}\"; manifestVersion \
                     {SUPPORTED_MANIFEST_VERSION} defines exactly {:?}",
                    allowed
                ),
            ));
        }
    }
    Ok(())
}

fn read_string_field(object: &Map<String, Value>, key: &str) -> InstalledAppResult<String> {
    match object.get(key) {
        Some(Value::String(text)) => Ok(text.clone()),
        Some(_) => Err(InstalledAppError::field(
            InstalledAppRefusalCode::ManifestInvalidField,
            key,
            format!("{key} must be a string"),
        )),
        None => Err(InstalledAppError::field(
            InstalledAppRefusalCode::ManifestInvalidField,
            key,
            format!("{key} is required"),
        )),
    }
}

/// `manifestVersion`: present, numeric, and exactly [`SUPPORTED_MANIFEST_VERSION`].
fn read_manifest_version(object: &Map<String, Value>) -> InstalledAppResult<u32> {
    let value = object.get("manifestVersion").ok_or_else(|| {
        InstalledAppError::field(
            InstalledAppRefusalCode::ManifestInvalidField,
            "manifestVersion",
            "manifestVersion is required",
        )
    })?;

    let number = match value {
        Value::Number(number) => number,
        other => {
            return Err(InstalledAppError::field(
                InstalledAppRefusalCode::ManifestInvalidField,
                "manifestVersion",
                format!("manifestVersion must be a number (found {other})"),
            ))
        }
    };

    let Some(version) = number.as_u64() else {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::ManifestInvalidField,
            "manifestVersion",
            format!("manifestVersion must be a non-negative integer (found {number})"),
        ));
    };

    let version = u32::try_from(version).map_err(|_| {
        InstalledAppError::field(
            InstalledAppRefusalCode::ManifestInvalidField,
            "manifestVersion",
            format!("manifestVersion {version} does not fit in 32 bits"),
        )
    })?;

    if version != SUPPORTED_MANIFEST_VERSION {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::UnsupportedManifestVersion,
            "manifestVersion",
            format!(
                "manifestVersion {version} is not supported; this Fredo reads \
                 manifestVersion {SUPPORTED_MANIFEST_VERSION}"
            ),
        ));
    }
    Ok(version)
}

/// `engines`: an object with exactly `fredo: string`.
fn read_engines(object: &Map<String, Value>) -> InstalledAppResult<EnginesDeclaration> {
    let Some(Value::Object(engines)) = object.get("engines") else {
        return Err(match object.get("engines") {
            Some(_) => InstalledAppError::field(
                InstalledAppRefusalCode::ManifestInvalidField,
                "engines",
                "engines must be an object with a single \"fredo\" string",
            ),
            None => InstalledAppError::field(
                InstalledAppRefusalCode::ManifestInvalidField,
                "engines",
                "engines is required",
            ),
        });
    };

    reject_unknown_keys(engines, &MANIFEST_ENGINES_KEYS, "engines", "")?;

    let fredo = read_string_field(engines, "fredo").map_err(|error| InstalledAppError {
        code: error.code,
        detail: error.detail.replacen("engines.", "", 1),
        field: Some("engines.fredo".to_string()),
    })?;

    Ok(EnginesDeclaration { fredo })
}

/// `entry`: an object with exactly `document` and `module`, both valid paths.
fn read_entry(object: &Map<String, Value>) -> InstalledAppResult<EntryDeclaration> {
    let Some(Value::Object(entry)) = object.get("entry") else {
        return Err(match object.get("entry") {
            Some(_) => InstalledAppError::field(
                InstalledAppRefusalCode::ManifestInvalidField,
                "entry",
                "entry must be an object with \"document\" and \"module\" strings",
            ),
            None => InstalledAppError::field(
                InstalledAppRefusalCode::ManifestInvalidField,
                "entry",
                "entry is required",
            ),
        });
    };

    reject_unknown_keys(entry, &MANIFEST_ENTRY_KEYS, "entry", "")?;

    let document = read_string_field(entry, "document").map_err(|error| InstalledAppError {
        code: error.code,
        detail: error.detail,
        field: Some("entry.document".to_string()),
    })?;
    validate_entry_path(&document, ENTRY_DOCUMENT_EXTENSION).map_err(|reason| {
        InstalledAppError::field(
            InstalledAppRefusalCode::EntryInvalid,
            "entry.document",
            format!("entry.document \"{document}\" {reason}"),
        )
    })?;

    let module = read_string_field(entry, "module").map_err(|error| InstalledAppError {
        code: error.code,
        detail: error.detail,
        field: Some("entry.module".to_string()),
    })?;
    validate_entry_path(&module, ENTRY_MODULE_EXTENSION).map_err(|reason| {
        InstalledAppError::field(
            InstalledAppRefusalCode::EntryInvalid,
            "entry.module",
            format!("entry.module \"{module}\" {reason}"),
        )
    })?;

    Ok(EntryDeclaration { document, module })
}

/// `capabilities`: the declared backend reach (Spec #3146).
///
/// Absent — or an explicit `null`, treated as absent like `description` — is
/// [`None`], which means **zero declared capabilities**. There is no
/// "everything except a deny list" default: a package that declares nothing can
/// reach nothing.
fn read_capabilities(
    object: &Map<String, Value>,
    app_id: &str,
    app_version: &str,
) -> InstalledAppResult<Option<InstalledAppCapabilities>> {
    let Some(value) = object.get("capabilities") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }

    let Value::Object(capabilities) = value else {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::ManifestInvalidField,
            "capabilities",
            "capabilities must be an object",
        ));
    };

    reject_unknown_keys(
        capabilities,
        &MANIFEST_CAPABILITIES_KEYS,
        "capabilities",
        "capabilities.",
    )?;

    let version = read_capability_version(capabilities)?;
    let data = read_capability_data(capabilities, app_id, app_version)?;
    let high_risk = read_high_risk(capabilities)?;

    Ok(Some(InstalledAppCapabilities {
        version,
        data,
        high_risk,
    }))
}

/// `capabilities.version`: present, numeric, and exactly
/// [`CAPABILITY_MANIFEST_VERSION`].
///
/// A major this build does not implement is refused **loudly** — silently
/// ignoring an unknown contract major would let an author believe their
/// declaration was understood.
fn read_capability_version(capabilities: &Map<String, Value>) -> InstalledAppResult<u32> {
    const FIELD: &str = "capabilities.version";
    let Some(value) = capabilities.get("version") else {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::ManifestInvalidField,
            FIELD,
            "capabilities.version is required",
        ));
    };

    let number = match value {
        Value::Number(number) => number,
        other => {
            return Err(InstalledAppError::field(
                InstalledAppRefusalCode::ManifestInvalidField,
                FIELD,
                format!("capabilities.version must be a number (found {other})"),
            ))
        }
    };

    let Some(raw) = number.as_u64() else {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::ManifestInvalidField,
            FIELD,
            format!("capabilities.version must be a non-negative integer (found {number})"),
        ));
    };

    let version = u32::try_from(raw).map_err(|_| {
        InstalledAppError::field(
            InstalledAppRefusalCode::ManifestInvalidField,
            FIELD,
            format!("capabilities.version {raw} does not fit in 32 bits"),
        )
    })?;

    if version != CAPABILITY_MANIFEST_VERSION {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::ManifestInvalidField,
            FIELD,
            format!(
                "capabilities.version {version} is not supported; this Fredo implements \
                 capabilities.version {CAPABILITY_MANIFEST_VERSION}. The capability contract is \
                 additive within a major, so a different major cannot be read safely"
            ),
        ));
    }

    Ok(version)
}

/// `capabilities.data`: presence declares the `data.tables` capability.
fn read_capability_data(
    capabilities: &Map<String, Value>,
    app_id: &str,
    app_version: &str,
) -> InstalledAppResult<Option<CapabilityDataDeclaration>> {
    let Some(value) = capabilities.get("data") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }

    let Value::Object(data) = value else {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::ManifestInvalidField,
            "capabilities.data",
            "capabilities.data must be an object with a \"tables\" array",
        ));
    };

    reject_unknown_keys(
        data,
        &MANIFEST_CAPABILITY_DATA_KEYS,
        "capabilities.data",
        "capabilities.data.",
    )?;

    let Some(tables_value) = data.get("tables") else {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::ManifestInvalidField,
            "capabilities.data.tables",
            "capabilities.data.tables is required when capabilities.data is present; declare an \
             empty list when the application writes to no tables",
        ));
    };

    let Value::Array(entries) = tables_value else {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::ManifestInvalidField,
            "capabilities.data.tables",
            "capabilities.data.tables must be an array of table declarations",
        ));
    };

    let mut tables: Vec<ApplicationDataTableDeclaration> = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        tables.push(read_capability_table(entry, index)?);
    }

    // The shared declaration model is the ONE table validator (NFR-6): the
    // manifest does not re-implement name/charset/primary-key/column rules.
    // `declaration_revision` is inert here — the validator only checks that it
    // is non-empty — so the package version is recorded rather than invented.
    let declaration = ApplicationDataDeclaration {
        feature_id: app_id.to_string(),
        declaration_revision: data_declaration_revision(app_version),
        tables: tables.clone(),
    };
    if let Some(error) = declaration.validate().into_iter().next() {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::ManifestInvalidField,
            "capabilities.data.tables",
            format!("capabilities.data.tables is not a usable declaration: {error}"),
        ));
    }

    Ok(Some(CapabilityDataDeclaration { tables }))
}

/// One `capabilities.data.tables[i]` declaration.
fn read_capability_table(
    value: &Value,
    index: usize,
) -> InstalledAppResult<ApplicationDataTableDeclaration> {
    let path = format!("capabilities.data.tables[{index}]");

    let Value::Object(table) = value else {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::ManifestInvalidField,
            path.clone(),
            format!("{path} must be an object"),
        ));
    };

    // `source` is checked FIRST so the refusal names the rule, not a generic
    // unknown key. A declared projection reads a CANONICAL table — the user's own
    // chat/tool/agent-session rows — which no installed package may reach.
    if table.contains_key("source") {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::ManifestInvalidField,
            format!("{path}.source"),
            format!(
                "{path}.source is refused: a declared source projection reads Fredo's canonical \
                 tables (your own sessions and tool activity), which an installed application may \
                 never declare"
            ),
        ));
    }

    let prefix = format!("{path}.");
    reject_unknown_keys(table, &MANIFEST_CAPABILITY_TABLE_KEYS, path.as_str(), &prefix)?;

    serde_json::from_value::<ApplicationDataTableDeclaration>(value.clone()).map_err(|error| {
        InstalledAppError::field(
            InstalledAppRefusalCode::ManifestInvalidField,
            path.clone(),
            format!("{path} is not a valid table declaration: {error}"),
        )
    })
}

/// `capabilities.highRisk`: the declared consent-gated capability ids.
///
/// Each id is parsed through [`CapabilityId::parse`] and must be
/// [`CapabilityId::is_high_risk`] — so `data.tables` can never be smuggled into
/// the consent machinery, and a future id cannot become consentable by accident —
/// and may appear once. The result is sorted by wire spelling, so the projection's
/// arrays are deterministic.
fn read_high_risk(capabilities: &Map<String, Value>) -> InstalledAppResult<Vec<CapabilityId>> {
    let Some(value) = capabilities.get("highRisk") else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }

    let Value::Array(entries) = value else {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::ManifestInvalidField,
            "capabilities.highRisk",
            "capabilities.highRisk must be an array of capability ids",
        ));
    };

    let allowed: Vec<&str> = CapabilityId::ALL
        .iter()
        .filter(|id| id.is_high_risk())
        .map(|id| id.as_str())
        .collect();

    let mut seen: Vec<CapabilityId> = Vec::new();
    let mut high_risk: Vec<CapabilityId> = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let path = format!("capabilities.highRisk[{index}]");
        let Some(id) = entry.as_str() else {
            return Err(InstalledAppError::field(
                InstalledAppRefusalCode::ManifestInvalidField,
                path.clone(),
                format!("{path} must be a capability id string (found {entry})"),
            ));
        };
        let Some(capability) = CapabilityId::parse(id).filter(|id| id.is_high_risk()) else {
            return Err(InstalledAppError::field(
                InstalledAppRefusalCode::ManifestInvalidField,
                path,
                format!(
                    "\"{id}\" is not a high-risk capability this Fredo can ask you to consent to; \
                     the declared ids are {allowed:?}"
                ),
            ));
        };
        if seen.contains(&capability) {
            return Err(InstalledAppError::field(
                InstalledAppRefusalCode::ManifestInvalidField,
                path,
                format!("\"{id}\" is declared more than once"),
            ));
        }
        seen.push(capability);
        high_risk.push(capability);
    }

    high_risk.sort_by_key(|id| id.as_str());
    Ok(high_risk)
}

/// Is `range` a semver RANGE that admits the running Fredo version?
///
/// `*`, an empty string and an unparseable range are
/// [`EnginesRangeInvalid`]; a well-formed range that excludes the host is
/// [`HostIncompatible`]. The two families are deliberately distinct — collapsing
/// them would tell a user whose package declares `>=2` that their range is
/// malformed.
///
/// [`EnginesRangeInvalid`]: InstalledAppRefusalCode::EnginesRangeInvalid
/// [`HostIncompatible`]: InstalledAppRefusalCode::HostIncompatible
pub fn check_engines_range(range: &str) -> InstalledAppResult<()> {
    let trimmed = range.trim();
    if trimmed.is_empty() || trimmed == "*" {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::EnginesRangeInvalid,
            "engines.fredo",
            format!(
                "engines.fredo \"{range}\" must be a semver range such as \">=0.1.0\"; \"*\" and \
                 an empty string are refused"
            ),
        ));
    }

    let requirement = semver::VersionReq::parse(trimmed).map_err(|error| {
        InstalledAppError::field(
            InstalledAppRefusalCode::EnginesRangeInvalid,
            "engines.fredo",
            format!("engines.fredo \"{range}\" is not a valid semver range: {error}"),
        )
    })?;

    let host = semver::Version::parse(HOST_FREDO_VERSION).map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::HostIncompatible,
            format!(
                "this build's own version \"{HOST_FREDO_VERSION}\" is not parseable as SemVer: {error}"
            ),
        )
    })?;

    if !requirement.matches(&host) {
        return Err(InstalledAppError::field(
            InstalledAppRefusalCode::HostIncompatible,
            "engines.fredo",
            format!(
                "this package requires Fredo \"{range}\", but the running Fredo is \
                 {HOST_VERSION}",
                HOST_VERSION = host
            ),
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal valid manifest object, mutated per case.
    fn valid_manifest_json() -> Value {
        serde_json::json!({
            "manifestVersion": 1,
            "id": "qa3147-sample",
            "displayName": "QA3147 Sample",
            "version": "1.0.0",
            "engines": { "fredo": ">=0.0.0" },
            "entry": { "document": "index.html", "module": "main.js" },
            "description": "A sample package."
        })
    }

    fn parse_value(value: &Value) -> InstalledAppResult<AppManifest> {
        let bytes = serde_json::to_vec(value).expect("serialize");
        parse_manifest(&bytes)
    }

    fn code_of(value: &Value) -> InstalledAppRefusalCode {
        let error = parse_value(value).expect_err("expected a refusal");
        error.code
    }

    // ── The happy path ─────────────────────────────────────────────────────

    #[test]
    fn a_valid_manifest_is_accepted_and_round_trips() {
        let manifest = parse_value(&valid_manifest_json()).expect("valid manifest");
        assert_eq!(manifest.id, "qa3147-sample");
        assert_eq!(manifest.display_name, "QA3147 Sample");
        assert_eq!(manifest.version, "1.0.0");
        assert_eq!(manifest.engines.fredo, ">=0.0.0");
        assert_eq!(manifest.entry.document, "index.html");
        assert_eq!(manifest.entry.module, "main.js");
        assert_eq!(manifest.description.as_deref(), Some("A sample package."));

        // The canonical copy round-trips through serde unchanged.
        let encoded = serde_json::to_value(&manifest).expect("encode");
        let reparsed = parse_value(&encoded).expect("reparse");
        assert_eq!(reparsed, manifest);
    }

    #[test]
    fn an_absent_description_omits_the_key_entirely() {
        let mut value = valid_manifest_json();
        value.as_object_mut().expect("object").remove("description");
        let manifest = parse_value(&value).expect("valid without description");
        assert_eq!(manifest.description, None);

        let encoded = serde_json::to_value(&manifest).expect("encode");
        assert!(
            !encoded.as_object().expect("object").contains_key("description"),
            "an unset description must be an ABSENT key, never null"
        );
    }

    #[test]
    fn an_explicit_null_description_reads_as_absent() {
        let mut value = valid_manifest_json();
        value.as_object_mut().expect("object").insert("description".into(), Value::Null);
        let manifest = parse_value(&value).expect("null description is inert");
        assert_eq!(manifest.description, None);
    }

    // ── Rule 1-2: malformed ────────────────────────────────────────────────

    #[test]
    fn unparseable_json_is_manifest_malformed() {
        let error = parse_manifest(b"{ not json").expect_err("bad json");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestMalformed);
        assert!(error.detail.contains("not valid JSON"));
        assert_eq!(error.field, None, "a malformed document names no field");
    }

    #[test]
    fn a_json_array_is_manifest_malformed() {
        assert_eq!(
            parse_manifest(b"[]").expect_err("array").code,
            InstalledAppRefusalCode::ManifestMalformed
        );
    }

    #[test]
    fn an_empty_payload_is_manifest_malformed() {
        assert_eq!(
            parse_manifest(b"").expect_err("empty").code,
            InstalledAppRefusalCode::ManifestMalformed
        );
    }

    // ── Rule 3: unknown top-level key ──────────────────────────────────────

    /// INVERTED IN PLACE (Spec #3146): `capabilities` used to be the canonical
    /// unknown key. It is now the 8th allowed top-level key, so this test asserts
    /// the SAME property (an unknown top-level key is refused, naming the key
    /// exactly) against a key that is still unknown — and the next test proves
    /// `capabilities` itself is accepted.
    #[test]
    fn an_unknown_top_level_key_is_manifest_unknown_field() {
        let mut value = valid_manifest_json();
        value
            .as_object_mut()
            .expect("object")
            .insert("sandbox".into(), serde_json::json!(true));
        let error = parse_value(&value).expect_err("unknown key");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestUnknownField);
        assert_eq!(error.field.as_deref(), Some("sandbox"));
    }

    #[test]
    fn capabilities_is_the_eighth_allowed_top_level_key() {
        assert_eq!(MANIFEST_TOP_LEVEL_KEYS.len(), 8);
        assert_eq!(MANIFEST_TOP_LEVEL_KEYS[7], "capabilities");

        let mut value = valid_manifest_json();
        value["capabilities"] = serde_json::json!({ "version": 1 });
        let manifest = parse_value(&value).expect("capabilities is accepted");
        let capabilities = manifest.capabilities.expect("declared");
        assert_eq!(capabilities.version, 1);
        assert!(capabilities.declared().is_empty(), "no capability ids declared");
        assert!(capabilities.data_tables().is_empty());
    }

    #[test]
    fn an_unknown_key_inside_engines_is_refused() {
        let mut value = valid_manifest_json();
        value["engines"] = serde_json::json!({ "fredo": ">=0.0.0", "node": ">=18" });
        assert_eq!(
            code_of(&value),
            InstalledAppRefusalCode::ManifestUnknownField
        );
    }

    #[test]
    fn an_unknown_key_inside_entry_is_refused() {
        let mut value = valid_manifest_json();
        value["entry"] = serde_json::json!({
            "document": "index.html",
            "module": "main.js",
            "style": "main.css"
        });
        assert_eq!(
            code_of(&value),
            InstalledAppRefusalCode::ManifestUnknownField
        );
    }

    // ── capabilities (Spec #3146) ──────────────────────────────────────────

    /// A manifest declaring every capability family, with one declared table.
    fn declared_manifest_json() -> Value {
        let mut value = valid_manifest_json();
        value["id"] = serde_json::json!("qa3146-app-a");
        value["capabilities"] = serde_json::json!({
            "version": 1,
            "data": {
                "tables": [{
                    "name": "records",
                    "primaryKey": ["id"],
                    "columns": [
                        { "name": "id", "type": "TEXT", "nullable": false, "owner": "application" },
                        { "name": "value", "type": "TEXT", "nullable": true, "owner": "application" }
                    ]
                }]
            },
            "highRisk": ["high-risk.process-spawn", "high-risk.database-query"]
        });
        value
    }

    #[test]
    fn an_absent_capabilities_key_declares_nothing() {
        let manifest = parse_value(&valid_manifest_json()).expect("valid manifest");
        assert_eq!(manifest.capabilities, None, "absent ⇒ no access");

        let encoded = serde_json::to_value(&manifest).expect("encode");
        assert!(
            !encoded
                .as_object()
                .expect("object")
                .contains_key("capabilities"),
            "an undeclared capability set must be an ABSENT key, never null or {{}}: {encoded}"
        );
    }

    #[test]
    fn an_explicit_null_capabilities_key_reads_as_absent() {
        let mut value = valid_manifest_json();
        value
            .as_object_mut()
            .expect("object")
            .insert("capabilities".into(), Value::Null);
        let manifest = parse_value(&value).expect("null is inert (fail-safe)");
        assert_eq!(manifest.capabilities, None);
    }

    /// W-1 — the composer the window-open path hands to the registry: the
    /// manifest's tables verbatim and IN ORDER, under the derived application id,
    /// at the install validator's own revision, and with no `source` projection
    /// (an installed package can never declare one).
    #[test]
    fn the_open_declaration_carries_the_manifests_tables() {
        let mut value = declared_manifest_json();
        value["capabilities"]["data"]["tables"] = serde_json::json!([
            {
                "name": "notes",
                "primaryKey": ["id"],
                "columns": [
                    { "name": "id", "type": "TEXT", "nullable": false, "owner": "application" },
                    { "name": "body", "type": "TEXT", "nullable": true, "owner": "application" }
                ]
            },
            {
                "name": "shared_log",
                "primaryKey": ["id"],
                "columns": [
                    { "name": "id", "type": "TEXT", "nullable": false, "owner": "application" }
                ]
            }
        ]);
        let manifest = parse_value(&value).expect("a two-table declaration is valid");
        let capabilities = manifest.capabilities.as_ref().expect("declared");

        let declaration = capabilities
            .data_declaration(&manifest.id, &manifest.version)
            .expect("a package that declares tables composes a declaration");

        assert_eq!(declaration.feature_id, "qa3146-app-a");
        assert_eq!(
            declaration.declaration_revision,
            data_declaration_revision(&manifest.version),
            "one helper: the open path and the install validator share the revision"
        );
        assert_eq!(declaration.declaration_revision, "manifest:1.0.0");
        assert_eq!(
            declaration
                .tables
                .iter()
                .map(|table| table.name.as_str())
                .collect::<Vec<_>>(),
            ["notes", "shared_log"],
            "manifest order is preserved verbatim"
        );
        for table in &declaration.tables {
            assert!(
                table.source.is_none(),
                "an installed package's declared table never carries a source projection: {table:?}"
            );
        }
        // The composed declaration is one the registry accepts as-is.
        assert_eq!(declaration.validate(), Vec::<String>::new());
    }

    /// W-1 — a package with no declared table composes NOTHING (so the open path
    /// does no database work), and that includes the present-but-empty list.
    #[test]
    fn a_package_without_data_tables_composes_no_declaration() {
        assert!(
            parse_value(&valid_manifest_json())
                .expect("valid")
                .capabilities
                .is_none(),
            "control: this package declares no capabilities at all"
        );

        let mut empty = declared_manifest_json();
        empty["capabilities"]["data"]["tables"] = serde_json::json!([]);
        let manifest = parse_value(&empty).expect("an empty table list is valid");
        let capabilities = manifest.capabilities.as_ref().expect("declared");
        assert_eq!(capabilities.data_tables().len(), 0);
        assert_eq!(
            capabilities.data_declaration(&manifest.id, &manifest.version),
            None,
            "no declared table ⇒ no composition ⇒ no database work on open"
        );

        // ... and a package with no capabilities key at all is the same answer.
        let mut absent = valid_manifest_json();
        absent.as_object_mut().expect("object").remove("capabilities");
        let manifest = parse_value(&absent).expect("valid without capabilities");
        assert_eq!(manifest.capabilities, None);
    }

    #[test]
    fn a_declaration_round_trips_through_the_canonical_manifest() {
        let manifest = parse_value(&declared_manifest_json()).expect("declared manifest");
        let capabilities = manifest.capabilities.as_ref().expect("declared");
        assert_eq!(
            capabilities.declared(),
            [
                "data.tables",
                "high-risk.database-query",
                "high-risk.process-spawn"
            ],
            "declared ids are sorted and include data.tables for the data half"
        );
        assert_eq!(
            capabilities.high_risk(),
            ["high-risk.database-query", "high-risk.process-spawn"],
            "the high-risk subset is sorted (declaration order is not preserved)"
        );
        assert_eq!(capabilities.data_tables().len(), 1);
        assert_eq!(capabilities.data_tables()[0].name, "records");

        // The canonical copy re-parses to the same value (it is WHAT the runtime
        // re-reads on every call).
        let encoded = serde_json::to_value(&manifest).expect("encode");
        let reparsed = parse_value(&encoded).expect("canonical manifest reparses");
        assert_eq!(reparsed.capabilities, manifest.capabilities);
    }

    #[test]
    fn capabilities_must_be_an_object() {
        let mut value = valid_manifest_json();
        value["capabilities"] = serde_json::json!([1, 2, 3]);
        let error = parse_value(&value).expect_err("array");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestInvalidField);
        assert_eq!(error.field.as_deref(), Some("capabilities"));
    }

    #[test]
    fn an_unknown_key_inside_capabilities_is_refused_with_its_path() {
        let mut value = valid_manifest_json();
        value["capabilities"] = serde_json::json!({ "version": 1, "dataWatch": true });
        let error = parse_value(&value).expect_err("unknown capability key");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestUnknownField);
        assert_eq!(error.field.as_deref(), Some("capabilities.dataWatch"));
    }

    #[test]
    fn capabilities_version_is_required_numeric_and_exactly_one() {
        // Missing.
        let mut value = valid_manifest_json();
        value["capabilities"] = serde_json::json!({ "highRisk": [] });
        let error = parse_value(&value).expect_err("missing version");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestInvalidField);
        assert_eq!(error.field.as_deref(), Some("capabilities.version"));

        // Not a number.
        value["capabilities"] = serde_json::json!({ "version": "1" });
        let error = parse_value(&value).expect_err("string version");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestInvalidField);
        assert_eq!(error.field.as_deref(), Some("capabilities.version"));

        // An unknown contract major is refused LOUDLY, never ignored.
        for major in [0, 2, 99] {
            value["capabilities"] = serde_json::json!({ "version": major });
            let error = parse_value(&value).expect_err("unknown major");
            assert_eq!(
                error.code,
                InstalledAppRefusalCode::ManifestInvalidField,
                "capabilities.version {major} must be refused"
            );
            assert_eq!(error.field.as_deref(), Some("capabilities.version"));
            assert!(error.detail.contains("capabilities.version"));
        }
    }

    #[test]
    fn an_unknown_high_risk_id_is_refused_with_its_index() {
        let mut value = declared_manifest_json();
        value["capabilities"]["highRisk"] =
            serde_json::json!(["high-risk.database-query", "high-risk.everything"]);
        let error = parse_value(&value).expect_err("unknown capability id");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestInvalidField);
        assert_eq!(error.field.as_deref(), Some("capabilities.highRisk[1]"));
        assert!(error.detail.contains("high-risk.everything"));
    }

    #[test]
    fn data_tables_is_not_a_high_risk_id() {
        let mut value = declared_manifest_json();
        value["capabilities"]["highRisk"] = serde_json::json!(["data.tables"]);
        let error = parse_value(&value).expect_err("data.tables is never consentable");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestInvalidField);
        assert_eq!(error.field.as_deref(), Some("capabilities.highRisk[0]"));
    }

    #[test]
    fn a_duplicate_high_risk_id_is_refused() {
        let mut value = declared_manifest_json();
        value["capabilities"]["highRisk"] =
            serde_json::json!(["high-risk.database-reset", "high-risk.database-reset"]);
        let error = parse_value(&value).expect_err("duplicate");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestInvalidField);
        assert_eq!(error.field.as_deref(), Some("capabilities.highRisk[1]"));
    }

    #[test]
    fn a_non_string_high_risk_entry_is_refused() {
        let mut value = declared_manifest_json();
        value["capabilities"]["highRisk"] = serde_json::json!([42]);
        let error = parse_value(&value).expect_err("number");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestInvalidField);
        assert_eq!(error.field.as_deref(), Some("capabilities.highRisk[0]"));
    }

    #[test]
    fn a_declared_source_projection_is_refused_at_its_exact_path() {
        let mut value = declared_manifest_json();
        value["capabilities"]["data"]["tables"][0]["source"] =
            serde_json::json!({ "kind": "row", "from": "chat", "select": [] });
        let error = parse_value(&value).expect_err("source projection");
        assert_eq!(
            error.code,
            InstalledAppRefusalCode::ManifestInvalidField,
            "the source rule is an invalid-field refusal, not a generic unknown key"
        );
        assert_eq!(
            error.field.as_deref(),
            Some("capabilities.data.tables[0].source")
        );
    }

    #[test]
    fn an_unknown_key_inside_a_declared_table_is_refused_with_its_path() {
        let mut value = declared_manifest_json();
        value["capabilities"]["data"]["tables"][0]["engine"] = serde_json::json!("sqlite");
        let error = parse_value(&value).expect_err("unknown table key");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestUnknownField);
        assert_eq!(
            error.field.as_deref(),
            Some("capabilities.data.tables[0].engine")
        );
    }

    #[test]
    fn an_unusable_declared_table_is_refused_by_the_shared_validator() {
        // A missing primary key: the shared declaration model owns this rule, and
        // the manifest reports it under the declaration path.
        let mut value = declared_manifest_json();
        value["capabilities"]["data"]["tables"][0]["primaryKey"] = serde_json::json!([]);
        let error = parse_value(&value).expect_err("unusable table");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestInvalidField);
        assert_eq!(error.field.as_deref(), Some("capabilities.data.tables"));
    }

    #[test]
    fn capabilities_data_requires_a_tables_array() {
        let mut value = valid_manifest_json();
        value["capabilities"] = serde_json::json!({ "version": 1, "data": {} });
        let error = parse_value(&value).expect_err("no tables");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestInvalidField);
        assert_eq!(error.field.as_deref(), Some("capabilities.data.tables"));
    }

    // ── Rule 4-6: manifestVersion ──────────────────────────────────────────

    #[test]
    fn a_missing_manifest_version_is_manifest_invalid_field() {
        let mut value = valid_manifest_json();
        value.as_object_mut().expect("object").remove("manifestVersion");
        let error = parse_value(&value).expect_err("missing version");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestInvalidField);
        assert_eq!(error.field.as_deref(), Some("manifestVersion"));
    }

    #[test]
    fn a_string_manifest_version_is_manifest_invalid_field() {
        let mut value = valid_manifest_json();
        value["manifestVersion"] = serde_json::json!("1");
        assert_eq!(code_of(&value), InstalledAppRefusalCode::ManifestInvalidField);
    }

    #[test]
    fn a_fractional_manifest_version_is_manifest_invalid_field() {
        let mut value = valid_manifest_json();
        value["manifestVersion"] = serde_json::json!(1.5);
        assert_eq!(code_of(&value), InstalledAppRefusalCode::ManifestInvalidField);
    }

    #[test]
    fn a_future_manifest_version_is_unsupported() {
        let mut value = valid_manifest_json();
        value["manifestVersion"] = serde_json::json!(2);
        let error = parse_value(&value).expect_err("version 2");
        assert_eq!(error.code, InstalledAppRefusalCode::UnsupportedManifestVersion);
        assert_eq!(error.field.as_deref(), Some("manifestVersion"));
        assert!(error.detail.contains("manifestVersion 2"));
    }

    // ── id ─────────────────────────────────────────────────────────────────

    #[test]
    fn the_id_pattern_accepts_dotted_and_dashed_ids() {
        for id in [
            "a",
            "a1",
            "qa3147-sample",
            "com.example.app",
            "com.example-app.tool",
            "9lives",
            // A trailing dash IS legal under the plan's pattern
            // (`[a-z0-9][a-z0-9-]*` allows it); kept here as the documented
            // positive so nobody "tightens" the rule into a behaviour change.
            "trailing-dash-",
        ] {
            assert!(is_valid_app_id(id), "{id} should be valid");
        }
    }

    #[test]
    fn the_id_pattern_rejects_every_malformed_shape() {
        for id in [
            "",
            "-leading-dash",
            "Upper",
            "has space",
            "has_underscore",
            ".leading-dot",
            "trailing-dot.",
            "double..dot",
            "slash/inside",
            "colon:inside",
        ] {
            assert!(!is_valid_app_id(id), "{id:?} should be invalid");
        }
    }

    #[test]
    fn an_id_is_capped_at_96_characters() {
        let ok = "a".repeat(MAX_APP_ID_CHARS);
        assert!(is_valid_app_id(&ok), "exactly 96 chars is allowed");
        let too_long = "a".repeat(MAX_APP_ID_CHARS + 1);
        assert!(!is_valid_app_id(&too_long), "97 chars is refused");
        assert_eq!(MAX_APP_ID_CHARS, 96);
    }

    #[test]
    fn every_built_in_id_is_reserved() {
        for id in RESERVED_APP_IDS {
            assert!(is_reserved_app_id(id), "{id} must be reserved");
        }
        assert_eq!(RESERVED_APP_IDS.len(), 8);
        // The exact set the frontend pin asserts.
        assert_eq!(
            RESERVED_APP_IDS,
            [
                "wireframe",
                "terminal",
                "mission-monitor",
                "database-client",
                "theming",
                "setup",
                "settings",
                "dev-mode"
            ]
        );
    }

    #[test]
    fn a_reserved_id_is_refused_with_id_reserved() {
        for built_in in RESERVED_APP_IDS {
            let mut value = valid_manifest_json();
            value["id"] = serde_json::json!(built_in);
            let error = parse_value(&value).expect_err("reserved id");
            assert_eq!(
                error.code,
                InstalledAppRefusalCode::IdReserved,
                "{built_in} must be id_reserved"
            );
            assert_eq!(error.field.as_deref(), Some("id"));
        }
    }

    #[test]
    fn an_invalid_id_is_refused_with_id_invalid() {
        let mut value = valid_manifest_json();
        value["id"] = serde_json::json!("QA3147-Upper");
        let error = parse_value(&value).expect_err("bad id");
        assert_eq!(error.code, InstalledAppRefusalCode::IdInvalid);
        assert_eq!(error.field.as_deref(), Some("id"));
    }

    // ── displayName ────────────────────────────────────────────────────────

    #[test]
    fn display_name_is_bounded_to_1_through_64_characters() {
        let mut value = valid_manifest_json();
        value["displayName"] = serde_json::json!("x");
        assert!(parse_value(&value).is_ok(), "1 char is allowed");

        value["displayName"] = serde_json::json!("x".repeat(MAX_DISPLAY_NAME_CHARS));
        assert!(parse_value(&value).is_ok(), "64 chars is allowed");

        value["displayName"] = serde_json::json!("x".repeat(MAX_DISPLAY_NAME_CHARS + 1));
        let error = parse_value(&value).expect_err("65 chars");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestInvalidField);

        value["displayName"] = serde_json::json!("");
        assert!(parse_value(&value).is_err(), "empty is refused");
    }

    #[test]
    fn a_non_string_display_name_is_refused() {
        let mut value = valid_manifest_json();
        value["displayName"] = serde_json::json!(42);
        assert_eq!(code_of(&value), InstalledAppRefusalCode::ManifestInvalidField);
    }

    // ── version ────────────────────────────────────────────────────────────

    #[test]
    fn semver_versions_are_accepted_including_pre_release_and_build() {
        for version in ["0.0.1", "1.2.3", "1.0.0-alpha.1", "2.0.0-rc.1+build.5"] {
            let mut value = valid_manifest_json();
            value["version"] = serde_json::json!(version);
            assert!(parse_value(&value).is_ok(), "{version} must be accepted");
        }
    }

    #[test]
    fn a_non_semver_or_v_prefixed_version_is_version_invalid() {
        for version in ["1.0", "v1.0.0", "1", "1.0.0.0", "latest", ""] {
            let mut value = valid_manifest_json();
            value["version"] = serde_json::json!(version);
            let error = parse_value(&value).expect_err("bad version");
            assert_eq!(
                error.code,
                InstalledAppRefusalCode::VersionInvalid,
                "{version} must be version_invalid"
            );
            assert_eq!(error.field.as_deref(), Some("version"));
        }
    }

    // ── entry ──────────────────────────────────────────────────────────────

    #[test]
    fn entry_paths_accept_nested_relative_posix_paths() {
        assert!(validate_entry_path("index.html", ENTRY_DOCUMENT_EXTENSION).is_ok());
        assert!(validate_entry_path("ui/index.html", ENTRY_DOCUMENT_EXTENSION).is_ok());
        assert!(validate_entry_path("a/b/c/main.js", ENTRY_MODULE_EXTENSION).is_ok());
    }

    #[test]
    fn entry_paths_reject_absolute_parent_drive_unc_and_empty_segments() {
        let cases = [
            ("/index.html", "absolute"),
            ("../index.html", "parent"),
            ("ui/../../index.html", "parent"),
            ("C:/index.html", "drive"),
            ("ui\\index.html", "backslash"),
            ("ui//index.html", "empty segment"),
            ("", "empty"),
        ];
        for (path, label) in cases {
            assert!(
                validate_entry_path(path, ENTRY_DOCUMENT_EXTENSION).is_err(),
                "{label} path {path:?} must be refused"
            );
        }
    }

    #[test]
    fn entry_extensions_are_enforced() {
        assert!(validate_entry_path("index.htm", ENTRY_DOCUMENT_EXTENSION).is_err());
        assert!(validate_entry_path("index.html", ENTRY_MODULE_EXTENSION).is_err());
        assert!(validate_entry_path("main.js", ENTRY_DOCUMENT_EXTENSION).is_err());
    }

    #[test]
    fn a_bad_entry_document_is_entry_invalid() {
        let mut value = valid_manifest_json();
        value["entry"] = serde_json::json!({ "document": "../escape.html", "module": "main.js" });
        let error = parse_value(&value).expect_err("bad document");
        assert_eq!(error.code, InstalledAppRefusalCode::EntryInvalid);
        assert_eq!(error.field.as_deref(), Some("entry.document"));
    }

    #[test]
    fn a_bad_entry_module_is_entry_invalid() {
        let mut value = valid_manifest_json();
        value["entry"] = serde_json::json!({ "document": "index.html", "module": "main.mjs" });
        let error = parse_value(&value).expect_err("bad module");
        assert_eq!(error.code, InstalledAppRefusalCode::EntryInvalid);
        assert_eq!(error.field.as_deref(), Some("entry.module"));
    }

    #[test]
    fn a_missing_entry_is_manifest_invalid_field() {
        let mut value = valid_manifest_json();
        value.as_object_mut().expect("object").remove("entry");
        let error = parse_value(&value).expect_err("missing entry");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestInvalidField);
        assert_eq!(error.field.as_deref(), Some("entry"));
    }

    #[test]
    fn a_missing_engines_object_is_manifest_invalid_field() {
        let mut value = valid_manifest_json();
        value.as_object_mut().expect("object").remove("engines");
        let error = parse_value(&value).expect_err("missing engines");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestInvalidField);
        assert_eq!(error.field.as_deref(), Some("engines"));
    }

    // ── engines range: the TWO families stay distinct ──────────────────────

    #[test]
    fn a_star_or_empty_or_unparseable_range_is_engines_range_invalid() {
        for range in ["*", "", "   ", "not-a-range", ">=", "garbage &&&"] {
            let error = check_engines_range(range).expect_err("bad range");
            assert_eq!(
                error.code,
                InstalledAppRefusalCode::EnginesRangeInvalid,
                "{range:?} must be engines_range_invalid, NOT host_incompatible"
            );
            assert_eq!(error.field.as_deref(), Some("engines.fredo"));
        }
    }

    #[test]
    fn a_well_formed_range_excluding_the_host_is_host_incompatible() {
        let host = semver::Version::parse(HOST_FREDO_VERSION).expect("host version");
        let exclusive = format!(">={}.0.0", host.major + 1);
        let error = check_engines_range(&exclusive).expect_err("excludes host");
        assert_eq!(
            error.code,
            InstalledAppRefusalCode::HostIncompatible,
            "a well-formed range that excludes the host is host_incompatible"
        );
        assert_eq!(error.field.as_deref(), Some("engines.fredo"));
        assert!(error.detail.contains(&exclusive));
    }

    #[test]
    fn a_range_including_the_host_is_accepted() {
        let host = semver::Version::parse(HOST_FREDO_VERSION).expect("host version");
        for range in [
            ">=0.0.0".to_string(),
            format!("^{}.{}.{}", host.major, host.minor, host.patch),
            format!(">={}.0.0", host.major),
            format!("={}", host),
        ] {
            assert!(
                check_engines_range(&range).is_ok(),
                "{range} must include the running host"
            );
        }
    }

    #[test]
    fn the_two_range_families_never_collapse() {
        // A malformed range must NEVER report host_incompatible, and a valid
        // excluding range must NEVER report engines_range_invalid.
        assert_eq!(
            check_engines_range("*").expect_err("star").code,
            InstalledAppRefusalCode::EnginesRangeInvalid
        );
        assert_eq!(
            check_engines_range(">=999.0.0").expect_err("future").code,
            InstalledAppRefusalCode::HostIncompatible
        );
    }

    // ── description ────────────────────────────────────────────────────────

    #[test]
    fn description_is_capped_at_280_characters() {
        let mut value = valid_manifest_json();
        value["description"] = serde_json::json!("x".repeat(MAX_DESCRIPTION_CHARS));
        assert!(parse_value(&value).is_ok(), "280 chars is allowed");

        value["description"] = serde_json::json!("x".repeat(MAX_DESCRIPTION_CHARS + 1));
        let error = parse_value(&value).expect_err("281 chars");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestInvalidField);
        assert_eq!(error.field.as_deref(), Some("description"));
    }

    #[test]
    fn a_non_string_description_is_refused() {
        let mut value = valid_manifest_json();
        value["description"] = serde_json::json!({ "text": "nope" });
        assert_eq!(code_of(&value), InstalledAppRefusalCode::ManifestInvalidField);
    }

    // ── Precedence ─────────────────────────────────────────────────────────

    #[test]
    fn a_malformed_document_wins_over_an_unknown_key() {
        // Unparseable JSON cannot be scanned for keys at all.
        assert_eq!(
            parse_manifest(b"{\"bogus\": 1,").expect_err("bad json").code,
            InstalledAppRefusalCode::ManifestMalformed
        );
    }

    #[test]
    fn an_unknown_key_wins_over_a_bad_id() {
        let mut value = valid_manifest_json();
        value["id"] = serde_json::json!("BAD");
        value
            .as_object_mut()
            .expect("object")
            .insert("extra".into(), serde_json::json!(true));
        assert_eq!(
            code_of(&value),
            InstalledAppRefusalCode::ManifestUnknownField,
            "the closed-schema refusal is reported before field rules"
        );
    }

    #[test]
    fn an_unsupported_version_wins_over_a_bad_entry() {
        let mut value = valid_manifest_json();
        value["manifestVersion"] = serde_json::json!(99);
        value["entry"] = serde_json::json!({ "document": "../x.html", "module": "m.js" });
        assert_eq!(
            code_of(&value),
            InstalledAppRefusalCode::UnsupportedManifestVersion
        );
    }

    #[test]
    fn the_manifest_serializes_camel_case() {
        let manifest = parse_value(&valid_manifest_json()).expect("valid");
        let encoded = serde_json::to_value(&manifest).expect("encode");
        for key in ["manifestVersion", "id", "displayName", "version", "engines", "entry"] {
            assert!(encoded.get(key).is_some(), "{key} must be camelCase on the wire");
        }
        for snake in ["manifest_version", "display_name"] {
            assert!(
                encoded.get(snake).is_none(),
                "{snake} must never appear on the wire"
            );
        }
    }
}
