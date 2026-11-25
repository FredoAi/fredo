//! Spec #3146 — the installed tier's dispatcher: ONE command, one table, one
//! identity source.
//!
//! [`installed_app_invoke`] is the ONLY command an `installed-<id>` window can
//! reach (`capabilities/installed-app-commands.json` grants exactly
//! `allow-installed-app-invoke`, and `runtime::capability_guard` pins that this
//! is the one capability matching the installed label family). Every other
//! registered command stays ACL-refused to that window.
//!
//! # How a call is decided (per call — nothing is cached)
//!
//! 1. **Identity** — the IPC webview's own label,
//!    [`authority::classify_window_label`]. A payload can never supply it.
//! 2. **Install record** — the derived id must still have an install directory.
//! 3. **Vocabulary** — the action must be in [`DISPATCH_TABLE`]; anything else
//!    (including every `installed_app_*`, `application_store_*`,
//!    `subscribe_events`, `application_data_watch` and window-opening command)
//!    is `action_not_grantable` and is never forwarded.
//! 4. **Declaration + consent** — the action's capability must be declared by the
//!    package (`action_not_declared`) and, for a `high-risk.*` capability, the
//!    user must have consented for THIS application (`consent_required`).
//!    Both are re-read from disk on every call (R-3.5).
//! 5. **Data scope** — for the `data.tables` capability the caller's id and table
//!    are validated against the derived identity, the declaration set and the
//!    canonical physical name ([`super::scope::resolve_data_scope`]), and the
//!    payload's `applicationId` is then OVERWRITTEN with the derived id before a
//!    handler body sees it.
//!
//! Refusals carry `{code, appId, action, detail}` (plus `capability` when it
//! applies) from the six-code authority vocabulary — never the installer's 22.
//!
//! # The closed-vocabulary imprecision (recorded, deliberate)
//!
//! The authority vocabulary has no "handler failed" code, and it must not grow a
//! seventh (`regression.md` R-8.2). A handler body that fails after every
//! authority gate passed is therefore reported as `scope_denied` with the body's
//! own message in `detail` — the same accepted-imprecision pattern the frozen
//! installer vocabulary already uses for `io_error`. The gate decisions
//! themselves are exact.

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

use super::authority::{
    classify_window_label, read_authority_grants, AuthorityGrants, CallerScope, CallerTier,
    CapabilityId, CapabilityRefusal, CapabilityRefusalCode, DETAIL_ACTION_NOT_DECLARED,
    DETAIL_ACTION_NOT_GRANTABLE, DETAIL_APP_NOT_INSTALLED, DETAIL_CALLER_UNKNOWN,
    DETAIL_CONSENT_REQUIRED,
};
use super::manifest::RESERVED_APP_IDS;
use super::scope::{resolve_data_scope, ScopeDecision};
use super::store;
use crate::infrastructure::application_data::commands::{
    self as application_data, ApplicationDataDeclareArgs, ApplicationDataDeleteArgs,
    ApplicationDataReadArgs, ApplicationDataState, ApplicationDataWriteArgs,
};

/// The wire request: the action name and exactly the payload the corresponding
/// command accepts today.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAppCallRequest {
    pub action: String,
    /// The action's ordinary arguments. Omitted ⇒ `null` (an action that takes
    /// none, e.g. `pg_database_reset`).
    #[serde(default)]
    pub args: Value,
}

/// The ordered action → capability table.
///
/// The ORDER is the contract (`functional.md` F-7.3 asserts it as an ordered
/// exact set, so a same-set reorder reddens). Every action here is a real
/// `COMMAND_MANIFEST` entry — an action absent from the manifest would be
/// forwarded to a command nothing grants.
///
/// Deliberately ABSENT, and pinned absent by a test: `installed_app_*` (an
/// installed app may never install, open, close or consent for itself),
/// `application_store_*` (the legacy store surface takes a caller-supplied id),
/// `subscribe_events`, `application_data_watch`/`unwatch`, `open_app_window`,
/// `close_app_window`.
pub const DISPATCH_TABLE: &[(&str, CapabilityId)] = &[
    ("application_data_read", CapabilityId::DataTables),
    ("application_data_write", CapabilityId::DataTables),
    ("application_data_delete", CapabilityId::DataTables),
    ("application_data_declare", CapabilityId::DataTables),
    ("db_query_execute", CapabilityId::HighRiskDatabaseQuery),
    ("db_result_page", CapabilityId::HighRiskDatabaseQuery),
    ("pg_database_reset", CapabilityId::HighRiskDatabaseReset),
    ("spawn_terminal_session", CapabilityId::HighRiskProcessSpawn),
];

/// The authority inputs one call is decided from. Everything here is re-read per
/// call — nothing survives a window open, a subscribe or a previous call.
#[derive(Debug, Default, Clone)]
pub struct AuthorityInputs {
    pub grants: AuthorityGrants,
    /// The tables the caller's package declared (from `feature_data_tables`).
    pub declared_tables: Vec<String>,
    /// `RESERVED_APP_IDS` ∪ installed ids ∪ ids present in `feature_data_tables`.
    pub known_app_ids: Vec<String>,
    /// `feature_data_tables` as `(feature_id, table_name)`.
    pub owned_tables: Vec<(String, String)>,
}

