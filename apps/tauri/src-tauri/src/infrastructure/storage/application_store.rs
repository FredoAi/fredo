use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as JsonValue};
use sqlx::{Column as _, PgPool, Postgres, Row as _, TypeInfo as _};
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use super::engine::{quote_ident, EngineHandle, StoreEngine};

// ── Frozen on-disk identifiers (Spec #2956 AC4, NO-MIGRATE) ───────────────────

/// On-disk compatibility contract (Spec #2956 AC4, **NO-MIGRATE**).
///
/// The per-application physical table namespace is a serialized on-disk
/// contract with previously shipped installs. The prefix is **retained
/// verbatim**: renaming it would be a destructive PostgreSQL migration for zero
/// user benefit and would break existing databases. All table-name construction
/// references this constant; the unit tests pin its byte-identical output so a
/// future rename cannot silently diverge.
pub const LEGACY_TABLE_PREFIX: &str = "feature";

/// Frozen terminal-sessions table (`feature_terminal_sessions`): the
/// [`LEGACY_TABLE_PREFIX`] + the `terminal` application namespace + `sessions`.
/// Pinned by the unit tests below.
pub const LEGACY_TERMINAL_SESSIONS_TABLE: &str = "feature_terminal_sessions";

// ── Column Types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDef {
    pub name: String,
    pub col_type: ColumnType,
    #[serde(default)]
    pub nullable: bool,
    #[serde(default)]
    pub primary_key: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ColumnType {
    TEXT,
    INTEGER,
    REAL,
    BLOB,
}

impl ColumnType {
    /// The PostgreSQL type (Spec #2975 ST-4, the C1 map):
    /// `TEXT→text`, `INTEGER→bigint`, `REAL→double precision`, `BLOB→bytea`.
    ///
    /// Since Spec #2979 CU-2 the data plane is PostgreSQL-only, so this is the
    /// ONE physical type map for a declared column.
    pub(crate) fn as_pg_type(&self) -> &'static str {
        match self {
            ColumnType::TEXT => "text",
            ColumnType::INTEGER => "bigint",
            ColumnType::REAL => "double precision",
            ColumnType::BLOB => "bytea",
        }
    }
}

/// Map a PostgreSQL `information_schema.columns.data_type` to the shared
/// [`ColumnType`] affinity.
fn pg_data_type_to_column_type(data_type: &str) -> ColumnType {
    match data_type {
        "bigint" | "integer" | "smallint" => ColumnType::INTEGER,
        "double precision" | "real" | "numeric" => ColumnType::REAL,
        "bytea" => ColumnType::BLOB,
        _ => ColumnType::TEXT,
    }
}

/// Run one PostgreSQL future from a synchronous caller.
///
/// The migrated stores keep synchronous signatures because the RTDB canonical
/// ingest path and the `lib.rs` setup closure are synchronous boundaries that
/// this slice does not own. SQLite is executed fully synchronously on the shared
/// write connection (no bridge); the PostgreSQL branch is the only place the
/// bridge is entered, and it always runs inside the Tauri multi-threaded
/// runtime. The pool's own `acquire_timeout` (5 s) bounds every call (G-263).
pub(crate) fn block_on_pg<F: std::future::Future>(future: F) -> F::Output {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => tokio::task::block_in_place(|| handle.block_on(future)),
        Err(_) => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build a runtime for a synchronous PostgreSQL call")
            .block_on(future),
    }
}

// ── IPC Command Arg Structs ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureTableArgs {
    pub application_id: String,
    pub table_name: String,
    pub columns: Vec<ColumnDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertArgs {
    pub application_id: String,
    pub table_name: String,
    pub rows: Vec<serde_json::Map<String, JsonValue>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryArgs {
    pub application_id: String,
    pub table_name: String,
    #[serde(default)]
    pub where_cols: Option<serde_json::Map<String, JsonValue>>,
    #[serde(default)]
    pub order_by: Option<String>,
    #[serde(default)]
    pub limit: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateArgs {
    pub application_id: String,
    pub table_name: String,
    pub set_cols: serde_json::Map<String, JsonValue>,
    pub where_cols: serde_json::Map<String, JsonValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteArgs {
    pub application_id: String,
    pub table_name: String,
    pub where_cols: serde_json::Map<String, JsonValue>,
}

// ── ApplicationStore ──────────────────────────────────────────────────────────────

/// A generic, engine-selected store for application-scoped tables (Spec #2975 ST-4).
///
/// Each application gets its own namespace via `feature_{applicationId}_{tableName}`.
/// All operations validate that the table name matches the application's namespace
/// and route through the ONE shared [`EngineHandle`] — no per-store
/// `Mutex<Connection>`. Since Spec #2979 CU-2 the data plane is PostgreSQL-only:
/// identifiers are quoted, types use the C1 map (`TEXT→text`, `INTEGER→bigint`,
/// `REAL→double precision`, `BLOB→bytea`), and probes use the PostgreSQL catalogs
/// (`to_regclass`, `information_schema.columns`).
pub struct ApplicationStore {
    engine: Arc<EngineHandle>,
}

/// One physical column of an application-namespaced table, as reported by
/// `information_schema.columns`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PhysicalColumn {
    pub name: String,
    pub sql_type: String,
    pub col_type: ColumnType,
    pub not_null: bool,
    pub primary_key: bool,
}

// ── Dynamic-identifier validation (Spec #3075) ────────────────────────────────

/// A validated `ORDER BY`: exactly one physical column + a direction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedOrderBy {
    /// The physical column name, exactly as in `column_types` (case-sensitive).
    pub column: String,
    /// `true` = `DESC`, `false` = `ASC` (the default).
    pub descending: bool,
}

/// The typed rejection error for the dynamic-identifier surface (Spec #3075).
///
/// Every variant is raised BEFORE any SQL text is built, so a rejected call never
/// executes a statement. At the IPC boundary it surfaces as a `String`
/// (`map_err(|e| e.to_string())`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentifierError {
    /// `order_by` is not exactly `<column> [ASC|DESC]`.
    InvalidOrderBy {
        order_by: String,
        reason: &'static str,
    },
    /// `order_by` names a column the physical table does not have.
    UnknownOrderColumn { column: String },
    /// A `where_cols` key is not a physical column of the target table.
    UnknownWhereColumn { column: String },
    /// `application_id` / `table_name` holds a char outside `[A-Za-z0-9_-]`
    /// (or is empty).
    InvalidNamespaceIdentifier {
        kind: &'static str,
        value: String,
    },
}

