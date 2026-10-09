//! Doom asset acquisition (Spec #2968, ST-4).
//!
//! Acquisition goes through Fredo's ONE SHA-256-pinned streaming engine
//! ([`download_missing_files`] via [`crate::infrastructure::companion::download`])
//! so the Doom path never forks a second downloader (NFR-6). Two artifacts:
//!
//! * **Freedoom IWAD** — the libre game data, pinned by URL + SHA-256 (ST-1:
//!   `freedoom-0.13.0.zip`). Downloaded, then `freedoom1.wad` is extracted with
//!   the minimal in-module ZIP reader (the shared engine downloads a file; it is
//!   not an archive extractor, and no zip crate is a direct dependency).
//! * **Engine** — ST-1 found **no trustworthy prebuilt** RESTful-DOOM archive, so
//!   runtime-download is **deferred** and there is **no default URL**. The
//!   `FREDO_DOOM_ARCHIVE_URL` / `_SHA256` / `_BYTES` env-override mechanism is
//!   declared so a future pinned asset can be enabled; when no URL is configured
//!   [`acquire_engine`] returns `Ok(None)` and the caller falls back to the
//!   user-supplied `doom_engine_path` (never a bogus download, never a build
//!   failure). When a URL *is* configured, an unverified/unsized download is
//!   refused.
//!
//! Every failure is surfaced as a human-readable `Err`, which the launch command
//! maps to [`DoomErrorCode::AcquireFailed`].
//!
//! [`DoomErrorCode::AcquireFailed`]: super::state::DoomErrorCode::AcquireFailed

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;
use futures_util::StreamExt;
use tauri::AppHandle;

use crate::infrastructure::companion::download::{
    download_missing_files, BoxFuture, DownloadProgress, HttpRange, HttpResponse, HttpTransport,
    ProgressReporter, ReqwestTransport, SystemClock,
};
use crate::infrastructure::companion::models::{file_path, ModelFileSpec, ModelManifest};

// ── Freedoom (libre IWAD) — the pinned ST-1 artifact ─────────────────────────

/// Pinned Freedoom release version.
pub const FREEDOOM_VERSION: &str = "0.13.0";
/// Pinned Freedoom release archive URL (ST-1 `freedoom-iwad.md`).
pub const FREEDOOM_ARCHIVE_URL: &str =
    "https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip";
/// SHA-256 of [`FREEDOOM_ARCHIVE_URL`] (from the release's PGP-signed CHECKSUM).
pub const FREEDOOM_ARCHIVE_SHA256: &str =
    "3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59";
/// Network-transfer size of the pinned archive (release asset metadata).
pub const FREEDOOM_ARCHIVE_BYTES: u64 = 24_143_781;
/// Staged archive filename inside [`FREEDOOM_SUBDIR`].
pub const FREEDOOM_ARCHIVE_FILENAME: &str = "freedoom-0.13.0.zip";
/// Layout subdirectory under the install dir holding the Freedoom artifacts.
pub const FREEDOOM_SUBDIR: &str = "freedoom";
/// The Phase-1 IWAD extracted from the archive (Ultimate-Doom-compatible).
pub const DOOM_IWAD_FILENAME: &str = "freedoom1.wad";

// ── Engine archive — deferred, env-configured only (ST-1) ────────────────────

/// Layout subdirectory under the install dir holding the staged engine.
pub const DOOM_ENGINE_SUBDIR: &str = "engine";
/// The engine executable basename inside the staged engine dir.
pub const DOOM_ENGINE_EXE: &str = "restful-doom.exe";
/// Staged engine archive filename inside [`DOOM_ENGINE_SUBDIR`].
pub const DOOM_ENGINE_ARCHIVE_FILENAME: &str = "restful-doom.zip";
/// **No default prebuilt engine archive URL** (ST-1: the fork is source-only).
/// Runtime-download is deferred; the engine is user-supplied by default.
pub const DOOM_ENGINE_ARCHIVE_URL_DEFAULT: &str = "";

