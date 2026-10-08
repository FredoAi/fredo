//! Streamed model-file acquisition engine (Spec #2856, ST-2).
//!
//! Consumes the pure model in [`super::model_download_state`] and acquires every
//! required file that is NOT already present-and-complete:
//!
//! * skip files that verify present (never overwritten / re-fetched),
//! * HTTP `Range` resume from the on-disk byte count, with a safe from-zero
//!   restart when the server ignores `Range` (200), returns 416, or the on-disk
//!   file is longer than expected,
//! * streaming SHA-256, seeded with the on-disk prefix BEFORE the GET on resume
//!   (so the response body is never left idle) — a mismatch deletes the file and
//!   reports `error`,
//! * bounded retry with exponential backoff on a transient mid-stream body error
//!   or premature body, resuming from the persisted offset; corrupt data and
//!   HTTP-status responses are never retried,
//! * per-file error isolation (one file failing never aborts the run),
//! * throttled per-file progress (`≤ ~10 events/s`) via a caller-supplied sink.
//!
//! The module is deliberately free of Tauri types: ST-3 adapts the `AppHandle`
//! emitter to [`ProgressReporter`] and passes the resolved models dir in. HTTP is
//! abstracted behind [`HttpTransport`] so the engine is unit-tested with a fake
//! source and KB-scale payloads — no network, no large files.

use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use bytes::Bytes;
use futures_util::stream::BoxStream;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::model_download_state::{
    describe_file, file_path, FileState, ModelFileSpec, ModelManifest, ModelFileStatus,
};

/// A streaming HTTP body: each item is a chunk or a transport error.
pub type ByteStream = BoxStream<'static, Result<Bytes>>;

/// A boxed, `Send` future — keeps the [`HttpTransport`] trait object-safe.
pub type BoxFuture<'a, T> = Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// A byte range request (`Range: bytes=<start>-`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HttpRange {
    pub start: u64,
}

/// Minimal HTTP response surface the engine needs.
pub struct HttpResponse {
    pub status: u16,
    pub body: ByteStream,
}

impl HttpResponse {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Pluggable HTTP source — the production impl is [`ReqwestTransport`]; tests
/// inject a scripted fake so no network is touched.
pub trait HttpTransport: Send + Sync {
    fn get<'a>(
        &'a self,
        url: &'a str,
        range: Option<HttpRange>,
    ) -> BoxFuture<'a, Result<HttpResponse>>;
}

/// Production HTTP transport backed by `reqwest`.
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    /// Build a client with sane timeouts. No request is made here.
    pub fn new() -> Result<Self> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .build()
            .context("failed to build the HTTP client")?;
        Ok(Self { client })
    }
}

impl HttpTransport for ReqwestTransport {
    fn get<'a>(
        &'a self,
        url: &'a str,
        range: Option<HttpRange>,
    ) -> BoxFuture<'a, Result<HttpResponse>> {
        Box::pin(async move {
            let mut request = self.client.get(url);
            if let Some(range) = range {
                request = request.header(reqwest::header::RANGE, format!("bytes={}-", range.start));
            }
            let response = request
                .send()
                .await
                .with_context(|| format!("request failed for {url}"))?;
            let status = response.status().as_u16();
            let body: ByteStream = Box::pin(
                response
                    .bytes_stream()
                    .map(|chunk| chunk.map_err(anyhow::Error::from)),
            );
            Ok(HttpResponse { status, body })
        })
    }
}

/// Per-file progress lifecycle state (the four UI states plus `skipped`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProgressState {
    Downloading,
    Present,
    Skipped,
    Error,
}

/// The `setup:download-progress` payload (additive camelCase; legacy
/// `file`/`total`/`downloaded`/`percent` retained, `percent` in 0..=100).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub file_id: String,
    pub file: String,
    pub relative_path: String,
    pub total: u64,
    pub downloaded: u64,
    pub percent: f64,
    pub state: ProgressState,
}

/// Sink for progress events. ST-3 adapts `AppHandle::emit` to this.
pub trait ProgressReporter: Send + Sync {
    fn report(&self, progress: DownloadProgress);
}

/// Injectable time source so progress throttling is deterministically testable.
pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
}

/// Wall-clock time source.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

/// Minimum gap between progress emissions for one file (≤ ~10 events/s).
pub const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(100);

/// Result of a full acquisition run (additive to the legacy `SetupStepResult`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadOutcome {
    pub success: bool,
    pub output: String,
    pub error: Option<String>,
    pub files: Vec<ModelFileStatus>,
}

/// Coalesces progress emissions to at most one per [`PROGRESS_MIN_INTERVAL`].
struct Throttle {
    last: Option<Instant>,
}

impl Throttle {
    fn new() -> Self {
        Self { last: None }
    }

    fn due(&mut self, now: Instant, interval: Duration) -> bool {
        let ready = self
            .last
            .is_none_or(|last| now.duration_since(last) >= interval);
        if ready {
            self.last = Some(now);
        }
        ready
    }
}

