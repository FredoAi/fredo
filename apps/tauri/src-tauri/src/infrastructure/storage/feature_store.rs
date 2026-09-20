use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

// â”€â”€ Column Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    fn as_sql_type(&self) -> &str {
        match self {
            ColumnType::TEXT => "TEXT",
            ColumnType::INTEGER => "INTEGER",
            ColumnType::REAL => "REAL",
            ColumnType::BLOB => "BLOB",
        }
    }
}

// â”€â”€ IPC Command Arg Structs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ FeatureStore â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// A generic SQLite-backed keyâ€“value store for feature-scoped tables.
///
/// Each feature gets its own namespace via `feature_{featureId}_{tableName}`.
/// All operations validate that the table name matches the feature's namespace.
pub struct FeatureStore {
    conn: Mutex<Connection>,
}

/// One physical column of a feature-namespaced table, as reported by
/// `pragma_table_info`.
///
/// `sql_type` is the raw declared SQLite type (used in diagnostics); `col_type`
/// is the normalized affinity produced by the single
/// [`FeatureStore::normalize_column_type`] rule that [`FeatureStore::column_types`]
/// also uses. `not_null` / `primary_key` expose the DDL constraints so the
/// declared-table layer can tell its own tables apart from a foreign/legacy table
/// that happens to share the name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PhysicalColumn {
    pub name: String,
    pub sql_type: String,
    pub col_type: ColumnType,
    pub not_null: bool,
    pub primary_key: bool,
}

impl FeatureStore {
    /// Open (or create) fredo.db with WAL journal mode.
    pub fn open(data_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&data_dir)?;
        let db_path = data_dir.join("fredo.db");
        let conn = Connection::open(&db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        Ok(FeatureStore {
            conn: Mutex::new(conn),
        })
    }

    /// Build the full table name: `feature_{featureId}_{tableName}`.
    /// Hyphens in `feature_id` are replaced with underscores since SQLite
    /// does not allow hyphens in identifiers.
    fn full_table_name(feature_id: &str, table_name: &str) -> String {
        let sanitized = feature_id.replace('-', "_");
        format!("feature_{}_{}", sanitized, table_name)
    }

    /// Validate that the given full table name is properly namespaced to the feature.
    ///
    /// Crate-internal so the feature-owned data layer (`infrastructure::feature_data`)
    /// reuses the EXACT namespace rule for declared tables — one implementation,
    /// no drift.
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

    /// Normalize a raw `pragma_table_info.type` string to a [`ColumnType`].
    ///
    /// The ONE shared normalization rule — [`Self::column_types`] and
    /// [`Self::table_schema`] both use it, so the physical/declared type
    /// comparison in the feature-data registry cannot drift from the physical
    /// type mapping used by insert/upsert.
    fn normalize_column_type(type_str: &str) -> ColumnType {
        match type_str.to_uppercase().as_str() {
            "INTEGER" => ColumnType::INTEGER,
            "REAL" => ColumnType::REAL,
            "BLOB" => ColumnType::BLOB,
            _ => ColumnType::TEXT,
        }
    }

