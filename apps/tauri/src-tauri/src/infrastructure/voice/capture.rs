// SPIKE #2876 — THROWAWAY POC — replaced by #2877/#2878
//!
//! Native microphone capture: a `cpal` input stream (WASAPI on Windows) that
//! mono-mixes, linear-resamples to 16 kHz, slices into fixed 3200-sample chunks
//! and forwards them over a `std::sync::mpsc` channel to the recognition loop.
//!
//! The `cpal::Stream` is created and owned by the session's worker thread and
//! never crosses a thread boundary. No webview audio, no CSP changes (R-5.1).

use std::sync::mpsc::Sender;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;

use super::engine::{CAPTURE_CHUNK_SAMPLES, ENGINE_SAMPLE_RATE};
use super::state::{SttErrorCode, VoiceError};

/// Message protocol between capture and the recognition loop.
pub enum AudioMsg {
    /// A 3200-sample 16 kHz mono f32 chunk.
    Samples(Vec<f32>),
    /// Stop and commit the final partial (R-3.3 / stop semantics).
    Stop,
    /// Stop and discard the current partial (cancel semantics).
    Cancel,
}

/// Live capture: holding this keeps the device stream alive.
pub struct CaptureHandle {
    pub device_name: String,
    pub device_sample_rate: u32,
    _stream: cpal::Stream,
}

fn on_stream_error(error: cpal::Error) {
    eprintln!("[stt] audio stream error: {error}");
}

/// Map a `cpal` error to the typed vocabulary: permission denial and device
/// availability are named (R-5.2/R-5.3); everything else is `internal`.
fn map_cpal_error(context: &str, error: cpal::Error) -> VoiceError {
    match error.kind() {
        cpal::ErrorKind::PermissionDenied => {
            VoiceError::permission_denied(format!("{context}: {error}"))
        }
        cpal::ErrorKind::DeviceNotAvailable => VoiceError::no_device(),
        _ => VoiceError::new(SttErrorCode::Internal, format!("{context}: {error}")),
    }
}

/// Streaming linear resampler from the device rate to 16 kHz.
struct LinearResampler {
    /// input_rate / output_rate
    ratio: f64,
    /// Fractional read position into `tail`.
    position: f64,
    /// Unconsumed input samples (keeps one sample of interpolation history).
    tail: Vec<f32>,
}

impl LinearResampler {
    fn new(input_rate: u32) -> Self {
        let in_rate = if input_rate == 0 {
            ENGINE_SAMPLE_RATE as u32
        } else {
            input_rate
        };
        Self {
            ratio: in_rate as f64 / ENGINE_SAMPLE_RATE as f64,
            position: 0.0,
            tail: Vec::new(),
        }
    }

    fn process(&mut self, input: &[f32]) -> Vec<f32> {
        self.tail.extend_from_slice(input);
        let mut output = Vec::new();
        while (self.position as usize) + 1 < self.tail.len() {
            let index = self.position as usize;
            let frac = (self.position - index as f64) as f32;
            let a = self.tail[index];
            let b = self.tail[index + 1];
            output.push(a + (b - a) * frac);
            self.position += self.ratio;
        }
        let consumed = self.position as usize;
        if consumed > 0 {
            self.tail.drain(..consumed);
            self.position -= consumed as f64;
        }
        output
    }
}

/// Accumulates resampled audio and emits fixed 3200-sample chunks.
struct Chunker {
    resampler: LinearResampler,
    buffer: Vec<f32>,
    tx: Sender<AudioMsg>,
}

impl Chunker {
    fn new(device_sample_rate: u32, tx: Sender<AudioMsg>) -> Self {
        Self {
            resampler: LinearResampler::new(device_sample_rate),
            buffer: Vec::with_capacity(CAPTURE_CHUNK_SAMPLES),
            tx,
        }
    }

    fn push(&mut self, mono: &[f32]) {
        let resampled = self.resampler.process(mono);
        self.buffer.extend_from_slice(&resampled);
        while self.buffer.len() >= CAPTURE_CHUNK_SAMPLES {
            let chunk: Vec<f32> = self.buffer.drain(..CAPTURE_CHUNK_SAMPLES).collect();
            if self.tx.send(AudioMsg::Samples(chunk)).is_err() {
                // The session ended; stop buffering.
                self.buffer.clear();
                break;
            }
        }
    }
}

fn mono_f32(data: &[f32], channels: usize) -> Vec<f32> {
    let ch = channels.max(1);
    data.chunks(ch)
        .map(|frame| frame.iter().copied().sum::<f32>() / ch as f32)
        .collect()
}

