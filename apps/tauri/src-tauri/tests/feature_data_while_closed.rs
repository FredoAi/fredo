//! ST-8 — R-4.2: a canonical ingest projects the declared feature table WHILE
//! the declaring feature's UI is closed and NO watch/read is open.
//!
//! Two independent proofs live here:
//!
//! 1. **Runtime, through the real path.** A temp `fredo.db` is composed the way
//!    `lib.rs` composes it — declaration registry + `ProjectionEngine` + an
//!    EMPTY `WatchRegistry` and an RTDB pipeline with ZERO subscriptions — and
//!    driven through `Rtdb::ingest_row_upsert` (the single entry point the
//!    ingest classifier calls). A Mission-Monitor-shaped `sessionRollup`
//!    declaration is materialized first. After a canonical chat upsert and a
//!    canonical tool `task` upsert, the declared `sessions` row exists and both
//!    its `_row_version` and the table's `last_version` advance — the
//!    projection ran unconditionally (R-4.2). A negative control with the
//!    observer cleared leaves the declared table untouched, proving the update
//!    is causally the observer seam and not some incidental side effect.
//!
//! 2. **Wiring.** `lib.rs` installs the observer via
//!    `install_row_upsert_observer` exactly once, directly in the Tauri
//!    `setup` closure body (zero enclosing blocks => no `if`/`match`/loop
//!    subscription or UI gate), and the installed composite feeds BOTH the
//!    canonical watch registry and the projection engine.
//!
//! The declared tab/statement structure is verified structurally against the
//! shipped source; the runtime proof drives the same entry point the app uses.

use std::sync::Arc;

use serde_json::{json, Map, Value as JsonValue};

use fredo_lib::infrastructure::feature_data::declaration::FeatureDataDeclaration;
use fredo_lib::infrastructure::feature_data::envelope::FeatureRowNotification;
use fredo_lib::infrastructure::feature_data::projection::{
    clear_row_upsert_observer, install_row_upsert_observer, ProjectionEngine, RowUpsertObserver,
};
use fredo_lib::infrastructure::feature_data::registry::DeclarationRegistry;
use fredo_lib::infrastructure::feature_data::store::FeatureDataStore;
use fredo_lib::infrastructure::feature_data::watch::{NotificationSink, WatchRegistry};
use fredo_lib::infrastructure::rtdb::cache::RtdbCache;
use fredo_lib::infrastructure::rtdb::commands::{IngestRow, Rtdb};
use fredo_lib::infrastructure::rtdb::flush::{FlushLoop, RowEmitter};
use fredo_lib::infrastructure::rtdb::project::RowDelivery;
use fredo_lib::infrastructure::rtdb::rows::{ChatRow, RowState, ToolUseRow};
use fredo_lib::infrastructure::rtdb::store::RtdbStore;
use fredo_lib::infrastructure::rtdb::subscriptions::SubscriptionRegistry;
use fredo_lib::infrastructure::storage::feature_store::FeatureStore;

const FEATURE_ID: &str = "mission-monitor";
const DECLARED_TABLE: &str = "sessions";
const SESSION_ID: &str = "ses_st8";

/// The ONE composite upsert observer `lib.rs` installs: feed canonical-table
/// watches, then the declared-row projection engine.
struct CompositeUpsertObserver {
    engine: Arc<ProjectionEngine>,
    watches: Arc<WatchRegistry>,
}

impl RowUpsertObserver for CompositeUpsertObserver {
    fn on_row_upsert(&self, row: &IngestRow, changed_fields: &[String]) {
        self.watches.on_canonical_row(row, changed_fields);
        self.engine.on_row_upsert(row, changed_fields);
    }
}

/// A sink that drops notifications — this test has NO watches, so nothing is
/// ever delivered.
struct NullSink;

impl NotificationSink for NullSink {
    fn emit(&self, _notifications: &[FeatureRowNotification]) {}
}

