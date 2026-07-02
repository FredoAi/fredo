mod features;
pub mod infrastructure;
mod runtime;
mod utils;

use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use features::llm::state::{LlmLoadingState, LlmState};
use features::terminal::state::RunCliState;
use infrastructure::comm::adapters::opencode::OpenCodeAdapter;
use infrastructure::comm::bus::EventBus;
use infrastructure::comm::contract::engine::ContractEngine;
use infrastructure::comm::contract::EventContractEngine;
use infrastructure::storage::feature_store::{self, FeatureStore};
use infrastructure::storage::span_store::SpanStore;
use infrastructure::storage::AppStore;
use infrastructure::contract_407::{MetricCollector, SpanStoreMetricsExt};
use infrastructure::telemetry::SpanCollector;
use runtime::AppRuntime;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _runtime = AppRuntime::new();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init());

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());

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
                    eprintln!("[fredo/llm] found model in models_dir: {}", candidate.display());
                    return Some(candidate);
                }
                // 2. Resource dir (legacy — may contain stale copies from pre-Spec#108 builds)
                if let Ok(rd) = app.path().resource_dir() {
                    let fb = rd.join("models").join(subdir).join(filename);
                    if fb.exists() {
                        eprintln!("[fredo/llm] found model in resource_dir: {}", fb.display());
                        return Some(fb);
                    }
                }
                // 3. CARGO_MANIFEST_DIR fallback (source-tree development)
                let fb = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("models").join(subdir).join(filename);
                if fb.exists() {
                    eprintln!("[fredo/llm] found model in source tree: {}", fb.display());
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
            eprintln!("[fredo/llm] selected model: {selected_model}");
            eprintln!("[fredo/llm] model_path:  {:?}", model_path);
            eprintln!("[fredo/llm] mmproj_path: {:?}", mmproj_path);

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
                            eprintln!("[fredo/llm] in-process engine ready");
                        }
                        Ok(Err(e)) => eprintln!("[fredo/llm] engine load failed: {e:#}"),
                        Err(e) => eprintln!("[fredo/llm] task panicked: {e:#}"),
                    }

                    handle.state::<LlmLoadingState>().0.store(false, Ordering::SeqCst);
                });
            } else {
                eprintln!("[fredo/llm] model not found - LLM features disabled.");
            }

            // -- Terminal state ------------------------------------------------
            app.manage(Mutex::new(RunCliState::new()));

            // -- EventBus (SubscriptionDelivery emitter for "fredo-stream-event") --
            app.manage(EventBus::new(app.handle().clone()));

            // -- Event Contract Engine (Spec #303) ----------------------------
            let engine = ContractEngine::new();
            app.manage(engine.clone());

            // -- OpenCodeAdapter (shared singleton for Hook+OTLP correlation) --
            // Spec #382: The adapter MUST be a shared singleton so its internal
            // session_to_correlation and trace_to_session maps persist across
            // all events (IPC Hook, OTLP gRPC, OTLP HTTP). Creating a new
            // adapter per event defeats correlationId bridging → duplicate nodes.
            let opencode_adapter = Arc::new(OpenCodeAdapter::new());
            app.manage(opencode_adapter);

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
                        eprintln!("[telemetry] retention cleanup: deleted {deleted} spans");
                    }
                }
                Err(e) => eprintln!("[telemetry] retention cleanup error: {e}"),
            }

            // Create MetricCollector and register as Tauri state.
            let metric_collector = Arc::new(MetricCollector::new(
                span_store.clone(),
                Arc::clone(&*app.state::<Arc<AppStore>>()),
            ));
            app.manage(metric_collector.clone());

            // Create SpanCollector and register as Tauri state.
            let collector = Arc::new(SpanCollector::new(span_store, Arc::clone(&*app.state::<Arc<AppStore>>())));
            app.manage(collector.clone());

            // REQ-6: Background flush every 1 second (5-second idle timeout).
            let flush_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(1));
                loop {
                    interval.tick().await;
                    let collector = flush_handle.state::<Arc<SpanCollector>>();
                    let flushed = collector.flush_if_needed();
                    if flushed > 0 {
                        eprintln!("[telemetry] flushed {flushed} spans from timer");
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
                        eprintln!("[metrics] flushed {flushed} points from timer");
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
                        eprintln!("[telemetry] orphan sweep: closed {swept} timed-out spans");
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

            // -- IPC server (OpenCode plugin event path) -----------------------------
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = infrastructure::ipc::start_ipc_server(handle).await {
                    eprintln!("[fredo] IPC server error: {e}");
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
            // Features
            features::settings::commands::save_setting,
            features::settings::commands::get_setting,
            features::terminal::commands::open_run_cli,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Fredo application");
}