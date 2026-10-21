//! Wireframe file commands (Spec #3070, ST-6, C5).
//!
//! Three binding command names, each async and each owning its own OS picker via
//! `rfd` (already a declared dependency — no plugin, no capability, no lockfile
//! change). The picker blocks, so it runs on the blocking pool through
//! `tauri::async_runtime::spawn_blocking`; file reads/writes run there too.
//!
//! Every command maps failure to `Err(String)` at the boundary (the frontend
//! turns that into the file-error banner) and never panics: no `unwrap()`.

use std::path::PathBuf;

use serde::Serialize;

use super::files::{self, FileSeamVerdict};

/// The payload returned by `wireframe_open_document` (C5). Camel-case over IPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireframeOpenedDocument {
    pub path: String,
    pub contents: String,
}

/// Return `Some(short-circuit)` when an env seam decides the outcome, `None`
/// when the command should proceed to its path seam / native dialog.
///
/// Precedence is binding: `FREDO_WIREFRAME_CANCEL` > `FREDO_WIREFRAME_FAIL_FILE`.
fn seam_short_circuit() -> Option<Result<Option<()>, String>> {
    match files::env_seam_verdict() {
        FileSeamVerdict::Proceed => None,
        FileSeamVerdict::Cancelled => Some(Ok(None)),
        FileSeamVerdict::Failed => Some(Err(files::FAIL_DETAIL.to_string())),
    }
}

fn join_error(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}: {error}")
}

/// Open the native Save dialog off the UI thread. Returns `None` on cancel.
async fn save_dialog(default_name: String, title: &'static str) -> Result<Option<PathBuf>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title(title)
            .set_file_name(default_name.as_str())
            .add_filter("Wireframe document", &["json"])
            .save_file()
    })
    .await
    .map_err(|error| join_error("wireframe save dialog failed", error))
}

/// Open the native Open dialog off the UI thread. Returns `None` on cancel.
async fn open_dialog() -> Result<Option<PathBuf>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Open Wireframe document")
            .add_filter("Wireframe document", &["json"])
            .pick_file()
    })
    .await
    .map_err(|error| join_error("wireframe open dialog failed", error))
}

/// Open the native Export dialog off the UI thread. Returns `None` on cancel.
async fn export_dialog(default_name: String) -> Result<Option<PathBuf>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("Export Wireframe page as PNG")
            .set_file_name(default_name.as_str())
            .add_filter("PNG image", &["png"])
            .save_file()
    })
    .await
    .map_err(|error| join_error("wireframe export dialog failed", error))
}

/// Save the serialised document (R-4.7).
///
/// `Ok(Some(path))` written · `Ok(None)` user cancelled · `Err(detail)` failed.
#[tauri::command]
pub async fn wireframe_save_as(
    default_name: String,
    contents: String,
) -> Result<Option<String>, String> {
    if let Some(outcome) = seam_short_circuit() {
        return outcome.map(|_| None);
    }

    let path = match files::env_path(files::SAVE_PATH_ENV) {
        Some(path) => Some(path),
        None => save_dialog(default_name, "Save Wireframe document").await?,
    };
    let Some(path) = path else {
        return Ok(None);
    };
    let display = path.to_string_lossy().into_owned();

    tauri::async_runtime::spawn_blocking(move || files::write_text_file(&path, &contents))
        .await
        .map_err(|error| join_error("wireframe save task failed", error))?
        .map_err(|error| error.to_string())?;

    Ok(Some(display))
}

/// Read + validate a saved document (R-4.8 / R-4.13).
///
/// `Ok(Some(document))` read · `Ok(None)` user cancelled · `Err(detail)` failed
/// (unreadable file, foreign `app` tag, unknown/missing `schemaVersion`, or an
/// I/O error). A rejected file never reaches the frontend store.
#[tauri::command]
pub async fn wireframe_open_document() -> Result<Option<WireframeOpenedDocument>, String> {
    if let Some(outcome) = seam_short_circuit() {
        return outcome.map(|_| None);
    }

    let path = match files::env_path(files::OPEN_PATH_ENV) {
        Some(path) => Some(path),
        None => open_dialog().await?,
    };
    let Some(path) = path else {
        return Ok(None);
    };
    let display = path.to_string_lossy().into_owned();

    let contents = tauri::async_runtime::spawn_blocking(move || files::read_document(&path))
        .await
        .map_err(|error| join_error("wireframe open task failed", error))?
        .map_err(|error| error.to_string())?;

    Ok(Some(WireframeOpenedDocument {
        path: display,
        contents,
    }))
}

/// Write the page-capture PNG (R-4.9).
///
/// `Ok(Some(path))` written · `Ok(None)` user cancelled · `Err(detail)` failed.
#[tauri::command]
pub async fn wireframe_export_png(
    default_name: String,
    png_base64: String,
) -> Result<Option<String>, String> {
    if let Some(outcome) = seam_short_circuit() {
        return outcome.map(|_| None);
    }

    let path = match files::env_path(files::EXPORT_PATH_ENV) {
        Some(path) => Some(path),
        None => export_dialog(default_name).await?,
    };
    let Some(path) = path else {
        return Ok(None);
    };
    let display = path.to_string_lossy().into_owned();

    tauri::async_runtime::spawn_blocking(move || files::write_png_file(&path, &png_base64))
        .await
        .map_err(|error| join_error("wireframe export task failed", error))?
        .map_err(|error| error.to_string())?;

    Ok(Some(display))
}