/// **G-275** induction seam: override the engine archive URL (point at an
/// unreachable endpoint to drive the `acquireFailed` row). Inert when unset.
pub const DOOM_ARCHIVE_URL_ENV: &str = "FREDO_DOOM_ARCHIVE_URL";
/// **G-275** induction seam: override the pinned engine archive digest. Inert
/// when unset. Required whenever [`DOOM_ARCHIVE_URL_ENV`] is set.
pub const DOOM_ARCHIVE_SHA256_ENV: &str = "FREDO_DOOM_ARCHIVE_SHA256";
/// Exact byte size of the configured engine archive. Required whenever
/// [`DOOM_ARCHIVE_URL_ENV`] is set — the shared streaming engine gates on the
/// exact on-disk size, so an unknown size cannot be verified.
pub const DOOM_ARCHIVE_BYTES_ENV: &str = "FREDO_DOOM_ARCHIVE_BYTES";

/// Finite total bound on one acquisition (G-263: no unbounded wait).
pub const DOOM_ACQUIRE_TIMEOUT_S: u64 = 120;

/// A non-blank environment value, trimmed; `None` when unset or blank.
fn non_blank_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// The configured engine archive URL, or `None` when unconfigured (the shipped
/// default — engine acquisition falls back to the user-supplied path).
pub fn resolve_engine_archive_url() -> Option<String> {
    non_blank_env(DOOM_ARCHIVE_URL_ENV)
}

/// The configured engine archive digest, or `None` when unconfigured.
pub fn resolve_engine_archive_sha256() -> Option<String> {
    non_blank_env(DOOM_ARCHIVE_SHA256_ENV)
}

/// The configured engine archive byte size, or `None` when unconfigured/invalid.
pub fn resolve_engine_archive_bytes() -> Option<u64> {
    non_blank_env(DOOM_ARCHIVE_BYTES_ENV).and_then(|value| value.parse().ok())
}

/// Whether an engine archive download is configured at all.
pub fn engine_archive_configured() -> bool {
    resolve_engine_archive_url().is_some()
}

/// The one-file Freedoom manifest handed to the shared streaming engine.
pub fn freedoom_archive_manifest() -> ModelManifest {
    ModelManifest {
        revision: FREEDOOM_VERSION.to_string(),
        subdir: FREEDOOM_SUBDIR.to_string(),
        files: vec![ModelFileSpec {
            id: "freedoom".to_string(),
            path: FREEDOOM_ARCHIVE_FILENAME.to_string(),
            url: FREEDOOM_ARCHIVE_URL.to_string(),
            expected_bytes: FREEDOOM_ARCHIVE_BYTES,
            sha256: Some(FREEDOOM_ARCHIVE_SHA256.to_string()),
        }],
    }
}

/// The one-file engine manifest for a configured archive.
pub fn engine_archive_manifest(url: &str, sha256: &str, expected_bytes: u64) -> ModelManifest {
    ModelManifest {
        revision: "engine".to_string(),
        subdir: DOOM_ENGINE_SUBDIR.to_string(),
        files: vec![ModelFileSpec {
            id: "engine".to_string(),
            path: DOOM_ENGINE_ARCHIVE_FILENAME.to_string(),
            url: url.to_string(),
            expected_bytes,
            sha256: Some(sha256.to_string()),
        }],
    }
}

/// `<install_dir>/freedoom/freedoom-0.13.0.zip` — the manifest's ONE path rule.
pub fn freedoom_archive_path(install_dir: &Path) -> PathBuf {
    install_dir.join(FREEDOOM_SUBDIR).join(FREEDOOM_ARCHIVE_FILENAME)
}

/// `<install_dir>/freedoom/freedoom1.wad` — the extracted IWAD.
pub fn freedoom_iwad_path(install_dir: &Path) -> PathBuf {
    install_dir.join(FREEDOOM_SUBDIR).join(DOOM_IWAD_FILENAME)
}

/// `<install_dir>/engine/restful-doom.exe` — the extracted engine.
pub fn engine_exe_path(install_dir: &Path) -> PathBuf {
    install_dir.join(DOOM_ENGINE_SUBDIR).join(DOOM_ENGINE_EXE)
}

/// No-op progress sink: acquisition is a headless staging step; progress is not
/// surfaced through the Companion `setup:download-progress` channel.
struct NoopReporter;

impl ProgressReporter for NoopReporter {
    fn report(&self, _progress: DownloadProgress) {}
}

