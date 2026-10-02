//! Query execution + classification + safety gating + bounded result cache
//! (Spec #2950, ST-4).
//!
//! This module fills the ST-1 stubs so `db_query_execute` / `db_result_page`
//! are real. It owns:
//!
//! * **classification + splitting** ([`classify`]) — `sqlparser`-based
//!   classification and a quote/comment/dollar-aware splitter (R-5.2/R-5.3/R-5.4);
//! * **safety gating** — a read-only connection refuses every non-`read`
//!   statement *before* touching the server (R-5.2); a read-write connection
//!   returns `confirmationRequired` for an unconfirmed `destructive`/`unknown`
//!   statement and executes nothing (R-5.3);
//! * **single-statement default** — [`QueryMode::Single`] executes at most the
//!   first statement of the selection/caret scope and never the remainder
//!   (R-5.4); [`QueryMode::All`] returns one result set per statement in order
//!   (R-3.6);
//! * **bounded results + pagination** — each result set is capped at
//!   [`HARD_CAP`] rows, the first page honours the request's `limit` (falling
//!   back to [`DEFAULT_PAGE`]), and `db_result_page` slices the cached set
//!   without re-running the query (R-3.3/R-3.4);
//! * **typed errors** — the Postgres message with 1-based line/column when the
//!   server supplies a position (R-3.5) and a typed `connectionLost` when the
//!   connection drops mid-query (R-3.8).
//!
//! # Non-goals / invariants
//!
//! * A read-only connection never reaches the server for a non-`read` statement
//!   (the gate runs before the pool lookup).
//! * An unconfirmed `destructive`/`unknown` statement executes nothing.
//! * One `db_query_execute` call in `Single` mode executes at most one statement.
//! * `AppStore` / `EngineHandle` and the embedded-PostgreSQL supervisor are
//!   untouched; the result cache is local to this module.
//!
//! # Row mapping
//!
//! Execution uses the **simple query protocol** (`sqlx::raw_sql`), so every
//! value arrives in PostgreSQL's text format. Rows are mapped by physical type
//! name — the same technique as `feature_store::pg_row_to_json`, extended to the
//! text representation so arbitrary user columns (numeric, uuid, json, arrays,
//! bytea, timestamps) map without a fixed schema and without ever failing the
//! whole query on an unmappable column.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use serde_json::Value as JsonValue;
use sqlx::postgres::{PgDatabaseError, PgErrorPosition, PgPool, PgRow};
use sqlx::{Column, Either, Row, TypeInfo, ValueRef};
use uuid::Uuid;

use super::seam::{ForceFailStage, DBCLIENT_FORCE_FAIL_ENV};
use super::state::DbClientState;
use super::types::{
    AccessMode, DbColumn, DbConfirmationRequired, DbConnectionView, DbErrorKind, DbQueryArgs,
    DbQueryError, DbQueryOutcome, DbResultPageArgs, DbResultSet, QueryMode, StatementClass,
    DBCLIENT_CONNECTIONS_KEY,
};

#[path = "classify.rs"]
pub mod classify;

#[cfg(test)]
#[path = "tests_query.rs"]
mod tests_query;

/// Default page size (first page + one "Load more") — plan bound.
pub const DEFAULT_PAGE: usize = 100;
/// Hard cap on rows held per result set — plan bound (R-3.4).
pub const HARD_CAP: usize = 5_000;
/// Per-statement timeout — plan bound (R-3.5/R-3.8, G-263).
pub const STATEMENT_TIMEOUT: Duration = Duration::from_secs(30);
/// Bounded cache size: at most this many result sets are retained (LRU).
pub(crate) const MAX_CACHED_RESULT_SETS: usize = 16;

// ── Public commands (bodies) ──────────────────────────────────────────────────

