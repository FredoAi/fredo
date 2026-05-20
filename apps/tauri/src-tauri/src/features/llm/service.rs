use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tauri::{AppHandle, Emitter};

use crate::features::llm::engine::LlmEngine;

/// A single message in an LLM conversation.
/// Mirrors the TypeScript `LlmMessage` type on the frontend.
#[derive(Debug, Clone, Deserialize)]
pub struct LlmMessage {
    pub role: String,
    pub content: String,
}

/// LLM service backed by an in-process llama.cpp engine.
pub struct LlmService {
    engine: Arc<Mutex<LlmEngine>>,
}

impl LlmService {
    pub fn new(engine: LlmEngine) -> Self {
        Self {
            engine: Arc::new(Mutex::new(engine)),
        }
    }

    /// Kick off a streaming text chat.
    /// Emits `"llm-token"` per token chunk and `"llm-done"` when finished.
    pub fn chat_async(&self, messages: Vec<LlmMessage>, app: AppHandle) {
        let engine = Arc::clone(&self.engine);
        tauri::async_runtime::spawn(async move {
            Self::run_generate(engine, messages, app).await;
        });
    }

    /// Kick off a streaming vision chat with raw image bytes (PNG/JPEG).
    /// Emits `"llm-token"` per token chunk and `"llm-done"` when finished.
    /// Falls back to text-only if no mmproj is loaded.
    pub fn chat_with_image_async(
        &self,
        messages: Vec<LlmMessage>,
        image_bytes: Vec<u8>,
        app: AppHandle,
    ) {
        let engine = Arc::clone(&self.engine);
        tauri::async_runtime::spawn(async move {
            Self::run_generate_with_image(engine, messages, image_bytes, app).await;
        });
    }

    // ── Core streaming helpers ─────────────────────────────────────────────────

    async fn run_generate(
        engine: Arc<Mutex<LlmEngine>>,
        messages: Vec<LlmMessage>,
        app: AppHandle,
    ) {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

        let handle = tokio::task::spawn_blocking(move || {
            if let Ok(mut guard) = engine.lock() {
                let result = guard.generate(&messages, 1024, |tok| {
                    let _ = tx.send(tok);
                });
                if let Err(e) = result {
                    eprintln!("[fredo/llm] generate error: {e:#}");
                }
            } else {
                eprintln!("[fredo/llm] engine lock poisoned");
            }
        });

        while let Some(token) = rx.recv().await {
            let _ = app.emit("llm-token", token);
        }
        let _ = handle.await;
        let _ = app.emit("llm-done", ());
    }

    async fn run_generate_with_image(
        engine: Arc<Mutex<LlmEngine>>,
        messages: Vec<LlmMessage>,
        image_bytes: Vec<u8>,
        app: AppHandle,
    ) {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

        let handle = tokio::task::spawn_blocking(move || {
            if let Ok(mut guard) = engine.lock() {
                let result = guard.generate_with_image(&messages, &image_bytes, 1024, |tok| {
                    let _ = tx.send(tok);
                });
                if let Err(e) = result {
                    eprintln!("[fredo/llm] vision generate error: {e:#}");
                }
            } else {
                eprintln!("[fredo/llm] engine lock poisoned");
            }
        });

        while let Some(token) = rx.recv().await {
            let _ = app.emit("llm-token", token);
        }
        let _ = handle.await;
        let _ = app.emit("llm-done", ());
    }
}