    /// Look up the column-name â†’ ColumnType mapping for a feature-namespaced table.
    fn column_types(
        conn: &Connection,
        full_table: &str,
    ) -> Result<HashMap<String, ColumnType>> {
        let mut stmt = conn.prepare("SELECT name, type FROM pragma_table_info(?1)")?;
        let rows: Vec<(String, String)> = stmt
            .query_map(params![full_table], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut map = HashMap::new();
        for (name, type_str) in rows {
            map.insert(name, Self::normalize_column_type(&type_str));
        }
        Ok(map)
    }

    /// Convert a `serde_json::Value` to a `rusqlite::types::Value`.
    /// When `col_type` is `Some(BLOB)` and the value is a JSON array of numbers,
    /// the array elements are packed into a byte vector (SqlValue::Blob).
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
            JsonValue::Object(_) => {
                // Objects are always stored as JSON text
                SqlValue::Text(val.to_string())
            }
        }
    }

    /// Convert a `rusqlite::types::Value` back to a `serde_json::Value`.
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
            SqlValue::Blob(b) => JsonValue::Array(b.iter().map(|&x| JsonValue::Number(x.into())).collect()),
        }
    }

    /// REQ-1: Create a feature-namespaced table with typed columns.
    pub fn ensure_table(
        &self,
        feature_id: &str,
        table_name: &str,
        columns: &[ColumnDef],
    ) -> Result<()> {
        let full = Self::validate_namespace(feature_id, table_name)?;

        let col_defs: Vec<String> = columns
            .iter()
            .map(|c| {
                let sql_type = c.col_type.as_sql_type();
                let pk = if c.primary_key { " PRIMARY KEY" } else { "" };
                let nn = if !c.nullable && !c.primary_key {
                    " NOT NULL"
                } else {
                    ""
                };
                format!("{} {}{}{}", c.name, sql_type, pk, nn)
            })
            .collect();

        let sql = format!(
            "CREATE TABLE IF NOT EXISTS {} ({});",
            full,
            col_defs.join(", ")
        );

        let conn = self.conn.lock().unwrap();
        conn.execute_batch(&sql)?;
        Ok(())
    }

    /// REQ-2: Insert rows. Returns count of inserted rows.
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
        let conn = self.conn.lock().unwrap();

        // Look up column types from the table schema so we can handle BLOB columns.
        let col_types = Self::column_types(&conn, &full)?;

        // Collect column names from the first row
        let col_names: Vec<&str> = rows[0].keys().map(|s| s.as_str()).collect();
        let placeholders: Vec<String> = col_names.iter().map(|_| "?".to_string()).collect();

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
                    let col_type = col_types.get(name);
                    Self::json_to_sql(row.get(name).unwrap_or(&JsonValue::Null), col_type)
                })
                .collect();

            let params: Vec<&dyn rusqlite::types::ToSql> =
                values.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();

            let count = conn.execute(&sql, params.as_slice())? as u64;
            total += count;
        }

        Ok(total)
    }

    /// Upsert rows keyed by `primary_key` (`INSERT ... ON CONFLICT(pk) DO UPDATE`).
    ///
    /// Unlike [`Self::insert`] (an `INSERT OR IGNORE`), an existing row is
    /// UPDATED. The written column set is the union of the keys present across
    /// `rows` (deterministic order); a column absent from a row is bound as NULL.
    /// The caller supplies the backend-managed reserved columns (`_row_version`,
    /// `_updated_at`) where required. Returns the number of affected rows.
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
        let conn = self.lock_conn();
        let col_types = Self::column_types(&conn, &full)?;

        // Deterministic union of the columns present across all rows.
        let mut columns: Vec<&str> = Vec::new();
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        for row in rows {
            for key in row.keys() {
                if seen.insert(key.as_str()) {
                    columns.push(key.as_str());
                }
            }
        }

        let placeholders: Vec<String> = (1..=columns.len()).map(|i| format!("?{i}")).collect();
        let sql = if primary_key.is_empty() {
            // No declared key — a plain insert (nothing to conflict on).
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
                    let col_type = col_types.get(name);
                    Self::json_to_sql(row.get(name).unwrap_or(&JsonValue::Null), col_type)
                })
                .collect();

            let params: Vec<&dyn rusqlite::types::ToSql> =
                values.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();

            total += stmt.execute(params.as_slice())? as u64;
        }

        Ok(total)
    }

    /// Execute a raw DDL/DML batch against this store's connection.
    ///
    /// Crate-internal: the feature-owned data layer builds declared-table DDL —
    /// callers must only pass identifiers obtained from [`Self::validate_namespace`].
    pub(crate) fn execute_batch(&self, sql: &str) -> Result<()> {
        let conn = self.lock_conn();
        conn.execute_batch(sql)?;
        Ok(())
    }

    /// `true` iff the given (already validated, fully-qualified) table exists.
    pub(crate) fn table_exists(&self, full_table: &str) -> Result<bool> {
        let conn = self.lock_conn();
        let found: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![full_table],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    /// Physical schema of the given (fully-qualified) table: one entry per column
    /// in `pragma_table_info` order. An absent table yields an empty `Vec`, which
    /// callers treat as "table absent".
    pub(crate) fn table_schema(&self, full_table: &str) -> Result<Vec<PhysicalColumn>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare("SELECT name, type, `notnull`, pk FROM pragma_table_info(?1)")?;
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

    /// Row count of the given (fully-qualified) table.
    pub(crate) fn row_count(&self, full_table: &str) -> Result<i64> {
        let conn = self.lock_conn();
        let count: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM {}", full_table),
            [],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    /// Physical column names of the given (fully-qualified) table.
    pub(crate) fn table_column_names(&self, full_table: &str) -> Result<Vec<String>> {
        Ok(self
            .table_schema(full_table)?
            .into_iter()
            .map(|column| column.name)
            .collect())
    }

    /// Lock helper with poison recovery (no `unwrap`).
    fn lock_conn(&self) -> MutexGuard<'_, Connection> {
        match self.conn.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// REQ-3: Query rows with optional WHERE, ORDER BY, and LIMIT.
    pub fn query(
        &self,
        feature_id: &str,
        table_name: &str,
        where_cols: Option<&serde_json::Map<String, JsonValue>>,
        order_by: Option<&str>,
        limit: Option<u64>,
    ) -> Result<Vec<serde_json::Map<String, JsonValue>>> {
        let full = Self::validate_namespace(feature_id, table_name)?;
        let conn = self.conn.lock().unwrap();

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

    /// REQ-4: Update rows matching WHERE clause. Returns count of updated rows.
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

        let conn = self.conn.lock().unwrap();
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

        let affected = stmt.execute(params.as_slice())?;
        Ok(affected as u64)
    }

    /// REQ-5: Delete rows matching WHERE clause. Returns count of deleted rows.
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

        let where_clauses: Vec<String> = where_cols
            .keys()
            .enumerate()
            .map(|(i, k)| format!("{} = ?{}", k, i + 1))
            .collect();

        let sql = format!("DELETE FROM {} WHERE {}", full, where_clauses.join(" AND "));

        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql)?;

        let values: Vec<SqlValue> = where_cols
            .values()
            .map(|v| Self::json_to_sql(v, None))
            .collect();

        let params: Vec<&dyn rusqlite::types::ToSql> =
            values.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();

        let affected = stmt.execute(params.as_slice())?;
        Ok(affected as u64)
    }
}