/// Execute one statement / an explicit "Run all" under the safety gates
/// (R-3.2/R-3.6/R-5.2/R-5.3/R-5.4).
pub async fn query_execute(
    args: DbQueryArgs,
    state: &DbClientState,
) -> Result<DbQueryOutcome, Vec<String>> {
    // Resolve the connection's access mode from the secret-free metadata store.
    let access_mode = connection_access_mode(state, &args.connection_id)?;

    // Split the in-scope SQL and classify every statement that would run.
    let statements = plan_statements(&args);
    if statements.is_empty() {
        return Ok(error_outcome(DbQueryError {
            kind: DbErrorKind::Query,
            message: "no statement to execute".to_string(),
            line: None,
            column: None,
            position: None,
        }));
    }

    // R-5.2 — a read-only connection refuses every non-`read` statement before
    // any server contact.
    if access_mode == AccessMode::ReadOnly {
        if let Some(blocked) = statements.iter().find(|s| s.class != StatementClass::Read) {
            return Ok(error_outcome(DbQueryError {
                kind: DbErrorKind::ReadOnlyBlocked,
                message: format!(
                    "read-only connection: {} statements are refused before execution",
                    class_token(blocked.class)
                ),
                line: None,
                column: None,
                position: None,
            }));
        }
    } else {
        // R-5.3 — an unconfirmed destructive/unknown statement executes nothing.
        for statement in &statements {
            if matches!(
                statement.class,
                StatementClass::Destructive | StatementClass::Unknown
            ) {
                let hash = classify::statement_hash(&statement.sql);
                if !args
                    .confirmed_statement_hashes
                    .iter()
                    .any(|confirmed| confirmed == &hash)
                {
                    return Ok(DbQueryOutcome {
                        result_sets: Vec::new(),
                        confirmation_required: Some(DbConfirmationRequired {
                            statement_class: statement.class,
                            statement_hash: hash,
                            preview: classify::preview(&statement.sql),
                        }),
                        error: None,
                    });
                }
            }
        }
    }

    // G-275 induction: `FREDO_DBCLIENT_FORCE_FAIL=query|timeout` fails the query
    // before it reaches the server.
    if let Some(error) = forced_query_error(state.force_fail()) {
        return Ok(error_outcome(error));
    }

    let Some(pool) = state.pool(&args.connection_id).await else {
        return Err(vec![format!(
            "connection {} is not open; connect before running a query",
            args.connection_id
        )]);
    };

    let mut result_sets = Vec::new();
    // R-3.3 / PO decision 7 — the first page honours the client's
    // `defaultRowLimit` when supplied, falling back to `DEFAULT_PAGE` (100) and
    // clamped to `HARD_CAP` (R-3.4).
    let first_page = first_page_limit(args.limit);
    for statement in &statements {
        match execute_one(&pool, &args.connection_id, &statement.sql, first_page).await {
            Ok(set) => result_sets.push(set),
            Err(error) => {
                // R-3.8 — a dropped connection is typed `connectionLost` and the
                // session is marked disconnected (its pool is closed/removed).
                if error.kind == DbErrorKind::ConnectionLost {
                    if let Some(dead) = state.remove_pool(&args.connection_id).await {
                        dead.close().await;
                    }
                }
                return Ok(DbQueryOutcome {
                    result_sets,
                    confirmation_required: None,
                    error: Some(error),
                });
            }
        }
    }

    Ok(DbQueryOutcome {
        result_sets,
        confirmation_required: None,
        error: None,
    })
}

/// Slice the next page from an executed result set (R-3.3).
pub async fn result_page(
    args: DbResultPageArgs,
    _state: &DbClientState,
) -> Result<DbResultSet, Vec<String>> {
    let cache = result_cache()
        .lock()
        .map_err(|_| vec!["result cache unavailable".to_string()])?;
    cache
        .page(
            &args.connection_id,
            &args.result_set_id,
            args.offset,
            args.limit,
        )
        .ok_or_else(|| {
            vec![format!(
                "result set {} not found for connection {}",
                args.result_set_id, args.connection_id
            )]
        })
}

// ── Statement planning ────────────────────────────────────────────────────────

/// One statement selected for execution, with its classified kind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PlannedStatement {
    pub sql: String,
    pub class: StatementClass,
}

/// Select and classify the statements a call would execute.
///
/// `Single` keeps at most the first statement of the in-scope text (R-5.4);
/// `All` keeps every statement in order (R-3.6).
pub(crate) fn plan_statements(args: &DbQueryArgs) -> Vec<PlannedStatement> {
    let scope = in_scope_sql(args);
    let mut spans = classify::split_statements(&scope);
    if matches!(args.mode, QueryMode::Single) {
        spans.truncate(1);
    }
    spans
        .into_iter()
        .map(|span| PlannedStatement {
            class: classify::classify_statement(&span.sql),
            sql: span.sql,
        })
        .collect()
}

