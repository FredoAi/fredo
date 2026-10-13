//! Connection management + session lifecycle (Spec #2950, ST-2).
//!
//! Fills the ST-1 stubs so `db_connection_test`, `db_connection_save`,
//! `db_connection_list`, `db_connection_delete`, `db_connect` and
//! `db_disconnect` are real:
//!
//! * a **bounded** (10 s) probe/session open with typed failures — R-1.3/R-1.8;
//! * secret-free metadata persistence + OS-keychain secret handling — R-1.5/
//!   R-1.6/R-1.7 (delete clears all four stores);
//! * read-only-by-default on create (R-5.1) and a faithful, non-downgrading
//!   `SslMode` → `PgSslMode` mapping (R-5.6);
//! * the G-275 `FREDO_DBCLIENT_FORCE_FAIL` connect/auth/timeout induction.
//!
//! # Persistence model
//!
//! The backend owns a secret-free **connection store** under the G-275 state dir
//! ([`DbClientState::state_dir`]): `Fredo_dbclient_connections.json`, plus the
//! per-connection `Fredo_dbclient_history_<id>.json` and
//! `Fredo_dbclient_saved_queries_<id>.json` documents. The password lives only
//! in the OS keychain ([`credentials`]). The store is a document store keyed by
//! the frozen persistence keys, written atomically (temp + rename) and read
//! tolerantly (absent/corrupt → empty). This is the backend's authoritative
//! connection metadata; the frontend `settingsService` documents carry the same
//! key names for the UI-side history/saved/prefs reads.
//!
//! # Non-goals (ST-2)
//!
//! No schema or query logic; no password ever enters a returned view
//! (`has_password` only), the metadata documents, tracing, or an error message
//! (messages are sanitized against the submitted password).
//!
//! # Built-in "Fredo" connection (Spec #3029, ST-2)
//!
//! On a fresh profile (the connection-store document does NOT exist) the list /
//! save / connect entry points seed ONE built-in connection
//! ([`builtin_connection_view`]) to Fredo's own embedded cluster via
//! [`ensure_builtin_seeded`]. It persists a `port=0` sentinel and no secret; its
//! endpoint + loopback password are resolved at connect time from the
//! [`crate::infrastructure::storage::embedded_pg::EmbeddedPgEndpointProvider`]
//! (no cross-application import). Saving it makes it an ordinary connection
//! (`builtin=false`); deletion is permanent (the store document exists, so it is
//! never re-seeded).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Serialize;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "credentials.rs"]
pub mod credentials;

#[cfg(test)]
#[path = "tests_connect.rs"]
mod tests_connect;

#[cfg(test)]
#[path = "tests_builtin.rs"]
mod tests_builtin;

#[cfg(test)]
#[path = "tests_credentials.rs"]
mod tests_credentials;

use credentials::{CredentialStore, KeyringCredentialStore};

use crate::infrastructure::storage::embedded_pg::EmbeddedPgEndpointProvider;

use super::seam::{self, ForceFailStage};
use super::state::DbClientState;
use super::types::{
    history_key, saved_queries_key, AccessMode, DbConnectArgs, DbConnectionDeleteArgs,
    DbConnectionSaveArgs, DbConnectionTestArgs, DbConnectionView, DbEngineKind, DbErrorKind,
    DbQueryError, DbSessionInfo, DbTestResult, SslMode, DBCLIENT_CONNECTIONS_KEY,
};

/// Hard bound on every connect/probe attempt (R-1.3/R-1.8).
pub const CONNECT_BOUND: Duration = Duration::from_secs(10);

/// Maximum simultaneously open external pools (Spec #3028). Derived from the
/// shared connection-count policy so it can never drift from the server limit:
/// it stays strictly BELOW `PG_SERVER_MAX_CONNECTIONS` (leaving headroom), and
/// no longer equals it — the pre-#3028 literal `8` matched the server's
/// `max_connections = 8` and left no room for an additional client.
pub const MAX_OPEN_CONNECTIONS: usize =
    crate::infrastructure::storage::engine::PG_DBCLIENT_MAX_OPEN_CONNECTIONS as usize;

