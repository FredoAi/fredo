//! Spec #3146 — the installed tier's authority surface: who is calling, what the
//! closed capability vocabulary is, and the refusal it gets when a decision says
//! no.
//!
//! # The mechanism this module is half of
//!
//! Tauri's IPC authority gate is turned on by `build.rs` registering an
//! application manifest, so **no command reaches a window unless a capability
//! grants it** (`runtime::command_manifest`). The installed tier therefore gets
//! exactly ONE command (`dispatch::installed_app_invoke`) through exactly one
//! capability (`capabilities/installed-app-commands.json`,
//! `windows: ["installed-*"]`, `permissions: ["allow-installed-app-invoke"]`,
//! no `core:*` — pinned by `runtime::capability_guard`). Everything else — which
//! action, which data — is decided *inside* that one handler, from the IPC
//! webview's own window label.
//!
//! # Why the window label is the identity
//!
//! A [`tauri::Webview`] command argument is the IPC channel's own webview
//! (`impl CommandArg for Webview`), so its label is minted server-side and can
//! never be supplied by the calling document. `installed-<id>` labels are minted
//! only by `window::open_installed_app_window`, after `resolve_open_target` has
//! verified the install record, and no installed document holds a
//! window-creating permission. A caller-supplied `applicationId` is therefore
//! never authority: [`super::dispatch`] validates it against the derived id and
//! then **overwrites** it before any handler body sees it.
//!
//! # Fail-closed by construction
//!
//! [`classify_window_label`] answers `caller_unknown` for every label outside the
//! two closed sets (built-in class, `installed-<valid, non-reserved id>`), and
//! [`read_authority_grants`] answers "nothing declared, nothing consented" when
//! the declaration surface cannot be read. Both are the safe direction: an
//! application whose authority cannot be established is refused, never granted.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::manifest::{is_reserved_app_id, is_valid_app_id};
use super::INSTALLED_APP_WINDOW_LABEL_PREFIX;
use crate::infrastructure::app_window::GENERIC_APP_WINDOW_LABEL_PREFIX;

/// The built-in window labels that are not `app-*` derived.
///
/// These are exactly the three non-generic labels every shipped capability
/// targets (`capabilities/default.json`, `app-commands.json`,
/// `mcp-bridge-dev.json`); the fourth built-in label family is
/// [`GENERIC_APP_WINDOW_LABEL_PREFIX`].
pub const BUILT_IN_WINDOW_LABELS: [&str; 3] = ["main", "terminal", "doom"];

/// Which tier a caller belongs to. The tiers never mix: a built-in window is not
/// "an installed application that happens to have more rights", and installing a
/// package never promotes it into this enum's `BuiltIn` arm.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallerTier {
    /// A window Fredo ships (`main`, `terminal`, `doom`, `app-<id>`).
    BuiltIn,
    /// An `installed-<id>` window, opened only after integrity verification.
    Installed,
}

/// The caller's identity, derived from the IPC webview's window label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallerScope {
    pub tier: CallerTier,
    pub window_label: String,
    /// `Some(id)` iff `tier == Installed`; `None` for the built-in class.
    pub app_id: Option<String>,
}

/// The CLOSED capability vocabulary (`plan` §Binding Names).
///
/// Adding an arm is a declaration-surface change: it must also appear in
/// [`CapabilityId::ALL`], in the dispatch table
/// ([`super::dispatch::DISPATCH_TABLE`]) and in the manifest validator. The
/// `capability_ids_are_an_ordered_exact_set` unit test pins all four in order so
/// a same-set reorder or a silent fifth id reddens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CapabilityId {
    /// Read/write/delete/declare the application's OWN declared tables.
    #[serde(rename = "data.tables")]
    DataTables,
    /// Arbitrary SQL against the user's configured database connections.
    #[serde(rename = "high-risk.database-query")]
    HighRiskDatabaseQuery,
    /// Re-initialise (destroy) Fredo's database.
    #[serde(rename = "high-risk.database-reset")]
    HighRiskDatabaseReset,
    /// Start a terminal session on the user's machine.
    #[serde(rename = "high-risk.process-spawn")]
    HighRiskProcessSpawn,
}

