use std::sync::atomic::Ordering;
use tauri::{AppHandle, State};

use crate::features::llm::service::LlmMessage;
use crate::features::llm::state::{LlmState, LlmLoadingState};

/// Kick off a streaming LLM chat.
///
/// The frontend sends `messages` (system + user turns); this command starts
/// inference on a background task and returns immediately. Decoded tokens
/// are delivered to the webview as `"llm-token"` events; a final `"llm-done"`
/// event signals completion.
#[tauri::command]
pub fn llm_chat(
    messages: Vec<LlmMessage>,
    state: State<LlmState>,
    loading: State<LlmLoadingState>,
    app: AppHandle,
) -> Result<(), String> {
    tracing::info!(target: "fredo::llm", message_count = messages.len(), "llm_chat received");
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    tracing::info!(target: "fredo::llm", loaded = guard.is_some(), "model loaded status");
    match guard.as_ref() {
        Some(svc) => {
            tracing::info!(target: "fredo::llm", "dispatching chat_async");
            svc.chat_async(messages, app);
            Ok(())
        }
        None => {
            if loading.0.load(Ordering::SeqCst) {
                Err("Model is still loading, please wait a moment...".into())
            } else {
                Err("LLM model not loaded. Place a UQFF model in the models/ directory.".into())
            }
        }
    }
}

/// Kick off a streaming LLM vision chat with a base64-encoded PNG screenshot.
///
/// Decodes the image from `image_base64`, then streams the model response as
/// `"llm-token"` events followed by `"llm-done"`.
#[tauri::command]
pub fn llm_chat_with_image(
    messages: Vec<LlmMessage>,
    image_base64: String,
    state: State<LlmState>,
    loading: State<LlmLoadingState>,
    app: AppHandle,
) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let image_bytes = STANDARD.decode(&image_base64).map_err(|e| e.to_string())?;

    let guard = state.0.lock().map_err(|e| e.to_string())?;
    match guard.as_ref() {
        Some(svc) => {
            svc.chat_with_image_async(messages, image_bytes, app);
            Ok(())
        }
        None => {
            if loading.0.load(Ordering::SeqCst) {
                Err("Model is still loading, please wait a moment...".into())
            } else {
                Err("LLM model not loaded. Place a UQFF model in the models/ directory.".into())
            }
        }
    }
}