/// A newly created connection defaults to read-only (R-5.1). The mode is changed
/// only by an explicit later edit.
pub const DEFAULT_ACCESS_MODE: AccessMode = AccessMode::ReadOnly;

// ── Built-in "Fredo" connection (Spec #3029, ST-2) ────────────────────────────

/// The stable id of the seeded built-in connection to Fredo's own embedded
/// cluster (Spec #3029).
pub const DBCLIENT_BUILTIN_FREDO_ID: &str = "builtin-fredo";
/// The user-facing name of the seeded built-in connection (Spec #3029).
pub const DBCLIENT_BUILTIN_FREDO_NAME: &str = "Fredo";
/// The persisted port SENTINEL for the built-in connection: `0` means "resolve
/// the bound port from the live supervisor at connect time". It is NEVER
/// overwritten with the bound ephemeral port (EARS-6/EARS-7).
pub const DBCLIENT_BUILTIN_PORT_SENTINEL: u16 = 0;

/// The stable loopback host the built-in connection targets (loopback-only —
/// never `0.0.0.0`). Mirrors `pg_supervisor::DEFAULT_PG_HOST` without importing it.
const BUILTIN_HOST: &str = "127.0.0.1";
/// The bootstrap superuser role the built-in connection targets (Spec #3036).
const BUILTIN_USER: &str = "postgres";
/// The Fredo application database the built-in connection targets (Spec #3036).
const BUILTIN_DATABASE: &str = "fredo";

/// The seeded built-in connection view (Spec #3029). Never carries a secret; the
/// loopback password is resolved from the OS keychain at connect time only.
pub fn builtin_connection_view() -> DbConnectionView {
    DbConnectionView {
        id: DBCLIENT_BUILTIN_FREDO_ID.to_string(),
        name: DBCLIENT_BUILTIN_FREDO_NAME.to_string(),
        engine: DbEngineKind::Postgres,
        host: BUILTIN_HOST.to_string(),
        port: DBCLIENT_BUILTIN_PORT_SENTINEL,
        user: BUILTIN_USER.to_string(),
        database: BUILTIN_DATABASE.to_string(),
        // Loopback-only ⇒ no TLS.
        ssl_mode: SslMode::Disable,
        access_mode: DEFAULT_ACCESS_MODE,
        // The connection is credentialed via the shared loopback keychain; the
        // `Fredo_dbclient_connections.json` document itself never holds a secret.
        has_password: true,
        builtin: true,
    }
}

/// Seed the built-in connection ONCE, keyed SOLELY on the connection-store
/// document NOT existing (a fresh profile). Idempotent: a no-op when the
/// document exists (even an empty `[]`), so a deleted built-in is never
/// re-seeded on an existing profile — the binding "deletion is permanent"
/// decision. Any save/delete writes the document (`write_array`), so it exists
/// after any user action.
pub fn ensure_builtin_seeded(state: &DbClientState) -> Result<(), ProbeError> {
    let path = connections_path(state);
    if path.exists() {
        return Ok(());
    }
    let views = [builtin_connection_view()];
    write_array(&path, &views)
}

// ── Typed internal error ──────────────────────────────────────────────────────

/// A typed connection failure, carried internally and projected onto either the
/// `DbTestResult.error` shape (R-1.3) or the hard-named `Vec<String>` command
/// error shape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProbeError {
    pub kind: DbErrorKind,
    pub message: String,
}

