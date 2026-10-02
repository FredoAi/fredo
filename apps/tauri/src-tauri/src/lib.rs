mod features;
pub mod infrastructure;
mod runtime;
mod utils;

// Spec #2975 ST-6 — test seam. The cross-engine integration binary
// (`tests/storage_engine_pg.rs`) drives the SAME bounded `PgRuntime` the app
// uses, so the G-263 start/stop/teardown contract is exercised by the real
// primitive (finite timeouts, hard-kill fallback, RAII teardown) instead of a
// test-local copy. `#[doc(hidden)]`: not part of the app's surface.
#[doc(hidden)]
pub use features::pg_supervisor::runtime::PgRuntime;

// Spec #2975 ST-6 — test seam. The ST-2 startup schema-init registry is populated
// with `features::terminal::persistence::ensure_table_on_pg` (a `mod features`
// item, otherwise unreachable from an integration test). The gated cross-engine
// suite drives the SAME terminal initializer through the registry so the boot
// schema-set contract is pinned. `#[doc(hidden)]`: not part of the app surface.
#[doc(hidden)]
pub use features::terminal::persistence::ensure_table_on_pg as ensure_terminal_table_on_pg;

use std::sync::{Arc, Mutex};
use std::time::Duration;
use features::terminal::state::TerminalState;
use infrastructure::comm::bus::EventBus;
use infrastructure::feature_data::commands::FeatureDataState;
use infrastructure::feature_data::envelope::FeatureRowNotification;
use infrastructure::feature_data::projection::{install_row_upsert_observer, ProjectionEngine, RowUpsertObserver};
use infrastructure::feature_data::registry::DeclarationRegistry;
use infrastructure::feature_data::store::FeatureDataStore;
use infrastructure::feature_data::watch::{run_watch_flush_task, NotificationSink, WatchRegistry};
use infrastructure::rtdb::commands::IngestRow;
use infrastructure::rtdb::cache::{
    prune_with_knobs, run_writer_task as run_rtdb_writer_task, RtdbCache,
};
use infrastructure::rtdb::commands::{Rtdb, RtdbState};
use infrastructure::rtdb::ingest::{IngestClassifier, IngestClassifierState};
use infrastructure::rtdb::flush::{run_flush_task, FlushLoop};
use infrastructure::rtdb::project::RowDelivery;
use infrastructure::rtdb::store::{
    RtdbStore, RTDB_DEFAULT_MAX_ROWS, RTDB_DEFAULT_RETENTION_DAYS, RTDB_MAX_ROWS_KEY,
    RTDB_RETENTION_DAYS_KEY,
};
use infrastructure::rtdb::subscriptions::SubscriptionRegistry;
use infrastructure::storage::engine::{
    select_engine, EngineHandle, SqliteEngine, StorageEngineState, StoreEngine,
};
use infrastructure::storage::feature_store::{self, FeatureStore};
use infrastructure::storage::migration::MigrationGate;
use infrastructure::storage::span_store::SpanStore;
use infrastructure::storage::AppStore;
use infrastructure::telemetry::metrics_collector::{MetricCollector, SpanStoreMetricsExt};
use infrastructure::telemetry::log::{LogBridgeLayer, LogCollector, LOG_COLLECTOR_CELL};
use infrastructure::telemetry::SpanCollector;
use runtime::AppRuntime;
use tauri::Manager;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

/// A `NotificationSink` that emits feature-data batches through the `EventBus`
/// (the ONLY sanctioned emission path) on the `"fredo-stream-event"` channel.
struct EventBusSink {
    app: tauri::AppHandle,
}

impl NotificationSink for EventBusSink {
    fn emit(&self, notifications: &[FeatureRowNotification]) {
        let bus = self.app.state::<EventBus>();
        bus.emit_feature_delivery_batch(notifications);
    }
}

/// The ONE canonical-upsert observer: feeds canonical-table watches AND the
/// declared-row projection engine (which then fans declared changes back into
/// the same watch registry).
struct FeatureDataUpsertObserver {
    engine: Arc<ProjectionEngine>,
    watches: Arc<WatchRegistry>,
}

#[async_trait::async_trait]
impl RowUpsertObserver for FeatureDataUpsertObserver {
    async fn on_row_upsert(&self, row: &IngestRow, changed_fields: &[String]) {
        self.watches.on_canonical_row(row, changed_fields);
        self.engine.on_row_upsert(row, changed_fields).await;
    }
}

