use clap::Parser;

/// Open a Fredo app window by its identity.
///
/// <IDENTITY> is a feature's stable id (`mission-monitor`) or its display name
/// (`Mission Monitor`); matching is case-insensitive and quotes are allowed.
#[derive(Parser, Debug)]
pub struct OpenAppArgs {
    /// Feature stable id (`mission-monitor`) or display name (`Mission Monitor`)
    #[arg(value_name = "IDENTITY")]
    pub identity: String,
}