impl ProbeError {
    fn new(kind: DbErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn config(message: impl Into<String>) -> Self {
        Self::new(DbErrorKind::Config, message)
    }

    /// Project onto the wire error struct (test-result path).
    pub fn to_query_error(&self) -> DbQueryError {
        DbQueryError {
            kind: self.kind,
            message: self.message.clone(),
            line: None,
            column: None,
            position: None,
        }
    }

    /// Project onto the hard-named command error shape.
    pub fn to_messages(&self) -> Vec<String> {
        vec![format!("{}: {}", error_token(self.kind), self.message)]
    }
}

/// The wire token for an error kind (mirrors the `DbErrorKind` serde names).
pub fn error_token(kind: DbErrorKind) -> &'static str {
    match kind {
        DbErrorKind::Auth => "auth",
        DbErrorKind::Unreachable => "unreachable",
        DbErrorKind::Timeout => "timeout",
        DbErrorKind::Tls => "tls",
        DbErrorKind::Config => "config",
        DbErrorKind::ReadOnlyBlocked => "readOnlyBlocked",
        DbErrorKind::ConfirmationRequired => "confirmationRequired",
        DbErrorKind::ConnectionLost => "connectionLost",
        DbErrorKind::Query => "query",
        DbErrorKind::Other => "other",
    }
}

// ── SSL mapping (R-5.6) ───────────────────────────────────────────────────────

/// Map the wire [`SslMode`] onto `sqlx`'s `PgSslMode`. The mapping is total and
/// never downgrades: `verifyCa`/`verifyFull`/`require` are passed through
/// verbatim (R-5.6).
pub fn to_pg_ssl_mode(mode: SslMode) -> PgSslMode {
    match mode {
        SslMode::Disable => PgSslMode::Disable,
        SslMode::Prefer => PgSslMode::Prefer,
        SslMode::Require => PgSslMode::Require,
        SslMode::VerifyCa => PgSslMode::VerifyCa,
        SslMode::VerifyFull => PgSslMode::VerifyFull,
    }
}

/// Build the bounded connect options for a target. The password is applied only
/// when present/non-blank.
pub fn build_connect_options(
    host: &str,
    port: u16,
    user: &str,
    database: &str,
    password: Option<&str>,
    ssl_mode: SslMode,
) -> PgConnectOptions {
    let mut options = PgConnectOptions::new()
        .host(host)
        .port(port)
        .username(user)
        .database(database)
        .ssl_mode(to_pg_ssl_mode(ssl_mode));
    if let Some(password) = password.filter(|p| !p.trim().is_empty()) {
        options = options.password(password);
    }
    options
}

// ── Validation (R-1.2) ────────────────────────────────────────────────────────

fn validate_target(host: &str, port: u16, user: &str, database: &str) -> Result<(), ProbeError> {
    if host.trim().is_empty() {
        return Err(ProbeError::config("host is required"));
    }
    if port == 0 {
        return Err(ProbeError::config("port must be between 1 and 65535"));
    }
    if user.trim().is_empty() {
        return Err(ProbeError::config("user is required"));
    }
    if database.trim().is_empty() {
        return Err(ProbeError::config("database is required"));
    }
    Ok(())
}

/// Validate test-connection input before any network call (R-1.2).
pub fn validate_test_args(args: &DbConnectionTestArgs) -> Result<(), ProbeError> {
    validate_target(&args.host, args.port, &args.user, &args.database)
}

/// Validate save input before any store/network call (R-1.2).
pub fn validate_save_args(args: &DbConnectionSaveArgs) -> Result<(), ProbeError> {
    if args.name.trim().is_empty() {
        return Err(ProbeError::config("connection name is required"));
    }
    validate_target(&args.host, args.port, &args.user, &args.database)
}

// ── Error classification + secrecy ────────────────────────────────────────────

/// Replace any occurrence of the submitted password in a message so a failure
/// can never echo a secret (R-5.5 / QA-10).
fn sanitize(message: &str, password: Option<&str>) -> String {
    match password {
        Some(secret) if !secret.is_empty() => message.replace(secret, "***"),
        _ => message.to_string(),
    }
}