/// The shipped Mission-Monitor declaration shape, parsed from its wire JSON
/// (camelCase, `kind: "sessionRollup"`, the closed fact columns + the
/// feature-owned `customName`).
fn mission_monitor_declaration() -> FeatureDataDeclaration {
    FeatureDataDeclaration::parse(json!({
        "featureId": FEATURE_ID,
        "declarationRevision": "mm.sessions.v1",
        "tables": [{
            "name": DECLARED_TABLE,
            "primaryKey": ["sessionId"],
            "columns": [
                { "name": "sessionId", "type": "TEXT", "owner": "backend" },
                { "name": "startedAtNs", "type": "INTEGER", "owner": "backend", "nullable": true },
                { "name": "latestAt", "type": "TEXT", "owner": "backend" },
                { "name": "chatRowCount", "type": "INTEGER", "owner": "backend" },
                { "name": "nonSubagentChatRowCount", "type": "INTEGER", "owner": "backend" },
                { "name": "visibleTurnCount", "type": "INTEGER", "owner": "backend" },
                { "name": "userDispatchCount", "type": "INTEGER", "owner": "backend" },
                { "name": "derivedName", "type": "TEXT", "owner": "backend", "nullable": true },
                { "name": "agentName", "type": "TEXT", "owner": "backend", "nullable": true },
                { "name": "customName", "type": "TEXT", "owner": "feature", "nullable": true }
            ],
            "source": {
                "kind": "sessionRollup",
                "excludeDispatchNames": ["build", "plan"],
                "terminalStates": ["Response", "Timeout"]
            },
            "retention": { "maxRows": 500 }
        }]
    }))
    .expect("the shipped Mission-Monitor declaration must validate")
}