impl CapabilityId {
    /// Every capability id, in the plan's documented order (ordered exact set).
    pub const ALL: [Self; 4] = [
        Self::DataTables,
        Self::HighRiskDatabaseQuery,
        Self::HighRiskDatabaseReset,
        Self::HighRiskProcessSpawn,
    ];

    /// The wire spelling (also the manifest value).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DataTables => "data.tables",
            Self::HighRiskDatabaseQuery => "high-risk.database-query",
            Self::HighRiskDatabaseReset => "high-risk.database-reset",
            Self::HighRiskProcessSpawn => "high-risk.process-spawn",
        }
    }

    /// Parse a manifest capability id; `None` for anything outside the closed set.
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|id| id.as_str() == value)
    }

    /// Does this capability need a per-application user consent before use?
    ///
    /// `data.tables` does NOT: it reaches only the application's own declared
    /// tables, which the user already reviewed by installing the package. The
    /// three `high-risk.*` capabilities do (R-4.3).
    pub fn is_high_risk(self) -> bool {
        matches!(
            self,
            Self::HighRiskDatabaseQuery | Self::HighRiskDatabaseReset | Self::HighRiskProcessSpawn
        )
    }
}

/// Classify a window label into a [`CallerScope`], or `caller_unknown`.
///
/// Pure, so the closed set is unit-testable without a running app. The order
/// matters: the built-in class is matched FIRST, and the two prefixes are
/// disjoint (`installed-` can never start with `app-` and vice versa), so no
/// label can be read as both tiers.
pub fn classify_window_label(label: &str) -> Result<CallerScope, CapabilityRefusalCode> {
    if BUILT_IN_WINDOW_LABELS.contains(&label)
        || label.starts_with(GENERIC_APP_WINDOW_LABEL_PREFIX)
    {
        return Ok(CallerScope {
            tier: CallerTier::BuiltIn,
            window_label: label.to_string(),
            app_id: None,
        });
    }

    if let Some(id) = label.strip_prefix(INSTALLED_APP_WINDOW_LABEL_PREFIX) {
        // An installed id is the manifest id rule (charset + 96-char cap) AND the
        // reserved set: `installed-mission-monitor` must never be read as an
        // application, because that id IS a built-in application.
        if is_valid_app_id(id) && !is_reserved_app_id(id) {
            return Ok(CallerScope {
                tier: CallerTier::Installed,
                window_label: label.to_string(),
                app_id: Some(id.to_string()),
            });
        }
    }

    Err(CapabilityRefusalCode::CallerUnknown)
}

/// The SIX-code authority refusal vocabulary (plan §Binding Names).
///
/// Deliberately separate from [`super::InstalledAppRefusalCode`] (frozen at 22):
/// the installer's codes describe a package, these describe an authority
/// decision, and neither may grow into the other (`regression.md` R-8.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityRefusalCode {
    /// The action's capability is not declared by this package.
    ActionNotDeclared,
    /// The action is not one an installed application may ever invoke.
    ActionNotGrantable,
    /// The capability is declared but the user has not consented to it.
    ConsentRequired,
    /// The request named another application, an undeclared table, or a
    /// canonical table, or the composed physical name was ambiguous.
    ScopeDenied,
    /// The window label is in neither closed tier set (fail closed).
    CallerUnknown,
    /// The derived application id has no install directory any more.
    AppNotInstalled,
}

impl CapabilityRefusalCode {
    /// Every code, in the plan's documented order (ordered exact set).
    pub const ALL: [Self; 6] = [
        Self::ActionNotDeclared,
        Self::ActionNotGrantable,
        Self::ConsentRequired,
        Self::ScopeDenied,
        Self::CallerUnknown,
        Self::AppNotInstalled,
    ];