fn classify_sqlx_error(error: &sqlx::Error, password: Option<&str>) -> ProbeError {
    let kind = match error {
        sqlx::Error::Configuration(_) => DbErrorKind::Config,
        sqlx::Error::Tls(_) => DbErrorKind::Tls,
        sqlx::Error::PoolTimedOut | sqlx::Error::PoolClosed => DbErrorKind::Timeout,
        sqlx::Error::Io(io) => match io.kind() {
            std::io::ErrorKind::TimedOut => DbErrorKind::Timeout,
            _ => DbErrorKind::Unreachable,
        },
        sqlx::Error::Database(db) => match db.code().as_deref() {
            Some("28P01") | Some("28000") => DbErrorKind::Auth,
            _ => DbErrorKind::Other,
        },
        _ => DbErrorKind::Other,
    };
    ProbeError::new(kind, sanitize(&error.to_string(), password))
}

// ── G-275 forced failure (connect/auth/timeout) ───────────────────────────────

fn forced_failure(stage: Option<ForceFailStage>) -> Option<ProbeError> {
    let env = seam::DBCLIENT_FORCE_FAIL_ENV;
    match stage {
        Some(ForceFailStage::Connect) => Some(ProbeError::new(
            DbErrorKind::Unreachable,
            format!("forced connect failure ({env} = connect)"),
        )),
        Some(ForceFailStage::Auth) => Some(ProbeError::new(
            DbErrorKind::Auth,
            format!("forced authentication failure ({env} = auth)"),
        )),
        Some(ForceFailStage::Timeout) => Some(ProbeError::new(
            DbErrorKind::Timeout,
            format!("forced timeout ({env} = timeout)"),
        )),
        // `query` is ST-4's stage; inert for the connect/test leg.
        Some(ForceFailStage::Query) | None => None,
    }
}

// ── Bounded open ──────────────────────────────────────────────────────────────

async fn open_bounded(
    options: PgConnectOptions,
    force_fail: Option<ForceFailStage>,
    password: Option<&str>,
) -> Result<(PgPool, String), ProbeError> {
    if let Some(error) = forced_failure(force_fail) {
        return Err(error);
    }
    let attempt = async {
        let pool = PgPoolOptions::new()
            .min_connections(0)
            .max_connections(1)
            .acquire_timeout(CONNECT_BOUND)
            .connect_with(options)
            .await
            .map_err(|e| classify_sqlx_error(&e, password))?;
        let version = sqlx::query_scalar::<_, String>("SELECT version()")
            .fetch_one(&pool)
            .await
            .map_err(|e| classify_sqlx_error(&e, password))?;
        Ok::<_, ProbeError>((pool, version))
    };
    match tokio::time::timeout(CONNECT_BOUND, attempt).await {
        Ok(result) => result,
        Err(_) => Err(ProbeError::new(
            DbErrorKind::Timeout,
            format!(
                "connection attempt exceeded the {} s bound",
                CONNECT_BOUND.as_secs()
            ),
        )),
    }
}

// ── Secret-free connection store ──────────────────────────────────────────────

fn connections_path(state: &DbClientState) -> PathBuf {
    state
        .state_dir()
        .join(format!("{DBCLIENT_CONNECTIONS_KEY}.json"))
}

fn history_path(state: &DbClientState, connection_id: &str) -> PathBuf {
    state
        .state_dir()
        .join(format!("{}.json", history_key(connection_id)))
}

fn saved_queries_path(state: &DbClientState, connection_id: &str) -> PathBuf {
    state
        .state_dir()
        .join(format!("{}.json", saved_queries_key(connection_id)))
}

fn read_array<T: DeserializeOwned>(path: &Path) -> Vec<T> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<T>>(&raw).ok())
        .unwrap_or_default()
}

fn write_array<T: Serialize>(path: &Path, value: &[T]) -> Result<(), ProbeError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            ProbeError::new(
                DbErrorKind::Other,
                format!("failed to create {}: {e}", parent.display()),
            )
        })?;
    }
    let raw = serde_json::to_string_pretty(value).map_err(|e| {
        ProbeError::new(
            DbErrorKind::Other,
            format!("failed to serialize connection store: {e}"),
        )
    })?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| {
        ProbeError::new(
            DbErrorKind::Other,
            format!("failed to write {}: {e}", tmp.display()),
        )
    })?;
    std::fs::rename(&tmp, path).map_err(|e| {
        ProbeError::new(
            DbErrorKind::Other,
            format!("failed to replace {}: {e}", path.display()),
        )
    })
}