impl std::fmt::Display for IdentifierError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IdentifierError::InvalidOrderBy { order_by, reason } => {
                write!(f, "invalid order_by {order_by:?}: {reason}")
            }
            IdentifierError::UnknownOrderColumn { column } => {
                write!(f, "unknown order_by column \"{column}\"")
            }
            IdentifierError::UnknownWhereColumn { column } => {
                write!(f, "unknown where column \"{column}\"")
            }
            IdentifierError::InvalidNamespaceIdentifier { kind, value } => write!(
                f,
                "invalid {kind} \"{value}\": only [A-Za-z0-9_-] is allowed"
            ),
        }
    }
}

impl std::error::Error for IdentifierError {}

impl ApplicationStore {
    /// Wrap the shared engine handle.
    pub fn open(engine: Arc<EngineHandle>) -> Result<Self> {
        Ok(ApplicationStore { engine })
    }

    /// Build the full table name: `feature_{applicationId}_{tableName}`.
    ///
    /// `feature_` is the frozen NO-MIGRATE on-disk prefix
    /// ([`LEGACY_TABLE_PREFIX`]); the output is byte-identical to the shipped
    /// generator.
    fn full_table_name(application_id: &str, table_name: &str) -> String {
        let sanitized = application_id.replace('-', "_");
        format!("{LEGACY_TABLE_PREFIX}_{}_{}", sanitized, table_name)
    }

    /// Validate that the given full table name is properly namespaced to the
    /// application. The ONLY source of a dynamic identifier.
    ///
    /// Spec #3075 (REQ-3.1): both components are charset-gated first, so a
    /// dynamic identifier can never carry SQL metacharacters — that makes the
    /// prefix check below meaningful rather than a tautology. `full_table_name`
    /// output is unchanged (byte-identical to the shipped generator).
    pub(crate) fn validate_namespace(application_id: &str, table_name: &str) -> Result<String> {
        Self::validate_identifier_charset("applicationId", application_id)?;
        Self::validate_identifier_charset("tableName", table_name)?;
        let sanitized = application_id.replace('-', "_");
        let full = Self::full_table_name(application_id, table_name);
        let expected_prefix = format!("{LEGACY_TABLE_PREFIX}_{}_", sanitized);
        if !full.starts_with(&expected_prefix) {
            bail!(
                "Table '{}' is not in the '{}' application namespace",
                full,
                application_id
            );
        }
        Ok(full)
    }

    /// Charset gate for one namespace component (Spec #3075, REQ-3.1): non-empty,
    /// and every character inside `[A-Za-z0-9_-]`.
    fn validate_identifier_charset(kind: &'static str, value: &str) -> Result<(), IdentifierError> {
        let valid = !value.is_empty()
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if valid {
            Ok(())
        } else {
            Err(IdentifierError::InvalidNamespaceIdentifier {
                kind,
                value: value.to_string(),
            })
        }
    }

    // ── REQ-1: ensure_table ────────────────────────────────────────────────────

