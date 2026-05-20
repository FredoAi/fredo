pub mod commands;
pub mod engine;
pub mod service;
pub mod state;

use crate::runtime::capability::DesktopCapable;

#[allow(dead_code)]
pub struct LlmFeature;

impl DesktopCapable for LlmFeature {}