/// The SQL in scope: the selection when present/non-empty, else the whole buffer
/// (R-3.2). Offsets are UTF-8 byte offsets into [`DbQueryArgs::sql`]; an invalid
/// range falls back to the whole buffer.
fn in_scope_sql(args: &DbQueryArgs) -> String {
    match args.selection {
        Some(range) if range.end > range.start => args
            .sql
            .get(range.start..range.end)
            .map(str::to_string)
            .unwrap_or_else(|| args.sql.clone()),
        _ => args.sql.clone(),
    }
}

fn connection_access_mode(
    state: &DbClientState,
    connection_id: &str,
) -> Result<AccessMode, Vec<String>> {
    let path: PathBuf = state
        .state_dir()
        .join(format!("{DBCLIENT_CONNECTIONS_KEY}.json"));
    let views: Vec<DbConnectionView> = std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    views
        .into_iter()
        .find(|view| view.id == connection_id)
        .map(|view| view.access_mode)
        .ok_or_else(|| vec![format!("config: unknown connection {connection_id}")])
}

// ── G-275 forced failure ──────────────────────────────────────────────────────

fn forced_query_error(stage: Option<ForceFailStage>) -> Option<DbQueryError> {
    match stage {
        Some(ForceFailStage::Query) => Some(DbQueryError {
            kind: DbErrorKind::Query,
            message: format!("forced query failure ({DBCLIENT_FORCE_FAIL_ENV} = query)"),
            line: None,
            column: None,
            position: None,
        }),
        Some(ForceFailStage::Timeout) => Some(DbQueryError {
            kind: DbErrorKind::Timeout,
            message: format!("forced query timeout ({DBCLIENT_FORCE_FAIL_ENV} = timeout)"),
            line: None,
            column: None,
            position: None,
        }),
        // connect/auth belong to ST-2; the query leg is inert for them.
        Some(ForceFailStage::Connect) | Some(ForceFailStage::Auth) | None => None,
    }
}

fn error_outcome(error: DbQueryError) -> DbQueryOutcome {
    DbQueryOutcome {
        result_sets: Vec::new(),
        confirmation_required: None,
        error: Some(error),
    }
}

fn class_token(class: StatementClass) -> &'static str {
    match class {
        StatementClass::Read => "read",
        StatementClass::Write => "write",
        StatementClass::Ddl => "ddl",
        StatementClass::Destructive => "destructive",
        StatementClass::Unknown => "unknown",
    }
}

// ── Execution ─────────────────────────────────────────────────────────────────

/// Resolve the first-page row limit from an optional request value (R-3.3).
///
/// An absent or zero limit falls back to [`DEFAULT_PAGE`]; every value is clamped
/// to [`HARD_CAP`] (R-3.4) and never below 1.
fn first_page_limit(limit: Option<usize>) -> usize {
    limit
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_PAGE)
        .clamp(1, HARD_CAP)
}

