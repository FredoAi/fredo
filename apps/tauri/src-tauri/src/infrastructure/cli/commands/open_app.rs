use clap::Parser;

/// Open a Fredo app window by its identity.
///
/// <IDENTITY> is an application's stable id (`mission-monitor`) or its display name
/// (`Mission Monitor`); matching is case-insensitive and quotes are allowed.
#[derive(Parser, Debug)]
pub struct OpenAppArgs {
    /// Application stable id (`mission-monitor`) or display name (`Mission Monitor`)
    #[arg(value_name = "IDENTITY")]
    pub identity: String,
}
