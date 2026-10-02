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
//!   environment ([`DbClientState::from_env`]);
//! * the per-connection external `sqlx` pool registry is provided here for
//!   ST-2 (`db_connect`/`db_disconnect`), but ST-1 **opens no pool** — the map
//!   starts empty.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use sqlx::PgPool;
use tokio::sync::Mutex;

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
}

impl DbClientState {
    /// Build state from explicit values (tests / callers that already resolved
    /// the seams).
    pub fn new(force_fail: Option<ForceFailStage>, state_dir: PathBuf) -> Self {
        Self {
            force_fail,
            state_dir,
            pools: Mutex::new(HashMap::new()),
        }
    }

    /// Build state by resolving the G-275 seams from the environment.
    pub fn from_env() -> Self {
        Self::new(seam::force_fail_stage(), seam::state_dir())
    }

    /// The active forced-failure stage (`None` = inert).
    pub fn force_fail(&self) -> Option<ForceFailStage> {
        self.force_fail
    }

    /// The writable state dir used for test fixtures.
    pub fn state_dir(&self) -> &Path {
        &self.state_dir
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
    fn default() -> Self {
        Self::from_env()
    }
}
