pub mod commands;
pub mod state;

use crate::runtime::capability::DesktopCapable;

#[allow(dead_code)]
pub struct TerminalFeature;

impl DesktopCapable for TerminalFeature {}
