pub mod commands;
// The acquisition kernel (ST-1/ST-2) is consumed by the setup command surface
// (`check_model_files` / `download_model`), which ST-3 wires in this same slice.
// Until that wiring lands its public API is intentionally unreferenced, so the
// false-positive dead-code lint is scoped to these two module declarations —
// mirroring the `#[allow(dead_code)]` feature-marker convention used by every
// `features/*/mod.rs` in this crate.
#[allow(dead_code)]
pub mod model_download;
#[allow(dead_code)]
pub mod model_download_state;

use crate::runtime::capability::DesktopCapable;

#[allow(dead_code)]
pub struct SetupFeature;

impl DesktopCapable for SetupFeature {}
