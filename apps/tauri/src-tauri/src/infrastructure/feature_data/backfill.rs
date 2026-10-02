//! One-time declared-table projection backfill over the canonical `*_rows`
//! tables (Spec #2896, ST-4; strictly READ-ONLY, gated by the persisted
//! `feature_data_tables.backfill_done` marker).
//!
//! On startup (and after a first `feature_data_declare`), every persisted
//! declared table with `backfill_done = 0` is populated by re-running the SAME
//! projection engine over the canonical history:
//!
//! - a `row` projection feeds every canonical row of its `from` source through
//!   [`ProjectionEngine::project_row_sources`] (row declarations only — never a
//!   `sessionRollup`);
//! - a `sessionRollup` projection is recomputed ONCE per distinct canonical
//!   `sessionId` through [`ProjectionEngine::project_session_rollups`] (bounded
//!   per-group reads — total O(Σ group), never one group read per canonical row).
//!
//! The runner only ever SELECTs canonical rows ([`RtdbStore::select_snapshot`]
//! and the read-only canonical handle for session-id enumeration); it never
//! writes a canonical table. The declared-table writes and version bumps
//! all go through the engine's existing path, so a backfilled row is
//! byte-identical to a live-projected one. `backfill_done` is set as soon as a
//! table's OWN leg completes with no recorded failure (per-table incremental,
//! ST-4S) — a row-sourced table is marked even if a later rollup leg fails, and
//! vice versa; a `source: None` table completes immediately. A table with a
//! failed projection keeps its marker unset and retries on the next startup
//! (ST-4R). Failures are attributed per `(feature_id, table)` so one broken
//! declared table never suppresses a sibling.
//!
//! Each leg logs an INFO progress line every [`PROGRESS_EVERY`] fed units plus a
//! boundary line, so a slow backfill is distinguishable from a wedged one.
//!
//! The runner is spawned, never awaited on the read path — a `feature_data_read`
//! returns whatever is currently persisted and never blocks on the backfill.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;

use crate::infrastructure::feature_data::declaration::{
    ActivitySource, DataSource, FeatureDataTableDeclaration,
};
use crate::infrastructure::feature_data::projection::{DeclTableOutcome, ProjectionEngine};
use crate::infrastructure::feature_data::store::{FeatureDataStore, TableMeta};
use crate::infrastructure::rtdb::commands::IngestRow;
use crate::infrastructure::rtdb::store::{RowKind, RtdbStore, StoredRow};
use crate::infrastructure::storage::engine::{begin_read_only, CanonicalReader};

/// Fed units (canonical rows / distinct sessions) between INFO progress lines.
const PROGRESS_EVERY: usize = 5_000;

