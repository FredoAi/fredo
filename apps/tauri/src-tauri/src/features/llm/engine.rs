//! In-process LLM inference engine backed by llama.cpp (via llama-cpp-2).
//!
//! Loads a GGUF model from disk and runs token generation entirely in the
//! calling process — no child processes, no HTTP/SSE round-trips.
//! Vision (multimodal) is supported when a mmproj file is provided at load
//! time via `load_with_vision`.

use std::num::NonZeroU32;
use std::path::Path;

use anyhow::{Context, Result};
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaChatMessage, LlamaModel};
use llama_cpp_2::mtmd::{
    mtmd_default_marker, MtmdBitmap, MtmdContext, MtmdContextParams, MtmdInputText,
};
use llama_cpp_2::sampling::LlamaSampler;

use crate::features::llm::service::LlmMessage;

const DEFAULT_CTX: u32 = 4096;
const N_BATCH: usize = 512;

/// In-process GGUF inference engine with optional vision support.
///
/// Field declaration order matters for Drop: Rust drops fields in declaration
/// order, so `mtmd_ctx` (which holds a C pointer into the model) is declared
/// before `model` and therefore dropped before `model`.
pub struct LlmEngine {
    backend: LlamaBackend,
    /// Vision projector context — present when loaded with `load_with_vision`.
    mtmd_ctx: Option<MtmdContext>,
    /// The language model. Must be declared AFTER `mtmd_ctx` so it outlives it.
    model: LlamaModel,
}

unsafe impl Send for LlmEngine {}
unsafe impl Sync for LlmEngine {}

impl LlmEngine {
    /// Load a GGUF model from `model_path` (text-only, no vision).
    pub fn load(model_path: &Path) -> Result<Self> {
        let backend = LlamaBackend::init().context("Failed to init llama backend")?;
        let model =
            LlamaModel::load_from_file(&backend, model_path, &LlamaModelParams::default())
                .context("Failed to load GGUF model")?;
        eprintln!("[fredo/llm] model loaded (text-only): {:?}", model_path);
        Ok(Self { backend, mtmd_ctx: None, model })
    }

    /// Load a GGUF model **with** a multimodal projector for vision support.
    pub fn load_with_vision(model_path: &Path, mmproj_path: &Path) -> Result<Self> {
        let backend = LlamaBackend::init().context("Failed to init llama backend")?;
        let model =
            LlamaModel::load_from_file(&backend, model_path, &LlamaModelParams::default())
                .context("Failed to load GGUF model")?;

        let mmproj_str = mmproj_path
            .to_str()
            .context("mmproj path is not valid UTF-8")?;

        let n_threads = std::thread::available_parallelism()
            .map(|n| (n.get() / 2).max(1) as i32)
            .unwrap_or(4);

        let params = MtmdContextParams {
            use_gpu: false,
            print_timings: false,
            n_threads,
            media_marker: std::ffi::CString::new(mtmd_default_marker()).unwrap(),
        };

        // Windows debug builds hit MSVC CRT assertions when llama.cpp's C
        // internals open the mmproj file via _osfile().  Skip vision in debug
        // to avoid the crash; release builds get full multimodal support.
        #[cfg(debug_assertions)]
        let mtmd_ctx = {
            eprintln!("[fredo/llm] skipping mmproj in debug build (Windows CRT assertion)");
            None
        };

        #[cfg(not(debug_assertions))]
        let mtmd_ctx = match MtmdContext::init_from_file(mmproj_str, &model, &params) {
            Ok(ctx) => {
                eprintln!(
                    "[fredo/llm] mmproj loaded: {:?} | vision={}",
                    mmproj_path,
                    ctx.support_vision()
                );
                Some(ctx)
            }
            Err(e) => {
                eprintln!("[fredo/llm] mmproj load failed ({e}) — running text-only");
                None
            }
        };

        eprintln!("[fredo/llm] model loaded: {:?}", model_path);
        Ok(Self { backend, mtmd_ctx, model })
    }

    /// Whether this engine has a loaded vision projector.
    #[allow(dead_code)]
    pub fn has_vision(&self) -> bool {
        self.mtmd_ctx
            .as_ref()
            .map(|c| c.support_vision())
            .unwrap_or(false)
    }

