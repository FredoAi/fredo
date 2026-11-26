//! The three installed-application management Tauri commands (Spec #3144, ST-2).
//!
//! Exactly three, and no others:
//!
//! | Command | Args (camelCase) | Success | Failure |
//! |---|---|---|---|
//! | [`installed_app_disable`] | `appId: string` | [`InstalledAppEntry`] (state `disabled`) | [`InstalledAppError`] |
//! | [`installed_app_enable`] | `appId: string` | [`InstalledAppEntry`] (state `working`\|`failing`) | [`InstalledAppError`] |
//! | [`installed_app_remove`] | `appId: string` | [`InstalledAppRemovalOutcome`] | [`InstalledAppError`] |
//!
//! # What each command is allowed to touch
//!
//! - **disable / enable** record ONE boolean in the host-owned lifecycle file
//!   (`<app_data_dir>/installed-apps-state.json`) and close the application's
//!   window when turning it off. They never touch the package's files, its
//!   install record, its grants or its stored data (R-2.5). A disable takes
//!   effect on the NEXT call with no restart.
//! - **remove** closes the window, removes the install directory (rename-aside
//!   then delete — the registry is consistent even when the bytes cannot be freed
//!   immediately), drops the application's grants and its lifecycle record, and
//!   **KEEPS its stored data** (AC-3). There is no `DROP TABLE` path here and no
//!   change to the registry's no-drop rule.
//!
//! # Built-in tier only
//!
//! These three are registered for the built-in window class
//! (`capabilities/app-commands.json`); the installed tier's ONE capability grants
//! only `allow-installed-app-invoke`, so an `installed-<id>` document can never
//! manage itself. An unknown id reuses the frozen `id_not_installed`; no new
//! refusal code is added (the 22-code vocabulary is frozen).
//!
//! # Nothing at startup
//!
//! None of these is called from `lib.rs`'s setup closure — the app-data dir is
//! resolved per call, and each is reached only by a user action in the settings
//! pane.

use std::path::Path;

use serde::Serialize;
use tauri::AppHandle;

use super::commands_install::app_data_dir;
use super::store::{self, InstalledAppEntry};
use super::window::{self, TauriWindowHost};
use super::{consent, lifecycle};
use super::{InstalledAppError, InstalledAppRefusalCode, InstalledAppResult};

/// The result of a removal (Spec #3144): what was removed, and what happened to
/// the application's stored data.
///
/// `data_kept` is ALWAYS `true` in this slice — removal never destroys data — and
/// `data_tables` names the tables the package declared (so the disclosure the
/// user read has a machine-checkable counterpart).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAppRemovalOutcome {
    pub app_id: String,
    pub removed: bool,
    pub data_kept: bool,
    pub data_tables: Vec<String>,
}

/// Refuse an id with no install directory, reusing the frozen `id_not_installed`.
fn require_installed(data_dir: &Path, id: &str) -> InstalledAppResult<()> {
    let dir = store::app_dir(&store::install_root(data_dir), id);
    if dir.is_dir() {
        return Ok(());
    }
    Err(InstalledAppError::field(
        InstalledAppRefusalCode::IdNotInstalled,
        "appId",
        format!("\"{id}\" is not installed"),
    ))
}

/// The recomposed list entry for one application: the resilient projection plus
/// this application's grants and its resolved lifecycle state.
///
/// Reuses the ONE resilient reader and the ONE consent reader, so a management
/// command's response can never disagree with the next listing.
fn compose_entry(data_dir: &Path, id: &str) -> InstalledAppResult<InstalledAppEntry> {
    let root = store::install_root(data_dir);
    let entries = store::list_installed_resilient(&root)?;
    let entry = entries.into_iter().find(|entry| entry.id == id).ok_or_else(|| {
        InstalledAppError::field(
            InstalledAppRefusalCode::IdNotInstalled,
            "appId",
            format!("\"{id}\" is not installed"),
        )
    })?;
    let grants = consent::grants_for(data_dir, id);
    let (state, failure_code) = lifecycle::state_for(data_dir, id, entry.state, entry.failure_code);
    Ok(entry
        .with_consented(&grants)
        .with_lifecycle(state, failure_code))
}

