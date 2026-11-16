//! Spec #3029 (ST-2) — built-in "Fredo" connection tests.
//!
//! Deterministic and order-independent (G-222): the metadata store is a temp
//! dir, the credential store is in-memory (or a panicking sentinel), and the
//! endpoint provider is an in-memory fake — no live PostgreSQL, no OS keychain,
//! and no process-global env mutation.

use std::sync::Arc;

use super::credentials::{CredentialStore, MemoryCredentialStore};
use super::*;
use crate::applications::db_client::state::DbClientState;
use crate::applications::db_client::types::{
    AccessMode, DbConnectionSaveArgs, DbEngineKind, SslMode,
};
use crate::infrastructure::storage::embedded_pg::{
    EmbeddedPgEndpoint, EmbeddedPgEndpointProvider,
};

fn test_state() -> (tempfile::TempDir, DbClientState) {
    let dir = tempfile::tempdir().expect("tempdir");
    let state = DbClientState::new(None, dir.path().to_path_buf());
    (dir, state)
}

/// A provider with a fixed endpoint/password — deterministic, no keychain.
struct FakeProvider {
    endpoint: Option<EmbeddedPgEndpoint>,
    password: Result<Option<String>, String>,
}

impl EmbeddedPgEndpointProvider for FakeProvider {
    fn endpoint(&self) -> Option<EmbeddedPgEndpoint> {
        self.endpoint.clone()
    }

    fn loopback_password(&self) -> Result<Option<String>, String> {
        self.password.clone()
    }
}

/// A ready provider bound to `port` with a known password.
fn ready_provider(port: u16) -> FakeProvider {
    FakeProvider {
        endpoint: Some(EmbeddedPgEndpoint {
            host: "127.0.0.1".into(),
            port,
            user: "postgres".into(),
            database: "fredo".into(),
        }),
        password: Ok(Some("loopback-secret".into())),
    }
}

/// A provider whose cluster is not serving (`endpoint()` is `None`).
fn not_ready_provider() -> FakeProvider {
    FakeProvider {
        endpoint: None,
        password: Ok(None),
    }
}

/// A credential store that panics on ANY access: proves an arm never touches the
/// per-connection `fredo.dbclient` keychain (EARS-4/EARS-7).
struct PanicCredentialStore;

impl CredentialStore for PanicCredentialStore {
    fn set_password(&self, _connection_id: &str, _password: &str) -> Result<(), String> {
        panic!("the builtin arm must not write the fredo.dbclient keychain")
    }
    fn get_password(&self, _connection_id: &str) -> Result<Option<String>, String> {
        panic!("the builtin arm must not read the fredo.dbclient keychain")
    }
    fn delete_password(&self, _connection_id: &str) -> Result<(), String> {
        panic!("the builtin arm must not touch the fredo.dbclient keychain")
    }
    fn has_password(&self, _connection_id: &str) -> Result<bool, String> {
        panic!("the builtin arm must not touch the fredo.dbclient keychain")
    }
}

fn builtin_args() -> DbConnectArgs {
    DbConnectArgs {
        connection_id: DBCLIENT_BUILTIN_FREDO_ID.to_string(),
    }
}

// ── The seeded view (frozen contract) ─────────────────────────────────────────

#[test]
fn builtin_connection_view_matches_the_frozen_contract() {
    assert_eq!(DBCLIENT_BUILTIN_FREDO_ID, "builtin-fredo");
    assert_eq!(DBCLIENT_BUILTIN_FREDO_NAME, "Fredo");
    assert_eq!(DBCLIENT_BUILTIN_PORT_SENTINEL, 0);

    let view = builtin_connection_view();
    assert_eq!(view.id, "builtin-fredo");
    assert_eq!(view.name, "Fredo");
    assert_eq!(view.engine, DbEngineKind::Postgres);
    assert_eq!(view.host, "127.0.0.1");
    assert_eq!(view.port, DBCLIENT_BUILTIN_PORT_SENTINEL);
    assert_eq!(view.user, "postgres");
    assert_eq!(view.database, "fredo");
    assert_eq!(view.ssl_mode, SslMode::Disable);
    assert_eq!(view.access_mode, AccessMode::ReadOnly);
    assert!(view.builtin);
    assert_eq!(DEFAULT_ACCESS_MODE, AccessMode::ReadOnly);
}

#[test]
fn an_ordinary_view_deserializes_with_builtin_false() {
    // Serde-default: an existing (pre-#3029) document with no `builtin` key
    // stays valid and reads as ordinary.
    let raw = r#"{
        "id": "c1", "name": "local", "engine": "postgres",
        "host": "127.0.0.1", "port": 5432, "user": "postgres",
        "database": "postgres", "sslMode": "prefer",
        "accessMode": "readOnly", "hasPassword": false
    }"#;
    let view: DbConnectionView = serde_json::from_str(raw).expect("deserialize legacy view");
    assert!(!view.builtin);
}

