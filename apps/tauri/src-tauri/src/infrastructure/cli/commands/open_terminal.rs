use clap::Parser;

/// Open the Fredo Terminal window, optionally starting a CLI in a folder.
///
/// Both values are free-form `Option<String>`s so clap does NOT pre-empt the
/// application's own validation: an unknown `--cli` must yield the running
/// app's `invalid-cli` outcome (exit 1), never a clap parse error, and a
/// `--dir` that does not exist is refused in-app before any window opens.
#[derive(Parser, Debug)]
pub struct OpenTerminalArgs {
    /// CLI to start: `opencode` or `copilot` (defaults to the saved default CLI)
    #[arg(long, value_name = "opencode|copilot")]
    pub cli: Option<String>,

    /// Working directory to start it in (defaults to the saved work dir)
    #[arg(long, value_name = "PATH")]
    pub dir: Option<String>,
}
