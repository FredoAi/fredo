//! ZIP reading, entry-name safety and the archive budgets (Spec #3147, ST-2).
//!
//! # Archive safety is OUR rule, not a crate helper
//!
//! The `zip` crate exposes `enclosed_name()`, which strips `..` segments and
//! leading `/` before returning — that is a *sanitizer*, not a *refusal*. A
//! package whose entry is `../../secrets.txt` would be silently re-pointed at
//! `secrets.txt`, and the user would be told nothing. AC-3 requires a refusal
//! with a named reason, so every rule here DECIDES and REJECTS; nothing is
//! rewritten. The rules, in order:
//!
//! 1. the entry name must decode as UTF-8 ⇒ [`UnsafePath`]
//! 2. no absolute path, no drive/UNC prefix ⇒ [`UnsafePath`]
//! 3. no `..` component, no `.` component, no empty segment ⇒ [`UnsafePath`]
//! 4. no symlink / no non-regular entry type ⇒ [`UnsafePath`]
//! 5. a `__fredo` path segment ⇒ [`ReservedPath`]
//! 6. the normalized join must stay under the app root ⇒ [`UnsafePath`]
//!
//! # Budgets
//!
//! At most [`MAX_ARCHIVE_ENTRIES`] entries, [`MAX_TOTAL_UNCOMPRESSED_BYTES`] in
//! total and [`MAX_FILE_UNCOMPRESSED_BYTES`] in any one file — all three are
//! enforced against the archive's own DECLARED sizes before a single byte is
//! decompressed, so a zip bomb is refused without expanding it. The boundary
//! tests below accept exactly at the cap and reject at cap+1 (T-3.5 requires the
//! caps be ENFORCED, not merely declared).
//!
//! [`UnsafePath`]: super::InstalledAppRefusalCode::UnsafePath
//! [`ReservedPath`]: super::InstalledAppRefusalCode::ReservedPath

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Component, Path, PathBuf};

use zip::ZipArchive;

use super::{
    InstalledAppError, InstalledAppRefusalCode, InstalledAppResult, MAX_ARCHIVE_ENTRIES,
    MAX_FILE_UNCOMPRESSED_BYTES, MAX_TOTAL_UNCOMPRESSED_BYTES, PACKAGE_MANIFEST_FILENAME,
    RESERVED_PATH_SEGMENT,
};

/// One archive entry that passed every safety rule, with its normalized
/// in-archive path (always relative POSIX form, always under the app root).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafeEntry {
    /// The archive's own entry name, verbatim (diagnostics + manifest lookup).
    pub archive_name: String,
    /// The normalized relative path the file is written at (POSIX `'/'`
    /// separated), e.g. `ui/index.html`.
    pub relative_path: String,
    /// The declared uncompressed size.
    pub uncompressed_bytes: u64,
    /// `false` for a directory entry.
    pub is_file: bool,
}

/// The validated contents index of one package archive.
#[derive(Debug, Clone)]
pub struct ArchiveIndex {
    /// Every entry, in archive order.
    pub entries: Vec<SafeEntry>,
    /// The whole archive's declared uncompressed total.
    pub total_uncompressed_bytes: u64,
}

impl ArchiveIndex {
    /// The `fredo-app.json` entry, if the archive has one at its root.
    pub fn manifest_entry(&self) -> Option<&SafeEntry> {
        self.entries
            .iter()
            .find(|entry| entry.archive_name == PACKAGE_MANIFEST_FILENAME)
    }

    /// The regular-file entries (everything that becomes a file on disk).
    pub fn file_entries(&self) -> impl Iterator<Item = &SafeEntry> {
        self.entries.iter().filter(|entry| entry.is_file)
    }
}

