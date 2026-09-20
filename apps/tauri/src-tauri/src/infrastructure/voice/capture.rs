//! Native microphone capture: a `cpal` input stream (WASAPI on Windows) that
//! mono-mixes, linear-resamples to 16 kHz, slices into fixed 3200-sample chunks
//! and forwards them over a `std::sync::mpsc` channel to the recognition loop.
//!
//! The `cpal::Stream` is created and owned by the session's worker thread and
//! never crosses a thread boundary. Capture is device-selectable: the persisted
//! Companion preference (`Fredo_companion_voice_device_id`, a cpal device name)
//! is resolved against the live input set here — blank/unset means the system
//! default, and a named-but-absent device is the typed `NoDevice` NAMING it,
//! never a silent fallback to a different microphone (AC4). No webview audio,
//! no CSP changes, no network in the decode path (LOCAL-ONLY).
//!
//! ## Deterministic capture feed (test seam)
//!
//! `FREDO_STT_FEED_WAV=<abs path to a 16 kHz mono 16-bit PCM WAV>` replaces the
//! capture SOURCE with a paced file reader (1× real time) that pushes the same
//! [`AudioMsg::Samples`] `CAPTURE_CHUNK_SAMPLES`-sample chunks onto the same
//! `mpsc` channel the device callback uses. The variable is read in exactly one
//! place ([`capture_source_from_env`]); unset or blank selects
//! [`CaptureSource::Device`], so the shipped `cpal` path is unchanged. In Feed
//! mode **no `cpal` device (and no host) is ever constructed**, so the
//! microphone is opened strictly *less* than in production — this seam can never
//! open the mic earlier. `stt_warm` never reaches it (warm never calls
//! [`start_capture`]), and the feed is read-only: it adds no persisted key.
//!
//! **Stated limitation (honest):** a feed proves capture was live before the
//! first sample was pushed; it cannot prove a real transducer's latency.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;

use super::engine::{CAPTURE_CHUNK_SAMPLES, ENGINE_SAMPLE_RATE};
use super::state::{SttDeviceInfo, SttErrorCode, VoiceError};

/// Message protocol between capture and the recognition loop.
pub enum AudioMsg {
    /// A 3200-sample 16 kHz mono f32 chunk.
    Samples(Vec<f32>),
    /// Stop and commit the final partial (R-3.3 / stop semantics).
    Stop,
    /// Stop and discard the current partial (cancel semantics).
    Cancel,
}

/// The env var that selects the deterministic capture feed. Read ONLY by
/// [`capture_source_from_env`] — nowhere else in the crate.
pub(crate) const FEED_WAV_ENV: &str = "FREDO_STT_FEED_WAV";

/// The `device_name` reported in Feed mode. Deliberately unmistakable, so the
/// capture-active app-log line tells a tester the feed ran (not a microphone).
pub(crate) const FEED_DEVICE_NAME: &str = "stt-feed";

/// The feed's pacing: one `CAPTURE_CHUNK_SAMPLES` chunk per chunk duration, i.e.
/// 1× real time, so the transcript lands over the utterance's duration and the
/// timing rows are measured on a real start (`3200 / 16000 Hz = 200 ms`).
const FEED_CHUNK_PERIOD: Duration = Duration::from_millis(200);

/// Where a capture's audio comes from. `Device` is the shipped production path;
/// `Feed` is the env-gated deterministic reader.
#[derive(Debug, PartialEq, Eq)]
pub enum CaptureSource {
    /// Open the selected/default `cpal` input device (the shipped behaviour).
    Device,
    /// Read this 16 kHz mono 16-bit PCM WAV, paced 1× real time. No `cpal`
    /// device is constructed on this path.
    Feed(PathBuf),
}

/// Resolve the capture source from [`FEED_WAV_ENV`] — the ONE place capture
/// reads the environment. Unset/blank ⇒ [`CaptureSource::Device`].
pub(crate) fn capture_source_from_env() -> CaptureSource {
    capture_source_from_value(std::env::var_os(FEED_WAV_ENV).as_deref())
}

/// The pure selection rule behind [`capture_source_from_env`], split out so it
/// is testable without mutating the process environment (tests run in parallel).
fn capture_source_from_value(value: Option<&std::ffi::OsStr>) -> CaptureSource {
    match value.map(|raw| raw.to_string_lossy().trim().to_string()) {
        Some(path) if !path.is_empty() => CaptureSource::Feed(PathBuf::from(path)),
        _ => CaptureSource::Device,
    }
}