/// What a validated call will do — produced by the pure planner, consumed by the
/// thin executor below.
#[derive(Debug)]
enum PlannedCall {
    DataRead(ApplicationDataReadArgs),
    DataWrite(ApplicationDataWriteArgs),
    DataDelete(ApplicationDataDeleteArgs),
    DataDeclare(ApplicationDataDeclareArgs),
    HighRisk { action: &'static str },
}

/// The action's table row, if the action is dispatchable at all.
fn dispatch_row(action: &str) -> Option<(&'static str, CapabilityId)> {
    DISPATCH_TABLE
        .iter()
        .find(|(name, _)| *name == action)
        .copied()
}

// ── Pure planner ────────────────────────────────────────────────────────────

fn refusal(
    code: CapabilityRefusalCode,
    app_id: &str,
    action: &str,
    detail: &'static str,
) -> CapabilityRefusal {
    CapabilityRefusal::new(code, app_id, action, detail)
}

fn scope_refusal(app_id: &str, action: &str) -> CapabilityRefusal {
    refusal(
        CapabilityRefusalCode::ScopeDenied,
        app_id,
        action,
        super::scope::SCOPE_DENIED_DETAIL,
    )
}

/// Decide what `caller`'s request means, without touching the database.
///
/// Pure: identity in, a plan or a refusal out. Every branch below is unit-tested
/// against the inputs the QA rows drive (canonical source, foreign id,
/// undeclared table, the composed-name collision and the same-app allow).
fn plan_call(
    caller: &CallerScope,
    request: &InstalledAppCallRequest,
    inputs: &AuthorityInputs,
) -> Result<PlannedCall, CapabilityRefusal> {
    let app_id = match (caller.tier, caller.app_id.as_deref()) {
        (CallerTier::Installed, Some(id)) => id,
        // A built-in window has no installed-application identity, so there is
        // nothing to scope a call to. Fail closed rather than invent one.
        _ => {
            return Err(refusal(
                CapabilityRefusalCode::CallerUnknown,
                &caller.window_label,
                &request.action,
                DETAIL_CALLER_UNKNOWN,
            ))
        }
    };

    let Some((action, capability)) = dispatch_row(&request.action) else {
        return Err(refusal(
            CapabilityRefusalCode::ActionNotGrantable,
            app_id,
            &request.action,
            DETAIL_ACTION_NOT_GRANTABLE,
        ));
    };

    match capability {
        CapabilityId::DataTables => plan_data_call(app_id, action, &request.args, inputs),
        capability => {
            if !inputs.grants.declares(capability) {
                return Err(refusal(
                    CapabilityRefusalCode::ActionNotDeclared,
                    app_id,
                    action,
                    DETAIL_ACTION_NOT_DECLARED,
                )
                .with_capability(capability));
            }
            if capability.is_high_risk() && !inputs.grants.has_consent(capability) {
                return Err(refusal(
                    CapabilityRefusalCode::ConsentRequired,
                    app_id,
                    action,
                    DETAIL_CONSENT_REQUIRED,
                )
                .with_capability(capability));
            }
            Ok(PlannedCall::HighRisk { action })
        }
    }
}

/// The `data.tables` capability's four actions.
///
/// Clause order is load-bearing:
///
/// * the REF SHAPE (including the canonical-source door) is decided first, so a
///   canonical read is `scope_denied` and never `action_not_declared`;
/// * the DECLARATION gate follows, so a package with no `capabilities` is
///   `action_not_declared` for every data action (NFR fail-safe);
/// * the ownership/declaration/collision resolver runs last.
fn plan_data_call(
    app_id: &str,
    action: &'static str,
    args: &Value,
    inputs: &AuthorityInputs,
) -> Result<PlannedCall, CapabilityRefusal> {
    match action {
        "application_data_read" => {
            let mut value = args.clone();
            let (requested, table) = prepare_application_ref(&mut value, app_id, action, true)?;
            require_capability(app_id, action, inputs)?;
            ensure_scope(app_id, &requested, &table, inputs, action)?;
            let typed = from_args(value, app_id, action)?;
            Ok(PlannedCall::DataRead(typed))
        }
        "application_data_write" => {
            let mut value = args.clone();
            let (requested, table) = prepare_application_ref(&mut value, app_id, action, false)?;
            require_capability(app_id, action, inputs)?;
            ensure_scope(app_id, &requested, &table, inputs, action)?;
            let typed = from_args(value, app_id, action)?;
            Ok(PlannedCall::DataWrite(typed))
        }
        "application_data_delete" => {
            let mut value = args.clone();
            let (requested, table) = prepare_application_ref(&mut value, app_id, action, false)?;
            require_capability(app_id, action, inputs)?;
            ensure_scope(app_id, &requested, &table, inputs, action)?;
            let typed = from_args(value, app_id, action)?;
            Ok(PlannedCall::DataDelete(typed))
        }
        "application_data_declare" => plan_declare(app_id, action, args, inputs),
        other => Err(refusal(
            CapabilityRefusalCode::ActionNotGrantable,
            app_id,
            other,
            DETAIL_ACTION_NOT_GRANTABLE,
        )),
    }
}

/// The `data.tables` declaration gate.
fn require_capability(
    app_id: &str,
    action: &str,
    inputs: &AuthorityInputs,
) -> Result<(), CapabilityRefusal> {
    if inputs.grants.declares(CapabilityId::DataTables) {
        return Ok(());
    }
    Err(refusal(
        CapabilityRefusalCode::ActionNotDeclared,
        app_id,
        action,
        DETAIL_ACTION_NOT_DECLARED,
    )
    .with_capability(CapabilityId::DataTables))
}

/// Validate one `ref`-carrying payload, derive the requested identity, and
/// REWRITE `ref.applicationId` to the derived id.
///
/// Returns `(requested_app_id, table)`. The requested id is what the caller
/// asked for (or the derived id when it asked for nothing); it is never trusted
/// and never survives into the handler body.
fn prepare_application_ref(
    value: &mut Value,
    app_id: &str,
    action: &str,
    require_source: bool,
) -> Result<(String, String), CapabilityRefusal> {
    let Some(object) = value.as_object_mut() else {
        return Err(scope_refusal(app_id, action));
    };
    let Some(reference) = object.get_mut("ref").and_then(Value::as_object_mut) else {
        return Err(scope_refusal(app_id, action));
    };

    match reference.get("source") {
        Some(Value::String(source)) if source == "application" => {}
        // `source: "canonical"` is the SECOND DOOR at runtime: a canonical read
        // would expose the user's own agent sessions. Any other value is noise.
        Some(_) => return Err(scope_refusal(app_id, action)),
        None if !require_source => {}
        None => return Err(scope_refusal(app_id, action)),
    }

    let Some(table) = reference
        .get("table")
        .and_then(Value::as_str)
        .filter(|table| !table.is_empty())
        .map(str::to_string)
    else {
        return Err(scope_refusal(app_id, action));
    };

    let requested = match reference.get("applicationId") {
        None | Some(Value::Null) => app_id.to_string(),
        Some(Value::String(id)) => id.clone(),
        Some(_) => return Err(scope_refusal(app_id, action)),
    };

    // The identity the handler body sees is ALWAYS the derived one.
    reference.insert(
        "applicationId".to_string(),
        Value::String(app_id.to_string()),
    );
    Ok((requested, table))
}

/// The ownership / declaration / composed-name decision.
fn ensure_scope(
    app_id: &str,
    requested: &str,
    table: &str,
    inputs: &AuthorityInputs,
    action: &str,
) -> Result<(), CapabilityRefusal> {
    match resolve_data_scope(
        app_id,
        requested,
        table,
        &inputs.declared_tables,
        &inputs.known_app_ids,
        &inputs.owned_tables,
    ) {
        ScopeDecision::Allow => Ok(()),
        ScopeDecision::Deny(detail) => Err(CapabilityRefusal::new(
            CapabilityRefusalCode::ScopeDenied,
            app_id,
            action,
            detail,
        )),
    }
}

/// `application_data_declare`: identity-rewrite and scope-check EVERY declaration.
///
/// A declaration is a write path too: it creates a table and (with a `source`
/// projection) can make the host read CANONICAL tables into it. A `source` key is
/// therefore refused here as well as at install (R-3.3's two locks, one door).
fn plan_declare(
    app_id: &str,
    action: &'static str,
    args: &Value,
    inputs: &AuthorityInputs,
) -> Result<PlannedCall, CapabilityRefusal> {
    let mut value = args.clone();
    let Some(object) = value.as_object_mut() else {
        return Err(scope_refusal(app_id, action));
    };
    let Some(declarations) = object.get_mut("declarations").and_then(Value::as_array_mut) else {
        return Err(scope_refusal(app_id, action));
    };

    // Validate the ref shape of every declaration before the capability gate, so
    // the canonical/source door is closed for callers that declared nothing too.
    for declaration in declarations.iter_mut() {
        let Some(declaration) = declaration.as_object_mut() else {
            return Err(scope_refusal(app_id, action));
        };
        let requested = match declaration.get("applicationId") {
            None | Some(Value::Null) => app_id.to_string(),
            Some(Value::String(id)) => id.clone(),
            Some(_) => return Err(scope_refusal(app_id, action)),
        };
        declaration.insert(
            "applicationId".to_string(),
            Value::String(app_id.to_string()),
        );
        let Some(tables) = declaration.get("tables").and_then(Value::as_array) else {
            return Err(scope_refusal(app_id, action));
        };
        for table in tables {
            // The SECOND DOOR: a declared table carrying a `source` projection
            // reads the user's own chat/session tables. Refused at runtime as well
            // as at install — two doors, two locks.
            if table.get("source").is_some() {
                return Err(scope_refusal(app_id, action));
            }
            let Some(name) = table.get("name").and_then(Value::as_str) else {
                return Err(scope_refusal(app_id, action));
            };
            ensure_scope_pair(app_id, &requested, name, inputs, action)?;
        }
    }

    require_capability(app_id, action, inputs)?;
    let typed = from_args(value, app_id, action)?;
    Ok(PlannedCall::DataDeclare(typed))
}

/// `ensure_scope` without the action string dance, for the declaration loop.
fn ensure_scope_pair(
    app_id: &str,
    requested: &str,
    table: &str,
    inputs: &AuthorityInputs,
    action: &str,
) -> Result<(), CapabilityRefusal> {
    ensure_scope(app_id, requested, table, inputs, action)
}

fn from_args<T: for<'de> Deserialize<'de>>(
    value: Value,
    app_id: &str,
    action: &str,
) -> Result<T, CapabilityRefusal> {
    serde_json::from_value(value).map_err(|error| {
        // The detail is the caller's own request being unreadable — no other
        // application, table or count can appear here.
        CapabilityRefusal::new(
            CapabilityRefusalCode::ScopeDenied,
            app_id,
            action,
            format!("the request could not be read as a {action} call: {error}"),
        )
    })
}

// ── Executor ────────────────────────────────────────────────────────────────

fn traced(refusal: CapabilityRefusal) -> CapabilityRefusal {
    refusal.trace();
    refusal
}

/// A handler body that failed AFTER every authority gate passed.
///
/// The authority vocabulary is closed at six and must not grow a seventh code
/// (`regression.md` R-8.2), so the body's own message is carried in `detail`
/// under `scope_denied` — the same accepted imprecision the frozen installer
/// vocabulary uses for `io_error`.
fn body_failure(app_id: &str, action: &str, detail: String) -> CapabilityRefusal {
    CapabilityRefusal::new(
        CapabilityRefusalCode::ScopeDenied,
        app_id,
        action,
        detail,
    )
}

fn to_wire<T: Serialize>(
    result: Result<T, Vec<String>>,
    app_id: &str,
    action: &str,
) -> Result<Value, CapabilityRefusal> {
    match result {
        Ok(value) => serde_json::to_value(value)
            .map_err(|error| body_failure(app_id, action, error.to_string())),
        Err(errors) => Err(body_failure(app_id, action, errors.join("; "))),
    }
}

/// Read the tables + ids + grants one call is decided from.
///
/// Every source is re-read HERE, per call: the declaration metadata table, the
/// install root's directory listing, and (via
/// [`super::authority::read_authority_grants`]) the package's declarations and
/// the user's consent. A metadata read failure empties the declaration set, which
/// can only produce a FALSE REFUSAL — never a false permit.
fn load_authority_inputs(state: &ApplicationDataState, app_id: &str) -> AuthorityInputs {
    let mut declared_tables = Vec::new();
    let mut owned_tables = Vec::new();
    let mut registry_ids = Vec::new();

    if let Ok(persisted) = state.registry.persisted_tables() {
        for table in persisted {
            if !registry_ids.iter().any(|id| id == &table.feature_id) {
                registry_ids.push(table.feature_id.clone());
            }
            if table.feature_id == app_id {
                declared_tables.push(table.table_name.clone());
            }
            owned_tables.push((table.feature_id, table.table_name));
        }
    }

    let mut known_app_ids: Vec<String> = RESERVED_APP_IDS
        .iter()
        .map(|id| (*id).to_string())
        .collect();
    for id in registry_ids {
        if !known_app_ids.contains(&id) {
            known_app_ids.push(id);
        }
    }
    for id in installed_app_ids(&store::install_root(&state.data_dir)) {
        if !known_app_ids.contains(&id) {
            known_app_ids.push(id);
        }
    }

    AuthorityInputs {
        grants: read_authority_grants(&state.data_dir, app_id),
        declared_tables,
        known_app_ids,
        owned_tables,
    }
}

/// The installed ids, from the install root's directory listing (cheap; the
/// records themselves are NOT read).
fn installed_app_ids(root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    for entry in entries.flatten() {
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            if let Some(name) = entry.file_name().to_str() {
                ids.push(name.to_string());
            }
        }
    }
    ids
}