/// Acquire + verify one archive through the shared streaming engine with an
/// injected transport + progress sink (Spec #3012 ST-2 reuses this for the
/// managed toolchain, streaming its download progress to the provisioner).
/// Returns the on-disk archive path on success.
pub async fn acquire_archive_with(
    transport: &dyn HttpTransport,
    install_dir: &Path,
    manifest: &ModelManifest,
    reporter: &dyn ProgressReporter,
) -> Result<PathBuf, String> {
    let outcome =
        download_missing_files(transport, manifest, install_dir, reporter, &SystemClock).await;
    if !outcome.success {
        return Err(outcome
            .error
            .unwrap_or_else(|| format!("acquisition of {} failed", manifest.subdir)));
    }
    Ok(file_path(install_dir, manifest, &manifest.files[0]))
}

/// Acquire + verify one archive through the shared streaming engine. Returns the
/// on-disk archive path on success.
async fn acquire_archive(
    install_dir: &Path,
    manifest: &ModelManifest,
) -> Result<PathBuf, String> {
    let transport =
        ReqwestTransport::new().map_err(|e| format!("could not build the download client: {e}"))?;
    acquire_archive_with(&transport, install_dir, manifest, &NoopReporter).await
}

/// Acquire the pinned Freedoom archive and extract `freedoom1.wad`.
///
/// Returns the extracted IWAD path. Any download/verify/extract failure is an
/// `Err` → the caller maps it to `AcquireFailed`.
pub async fn acquire_iwad(app: &AppHandle) -> Result<Option<String>, String> {
    let install_dir = super::process::resolve_install_dir(app)?;
    let manifest = freedoom_archive_manifest();
    let archive = match tokio::time::timeout(
        Duration::from_secs(DOOM_ACQUIRE_TIMEOUT_S),
        acquire_archive(&install_dir, &manifest),
    )
    .await
    {
        Ok(result) => result?,
        Err(_) => {
            return Err(format!(
                "the Freedoom IWAD download did not finish within {DOOM_ACQUIRE_TIMEOUT_S}s"
            ))
        }
    };
    let iwad = extract_freedoom_iwad(&archive, &install_dir)?;
    Ok(Some(iwad))
}

/// Acquire + extract the engine archive when one is configured.
///
/// `Ok(None)` when no archive URL is configured (the shipped default: the engine
/// is user-supplied). `Err` on any download/verify/extract failure.
pub async fn acquire_engine(app: &AppHandle) -> Result<Option<String>, String> {
    let Some(url) = resolve_engine_archive_url() else {
        return Ok(None);
    };
    let sha = resolve_engine_archive_sha256().ok_or_else(|| {
        format!(
            "an engine archive URL is configured but {DOOM_ARCHIVE_SHA256_ENV} is not — refusing an unverified download"
        )
    })?;
    let bytes = resolve_engine_archive_bytes().ok_or_else(|| {
        format!(
            "an engine archive URL is configured but {DOOM_ARCHIVE_BYTES_ENV} is not — the shared download engine requires the exact byte size"
        )
    })?;

    let install_dir = super::process::resolve_install_dir(app)?;
    let manifest = engine_archive_manifest(&url, &sha, bytes);
    let archive = match tokio::time::timeout(
        Duration::from_secs(DOOM_ACQUIRE_TIMEOUT_S),
        acquire_archive(&install_dir, &manifest),
    )
    .await
    {
        Ok(result) => result?,
        Err(_) => {
            return Err(format!(
                "the engine archive download did not finish within {DOOM_ACQUIRE_TIMEOUT_S}s"
            ))
        }
    };
    let exe = extract_engine_exe(&archive, &install_dir)?;
    Ok(Some(exe))
}

// ── Local-file transport (Spec #3012 ST-2) ───────────────────────────────────

/// Whether `url` is a LOCAL source (`file://` URL or a plain filesystem path)
/// rather than an `http(s)://` URL. The provisioning archive seam accepts both
/// so a small in-repo craft archive can drive the error/extract legs.
pub fn is_local_source(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    !(lower.starts_with("http://") || lower.starts_with("https://"))
}

/// Map a `file://` URL or a plain path to an OS filesystem path. Handles the
/// Windows `file:///C:/…` drive form (the leading `/` before the drive letter is
/// dropped).
pub fn local_source_path(url: &str) -> PathBuf {
    let trimmed = url.trim();
    let rest = trimmed
        .strip_prefix("file://")
        .or_else(|| trimmed.strip_prefix("FILE://"))
        .unwrap_or(trimmed);
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    let mut path = rest.to_string();
    #[cfg(windows)]
    {
        let bytes = path.as_bytes();
        if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':'
        {
            path.remove(0);
        }
    }
    PathBuf::from(path)
}

