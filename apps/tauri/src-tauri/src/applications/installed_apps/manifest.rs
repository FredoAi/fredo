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
//! 8. `engines.fredo` `*`/empty/unparseable ⇒ [`EnginesRangeInvalid`]
//! 9. a well-formed range excluding the host ⇒ [`HostIncompatible`]
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
//! package declare something (`capabilities`, say) that this build silently
//! ignores, which reads to the author as accepted consent. `#3146` will add
//! `capabilities` as an additive optional field and relax this rule in the SAME
//! landing — never before.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{
    InstalledAppError, InstalledAppRefusalCode, InstalledAppResult, HOST_FREDO_VERSION,
    SUPPORTED_MANIFEST_VERSION,
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
pub const MANIFEST_TOP_LEVEL_KEYS: [&str; 7] = [
    "manifestVersion",
    "id",
    "displayName",
    "version",
    "engines",
    "entry",
    "description",
];

/// `entry` object keys.
pub const MANIFEST_ENTRY_KEYS: [&str; 2] = ["document", "module"];
/// `engines` object keys.
pub const MANIFEST_ENGINES_KEYS: [&str; 1] = ["fredo"];

/// A validated `fredo-app.json`.
///
/// Produced only by [`parse_manifest`], so holding one means every rule below
/// has already passed. Field names are the manifest's own (`camelCase` on the
/// wire) because this type is ALSO written verbatim as
/// `<id>/manifest.json` — the canonical normalized copy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

    reject_unknown_keys(&object, &MANIFEST_TOP_LEVEL_KEYS, "fredo-app.json")?;

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
    })
}

/// Reject any key in `object` that is not in `allowed`.
fn reject_unknown_keys(
    object: &Map<String, Value>,
    allowed: &[&str],
    where_: &str,
) -> InstalledAppResult<()> {
    let allowed: BTreeSet<&str> = allowed.iter().copied().collect();
    for key in object.keys() {
        if !allowed.contains(key.as_str()) {
            return Err(InstalledAppError::field(
                InstalledAppRefusalCode::ManifestUnknownField,
                key,
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

    reject_unknown_keys(engines, &MANIFEST_ENGINES_KEYS, "engines")?;

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

    reject_unknown_keys(entry, &MANIFEST_ENTRY_KEYS, "entry")?;

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

    #[test]
    fn an_unknown_top_level_key_is_manifest_unknown_field() {
        let mut value = valid_manifest_json();
        value
            .as_object_mut()
            .expect("object")
            .insert("capabilities".into(), serde_json::json!([]));
        let error = parse_value(&value).expect_err("unknown key");
        assert_eq!(error.code, InstalledAppRefusalCode::ManifestUnknownField);
        assert_eq!(error.field.as_deref(), Some("capabilities"));
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
