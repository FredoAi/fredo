pub mod capability;

/// The application composition root.
///
/// `AppRuntime` is the explicit registration point for all feature modules.
/// Features declare their capabilities via the [`capability`] traits;
/// the runtime wires state and command handlers into the Tauri builder.
///
/// Following the SAD principle of explicit composition over hidden DI,
/// feature registration in `lib.rs` is intentional and visible.
pub struct AppRuntime;

impl AppRuntime {
    pub fn new() -> Self {
        Self
    }
}

impl Default for AppRuntime {
    fn default() -> Self {
        Self::new()
    }
}