fn remove_file_if_exists(path: &Path) -> Result<(), ProbeError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(ProbeError::new(
            DbErrorKind::Other,
            format!("failed to remove {}: {e}", path.display()),
        )),
    }
}

/// Connection ids are uuid v4 or a caller-supplied id; restrict to a safe
/// filename charset so the per-connection document paths cannot escape the
/// state dir.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn credential_present(credentials: &dyn CredentialStore, connection_id: &str) -> bool {
    // A store outage must not take the whole connection list down; the view then
    // reports `hasPassword: false` (R-1.5 tolerates a metadata read).
    credentials.has_password(connection_id).unwrap_or(false)
}

// ── Commands (bodies) ─────────────────────────────────────────────────────────

/// List saved connections (R-1.5). Reads the secret-free metadata documents and
/// fills `has_password` from the keychain — never the secret itself.
pub async fn connection_list(
    state: &DbClientState,
) -> Result<Vec<DbConnectionView>, Vec<String>> {
    connection_list_with(state, &KeyringCredentialStore)
}

/// Testable `connection_list` with an injected credential store.
pub fn connection_list_with(
    state: &DbClientState,
    credentials: &dyn CredentialStore,
) -> Result<Vec<DbConnectionView>, Vec<String>> {
    ensure_builtin_seeded(state).map_err(|e| e.to_messages())?;
    let mut views = read_array::<DbConnectionView>(&connections_path(state));
    for view in &mut views {
        view.has_password = credential_present(credentials, &view.id);
    }
    Ok(views)
}

/// Bounded test-before-save probe (R-1.3/R-1.4/R-1.8). The failure stage is
/// resolved from the G-275 env seam.
pub async fn connection_test(args: DbConnectionTestArgs) -> Result<DbTestResult, Vec<String>> {
    Ok(probe(args, seam::force_fail_stage()).await)
}

/// The probe itself, with an explicit failure stage (testable without env
/// mutation, G-222). Always `Ok` — the typed failure is carried in
/// [`DbTestResult::error`].
pub async fn probe(args: DbConnectionTestArgs, force_fail: Option<ForceFailStage>) -> DbTestResult {
    if let Err(error) = validate_test_args(&args) {
        return DbTestResult {
            ok: false,
            server_version: None,
            error: Some(error.to_query_error()),
        };
    }
    let password = args.password.as_deref();
    let options = build_connect_options(
        &args.host,
        args.port,
        &args.user,
        &args.database,
        password,
        args.ssl_mode,
    );
    match open_bounded(options, force_fail, password).await {
        Ok((pool, version)) => {
            pool.close().await;
            DbTestResult {
                ok: true,
                server_version: Some(version),
                error: None,
            }
        }
        Err(error) => DbTestResult {
            ok: false,
            server_version: None,
            error: Some(error.to_query_error()),
        },
    }
}

/// Create or edit a saved connection (R-1.5/R-1.6). A new connection is forced
/// read-only (R-5.1); a blank/absent password on edit keeps the existing secret
/// (R-1.6).
pub async fn connection_save(
    args: DbConnectionSaveArgs,
    state: &DbClientState,
) -> Result<DbConnectionView, Vec<String>> {
    connection_save_with(args, state, &KeyringCredentialStore)
}

