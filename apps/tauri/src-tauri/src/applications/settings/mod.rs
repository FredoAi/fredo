pub mod autostart;
pub mod commands;
/// Spec #3206 ST-4 — the ONE outbound link hand-off (Settings → Credits, AC-5):
/// a pure, pre-I/O `https`-only validator plus the `open_external_link` command.
pub mod credits;

use crate::runtime::capability::DesktopCapable;

#[allow(dead_code)]
pub struct SettingsApplication;

impl DesktopCapable for SettingsApplication {}