/// A canonical chat row (non-terminal state so the group has a visible turn).
fn chat_row(session_id: &str, correlation_id: &str, updated_at: &str, user_message: &str) -> ChatRow {
    ChatRow {
        session_id: session_id.to_string(),
        correlation_id: correlation_id.to_string(),
        seq: 0,
        started_at_ns: Some(1_000),
        ended_at_ns: None,
        updated_at: updated_at.to_string(),
        state: RowState::Init,
        user_message: Some(user_message.to_string()),
        agent_reply: None,
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

/// A canonical user-requested `task` dispatch (counts toward qualification).
fn tool_row(session_id: &str, correlation_id: &str, updated_at: &str) -> ToolUseRow {
    ToolUseRow {
        session_id: session_id.to_string(),
        correlation_id: correlation_id.to_string(),
        seq: 0,
        started_at_ns: None,
        ended_at_ns: None,
        updated_at: updated_at.to_string(),
        state: RowState::Response,
        tool_name: Some("task".to_string()),
        tool_success: None,
        tool_error: None,
        duration_ms: None,
        tool_input_json: Some(r#"{"subagent_type":"developer","prompt":"p"}"#.to_string()),
        tool_output_json: None,
        is_subagent: Some(false),
        raw_json: "{}".to_string(),
    }
}

fn declared_rows(tables: &FeatureStore) -> Vec<Map<String, JsonValue>> {
    tables
        .query(FEATURE_ID, DECLARED_TABLE, None, None, None)
        .expect("query the declared sessions table")
}

fn declared_version(meta: &FeatureDataStore) -> i64 {
    meta.get_table(FEATURE_ID, DECLARED_TABLE)
        .expect("read declared table metadata")
        .expect("the declared table must be persisted")
        .last_version
}

/// R-4.2 — the end-to-end proof: no watch, no read, window closed.
#[test]
fn canonical_ingest_updates_the_declared_sessions_row_with_no_watch_or_read_open() {
    let dir = tempfile::tempdir().expect("tempdir");

    // ── Stores (the same set lib.rs opens over one fredo.db) ────────────────
    let rtdb_store = Arc::new(RtdbStore::open(dir.path().to_path_buf()).expect("rtdb store"));
    rtdb_store.ensure_schema().expect("rtdb schema");
    let meta = Arc::new(FeatureDataStore::open(dir.path().to_path_buf()).expect("feature data store"));
    meta.ensure_schema().expect("feature data schema");
    let tables = Arc::new(FeatureStore::open(dir.path().to_path_buf()).expect("feature store"));

    // ── Persisted Mission-Monitor-shaped declaration ────────────────────────
    let registry = DeclarationRegistry::new(meta.clone(), tables.clone());
    let materialized = registry
        .declare(&mission_monitor_declaration())
        .expect("declare the Mission-Monitor sessions table");
    assert_eq!(materialized.len(), 1);
    assert!(materialized[0].created, "first declare materializes the table");
    assert_eq!(
        declared_version(&meta),
        0,
        "a fresh declaration starts at version 0"
    );

    // ── Engine + an EMPTY watch registry (the feature UI is closed) ─────────
    let engine = Arc::new(
        ProjectionEngine::new(dir.path().to_path_buf(), meta.clone(), tables.clone())
            .expect("projection engine"),
    );
    let watches = Arc::new(WatchRegistry::new(Arc::new(NullSink)));
    engine.set_declared_row_observer(watches.clone());

    // ── RTDB pipeline with ZERO subscriptions ───────────────────────────────
    let (cache, _rx) = RtdbCache::new(rtdb_store.clone());
    let rtdb = Rtdb::new(
        cache,
        Arc::new(SubscriptionRegistry::new()),
        Arc::new(FlushLoop::new(Arc::new(
            |_deliveries: &[RowDelivery], _marker: Option<&str>| {},
        ) as RowEmitter)),
    );

    // The continuous condition: NO watch and NO read/subscription is open.
    assert_eq!(watches.watch_count(), 0, "no watch may be open (R-4.2)");
    assert_eq!(
        rtdb.registry().subscription_count(),
        0,
        "no read/subscription may be open (R-4.2)"
    );

    // ── Negative control: with the seam cleared, nothing is projected ───────
    clear_row_upsert_observer();
    rtdb.ingest_row_upsert(
        IngestRow::Chat(chat_row(
            "ses_st8_control",
            "ses_st8_control_1",
            "2026-09-18T00:00:01+00:00",
            "control",
        )),
        &["userMessage".to_string()],
    )
    .expect("ingest the control session with no observer installed");
    assert!(
        declared_rows(&tables).is_empty(),
        "without the observer the declared table stays untouched"
    );

    // ── Install the SAME composite observer lib.rs installs ─────────────────
    install_row_upsert_observer(Arc::new(CompositeUpsertObserver {
        engine: engine.clone(),
        watches: watches.clone(),
    }));

    // ── Canonical chat upsert → the declared `sessions` row appears ─────────
    rtdb.ingest_row_upsert(
        IngestRow::Chat(chat_row(
            SESSION_ID,
            "ses_st8_1",
            "2026-09-18T00:00:02+00:00",
            "hello from a closed window",
        )),
        &["state".to_string(), "userMessage".to_string()],
    )
    .expect("ingest the first canonical chat row");

    let rows = declared_rows(&tables);
    assert_eq!(rows.len(), 1, "exactly one declared row was projected");
    let row = &rows[0];
    assert_eq!(row.get("sessionId"), Some(&json!(SESSION_ID)));
    assert_eq!(row.get("chatRowCount"), Some(&json!(1)));
    assert_eq!(row.get("nonSubagentChatRowCount"), Some(&json!(1)));
    assert_eq!(row.get("visibleTurnCount"), Some(&json!(1)));
    assert_eq!(row.get("userDispatchCount"), Some(&json!(0)));
    assert_eq!(
        row.get("_row_version"),
        Some(&json!(1)),
        "the declared row's first projection is version 1"
    );
    assert_eq!(declared_version(&meta), 1, "the table scope version advanced");
    assert!(
        !rows.iter().any(|r| r.get("sessionId") == Some(&json!("ses_st8_control"))),
        "the unobserved control session must never appear"
    );

    // ── A second canonical upsert (tool `task`) advances the version ────────
    rtdb.ingest_row_upsert(
        IngestRow::ToolUse(tool_row(SESSION_ID, "ses_st8_2", "2026-09-18T00:00:03+00:00")),
        &["toolName".to_string()],
    )
    .expect("ingest a canonical user-requested task row");

    let rows = declared_rows(&tables);
    assert_eq!(rows.len(), 1, "the same session upserts in place");
    assert_eq!(
        rows[0].get("userDispatchCount"),
        Some(&json!(1)),
        "the tool row recomputed the rollup"
    );
    assert_eq!(
        rows[0].get("_row_version"),
        Some(&json!(2)),
        "a later canonical upsert advances the declared row version"
    );
    assert_eq!(
        declared_version(&meta),
        2,
        "the table scope version advances with no watch/read open"
    );

    // The continuous condition still holds after every projection.
    assert_eq!(watches.watch_count(), 0, "the projection never opened a watch");
    assert_eq!(
        rtdb.registry().subscription_count(),
        0,
        "the projection never opened a read/subscription"
    );

    clear_row_upsert_observer();
}

/// R-4.2 (wiring) — `lib.rs` installs the observer once, unconditionally, and
/// the composite feeds both the watch registry and the projection engine.
#[test]
fn observer_is_registered_unconditionally_in_lib_rs() {
    let source = lib_rs_source();
    let masked = mask(&source);

    // Exactly ONE install call (the `use` import has a comma, not a call).
    assert_eq!(
        masked.matches("install_row_upsert_observer(").count(),
        1,
        "lib.rs must install exactly one canonical-upsert observer"
    );

    let body = setup_body(&masked);
    let call = body
        .find("install_row_upsert_observer(")
        .expect("the observer install must sit in the Tauri setup closure");
    assert_eq!(
        relative_depth(body, call),
        0,
        "the observer install must be a direct statement of the setup closure body — \
         no `if`/`match`/loop (no subscription or UI gate) may enclose it (R-4.2)"
    );

    // Positive control: the depth meter DOES see nesting (the tracing block).
    let logging = body
        .find("LogBridgeLayer::new()")
        .expect("the tracing-init marker must be present");
    assert!(
        relative_depth(body, logging) > 0,
        "the depth meter must detect an enclosed call (tracing init)"
    );

    // The install composes the composite, not the bare engine.
    assert!(
        body.contains("install_row_upsert_observer(Arc::new(FeatureDataUpsertObserver {"),
        "lib.rs must install the composite observer (canonical watches + projection engine)"
    );

    // The composite feeds BOTH the canonical watch registry and the engine.
    let composite = item_span(&masked, "impl RowUpsertObserver for FeatureDataUpsertObserver");
    assert!(
        composite.contains("self.watches.on_canonical_row("),
        "the observer must feed canonical-table watches"
    );
    assert!(
        composite.contains("self.engine.on_row_upsert("),
        "the observer must feed the declared-row projection engine"
    );
}

// ── Static-source helpers ───────────────────────────────────────────────────

/// `apps/tauri/src-tauri/src/lib.rs` — the crate's composition root.
fn lib_rs_source() -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("lib.rs");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()))
}

