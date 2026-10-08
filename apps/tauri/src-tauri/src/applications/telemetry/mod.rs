//! Telemetry application module.
//!
//! Provides IPC commands for telemetry management (stats, purge, toggle).
//! Registered as a DesktopCapable application.

pub mod commands;

use crate::runtime::capability::DesktopCapable;

#[allow(dead_code)]
pub struct TelemetryApplication;

impl DesktopCapable for TelemetryApplication {}
