mod features;
pub mod infrastructure;
mod runtime;
mod utils;

use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use features::llm::state::{LlmLoadingState, LlmState};
use features::terminal::state::RunCliState;
use infrastructure::comm::adapters::otlp::GenericOtlpAdapter;
use infrastructure::comm::bus::EventBus;
use infrastructure::comm::contract::engine::ContractEngine;
use infrastructure::comm::contract::store::{
    run_writer_task, ContractEventStore, ContractEventWriter, DEFAULT_MAX_ROWS,
    DEFAULT_RETENTION_DAYS, MAX_ROWS_KEY, RETENTION_DAYS_KEY,
};
use infrastructure::comm::contract::EventContractEngine;
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
use infrastructure::storage::feature_store::{self, FeatureStore};
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
            // -- SQLite settings store -----------------------------------------
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to resolve app data dir");
            let store = AppStore::open(data_dir.clone()).expect("Failed to open settings store");
            app.manage(Arc::new(store));

            // -- FeatureStore (generic typed-column SQLite store for features) --
            let feature_store =
                FeatureStore::open(data_dir.clone()).expect("Failed to open FeatureStore");
            app.manage(Arc::new(feature_store));

            // -- Tracing subscriber initialization (Spec #408) -----------------
            // Initialize before any tracing::info!/warn!/error! calls.
            // Uses a deferred LogBridgeLayer that reads from LOG_COLLECTOR_CELL,
            // which is set after LogCollector creation below.
            {
                let logging_level = app.state::<Arc<AppStore>>()
                    .get("tracing.logging_level").ok().flatten()
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

            // -- LLM service (in-process llama.cpp engine) --------------------
            app.manage(LlmState(Mutex::new(None)));
            let is_loading = Arc::new(AtomicBool::new(false));
            app.manage(LlmLoadingState(Arc::clone(&is_loading)));

            // Which model is selected? Read from SQLite (default: gemma-4-e2b).
            let selected_model = {
                let store_ref = app.state::<Arc<AppStore>>();
                store_ref.get("llm_model").ok().flatten()
                    .unwrap_or_else(|| "gemma-4-e2b".to_string())
            };

            // Read configured models_dir from AppStore (default: {home}/fredo-models)
            let models_dir = {
                let store_ref = app.state::<Arc<AppStore>>();
                store_ref.get("models_dir").ok().flatten()
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(|| {
                        app.path().home_dir().unwrap_or_default().join("fredo-models")
                    })
            };

            let resolve_path = |subdir: &str, filename: &str| -> Option<std::path::PathBuf> {
                // 1. Configured models_dir (primary — user can control this)
                let candidate = models_dir.join(subdir).join(filename);
                if candidate.exists() {
                    tracing::info!(target: "fredo::llm", path = %candidate.display(), "found model in models_dir");
                    return Some(candidate);
                }
                // 2. Resource dir (legacy — may contain stale copies from pre-Spec#108 builds)
                if let Ok(rd) = app.path().resource_dir() {
                    let fb = rd.join("models").join(subdir).join(filename);
                    if fb.exists() {
                        tracing::info!(target: "fredo::llm", path = %fb.display(), "found model in resource_dir");
                        return Some(fb);
                    }
                }
                // 3. CARGO_MANIFEST_DIR fallback (source-tree development)
                let fb = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("models").join(subdir).join(filename);
                if fb.exists() {
                    tracing::info!(target: "fredo::llm", path = %fb.display(), "found model in source tree");
                    return Some(fb);
                }
                None
            };

            // Map model id ? (subdir, gguf filename, optional mmproj filename)
            // MiniCPM-V 4.6's projector type is not supported in llama-cpp-2 v0.1.146,
            // so it runs text-only. Gemma gets the mmproj for vision.
            let (model_file, mmproj_file, model_dir) = match selected_model.as_str() {
                "minicpm-v-4-6" => (
                    "MiniCPM-V-4_6-Q4_K_M.gguf",
                    None,   // projector type unsupported in this version
                    "minicpm-4-6",
                ),
                _ => (
                    "gemma-4-E2B-it-Q4_K_M.gguf",
                    Some("mmproj-F16.gguf"),
                    "gemma-e2b-it",
                ),
            };

            let model_path = resolve_path(model_dir, model_file);
            let mmproj_path = mmproj_file.and_then(|f| resolve_path(model_dir, f));
            tracing::info!(target: "fredo::llm", selected_model, model_path = ?model_path, mmproj_path = ?mmproj_path, "model configuration");

            if let Some(model) = model_path {
                is_loading.store(true, Ordering::SeqCst);
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        if let Some(mmproj) = mmproj_path {
                            features::llm::engine::LlmEngine::load_with_vision(&model, &mmproj)
                        } else {
                            features::llm::engine::LlmEngine::load(&model)
                        }
                    })
                    .await;

                    match result {
                        Ok(Ok(engine)) => {
                            let svc = features::llm::service::LlmService::new(engine);
                            *handle.state::<LlmState>().0.lock().unwrap() = Some(svc);
                            tracing::info!(target: "fredo::llm", "in-process engine ready");
                        }
                        Ok(Err(e)) => tracing::error!(target: "fredo::llm", error = %e, "engine load failed"),
                        Err(e) => tracing::error!(target: "fredo::llm", error = %e, "task panicked"),
                    }

                    handle.state::<LlmLoadingState>().0.store(false, Ordering::SeqCst);
                });
            } else {
                tracing::warn!(target: "fredo::llm", "model not found - LLM features disabled.");
            }

            // -- Terminal state ------------------------------------------------
            app.manage(Mutex::new(RunCliState::new()));

            // -- ContractEventStore (Spec #2768 ST-3) --------------------------
            // Per-contract delivery persistence: own Mutex<Connection> to
            // fredo.db (SpanStore pattern), `contract_events` table.
            let contract_event_store = Arc::new(
                ContractEventStore::open(data_dir.clone())
                    .expect("Failed to open ContractEventStore"),
            );
            contract_event_store
                .ensure_schema()
                .expect("Failed to create contract_events schema");
            app.manage(contract_event_store.clone());

            // Set persistence retention defaults if not already configured.
            {
                let store_ref = app.state::<Arc<AppStore>>();
                if store_ref.get(RETENTION_DAYS_KEY).ok().flatten().is_none() {
                    let _ = store_ref.set(RETENTION_DAYS_KEY, &DEFAULT_RETENTION_DAYS.to_string());
                }
                if store_ref.get(MAX_ROWS_KEY).ok().flatten().is_none() {
                    let _ = store_ref.set(MAX_ROWS_KEY, &DEFAULT_MAX_ROWS.to_string());
                }
            }

            // Retention prune on startup (mirrors the SpanStore REQ-9 flow).
            {
                let store_ref = app.state::<Arc<AppStore>>();
                let retention_days: i64 = store_ref
                    .get(RETENTION_DAYS_KEY)
                    .ok()
                    .flatten()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(DEFAULT_RETENTION_DAYS);
                let max_rows: i64 = store_ref
                    .get(MAX_ROWS_KEY)
                    .ok()
                    .flatten()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(DEFAULT_MAX_ROWS);
                match contract_event_store.prune(retention_days, max_rows) {
                    Ok(deleted) => {
                        if deleted > 0 {
                            tracing::info!(target: "fredo::comm", deleted, "contract_events startup prune");
                        }
                    }
                    Err(e) => tracing::error!(target: "fredo::comm", error = %e, "contract_events startup prune error"),
                }
            }

            // -- ContractEventWriter (Spec #2768 ST-3, R8) ---------------------
            // Bounded non-blocking persistence queue drained by the writer task
            // below. Overflow sheds persistence work — never live deliveries.
            let (event_writer, contract_event_rx) = ContractEventWriter::new();
            app.manage(event_writer.clone());

            // -- EventBus (SubscriptionDelivery emitter for "fredo-stream-event") --
            // Holds the persistence writer: emit_delivery is the single choke
            // point enqueueing persistent-contract deliveries.
            app.manage(EventBus::new(app.handle().clone(), event_writer.clone()));

            // -- Event Contract Engine (Spec #303) ----------------------------
            let engine = ContractEngine::new();
            app.manage(engine.clone());

            // -- GenericOtlpAdapter (provider-agnostic OTLP → EngineInput) --
            // Spec #2449 S2/S4: the provider-agnostic OTLP adapter emits
            // `EngineInput` (the ECE's input contract) instead of a standalone
            // event object (R3/AC-3). The OTLP receivers resolve it from Tauri
            // state. The superseded OTLP half of OpenCodeAdapter was removed in
            // S4 — its managed singleton is no longer registered because no
            // runtime path resolves `Arc<OpenCodeAdapter>` from state.
            let generic_otlp_adapter = Arc::new(GenericOtlpAdapter::new());
            app.manage(generic_otlp_adapter);

            // -- Telemetry: SpanStore + SpanCollector (Spec #396) --------------
            // REQ-1: Create SpanStore with the telemetry_spans schema.
            let span_store = Arc::new(
                SpanStore::open(data_dir.clone()).expect("Failed to open SpanStore"),
            );
            span_store.ensure_schema().expect("Failed to create telemetry schema");
            // REQ-9: Create telemetry_metrics table
            span_store
                .ensure_metrics_schema()
                .expect("Failed to create telemetry metrics schema");
            app.manage(span_store.clone());

            // REQ-11: Set telemetry defaults if not already configured.
            {
                let store_ref = app.state::<Arc<AppStore>>();
                if store_ref.get("tracing.enabled").ok().flatten().is_none() {
                    let _ = store_ref.set("tracing.enabled", "true");
                }
                if store_ref.get("tracing.retention_days").ok().flatten().is_none() {
                    let _ = store_ref.set("tracing.retention_days", "7");
                }
                // REQ-13: Set metrics defaults if not already configured.
                if store_ref.get("tracing.metrics_enabled").ok().flatten().is_none() {
                    let _ = store_ref.set("tracing.metrics_enabled", "true");
                }
                if store_ref.get("tracing.metrics_aggregation_s").ok().flatten().is_none() {
                    let _ = store_ref.set("tracing.metrics_aggregation_s", "60");
                }
                // REQ-7: Set logging defaults if not already configured.
                if store_ref.get("tracing.logging_enabled").ok().flatten().is_none() {
                    let _ = store_ref.set("tracing.logging_enabled", "true");
                }
                if store_ref.get("tracing.logging_level").ok().flatten().is_none() {
                    let _ = store_ref.set("tracing.logging_level", "INFO");
                }
            }

            // REQ-9: Run retention cleanup on startup.
            let store_ref = app.state::<Arc<AppStore>>();
            let retention_days: i64 = store_ref
                .get("tracing.retention_days")
                .ok()
                .flatten()
                .and_then(|v| v.parse().ok())
                .unwrap_or(7);
            match span_store.delete_expired(retention_days) {
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
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(1));
                loop {
                    interval.tick().await;
                    let collector = flush_handle.state::<Arc<SpanCollector>>();
                    let flushed = collector.flush_if_needed();
                    if flushed > 0 {
                        tracing::info!(target: "fredo::telemetry", flushed, "spans flushed from timer");
                    }
                }
            });

            // REQ-17: Background metrics flush every 1 second.
            let metrics_flush_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(1));
                loop {
                    interval.tick().await;
                    let mc = metrics_flush_handle.state::<Arc<MetricCollector>>();
                    let flushed = mc.flush_if_needed();
                    if flushed > 0 {
                        tracing::info!(target: "fredo::telemetry", flushed, "metrics flushed from timer");
                    }
                }
            });

            // REQ-7: Background log flush every 1 second.
            let log_flush_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(1));
                loop {
                    interval.tick().await;
                    let lc = log_flush_handle.state::<Arc<LogCollector>>();
                    let flushed = lc.flush_if_needed();
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
                    let swept = collector.sweep_orphans();
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

            // REQ-6: 5-second periodic sweep for timed-out contract instances
            let sweep_bus = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(5));
                loop {
                    interval.tick().await;
                    let bus = sweep_bus.state::<EventBus>();
                    let eng = sweep_bus.state::<Arc<ContractEngine>>();
                    let deliveries = eng.req_6_sweep();
                    for delivery in deliveries {
                        bus.emit_delivery(delivery);
                    }
                }
            });

            // -- Spec #2768 (ST-3): contract-event persistence writer task -----
            // Drains the bounded enqueue queue in ~100 ms batches and prunes
            // contract_events on a 60-minute interval (knobs re-read each cycle).
            let writer_task_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                run_writer_task(writer_task_handle, contract_event_rx).await;
            });

            // -- RTDB row store (Spec #2788 P1.2) ------------------------------
            // SQLite-authoritative typed rows (chat_rows / tool_use_rows /
            // agent_session_rows in fredo.db) behind an LRU row cache with a
            // ~30 ms write-behind flush task. telemetry_spans is never touched.
            let rtdb_store = Arc::new(
                RtdbStore::open(data_dir.clone()).expect("Failed to open RtdbStore"),
            );
            rtdb_store
                .ensure_schema()
                .expect("Failed to create rtdb schema");
            let (rtdb_cache, rtdb_rx) = RtdbCache::new(rtdb_store);
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
            // maps (ported from the v1 adapter + ECE relationship registry)
            // and classifies spans/events into row upserts. ADDITIVE parallel
            // run — the v1 path is untouched; the OTLP receivers + IPC
            // dispatcher consume this state.
            let classifier = IngestClassifierState::new(IngestClassifier::new(Arc::clone(&rtdb)));
            app.manage(rtdb);
            app.manage(classifier);

            // Flush task: polls due coalescing windows (~5 ms cadence).
            let rtdb_flush_task = Arc::clone(&rtdb_flush);
            tauri::async_runtime::spawn(async move {
                run_flush_task(rtdb_flush_task).await;
            });

            // Set RTDB retention defaults if not already configured (AppStore
            // KV keys — the binding config-first mechanism).
            {
                let store_ref = app.state::<Arc<AppStore>>();
                if store_ref.get(RTDB_RETENTION_DAYS_KEY).ok().flatten().is_none() {
                    let _ = store_ref
                        .set(RTDB_RETENTION_DAYS_KEY, &RTDB_DEFAULT_RETENTION_DAYS.to_string());
                }
                if store_ref.get(RTDB_MAX_ROWS_KEY).ok().flatten().is_none() {
                    let _ = store_ref.set(RTDB_MAX_ROWS_KEY, &RTDB_DEFAULT_MAX_ROWS.to_string());
                }
            }

            // Retention prune on startup (mirrors the SpanStore/contract flow;
            // the writer task re-prunes on a 60-minute interval). P2.3: the
            // evicted keys route `kind: remove` deliveries through Rtdb.
            prune_with_knobs(app.handle());

            // RTDB write-behind task: drains the bounded queue in ~30 ms
            // batches; overflow sheds the storage write, never in-memory state.
            let rtdb_writer_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                run_rtdb_writer_task(rtdb_writer_handle, rtdb_rx).await;
            });

            // RTDB canonical backfill (Spec #2788 P3.2, REQs R-2b/R-4c):
            // re-derives canonical rows for PRE-CUTOVER history from
            // telemetry_spans (strictly READ-ONLY) through the SAME ingest
            // classifier — one shared extract-rule implementation keeps
            // re-derivation byte-comparable with live derivation (NFR-6).
            // Spawned: never blocks startup. Idempotent: content-identical
            // re-merges skip the write (no seq inflation); a one-shot
            // completion marker keeps later startups O(1).
            let backfill_handle = app.handle().clone();
            let backfill_dir = data_dir.clone();
            tauri::async_runtime::spawn(async move {
                infrastructure::rtdb::backfill::run_startup_backfill(&backfill_handle, &backfill_dir);
            });

            // -- IPC server (OpenCode plugin event path) -----------------------------
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = infrastructure::ipc::start_ipc_server(handle).await {
                    tracing::error!(target: "fredo::ipc", error = %e, "IPC server error");
                }
            });

            // -- OTLP receiver (gRPC :4317 + HTTP :4318) -----------------------
            infrastructure::otlp::start(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // REQ-1: Event Contract Engine IPC commands
            infrastructure::comm::contract::commands::register_event_contracts,
            infrastructure::comm::contract::commands::deregister_event_contracts,
            // Spec #2768 (ST-4): per-contract event hydration (PULL-only)
            infrastructure::comm::contract::commands::contract_events_hydrate,
            // RTDB (Spec #2788 P2.3)
            infrastructure::rtdb::commands::subscribe_events,
            infrastructure::rtdb::commands::unsubscribe_events,
            // Features
            features::settings::commands::save_setting,
            features::settings::commands::get_setting,
            features::terminal::commands::open_run_cli,
            features::terminal::commands::get_run_cli_status,
            features::terminal::commands::get_pty_buffer,
            features::terminal::commands::write_pty_input,
            features::terminal::commands::resize_pty,
            features::terminal::commands::close_run_cli,
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
            features::llm::commands::llm_chat,
            features::llm::commands::llm_chat_with_image,
            features::screenshot::commands::capture_screen_region,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Fredo application");
}