/// The installed tier's ONE command.
///
/// The caller's identity is the IPC webview's own window label — `webview` is a
/// [`tauri::Webview`] command argument (`CommandArg for Webview`), never a field
/// of [`InstalledAppCallRequest`], so no document can claim another identity.
#[tauri::command]
pub async fn installed_app_invoke(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    request: InstalledAppCallRequest,
) -> Result<Value, CapabilityRefusal> {
    let label = webview.label().to_string();
    let caller = classify_window_label(&label).map_err(|code| {
        traced(CapabilityRefusal::new(
            code,
            &label,
            &request.action,
            DETAIL_CALLER_UNKNOWN,
        ))
    })?;

    let Some(app_id) = caller.app_id.clone() else {
        return Err(traced(CapabilityRefusal::new(
            CapabilityRefusalCode::CallerUnknown,
            &label,
            &request.action,
            DETAIL_CALLER_UNKNOWN,
        )));
    };

    let Some(state) = app.try_state::<Arc<ApplicationDataState>>() else {
        return Err(traced(refusal(
            CapabilityRefusalCode::AppNotInstalled,
            &app_id,
            &request.action,
            DETAIL_APP_NOT_INSTALLED,
        )));
    };
    let install_root = store::install_root(&state.data_dir);
    if !store::app_dir(&install_root, &app_id).is_dir() {
        return Err(traced(refusal(
            CapabilityRefusalCode::AppNotInstalled,
            &app_id,
            &request.action,
            DETAIL_APP_NOT_INSTALLED,
        )));
    }

    let inputs = load_authority_inputs(state.inner(), &app_id);
    let planned = plan_call(&caller, &request, &inputs).map_err(traced)?;
    let action = request.action.clone();

    match planned {
        PlannedCall::DataRead(args) => {
            let result = application_data::read(state.inner(), args).await;
            to_wire(result, &app_id, &action)
        }
        PlannedCall::DataWrite(args) => {
            let result = application_data::write(state.inner(), args);
            to_wire(result, &app_id, &action)
        }
        PlannedCall::DataDelete(args) => {
            let result = application_data::delete(state.inner(), args);
            to_wire(result, &app_id, &action)
        }
        PlannedCall::DataDeclare(args) => {
            let result = application_data::declare(state.inner(), args);
            to_wire(result, &app_id, &action)
        }
        PlannedCall::HighRisk { action } => {
            forward_high_risk(&app, &app_id, action, &request.args).await
        }
    }
}