/// Reject an entry name that cannot be a safe relative path inside the app
/// root. Returns the refusal that names the specific defect.
///
/// Split into its own function so it is testable without building a ZIP: the QA
/// row asserts the shapes, not the crate's behaviour.
pub fn validate_entry_name(name: &str) -> InstalledAppResult<String> {
    if name.is_empty() {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::UnsafePath,
            "the archive contains an entry with an empty name",
        ));
    }

    // A NUL inside a name is a classic truncation trick: the joined path may
    // resolve to something else than what was checked.
    if name.contains('\0') {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::UnsafePath,
            format!("entry {name:?} contains a NUL byte"),
        ));
    }

    // Windows drive (`C:`) and UNC (`\\server\share`) prefixes.
    if name.contains(':') {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::UnsafePath,
            format!("entry {name:?} carries a drive or scheme prefix"),
        ));
    }
    if name.starts_with("\\\\") || name.starts_with("//") {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::UnsafePath,
            format!("entry {name:?} is a UNC path"),
        ));
    }
    if name.starts_with('/') || name.starts_with('\\') {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::UnsafePath,
            format!("entry {name:?} is an absolute path"),
        ));
    }
    if name.contains('\\') {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::UnsafePath,
            format!("entry {name:?} uses backslash separators"),
        ));
    }

    // Component-wise traversal checks. A trailing '/' marks a directory entry
    // and is dropped before the segment scan.
    let trimmed = name.trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::UnsafePath,
            format!("entry {name:?} names only a root"),
        ));
    }

    for segment in trimmed.split('/') {
        match segment {
            "" => {
                return Err(InstalledAppError::new(
                    InstalledAppRefusalCode::UnsafePath,
                    format!("entry {name:?} contains an empty path segment"),
                ))
            }
            "." => {
                return Err(InstalledAppError::new(
                    InstalledAppRefusalCode::UnsafePath,
                    format!("entry {name:?} contains a '.' component"),
                ))
            }
            ".." => {
                return Err(InstalledAppError::new(
                    InstalledAppRefusalCode::UnsafePath,
                    format!("entry {name:?} contains a '..' component (zip-slip)"),
                ))
            }
            _ => {}
        }
    }

    // The host reserves `__fredo/` for its injected bootstrap.
    if trimmed
        .split('/')
        .any(|segment| segment == RESERVED_PATH_SEGMENT)
    {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::ReservedPath,
            format!(
                "entry {name:?} claims the host-reserved \"{RESERVED_PATH_SEGMENT}\" path segment"
            ),
        ));
    }

    Ok(trimmed.to_string())
}

/// Join a validated relative path under `root` and confirm the result stays
/// there after normalization.
///
/// The name was already validated component-wise, so this is the defensive
/// second check the plan asks for ("then normalize-join and confirm the result
/// stays under the app root") — it catches a platform path quirk rather than
/// trusting the string scan alone.
pub fn join_under_root(root: &Path, relative_path: &str) -> InstalledAppResult<PathBuf> {
    let joined = root.join(relative_path);
    if !path_is_under(root, &joined) {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::UnsafePath,
            format!(
                "entry {relative_path:?} resolves outside the app root ({} vs {})",
                joined.display(),
                root.display()
            ),
        ));
    }
    Ok(joined)
}

/// Is `candidate` `root` itself or a descendant, after component normalization?
///
/// Pure component comparison — never `canonicalize` (which would follow
/// symlinks and touch the filesystem).
pub fn path_is_under(root: &Path, candidate: &Path) -> bool {
    let root_components: Vec<Component<'_>> = root.components().collect();
    let candidate_components: Vec<Component<'_>> = candidate.components().collect();
    if candidate_components.len() < root_components.len() {
        return false;
    }
    root_components
        .iter()
        .zip(candidate_components.iter())
        .all(|(left, right)| left == right)
}

/// Enforce the three archive budgets over the DECLARED entry metadata.
///
/// A single entry larger than [`MAX_FILE_UNCOMPRESSED_BYTES`] is refused with
/// the per-file message even when the total is under the cap (T-3.5 records
/// which rule fired); the total is refused with the running-total message.
pub fn check_archive_budgets(counts: &[(String, u64)]) -> InstalledAppResult<u64> {
    let count = counts.len() as u64;
    if count > MAX_ARCHIVE_ENTRIES {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::ArchiveTooLarge,
            format!(
                "the archive has {count} entries; the limit is {MAX_ARCHIVE_ENTRIES} \
                 (per-file limit {MAX_FILE_UNCOMPRESSED_BYTES} bytes, total limit \
                 {MAX_TOTAL_UNCOMPRESSED_BYTES} bytes)"
            ),
        ));
    }

    let mut total: u64 = 0;
    for (name, bytes) in counts {
        if *bytes > MAX_FILE_UNCOMPRESSED_BYTES {
            return Err(InstalledAppError::new(
                InstalledAppRefusalCode::ArchiveTooLarge,
                format!(
                    "entry {name:?} declares {bytes} uncompressed bytes; the per-file limit is \
                     {MAX_FILE_UNCOMPRESSED_BYTES}"
                ),
            ));
        }
        total = total.checked_add(*bytes).ok_or_else(|| {
            InstalledAppError::new(
                InstalledAppRefusalCode::ArchiveTooLarge,
                format!("the archive's declared uncompressed size overflows u64 at {name:?}"),
            )
        })?;
        if total > MAX_TOTAL_UNCOMPRESSED_BYTES {
            return Err(InstalledAppError::new(
                InstalledAppRefusalCode::ArchiveTooLarge,
                format!(
                    "the archive declares more than {MAX_TOTAL_UNCOMPRESSED_BYTES} uncompressed \
                     bytes (reached {total} at {name:?})"
                ),
            ));
        }
    }

    Ok(total)
}

