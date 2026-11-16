//! Companion inference (Spec #2857, re-based in-process by Spec #3141).
//!
//! Companion inference runs IN-PROCESS on the `llama-cpp-4` Rust bindings: no
//! `llama-server` child process, no generated `.bat`, no loopback HTTP hop
//! (`#3141` decision A, reversed). The runtime lives under [`engine`]; the
//! pre-migration out-of-process surface (`process`, `health`, `state`,
//! `config`, and the launch/`/props` commands) was DELETED by ST-6 once every
//! live consumer had been re-pointed (G-430).
//!
//! What remains: the engine ([`engine`]), the chat/skill/status surfaces
//! ([`commands`], [`skills`], [`status`], [`doom_agent`]), the IPC message DTO
//! ([`chat`]), and [`status_keys`] — the persisted key NAMES the migration keeps.
//!
//! ## Environment overrides (Spec #2944 ST-2, R-1.2; port retired by #3141)
//!
//! The companion is a per-process singleton: one engine per Fredo process, one
//! companion dir. An isolated environment injects
//! `FREDO_LLAMA_SERVER_COMPANION_DIR`, resolved by [`EnvConfig`], so each
//! environment's engine log goes to its own dir (AC-27). There is NO port
//! dimension any more — with no listener there is nothing to bind.

pub mod chat;
pub mod commands;
pub mod doom_agent;
pub mod engine;
pub mod skills;
pub mod status;
pub mod status_keys;

pub use status_keys::{LLAMA_SERVER_BACKEND_KEY, LLAMA_SERVER_COMPANION_DIR_KEY};

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::infrastructure::env::EnvConfig;
use crate::infrastructure::storage::SettingsStore;

// ── Environment overrides (Spec #2944 ST-2, R-1.2) ─────────────────────────────
//
// An isolated environment injects `FREDO_LLAMA_SERVER_COMPANION_DIR`, resolved
// by [`EnvConfig`], so each environment's companion artifacts (the engine log)
// live in their own dir — the companion is independently inspectable (AC-27).
//
// `FREDO_LLAMA_SERVER_PORT` was RETIRED with the out-of-process server
// (`#3141`): in-process there is no listener, so there is no port to isolate.

/// The companion settings an isolated environment overrides.
///
/// Only the companion dir survives: the retired `llama_server_*` port keys have
/// no subject once the loopback server is gone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompanionEnvOverrides {
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
        companion_dir: env.llama_server_companion_dir.clone(),
    })
}

/// Persist [`companion_env_overrides`] into this environment's settings cache.
///
/// The env-supplied companion dir is written into the synchronous settings cache
/// (write-through to PostgreSQL), so the existing companion-dir resolver
/// (`engine::paths::resolve_companion_dir`) picks it up unchanged. Inert on the
/// legacy path. A write failure is logged and ignored: a missing override
/// degrades to the persisted/default setting, never a crash.
pub fn apply_companion_env_overrides(app: &AppHandle, env: &EnvConfig) {
    let Some(overrides) = companion_env_overrides(env) else {
        return;
    };
    let Some(dir) = &overrides.companion_dir else {
        return;
    };
    let store = app.state::<Arc<SettingsStore>>();
    if let Err(error) = store.cached_set(LLAMA_SERVER_COMPANION_DIR_KEY, &dir.to_string_lossy()) {
        tracing::warn!(
            target: "fredo::llm_server",
            error = %error,
            "could not persist the environment companion dir"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    use crate::infrastructure::env::{ENV_ID_ENV, LLAMA_SERVER_COMPANION_DIR_ENV};

    fn resolve(pairs: &[(&str, &str)]) -> EnvConfig {
        let map: HashMap<&str, &str> = pairs.iter().copied().collect();
        EnvConfig::resolve_with(|key| map.get(key).map(|value| (*value).to_string()))
    }

    /// With no `FREDO_*` set the companion overrides are inert, so the legacy
    /// single-process path is unchanged.
    #[test]
    fn companion_overrides_are_inert_on_the_legacy_path() {
        assert_eq!(companion_env_overrides(&resolve(&[])), None);
    }

    /// An isolated env resolves its own companion dir (AC-27).
    #[test]
    fn companion_overrides_use_the_environment_dir() {
        let env = resolve(&[
            (ENV_ID_ENV, "spec2944"),
            (LLAMA_SERVER_COMPANION_DIR_ENV, "C:/env/companion"),
        ]);
        assert_eq!(
            companion_env_overrides(&env),
            Some(CompanionEnvOverrides {
                companion_dir: Some(PathBuf::from("C:/env/companion")),
            })
        );
    }

    /// A missing `FREDO_LLAMA_SERVER_COMPANION_DIR` leaves the dir unset, so the
    /// persisted/default companion dir applies.
    #[test]
    fn companion_overrides_leave_the_dir_unset_when_absent() {
        let env = resolve(&[(ENV_ID_ENV, "spec2944")]);
        assert_eq!(
            companion_env_overrides(&env),
            Some(CompanionEnvOverrides {
                companion_dir: None,
            })
        );
    }

    /// The retired port dimension is gone from the override surface: there is no
    /// `port` field, so nothing can persist a phantom endpoint.
    #[test]
    fn the_retired_port_is_not_part_of_the_overrides() {
        let env = resolve(&[
            (ENV_ID_ENV, "spec2944"),
            (LLAMA_SERVER_COMPANION_DIR_ENV, "C:/env/companion"),
        ]);
        let overrides = companion_env_overrides(&env).expect("isolated env has overrides");
        assert_eq!(overrides.companion_dir, Some(PathBuf::from("C:/env/companion")));
    }
}
