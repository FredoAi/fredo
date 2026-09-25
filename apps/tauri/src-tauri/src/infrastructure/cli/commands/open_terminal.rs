use clap::Parser;

/// Open the Fredo Terminal window, optionally starting a session in a folder.
///
/// Both values are free-form `Option<String>`s so clap does NOT pre-empt the
/// application's own validation: an unknown `--cli` must yield the running
/// app's `invalid-cli` outcome (exit 1), never a clap parse error, and a
/// `--dir` that does not exist is refused in-app before any window opens.
#[derive(Parser, Debug)]
pub struct OpenTerminalArgs {
    /// Session type to start: `shell` (plain OS shell), `opencode` or `copilot`
    /// (defaults to the saved default session type)
    #[arg(long, value_name = "shell|opencode|copilot")]
    pub cli: Option<String>,

    /// Working directory to start it in (defaults to the saved work dir)
    #[arg(long, value_name = "PATH")]
    pub dir: Option<String>,
}