// ── Seeding (EARS-1 / EARS-2) ─────────────────────────────────────────────────

#[test]
fn ensure_builtin_seeded_seeds_once_and_is_idempotent() {
    let (_dir, state) = test_state();
    let path = connections_path(&state);
    assert!(!path.exists(), "a fresh profile has no store document");

    ensure_builtin_seeded(&state).expect("seed");
    assert!(path.exists(), "seeding writes the store document");

    let views = read_array::<DbConnectionView>(&path);
    assert_eq!(views.len(), 1);
    assert!(views[0].builtin);

    // A second seed is a no-op (the document now exists) — no duplicate.
    ensure_builtin_seeded(&state).expect("second seed");
    assert_eq!(read_array::<DbConnectionView>(&path).len(), 1);
}

#[test]
fn seeding_is_skipped_when_the_store_document_already_exists() {
    let (_dir, state) = test_state();
    let path = connections_path(&state);
    std::fs::create_dir_all(state.state_dir()).unwrap();
    std::fs::write(&path, "[]").unwrap();

    ensure_builtin_seeded(&state).expect("no-op");
    assert!(
        read_array::<DbConnectionView>(&path).is_empty(),
        "an existing (even empty) store document is never re-seeded"
    );

    let credentials = MemoryCredentialStore::new();
    assert!(connection_list_with(&state, &credentials).unwrap().is_empty());
}

#[test]
fn connection_list_on_a_fresh_profile_returns_the_builtin_row() {
    let (_dir, state) = test_state();
    let credentials = MemoryCredentialStore::new();
    let listed = connection_list_with(&state, &credentials).expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, DBCLIENT_BUILTIN_FREDO_ID);
    assert_eq!(listed[0].name, DBCLIENT_BUILTIN_FREDO_NAME);
    assert!(listed[0].builtin);
    assert_eq!(listed[0].port, DBCLIENT_BUILTIN_PORT_SENTINEL);
    // Idempotent: a second list returns the SAME single row.
    let again = connection_list_with(&state, &credentials).expect("re-list");
    assert_eq!(again.len(), 1);
}

#[test]
fn the_persisted_builtin_document_holds_no_secret_and_the_port_sentinel() {
    let (_dir, state) = test_state();
    ensure_builtin_seeded(&state).expect("seed");
    let raw = std::fs::read_to_string(connections_path(&state)).expect("read store");

    assert!(raw.contains("\"port\": 0"), "the port sentinel is persisted: {raw}");
    assert!(raw.contains("\"builtin\": true"));
    assert!(!raw.contains("password"));
    assert!(!raw.contains("secret"));
    assert!(!raw.contains("loopback-secret"));
}

// ── Edit ⇒ ordinary (EARS-2) ──────────────────────────────────────────────────

#[test]
fn editing_the_builtin_persists_it_as_an_ordinary_connection() {
    let (_dir, state) = test_state();
    let credentials = MemoryCredentialStore::new();
    let saved = connection_save_with(
        DbConnectionSaveArgs {
            id: Some(DBCLIENT_BUILTIN_FREDO_ID.to_string()),
            name: "Fredo (edited)".into(),
            engine: DbEngineKind::Postgres,
            host: "127.0.0.1".into(),
            port: 5432,
            user: "postgres".into(),
            database: "fredo".into(),
            ssl_mode: SslMode::Prefer,
            access_mode: AccessMode::ReadOnly,
            password: None,
        },
        &state,
        &credentials,
    )
    .expect("edit builtin");

    assert!(!saved.builtin, "a SAVE always produces an ordinary connection");
    let listed = connection_list_with(&state, &credentials).expect("list");
    assert_eq!(listed.len(), 1);
    assert!(!listed[0].builtin);
    assert_eq!(listed[0].name, "Fredo (edited)");
    assert_eq!(listed[0].port, 5432);
}

// ── Connect-time endpoint resolution (EARS-3/EARS-4/EARS-6/EARS-7) ────────────

#[test]
fn resolve_target_reads_the_builtin_endpoint_from_the_live_provider_each_call() {
    let view = builtin_connection_view();
    let store = PanicCredentialStore;

    let first = resolve_target(&view, &store, Some(&ready_provider(40001))).expect("resolve");
    assert_eq!(first.host, "127.0.0.1");
    assert_eq!(first.port, 40001);
    assert_eq!(first.user, "postgres");
    assert_eq!(first.database, "fredo");
    assert_eq!(first.ssl_mode, SslMode::Disable);
    assert_eq!(first.password.as_deref(), Some("loopback-secret"));

    // A restart binds a NEW port: the next resolution reads it — the persisted
    // `port=0` sentinel is never consulted or updated (EARS-6).
    let second = resolve_target(&view, &store, Some(&ready_provider(51999))).expect("resolve");
    assert_eq!(second.port, 51999);
    assert_ne!(first.port, second.port);
    assert_eq!(view.port, DBCLIENT_BUILTIN_PORT_SENTINEL);
}