// ── High-risk forwarding (the SAME handler bodies the built-ins reach) ──────

/// Forward one consented high-risk action to the shipped handler body.
///
/// The gate above has already established declaration + consent, so this function
/// performs NO authority decision of its own — it only adapts the wire `args`
/// into the command's own argument type and runs the same body a built-in
/// window's call reaches (R-1.1).
async fn forward_high_risk(
    app: &tauri::AppHandle,
    app_id: &str,
    action: &'static str,
    args: &Value,
) -> Result<Value, CapabilityRefusal> {
    match action {
        "db_query_execute" => {
            let typed: crate::applications::db_client::types::DbQueryArgs =
                serde_json::from_value(args.clone()).map_err(|error| {
                    body_failure(app_id, action, format!("the request could not be read: {error}"))
                })?;
            let state = app.state::<Arc<crate::applications::db_client::state::DbClientState>>();
            let outcome = crate::applications::db_client::query::query_execute(typed, state.inner())
                .await
                .map_err(|errors| body_failure(app_id, action, errors.join("; ")))?;
            serde_json::to_value(outcome)
                .map_err(|error| body_failure(app_id, action, error.to_string()))
        }
        "db_result_page" => {
            let typed: crate::applications::db_client::types::DbResultPageArgs =
                serde_json::from_value(args.clone()).map_err(|error| {
                    body_failure(app_id, action, format!("the request could not be read: {error}"))
                })?;
            let state = app.state::<Arc<crate::applications::db_client::state::DbClientState>>();
            let page = crate::applications::db_client::query::result_page(typed, state.inner())
                .await
                .map_err(|errors| body_failure(app_id, action, errors.join("; ")))?;
            serde_json::to_value(page)
                .map_err(|error| body_failure(app_id, action, error.to_string()))
        }
        "pg_database_reset" => {
            let result = crate::applications::pg_supervisor::state::pg_database_reset(app.clone())
                .await;
            serde_json::to_value(result)
                .map_err(|error| body_failure(app_id, action, error.to_string()))
        }
        "spawn_terminal_session" => {
            // `testOverride` (a debug-only argument on the shipped command) is
            // deliberately NOT part of this adapter: an installed application can
            // never name the executable a PTY is pointed at.
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct SpawnArgs {
                cli: String,
                #[serde(default)]
                work_dir: Option<String>,
                #[serde(default)]
                cols: Option<u16>,
                #[serde(default)]
                rows: Option<u16>,
            }
            let typed: SpawnArgs = serde_json::from_value(args.clone()).map_err(|error| {
                body_failure(app_id, action, format!("the request could not be read: {error}"))
            })?;
            let state = app.state::<Mutex<crate::applications::terminal::state::TerminalState>>();
            #[cfg(debug_assertions)]
            let spawned = crate::applications::terminal::commands::spawn_terminal_session(
                typed.cli,
                typed.work_dir,
                typed.cols,
                typed.rows,
                None,
                app.clone(),
                state,
            )
            .await;
            #[cfg(not(debug_assertions))]
            let spawned = crate::applications::terminal::commands::spawn_terminal_session(
                typed.cli,
                typed.work_dir,
                typed.cols,
                typed.rows,
                app.clone(),
                state,
            )
            .await;
            spawned
                .map(Value::String)
                .map_err(|error| body_failure(app_id, action, error))
        }
        other => Err(refusal(
            CapabilityRefusalCode::ActionNotGrantable,
            app_id,
            other,
            DETAIL_ACTION_NOT_GRANTABLE,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn installed_caller(id: &str) -> CallerScope {
        CallerScope {
            tier: CallerTier::Installed,
            window_label: format!("installed-{id}"),
            app_id: Some(id.to_string()),
        }
    }

    fn request(action: &str, args: Value) -> InstalledAppCallRequest {
        InstalledAppCallRequest {
            action: action.to_string(),
            args,
        }
    }

    fn inputs_with_data_tables(app_id: &str, tables: &[&str], known: &[&str]) -> AuthorityInputs {
        AuthorityInputs {
            grants: AuthorityGrants {
                declared: vec![CapabilityId::DataTables],
                consented: vec![],
            },
            declared_tables: tables.iter().map(|t| (*t).to_string()).collect(),
            known_app_ids: {
                let mut ids: Vec<String> =
                    RESERVED_APP_IDS.iter().map(|id| (*id).to_string()).collect();
                ids.push(app_id.to_string());
                for id in known {
                    if !ids.iter().any(|known| known == id) {
                        ids.push((*id).to_string());
                    }
                }
                ids
            },
            owned_tables: vec![],
        }
    }

    /// F-7.3 — the dispatch table is an ORDERED exact set, every action is a real
    /// manifest command, and nothing dangerous is in it.
    #[test]
    fn the_dispatch_table_is_an_ordered_exact_set() {
        assert_eq!(
            DISPATCH_TABLE
                .iter()
                .map(|(action, capability)| (*action, capability.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("application_data_read", "data.tables"),
                ("application_data_write", "data.tables"),
                ("application_data_delete", "data.tables"),
                ("application_data_declare", "data.tables"),
                ("db_query_execute", "high-risk.database-query"),
                ("db_result_page", "high-risk.database-query"),
                ("pg_database_reset", "high-risk.database-reset"),
                ("spawn_terminal_session", "high-risk.process-spawn"),
            ],
            "ordered exact set: a same-set reorder must redden"
        );

        for (action, _) in DISPATCH_TABLE {
            assert!(
                crate::runtime::command_manifest::COMMAND_MANIFEST.contains(action),
                "{action} is dispatched but is not a COMMAND_MANIFEST entry"
            );
        }

        for banned in [
            "installed_app_install",
            "installed_apps_list",
            "installed_app_open",
            "installed_app_close",
            "installed_apps_push_theme",
            "installed_app_invoke",
            "installed_app_consent_grant",
            "installed_app_consent_revoke",
            "application_store_ensure_table",
            "application_store_insert",
            "application_store_query",
            "application_store_update",
            "application_store_delete",
            "subscribe_events",
            "application_data_watch",
            "application_data_unwatch",
            "open_app_window",
            "close_app_window",
            "open_terminal_window",
            "save_control_setting",
        ] {
            assert!(
                !DISPATCH_TABLE.iter().any(|(name, _)| *name == banned),
                "{banned} must never be dispatchable for an installed application"
            );
        }

        // Every capability id the table uses is in the closed vocabulary, and each
        // of the four is reached by at least one action.
        for capability in CapabilityId::ALL {
            assert!(
                DISPATCH_TABLE.iter().any(|(_, used)| *used == capability),
                "{capability:?} has no dispatchable action"
            );
        }
    }

    /// F-7.9 — an action outside the vocabulary is `action_not_grantable` and is
    /// never forwarded, before any declaration or scope work.
    #[test]
    fn actions_outside_the_vocabulary_are_not_grantable() {
        let caller = installed_caller("qa3146-app-a");
        let inputs = inputs_with_data_tables("qa3146-app-a", &["notes"], &[]);
        for action in [
            "save_control_setting",
            "installed_apps_list",
            "installed_app_consent_grant",
            "installed_app_install",
            "application_store_query",
            "subscribe_events",
            "application_data_watch",
            "open_app_window",
        ] {
            let refusal = plan_call(&caller, &request(action, json!({})), &inputs)
                .expect_err("must be refused");
            assert_eq!(refusal.code, CapabilityRefusalCode::ActionNotGrantable);
            assert_eq!(refusal.app_id, "qa3146-app-a");
            assert_eq!(refusal.action, action);
            assert!(refusal.capability.is_none(), "this code names no capability");
            assert!(!refusal.detail.is_empty(), "a detail is always present");
        }
    }

    /// F-7.26 — no declaration means NO reach, and the code is
    /// `action_not_declared` (never `scope_denied`).
    #[test]
    fn an_undeclared_capability_is_action_not_declared() {
        let caller = installed_caller("qa3146-no-capabilities");
        let inputs = AuthorityInputs::default();
        let refusal = plan_call(
            &caller,
            &request(
                "application_data_read",
                json!({"ref": {"source": "application", "table": "notes"}}),
            ),
            &inputs,
        )
        .expect_err("must be refused");
        assert_eq!(refusal.code, CapabilityRefusalCode::ActionNotDeclared);
        assert_eq!(refusal.capability.as_deref(), Some("data.tables"));

        let refusal = plan_call(
            &caller,
            &request("pg_database_reset", json!({})),
            &inputs,
        )
        .expect_err("must be refused");
        assert_eq!(refusal.code, CapabilityRefusalCode::ActionNotDeclared);
        assert_eq!(refusal.capability.as_deref(), Some("high-risk.database-reset"));
    }

    /// F-7.6 — the identity is injected: a `ref` with no `applicationId` resolves
    /// as the caller, and the handler body sees the DERIVED id.
    #[test]
    fn the_derived_identity_is_injected_into_the_ref() {
        let caller = installed_caller("qa3146-app-a");
        let inputs = inputs_with_data_tables("qa3146-app-a", &["notes"], &[]);
        let planned = plan_call(
            &caller,
            &request(
                "application_data_read",
                json!({"ref": {"source": "application", "table": "notes"}, "where": [], "limit": 10}),
            ),
            &inputs,
        )
        .expect("an own declared table resolves");
        match planned {
            PlannedCall::DataRead(args) => match args.r#ref {
                crate::infrastructure::application_data::commands::DataTableRef::Application {
                    feature_id,
                    table,
                } => {
                    assert_eq!(feature_id, "qa3146-app-a", "the derived id is injected");
                    assert_eq!(table, "notes");
                }
                other => panic!("expected an application ref, got {other:?}"),
            },
            other => panic!("expected a data read, got {other:?}"),
        }
    }

    /// F-7.13 / F-7.24 — naming another application (or a ghost) is
    /// `scope_denied`, and the refusal's `appId` is ALWAYS the derived one.
    #[test]
    fn another_identity_is_scope_denied_with_the_derived_app_id() {
        let caller = installed_caller("qa3146-app-a");
        let inputs = inputs_with_data_tables("qa3146-app-a", &["notes"], &["qa3146-app-b"]);
        for requested in ["qa3146-app-b", "qa3146-ghost"] {
            let refusal = plan_call(
                &caller,
                &request(
                    "application_data_read",
                    json!({"ref": {"source": "application", "applicationId": requested, "table": "records"}}),
                ),
                &inputs,
            )
            .expect_err("must be refused");
            assert_eq!(refusal.code, CapabilityRefusalCode::ScopeDenied);
            assert_eq!(refusal.app_id, "qa3146-app-a", "never the requested id");
            assert_eq!(
                refusal.detail,
                crate::applications::installed_apps::scope::SCOPE_DENIED_DETAIL
            );
            assert!(!refusal.detail.contains(requested), "no foreign id in the detail");
        }
    }

    /// F-7.14 — the SECOND DOOR at runtime: a canonical ref is `scope_denied`
    /// (not `action_not_declared`), on every data action.
    #[test]
    fn a_canonical_source_is_refused_at_runtime() {
        let caller = installed_caller("qa3146-app-a");
        let inputs = inputs_with_data_tables("qa3146-app-a", &["notes"], &[]);
        for canonical in ["chat", "agentSession", "toolUse"] {
            let refusal = plan_call(
                &caller,
                &request(
                    "application_data_read",
                    json!({"ref": {"source": "canonical", "table": canonical}}),
                ),
                &inputs,
            )
            .expect_err("a canonical read must be refused");
            assert_eq!(refusal.code, CapabilityRefusalCode::ScopeDenied);
            assert_eq!(refusal.action, "application_data_read");
        }
        // ... even for a package that declared NO capability: the source door is
        // closed before the declaration gate.
        let refusal = plan_call(
            &caller,
            &request(
                "application_data_read",
                json!({"ref": {"source": "canonical", "table": "chat"}}),
            ),
            &AuthorityInputs::default(),
        )
        .expect_err("must be refused");
        assert_eq!(refusal.code, CapabilityRefusalCode::ScopeDenied);

        // A write/delete ref may omit `source`, but a canonical one is still out.
        let refusal = plan_call(
            &caller,
            &request(
                "application_data_write",
                json!({"ref": {"source": "canonical", "table": "chat"}, "key": ["k"], "set": {}}),
            ),
            &inputs,
        )
        .expect_err("must be refused");
        assert_eq!(refusal.code, CapabilityRefusalCode::ScopeDenied);
    }

    /// F-7.11 / F-7.12 — the named and the constructed composition collisions are
    /// both refused through the DECLARED table, with the same-app discriminator.
    #[test]
    fn composition_collisions_are_refused_through_a_declared_table() {
        // The named collision: `mission` + `monitor_sessions`.
        let caller = installed_caller("mission");
        let inputs = inputs_with_data_tables("mission", &["monitor_sessions"], &[]);
        let refusal = plan_call(
            &caller,
            &request(
                "application_data_read",
                json!({"ref": {"source": "application", "applicationId": "mission", "table": "monitor_sessions"}}),
            ),
            &inputs,
        )
        .expect_err("the composed name must be refused");
        assert_eq!(refusal.code, CapabilityRefusalCode::ScopeDenied);

        // The installed-vs-installed collision, with its same-app discriminator.
        let caller = installed_caller("orbit");
        let inputs = inputs_with_data_tables("orbit", &["lab_notes", "orbit_own"], &["orbit-lab"]);
        let refusal = plan_call(
            &caller,
            &request(
                "application_data_read",
                json!({"ref": {"source": "application", "table": "lab_notes"}}),
            ),
            &inputs,
        )
        .expect_err("orbit+lab_notes collides with orbit-lab+notes");
        assert_eq!(refusal.code, CapabilityRefusalCode::ScopeDenied);

        plan_call(
            &caller,
            &request(
                "application_data_read",
                json!({"ref": {"source": "application", "table": "orbit_own"}}),
            ),
            &inputs,
        )
        .expect("the same-app table must resolve in the same decision set");
    }

    /// R-3.3 — the SECOND DOOR through a DECLARATION: a table carrying a `source`
    /// projection is refused at runtime, before anything is materialized.
    #[test]
    fn a_declaration_carrying_a_source_projection_is_refused_at_runtime() {
        let caller = installed_caller("qa3146-app-a");
        let inputs = inputs_with_data_tables("qa3146-app-a", &["notes"], &[]);
        let refusal = plan_call(
            &caller,
            &request(
                "application_data_declare",
                json!({"declarations": [{
                    "applicationId": "qa3146-app-a",
                    "declarationRevision": "r1",
                    "tables": [{
                        "name": "notes",
                        "primaryKey": ["id"],
                        "columns": [{"name": "id", "type": "text", "nullable": false, "owner": "application"}],
                        "source": {"kind": "row", "table": "chat", "select": []}
                    }]
                }]}),
            ),
            &inputs,
        )
        .expect_err("a declared table with a source projection is refused");
        assert_eq!(refusal.code, CapabilityRefusalCode::ScopeDenied);
        assert_eq!(refusal.action, "application_data_declare");

        // ... and a declaration of ANOTHER application's id is refused too.
        let refusal = plan_call(
            &caller,
            &request(
                "application_data_declare",
                json!({"declarations": [{
                    "applicationId": "qa3146-app-b",
                    "declarationRevision": "r1",
                    "tables": [{"name": "notes", "primaryKey": ["id"], "columns": []}]
                }]}),
            ),
            &inputs,
        )
        .expect_err("another application's id is refused");
        assert_eq!(refusal.code, CapabilityRefusalCode::ScopeDenied);
        assert_eq!(refusal.app_id, "qa3146-app-a");
    }

    /// F-7.17 / F-7.20 — a declared-but-unconsented high-risk action is
    /// `consent_required`, and a consent for one capability does not enable a
    /// second one.
    #[test]
    fn high_risk_actions_are_gated_per_capability() {
        let caller = installed_caller("qa3146-consent-a");
        let mut inputs = AuthorityInputs {
            grants: AuthorityGrants {
                declared: vec![
                    CapabilityId::HighRiskDatabaseQuery,
                    CapabilityId::HighRiskDatabaseReset,
                ],
                consented: vec![CapabilityId::HighRiskDatabaseQuery],
            },
            ..AuthorityInputs::default()
        };

        // Consented: the gate lifts and the call reaches the handler.
        let planned = plan_call(
            &caller,
            &request("db_query_execute", json!({})),
            &inputs,
        )
        .expect("a consented capability passes the gate");
        assert!(matches!(
            planned,
            PlannedCall::HighRisk {
                action: "db_query_execute"
            }
        ));

        // Declared but NOT consented: refused, and the capability is named.
        let refusal = plan_call(&caller, &request("pg_database_reset", json!({})), &inputs)
            .expect_err("a declared-but-unconsented capability is refused");
        assert_eq!(refusal.code, CapabilityRefusalCode::ConsentRequired);
        assert_eq!(
            refusal.capability.as_deref(),
            Some("high-risk.database-reset")
        );
        assert!(refusal.detail.contains("Settings > Installed applications"));

        // Revoking the one grant re-imposes the gate on the query leg only.
        inputs.grants.consented.clear();
        let refusal = plan_call(&caller, &request("db_query_execute", json!({})), &inputs)
            .expect_err("a revoked capability is refused");
        assert_eq!(refusal.code, CapabilityRefusalCode::ConsentRequired);
        assert_eq!(
            refusal.capability.as_deref(),
            Some("high-risk.database-query")
        );
    }

    /// A built-in window has no installed identity: the command refuses it rather
    /// than inventing a scope (fail closed).
    #[test]
    fn a_built_in_caller_is_caller_unknown() {
        let caller = CallerScope {
            tier: CallerTier::BuiltIn,
            window_label: "main".to_string(),
            app_id: None,
        };
        let refusal = plan_call(
            &caller,
            &request("application_data_read", json!({})),
            &AuthorityInputs::default(),
        )
        .expect_err("a built-in caller has no installed identity");
        assert_eq!(refusal.code, CapabilityRefusalCode::CallerUnknown);
        assert_eq!(refusal.app_id, "main");
    }
}
