//! Fredo-owned verified-archive extraction (Spec #3076, ST-1).
//!
//! # Why this module exists
//!
//! `acquire_pg_archive` stages `<install_dir>/archives/postgresql.tar.gz` and
//! SHA-256-verifies it against Fredo's pin. The crate (`postgresql_embedded`
//! 0.21) can then extract it, but only through `postgresql_archive::extract`,
//! which takes a `&Vec<u8>` (the whole ~164 MB decompressed tree in memory) and
//! re-derives nothing about the pin. Instead, Fredo extracts the **verified
//! bytes it already owns** with this streaming extractor, so the runtime that
//! runs is the archive Fredo verified.
//!
//! # Layout rule (same as the crate's own extractor)
//!
//! The Windows x86_64 release archive has ONE top-level component
//! (`postgresql-<version>/`). The crate strips exactly one component on extract
//! (`postgresql_archive::extractor::tar_gz_extractor`), so `binary_dir()`
//! (`<install_dir>/bin`) resolves. This module implements the SAME one-component
//! strip — never a double strip, never a flatten of more than one component.
//!
//! # Safety
//!
//! * The digest pass completes **before** any file is written, so a mismatch
//!   leaves the installation directory untouched.
//! * Every entry path is validated (no `..`, no root/absolute, no Windows prefix,
//!   one consistent top-level component) in a validation pass that also writes
//!   nothing — so a crafted LAST entry cannot leave a partially-written tree.
//! * Streaming only: 64 KiB hashing chunks and a `flate2::bufread::GzDecoder`
//!   over a `BufReader<File>`; no whole-archive buffer.
//! * A `.fredo-pg-extracted` marker is written (temp file + rename) only after a
//!   fully successful extraction, so a crash mid-extract is never trusted.

use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, Result};
use sha2::{Digest, Sha256};

use super::acquisition::PgArchivePin;

/// Marker written only after a fully-successful extraction.
pub const PG_EXTRACTION_MARKER_FILENAME: &str = ".fredo-pg-extracted";
/// Stable error prefix for every extraction failure.
pub const PG_EXTRACT_ERROR_PREFIX: &str = "[pg:extract]";
/// Binaries that must exist under `bin/` for a trusted install to be usable
/// (resolved by the crate through `Settings::binary_dir()`).
pub const PG_REQUIRED_BINARIES: &[&str] = &["initdb.exe", "pg_ctl.exe", "postgres.exe"];

/// Hashing / streaming chunk size (64 KiB).
const HASH_CHUNK_BYTES: usize = 64 * 1024;

/// Build a `[pg:extract]`-prefixed error with a human-readable context.
fn extract_error(context: &str, error: impl std::fmt::Display) -> anyhow::Error {
    anyhow!("{PG_EXTRACT_ERROR_PREFIX} {context}: {error}")
}

/// Build a bare `[pg:extract]`-prefixed error from a message.
fn extract_message(message: impl std::fmt::Display) -> anyhow::Error {
    anyhow!("{PG_EXTRACT_ERROR_PREFIX} {message}")
}

/// `<install_dir>/.fredo-pg-extracted`.
pub(crate) fn extraction_marker_path(install_dir: &Path) -> PathBuf {
    install_dir.join(PG_EXTRACTION_MARKER_FILENAME)
}

/// Stream `path` through `sha2::Sha256` in 64 KiB chunks and return the
/// lowercase hex digest. No whole-file buffer.
fn hash_file_hex(path: &Path) -> Result<String> {
    let file = File::open(path)
        .map_err(|error| extract_error(&format!("opening {}", path.display()), error))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut chunk = vec![0_u8; HASH_CHUNK_BYTES];
    loop {
        let read = reader
            .read(&mut chunk)
            .map_err(|error| extract_error(&format!("reading {}", path.display()), error))?;
        if read == 0 {
            break;
        }
        hasher.update(&chunk[..read]);
    }
    Ok(hex_encode(&hasher.finalize()))
}

/// Lowercase hex encoding (no extra crate dependency).
fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Open the staged archive as a streaming gzip+tar reader.
fn open_archive(
    archive_path: &Path,
) -> Result<tar::Archive<flate2::bufread::GzDecoder<BufReader<File>>>> {
    let file = File::open(archive_path)
        .map_err(|error| extract_error(&format!("opening {}", archive_path.display()), error))?;
    let decoder = flate2::bufread::GzDecoder::new(BufReader::new(file));
    Ok(tar::Archive::new(decoder))
}