/// Read + validate a package archive from disk.
///
/// Order matters: the budgets and every name are checked across the WHOLE
/// archive before any payload is read, so a crafted late entry cannot leave a
/// partially extracted tree (the same discipline as
/// `applications::pg_supervisor::extraction`).
pub fn read_archive_index(archive_path: &Path) -> InstalledAppResult<ArchiveIndex> {
    let archive = open_archive(archive_path)?;
    index_archive(archive)
}

/// The index pass over an already-opened archive (split out so tests can drive
/// it over an in-memory reader).
pub fn index_archive<R: Read + std::io::Seek>(
    mut archive: ZipArchive<R>,
) -> InstalledAppResult<ArchiveIndex> {
    index_archive_in_place(&mut archive)
}

/// The SAME index pass, but over a borrowed archive so the caller can still read
/// the manifest and the payloads afterwards.
///
/// This is the ONE implementation of the naming/budget rule: [`index_archive`]
/// delegates here rather than duplicating it, so the install path and any future
/// reader cannot drift on which names are safe.
pub fn index_archive_in_place<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> InstalledAppResult<ArchiveIndex> {
    let declared: Vec<(String, u64)> = (0..archive.len())
        .map(|index| {
            archive
                .by_index(index)
                .map(|file| (file.name().to_string(), file.size()))
                .map_err(|error| archive_error(&error))
        })
        .collect::<InstalledAppResult<Vec<_>>>()?;

    let total_uncompressed_bytes = check_archive_budgets(&declared)?;

    let mut entries = Vec::with_capacity(declared.len());
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|error| archive_error(&error))?;

        // Entry-type rule: only regular files and directories may exist. A
        // symlink (or any other recorded type) is a path-escape primitive.
        if file.is_symlink() {
            return Err(InstalledAppError::new(
                InstalledAppRefusalCode::UnsafePath,
                format!("entry {:?} is recorded as a symlink", file.name()),
            ));
        }
        let is_dir = file.is_dir();
        if !is_dir && !is_regular_file(file.unix_mode()) {
            return Err(InstalledAppError::new(
                InstalledAppRefusalCode::UnsafePath,
                format!("entry {:?} is not a regular file or directory", file.name()),
            ));
        }

        let archive_name = file.name().to_string();
        let relative_path = validate_entry_name(&archive_name)?;

        entries.push(SafeEntry {
            archive_name,
            relative_path,
            uncompressed_bytes: file.size(),
            is_file: !is_dir,
        });
    }

    Ok(ArchiveIndex {
        entries,
        total_uncompressed_bytes,
    })
}

/// A file is "regular" when its recorded Unix mode says so, or when no mode is
/// recorded at all (a zip written without attributes on a non-Unix host).
///
/// Public so the install path in [`super::store`] can apply the identical rule
/// through [`index_archive_in_place`] — one rule, one place.
pub fn is_regular_file(unix_mode: Option<u32>) -> bool {
    /// `S_IFMT` — the file-type mask.
    const S_IFMT: u32 = 0o170_000;
    /// `S_IFREG` — a regular file.
    const S_IFREG: u32 = 0o100_000;

    match unix_mode {
        None => true,
        Some(mode) => {
            let file_type = mode & S_IFMT;
            // 0 means "no type recorded", which is how a zip built on Windows
            // typically looks; treat it as regular rather than refusing every
            // package produced there.
            file_type == 0 || file_type == S_IFREG
        }
    }
}