    /// Generate a response for `messages` together with an image.
    /// Falls back to text-only if the engine was loaded without a mmproj.
    pub fn generate_with_image(
        &mut self,
        messages: &[LlmMessage],
        image_bytes: &[u8],
        max_tokens: usize,
        mut on_token: impl FnMut(String),
    ) -> Result<()> {
        let Some(mtmd_ctx) = self.mtmd_ctx.as_ref() else {
            eprintln!("[fredo/llm] no mmproj loaded — falling back to text-only");
            return self.generate(messages, max_tokens, on_token);
        };

        let bitmap = {
            // Decode the PNG/JPEG ourselves using the `image` crate and pass
            // clean RGB bytes via from_image_data.  This avoids calling
            // stb_image through from_buffer, which mishandles RGBA PNGs
            // (4-channel) and can corrupt the stack (STATUS_STACK_BUFFER_OVERRUN).
            use image::GenericImageView;
            let img = image::load_from_memory(image_bytes)
                .context("Failed to decode image for vision")?;
            // Resize to at most 448×448 — large images slow down the clip encoder
            // and can exceed stack limits in the SIMD projection code.
            let img = img.thumbnail(448, 448);
            let (nx, ny) = img.dimensions();
            let rgb = img.to_rgb8();
            MtmdBitmap::from_image_data(nx, ny, &rgb)
                .context("Failed to create MtmdBitmap from RGB data")?
        };

        let prompt = self.format_vision_prompt(messages)?;

        let input = MtmdInputText {
            text: prompt,
            add_special: true,
            parse_special: true,
        };
        let chunks = mtmd_ctx
            .tokenize(input, &[&bitmap])
            .context("Failed to tokenize multimodal input")?;

        let n_tokens = chunks.total_tokens();
        let ctx_size = NonZeroU32::new(
            ((n_tokens + max_tokens + 512) as u32).max(DEFAULT_CTX),
        )
        .unwrap();

        let n_threads = std::thread::available_parallelism()
            .map(|n| (n.get() / 2).max(1) as i32)
            .unwrap_or(4);

        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(Some(ctx_size))
            .with_n_threads(n_threads)
            .with_n_threads_batch(n_threads);

        let mut ctx = self
            .model
            .new_context(&self.backend, ctx_params)
            .context("Failed to create llama context for vision")?;

        let n_past = chunks
            .eval_chunks(mtmd_ctx, &ctx, 0, 0, N_BATCH as i32, true)
            .context("Failed to eval multimodal chunks")?;

        let mut n_cur = n_past;
        let max_pos = n_past + (max_tokens as i32);
        let mut decoder = encoding_rs::UTF_8.new_decoder();
        let mut sampler = LlamaSampler::chain_simple([
            LlamaSampler::dist(42),
            LlamaSampler::greedy(),
        ]);
        let mut batch = LlamaBatch::new(1, 1);

        // After eval_chunks the last sub-batch has N tokens with only the LAST
        // one having logit=true.  llama.cpp's get_logits_ith interprets a
        // negative idx as (n_outputs + idx), so -1 = last output — exactly the
        // one eval_chunks produced.  For subsequent 1-token decode batches the
        // single token is always at position 0 (logit=true), so idx=0 is used.
        let mut first_sample = true;

        loop {
            let sample_idx = if first_sample { first_sample = false; -1 } else { 0 };
            let token = sampler.sample(&ctx, sample_idx);
            sampler.accept(token);

            if self.model.is_eog_token(token) || n_cur >= max_pos {
                break;
            }

            if let Ok(piece) = self.model.token_to_piece(token, &mut decoder, true, None) {
                if piece.contains("<end_of_turn>") || piece.contains("<start_of_turn>") {
                    break;
                }
                if !piece.is_empty() {
                    on_token(piece);
                }
            }

            batch.clear();
            batch
                .add(token, n_cur, &[0], true)
                .context("batch.add failed during vision generation")?;
            n_cur += 1;
            ctx.decode(&mut batch)
                .context("decode failed during vision generation")?;
        }

        Ok(())
    }