/// Testable `connection_save` with an injected credential store.
pub fn connection_save_with(
    args: DbConnectionSaveArgs,
    state: &DbClientState,
    credentials: &dyn CredentialStore,
) -> Result<DbConnectionView, Vec<String>> {
    ensure_builtin_seeded(state).map_err(|e| e.to_messages())?;
    validate_save_args(&args).map_err(|e| e.to_messages())?;

    if let Some(id) = &args.id {
        if !is_safe_id(id) {
            return Err(ProbeError::config("invalid connection id").to_messages());
        }
    }

    let path = connections_path(state);
    let mut views = read_array::<DbConnectionView>(&path);
    let existing = args
        .id
        .as_ref()
        .and_then(|id| views.iter().position(|view| &view.id == id));

    let id = match &args.id {
        Some(id) => id.clone(),
        None => Uuid::new_v4().to_string(),
    };

    // R-1.6: only a non-blank password replaces the stored secret.
    if let Some(password) = args.password.as_deref().filter(|p| !p.trim().is_empty()) {
        credentials
            .set_password(&id, password)
            .map_err(|e| ProbeError::new(DbErrorKind::Other, e).to_messages())?;
    }

    // R-5.1: a newly created connection is read-only; an edit honours the
    // explicit mode toggle.
    let access_mode = if existing.is_none() {
        DEFAULT_ACCESS_MODE
    } else {
        args.access_mode
    };

    let view = DbConnectionView {
        id: id.clone(),
        name: args.name.trim().to_string(),
        engine: args.engine,
        host: args.host.trim().to_string(),
        port: args.port,
        user: args.user.trim().to_string(),
        database: args.database.trim().to_string(),
        ssl_mode: args.ssl_mode,
        access_mode,
        has_password: credential_present(credentials, &id),
        // Spec #3029: every SAVE produces an ordinary connection. Editing the
        // built-in (via `db_connection_save` with its id) therefore converts it
        // to an ordinary saved connection and stops connect-time endpoint
        // resolution (binding "edit ⇒ ordinary" decision).
        builtin: false,
    };

    match existing {
        Some(index) => views[index] = view.clone(),
        None => views.push(view.clone()),
    }
    write_array(&path, &views).map_err(|e| e.to_messages())?;
    Ok(view)
}

/// Delete a connection and all four of its stores (R-1.7): metadata, keychain
/// secret, history document, saved-queries document. Any open pool is closed.
pub async fn connection_delete(
    args: DbConnectionDeleteArgs,
    state: &DbClientState,
) -> Result<(), Vec<String>> {
    let result = connection_delete_with(&args, state, &KeyringCredentialStore);
    if let Some(pool) = state.remove_pool(&args.connection_id).await {
        pool.close().await;
    }
    result
}

/// Testable `connection_delete` with an injected credential store.
pub fn connection_delete_with(
    args: &DbConnectionDeleteArgs,
    state: &DbClientState,
    credentials: &dyn CredentialStore,
) -> Result<(), Vec<String>> {
    let id = args.connection_id.as_str();
    if !is_safe_id(id) {
        return Err(ProbeError::config("invalid connection id").to_messages());
    }

    let path = connections_path(state);
    let mut views = read_array::<DbConnectionView>(&path);
    views.retain(|view| view.id != id);
    write_array(&path, &views).map_err(|e| e.to_messages())?;

    credentials
        .delete_password(id)
        .map_err(|e| ProbeError::new(DbErrorKind::Other, e).to_messages())?;
    remove_file_if_exists(&history_path(state, id)).map_err(|e| e.to_messages())?;
    remove_file_if_exists(&saved_queries_path(state, id)).map_err(|e| e.to_messages())?;
    // R-3.3/R-3.4: release the deleted connection's cached result rows so the
    // bounded cache cannot retain memory for a store that no longer exists.
    super::query::release_connection_results(id);
    Ok(())
}

/// Open a bounded external session (R-1.3) and register its pool.
pub async fn connect(
    args: DbConnectArgs,
    state: &DbClientState,
) -> Result<DbSessionInfo, Vec<String>> {
    let provider = state.embedded_endpoint_provider();
    connect_with(args, state, &KeyringCredentialStore, provider.as_deref()).await
}

/// The effective connect target for a stored connection, resolved per call.
struct ResolvedTarget {
    host: String,
    port: u16,
    user: String,
    database: String,
    ssl_mode: SslMode,
    password: Option<String>,
}

