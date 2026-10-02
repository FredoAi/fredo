//! ST-4 query execution / gating / pagination tests (Spec #2950).
//!
//! Deterministic and DB-free (G-222): the access mode is read from a temp
//! connection store, the G-275 failure stage is passed explicitly (never via
//! process env), and the result cache is exercised directly. A missing pool is
//! the oracle that a gate let a statement through (the command then returns the
//! typed "not open" error instead of contacting a server). The live query,
//! destructive-confirmation and connection-lost paths are the tester's QA receipt.

use serde_json::{json, Value as JsonValue};

use super::{
    line_column, plan_statements, query_execute, result_page, ResultCache, DEFAULT_PAGE, HARD_CAP,
    MAX_CACHED_RESULT_SETS, STATEMENT_TIMEOUT,
};
use crate::features::db_client::seam::ForceFailStage;
use crate::features::db_client::state::DbClientState;
use crate::features::db_client::types::{
    AccessMode, DbColumn, DbConnectionView, DbEngineKind, DbErrorKind, DbQueryArgs,
    DbResultPageArgs, QueryMode, SslMode, StatementClass, TextRange, DBCLIENT_CONNECTIONS_KEY,
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

fn state_with_force(
    dir: &tempfile::TempDir,
    id: &str,
    mode: AccessMode,
    force_fail: Option<ForceFailStage>,
) -> DbClientState {
    let state = DbClientState::new(force_fail, dir.path().to_path_buf());
    let view = DbConnectionView {
        id: id.to_string(),
        name: "test".to_string(),
        engine: DbEngineKind::Postgres,
        host: "127.0.0.1".to_string(),
        port: 5432,
        user: "postgres".to_string(),
        database: "postgres".to_string(),
        ssl_mode: SslMode::Prefer,
        access_mode: mode,
        has_password: false,
    };
    let path = dir.path().join(format!("{DBCLIENT_CONNECTIONS_KEY}.json"));
    std::fs::write(path, serde_json::to_string(&vec![view]).expect("serialize")).expect("write");
    state
}

fn state_with(dir: &tempfile::TempDir, id: &str, mode: AccessMode) -> DbClientState {
    state_with_force(dir, id, mode, None)
}

fn args(sql: &str, mode: QueryMode) -> DbQueryArgs {
    DbQueryArgs {
        connection_id: "c1".to_string(),
        sql: sql.to_string(),
        mode,
        selection: None,
        confirmed_statement_hashes: Vec::new(),
    }
}

fn columns() -> Vec<DbColumn> {
    vec![DbColumn {
        name: "n".to_string(),
        type_name: "int4".to_string(),
    }]
}

// ── R-5.2 read-only gate ──────────────────────────────────────────────────────

#[tokio::test]
async fn read_only_refuses_every_non_read_without_touching_the_server() {
    let dir = tempfile::tempdir().expect("tempdir");
    let state = state_with(&dir, "c1", AccessMode::ReadOnly);
    for sql in [
        "INSERT INTO t VALUES (1)",
        "UPDATE t SET a = 1",
        "DELETE FROM t",
        "DROP TABLE t",
        "TRUNCATE t",
        "ALTER TABLE t ADD COLUMN c int",
        "SELCT 1",
        "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
    ] {
        let outcome = query_execute(args(sql, QueryMode::Single), &state)
            .await
            .expect("outcome");
        assert!(outcome.result_sets.is_empty(), "{sql}");
        assert!(outcome.confirmation_required.is_none(), "{sql}");
        assert_eq!(
            outcome.error.expect("typed error").kind,
            DbErrorKind::ReadOnlyBlocked,
            "{sql}"
        );
    }
}

#[tokio::test]
async fn read_only_allows_reads_to_reach_the_pool_lookup() {
    let dir = tempfile::tempdir().expect("tempdir");
    let state = state_with(&dir, "c1", AccessMode::ReadOnly);
    let error = query_execute(args("SELECT 1", QueryMode::Single), &state)
        .await
        .expect_err("no pool registered");
    assert!(error.iter().any(|message| message.contains("not open")), "{error:?}");
}

// ── R-5.3 destructive confirmation ────────────────────────────────────────────

#[tokio::test]
async fn read_write_requires_confirmation_for_destructive_and_unknown() {
    let dir = tempfile::tempdir().expect("tempdir");
    let state = state_with(&dir, "c1", AccessMode::ReadWrite);
    for (sql, expected) in [
        ("UPDATE t SET a = 1", StatementClass::Destructive),
        ("DELETE FROM t", StatementClass::Destructive),
        ("DROP TABLE t", StatementClass::Destructive),
        ("SELCT 1", StatementClass::Unknown),
    ] {
        let outcome = query_execute(args(sql, QueryMode::Single), &state)
            .await
            .expect("outcome");
        assert!(outcome.result_sets.is_empty(), "{sql}");
        assert!(outcome.error.is_none(), "{sql}");
        let confirmation = outcome.confirmation_required.expect("confirmation");
        assert_eq!(confirmation.statement_class, expected, "{sql}");
        assert!(!confirmation.statement_hash.is_empty(), "{sql}");
        assert!(!confirmation.preview.is_empty(), "{sql}");
    }
}

#[tokio::test]
async fn confirmed_destructive_hash_passes_the_gate() {
    let dir = tempfile::tempdir().expect("tempdir");
    let state = state_with(&dir, "c1", AccessMode::ReadWrite);
    let sql = "DROP TABLE t";
    let first = query_execute(args(sql, QueryMode::Single), &state)
        .await
        .expect("first call");
    let hash = first
        .confirmation_required
        .expect("confirmation")
        .statement_hash;

    let mut confirmed = args(sql, QueryMode::Single);
    confirmed.confirmed_statement_hashes = vec![hash];
    let error = query_execute(confirmed, &state)
        .await
        .expect_err("gate passed; no pool");
    assert!(error.iter().any(|message| message.contains("not open")), "{error:?}");
}

#[tokio::test]
async fn a_wrong_confirmation_hash_does_not_execute() {
    let dir = tempfile::tempdir().expect("tempdir");
    let state = state_with(&dir, "c1", AccessMode::ReadWrite);
    let mut wrong = args("DROP TABLE t", QueryMode::Single);
    wrong.confirmed_statement_hashes = vec!["deadbeefdeadbeef".to_string()];
    let outcome = query_execute(wrong, &state).await.expect("outcome");
    assert!(outcome.result_sets.is_empty());
    assert!(outcome.confirmation_required.is_some());
}

#[tokio::test]
async fn read_write_write_class_needs_no_confirmation() {
    let dir = tempfile::tempdir().expect("tempdir");
    let state = state_with(&dir, "c1", AccessMode::ReadWrite);
    let error = query_execute(args("INSERT INTO t VALUES (1)", QueryMode::Single), &state)
        .await
        .expect_err("no pool");
    assert!(error.iter().any(|message| message.contains("not open")), "{error:?}");
}

// ── R-5.4 single statement / R-3.6 all statements ─────────────────────────────

#[test]
fn single_mode_plans_at_most_one_statement_and_all_keeps_order() {
    let sql = "SELECT 1; DROP TABLE t;";
    let single = plan_statements(&args(sql, QueryMode::Single));
    assert_eq!(single.len(), 1);
    assert_eq!(single[0].class, StatementClass::Read);
    assert_eq!(single[0].sql, "SELECT 1");

    let all = plan_statements(&args(sql, QueryMode::All));
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].class, StatementClass::Read);
    assert_eq!(all[1].class, StatementClass::Destructive);
    assert_eq!(all[1].sql, "DROP TABLE t");
}

