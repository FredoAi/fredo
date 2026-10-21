//! Wireframe native file I/O (Spec #3070, ST-6, C5/C6).
//!
//! Everything here is deliberately split into pure rules plus thin filesystem
//! helpers so every branch is unit-testable:
//!
//! - [`resolve_dialog_path`] — per-command seam wins over the shared fallback,
//!   blank values are inert.
//! - [`seam_verdict`] — `FREDO_WIREFRAME_CANCEL` beats
//!   `FREDO_WIREFRAME_FAIL_FILE` beats both path seams and the native dialog.
//! - [`validate_wireframe_document`] — R-4.13 rejection class (unreadable JSON,
//!   foreign `app` tag, unknown/missing `schemaVersion`).
//! - [`decode_png_base64`] / [`write_png_file`] — R-4.9 export bytes.
//!
//! The commands in [`super::commands`] read the environment ONCE per invocation
//! and pass plain `Option<&str>` values here; tests exercise the pure rules and
//! never mutate process-wide environment variables.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;

/// Env seam: every file command returns `Ok(None)` (the user-cancel path).
pub const CANCEL_ENV: &str = "FREDO_WIREFRAME_CANCEL";
/// Env seam: every file command returns the documented error.
pub const FAIL_ENV: &str = "FREDO_WIREFRAME_FAIL_FILE";
/// Env seam: `wireframe_save_as` writes here instead of opening the dialog.
pub const SAVE_PATH_ENV: &str = "FREDO_WIREFRAME_SAVE_PATH";
/// Env seam: `wireframe_open_document` reads here instead of opening the dialog.
pub const OPEN_PATH_ENV: &str = "FREDO_WIREFRAME_OPEN_PATH";
/// Env seam: `wireframe_export_png` writes here instead of opening the dialog.
pub const EXPORT_PATH_ENV: &str = "FREDO_WIREFRAME_EXPORT_PATH";
/// Env seam: shared fallback used by all three commands when their own seam is
/// unset (C6).
pub const SHARED_PATH_ENV: &str = "FREDO_WIREFRAME_FILE_PATH";

/// The exact failure detail the `FAIL_FILE` seam produces (C6 binding).
pub const FAIL_DETAIL: &str =
    "wireframe file operation failed (FREDO_WIREFRAME_FAIL_FILE=1)";

/// Error detail when an export carries no image bytes.
pub const EMPTY_PNG_DETAIL: &str = "wireframe export produced no PNG data";

/// Binding document identity (C1/C9).
pub const WIREFRAME_APP_TAG: &str = "fredo.wireframe";
/// Binding document schema version (C1/C9).
pub const WIREFRAME_SCHEMA_VERSION: u64 = 1;

/// Which seam (if any) short-circuits a file command (C6 precedence).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileSeamVerdict {
    /// No seam is active — resolve a path or open the native dialog.
    Proceed,
    /// `FREDO_WIREFRAME_CANCEL=1`: return `Ok(None)`.
    Cancelled,
    /// `FREDO_WIREFRAME_FAIL_FILE=1`: return the documented error.
    Failed,
}

fn is_enabled(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("1"))
}