/// [`HttpTransport`] over the local filesystem — reqwest cannot serve a
/// `file://` URL or a plain path, so the provisioning archive seam routes local
/// sources here. The shared engine's exact-size + SHA-256 gating is unchanged;
/// `Range` is honoured with a `206` so resume works exactly as over HTTP.
pub struct LocalFileTransport;

impl LocalFileTransport {
    /// A stateless local transport.
    pub fn new() -> Self {
        Self
    }
}

impl Default for LocalFileTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpTransport for LocalFileTransport {
    fn get<'a>(
        &'a self,
        url: &'a str,
        range: Option<HttpRange>,
    ) -> BoxFuture<'a, anyhow::Result<HttpResponse>> {
        Box::pin(async move {
            let path = local_source_path(url);
            let mut file = tokio::fs::File::open(&path)
                .await
                .with_context(|| format!("could not open local archive {}", path.display()))?;
            let len = file.metadata().await.map(|meta| meta.len()).unwrap_or(0);
            let start = range.map(|r| r.start).unwrap_or(0).min(len);
            if start > 0 {
                use tokio::io::AsyncSeekExt;
                file.seek(std::io::SeekFrom::Start(start))
                    .await
                    .with_context(|| format!("could not seek {}", path.display()))?;
            }
            let status = if range.is_some() { 206u16 } else { 200u16 };
            let body: crate::infrastructure::companion::download::ByteStream =
                Box::pin(tokio_util::io::ReaderStream::new(file).map(|res| res.map_err(anyhow::Error::from)));
            Ok(HttpResponse { status, body })
        })
    }
}

// ── Extraction ────────────────────────────────────────────────────────────────

fn extract_freedoom_iwad(archive: &Path, install_dir: &Path) -> Result<String, String> {
    let bytes = std::fs::read(archive)
        .map_err(|e| format!("could not read the Freedoom archive {}: {e}", archive.display()))?;
    let out_dir = install_dir.join(FREEDOOM_SUBDIR);
    let dest = extract_zip_entry(&bytes, DOOM_IWAD_FILENAME, &out_dir)?;
    Ok(dest.to_string_lossy().into_owned())
}

fn extract_engine_exe(archive: &Path, install_dir: &Path) -> Result<String, String> {
    let bytes = std::fs::read(archive)
        .map_err(|e| format!("could not read the engine archive {}: {e}", archive.display()))?;
    let out_dir = install_dir.join(DOOM_ENGINE_SUBDIR);
    let dest = extract_zip_first_exe(&bytes, &out_dir)?;
    Ok(dest.to_string_lossy().into_owned())
}

// ── Minimal ZIP reader (stored + raw-deflate) ────────────────────────────────

const ZIP_LOCAL_SIG: [u8; 4] = *b"PK\x03\x04";
const ZIP_CENTRAL_SIG: [u8; 4] = *b"PK\x01\x02";
const ZIP_EOCD_SIG: [u8; 4] = *b"PK\x05\x06";

struct ZipEntry {
    name: String,
    method: u16,
    compressed_size: usize,
    uncompressed_size: usize,
    local_offset: usize,
}

fn has_sig(bytes: &[u8], at: usize, sig: &[u8; 4]) -> bool {
    bytes.get(at..).is_some_and(|rest| rest.starts_with(sig))
}

