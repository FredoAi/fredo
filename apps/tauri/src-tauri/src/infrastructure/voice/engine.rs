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

#[cfg(test)]
mod tests {
    // SPIKE #2876 — THROWAWAY POC — replaced by #2877/#2878
    //!
    //! Deterministic second leg (ST-6b): the REAL engine over a hand-placed
    //! 16 kHz mono WAV, driven through the same recognition loop the live path
    //! uses. The WAV and the models dir are supplied at run time — nothing is
    //! downloaded, no fixture blob is committed, and the leg self-skips when the
    //! env vars are absent, so `cargo test --locked` stays green with no model
    //! and no mic.
    //!
    //! Run it explicitly (PowerShell, from `apps/tauri/src-tauri`):
    //! ```text
    //! $env:FREDO_STT_TEST_MODELS = "<models_dir>"
    //! $env:FREDO_STT_TEST_WAV    = "<16 kHz mono wav>"
    //! cargo test --locked --lib voice::engine::tests::real_engine_wav_fixture_emits_partials_then_final -- --ignored --nocapture
    //! ```
    use super::*;

    use std::path::PathBuf;
    use std::sync::Mutex;

    use crate::infrastructure::voice::capture::AudioMsg;
    use crate::infrastructure::voice::session::{run_recognition, TranscriptSink};
    use crate::infrastructure::voice::state::{SttStateEvent, SttTranscriptEvent};

    /// Env var naming the 16 kHz mono WAV that supplies the deterministic leg.
    const WAV_ENV: &str = "FREDO_STT_TEST_WAV";
    /// Env var naming the models dir holding the pinned STT files.
    const MODELS_ENV: &str = "FREDO_STT_TEST_MODELS";

    #[derive(Default)]
    struct RecordingSink {
        transcripts: Mutex<Vec<SttTranscriptEvent>>,
    }

    impl TranscriptSink for RecordingSink {
        fn transcript(&self, event: SttTranscriptEvent) {
            self.transcripts.lock().expect("sink lock").push(event);
        }

        fn state(&self, _event: SttStateEvent) {}
    }

    /// `<repo>/models` — the in-repo models root, derived from
    /// `CARGO_MANIFEST_DIR` (`apps/tauri/src-tauri`).
    fn default_models_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("models")
    }

    /// Minimal RIFF/WAVE reader: 16-bit PCM or 32-bit float samples. Returns
    /// `(interleaved_samples, channels, sample_rate)`.
    fn read_wav(path: &Path) -> (Vec<f32>, u16, u32) {
        let bytes = std::fs::read(path).expect("read wav");
        assert!(bytes.len() >= 12, "wav too short");
        assert_eq!(&bytes[0..4], &b"RIFF"[..], "not a RIFF file");
        assert_eq!(&bytes[8..12], &b"WAVE"[..], "not a WAVE file");

        let mut audio_format = 0u16;
        let mut channels = 0u16;
        let mut sample_rate = 0u32;
        let mut bits = 0u16;
        let mut samples: Vec<f32> = Vec::new();

        let mut offset = 12usize;
        while offset + 8 <= bytes.len() {
            let id = &bytes[offset..offset + 4];
            let size = u32::from_le_bytes([
                bytes[offset + 4],
                bytes[offset + 5],
                bytes[offset + 6],
                bytes[offset + 7],
            ]) as usize;
            let body = offset + 8;
            if id.starts_with(b"fmt ") {
                assert!(body + 16 <= bytes.len(), "truncated fmt chunk");
                audio_format = u16::from_le_bytes([bytes[body], bytes[body + 1]]);
                channels = u16::from_le_bytes([bytes[body + 2], bytes[body + 3]]);
                sample_rate = u32::from_le_bytes([
                    bytes[body + 4],
                    bytes[body + 5],
                    bytes[body + 6],
                    bytes[body + 7],
                ]);
                bits = u16::from_le_bytes([bytes[body + 14], bytes[body + 15]]);
            } else if id.starts_with(b"data") {
                let end = (body + size).min(bytes.len());
                samples = decode_pcm(&bytes[body..end], audio_format, bits);
            }
            // RIFF chunks are word-aligned.
            offset = body + size + (size % 2);
        }

        (samples, channels, sample_rate)
    }

    fn decode_pcm(body: &[u8], audio_format: u16, bits: u16) -> Vec<f32> {
        match (audio_format, bits) {
            (3, 32) => body
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect(),
            (1, 16) => body
                .chunks_exact(2)
                .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32_768.0)
                .collect(),
            (format, width) => panic!("unsupported WAV format {format} with {width}-bit samples"),
        }
    }

    #[test]
    #[ignore = "requires a real STT model + a 16 kHz mono WAV supplied at run time (env vars)"]
    fn real_engine_wav_fixture_emits_partials_then_final() {
        let Ok(wav_path) = std::env::var(WAV_ENV) else {
            eprintln!("skipping: {WAV_ENV} is not set");
            return;
        };
        let models_dir = std::env::var(MODELS_ENV)
            .map(PathBuf::from)
            .unwrap_or_else(|_| default_models_dir());
        if !Path::new(&wav_path).is_file() {
            eprintln!("skipping: {wav_path} does not exist");
            return;
        }
        if !models_dir.is_dir() {
            eprintln!(
                "skipping: models dir {} does not exist",
                models_dir.display()
            );
            return;
        }

        let (samples, channels, sample_rate) = read_wav(Path::new(&wav_path));
        assert_eq!(
            sample_rate, ENGINE_SAMPLE_RATE as u32,
            "fixture must be 16 kHz"
        );
        assert_eq!(channels, 1, "fixture must be mono");
        assert!(!samples.is_empty(), "fixture carried no samples");

        let mut recognizer = load_recognizer(&models_dir).expect("load the real engine");

        let sink = RecordingSink::default();
        let (tx, rx) = std::sync::mpsc::channel::<AudioMsg>();
        for chunk in samples.chunks(CAPTURE_CHUNK_SAMPLES) {
            tx.send(AudioMsg::Samples(chunk.to_vec())).expect("send samples");
        }
        tx.send(AudioMsg::Stop).expect("send stop");
        drop(tx);
        run_recognition(&sink, "fixture", recognizer.as_mut(), &rx);

        let events = sink.transcripts.lock().expect("sink lock").clone();
        for event in &events {
            eprintln!(
                "  rev={} seg={} final={} text={:?}",
                event.revision, event.segment_id, event.is_final, event.text
            );
        }

        let first_final = events
            .iter()
            .position(|event| event.is_final)
            .expect("expected a final transcript line");
        let partials_before_final: std::collections::BTreeSet<&str> = events[..first_final]
            .iter()
            .filter(|event| !event.is_final)
            .map(|event| event.text.as_str())
            .collect();

        eprintln!(
            "fixture leg: {} events, {} distinct partials before the first final",
            events.len(),
            partials_before_final.len()
        );
        assert!(
            partials_before_final.len() >= 2,
            "expected >=2 DISTINCT partials before the final, got {partials_before_final:?}"
        );
    }
}