/// Live capture: holding this keeps the source alive (the device stream, or the
/// paced feed reader — exactly one of the two).
pub struct CaptureHandle {
    pub device_name: String,
    pub device_sample_rate: u32,
    /// The `cpal` input stream (Device mode only). `None` in Feed mode, where no
    /// device is ever constructed.
    _stream: Option<cpal::Stream>,
    /// The paced feed reader (Feed mode only).
    _feed: Option<FeedReader>,
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

/// The persisted selection with surrounding whitespace removed; blank ⇒ unset.
fn normalized_selection(selected: Option<&str>) -> Option<&str> {
    selected.map(str::trim).filter(|value| !value.is_empty())
}

/// The host's input-device names — the stable selection identity (cpal exposes
/// no device GUID). Enumeration failure is reported as the typed `NoDevice`.
fn input_device_names(host: &cpal::Host) -> Result<Vec<String>, VoiceError> {
    let devices = host.input_devices().map_err(|error| {
        VoiceError::new(
            SttErrorCode::NoDevice,
            format!("failed to enumerate input devices: {error}"),
        )
    })?;
    Ok(devices.map(|device| device.to_string()).collect())
}

/// Locate an enumerated input device by its exact name.
fn find_input_device(host: &cpal::Host, name: &str) -> Result<cpal::Device, VoiceError> {
    let devices = host.input_devices().map_err(|error| {
        VoiceError::new(
            SttErrorCode::NoDevice,
            format!("failed to enumerate input devices: {error}"),
        )
    })?;
    for device in devices {
        if device.to_string() == name {
            return Ok(device);
        }
    }
    Err(VoiceError::no_device_named(name))
}

/// The selection rule, pure over the enumerated device names: unset/blank ⇒ the
/// system default (`Ok(None)`); an enumerated name ⇒ `Ok(Some(name))`; a name
/// that is absent ⇒ typed `NoDevice` naming it. Kept pure so the no-silent-
/// fallback rule (AC4) is hermetically pinned without a real device.
pub(crate) fn choose_device_name(
    selected: Option<&str>,
    enumerated: &[String],
) -> Result<Option<String>, VoiceError> {
    match normalized_selection(selected) {
        None => Ok(None),
        Some(name) if enumerated.iter().any(|candidate| candidate.as_str() == name) => {
            Ok(Some(name.to_string()))
        }
        Some(name) => Err(VoiceError::no_device_named(name)),
    }
}

/// Enumerate the host's input devices for the Companion settings picker, marking
/// the host default. Enumeration failure is the typed `NoDevice` — never a panic.
pub fn list_input_devices() -> Result<Vec<SttDeviceInfo>, VoiceError> {
    let host = cpal::default_host();
    let default_name = host.default_input_device().map(|device| device.to_string());
    let devices = host.input_devices().map_err(|error| {
        VoiceError::new(
            SttErrorCode::NoDevice,
            format!("failed to enumerate input devices: {error}"),
        )
    })?;
    Ok(devices
        .map(|device| {
            let name = device.to_string();
            SttDeviceInfo {
                is_default: default_name.as_deref() == Some(name.as_str()),
                id: name.clone(),
                name,
            }
        })
        .collect())
}

/// `cpal::default_host()` behind a seam so a test can prove the Feed path never
/// enters the device path at all (and therefore never constructs a device). The
/// probe is a no-op in production: `cfg!(test)` is a `false` literal there, so
/// the branch is dead code and production behaviour is unchanged.
fn capture_host() -> cpal::Host {
    if cfg!(test) {
        DEVICE_PATH_ENTRIES.fetch_add(1, Ordering::SeqCst);
    }
    cpal::default_host()
}

/// Counts entries into the device path. Written only under `cfg!(test)`; it
/// exists unconditionally so production code carries no `#[cfg(test)]` item
/// (the crate's invariant harness treats the first such item as the test-region
/// boundary and would stop scanning capture.rs's production region there).
static DEVICE_PATH_ENTRIES: AtomicUsize = AtomicUsize::new(0);

/// Start capture from the source named by [`FEED_WAV_ENV`] (unset ⇒ the shipped
/// `cpal` device path). The returned handle must be kept alive for the duration
/// of capture — dropping it releases the device, or stops the feed reader.
pub fn start_capture(
    tx: Sender<AudioMsg>,
    selected: Option<&str>,
) -> Result<CaptureHandle, VoiceError> {
    start_capture_with_source(tx, capture_source_from_env(), selected)
}

/// Dispatch on the resolved [`CaptureSource`]. Split from [`start_capture`] so
/// the Feed path is pinnable without touching the process environment.
fn start_capture_with_source(
    tx: Sender<AudioMsg>,
    source: CaptureSource,
    selected: Option<&str>,
) -> Result<CaptureHandle, VoiceError> {
    match source {
        // The feed ignores `selected` entirely: it enumerates and validates no
        // device, so a hold can never open a microphone on this path.
        CaptureSource::Feed(path) => start_feed_capture(tx, &path),
        // The shipped production path, unchanged.
        CaptureSource::Device => start_device_capture(tx, selected),
    }
}

/// Open the requested input device and start streaming 16 kHz mono chunks.
///
/// `selected` is the persisted preference (a cpal device name; `None`/blank ⇒
/// the system default). A named device that no longer enumerates is the typed
/// `NoDevice` with a detail NAMING it — capture NEVER silently falls back to a
/// different microphone (AC4 / R-4.5). A host with no input device is
/// `NoDevice`; a device open/play failure maps to `PermissionDenied`/`NoDevice`/
/// `Internal` — never a panic. The returned handle must be kept alive for the
/// duration of capture.
fn start_device_capture(
    tx: Sender<AudioMsg>,
    selected: Option<&str>,
) -> Result<CaptureHandle, VoiceError> {
    let host = capture_host();
    // Only pay for enumeration when a named device must be validated.
    let enumerated = match normalized_selection(selected) {
        Some(_) => input_device_names(&host)?,
        None => Vec::new(),
    };
    let device = match choose_device_name(selected, &enumerated)? {
        Some(name) => find_input_device(&host, &name)?,
        None => host.default_input_device().ok_or_else(VoiceError::no_device)?,
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
        _stream: Some(stream),
        _feed: None,
    })
}