/// Extract one entry's bytes into a `Vec`.
///
/// The read is BOUNDED by the declared size from the validated index: a
/// decompression that tries to emit more than was declared is refused rather
/// than trusted (zip-bomb defence — a declared size is a claim, so it is
/// enforced with `take`).
pub fn read_entry_bytes<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    entry: &SafeEntry,
) -> InstalledAppResult<Vec<u8>> {
    let mut file = archive
        .by_name(&entry.archive_name)
        .map_err(|error| archive_error(&error))?;

    let declared = entry.uncompressed_bytes;
    let mut buffer = Vec::with_capacity(declared.min(MAX_FILE_UNCOMPRESSED_BYTES) as usize);
    let mut limited = file.by_ref().take(declared.saturating_add(1));
    limited
        .read_to_end(&mut buffer)
        .map_err(|error| InstalledAppError::new(
            InstalledAppRefusalCode::IoError,
            format!("reading entry {:?}: {error}", entry.archive_name),
        ))?;

    if buffer.len() as u64 > declared {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::ArchiveTooLarge,
            format!(
                "entry {:?} decompressed to more than its declared {declared} bytes",
                entry.archive_name
            ),
        ));
    }
    if buffer.len() as u64 > MAX_FILE_UNCOMPRESSED_BYTES {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::ArchiveTooLarge,
            format!(
                "entry {:?} decompressed to {} bytes; the per-file limit is \
                 {MAX_FILE_UNCOMPRESSED_BYTES}",
                entry.archive_name,
                buffer.len()
            ),
        ));
    }

    Ok(buffer)
}

/// Open a package archive from disk. A non-zip file is [`NotAZip`].
///
/// [`NotAZip`]: super::InstalledAppRefusalCode::NotAZip
pub fn open_archive(archive_path: &Path) -> InstalledAppResult<ZipArchive<BufReader<File>>> {
    let file = File::open(archive_path).map_err(|error| {
        InstalledAppError::io(
            &format!("opening package {}", archive_path.display()),
            &error,
        )
    })?;
    ZipArchive::new(BufReader::new(file)).map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::NotAZip,
            format!(
                "{} is not a readable ZIP archive: {error}",
                archive_path.display()
            ),
        )
    })
}