fn progress_for(
    spec: &ModelFileSpec,
    manifest: &ModelManifest,
    downloaded: u64,
    state: ProgressState,
) -> DownloadProgress {
    let total = spec.expected_bytes;
    let clamped = downloaded.min(total);
    let percent = if total > 0 {
        (clamped as f64 / total as f64) * 100.0
    } else {
        0.0
    };
    DownloadProgress {
        file_id: spec.id.clone(),
        file: spec.filename().to_string(),
        relative_path: format!("{}/{}", manifest.subdir, spec.path),
        total,
        downloaded,
        percent,
        state,
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Hash exactly `len` leading bytes of the file at `path` into `hasher`. Used on
/// resume so the final digest covers the already-downloaded prefix.
async fn hash_prefix(path: &Path, len: u64, hasher: &mut Sha256) -> Result<()> {
    let mut file = tokio::fs::File::open(path)
        .await
        .with_context(|| format!("failed to open {} for prefix hashing", path.display()))?;
    let mut remaining = len;
    let mut buffer = vec![0u8; 64 * 1024];
    while remaining > 0 {
        let want = remaining.min(buffer.len() as u64) as usize;
        let read = file
            .read(&mut buffer[..want])
            .await
            .with_context(|| format!("failed to read {} while hashing", path.display()))?;
        if read == 0 {
            return Err(anyhow!(
                "{} is shorter than the expected resume offset",
                path.display()
            ));
        }
        hasher.update(&buffer[..read]);
        remaining -= read as u64;
    }
    Ok(())
}

/// Why a single download attempt failed. Transient body failures are retried
/// from the persisted offset; terminal failures surface to the UI immediately.
enum AttemptError {
    /// A mid-stream transport/body error or a premature/short body. The bytes on
    /// disk are a correct prefix, so the caller may re-issue the `Range` GET.
    Retryable(anyhow::Error),
    /// Corrupt data (SHA-256 mismatch), an over-long body, or a local write/IO
    /// failure — retrying cannot help.
    Fatal(anyhow::Error),
}

/// The seeded resume state handed to [`stream_and_verify`]: the on-disk offset
/// and the SHA-256 already hashed over that prefix (ST-2R). Bundling them keeps
/// the seed→stream hand-off explicit and the argument list bounded.
struct Resume {
    offset: u64,
    hasher: Sha256,
}

/// Stream a response body to disk from the resume offset, hashing into the
/// caller-seeded `hasher`, and verify the exact byte count plus (when pinned) the
/// SHA-256.
///
/// **Invariant (ST-2R):** no long-running work may run between the response
/// headers arriving and the first `body.next()` poll below. The resume prefix is
/// hashed by the caller BEFORE the GET (see [`acquire_file`]); hashing it here
/// would leave the response body idle until the server/edge resets the stream —
/// the deterministic `error decoding response body` observed in round 1.
async fn stream_and_verify(
    mut body: ByteStream,
    dest: &Path,
    resume: Resume,
    spec: &ModelFileSpec,
    manifest: &ModelManifest,
    reporter: &dyn ProgressReporter,
    clock: &dyn Clock,
) -> Result<(), AttemptError> {
    let Resume { offset, mut hasher } = resume;
    let (mut file, mut downloaded) = if offset == 0 {
        let file = tokio::fs::File::create(dest).await.map_err(|error| {
            AttemptError::Fatal(
                anyhow::Error::from(error).context(format!("failed to create {}", dest.display())),
            )
        })?;
        (file, 0u64)
    } else {
        let file = tokio::fs::OpenOptions::new()
            .append(true)
            .open(dest)
            .await
            .map_err(|error| {
                AttemptError::Fatal(
                    anyhow::Error::from(error)
                        .context(format!("failed to open {} for resume", dest.display())),
                )
            })?;
        (file, offset)
    };

    let mut throttle = Throttle::new();
    if throttle.due(clock.now(), PROGRESS_MIN_INTERVAL) {
        reporter.report(progress_for(
            spec,
            manifest,
            downloaded,
            ProgressState::Downloading,
        ));
    }

    while let Some(item) = body.next().await {
        let chunk = match item {
            Ok(chunk) => chunk,
            Err(error) => {
                // A body error AFTER every expected byte arrived is benign — the
                // file is byte-complete, so fall through to verification rather
                // than restarting (which would regress progress).
                if downloaded == spec.expected_bytes {
                    break;
                }
                // Flush before returning so the persisted on-disk length is exact
                // for the retry's offset re-derivation.
                let _ = file.flush().await;
                return Err(AttemptError::Retryable(error));
            }
        };
        file.write_all(&chunk).await.map_err(|error| {
            AttemptError::Fatal(
                anyhow::Error::from(error).context(format!("failed to write {}", dest.display())),
            )
        })?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        if downloaded > spec.expected_bytes {
            return Err(AttemptError::Fatal(anyhow!(
                "server sent more than the expected {} bytes for {}",
                spec.expected_bytes,
                spec.id
            )));
        }
        if throttle.due(clock.now(), PROGRESS_MIN_INTERVAL) {
            reporter.report(progress_for(
                spec,
                manifest,
                downloaded,
                ProgressState::Downloading,
            ));
        }
    }

    file.flush().await.map_err(|error| {
        AttemptError::Fatal(
            anyhow::Error::from(error).context(format!("failed to flush {}", dest.display())),
        )
    })?;
    drop(file);

    if downloaded != spec.expected_bytes {
        return Err(AttemptError::Retryable(anyhow!(
            "incomplete download — {downloaded} of {} bytes",
            spec.expected_bytes
        )));
    }

    if let Some(expected) = &spec.sha256 {
        let actual = hex_encode(hasher.finalize().as_slice());
        if !actual.eq_ignore_ascii_case(expected) {
            let _ = tokio::fs::remove_file(dest).await;
            return Err(AttemptError::Fatal(anyhow!(
                "SHA-256 mismatch for {} — expected {expected}, got {actual}",
                spec.filename()
            )));
        }
    }

    Ok(())
}

/// Bounded budget of `Range` GET attempts per file (ST-2R2). A genuinely
/// persistent body failure ends in the terminal per-file `Error` after this
/// many attempts — the AC5 contract is unchanged.
const MAX_DOWNLOAD_ATTEMPTS: usize = 5;

/// Base retry backoff between attempts; doubled per attempt, capped at
/// [`RETRY_MAX_DELAY`]. Tests use a 1 ms base so the retry path stays fast.
#[cfg(not(test))]
const RETRY_BASE_DELAY: Duration = Duration::from_millis(500);
#[cfg(test)]
const RETRY_BASE_DELAY: Duration = Duration::from_millis(1);

/// Upper bound for the exponential retry backoff.
const RETRY_MAX_DELAY: Duration = Duration::from_secs(4);

/// Backoff before the next attempt after `attempt` (1-based) transient failures:
/// base, 2×, 4×… capped at [`RETRY_MAX_DELAY`].
fn retry_backoff(attempt: usize) -> Duration {
    let shift = attempt.saturating_sub(1).min(3) as u32;
    let millis = RETRY_BASE_DELAY.as_millis() as u64 * (1u64 << shift);
    Duration::from_millis(millis.min(RETRY_MAX_DELAY.as_millis() as u64))
}

/// Acquire one file, isolating any failure to that file. Emits the terminal
/// `present` / `skipped` / `error` transition for the file.
async fn acquire_file(
    transport: &dyn HttpTransport,
    manifest: &ModelManifest,
    spec: &ModelFileSpec,
    models_dir: &Path,
    reporter: &dyn ProgressReporter,
    clock: &dyn Clock,
) -> Result<()> {
    let dest = file_path(models_dir, manifest, spec);
    let initial = describe_file(models_dir, manifest, spec);

    // Never re-fetch or overwrite a present-and-complete file.
    if initial.state == FileState::Present {
        reporter.report(progress_for(
            spec,
            manifest,
            initial.downloaded_bytes,
            ProgressState::Skipped,
        ));
        return Ok(());
    }

    // A metadata/IO error we cannot reason about (as opposed to an oversize
    // file, which we deliberately restart) is a hard per-file failure.
    if initial.state == FileState::Error && initial.downloaded_bytes <= spec.expected_bytes {
        let detail = initial
            .detail
            .clone()
            .unwrap_or_else(|| format!("could not inspect {}", spec.id));
        reporter.report(progress_for(
            spec,
            manifest,
            initial.downloaded_bytes,
            ProgressState::Error,
        ));
        return Err(anyhow!(detail));
    }

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }

    // Bounded retry loop (ST-2R2): one attempt = re-derive offset → seed hasher
    // → GET → stream/verify. Only transient body failures re-enter the loop.
    let mut last_error: Option<anyhow::Error> = None;

    for attempt in 1..=MAX_DOWNLOAD_ATTEMPTS {
        // Re-derive the offset from the ACTUAL on-disk byte count at the start of
        // every attempt, so a retry continues from wherever the previous attempt
        // landed; the final digest still covers the whole file. Oversize (or an
        // exactly-at-expected unverified length) restarts from zero.
        let inspected = describe_file(models_dir, manifest, spec);
        let mut offset = if inspected.downloaded_bytes < spec.expected_bytes {
            inspected.downloaded_bytes
        } else {
            0
        };

        // ST-2R: seed the resume hasher BEFORE the GET. The ~GB prefix hash must
        // not sit between the response headers and the first body poll, or the
        // server/edge resets the idle body.
        let mut hasher = Sha256::new();
        if offset > 0 {
            if let Err(error) = hash_prefix(&dest, offset, &mut hasher).await {
                reporter.report(progress_for(spec, manifest, offset, ProgressState::Error));
                return Err(error);
            }
        }

        let range = (offset > 0).then_some(HttpRange { start: offset });
        let mut response = match transport.get(&spec.url, range).await {
            Ok(response) => response,
            Err(error) => {
                // A GET-level failure is not in the retry class — surface it.
                reporter.report(progress_for(spec, manifest, offset, ProgressState::Error));
                return Err(error);
            }
        };

        if response.status == 416 {
            // Requested range not satisfiable — retry the whole file.
            response = match transport.get(&spec.url, None).await {
                Ok(response) => response,
                Err(error) => {
                    reporter.report(progress_for(spec, manifest, 0, ProgressState::Error));
                    return Err(error);
                }
            };
            offset = 0;
            hasher = Sha256::new();
        } else if offset > 0 && response.status != 206 {
            // Server ignored `Range` (or returned something else) — the body is
            // the full file, so truncate and write it from zero.
            offset = 0;
            hasher = Sha256::new();
        }

        if !response.is_success() {
            reporter.report(progress_for(spec, manifest, offset, ProgressState::Error));
            return Err(anyhow!("HTTP {} for {}", response.status, spec.url));
        }

        match stream_and_verify(
            response.body,
            &dest,
            Resume { offset, hasher },
            spec,
            manifest,
            reporter,
            clock,
        )
        .await
        {
            Ok(()) => {
                reporter.report(progress_for(
                    spec,
                    manifest,
                    spec.expected_bytes,
                    ProgressState::Present,
                ));
                return Ok(());
            }
            Err(AttemptError::Fatal(error)) => {
                reporter.report(progress_for(spec, manifest, offset, ProgressState::Error));
                return Err(error);
            }
            Err(AttemptError::Retryable(error)) => {
                last_error = Some(error);
                if attempt == MAX_DOWNLOAD_ATTEMPTS {
                    break;
                }
                tokio::time::sleep(retry_backoff(attempt)).await;
            }
        }
    }

    // ST-2R2 / AC5: budget exhausted — emit the same terminal per-file `Error` as
    // before (the partial survives for a later resume).
    let error = last_error.unwrap_or_else(|| anyhow!("download failed for {}", spec.id));
    let final_offset = describe_file(models_dir, manifest, spec).downloaded_bytes;
    reporter.report(progress_for(
        spec,
        manifest,
        final_offset,
        ProgressState::Error,
    ));
    Err(error)
}

/// Acquire every non-present required file, in manifest order. Per-file failures
/// are collected and never abort the run; the returned `files` carry the final
/// per-file state.
pub async fn download_missing_files(
    transport: &dyn HttpTransport,
    manifest: &ModelManifest,
    models_dir: &Path,
    reporter: &dyn ProgressReporter,
    clock: &dyn Clock,
) -> ModelDownloadOutcome {
    let mut files = Vec::with_capacity(manifest.files.len());
    let mut errors: Vec<String> = Vec::new();

    for spec in &manifest.files {
        match acquire_file(transport, manifest, spec, models_dir, reporter, clock).await {
            Ok(()) => files.push(describe_file(models_dir, manifest, spec)),
            Err(error) => {
                errors.push(format!("{}: {error}", spec.filename()));
                let mut status = describe_file(models_dir, manifest, spec);
                status.state = FileState::Error;
                status.detail = Some(error.to_string());
                files.push(status);
            }
        }
    }

    let success = !manifest.files.is_empty() && errors.is_empty();
    let subdir_path: PathBuf = models_dir.join(&manifest.subdir);
    let output = if manifest.files.is_empty() {
        "No required model files are declared in the manifest.".to_string()
    } else if success {
        format!("Model files ready in {}", subdir_path.display())
    } else {
        format!(
            "{} of {} model files failed to download",
            errors.len(),
            manifest.files.len()
        )
    };

    ModelDownloadOutcome {
        success,
        output,
        error: if errors.is_empty() {
            None
        } else {
            Some(errors.join("; "))
        },
        files,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    fn sha256_hex(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        hex_encode(hasher.finalize().as_slice())
    }

    fn spec(id: &str, path: &str, url: &str, expected: u64, sha: Option<String>) -> ModelFileSpec {
        ModelFileSpec {
            id: id.to_string(),
            path: path.to_string(),
            url: url.to_string(),
            expected_bytes: expected,
            sha256: sha,
        }
    }

    fn manifest(files: Vec<ModelFileSpec>) -> ModelManifest {
        ModelManifest {
            revision: "test-rev".to_string(),
            subdir: "test-sub".to_string(),
            files,
        }
    }

    fn seed_file(dir: &Path, manifest: &ModelManifest, spec: &ModelFileSpec, bytes: &[u8]) {
        let dest = file_path(dir, manifest, spec);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).expect("create parent dir");
        }
        std::fs::write(&dest, bytes).expect("seed file");
    }

    #[derive(Clone, Copy)]
    enum FakeMode {
        Full,
        Range,
        IgnoreRange,
        RangeUnsupported,
        Http(u16),
        FailAfter(usize),
        /// Honor `Range` (206 + slice from the start) but fail the body on the
        /// first `attempts` requests — the retry's persisted offset advances.
        FailFirstAfter {
            attempts: usize,
            fail_after: usize,
        },
    }

    #[derive(Clone)]
    struct FakeFile {
        body: Vec<u8>,
        mode: FakeMode,
        chunk_size: usize,
    }

    #[derive(Default)]
    struct FakeTransport {
        files: Mutex<HashMap<String, FakeFile>>,
        requests: Mutex<Vec<(String, Option<u64>)>>,
    }

    impl FakeTransport {
        fn new() -> Self {
            Self {
                files: Mutex::new(HashMap::new()),
                requests: Mutex::new(Vec::new()),
            }
        }

        fn insert(&self, url: &str, file: FakeFile) {
            self.files
                .lock()
                .expect("lock")
                .insert(url.to_string(), file);
        }

        fn request_log(&self) -> Vec<(String, Option<u64>)> {
            self.requests.lock().expect("lock").clone()
        }
    }

    fn chunk_stream(body: Vec<u8>, chunk_size: usize, fail_after: Option<usize>) -> ByteStream {
        let limit = fail_after.unwrap_or(body.len());
        let mut items: Vec<Result<Bytes>> = Vec::new();
        let mut pos = 0usize;
        while pos < body.len() && pos < limit {
            let end = (pos + chunk_size).min(body.len()).min(limit);
            items.push(Ok(Bytes::copy_from_slice(&body[pos..end])));
            pos = end;
        }
        if fail_after.is_some() {
            items.push(Err(anyhow!("simulated mid-stream failure")));
        }
        Box::pin(futures_util::stream::iter(items))
    }

    impl HttpTransport for FakeTransport {
        fn get<'a>(
            &'a self,
            url: &'a str,
            range: Option<HttpRange>,
        ) -> BoxFuture<'a, Result<HttpResponse>> {
            Box::pin(async move {
                let attempt_index = {
                    let mut log = self.requests.lock().expect("lock");
                    log.push((url.to_string(), range.map(|r| r.start)));
                    // 1-based: the request just pushed.
                    log.iter().filter(|(seen, _)| seen == url).count()
                };
                let file = self
                    .files
                    .lock()
                    .expect("lock")
                    .get(url)
                    .cloned()
                    .ok_or_else(|| anyhow!("unexpected request for {url}"))?;
                let start = range.map(|r| r.start).unwrap_or(0);
                let (status, bytes, fail_after) = match file.mode {
                    FakeMode::Full => (200u16, file.body.clone(), None),
                    FakeMode::Range => {
                        if range.is_some() {
                            let slice = file
                                .body
                                .get(start as usize..)
                                .unwrap_or(&[])
                                .to_vec();
                            (206, slice, None)
                        } else {
                            (200, file.body.clone(), None)
                        }
                    }
                    FakeMode::IgnoreRange => (200, file.body.clone(), None),
                    FakeMode::RangeUnsupported => {
                        if range.is_some() {
                            (416, Vec::new(), None)
                        } else {
                            (200, file.body.clone(), None)
                        }
                    }
                    FakeMode::Http(code) => (code, Vec::new(), None),
                    FakeMode::FailAfter(n) => (200, file.body.clone(), Some(n)),
                    FakeMode::FailFirstAfter {
                        attempts,
                        fail_after,
                    } => {
                        // Honor the Range so the retry's persisted offset advances.
                        let slice = file
                            .body
                            .get(start as usize..)
                            .unwrap_or(&[])
                            .to_vec();
                        let status = if range.is_some() { 206 } else { 200 };
                        let fail = (attempt_index <= attempts).then_some(fail_after);
                        (status, slice, fail)
                    }
                };
                let body = chunk_stream(bytes, file.chunk_size.max(1), fail_after);
                Ok(HttpResponse { status, body })
            })
        }
    }

    struct ManualClock {
        now: Mutex<Instant>,
    }

    impl ManualClock {
        fn new() -> Self {
            Self {
                now: Mutex::new(Instant::now()),
            }
        }
    }

    impl Clock for ManualClock {
        fn now(&self) -> Instant {
            *self.now.lock().expect("lock")
        }
    }

    /// Advances by `step` on every read, forcing the throttle to emit per chunk.
    struct AutoAdvanceClock {
        now: Mutex<Instant>,
        step: Duration,
    }

    impl Clock for AutoAdvanceClock {
        fn now(&self) -> Instant {
            let mut guard = self.now.lock().expect("lock");
            let current = *guard;
            *guard += self.step;
            current
        }
    }

    #[derive(Default)]
    struct RecordingReporter {
        events: Mutex<Vec<DownloadProgress>>,
    }

    impl ProgressReporter for RecordingReporter {
        fn report(&self, progress: DownloadProgress) {
            self.events.lock().expect("lock").push(progress);
        }
    }

    impl RecordingReporter {
        fn events(&self) -> Vec<DownloadProgress> {
            self.events.lock().expect("lock").clone()
        }
    }

    #[tokio::test]
    async fn skips_present_and_complete_file_without_request() {
        let dir = tempfile::tempdir().expect("tempdir");
        let m = manifest(vec![spec("model", "a.bin", "http://stub/a.bin", 5, None)]);
        seed_file(dir.path(), &m, &m.files[0], b"12345");

        let transport = FakeTransport::new();
        let reporter = RecordingReporter::default();
        let clock = ManualClock::new();

        let outcome = download_missing_files(&transport, &m, dir.path(), &reporter, &clock).await;

        assert!(outcome.success, "outcome: {outcome:?}");
        assert!(
            transport.request_log().is_empty(),
            "a present file must not be re-fetched"
        );
        assert_eq!(outcome.files[0].state, FileState::Present);
        let events = reporter.events();
        assert_eq!(events.last().expect("terminal event").state, ProgressState::Skipped);
        assert_eq!(
            std::fs::read(file_path(dir.path(), &m, &m.files[0])).expect("read"),
            b"12345"
        );
    }

    #[tokio::test]
    async fn downloads_streams_and_verifies_sha256() {
        let dir = tempfile::tempdir().expect("tempdir");
        let body = b"hello world 123".to_vec();
        let m = manifest(vec![spec(
            "model",
            "a.bin",
            "http://stub/a.bin",
            body.len() as u64,
            Some(sha256_hex(&body)),
        )]);
        let transport = FakeTransport::new();
        transport.insert(
            "http://stub/a.bin",
            FakeFile {
                body: body.clone(),
                mode: FakeMode::Full,
                chunk_size: 4,
            },
        );
        let reporter = RecordingReporter::default();
        let clock = ManualClock::new();

        let outcome = download_missing_files(&transport, &m, dir.path(), &reporter, &clock).await;

        assert!(outcome.success, "outcome: {outcome:?}");
        assert_eq!(
            std::fs::read(file_path(dir.path(), &m, &m.files[0])).expect("read"),
            body
        );
        assert_eq!(outcome.files[0].state, FileState::Present);
        let terminal = reporter.events().pop().expect("terminal event");
        assert_eq!(terminal.state, ProgressState::Present);
        assert!((terminal.percent - 100.0).abs() < f64::EPSILON);
    }

    #[tokio::test]
    async fn resumes_from_partial_file_with_range_and_prefix_hash() {
        let dir = tempfile::tempdir().expect("tempdir");
        let full: Vec<u8> = (0..20u8).collect();
        let m = manifest(vec![spec(
            "vision",
            "a.bin",
            "http://stub/a.bin",
            full.len() as u64,
            Some(sha256_hex(&full)),
        )]);
        seed_file(dir.path(), &m, &m.files[0], &full[..8]);

        let transport = FakeTransport::new();
        transport.insert(
            "http://stub/a.bin",
            FakeFile {
                body: full.clone(),
                mode: FakeMode::Range,
                chunk_size: 3,
            },
        );
        let reporter = RecordingReporter::default();
        let clock = ManualClock::new();

        let outcome = download_missing_files(&transport, &m, dir.path(), &reporter, &clock).await;

        assert!(outcome.success, "outcome: {outcome:?}");
        assert_eq!(
            transport.request_log(),
            vec![("http://stub/a.bin".to_string(), Some(8))]
        );
        assert_eq!(
            std::fs::read(file_path(dir.path(), &m, &m.files[0])).expect("read"),
            full
        );
        assert_eq!(outcome.files[0].state, FileState::Present);
    }

    #[tokio::test]
    async fn range_ignored_restarts_from_zero_without_duplicating_prefix() {
        let dir = tempfile::tempdir().expect("tempdir");
        let full: Vec<u8> = (0..20u8).collect();
        let m = manifest(vec![spec("model", "a.bin", "http://stub/a.bin", 20, None)]);
        seed_file(dir.path(), &m, &m.files[0], &full[..8]);

        let transport = FakeTransport::new();
        transport.insert(
            "http://stub/a.bin",
            FakeFile {
                body: full.clone(),
                mode: FakeMode::IgnoreRange,
                chunk_size: 5,
            },
        );
        let reporter = RecordingReporter::default();
        let clock = ManualClock::new();

        let outcome = download_missing_files(&transport, &m, dir.path(), &reporter, &clock).await;

        assert!(outcome.success, "outcome: {outcome:?}");
        assert_eq!(
            transport.request_log(),
            vec![("http://stub/a.bin".to_string(), Some(8))]
        );
        assert_eq!(
            std::fs::read(file_path(dir.path(), &m, &m.files[0])).expect("read"),
            full
        );
    }

    #[tokio::test]
    async fn range_unsupported_416_retries_whole_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let full: Vec<u8> = (0..20u8).collect();
        let m = manifest(vec![spec("model", "a.bin", "http://stub/a.bin", 20, None)]);
        seed_file(dir.path(), &m, &m.files[0], &full[..8]);

        let transport = FakeTransport::new();
        transport.insert(
            "http://stub/a.bin",
            FakeFile {
                body: full.clone(),
                mode: FakeMode::RangeUnsupported,
                chunk_size: 5,
            },
        );
        let reporter = RecordingReporter::default();
        let clock = ManualClock::new();

        let outcome = download_missing_files(&transport, &m, dir.path(), &reporter, &clock).await;

        assert!(outcome.success, "outcome: {outcome:?}");
        assert_eq!(
            transport.request_log(),
            vec![
                ("http://stub/a.bin".to_string(), Some(8)),
                ("http://stub/a.bin".to_string(), None),
            ]
        );
        assert_eq!(
            std::fs::read(file_path(dir.path(), &m, &m.files[0])).expect("read"),
            full
        );
    }

    #[tokio::test]
    async fn oversize_file_restarts_from_zero() {
        let dir = tempfile::tempdir().expect("tempdir");
        let full: Vec<u8> = (0..20u8).collect();
        let m = manifest(vec![spec("model", "a.bin", "http://stub/a.bin", 20, None)]);
        seed_file(dir.path(), &m, &m.files[0], &(0..25u8).collect::<Vec<u8>>());

        let transport = FakeTransport::new();
        transport.insert(
            "http://stub/a.bin",
            FakeFile {
                body: full.clone(),
                mode: FakeMode::Full,
                chunk_size: 5,
            },
        );
        let reporter = RecordingReporter::default();
        let clock = ManualClock::new();

        let outcome = download_missing_files(&transport, &m, dir.path(), &reporter, &clock).await;

        assert!(outcome.success, "outcome: {outcome:?}");
        assert_eq!(
            transport.request_log(),
            vec![("http://stub/a.bin".to_string(), None)]
        );
        assert_eq!(
            std::fs::read(file_path(dir.path(), &m, &m.files[0])).expect("read"),
            full
        );
    }

    #[tokio::test]
    async fn hash_mismatch_deletes_file_and_reports_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let body = b"abcdef".to_vec();
        let m = manifest(vec![spec(
            "model",
            "a.bin",
            "http://stub/a.bin",
            body.len() as u64,
            Some("0".repeat(64)),
        )]);
        let transport = FakeTransport::new();
        transport.insert(
            "http://stub/a.bin",
            FakeFile {
                body: body.clone(),
                mode: FakeMode::Full,
                chunk_size: 8,
            },
        );
        let reporter = RecordingReporter::default();
        let clock = ManualClock::new();

        let outcome = download_missing_files(&transport, &m, dir.path(), &reporter, &clock).await;

        assert!(!outcome.success);
        assert_eq!(outcome.files[0].state, FileState::Error);
        assert!(outcome
            .error
            .as_deref()
            .expect("error")
            .contains("SHA-256 mismatch"));
        assert!(
            !file_path(dir.path(), &m, &m.files[0]).exists(),
            "mismatched file must be deleted"
        );
        assert_eq!(
            transport.request_log().len(),
            1,
            "a SHA-256 mismatch (corrupt data) must not be retried"
        );
    }

    #[tokio::test]
    async fn transport_error_is_isolated_and_run_continues() {
        let dir = tempfile::tempdir().expect("tempdir");
        let good_body = b"abcd".to_vec();
        let m = manifest(vec![
            spec("model", "model.bin", "http://stub/bad", 3, None),
            spec(
                "vision",
                "vision.bin",
                "http://stub/good",
                good_body.len() as u64,
                Some(sha256_hex(&good_body)),
            ),
        ]);
        let transport = FakeTransport::new();
        transport.insert(
            "http://stub/bad",
            FakeFile {
                body: Vec::new(),
                mode: FakeMode::Http(500),
                chunk_size: 8,
            },
        );
        transport.insert(
            "http://stub/good",
            FakeFile {
                body: good_body.clone(),
                mode: FakeMode::Full,
                chunk_size: 2,
            },
        );
        let reporter = RecordingReporter::default();
        let clock = ManualClock::new();

        let outcome = download_missing_files(&transport, &m, dir.path(), &reporter, &clock).await;

        assert!(!outcome.success);
        assert_eq!(outcome.files.len(), 2);
        assert_eq!(outcome.files[0].state, FileState::Error);
        assert_eq!(outcome.files[1].state, FileState::Present);
        assert_eq!(
            std::fs::read(file_path(dir.path(), &m, &m.files[1])).expect("read"),
            good_body
        );
        let urls: Vec<String> = transport
            .request_log()
            .into_iter()
            .map(|(url, _)| url)
            .collect();
        assert!(urls.contains(&"http://stub/bad".to_string()));
        assert!(urls.contains(&"http://stub/good".to_string()));
    }

    #[tokio::test]
    async fn short_body_is_an_error_not_a_false_success() {
        let dir = tempfile::tempdir().expect("tempdir");
        let m = manifest(vec![spec("model", "a.bin", "http://stub/a.bin", 20, None)]);
        let transport = FakeTransport::new();
        transport.insert(
            "http://stub/a.bin",
            FakeFile {
                body: b"short".to_vec(),
                mode: FakeMode::Full,
                chunk_size: 2,
            },
        );
        let reporter = RecordingReporter::default();
        let clock = ManualClock::new();

        let outcome = download_missing_files(&transport, &m, dir.path(), &reporter, &clock).await;

        assert!(!outcome.success);
        assert_eq!(outcome.files[0].state, FileState::Error);
        assert!(outcome
            .error
            .as_deref()
            .expect("error")
            .contains("incomplete download"));
    }

    #[tokio::test]
    async fn omitted_sha256_verifies_by_size_only() {
        let dir = tempfile::tempdir().expect("tempdir");
        let body = b"1234567".to_vec();
        let m = manifest(vec![spec(
            "mtp",
            "MTP/a.bin",
            "http://stub/a.bin",
            body.len() as u64,
            None,
        )]);
        let transport = FakeTransport::new();
        transport.insert(
            "http://stub/a.bin",
            FakeFile {
                body: body.clone(),
                mode: FakeMode::Full,
                chunk_size: 3,
            },
        );
        let reporter = RecordingReporter::default();
        let clock = ManualClock::new();

        let outcome = download_missing_files(&transport, &m, dir.path(), &reporter, &clock).await;

        assert!(outcome.success, "outcome: {outcome:?}");
        assert_eq!(outcome.files[0].state, FileState::Present);
        assert_eq!(
            std::fs::read(file_path(dir.path(), &m, &m.files[0])).expect("read"),
            body
        );
    }

    #[tokio::test]
    async fn mid_stream_failure_is_isolated_and_partial_file_survives_for_resume() {
        let dir = tempfile::tempdir().expect("tempdir");
        let body: Vec<u8> = (0..20u8).collect();
        let m = manifest(vec![spec("model", "a.bin", "http://stub/a.bin", 20, None)]);
        let transport = FakeTransport::new();
        transport.insert(
            "http://stub/a.bin",
            FakeFile {
                body: body.clone(),
                mode: FakeMode::FailAfter(8),
                chunk_size: 4,
            },
        );
        let reporter = RecordingReporter::default();
        let clock = ManualClock::new();

        let outcome = download_missing_files(&transport, &m, dir.path(), &reporter, &clock).await;

        assert!(!outcome.success);
        assert_eq!(outcome.files[0].state, FileState::Error);
        assert_eq!(
            std::fs::read(file_path(dir.path(), &m, &m.files[0]))
                .expect("partial file survives")
                .len(),
            8
        );
    }

    #[tokio::test]
    async fn mid_stream_body_error_is_retried_from_persisted_offset_until_success() {
        let dir = tempfile::tempdir().expect("tempdir");
        let full: Vec<u8> = (0..20u8).collect();
        let m = manifest(vec![spec(
            "model",
            "a.bin",
            "http://stub/a.bin",
            full.len() as u64,
            Some(sha256_hex(&full)),
        )]);
        let transport = FakeTransport::new();
        transport.insert(
            "http://stub/a.bin",
            FakeFile {
                body: full.clone(),
                mode: FakeMode::FailFirstAfter {
                    attempts: 1,
                    fail_after: 8,
                },
                chunk_size: 4,
            },
        );
        let reporter = RecordingReporter::default();
        let clock = ManualClock::new();

        let outcome = download_missing_files(&transport, &m, dir.path(), &reporter, &clock).await;

        assert!(outcome.success, "outcome: {outcome:?}");
        assert_eq!(outcome.files[0].state, FileState::Present);
        // Attempt 1 has no range (offset 0) and fails after 8 bytes; attempt 2
        // resumes from the persisted 8-byte offset.
        assert_eq!(
            transport.request_log(),
            vec![
                ("http://stub/a.bin".to_string(), None),
                ("http://stub/a.bin".to_string(), Some(8)),
            ]
        );
        assert_eq!(
            std::fs::read(file_path(dir.path(), &m, &m.files[0])).expect("read"),
            full
        );
        assert!(
            reporter
                .events()
                .iter()
                .all(|event| event.state != ProgressState::Error),
            "a retried body error must never surface a per-file Error"
        );
    }

    #[tokio::test]
    async fn exhausted_retries_surface_terminal_error_and_preserve_partial() {
        let dir = tempfile::tempdir().expect("tempdir");
        let body: Vec<u8> = (0..20u8).collect();
        let m = manifest(vec![spec("model", "a.bin", "http://stub/a.bin", 20, None)]);
        let transport = FakeTransport::new();
        transport.insert(
            "http://stub/a.bin",
            FakeFile {
                body: body.clone(),
                mode: FakeMode::FailAfter(4),
                chunk_size: 2,
            },
        );
        let reporter = RecordingReporter::default();
        let clock = ManualClock::new();

        let outcome = download_missing_files(&transport, &m, dir.path(), &reporter, &clock).await;

        assert!(!outcome.success);
        assert_eq!(outcome.files[0].state, FileState::Error);
        // The bounded budget caps the attempts; the partial survives for a resume.
        assert_eq!(
            transport.request_log().len(),
            MAX_DOWNLOAD_ATTEMPTS,
            "the bounded retry budget must cap the attempts"
        );
        assert_eq!(
            std::fs::read(file_path(dir.path(), &m, &m.files[0]))
                .expect("partial file survives")
                .len(),
            4
        );
        assert!(reporter
            .events()
            .iter()
            .any(|event| event.state == ProgressState::Error));
    }

    #[tokio::test]
    async fn resumed_download_seeds_hasher_with_on_disk_prefix_and_matches_digest() {
        let dir = tempfile::tempdir().expect("tempdir");
        let full: Vec<u8> = (0..32u8).collect();
        let expected_sha = sha256_hex(&full);
        let m = manifest(vec![spec(
            "vision",
            "a.bin",
            "http://stub/a.bin",
            full.len() as u64,
            Some(expected_sha.clone()),
        )]);
        seed_file(dir.path(), &m, &m.files[0], &full[..12]);

        let transport = FakeTransport::new();
        transport.insert(
            "http://stub/a.bin",
            FakeFile {
                body: full.clone(),
                mode: FakeMode::Range,
                chunk_size: 5,
            },
        );
        let reporter = RecordingReporter::default();
        let clock = ManualClock::new();

        let outcome = download_missing_files(&transport, &m, dir.path(), &reporter, &clock).await;

        // The request offset equals the seeded prefix length; the final digest
        // must cover prefix + newly streamed bytes.
        assert_eq!(
            transport.request_log(),
            vec![("http://stub/a.bin".to_string(), Some(12))]
        );
        assert!(outcome.success, "outcome: {outcome:?}");
        let on_disk = std::fs::read(file_path(dir.path(), &m, &m.files[0])).expect("read");
        assert_eq!(on_disk, full);
        assert_eq!(sha256_hex(&on_disk), expected_sha);
    }

    #[test]
    fn throttle_coalesces_to_at_most_one_event_per_interval() {
        let mut throttle = Throttle::new();
        let t0 = Instant::now();
        assert!(throttle.due(t0, PROGRESS_MIN_INTERVAL));
        assert!(!throttle.due(t0 + Duration::from_millis(50), PROGRESS_MIN_INTERVAL));
        assert!(!throttle.due(t0 + Duration::from_millis(99), PROGRESS_MIN_INTERVAL));
        assert!(throttle.due(t0 + Duration::from_millis(100), PROGRESS_MIN_INTERVAL));
        assert!(!throttle.due(t0 + Duration::from_millis(150), PROGRESS_MIN_INTERVAL));
        assert!(throttle.due(t0 + Duration::from_millis(200), PROGRESS_MIN_INTERVAL));
    }

    #[tokio::test]
    async fn many_chunks_do_not_emit_a_per_chunk_event() {
        let dir = tempfile::tempdir().expect("tempdir");
        let body: Vec<u8> = (0..1024u32).map(|n| n as u8).collect();
        let m = manifest(vec![spec(
            "model",
            "a.bin",
            "http://stub/a.bin",
            body.len() as u64,
            Some(sha256_hex(&body)),
        )]);
        let transport = FakeTransport::new();
        transport.insert(
            "http://stub/a.bin",
            FakeFile {
                body: body.clone(),
                mode: FakeMode::Full,
                chunk_size: 1,
            },
        );
        let reporter = RecordingReporter::default();
        let clock = ManualClock::new();

        let outcome = download_missing_files(&transport, &m, dir.path(), &reporter, &clock).await;

        assert!(outcome.success, "outcome: {outcome:?}");
        let events = reporter.events();
        let downloading = events
            .iter()
            .filter(|e| e.state == ProgressState::Downloading)
            .count();
        assert_eq!(
            downloading, 1,
            "a frozen clock must coalesce to the single opening event"
        );
        assert_eq!(events.len(), 2, "opening + terminal only");
        assert_eq!(events[0].state, ProgressState::Downloading);
        assert_eq!(events[1].state, ProgressState::Present);
    }

    #[tokio::test]
    async fn progress_is_monotonic_per_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let body: Vec<u8> = (0..100u32).map(|n| n as u8).collect();
        let m = manifest(vec![spec(
            "vision",
            "a.bin",
            "http://stub/a.bin",
            body.len() as u64,
            Some(sha256_hex(&body)),
        )]);
        let transport = FakeTransport::new();
        transport.insert(
            "http://stub/a.bin",
            FakeFile {
                body: body.clone(),
                mode: FakeMode::Full,
                chunk_size: 7,
            },
        );
        let reporter = RecordingReporter::default();
        let clock = AutoAdvanceClock {
            now: Mutex::new(Instant::now()),
            step: Duration::from_millis(150),
        };

        let outcome = download_missing_files(&transport, &m, dir.path(), &reporter, &clock).await;

        assert!(outcome.success, "outcome: {outcome:?}");
        let events = reporter.events();
        assert!(
            events.len() > 3,
            "auto-advancing clock should emit multiple updates"
        );
        let mut previous = 0u64;
        for event in &events {
            assert!(
                event.downloaded >= previous,
                "downloaded must be monotonic: {previous} -> {}",
                event.downloaded
            );
            previous = event.downloaded;
        }
        assert_eq!(events.last().expect("terminal").state, ProgressState::Present);
    }

    #[tokio::test]
    async fn processes_files_in_manifest_order_and_skips_present_ones() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vision_body = b"abcde".to_vec();
        let m = manifest(vec![
            spec("model", "model.bin", "http://stub/model", 4, None),
            spec(
                "vision",
                "vision.bin",
                "http://stub/vision",
                vision_body.len() as u64,
                Some(sha256_hex(&vision_body)),
            ),
            spec("mtp", "MTP/mtp.bin", "http://stub/mtp", 6, None),
        ]);
        seed_file(dir.path(), &m, &m.files[0], b"1234");
        seed_file(dir.path(), &m, &m.files[2], b"123456");

        let transport = FakeTransport::new();
        transport.insert(
            "http://stub/vision",
            FakeFile {
                body: vision_body.clone(),
                mode: FakeMode::Full,
                chunk_size: 2,
            },
        );
        let reporter = RecordingReporter::default();
        let clock = ManualClock::new();

        let outcome = download_missing_files(&transport, &m, dir.path(), &reporter, &clock).await;

        assert!(outcome.success, "outcome: {outcome:?}");
        let ids: Vec<&str> = outcome.files.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, vec!["model", "vision", "mtp"]);
        assert!(outcome.files.iter().all(|f| f.state == FileState::Present));
        assert_eq!(
            transport.request_log(),
            vec![("http://stub/vision".to_string(), None)]
        );
    }

    #[tokio::test]
    async fn empty_manifest_is_not_reported_successful() {
        let dir = tempfile::tempdir().expect("tempdir");
        let m = manifest(Vec::new());
        let transport = FakeTransport::new();
        let reporter = RecordingReporter::default();
        let clock = ManualClock::new();

        let outcome = download_missing_files(&transport, &m, dir.path(), &reporter, &clock).await;

        assert!(!outcome.success);
        assert!(outcome.files.is_empty());
        assert!(outcome.error.is_none());
    }
}
