//! Wireframe application module (Spec #3070).
//!
//! ST-6 owns the native file I/O seam: `files` holds the pure resolution rules
//! (env-seam precedence, document validation, PNG decoding) and `commands`
//! exposes the three Tauri commands registered in `lib.rs`.
//!
//! The companion intent relay is application-agnostic since Spec #3099 ST-5:
//! it lives in `infrastructure::app_command` (`app-command-intent` /
//! `app-command-intent-result`, G-124).

pub mod commands;
pub mod files;
