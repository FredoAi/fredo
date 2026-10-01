use anyhow::{bail, Result};
use rusqlite::{params, types::Value as SqlValue, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as JsonValue};
use sqlx::{Column as _, PgPool, Postgres, Row as _, TypeInfo as _};
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use super::engine::{quote_ident, Dialect, EngineHandle, StoreEngine};

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
    fn as_sql_type(&self) -> &'static str {
        match self {
            ColumnType::TEXT => "TEXT",
            ColumnType::INTEGER => "INTEGER",
            ColumnType::REAL => "REAL",
            ColumnType::BLOB => "BLOB",
        }
    }

    /// The PostgreSQL type (Spec #2975 ST-4, the C1 map):
    /// `TEXT→text`, `INTEGER→bigint`, `REAL→double precision`, `BLOB→bytea`.
    fn as_pg_type(&self) -> &'static str {
        match self {
            ColumnType::TEXT => "text",
            ColumnType::INTEGER => "bigint",
            ColumnType::REAL => "double precision",
            ColumnType::BLOB => "bytea",
        }
    }

    /// The physical SQL type for the active [`Dialect`] (Spec #2975 ST-4 rework).
    ///
    /// This is the ONE dialect-aware type selector: SQLite keeps the incumbent
    /// physical names (`pragma_table_info` must stay `INTEGER`/`REAL`/`TEXT`),
    /// while PostgreSQL uses the existing C1 map (`bigint`/`double precision`/
    /// `text` — a ns-epoch `startedAtNs` cannot fit int4). It delegates to the
    /// two maps already in this module; it is **not** a second type map.
    pub(crate) fn as_sql_type_for(&self, dialect: Dialect) -> &'static str {
        match dialect {
            Dialect::Sqlite => self.as_sql_type(),
            Dialect::Postgres => self.as_pg_type(),
        }
    }
}

