//! Wireframe application module (Spec #3070).
//!
//! ST-6 owns the native file I/O seam: `files` holds the pure resolution rules
//! (env-seam precedence, document validation, PNG decoding) and `commands`
//! exposes the three Tauri commands registered in `lib.rs`.
//!
//! The companion executes no application command (Spec #3152): the app command
//! intent relay and the generated per-surface skill offer were removed with the
//! NavigationEngine, so this application has no companion dispatch path.

pub mod commands;
pub mod files;