    /// The wire spelling (serde `snake_case` derivation, asserted by a test).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ActionNotDeclared => "action_not_declared",
            Self::ActionNotGrantable => "action_not_grantable",
            Self::ConsentRequired => "consent_required",
            Self::ScopeDenied => "scope_denied",
            Self::CallerUnknown => "caller_unknown",
            Self::AppNotInstalled => "app_not_installed",
        }
    }
}

impl std::fmt::Display for CapabilityRefusalCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The refusal a rejected installed-application call is rejected with.
///
/// Wire keys: `code`, `appId`, `action`, `detail` and — ONLY when it applies —
/// `capability`. The optional key is `skip_serializing_if`, so an unset
/// capability is an **absent key, never `"capability": null`** (G-413): a
/// consumer that discriminates presence would otherwise dereference a null.
///
/// `app_id` is ALWAYS the id derived from the window label, never the id the
/// payload asked for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityRefusal {
    pub code: CapabilityRefusalCode,
    pub app_id: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability: Option<String>,
    pub detail: String,
}

impl CapabilityRefusal {
    /// A refusal that has no `capability` to name (the key is omitted).
    pub fn new(
        code: CapabilityRefusalCode,
        app_id: impl Into<String>,
        action: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            code,
            app_id: app_id.into(),
            action: action.into(),
            capability: None,
            detail: detail.into(),
        }
    }

    /// Attach the capability the decision was about (adds the `capability` key).
    pub fn with_capability(mut self, capability: CapabilityId) -> Self {
        self.capability = Some(capability.as_str().to_string());
        self
    }

    /// Log the refusal once. The host renders NOTHING for a runtime refusal
    /// (UI/UX §4): the app's own document renders it, and a host toast would
    /// attribute a refusal the caller caused to the host.
    pub fn trace(&self) {
        tracing::warn!(
            target: "fredo::installed_apps::authority",
            code = self.code.as_str(),
            app_id = %self.app_id,
            action = %self.action,
            capability = self.capability.as_deref().unwrap_or(""),
            detail = %self.detail,
            "installed-application call refused"
        );
    }
}

// ── Refusal details ─────────────────────────────────────────────────────────
//
// Every detail is FIXED text. The UI/UX leak boundary (§4) is part of AC-3: a
// refusal is caused by the caller, so it may describe the caller only. These
// strings name the RULE and never another application, its table, an
// enumeration of installed ids, or a count. `scope_denied` in particular is one
// sentence for every cause (foreign id, undeclared table, composed-name
// collision, canonical source), so "that table exists and is not yours" and
// "that table does not exist" are indistinguishable — otherwise the refusal is
// an installed-application enumeration oracle.

/// `action_not_declared`
pub const DETAIL_ACTION_NOT_DECLARED: &str =
    "This application's package did not declare the capability this action needs.";
/// `action_not_grantable`
pub const DETAIL_ACTION_NOT_GRANTABLE: &str =
    "This action is not one an installed application may invoke, so Fredo refused it.";
/// `consent_required`
pub const DETAIL_CONSENT_REQUIRED: &str = "You have not allowed this capability for this \
     application yet. Allow it in Settings > Installed applications, then try again.";
/// `caller_unknown`
pub const DETAIL_CALLER_UNKNOWN: &str =
    "Fredo could not establish which application made this call, so it refused it.";
/// `app_not_installed`
pub const DETAIL_APP_NOT_INSTALLED: &str =
    "This application has no install record any more, so Fredo refused the call.";

/// What one installed application has declared and what the user has consented
/// to, as read for ONE call.
///
/// Both lists are empty when nothing is recorded, and an empty declaration list
/// means **zero reach** — never "everything except a deny list" (NFR fail-safe).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct AuthorityGrants {
    /// The capability ids the package declared (`capabilities` in its manifest).
    pub declared: Vec<CapabilityId>,
    /// The high-risk ids the user granted, for THIS application only.
    pub consented: Vec<CapabilityId>,
}