// ---------------------------------------------------------------------------
// Deterministic capture feed (`FREDO_STT_FEED_WAV`)
// ---------------------------------------------------------------------------

/// A typed failure on the feed path. Always `Internal`: the feed is a test seam,
/// but a broken feed must never silently degrade into a device capture.
fn feed_error(path: &Path, detail: impl std::fmt::Display) -> VoiceError {
    VoiceError::new(
        SttErrorCode::Internal,
        format!("capture feed {}: {detail}", path.display()),
    )
}

/// Read the feed WAV from disk (read-only — no writes, no persisted keys).
fn read_feed_wav(path: &Path) -> Result<Vec<f32>, VoiceError> {
    let bytes = std::fs::read(path)
        .map_err(|error| feed_error(path, format!("cannot read the WAV: {error}")))?;
    decode_feed_wav(&bytes, path)
}

/// Decode a 16 kHz mono 16-bit PCM WAV into the recognizer's f32 sample shape.
/// Kept pure over bytes so malformed-input pins need no filesystem at all.
fn decode_feed_wav(bytes: &[u8], path: &Path) -> Result<Vec<f32>, VoiceError> {
    if bytes.len() < 12 || bytes[0..4] != b"RIFF"[..] || bytes[8..12] != b"WAVE"[..] {
        return Err(feed_error(path, "not a RIFF/WAVE file"));
    }
    let mut format_seen = false;
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
        let end = body
            .checked_add(size)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| feed_error(path, "a RIFF chunk is truncated"))?;
        if id == b"fmt " {
            validate_feed_format(path, &bytes[body..end])?;
            format_seen = true;
        } else if id == b"data" {
            if !format_seen {
                return Err(feed_error(path, "the data chunk precedes the fmt chunk"));
            }
            return decode_feed_pcm(path, &bytes[body..end]);
        }
        // RIFF chunks are word-aligned.
        offset = end + (size % 2);
    }
    Err(feed_error(path, "no data chunk"))
}

