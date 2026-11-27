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
pub mod injection;
pub mod skills;
pub mod status;
pub mod status_keys;

pub use status_keys::{LLAMA_SERVER_BACKEND_KEY, LLAMA_SERVER_COMPANION_DIR_KEY};

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

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

// ── Launch auto-start (Spec #3180 ST-2) ───────────────────────────────────────

/// The bounded wait for the settings cache to hydrate before the launch
/// auto-start reads the persisted backend mode / models dir.
///
/// Matches the PostgreSQL ready bound (60 s): a slow first boot still starts the
/// engine, and the shell is never blocked because this wait lives on a spawned
/// task. When the bound elapses the start proceeds with the cache as it is (the
/// lazy first-turn start remains the fallback).
pub const SETTINGS_HYDRATION_BUDGET: Duration = Duration::from_secs(60);

/// The poll interval for [`await_settings_hydration`].
const SETTINGS_HYDRATION_POLL: Duration = Duration::from_millis(100);

/// The module-scoped process-once guard: the launch start is attempted at most
/// once per process (mirror of the frontend's `autoLaunchAttempted`). A manual
/// stop is therefore never raced by a restart loop.
static COMPANION_LAUNCH_ATTEMPTED: AtomicBool = AtomicBool::new(false);

/// Claim the process-once launch attempt. `true` only for the first caller.
///
/// Takes the flag as a parameter so the guard's semantics are pinnable without
/// mutating process-global state from a test (G-222: no order-dependent global).
fn claim_launch_attempt(flag: &AtomicBool) -> bool {
    !flag.swap(true, Ordering::SeqCst)
}

/// Wait (bounded) until the settings cache has hydrated.
///
/// Returns `true` when it hydrated within `budget`, `false` when the bound
/// elapsed (the caller then proceeds with the cache as it is — the start is
/// best-effort and a later turn starts the engine lazily).
pub async fn await_settings_hydration(store: &SettingsStore, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    while !store.is_hydrated() {
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(SETTINGS_HYDRATION_POLL).await;
    }
    true
}

