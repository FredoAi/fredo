//! Managed db_client state (Spec #2950, ST-1).
//!
//! [`DbClientState`] is `app.manage`-ed once in `lib.rs` as
//! `Arc<DbClientState>` and injected into every `db_*` command wrapper.
//!
//! ST-1 owns the struct shape (the wiring files are frozen); later sub-tasks
//! use the accessors and never re-open this file:
//!
//! * the G-275 seam values ([`DbClientState::force_fail`],
//!   [`DbClientState::state_dir`]) are resolved once at construction from the
//!   environment ([`DbClientState::from_env`]), with the production default
//!   state dir rooted at the Tauri app-data dir passed in at startup
//!   (`<app_data_dir>/dbclient`); the `FREDO_DBCLIENT_STATE_DIR` override wins;
//! * the per-connection external `sqlx` pool registry is provided here for
//!   ST-2 (`db_connect`/`db_disconnect`), but ST-1 **opens no pool** — the map
//!   starts empty.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};

use sqlx::PgPool;
use tokio::sync::Mutex;

use crate::infrastructure::storage::embedded_pg::EmbeddedPgEndpointProvider;

use super::seam::{self, ForceFailStage};

/// Open external connection pools keyed by connection id (ST-2).
pub type PgPoolMap = HashMap<String, PgPool>;

/// The single Tauri-managed db_client state.
pub struct DbClientState {
    /// Resolved G-275 failure stage; inert `None` by default.
    force_fail: Option<ForceFailStage>,
    /// Resolved writable state dir for test fixtures.
    state_dir: PathBuf,
    /// Open per-connection pools. Empty in ST-1 — no pool is opened here.
    pools: Mutex<PgPoolMap>,
    /// Spec #3029 ST-2: the embedded-PostgreSQL endpoint provider. Installed
    /// once by the composition root (`lib.rs`); `None` in unit tests and when no
    /// managed supervisor is present (the `Disabled` fallback ⇒ a built-in
    /// connect fails with the typed `config` error, EARS-4b). Guarded by a std
    /// mutex (never held across an `.await`).
    embedded_endpoint_provider: StdMutex<Option<Arc<dyn EmbeddedPgEndpointProvider>>>,
}

impl DbClientState {
    /// Build state from explicit values (tests / callers that already resolved
    /// the seams).
    pub fn new(force_fail: Option<ForceFailStage>, state_dir: PathBuf) -> Self {
        Self {
            force_fail,
            state_dir,
            pools: Mutex::new(HashMap::new()),
            embedded_endpoint_provider: StdMutex::new(None),
        }
    }

    /// Build state by resolving the G-275 seams from the environment, rooting
    /// the default state dir at the Tauri app-data dir resolved at startup.
    /// `FREDO_DBCLIENT_STATE_DIR` still overrides (test fixtures).
    pub fn from_env(app_data_dir: &Path) -> Self {
        Self::new(
            seam::force_fail_stage(),
            seam::state_dir_in(app_data_dir),
        )
    }

    /// The active forced-failure stage (`None` = inert).
    pub fn force_fail(&self) -> Option<ForceFailStage> {
        self.force_fail
    }

    /// The writable state dir used for test fixtures.
    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    /// Install the embedded-PostgreSQL endpoint provider (Spec #3029). Called
    /// once by the composition root (`lib.rs`) after the managed supervisor is
    /// available (a later install simply replaces the previous provider).
    pub fn set_embedded_endpoint_provider(
        &self,
        provider: Arc<dyn EmbeddedPgEndpointProvider>,
    ) {
        *self.provider_lock() = Some(provider);
    }

    /// The installed embedded-PostgreSQL endpoint provider, if any (Spec #3029).
    /// `None` when no managed supervisor was wired (the `Disabled` fallback).
    pub fn embedded_endpoint_provider(&self) -> Option<Arc<dyn EmbeddedPgEndpointProvider>> {
        self.provider_lock().clone()
    }

    /// Lock the provider slot, recovering from poisoning (no `unwrap`).
    fn provider_lock(&self) -> MutexGuard<'_, Option<Arc<dyn EmbeddedPgEndpointProvider>>> {
        self.embedded_endpoint_provider
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Register an open pool for `connection_id`, returning any pool it
    /// replaced (ST-2).
    pub async fn insert_pool(&self, connection_id: String, pool: PgPool) -> Option<PgPool> {
        self.pools.lock().await.insert(connection_id, pool)
    }

    /// Remove and return the pool for `connection_id` (ST-2 disconnect/delete).
    pub async fn remove_pool(&self, connection_id: &str) -> Option<PgPool> {
        self.pools.lock().await.remove(connection_id)
    }

    /// Clone the open pool for `connection_id`, if any. Read-only accessor for
    /// the consumers of the registry — ST-3 (`db_schema_list`) and ST-4
    /// (`db_query_execute`/`db_result_page`) run read-only catalog/query SQL on
    /// the already-open pool; **pool lifecycle stays ST-2's** (this never opens
    /// or closes a pool). Returns `None` when the connection is not open.
    pub async fn pool(&self, connection_id: &str) -> Option<PgPool> {
        self.pools.lock().await.get(connection_id).cloned()
    }

    /// Number of currently open external pools.
    pub async fn pool_count(&self) -> usize {
        self.pools.lock().await.len()
    }
}

impl Default for DbClientState {
    /// Inert fallback (no app-data dir available): the repo-relative test dir.
    /// Production always constructs via [`DbClientState::from_env`].
    fn default() -> Self {
        Self::new(seam::force_fail_stage(), seam::state_dir())
    }
}
