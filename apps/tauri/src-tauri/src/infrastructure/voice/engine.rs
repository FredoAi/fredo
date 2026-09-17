//! Streaming engine wrapper around `sherpa_onnx::OnlineRecognizer`.
//!
//! [`Recognizer`] is the seam the hermetic session pins inject a fake through
//! (no model, no mic, CI-green); [`SherpaRecognizer`] is the real int8 Zipformer
//! transducer. [`Recognizer::new_stream`] renews only the per-session stream, so
//! one recognizer can be reused by the process-resident engine (R-7); when the
//! resident slot is empty the engine is still loaded lazily on `stt_start`. The
//! SHA-256 content gate runs BEFORE `OnlineRecognizer::create` (a size-valid /
//! content-invalid model must never reach the native parser).
//! API verified live against sherpa-onnx 1.13.8.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};
use sherpa_onnx::{
    OnlineModelConfig, OnlineRecognizer, OnlineRecognizerConfig, OnlineStream,
    OnlineTransducerModelConfig,
};

use crate::infrastructure::companion::models::{file_path, ModelManifest};

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
    /// Replace the active stream with a fresh one so a RESIDENT recognizer can
    /// serve another session (R-7). Creation stays the ONE-time cost; only the
    /// stream is renewed. A recognizer that has already been through
    /// [`Recognizer::input_finished`] is NOT reusable without this reset.
    fn new_stream(&mut self);
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

    fn new_stream(&mut self) {
        // The `OnlineRecognizer` (the expensive, verified model load) is kept;
        // only the per-session `OnlineStream` is replaced.
        self.stream = self.recognizer.create_stream();
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

/// Stream a file through SHA-256 in ~64 KiB chunks, returning the lowercase hex
/// digest. `voice/` is `infrastructure/` and MUST NOT import `features/setup`'s
/// private `hex_encode` (no cross-feature import), so the hex helper is local.
fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_lowercase(hasher.finalize().as_slice()))
}