/// Start the companion engine at launch (Spec #3180 ST-2, R-1.2).
///
/// On a fresh install the engine must be up and healthy WITHOUT the user finding
/// the setup step. The start is:
///
/// * **process-once** — [`COMPANION_LAUNCH_ATTEMPTED`] makes a manual stop final
///   (no restart loop);
/// * **hydration-gated** — the persisted backend mode and the models dir/manifest
///   are read only after the settings cache hydrates (bounded), so a persisted
///   `cpu` selection is honoured instead of the pre-hydration `Auto` default;
/// * **model-gated** — a missing model set SKIPS the start (logged; the status is
///   untouched so the setup/health surface still reports `notSetUp`) and the lazy
///   first-turn start remains the fallback;
/// * **bounded and non-blocking** — the whole body runs on a spawned task, so
///   `setup` returns immediately and boot is never blocked; the start itself is
///   bounded by [`engine::handle::DEFAULT_START_BUDGET`] (120 s).
///
/// The terminal status is PUSHED on success AND failure: the row must stop
/// reading "not running" during and after a load.
pub fn start_companion_engine_on_launch(app: &AppHandle) {
    if !claim_launch_attempt(&COMPANION_LAUNCH_ATTEMPTED) {
        return;
    }
    let Some(store) = app.try_state::<Arc<SettingsStore>>() else {
        tracing::warn!(
            target: "fredo::llm_server",
            "launch auto-start skipped: the settings store is not managed"
        );
        return;
    };
    let store = Arc::clone(store.inner());
    let Some(engine) = app.try_state::<commands::CompanionEngineState>() else {
        tracing::warn!(
            target: "fredo::llm_server",
            "launch auto-start skipped: the engine state is not managed"
        );
        return;
    };
    let handle = Arc::clone(&engine.0);
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        if !await_settings_hydration(&store, SETTINGS_HYDRATION_BUDGET).await {
            tracing::warn!(
                target: "fredo::llm_server",
                budget_ms = SETTINGS_HYDRATION_BUDGET.as_millis() as u64,
                "settings hydration did not finish within the launch budget; starting with the cache as it is"
            );
        }
        // A loaded (or in-flight) engine is never started twice.
        if handle.is_starting_or_loaded() {
            tracing::debug!(
                target: "fredo::llm_server",
                "launch auto-start skipped: the engine is already loaded or starting"
            );
            return;
        }
        let model_paths = match engine::paths::resolve_for_handle(&app) {
            Ok(paths) => paths,
            Err((code, detail)) => {
                // Models absent (or incomplete): SKIP. The status is untouched,
                // so the setup/health surface still reports `notSetUp`; a later
                // turn starts the engine lazily.
                tracing::info!(
                    target: "fredo::llm_server",
                    ?code,
                    %detail,
                    "launch auto-start skipped: the model files are not ready"
                );
                return;
            }
        };
        let mode = commands::backend_mode(&app);
        tracing::info!(
            target: "fredo::llm_server",
            ?mode,
            "launch auto-start: starting the companion engine"
        );
        let outcome = handle.start(model_paths, mode);
        if outcome.success {
            let backend = outcome.backend;
            tracing::info!(
                target: "fredo::llm_server",
                ?backend,
                "launch auto-start: the companion engine is ready"
            );
        } else {
            let code = outcome.code;
            let detail = outcome.detail.as_str();
            tracing::warn!(
                target: "fredo::llm_server",
                ?code,
                %detail,
                "launch auto-start: the companion engine start failed"
            );
        }
        // Push the terminal status (success AND failure) on the channel the
        // webview already listens on.
        commands::engine::publish_engine_status(&app);
    });
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

    // ── Spec #3180 ST-2: the launch auto-start guards ────────────────────────

    use std::sync::atomic::AtomicUsize;

    use crate::applications::llm_server::engine::CompanionBackendMode;
    use crate::infrastructure::storage::EngineHandle;

    /// The one-shot guard: the launch start is attempted at most once per
    /// process, and concurrent callers yield EXACTLY one winner (the guard is a
    /// real swap, not a read-then-write). A manual stop is therefore never raced
    /// by a restart loop.
    #[test]
    fn the_launch_attempt_is_claimed_once() {
        let flag = AtomicBool::new(false);
        assert!(claim_launch_attempt(&flag), "the first caller wins");
        assert!(!claim_launch_attempt(&flag), "the second caller is refused");
        assert!(!claim_launch_attempt(&flag));

        // Concurrent claims: exactly ONE wins. The flag is LOCAL to this test,
        // so the pin cannot depend on another test's ordering (G-222).
        let shared = Arc::new(AtomicBool::new(false));
        let winners = Arc::new(AtomicUsize::new(0));
        let mut threads = Vec::new();
        for _ in 0..8 {
            let shared = Arc::clone(&shared);
            let winners = Arc::clone(&winners);
            threads.push(std::thread::spawn(move || {
                if claim_launch_attempt(&shared) {
                    winners.fetch_add(1, Ordering::SeqCst);
                }
            }));
        }
        for thread in threads {
            thread.join().expect("guard thread");
        }
        assert_eq!(
            winners.load(Ordering::SeqCst),
            1,
            "exactly one caller may start the engine at launch"
        );
    }

    /// The hydration gate: a persisted `cpu` selection is honoured only AFTER
    /// the bounded wait. A pre-hydration read coerces to `Auto`, which is the
    /// wrong-mode hazard this gate exists to close.
    #[tokio::test]
    async fn a_persisted_cpu_mode_survives_the_hydration_wait() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = Arc::new(
            SettingsStore::open(EngineHandle::new_pending(), dir.path()).expect("open store"),
        );
        // No PostgreSQL pool in this suite, so the hydration-visible value is a
        // registered default — the SAME `hydrate` → cache write path a persisted
        // row takes.
        store.register_default(LLAMA_SERVER_BACKEND_KEY, "cpu");
        assert!(!store.is_hydrated());
        assert_eq!(
            CompanionBackendMode::from_persisted(
                store
                    .cached_get(LLAMA_SERVER_BACKEND_KEY)
                    .ok()
                    .flatten()
                    .as_deref()
            ),
            CompanionBackendMode::Auto,
            "before hydration the cache has no persisted mode — the wrong-mode hazard"
        );

        let hydrating = Arc::clone(&store);
        tokio::spawn(async move {
            let _ = hydrating.hydrate().await;
        });
        assert!(
            await_settings_hydration(&store, Duration::from_secs(5)).await,
            "the bounded wait must observe hydration"
        );
        assert_eq!(
            CompanionBackendMode::from_persisted(
                store
                    .cached_get(LLAMA_SERVER_BACKEND_KEY)
                    .ok()
                    .flatten()
                    .as_deref()
            ),
            CompanionBackendMode::Cpu,
            "the persisted cpu mode must survive the hydration wait"
        );
    }

    /// The wait is BOUNDED: an un-hydrated store returns `false` rather than
    /// hanging the spawned launch task (boot is never blocked).
    #[tokio::test]
    async fn the_hydration_wait_is_bounded() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SettingsStore::open(EngineHandle::new_pending(), dir.path()).expect("open store");
        let started = Instant::now();
        assert!(
            !await_settings_hydration(&store, Duration::from_millis(50)).await,
            "an un-hydrated store must time out, not hang"
        );
        assert!(
            started.elapsed() >= Duration::from_millis(50),
            "the wait must actually spend its budget"
        );
    }
}
