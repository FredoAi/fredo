//! ST-1 foundation tests (Spec #2950).
//!
//! Pins the frozen producer contract every later sub-task consumes:
//! the `camelCase` wire names, the persistence/credential key constants, the
//! G-275 seam parsing/resolution (pure — no env mutation, so the suite is
//! order-independent, G-222), the managed-state pool registry, and the typed
//! `NotImplemented` stubs.

use std::path::PathBuf;

use super::seam::{parse_force_fail, resolve_state_dir, ForceFailStage, DEFAULT_DBCLIENT_STATE_DIR};
use super::state::DbClientState;
use super::types::{
    history_key, keyring_account, saved_queries_key, AccessMode, DbColumn, DbConnectionView,
    DbEngineKind, DbErrorKind, DbObjectKind, DbQueryError, DbResultSet, QueryMode, SslMode,
    StatementClass, DBCLIENT_CONNECTIONS_KEY, DBCLIENT_HISTORY_KEY_PREFIX,
    DBCLIENT_KEYRING_SERVICE, DBCLIENT_PREFS_KEY, DBCLIENT_SAVED_QUERIES_KEY_PREFIX,
};

fn sample_view() -> DbConnectionView {
    DbConnectionView {
        id: "11111111-1111-4111-8111-111111111111".into(),
        name: "local".into(),
        engine: DbEngineKind::Postgres,
        host: "127.0.0.1".into(),
        port: 5432,
        user: "postgres".into(),
        database: "postgres".into(),
        ssl_mode: SslMode::VerifyCa,
        access_mode: AccessMode::ReadOnly,
        has_password: true,
    }
}

#[test]
fn connection_view_serializes_camel_case_and_has_no_secret() {
    let value = serde_json::to_value(sample_view()).expect("serialize view");
    assert_eq!(value["engine"], "postgres");
    assert_eq!(value["sslMode"], "verifyCa");
    assert_eq!(value["accessMode"], "readOnly");
    assert_eq!(value["host"], "127.0.0.1");
    assert_eq!(value["port"].as_u64(), Some(5432));
    assert_eq!(value["hasPassword"].as_bool(), Some(true));
    // The wire view structurally cannot carry the secret.
    assert!(value.get("password").is_none());
    assert!(value.get("secret").is_none());
}

#[test]
fn enum_wire_values_are_frozen() {
    let cases = [
        (serde_json::to_value(DbEngineKind::Postgres).unwrap(), "postgres"),
        (serde_json::to_value(SslMode::Disable).unwrap(), "disable"),
        (serde_json::to_value(SslMode::Prefer).unwrap(), "prefer"),
        (serde_json::to_value(SslMode::Require).unwrap(), "require"),
        (serde_json::to_value(SslMode::VerifyCa).unwrap(), "verifyCa"),
        (serde_json::to_value(SslMode::VerifyFull).unwrap(), "verifyFull"),
        (serde_json::to_value(AccessMode::ReadOnly).unwrap(), "readOnly"),
        (serde_json::to_value(AccessMode::ReadWrite).unwrap(), "readWrite"),
        (serde_json::to_value(StatementClass::Read).unwrap(), "read"),
        (serde_json::to_value(StatementClass::Write).unwrap(), "write"),
        (serde_json::to_value(StatementClass::Ddl).unwrap(), "ddl"),
        (serde_json::to_value(StatementClass::Destructive).unwrap(), "destructive"),
        (serde_json::to_value(StatementClass::Unknown).unwrap(), "unknown"),
        (serde_json::to_value(DbObjectKind::Database).unwrap(), "database"),
        (serde_json::to_value(DbObjectKind::Schema).unwrap(), "schema"),
        (serde_json::to_value(DbObjectKind::Table).unwrap(), "table"),
        (serde_json::to_value(DbObjectKind::View).unwrap(), "view"),
        (serde_json::to_value(DbObjectKind::Column).unwrap(), "column"),
        (serde_json::to_value(DbObjectKind::Index).unwrap(), "index"),
        (serde_json::to_value(DbObjectKind::Key).unwrap(), "key"),
        (serde_json::to_value(DbObjectKind::Function).unwrap(), "function"),
        (serde_json::to_value(DbErrorKind::Auth).unwrap(), "auth"),
        (serde_json::to_value(DbErrorKind::Unreachable).unwrap(), "unreachable"),
        (serde_json::to_value(DbErrorKind::Timeout).unwrap(), "timeout"),
        (serde_json::to_value(DbErrorKind::Tls).unwrap(), "tls"),
        (serde_json::to_value(DbErrorKind::Config).unwrap(), "config"),
        (serde_json::to_value(DbErrorKind::ReadOnlyBlocked).unwrap(), "readOnlyBlocked"),
        (
            serde_json::to_value(DbErrorKind::ConfirmationRequired).unwrap(),
            "confirmationRequired",
        ),
        (serde_json::to_value(DbErrorKind::ConnectionLost).unwrap(), "connectionLost"),
        (serde_json::to_value(DbErrorKind::Query).unwrap(), "query"),
        (serde_json::to_value(DbErrorKind::Other).unwrap(), "other"),
        (serde_json::to_value(QueryMode::Single).unwrap(), "single"),
        (serde_json::to_value(QueryMode::All).unwrap(), "all"),
    ];
    for (actual, expected) in cases {
        assert_eq!(actual, serde_json::Value::String(expected.to_string()));
    }
}

