// Prevent console window from appearing on Windows in GUI mode
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // If any arguments are passed (beyond the binary name), run as the `fredo` CLI.
    // Otherwise, launch the Tauri desktop GUI.
    if args.len() > 1 {
        use clap::Parser;
        // `try_parse` (not `parse`) so a malformed invocation exits 1
        // (`invalid-argument`) — `2` stays reserved for app-not-running (R-3.3),
        // while `--help` / `--version` still exit 0.
        match fredo_lib::infrastructure::cli::Cli::try_parse() {
            Ok(parsed) => {
                if let Err(e) = fredo_lib::infrastructure::cli::run(parsed) {
                    tracing::error!(target: "fredo::cli", error = %e, "CLI error");
                    std::process::exit(1);
                }
            }
            Err(err) => {
                let _ = err.print();
                std::process::exit(fredo_lib::infrastructure::cli::exit_code_for_parse_error(
                    err.kind(),
                ));
            }
        }
    } else {
        fredo_lib::run();
    }
}
