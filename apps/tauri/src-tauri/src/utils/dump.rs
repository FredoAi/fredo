//! Event dump helper — appends JSON payloads to ~/.fredo/event-dump.jsonl.
//!
//! Used for debugging event flow across IPC, OTLP-HTTP, and OTLP-gRPC paths.
//! Replaces the temporary eprintln!("[fredo-dump]...") blocks.

use std::io::Write;

/// Append a JSON payload as a single JSONL line to the event dump file.
/// Silently fails if the home directory cannot be resolved or the file
/// cannot be opened / written.
pub fn append_event_dump(payload_json: &serde_json::Value) {
    let home = match std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        Ok(h) => h,
        Err(_) => return,
    };
    let dir = std::path::PathBuf::from(&home).join(".fredo");
    let _ = std::fs::create_dir_all(&dir);
    let file_path = dir.join("event-dump.jsonl");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file_path)
    {
        let _ = writeln!(
            file,
            "{}",
            serde_json::to_string(payload_json).unwrap_or_default()
        );
    }
}
