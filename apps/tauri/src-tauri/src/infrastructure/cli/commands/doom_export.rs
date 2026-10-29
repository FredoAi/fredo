//! `fredo doom export-dataset` (Spec #3032 ST-5; confined by Spec #3078 ST-3).
//!
//! The local export surface for the Doom fine-tuning dataset. The CLI parses
//! `--format raw|sft|dpo` (default `raw`) and `--out <path>`, then forwards a
//! [`CliCommand::DoomExportDataset`](crate::infrastructure::ipc::CliCommand)
//! to the running app over the local socket, which calls the CLI/IPC export
//! entry (`export_doom_dataset_cli`). LOCAL-ONLY: the CLI performs no network
//! I/O — the export is a local file write.
//!
//! `--out` is CONFINED to `<dataset dir>/exports/`: a plain relative path is
//! joined under it; absolute paths, drive/UNC-prefixed paths and any path with a
//! `..` component are refused; a blank/omitted `--out` writes the default
//! `<dataset dir>/exports/doom-dataset-<ts>.<ext>`.

use clap::{Args, Parser, Subcommand, ValueEnum};

/// `fredo doom` — Doom Mode maintenance commands (local only; no egress).
#[derive(Debug, Args)]
pub struct DoomArgs {
    #[command(subcommand)]
    pub command: DoomCommand,
}

/// The `fredo doom` subcommands.
#[derive(Debug, Subcommand)]
pub enum DoomCommand {
    /// Export the fine-tuning dataset locally (no upload)
    ///
    /// `--out` is confined to `<dataset_dir>/exports/`: a relative path is
    /// joined under it; absolute, drive/UNC-prefixed and `..`-bearing paths are
    /// refused; `--out` omitted (or blank) writes
    /// `<dataset_dir>/exports/doom-dataset-<ts>.<ext>`.
    ///
    /// Exit codes:
    ///   0  the export was written
    ///   1  invalid format, a refused `--out`, an empty dataset, or a write failure
    ///   2  app-not-running
    ExportDataset(DoomExportArgs),
}

/// Arguments for `fredo doom export-dataset`.
#[derive(Debug, Parser)]
pub struct DoomExportArgs {
    /// Export format: `raw` (lossless JSONL, default), `sft`, or `dpo`
    #[arg(long, value_enum, default_value = "raw", value_name = "raw|sft|dpo")]
    pub format: DoomExportFormat,

    /// Target file path, RELATIVE to `<dataset_dir>/exports/`. Absolute paths,
    /// drive/UNC prefixes and `..` components are refused; omitted (or blank)
    /// writes `<dataset_dir>/exports/doom-dataset-<ts>.<ext>`
    #[arg(long, value_name = "PATH")]
    pub out: Option<String>,
}

/// The `--format` value set (the declared, shippable surface — G-254).
///
/// A CLI-surface mirror of ST-1's `DoomDatasetFormat`; kept local so the wire
/// payload is the canonical lowercase token (`raw|sft|dpo`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, ValueEnum)]
#[value(rename_all = "lower")]
pub enum DoomExportFormat {
    /// Lossless JSONL (the concatenated source, verbatim).
    #[default]
    Raw,
    /// Supervised fine-tuning rows (`{prompt, completion, reward, terminal}`).
    Sft,
    /// Preference pairs (`{prompt, chosen, rejected, reward}`).
    Dpo,
}

impl DoomExportFormat {
    /// The canonical wire token (`raw|sft|dpo`) carried in the IPC payload.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Raw => "raw",
            Self::Sft => "sft",
            Self::Dpo => "dpo",
        }
    }
}