async fn execute_one(
    pool: &PgPool,
    connection_id: &str,
    sql: &str,
    first_page: usize,
) -> Result<DbResultSet, DbQueryError> {
    let started = Instant::now();
    let attempt = async {
        // R-3.8 — a killed server does not close the pool; `acquire()` then
        // exhausts its timeout. Only a pool with NO live connection is a lost
        // connection; genuine contention on a healthy (saturated) pool stays
        // `Timeout` (the pool is built with `max_connections(1)`).
        let mut conn = pool.acquire().await.map_err(|e| {
            if matches!(e, sqlx::Error::PoolTimedOut) && pool.size() == 0 {
                DbQueryError {
                    kind: DbErrorKind::ConnectionLost,
                    message: "connection lost: the server is no longer reachable".to_string(),
                    line: None,
                    column: None,
                    position: None,
                }
            } else {
                map_sqlx_error(&e, sql)
            }
        })?;
        // Server-side bound (mirrors the client-side `STATEMENT_TIMEOUT`).
        sqlx::query("SET statement_timeout = 30000")
            .execute(&mut *conn)
            .await
            .map_err(|e| map_sqlx_error(&e, sql))?;

        let mut columns: Vec<DbColumn> = Vec::new();
        let mut rows: Vec<Vec<JsonValue>> = Vec::new();
        let mut truncated = false;
        let mut stopped_early = false;

        {
            let mut stream = sqlx::raw_sql(sql).fetch_many(&mut *conn);
            while let Some(item) = stream.try_next().await.map_err(|e| map_sqlx_error(&e, sql))? {
                if let Either::Right(row) = item {
                    if columns.is_empty() {
                        columns = row
                            .columns()
                            .iter()
                            .map(|column| DbColumn {
                                name: column.name().to_string(),
                                type_name: column.type_info().name().to_string(),
                            })
                            .collect();
                    }
                    if rows.len() < HARD_CAP {
                        rows.push(row_to_json(&row));
                    } else {
                        // Hard cap reached (R-3.4). Stop reading and discard the
                        // connection so a mid-stream socket is never reused.
                        truncated = true;
                        stopped_early = true;
                        break;
                    }
                }
            }
        }

        if stopped_early {
            let _ = conn.close().await;
        }

        Ok::<_, DbQueryError>((columns, rows, truncated))
    };

    match tokio::time::timeout(STATEMENT_TIMEOUT, attempt).await {
        Err(_) => Err(DbQueryError {
            kind: DbErrorKind::Timeout,
            message: format!(
                "statement exceeded the {} s timeout",
                STATEMENT_TIMEOUT.as_secs()
            ),
            line: None,
            column: None,
            position: None,
        }),
        Ok(Ok((columns, rows, truncated))) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            let (_, set) =
                cache_result_set(connection_id, columns, rows, truncated, duration_ms, first_page);
            Ok(set)
        }
        Ok(Err(error)) => Err(error),
    }
}

// ── Typed error mapping (R-3.5/R-3.8) ─────────────────────────────────────────

fn map_sqlx_error(error: &sqlx::Error, sql: &str) -> DbQueryError {
    let (kind, message) = match error {
        sqlx::Error::Database(db) => {
            let kind = match db.code().as_deref() {
                Some("57014") => DbErrorKind::Timeout,
                Some(
                    "57P01" | "57P02" | "57P03" | "08000" | "08001" | "08003" | "08004" | "08006"
                    | "08007" | "08P01",
                ) => DbErrorKind::ConnectionLost,
                _ => DbErrorKind::Query,
            };
            (kind, db.message().to_string())
        }
        sqlx::Error::PoolTimedOut => (
            DbErrorKind::Timeout,
            "connection pool timed out".to_string(),
        ),
        sqlx::Error::PoolClosed => (
            DbErrorKind::ConnectionLost,
            "connection pool is closed".to_string(),
        ),
        sqlx::Error::Io(io) => match io.kind() {
            std::io::ErrorKind::TimedOut => (DbErrorKind::Timeout, io.to_string()),
            std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::UnexpectedEof
            | std::io::ErrorKind::NotConnected => (DbErrorKind::ConnectionLost, io.to_string()),
            _ => (DbErrorKind::Other, io.to_string()),
        },
        sqlx::Error::Tls(_) => (DbErrorKind::Tls, error.to_string()),
        sqlx::Error::Protocol(_) => (DbErrorKind::ConnectionLost, error.to_string()),
        sqlx::Error::Configuration(_) => (DbErrorKind::Config, error.to_string()),
        _ => (DbErrorKind::Other, error.to_string()),
    };

    let (line, column, position) = match error {
        sqlx::Error::Database(db) => db
            .try_downcast_ref::<PgDatabaseError>()
            .and_then(|pg| pg.position())
            .map(|position| position_fields(position, sql))
            .unwrap_or((None, None, None)),
        _ => (None, None, None),
    };

    DbQueryError {
        kind,
        message,
        line,
        column,
        position,
    }
}

/// Project a Postgres error cursor onto 1-based `(line, column, position)`.
fn position_fields(
    position: PgErrorPosition<'_>,
    sql: &str,
) -> (Option<u32>, Option<u32>, Option<u32>) {
    match position {
        PgErrorPosition::Original(position) => {
            let position = position as u32;
            let (line, column) = line_column(sql, position);
            (Some(line), Some(column), Some(position))
        }
        PgErrorPosition::Internal { position, .. } => (None, None, Some(position as u32)),
    }
}