// â”€â”€ IPC Commands â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: create a FeatureStore backed by an in-memory SQLite database.
    fn make_store() -> FeatureStore {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL;").ok();
        FeatureStore {
            conn: Mutex::new(conn),
        }
    }

    #[test]
    fn test_ensure_table_creates_schema() {
        // AC-1: ensure_table with typed columns creates the correct schema
        let store = make_store();
        let columns = vec![
            ColumnDef {
                name: "id".to_string(),
                col_type: ColumnType::TEXT,
                nullable: false,
                primary_key: true,
            },
            ColumnDef {
                name: "count".to_string(),
                col_type: ColumnType::INTEGER,
                nullable: false,
                primary_key: false,
            },
        ];

        store
            .ensure_table("myfeature", "mytable", &columns)
            .unwrap();

        // Verify schema via PRAGMA table_info
        let conn = store.conn.lock().unwrap();
        let mut stmt = conn
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
        // id column: TEXT, PK, not null
        assert_eq!(rows[0].0, "id");
        assert_eq!(rows[0].1, "TEXT");
        assert_eq!(rows[0].2, 1); // pk
        assert_eq!(rows[0].3, 0); // notnull (0 = nullable)
        // count column: INTEGER, not PK, not null
        assert_eq!(rows[1].0, "count");
        assert_eq!(rows[1].1, "INTEGER");
        assert_eq!(rows[1].2, 0); // not pk
        assert_eq!(rows[1].3, 1); // notnull
    }

    #[test]
    fn test_crud_round_trip() {
        // AC-2: Full CRUD round-trip
        let store = make_store();

        // Create the table
        let columns = vec![
            ColumnDef {
                name: "id".to_string(),
                col_type: ColumnType::TEXT,
                nullable: false,
                primary_key: true,
            },
            ColumnDef {
                name: "label".to_string(),
                col_type: ColumnType::TEXT,
                nullable: false,
                primary_key: false,
            },
            ColumnDef {
                name: "value".to_string(),
                col_type: ColumnType::INTEGER,
                nullable: false,
                primary_key: false,
            },
        ];
        store.ensure_table("crudtest", "items", &columns).unwrap();

        // Insert 3 rows
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
        let inserted = store.insert("crudtest", "items", &rows).unwrap();
        assert_eq!(inserted, 3);

        // Query all rows
        let all = store
            .query("crudtest", "items", None, None, None)
            .unwrap();
        assert_eq!(all.len(), 3);

        // Query with WHERE
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

        // Update
        let updated = store
            .update(
                "crudtest",
                "items",
                &serde_json::json!({"value": 25}).as_object().unwrap().clone(),
                &serde_json::json!({"id": "b"}).as_object().unwrap().clone(),
            )
            .unwrap();
        assert_eq!(updated, 1);

        // Verify update
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

        // Delete
        let deleted = store
            .delete(
                "crudtest",
                "items",
                &serde_json::json!({"id": "c"}).as_object().unwrap().clone(),
            )
            .unwrap();
        assert_eq!(deleted, 1);

        // Verify deletion
        let remaining = store
            .query("crudtest", "items", None, None, None)
            .unwrap();
        assert_eq!(remaining.len(), 2);
    }

    #[test]
    fn test_cross_feature_isolation() {
        // AC-3: Cross-feature access returns an error
        let store = make_store();

        // Create table for feature "bar"
        let columns = vec![ColumnDef {
            name: "id".to_string(),
            col_type: ColumnType::TEXT,
            nullable: false,
            primary_key: true,
        }];
        store.ensure_table("bar", "mytable", &columns).unwrap();

        // Try to query with feature "foo" â€” should error
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
        let store = make_store();
        let columns = vec![
            ColumnDef {
                name: "name".to_string(),
                col_type: ColumnType::TEXT,
                nullable: false,
                primary_key: false,
            },
            ColumnDef {
                name: "rank".to_string(),
                col_type: ColumnType::INTEGER,
                nullable: false,
                primary_key: false,
            },
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

        // ORDER BY rank DESC LIMIT 2
        let result = store
            .query("ranked", "entries", None, Some("rank DESC"), Some(2))
            .unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].get("name").unwrap(), "d");
        assert_eq!(result[1].get("name").unwrap(), "c");
    }

    #[test]
    fn test_update_delete_count_zero() {
        // Update with no matching rows returns 0
        let store = make_store();
        let columns = vec![ColumnDef {
            name: "id".to_string(),
            col_type: ColumnType::TEXT,
            nullable: false,
            primary_key: true,
        }];
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
        let store = make_store();
        let columns = vec![ColumnDef {
            name: "id".to_string(),
            col_type: ColumnType::TEXT,
            nullable: false,
            primary_key: true,
        }];
        store.ensure_table("emptywhere", "t", &columns).unwrap();

        let rows = vec![
            serde_json::json!({"id": "a"}).as_object().unwrap().clone(),
        ];
        store.insert("emptywhere", "t", &rows).unwrap();

        // Empty WHERE should still be treated as no filter
        let result = store
            .query(
                "emptywhere",
                "t",
                Some(&serde_json::Map::new()),
                None,
                None,
            )
            .unwrap();
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_blob_round_trip() {
        let store = make_store();
        let columns = vec![
            ColumnDef {
                name: "id".to_string(),
                col_type: ColumnType::TEXT,
                nullable: false,
                primary_key: true,
            },
            ColumnDef {
                name: "data".to_string(),
                col_type: ColumnType::BLOB,
                nullable: true,
                primary_key: false,
            },
        ];
        store.ensure_table("blobtest", "t", &columns).unwrap();

        // Insert with blob value
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
    fn test_hyphenated_feature_id_ensure_table() {
        // AC-4a: ensure_table with hyphenated feature_id works
        let store = make_store();
        let columns = vec![ColumnDef {
            name: "id".to_string(),
            col_type: ColumnType::TEXT,
            nullable: false,
            primary_key: true,
        }];
        store
            .ensure_table("mission-monitor", "sessions", &columns)
            .unwrap();
    }

    #[test]
    fn test_hyphenated_feature_id_insert_and_query() {
        // AC-4b: insert and query with hyphenated feature_id
        let store = make_store();
        let columns = vec![ColumnDef {
            name: "id".to_string(),
            col_type: ColumnType::TEXT,
            nullable: false,
            primary_key: true,
        }];
        store
            .ensure_table("mission-monitor", "sessions", &columns)
            .unwrap();

        let rows = vec![serde_json::json!({"id": "1"})
            .as_object()
            .unwrap()
            .clone()];
        let inserted = store
            .insert("mission-monitor", "sessions", &rows)
            .unwrap();
        assert_eq!(inserted, 1);

        let all = store
            .query("mission-monitor", "sessions", None, None, None)
            .unwrap();
        assert_eq!(all.len(), 1);
    }

    #[test]
    fn test_hyphenated_feature_id_update_delete() {
        // AC-4c: full CRUD with hyphenated feature_id
        let store = make_store();
        let columns = vec![
            ColumnDef {
                name: "id".to_string(),
                col_type: ColumnType::TEXT,
                nullable: false,
                primary_key: true,
            },
            ColumnDef {
                name: "value".to_string(),
                col_type: ColumnType::INTEGER,
                nullable: false,
                primary_key: false,
            },
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
        store
            .insert("mission-monitor", "sessions", &rows)
            .unwrap();

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

        let remaining = store
            .query("mission-monitor", "sessions", None, None, None)
            .unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].get("value").unwrap(), 100);
    }

    #[test]
    fn test_hyphenated_feature_id_cross_feature_isolation() {
        // AC-4d: cross-feature isolation still works with hyphenated IDs
        let store = make_store();
        let columns = vec![ColumnDef {
            name: "id".to_string(),
            col_type: ColumnType::TEXT,
            nullable: false,
            primary_key: true,
        }];
        store
            .ensure_table("mission-monitor", "sessions", &columns)
            .unwrap();

        let result = store.query("other-feature", "sessions", None, None, None);
        assert!(result.is_err());
        let err = result.err().unwrap().to_string();
        // The table name "feature_other_feature_sessions" doesn't exist
        assert!(err.contains("no such table"));
    }

    #[test]
    fn test_hyphenated_feature_id_verify_table_name() {
        // AC-4e: verify the internal table name uses underscores
        let store = make_store();
        let columns = vec![ColumnDef {
            name: "id".to_string(),
            col_type: ColumnType::TEXT,
            nullable: false,
            primary_key: true,
        }];
        store
            .ensure_table("mission-monitor", "sessions", &columns)
            .unwrap();

        let conn = store.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?1")
            .unwrap();
        let tables: Vec<String> = stmt
            .query_map(params!["feature_mission_monitor_sessions"], |row| {
                row.get::<_, String>(0)
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0], "feature_mission_monitor_sessions");
    }

    #[test]
    fn test_idempotent_insert_duplicate_primary_key() {
        // AC-3: Duplicate inserts with the same primary key silently succeed
        // without error, returning 0 for ignored rows, and the row count stays at 1.
        let store = make_store();
        let columns = vec![ColumnDef {
            name: "id".to_string(),
            col_type: ColumnType::TEXT,
            nullable: false,
            primary_key: true,
        }];
        store
            .ensure_table("idempotent", "test", &columns)
            .unwrap();

        // First insert â€” should return 1
        let row = serde_json::json!({"id": "dup-1"})
            .as_object()
            .unwrap()
            .clone();
        let first = store.insert("idempotent", "test", &[row.clone()]).unwrap();
        assert_eq!(first, 1, "first insert of new primary key should return 1");

        // Second insert with same primary key â€” should return 0 (silently ignored)
        let second = store.insert("idempotent", "test", &[row]).unwrap();
        assert_eq!(
            second, 0,
            "duplicate insert should be silently ignored and return 0"
        );

        // Verify only one row exists in the table
        let all = store
            .query("idempotent", "test", None, None, None)
            .unwrap();
        assert_eq!(all.len(), 1, "table should still contain exactly one row");
        assert_eq!(
            all[0].get("id").unwrap(),
            "dup-1",
            "the existing row should have the correct id"
        );
    }

    #[test]
    fn test_upsert_updates_existing_row_on_conflict() {
        // The projection path needs UPDATE-on-conflict, not INSERT OR IGNORE.
        let store = make_store();
        let columns = vec![
            ColumnDef {
                name: "id".to_string(),
                col_type: ColumnType::TEXT,
                nullable: false,
                primary_key: true,
            },
            ColumnDef {
                name: "value".to_string(),
                col_type: ColumnType::INTEGER,
                nullable: false,
                primary_key: false,
            },
        ];
        store.ensure_table("upserttest", "t", &columns).unwrap();

        let first = store
            .upsert(
                "upserttest",
                "t",
                &["id".to_string()],
                &[serde_json::json!({"id": "a", "value": 1})
                    .as_object()
                    .unwrap()
                    .clone()],
            )
            .unwrap();
        assert_eq!(first, 1);

        // Same key, new value — UPDATE, not ignore.
        let second = store
            .upsert(
                "upserttest",
                "t",
                &["id".to_string()],
                &[serde_json::json!({"id": "a", "value": 42})
                    .as_object()
                    .unwrap()
                    .clone()],
            )
            .unwrap();
        assert_eq!(second, 1);

        let rows = store.query("upserttest", "t", None, None, None).unwrap();
        assert_eq!(rows.len(), 1, "conflict must update in place, not duplicate");
        assert_eq!(rows[0].get("value").unwrap(), 42);

        // A new key inserts.
        store
            .upsert(
                "upserttest",
                "t",
                &["id".to_string()],
                &[serde_json::json!({"id": "b", "value": 7})
                    .as_object()
                    .unwrap()
                    .clone()],
            )
            .unwrap();
        assert_eq!(
            store.query("upserttest", "t", None, None, None).unwrap().len(),
            2
        );
    }

    #[test]
    fn test_upsert_composite_primary_key() {
        let store = make_store();
        // `ensure_table` only expresses per-column PRIMARY KEY, so build the
        // composite-key table the way a declared table is created.
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
    fn test_idempotent_insert_mixed_unique_and_duplicate() {
        // AC-3 (extended): Insert multiple rows where some have duplicate
        // primary keys and some are new. Only new rows should be counted.
        let store = make_store();
        let columns = vec![
            ColumnDef {
                name: "id".to_string(),
                col_type: ColumnType::TEXT,
                nullable: false,
                primary_key: true,
            },
            ColumnDef {
                name: "value".to_string(),
                col_type: ColumnType::INTEGER,
                nullable: false,
                primary_key: false,
            },
        ];
        store
            .ensure_table("idempotent", "multi", &columns)
            .unwrap();

        // Insert initial row
        let row_a = serde_json::json!({"id": "a", "value": 1})
            .as_object()
            .unwrap()
            .clone();
        let inserted = store.insert("idempotent", "multi", &[row_a.clone()]).unwrap();
        assert_eq!(inserted, 1);

        // Insert two rows: one duplicate ("a"), one new ("b")
        let row_b = serde_json::json!({"id": "b", "value": 2})
            .as_object()
            .unwrap()
            .clone();
        let mixed = store
            .insert("idempotent", "multi", &[row_a, row_b])
            .unwrap();
        assert_eq!(
            mixed, 1,
            "only the new row should be counted; the duplicate should be ignored"
        );

        // Verify exactly 2 rows exist
        let all = store
            .query("idempotent", "multi", None, None, None)
            .unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn test_table_schema_reports_type_nullability_and_primary_key() {
        let store = make_store();
        let columns = vec![
            ColumnDef {
                name: "id".to_string(),
                col_type: ColumnType::TEXT,
                nullable: false,
                primary_key: true,
            },
            ColumnDef {
                name: "count".to_string(),
                col_type: ColumnType::INTEGER,
                nullable: true,
                primary_key: false,
            },
            ColumnDef {
                name: "label".to_string(),
                col_type: ColumnType::TEXT,
                nullable: false,
                primary_key: false,
            },
        ];
        store
            .ensure_table("myfeature", "mytable", &columns)
            .unwrap();

        let schema = store.table_schema("feature_myfeature_mytable").unwrap();
        assert_eq!(schema.len(), 3);
        assert_eq!(schema[0].name, "id");
        assert_eq!(schema[0].sql_type, "TEXT");
        assert_eq!(schema[0].col_type, ColumnType::TEXT);
        assert!(!schema[0].not_null); // PK, declared without NOT NULL here
        assert!(schema[0].primary_key);
        assert_eq!(schema[1].name, "count");
        assert_eq!(schema[1].col_type, ColumnType::INTEGER);
        assert_eq!(schema[2].name, "label");
        assert!(schema[2].not_null, "declared non-nullable");
        assert!(!schema[2].primary_key);

        // `table_column_names` delegates to the same physical inspection.
        assert_eq!(
            store.table_column_names("feature_myfeature_mytable").unwrap(),
            vec!["id", "count", "label"]
        );

        // An absent table yields an empty physical schema.
        assert!(store
            .table_schema("feature_myfeature_missing")
            .unwrap()
            .is_empty());

        let row = serde_json::json!({"id": "a", "count": 1, "label": "x"})
            .as_object()
            .unwrap()
            .clone();
        store
            .insert("myfeature", "mytable", &[row])
            .unwrap();
        assert_eq!(store.row_count("feature_myfeature_mytable").unwrap(), 1);
    }
}