/// The ONE accepted feed format: 16 kHz mono 16-bit PCM — already the shape the
/// recognizer consumes, so the feed never resamples.
fn validate_feed_format(path: &Path, body: &[u8]) -> Result<(), VoiceError> {
    if body.len() < 16 {
        return Err(feed_error(path, "the fmt chunk is too short"));
    }
    let audio_format = u16::from_le_bytes([body[0], body[1]]);
    let channels = u16::from_le_bytes([body[2], body[3]]);
    let sample_rate = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
    let bits_per_sample = u16::from_le_bytes([body[14], body[15]]);
    if audio_format != 1 {
        return Err(feed_error(
            path,
            format!("expected 16-bit PCM (format 1), found WAV format {audio_format}"),
        ));
    }
    if channels != 1 {
        return Err(feed_error(
            path,
            format!("expected mono, found {channels} channels"),
        ));
    }
    if sample_rate != ENGINE_SAMPLE_RATE as u32 {
        return Err(feed_error(
            path,
            format!("expected {ENGINE_SAMPLE_RATE} Hz, found {sample_rate} Hz"),
        ));
    }
    if bits_per_sample != 16 {
        return Err(feed_error(
            path,
            format!("expected 16-bit samples, found {bits_per_sample}-bit"),
        ));
    }
    Ok(())
}

/// 16-bit little-endian PCM → f32 through the SAME conversion the device
/// callback uses (`mono_i16`), so feed audio is identical to a mono 16-bit
/// device's audio.
fn decode_feed_pcm(path: &Path, body: &[u8]) -> Result<Vec<f32>, VoiceError> {
    if !body.len().is_multiple_of(2) {
        return Err(feed_error(
            path,
            "the data chunk is not a whole number of 16-bit samples",
        ));
    }
    let samples: Vec<i16> = body
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    Ok(mono_i16(&samples, 1))
}

/// Owns the paced feed reader thread; dropping it stops the reader promptly.
struct FeedReader {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl Drop for FeedReader {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(join) = self.join.take() {
            // The reader wakes from its pacing sleep within one slice and exits.
            let _ = join.join();
        }
    }
}

/// Sleep for `total`, returning early when `stop` is set.
fn sleep_until_stopped(stop: &AtomicBool, total: Duration) -> bool {
    const SLICE: Duration = Duration::from_millis(5);
    let mut slept = Duration::ZERO;
    while slept < total {
        if stop.load(Ordering::SeqCst) {
            return true;
        }
        let slice = SLICE.min(total - slept);
        thread::sleep(slice);
        slept += slice;
    }
    stop.load(Ordering::SeqCst)
}

/// Spawn the paced file reader: it pushes `CAPTURE_CHUNK_SAMPLES`-sample
/// [`AudioMsg::Samples`] chunks onto the SAME channel the device callback uses,
/// one per `pace`, and never touches `cpal`.
fn spawn_feed_reader(
    tx: Sender<AudioMsg>,
    path: &Path,
    pace: Duration,
) -> Result<FeedReader, VoiceError> {
    let samples = read_feed_wav(path)?;
    let stop = Arc::new(AtomicBool::new(false));
    let reader_stop = Arc::clone(&stop);
    let join = thread::Builder::new()
        .name("stt-feed".to_string())
        .spawn(move || {
            for chunk in samples.chunks(CAPTURE_CHUNK_SAMPLES) {
                if reader_stop.load(Ordering::SeqCst) {
                    return;
                }
                if tx.send(AudioMsg::Samples(chunk.to_vec())).is_err() {
                    // The session ended; stop reading.
                    return;
                }
                if !pace.is_zero() && sleep_until_stopped(&reader_stop, pace) {
                    return;
                }
            }
        })
        .map_err(|error| {
            VoiceError::new(
                SttErrorCode::Internal,
                format!("capture feed: cannot start the reader thread: {error}"),
            )
        })?;
    Ok(FeedReader {
        stop,
        join: Some(join),
    })
}

/// Feed mode: no device is enumerated, validated or opened.
fn start_feed_capture(tx: Sender<AudioMsg>, path: &Path) -> Result<CaptureHandle, VoiceError> {
    let reader = spawn_feed_reader(tx, path, FEED_CHUNK_PERIOD)?;
    Ok(CaptureHandle {
        device_name: FEED_DEVICE_NAME.to_string(),
        device_sample_rate: ENGINE_SAMPLE_RATE as u32,
        _stream: None,
        _feed: Some(reader),
    })
}

#[cfg(test)]
mod tests {
    //! Hermetic device-selection pins: the persisted-preference → device rule
    //! runs without a real microphone (no `cpal`, no `AppHandle`, no network).

    use super::*;