    /// Generate a response for `messages`, calling `on_token` for each output
    /// token string as it is produced.
    pub fn generate(
        &mut self,
        messages: &[LlmMessage],
        max_tokens: usize,
        mut on_token: impl FnMut(String),
    ) -> Result<()> {
        let prompt = self.format_prompt(messages)?;

        let tokens = self
            .model
            .str_to_token(&prompt, AddBos::Always)
            .context("tokenization failed")?;

        if tokens.is_empty() {
            return Ok(());
        }

        let ctx_size = NonZeroU32::new(
            ((tokens.len() + max_tokens + 512) as u32).max(DEFAULT_CTX),
        )
        .unwrap();

        let n_threads = std::thread::available_parallelism()
            .map(|n| (n.get() / 2).max(1) as i32)
            .unwrap_or(4);

        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(Some(ctx_size))
            .with_n_threads(n_threads)
            .with_n_threads_batch(n_threads);

        let mut ctx = self
            .model
            .new_context(&self.backend, ctx_params)
            .context("failed to create llama context")?;

        // Feed all prompt tokens as a single batch.
        let mut batch = LlamaBatch::new(N_BATCH.max(tokens.len()), 1);
        let last_prompt_idx = (tokens.len() as i32) - 1;
        for (i, &token) in tokens.iter().enumerate() {
            batch
                .add(token, i as i32, &[0], i as i32 == last_prompt_idx)
                .context("batch.add failed")?;
        }
        ctx.decode(&mut batch).context("prompt decode failed")?;

        // Autoregressive generation loop.
        let mut n_cur = batch.n_tokens();
        let mut decoder = encoding_rs::UTF_8.new_decoder();
        let mut sampler = LlamaSampler::chain_simple([
            LlamaSampler::dist(42),
            LlamaSampler::greedy(),
        ]);

        let max_pos = (tokens.len() as i32) + (max_tokens as i32);

        while n_cur < max_pos {
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            sampler.accept(token);

            if self.model.is_eog_token(token) {
                break;
            }

            if let Ok(piece) = self.model.token_to_piece(token, &mut decoder, true, None) {
                if piece.contains("<end_of_turn>") || piece.contains("<start_of_turn>") {
                    break;
                }
                if !piece.is_empty() {
                    on_token(piece);
                }
            }

            batch.clear();
            batch
                .add(token, n_cur, &[0], true)
                .context("batch.add failed during generation")?;
            n_cur += 1;
            ctx.decode(&mut batch).context("generation decode failed")?;
        }

        Ok(())
    }

    /// Format messages using the model's embedded chat template, falling back
    /// to a hand-written Gemma4 template if the model has none.
    fn format_prompt(&self, messages: &[LlmMessage]) -> Result<String> {
        let chat_msgs: Vec<LlamaChatMessage> = messages
            .iter()
            .filter_map(|m| {
                let role = match m.role.as_str() {
                    "user" | "assistant" | "system" => m.role.as_str(),
                    _ => return None,
                };
                LlamaChatMessage::new(role.to_string(), m.content.clone()).ok()
            })
            .collect();

        if let Ok(tmpl) = self.model.chat_template(None) {
            if let Ok(prompt) = self.model.apply_chat_template(&tmpl, &chat_msgs, true) {
                return Ok(prompt);
            }
        }

        // Fallback: Gemma-style formatting.
        Ok(format_gemma_prompt(messages))
    }

    /// Format messages for vision: injects the `<__media__>` marker at the
    /// start of the last user message so the image is placed there.
    fn format_vision_prompt(&self, messages: &[LlmMessage]) -> Result<String> {
        let marker = mtmd_default_marker();
        let mut modified = messages.to_vec();
        if let Some(last_user) = modified.iter_mut().rev().find(|m| m.role == "user") {
            last_user.content = format!("{}\n{}", marker, last_user.content);
        }
        self.format_prompt(&modified)
    }
}

fn format_gemma_prompt(messages: &[LlmMessage]) -> String {
    let mut prompt = String::new();
    for msg in messages {
        match msg.role.as_str() {
            "user" | "system" => {
                prompt.push_str("<start_of_turn>user\n");
                prompt.push_str(&msg.content);
                prompt.push_str("<end_of_turn>\n");
            }
            "assistant" => {
                prompt.push_str("<start_of_turn>model\n");
                prompt.push_str(&msg.content);
                prompt.push_str("<end_of_turn>\n");
            }
            _ => {}
        }
    }
    prompt.push_str("<start_of_turn>model\n");
    prompt
}
