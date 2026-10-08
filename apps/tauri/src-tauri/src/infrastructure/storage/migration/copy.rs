//! PK-ordered, chunked table copy + per-table parity (ST-1/ST-2, R-1.1/R-2.1).
//!
//! For each source table:
//! 1. create the target with the derived DDL (a no-op for the fixed tables),
//! 2. stream the source rows PK-ordered in [`MIGRATION_CHUNK_ROWS`] chunks,
//!    upserting each chunk with
//!    `INSERT … ON CONFLICT(<pk>) DO UPDATE SET …=EXCLUDED.…`,
//! 3. compute the source checksum WHILE streaming (bounded memory),
//! 4. stream the target back and compute its checksum,
//! 5. return both independent comparisons as a [`TableParity`].
//!
//! **One transaction per table (ST-8c):** all of a table's chunk upserts commit
//! together (with `SET LOCAL synchronous_commit = off` for the copy session), so
//! the copy pays one WAL flush per table instead of one per 512-row chunk. The
//! leg is idempotent (a crash re-runs the read-only export) and the marker is
//! written only after a full parity-clean pass, so relaxing copy-time durability
//! does not weaken the fail-closed contract.
//!
//! **Cooperative per-table deadline (ST-8b):** `deadline` is checked BETWEEN
//! chunks, so an over-budget table returns `Err` with its transaction rolled back
//! cleanly (never a future dropped mid-transaction); the caller then writes no
//! marker and the app stays on SQLite.
//!
//! Reads never hold a SQLite borrow across an `.await`: each chunk is read
//! synchronously and dropped before the PostgreSQL write, so the copy future is
//! `Send` (the supervisor's background task requires it).
//!
//! Identity columns (`telemetry_logs.id` / `telemetry_metrics.id`) are copied
//! with `OVERRIDING SYSTEM VALUE` and their sequence is advanced to the migrated
//! maximum, so post-migration inserts cannot collide with a carried id.

use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use futures_util::TryStreamExt;
use rusqlite::Connection;
use sqlx::{PgConnection, PgPool, Postgres, Row as _};

use crate::infrastructure::storage::engine::quote_ident;
use crate::infrastructure::storage::application_store::ColumnType;

use super::parity::{CellValue, RowHasher};
use super::tables::{ColumnSpec, TableSpec};
use super::{MigrationFault, TableParity, MIGRATION_CHUNK_ROWS, MIGRATION_FORCE_MISMATCH_ENV};

/// Copy one source table into PostgreSQL and return its independent parity pair
/// (fault-seam-free default path).
pub async fn copy_table(
    conn: &mut Connection,
    pool: &PgPool,
    spec: &TableSpec,
    deadline: Instant,
) -> Result<TableParity> {
    copy_table_with_fault(conn, pool, spec, None, deadline).await
}

