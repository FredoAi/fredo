//! Source-table enumeration + PostgreSQL target DDL derivation (ST-1, R-1.1).
//!
//! The migration enumerates the physical tables of the SOURCE `fredo.db` at
//! runtime from `sqlite_master` (skipping the `sqlite_*` internals), then derives
//! each target's PostgreSQL DDL from `pragma_table_info` through the ONE type map
//! ([`ColumnType::as_pg_type`]) + [`quote_ident`].
//! The derived DDL is compatible with
//! [`FeatureStore::ensure_table_on_pg`](crate::infrastructure::storage::feature_store::FeatureStore::ensure_table_on_pg),
//! so a post-install `ensure_table` is a no-op.
//!
//! Every table in `fredo.db` has a primary key, so the copy is PK-keyed and
//! idempotent (`ON CONFLICT(<pk>) DO UPDATE`).

use anyhow::{Context, Result};
use rusqlite::Connection;

use crate::infrastructure::storage::engine::quote_ident;
use crate::infrastructure::storage::feature_store::{ColumnType, FeatureStore};

/// One physical column of a source table, in declaration order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ColumnSpec {
    pub name: String,
    pub col_type: ColumnType,
    pub not_null: bool,
    /// The 1-based ordinal within the primary key, or `0` when not a PK column.
    pub pk_ordinal: i64,
}

/// One source table: its physical columns (declaration order) and its primary
/// key (ordered by PK ordinal).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableSpec {
    pub name: String,
    pub columns: Vec<ColumnSpec>,
    pub pk: Vec<String>,
}

impl TableSpec {
    /// Is `column` part of the primary key?
    pub fn is_primary_key(&self, column: &str) -> bool {
        self.pk.iter().any(|key| key == column)
    }

