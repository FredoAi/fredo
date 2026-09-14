// SPIKE #2876 — THROWAWAY POC — replaced by #2877/#2878
//!
//! Streaming engine wrapper around `sherpa_onnx::OnlineRecognizer`.
//!
//! [`Recognizer`] is the seam ST-6 injects a fake through (no model, no mic,
//! CI-green); [`SherpaRecognizer`] is the real int8 Zipformer transducer.
//! API verified live by ST-0 (docs.rs sherpa-onnx 1.13.8 + the official
//! `rust-api-examples/examples/streaming_zipformer_microphone.rs`).

use std::path::Path;

use sherpa_onnx::{
    OnlineModelConfig, OnlineRecognizer, OnlineRecognizerConfig, OnlineStream,
    OnlineTransducerModelConfig,
};

use crate::infrastructure::companion::models::file_path;

use super::manifest::resolve_stt_manifest;
use super::state::{SttErrorCode, VoiceError};

/// The rate the pinned Zipformer model expects; capture resamples to this.
pub const ENGINE_SAMPLE_RATE: i32 = 16_000;

/// Audio chunk handed to the recognizer: 3200 f32 samples (~200 ms at 16 kHz),
/// matching the official microphone example's default `chunk_size`.
pub const CAPTURE_CHUNK_SAMPLES: usize = 3200;

/// Object-safe seam over a streaming recognizer so ST-6 can drive the session
/// loop with a deterministic fake (no model, no mic, no network).
pub trait Recognizer: Send {
    /// Append one chunk of 16 kHz mono f32 audio.
    fn accept_waveform(&mut self, samples: &[f32]);
    /// True when enough audio accumulated to run another decode step.
    fn is_ready(&self) -> bool;
    /// Decode one step.
    fn decode(&mut self);
    /// Current cumulative hypothesis for the active segment (non-empty only).
    fn result_text(&self) -> Option<String>;
    /// True when endpointing rules say the utterance ended.
    fn is_endpoint(&self) -> bool;
    /// Reset after an endpoint / segment boundary.
    fn reset(&mut self);
    /// Mark end of input so trailing context is flushed.
    fn input_finished(&mut self);
}

/// The real `OnlineRecognizer` + its single `OnlineStream`.
pub struct SherpaRecognizer {
    recognizer: OnlineRecognizer,
    stream: OnlineStream,
}

impl Recognizer for SherpaRecognizer {
    fn accept_waveform(&mut self, samples: &[f32]) {
        self.stream.accept_waveform(ENGINE_SAMPLE_RATE, samples);
    }

    fn is_ready(&self) -> bool {
        self.recognizer.is_ready(&self.stream)
    }

    fn decode(&mut self) {
        self.recognizer.decode(&self.stream);
    }

    fn result_text(&self) -> Option<String> {
        self.recognizer
            .get_result(&self.stream)
            .map(|result| result.text)
            .filter(|text| !text.is_empty())
    }

    fn is_endpoint(&self) -> bool {
        self.recognizer.is_endpoint(&self.stream)
    }

    fn reset(&mut self) {
        self.recognizer.reset(&self.stream);
    }

    fn input_finished(&mut self) {
        self.stream.input_finished();
    }
}

/// Build the pinned `OnlineRecognizerConfig` from the ST-2 manifest, resolving
/// every model path through the shared `<models_dir>/<STT_SUBDIR>/<path>` rule.
fn recognizer_config(models_dir: &Path) -> OnlineRecognizerConfig {
    let manifest = resolve_stt_manifest();
    let path_for = |id: &str| -> Option<String> {
        manifest
            .files
            .iter()
            .find(|spec| spec.id == id)
            .map(|spec| {
                file_path(models_dir, &manifest, spec)
                    .to_string_lossy()
                    .into_owned()
            })
    };

    OnlineRecognizerConfig {
        model_config: OnlineModelConfig {
            transducer: OnlineTransducerModelConfig {
                encoder: path_for("sttEncoder"),
                decoder: path_for("sttDecoder"),
                joiner: path_for("sttJoiner"),
            },
            tokens: path_for("sttTokens"),
            provider: Some("cpu".to_string()),
            num_threads: 2,
            ..Default::default()
        },
        decoding_method: Some("greedy_search".to_string()),
        enable_endpoint: true,
        // ST-0 verified these field names on OnlineRecognizerConfig.
        rule1_min_trailing_silence: 2.0,
        rule2_min_trailing_silence: 1.2,
        rule3_min_utterance_length: 20.0,
        ..Default::default()
    }
}

/// Lazily load the engine. `OnlineRecognizer::create` returning `None` is the
/// typed `engineStartFailed` failure (R-5.5) — never a panic.
pub fn load_recognizer(models_dir: &Path) -> Result<Box<dyn Recognizer>, VoiceError> {
    let config = recognizer_config(models_dir);
    let recognizer = OnlineRecognizer::create(&config).ok_or_else(|| {
        VoiceError::new(
            SttErrorCode::EngineStartFailed,
            format!(
                "OnlineRecognizer::create returned None for {}",
                models_dir.display()
            ),
        )
    })?;
    let stream = recognizer.create_stream();
    Ok(Box::new(SherpaRecognizer { recognizer, stream }))
}