/// Blank every comment and string literal, preserving byte offsets, so the
/// structural scans match CODE only.
fn mask(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = vec![b' '; bytes.len()];
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index += 2;
                while index + 1 < bytes.len()
                    && !(bytes[index] == b'*' && bytes[index + 1] == b'/')
                {
                    index += 1;
                }
                index = (index + 2).min(bytes.len());
            }
            b'"' => {
                index += 1;
                while index < bytes.len() {
                    match bytes[index] {
                        b'\\' => index += 2,
                        b'"' => {
                            index += 1;
                            break;
                        }
                        _ => index += 1,
                    }
                }
            }
            byte => {
                out[index] = byte;
                index += 1;
            }
        }
    }
    String::from_utf8(out).expect("masked source stays valid UTF-8")
}

/// The body of the Tauri `.setup(|app| { ... })` closure (masked source).
fn setup_body(masked: &str) -> &str {
    let marker = ".setup(|app|";
    let setup = masked
        .find(marker)
        .unwrap_or_else(|| panic!("lib.rs must open the app with `{marker}`"));
    let open = setup
        + masked[setup..]
            .find('{')
            .expect("the setup closure must have a body");
    let close = matching_brace(masked, open);
    &masked[open + 1..close]
}

/// The item whose signature contains `signature`, delimited by brace matching.
fn item_span<'a>(masked: &'a str, signature: &str) -> &'a str {
    let start = masked
        .find(signature)
        .unwrap_or_else(|| panic!("`{signature}` not found in masked lib.rs"));
    let open = start
        + masked[start..]
            .find('{')
            .unwrap_or_else(|| panic!("`{signature}` has no body"));
    let close = matching_brace(masked, open);
    &masked[start..=close]
}

/// The index of the `}` closing the `{` at `open`.
fn matching_brace(masked: &str, open: usize) -> usize {
    let bytes = masked.as_bytes();
    let mut depth = 0i32;
    let mut index = open;
    while index < bytes.len() {
        match bytes[index] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return index;
                }
            }
            _ => {}
        }
        index += 1;
    }
    panic!("unbalanced braces while scanning from byte {open}");
}

/// Brace nesting depth at `needle`, relative to the start of `body` (0 = a
/// direct statement of the body — no enclosing block).
fn relative_depth(body: &str, needle: usize) -> i32 {
    let mut depth = 0i32;
    for (index, byte) in body.bytes().enumerate() {
        if index >= needle {
            break;
        }
        match byte {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            _ => {}
        }
    }
    depth
}