/// Copy one source table into PostgreSQL and return its independent parity pair,
/// honouring the **G-275** fault seam and the **ST-8b** per-table `deadline`.
///
/// * [`MigrationFault::ExportError`] targeting `spec.name` aborts before any
///   read/copy with an injected error (fail-closed, before parity).
/// * [`MigrationFault::DropRow`] targeting `spec.name` removes ONE row from the
///   target after the copy and before the target count/checksum, so the parity
///   gate observes a count + checksum mismatch (R-4.1).
///
/// The whole chunk loop runs inside ONE transaction (ST-8c) with
/// `SET LOCAL synchronous_commit = off`; the deadline (ST-8b) is checked between
/// chunks so an overrun rolls the transaction back cleanly. With `fault == None`
/// the copied bytes are byte-identical to the un-forced default.
pub async fn copy_table_with_fault(
    conn: &mut Connection,
    pool: &PgPool,
    spec: &TableSpec,
    fault: Option<&MigrationFault>,
    deadline: Instant,
) -> Result<TableParity> {
    let table_started = Instant::now();

    if let Some(MigrationFault::ExportError(table)) = fault {
        if &spec.name == table {
            return Err(anyhow!(
                "[migration] injected export I/O error for '{}' via {MIGRATION_FORCE_MISMATCH_ENV}",
                spec.name
            ));
        }
    }

    sqlx::query(&spec.pg_create_sql())
        .execute(pool)
        .await
        .with_context(|| format!("[migration] create target table '{}'", spec.name))?;

    let identity_columns = identity_columns(pool, &spec.name).await?;
    let overriding_identity = !identity_columns.is_empty();

    // ST-8c: ONE transaction per table. A `Drop` (error / cancelled future)
    // rolls every chunk of this table back atomically, so a partial table is
    // never left behind for the (fail-closed, marker-less) re-run.
    let mut tx = pool
        .begin()
        .await
        .with_context(|| format!("[migration] begin copy transaction for '{}'", spec.name))?;
    // The leg is idempotent and the marker is written only after a parity-clean
    // pass, so the copy session may skip the per-commit fsync.
    sqlx::query("SET LOCAL synchronous_commit = off")
        .execute(&mut *tx)
        .await
        .with_context(|| format!("[migration] relax synchronous_commit for '{}'", spec.name))?;

    let mut source_rows: i64 = 0;
    let mut source_hasher = RowHasher::new();
    if spec.pk.is_empty() {
        // No primary key: no keyset order exists, so read the table once
        // (ordered by all columns for a deterministic checksum) and flush in
        // bounded writes. Defensive only — every real table is PK-keyed.
        let all = read_all(conn, spec)?;
        for row in &all {
            source_hasher.update_row(row);
        }
        source_rows = all.len() as i64;
        for chunk in all.chunks(MIGRATION_CHUNK_ROWS) {
            ensure_within_budget(deadline, &spec.name)?;
            flush_chunk(&mut tx, spec, chunk, overriding_identity).await?;
        }
    } else {
        let mut cursor: Option<Vec<CellValue>> = None;
        loop {
            ensure_within_budget(deadline, &spec.name)?;
            let chunk = read_chunk(conn, spec, cursor.as_deref())?;
            if chunk.is_empty() {
                break;
            }
            for row in &chunk {
                source_hasher.update_row(row);
            }
            source_rows += chunk.len() as i64;
            flush_chunk(&mut tx, spec, &chunk, overriding_identity).await?;
            cursor = Some(primary_key_values(
                spec,
                chunk.last().expect("chunk is non-empty"),
            ));
        }
    }
    let source_checksum = source_hasher.finish();

    tx.commit()
        .await
        .with_context(|| format!("[migration] commit copy transaction for '{}'", spec.name))?;

    if overriding_identity {
        reset_identity_sequences(pool, spec, &identity_columns).await?;
    }

    // G-275 fault seam: drop ONE target row before the target count/checksum, so
    // the parity gate observes a mismatch (inert when the table does not match).
    if let Some(MigrationFault::DropRow(table)) = fault {
        if &spec.name == table {
            drop_one_target_row(pool, spec).await?;
        }
    }

    let target_rows: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*) FROM {}",
        quote_ident(&spec.name)
    ))
    .fetch_one(pool)
    .await
    .with_context(|| format!("[migration] count target table '{}'", spec.name))?;

    let target_sql = format!(
        "SELECT {} FROM {} ORDER BY {}",
        spec.select_columns(),
        quote_ident(&spec.name),
        spec.order_by_pg()
    );
    let mut target_hasher = RowHasher::new();
    {
        let mut stream = sqlx::query(&target_sql).fetch(pool);
        while let Some(row) = stream
            .try_next()
            .await
            .with_context(|| format!("[migration] read target table '{}'", spec.name))?
        {
            let mut cells = Vec::with_capacity(spec.columns.len());
            for (index, column) in spec.columns.iter().enumerate() {
                cells.push(pg_cell(&row, index, column)?);
            }
            target_hasher.update_row(&cells);
        }
    }
    let target_checksum = target_hasher.finish();

    Ok(TableParity {
        table: spec.name.clone(),
        source_rows,
        target_rows,
        count_match: source_rows == target_rows,
        source_checksum: source_checksum.clone(),
        target_checksum: target_checksum.clone(),
        checksum_match: source_checksum == target_checksum,
        read_only_source: true,
        elapsed_ms: table_started.elapsed().as_millis(),
    })
}

