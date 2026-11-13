//! Incremental UTF-8 detokenisation at the token boundary (Spec #3141, ST-2).
//!
//! ## Why this exists
//!
//! The retired HTTP path received *already-decoded* text from `llama-server`, so
//! a multi-byte character could never be torn — the server's own detokeniser had
//! buffered the partial bytes. In-process the engine converts tokens to bytes
//! itself, and a single token can carry a PARTIAL UTF-8 sequence (llama.cpp's
//! byte-fallback tokens). Emitting those bytes as text would tear a character
//! across two `llm-token` events and corrupt the reply.
//!
//! [`TokenStreamDecoder`] wraps the crate's [`StreamDetokenizer`], which is the
//! canonical incremental decoder: it buffers trailing incomplete UTF-8 bytes and
//! releases them once the sequence completes. A caller therefore receives only
//! well-formed strings — the `drain_complete_lines` guarantee of the retired path
//! (`chat.rs:641-653`) reproduced at the token boundary.
//!
//! ## Control tokens
//!
//! The template declares reserved/control tokens (`<|"|>`, `<|turn>`, …). Those
//! are NOT user-visible text: [`TokenStreamDecoder`] drops a token whose id is in
//! the reserved set BEFORE it reaches the detokeniser, on top of the
//! `Special::Plaintext` render (which already strips llama.cpp's special tokens).

use llama_cpp_4::model::{LlamaModel, Special};
use llama_cpp_4::token::detokenizer::StreamDetokenizer;
use llama_cpp_4::token::LlamaToken;

/// The incremental token→text decoder for one generation.
pub struct TokenStreamDecoder<'m> {
    inner: StreamDetokenizer<'m>,
    reserved: Vec<i32>,
}

impl<'m> TokenStreamDecoder<'m> {
    /// Build a decoder for `model`, dropping the `reserved` control-token ids.
    pub fn new(model: &'m LlamaModel, reserved: &[i32]) -> Self {
        Self {
            inner: StreamDetokenizer::new(model, Special::Plaintext),
            reserved: reserved.to_vec(),
        }
    }

    /// Whether `token` is a reserved control token (never user-visible text).
    pub fn is_reserved(&self, token: LlamaToken) -> bool {
        self.reserved.contains(&token.0)
    }

    /// Feed one sampled token.
    ///
    /// Returns the newly completed text — possibly EMPTY when the token only
    /// advanced an incomplete UTF-8 sequence, which is the whole point: an empty
    /// result means "hold", not "nothing happened".
    pub fn push(&mut self, token: LlamaToken) -> Result<String, String> {
        if self.is_reserved(token) {
            return Ok(String::new());
        }
        self.inner.push(token).map_err(|error| error.to_string())
    }

    /// Flush any text the decoder still holds.
    ///
    /// Called ONCE at the end of a generation — it consumes the decoder, so a
    /// flushed stream can never be pushed to again. Trailing incomplete bytes
    /// become U+FFFD rather than being dropped silently: a truncated reply must
    /// still be visible, and the caller learns it ended mid-character.
    pub fn finish(self) -> Result<String, String> {
        self.inner.finish().map_err(|error| error.to_string())
    }