/// Backfill every persisted declared table whose `backfill_done` marker is
/// unset. Returns the number of fed units: canonical rows fed through the row
/// leg plus one recompute per distinct session fed through the rollup leg.
pub async fn backfill_pending(
    meta: &Arc<FeatureDataStore>,
    engine: &Arc<ProjectionEngine>,
    rtdb_store: &Arc<RtdbStore>,
) -> Result<usize> {
    let pending: Vec<TableMeta> = meta
        .list_tables()?
        .into_iter()
        .filter(|table| !table.backfill_done)
        .collect();
    if pending.is_empty() {
        return Ok(0);
    }

    let mut needed_sources: BTreeSet<u8> = BTreeSet::new();
    let mut row_tables: Vec<TableMeta> = Vec::new();
    let mut rollup_tables: Vec<TableMeta> = Vec::new();
    let mut completed = 0usize;
    for table in &pending {
        match serde_json::from_str::<FeatureDataTableDeclaration>(&table.declaration_json) {
            Ok(declaration) => match &declaration.source {
                Some(DataSource::Row(projection)) => {
                    needed_sources.insert(source_tag(projection.from));
                    row_tables.push(table.clone());
                }
                Some(DataSource::SessionRollup(_)) => rollup_tables.push(table.clone()),
                None => {
                    // Nothing to feed — the table completes immediately.
                    meta.set_backfill_done(&table.feature_id, &table.table_name, true)?;
                    completed += 1;
                }
            },
            Err(e) => {
                tracing::warn!(
                    target: "fredo::feature_data",
                    feature_id = %table.feature_id,
                    table = %table.table_name,
                    error = %e,
                    "persisted declaration is unreadable; backfill skipped for this table"
                );
                meta.set_backfill_done(&table.feature_id, &table.table_name, true)?;
                completed += 1;
            }
        }
    }

    let mut fed = 0usize;
    // Success-blind markers are the defect this fixes: record every
    // per-declaration failure so the owning pending table keeps
    // `backfill_done = false` and retries on the next startup (ST-4R).
    let mut failures: BTreeMap<(String, String), String> = BTreeMap::new();

    // ── Row leg: every canonical row of each needed source, row projections only.
    // Cost O(rows of the source) — a `sessionRollup` declaration is never run
    // here, so a sibling row-source table can no longer make the rollup
    // quadratic (ST-4S).
    let row_leg_start = Instant::now();
    let mut row_fed = 0usize;
    for tag in &needed_sources {
        let kind = kind_of_tag(*tag);
        for row in rtdb_store.select_snapshot(kind, "1=1", Vec::new()).await? {
            row_fed += 1;
            fed += 1;
            if row_fed.is_multiple_of(PROGRESS_EVERY) {
                tracing::info!(
                    target: "fredo::feature_data",
                    leg = "row",
                    fed = row_fed,
                    pending = row_tables.len(),
                    elapsed_ms = row_leg_start.elapsed().as_millis() as u64,
                    "declared-table backfill progress"
                );
            }
            record_outcomes(
                &engine.project_row_sources(&to_ingest_row(&row)).await,
                &mut failures,
            );
        }
    }
    tracing::info!(
        target: "fredo::feature_data",
        leg = "row",
        fed = row_fed,
        pending = row_tables.len(),
        elapsed_ms = row_leg_start.elapsed().as_millis() as u64,
        "declared-table backfill leg complete"
    );
    // Mark the row-sourced tables that completed BEFORE the rollup leg runs, so
    // a later rollup failure cannot un-complete them (ST-4S).
    for table in &row_tables {
        if failures.contains_key(&(table.feature_id.clone(), table.table_name.clone())) {
            continue;
        }
        meta.set_backfill_done(&table.feature_id, &table.table_name, true)?;
        completed += 1;
    }

    // ── Rollup leg: one recompute per distinct canonical session, rollup
    // declarations only. Total cost O(Σ group).
    if !rollup_tables.is_empty() {
        let rollup_leg_start = Instant::now();
        let mut rollup_fed = 0usize;
        for session_id in distinct_session_ids(engine).await? {
            rollup_fed += 1;
            fed += 1;
            if rollup_fed.is_multiple_of(PROGRESS_EVERY) {
                tracing::info!(
                    target: "fredo::feature_data",
                    leg = "rollup",
                    fed = rollup_fed,
                    pending = rollup_tables.len(),
                    elapsed_ms = rollup_leg_start.elapsed().as_millis() as u64,
                    "declared-table backfill progress"
                );
            }
            record_outcomes(
                &engine.project_session_rollups(&session_id).await,
                &mut failures,
            );
        }
        tracing::info!(
            target: "fredo::feature_data",
            leg = "rollup",
            fed = rollup_fed,
            pending = rollup_tables.len(),
            elapsed_ms = rollup_leg_start.elapsed().as_millis() as u64,
            "declared-table backfill leg complete"
        );
        for table in &rollup_tables {
            if failures.contains_key(&(table.feature_id.clone(), table.table_name.clone())) {
                continue;
            }
            meta.set_backfill_done(&table.feature_id, &table.table_name, true)?;
            completed += 1;
        }
    }

    // Per-failed-table attribution over the PENDING set (a table that completed
    // above is never re-attributed): a damaged table keeps `backfill_done`
    // unset and retries while its healthy siblings stay completed (ST-4R).
    let mut failed_tables: Vec<(String, String, String)> = Vec::new();
    for table in &pending {
        if let Some(error) = failures.get(&(table.feature_id.clone(), table.table_name.clone())) {
            failed_tables.push((
                table.feature_id.clone(),
                table.table_name.clone(),
                error.clone(),
            ));
        }
    }

    for (feature_id, table, error) in &failed_tables {
        tracing::error!(
            target: "fredo::feature_data",
            feature_id = %feature_id,
            table = %table,
            error = %error,
            "declared-table projection backfill failed; backfill_done left unset so the next startup retries"
        );
    }
    tracing::info!(
        target: "fredo::feature_data",
        tables = pending.len(),
        completed,
        failed = failed_tables.len(),
        fed,
        "declared-table projection backfill complete"
    );
    Ok(fed)
}