/// Cooperative per-table deadline check (ST-8b), called BETWEEN chunks so the
/// table's transaction is rolled back cleanly (never a future dropped
/// mid-transaction). Fail-closed: an overrun returns `Err`, so the caller writes
/// no marker and the app stays on SQLite.
fn ensure_within_budget(deadline: Instant, table: &str) -> Result<()> {
    if Instant::now() >= deadline {
        return Err(anyhow!(
            "[migration] table '{table}' exceeded its per-table copy budget"
        ));
    }
    Ok(())
}

/// Read at most [`MIGRATION_CHUNK_ROWS`] source rows PK-ordered, after `cursor`.
///
/// Keyset pagination (a row-value `> (…)` comparison on the PK) keeps every
/// query bounded — no `OFFSET` scan, no full-table materialization (R-5.1).
fn read_chunk(
    conn: &Connection,
    spec: &TableSpec,
    cursor: Option<&[CellValue]>,
) -> Result<Vec<Vec<CellValue>>> {
    let columns = spec.select_columns();
    let table = quote_ident(&spec.name);
    let order = spec.order_by_sqlite();

    let (sql, params) = match cursor {
        None => (
            format!(
                "SELECT {columns} FROM {table} ORDER BY {order} LIMIT {MIGRATION_CHUNK_ROWS}"
            ),
            Vec::new(),
        ),
        Some(values) => {
            let lhs = spec
                .pk
                .iter()
                .map(|key| quote_ident(key))
                .collect::<Vec<_>>()
                .join(", ");
            let rhs = (1..=spec.pk.len())
                .map(|index| format!("?{index}"))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "SELECT {columns} FROM {table} WHERE ({lhs}) > ({rhs}) \
                 ORDER BY {order} LIMIT {MIGRATION_CHUNK_ROWS}"
            );
            let params: Vec<rusqlite::types::Value> =
                values.iter().map(cell_to_sqlite).collect();
            (sql, params)
        }
    };

    let mut statement = conn
        .prepare(&sql)
        .with_context(|| format!("[migration] prepare source read of '{}'", spec.name))?;
    let mut rows = statement.query(rusqlite::params_from_iter(params))?;
    let mut chunk = Vec::new();
    while let Some(row) = rows.next()? {
        let mut cells = Vec::with_capacity(spec.columns.len());
        for (index, column) in spec.columns.iter().enumerate() {
            let value: rusqlite::types::Value = row.get(index)?;
            cells.push(source_cell(value, column));
        }
        chunk.push(cells);
    }
    Ok(chunk)
}

/// Read a whole table (only used for the defensive no-primary-key case), ordered
/// by all columns so the checksum is deterministic.
fn read_all(conn: &Connection, spec: &TableSpec) -> Result<Vec<Vec<CellValue>>> {
    let sql = format!(
        "SELECT {} FROM {} ORDER BY {}",
        spec.select_columns(),
        quote_ident(&spec.name),
        spec.order_by_sqlite()
    );
    let mut statement = conn
        .prepare(&sql)
        .with_context(|| format!("[migration] prepare source read of '{}'", spec.name))?;
    let mut rows = statement.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut cells = Vec::with_capacity(spec.columns.len());
        for (index, column) in spec.columns.iter().enumerate() {
            let value: rusqlite::types::Value = row.get(index)?;
            cells.push(source_cell(value, column));
        }
        out.push(cells);
    }
    Ok(out)
}