/// The FIRST path component of `entry_path`, when it is a plain (normal)
/// component. A root/prefix/Parent-dir first component is rejected.
fn top_component(entry_path: &Path) -> Result<OsString> {
    match entry_path.components().next() {
        Some(Component::Normal(part)) => Ok(part.to_os_string()),
        Some(other) => Err(extract_message(format!(
            "archive entry {} is not a relative path (found {other:?})",
            entry_path.display()
        ))),
        None => Err(extract_message("the archive contains an entry with an empty path")),
    }
}

/// The pure layout rule: strip exactly `top` from `entry_path`.
///
/// Returns the empty [`PathBuf`] for the bare top-directory entry itself (the
/// caller skips it). Errors on an empty path, a divergent/absent top component,
/// or any `ParentDir`/`RootDir`/`Prefix` component (the path-traversal guard).
pub(crate) fn strip_top_component(entry_path: &Path, top: &OsStr) -> Result<PathBuf> {
    let mut components = entry_path.components();
    let first = components.next().ok_or_else(|| {
        extract_message(format!(
            "archive entry {} has an empty path",
            entry_path.display()
        ))
    })?;
    match first {
        Component::Normal(part) if part == top => {}
        Component::Normal(_) => {
            return Err(extract_message(format!(
                "archive entry {} diverges from the top-level component {}",
                entry_path.display(),
                top.to_string_lossy()
            )))
        }
        _ => {
            return Err(extract_message(format!(
                "archive entry {} is not a relative path",
                entry_path.display()
            )))
        }
    }

    let mut stripped = PathBuf::new();
    for component in components {
        match component {
            Component::Normal(part) => stripped.push(part),
            Component::CurDir => {}
            _ => {
                return Err(extract_message(format!(
                    "archive entry {} escapes the installation directory",
                    entry_path.display()
                )))
            }
        }
    }
    Ok(stripped)
}

/// Read every entry header and validate its path, returning the ONE top-level
/// component. Writes nothing, so a rejected archive leaves no partial tree.
fn validate_archive_layout(archive_path: &Path) -> Result<OsString> {
    let mut archive = open_archive(archive_path)?;
    let mut entries = archive
        .entries()
        .map_err(|error| extract_error("reading the archive index", error))?;
    let mut top: Option<OsString> = None;
    for entry in entries.by_ref() {
        let entry = entry.map_err(|error| extract_error("reading an archive entry", error))?;
        let path = entry
            .path()
            .map_err(|error| extract_error("decoding an archive entry path", error))?
            .into_owned();
        let entry_top = top_component(&path)?;
        match &top {
            None => top = Some(entry_top.clone()),
            Some(expected) if *expected != entry_top => {
                return Err(extract_message(format!(
                    "archive entry {} diverges from the top-level component {}",
                    path.display(),
                    expected.to_string_lossy()
                )))
            }
            Some(_) => {}
        }
        // Validate the remainder of every path too (traversal guard).
        strip_top_component(&path, &entry_top)?;
    }
    top.ok_or_else(|| extract_message("the archive contains no entries"))
}

/// Second pass: unpack every entry into `install_dir`, stripping exactly one
/// top-level component. The layout was validated before this pass.
fn unpack_archive(archive_path: &Path, install_dir: &Path, top: &OsStr) -> Result<()> {
    let mut archive = open_archive(archive_path)?;
    let mut entries = archive
        .entries()
        .map_err(|error| extract_error("reading the archive index", error))?;
    for entry in entries.by_ref() {
        let mut entry = entry.map_err(|error| extract_error("reading an archive entry", error))?;
        let path = entry
            .path()
            .map_err(|error| extract_error("decoding an archive entry path", error))?
            .into_owned();
        let stripped = strip_top_component(&path, top)?;
        if stripped.as_os_str().is_empty() {
            // The bare top-directory entry itself.
            continue;
        }
        let destination = install_dir.join(&stripped);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                extract_error(&format!("creating {}", parent.display()), error)
            })?;
        }
        entry
            .unpack(&destination)
            .map_err(|error| extract_error(&format!("unpacking {}", destination.display()), error))?;
    }
    Ok(())
}