fn non_blank(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// Resolve the cancel/fail verdict. Precedence is binding (C6):
/// `CANCEL` > `FAIL_FILE` > path seams > shared fallback > native dialog.
pub fn seam_verdict(cancel: Option<&str>, fail: Option<&str>) -> FileSeamVerdict {
    if is_enabled(cancel) {
        FileSeamVerdict::Cancelled
    } else if is_enabled(fail) {
        FileSeamVerdict::Failed
    } else {
        FileSeamVerdict::Proceed
    }
}

/// Resolve an explicit file path from a command-specific seam and the shared
/// fallback. The command-specific value wins; blank values are inert.
pub fn resolve_dialog_path(
    command_path: Option<&str>,
    shared_path: Option<&str>,
) -> Option<PathBuf> {
    command_path
        .and_then(non_blank)
        .or_else(|| shared_path.and_then(non_blank))
        .map(PathBuf::from)
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// The active seam verdict, read from the process environment.
pub fn env_seam_verdict() -> FileSeamVerdict {
    let cancel = env_value(CANCEL_ENV);
    let fail = env_value(FAIL_ENV);
    seam_verdict(cancel.as_deref(), fail.as_deref())
}

/// The active path for `command_env`, falling back to [`SHARED_PATH_ENV`].
pub fn env_path(command_env: &str) -> Option<PathBuf> {
    let own = env_value(command_env);
    let shared = env_value(SHARED_PATH_ENV);
    resolve_dialog_path(own.as_deref(), shared.as_deref())
}

/// Write the serialised document. The caller runs this off the UI thread.
pub fn write_text_file(path: &Path, contents: &str) -> Result<()> {
    std::fs::write(path, contents)
        .with_context(|| format!("failed to write {}", path.display()))
}

/// Read a file's contents as UTF-8 text.
pub fn read_text_file(path: &Path) -> Result<String> {
    std::fs::read_to_string(path)
        .with_context(|| format!("failed to read {}", path.display()))
}

/// Validate a saved document against the binding file contract (R-4.13).
///
/// Rejects unreadable JSON, a foreign `app` tag and an unknown or missing
/// `schemaVersion`, each with a user-readable message naming the problem.
pub fn validate_wireframe_document(contents: &str) -> Result<()> {
    let value: Value = serde_json::from_str(contents)
        .map_err(|_| anyhow!("This file is not readable JSON. Nothing changed."))?;

    let object = value.as_object().ok_or_else(|| {
        anyhow!("This file isn't a Wireframe document. Nothing changed.")
    })?;

    let app = object.get("app").and_then(Value::as_str);
    if app != Some(WIREFRAME_APP_TAG) {
        bail!(
            "This file isn't a Wireframe document (app tag \"{}\"). Nothing changed.",
            app.unwrap_or("missing")
        );
    }

    let schema_version = object.get("schemaVersion").and_then(Value::as_u64);
    if schema_version != Some(WIREFRAME_SCHEMA_VERSION) {
        let label = schema_version
            .map(|version| version.to_string())
            .unwrap_or_else(|| "missing".to_string());
        bail!(
            "Unsupported Wireframe document version \"{label}\". Nothing changed."
        );
    }

    Ok(())
}

/// Read + validate a document file. Validation happens BEFORE the contents are
/// returned, so a rejected file never reaches the frontend store.
pub fn read_document(path: &Path) -> Result<String> {
    let contents = read_text_file(path)?;
    validate_wireframe_document(&contents)?;
    Ok(contents)
}

/// Decode the base64 PNG produced by the canvas capture.
///
/// Empty (or whitespace-only) payloads are rejected — that is the "nothing to
/// export" case, surfaced as an error rather than an empty file.
pub fn decode_png_base64(png_base64: &str) -> Result<Vec<u8>> {
    let trimmed = png_base64.trim();
    if trimmed.is_empty() {
        bail!("{EMPTY_PNG_DETAIL}");
    }
    let bytes = STANDARD
        .decode(trimmed)
        .context("wireframe PNG data is not valid base64")?;
    if bytes.is_empty() {
        bail!("{EMPTY_PNG_DETAIL}");
    }
    Ok(bytes)
}

/// Decode the base64 PNG and write the raw bytes.
pub fn write_png_file(path: &Path, png_base64: &str) -> Result<()> {
    let bytes = decode_png_base64(png_base64)?;
    std::fs::write(path, bytes)
        .with_context(|| format!("failed to write {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(name);
        (dir, path)
    }

    // ── C6 precedence matrix ────────────────────────────────────────────────

    #[test]
    fn seam_verdict_proceeds_when_no_seam_is_set() {
        assert_eq!(seam_verdict(None, None), FileSeamVerdict::Proceed);
        assert_eq!(seam_verdict(Some(""), Some("")), FileSeamVerdict::Proceed);
        assert_eq!(seam_verdict(Some("0"), Some("0")), FileSeamVerdict::Proceed);
        assert_eq!(
            seam_verdict(Some("true"), Some("yes")),
            FileSeamVerdict::Proceed,
            "only the literal 1 enables a seam"
        );
    }

    #[test]
    fn seam_verdict_cancel_wins_over_fail() {
        assert_eq!(
            seam_verdict(Some("1"), Some("1")),
            FileSeamVerdict::Cancelled
        );
        assert_eq!(
            seam_verdict(Some("1"), Some("0")),
            FileSeamVerdict::Cancelled
        );
    }

    #[test]
    fn seam_verdict_fail_applies_when_cancel_is_inert() {
        assert_eq!(
            seam_verdict(Some("0"), Some("1")),
            FileSeamVerdict::Failed
        );
        assert_eq!(
            seam_verdict(None, Some("1")),
            FileSeamVerdict::Failed
        );
    }

    #[test]
    fn seam_verdict_trims_enabling_values() {
        assert_eq!(
            seam_verdict(Some(" 1 "), None),
            FileSeamVerdict::Cancelled
        );
        assert_eq!(seam_verdict(None, Some(" 1 ")), FileSeamVerdict::Failed);
    }

    #[test]
    fn fail_detail_matches_the_documented_string() {
        assert_eq!(
            FAIL_DETAIL,
            "wireframe file operation failed (FREDO_WIREFRAME_FAIL_FILE=1)"
        );
    }

    // ── Path resolution ────────────────────────────────────────────────────

    #[test]
    fn resolve_dialog_path_prefers_the_command_specific_seam() {
        assert_eq!(
            resolve_dialog_path(Some("save.json"), Some("shared.json")),
            Some(PathBuf::from("save.json"))
        );
    }

    #[test]
    fn resolve_dialog_path_falls_back_to_the_shared_seam() {
        assert_eq!(
            resolve_dialog_path(None, Some("shared.json")),
            Some(PathBuf::from("shared.json"))
        );
        assert_eq!(
            resolve_dialog_path(Some("   "), Some("shared.json")),
            Some(PathBuf::from("shared.json")),
            "a blank command seam is inert"
        );
    }

    #[test]
    fn resolve_dialog_path_is_none_when_both_seams_are_inert() {
        assert_eq!(resolve_dialog_path(None, None), None);
        assert_eq!(resolve_dialog_path(Some(""), Some("  ")), None);
    }

    #[test]
    fn resolve_dialog_path_trims_whitespace() {
        assert_eq!(
            resolve_dialog_path(Some("  C:\\tmp\\save.json  "), None),
            Some(PathBuf::from("C:\\tmp\\save.json"))
        );
    }

    #[test]
    fn each_command_has_its_own_path_seam_constant() {
        let seams = [
            SAVE_PATH_ENV,
            OPEN_PATH_ENV,
            EXPORT_PATH_ENV,
            SHARED_PATH_ENV,
            CANCEL_ENV,
            FAIL_ENV,
        ];
        assert_eq!(seams.len(), 6);
        assert!(seams.iter().all(|name| name.starts_with("FREDO_WIREFRAME_")));
    }

    // ── R-4.13 document validation ─────────────────────────────────────────

    const VALID_DOCUMENT: &str = r#"{
        "schemaVersion": 1,
        "app": "fredo.wireframe",
        "page": { "preset": "desktop", "width": 1280, "height": 800 },
        "elements": []
    }"#;

    #[test]
    fn valid_document_is_accepted() {
        assert!(validate_wireframe_document(VALID_DOCUMENT).is_ok());
    }

    #[test]
    fn unreadable_json_is_rejected() {
        let error = validate_wireframe_document("{ not json").expect_err("invalid JSON");
        assert!(error.to_string().contains("not readable JSON"));
    }

    #[test]
    fn foreign_app_tag_is_rejected() {
        let foreign = r#"{ "schemaVersion": 1, "app": "something.else" }"#;
        let error = validate_wireframe_document(foreign).expect_err("foreign app");
        assert!(error.to_string().contains("something.else"));
        assert!(error.to_string().contains("isn't a Wireframe document"));
    }

    #[test]
    fn missing_app_tag_is_rejected() {
        let missing = r#"{ "schemaVersion": 1 }"#;
        let error = validate_wireframe_document(missing).expect_err("missing app");
        assert!(error.to_string().contains("missing"));
    }

    #[test]
    fn unknown_schema_version_is_rejected() {
        let unknown = r#"{ "schemaVersion": 2, "app": "fredo.wireframe" }"#;
        let error = validate_wireframe_document(unknown).expect_err("unknown version");
        assert!(error.to_string().contains("version \"2\""));
    }

    #[test]
    fn missing_schema_version_is_rejected() {
        let missing = r#"{ "app": "fredo.wireframe" }"#;
        let error = validate_wireframe_document(missing).expect_err("missing version");
        assert!(error.to_string().contains("version \"missing\""));
    }

    #[test]
    fn non_numeric_schema_version_is_rejected() {
        let wrong_type = r#"{ "schemaVersion": "1", "app": "fredo.wireframe" }"#;
        assert!(validate_wireframe_document(wrong_type).is_err());
    }

    #[test]
    fn a_json_array_is_not_a_document() {
        assert!(validate_wireframe_document("[]").is_err());
    }

    // ── File helpers ───────────────────────────────────────────────────────

    #[test]
    fn text_file_round_trips() {
        let (_dir, path) = temp_file("doc.wireframe.json");
        write_text_file(&path, VALID_DOCUMENT).expect("write");
        assert_eq!(read_text_file(&path).expect("read"), VALID_DOCUMENT);
    }

    #[test]
    fn read_document_returns_valid_contents() {
        let (_dir, path) = temp_file("doc.wireframe.json");
        write_text_file(&path, VALID_DOCUMENT).expect("write");
        assert_eq!(read_document(&path).expect("read document"), VALID_DOCUMENT);
    }

    #[test]
    fn read_document_rejects_a_foreign_file_without_returning_contents() {
        let (_dir, path) = temp_file("foreign.json");
        write_text_file(&path, r#"{ "schemaVersion": 1, "app": "other" }"#).expect("write");
        let error = read_document(&path).expect_err("foreign document");
        assert!(error.to_string().contains("other"));
    }

    #[test]
    fn read_document_reports_a_missing_file() {
        let (_dir, path) = temp_file("absent.wireframe.json");
        let error = read_document(&path).expect_err("missing file");
        assert!(error.to_string().contains("failed to read"));
    }

    #[test]
    fn empty_document_contents_round_trip_as_unreadable_json() {
        let (_dir, path) = temp_file("empty.wireframe.json");
        write_text_file(&path, "").expect("write");
        assert!(read_document(&path).is_err());
    }

    // ── R-4.9 PNG export ───────────────────────────────────────────────────

    /// A minimal 1x1 transparent PNG.
    const ONE_PIXEL_PNG_BASE64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    #[test]
    fn png_base64_is_decoded_and_written_verbatim() {
        let (_dir, path) = temp_file("page.png");
        write_png_file(&path, ONE_PIXEL_PNG_BASE64).expect("write png");

        let bytes = std::fs::read(&path).expect("read png");
        let expected = STANDARD.decode(ONE_PIXEL_PNG_BASE64).expect("decode");
        assert_eq!(bytes, expected);
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "PNG signature");
    }

    #[test]
    fn png_base64_decode_accepts_surrounding_whitespace() {
        let padded = format!("  {ONE_PIXEL_PNG_BASE64}\n");
        assert_eq!(
            decode_png_base64(&padded).expect("decode"),
            STANDARD.decode(ONE_PIXEL_PNG_BASE64).expect("decode")
        );
    }

    #[test]
    fn empty_png_payload_is_rejected() {
        let error = decode_png_base64("").expect_err("empty png");
        assert_eq!(error.to_string(), EMPTY_PNG_DETAIL);
        assert!(decode_png_base64("   \n").is_err());
    }

    #[test]
    fn invalid_base64_png_payload_is_rejected() {
        let error = decode_png_base64("not-base64!!").expect_err("invalid base64");
        assert!(error.to_string().contains("base64"));
    }

    #[test]
    fn empty_png_write_creates_no_file() {
        let (_dir, path) = temp_file("page.png");
        assert!(write_png_file(&path, "").is_err());
        assert!(!path.exists(), "a failed export must not leave a file");
    }
}
