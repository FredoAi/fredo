use clap::Args;

/// Forward an OpenCode plugin event to the Fredo desktop app.
///
/// Plugin scripts pipe the JSON payload supplied by the OpenCode runtime
/// into this command. fredo emits a corresponding stream event into the UI
/// so every plugin hook can be observed in the mission-control panel.
///
/// Usage from a plugin hook:
///   INPUT=$(cat)
///   fredo opencode-plugin <EventType> --payload "$INPUT" &
#[derive(Debug, Args)]
pub struct OpenCodePluginArgs {
    /// Name of the plugin event (e.g. event, chat.message, tool.execute.before).
    pub event_type: String,

    /// JSON payload from the plugin hook. When omitted, JSON is read from stdin.
    #[arg(short, long)]
    pub payload: Option<String>,
}