/// Convert a 1-based character `position` (Postgres semantics) into 1-based
/// `(line, column)` for `sql` (R-3.5).
pub(crate) fn line_column(sql: &str, position: u32) -> (u32, u32) {
    let target = position as usize;
    let mut line = 1u32;
    let mut column = 1u32;
    for (index, ch) in sql.chars().enumerate() {
        if index + 1 >= target {
            break;
        }
        if ch == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    (line, column)
}

// ── Dynamic row mapping (text protocol) ───────────────────────────────────────

fn row_to_json(row: &PgRow) -> Vec<JsonValue> {
    (0..row.len())
        .map(|index| column_to_json(row, index))
        .collect()
}

fn column_to_json(row: &PgRow, index: usize) -> JsonValue {
    let Ok(value) = row.try_get_raw(index) else {
        return JsonValue::Null;
    };
    if value.is_null() {
        return JsonValue::Null;
    }
    let type_name = value.type_info().name().to_ascii_uppercase();
    let Ok(text) = value.as_str() else {
        return JsonValue::Null;
    };
    match type_name.as_str() {
        "BOOL" => match text {
            "t" | "true" => JsonValue::Bool(true),
            "f" | "false" => JsonValue::Bool(false),
            _ => JsonValue::String(text.to_string()),
        },
        "INT2" | "INT4" | "INT8" => text
            .parse::<i64>()
            .map(JsonValue::from)
            .unwrap_or_else(|_| JsonValue::String(text.to_string())),
        "FLOAT4" | "FLOAT8" => text
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(JsonValue::Number)
            .unwrap_or_else(|| JsonValue::String(text.to_string())),
        // `numeric` is arbitrary precision; keep its exact text (a JSON number
        // is an f64 and would silently round).
        "NUMERIC" => JsonValue::String(text.to_string()),
        "JSON" | "JSONB" => {
            serde_json::from_str(text).unwrap_or_else(|_| JsonValue::String(text.to_string()))
        }
        "BYTEA" => parse_bytea(text),
        _ => JsonValue::String(text.to_string()),
    }
}

/// Decode PostgreSQL's text-format `bytea` (`\x<hex>`) into a JSON byte array.
fn parse_bytea(text: &str) -> JsonValue {
    let hex = text.strip_prefix("\\x").unwrap_or(text);
    if hex.is_empty() || !hex.len().is_multiple_of(2) {
        return JsonValue::String(text.to_string());
    }
    let raw = hex.as_bytes();
    let mut bytes = Vec::with_capacity(raw.len() / 2);
    let mut index = 0;
    while index < raw.len() {
        let pair = std::str::from_utf8(&raw[index..index + 2])
            .ok()
            .and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match pair {
            Some(byte) => bytes.push(byte),
            None => return JsonValue::String(text.to_string()),
        }
        index += 2;
    }
    JsonValue::Array(
        bytes
            .into_iter()
            .map(|byte| JsonValue::from(i64::from(byte)))
            .collect(),
    )
}

// ── Bounded result-set cache (R-3.3/R-3.4) ────────────────────────────────────

struct CachedResultSet {
    connection_id: String,
    columns: Vec<DbColumn>,
    rows: Vec<Vec<JsonValue>>,
    truncated: bool,
    duration_ms: u64,
}

/// A bounded, insertion-ordered cache of executed result sets. Pagination slices
/// a cached set without re-running the query (R-3.3).
#[derive(Default)]
pub(crate) struct ResultCache {
    map: HashMap<String, CachedResultSet>,
    order: VecDeque<String>,
}

impl ResultCache {
    /// Store a result set under a fresh id, evicting the oldest entries beyond
    /// [`MAX_CACHED_RESULT_SETS`].
    pub(crate) fn insert(
        &mut self,
        connection_id: String,
        id: String,
        columns: Vec<DbColumn>,
        rows: Vec<Vec<JsonValue>>,
        truncated: bool,
        duration_ms: u64,
    ) {
        if self.map.contains_key(&id) {
            self.order.retain(|existing| existing != &id);
        }
        self.map.insert(
            id.clone(),
            CachedResultSet {
                connection_id,
                columns,
                rows,
                truncated,
                duration_ms,
            },
        );
        self.order.push_back(id);
        while self.map.len() > MAX_CACHED_RESULT_SETS {
            match self.order.pop_front() {
                Some(oldest) => {
                    self.map.remove(&oldest);
                }
                None => break,
            }
        }
    }

    /// Number of cached result sets (test/diagnostic).
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.map.len()
    }

    /// Drop every cached result set belonging to `connection_id` (R-3.3/R-3.4
    /// memory bound). Called on `db_disconnect` and connection delete so a
    /// closed session's result rows are never retained.
    pub(crate) fn release_connection(&mut self, connection_id: &str) {
        let ids: Vec<String> = self
            .map
            .iter()
            .filter(|(_, set)| set.connection_id == connection_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.map.remove(&id);
            self.order.retain(|existing| existing != &id);
        }
    }

    /// Slice a page from a cached set. `None` when the id is unknown or belongs
    /// to a different connection.
    pub(crate) fn page(
        &self,
        connection_id: &str,
        id: &str,
        offset: usize,
        limit: usize,
    ) -> Option<DbResultSet> {
        let entry = self.map.get(id)?;
        if entry.connection_id != connection_id {
            return None;
        }
        let limit = if limit == 0 {
            DEFAULT_PAGE
        } else {
            limit.min(HARD_CAP)
        };
        let total = entry.rows.len();
        let start = offset.min(total);
        let end = (start + limit).min(total);
        Some(DbResultSet {
            result_set_id: id.to_string(),
            columns: entry.columns.clone(),
            rows: entry.rows[start..end].to_vec(),
            row_count_loaded: end,
            has_more: end < total,
            truncated: entry.truncated,
            duration_ms: entry.duration_ms,
        })
    }
}