/// The primary-key values of a row, in `spec.pk` order.
fn primary_key_values(spec: &TableSpec, row: &[CellValue]) -> Vec<CellValue> {
    spec.pk
        .iter()
        .map(|key| {
            let index = spec
                .columns
                .iter()
                .position(|column| &column.name == key)
                .expect("a primary-key column is always in the column set");
            row[index].clone()
        })
        .collect()
}

/// Upsert one chunk on PostgreSQL through the table's transaction connection
/// (ST-8c: one transaction per table, not one autocommit per chunk).
async fn flush_chunk(
    conn: &mut PgConnection,
    spec: &TableSpec,
    rows: &[Vec<CellValue>],
    overriding_identity: bool,
) -> Result<()> {
    if rows.is_empty() {
        return Ok(());
    }

    let column_count = spec.columns.len();
    let mut placeholder_rows = Vec::with_capacity(rows.len());
    let mut placeholder = 1usize;
    for _ in 0..rows.len() {
        let row: Vec<String> = (0..column_count)
            .map(|_| {
                let token = format!("${placeholder}");
                placeholder += 1;
                token
            })
            .collect();
        placeholder_rows.push(format!("({})", row.join(", ")));
    }

    let overriding = if overriding_identity {
        " OVERRIDING SYSTEM VALUE"
    } else {
        ""
    };
    let sql = format!(
        "INSERT INTO {} ({}){overriding} VALUES {}{}",
        quote_ident(&spec.name),
        spec.select_columns(),
        placeholder_rows.join(", "),
        conflict_clause(spec)
    );

    let mut query = sqlx::query(&sql);
    for row in rows {
        for (cell, column) in row.iter().zip(spec.columns.iter()) {
            query = bind_cell(query, cell, column);
        }
    }
    query
        .execute(&mut *conn)
        .await
        .with_context(|| format!("[migration] copy rows into '{}'", spec.name))?;
    Ok(())
}

/// `ON CONFLICT(<pk>) DO UPDATE SET <non-pk> = EXCLUDED.<non-pk>`. A table with
/// no primary key (none exist in `fredo.db`) falls back to a plain insert.
fn conflict_clause(spec: &TableSpec) -> String {
    if spec.pk.is_empty() {
        return String::new();
    }
    let keys = spec
        .pk
        .iter()
        .map(|key| quote_ident(key))
        .collect::<Vec<_>>()
        .join(", ");
    let updates: Vec<String> = spec
        .columns
        .iter()
        .filter(|column| !spec.is_primary_key(&column.name))
        .map(|column| {
            let quoted = quote_ident(&column.name);
            format!("{quoted} = EXCLUDED.{quoted}")
        })
        .collect();
    let action = if updates.is_empty() {
        "DO NOTHING".to_string()
    } else {
        format!("DO UPDATE SET {}", updates.join(", "))
    };
    format!(" ON CONFLICT ({keys}) {action}")
}

/// Normalize one source cell to the canonical affinity for its column, so both
/// engines encode the same physical value the same way.
pub(crate) fn source_cell(value: rusqlite::types::Value, column: &ColumnSpec) -> CellValue {
    match value {
        rusqlite::types::Value::Null => CellValue::Null,
        rusqlite::types::Value::Integer(number) => match column.col_type {
            ColumnType::REAL => CellValue::Real(number as f64),
            ColumnType::TEXT => CellValue::Text(number.to_string()),
            _ => CellValue::Integer(number),
        },
        rusqlite::types::Value::Real(number) => match column.col_type {
            ColumnType::INTEGER => CellValue::Integer(number as i64),
            ColumnType::TEXT => CellValue::Text(number.to_string()),
            _ => CellValue::Real(number),
        },
        rusqlite::types::Value::Text(text) => match column.col_type {
            ColumnType::INTEGER => match text.parse::<i64>() {
                Ok(number) => CellValue::Integer(number),
                Err(_) => CellValue::Text(text),
            },
            ColumnType::REAL => match text.parse::<f64>() {
                Ok(number) => CellValue::Real(number),
                Err(_) => CellValue::Text(text),
            },
            _ => CellValue::Text(text),
        },
        rusqlite::types::Value::Blob(bytes) => CellValue::Blob(bytes),
    }
}

