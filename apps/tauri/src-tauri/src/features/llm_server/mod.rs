//! Out-of-process companion inference via a managed `llama-server` (Spec #2857).
//!
//! ST-2 owns the PURE launch-configuration model ([`config`]) and the AppStore
//! key constants every other sub-task consumes. Process lifecycle (`state.rs`,
//! `process.rs`, `health.rs`, `commands.rs`) lands in ST-3; chat routing in
//! ST-4. Nothing here spawns a process, performs HTTP, or touches Tauri.

pub mod config;

// ── AppStore keys (AppStore remains the single source of truth) ────────────────
//
// These are the persisted setting names the launch flow reads/writes. ST-2
// declares them; ST-3/ST-4 own their persistence — never hard-code a literal at
// a call site.

/// Absolute path to the resolved `llama-server` executable.
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
