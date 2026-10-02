//! ST-2 connect/credentials behaviour tests (Spec #2950).
//!
//! Deterministic and order-independent (G-222): the metadata store is a temp
//! dir, the credential store is in-memory, and the G-275 failure stage is passed
//! explicitly (never via process env). No live PostgreSQL is required — the live
//! success/error paths are exercised by the tester's live QA.

use super::credentials::MemoryCredentialStore;
use super::*;
use crate::features::db_client::state::DbClientState;
use crate::features::db_client::types::{
    AccessMode, DbConnectionDeleteArgs, DbConnectionSaveArgs, DbConnectionTestArgs, DbEngineKind,
    SslMode,
};

fn test_state() -> (tempfile::TempDir, DbClientState) {
    let dir = tempfile::tempdir().expect("tempdir");
    let state = DbClientState::new(None, dir.path().to_path_buf());
    (dir, state)
}

fn test_args(host: &str, port: u16) -> DbConnectionTestArgs {
    DbConnectionTestArgs {
        engine: DbEngineKind::Postgres,
        host: host.to_string(),
        port,
        user: "postgres".into(),
        database: "postgres".into(),
        ssl_mode: SslMode::Prefer,
        password: None,
    }
}

fn save_args(
    id: Option<&str>,
    name: &str,
    access_mode: AccessMode,
    password: Option<&str>,
) -> DbConnectionSaveArgs {
    DbConnectionSaveArgs {
        id: id.map(|value| value.to_string()),
        name: name.to_string(),
        engine: DbEngineKind::Postgres,
        host: "127.0.0.1".into(),
        port: 5432,
        user: "postgres".into(),
        database: "postgres".into(),
        ssl_mode: SslMode::Require,
        access_mode,
        password: password.map(|value| value.to_string()),
    }
}

// ── R-5.6 SSL mapping ─────────────────────────────────────────────────────────

#[test]
fn ssl_modes_map_without_downgrade() {
    // `PgSslMode` does not implement `PartialEq`, so pin the variant name.
    assert_eq!(format!("{:?}", to_pg_ssl_mode(SslMode::Disable)), "Disable");
    assert_eq!(format!("{:?}", to_pg_ssl_mode(SslMode::Prefer)), "Prefer");
    assert_eq!(format!("{:?}", to_pg_ssl_mode(SslMode::Require)), "Require");
    assert_eq!(format!("{:?}", to_pg_ssl_mode(SslMode::VerifyCa)), "VerifyCa");
    assert_eq!(
        format!("{:?}", to_pg_ssl_mode(SslMode::VerifyFull)),
        "VerifyFull"
    );
}

// ── R-1.2 validation ──────────────────────────────────────────────────────────

#[test]
fn validation_rejects_blank_fields_and_zero_port() {
    assert_eq!(
        validate_test_args(&test_args("", 5432)).unwrap_err().kind,
        DbErrorKind::Config
    );
    assert_eq!(
        validate_test_args(&test_args("127.0.0.1", 0)).unwrap_err().kind,
        DbErrorKind::Config
    );
    let mut args = test_args("127.0.0.1", 5432);
    args.user = "  ".into();
    assert_eq!(validate_test_args(&args).unwrap_err().kind, DbErrorKind::Config);
    let mut args = test_args("127.0.0.1", 5432);
    args.database = String::new();
    assert_eq!(validate_test_args(&args).unwrap_err().kind, DbErrorKind::Config);

    assert_eq!(
        validate_save_args(&save_args(None, "  ", AccessMode::ReadOnly, None))
            .unwrap_err()
            .kind,
        DbErrorKind::Config
    );
    assert!(validate_save_args(&save_args(None, "local", AccessMode::ReadOnly, None)).is_ok());
}

// ── G-275 typed failures (no network) ─────────────────────────────────────────

#[tokio::test]
async fn forced_connect_auth_and_timeout_stages_are_typed() {
    let cases = [
        (ForceFailStage::Connect, DbErrorKind::Unreachable),
        (ForceFailStage::Auth, DbErrorKind::Auth),
        (ForceFailStage::Timeout, DbErrorKind::Timeout),
    ];
    for (stage, expected) in cases {
        let result = probe(test_args("127.0.0.1", 5432), Some(stage)).await;
        assert!(!result.ok, "{stage:?} must not succeed");
        assert_eq!(result.error.expect("typed error").kind, expected);
    }
}

#[tokio::test]
async fn invalid_args_fail_before_any_network_call() {
    let result = probe(test_args("", 5432), None).await;
    assert!(!result.ok);
    assert_eq!(result.error.expect("typed error").kind, DbErrorKind::Config);
}

// ── R-5.1 read-only default ───────────────────────────────────────────────────

#[test]
fn new_connection_is_read_only_even_when_read_write_is_requested() {
    let (_dir, state) = test_state();
    let credentials = MemoryCredentialStore::new();
    let view = connection_save_with(
        save_args(None, "local", AccessMode::ReadWrite, Some("s3cr3t")),
        &state,
        &credentials,
    )
    .expect("save");
    assert_eq!(view.access_mode, AccessMode::ReadOnly);
    assert_eq!(DEFAULT_ACCESS_MODE, AccessMode::ReadOnly);
}

#[test]
fn editing_a_connection_honours_the_access_mode_toggle() {
    let (_dir, state) = test_state();
    let credentials = MemoryCredentialStore::new();
    let created = connection_save_with(
        save_args(None, "local", AccessMode::ReadOnly, None),
        &state,
        &credentials,
    )
    .expect("create");
    let edited = connection_save_with(
        save_args(Some(&created.id), "local", AccessMode::ReadWrite, None),
        &state,
        &credentials,
    )
    .expect("edit");
    assert_eq!(edited.access_mode, AccessMode::ReadWrite);
}

