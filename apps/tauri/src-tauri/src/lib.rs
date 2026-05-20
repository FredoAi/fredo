mod features;
pub mod infrastructure;
mod runtime;
mod utils;

use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use features::llm::state::{LlmLoadingState, LlmState};
use features::terminal::state::RunCliState;
use infrastructure::storage::AppStore;
use runtime::AppRuntime;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _runtime = AppRuntime::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // -- SQLite settings store -----------------------------------------
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to resolve app data dir");
            let store = AppStore::open(data_dir.clone()).expect("Failed to open settings store");
            app.manage(Arc::new(store));

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

            let resolve_path = |subdir: &str, filename: &str| -> Option<std::path::PathBuf> {
                app.path()
                    .resource_dir()
                    .ok()
                    .map(|d| d.join("models").join(subdir).join(filename))
                    .filter(|p| p.exists())
                    .or_else(|| {
                        let fb = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                            .join("models").join(subdir).join(filename);
                        if fb.exists() { Some(fb) } else { None }
                    })
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

            // -- IPC server (legacy hook path) ---------------------------------
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
            features::llm::commands::llm_chat,
            features::llm::commands::llm_chat_with_image,
            features::screenshot::commands::capture_screen_region,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Fredo application");
}