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
//! and a `PRAGMA query_only=ON` connection for session-id enumeration); it
//! never writes a canonical table. The declared-table writes and version bumps
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
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use rusqlite::Connection;

use crate::infrastructure::feature_data::declaration::{
    ActivitySource, DataSource, FeatureDataTableDeclaration,
};
use crate::infrastructure::feature_data::projection::{DeclTableOutcome, ProjectionEngine};
use crate::infrastructure::feature_data::store::{FeatureDataStore, TableMeta};
use crate::infrastructure::rtdb::commands::IngestRow;
use crate::infrastructure::rtdb::store::{RowKind, RtdbStore, StoredRow};

/// Fed units (canonical rows / distinct sessions) between INFO progress lines.
const PROGRESS_EVERY: usize = 5_000;

/// Backfill every persisted declared table whose `backfill_done` marker is
/// unset. Returns the number of fed units: canonical rows fed through the row
/// leg plus one recompute per distinct session fed through the rollup leg.
pub fn backfill_pending(
    data_dir: &Path,
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
        for row in rtdb_store.select_snapshot(kind, "1=1", Vec::new())? {
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
                &engine.project_row_sources(&to_ingest_row(&row)),
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
        for session_id in distinct_session_ids(data_dir)? {
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
            record_outcomes(&engine.project_session_rollups(&session_id), &mut failures);
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
    data_dir: std::path::PathBuf,
    meta: Arc<FeatureDataStore>,
    engine: Arc<ProjectionEngine>,
    rtdb_store: Arc<RtdbStore>,
) {
    match backfill_pending(&data_dir, &meta, &engine, &rtdb_store) {
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
fn distinct_session_ids(data_dir: &Path) -> Result<Vec<String>> {
    let conn = Connection::open(data_dir.join("fredo.db"))?;
    conn.execute_batch("PRAGMA query_only=ON;")?;
    let mut stmt = conn.prepare(
        "SELECT session_id FROM chat_rows
         UNION SELECT session_id FROM tool_use_rows
         UNION SELECT session_id FROM agent_session_rows",
    )?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use crate::infrastructure::feature_data::declaration::{
        ColumnOwner, DeclaredColumn, DeclaredColumnType, FeatureDataDeclaration, FieldMapping,
        Retention, RowProjection, RowProjectionKind, SessionRollupKind, SessionRollupProjection,
    };
    use crate::infrastructure::feature_data::projection::{DeclaredRowChange, DeclaredRowObserver};
    use crate::infrastructure::feature_data::registry::DeclarationRegistry;
    use crate::infrastructure::feature_data::store::FeatureDataStore;
    use crate::infrastructure::rtdb::rows::{ChatRow, RowState};
    use crate::infrastructure::storage::feature_store::FeatureStore;

    fn backend_column(name: &str, ty: DeclaredColumnType, nullable: bool) -> DeclaredColumn {
        DeclaredColumn {
            name: name.to_string(),
            col_type: ty,
            nullable,
            owner: ColumnOwner::Backend,
        }
    }

    fn row_declaration() -> FeatureDataTableDeclaration {
        FeatureDataTableDeclaration {
            name: "turns".to_string(),
            primary_key: vec!["id".to_string()],
            columns: vec![
                backend_column("id", DeclaredColumnType::Text, false),
                backend_column("reply", DeclaredColumnType::Text, true),
            ],
            source: Some(DataSource::Row(RowProjection {
                kind: RowProjectionKind::Row,
                from: ActivitySource::Chat,
                r#where: None,
                select: BTreeMap::from([
                    (
                        "id".to_string(),
                        FieldMapping::Field {
                            field: "correlationId".to_string(),
                        },
                    ),
                    (
                        "reply".to_string(),
                        FieldMapping::Field {
                            field: "agentReply".to_string(),
                        },
                    ),
                ]),
            })),
            retention: None,
        }
    }

    fn rollup_declaration() -> FeatureDataTableDeclaration {
        FeatureDataTableDeclaration {
            name: "sessions".to_string(),
            primary_key: vec!["sessionId".to_string()],
            columns: vec![
                backend_column("sessionId", DeclaredColumnType::Text, false),
                backend_column("chatRowCount", DeclaredColumnType::Integer, false),
                backend_column("latestAt", DeclaredColumnType::Text, false),
            ],
            source: Some(DataSource::SessionRollup(SessionRollupProjection {
                kind: SessionRollupKind::SessionRollup,
                exclude_dispatch_names: vec!["build".to_string(), "plan".to_string()],
                terminal_states: vec![RowState::Response, RowState::Timeout],
            })),
            retention: Some(Retention {
                max_rows: Some(500),
                ttl_days: None,
            }),
        }
    }

    struct Harness {
        _dir: tempfile::TempDir,
        data_dir: std::path::PathBuf,
        meta: Arc<FeatureDataStore>,
        engine: Arc<ProjectionEngine>,
        rtdb_store: Arc<RtdbStore>,
        tables: Arc<FeatureStore>,
    }

    fn setup_full(full: FeatureDataDeclaration) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let rtdb_store = Arc::new(RtdbStore::open(dir.path().to_path_buf()).unwrap());
        rtdb_store.ensure_schema().unwrap();
        let meta = Arc::new(FeatureDataStore::open(dir.path().to_path_buf()).unwrap());
        meta.ensure_schema().unwrap();
        let tables = Arc::new(FeatureStore::open(dir.path().to_path_buf()).unwrap());
        let registry = DeclarationRegistry::new(meta.clone(), tables.clone());
        registry.declare(&full).unwrap();
        let engine =
            Arc::new(ProjectionEngine::new(dir.path().to_path_buf(), meta.clone(), tables.clone()).unwrap());
        Harness {
            data_dir: dir.path().to_path_buf(),
            _dir: dir,
            meta,
            engine,
            rtdb_store,
            tables,
        }
    }

    fn setup(declaration: FeatureDataTableDeclaration) -> Harness {
        setup_full(FeatureDataDeclaration {
            feature_id: "probe".to_string(),
            declaration_revision: "probe.v1".to_string(),
            tables: vec![declaration],
        })
    }

    /// A `row`-sourced table projecting `correlationId`/`agentReply`.
    fn row_table(name: &str, from: ActivitySource) -> FeatureDataTableDeclaration {
        FeatureDataTableDeclaration {
            name: name.to_string(),
            primary_key: vec!["id".to_string()],
            columns: vec![
                backend_column("id", DeclaredColumnType::Text, false),
                backend_column("reply", DeclaredColumnType::Text, true),
            ],
            source: Some(DataSource::Row(RowProjection {
                kind: RowProjectionKind::Row,
                from,
                r#where: None,
                select: BTreeMap::from([
                    (
                        "id".to_string(),
                        FieldMapping::Field {
                            field: "correlationId".to_string(),
                        },
                    ),
                    (
                        "reply".to_string(),
                        FieldMapping::Field {
                            field: "agentReply".to_string(),
                        },
                    ),
                ]),
            })),
            retention: None,
        }
    }

    fn chat_row(session_id: &str, correlation_id: &str, seq: i64, reply: &str) -> ChatRow {
        ChatRow {
            session_id: session_id.to_string(),
            correlation_id: correlation_id.to_string(),
            seq,
            started_at_ns: Some(1_000),
            ended_at_ns: None,
            updated_at: "2026-09-18T00:00:00+00:00".to_string(),
            state: RowState::Response,
            provider: None,
            user_message: None,
            agent_reply: Some(reply.to_string()),
            prompt_tokens: None,
            completion_tokens: None,
            cache_read_tokens: None,
            cost_usd: None,
            model: None,
            parent_session_id: None,
            composited_child_session_id: None,
            raw_json: "{}".to_string(),
        }
    }

    fn declared(h: &Harness, table: &str) -> Vec<serde_json::Map<String, serde_json::Value>> {
        h.tables.query("probe", table, None, None, None).unwrap()
    }

    fn marker(h: &Harness, table: &str) -> bool {
        h.meta
            .get_table("probe", table)
            .unwrap()
            .unwrap()
            .backfill_done
    }

    #[derive(Default)]
    struct CollectingObserver {
        changes: Mutex<Vec<DeclaredRowChange>>,
    }

    impl DeclaredRowObserver for CollectingObserver {
        fn on_declared_row_change(&self, change: &DeclaredRowChange) {
            match self.changes.lock() {
                Ok(mut changes) => changes.push(change.clone()),
                Err(poisoned) => poisoned.into_inner().push(change.clone()),
            }
        }
    }

    #[test]
    fn backfill_projects_pending_rows_and_sets_the_marker() {
        let h = setup(row_declaration());
        h.rtdb_store
            .upsert_chat_rows(&[chat_row("ses_1", "ses_1_1", 1, "one"), chat_row("ses_1", "ses_1_2", 2, "two")])
            .unwrap();

        let fed = backfill_pending(&h.data_dir, &h.meta, &h.engine, &h.rtdb_store).unwrap();
        assert_eq!(fed, 2, "every canonical chat row is fed once");
        let rows = declared(&h, "turns");
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|row| row.get("reply") == Some(&serde_json::json!("one"))));
        assert!(marker(&h, "turns"), "the backfill marker is set");

        // A second run is a no-op (marker gated).
        let again = backfill_pending(&h.data_dir, &h.meta, &h.engine, &h.rtdb_store).unwrap();
        assert_eq!(again, 0, "backfill is one-time");
        assert_eq!(declared(&h, "turns").len(), 2, "no duplicate projection");
    }

    #[test]
    fn backfill_never_modifies_canonical_rows() {
        let h = setup(row_declaration());
        h.rtdb_store
            .upsert_chat_rows(&[chat_row("ses_1", "ses_1_1", 1, "one")])
            .unwrap();
        let (chats_before, _, _) = h.rtdb_store.row_counts().unwrap();

        backfill_pending(&h.data_dir, &h.meta, &h.engine, &h.rtdb_store).unwrap();

        let (chats_after, _, _) = h.rtdb_store.row_counts().unwrap();
        assert_eq!(chats_before, chats_after, "canonical rows are read-only to backfill");
    }

    #[test]
    fn backfill_recomputes_a_session_rollup_per_distinct_session() {
        let h = setup(rollup_declaration());
        h.rtdb_store
            .upsert_chat_rows(&[
                chat_row("ses_a", "ses_a_1", 1, "answer a"),
                chat_row("ses_b", "ses_b_1", 1, "answer b"),
            ])
            .unwrap();

        let fed = backfill_pending(&h.data_dir, &h.meta, &h.engine, &h.rtdb_store).unwrap();
        assert_eq!(fed, 2, "one representative row per distinct session");
        let rows = declared(&h, "sessions");
        assert_eq!(rows.len(), 2, "both sessions qualify");
        let first = rows
            .iter()
            .find(|row| row.get("sessionId") == Some(&serde_json::json!("ses_b")))
            .expect("session b");
        assert_eq!(first.get("chatRowCount"), Some(&serde_json::json!(1)));
        assert!(marker(&h, "sessions"));
    }

    /// The discriminating ST-4S test: with BOTH a `row` table and a
    /// `sessionRollup` table pending, the rollup is recomputed once per distinct
    /// session (M), never once per canonical row (N). On the pre-fix code the row
    /// leg routed every row through `project_reporting`, so the counter would be
    /// N and the row-notification/rollup-notification split would collapse.
    #[test]
    fn rollup_is_recomputed_once_per_session_not_per_row() {
        let h = setup_full(FeatureDataDeclaration {
            feature_id: "probe".to_string(),
            declaration_revision: "probe.row+rollup.v1".to_string(),
            tables: vec![
                row_table("turns", ActivitySource::Chat),
                rollup_declaration(),
            ],
        });
        // N = 6 canonical chat rows across M = 2 sessions (N > M).
        h.rtdb_store
            .upsert_chat_rows(&[
                chat_row("ses_a", "ses_a_1", 1, "a1"),
                chat_row("ses_a", "ses_a_2", 2, "a2"),
                chat_row("ses_a", "ses_a_3", 3, "a3"),
                chat_row("ses_b", "ses_b_1", 1, "b1"),
                chat_row("ses_b", "ses_b_2", 2, "b2"),
                chat_row("ses_b", "ses_b_3", 3, "b3"),
            ])
            .unwrap();

        let observer = Arc::new(CollectingObserver::default());
        h.engine
            .set_declared_row_observer(observer.clone() as Arc<dyn DeclaredRowObserver>);

        let fed = backfill_pending(&h.data_dir, &h.meta, &h.engine, &h.rtdb_store).unwrap();

        assert_eq!(
            h.engine.rollup_recompute_count(),
            2,
            "the rollup is recomputed once per distinct session (M), never once per canonical row (N=6)"
        );
        assert_eq!(fed, 6 + 2, "6 canonical rows + 2 distinct-session recomputes");
        assert_eq!(
            declared(&h, "turns").len(),
            6,
            "the row-sourced table projected every canonical row"
        );
        assert_eq!(declared(&h, "sessions").len(), 2, "both sessions qualify");

        let changes = observer.changes.lock().unwrap();
        let rollup_notifications = changes
            .iter()
            .filter(|change| change.table == "sessions")
            .count();
        assert_eq!(
            rollup_notifications, 2,
            "one rollup notification per distinct session"
        );
        assert!(marker(&h, "turns"), "the row leg completes");
        assert!(marker(&h, "sessions"), "the rollup leg completes");
    }

    /// `fed` observably separates the two legs: rows fed through the row
    /// projections + one recompute per distinct session.
    #[test]
    fn fed_counts_row_rows_plus_distinct_sessions() {
        let h = setup_full(FeatureDataDeclaration {
            feature_id: "probe".to_string(),
            declaration_revision: "probe.row+rollup.fed.v1".to_string(),
            tables: vec![
                row_table("turns", ActivitySource::Chat),
                rollup_declaration(),
            ],
        });
        h.rtdb_store
            .upsert_chat_rows(&[
                chat_row("ses_a", "ses_a_1", 1, "a1"),
                chat_row("ses_a", "ses_a_2", 2, "a2"),
                chat_row("ses_b", "ses_b_1", 1, "b1"),
            ])
            .unwrap();

        let fed = backfill_pending(&h.data_dir, &h.meta, &h.engine, &h.rtdb_store).unwrap();
        assert_eq!(
            fed,
            3 + 2,
            "3 canonical rows fed through the row leg + 2 distinct-session rollup recomputes"
        );
        assert_eq!(h.engine.rollup_recompute_count(), 2);
    }

    /// Per-leg incremental markers (ST-4S): the row-sourced sibling is marked as
    /// soon as the row leg completes, so a LATER rollup-leg failure cannot
    /// un-complete it; the damaged rollup table stays `false` and a second run
    /// retries only it.
    #[test]
    fn completed_table_is_marked_before_a_later_leg_fails() {
        let h = setup_full(FeatureDataDeclaration {
            feature_id: "probe".to_string(),
            declaration_revision: "probe.row+broken-rollup.v1".to_string(),
            tables: vec![
                row_table("turns", ActivitySource::Chat),
                rollup_declaration(),
            ],
        });
        h.rtdb_store
            .upsert_chat_rows(&[
                chat_row("ses_a", "ses_a_1", 1, "a1"),
                chat_row("ses_a", "ses_a_2", 2, "a2"),
                chat_row("ses_b", "ses_b_1", 1, "b1"),
            ])
            .unwrap();
        // Damage the rollup physical table: recreate it WITHOUT the declared
        // `chatRowCount` column, so every rollup projection fails.
        h.tables
            .execute_batch(
                "DROP TABLE feature_probe_sessions; \
                 CREATE TABLE feature_probe_sessions \
                 (sessionId TEXT PRIMARY KEY, _row_version INTEGER, _updated_at TEXT);",
            )
            .unwrap();

        let fed = backfill_pending(&h.data_dir, &h.meta, &h.engine, &h.rtdb_store).unwrap();
        assert_eq!(fed, 3 + 2, "both legs are fed in one run");
        assert_eq!(
            declared(&h, "turns").len(),
            3,
            "the row-sourced sibling projected every row"
        );
        assert!(
            marker(&h, "turns"),
            "the row leg's table is marked before the rollup leg fails"
        );
        assert!(
            !marker(&h, "sessions"),
            "the damaged rollup table keeps backfill_done unset"
        );

        // A second run retries ONLY the damaged rollup table: the row leg has no
        // pending row-sourced table left, so it feeds nothing.
        let retry = backfill_pending(&h.data_dir, &h.meta, &h.engine, &h.rtdb_store).unwrap();
        assert_eq!(retry, 2, "only the still-pending rollup table is re-fed");
        assert_eq!(
            declared(&h, "turns").len(),
            3,
            "no duplicate row projection on retry"
        );
        assert!(!marker(&h, "sessions"), "still unset until it can project");
    }

    #[test]
    fn backfill_failed_projection_leaves_marker_unset_and_does_not_suppress_a_sibling() {
        let h = setup_full(FeatureDataDeclaration {
            feature_id: "probe".to_string(),
            declaration_revision: "probe.multi.v1".to_string(),
            tables: vec![
                row_table("broken", ActivitySource::Chat),
                row_table("healthy", ActivitySource::Chat),
            ],
        });
        h.rtdb_store
            .upsert_chat_rows(&[
                chat_row("ses_1", "ses_1_1", 1, "one"),
                chat_row("ses_1", "ses_1_2", 2, "two"),
            ])
            .unwrap();
        // Damage the `broken` physical table: recreate it without the declared
        // `reply` column, so every projection against it fails independently.
        h.tables
            .execute_batch(
                "DROP TABLE feature_probe_broken; \
                 CREATE TABLE feature_probe_broken \
                 (id TEXT PRIMARY KEY, _row_version INTEGER, _updated_at TEXT);",
            )
            .unwrap();

        let fed = backfill_pending(&h.data_dir, &h.meta, &h.engine, &h.rtdb_store).unwrap();
        assert_eq!(fed, 2, "both canonical chat rows are fed through the engine");

        assert_eq!(
            declared(&h, "healthy").len(),
            2,
            "the healthy sibling still projects every row"
        );
        assert!(marker(&h, "healthy"), "the healthy sibling completes");
        assert!(
            !marker(&h, "broken"),
            "a table with a failed projection keeps backfill_done unset"
        );

        // A retry retries the still-pending broken table and does not duplicate
        // the healthy sibling's rows.
        let before = declared(&h, "healthy").len();
        backfill_pending(&h.data_dir, &h.meta, &h.engine, &h.rtdb_store).unwrap();
        assert_eq!(
            declared(&h, "healthy").len(),
            before,
            "no duplicate projection on retry"
        );
        assert!(!marker(&h, "broken"), "still unset until it can project");
    }

    #[test]
    fn backfill_zero_row_source_completes_and_sets_the_marker() {
        let h = setup_full(FeatureDataDeclaration {
            feature_id: "probe".to_string(),
            declaration_revision: "probe.empty.v1".to_string(),
            tables: vec![row_table("empty", ActivitySource::ToolUse)],
        });
        // No canonical tool rows exist.

        let fed = backfill_pending(&h.data_dir, &h.meta, &h.engine, &h.rtdb_store).unwrap();
        assert_eq!(fed, 0, "nothing to feed");
        assert!(declared(&h, "empty").is_empty());
        assert!(
            marker(&h, "empty"),
            "a source with zero canonical rows completes successfully"
        );
    }

    #[test]
    fn backfill_source_none_table_completes_and_sets_the_marker() {
        let h = setup_full(FeatureDataDeclaration {
            feature_id: "probe".to_string(),
            declaration_revision: "probe.none.v1".to_string(),
            tables: vec![FeatureDataTableDeclaration {
                name: "manual".to_string(),
                primary_key: vec!["id".to_string()],
                columns: vec![backend_column("id", DeclaredColumnType::Text, false)],
                source: None,
                retention: None,
            }],
        });

        let fed = backfill_pending(&h.data_dir, &h.meta, &h.engine, &h.rtdb_store).unwrap();
        assert_eq!(fed, 0);
        assert!(marker(&h, "manual"), "a source:None table completes");
    }
}