fn hex_lowercase(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Content-integrity gate (ST-7.1 / F-15): run BEFORE `OnlineRecognizer::create`
/// so a size-valid / content-invalid model yields a typed `modelCorrupt` instead
/// of reaching the native parser (which aborts: "Rust cannot catch foreign
/// exceptions"). Walks the manifest in order and verifies every file whose
/// `sha256` is `Some`; `sha256: None` ⇒ skipped (`ModelFileSpec::sha256`
/// contract). Strictly read-only — never writes, deletes, or repairs a file.
pub(crate) fn verify_model_content(
    models_dir: &Path,
    manifest: &ModelManifest,
) -> Option<VoiceError> {
    for spec in &manifest.files {
        let Some(expected) = spec.sha256.as_deref() else {
            continue;
        };
        let path = file_path(models_dir, manifest, spec);
        let actual = match sha256_file(&path) {
            Ok(actual) => actual,
            Err(error) => {
                return Some(VoiceError::model_corrupt(format!(
                    "{} could not be read for SHA-256 verification: {error}",
                    spec.filename()
                )))
            }
        };
        if !actual.eq_ignore_ascii_case(expected) {
            return Some(VoiceError::model_corrupt(format!(
                "{} failed SHA-256 verification (expected {}, got {})",
                spec.filename(),
                expected,
                actual
            )));
        }
    }
    None
}

/// Lazily load the engine. `OnlineRecognizer::create` returning `None` is the
/// typed `engineStartFailed` failure (R-5.5) — never a panic. The
/// content-integrity gate (ST-7.1) runs FIRST: unverified bytes must never reach
/// the native parser.
pub fn load_recognizer(models_dir: &Path) -> Result<Box<dyn Recognizer>, VoiceError> {
    let manifest = resolve_stt_manifest();
    if let Some(error) = verify_model_content(models_dir, &manifest) {
        return Err(error);
    }
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
    //! Deterministic second leg: the REAL engine over a hand-placed 16 kHz mono
    //! WAV, driven through the same recognition loop the live path uses. The WAV
    //! and the models dir are supplied at run time — nothing is downloaded, no
    //! fixture blob is committed, and the leg self-skips when the env vars are
    //! absent, so `cargo test --locked` stays green with no model and no mic.
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

    use crate::infrastructure::companion::models::{file_path, ModelFileSpec, ModelManifest};
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

    /// Nearest-rank percentile over an ASCENDING slice (`pct` in 1..=100).
    fn percentile(sorted: &[u64], pct: usize) -> u64 {
        if sorted.is_empty() {
            return 0;
        }
        let rank = (sorted.len() * pct).div_ceil(100);
        sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
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
                "  rev={} seg={} final={} latencyMs={} text={:?}",
                event.revision, event.segment_id, event.is_final, event.latency_ms, event.text
            );
        }

        // ST-7.3 (AC2): the AC2 latency numbers over the NON-final events — a
        // final's `latency_ms` is measured from `input_finished` (a different
        // quantity), so finals are excluded from the percentile set.
        let mut latencies: Vec<u64> = events
            .iter()
            .filter(|event| !event.is_final)
            .map(|event| event.latency_ms)
            .collect();
        latencies.sort_unstable();
        eprintln!(
            "latency: n={} p50={} p95={} max={} (method: chunk dequeue -> stt:transcript emit, from SttTranscriptEvent.latencyMs; fixture fed as fast as the loop accepts audio)",
            latencies.len(),
            percentile(&latencies, 50),
            percentile(&latencies, 95),
            latencies.last().copied().unwrap_or(0),
        );

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

    /// SHA-256 of the ASCII bytes `hello world` — a fixed, independent pin.
    const SHA_HELLO_WORLD: &str =
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

    fn content_manifest(path: &str, expected_bytes: u64, sha256: Option<&str>) -> ModelManifest {
        ModelManifest {
            revision: "test".to_string(),
            subdir: "stt-test".to_string(),
            files: vec![ModelFileSpec {
                id: path.to_string(),
                path: path.to_string(),
                url: format!("https://example.invalid/{path}"),
                expected_bytes,
                sha256: sha256.map(str::to_string),
            }],
        }
    }

    fn write_model_content(dir: &Path, manifest: &ModelManifest, bytes: &[u8]) {
        let spec = &manifest.files[0];
        let path = file_path(dir, manifest, spec);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, bytes).expect("write model content");
    }

    #[test]
    fn verify_model_content_accepts_matching_pinned_content() {
        let manifest = content_manifest("model.onnx", 11, Some(SHA_HELLO_WORLD));
        let dir = tempfile::tempdir().expect("tempdir");
        write_model_content(dir.path(), &manifest, b"hello world");
        assert!(verify_model_content(dir.path(), &manifest).is_none());
    }

    /// The F-15 shape: a size-valid file whose CONTENT is wrong must never reach
    /// the native parser — the gate names the file and the check.
    #[test]
    fn verify_model_content_flags_same_size_different_bytes() {
        let manifest = content_manifest("model.onnx", 11, Some(SHA_HELLO_WORLD));
        let dir = tempfile::tempdir().expect("tempdir");
        // Same byte COUNT, one byte different.
        write_model_content(dir.path(), &manifest, b"hellp world");
        let error = verify_model_content(dir.path(), &manifest).expect("mismatch must be typed");
        assert_eq!(error.code, SttErrorCode::ModelCorrupt);
        assert!(
            error.detail.contains("model.onnx"),
            "detail must name the file: {}",
            error.detail
        );
        assert!(
            error.detail.contains("SHA-256"),
            "detail must name the check: {}",
            error.detail
        );
    }

    #[test]
    fn verify_model_content_skips_files_without_a_pin() {
        // `sha256: None` ⇒ size-only contract (`ModelFileSpec`) — never hashed.
        let manifest = content_manifest("model.onnx", 23, None);
        let dir = tempfile::tempdir().expect("tempdir");
        write_model_content(dir.path(), &manifest, b"totally different bytes");
        assert!(verify_model_content(dir.path(), &manifest).is_none());
    }
}