    /// The bytes still buffered as an incomplete UTF-8 prefix (empty when the
    /// stream ended on a character boundary).
    ///
    /// Read by the truncation-aware caller: a generation that stops mid-character
    /// leaves a non-empty prefix, which is the difference between "the reply ended"
    /// and "the reply was cut". Test-only because the production loop only needs
    /// the released text, and a second read path would be a second truth.
    #[cfg(test)]
    pub fn pending_bytes(&self) -> &[u8] {
        self.inner.pending()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::llm_server::engine::paths;
    use crate::infrastructure::companion::models::default_manifest;

    fn models_dir() -> std::path::PathBuf {
        match std::env::var("FREDO_COMPANION_MODELS_DIR") {
            Ok(dir) if !dir.trim().is_empty() => std::path::PathBuf::from(dir.trim()),
            _ => std::path::PathBuf::from(
                std::env::var("USERPROFILE")
                    .or_else(|_| std::env::var("HOME"))
                    .unwrap_or_else(|_| ".".to_string()),
            )
            .join("fredo-models"),
        }
    }

    fn load_model_or_skip() -> Option<(llama_cpp_4::llama_backend::LlamaBackend, LlamaModel)> {
        let manifest = default_manifest();
        let engine_paths = match paths::resolve_for_app(&models_dir(), &manifest) {
            Ok(paths) => paths,
            Err((code, detail)) => {
                eprintln!(
                    "ST-2 DETOKENISER GATE SKIPPED (named blocker: {code:?}) — {detail}. \
                     Provide the pinned GGUF files under {} (set FREDO_COMPANION_MODELS_DIR) \
                     to run this gate. Nothing was asserted on this path.",
                    models_dir().display()
                );
                return None;
            }
        };
        let backend = llama_cpp_4::llama_backend::LlamaBackend::init().ok()?;
        match paths::load_model(&backend, &engine_paths.model, &paths::model_params(0)) {
            Ok(model) => Some((backend, model)),
            Err((code, detail)) => {
                eprintln!("ST-2 DETOKENISER GATE SKIPPED (named blocker: {code:?}) — {detail}");
                None
            }
        }
    }

    /// REQUIRED (ST-2 work item): no multi-byte character is ever torn at a token
    /// boundary.
    ///
    /// The test picks text with multi-byte characters, feeds it ONE TOKEN AT A
    /// TIME, and concatenates what the decoder releases. Every intermediate
    /// release must be well-formed UTF-8 (guaranteed by `String`), and the
    /// concatenation must equal the original text — which can only hold if the
    /// decoder buffered the partial sequences instead of emitting `U+FFFD`.
    #[test]
    fn a_multibyte_character_is_never_torn_across_a_token_boundary() {
        let Some((_backend, model)) = load_model_or_skip() else {
            return;
        };
        // A mix of 2-, 3-, and 4-byte characters plus ASCII.
        let text = "héllo → wörld 日本語 🎉 done";
        let tokens = model
            .str_to_token(text, llama_cpp_4::model::AddBos::Never)
            .expect("the text tokenises");
        assert!(
            tokens.len() > 1,
            "the text must span several tokens so the boundary is exercised"
        );

        let mut decoder = TokenStreamDecoder::new(&model, &[]);
        let mut released = String::new();
        let mut chunks: Vec<String> = Vec::new();
        for token in &tokens {
            let piece = decoder.push(*token).expect("push");
            // Every release is a valid `String` by construction; the assertion
            // that matters is that NO piece contains a replacement char, which is
            // what a torn sequence would produce.
            assert!(
                !piece.contains('\u{FFFD}'),
                "a torn character must never be released: {piece:?}"
            );
            chunks.push(piece.clone());
            released.push_str(&piece);
        }
        released.push_str(&decoder.finish().expect("finish"));

        assert_eq!(released, text, "the decoded text must round-trip exactly");
        // Non-vacuity: the decoder really did release the text incrementally
        // (more than one non-empty piece), so this is not a single-chunk pass.
        assert!(
            chunks.iter().filter(|chunk| !chunk.is_empty()).count() > 1,
            "the decoder must release the text incrementally: {chunks:?}"
        );
    }

    /// CONTROL: feeding the SAME bytes as one whole-string token set produces the
    /// same text — so the incremental path is lossless, not merely non-empty.
    #[test]
    fn the_incremental_path_is_lossless_versus_whole_text() {
        let Some((_backend, model)) = load_model_or_skip() else {
            return;
        };
        let text = "naïve café — ünïcode";
        let tokens = model
            .str_to_token(text, llama_cpp_4::model::AddBos::Never)
            .expect("tokenise");

        // Whole-text baseline through the SAME conversion the decoder uses.
        let whole: String = tokens
            .iter()
            .filter_map(|token| model.token_to_str(*token, Special::Plaintext).ok())
            .collect();

        let mut decoder = TokenStreamDecoder::new(&model, &[]);
        let mut incremental = String::new();
        for token in &tokens {
            incremental.push_str(&decoder.push(*token).expect("push"));
        }
        incremental.push_str(&decoder.finish().expect("finish"));

        assert_eq!(incremental, whole);
        assert_eq!(incremental, text);
    }

    /// A reserved control token is dropped, never rendered as text.
    #[test]
    fn a_reserved_control_token_is_never_rendered() {
        let Some((_backend, model)) = load_model_or_skip() else {
            return;
        };
        // Any id is "reserved" for this pin — the rule is about the set, not the
        // specific token.
        let mut decoder = TokenStreamDecoder::new(&model, &[1, 2, 3]);
        assert!(decoder.is_reserved(LlamaToken(1)));
        assert!(!decoder.is_reserved(LlamaToken(4)));
        assert_eq!(decoder.push(LlamaToken(1)).expect("push"), "");
        assert_eq!(decoder.push(LlamaToken(4)), decoder.push(LlamaToken(4)));
    }

    /// An empty reserved set renders everything (the default).
    #[test]
    fn an_empty_reserved_set_renders_every_token() {
        let Some((_backend, model)) = load_model_or_skip() else {
            return;
        };
        let decoder = TokenStreamDecoder::new(&model, &[]);
        assert!(!decoder.is_reserved(LlamaToken(0)));
        assert!(decoder.pending_bytes().is_empty());
    }
}