    /// Create an application-namespaced table with typed columns (idempotent).
    pub fn ensure_table(
        &self,
        application_id: &str,
        table_name: &str,
        columns: &[ColumnDef],
    ) -> Result<()> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                Self::ensure_table_on_pg(&pg.pool, application_id, table_name, columns)
            }
        }
    }

    /// Create an application-namespaced table on a PostgreSQL pool (idempotent).
    ///
    /// The ONE PostgreSQL DDL-builder source: [`Self::ensure_table`]'s
    /// PostgreSQL arm and the startup schema-init registry (`lib.rs`, via
    /// `applications::terminal::persistence::ensure_table_on_pg`) both route here,
    /// so the table definition is never duplicated (NFR-6 spirit). The full
    /// table name is namespace-validated on entry.
    pub fn ensure_table_on_pg(
        pool: &PgPool,
        application_id: &str,
        table_name: &str,
        columns: &[ColumnDef],
    ) -> Result<()> {
        let full = Self::validate_namespace(application_id, table_name)?;
        let defs: Vec<String> = columns
            .iter()
            .map(|c| {
                let pk = if c.primary_key { " PRIMARY KEY" } else { "" };
                let nn = if !c.nullable && !c.primary_key {
                    " NOT NULL"
                } else {
                    ""
                };
                format!(
                    "{} {}{}{}",
                    quote_ident(&c.name),
                    c.col_type.as_pg_type(),
                    pk,
                    nn
                )
            })
            .collect();
        let sql = format!(
            "CREATE TABLE IF NOT EXISTS {} ({});",
            quote_ident(&full),
            defs.join(", ")
        );
        block_on_pg(async { sqlx::query(&sql).execute(pool).await.map(|_| ()) })?;
        Ok(())
    }

    /// Column-name → [`ColumnType`] for an application-namespaced table.
    fn column_types(&self, full_table: &str) -> Result<HashMap<String, ColumnType>> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => Self::column_types_pg(&pg.pool, full_table),
        }
    }

    fn column_types_pg(pool: &PgPool, full_table: &str) -> Result<HashMap<String, ColumnType>> {
        let rows: Vec<(String, String)> = block_on_pg(async {
            sqlx::query_as(
                "SELECT column_name, data_type FROM information_schema.columns
                 WHERE table_name = $1",
            )
            .bind(full_table)
            .fetch_all(pool)
            .await
        })?;
        Ok(rows
            .into_iter()
            .map(|(name, data_type)| (name, pg_data_type_to_column_type(&data_type)))
            .collect())
    }

    // ── REQ-2: insert (idempotent on a duplicate primary key) ──────────────────

    /// Insert rows. Returns the count of inserted rows. A duplicate primary key
    /// is silently ignored on both engines.
    pub fn insert(
        &self,
        application_id: &str,
        table_name: &str,
        rows: &[serde_json::Map<String, JsonValue>],
    ) -> Result<u64> {
        if rows.is_empty() {
            return Ok(0);
        }
        let full = Self::validate_namespace(application_id, table_name)?;
        let col_types = self.column_types(&full)?;
        let col_names: Vec<&str> = rows[0].keys().map(|s| s.as_str()).collect();
        if col_names.is_empty() {
            return Ok(0);
        }

        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let placeholders: Vec<String> =
                    (1..=col_names.len()).map(|i| format!("${i}")).collect();
                let cols = col_names
                    .iter()
                    .map(|c| quote_ident(c))
                    .collect::<Vec<_>>()
                    .join(", ");
                let sql = format!(
                    "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT DO NOTHING",
                    quote_ident(&full),
                    cols,
                    placeholders.join(", ")
                );
                block_on_pg(async {
                    let mut total = 0u64;
                    for row in rows {
                        let mut query = sqlx::query(&sql);
                        for name in &col_names {
                            query = pg_bind(
                                query,
                                row.get(*name).unwrap_or(&JsonValue::Null),
                                col_types.get(*name).copied(),
                            );
                        }
                        total += query.execute(&pg.pool).await?.rows_affected();
                    }
                    Ok(total)
                })
            }
        }
    }

    // ── REQ-2: upsert (INSERT ... ON CONFLICT DO UPDATE) ───────────────────────

    /// Upsert rows keyed by `primary_key`. Existing rows are UPDATED; the written
    /// column set is the deterministic union of the keys present across `rows`.
    pub fn upsert(
        &self,
        application_id: &str,
        table_name: &str,
        primary_key: &[String],
        rows: &[serde_json::Map<String, JsonValue>],
    ) -> Result<u64> {
        if rows.is_empty() {
            return Ok(0);
        }
        let full = Self::validate_namespace(application_id, table_name)?;
        let col_types = self.column_types(&full)?;

        let mut columns: Vec<&str> = Vec::new();
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        for row in rows {
            for key in row.keys() {
                if seen.insert(key.as_str()) {
                    columns.push(key.as_str());
                }
            }
        }

        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let placeholders: Vec<String> =
                    (1..=columns.len()).map(|i| format!("${i}")).collect();
                let cols = columns
                    .iter()
                    .map(|c| quote_ident(c))
                    .collect::<Vec<_>>()
                    .join(", ");
                let sql = if primary_key.is_empty() {
                    format!(
                        "INSERT INTO {} ({}) VALUES ({})",
                        quote_ident(&full),
                        cols,
                        placeholders.join(", ")
                    )
                } else {
                    let updates: Vec<String> = columns
                        .iter()
                        .filter(|c| !primary_key.iter().any(|pk| pk.as_str() == **c))
                        .map(|c| {
                            let quoted = quote_ident(c);
                            format!("{quoted} = EXCLUDED.{quoted}")
                        })
                        .collect();
                    let conflict_action = if updates.is_empty() {
                        "DO NOTHING".to_string()
                    } else {
                        format!("DO UPDATE SET {}", updates.join(", "))
                    };
                    let key_cols = primary_key
                        .iter()
                        .map(|k| quote_ident(k))
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!(
                        "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT({}) {}",
                        quote_ident(&full),
                        cols,
                        placeholders.join(", "),
                        key_cols,
                        conflict_action
                    )
                };
                block_on_pg(async {
                    let mut total = 0u64;
                    for row in rows {
                        let mut query = sqlx::query(&sql);
                        for name in &columns {
                            query = pg_bind(
                                query,
                                row.get(*name).unwrap_or(&JsonValue::Null),
                                col_types.get(*name).copied(),
                            );
                        }
                        total += query.execute(&pg.pool).await?.rows_affected();
                    }
                    Ok(total)
                })
            }
        }
    }

    // ── DDL/DML batch ─────────────────────────────────────────────────────────

    /// Execute a raw DDL/DML batch against the shared engine.
    ///
    /// Crate-internal: callers must only pass identifiers obtained from
    /// [`Self::validate_namespace`].
    pub(crate) fn execute_batch(&self, sql: &str) -> Result<()> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                block_on_pg(async { sqlx::raw_sql(sql).execute(&pg.pool).await.map(|_| ()) })?;
                Ok(())
            }
        }
    }

    // ── Probes ─────────────────────────────────────────────────────────────────

    /// `true` iff the given (already validated, fully-qualified) table exists.
    pub(crate) fn table_exists(&self, full_table: &str) -> Result<bool> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let found: Option<String> = block_on_pg(async {
                    sqlx::query_scalar("SELECT to_regclass($1)::text")
                        .bind(full_table)
                        .fetch_one(&pg.pool)
                        .await
                })?;
                Ok(found.is_some())
            }
        }
    }

    /// Physical schema of the given (fully-qualified) table: one entry per column
    /// in definition order. An absent table yields an empty `Vec`.
    pub(crate) fn table_schema(&self, full_table: &str) -> Result<Vec<PhysicalColumn>> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let rows: Vec<(String, String, String, bool)> = block_on_pg(async {
                    sqlx::query_as(
                        "SELECT c.column_name, c.data_type, c.is_nullable, COALESCE(pk.is_pk, false)
                         FROM information_schema.columns c
                         LEFT JOIN (
                             SELECT kcu.column_name, TRUE AS is_pk
                             FROM information_schema.table_constraints tc
                             JOIN information_schema.key_column_usage kcu
                               ON tc.constraint_name = kcu.constraint_name
                              AND tc.table_schema = kcu.table_schema
                             WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1
                         ) pk ON pk.column_name = c.column_name
                         WHERE c.table_name = $1
                         ORDER BY c.ordinal_position",
                    )
                    .bind(full_table)
                    .fetch_all(&pg.pool)
                    .await
                })?;
                Ok(rows
                    .into_iter()
                    .map(|(name, data_type, is_nullable, primary_key)| PhysicalColumn {
                        col_type: pg_data_type_to_column_type(&data_type),
                        sql_type: data_type,
                        name,
                        not_null: is_nullable == "NO",
                        primary_key,
                    })
                    .collect())
            }
        }
    }

    /// Row count of the given (fully-qualified) table.
    pub(crate) fn row_count(&self, full_table: &str) -> Result<i64> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let count = block_on_pg(async {
                    sqlx::query_scalar(&format!(
                        "SELECT COUNT(*) FROM {}",
                        quote_ident(full_table)
                    ))
                    .fetch_one(&pg.pool)
                    .await
                })?;
                Ok(count)
            }
        }
    }

    /// Physical column names of the given (fully-qualified) table.
    pub(crate) fn table_column_names(&self, full_table: &str) -> Result<Vec<String>> {
        Ok(self
            .table_schema(full_table)?
            .into_iter()
            .map(|column| column.name)
            .collect())
    }

    // ── REQ-3: dynamic ORDER BY validation (Spec #3075 ST-1) ──────────────────

    /// Parse + validate `order_by` against the table's physical columns.
    ///
    /// Grammar (Spec #3075, REQ-1/REQ-2): `<column> [ASC|DESC]` — whitespace-split,
    /// direction case-insensitive, default `ASC`. Zero tokens (including a
    /// whitespace-only string), two or more tokens after the direction, and a
    /// non-`ASC`/`DESC` direction are `InvalidOrderBy`; a single token that is not
    /// a physical column is `UnknownOrderColumn` (case-sensitive — `latestat` does
    /// NOT match the physical `latestAt`). Nothing is quoted or interpolated here.
    fn parse_order_by(
        order_by: &str,
        columns: &HashMap<String, ColumnType>,
    ) -> Result<ValidatedOrderBy, IdentifierError> {
        let mut tokens = order_by.split_whitespace();
        let Some(column) = tokens.next() else {
            return Err(IdentifierError::InvalidOrderBy {
                order_by: order_by.to_string(),
                reason: "expected exactly `<column> [ASC|DESC]`",
            });
        };
        let descending = match tokens.next() {
            None => false,
            Some(direction) if direction.eq_ignore_ascii_case("asc") => false,
            Some(direction) if direction.eq_ignore_ascii_case("desc") => true,
            Some(_) => {
                return Err(IdentifierError::InvalidOrderBy {
                    order_by: order_by.to_string(),
                    reason: "the direction must be ASC or DESC",
                });
            }
        };
        if tokens.next().is_some() {
            return Err(IdentifierError::InvalidOrderBy {
                order_by: order_by.to_string(),
                reason: "expected exactly one column and an optional direction",
            });
        }
        if !columns.contains_key(column) {
            return Err(IdentifierError::UnknownOrderColumn {
                column: column.to_string(),
            });
        }
        Ok(ValidatedOrderBy {
            column: column.to_string(),
            descending,
        })
    }

    /// Render a validated order-by as SQL text: `"<col>" ASC|DESC`.
    ///
    /// Spec #3075: the SINGLE quoting point for `ORDER BY` — quoting upstream (in
    /// `application_data::validated_order_by`) would double-quote and break the
    /// physical-column name check above.
    fn order_by_sql(order: &ValidatedOrderBy) -> String {
        format!(
            "{} {}",
            quote_ident(&order.column),
            if order.descending { "DESC" } else { "ASC" }
        )
    }

    // ── REQ-3: query ───────────────────────────────────────────────────────────

    /// Query rows with optional WHERE, ORDER BY, and LIMIT.
    pub fn query(
        &self,
        application_id: &str,
        table_name: &str,
        where_cols: Option<&serde_json::Map<String, JsonValue>>,
        order_by: Option<&str>,
        limit: Option<u64>,
    ) -> Result<Vec<serde_json::Map<String, JsonValue>>> {
        let full = Self::validate_namespace(application_id, table_name)?;
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let col_types = Self::column_types_pg(&pg.pool, &full)?;

                // Spec #3075 (REQ-1.1–1.5): reject an invalid `order_by` BEFORE
                // any SQL text is built. An absent/empty `order_by` still emits no
                // `ORDER BY` clause (REQ-1.6).
                let validated_order = match order_by {
                    Some(ob) if !ob.is_empty() => Some(Self::parse_order_by(ob, &col_types)?),
                    _ => None,
                };

                let mut sql = format!("SELECT * FROM {}", quote_ident(&full));
                if let Some(wc) = where_cols {
                    if !wc.is_empty() {
                        let clauses: Vec<String> = wc
                            .keys()
                            .enumerate()
                            .map(|(i, k)| format!("{} = ${}", quote_ident(k), i + 1))
                            .collect();
                        sql.push_str(&format!(" WHERE {}", clauses.join(" AND ")));
                    }
                }
                if let Some(order) = &validated_order {
                    sql.push_str(&format!(" ORDER BY {}", Self::order_by_sql(order)));
                }
                if let Some(lim) = limit {
                    sql.push_str(&format!(" LIMIT {}", lim));
                }
                block_on_pg(async {
                    let mut query = sqlx::query(&sql);
                    if let Some(wc) = where_cols {
                        if !wc.is_empty() {
                            for (k, val) in wc {
                                query = pg_bind(query, val, col_types.get(k).copied());
                            }
                        }
                    }
                    let rows = query.fetch_all(&pg.pool).await?;
                    rows.iter().map(pg_row_to_json).collect()
                })
            }
        }
    }

    // ── REQ-4: update ──────────────────────────────────────────────────────────

    /// Update rows matching WHERE. Returns the count of updated rows.
    pub fn update(
        &self,
        application_id: &str,
        table_name: &str,
        set_cols: &serde_json::Map<String, JsonValue>,
        where_cols: &serde_json::Map<String, JsonValue>,
    ) -> Result<u64> {
        let full = Self::validate_namespace(application_id, table_name)?;
        if set_cols.is_empty() {
            return Ok(0);
        }
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let col_types = Self::column_types_pg(&pg.pool, &full)?;
                let set_clauses: Vec<String> = set_cols
                    .keys()
                    .enumerate()
                    .map(|(i, k)| format!("{} = ${}", quote_ident(k), i + 1))
                    .collect();
                let offset = set_cols.len();
                let where_clauses: Vec<String> = where_cols
                    .keys()
                    .enumerate()
                    .map(|(i, k)| format!("{} = ${}", quote_ident(k), offset + i + 1))
                    .collect();
                let mut sql =
                    format!("UPDATE {} SET {}", quote_ident(&full), set_clauses.join(", "));
                if !where_clauses.is_empty() {
                    sql.push_str(&format!(" WHERE {}", where_clauses.join(" AND ")));
                }
                block_on_pg(async {
                    let mut query = sqlx::query(&sql);
                    for (k, val) in set_cols {
                        query = pg_bind(query, val, col_types.get(k).copied());
                    }
                    for (k, val) in where_cols {
                        query = pg_bind(query, val, col_types.get(k).copied());
                    }
                    Ok(query.execute(&pg.pool).await?.rows_affected())
                })
            }
        }
    }

    // ── REQ-5: delete ──────────────────────────────────────────────────────────

    /// Delete rows matching WHERE. Returns the count of deleted rows.
    pub fn delete(
        &self,
        application_id: &str,
        table_name: &str,
        where_cols: &serde_json::Map<String, JsonValue>,
    ) -> Result<u64> {
        let full = Self::validate_namespace(application_id, table_name)?;
        if where_cols.is_empty() {
            return Ok(0);
        }
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let col_types = Self::column_types_pg(&pg.pool, &full)?;
                let where_clauses: Vec<String> = where_cols
                    .keys()
                    .enumerate()
                    .map(|(i, k)| format!("{} = ${}", quote_ident(k), i + 1))
                    .collect();
                let sql = format!(
                    "DELETE FROM {} WHERE {}",
                    quote_ident(&full),
                    where_clauses.join(" AND ")
                );
                block_on_pg(async {
                    let mut query = sqlx::query(&sql);
                    for (k, val) in where_cols {
                        query = pg_bind(query, val, col_types.get(k).copied());
                    }
                    Ok(query.execute(&pg.pool).await?.rows_affected())
                })
            }
        }
    }
}