impl AuthorityGrants {
    /// Has the package declared this capability?
    pub fn declares(&self, capability: CapabilityId) -> bool {
        self.declared.contains(&capability)
    }

    /// Has the user consented to this capability for this application?
    pub fn has_consent(&self, capability: CapabilityId) -> bool {
        self.consented.contains(&capability)
    }
}

/// Read the caller's declared + consented capabilities, **from disk, per call**.
///
/// # Handoff seam (one call site, no second implementation)
///
/// This is the ONE place the dispatcher reads authority declarations. The two
/// sources are owned by the capsule that owns the declaration surfaces:
///
/// * the package's `capabilities` object (`manifest::AppManifest::capabilities`,
///   the 8th top-level manifest key) for [`AuthorityGrants::declared`];
/// * the host-owned consent store (`<app_data_dir>/installed-apps-consent.json`,
///   `{ "version": 1, "grants": { "<id>": ["<capability id>", …] } }`) for
///   [`AuthorityGrants::consented`].
///
/// Until those read paths land this returns the EMPTY set, which is the
/// fail-closed direction and the honest state of the tree: a package whose
/// `capabilities` key cannot be validated yet is refused at install
/// (`manifest_unknown_field`), and an application whose declarations cannot be
/// read is refused `action_not_declared` rather than granted reach it cannot
/// prove. It must be **replaced in place** — never duplicated beside a second
/// reader, and never cached across calls (R-3.5 / NFR complete mediation).
pub fn read_authority_grants(_app_data_dir: &Path, _app_id: &str) -> AuthorityGrants {
    AuthorityGrants::default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// F-7.2 — the tier classifier is closed and fails closed.
    #[test]
    fn caller_tiers_are_closed_and_fail_closed() {
        for label in ["main", "terminal", "doom", "app-terminal", "app-database-client"] {
            let scope = classify_window_label(label).expect("built-in label classifies");
            assert_eq!(scope.tier, CallerTier::BuiltIn, "{label} is a built-in window");
            assert_eq!(scope.window_label, label);
            assert_eq!(scope.app_id, None, "a built-in window carries no app id");
        }

        let installed = classify_window_label("installed-qa3146-app-a")
            .expect("an installed-<valid id> label classifies");
        assert_eq!(installed.tier, CallerTier::Installed);
        assert_eq!(installed.app_id.as_deref(), Some("qa3146-app-a"));

        // An installed id that EXTENDS another id is still a valid id; whether it
        // is shadowed is the resolver's decision (scope.rs), not the classifier's.
        let extended = classify_window_label("installed-qa3146-app-a-evil")
            .expect("a hyphen-extension is a valid app id");
        assert_eq!(extended.app_id.as_deref(), Some("qa3146-app-a-evil"));

        for label in [
            "",
            "installed-",
            "installed-QA3146",
            "installed-qa_3146",
            "installed-mission-monitor",
            "installed-..",
            "installed-.a",
            "webview-1",
            "launcher",
            "installed",
        ] {
            assert_eq!(
                classify_window_label(label),
                Err(CapabilityRefusalCode::CallerUnknown),
                "{label:?} must be refused as caller_unknown"
            );
        }
    }

    /// F-7.2 — the six wire codes are the exact snake_case strings, in order.
    #[test]
    fn refusal_codes_are_the_six_wire_strings() {
        assert_eq!(CapabilityRefusalCode::ALL.len(), 6, "the authority set is six");
        let wire: Vec<String> = CapabilityRefusalCode::ALL
            .into_iter()
            .map(|code| serde_json::to_string(&code).expect("serialize code"))
            .collect();
        assert_eq!(
            wire,
            vec![
                "\"action_not_declared\"".to_string(),
                "\"action_not_grantable\"".to_string(),
                "\"consent_required\"".to_string(),
                "\"scope_denied\"".to_string(),
                "\"caller_unknown\"".to_string(),
                "\"app_not_installed\"".to_string(),
            ],
            "serde snake_case must agree with as_str(), in the plan's order"
        );
        for code in CapabilityRefusalCode::ALL {
            assert_eq!(
                format!("\"{}\"", code.as_str()),
                serde_json::to_string(&code).expect("serialize code"),
                "as_str() and the serde derivation must agree for {code:?}"
            );
        }
    }

    /// F-7.2 — the serialized refusal carries `capability` ONLY when it applies.
    #[test]
    fn refusal_wire_keys_are_exact_in_both_directions() {
        let with = CapabilityRefusal::new(
            CapabilityRefusalCode::ConsentRequired,
            "qa3146-consent-a",
            "db_query_execute",
            DETAIL_CONSENT_REQUIRED,
        )
        .with_capability(CapabilityId::HighRiskDatabaseQuery);
        let value: Value = serde_json::to_value(&with).expect("serialize refusal");
        let mut keys: Vec<&str> = value
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["action", "appId", "capability", "code", "detail"],
            "the present-optional shape is exactly five keys"
        );
        assert_eq!(value["capability"], Value::String("high-risk.database-query".into()));
        assert_eq!(value["appId"], Value::String("qa3146-consent-a".into()));

        let without = CapabilityRefusal::new(
            CapabilityRefusalCode::ActionNotGrantable,
            "qa3146-app-a",
            "save_control_setting",
            DETAIL_ACTION_NOT_GRANTABLE,
        );
        let value: Value = serde_json::to_value(&without).expect("serialize refusal");
        let mut keys: Vec<&str> = value
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["action", "appId", "code", "detail"],
            "an unset capability is an ABSENT key, never an explicit null"
        );
        assert!(
            without.capability.is_none(),
            "the type must not carry an empty-string capability either"
        );
    }

    /// The capability vocabulary is the closed four, in order, with distinct
    /// wire spellings that round-trip through the manifest spelling.
    #[test]
    fn capability_ids_are_an_ordered_exact_set() {
        assert_eq!(
            CapabilityId::ALL.map(CapabilityId::as_str),
            [
                "data.tables",
                "high-risk.database-query",
                "high-risk.database-reset",
                "high-risk.process-spawn",
            ],
            "ordered exact set — a same-set reorder must redden"
        );
        for id in CapabilityId::ALL {
            assert_eq!(CapabilityId::parse(id.as_str()), Some(id));
            assert_eq!(
                serde_json::to_string(&id).expect("serialize id"),
                format!("\"{}\"", id.as_str()),
                "the serde spelling is the manifest spelling"
            );
        }
        assert_eq!(CapabilityId::parse("data.watch"), None, "not a declarable id");
        assert_eq!(CapabilityId::parse(""), None);

        assert!(!CapabilityId::DataTables.is_high_risk());
        for id in [
            CapabilityId::HighRiskDatabaseQuery,
            CapabilityId::HighRiskDatabaseReset,
            CapabilityId::HighRiskProcessSpawn,
        ] {
            assert!(id.is_high_risk(), "{id:?} needs a consent");
        }
    }

    /// The fail-safe default: nothing declared, nothing reachable.
    #[test]
    fn grants_default_to_nothing() {
        let grants = AuthorityGrants::default();
        for id in CapabilityId::ALL {
            assert!(!grants.declares(id), "{id:?} must not be declared by default");
            assert!(!grants.has_consent(id), "{id:?} must not be consented by default");
        }
        assert_eq!(
            read_authority_grants(Path::new("unused"), "qa3146-app-a"),
            AuthorityGrants::default(),
            "the authority read is fail-closed while the declaration surfaces are unreadable"
        );
    }
}