fn cell_to_sqlite(cell: &CellValue) -> rusqlite::types::Value {
    match cell {
        CellValue::Null => rusqlite::types::Value::Null,
        CellValue::Integer(value) => rusqlite::types::Value::Integer(*value),
        CellValue::Real(value) => rusqlite::types::Value::Real(*value),
        CellValue::Text(value) => rusqlite::types::Value::Text(value.clone()),
        CellValue::Blob(value) => rusqlite::types::Value::Blob(value.clone()),
    }
}

/// Read one PostgreSQL cell through the column's source affinity.
fn pg_cell(row: &sqlx::postgres::PgRow, index: usize, column: &ColumnSpec) -> Result<CellValue> {
    Ok(match column.col_type {
        ColumnType::INTEGER => match row.try_get::<Option<i64>, _>(index)? {
            Some(value) => CellValue::Integer(value),
            None => CellValue::Null,
        },
        ColumnType::REAL => match row.try_get::<Option<f64>, _>(index)? {
            Some(value) => CellValue::Real(value),
            None => CellValue::Null,
        },
        ColumnType::BLOB => match row.try_get::<Option<Vec<u8>>, _>(index)? {
            Some(value) => CellValue::Blob(value),
            None => CellValue::Null,
        },
        ColumnType::TEXT => match row.try_get::<Option<String>, _>(index)? {
            Some(value) => CellValue::Text(value),
            None => CellValue::Null,
        },
    })
}

/// Bind one canonical cell onto a PostgreSQL query, using the column's physical
/// affinity so a typed NULL keeps the parameter's inferred type.
fn bind_cell<'q>(
    query: sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments>,
    cell: &CellValue,
    column: &ColumnSpec,
) -> sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments> {
    match cell {
        CellValue::Null => match column.col_type {
            ColumnType::INTEGER => query.bind(None::<i64>),
            ColumnType::REAL => query.bind(None::<f64>),
            ColumnType::BLOB => query.bind(None::<Vec<u8>>),
            ColumnType::TEXT => query.bind(None::<String>),
        },
        CellValue::Integer(value) => query.bind(*value),
        CellValue::Real(value) => query.bind(*value),
        CellValue::Text(value) => query.bind(value.clone()),
        CellValue::Blob(value) => query.bind(value.clone()),
    }
}

/// The identity columns of a target table (empty for the fixed tables whose
/// `id` is a plain `bigint` PK or has no identity).
async fn identity_columns(pool: &PgPool, table: &str) -> Result<Vec<String>> {
    let columns: Vec<String> = sqlx::query_scalar(
        "SELECT column_name FROM information_schema.columns
         WHERE table_name = $1 AND is_identity = 'YES'",
    )
    .bind(table)
    .fetch_all(pool)
    .await
    .with_context(|| format!("[migration] read identity columns of '{table}'"))?;
    Ok(columns)
}

/// Advance each identity column's sequence past the migrated maximum, so a
/// post-migration insert cannot collide with a carried id.
async fn reset_identity_sequences(
    pool: &PgPool,
    spec: &TableSpec,
    identity_columns: &[String],
) -> Result<()> {
    for column in identity_columns {
        let sql = format!(
            "SELECT setval(pg_get_serial_sequence($1, $2), \
             COALESCE((SELECT MAX({}) FROM {}), 1))",
            quote_ident(column),
            quote_ident(&spec.name)
        );
        sqlx::query(&sql)
            .bind(&spec.name)
            .bind(column)
            .fetch_one(pool)
            .await
            .with_context(|| {
                format!(
                    "[migration] advance identity sequence for '{}.{column}'",
                    spec.name
                )
            })?;
    }
    Ok(())
}

