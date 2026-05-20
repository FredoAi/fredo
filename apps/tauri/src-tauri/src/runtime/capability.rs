/// A feature that exposes Tauri command handlers to the desktop UI.
///
/// Implementations own their commands, models, and Tauri state.
/// The composition root in `lib.rs` lists all feature commands in `generate_handler!`.
#[allow(dead_code)]
pub trait DesktopCapable: Send + Sync + 'static {}

/// A feature that exposes a `clap` subcommand for the CLI interface.
///
/// Implementations define their clap args and connect to the IPC socket
/// to forward commands to the running Fredo desktop app.
#[allow(dead_code)]
pub trait CliCapable {}