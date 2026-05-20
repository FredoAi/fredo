pub mod commands;

use crate::runtime::capability::DesktopCapable;

#[allow(dead_code)]
pub struct SetupFeature;

impl DesktopCapable for SetupFeature {}
