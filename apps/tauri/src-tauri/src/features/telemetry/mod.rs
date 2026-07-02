//! Telemetry feature module.
//!
//! Provides IPC commands for telemetry management (stats, purge, toggle).
//! Registered as a DesktopCapable feature.

pub mod commands;

use crate::runtime::capability::DesktopCapable;

#[allow(dead_code)]
pub struct TelemetryFeature;

impl DesktopCapable for TelemetryFeature {}