#[test]
fn selection_scopes_single_mode_to_the_selected_statement() {
    let sql = "SELECT 1;\nDROP TABLE t;";
    let drop_start = sql.find("DROP").expect("DROP present");
    let drop_end = drop_start + sql[drop_start..].find(';').expect("semicolon present");
    let mut scoped = args(sql, QueryMode::Single);
    scoped.selection = Some(TextRange {
        start: drop_start,
        end: drop_end,
    });
    let planned = plan_statements(&scoped);
    assert_eq!(planned.len(), 1);
    assert_eq!(planned[0].class, StatementClass::Destructive);
    assert_eq!(planned[0].sql, "DROP TABLE t");
}

// ── G-275 forced query seam ───────────────────────────────────────────────────

#[tokio::test]
async fn forced_query_and_timeout_seams_are_typed() {
    let dir = tempfile::tempdir().expect("tempdir");
    for (stage, expected) in [
        (ForceFailStage::Query, DbErrorKind::Query),
        (ForceFailStage::Timeout, DbErrorKind::Timeout),
    ] {
        let state = state_with_force(&dir, "c1", AccessMode::ReadOnly, Some(stage));
        let outcome = query_execute(args("SELECT 1", QueryMode::Single), &state)
            .await
            .expect("outcome");
        let error = outcome.error.expect("typed error");
        assert_eq!(error.kind, expected, "{stage:?}");
        assert!(error.message.contains("forced"), "{stage:?}: {}", error.message);
    }
}

