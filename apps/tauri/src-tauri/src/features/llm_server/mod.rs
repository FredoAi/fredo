//! Out-of-process companion inference via a managed `llama-server` (Spec #2857).
//!
//! ST-2 owns the PURE launch-configuration model ([`config`]) and the AppStore
//! key constants every other sub-task consumes. ST-3 adds the process lifecycle
//! ([`state`], [`process`], [`health`], [`commands`]); ST-4 adds chat routing
//! ([`chat`]) and registers the commands in `lib.rs`. The exit hook mechanism
//! lives in `lib.rs` / [`commands::stop_llama_server_on_exit`]; ST-7 owns the
//! startup PID sweep and the kill-on-exit test.

pub mod chat;
pub mod commands;
pub mod config;
pub mod health;
pub mod process;
pub mod state;

// ── AppStore keys (AppStore remains the single source of truth) ────────────────
//
// These are the persisted setting names the launch flow reads/writes. ST-2
// declares them; ST-3/ST-4 own their persistence — never hard-code a literal at
// a call site.

/// Absolute path to the resolved `llama-server` executable.
///
/// The runtime resolver owns the authoritative key
/// (`infrastructure::companion::resolver::LLAMA_SERVER_SETTING_KEY`); this
/// constant exists only so the launch-config key-set test pins the shared
/// string. Gate it to test builds so production has no dead code.
#[cfg(test)]
pub const LLAMA_SERVER_PATH_KEY: &str = "llama_server_path";
/// Configured (preferred) server port.
pub const LLAMA_SERVER_PORT_KEY: &str = "llama_server_port";
/// The port actually bound by the running server (OS-assigned fallback).
pub const LLAMA_SERVER_ACTIVE_PORT_KEY: &str = "llama_server_active_port";
/// Server bind host (localhost only in the reference deployment).
pub const LLAMA_SERVER_HOST_KEY: &str = "llama_server_host";
/// Absolute path to the main model (GGUF).
pub const LLAMA_SERVER_MODEL_PATH_KEY: &str = "llama_server_model_path";
/// Absolute path to the multimodal projector (GGUF).
pub const LLAMA_SERVER_MMPROJ_PATH_KEY: &str = "llama_server_mmproj_path";
/// Absolute path to the MTP draft model (GGUF).
pub const LLAMA_SERVER_MTP_PATH_KEY: &str = "llama_server_mtp_path";
/// Optional persisted argv override for the launch config.
pub const LLAMA_SERVER_ARGS_KEY: &str = "llama_server_args";
/// Bounded health-check timeout, in seconds.
pub const LLAMA_SERVER_HEALTH_TIMEOUT_S_KEY: &str = "llama_server_health_timeout_s";
/// PID of the managed server process.
pub const LLAMA_SERVER_PID_KEY: &str = "llama_server_pid";
/// RFC3339 timestamp marking when the managed server started.
pub const LLAMA_SERVER_STARTED_AT_KEY: &str = "llama_server_started_at";
/// Absolute path to the server's stdout/stderr log file.
pub const LLAMA_SERVER_LOG_PATH_KEY: &str = "llama_server_log_path";

// ── Launch defaults ────────────────────────────────────────────────────────────

/// Default bind host.
pub const DEFAULT_LLAMA_SERVER_HOST: &str = "127.0.0.1";
/// Default port (OS-assigned fallback is persisted as the active port).
pub const DEFAULT_LLAMA_SERVER_PORT: u16 = 8080;
/// Default bounded health-check timeout, in seconds. The reference model load
/// (2.6 GB QAT set at `--ctx-size 131072`) is slow; 180 s covers the documented
/// cold-disk window with no unbounded wait.
pub const DEFAULT_LLAMA_SERVER_HEALTH_TIMEOUT_S: u64 = 180;