/// Remove exactly one row from the copied target table (the **G-275** fault
/// seam's parity-mismatch induction). `ctid` is PostgreSQL's physical row
/// locator, so this needs no primary key and is a no-op on an empty table.
async fn drop_one_target_row(pool: &PgPool, spec: &TableSpec) -> Result<()> {
    let table = quote_ident(&spec.name);
    let sql = format!(
        "DELETE FROM {table} WHERE ctid IN (SELECT ctid FROM {table} LIMIT 1)"
    );
    sqlx::query(&sql)
        .execute(pool)
        .await
        .with_context(|| {
            format!(
                "[migration] drop one row from '{}' via {MIGRATION_FORCE_MISMATCH_ENV}",
                spec.name
            )
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflict_clause_updates_every_non_pk_column_via_excluded() {
        let spec = TableSpec {
            name: "widget".to_string(),
            columns: vec![
                ColumnSpec {
                    name: "id".to_string(),
                    col_type: ColumnType::TEXT,
                    not_null: true,
                    pk_ordinal: 1,
                },
                ColumnSpec {
                    name: "label".to_string(),
                    col_type: ColumnType::TEXT,
                    not_null: true,
                    pk_ordinal: 0,
                },
            ],
            pk: vec!["id".to_string()],
        };
        assert_eq!(
            conflict_clause(&spec),
            " ON CONFLICT (\"id\") DO UPDATE SET \"label\" = EXCLUDED.\"label\""
        );
    }

    #[test]
    fn conflict_clause_is_empty_without_a_primary_key() {
        let spec = TableSpec {
            name: "orphan".to_string(),
            columns: vec![ColumnSpec {
                name: "note".to_string(),
                col_type: ColumnType::TEXT,
                not_null: false,
                pk_ordinal: 0,
            }],
            pk: Vec::new(),
        };
        assert_eq!(conflict_clause(&spec), "");
    }

    #[test]
    fn source_cells_are_normalized_to_the_declared_affinity() {
        let text = ColumnSpec {
            name: "t".to_string(),
            col_type: ColumnType::TEXT,
            not_null: false,
            pk_ordinal: 0,
        };
        let real = ColumnSpec {
            name: "r".to_string(),
            col_type: ColumnType::REAL,
            not_null: false,
            pk_ordinal: 0,
        };
        let integer = ColumnSpec {
            name: "i".to_string(),
            col_type: ColumnType::INTEGER,
            not_null: false,
            pk_ordinal: 0,
        };

        assert_eq!(
            source_cell(rusqlite::types::Value::Integer(7), &text),
            CellValue::Text("7".to_string())
        );
        assert_eq!(
            source_cell(rusqlite::types::Value::Integer(7), &real),
            CellValue::Real(7.0)
        );
        assert_eq!(
            source_cell(rusqlite::types::Value::Real(7.0), &integer),
            CellValue::Integer(7)
        );
        assert_eq!(
            source_cell(rusqlite::types::Value::Null, &text),
            CellValue::Null
        );
    }

    #[test]
    fn primary_key_values_follow_the_pk_order() {
        let spec = TableSpec {
            name: "composite".to_string(),
            columns: vec![
                ColumnSpec {
                    name: "a".to_string(),
                    col_type: ColumnType::TEXT,
                    not_null: true,
                    pk_ordinal: 2,
                },
                ColumnSpec {
                    name: "b".to_string(),
                    col_type: ColumnType::INTEGER,
                    not_null: true,
                    pk_ordinal: 1,
                },
            ],
            pk: vec!["b".to_string(), "a".to_string()],
        };
        let row = vec![
            CellValue::Text("x".to_string()),
            CellValue::Integer(3),
        ];
        assert_eq!(
            primary_key_values(&spec, &row),
            vec![CellValue::Integer(3), CellValue::Text("x".to_string())]
        );
    }
}
