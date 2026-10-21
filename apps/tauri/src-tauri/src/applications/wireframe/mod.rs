//! Wireframe application module (Spec #3070).
//!
//! ST-6 owns the native file I/O seam: `files` holds the pure resolution rules
//! (env-seam precedence, document validation, PNG decoding) and `commands`
//! exposes the three Tauri commands registered in `lib.rs`.
//!
//! ST-7 owns the Companion relay: `intent` holds the bounded host-side queue
//! plus the `wireframe-intent` / `wireframe-intent-result` commands (G-124).

pub mod commands;
pub mod files;
pub mod intent;