fn read_u16(bytes: &[u8], at: usize) -> Option<u16> {
    let slice = bytes.get(at..at.checked_add(2)?)?;
    Some(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32(bytes: &[u8], at: usize) -> Option<u32> {
    let slice = bytes.get(at..at.checked_add(4)?)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_slice(bytes: &[u8], at: usize, len: usize) -> Option<&[u8]> {
    bytes.get(at..at.checked_add(len)?)
}

/// Locate the end-of-central-directory record (scanning the final 64 KiB+22).
fn find_eocd(bytes: &[u8]) -> Option<usize> {
    let len = bytes.len();
    if len < 22 {
        return None;
    }
    let start = len.saturating_sub(65_557);
    (start..=len - 4)
        .rev()
        .find(|&i| has_sig(bytes, i, &ZIP_EOCD_SIG))
}

fn truncated_zip() -> String {
    "truncated ZIP archive".to_string()
}

/// Parse the central directory into entries (filename, method, sizes, offset).
fn zip_entries(bytes: &[u8]) -> Result<Vec<ZipEntry>, String> {
    let truncated = truncated_zip;
    let eocd = find_eocd(bytes)
        .ok_or_else(|| "not a ZIP archive (no end-of-central-directory record)".to_string())?;
    let count = read_u16(bytes, eocd + 10).ok_or_else(truncated)? as usize;
    let cd_offset = read_u32(bytes, eocd + 16).ok_or_else(truncated)? as usize;

    let mut entries = Vec::with_capacity(count);
    let mut cursor = cd_offset;
    for _ in 0..count {
        if !has_sig(bytes, cursor, &ZIP_CENTRAL_SIG) {
            return Err("corrupt ZIP central directory (bad record signature)".to_string());
        }
        let method = read_u16(bytes, cursor + 10).ok_or_else(truncated)?;
        let compressed_size = read_u32(bytes, cursor + 20).ok_or_else(truncated)? as usize;
        let uncompressed_size = read_u32(bytes, cursor + 24).ok_or_else(truncated)? as usize;
        let name_len = read_u16(bytes, cursor + 28).ok_or_else(truncated)? as usize;
        let extra_len = read_u16(bytes, cursor + 30).ok_or_else(truncated)? as usize;
        let comment_len = read_u16(bytes, cursor + 32).ok_or_else(truncated)? as usize;
        let local_offset = read_u32(bytes, cursor + 42).ok_or_else(truncated)? as usize;
        let name_bytes = read_slice(bytes, cursor + 46, name_len)
            .ok_or_else(|| "truncated ZIP entry name".to_string())?;
        entries.push(ZipEntry {
            name: String::from_utf8_lossy(name_bytes).into_owned(),
            method,
            compressed_size,
            uncompressed_size,
            local_offset,
        });
        cursor = cursor + 46 + name_len + extra_len + comment_len;
    }
    Ok(entries)
}

/// Decode one entry's payload (method 0 = stored, 8 = raw deflate).
fn extract_entry_data(bytes: &[u8], entry: &ZipEntry) -> Result<Vec<u8>, String> {
    if !has_sig(bytes, entry.local_offset, &ZIP_LOCAL_SIG) {
        return Err("corrupt ZIP local header".to_string());
    }
    let name_len = read_u16(bytes, entry.local_offset + 26)
        .ok_or_else(|| "truncated ZIP local header".to_string())? as usize;
    let extra_len = read_u16(bytes, entry.local_offset + 28)
        .ok_or_else(|| "truncated ZIP local header".to_string())? as usize;
    let data_start = entry.local_offset + 30 + name_len + extra_len;
    let compressed = read_slice(bytes, data_start, entry.compressed_size)
        .ok_or_else(|| "truncated ZIP entry data".to_string())?;

    let raw = match entry.method {
        0 => compressed.to_vec(),
        8 => {
            let mut decoder = flate2::read::DeflateDecoder::new(compressed);
            let mut out = Vec::with_capacity(entry.uncompressed_size);
            decoder
                .read_to_end(&mut out)
                .map_err(|e| format!("ZIP inflate failed: {e}"))?;
            out
        }
        other => return Err(format!("unsupported ZIP compression method {other}")),
    };

    if raw.len() != entry.uncompressed_size {
        return Err(format!(
            "ZIP entry size mismatch: decoded {} of {} bytes",
            raw.len(),
            entry.uncompressed_size
        ));
    }
    Ok(raw)
}

/// Extract one named entry (matched by full path or basename) to `dest_dir`.
pub fn extract_zip_entry(
    bytes: &[u8],
    entry_name: &str,
    dest_dir: &Path,
) -> Result<PathBuf, String> {
    let entries = zip_entries(bytes)?;
    let entry = entries
        .iter()
        .find(|e| {
            e.name == entry_name || e.name.rsplit(['/', '\\']).next() == Some(entry_name)
        })
        .ok_or_else(|| format!("entry {entry_name} not found in the ZIP archive"))?;
    let data = extract_entry_data(bytes, entry)?;
    std::fs::create_dir_all(dest_dir)
        .map_err(|e| format!("could not create {}: {e}", dest_dir.display()))?;
    let dest = dest_dir.join(entry_name);
    std::fs::write(&dest, &data).map_err(|e| format!("could not write {}: {e}", dest.display()))?;
    Ok(dest)
}

/// Extract the first `.exe` entry to `dest_dir` (engine archive), returning its path.
pub fn extract_zip_first_exe(bytes: &[u8], dest_dir: &Path) -> Result<PathBuf, String> {
    let entries = zip_entries(bytes)?;
    let entry = entries
        .iter()
        .find(|e| e.name.to_ascii_lowercase().ends_with(".exe"))
        .ok_or_else(|| "no .exe entry found in the engine archive".to_string())?;
    let data = extract_entry_data(bytes, entry)?;
    let file_name = entry
        .name
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(DOOM_ENGINE_EXE);
    std::fs::create_dir_all(dest_dir)
        .map_err(|e| format!("could not create {}: {e}", dest_dir.display()))?;
    let dest = dest_dir.join(file_name);
    std::fs::write(&dest, &data).map_err(|e| format!("could not write {}: {e}", dest.display()))?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::companion::download::ByteStream;
    use std::io::Write;

    /// Build an in-memory ZIP with stored (`deflate=false`) or deflated entries.
    fn build_zip(entries: &[(&str, &[u8], bool)]) -> Vec<u8> {
        let mut out: Vec<u8> = Vec::new();
        let mut central: Vec<u8> = Vec::new();
        for (name, data, deflate) in entries {
            let offset = out.len();
            let (method, payload): (u16, Vec<u8>) = if *deflate {
                let mut encoder =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                encoder.write_all(data).expect("deflate");
                (8, encoder.finish().expect("finish"))
            } else {
                (0, data.to_vec())
            };

            // Local file header.
            out.extend_from_slice(&ZIP_LOCAL_SIG);
            out.extend_from_slice(&10u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&method.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&payload);

            // Central directory record.
            central.extend_from_slice(&ZIP_CENTRAL_SIG);
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&10u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&method.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u32.to_le_bytes());
            central.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u32.to_le_bytes());
            central.extend_from_slice(&(offset as u32).to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }

        let cd_offset = out.len();
        let cd_size = central.len();
        out.extend_from_slice(&central);

        out.extend_from_slice(&ZIP_EOCD_SIG);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(cd_size as u32).to_le_bytes());
        out.extend_from_slice(&(cd_offset as u32).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    #[test]
    fn freedoom_manifest_pins_the_st_1_artifact() {
        let manifest = freedoom_archive_manifest();
        assert_eq!(manifest.revision, FREEDOOM_VERSION);
        assert_eq!(manifest.subdir, FREEDOOM_SUBDIR);
        assert_eq!(manifest.files.len(), 1);
        let spec = &manifest.files[0];
        assert_eq!(spec.path, FREEDOOM_ARCHIVE_FILENAME);
        assert_eq!(spec.url, FREEDOOM_ARCHIVE_URL);
        assert_eq!(spec.expected_bytes, FREEDOOM_ARCHIVE_BYTES);
        assert_eq!(spec.sha256.as_deref(), Some(FREEDOOM_ARCHIVE_SHA256));
        assert_eq!(FREEDOOM_ARCHIVE_SHA256.len(), 64);
        assert!(FREEDOOM_ARCHIVE_SHA256
            .chars()
            .all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn there_is_no_default_engine_archive_url() {
        // ST-1: no trustworthy prebuilt exists, so runtime-download is deferred.
        assert!(DOOM_ENGINE_ARCHIVE_URL_DEFAULT.is_empty());
        // The env seam is inert when unset (the shipped default).
        if std::env::var(DOOM_ARCHIVE_URL_ENV).is_err() {
            assert!(!engine_archive_configured());
            assert_eq!(resolve_engine_archive_url(), None);
        }
    }

    #[test]
    fn archive_paths_follow_the_manifest_layout() {
        let install = Path::new("C:/app/doom");
        assert_eq!(
            freedoom_archive_path(install),
            install.join(FREEDOOM_SUBDIR).join(FREEDOOM_ARCHIVE_FILENAME)
        );
        assert_eq!(
            freedoom_iwad_path(install),
            install.join(FREEDOOM_SUBDIR).join(DOOM_IWAD_FILENAME)
        );
        assert_eq!(
            engine_exe_path(install),
            install.join(DOOM_ENGINE_SUBDIR).join(DOOM_ENGINE_EXE)
        );
    }

    #[test]
    fn zip_reader_round_trips_stored_and_deflated_entries() {
        let payload: Vec<u8> = b"freedoom1.wad contents".repeat(32);
        let archive = build_zip(&[
            ("freedoom1.wad", payload.as_slice(), true),
            ("readme.txt", b"hello".as_slice(), false),
        ]);

        let entries = zip_entries(&archive).expect("parse entries");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "freedoom1.wad");
        assert_eq!(entries[1].name, "readme.txt");

        let dir = tempfile::tempdir().expect("tempdir");
        let dest = extract_zip_entry(&archive, "freedoom1.wad", dir.path()).expect("extract");
        assert_eq!(std::fs::read(dest).expect("read"), payload);
    }

    #[test]
    fn zip_reader_rejects_non_archives_and_missing_entries() {
        assert!(zip_entries(b"not a zip at all").is_err());

        let archive = build_zip(&[("only.txt", b"x".as_slice(), false)]);
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(extract_zip_entry(&archive, "missing.wad", dir.path()).is_err());
        assert!(extract_zip_first_exe(&archive, dir.path()).is_err());
    }

    #[test]
    fn zip_reader_extracts_the_first_exe_by_basename() {
        let archive = build_zip(&[
            ("docs/README.md", b"readme".as_slice(), false),
            ("bin/restful-doom.exe", b"MZ fake exe".as_slice(), true),
        ]);
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = extract_zip_first_exe(&archive, dir.path()).expect("extract exe");
        assert_eq!(dest.file_name().and_then(|n| n.to_str()), Some(DOOM_ENGINE_EXE));
        assert_eq!(std::fs::read(dest).expect("read"), b"MZ fake exe");
    }

    // ── Local-file transport (Spec #3012 ST-2) ───────────────────────────────

    #[test]
    fn local_source_detection_and_path_mapping() {
        assert!(is_local_source("file:///C:/tmp/a.tar.xz"));
        assert!(is_local_source(r"C:\tmp\a.tar.xz"));
        assert!(is_local_source(".opencode/tmp/3012/archive/a.tar.xz"));
        assert!(!is_local_source("http://example.test/a.tar.xz"));
        assert!(!is_local_source("HTTPS://example.test/a.tar.xz"));
        assert!(!is_local_source("  https://example.test/a.tar.xz  "));

        assert_eq!(
            local_source_path("file:///C:/tmp/a.tar.xz"),
            PathBuf::from("C:/tmp/a.tar.xz")
        );
        assert_eq!(
            local_source_path("file://C:/tmp/a.tar.xz"),
            PathBuf::from("C:/tmp/a.tar.xz")
        );
        assert_eq!(
            local_source_path(r"C:\tmp\a.tar.xz"),
            PathBuf::from(r"C:\tmp\a.tar.xz")
        );
    }

    #[tokio::test]
    async fn local_file_transport_serves_bytes_and_honours_range() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("archive.tar.xz");
        let body: Vec<u8> = (0..64u8).collect();
        std::fs::write(&path, &body).expect("write archive");
        let url = format!("file:///{}", path.to_string_lossy().replace('\\', "/"));
        let transport = LocalFileTransport::new();

        let response = transport.get(&url, None).await.expect("full get");
        assert_eq!(response.status, 200);
        assert_eq!(collect_body(response.body).await, body);

        let response = transport
            .get(&url, Some(HttpRange { start: 10 }))
            .await
            .expect("range get");
        assert_eq!(response.status, 206);
        assert_eq!(collect_body(response.body).await, body[10..]);

        // A missing local file is an error, never a false success.
        assert!(transport
            .get("file:///does/not/exist.tar.xz", None)
            .await
            .is_err());
    }

    /// Drain a `ByteStream` into a byte vector (test helper).
    async fn collect_body(mut body: ByteStream) -> Vec<u8> {
        let mut out = Vec::new();
        while let Some(item) = body.next().await {
            out.extend_from_slice(&item.expect("stream chunk"));
        }
        out
    }
}
