pub mod commands;

use crate::runtime::capability::DesktopCapable;

#[allow(dead_code)]
pub struct SettingsFeature;

impl DesktopCapable for SettingsFeature {}