fn mono_i16(data: &[i16], channels: usize) -> Vec<f32> {
    let ch = channels.max(1);
    let scale = 1.0 / i16::MAX as f32;
    data.chunks(ch)
        .map(|frame| frame.iter().map(|&s| s as f32 * scale).sum::<f32>() / ch as f32)
        .collect()
}

fn mono_u16(data: &[u16], channels: usize) -> Vec<f32> {
    let ch = channels.max(1);
    data.chunks(ch)
        .map(|frame| {
            frame
                .iter()
                .map(|&s| (s as f32 - 32768.0) / 32768.0)
                .sum::<f32>()
                / ch as f32
        })
        .collect()
}

fn mono_i32(data: &[i32], channels: usize) -> Vec<f32> {
    let ch = channels.max(1);
    let scale = 1.0 / i32::MAX as f32;
    data.chunks(ch)
        .map(|frame| frame.iter().map(|&s| s as f32 * scale).sum::<f32>() / ch as f32)
        .collect()
}

fn mono_u8(data: &[u8], channels: usize) -> Vec<f32> {
    let ch = channels.max(1);
    data.chunks(ch)
        .map(|frame| {
            frame
                .iter()
                .map(|&s| (s as f32 - 128.0) / 128.0)
                .sum::<f32>()
                / ch as f32
        })
        .collect()
}

/// Open the default input device and start streaming 16 kHz mono chunks.
///
/// `default_input_device() == None` ⇒ `NoDevice` (R-5.2); a device open/play
/// failure maps to `PermissionDenied`/`NoDevice`/`Internal` (R-5.3) — never a
/// panic. The returned handle must be kept alive for the duration of capture.
pub fn start_capture(tx: Sender<AudioMsg>) -> Result<CaptureHandle, VoiceError> {
    let host = cpal::default_host();
    let device = match host.default_input_device() {
        Some(device) => device,
        None => return Err(VoiceError::no_device()),
    };
    let device_name = device.to_string();

    let supported = device
        .default_input_config()
        .map_err(|error| map_cpal_error("failed to query the default input config", error))?;
    let sample_format = supported.sample_format();
    let config = supported.config();
    let device_sample_rate = config.sample_rate;
    let channels = config.channels as usize;

    let stream = match sample_format {
        SampleFormat::F32 => {
            let mut chunker = Chunker::new(device_sample_rate, tx);
            device
                .build_input_stream(
                    config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        chunker.push(&mono_f32(data, channels));
                    },
                    on_stream_error,
                    None,
                )
                .map_err(|error| map_cpal_error("failed to open the input stream", error))?
        }
        SampleFormat::I16 => {
            let mut chunker = Chunker::new(device_sample_rate, tx);
            device
                .build_input_stream(
                    config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        chunker.push(&mono_i16(data, channels));
                    },
                    on_stream_error,
                    None,
                )
                .map_err(|error| map_cpal_error("failed to open the input stream", error))?
        }
        SampleFormat::U16 => {
            let mut chunker = Chunker::new(device_sample_rate, tx);
            device
                .build_input_stream(
                    config,
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        chunker.push(&mono_u16(data, channels));
                    },
                    on_stream_error,
                    None,
                )
                .map_err(|error| map_cpal_error("failed to open the input stream", error))?
        }
        SampleFormat::I32 => {
            let mut chunker = Chunker::new(device_sample_rate, tx);
            device
                .build_input_stream(
                    config,
                    move |data: &[i32], _: &cpal::InputCallbackInfo| {
                        chunker.push(&mono_i32(data, channels));
                    },
                    on_stream_error,
                    None,
                )
                .map_err(|error| map_cpal_error("failed to open the input stream", error))?
        }
        SampleFormat::U8 => {
            let mut chunker = Chunker::new(device_sample_rate, tx);
            device
                .build_input_stream(
                    config,
                    move |data: &[u8], _: &cpal::InputCallbackInfo| {
                        chunker.push(&mono_u8(data, channels));
                    },
                    on_stream_error,
                    None,
                )
                .map_err(|error| map_cpal_error("failed to open the input stream", error))?
        }
        other => {
            return Err(VoiceError::new(
                SttErrorCode::Internal,
                format!("unsupported input sample format: {other:?}"),
            ))
        }
    };

    stream
        .play()
        .map_err(|error| map_cpal_error("failed to start the input stream", error))?;

    Ok(CaptureHandle {
        device_name,
        device_sample_rate,
        _stream: stream,
    })
}
