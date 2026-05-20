// Prevent console window from appearing on Windows in GUI mode
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // If any arguments are passed (beyond the binary name), run as the `fredo` CLI.
    // Otherwise, launch the Tauri desktop GUI.
    if args.len() > 1 {
        use clap::Parser;
        let parsed = fredo_lib::infrastructure::cli::Cli::parse();
        if let Err(e) = fredo_lib::infrastructure::cli::run(parsed) {
            eprintln!("fredo: {e}");
            std::process::exit(1);
        }
    } else {
        fredo_lib::run();
    }
}