/// One declared-table retention prune cycle; every eviction fans out into the
/// watch registry as a `remove` notification (the function itself returns the
/// evictions and emits nothing).
///
/// Spec #2977 ST-4: quiesces against the exclusive migration barrier when one is
/// installed; on timeout the prune is shed (the next cycle retries).
async fn prune_feature_data(app: &tauri::AppHandle, gate: Option<&Arc<MigrationGate>>) {
    let _guard = match gate {
        Some(gate) => match gate.writer_enter().await {
            Ok(guard) => Some(guard),
            Err(error) => {
                tracing::warn!(
                    target: "fredo::feature_data",
                    error = %error,
                    "declared retention prune shed: migration barrier held past its bound"
                );
                return;
            }
        },
        None => None,
    };
    let Some(state) = app.try_state::<Arc<FeatureDataState>>() else {
        return;
    };
    match infrastructure::feature_data::lifecycle::prune_declared_tables(
        &state.meta,
        &state.tables,
        &state.app_store,
    ) {
        Ok(evicted) if !evicted.is_empty() => {
            let removed = evicted.len();
            state.watches.handle_declared_changes(&evicted);
            tracing::info!(target: "fredo::feature_data", removed, "declared retention prune");
        }
        Ok(_) => {}
        Err(e) => tracing::error!(
            target: "fredo::feature_data",
            error = %e,
            "declared retention prune failed"
        ),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _runtime = AppRuntime::new();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init());

    #[cfg(debug_assertions)]
    let builder = builder.plugin(
        tauri_plugin_mcp_bridge::Builder::new()
            .bind_address("127.0.0.1")
            .base_port(9223)
            .build()
    );

    builder.setup(|app| {
            // Spec #2977 ST-6 (G-275): the ONE app-data-dir resolver. A non-blank
            // `FREDO_DATA_DIR` redirects the source `fredo.db` (and the AC3 backout
            // target) to an in-repo fixture; the managed-PG install dir + lock stay
            // on the OS dir (`features::pg_supervisor`), so a fixture run reuses the
            // existing install. Inert when unset (the default path is byte-identical).
            let data_dir = infrastructure::storage::migration::resolve_app_data_dir(
                &app.path()
                    .app_data_dir()
                    .expect("Failed to resolve app data dir"),
            );

            // -- Shared storage-engine seam (Spec #2975 ST-2) ------------------
            // ONE shared SQLite engine + the swap-once `EngineHandle`, built
            // BEFORE the supervisor starts. The supervisor's background pool
            // build installs PostgreSQL into this handle once the managed server
            // is ready; any failure leaves the handle on SQLite (fail-closed,
            // REQ-3/EARS-3.2). The state is managed so `storage_engine_status`
            // can report the live dialect + the fail-closed reason, and so the
            // supervisor can read the resolved selection.
            let sqlite_engine = SqliteEngine::open(&data_dir.join("fredo.db"))
                .expect("Failed to open the shared storage engine");
            let engine_choice = select_engine(&sqlite_engine);
            let engine_handle = EngineHandle::new(StoreEngine::Sqlite(sqlite_engine));
            let storage_state = StorageEngineState::new(engine_handle.clone(), engine_choice);
            // Spec #2975 ST-2 rework: register the startup schema initializers
            // BEFORE the supervisor starts, so the registry is populated before
            // the background task can reach pool-ready (no timing race). They run
            // against the candidate PostgreSQL pool pre-install, so the full
            // startup schema set exists before any feature op. The SQLite path
            // below keeps creating the same schema on SQLite.
            storage_state.register_pg_schema_init(Arc::new(|pool: &sqlx::PgPool| {
                FeatureDataStore::ensure_schema_on_pg(pool)
            }));
            storage_state.register_pg_schema_init(Arc::new(|pool: &sqlx::PgPool| {
                features::terminal::persistence::ensure_table_on_pg(pool)
            }));
            // Spec #2976 ST-7: the six slice-3 canonical tables (three `*_rows`
            // for RtdbStore + three telemetry tables) exist on the candidate
            // pool BEFORE it is installed (fail-closed: a failed init installs
            // NOTHING).
            storage_state.register_slice3_pg_schema_inits();
            app.manage(storage_state);

            // Spec #2977 ST-4: the ONE shared migration barrier, cloned into
            // every storage-write chokepoint below (the RTDB writer task, the
            // span/metrics/log flush tasks, the watch flush, the prunes, the
            // feature-data backfill) and installed onto the `FeatureStore` for
            // the terminal persistence writes. The supervisor's migration leg
            // takes the exclusive side of this SAME gate.
            let migration_gate = app.state::<Arc<StorageEngineState>>().migration_gate();

            // -- SQLite settings store (Spec #2975 ST-3) -----------------------
            // The KV store sits ON the shared handle: the async data plane
            // (`get`/`set`) is engine-selected, while the synchronous control
            // plane (`control_get`/`control_set`) stays on SQLite. The setup
            // closure below stays synchronous and reads config via the control
            // API — never `block_on`.
            let app_store = Arc::new(
                AppStore::open(engine_handle.clone()).expect("Failed to open settings store"),
            );
            app.manage(app_store.clone());

            // -- Embedded-PostgreSQL supervisor (Spec #2974 ST-3) --------------
            // Disabled by default (`postgres.enabled` absent ⇒ no lock, no
            // sweep, no spawn; SQLite persistence unchanged — R-1.4). When
            // enabled it acquires the exclusive data-dir lock BEFORE the orphan
            // sweep and LAZILY starts the postmaster on a background task:
            // `setup` NEVER awaits the boot (G-273/R-2.3), so the webview shell
            // renders while PostgreSQL starts.
            features::pg_supervisor::start_supervisor(app.handle());

            // -- FeatureStore (generic typed-column store for features) --------
            // Spec #2975 ST-4: the store holds an `Arc<EngineHandle>` clone of the
            // ONE shared engine; its SQLite statements are byte-identical to the
            // incumbent path, PostgreSQL is the 1:1 translated dialect.
            let feature_store = Arc::new(
                FeatureStore::open(engine_handle.clone()).expect("Failed to open FeatureStore"),
            );
            // Spec #2977 ST-4: the terminal persistence writes quiesce through
            // the shared migration barrier installed here.
            feature_store.install_migration_gate(migration_gate.clone());
            app.manage(feature_store.clone());

            // -- Terminal persisted session records (Spec #2935 ST-2) ----------
            // Materialize the record table once at startup; the terminal feature
            // writes/reads it directly (never via useFeatureData).
            features::terminal::persistence::ensure_table(&feature_store)
                .expect("Failed to create terminal session record table");

            // -- Tracing subscriber initialization (Spec #408) -----------------
            // Initialize before any tracing::info!/warn!/error! calls.
            // Uses a deferred LogBridgeLayer that reads from LOG_COLLECTOR_CELL,
            // which is set after LogCollector creation below.
            {
                let logging_level = app.state::<Arc<AppStore>>()
                    .control_get("tracing.logging_level").ok().flatten()
                    .unwrap_or_else(|| "INFO".to_string());

                let env_filter = EnvFilter::try_new(&logging_level)
                    .unwrap_or_else(|_| EnvFilter::new("INFO"));

                tracing_subscriber::registry()
                    .with(env_filter)
                    .with(tracing_subscriber::fmt::layer()
                        .with_target(true)
                        .with_level(true)
                        .compact())
                    .with(LogBridgeLayer::new())
                    .init();
            }

            // -- Companion llama-server state (Spec #2857 ST-4) ----------------
            // Out-of-process inference: the managed child process lives in this
            // state and is spawned/killed via the `features::llm_server`
            // commands registered below. There is NO in-process engine load —
            // readiness is the server's own `/health`, gated by the wizard.
            app.manage(features::llm_server::state::LlamaServerState::default());

            // -- Startup orphan sweep (Spec #2857 ST-7) ------------------------
            // A hard-kill (Task Manager) never runs the `RunEvent::Exit` hook, so
            // reclaim a persisted `llama-server` PID on the next launch. The sweep
            // is PID-reuse guarded (image name) and can never kill an unrelated
            // process (R-3.3).
            features::llm_server::process::sweep_orphan(app.handle());

            // -- Terminal state ------------------------------------------------
            app.manage(Mutex::new(TerminalState::new()));
            // Cold-launch one-shot handshake (Spec #2940 ST-8): the armed
            // `fredo open-terminal` intent a freshly created window drains on
            // its first `list_terminal_sessions`.
            app.manage(features::terminal::commands::PendingTerminalOpen::default());

            // -- EventBus (RTDB row-batch emitter for "fredo-stream-event") ----
            // The ONLY sanctioned emission path to the webview: RTDB row
            // batches via emit_row_delivery_batch (Spec #2788 P5.1 — the v1
            // raw/legacy emission paths and the persistence writer are gone).
            app.manage(EventBus::new(app.handle().clone()));

            // -- Telemetry: SpanStore + SpanCollector (Spec #396) --------------
            // REQ-1: Create SpanStore on the ONE shared engine handle
            // (Spec #2976 ST-5): SQLite `fredo.db` by default, the shared
            // PostgreSQL pool once installed. The sync setup closure bridges the
            // async schema/retention calls (same pattern as RtdbStore below).
            let span_store = Arc::new(
                SpanStore::open(engine_handle.clone()).expect("Failed to open SpanStore"),
            );
            tauri::async_runtime::block_on(span_store.ensure_schema())
                .expect("Failed to create telemetry schema");
            // REQ-9: Create telemetry_metrics table
            tauri::async_runtime::block_on(span_store.ensure_metrics_schema())
                .expect("Failed to create telemetry metrics schema");
            app.manage(span_store.clone());

            // REQ-11: Set telemetry defaults if not already configured.
            {
                let store_ref = app.state::<Arc<AppStore>>();
                if store_ref.control_get("tracing.enabled").ok().flatten().is_none() {
                    let _ = store_ref.control_set("tracing.enabled", "true");
                }
                if store_ref.control_get("tracing.retention_days").ok().flatten().is_none() {
                    let _ = store_ref.control_set("tracing.retention_days", "7");
                }
                // REQ-13: Set metrics defaults if not already configured.
                if store_ref.control_get("tracing.metrics_enabled").ok().flatten().is_none() {
                    let _ = store_ref.control_set("tracing.metrics_enabled", "true");
                }
                if store_ref.control_get("tracing.metrics_aggregation_s").ok().flatten().is_none() {
                    let _ = store_ref.control_set("tracing.metrics_aggregation_s", "60");
                }
                // REQ-7: Set logging defaults if not already configured.
                if store_ref.control_get("tracing.logging_enabled").ok().flatten().is_none() {
                    let _ = store_ref.control_set("tracing.logging_enabled", "true");
                }
                if store_ref.control_get("tracing.logging_level").ok().flatten().is_none() {
                    let _ = store_ref.control_set("tracing.logging_level", "INFO");
                }
            }

            // REQ-9: Run retention cleanup on startup.
            let store_ref = app.state::<Arc<AppStore>>();
            let retention_days: i64 = store_ref
                .control_get("tracing.retention_days")
                .ok()
                .flatten()
                .and_then(|v| v.parse().ok())
                .unwrap_or(7);
            match tauri::async_runtime::block_on(span_store.delete_expired(retention_days)) {
                Ok(deleted) => {
                    if deleted > 0 {
                        tracing::info!(target: "fredo::telemetry", deleted, "retention cleanup");
                    }
                }
                Err(e) => tracing::error!(target: "fredo::telemetry", error = %e, "retention cleanup error"),
            }

            // Create MetricCollector and register as Tauri state.
            let metric_collector = Arc::new(MetricCollector::new(
                span_store.clone(),
                Arc::clone(&*app.state::<Arc<AppStore>>()),
            ));
            app.manage(metric_collector.clone());

            // Create SpanCollector and register as Tauri state.
            let collector = Arc::new(SpanCollector::new(span_store.clone(), Arc::clone(&*app.state::<Arc<AppStore>>())));
            app.manage(collector.clone());

            // -- LogCollector (Spec #408) -------------------------------------
            // Create LogCollector, register as Tauri state, and set the global
            // OnceLock so the LogBridgeLayer (initialized earlier) starts capturing.
            let log_collector = Arc::new(LogCollector::new(
                span_store.clone(),
                Arc::clone(&*app.state::<Arc<AppStore>>()),
            ));
            // Set the global OnceLock for the LogBridgeLayer
            let _ = LOG_COLLECTOR_CELL.set(log_collector.clone());
            app.manage(log_collector.clone());

            // REQ-6: Background flush every 1 second (5-second idle timeout).
            let flush_handle = app.handle().clone();
            let flush_gate = migration_gate.clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(1));
                loop {
                    interval.tick().await;
                    // Spec #2977 ST-4: quiesce the storage flush against the
                    // exclusive migration barrier.
                    let _guard = match flush_gate.writer_enter().await {
                        Ok(guard) => guard,
                        Err(error) => {
                            tracing::warn!(
                                target: "fredo::telemetry",
                                error = %error,
                                "span flush shed: migration barrier held past its bound"
                            );
                            continue;
                        }
                    };
                    let collector = flush_handle.state::<Arc<SpanCollector>>();
                    let flushed = collector.flush_if_needed().await;
                    if flushed > 0 {
                        tracing::info!(target: "fredo::telemetry", flushed, "spans flushed from timer");
                    }
                }
            });

            // REQ-17: Background metrics flush every 1 second.
            let metrics_flush_handle = app.handle().clone();
            let metrics_flush_gate = migration_gate.clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(1));
                loop {
                    interval.tick().await;
                    // Spec #2977 ST-4: quiesce the storage flush against the
                    // exclusive migration barrier.
                    let _guard = match metrics_flush_gate.writer_enter().await {
                        Ok(guard) => guard,
                        Err(error) => {
                            tracing::warn!(
                                target: "fredo::telemetry",
                                error = %error,
                                "metrics flush shed: migration barrier held past its bound"
                            );
                            continue;
                        }
                    };
                    let mc = metrics_flush_handle.state::<Arc<MetricCollector>>();
                    let flushed = mc.flush_if_needed().await;
                    if flushed > 0 {
                        tracing::info!(target: "fredo::telemetry", flushed, "metrics flushed from timer");
                    }
                }
            });

            // REQ-7: Background log flush every 1 second.
            let log_flush_handle = app.handle().clone();
            let log_flush_gate = migration_gate.clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(1));
                loop {
                    interval.tick().await;
                    // Spec #2977 ST-4: quiesce the storage flush against the
                    // exclusive migration barrier.
                    let _guard = match log_flush_gate.writer_enter().await {
                        Ok(guard) => guard,
                        Err(error) => {
                            tracing::warn!(
                                target: "fredo::telemetry",
                                error = %error,
                                "log flush shed: migration barrier held past its bound"
                            );
                            continue;
                        }
                    };
                    let lc = log_flush_handle.state::<Arc<LogCollector>>();
                    let flushed = lc.flush_if_needed().await;
                    if flushed > 0 {
                        tracing::info!(target: "fredo::telemetry", flushed, "log buffer flushed");
                    }
                }
            });

            // REQ-7: Background orphan sweep every 60 seconds (5-minute timeout).
            let sweep_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(60));
                loop {
                    interval.tick().await;
                    let collector = sweep_handle.state::<Arc<SpanCollector>>();
                    let swept = collector.sweep_orphans().await;
                    if swept > 0 {
                        tracing::info!(target: "fredo::telemetry", swept, "orphan sweep completed");
                    }
                    // REQ-4: Feed orphan count to MetricCollector
                    if swept > 0 {
                        let mc = sweep_handle.state::<Arc<MetricCollector>>();
                        mc.record_orphan_count(swept);
                    }
                }
            });

            // -- RTDB row store (Spec #2788 P1.2; engine-selected #2976 ST-7) ---
            // Typed rows (chat_rows / tool_use_rows / agent_session_rows) behind
            // an LRU row cache with a ~30 ms write-behind flush task, routed
            // through the ONE shared `EngineHandle` (SQLite `fredo.db` by
            // default, the shared PostgreSQL pool once installed).
            // telemetry_spans is never touched.
            let rtdb_store = Arc::new(
                RtdbStore::open(engine_handle.clone()).expect("Failed to open RtdbStore"),
            );
            // One-time startup schema creation on the active engine (the
            // sync setup closure bridges to the async store schema).
            tauri::async_runtime::block_on(rtdb_store.ensure_schema())
                .expect("Failed to create rtdb schema");
            let (rtdb_cache, rtdb_rx) = RtdbCache::new(Arc::clone(&rtdb_store));
            app.manage(rtdb_cache.clone());

            // -- RTDB live pipeline (Spec #2788 P2.3) --------------------------
            // Registry (P2.2) + flush loop + eviction routing, behind
            // `Arc<Rtdb>` Tauri state. Emission goes through the EventBus's
            // emit_row_delivery_batch (the ONLY sanctioned RTDB emission
            // path) — ONE batch IPC envelope per drained window chunk
            // (F-33 fix, W-1), never one IPC event per row.
            let rtdb_registry = Arc::new(SubscriptionRegistry::new());
            let rtdb_emit_handle = app.handle().clone();
            let rtdb_flush = Arc::new(FlushLoop::new(Arc::new(
                move |deliveries: &[RowDelivery], replay_complete_query_id: Option<&str>| {
                    let bus = rtdb_emit_handle.state::<EventBus>();
                    bus.emit_row_delivery_batch(deliveries, replay_complete_query_id);
                },
            )));
            let rtdb: RtdbState = Arc::new(Rtdb::new(
                Arc::clone(&rtdb_cache),
                rtdb_registry,
                Arc::clone(&rtdb_flush),
            ));
            // RTDB ingest classifier (Spec #2788 P3.1): owns the correlation
            // maps (ported from the deleted v1 adapter + ECE relationship
            // registry) and classifies spans/events into row upserts. The
            // OTLP receivers + IPC dispatcher consume this state.
            let classifier = IngestClassifierState::new(IngestClassifier::new(Arc::clone(&rtdb)));
            app.manage(rtdb);
            app.manage(classifier);

            // -- Feature-owned data layer (Spec #2896 ST-4) --------------------
            // Declared, backend-owned, persistent per-feature tables: compose
            // the declaration registry + projection engine here, install the
            // projection observer UNCONDITIONALLY (never gated by a watch/read/
            // open UI — R-4.2), and make the watch registry the declared-row
            // sink. Canonical-table watches are fed by the same observer.
            let feature_meta = Arc::new(
                FeatureDataStore::open(engine_handle.clone())
                    .expect("Failed to open FeatureDataStore"),
            );
            feature_meta
                .ensure_schema()
                .expect("Failed to create feature data schema");
            let feature_registry = Arc::new(DeclarationRegistry::new(
                feature_meta.clone(),
                feature_store.clone(),
            ));
            // Re-materialize every persisted declaration (R-4.4: a restart over
            // an existing fredo.db preserves the declared rows).
            match feature_registry.materialize_persisted() {
                Ok(materialized) if !materialized.is_empty() => tracing::info!(
                    target: "fredo::feature_data",
                    tables = materialized.len(),
                    "persisted declared tables re-materialized"
                ),
                Ok(_) => {}
                Err(errors) => tracing::warn!(
                    target: "fredo::feature_data",
                    error = %errors.join("; "),
                    "declared table re-materialization reported errors"
                ),
            }
            let feature_engine = Arc::new(
                ProjectionEngine::new(
                    engine_handle.clone(),
                    feature_meta.clone(),
                    feature_store.clone(),
                )
                .expect("Failed to open feature-data projection engine"),
            );
            let feature_watches = Arc::new(WatchRegistry::new(Arc::new(EventBusSink {
                app: app.handle().clone(),
            })));
            feature_engine.set_declared_row_observer(feature_watches.clone());
            // ONE observer slot: a composite feeding canonical watches AND the
            // projection engine. Installing the ST-3 engine alone would leave
            // canonical-table watches (contract (c) `featureId: null`) un-fed.
            install_row_upsert_observer(Arc::new(FeatureDataUpsertObserver {
                engine: feature_engine.clone(),
                watches: feature_watches.clone(),
            }));
            app.manage(Arc::new(FeatureDataState {
                data_dir: data_dir.clone(),
                meta: feature_meta.clone(),
                tables: feature_store.clone(),
                app_store: app_store.clone(),
                registry: feature_registry,
                engine: feature_engine.clone(),
                watches: feature_watches.clone(),
                rtdb_store: rtdb_store.clone(),
                migration_gate: migration_gate.clone(),
            }));
            // Watch flush task: emits due coalescing windows (~5 ms cadence).
            let feature_flush = feature_watches.clone();
            let watch_flush_gate = migration_gate.clone();
            tauri::async_runtime::spawn(async move {
                run_watch_flush_task(feature_flush, Some(watch_flush_gate)).await;
            });
            // One-time declared-table projection backfill (A-17): spawned,
            // never awaited on the read path. Spec #2977 ST-4: the backfill
            // writes declared rows directly, so it quiesces against the
            // migration barrier for its (one-shot) duration.
            let backfill_meta = feature_meta.clone();
            let backfill_engine = feature_engine.clone();
            let backfill_store = rtdb_store.clone();
            let backfill_gate = migration_gate.clone();
            tauri::async_runtime::spawn(async move {
                let _guard = match backfill_gate.writer_enter().await {
                    Ok(guard) => guard,
                    Err(error) => {
                        tracing::warn!(
                            target: "fredo::feature_data",
                            error = %error,
                            "declared-table backfill shed: migration barrier held past its bound"
                        );
                        return;
                    }
                };
                infrastructure::feature_data::backfill::run_backfill(
                    backfill_meta,
                    backfill_engine,
                    backfill_store,
                )
                .await;
            });

            // Voice session state: holds the ONE active listening session and the
            // bounded model-audio clip awaiting `stt_take_audio_clip`. The
            // microphone is opened ONLY by `stt_start` (Spec #2887 / #2914 —
            // there is no resident engine: the captured clip is the ONE path).
            app.manage(infrastructure::voice::session::VoiceState::new());

            // Legacy STT on-disk cleanup (Spec #2914 SA-12/SA-13, NFR-3). The
            // on-device sherpa engine was deleted with the local speech path, so
            // an upgraded machine's previously downloaded model directory under
            // `<models_dir>/sherpa-onnx-streaming-zipformer-en-2023-06-26` is
            // dead weight. FIRE-AND-FORGET, exactly like the retired
            // `ResidentEngine::warm_at_setup`: nothing on the setup path awaits
            // it, so startup is never blocked or delayed. Un-gated and
            // idempotent (no completion marker) — a restart on an upgraded
            // machine is the live trigger. The cleanup is scoped to that ONE
            // path; a missing path or a failure is silent (logged, never panics).
            let legacy_stt_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let models_dir =
                    infrastructure::companion::models::resolve_models_dir(&legacy_stt_handle);
                features::setup::legacy_stt::remove_legacy_stt_model_dir(&models_dir);
            });

            // Flush task: polls due coalescing windows (~5 ms cadence).
            let rtdb_flush_task = Arc::clone(&rtdb_flush);
            tauri::async_runtime::spawn(async move {
                run_flush_task(rtdb_flush_task).await;
            });

            // Set RTDB retention defaults if not already configured (AppStore
            // KV keys — the binding config-first mechanism).
            {
                let store_ref = app.state::<Arc<AppStore>>();
                if store_ref.control_get(RTDB_RETENTION_DAYS_KEY).ok().flatten().is_none() {
                    let _ = store_ref
                        .control_set(RTDB_RETENTION_DAYS_KEY, &RTDB_DEFAULT_RETENTION_DAYS.to_string());
                }
                if store_ref.control_get(RTDB_MAX_ROWS_KEY).ok().flatten().is_none() {
                    let _ = store_ref.control_set(RTDB_MAX_ROWS_KEY, &RTDB_DEFAULT_MAX_ROWS.to_string());
                }
            }

            // Retention prune on startup (mirrors the SpanStore/contract flow;
            // the writer task re-prunes on a 60-minute interval). P2.3: the
            // evicted keys route `kind: remove` deliveries through Rtdb. The
            // prune now awaits the engine-selected store; the sync setup closure
            // bridges with `block_on` to keep the pre-writer-task ordering.
            tauri::async_runtime::block_on(prune_with_knobs(app.handle(), Some(&migration_gate)));

            // Declared-table retention prune: once at startup, then on the same
            // 60-minute cadence as the RTDB writer prune (ST-7 supplies the
            // function; evictions fan out as `remove` notifications here).
            tauri::async_runtime::block_on(prune_feature_data(
                app.handle(),
                Some(&migration_gate),
            ));
            let feature_prune_handle = app.handle().clone();
            let feature_prune_gate = migration_gate.clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(60 * 60));
                interval.tick().await; // consume the immediate first tick
                loop {
                    interval.tick().await;
                    prune_feature_data(&feature_prune_handle, Some(&feature_prune_gate)).await;
                }
            });

            // RTDB write-behind task: drains the bounded queue in ~30 ms
            // batches; overflow sheds the storage write, never in-memory state.
            let rtdb_writer_handle = app.handle().clone();
            let rtdb_writer_gate = migration_gate.clone();
            tauri::async_runtime::spawn(async move {
                run_rtdb_writer_task(rtdb_writer_handle, rtdb_rx, Some(rtdb_writer_gate)).await;
            });

            // RTDB canonical backfill (Spec #2788 P3.2, REQs R-2b/R-4c):
            // re-derives canonical rows for PRE-CUTOVER history from
            // telemetry_spans (strictly READ-ONLY) through the SAME ingest
            // classifier — one shared extract-rule implementation keeps
            // re-derivation byte-comparable with live derivation (NFR-6).
            // Spawned: never blocks startup. Idempotent: content-identical
            // re-merges skip the write (no seq inflation); a one-shot
            // completion marker keeps later startups O(1).
            //
            // Spec #2977 ST-4 quiesce note: this replay ingests INTO THE
            // IN-MEMORY RTDB pipeline (classifier → cache → write-behind queue);
            // it performs NO direct storage write. Its storage writes are the
            // writer task's, which are gated below — so the canonical backfill
            // is quiesced TRANSITIVELY without a coarse hold here (a coarse hold
            // would stall the migration for the whole replay on a full-size DB).
            //
            // Spec #2932 ST-6: the provider re-derivation leg runs SEQUENTIALLY
            // after it, gated by its OWN independent marker
            // (`rtdb.backfill.provider.completed`) so an install that latched
            // `rtdb.backfill.completed` before the `provider` column existed
            // still gets one pass. Sequential in this task so the two one-shot
            // replays never overlap; the second leg builds its own classifier
            // instance (the per-classifier turn/correlation state must start
            // fresh — see rtdb::backfill module docs).
            let backfill_handle = app.handle().clone();
            let backfill_engine = engine_handle.clone();
            tauri::async_runtime::spawn(async move {
                infrastructure::rtdb::backfill::run_startup_backfill(
                    &backfill_handle,
                    backfill_engine.clone(),
                )
                .await;
                infrastructure::rtdb::backfill::run_startup_provider_rebackfill(
                    &backfill_handle,
                    backfill_engine,
                )
                .await;
            });

            // -- IPC server (OpenCode plugin event path) -----------------------------
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = infrastructure::ipc::start_ipc_server(handle).await {
                    tracing::error!(target: "fredo::ipc", error = %e, "IPC server error");
                }
            });

            // -- App-open request registry (Spec #2893 ST-4) -------------------
            // `fredo open-app <IDENTITY>` emits `app-open-request` to the main
            // window and waits (bounded 5 s) for the webview's confirmation
            // through this registry. The Rust side never resolves identities —
            // the frontend owns the one resolution rule.
            app.manage(infrastructure::app_open::AppOpenRegistry::new());

            // -- OTLP receiver (gRPC :4317 + HTTP :4318) -----------------------
            infrastructure::otlp::start(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // RTDB (Spec #2788 P2.3)
            infrastructure::rtdb::commands::subscribe_events,
            infrastructure::rtdb::commands::unsubscribe_events,
            // Feature-owned data layer (Spec #2896 ST-4): read/watch/unwatch +
            // write/delete/declare over declared and canonical tables.
            infrastructure::feature_data::commands::feature_data_read,
            infrastructure::feature_data::commands::feature_data_watch,
            infrastructure::feature_data::commands::feature_data_unwatch,
            infrastructure::feature_data::commands::feature_data_write,
            infrastructure::feature_data::commands::feature_data_delete,
            infrastructure::feature_data::commands::feature_data_declare,
            // Voice input (opt-in, one model-audio path; control-plane events)
            infrastructure::voice::commands::stt_list_devices,
            infrastructure::voice::commands::stt_start,
            infrastructure::voice::commands::stt_stop,
            infrastructure::voice::commands::stt_cancel,
            infrastructure::voice::commands::stt_status,
            // #2897 ST-2 — take (and clear) the bounded model-audio clip after a
            // stop; the clip crosses IPC only.
            infrastructure::voice::commands::stt_take_audio_clip,
            // Features
            features::settings::commands::save_setting,
            features::settings::commands::get_setting,
            features::terminal::commands::open_terminal_window,
            features::terminal::commands::spawn_terminal_session,
            features::terminal::commands::list_terminal_sessions,
            features::terminal::commands::get_pty_buffer,
            features::terminal::commands::write_pty_input,
            features::terminal::commands::resize_pty,
            features::terminal::commands::close_terminal_session,
            features::terminal::commands::close_terminal_window,
            features::terminal::commands::list_persisted_terminal_sessions,
            features::terminal::commands::resume_terminal_session,
            features::terminal::commands::delete_terminal_session_record,
            features::terminal::commands::rename_terminal_session_record,
            features::setup::commands::check_cli_installations,
            features::setup::commands::install_plugin,
            features::setup::commands::get_plugin_source_path,
            features::setup::commands::check_fredo_in_path,
            features::setup::commands::add_fredo_to_path,
            features::setup::commands::check_otel_configured,
            features::setup::commands::configure_otel,
            features::setup::commands::get_setup_plan,
            features::setup::commands::check_all_setup,
            features::setup::commands::run_setup_step,
            features::setup::commands::check_model_files,
            features::setup::commands::download_model,
            features::setup::commands::check_companion_readiness,
            features::setup::commands::install_llama_cpp,
            // Companion llama-server (Spec #2857 ST-4): rerouted chat/vision +
            // the lifecycle commands. SAME `llm_chat` / `llm_chat_with_image`
            // IPC names and argument shapes as the deleted in-process path.
            features::llm_server::commands::llm_chat,
            features::llm_server::commands::llm_chat_with_image,
            // #2897 ST-3 — model-audio turn: the captured clip is attached to the
            // last user message and delivered over the managed loopback server.
            features::llm_server::commands::llm_chat_with_audio,
            features::llm_server::commands::generate_llama_server_config,
            features::llm_server::commands::launch_llama_server,
            features::llm_server::commands::stop_llama_server,
            features::llm_server::commands::get_llama_server_status,
            // Phase-0 live capability diagnostic (Spec #2893, ST-1): read-only
            // `/props` + `tools`/`response_format` probe; no window, no state write.
            features::llm_server::probe::probe_companion_skills,
            // #2897 ST-6 — backend-owned model-audio capability for the Companion
            // readiness row + the pre-start gate. Reads the managed loopback
            // server and records the verdict on `VoiceState` (REQ-7).
            features::llm_server::commands::stt_audio_capability,
            // Skill-aware inference path (Spec #2893, ST-5): offers the ST-3
            // registry, validates a selection, emits `llm-skill-call` then
            // `llm-done`. ADDITIVE — `llm_chat`/`llm_chat_with_image` unchanged.
            features::llm_server::skills::llm_chat_with_skills,
            // Structured per-reply status (Spec #2918, ST-1): the reply is
            // obtained under a JSON-Schema `response_format` contract
            // (`{reply,status}`); ONLY decoded reply characters cross as
            // `llm-token` and the parsed status rides the ADDITIVE `llm-status`
            // before the shipped `llm-done`. ADDITIVE — `llm_chat` /
            // `llm_chat_with_skills` unchanged.
            features::llm_server::status::llm_chat_with_status,
            // #2918 ST-2 — the cached read-only `response_format` capability gate.
            // REUSES the existing `probe_companion_skills` mechanism (no new
            // detector); the chat gate reads this cache, so the capability is
            // never probed per turn.
            features::llm_server::probe::companion_status_capability,
            features::screenshot::commands::capture_screen_region,
            // Embedded-PostgreSQL supervisor (Spec #2974 ST-3): the single
            // read-only observability hook (no state mutation).
            features::pg_supervisor::state::pg_supervisor_status,
            // Windows distribution quality (Spec #2978 S4): the bounded,
            // read-only postmaster log tail (`<data_dir>/log/postgres.log`).
            features::pg_supervisor::state::pg_server_log_tail,
            // Cutover release gate (Spec #2978 S6): the ONE read-only decision
            // source slice 6 consumes (acquisition mode + cutover marker →
            // shipped default; fail-closed to SQLite; NO engine flip).
            features::pg_supervisor::release_gate::cutover_release_gate,
            // Storage engine seam (Spec #2975 ST-2): the live-observable,
            // read-only engine status (dialect + fail-closed reason).
            infrastructure::storage::engine::storage_engine_status,
            // One-shot `fredo.db` → PostgreSQL data migration (Spec #2977):
            // the read-only live status hook (ST-6).
            infrastructure::storage::migration::run::migration_status,
            // FeatureStore (Spec #339)
            feature_store::feature_store_ensure_table,
            feature_store::feature_store_insert,
            feature_store::feature_store_query,
            feature_store::feature_store_update,
            feature_store::feature_store_delete,
            // Telemetry (Spec #396)
            features::telemetry::commands::telemetry_get_stats,
            features::telemetry::commands::telemetry_purge,
            features::telemetry::commands::telemetry_toggle,
            // Telemetry Metrics (Spec #407)
            features::telemetry::commands::telemetry_metrics_toggle,
            // Telemetry Logging (Spec #408)
            features::telemetry::commands::telemetry_logging_toggle,
            features::telemetry::commands::telemetry_logging_set_level,
            // App-open transport (Spec #2893 ST-4): the webview's confirmation
            // of an emitted `app-open-request`, and the companion's thin CLI
            // spawn/bound/parse seam.
            infrastructure::app_open::confirm_app_open_request,
            infrastructure::app_open::run_open_app_cli,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Fredo application")
        .run(|app, event| {
            // Spec #2857 ST-4: the app-exit hook. Terminate the managed
            // `llama-server` tree so no orphan survives Fredo (R-3.3). The
            // startup PID sweep + the kill-on-exit test are ST-7's.
            if let tauri::RunEvent::Exit = event {
                features::llm_server::commands::stop_llama_server_on_exit(app);
                // Spec #2974 ST-3: bounded embedded-PostgreSQL teardown. The
                // graceful stop is wall-clock capped by PG_EXIT_HOOK_BOUND (5 s)
                // with a `taskkill /T /F` hard-kill fallback, then a marker sweep
                // backstop — quit never blocks on a hung server (R-2.1/G-263).
                features::pg_supervisor::stop_on_exit(app);
            }
        });
}
