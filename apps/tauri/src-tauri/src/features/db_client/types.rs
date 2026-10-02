//! db_client wire contract + persistence key contract (Spec #2950, ST-1).
//!
//! Every type here is **frozen** by the plan's Authoritative Names Block and
//! API Contracts & Data Models (G-255/G-023): later sub-tasks and the TS mirror
//! (`apps/ui/src/features/database-client/lib/types.ts`) consume these names
//! verbatim. Do not rename.
//!
//! All wire structs/enums serialize `camelCase`; the enums carry the exact
//! variant strings the frontend expects (`readOnly`, `verifyCa`, …).

use serde::{Deserialize, Serialize};

// ── Persistence key contract (settingsService → AppStore KV; NO secret) ───────
//
// The connection metadata / history / saved-query / preference documents are
// secret-free by construction — the password lives only in the OS keychain
// (service [`DBCLIENT_KEYRING_SERVICE`], account from [`keyring_account`]).

/// `DbConnectionView[]` — saved connections, newest metadata only (no secret).
pub const DBCLIENT_CONNECTIONS_KEY: &str = "Fredo_dbclient_connections";
/// Prefix for `QueryHistoryEntry[]` per connection (`<prefix><connectionId>`).
pub const DBCLIENT_HISTORY_KEY_PREFIX: &str = "Fredo_dbclient_history_";
/// Prefix for `SavedQuery[]` per connection (`<prefix><connectionId>`).
pub const DBCLIENT_SAVED_QUERIES_KEY_PREFIX: &str = "Fredo_dbclient_saved_queries_";
/// `DbClientPrefs` — client preferences.
pub const DBCLIENT_PREFS_KEY: &str = "Fredo_dbclient_prefs";
/// OS-keychain service name for every db-client credential.
pub const DBCLIENT_KEYRING_SERVICE: &str = "fredo.dbclient";

/// History document key for one connection (`Fredo_dbclient_history_<id>`).
pub fn history_key(connection_id: &str) -> String {
    format!("{DBCLIENT_HISTORY_KEY_PREFIX}{connection_id}")
}

/// Saved-queries document key for one connection
/// (`Fredo_dbclient_saved_queries_<id>`).
pub fn saved_queries_key(connection_id: &str) -> String {
    format!("{DBCLIENT_SAVED_QUERIES_KEY_PREFIX}{connection_id}")
}

/// OS-keychain account for one connection (`connection:<id>:password`).
pub fn keyring_account(connection_id: &str) -> String {
    format!("connection:{connection_id}:password")
}

// ── Enums ─────────────────────────────────────────────────────────────────────

/// Database engine. Only PostgreSQL ships in this slice.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DbEngineKind {
    Postgres,
}

/// TLS mode mapped onto `sqlx`'s `PgSslMode` (R-5.6).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SslMode {
    Disable,
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

/// Session access mode. New connections default to [`AccessMode::ReadOnly`]
/// (R-5.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccessMode {
    ReadOnly,
    ReadWrite,
}

/// Classified statement kind used by the safety gates (R-5.2/R-5.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StatementClass {
    Read,
    Write,
    Ddl,
    Destructive,
    Unknown,
}

/// Schema-tree node kind (R-2.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DbObjectKind {
    Database,
    Schema,
    Table,
    View,
    Column,
    Index,
    Key,
    Function,
}

/// Typed failure vocabulary. Every failure path returns one of these; errors are
/// never swallowed (R-1.3/R-1.8/R-3.5/R-3.8/R-5.2/R-5.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DbErrorKind {
    Auth,
    Unreachable,
    Timeout,
    Tls,
    Config,
    ReadOnlyBlocked,
    ConfirmationRequired,
    ConnectionLost,
    Query,
    Other,
}

/// Query execution scope: one statement at the caret/selection (default,
/// R-5.4) or the explicit "Run all" (R-3.6).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QueryMode {
    Single,
    All,
}

// ── Wire structs ──────────────────────────────────────────────────────────────

/// A saved connection as rendered by the UI — **never** carries the secret;
/// [`DbConnectionView::has_password`] is the only credential signal.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectionView {
    /// uuid v4 (assigned by the save path).
    pub id: String,
    pub name: String,
    pub engine: DbEngineKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    pub ssl_mode: SslMode,
    pub access_mode: AccessMode,
    /// Whether a keychain secret exists. NEVER the secret itself.
    pub has_password: bool,
}

/// Transient test-connection arguments. The password is used for this call only
/// and is never persisted by `db_connection_test`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectionTestArgs {
    pub engine: DbEngineKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    pub ssl_mode: SslMode,
    pub password: Option<String>,
}