    fn names(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn unset_or_blank_selection_resolves_to_the_system_default() {
        let enumerated = names(&["Iriun Webcam", "Microphone (USB)"]);
        for selected in [None, Some(""), Some("   "), Some("\t\n")] {
            assert_eq!(
                choose_device_name(selected, &enumerated).expect("blank is not an error"),
                None,
                "{selected:?} must select the system default, not a device"
            );
        }
    }

    #[test]
    fn a_named_enumerated_device_is_selected_by_its_name() {
        let enumerated = names(&["Iriun Webcam", "Microphone (USB)"]);
        let chosen = choose_device_name(Some("Microphone (USB)"), &enumerated)
            .expect("an enumerated device must resolve");
        assert_eq!(chosen.as_deref(), Some("Microphone (USB)"));

        // Surrounding whitespace is tolerated (a persisted value is user data).
        let chosen = choose_device_name(Some("  Iriun Webcam  "), &enumerated)
            .expect("trimmed name must resolve");
        assert_eq!(chosen.as_deref(), Some("Iriun Webcam"));
    }

    /// AC4: a persisted device that is no longer enumerated is the typed
    /// `NoDevice` NAMING it — never a silent fallback to another microphone.
    #[test]
    fn a_vanished_named_device_is_no_device_naming_it_and_never_falls_back() {
        let enumerated = names(&["Microphone (USB)"]);
        let error = choose_device_name(Some("Iriun Webcam"), &enumerated)
            .expect_err("a vanished device must fail, not fall back");
        assert_eq!(error.code, SttErrorCode::NoDevice);
        assert!(
            error.detail.contains("Iriun Webcam"),
            "detail must name the vanished device: {}",
            error.detail
        );

        // Even an empty host must not fall back when a name is persisted.
        let error = choose_device_name(Some("Iriun Webcam"), &[])
            .expect_err("an empty device set must not silently fall back");
        assert_eq!(error.code, SttErrorCode::NoDevice);
        assert!(error.detail.contains("Iriun Webcam"));
    }

    // -----------------------------------------------------------------------
    // Deterministic capture feed (ST-9)
    // -----------------------------------------------------------------------

    /// The committed deterministic fixture (generated in-repo by
    /// `.opencode/tests/voice-dictation/fixtures/generate-dictation-phrase.mjs`).
    /// The tester passes this absolute path via `FREDO_STT_FEED_WAV`.
    fn fixture_path() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join(".opencode")
            .join("tests")
            .join("voice-dictation")
            .join("fixtures")
            .join("dictation-phrase-16k-mono.wav")
    }