#[tokio::test]
async fn connect_and_auth_seams_do_not_affect_queries() {
    let dir = tempfile::tempdir().expect("tempdir");
    for stage in [ForceFailStage::Connect, ForceFailStage::Auth] {
        let state = state_with_force(&dir, "c1", AccessMode::ReadOnly, Some(stage));
        let error = query_execute(args("SELECT 1", QueryMode::Single), &state)
            .await
            .expect_err("no pool");
        assert!(error.iter().any(|message| message.contains("not open")), "{stage:?}: {error:?}");
        assert!(!error.iter().any(|message| message.contains("forced")), "{stage:?}: {error:?}");
    }
}

// ── Bounded cache + pagination (R-3.3/R-3.4) ──────────────────────────────────

#[test]
fn result_cache_pages_without_rerunning() {
    let mut cache = ResultCache::default();
    let rows: Vec<Vec<JsonValue>> = (0..250).map(|index| vec![json!(index)]).collect();
    cache.insert("c1".to_string(), "rs1".to_string(), columns(), rows, false, 7);

    let first = cache.page("c1", "rs1", 0, DEFAULT_PAGE).expect("first page");
    assert_eq!(first.rows.len(), DEFAULT_PAGE);
    assert_eq!(first.row_count_loaded, 100);
    assert!(first.has_more);
    assert!(!first.truncated);
    assert_eq!(first.duration_ms, 7);

    let second = cache.page("c1", "rs1", 100, DEFAULT_PAGE).expect("second page");
    assert_eq!(second.rows.len(), 100);
    assert_eq!(second.row_count_loaded, 200);
    assert!(second.has_more);

    let last = cache.page("c1", "rs1", 200, DEFAULT_PAGE).expect("last page");
    assert_eq!(last.rows.len(), 50);
    assert_eq!(last.row_count_loaded, 250);
    assert!(!last.has_more);

    let beyond = cache.page("c1", "rs1", 250, DEFAULT_PAGE).expect("beyond end");
    assert!(beyond.rows.is_empty());
    assert!(!beyond.has_more);
}

#[test]
fn result_cache_zero_limit_uses_the_default_page() {
    let mut cache = ResultCache::default();
    let rows: Vec<Vec<JsonValue>> = (0..150).map(|index| vec![json!(index)]).collect();
    cache.insert("c1".into(), "rs".into(), columns(), rows, false, 0);
    assert_eq!(cache.page("c1", "rs", 0, 0).expect("page").rows.len(), DEFAULT_PAGE);
}

#[test]
fn result_cache_rejects_unknown_and_cross_connection_pages() {
    let mut cache = ResultCache::default();
    cache.insert(
        "c1".into(),
        "rs".into(),
        columns(),
        vec![vec![json!(1)]],
        false,
        0,
    );
    assert!(cache.page("c2", "rs", 0, DEFAULT_PAGE).is_none());
    assert!(cache.page("c1", "missing", 0, DEFAULT_PAGE).is_none());
}

#[test]
fn result_cache_evicts_beyond_capacity() {
    let mut cache = ResultCache::default();
    for index in 0..(MAX_CACHED_RESULT_SETS + 2) {
        cache.insert(
            "c1".into(),
            format!("rs{index}"),
            columns(),
            vec![vec![json!(index)]],
            false,
            0,
        );
    }
    assert_eq!(cache.len(), MAX_CACHED_RESULT_SETS);
    assert!(cache.page("c1", "rs0", 0, DEFAULT_PAGE).is_none());
    assert!(
        cache
            .page("c1", &format!("rs{}", MAX_CACHED_RESULT_SETS + 1), 0, DEFAULT_PAGE)
            .is_some()
    );
}

#[tokio::test]
async fn result_page_returns_typed_error_for_unknown_id() {
    let dir = tempfile::tempdir().expect("tempdir");
    let state = state_with(&dir, "c1", AccessMode::ReadOnly);
    let error = result_page(
        DbResultPageArgs {
            connection_id: "c1".into(),
            result_set_id: "nope".into(),
            offset: 0,
            limit: DEFAULT_PAGE,
        },
        &state,
    )
    .await
    .expect_err("unknown result set");
    assert!(error.iter().any(|message| message.contains("not found")), "{error:?}");
}

// ── Bounds + position math ────────────────────────────────────────────────────

#[test]
fn plan_bounds_are_frozen() {
    assert_eq!(DEFAULT_PAGE, 100);
    assert_eq!(HARD_CAP, 5_000);
    assert_eq!(STATEMENT_TIMEOUT.as_secs(), 30);
}

#[test]
fn line_column_is_one_based_and_tracks_newlines() {
    assert_eq!(line_column("SELECT 1", 1), (1, 1));
    assert_eq!(line_column("SELECT 1", 8), (1, 8));
    assert_eq!(line_column("SELECT\n  bad", 10), (2, 3));
}