/// Bind one JSON value onto a PostgreSQL query, using the column's physical
/// affinity so NULLs and coerced values carry the right wire type.
fn pg_bind<'q>(
    query: sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments>,
    value: &'q JsonValue,
    col_type: Option<ColumnType>,
) -> sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments> {
    if value.is_null() {
        return match col_type {
            Some(ColumnType::INTEGER) => query.bind(None::<i64>),
            Some(ColumnType::REAL) => query.bind(None::<f64>),
            Some(ColumnType::BLOB) => query.bind(None::<Vec<u8>>),
            _ => query.bind(None::<String>),
        };
    }
    match col_type {
        Some(ColumnType::INTEGER) => query.bind(json_as_i64(value)),
        Some(ColumnType::REAL) => query.bind(json_as_f64(value)),
        Some(ColumnType::BLOB) => query.bind(json_as_blob(value)),
        Some(ColumnType::TEXT) => query.bind(json_as_text(value)),
        None => match value {
            JsonValue::String(s) => query.bind(s.clone()),
            JsonValue::Number(n) => {
                if let Some(i) = n.as_i64() {
                    query.bind(i)
                } else {
                    query.bind(n.as_f64().unwrap_or(0.0))
                }
            }
            JsonValue::Bool(b) => query.bind(*b),
            JsonValue::Array(_) | JsonValue::Object(_) => query.bind(value.to_string()),
            JsonValue::Null => query.bind(None::<String>),
        },
    }
}