/// Save (create or edit) arguments. `id: None` creates; `password: None` on edit
/// keeps the existing keychain secret (R-1.6).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectionSaveArgs {
    /// `None` => create.
    pub id: Option<String>,
    pub name: String,
    pub engine: DbEngineKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    pub ssl_mode: SslMode,
    pub access_mode: AccessMode,
    /// `None` on edit => keep the existing keychain secret (R-1.6).
    pub password: Option<String>,
}

/// Delete-by-id arguments (R-1.7).
///
/// NOTE: the plan's command block references this shape but the API Contracts
/// block omitted it; ST-1 freezes it here as the producer contract.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectionDeleteArgs {
    pub connection_id: String,
}

/// Connect / disconnect arguments (R-1.3/R-3.8).
///
/// NOTE: referenced by the plan's command block, frozen here by ST-1.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectArgs {
    pub connection_id: String,
}

/// Lazy per-level schema browse arguments (R-2.1/R-2.2). `parent_id: None`
/// fetches the root level (databases); otherwise it is the parent
/// [`SchemaNode::id`] path key whose children are fetched.
///
/// NOTE: referenced by the plan's command block, frozen here by ST-1.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbSchemaListArgs {
    pub connection_id: String,
    pub parent_id: Option<String>,
}

/// Bounded connection probe outcome (R-1.3).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTestResult {
    pub ok: bool,
    pub server_version: Option<String>,
    pub error: Option<DbQueryError>,
}

/// Open-session descriptor (R-1.3).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbSessionInfo {
    pub connection_id: String,
    pub server_version: String,
    pub access_mode: AccessMode,
}

/// One lazy schema-tree node (R-2.1/R-2.3).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaNode {
    pub kind: DbObjectKind,
    /// Stable path key, e.g. `"db/schema/table"`.
    pub id: String,
    pub name: String,
    /// Column type / index def / function signature.
    pub detail: Option<String>,
    pub has_children: bool,
}

/// UTF-8 byte offsets into the editor buffer (R-3.2).
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct TextRange {
    pub start: usize,
    pub end: usize,
}

/// Query execution arguments (R-3.2/R-3.6/R-5.3/R-5.4).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbQueryArgs {
    pub connection_id: String,
    pub sql: String,
    /// `Single` = R-5.4 default; `All` = explicit "Run all" (R-3.6).
    pub mode: QueryMode,
    pub selection: Option<TextRange>,
    /// Confirmation hashes the user has explicitly approved (R-5.3).
    pub confirmed_statement_hashes: Vec<String>,
    /// First-page row limit (R-3.3, PO decision 7). `None`/`0` => the backend's
    /// `DEFAULT_PAGE` (100).
    ///
    /// Additive and serde-defaulted so existing callers keep the 100-row default.
    /// Clamped to the backend's `HARD_CAP` (5,000) bound by the query path.
    #[serde(default)]
    pub limit: Option<usize>,
}

/// A result-set column descriptor.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbColumn {
    pub name: String,
    pub type_name: String,
}

/// One bounded result set (current page). `truncated` marks the hard-cap cut
/// (R-3.4).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbResultSet {
    pub result_set_id: String,
    pub columns: Vec<DbColumn>,
    /// Current page of rows.
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count_loaded: usize,
    pub has_more: bool,
    /// R-3.4 — the 5,000-row hard cap was reached.
    pub truncated: bool,
    pub duration_ms: u64,
}

/// Typed query/test error with optional 1-based position (R-3.5).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbQueryError {
    pub kind: DbErrorKind,
    pub message: String,
    /// 1-based line (R-3.5).
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub position: Option<u32>,
}

/// Destructive/unknown statement awaiting explicit confirmation (R-5.3). The
/// `statement_hash` is echoed back in
/// [`DbQueryArgs::confirmed_statement_hashes`].
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConfirmationRequired {
    pub statement_class: StatementClass,
    pub statement_hash: String,
    pub preview: String,
}

/// One `db_query_execute` outcome (R-3.6/R-5.3).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbQueryOutcome {
    pub result_sets: Vec<DbResultSet>,
    pub confirmation_required: Option<DbConfirmationRequired>,
    pub error: Option<DbQueryError>,
}

/// Pagination arguments for an already-executed result set (R-3.3).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbResultPageArgs {
    pub connection_id: String,
    pub result_set_id: String,
    pub offset: usize,
    pub limit: usize,
}
