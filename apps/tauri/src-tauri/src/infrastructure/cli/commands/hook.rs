use clap::Args;

/// Forward an agent lifecycle hook event to the Fredo desktop app.
///
/// Hook scripts (defined in the Fredo Copilot/Claude CLI plugin) pipe the JSON
/// payload supplied by the agent runtime into this command. fredo emits a
/// corresponding stream event into the UI so every hook can be observed in the
/// mission-control panel.
///
/// Usage from a hook script:
///   INPUT=$(cat)
///   fredo hook <EventName> --payload "$INPUT" &
#[derive(Debug, Args)]
pub struct HookArgs {
    /// Name of the hook event (e.g. SessionStart, PreToolUse, Stop).
    pub event_type: String,

    /// JSON payload from the agent runtime. When omitted, JSON is read from stdin.
    #[arg(short, long)]
    pub payload: Option<String>,
}