fn result_cache() -> &'static Mutex<ResultCache> {
    static CACHE: OnceLock<Mutex<ResultCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(ResultCache::default()))
}

/// Release every cached result set for `connection_id` (R-3.3/R-3.4). Wired
/// into `db_disconnect` and connection delete so a closed session's rows are
/// reclaimed. A poisoned cache is ignored — there is nothing safe to release.
pub fn release_connection_results(connection_id: &str) {
    if let Ok(mut cache) = result_cache().lock() {
        cache.release_connection(connection_id);
    }
}

/// Insert a result set into the process-wide cache and return its id plus the
/// first page (R-3.3). `first_page` is the already-clamped request limit.
fn cache_result_set(
    connection_id: &str,
    columns: Vec<DbColumn>,
    rows: Vec<Vec<JsonValue>>,
    truncated: bool,
    duration_ms: u64,
    first_page: usize,
) -> (String, DbResultSet) {
    let id = Uuid::new_v4().to_string();
    let mut cache = result_cache().lock().expect("result cache poisoned");
    cache.insert(
        connection_id.to_string(),
        id.clone(),
        columns,
        rows,
        truncated,
        duration_ms,
    );
    let set = cache
        .page(connection_id, &id, 0, first_page)
        .expect("just-inserted result set");
    (id, set)
}

#[cfg(test)]
mod cache_release_tests {
    use super::*;

    fn insert(cache: &mut ResultCache, connection_id: &str, id: &str) {
        cache.insert(
            connection_id.to_string(),
            id.to_string(),
            Vec::new(),
            Vec::new(),
            false,
            0,
        );
    }

    #[test]
    fn release_connection_drops_only_that_connections_result_sets() {
        let mut cache = ResultCache::default();
        insert(&mut cache, "a", "r1");
        insert(&mut cache, "a", "r2");
        insert(&mut cache, "b", "r3");
        assert_eq!(cache.len(), 3);

        cache.release_connection("a");

        assert_eq!(cache.len(), 1);
        assert!(cache.page("a", "r1", 0, DEFAULT_PAGE).is_none());
        assert!(cache.page("a", "r2", 0, DEFAULT_PAGE).is_none());
        assert!(cache.page("b", "r3", 0, DEFAULT_PAGE).is_some());

        // The released ids are also gone from the eviction order, so a later
        // insert cannot resurrect or double-count them.
        insert(&mut cache, "c", "r4");
        assert_eq!(cache.len(), 2);
        assert!(cache.page("c", "r4", 0, DEFAULT_PAGE).is_some());
    }
}