fn archive_error(error: &zip::result::ZipError) -> InstalledAppError {
    InstalledAppError::new(
        InstalledAppRefusalCode::NotAZip,
        format!("the archive could not be read: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    // ── Entry-name safety ──────────────────────────────────────────────────

    #[test]
    fn plain_relative_names_are_accepted_and_normalized() {
        for (name, expected) in [
            ("index.html", "index.html"),
            ("main.js", "main.js"),
            ("assets/logo.png", "assets/logo.png"),
            ("a/b/c/deep.txt", "a/b/c/deep.txt"),
            ("assets/", "assets"),
        ] {
            assert_eq!(
                validate_entry_name(name).expect(name),
                expected,
                "{name} should normalize to {expected}"
            );
        }
    }

    #[test]
    fn a_parent_component_is_unsafe_path() {
        for name in [
            "../escape.txt",
            "a/../../escape.txt",
            "a/..",
            "..",
        ] {
            let error = validate_entry_name(name).expect_err(name);
            assert_eq!(error.code, InstalledAppRefusalCode::UnsafePath, "{name}");
            assert!(
                error.detail.contains(".."),
                "the detail must name the defect: {}",
                error.detail
            );
        }
    }

    #[test]
    fn an_absolute_path_is_unsafe_path() {
        for name in ["/etc/passwd", "/index.html", "\\\\server\\share\\x"] {
            let error = validate_entry_name(name).expect_err(name);
            assert_eq!(error.code, InstalledAppRefusalCode::UnsafePath, "{name}");
        }
    }

    #[test]
    fn a_drive_prefix_is_unsafe_path() {
        for name in ["C:/Windows/system32/evil.dll", "c:evil.txt", "C:\\evil.txt"] {
            let error = validate_entry_name(name).expect_err(name);
            assert_eq!(error.code, InstalledAppRefusalCode::UnsafePath, "{name}");
        }
    }

    #[test]
    fn backslash_separators_are_refused() {
        let error = validate_entry_name("a\\b.txt").expect_err("backslash");
        assert_eq!(error.code, InstalledAppRefusalCode::UnsafePath);
    }

    #[test]
    fn empty_segments_and_dot_components_are_refused() {
        for name in ["a//b.txt", "./a.txt", "a/./b.txt"] {
            let error = validate_entry_name(name).expect_err(name);
            assert_eq!(error.code, InstalledAppRefusalCode::UnsafePath, "{name}");
        }
    }

    #[test]
    fn an_empty_or_null_bearing_name_is_refused() {
        assert_eq!(
            validate_entry_name("").expect_err("empty").code,
            InstalledAppRefusalCode::UnsafePath
        );
        assert_eq!(
            validate_entry_name("a\0b.txt").expect_err("nul").code,
            InstalledAppRefusalCode::UnsafePath
        );
        assert_eq!(
            validate_entry_name("/").expect_err("root-ish").code,
            InstalledAppRefusalCode::UnsafePath
        );
    }

    #[test]
    fn a_reserved_fredo_segment_is_reserved_path() {
        for name in [
            "__fredo/bootstrap.js",
            "__fredo",
            "assets/__fredo/evil.js",
            "__fredo/",
        ] {
            let error = validate_entry_name(name).expect_err(name);
            assert_eq!(error.code, InstalledAppRefusalCode::ReservedPath, "{name}");
            assert!(error.detail.contains("__fredo"));
        }
    }

    #[test]
    fn a_name_that_merely_contains_the_reserved_token_is_not_reserved() {
        // Only a WHOLE `__fredo` segment is reserved — `__fredo-like` inside a
        // filename is an ordinary name and must not be refused.
        for name in ["my__fredo.txt", "__fredo-notes.md", "a/__fredo.bak"] {
            assert!(
                validate_entry_name(name).is_ok(),
                "{name} is not a reserved segment"
            );
        }
    }

    // ── Normalize-join containment ─────────────────────────────────────────

    #[test]
    fn a_joined_path_stays_under_the_root() {
        let root = Path::new("C:/data/installed-apps/sample/files");
        let joined = join_under_root(root, "ui/index.html").expect("under root");
        assert!(path_is_under(root, &joined));
    }

    #[test]
    fn path_is_under_rejects_a_sibling_and_an_ancestor() {
        let root = Path::new("C:/data/installed-apps/sample/files");
        assert!(!path_is_under(root, Path::new("C:/data/installed-apps/sample/other/x")));
        assert!(!path_is_under(root, Path::new("C:/data/installed-apps/sample")));
        assert!(path_is_under(root, root), "the root is under itself");
    }

    // ── Budgets: the boundary tests T-3.5 requires ─────────────────────────

    /// `count` entries of 1 byte each.
    fn entries(count: usize) -> Vec<(String, u64)> {
        (0..count)
            .map(|index| (format!("f{index}.txt"), 1))
            .collect()
    }

    #[test]
    fn the_entry_count_cap_accepts_exactly_4096_and_rejects_4097() {
        assert_eq!(MAX_ARCHIVE_ENTRIES, 4_096);

        let at_cap = entries(MAX_ARCHIVE_ENTRIES as usize);
        let total = check_archive_budgets(&at_cap).expect("exactly at the cap is accepted");
        assert_eq!(total, MAX_ARCHIVE_ENTRIES);

        let over_cap = entries(MAX_ARCHIVE_ENTRIES as usize + 1);
        let error = check_archive_budgets(&over_cap).expect_err("cap + 1 is refused");
        assert_eq!(error.code, InstalledAppRefusalCode::ArchiveTooLarge);
        assert!(error.detail.contains("4097"));
    }

    #[test]
    fn the_total_uncompressed_cap_accepts_exactly_256_mib_and_rejects_256_mib_plus_one() {
        assert_eq!(MAX_TOTAL_UNCOMPRESSED_BYTES, 256 * 1024 * 1024);

        // The total cap is only reachable through several files: one 256 MiB
        // file trips the PER-FILE cap first, which is the correct precedence
        // (`a_64_mib_file_inside_a_256_mib_archive_rejects_on_the_per_file_rule`).
        // Four 64 MiB files land exactly on the total cap.
        let per_file = MAX_FILE_UNCOMPRESSED_BYTES;
        assert_eq!(per_file * 4, MAX_TOTAL_UNCOMPRESSED_BYTES);

        let at_cap = (0..4)
            .map(|index| (format!("chunk{index}.bin"), per_file))
            .collect::<Vec<_>>();
        let total = check_archive_budgets(&at_cap).expect("exactly 256 MiB is accepted");
        assert_eq!(total, MAX_TOTAL_UNCOMPRESSED_BYTES);

        let mut over_cap = at_cap.clone();
        over_cap.push(("one-byte-over.bin".to_string(), 1));
        let error = check_archive_budgets(&over_cap).expect_err("256 MiB + 1 is refused");
        assert_eq!(error.code, InstalledAppRefusalCode::ArchiveTooLarge);
        assert!(
            error.detail.contains("one-byte-over.bin"),
            "the running-total rule names the entry that crossed it: {}",
            error.detail
        );
    }

    #[test]
    fn the_total_cap_accumulates_across_files() {
        // Two 64 MiB files are fine; four are exactly at the 256 MiB cap; a
        // fifth pushes it over.
        let per_file = MAX_FILE_UNCOMPRESSED_BYTES;
        let four = (0..4)
            .map(|index| (format!("chunk{index}.bin"), per_file))
            .collect::<Vec<_>>();
        assert_eq!(check_archive_budgets(&four).expect("4 x 64 MiB is the cap"), MAX_TOTAL_UNCOMPRESSED_BYTES);

        let five = (0..5)
            .map(|index| (format!("chunk{index}.bin"), per_file))
            .collect::<Vec<_>>();
        assert_eq!(
            check_archive_budgets(&five).expect_err("5 x 64 MiB").code,
            InstalledAppRefusalCode::ArchiveTooLarge
        );
    }

    #[test]
    fn the_per_file_cap_accepts_exactly_64_mib_and_rejects_64_mib_plus_one() {
        assert_eq!(MAX_FILE_UNCOMPRESSED_BYTES, 64 * 1024 * 1024);

        let at_cap = vec![("big.bin".to_string(), MAX_FILE_UNCOMPRESSED_BYTES)];
        check_archive_budgets(&at_cap).expect("exactly 64 MiB in one file is accepted");

        let over_cap = vec![("big.bin".to_string(), MAX_FILE_UNCOMPRESSED_BYTES + 1)];
        let error = check_archive_budgets(&over_cap).expect_err("64 MiB + 1 is refused");
        assert_eq!(error.code, InstalledAppRefusalCode::ArchiveTooLarge);
        assert!(
            error.detail.contains("per-file"),
            "the per-file rule must be the one that names itself: {}",
            error.detail
        );
    }

    #[test]
    fn a_64_mib_file_inside_a_256_mib_archive_rejects_on_the_per_file_rule() {
        // The per-file rule fires first even when the total would be legal.
        let entries = vec![
            ("ok.bin".to_string(), MAX_FILE_UNCOMPRESSED_BYTES),
            ("too-big.bin".to_string(), MAX_FILE_UNCOMPRESSED_BYTES + 1),
        ];
        let error = check_archive_budgets(&entries).expect_err("per-file over cap");
        assert_eq!(error.code, InstalledAppRefusalCode::ArchiveTooLarge);
        assert!(error.detail.contains("too-big.bin"));
        assert!(error.detail.contains("per-file"));
    }

    #[test]
    fn an_empty_archive_is_within_every_budget() {
        assert_eq!(check_archive_budgets(&[]).expect("empty is fine"), 0);
    }

    #[test]
    fn a_total_that_overflows_u64_is_refused() {
        let entries = vec![
            ("a.bin".to_string(), u64::MAX),
            ("b.bin".to_string(), u64::MAX),
        ];
        let error = check_archive_budgets(&entries).expect_err("overflow");
        assert_eq!(error.code, InstalledAppRefusalCode::ArchiveTooLarge);
    }

    // ── Entry-type rule ────────────────────────────────────────────────────

    #[test]
    fn the_regular_file_rule_accepts_absent_and_regular_modes() {
        assert!(is_regular_file(None), "no recorded mode is treated as regular");
        assert!(is_regular_file(Some(0)), "a Windows-written zip records 0");
        assert!(is_regular_file(Some(0o100_644)), "a regular file mode");
    }

    #[test]
    fn the_regular_file_rule_refuses_every_special_type() {
        for (mode, label) in [
            (0o120_777u32, "symlink"),
            (0o010_644, "fifo"),
            (0o140_644, "socket"),
            (0o020_644, "char device"),
            (0o060_644, "block device"),
        ] {
            assert!(!is_regular_file(Some(mode)), "{label} must be refused");
        }
    }

    // ── Whole-archive index over a real in-memory zip ──────────────────────

    /// Build a minimal stored-entry zip in memory (the same discipline the
    /// fixture generators use: method 0, fixed DOS date).
    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        fn crc32(data: &[u8]) -> u32 {
            let mut crc = 0xffff_ffffu32;
            for byte in data {
                crc ^= *byte as u32;
                for _ in 0..8 {
                    crc = if crc & 1 != 0 { 0xedb8_8320 ^ (crc >> 1) } else { crc >> 1 };
                }
            }
            crc ^ 0xffff_ffff
        }

        let mut out: Vec<u8> = Vec::new();
        let mut central: Vec<u8> = Vec::new();

        for (name, data) in entries {
            let offset = out.len() as u32;
            let crc = crc32(data);
            let size = data.len() as u32;
            let name_bytes = name.as_bytes();
            let name_len = name_bytes.len() as u16;

            // Local header.
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&20u16.to_le_bytes());
            out.extend_from_slice(&0x0800u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0x0000u16.to_le_bytes());
            out.extend_from_slice(&0x0021u16.to_le_bytes());
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&name_len.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name_bytes);
            out.extend_from_slice(data);

            // Central directory header.
            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&0x0800u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0x0000u16.to_le_bytes());
            central.extend_from_slice(&0x0021u16.to_le_bytes());
            central.extend_from_slice(&crc.to_le_bytes());
            central.extend_from_slice(&size.to_le_bytes());
            central.extend_from_slice(&size.to_le_bytes());
            central.extend_from_slice(&name_len.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u32.to_le_bytes());
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name_bytes);
        }

        let central_offset = out.len() as u32;
        let central_size = central.len() as u32;
        out.extend_from_slice(&central);

        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&central_size.to_le_bytes());
        out.extend_from_slice(&central_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    fn index_of(entries: &[(&str, &[u8])]) -> InstalledAppResult<ArchiveIndex> {
        let bytes = build_zip(entries);
        let archive = ZipArchive::new(Cursor::new(bytes)).expect("valid zip");
        index_archive(archive)
    }

    #[test]
    fn a_well_formed_archive_indexes_every_entry() {
        let index = index_of(&[
            ("fredo-app.json", b"{}"),
            ("index.html", b"<html></html>"),
            ("assets/logo.png", b"png"),
        ])
        .expect("index");
        assert_eq!(index.entries.len(), 3);
        assert_eq!(index.file_entries().count(), 3);
        let manifest = index.manifest_entry().expect("manifest at root");
        assert_eq!(manifest.archive_name, "fredo-app.json");
        assert_eq!(index.total_uncompressed_bytes, 2 + 13 + 3);
    }

    #[test]
    fn an_archive_without_a_root_manifest_indexes_but_reports_no_manifest() {
        let index = index_of(&[("index.html", b"<html></html>")]).expect("index");
        assert!(index.manifest_entry().is_none());
    }

    #[test]
    fn a_nested_manifest_is_not_a_root_manifest() {
        let index = index_of(&[("sub/fredo-app.json", b"{}")]).expect("index");
        assert!(
            index.manifest_entry().is_none(),
            "the manifest must be at the ARCHIVE ROOT, not in a subdirectory"
        );
    }

    #[test]
    fn a_zip_slip_entry_makes_the_whole_archive_invalid() {
        let error = index_of(&[
            ("fredo-app.json", b"{}"),
            ("../../escape.txt", b"owned"),
        ])
        .expect_err("zip slip");
        assert_eq!(error.code, InstalledAppRefusalCode::UnsafePath);
    }

    #[test]
    fn a_reserved_path_entry_makes_the_whole_archive_invalid() {
        let error = index_of(&[("fredo-app.json", b"{}"), ("__fredo/bootstrap.js", b"x")])
            .expect_err("reserved");
        assert_eq!(error.code, InstalledAppRefusalCode::ReservedPath);
    }

    #[test]
    fn entry_bytes_round_trip_and_are_bounded_by_the_declared_size() {
        let payload = b"<html>hello</html>";
        let bytes = build_zip(&[("index.html", payload)]);
        let archive = ZipArchive::new(Cursor::new(bytes)).expect("zip");
        let index = index_archive(archive).expect("index");

        let mut archive = ZipArchive::new(Cursor::new(build_zip(&[("index.html", payload)])))
            .expect("zip");
        let entry = &index.entries[0];
        let read = read_entry_bytes(&mut archive, entry).expect("read");
        assert_eq!(read, payload);
    }
}