/// Write the extraction marker atomically (sibling temp file + rename). Only
/// called after a fully successful extraction.
fn write_marker(install_dir: &Path, pin: &PgArchivePin) -> Result<()> {
    let path = extraction_marker_path(install_dir);
    let temp = path.with_extension("tmp");
    let contents = format!("version={}\nsha256={}\n", pin.version, pin.sha256);
    std::fs::write(&temp, contents)
        .map_err(|error| extract_error(&format!("writing {}", temp.display()), error))?;
    std::fs::rename(&temp, &path).map_err(|error| {
        extract_error(
            &format!("renaming {} -> {}", temp.display(), path.display()),
            error,
        )
    })
}

/// Re-verify `archive_path` against `pin`, then extract it into `install_dir`,
/// stripping the archive's ONE top-level component, and write the marker for
/// `pin`. Blocking (the caller wraps it in `spawn_blocking`). No network, no env
/// reads: the pin is an explicit parameter, so unit fixtures supply a synthetic
/// pin and never touch process-global env (G-222).
///
/// When the marker is already current for `pin`, this is a byte-identical no-op
/// (the R-1a idempotence path).
pub fn extract_verified_archive(
    archive_path: &Path,
    install_dir: &Path,
    pin: &PgArchivePin,
) -> Result<()> {
    if trusted_install_is_current(install_dir, pin) {
        return Ok(());
    }

    let expected = pin.sha256.trim();
    let actual = hash_file_hex(archive_path)?;
    if !actual.eq_ignore_ascii_case(expected) {
        return Err(extract_message(format!(
            "SHA-256 mismatch for {}: expected {expected}, computed {actual} — \
             no file was extracted",
            archive_path.display()
        )));
    }

    // Validate the whole layout BEFORE writing anything, so a rejected archive
    // (including one whose last entry is crafted) leaves no partial tree.
    let top = validate_archive_layout(archive_path)?;

    std::fs::create_dir_all(install_dir).map_err(|error| {
        extract_error(
            &format!("creating {}", install_dir.display()),
            error,
        )
    })?;
    unpack_archive(archive_path, install_dir, &top)?;
    write_marker(install_dir, pin)
}

/// True iff the marker matches `pin`'s version + digest (case-insensitive on the
/// digest) AND every [`PG_REQUIRED_BINARIES`] entry exists under
/// `<install_dir>/bin`. Explicit pin: a pure predicate with no env read.
pub fn trusted_install_is_current(install_dir: &Path, pin: &PgArchivePin) -> bool {
    let marker = extraction_marker_path(install_dir);
    let Ok(contents) = std::fs::read_to_string(&marker) else {
        return false;
    };
    let mut version: Option<&str> = None;
    let mut sha256: Option<&str> = None;
    for line in contents.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "version" => version = Some(value.trim()),
            "sha256" => sha256 = Some(value.trim()),
            _ => {}
        }
    }
    let (Some(version), Some(sha256)) = (version, sha256) else {
        return false;
    };
    if version != pin.version {
        return false;
    }
    if !sha256.eq_ignore_ascii_case(pin.sha256.trim()) {
        return false;
    }
    let bin_dir = install_dir.join("bin");
    PG_REQUIRED_BINARIES
        .iter()
        .all(|name| bin_dir.join(name).is_file())
}