#[test]
fn persistence_keys_and_keyring_account_match_contract() {
    assert_eq!(DBCLIENT_CONNECTIONS_KEY, "Fredo_dbclient_connections");
    assert_eq!(DBCLIENT_HISTORY_KEY_PREFIX, "Fredo_dbclient_history_");
    assert_eq!(DBCLIENT_SAVED_QUERIES_KEY_PREFIX, "Fredo_dbclient_saved_queries_");
    assert_eq!(DBCLIENT_PREFS_KEY, "Fredo_dbclient_prefs");
    assert_eq!(DBCLIENT_KEYRING_SERVICE, "fredo.dbclient");
    assert_eq!(history_key("abc"), "Fredo_dbclient_history_abc");
    assert_eq!(saved_queries_key("abc"), "Fredo_dbclient_saved_queries_abc");
    assert_eq!(keyring_account("abc"), "connection:abc:password");
}

#[test]
fn force_fail_parser_maps_known_stages_and_is_inert_otherwise() {
    assert_eq!(parse_force_fail("connect"), Some(ForceFailStage::Connect));
    assert_eq!(parse_force_fail("AUTH"), Some(ForceFailStage::Auth));
    assert_eq!(parse_force_fail(" timeout "), Some(ForceFailStage::Timeout));
    assert_eq!(parse_force_fail("query"), Some(ForceFailStage::Query));
    assert_eq!(parse_force_fail("1"), Some(ForceFailStage::Connect));
    assert_eq!(parse_force_fail("true"), Some(ForceFailStage::Connect));
    // Inert cases: blank / unknown values never inject a failure.
    assert_eq!(parse_force_fail(""), None);
    assert_eq!(parse_force_fail("   "), None);
    assert_eq!(parse_force_fail("nope"), None);
    assert_eq!(parse_force_fail("0"), None);
    assert_eq!(ForceFailStage::Query.as_str(), "query");
}

#[test]
fn state_dir_defaults_and_honours_a_non_blank_override() {
    assert_eq!(
        resolve_state_dir(None),
        PathBuf::from(DEFAULT_DBCLIENT_STATE_DIR)
    );
    assert_eq!(resolve_state_dir(Some("")), PathBuf::from(DEFAULT_DBCLIENT_STATE_DIR));
    assert_eq!(
        resolve_state_dir(Some("  ")),
        PathBuf::from(DEFAULT_DBCLIENT_STATE_DIR)
    );
    assert_eq!(
        resolve_state_dir(Some(" C:/tmp/dbclient ")),
        PathBuf::from("C:/tmp/dbclient")
    );
}

