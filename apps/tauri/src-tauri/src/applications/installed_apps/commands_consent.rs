//! The two consent Tauri commands (Spec #3146, ST-2/ST-5).
//!
//! | Command | Args | Success | Failure |
//! |---|---|---|---|
//! | [`installed_app_consent_grant`] | `appId`, `capability` | [`InstalledAppCapabilityStatus`] | [`InstalledAppError`] |
//! | [`installed_app_consent_revoke`] | `appId`, `capability` | [`InstalledAppCapabilityStatus`] | [`InstalledAppError`] |
//!
//! # Built-in tier only
//!
//! These are the commands the settings pane calls, and the settings pane is a
//! built-in window. The installed tier's authority surface is exactly ONE command
//! (`dispatch::installed_app_invoke`, granted by
//! `capabilities/installed-app-commands.json` with `windows: ["installed-*"]`), so
//! an installed document CANNOT reach either command: there is no permission that
//! would let it, and `runtime::capability_guard` pins that the installed
//! capability's permission set is exactly `["allow-installed-app-invoke"]`. The
//! ACL refusal therefore happens before this module's code runs — a host-side
//! consent granted by untrusted code is unreachable by construction, not by a
//! check in here.
//!
//! # Returned status is the authority
//!
//! Both commands return the application's FULL [`InstalledAppCapabilityStatus`]
//! after the write, so the surface that called them renders the host's record
//! rather than a guess. A refusal changes nothing on disk (see
//! [`super::consent::grant`] / [`super::consent::revoke`]).
//!
//! Nothing here runs at startup, and there is no background task.

use super::commands_install::app_data_dir;
use super::consent;
use super::store::InstalledAppCapabilityStatus;
use super::InstalledAppResult;

/// Allow one declared high-risk capability for one application.
///
/// Refused with the frozen install vocabulary when the id is not installed
/// (`id_not_installed`) or the package did not declare `capability` as
/// high-risk (`manifest_invalid_field`, `field: "capability"`). A refusal
/// records nothing (R-4.5).
#[tauri::command]
pub async fn installed_app_consent_grant(
    app: tauri::AppHandle,
    app_id: String,
    capability: String,
) -> InstalledAppResult<InstalledAppCapabilityStatus> {
    let data_dir = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        consent::grant(&data_dir, &app_id, &capability)
    })
    .await
    .map_err(|error| {
        super::InstalledAppError::new(
            super::InstalledAppRefusalCode::IoError,
            format!("the consent task could not be run: {error}"),
        )
    })?
}

/// Revoke one capability for one application.
///
/// Idempotent, and never refused for an unrecognised capability: removing
/// authority is always safe. It never removes an application and never deletes
/// data.
#[tauri::command]
pub async fn installed_app_consent_revoke(
    app: tauri::AppHandle,
    app_id: String,
    capability: String,
) -> InstalledAppResult<InstalledAppCapabilityStatus> {
    let data_dir = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        consent::revoke(&data_dir, &app_id, &capability)
    })
    .await
    .map_err(|error| {
        super::InstalledAppError::new(
            super::InstalledAppRefusalCode::IoError,
            format!("the consent task could not be run: {error}"),
        )
    })?
}

#[cfg(test)]
mod tests {
    /// The command surface this module owns is exactly two functions — a guard so
    /// a later change cannot quietly add a third loaded/consented verb here.
    #[test]
    fn the_module_owns_exactly_the_two_consent_commands() {
        let source = include_str!("commands_consent.rs");
        let product = source
            .find("#[cfg(test)]")
            .map(|split| &source[..split])
            .unwrap_or(source);

        let attribute = ["#[tauri", "::command]"].concat();
        assert_eq!(
            product.matches(&attribute).count(),
            2,
            "commands_consent.rs must carry exactly grant + revoke"
        );
        assert!(product.contains("pub async fn installed_app_consent_grant("));
        assert!(product.contains("pub async fn installed_app_consent_revoke("));
    }

    /// Both commands must be registered, or the settings surface's two calls are
    /// dead ends. The manifest list is the permission source; `lib.rs` is the
    /// handler source; the built-in permission set is what makes them reachable
    /// from the pane's window (the shipped guard requires one grant per
    /// registered command).
    #[test]
    fn the_two_commands_are_registered_manifested_and_granted() {
        for command in ["installed_app_consent_grant", "installed_app_consent_revoke"] {
            assert!(
                crate::runtime::command_manifest::COMMAND_MANIFEST.contains(&command),
                "{command} must be a COMMAND_MANIFEST entry"
            );
            let lib = include_str!("../../lib.rs");
            assert!(
                lib.contains(command),
                "{command} must be registered in lib.rs's generate_handler![]"
            );
            let grants = include_str!("../../../permissions/app/default.toml");
            let permission = format!("\"allow-{}\"", command.replace('_', "-"));
            assert!(
                grants.contains(&permission),
                "{command} must be granted in permissions/app/default.toml ({permission})"
            );
        }

        // ... and the INSTALLED tier still reaches nothing but the dispatcher.
        let installed =
            include_str!("../../../capabilities/installed-app-commands.json");
        assert!(!installed.contains("installed-app-consent"));
        assert!(installed.contains("\"allow-installed-app-invoke\""));
    }
}