/// Resolve the effective connect target for a stored [`DbConnectionView`]
/// (Spec #3029).
///
/// * `builtin=true` (EARS-3/EARS-6/EARS-7): host/port/user/database come from the
///   LIVE [`EmbeddedPgEndpointProvider`] on EVERY call (no stale persisted port),
///   the password from the provider's keychain resolution, and TLS is `Disable`
///   (loopback-only). This arm resolves BEFORE any credential path: provider
///   absent ⇒ typed `config` (EARS-4b); provider present but not serving ⇒ typed
///   `unreachable` (EARS-4a). It NEVER prompts for a credential.
/// * `builtin=false` (ordinary): the persisted view fields + the per-connection
///   `fredo.dbclient` keychain secret — byte-identical to the pre-#3029 path.
fn resolve_target(
    view: &DbConnectionView,
    credentials: &dyn CredentialStore,
    endpoint_provider: Option<&dyn EmbeddedPgEndpointProvider>,
) -> Result<ResolvedTarget, Vec<String>> {
    if view.builtin {
        let provider = endpoint_provider.ok_or_else(|| {
            ProbeError::new(
                DbErrorKind::Config,
                "the embedded PostgreSQL endpoint is not managed in this environment",
            )
            .to_messages()
        })?;
        let endpoint = provider.endpoint().ok_or_else(|| {
            ProbeError::new(
                DbErrorKind::Unreachable,
                "the embedded PostgreSQL cluster is not serving yet",
            )
            .to_messages()
        })?;
        let password = provider
            .loopback_password()
            .map_err(|e| ProbeError::new(DbErrorKind::Other, e).to_messages())?;
        return Ok(ResolvedTarget {
            host: endpoint.host,
            port: endpoint.port,
            user: endpoint.user,
            database: endpoint.database,
            ssl_mode: SslMode::Disable,
            password,
        });
    }

    let password = credentials
        .get_password(&view.id)
        .map_err(|e| ProbeError::new(DbErrorKind::Other, e).to_messages())?;
    Ok(ResolvedTarget {
        host: view.host.clone(),
        port: view.port,
        user: view.user.clone(),
        database: view.database.clone(),
        ssl_mode: view.ssl_mode,
        password,
    })
}

/// Testable `connect` with an injected credential store and endpoint provider.
pub async fn connect_with(
    args: DbConnectArgs,
    state: &DbClientState,
    credentials: &dyn CredentialStore,
    endpoint_provider: Option<&dyn EmbeddedPgEndpointProvider>,
) -> Result<DbSessionInfo, Vec<String>> {
    ensure_builtin_seeded(state).map_err(|e| e.to_messages())?;

    let view = read_array::<DbConnectionView>(&connections_path(state))
        .into_iter()
        .find(|view| view.id == args.connection_id)
        .ok_or_else(|| ProbeError::config("unknown connection").to_messages())?;

    if state.pool_count().await >= MAX_OPEN_CONNECTIONS {
        return Err(ProbeError::config(format!(
            "at most {MAX_OPEN_CONNECTIONS} connections may be open at once"
        ))
        .to_messages());
    }

    let target = resolve_target(&view, credentials, endpoint_provider)?;
    let options = build_connect_options(
        &target.host,
        target.port,
        &target.user,
        &target.database,
        target.password.as_deref(),
        target.ssl_mode,
    );
    let (pool, server_version) = open_bounded(options, state.force_fail(), target.password.as_deref())
        .await
        .map_err(|e| e.to_messages())?;

    if let Some(replaced) = state.insert_pool(view.id.clone(), pool).await {
        replaced.close().await;
    }
    Ok(DbSessionInfo {
        connection_id: view.id,
        server_version,
        access_mode: view.access_mode,
    })
}

/// Close a session and release its pool (R-3.8) plus its cached result rows
/// (R-3.3/R-3.4).
pub async fn disconnect(args: DbConnectArgs, state: &DbClientState) -> Result<(), Vec<String>> {
    if let Some(pool) = state.remove_pool(&args.connection_id).await {
        pool.close().await;
    }
    super::query::release_connection_results(&args.connection_id);
    Ok(())
}
