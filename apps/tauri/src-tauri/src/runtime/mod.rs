pub mod capability;
// Spec #3146 — the installed tier's static authority guards. `#[cfg(test)]` on
// purpose: they assert committed static artefacts (capabilities/*.json,
// permissions/app/default.toml, the manifest and the registration block), so they
// belong to `cargo test --lib` and must not compile a line of runtime code.
#[cfg(test)]
mod capability_guard;
// Spec #3147 ST-1 — the application command manifest. `build.rs` `include!`-s
// this file to hand the list to `tauri_build::AppManifest::commands(...)`; in
// the app crate it carries the drift guard that keeps the list a superset of
// `lib.rs`'s `generate_handler![]`. See the module docs for why both halve.
pub mod command_manifest;

/// The application composition root.
///
/// `AppRuntime` is the explicit registration point for all application modules.
/// Applications declare their capabilities via the [`capability`] traits;
/// the runtime wires state and command handlers into the Tauri builder.
///
/// Following the SAD principle of explicit composition over hidden DI,
/// application registration in `lib.rs` is intentional and visible.
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