#[test]
fn resolve_target_uses_the_persisted_view_and_keychain_for_an_ordinary_connection() {
    let view = DbConnectionView {
        id: "ordinary-1".into(),
        name: "external".into(),
        engine: DbEngineKind::Postgres,
        host: "db.example.com".into(),
        port: 6543,
        user: "app".into(),
        database: "appdb".into(),
        ssl_mode: SslMode::Require,
        access_mode: AccessMode::ReadOnly,
        has_password: true,
        builtin: false,
    };
    let credentials = MemoryCredentialStore::new();
    credentials.set_password("ordinary-1", "hunter2").unwrap();

    // No endpoint provider (and none needed): the ordinary path is unchanged.
    let target = resolve_target(&view, &credentials, None).expect("resolve");
    assert_eq!(target.host, "db.example.com");
    assert_eq!(target.port, 6543);
    assert_eq!(target.user, "app");
    assert_eq!(target.database, "appdb");
    assert_eq!(target.ssl_mode, SslMode::Require);
    assert_eq!(target.password.as_deref(), Some("hunter2"));
}

#[tokio::test]
async fn builtin_connect_without_a_provider_fails_config_and_never_touches_the_keychain() {
    let (_dir, state) = test_state();
    // PanicCredentialStore proves the builtin arm returns BEFORE any
    // `fredo.dbclient` credential read (EARS-4b).
    let err = connect_with(builtin_args(), &state, &PanicCredentialStore, None)
        .await
        .expect_err("no provider => typed config");
    assert!(
        err.iter().any(|message| message.starts_with("config:")),
        "{err:?}"
    );
}

#[tokio::test]
async fn builtin_connect_with_a_not_ready_cluster_fails_unreachable() {
    let (_dir, state) = test_state();
    let provider = not_ready_provider();
    let err = connect_with(
        builtin_args(),
        &state,
        &PanicCredentialStore,
        Some(&provider),
    )
    .await
    .expect_err("not serving => typed unreachable");
    assert!(
        err.iter().any(|message| message.starts_with("unreachable:")),
        "{err:?}"
    );
}

#[tokio::test]
async fn builtin_connect_reaches_the_bounded_open_step_with_a_ready_provider() {
    let dir = tempfile::tempdir().expect("tempdir");
    // Force the shared bounded open to fail so no socket is opened: reaching the
    // typed `unreachable` from the forced stage proves the builtin arm resolved
    // the provider endpoint and never consulted the dbclient keychain.
    let state = DbClientState::new(Some(ForceFailStage::Connect), dir.path().to_path_buf());
    let provider = ready_provider(40001);
    let err = connect_with(builtin_args(), &state, &PanicCredentialStore, Some(&provider))
        .await
        .expect_err("forced connect failure");
    assert!(
        err.iter().any(|message| message.starts_with("unreachable:")),
        "{err:?}"
    );
}

#[tokio::test]
async fn an_ordinary_connect_still_reaches_the_bounded_open_step() {
    let dir = tempfile::tempdir().expect("tempdir");
    let state = DbClientState::new(Some(ForceFailStage::Connect), dir.path().to_path_buf());
    let credentials = MemoryCredentialStore::new();
    let created = connection_save_with(
        DbConnectionSaveArgs {
            id: None,
            name: "external".into(),
            engine: DbEngineKind::Postgres,
            host: "127.0.0.1".into(),
            port: 5432,
            user: "postgres".into(),
            database: "postgres".into(),
            ssl_mode: SslMode::Prefer,
            access_mode: AccessMode::ReadOnly,
            password: Some("pw".into()),
        },
        &state,
        &credentials,
    )
    .expect("save");

    let err = connect_with(
        DbConnectArgs {
            connection_id: created.id,
        },
        &state,
        &credentials,
        None,
    )
    .await
    .expect_err("forced connect failure");
    assert!(
        err.iter().any(|message| message.starts_with("unreachable:")),
        "{err:?}"
    );
}

/// The `Arc<dyn EmbeddedPgEndpointProvider>` a composition root installs on the
/// db-client state resolves through the same seam.
#[tokio::test]
async fn a_provider_installed_on_the_state_is_used_by_the_builtin_arm() {
    let dir = tempfile::tempdir().expect("tempdir");
    let state = DbClientState::new(Some(ForceFailStage::Connect), dir.path().to_path_buf());
    state.set_embedded_endpoint_provider(Arc::new(ready_provider(40001)));
    assert!(state.embedded_endpoint_provider().is_some());

    // `connect` (the production body) pulls the provider off the state and uses
    // it; the forced stage proves the builtin arm was taken.
    let err = connect(builtin_args(), &state)
        .await
        .expect_err("forced connect failure");
    assert!(
        err.iter().any(|message| message.starts_with("unreachable:")),
        "{err:?}"
    );
}