/// Test-only: seed a trusted install tree for `pin` (the three required `bin/`
/// sentinels + a current marker). Used by the R-1a idempotence tests so they
/// never reach the network.
#[cfg(test)]
pub(crate) fn seed_trusted_install(install_dir: &Path, pin: &PgArchivePin) -> Result<()> {
    use anyhow::Context as _;

    let bin_dir = install_dir.join("bin");
    std::fs::create_dir_all(&bin_dir)
        .with_context(|| format!("creating {}", bin_dir.display()))?;
    for name in PG_REQUIRED_BINARIES {
        std::fs::write(bin_dir.join(name), format!("seeded {name}"))
            .with_context(|| format!("seeding {}", name))?;
    }
    write_marker(install_dir, pin)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::time::SystemTime;

    /// The fixture archive's single top-level component (the crate's layout).
    const FIXTURE_TOP: &str = "postgresql-18.6.0";

    /// The synthetic distribution: the three required binaries plus one `lib/`
    /// and one `share/` file (so the strip rule is proven for all three roots).
    const FIXTURE_FILES: &[(&str, &[u8])] = &[
        ("bin/initdb.exe", b"fixture-initdb"),
        ("bin/pg_ctl.exe", b"fixture-pg-ctl"),
        ("bin/postgres.exe", b"fixture-postgres"),
        ("lib/libpq.dll", b"fixture-libpq"),
        ("share/postgres.bki", b"fixture-bki"),
    ];

    fn pin_with_digest(digest: &str) -> PgArchivePin {
        PgArchivePin {
            version: "18.6.0".to_string(),
            sha256: digest.to_string(),
        }
    }

    fn append_dir(builder: &mut tar::Builder<flate2::write::GzEncoder<File>>, path: &str) {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Directory);
        header.set_size(0);
        header.set_mode(0o755);
        header.set_mtime(0);
        header.set_path(path).expect("set dir path");
        header.set_cksum();
        builder.append(&header, std::io::empty()).expect("append dir");
    }

    fn append_file(
        builder: &mut tar::Builder<flate2::write::GzEncoder<File>>,
        path: &str,
        contents: &[u8],
    ) {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(contents.len() as u64);
        header.set_mode(0o644);
        header.set_mtime(0);
        header.set_path(path).expect("set file path");
        header.set_cksum();
        builder.append(&header, contents).expect("append file");
    }

    /// Build a synthetic `tar.gz` under `dir` with `entries` and return its path
    /// plus the SHA-256 of the COMPRESSED file (what the pin covers).
    fn write_fixture(
        dir: &Path,
        file_name: &str,
        entries: &[(&str, Option<&[u8]>)],
    ) -> (PathBuf, String) {
        let path = dir.join(file_name);
        let file = File::create(&path).expect("create fixture archive");
        let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
        let mut builder = tar::Builder::new(encoder);
        for (entry_path, contents) in entries {
            match contents {
                Some(contents) => append_file(&mut builder, entry_path, contents),
                None => append_dir(&mut builder, entry_path),
            }
        }
        let encoder = builder.into_inner().expect("finish tar stream");
        encoder.finish().expect("finish gzip stream");
        let digest = hash_file_hex(&path).expect("hash fixture");
        (path, digest)
    }

    /// The one-top-component fixture used by the positive tests.
    fn standard_fixture(dir: &Path) -> (PathBuf, PgArchivePin) {
        let mut entries: Vec<(String, Option<&[u8]>)> = vec![(format!("{FIXTURE_TOP}/"), None)];
        for (relative, contents) in FIXTURE_FILES {
            entries.push((format!("{FIXTURE_TOP}/{relative}"), Some(*contents)));
        }
        let owned: Vec<(&str, Option<&[u8]>)> = entries
            .iter()
            .map(|(path, contents)| (path.as_str(), *contents))
            .collect();
        let (archive, digest) = write_fixture(dir, "postgresql.tar.gz", &owned);
        (archive, pin_with_digest(&digest))
    }

    /// `(length, bytes, mtime)` for every file under `root`, keyed by the
    /// relative path — the byte-identity snapshot the layout tests compare.
    fn snapshot(root: &Path) -> BTreeMap<String, (u64, Vec<u8>, Option<SystemTime>)> {
        let mut snapshot = BTreeMap::new();
        collect_snapshot(root, root, &mut snapshot);
        snapshot
    }

    fn collect_snapshot(
        root: &Path,
        current: &Path,
        into: &mut BTreeMap<String, (u64, Vec<u8>, Option<SystemTime>)>,
    ) {
        let Ok(entries) = std::fs::read_dir(current) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.is_dir() {
                collect_snapshot(root, &path, into);
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .display()
                .to_string();
            into.insert(
                relative,
                (metadata.len(), bytes, metadata.modified().ok()),
            );
        }
    }

    #[test]
    fn extract_verified_archive_strips_the_single_top_level_component() {
        let dir = tempfile::tempdir().expect("tempdir");
        let install = dir.path().join("install");
        let (archive, pin) = standard_fixture(dir.path());

        extract_verified_archive(&archive, &install, &pin).expect("extract");

        for (relative, contents) in FIXTURE_FILES {
            let actual = std::fs::read(install.join(relative)).expect("read extracted file");
            assert_eq!(
                actual.as_slice(),
                *contents,
                "{relative} must land directly under the install dir"
            );
        }
        assert!(
            !install.join(FIXTURE_TOP).exists(),
            "the top-level component must be stripped, not nested"
        );
        assert!(
            trusted_install_is_current(&install, &pin),
            "a fully extracted tree with the marker must report current"
        );

        let mut settings = postgresql_embedded::Settings::new();
        settings.installation_dir = install.clone();
        assert_eq!(
            settings.binary_dir(),
            install.join("bin"),
            "the crate resolves <install_dir>/bin (the strip rule)"
        );
    }

    #[test]
    fn extract_verified_archive_writes_the_marker_and_reports_current() {
        let dir = tempfile::tempdir().expect("tempdir");
        let install = dir.path().join("install");
        let (archive, pin) = standard_fixture(dir.path());

        extract_verified_archive(&archive, &install, &pin).expect("extract");

        let marker = extraction_marker_path(&install);
        let text = std::fs::read_to_string(&marker).expect("read marker");
        assert!(text.contains("version=18.6.0"), "marker: {text}");
        assert!(
            text.contains(&format!("sha256={}", pin.sha256)),
            "marker: {text}"
        );
        assert!(trusted_install_is_current(&install, &pin));

        // The digest comparison is case-insensitive: an uppercase pin is current.
        let upper = PgArchivePin {
            version: pin.version.clone(),
            sha256: pin.sha256.to_uppercase(),
        };
        assert!(trusted_install_is_current(&install, &upper));
    }

    #[test]
    fn extract_verified_archive_is_idempotent_when_the_marker_is_current() {
        let dir = tempfile::tempdir().expect("tempdir");
        let install = dir.path().join("install");
        let (archive, pin) = standard_fixture(dir.path());

        extract_verified_archive(&archive, &install, &pin).expect("first extract");
        let before = snapshot(&install);

        extract_verified_archive(&archive, &install, &pin).expect("second extract");

        assert_eq!(
            snapshot(&install),
            before,
            "a current marker must make a re-extract a byte-identical no-op \
             (no rewritten file, no advanced mtime)"
        );
        assert!(trusted_install_is_current(&install, &pin));
    }

    #[test]
    fn extract_verified_archive_rejects_a_divergent_top_level_component() {
        let dir = tempfile::tempdir().expect("tempdir");
        let install = dir.path().join("install");

        // The LAST entry is the divergent one: nothing may be written.
        let entries: Vec<(String, Option<&[u8]>)> = vec![
            (format!("{FIXTURE_TOP}/"), None),
            (format!("{FIXTURE_TOP}/bin/initdb.exe"), Some(b"a")),
            (format!("{FIXTURE_TOP}/bin/pg_ctl.exe"), Some(b"b")),
            ("other-top/bin/postgres.exe".to_string(), Some(b"c")),
        ];
        let owned: Vec<(&str, Option<&[u8]>)> = entries
            .iter()
            .map(|(path, contents)| (path.as_str(), *contents))
            .collect();
        let (archive, digest) = write_fixture(dir.path(), "divergent.tar.gz", &owned);
        let pin = pin_with_digest(&digest);
        let parent_before = snapshot(dir.path());

        let error = extract_verified_archive(&archive, &install, &pin)
            .expect_err("a divergent top-level component must be rejected");
        let message = format!("{error:#}");
        assert!(
            message.starts_with(PG_EXTRACT_ERROR_PREFIX),
            "every extraction error carries the prefix: {message}"
        );
        assert!(
            !install.exists(),
            "a rejected archive must not create the install dir"
        );
        assert!(
            !trusted_install_is_current(&install, &pin),
            "a rejected archive is never trusted"
        );
        assert_eq!(
            snapshot(dir.path()),
            parent_before,
            "nothing may be written outside the install dir either (the archive itself is unchanged)"
        );
    }

    #[test]
    fn extract_verified_archive_refuses_a_digest_mismatch_without_writing_binaries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let install = dir.path().join("install");
        let (archive, real_pin) = standard_fixture(dir.path());
        let wrong = pin_with_digest(&"0".repeat(64));
        let parent_before = snapshot(dir.path());

        let error = extract_verified_archive(&archive, &install, &wrong)
            .expect_err("a digest mismatch must be refused");
        let message = format!("{error:#}");
        assert!(
            message.starts_with(PG_EXTRACT_ERROR_PREFIX),
            "the error is an extraction failure: {message}"
        );
        assert!(
            message.contains("SHA-256 mismatch"),
            "the error names the mismatch: {message}"
        );
        assert!(
            !install.exists(),
            "no bin/lib/share/marker may be written on a mismatch"
        );
        assert!(!trusted_install_is_current(&install, &wrong));
        assert!(!trusted_install_is_current(&install, &real_pin));
        assert_eq!(
            snapshot(dir.path()),
            parent_before,
            "the staged archive itself must be untouched"
        );
    }

    #[test]
    fn strip_top_component_rejects_parent_dir_root_and_prefix_components() {
        let top = OsStr::new(FIXTURE_TOP);

        for hostile in [
            Path::new("../evil"),
            Path::new("top/../evil"),
            Path::new("/top/bin"),
            Path::new(""),
            Path::new("other-top/bin"),
        ] {
            let error = strip_top_component(hostile, top)
                .expect_err("a hostile or divergent path must be rejected");
            assert!(
                format!("{error:#}").starts_with(PG_EXTRACT_ERROR_PREFIX),
                "{hostile:?} error carries the prefix"
            );
        }

        #[cfg(windows)]
        {
            let error = strip_top_component(Path::new("C:/top/bin"), top)
                .expect_err("a Windows prefix component must be rejected");
            assert!(format!("{error:#}").starts_with(PG_EXTRACT_ERROR_PREFIX));
        }

        assert_eq!(
            strip_top_component(Path::new("postgresql-18.6.0/bin/pg_ctl.exe"), top).expect("strip"),
            PathBuf::from("bin").join("pg_ctl.exe")
        );
        assert_eq!(
            strip_top_component(Path::new(FIXTURE_TOP), top).expect("bare top dir"),
            PathBuf::new(),
            "the bare top-directory entry strips to an empty path"
        );
    }

    #[test]
    fn trusted_install_is_current_requires_the_marker_and_the_required_binaries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let install = dir.path().join("install");
        let (_, pin) = standard_fixture(dir.path());
        seed_trusted_install(&install, &pin).expect("seed");
        let marker = extraction_marker_path(&install);

        // All present and matching.
        assert!(trusted_install_is_current(&install, &pin));

        // An unrelated extra file under bin/ must not flip the predicate.
        std::fs::write(install.join("bin").join("extra.dll"), b"extra").expect("write extra");
        assert!(trusted_install_is_current(&install, &pin));

        // Marker absent.
        std::fs::remove_file(&marker).expect("remove marker");
        assert!(!trusted_install_is_current(&install, &pin));

        // Marker blank.
        std::fs::write(&marker, "").expect("blank marker");
        assert!(!trusted_install_is_current(&install, &pin));

        // Missing the version= line.
        std::fs::write(&marker, format!("sha256={}\n", pin.sha256)).expect("versionless marker");
        assert!(!trusted_install_is_current(&install, &pin));

        // Missing the sha256= line.
        std::fs::write(&marker, format!("version={}\n", pin.version)).expect("digestless marker");
        assert!(!trusted_install_is_current(&install, &pin));

        // Version mismatch.
        std::fs::write(
            &marker,
            format!("version=18.7.0\nsha256={}\n", pin.sha256),
        )
        .expect("version-mismatch marker");
        assert!(!trusted_install_is_current(&install, &pin));

        // Digest mismatch.
        std::fs::write(
            &marker,
            format!("version={}\nsha256={}\n", pin.version, "0".repeat(64)),
        )
        .expect("digest-mismatch marker");
        assert!(!trusted_install_is_current(&install, &pin));

        // Restore a current marker, then remove each required binary in turn.
        write_marker(&install, &pin).expect("rewrite marker");
        for name in PG_REQUIRED_BINARIES {
            let binary = install.join("bin").join(name);
            std::fs::remove_file(&binary).expect("remove binary");
            assert!(
                !trusted_install_is_current(&install, &pin),
                "a missing {name} must make the install not-current"
            );
            std::fs::write(&binary, format!("seeded {name}")).expect("restore binary");
        }
        assert!(trusted_install_is_current(&install, &pin));
    }
}