fn json_as_i64(value: &JsonValue) -> i64 {
    match value {
        JsonValue::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .unwrap_or(0),
        JsonValue::Bool(b) => i64::from(*b),
        JsonValue::String(s) => s.parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

fn json_as_f64(value: &JsonValue) -> f64 {
    match value {
        JsonValue::Number(n) => n.as_f64().unwrap_or(0.0),
        JsonValue::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        JsonValue::String(s) => s.parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn json_as_blob(value: &JsonValue) -> Vec<u8> {
    match value {
        JsonValue::Array(arr) => arr
            .iter()
            .filter_map(|v| v.as_u64().map(|n| n as u8))
            .collect(),
        JsonValue::String(s) => s.as_bytes().to_vec(),
        _ => Vec::new(),
    }
}

fn json_as_text(value: &JsonValue) -> String {
    match value {
        JsonValue::String(s) => s.clone(),
        JsonValue::Bool(b) => {
            if *b {
                "1".to_string()
            } else {
                "0".to_string()
            }
        }
        JsonValue::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

/// Convert one PostgreSQL row to the JSON row shape the IPC surface returns.
fn pg_row_to_json(row: &sqlx::postgres::PgRow) -> Result<Map<String, JsonValue>> {
    let mut map = Map::new();
    for (idx, column) in row.columns().iter().enumerate() {
        let name = column.name().to_string();
        let type_name = column.type_info().name();
        let value: JsonValue = match type_name {
            "BOOL" => row
                .try_get::<Option<bool>, _>(idx)?
                .map(JsonValue::Bool)
                .unwrap_or(JsonValue::Null),
            "INT2" => row
                .try_get::<Option<i16>, _>(idx)?
                .map(|v| JsonValue::from(i64::from(v)))
                .unwrap_or(JsonValue::Null),
            "INT4" => row
                .try_get::<Option<i32>, _>(idx)?
                .map(|v| JsonValue::from(i64::from(v)))
                .unwrap_or(JsonValue::Null),
            "INT8" => row
                .try_get::<Option<i64>, _>(idx)?
                .map(JsonValue::from)
                .unwrap_or(JsonValue::Null),
            "FLOAT4" => row
                .try_get::<Option<f32>, _>(idx)?
                .and_then(|v| serde_json::Number::from_f64(f64::from(v)))
                .map(JsonValue::Number)
                .unwrap_or(JsonValue::Null),
            "FLOAT8" => row
                .try_get::<Option<f64>, _>(idx)?
                .and_then(serde_json::Number::from_f64)
                .map(JsonValue::Number)
                .unwrap_or(JsonValue::Null),
            "BYTEA" => row
                .try_get::<Option<Vec<u8>>, _>(idx)?
                .map(|bytes| {
                    JsonValue::Array(
                        bytes
                            .into_iter()
                            .map(|x| JsonValue::from(i64::from(x)))
                            .collect(),
                    )
                })
                .unwrap_or(JsonValue::Null),
            _ => row
                .try_get::<Option<String>, _>(idx)?
                .map(JsonValue::String)
                .unwrap_or(JsonValue::Null),
        };
        map.insert(name, value);
    }
    Ok(map)
}

// ── IPC Commands ──────────────────────────────────────────────────────────────

/// REQ-1: Create an application-namespaced table.
#[tauri::command]
pub fn application_store_ensure_table(
    state: tauri::State<'_, Arc<ApplicationStore>>,
    application_id: String,
    table_name: String,
    columns: Vec<ColumnDef>,
) -> Result<(), String> {
    state
        .ensure_table(&application_id, &table_name, &columns)
        .map_err(|e| e.to_string())
}

/// REQ-2: Insert rows into an application-namespaced table.
#[tauri::command]
pub async fn application_store_insert(
    state: tauri::State<'_, Arc<ApplicationStore>>,
    application_id: String,
    table_name: String,
    rows: Vec<serde_json::Map<String, JsonValue>>,
) -> Result<u64, String> {
    state
        .insert(&application_id, &table_name, &rows)
        .map_err(|e| e.to_string())
}

/// REQ-3: Query rows with optional WHERE, ORDER BY, LIMIT.
#[tauri::command]
pub fn application_store_query(
    state: tauri::State<'_, Arc<ApplicationStore>>,
    application_id: String,
    table_name: String,
    where_cols: Option<serde_json::Map<String, JsonValue>>,
    order_by: Option<String>,
    limit: Option<u64>,
) -> Result<Vec<serde_json::Map<String, JsonValue>>, String> {
    state
        .query(
            &application_id,
            &table_name,
            where_cols.as_ref(),
            order_by.as_deref(),
            limit,
        )
        .map_err(|e| e.to_string())
}

/// REQ-4: Update rows matching WHERE clause.
#[tauri::command]
pub async fn application_store_update(
    state: tauri::State<'_, Arc<ApplicationStore>>,
    application_id: String,
    table_name: String,
    set_cols: serde_json::Map<String, JsonValue>,
    where_cols: serde_json::Map<String, JsonValue>,
) -> Result<u64, String> {
    state
        .update(&application_id, &table_name, &set_cols, &where_cols)
        .map_err(|e| e.to_string())
}

/// REQ-5: Delete rows matching WHERE clause.
#[tauri::command]
pub async fn application_store_delete(
    state: tauri::State<'_, Arc<ApplicationStore>>,
    application_id: String,
    table_name: String,
    where_cols: serde_json::Map<String, JsonValue>,
) -> Result<u64, String> {
    state
        .delete(&application_id, &table_name, &where_cols)
        .map_err(|e| e.to_string())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// The physical-column set the order/where validators are pinned against.
    fn test_columns() -> HashMap<String, ColumnType> {
        HashMap::from([
            ("id".to_string(), ColumnType::TEXT),
            ("latestAt".to_string(), ColumnType::TEXT),
            ("last_active_at".to_string(), ColumnType::TEXT),
            ("_updated_at".to_string(), ColumnType::TEXT),
        ])
    }

    #[test]
    fn per_app_table_prefix_generator_is_byte_identical() {
        // Spec #2956 AC4 (NO-MIGRATE): the generator output is the shipped
        // on-disk contract and must stay byte-identical.
        assert_eq!(LEGACY_TABLE_PREFIX, "feature");

        // Dash sanitization + prefix, exactly as shipped.
        assert_eq!(
            ApplicationStore::full_table_name("mission-monitor", "sessions"),
            "feature_mission_monitor_sessions"
        );

        // The terminal sessions table (namespace `terminal`, table `sessions`)
        // resolves to the frozen literal.
        assert_eq!(
            ApplicationStore::full_table_name("terminal", "sessions"),
            LEGACY_TERMINAL_SESSIONS_TABLE
        );
        assert_eq!(LEGACY_TERMINAL_SESSIONS_TABLE, "feature_terminal_sessions");
    }

    #[test]
    fn namespace_validation_uses_the_frozen_prefix() {
        assert_eq!(
            ApplicationStore::validate_namespace("mission-monitor", "sessions").unwrap(),
            "feature_mission_monitor_sessions"
        );
    }

    // ── Spec #3075 ST-1: order_by parse + validate + quote ───────────────────

    #[test]
    fn parse_order_by_defaults_to_ascending_and_accepts_both_directions() {
        let cols = test_columns();
        assert_eq!(
            ApplicationStore::parse_order_by("id", &cols).unwrap(),
            ValidatedOrderBy {
                column: "id".to_string(),
                descending: false,
            }
        );
        for (input, descending) in [
            ("id ASC", false),
            ("id asc", false),
            ("id AsC", false),
            ("id  ASC", false),
            ("id\tASC", false),
            ("id DESC", true),
            ("id desc", true),
            ("id  desc", true),
        ] {
            assert_eq!(
                ApplicationStore::parse_order_by(input, &cols).unwrap(),
                ValidatedOrderBy {
                    column: "id".to_string(),
                    descending,
                },
                "{input:?}"
            );
        }
    }

    #[test]
    fn parse_order_by_rejects_statement_terminators_and_extra_tokens() {
        let cols = test_columns();
        for payload in [
            "id; DROP TABLE feature_mission_monitor_sessions",
            "id ;",
            "id\n;",
            "id\n; DROP TABLE x",
            "id; DROP TABLE x; --",
        ] {
            assert!(
                matches!(
                    ApplicationStore::parse_order_by(payload, &cols),
                    Err(IdentifierError::InvalidOrderBy { .. })
                ),
                "{payload:?} must be InvalidOrderBy"
            );
        }
        for payload in ["id;", "id;--"] {
            assert_eq!(
                ApplicationStore::parse_order_by(payload, &cols),
                Err(IdentifierError::UnknownOrderColumn {
                    column: payload.to_string(),
                }),
                "{payload:?}"
            );
        }
    }

    #[test]
    fn parse_order_by_rejects_parens_and_subqueries() {
        let cols = test_columns();
        assert_eq!(
            ApplicationStore::parse_order_by("id)", &cols),
            Err(IdentifierError::UnknownOrderColumn {
                column: "id)".to_string(),
            })
        );
        // A single-token function call (no whitespace) is an unknown column.
        assert_eq!(
            ApplicationStore::parse_order_by("pg_read_file('/etc/passwd')", &cols),
            Err(IdentifierError::UnknownOrderColumn {
                column: "pg_read_file('/etc/passwd')".to_string(),
            })
        );
        for payload in [
            "id) DROP TABLE x",
            "(SELECT 1)",
            "id, (SELECT 1)",
            "(SELECT pg_read_file('/etc/passwd'))",
        ] {
            assert!(
                matches!(
                    ApplicationStore::parse_order_by(payload, &cols),
                    Err(IdentifierError::InvalidOrderBy { .. })
                ),
                "{payload:?} must be InvalidOrderBy"
            );
        }
    }

    #[test]
    fn parse_order_by_rejects_multi_column_payloads() {
        let cols = test_columns();
        for payload in ["a, b", "a , b"] {
            assert!(
                matches!(
                    ApplicationStore::parse_order_by(payload, &cols),
                    Err(IdentifierError::InvalidOrderBy { .. })
                ),
                "{payload:?} must be InvalidOrderBy"
            );
        }
        for payload in ["a,b", "id,"] {
            assert_eq!(
                ApplicationStore::parse_order_by(payload, &cols),
                Err(IdentifierError::UnknownOrderColumn {
                    column: payload.to_string(),
                }),
                "{payload:?}"
            );
        }
    }

    #[test]
    fn parse_order_by_rejects_bad_directions_and_a_third_token() {
        let cols = test_columns();
        for payload in ["id SIDEWAYS", "id ASC extra", "id ASC, DESC"] {
            assert!(
                matches!(
                    ApplicationStore::parse_order_by(payload, &cols),
                    Err(IdentifierError::InvalidOrderBy { .. })
                ),
                "{payload:?} must be InvalidOrderBy"
            );
        }
    }

    #[test]
    fn parse_order_by_rejects_unknown_columns_case_sensitively() {
        let cols = test_columns();
        for payload in ["nope", "ID", "latestat"] {
            assert_eq!(
                ApplicationStore::parse_order_by(payload, &cols),
                Err(IdentifierError::UnknownOrderColumn {
                    column: payload.to_string(),
                }),
                "physical columns are case-sensitive: {payload:?}"
            );
        }
        let error = ApplicationStore::parse_order_by("nope", &cols).unwrap_err();
        assert!(error.to_string().contains("nope"), "{error}");
    }

    #[test]
    fn parse_order_by_rejects_empty_and_whitespace_only_input() {
        let cols = test_columns();
        for payload in ["", "   ", "\t", "\n", " \t\n "] {
            assert!(
                matches!(
                    ApplicationStore::parse_order_by(payload, &cols),
                    Err(IdentifierError::InvalidOrderBy { .. })
                ),
                "{payload:?} must be a typed rejection (never a bare ORDER BY)"
            );
        }
    }

    #[test]
    fn order_by_sql_quotes_the_exact_camel_case_column() {
        let cols = test_columns();
        let order = ApplicationStore::parse_order_by("latestAt", &cols).unwrap();
        assert_eq!(
            order,
            ValidatedOrderBy {
                column: "latestAt".to_string(),
                descending: false,
            }
        );
        assert_eq!(ApplicationStore::order_by_sql(&order), "\"latestAt\" ASC");

        let order = ApplicationStore::parse_order_by("latestAt DESC", &cols).unwrap();
        assert_eq!(ApplicationStore::order_by_sql(&order), "\"latestAt\" DESC");

        let order = ApplicationStore::parse_order_by("id", &cols).unwrap();
        assert_eq!(ApplicationStore::order_by_sql(&order), "\"id\" ASC");
    }

    // ── Spec #3075 ST-2: namespace charset gate ──────────────────────────────

    #[test]
    fn validate_identifier_charset_gates_the_namespace_charset() {
        for ok in [
            "mission-monitor",
            "app_1",
            "App-2",
            "doom",
            "terminal",
            "sessions",
            "save",
            "deleted_sessions",
            "terminal_sessions",
        ] {
            assert_eq!(
                ApplicationStore::validate_identifier_charset("applicationId", ok),
                Ok(()),
                "{ok:?} must be accepted"
            );
        }
        for bad in [
            "a b",
            "app;drop",
            "app\"",
            "",
            "app.dot",
            "app/slash",
            "app\nline",
            "appü",
            "app'",
            "app)",
        ] {
            assert_eq!(
                ApplicationStore::validate_identifier_charset("applicationId", bad),
                Err(IdentifierError::InvalidNamespaceIdentifier {
                    kind: "applicationId",
                    value: bad.to_string(),
                }),
                "{bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn validate_namespace_rejects_out_of_charset_identifiers() {
        for bad_application in ["a b", "app;drop", "app\"", "", "app.dot", "app/slash", "appü"]
        {
            let error = ApplicationStore::validate_namespace(bad_application, "sessions")
                .expect_err("an out-of-charset application_id must be rejected");
            assert!(
                error.to_string().contains("applicationId"),
                "{bad_application:?}: {error}"
            );
        }
        for bad_table in ["a b", "app;drop", "", "app.dot", "app/slash", "appü"] {
            let error = ApplicationStore::validate_namespace("mission-monitor", bad_table)
                .expect_err("an out-of-charset table_name must be rejected");
            assert!(
                error.to_string().contains("tableName"),
                "{bad_table:?}: {error}"
            );
        }
    }

    #[test]
    fn validate_namespace_keeps_the_byte_identical_full_names() {
        for (application, table, expected) in [
            (
                "mission-monitor",
                "sessions",
                "feature_mission_monitor_sessions",
            ),
            ("doom", "save", "feature_doom_save"),
            ("terminal", "sessions", "feature_terminal_sessions"),
            (
                "mission-monitor",
                "deleted_sessions",
                "feature_mission_monitor_deleted_sessions",
            ),
        ] {
            assert_eq!(
                ApplicationStore::full_table_name(application, table),
                expected,
                "the generator output is the frozen on-disk contract"
            );
            assert_eq!(
                ApplicationStore::validate_namespace(application, table).unwrap(),
                expected
            );
        }
        assert_eq!(
            ApplicationStore::validate_namespace("terminal", "sessions").unwrap(),
            LEGACY_TERMINAL_SESSIONS_TABLE
        );
    }
}
