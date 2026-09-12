pub mod commands;
pub mod model_download;
pub mod model_download_state;

use crate::runtime::capability::DesktopCapable;

#[allow(dead_code)]
pub struct SetupFeature;

impl DesktopCapable for SetupFeature {}