#[test]
fn state_resolves_construction_inputs() {
    let state = DbClientState::new(
        Some(ForceFailStage::Timeout),
        PathBuf::from("C:/tmp/dbclient"),
    );
    assert_eq!(state.force_fail(), Some(ForceFailStage::Timeout));
    assert_eq!(state.state_dir(), PathBuf::from("C:/tmp/dbclient").as_path());
}

#[tokio::test]
async fn state_registry_tracks_pools_by_connection_id() {
    let state = DbClientState::new(None, PathBuf::from("C:/tmp/dbclient"));
    assert_eq!(state.pool_count().await, 0);

    // `connect_lazy` parses the URL but opens NO socket — the ST-1 non-goal
    // ("no pool is opened") holds; the registry itself is what is under test.
    let pool = sqlx::PgPool::connect_lazy("postgres://user:pass@127.0.0.1:1/db")
        .expect("lazy pool");
    assert!(state.insert_pool("c1".to_string(), pool.clone()).await.is_none());
    assert_eq!(state.pool_count().await, 1);
    // Re-inserting the same id returns the replaced pool.
    assert!(state.insert_pool("c1".to_string(), pool).await.is_some());
    assert_eq!(state.pool_count().await, 1);
    assert!(state.remove_pool("c1").await.is_some());
    assert_eq!(state.pool_count().await, 0);
    assert!(state.remove_pool("missing").await.is_none());
}

#[tokio::test]
async fn remaining_query_stub_returns_typed_not_implemented() {
    let state = DbClientState::new(None, PathBuf::from("C:/tmp/dbclient"));

    // ST-2 filled the connection lifecycle: `db_connection_list` is real and
    // returns the (empty) saved-connection list without any network call.
    assert!(super::connect::connection_list(&state).await.is_ok());

    // ST-3 filled the schema browse: with no open pool it returns the typed
    // "not open" error (no network call), not the ST-1 NotImplemented stub.
    let schema_args = super::types::DbSchemaListArgs {
        connection_id: "c1".into(),
        parent_id: None,
    };
    let schema_err = super::schema::schema_list(schema_args, &state)
        .await
        .expect_err("no open pool must fail");
    assert!(schema_err.iter().any(|m| m.contains("not open")));

    let query_args = super::types::DbQueryArgs {
        connection_id: "c1".into(),
        sql: "select 1".into(),
        mode: QueryMode::Single,
        selection: None,
        confirmed_statement_hashes: Vec::new(),
    };
    assert!(super::query::query_execute(query_args, &state).await.is_err());
}

#[test]
fn result_set_wire_shape_is_bounded_and_typed() {
    let set = DbResultSet {
        result_set_id: "rs-1".into(),
        columns: vec![DbColumn {
            name: "id".into(),
            type_name: "int4".into(),
        }],
        rows: vec![vec![serde_json::json!(1)]],
        row_count_loaded: 1,
        has_more: true,
        truncated: false,
        duration_ms: 3,
    };
    let value = serde_json::to_value(&set).unwrap();
    assert_eq!(value["resultSetId"], "rs-1");
    assert_eq!(value["rowCountLoaded"].as_u64(), Some(1));
    assert_eq!(value["hasMore"].as_bool(), Some(true));
    assert_eq!(value["truncated"].as_bool(), Some(false));
    assert_eq!(value["columns"][0]["typeName"], "int4");

    let err = DbQueryError {
        kind: DbErrorKind::Query,
        message: "syntax error".into(),
        line: Some(1),
        column: Some(8),
        position: Some(7),
    };
    let err_value = serde_json::to_value(&err).unwrap();
    assert_eq!(err_value["kind"], "query");
    assert_eq!(err_value["line"].as_u64(), Some(1));
}
