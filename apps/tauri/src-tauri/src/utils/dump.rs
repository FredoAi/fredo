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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── REQ-6/7/8: append_event_dump ─────────────────────────────────────

    #[test]
    fn append_event_dump_writes_jsonl_to_fredo_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_str().unwrap().to_string();

        let old_home = std::env::var("HOME").ok();
        let old_userprofile = std::env::var("USERPROFILE").ok();
        std::env::set_var("HOME", &home);
        std::env::remove_var("USERPROFILE");

        let payload = json!({"event": "test_event", "value": 42});
        append_event_dump(&payload);

        // Restore env vars before assertions
        if let Some(h) = old_home {
            std::env::set_var("HOME", h);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(u) = old_userprofile {
            std::env::set_var("USERPROFILE", u);
        }

        let dump_path = dir.path().join(".fredo").join("event-dump.jsonl");
        assert!(dump_path.exists(), "event-dump.jsonl should exist");

        let content = std::fs::read_to_string(&dump_path).unwrap();
        assert!(
            content.contains("test_event"),
            "dump file should contain the serialized event"
        );
        assert!(
            content.contains("\"value\": 42") || content.contains("\"value\":42"),
            "dump file should contain the numeric value"
        );
    }

    #[test]
    fn append_event_dump_silently_returns_when_home_unset() {
        let old_home = std::env::var("HOME").ok();
        let old_userprofile = std::env::var("USERPROFILE").ok();

        std::env::remove_var("HOME");
        std::env::remove_var("USERPROFILE");

        let payload = json!({"event": "orphan"});
        // Should not panic or crash
        append_event_dump(&payload);

        // Restore env vars
        if let Some(h) = old_home {
            std::env::set_var("HOME", h);
        }
        if let Some(u) = old_userprofile {
            std::env::set_var("USERPROFILE", u);
        }
    }
}
