//! `fredo ingest` — the headless ingest daemon subcommand (Spec #2992, ST-5).
//!
//! The clap surface only. The daemon lifecycle lives in
//! [`crate::features::pg_supervisor::headless::run_ingest_daemon`]; this struct
//! is re-exported there as `IngestDaemonArgs` (the frozen names-block type).
//!
//! # Value mapping (G-296: CLI flag > env > default)
//!
//! Every flag maps to the env seam the daemon already honours; a flag is applied
//! ONLY when supplied, so a caller-supplied env value is never overridden by an
//! internal default. The daemon never mutates the process environment.

use std::path::PathBuf;

use clap::Parser;

/// Run the headless ingest daemon (embedded PostgreSQL + OTLP receivers).
///
/// The full help (flags, defaults, and exit codes) is attached to the `Ingest`
/// subcommand variant in `infrastructure/cli/mod.rs`.
#[derive(Parser, Debug, Clone)]
pub struct IngestArgs {
    /// Override the OS app-data dir (maps to FREDO_DATA_DIR; default
    /// %APPDATA%\com.fredo.app)
    #[arg(long = "data-dir", value_name = "PATH")]
    pub data_dir: Option<PathBuf>,

    /// Embedded PostgreSQL data dir (maps to FREDO_PG_DATA_DIR; default
    /// <data-dir>\postgres)
    #[arg(long = "pg-data-dir", value_name = "PATH")]
    pub pg_data_dir: Option<PathBuf>,

    /// Exclusive data-dir lock dir (maps to FREDO_PG_LOCK_DIR; default <data-dir>)
    #[arg(long = "lock-dir", value_name = "PATH")]
    pub lock_dir: Option<PathBuf>,

    /// OTLP/gRPC loopback port (maps to FREDO_INGEST_GRPC_PORT; default 4317)
    #[arg(long = "grpc-port", value_name = "PORT", value_parser = parse_nonzero_port)]
    pub grpc_port: Option<u16>,

    /// OTLP/HTTP loopback port (maps to FREDO_INGEST_HTTP_PORT; default 4318)
    #[arg(long = "http-port", value_name = "PORT", value_parser = parse_nonzero_port)]
    pub http_port: Option<u16>,

    /// Bounded run in milliseconds (maps to FREDO_INGEST_RUN_MS; unset = run until
    /// signal)
    #[arg(long = "run-ms", value_name = "MS")]
    pub run_ms: Option<u64>,

    /// Graceful-shutdown trigger file (maps to FREDO_INGEST_SHUTDOWN_FILE; the
    /// daemon shuts down when this file exists)
    #[arg(long = "shutdown-file", value_name = "PATH")]
    pub shutdown_file: Option<PathBuf>,
}

/// A port parser that rejects `0` (the OS-assigned ephemeral form is not a valid
/// receiver port; `--grpc-port 0` is a usage error, not a silent ephemeral bind).
fn parse_nonzero_port(raw: &str) -> Result<u16, String> {
    let port: u16 = raw
        .parse()
        .map_err(|_| format!("`{raw}` is not a valid port (expected 1-65535)"))?;
    if port == 0 {
        return Err("port 0 is not allowed (expected 1-65535)".to_string());
    }
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Subcommand;

    #[derive(Parser, Debug)]
    struct Harness {
        #[command(subcommand)]
        command: HarnessCommand,
    }

    #[derive(Subcommand, Debug)]
    enum HarnessCommand {
        Ingest(IngestArgs),
    }

    fn parse(argv: &[&str]) -> IngestArgs {
        let mut full = vec!["fredo"];
        full.extend_from_slice(argv);
        match Harness::try_parse_from(full).expect("parses").command {
            HarnessCommand::Ingest(args) => args,
        }
    }

    #[test]
    fn ingest_parses_every_flag() {
        let args = parse(&[
            "ingest",
            "--data-dir",
            "C:/data",
            "--pg-data-dir",
            "C:/pg",
            "--lock-dir",
            "C:/lock",
            "--grpc-port",
            "9999",
            "--http-port",
            "9998",
            "--run-ms",
            "1234",
            "--shutdown-file",
            "C:/stop.flag",
        ]);
        assert_eq!(args.data_dir, Some(PathBuf::from("C:/data")));
        assert_eq!(args.pg_data_dir, Some(PathBuf::from("C:/pg")));
        assert_eq!(args.lock_dir, Some(PathBuf::from("C:/lock")));
        assert_eq!(args.grpc_port, Some(9999));
        assert_eq!(args.http_port, Some(9998));
        assert_eq!(args.run_ms, Some(1234));
        assert_eq!(args.shutdown_file, Some(PathBuf::from("C:/stop.flag")));
    }

    #[test]
    fn ingest_defaults_are_all_unset_so_env_wins() {
        let args = parse(&["ingest"]);
        assert!(args.data_dir.is_none());
        assert!(args.pg_data_dir.is_none());
        assert!(args.lock_dir.is_none());
        assert!(args.grpc_port.is_none());
        assert!(args.http_port.is_none());
        assert!(args.run_ms.is_none());
        assert!(args.shutdown_file.is_none());
    }

    #[test]
    fn grpc_port_zero_is_rejected() {
        let mut full = vec!["fredo", "ingest", "--grpc-port", "0"];
        let error = Harness::try_parse_from(full.drain(..))
            .expect_err("port 0 must be rejected");
        assert!(
            error.to_string().contains("port 0 is not allowed"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn http_port_zero_is_rejected() {
        let error = Harness::try_parse_from(["fredo", "ingest", "--http-port", "0"])
            .expect_err("port 0 must be rejected");
        assert!(
            error.to_string().contains("port 0 is not allowed"),
            "unexpected error: {error}"
        );
    }
}
