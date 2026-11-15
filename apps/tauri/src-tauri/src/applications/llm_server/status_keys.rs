//! Persisted-settings key constants for the companion inference engine
//! (Spec #3141, ST-1).
//!
//! This module owns the key NAMES every consumer shares. Engineering rules
//! forbid cross-application imports, so `applications/settings` and
//! `applications/llm_server` each declare their own literal for the same key —
//! these constants are the canonical spelling on the llm_server side.
//!
//! ## What survives the migration
//!
//! * [`LLAMA_SERVER_BACKEND_KEY`] — NEW. The backend switch: a CLOSED enum on
//!   the wire (`auto` | `gpu` | `cpu`, lowercase). An unparseable persisted
//!   value coerces to `auto` on read and NEVER reaches engine configuration.
//! * [`LLAMA_SERVER_COMPANION_DIR_KEY`] — UNCHANGED. The per-environment
//!   companion directory (holds the engine log).
//!
//! ## What is deliberately NOT read any more
//!
//! The retired keys (`llama_server_path`, the port / active-port / host, the
//! health timeout, the PID, the started-at marker, the log path, and the three
//! per-file model path overrides) are NEVER read by the engine: model paths
//! resolve through the shared #2856 manifest (`AC-18`), and there is no process,
//! no port, and no health poll. A stale persisted value for any of them is
//! inert — never deleted, never crashing. Their constants stay declared in
//! `mod.rs` only while the pre-migration launch path they still serve exists;
//! ST-6 deletes that path (and those constants) once every consumer is
//! re-pointed. The engine never imports them.

/// The backend switch setting (`auto` | `gpu` | `cpu`, lowercase).
pub const LLAMA_SERVER_BACKEND_KEY: &str = "llama_server_backend";

/// The per-environment companion directory. UNCHANGED by the migration.
pub const LLAMA_SERVER_COMPANION_DIR_KEY: &str = "llama_server_companion_dir";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_key_matches_the_published_wire_name() {
        assert_eq!(LLAMA_SERVER_BACKEND_KEY, "llama_server_backend");
    }

    #[test]
    fn companion_dir_key_is_unchanged_by_the_migration() {
        assert_eq!(LLAMA_SERVER_COMPANION_DIR_KEY, "llama_server_companion_dir");
    }
}
