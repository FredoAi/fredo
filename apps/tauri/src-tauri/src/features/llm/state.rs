use std::sync::{Arc, Mutex};
use std::sync::atomic::AtomicBool;

use crate::features::llm::service::LlmService;

/// Tauri managed state wrapping the LLM service.
/// `Option` so the app starts even while the model is still loading.
pub struct LlmState(pub Mutex<Option<LlmService>>);

/// Tracks whether the model is still being loaded.
pub struct LlmLoadingState(pub Arc<AtomicBool>);