/// The data tables the package declared, read best-effort from the canonical
/// manifest. An unreadable manifest yields an empty list, never an invented one.
fn declared_tables(data_dir: &Path, id: &str) -> Vec<String> {
    let dir = store::app_dir(&store::install_root(data_dir), id);
    match store::read_manifest_file(&dir) {
        Ok(manifest) => manifest
            .capabilities
            .as_ref()
            .map(|capabilities| {
                capabilities
                    .data_tables()
                    .iter()
                    .map(|table| table.name.clone())
                    .collect()
            })
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Turn an installed application OFF (R-2.1 / R-2.2).
///
/// Records the disabled state, then closes the application's window if it is
/// open. Effective on the next `installed_app_open` with no restart. Refuses an
/// unknown id with `id_not_installed`.
#[tauri::command]
pub async fn installed_app_disable(
    app: AppHandle,
    app_id: String,
) -> InstalledAppResult<InstalledAppEntry> {
    let id = window::normalize_app_id(&app_id)?;
    let data_dir = app_data_dir(&app)?;
    require_installed(&data_dir, &id)?;

    lifecycle::set_disabled(&data_dir, &id, true)?;
    // Anything the application currently has running is stopped.
    window::close_installed_window(&TauriWindowHost::new(&app), &id)?;

    compose_entry(&data_dir, &id)
}

/// Turn an installed application back ON (R-2.3).
///
/// Records the enabled state. The application can be opened again with no Fredo
/// restart; its state reads `working` or `failing` depending on what the host has
/// recorded. Refuses an unknown id with `id_not_installed`.
#[tauri::command]
pub async fn installed_app_enable(
    app: AppHandle,
    app_id: String,
) -> InstalledAppResult<InstalledAppEntry> {
    let id = window::normalize_app_id(&app_id)?;
    let data_dir = app_data_dir(&app)?;
    require_installed(&data_dir, &id)?;

    lifecycle::set_disabled(&data_dir, &id, false)?;

    compose_entry(&data_dir, &id)
}

/// Remove an installed application (AC-3 / R-3.2 / R-3.3 / R-3.4).
///
/// Closes the window if open, removes the install directory, drops the
/// application's grants and its lifecycle record, and KEEPS its stored data. The
/// returned outcome names the declared tables and reports `data_kept: true`; an
/// unknown id is refused with `id_not_installed`.
#[tauri::command]
pub async fn installed_app_remove(
    app: AppHandle,
    app_id: String,
) -> InstalledAppResult<InstalledAppRemovalOutcome> {
    let id = window::normalize_app_id(&app_id)?;
    let data_dir = app_data_dir(&app)?;
    require_installed(&data_dir, &id)?;

    // The declared tables (what the application could have stored into) — the
    // machine-checkable counterpart of the disclosure the user read.
    let data_tables = declared_tables(&data_dir, &id);

    // Stop it if it is running: closing the window also releases its file handles.
    window::close_installed_window(&TauriWindowHost::new(&app), &id)?;

    // Remove the install directory off the IPC thread. Past the rename inside
    // `remove_install`, the application is ABSENT from the inventory even if the
    // bytes cannot be freed immediately (the registry stays consistent).
    let remove_dir = data_dir.clone();
    let remove_id = id.clone();
    tauri::async_runtime::spawn_blocking(move || store::remove_install(&remove_dir, &remove_id))
        .await
        .map_err(|error| {
            InstalledAppError::new(
                InstalledAppRefusalCode::IoError,
                format!("the removal task could not be run: {error}"),
            )
        })??;

    // Drop the application's grants and its lifecycle record. Its stored DATA is
    // KEPT (the registry's no-drop rule is untouched). Best-effort: the directory
    // is already gone, so a cleanup write failure must not report the removal as
    // failed.
    for capability in consent::grants_for(&data_dir, &id) {
        let _ = consent::revoke(&data_dir, &id, &capability);
    }
    let _ = lifecycle::forget(&data_dir, &id);

    Ok(InstalledAppRemovalOutcome {
        app_id: id,
        removed: true,
        data_kept: true,
        data_tables,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The command surface this module owns is exactly three functions — a guard
    /// so a later sub-task's command cannot be added here by accident.
    #[test]
    fn the_module_owns_exactly_the_three_management_commands() {
        let source = include_str!("commands_manage.rs");
        let product = source
            .find("#[cfg(test)]")
            .map(|split| &source[..split])
            .unwrap_or(source);

        let attribute = ["#[tauri", "::command]"].concat();
        assert_eq!(
            product.matches(&attribute).count(),
            3,
            "commands_manage.rs must carry exactly disable + enable + remove"
        );
        for expected in [
            "pub async fn installed_app_disable(",
            "pub async fn installed_app_enable(",
            "pub async fn installed_app_remove(",
        ] {
            assert!(product.contains(expected), "missing {expected}");
        }
        assert_eq!(
            product.matches("    app_id: String,").count(),
            3,
            "each command takes exactly one `appId: string` argument"
        );
        for other in [
            "installed_app_install",
            "installed_apps_list",
            "installed_app_open",
            "installed_app_close",
            "installed_apps_push_theme",
        ] {
            assert!(
                !product.contains(&format!("pub async fn {other}(")),
                "{other} belongs to another sub-task"
            );
        }
    }

    #[test]
    fn the_removal_outcome_wire_shape_is_camel_case() {
        let value = serde_json::to_value(InstalledAppRemovalOutcome {
            app_id: "qa3144-valid".into(),
            removed: true,
            data_kept: true,
            data_tables: vec!["notes".into(), "shared_log".into()],
        })
        .expect("serialize");
        assert_eq!(value["appId"], "qa3144-valid");
        assert_eq!(value["removed"], true);
        assert_eq!(value["dataKept"], true);
        assert_eq!(value["dataTables"], serde_json::json!(["notes", "shared_log"]));
        assert_eq!(
            value.as_object().expect("object").len(),
            4,
            "the wire shape is exactly the four documented keys: {value}"
        );
    }

    #[test]
    fn an_unknown_id_is_refused_with_the_frozen_code() {
        let data = tempfile::tempdir().expect("tempdir");
        let error = require_installed(data.path(), "qa3144-ghost").expect_err("not installed");
        assert_eq!(error.code, InstalledAppRefusalCode::IdNotInstalled);
        assert_eq!(error.field.as_deref(), Some("appId"));
    }
}
