//! Companion inference (Spec #2857, re-based in-process by Spec #3141).
//!
//! Companion inference moves IN-PROCESS onto the `llama-cpp-4` Rust bindings:
//! no `llama-server` child process, no generated `.bat`, no loopback HTTP hop
//! (`#3141` decision A, reversed). The new runtime lives under [`engine`]; the
//! pre-migration out-of-process surface ([`process`], [`health`], [`config`],
//! [`state`], and the launch commands in [`commands`]) is still present because
//! its live consumers (chat streaming, the Doom agent, the readiness surface)
//! are re-pointed by later sub-tasks — ST-1 adds the engine WITHOUT deleting the
//! old transport it will replace.
//!
//! ST-1 owns the engine skeleton ([`engine`]), the backend switch + typed device
//! readout, and the additive status fields. [`status_keys`] owns the persisted
//! key NAMES the migration keeps and adds.

pub mod chat;
pub mod commands;
pub mod config;
pub mod doom_agent;
pub mod engine;
pub mod health;
pub mod process;
pub mod probe;
pub mod skills;
pub mod state;
pub mod status;
pub mod status_keys;

pub use status_keys::{LLAMA_SERVER_BACKEND_KEY, LLAMA_SERVER_COMPANION_DIR_KEY};

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::infrastructure::env::EnvConfig;
use crate::infrastructure::storage::SettingsStore;

// ── SettingsStore keys (SettingsStore remains the single source of truth) ────────────────
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
// `LLAMA_SERVER_COMPANION_DIR_KEY` (the per-environment companion directory) is
// UNCHANGED by the migration and now lives in [`status_keys`], which re-exports
// it above. Its behaviour is byte-identical (AC-27).
//
// NOTE (Spec #3141 ST-1): the engine NEVER reads any of the `llama_server_*`
// keys above for engine configuration — model paths resolve through the shared
// #2856 manifest (AC-18). These constants stay declared ONLY because the
// pre-migration launch path they still serve is not deleted in ST-1; ST-6
// retires that path and these keys together. A stale persisted value for any of
// them is inert: never deleted, never crashing.

// ── Launch defaults ────────────────────────────────────────────────────────────

/// Default bind host.
pub const DEFAULT_LLAMA_SERVER_HOST: &str = "127.0.0.1";
/// Default port (OS-assigned fallback is persisted as the active port).
pub const DEFAULT_LLAMA_SERVER_PORT: u16 = 8080;
/// Default bounded health-check timeout, in seconds. The reference model load
/// (2.6 GB QAT set at `--ctx-size 131072`) is slow; 180 s covers the documented
/// cold-disk window with no unbounded wait.
pub const DEFAULT_LLAMA_SERVER_HEALTH_TIMEOUT_S: u64 = 180;

// ── Environment overrides (Spec #2944 ST-2, R-1.2) ─────────────────────────────
//
// `llama-server` is otherwise a per-app singleton (one persisted port + one
// companion dir). An isolated environment injects `FREDO_LLAMA_SERVER_PORT` /
// `FREDO_LLAMA_SERVER_COMPANION_DIR`, resolved by [`EnvConfig`], so each
// environment's server binds its own port and writes into its own dir — the
// companion endpoint is reachable independently (AC1 named element).

/// The companion-server settings an isolated environment overrides.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompanionEnvOverrides {
    /// The environment's `llama-server` port.
    pub port: u16,
    /// The environment's companion artifact dir, when supplied.
    pub companion_dir: Option<PathBuf>,
}

/// The companion overrides for `env`, or `None` on the legacy single-env path
/// (`FREDO_ENV_ID` unset). Pure: the caller persists the values via
/// [`apply_companion_env_overrides`]; nothing here reads or writes the store.
pub fn companion_env_overrides(env: &EnvConfig) -> Option<CompanionEnvOverrides> {
    if !env.is_isolated() {
        return None;
    }
    Some(CompanionEnvOverrides {
        port: env.llama_server_port,
        companion_dir: env.llama_server_companion_dir.clone(),
    })
}

/// Persist [`companion_env_overrides`] into this environment's settings cache.
///
/// The env-supplied port / companion dir are written into the synchronous
/// settings cache (write-through to PostgreSQL), so the existing companion
/// resolvers (`process::resolve_companion_dir`, `commands::build_launch_config`)
/// pick them up unchanged — no dimension is re-derived. Inert on the legacy path.
/// A write failure is logged and ignored: a missing override degrades to the
/// persisted/default setting, never a crash.
pub fn apply_companion_env_overrides(app: &AppHandle, env: &EnvConfig) {
    let Some(overrides) = companion_env_overrides(env) else {
        return;
    };
    let store = app.state::<Arc<SettingsStore>>();
    if let Err(error) = store.cached_set(LLAMA_SERVER_PORT_KEY, &overrides.port.to_string()) {
        tracing::warn!(
            target: "fredo::llm_server",
            error = %error,
            "could not persist the environment llama-server port"
        );
    }
    if let Some(dir) = &overrides.companion_dir {
        if let Err(error) =
            store.cached_set(LLAMA_SERVER_COMPANION_DIR_KEY, &dir.to_string_lossy())
        {
            tracing::warn!(
                target: "fredo::llm_server",
                error = %error,
                "could not persist the environment companion dir"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    use crate::infrastructure::env::{
        ENV_ID_ENV, LLAMA_SERVER_COMPANION_DIR_ENV, LLAMA_SERVER_PORT_ENV,
    };

    fn resolve(pairs: &[(&str, &str)]) -> EnvConfig {
        let map: HashMap<&str, &str> = pairs.iter().copied().collect();
        EnvConfig::resolve_with(|key| map.get(key).map(|value| (*value).to_string()))
    }

    /// ST-2 regression invariant: with no `FREDO_*` set the companion overrides
    /// are inert, so the legacy singleton `llama-server` path is unchanged.
    #[test]
    fn companion_overrides_are_inert_on_the_legacy_path() {
        assert_eq!(companion_env_overrides(&resolve(&[])), None);
    }

    /// ST-2 (R-1.2): an isolated env resolves its own port + companion dir.
    #[test]
    fn companion_overrides_use_the_environment_port_and_dir() {
        let env = resolve(&[
            (ENV_ID_ENV, "spec2944"),
            (LLAMA_SERVER_PORT_ENV, "16004"),
            (LLAMA_SERVER_COMPANION_DIR_ENV, "C:/env/companion"),
        ]);
        assert_eq!(
            companion_env_overrides(&env),
            Some(CompanionEnvOverrides {
                port: 16004,
                companion_dir: Some(PathBuf::from("C:/env/companion")),
            })
        );
    }

    /// ST-2: a missing `FREDO_LLAMA_SERVER_COMPANION_DIR` leaves the dir
    /// untouched (the port override still applies).
    #[test]
    fn companion_overrides_leave_the_dir_unset_when_absent() {
        let env = resolve(&[(ENV_ID_ENV, "spec2944"), (LLAMA_SERVER_PORT_ENV, "16004")]);
        assert_eq!(
            companion_env_overrides(&env),
            Some(CompanionEnvOverrides {
                port: 16004,
                companion_dir: None,
            })
        );
    }
}