    /// The quoted, comma-joined column list for SELECT/INSERT statements.
    pub fn select_columns(&self) -> String {
        self.columns
            .iter()
            .map(|column| quote_ident(&column.name))
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The SQLite `ORDER BY` for the PK (default BINARY collation on text).
    ///
    /// A table with no primary key (none is expected in `fredo.db`, but the
    /// migration copies EVERY physical table) falls back to all columns, so the
    /// parity encoding still has a deterministic order on both engines.
    pub fn order_by_sqlite(&self) -> String {
        let keys: Vec<&String> = if self.pk.is_empty() {
            self.columns.iter().map(|column| &column.name).collect()
        } else {
            self.pk.iter().collect()
        };
        keys.iter()
            .map(|key| quote_ident(key))
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The PostgreSQL `ORDER BY` for the PK. Text keys are pinned to the `"C"`
    /// collation so the target order is byte-for-byte the SQLite BINARY order —
    /// otherwise the parity checksum would depend on the server's locale. A
    /// table with no primary key falls back to all columns (see
    /// [`Self::order_by_sqlite`]).
    pub fn order_by_pg(&self) -> String {
        let keys: Vec<&String> = if self.pk.is_empty() {
            self.columns.iter().map(|column| &column.name).collect()
        } else {
            self.pk.iter().collect()
        };
        keys.iter()
            .map(|key| {
                let quoted = quote_ident(key);
                match self.column_type(key) {
                    Some(ColumnType::TEXT) => format!("{quoted} COLLATE \"C\""),
                    _ => quoted,
                }
            })
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The [`ColumnType`] of a named column, when present.
    pub fn column_type(&self, column: &str) -> Option<ColumnType> {
        self.columns
            .iter()
            .find(|candidate| candidate.name == column)
            .map(|candidate| candidate.col_type)
    }

    /// The derived PostgreSQL `CREATE TABLE IF NOT EXISTS` DDL for this source
    /// table. A no-op for the fixed tables already created by the startup
    /// schema inits; the authoritative DDL for a lazily-created dynamic
    /// `feature_*` table.
    pub fn pg_create_sql(&self) -> String {
        let mut definitions: Vec<String> = Vec::with_capacity(self.columns.len() + 1);
        for column in &self.columns {
            let mut definition = format!(
                "{} {}",
                quote_ident(&column.name),
                column.col_type.as_pg_type()
            );
            // PK columns are NOT NULL via the table-level PRIMARY KEY clause.
            if column.not_null && column.pk_ordinal == 0 {
                definition.push_str(" NOT NULL");
            }
            definitions.push(definition);
        }
        if !self.pk.is_empty() {
            let keys = self
                .pk
                .iter()
                .map(|key| quote_ident(key))
                .collect::<Vec<_>>()
                .join(", ");
            definitions.push(format!("PRIMARY KEY ({keys})"));
        }
        format!(
            "CREATE TABLE IF NOT EXISTS {} ({});",
            quote_ident(&self.name),
            definitions.join(", ")
        )
    }
}

/// Enumerate every physical table of the source database, in name order,
/// skipping SQLite internals (`sqlite_master`, `sqlite_sequence`, …).
pub fn enumerate_tables(conn: &Connection) -> Result<Vec<TableSpec>> {
    let mut statement = conn.prepare(
        "SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name",
    )?;
    let names: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("[migration] enumerate source tables")?;

    let mut tables = Vec::with_capacity(names.len());
    for name in names {
        tables.push(read_table_spec(conn, &name)?);
    }
    Ok(tables)
}

fn read_table_spec(conn: &Connection, table: &str) -> Result<TableSpec> {
    let mut statement = conn.prepare(
        "SELECT name, type, \"notnull\", pk FROM pragma_table_info(?1) ORDER BY cid",
    )?;
    let rows: Vec<(String, String, i64, i64)> = statement
        .query_map([table], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .with_context(|| format!("[migration] read columns of '{table}'"))?;

    let mut columns = Vec::with_capacity(rows.len());
    let mut pk: Vec<(i64, String)> = Vec::new();
    for (name, declared_type, not_null, pk_ordinal) in rows {
        if pk_ordinal > 0 {
            pk.push((pk_ordinal, name.clone()));
        }
        columns.push(ColumnSpec {
            name,
            col_type: FeatureStore::normalize_column_type(&declared_type),
            not_null: not_null != 0,
            pk_ordinal,
        });
    }
    pk.sort_by_key(|(ordinal, _)| *ordinal);

    Ok(TableSpec {
        name: table.to_string(),
        columns,
        pk: pk.into_iter().map(|(_, name)| name).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_probe() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch(
            "CREATE TABLE settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE widget (
                id      TEXT PRIMARY KEY,
                label   TEXT NOT NULL,
                weight  REAL,
                payload BLOB
            );
            CREATE TABLE composite (
                a   TEXT NOT NULL,
                b   INTEGER NOT NULL,
                c   TEXT,
                PRIMARY KEY (b, a)
            );
            CREATE TABLE empty_pk_less (note TEXT);",
        )
        .expect("create probe schema");
        conn
    }

    #[test]
    fn enumerates_physical_tables_and_skips_sqlite_internals() {
        let conn = open_probe();
        let names: Vec<String> = enumerate_tables(&conn)
            .unwrap()
            .into_iter()
            .map(|table| table.name)
            .collect();
        assert!(names.contains(&"settings".to_string()));
        assert!(names.contains(&"widget".to_string()));
        assert!(names.contains(&"composite".to_string()));
        assert!(names.contains(&"empty_pk_less".to_string()));
        assert!(
            names.iter().all(|name| !name.starts_with("sqlite_")),
            "sqlite internals must be skipped: {names:?}"
        );
    }

    #[test]
    fn reads_columns_in_declaration_order_with_affinities() {
        let conn = open_probe();
        let widget = enumerate_tables(&conn)
            .unwrap()
            .into_iter()
            .find(|table| table.name == "widget")
            .unwrap();
        assert_eq!(
            widget
                .columns
                .iter()
                .map(|column| column.name.as_str())
                .collect::<Vec<_>>(),
            vec!["id", "label", "weight", "payload"]
        );
        assert_eq!(widget.columns[0].col_type, ColumnType::TEXT);
        assert_eq!(widget.columns[0].pk_ordinal, 1);
        assert!(
            !widget.columns[0].not_null,
            "SQLite only implies NOT NULL for an INTEGER PRIMARY KEY; a TEXT PK is nullable in pragma"
        );
        assert_eq!(widget.columns[1].col_type, ColumnType::TEXT);
        assert_eq!(widget.columns[2].col_type, ColumnType::REAL);
        assert_eq!(widget.columns[3].col_type, ColumnType::BLOB);
        assert_eq!(widget.pk, vec!["id".to_string()]);
    }

    #[test]
    fn orders_a_composite_primary_key_by_its_ordinal() {
        let conn = open_probe();
        let composite = enumerate_tables(&conn)
            .unwrap()
            .into_iter()
            .find(|table| table.name == "composite")
            .unwrap();
        // Declared PRIMARY KEY (b, a): ordinal 1 is `b`, ordinal 2 is `a`.
        assert_eq!(composite.pk, vec!["b".to_string(), "a".to_string()]);
    }

    #[test]
    fn derives_postgres_ddl_through_the_one_type_map() {
        let conn = open_probe();
        let widget = enumerate_tables(&conn)
            .unwrap()
            .into_iter()
            .find(|table| table.name == "widget")
            .unwrap();
        assert_eq!(
            widget.pg_create_sql(),
            "CREATE TABLE IF NOT EXISTS \"widget\" (\
\"id\" text, \
\"label\" text NOT NULL, \
\"weight\" double precision, \
\"payload\" bytea, \
PRIMARY KEY (\"id\"));"
        );
    }

    #[test]
    fn postgres_order_by_pins_text_keys_to_the_c_collation() {
        let conn = open_probe();
        let composite = enumerate_tables(&conn)
            .unwrap()
            .into_iter()
            .find(|table| table.name == "composite")
            .unwrap();
        assert_eq!(
            composite.order_by_pg(),
            "\"b\", \"a\" COLLATE \"C\"",
            "the integer key is unquoted-collation; the text key is C-pinned"
        );
    }
}