// ── R-1.5 / R-1.6 secret handling ─────────────────────────────────────────────

#[test]
fn password_goes_to_the_credential_store_and_never_into_the_view() {
    let (_dir, state) = test_state();
    let credentials = MemoryCredentialStore::new();
    let view = connection_save_with(
        save_args(None, "local", AccessMode::ReadOnly, Some("hunter2")),
        &state,
        &credentials,
    )
    .expect("save");

    assert!(view.has_password);
    assert_eq!(
        credentials.get_password(&view.id).unwrap().as_deref(),
        Some("hunter2")
    );
    let serialized = serde_json::to_value(&view).unwrap();
    assert!(serialized.get("password").is_none());
    assert!(serialized.get("secret").is_none());
    assert_eq!(serialized["hasPassword"], serde_json::json!(true));
    // The metadata document on disk carries no secret either.
    let raw = std::fs::read_to_string(connections_path(&state)).unwrap();
    assert!(!raw.contains("hunter2"));
}

#[test]
fn blank_or_absent_password_on_edit_keeps_the_stored_secret() {
    let (_dir, state) = test_state();
    let credentials = MemoryCredentialStore::new();
    let created = connection_save_with(
        save_args(None, "local", AccessMode::ReadOnly, Some("old-secret")),
        &state,
        &credentials,
    )
    .expect("create");

    // R-1.6: `None` keeps it.
    connection_save_with(
        save_args(Some(&created.id), "local", AccessMode::ReadOnly, None),
        &state,
        &credentials,
    )
    .expect("edit none");
    assert_eq!(
        credentials.get_password(&created.id).unwrap().as_deref(),
        Some("old-secret")
    );

    // R-1.6: a blank field keeps it.
    connection_save_with(
        save_args(Some(&created.id), "local", AccessMode::ReadOnly, Some("  ")),
        &state,
        &credentials,
    )
    .expect("edit blank");
    assert_eq!(
        credentials.get_password(&created.id).unwrap().as_deref(),
        Some("old-secret")
    );

    // A non-blank password replaces it.
    connection_save_with(
        save_args(Some(&created.id), "local", AccessMode::ReadOnly, Some("new-secret")),
        &state,
        &credentials,
    )
    .expect("edit new");
    assert_eq!(
        credentials.get_password(&created.id).unwrap().as_deref(),
        Some("new-secret")
    );
}

// ── R-1.5 persistence across a fresh state handle ─────────────────────────────

#[test]
fn saved_connection_is_listed_from_a_fresh_state_handle() {
    let (dir, state) = test_state();
    let credentials = MemoryCredentialStore::new();
    let created = connection_save_with(
        save_args(None, "qa-local", AccessMode::ReadOnly, Some("pw")),
        &state,
        &credentials,
    )
    .expect("save");

    // A new state over the same directory models an app restart.
    let reopened = DbClientState::new(None, dir.path().to_path_buf());
    let listed = connection_list_with(&reopened, &credentials).expect("list");
    assert_eq!(listed.len(), 1);
    let view = &listed[0];
    assert_eq!(view.id, created.id);
    assert_eq!(view.name, "qa-local");
    assert_eq!(view.host, "127.0.0.1");
    assert_eq!(view.port, 5432);
    assert_eq!(view.ssl_mode, SslMode::Require);
    assert_eq!(view.access_mode, AccessMode::ReadOnly);
    assert!(view.has_password);
}

// ── R-1.7 delete clears all four stores ───────────────────────────────────────

#[test]
fn delete_clears_metadata_secret_history_and_saved_queries() {
    let (_dir, state) = test_state();
    let credentials = MemoryCredentialStore::new();
    let view = connection_save_with(
        save_args(None, "local", AccessMode::ReadOnly, Some("secret")),
        &state,
        &credentials,
    )
    .expect("save");

    std::fs::write(history_path(&state, &view.id), "[]").unwrap();
    std::fs::write(saved_queries_path(&state, &view.id), "[]").unwrap();
    assert!(history_path(&state, &view.id).exists());
    assert!(saved_queries_path(&state, &view.id).exists());

    connection_delete_with(
        &DbConnectionDeleteArgs {
            connection_id: view.id.clone(),
        },
        &state,
        &credentials,
    )
    .expect("delete");

    assert!(connection_list_with(&state, &credentials).unwrap().is_empty());
    assert!(!credentials.has_password(&view.id).unwrap());
    assert!(!history_path(&state, &view.id).exists());
    assert!(!saved_queries_path(&state, &view.id).exists());
}

#[test]
fn corrupt_metadata_degrades_to_an_empty_list() {
    let (_dir, state) = test_state();
    let credentials = MemoryCredentialStore::new();
    std::fs::create_dir_all(state.state_dir()).unwrap();
    std::fs::write(connections_path(&state), "{ not json").unwrap();
    assert!(connection_list_with(&state, &credentials).unwrap().is_empty());
}

#[test]
fn unsafe_connection_ids_are_rejected() {
    let (_dir, state) = test_state();
    let credentials = MemoryCredentialStore::new();
    let err = connection_delete_with(
        &DbConnectionDeleteArgs {
            connection_id: "../escape".into(),
        },
        &state,
        &credentials,
    )
    .unwrap_err();
    assert!(err.iter().any(|message| message.starts_with("config:")));
}
