//! One-time declared-table projection backfill over the canonical `*_rows`
//! tables (Spec #2896, ST-4; strictly READ-ONLY, gated by the persisted
//! `feature_data_tables.backfill_done` marker).
//!
//! On startup (and after a first `feature_data_declare`), every persisted
//! declared table with `backfill_done = 0` is populated by re-running the SAME
//! projection engine over the canonical history:
//!
//! - a `row` projection feeds every canonical row of its `from` source through
//!   [`ProjectionEngine::project`];
//! - a `sessionRollup` projection feeds ONE representative canonical row per
//!   distinct `sessionId` so the group is recomputed (bounded per-group reads).
//!
//! The runner only ever SELECTs canonical rows ([`RtdbStore::select_snapshot`]
//! and a `PRAGMA query_only=ON` connection for session-id enumeration); it
//! never writes a canonical table. The declared-table writes and version bumps
//! all go through the engine's existing path, so a backfilled row is
//! byte-identical to a live-projected one and `backfill_done` is set once the
//! pass completes.
//!
//! The runner is spawned, never awaited on the read path — a `feature_data_read`
//! returns whatever is currently persisted and never blocks on the backfill.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;

use crate::infrastructure::feature_data::declaration::{
    ActivitySource, DataSource, FeatureDataTableDeclaration,
};
use crate::infrastructure::feature_data::projection::ProjectionEngine;
use crate::infrastructure::feature_data::store::{FeatureDataStore, TableMeta};
use crate::infrastructure::rtdb::commands::IngestRow;
use crate::infrastructure::rtdb::store::{RowKind, RtdbStore, StoredRow};

/// Backfill every persisted declared table whose `backfill_done` marker is
/// unset. Returns the number of canonical rows fed through the engine.
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
    let mut needs_rollup = false;
    for table in &pending {
        match serde_json::from_str::<FeatureDataTableDeclaration>(&table.declaration_json) {
            Ok(declaration) => match &declaration.source {
                Some(DataSource::Row(projection)) => {
                    needed_sources.insert(source_tag(projection.from));
                }
                Some(DataSource::SessionRollup(_)) => needs_rollup = true,
                None => {}
            },
            Err(e) => tracing::warn!(
                target: "fredo::feature_data",
                feature_id = %table.feature_id,
                table = %table.table_name,
                error = %e,
                "persisted declaration is unreadable; backfill skipped for this table"
            ),
        }
    }

    let mut fed = 0usize;

    // Row projections: every canonical row of each needed source.
    for tag in &needed_sources {
        let kind = kind_of_tag(*tag);
        for row in rtdb_store.select_snapshot(kind, "1=1", Vec::new())? {
            if let Err(e) = engine.project(&to_ingest_row(&row), &[]) {
                tracing::warn!(
                    target: "fredo::feature_data",
                    error = %e,
                    "declared-table backfill projection failed; continuing"
                );
            } else {
                fed += 1;
            }
        }
    }

    // sessionRollup: one representative row per distinct sessionId.
    if needs_rollup {
        for session_id in distinct_session_ids(data_dir)? {
            if let Some(row) = representative_row(rtdb_store, &session_id)? {
                if let Err(e) = engine.project(&to_ingest_row(&row), &[]) {
                    tracing::warn!(
                        target: "fredo::feature_data",
                        error = %e,
                        "declared-table backfill rollup failed; continuing"
                    );
                } else {
                    fed += 1;
                }
            }
        }
    }

    for table in &pending {
        meta.set_backfill_done(&table.feature_id, &table.table_name, true)?;
    }
    tracing::info!(
        target: "fredo::feature_data",
        tables = pending.len(),
        fed,
        "declared-table projection backfill complete"
    );
    Ok(fed)
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

/// The first canonical row for `session_id` (chat preferred, then tool, then
/// agent) — enough to recompute the group in [`ProjectionEngine::project`].
fn representative_row(rtdb_store: &Arc<RtdbStore>, session_id: &str) -> Result<Option<StoredRow>> {
    for kind in [RowKind::Chat, RowKind::ToolUse, RowKind::AgentSession] {
        let rows = rtdb_store.select_snapshot(
            kind,
            "session_id = ?1",
            vec![SqlValue::Text(session_id.to_string())],
        )?;
        if let Some(row) = rows.into_iter().next() {
            return Ok(Some(row));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    use crate::infrastructure::feature_data::declaration::{
        ColumnOwner, DeclaredColumn, DeclaredColumnType, FieldMapping, Retention, RowProjection,
        RowProjectionKind, SessionRollupKind, SessionRollupProjection,
    };
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

    fn setup(declaration: FeatureDataTableDeclaration) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let rtdb_store = Arc::new(RtdbStore::open(dir.path().to_path_buf()).unwrap());
        rtdb_store.ensure_schema().unwrap();
        let meta = Arc::new(FeatureDataStore::open(dir.path().to_path_buf()).unwrap());
        meta.ensure_schema().unwrap();
        let tables = Arc::new(FeatureStore::open(dir.path().to_path_buf()).unwrap());
        let registry = DeclarationRegistry::new(meta.clone(), tables.clone());
        let full = crate::infrastructure::feature_data::declaration::FeatureDataDeclaration {
            feature_id: "probe".to_string(),
            declaration_revision: "probe.v1".to_string(),
            tables: vec![declaration],
        };
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

    fn chat_row(session_id: &str, correlation_id: &str, seq: i64, reply: &str) -> ChatRow {
        ChatRow {
            session_id: session_id.to_string(),
            correlation_id: correlation_id.to_string(),
            seq,
            started_at_ns: Some(1_000),
            ended_at_ns: None,
            updated_at: "2026-09-18T00:00:00+00:00".to_string(),
            state: RowState::Response,
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
}