/// Map a PostgreSQL `information_schema.columns.data_type` to the shared
/// [`ColumnType`] affinity, mirroring [`FeatureStore::normalize_column_type`].
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
    pub feature_id: String,
    pub table_name: String,
    pub columns: Vec<ColumnDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertArgs {
    pub feature_id: String,
    pub table_name: String,
    pub rows: Vec<serde_json::Map<String, JsonValue>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryArgs {
    pub feature_id: String,
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
    pub feature_id: String,
    pub table_name: String,
    pub set_cols: serde_json::Map<String, JsonValue>,
    pub where_cols: serde_json::Map<String, JsonValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteArgs {
    pub feature_id: String,
    pub table_name: String,
    pub where_cols: serde_json::Map<String, JsonValue>,
}

// ── FeatureStore ──────────────────────────────────────────────────────────────

/// A generic, engine-selected store for feature-scoped tables (Spec #2975 ST-4).
///
/// Each feature gets its own namespace via `feature_{featureId}_{tableName}`.
/// All operations validate that the table name matches the feature's namespace
/// and route through the ONE shared [`EngineHandle`] — no per-store
/// `Mutex<Connection>`. SQLite keeps the exact incumbent statements; PostgreSQL
/// uses the 1:1 translation (`TEXT→text`, `INTEGER→bigint`, `REAL→double
/// precision`, `BLOB→bytea`; `INSERT OR IGNORE → ON CONFLICT DO NOTHING`;
/// `excluded. → EXCLUDED.`; `sqlite_master → to_regclass`;
/// `pragma_table_info → information_schema.columns`; quoted identifiers).
pub struct FeatureStore {
    engine: Arc<EngineHandle>,
}

/// One physical column of a feature-namespaced table, as reported by
/// `pragma_table_info` / `information_schema.columns`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PhysicalColumn {
    pub name: String,
    pub sql_type: String,
    pub col_type: ColumnType,
    pub not_null: bool,
    pub primary_key: bool,
}

impl FeatureStore {
    /// Wrap the shared engine handle.
    pub fn open(engine: Arc<EngineHandle>) -> Result<Self> {
        Ok(FeatureStore { engine })
    }

    /// The SQL dialect the active engine speaks (Spec #2975 ST-4 rework).
    ///
    /// Delegates to the isolated [`EngineHandle::engine`] snapshot's
    /// [`StoreEngine::dialect`], so a caller that must emit dialect-specific SQL
    /// (the declared-table DDL type token) branches on the SAME engine the DML
    /// path targets.
    pub(crate) fn dialect(&self) -> Dialect {
        self.engine.engine().dialect()
    }

    /// Test-only convenience: a SQLite-backed store at `<data_dir>/fredo.db`.
    #[cfg(test)]
    pub fn open_sqlite_for_tests(data_dir: std::path::PathBuf) -> Result<Self> {
        let sqlite =
            crate::infrastructure::storage::engine::SqliteEngine::open(&data_dir.join("fredo.db"))?;
        Self::open(EngineHandle::new(StoreEngine::Sqlite(sqlite)))
    }

    /// Build the full table name: `feature_{featureId}_{tableName}`.
    fn full_table_name(feature_id: &str, table_name: &str) -> String {
        let sanitized = feature_id.replace('-', "_");
        format!("feature_{}_{}", sanitized, table_name)
    }

    /// Validate that the given full table name is properly namespaced to the
    /// feature. The ONLY source of a dynamic identifier.
    pub(crate) fn validate_namespace(feature_id: &str, table_name: &str) -> Result<String> {
        let sanitized = feature_id.replace('-', "_");
        let full = Self::full_table_name(feature_id, table_name);
        let expected_prefix = format!("feature_{}_", sanitized);
        if !full.starts_with(&expected_prefix) {
            bail!(
                "Table '{}' is not in the '{}' feature namespace",
                full,
                feature_id
            );
        }
        Ok(full)
    }

    /// Normalize a raw physical type string to a [`ColumnType`].
    ///
    /// The ONE source-affinity map: the engine-selected store and the one-shot
    /// `fredo.db` → PostgreSQL migration (`storage::migration`) both read a
    /// physical type string through this function, so a source table's derived
    /// target DDL can never diverge from the store's own table creation.
    pub(crate) fn normalize_column_type(type_str: &str) -> ColumnType {
        match type_str.to_uppercase().as_str() {
            "INTEGER" => ColumnType::INTEGER,
            "REAL" => ColumnType::REAL,
            "BLOB" => ColumnType::BLOB,
            _ => ColumnType::TEXT,
        }
    }

    // ── SQLite value bridge (unchanged) ────────────────────────────────────────

    fn json_to_sql(val: &JsonValue, col_type: Option<&ColumnType>) -> SqlValue {
        match val {
            JsonValue::String(s) => SqlValue::Text(s.clone()),
            JsonValue::Number(n) => {
                if let Some(i) = n.as_i64() {
                    SqlValue::Integer(i)
                } else {
                    SqlValue::Real(n.as_f64().unwrap_or(0.0))
                }
            }
            JsonValue::Bool(b) => SqlValue::Integer(*b as i64),
            JsonValue::Null => SqlValue::Null,
            JsonValue::Array(arr) => {
                if let Some(ColumnType::BLOB) = col_type {
                    let bytes: Vec<u8> = arr
                        .iter()
                        .filter_map(|v| v.as_u64().map(|n| n as u8))
                        .collect();
                    SqlValue::Blob(bytes)
                } else {
                    SqlValue::Text(val.to_string())
                }
            }
            JsonValue::Object(_) => SqlValue::Text(val.to_string()),
        }
    }

    fn sql_to_json(val: &SqlValue) -> JsonValue {
        match val {
            SqlValue::Null => JsonValue::Null,
            SqlValue::Integer(i) => JsonValue::Number((*i).into()),
            SqlValue::Real(f) => {
                if let Some(n) = serde_json::Number::from_f64(*f) {
                    JsonValue::Number(n)
                } else {
                    JsonValue::Null
                }
            }
            SqlValue::Text(s) => JsonValue::String(s.clone()),
            SqlValue::Blob(b) => {
                JsonValue::Array(b.iter().map(|&x| JsonValue::Number(x.into())).collect())
            }
        }
    }

    // ── REQ-1: ensure_table ────────────────────────────────────────────────────

    /// Create a feature-namespaced table with typed columns (idempotent).
    pub fn ensure_table(
        &self,
        feature_id: &str,
        table_name: &str,
        columns: &[ColumnDef],
    ) -> Result<()> {
        let full = Self::validate_namespace(feature_id, table_name)?;
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let defs: Vec<String> = columns
                    .iter()
                    .map(|c| {
                        let pk = if c.primary_key { " PRIMARY KEY" } else { "" };
                        let nn = if !c.nullable && !c.primary_key {
                            " NOT NULL"
                        } else {
                            ""
                        };
                        format!("{} {}{}{}", c.name, c.col_type.as_sql_type(), pk, nn)
                    })
                    .collect();
                let conn = engine.write_conn();
                conn.execute_batch(&format!(
                    "CREATE TABLE IF NOT EXISTS {} ({});",
                    full,
                    defs.join(", ")
                ))?;
                Ok(())
            }
            StoreEngine::Postgres(pg) => {
                Self::ensure_table_on_pg(&pg.pool, feature_id, table_name, columns)
            }
        }
    }

    /// Create a feature-namespaced table on a PostgreSQL pool (idempotent).
    ///
    /// The ONE PostgreSQL DDL-builder source: [`Self::ensure_table`]'s
    /// PostgreSQL arm and the startup schema-init registry (`lib.rs`, via
    /// `features::terminal::persistence::ensure_table_on_pg`) both route here,
    /// so the table definition is never duplicated (NFR-6 spirit). The full
    /// table name is namespace-validated on entry.
    pub fn ensure_table_on_pg(
        pool: &PgPool,
        feature_id: &str,
        table_name: &str,
        columns: &[ColumnDef],
    ) -> Result<()> {
        let full = Self::validate_namespace(feature_id, table_name)?;
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

    /// Column-name → [`ColumnType`] for a feature-namespaced table.
    fn column_types(&self, full_table: &str) -> Result<HashMap<String, ColumnType>> {
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let conn = engine.write_conn();
                Self::column_types_sqlite(&conn, full_table)
            }
            StoreEngine::Postgres(pg) => Self::column_types_pg(&pg.pool, full_table),
        }
    }

    fn column_types_sqlite(
        conn: &Connection,
        full_table: &str,
    ) -> Result<HashMap<String, ColumnType>> {
        let mut stmt = conn.prepare("SELECT name, type FROM pragma_table_info(?1)")?;
        let rows: Vec<(String, String)> = stmt
            .query_map(params![full_table], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .map(|(name, type_str)| (name, Self::normalize_column_type(&type_str)))
            .collect())
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
        feature_id: &str,
        table_name: &str,
        rows: &[serde_json::Map<String, JsonValue>],
    ) -> Result<u64> {
        if rows.is_empty() {
            return Ok(0);
        }
        let full = Self::validate_namespace(feature_id, table_name)?;
        let col_types = self.column_types(&full)?;
        let col_names: Vec<&str> = rows[0].keys().map(|s| s.as_str()).collect();
        if col_names.is_empty() {
            return Ok(0);
        }

        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let conn = engine.write_conn();
                let placeholders: Vec<String> =
                    col_names.iter().map(|_| "?".to_string()).collect();
                let sql = format!(
                    "INSERT OR IGNORE INTO {} ({}) VALUES ({})",
                    full,
                    col_names.join(", "),
                    placeholders.join(", ")
                );
                let mut total = 0u64;
                for row in rows {
                    let values: Vec<SqlValue> = col_names
                        .iter()
                        .map(|&name| {
                            Self::json_to_sql(
                                row.get(name).unwrap_or(&JsonValue::Null),
                                col_types.get(name),
                            )
                        })
                        .collect();
                    let params: Vec<&dyn rusqlite::types::ToSql> =
                        values.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();
                    total += conn.execute(&sql, params.as_slice())? as u64;
                }
                Ok(total)
            }
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
        feature_id: &str,
        table_name: &str,
        primary_key: &[String],
        rows: &[serde_json::Map<String, JsonValue>],
    ) -> Result<u64> {
        if rows.is_empty() {
            return Ok(0);
        }
        let full = Self::validate_namespace(feature_id, table_name)?;
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

        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let conn = engine.write_conn();
                let placeholders: Vec<String> =
                    (1..=columns.len()).map(|i| format!("?{i}")).collect();
                let sql = if primary_key.is_empty() {
                    format!(
                        "INSERT INTO {} ({}) VALUES ({})",
                        full,
                        columns.join(", "),
                        placeholders.join(", ")
                    )
                } else {
                    let updates: Vec<String> = columns
                        .iter()
                        .filter(|c| !primary_key.iter().any(|pk| pk.as_str() == **c))
                        .map(|c| format!("{c} = excluded.{c}"))
                        .collect();
                    let conflict_action = if updates.is_empty() {
                        "DO NOTHING".to_string()
                    } else {
                        format!("DO UPDATE SET {}", updates.join(", "))
                    };
                    format!(
                        "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT({}) {}",
                        full,
                        columns.join(", "),
                        placeholders.join(", "),
                        primary_key.join(", "),
                        conflict_action
                    )
                };
                let mut stmt = conn.prepare(&sql)?;
                let mut total = 0u64;
                for row in rows {
                    let values: Vec<SqlValue> = columns
                        .iter()
                        .map(|&name| {
                            Self::json_to_sql(
                                row.get(name).unwrap_or(&JsonValue::Null),
                                col_types.get(name),
                            )
                        })
                        .collect();
                    let params: Vec<&dyn rusqlite::types::ToSql> =
                        values.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();
                    total += stmt.execute(params.as_slice())? as u64;
                }
                Ok(total)
            }
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
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                engine.write_conn().execute_batch(sql)?;
                Ok(())
            }
            StoreEngine::Postgres(pg) => {
                block_on_pg(async { sqlx::raw_sql(sql).execute(&pg.pool).await.map(|_| ()) })?;
                Ok(())
            }
        }
    }

    // ── Probes ─────────────────────────────────────────────────────────────────

    /// `true` iff the given (already validated, fully-qualified) table exists.
    pub(crate) fn table_exists(&self, full_table: &str) -> Result<bool> {
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let conn = engine.write_conn();
                let found: Option<i64> = conn
                    .query_row(
                        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
                        params![full_table],
                        |row| row.get(0),
                    )
                    .optional()?;
                Ok(found.is_some())
            }
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
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let conn = engine.write_conn();
                let mut stmt =
                    conn.prepare("SELECT name, type, `notnull`, pk FROM pragma_table_info(?1)")?;
                let columns = stmt
                    .query_map(params![full_table], |row| {
                        let name: String = row.get(0)?;
                        let sql_type: String = row.get(1)?;
                        Ok(PhysicalColumn {
                            name,
                            col_type: Self::normalize_column_type(&sql_type),
                            sql_type,
                            not_null: row.get::<_, i64>(2)? != 0,
                            primary_key: row.get::<_, i64>(3)? != 0,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(columns)
            }
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
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let conn = engine.write_conn();
                let count: i64 = conn.query_row(
                    &format!("SELECT COUNT(*) FROM {}", full_table),
                    [],
                    |row| row.get(0),
                )?;
                Ok(count)
            }
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

    // ── REQ-3: query ───────────────────────────────────────────────────────────

    /// Query rows with optional WHERE, ORDER BY, and LIMIT.
    pub fn query(
        &self,
        feature_id: &str,
        table_name: &str,
        where_cols: Option<&serde_json::Map<String, JsonValue>>,
        order_by: Option<&str>,
        limit: Option<u64>,
    ) -> Result<Vec<serde_json::Map<String, JsonValue>>> {
        let full = Self::validate_namespace(feature_id, table_name)?;
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let conn = engine.write_conn();
                let mut sql = format!("SELECT * FROM {}", full);
                let mut values: Vec<SqlValue> = Vec::new();

                if let Some(wc) = where_cols {
                    if !wc.is_empty() {
                        let clauses: Vec<String> = wc
                            .keys()
                            .enumerate()
                            .map(|(i, k)| format!("{} = ?{}", k, i + 1))
                            .collect();
                        sql.push_str(&format!(" WHERE {}", clauses.join(" AND ")));
                        for val in wc.values() {
                            values.push(Self::json_to_sql(val, None));
                        }
                    }
                }
                if let Some(ob) = order_by {
                    if !ob.is_empty() {
                        sql.push_str(&format!(" ORDER BY {}", ob));
                    }
                }
                if let Some(lim) = limit {
                    sql.push_str(&format!(" LIMIT {}", lim));
                }

                let mut stmt = conn.prepare(&sql)?;
                let params: Vec<&dyn rusqlite::types::ToSql> =
                    values.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();
                let column_count = stmt.column_count();
                let column_names: Vec<String> = (0..column_count)
                    .map(|i| stmt.column_name(i).unwrap().to_string())
                    .collect();
                let rows_iter = stmt.query_map(params.as_slice(), |row| {
                    let mut map = serde_json::Map::new();
                    for (idx, name) in column_names.iter().enumerate() {
                        let sql_val: SqlValue = row.get::<_, SqlValue>(idx)?;
                        map.insert(name.clone(), Self::sql_to_json(&sql_val));
                    }
                    Ok(map)
                })?;
                let mut result = Vec::new();
                for row in rows_iter {
                    result.push(row?);
                }
                Ok(result)
            }
            StoreEngine::Postgres(pg) => {
                let col_types = Self::column_types_pg(&pg.pool, &full)?;
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
                if let Some(ob) = order_by {
                    if !ob.is_empty() {
                        sql.push_str(&format!(" ORDER BY {}", ob));
                    }
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
        feature_id: &str,
        table_name: &str,
        set_cols: &serde_json::Map<String, JsonValue>,
        where_cols: &serde_json::Map<String, JsonValue>,
    ) -> Result<u64> {
        let full = Self::validate_namespace(feature_id, table_name)?;
        if set_cols.is_empty() {
            return Ok(0);
        }
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let set_clauses: Vec<String> = set_cols
                    .keys()
                    .enumerate()
                    .map(|(i, k)| format!("{} = ?{}", k, i + 1))
                    .collect();
                let offset = set_cols.len();
                let where_clauses: Vec<String> = where_cols
                    .keys()
                    .enumerate()
                    .map(|(i, k)| format!("{} = ?{}", k, offset + i + 1))
                    .collect();
                let mut sql = format!("UPDATE {} SET {}", full, set_clauses.join(", "));
                if !where_clauses.is_empty() {
                    sql.push_str(&format!(" WHERE {}", where_clauses.join(" AND ")));
                }
                let conn = engine.write_conn();
                let mut stmt = conn.prepare(&sql)?;
                let mut all_values: Vec<SqlValue> = Vec::new();
                for val in set_cols.values() {
                    all_values.push(Self::json_to_sql(val, None));
                }
                for val in where_cols.values() {
                    all_values.push(Self::json_to_sql(val, None));
                }
                let params: Vec<&dyn rusqlite::types::ToSql> =
                    all_values.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();
                Ok(stmt.execute(params.as_slice())? as u64)
            }
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
        feature_id: &str,
        table_name: &str,
        where_cols: &serde_json::Map<String, JsonValue>,
    ) -> Result<u64> {
        let full = Self::validate_namespace(feature_id, table_name)?;
        if where_cols.is_empty() {
            return Ok(0);
        }
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let where_clauses: Vec<String> = where_cols
                    .keys()
                    .enumerate()
                    .map(|(i, k)| format!("{} = ?{}", k, i + 1))
                    .collect();
                let sql = format!("DELETE FROM {} WHERE {}", full, where_clauses.join(" AND "));
                let conn = engine.write_conn();
                let mut stmt = conn.prepare(&sql)?;
                let values: Vec<SqlValue> = where_cols
                    .values()
                    .map(|v| Self::json_to_sql(v, None))
                    .collect();
                let params: Vec<&dyn rusqlite::types::ToSql> =
                    values.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();
                Ok(stmt.execute(params.as_slice())? as u64)
            }
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

/// REQ-1: Create a feature-namespaced table.
#[tauri::command]
pub fn feature_store_ensure_table(
    state: tauri::State<'_, Arc<FeatureStore>>,
    feature_id: String,
    table_name: String,
    columns: Vec<ColumnDef>,
) -> Result<(), String> {
    state
        .ensure_table(&feature_id, &table_name, &columns)
        .map_err(|e| e.to_string())
}

/// REQ-2: Insert rows into a feature-namespaced table.
#[tauri::command]
pub fn feature_store_insert(
    state: tauri::State<'_, Arc<FeatureStore>>,
    feature_id: String,
    table_name: String,
    rows: Vec<serde_json::Map<String, JsonValue>>,
) -> Result<u64, String> {
    state
        .insert(&feature_id, &table_name, &rows)
        .map_err(|e| e.to_string())
}

/// REQ-3: Query rows with optional WHERE, ORDER BY, LIMIT.
#[tauri::command]
pub fn feature_store_query(
    state: tauri::State<'_, Arc<FeatureStore>>,
    feature_id: String,
    table_name: String,
    where_cols: Option<serde_json::Map<String, JsonValue>>,
    order_by: Option<String>,
    limit: Option<u64>,
) -> Result<Vec<serde_json::Map<String, JsonValue>>, String> {
    state
        .query(
            &feature_id,
            &table_name,
            where_cols.as_ref(),
            order_by.as_deref(),
            limit,
        )
        .map_err(|e| e.to_string())
}

/// REQ-4: Update rows matching WHERE clause.
#[tauri::command]
pub fn feature_store_update(
    state: tauri::State<'_, Arc<FeatureStore>>,
    feature_id: String,
    table_name: String,
    set_cols: serde_json::Map<String, JsonValue>,
    where_cols: serde_json::Map<String, JsonValue>,
) -> Result<u64, String> {
    state
        .update(&feature_id, &table_name, &set_cols, &where_cols)
        .map_err(|e| e.to_string())
}

/// REQ-5: Delete rows matching WHERE clause.
#[tauri::command]
pub fn feature_store_delete(
    state: tauri::State<'_, Arc<FeatureStore>>,
    feature_id: String,
    table_name: String,
    where_cols: serde_json::Map<String, JsonValue>,
) -> Result<u64, String> {
    state
        .delete(&feature_id, &table_name, &where_cols)
        .map_err(|e| e.to_string())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::storage::engine::{EngineHandle, SqliteEngine, StoreEngine};

    /// Helper: a FeatureStore over a tempdir-backed shared SQLite engine.
    fn make_store() -> (tempfile::TempDir, FeatureStore) {
        let dir = tempfile::tempdir().unwrap();
        let sqlite = SqliteEngine::open(&dir.path().join("fredo.db")).unwrap();
        let handle = EngineHandle::new(StoreEngine::Sqlite(sqlite));
        (dir, FeatureStore::open(handle).unwrap())
    }

    fn conn(engine: &Arc<SqliteEngine>) -> std::sync::MutexGuard<'_, Connection> {
        engine.write_conn()
    }

    fn col(name: &str, ty: ColumnType, nullable: bool, pk: bool) -> ColumnDef {
        ColumnDef {
            name: name.to_string(),
            col_type: ty,
            nullable,
            primary_key: pk,
        }
    }

    #[test]
    fn test_ensure_table_creates_schema() {
        let (_dir, store) = make_store();
        let columns = vec![
            col("id", ColumnType::TEXT, false, true),
            col("count", ColumnType::INTEGER, false, false),
        ];
        store
            .ensure_table("myfeature", "mytable", &columns)
            .unwrap();

        let engine = store.engine.engine().sqlite().unwrap().clone();
        let c = conn(&engine);
        let mut stmt = c
            .prepare("SELECT name, type, pk, `notnull` FROM pragma_table_info(?1)")
            .unwrap();
        let rows: Vec<(String, String, i32, i32)> = stmt
            .query_map(params!["feature_myfeature_mytable"], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i32>(2)?,
                    row.get::<_, i32>(3)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, "id");
        assert_eq!(rows[0].1, "TEXT");
        assert_eq!(rows[0].2, 1);
        assert_eq!(rows[0].3, 0);
        assert_eq!(rows[1].0, "count");
        assert_eq!(rows[1].1, "INTEGER");
        assert_eq!(rows[1].2, 0);
        assert_eq!(rows[1].3, 1);
    }

    #[test]
    fn test_crud_round_trip() {
        let (_dir, store) = make_store();
        let columns = vec![
            col("id", ColumnType::TEXT, false, true),
            col("label", ColumnType::TEXT, false, false),
            col("value", ColumnType::INTEGER, false, false),
        ];
        store.ensure_table("crudtest", "items", &columns).unwrap();

        let rows = vec![
            serde_json::json!({"id": "a", "label": "alpha", "value": 10})
                .as_object()
                .unwrap()
                .clone(),
            serde_json::json!({"id": "b", "label": "beta", "value": 20})
                .as_object()
                .unwrap()
                .clone(),
            serde_json::json!({"id": "c", "label": "gamma", "value": 30})
                .as_object()
                .unwrap()
                .clone(),
        ];
        assert_eq!(store.insert("crudtest", "items", &rows).unwrap(), 3);
        assert_eq!(
            store.query("crudtest", "items", None, None, None).unwrap().len(),
            3
        );

        let beta_rows = store
            .query(
                "crudtest",
                "items",
                Some(&serde_json::json!({"label": "beta"}).as_object().unwrap().clone()),
                None,
                None,
            )
            .unwrap();
        assert_eq!(beta_rows.len(), 1);
        assert_eq!(beta_rows[0].get("id").unwrap(), "b");

        let updated = store
            .update(
                "crudtest",
                "items",
                &serde_json::json!({"value": 25}).as_object().unwrap().clone(),
                &serde_json::json!({"id": "b"}).as_object().unwrap().clone(),
            )
            .unwrap();
        assert_eq!(updated, 1);
        let updated_row = store
            .query(
                "crudtest",
                "items",
                Some(&serde_json::json!({"id": "b"}).as_object().unwrap().clone()),
                None,
                None,
            )
            .unwrap();
        assert_eq!(updated_row[0].get("value").unwrap(), 25);

        let deleted = store
            .delete(
                "crudtest",
                "items",
                &serde_json::json!({"id": "c"}).as_object().unwrap().clone(),
            )
            .unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(
            store.query("crudtest", "items", None, None, None).unwrap().len(),
            2
        );
    }

    #[test]
    fn test_cross_feature_isolation() {
        let (_dir, store) = make_store();
        let columns = vec![col("id", ColumnType::TEXT, false, true)];
        store.ensure_table("bar", "mytable", &columns).unwrap();
        let result = store.query("foo", "mytable", None, None, None);
        assert!(result.is_err());
        let err = result.err().unwrap().to_string();
        assert!(
            err.contains("not in the 'foo' feature namespace")
                || err.contains("feature_foo_mytable")
        );
    }

    #[test]
    fn test_query_with_order_by_and_limit() {
        let (_dir, store) = make_store();
        let columns = vec![
            col("name", ColumnType::TEXT, false, false),
            col("rank", ColumnType::INTEGER, false, false),
        ];
        store.ensure_table("ranked", "entries", &columns).unwrap();
        let rows = vec![
            serde_json::json!({"name": "c", "rank": 3})
                .as_object()
                .unwrap()
                .clone(),
            serde_json::json!({"name": "a", "rank": 1})
                .as_object()
                .unwrap()
                .clone(),
            serde_json::json!({"name": "b", "rank": 2})
                .as_object()
                .unwrap()
                .clone(),
            serde_json::json!({"name": "d", "rank": 4})
                .as_object()
                .unwrap()
                .clone(),
        ];
        store.insert("ranked", "entries", &rows).unwrap();
        let result = store
            .query("ranked", "entries", None, Some("rank DESC"), Some(2))
            .unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].get("name").unwrap(), "d");
        assert_eq!(result[1].get("name").unwrap(), "c");
    }

    #[test]
    fn test_update_delete_count_zero() {
        let (_dir, store) = make_store();
        let columns = vec![col("id", ColumnType::TEXT, false, true)];
        store.ensure_table("empty", "table", &columns).unwrap();
        let updated = store
            .update(
                "empty",
                "table",
                &serde_json::json!({"id": "x"}).as_object().unwrap().clone(),
                &serde_json::json!({"id": "nonexistent"})
                    .as_object()
                    .unwrap()
                    .clone(),
            )
            .unwrap();
        assert_eq!(updated, 0);
        let deleted = store
            .delete(
                "empty",
                "table",
                &serde_json::json!({"id": "x"}).as_object().unwrap().clone(),
            )
            .unwrap();
        assert_eq!(deleted, 0);
    }

    #[test]
    fn test_empty_where_query_returns_all() {
        let (_dir, store) = make_store();
        let columns = vec![col("id", ColumnType::TEXT, false, true)];
        store.ensure_table("emptywhere", "t", &columns).unwrap();
        let rows = vec![serde_json::json!({"id": "a"}).as_object().unwrap().clone()];
        store.insert("emptywhere", "t", &rows).unwrap();
        let result = store
            .query("emptywhere", "t", Some(&serde_json::Map::new()), None, None)
            .unwrap();
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_blob_round_trip() {
        let (_dir, store) = make_store();
        let columns = vec![
            col("id", ColumnType::TEXT, false, true),
            col("data", ColumnType::BLOB, true, false),
        ];
        store.ensure_table("blobtest", "t", &columns).unwrap();
        let rows = vec![
            serde_json::json!({"id": "1", "data": [0, 1, 2, 255]})
                .as_object()
                .unwrap()
                .clone(),
        ];
        store.insert("blobtest", "t", &rows).unwrap();
        let result = store.query("blobtest", "t", None, None, None).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].get("data").unwrap(),
            &serde_json::json!([0, 1, 2, 255])
        );
    }

    #[test]
    fn test_hyphenated_feature_id_full_crud() {
        let (_dir, store) = make_store();
        let columns = vec![
            col("id", ColumnType::TEXT, false, true),
            col("value", ColumnType::INTEGER, false, false),
        ];
        store
            .ensure_table("mission-monitor", "sessions", &columns)
            .unwrap();
        let rows = vec![
            serde_json::json!({"id": "1", "value": 42})
                .as_object()
                .unwrap()
                .clone(),
            serde_json::json!({"id": "2", "value": 99})
                .as_object()
                .unwrap()
                .clone(),
        ];
        assert_eq!(
            store
                .insert("mission-monitor", "sessions", &rows)
                .unwrap(),
            2
        );
        let updated = store
            .update(
                "mission-monitor",
                "sessions",
                &serde_json::json!({"value": 100}).as_object().unwrap().clone(),
                &serde_json::json!({"id": "1"}).as_object().unwrap().clone(),
            )
            .unwrap();
        assert_eq!(updated, 1);
        let deleted = store
            .delete(
                "mission-monitor",
                "sessions",
                &serde_json::json!({"id": "2"}).as_object().unwrap().clone(),
            )
            .unwrap();
        assert_eq!(deleted, 1);

        let engine = store.engine.engine().sqlite().unwrap().clone();
        let c = conn(&engine);
        let mut stmt = c
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?1")
            .unwrap();
        let tables: Vec<String> = stmt
            .query_map(params!["feature_mission_monitor_sessions"], |row| {
                row.get::<_, String>(0)
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(tables, vec!["feature_mission_monitor_sessions"]);
    }

    #[test]
    fn test_hyphenated_feature_id_cross_feature_isolation() {
        let (_dir, store) = make_store();
        let columns = vec![col("id", ColumnType::TEXT, false, true)];
        store
            .ensure_table("mission-monitor", "sessions", &columns)
            .unwrap();
        let result = store.query("other-feature", "sessions", None, None, None);
        assert!(result.is_err());
        let err = result.err().unwrap().to_string();
        assert!(err.contains("no such table"));
    }

    #[test]
    fn test_idempotent_insert_duplicate_primary_key() {
        let (_dir, store) = make_store();
        let columns = vec![col("id", ColumnType::TEXT, false, true)];
        store.ensure_table("idempotent", "test", &columns).unwrap();
        let row = serde_json::json!({"id": "dup-1"})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(
            store.insert("idempotent", "test", &[row.clone()]).unwrap(),
            1
        );
        assert_eq!(store.insert("idempotent", "test", &[row]).unwrap(), 0);
        assert_eq!(
            store
                .query("idempotent", "test", None, None, None)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn test_idempotent_insert_mixed_unique_and_duplicate() {
        let (_dir, store) = make_store();
        let columns = vec![
            col("id", ColumnType::TEXT, false, true),
            col("value", ColumnType::INTEGER, false, false),
        ];
        store.ensure_table("idempotent", "multi", &columns).unwrap();
        let row_a = serde_json::json!({"id": "a", "value": 1})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(
            store.insert("idempotent", "multi", &[row_a.clone()]).unwrap(),
            1
        );
        let row_b = serde_json::json!({"id": "b", "value": 2})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(
            store.insert("idempotent", "multi", &[row_a, row_b]).unwrap(),
            1
        );
        assert_eq!(
            store
                .query("idempotent", "multi", None, None, None)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn test_upsert_updates_existing_row_on_conflict() {
        let (_dir, store) = make_store();
        let columns = vec![
            col("id", ColumnType::TEXT, false, true),
            col("value", ColumnType::INTEGER, false, false),
        ];
        store.ensure_table("upserttest", "t", &columns).unwrap();
        assert_eq!(
            store
                .upsert(
                    "upserttest",
                    "t",
                    &["id".to_string()],
                    &[serde_json::json!({"id": "a", "value": 1})
                        .as_object()
                        .unwrap()
                        .clone()],
                )
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .upsert(
                    "upserttest",
                    "t",
                    &["id".to_string()],
                    &[serde_json::json!({"id": "a", "value": 42})
                        .as_object()
                        .unwrap()
                        .clone()],
                )
                .unwrap(),
            1
        );
        let rows = store.query("upserttest", "t", None, None, None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("value").unwrap(), 42);
    }

    #[test]
    fn test_upsert_composite_primary_key() {
        let (_dir, store) = make_store();
        store
            .execute_batch(
                "CREATE TABLE feature_upsertmulti_rows (
                    session_id     TEXT NOT NULL,
                    correlation_id TEXT NOT NULL,
                    agent_reply    TEXT,
                    PRIMARY KEY (session_id, correlation_id)
                );",
            )
            .unwrap();
        let key = vec!["session_id".to_string(), "correlation_id".to_string()];
        store
            .upsert(
                "upsertmulti",
                "rows",
                &key,
                &[serde_json::json!({"session_id": "s1", "correlation_id": "c1", "agent_reply": "one"})
                    .as_object()
                    .unwrap()
                    .clone()],
            )
            .unwrap();
        store
            .upsert(
                "upsertmulti",
                "rows",
                &key,
                &[serde_json::json!({"session_id": "s1", "correlation_id": "c1", "agent_reply": "two"})
                    .as_object()
                    .unwrap()
                    .clone()],
            )
            .unwrap();
        let rows = store.query("upsertmulti", "rows", None, None, None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("agent_reply").unwrap(), "two");
    }

    #[test]
    fn test_table_schema_reports_type_nullability_and_primary_key() {
        let (_dir, store) = make_store();
        let columns = vec![
            col("id", ColumnType::TEXT, false, true),
            col("count", ColumnType::INTEGER, true, false),
            col("label", ColumnType::TEXT, false, false),
        ];
        store.ensure_table("myfeature", "mytable", &columns).unwrap();

        let schema = store.table_schema("feature_myfeature_mytable").unwrap();
        assert_eq!(schema.len(), 3);
        assert_eq!(schema[0].name, "id");
        assert_eq!(schema[0].sql_type, "TEXT");
        assert_eq!(schema[0].col_type, ColumnType::TEXT);
        assert!(!schema[0].not_null);
        assert!(schema[0].primary_key);
        assert_eq!(schema[1].col_type, ColumnType::INTEGER);
        assert!(schema[2].not_null, "declared non-nullable");
        assert!(!schema[2].primary_key);

        assert_eq!(
            store.table_column_names("feature_myfeature_mytable").unwrap(),
            vec!["id", "count", "label"]
        );
        assert!(store
            .table_schema("feature_myfeature_missing")
            .unwrap()
            .is_empty());

        let row = serde_json::json!({"id": "a", "count": 1, "label": "x"})
            .as_object()
            .unwrap()
            .clone();
        store.insert("myfeature", "mytable", &[row]).unwrap();
        assert_eq!(store.row_count("feature_myfeature_mytable").unwrap(), 1);
    }
}