/// Record the first failure for every `(feature_id, table)` an outcome reports.
fn record_outcomes(
    outcomes: &[DeclTableOutcome],
    failures: &mut BTreeMap<(String, String), String>,
) {
    for outcome in outcomes {
        if let Err(e) = &outcome.result {
            failures
                .entry((outcome.feature_id.clone(), outcome.table.clone()))
                .or_insert_with(|| format!("{e:#}"));
        }
    }
}

/// Spawned startup/declare wrapper: logs and never propagates.
pub async fn run_backfill(
    meta: Arc<FeatureDataStore>,
    engine: Arc<ProjectionEngine>,
    rtdb_store: Arc<RtdbStore>,
) {
    match backfill_pending(&meta, &engine, &rtdb_store).await {
        Ok(fed) if fed > 0 => tracing::info!(
            target: "fredo::feature_data",
            fed,
            "declared-table backfill projected rows"
        ),
        Ok(_) => {}
        Err(e) => tracing::warn!(
            target: "fredo::feature_data",
            error = %e,
            "declared-table backfill failed; declared reads are unaffected"
        ),
    }
}

fn source_tag(source: ActivitySource) -> u8 {
    match source {
        ActivitySource::Chat => 0,
        ActivitySource::ToolUse => 1,
        ActivitySource::AgentSession => 2,
    }
}

fn kind_of_tag(tag: u8) -> RowKind {
    match tag {
        1 => RowKind::ToolUse,
        2 => RowKind::AgentSession,
        _ => RowKind::Chat,
    }
}

fn to_ingest_row(row: &StoredRow) -> IngestRow {
    match row {
        StoredRow::Chat(inner) => IngestRow::Chat(inner.clone()),
        StoredRow::ToolUse(inner) => IngestRow::ToolUse(inner.clone()),
        StoredRow::AgentSession(inner) => IngestRow::AgentSession(inner.clone()),
    }
}

/// Distinct canonical sessionIds across all three row tables (read-only).
///
/// Uses the engine-selected read-only canonical handle owned by the projection
/// engine (REQ-9): the shared PostgreSQL pool wrapped in a READ ONLY
/// transaction — never a per-run `Connection::open`.
async fn distinct_session_ids(engine: &ProjectionEngine) -> Result<Vec<String>> {
    const SQL: &str = "SELECT session_id FROM chat_rows
         UNION SELECT session_id FROM tool_use_rows
         UNION SELECT session_id FROM agent_session_rows";
    match engine.canonical_conn().await? {
        CanonicalReader::Postgres(pool) => {
            let mut tx = begin_read_only(&pool).await?;
            let rows: Vec<(String,)> = sqlx::query_as(SQL).fetch_all(&mut *tx).await?;
            tx.commit().await?;
            Ok(rows.into_iter().map(|(session_id,)| session_id).collect())
        }
    }
}
