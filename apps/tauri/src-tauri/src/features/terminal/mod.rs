pub mod commands;
pub mod open_terminal;
pub mod persistence;
pub mod resume;
pub mod state;

use crate::runtime::capability::DesktopCapable;

#[allow(dead_code)]
pub struct TerminalFeature;

impl DesktopCapable for TerminalFeature {}