    /// A minimal RIFF/WAVE container for the malformed-input pins: the caller
    /// controls the format tag and the raw data bytes (no filesystem involved).
    fn wav_bytes(
        audio_format: u16,
        channels: u16,
        sample_rate: u32,
        bits_per_sample: u16,
        data: &[u8],
    ) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&((36 + data.len()) as u32).to_le_bytes());
        bytes.extend_from_slice(b"WAVE");
        bytes.extend_from_slice(b"fmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&audio_format.to_le_bytes());
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        let byte_rate = sample_rate * u32::from(channels) * u32::from(bits_per_sample) / 8;
        bytes.extend_from_slice(&byte_rate.to_le_bytes());
        bytes.extend_from_slice(&(channels * bits_per_sample / 8).to_le_bytes());
        bytes.extend_from_slice(&bits_per_sample.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(data.len() as u32).to_le_bytes());
        bytes.extend_from_slice(data);
        bytes
    }

    /// Unset/blank env ⇒ the shipped device path; a path ⇒ the feed. The rule is
    /// pure, so this pin never mutates the process environment.
    #[test]
    fn the_capture_source_is_the_device_unless_the_feed_env_var_names_a_file() {
        use std::ffi::OsStr;
        assert_eq!(capture_source_from_value(None), CaptureSource::Device);
        assert_eq!(
            capture_source_from_value(Some(OsStr::new(""))),
            CaptureSource::Device
        );
        assert_eq!(
            capture_source_from_value(Some(OsStr::new("   "))),
            CaptureSource::Device
        );
        assert_eq!(
            capture_source_from_value(Some(OsStr::new(" C:\\feeds\\phrase.wav "))),
            CaptureSource::Feed(PathBuf::from("C:\\feeds\\phrase.wav"))
        );
    }

    /// The fixture's format is pinned exactly: 16 kHz mono 16-bit PCM, signal at
    /// sample 0 (so a dropped opening cannot hide behind leading silence).
    #[test]
    fn the_feed_fixture_is_16k_mono_16bit_pcm_with_signal_at_sample_zero() {
        let path = fixture_path();
        let bytes = std::fs::read(&path).expect("the committed fixture must exist");
        assert!(bytes.len() > 44, "the fixture must carry a data chunk");
        assert_eq!(&bytes[0..4], &b"RIFF"[..]);
        assert_eq!(&bytes[8..12], &b"WAVE"[..]);
        assert_eq!(u16::from_le_bytes([bytes[20], bytes[21]]), 1, "PCM tag");
        assert_eq!(u16::from_le_bytes([bytes[22], bytes[23]]), 1, "mono");
        assert_eq!(
            u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]),
            16_000,
            "16 kHz"
        );
        assert_eq!(u16::from_le_bytes([bytes[34], bytes[35]]), 16, "16-bit");
        assert_eq!(
            u32::from_le_bytes([bytes[40], bytes[41], bytes[42], bytes[43]]),
            51_200,
            "1.6 s of 16-bit mono samples"
        );

        let samples = decode_feed_wav(&bytes, &path).expect("the fixture must decode");
        assert_eq!(samples.len(), 25_600, "1.6 s at 16 kHz");
        assert_ne!(samples[0], 0.0, "the opening must start at sample 0");
        let peak = samples.iter().fold(0.0f32, |peak, s| peak.max(s.abs()));
        assert!(peak > 0.3, "the fixture must carry real signal, peak {peak}");
    }

    /// The over-limit leg's format contract (ST-9): the parameterised generator
    /// (`.opencode/tests/voice-dictation/fixtures/generate-dictation-phrase.mjs
    /// --seconds 31` → `dictation-31s-16k-mono.wav`) emits the SAME 16 kHz mono
    /// 16-bit PCM container the feed accepts, and the decoder applies NO length
    /// cap — a >30 s clip decodes in full, sample for sample. Kept pure over
    /// bytes (no file, no environment) so it pins the format independently of
    /// the on-demand variant.
    #[test]
    fn the_over_limit_feed_format_decodes_every_sample_with_no_length_cap() {
        const OVER_LIMIT_SECONDS: usize = 31;
        const OVER_LIMIT_SAMPLES: usize = OVER_LIMIT_SECONDS * 16_000;

        // Non-zero at sample 0, so the decode assertion is not vacuous.
        let mut data = vec![0u8; OVER_LIMIT_SAMPLES * 2];
        data[0..2].copy_from_slice(&1000i16.to_le_bytes());
        let bytes = wav_bytes(1, 1, 16_000, 16, &data);
        assert_eq!(
            u32::from_le_bytes([bytes[40], bytes[41], bytes[42], bytes[43]]) as usize,
            OVER_LIMIT_SAMPLES * 2,
            "31 s of 16-bit mono samples"
        );

        let samples = decode_feed_wav(&bytes, Path::new("dictation-31s-16k-mono.wav"))
            .expect("the over-limit fixture format must decode");
        assert_eq!(
            samples.len(),
            OVER_LIMIT_SAMPLES,
            "31 s at 16 kHz must decode in full, untruncated"
        );
        assert_ne!(samples[0], 0.0, "the opening sample must survive the decode");
        assert_eq!(
            samples.chunks(CAPTURE_CHUNK_SAMPLES).count(),
            155,
            "31 s = 155 whole 200 ms capture chunks"
        );
    }

    /// The feed pushes exactly the chunk shape the device callback pushes, on the
    /// same channel — and the first chunk carries sample 0 of the fixture.
    #[test]
    fn the_feed_pushes_the_same_3200_sample_chunks_the_device_callback_does() {
        let (tx, rx) = std::sync::mpsc::channel();
        let reader =
            spawn_feed_reader(tx, &fixture_path(), Duration::ZERO).expect("spawn the feed reader");
        let mut chunks = Vec::new();
        while let Ok(AudioMsg::Samples(chunk)) = rx.recv() {
            chunks.push(chunk);
        }
        assert_eq!(chunks.len(), 8, "1.6 s of audio = eight 200 ms chunks");
        for chunk in &chunks {
            assert_eq!(chunk.len(), CAPTURE_CHUNK_SAMPLES);
        }
        assert_ne!(chunks[0][0], 0.0, "the opening sample must be fed first");
        drop(reader);
    }

    /// No `cpal` device — not even a host — is constructed in Feed mode, so the
    /// microphone is opened strictly less than in production. The probe's
    /// liveness is asserted first, so the Feed assertion is non-vacuous.
    #[test]
    fn feed_mode_never_constructs_a_cpal_device() {
        let before = DEVICE_PATH_ENTRIES.load(Ordering::SeqCst);
        drop(capture_host());
        assert_eq!(
            DEVICE_PATH_ENTRIES.load(Ordering::SeqCst),
            before + 1,
            "the device-path probe must be live"
        );

        let before = DEVICE_PATH_ENTRIES.load(Ordering::SeqCst);
        let (tx, _rx) = std::sync::mpsc::channel();
        // `selected` names a device that does not exist: Feed mode must not
        // enumerate or validate devices, so this still succeeds.
        let handle = start_capture_with_source(
            tx,
            CaptureSource::Feed(fixture_path()),
            Some("No Such Microphone"),
        )
        .expect("the feed must open");
        assert_eq!(
            DEVICE_PATH_ENTRIES.load(Ordering::SeqCst),
            before,
            "Feed mode must not enter the cpal device path"
        );
        assert_eq!(handle.device_name, FEED_DEVICE_NAME);
        assert_eq!(handle.device_sample_rate, ENGINE_SAMPLE_RATE as u32);
        drop(handle);
    }

    /// A bad feed is a typed error that names the file — it never falls back to a
    /// microphone.
    #[test]
    fn a_missing_feed_is_a_typed_error_and_never_falls_back_to_a_device() {
        let (tx, _rx) = std::sync::mpsc::channel();
        let error = start_capture_with_source(
            tx,
            CaptureSource::Feed(PathBuf::from("definitely-not-a-feed-file.wav")),
            None,
        )
        .err()
        .expect("a missing feed file must fail");
        assert_eq!(error.code, SttErrorCode::Internal);
        assert!(
            error.detail.contains("definitely-not-a-feed-file.wav"),
            "the detail must name the file: {}",
            error.detail
        );
    }

    /// Only 16 kHz mono 16-bit PCM is accepted; every other shape is a typed
    /// error naming the mismatch (never a silent resample or channel mix).
    #[test]
    fn a_feed_wav_that_is_not_16k_mono_pcm_is_rejected_with_a_typed_error() {
        let path = Path::new("feed.wav");
        let mono_16k = |data: &[u8]| wav_bytes(1, 1, 16_000, 16, data);

        let mut truncated_data = mono_16k(&[0, 0, 0, 0]);
        let truncated_len = truncated_data.len();
        truncated_data.truncate(truncated_len - 1);
        let mut no_data = mono_16k(&[0, 0]);
        no_data.truncate(36);

        let cases: [(&str, Vec<u8>, &str); 8] = [
            ("not RIFF", b"not a wav at all".to_vec(), "RIFF"),
            ("float samples", wav_bytes(3, 1, 16_000, 32, &[0, 0, 0, 0]), "PCM"),
            ("stereo", wav_bytes(1, 2, 16_000, 16, &[0, 0, 0, 0]), "mono"),
            ("8 kHz", wav_bytes(1, 1, 8_000, 16, &[0, 0]), "16000"),
            ("8-bit", wav_bytes(1, 1, 16_000, 8, &[0]), "16-bit"),
            (
                "odd data length",
                wav_bytes(1, 1, 16_000, 16, &[0]),
                "whole number",
            ),
            ("truncated chunk", truncated_data, "truncated"),
            ("no data chunk", no_data, "no data chunk"),
        ];

        for (name, bytes, expected) in cases {
            let error = decode_feed_wav(&bytes, path).expect_err(name);
            assert_eq!(error.code, SttErrorCode::Internal, "{name}");
            assert!(
                error.detail.contains(expected),
                "{name}: detail {:?} must contain {expected:?}",
                error.detail
            );
        }
    }

    /// The feed is pinned to 1× real time: one 3200-sample chunk per 200 ms —
    /// exactly the audio duration it carries.
    #[test]
    fn the_feed_paces_one_realtime() {
        assert_eq!(FEED_CHUNK_PERIOD, Duration::from_millis(200));
        assert_eq!(
            CAPTURE_CHUNK_SAMPLES,
            ENGINE_SAMPLE_RATE as usize / 5,
            "3200 samples at 16 kHz IS 200 ms"
        );
    }
}
