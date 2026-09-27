pub mod engine;
pub mod feature_store;
pub mod span_store;

// The storage engine seam (Spec #2975 ST-1) re-exported at the module root so
// consumers read `storage::{EngineHandle, StoreEngine, ...}`.
pub use engine::{
    quote_ident, select_engine, Dialect, EngineChoice, EngineHandle, PgEngine, SqliteEngine,
    StoreEngine, PG_POOL_ACQUIRE_TIMEOUT, PG_POOL_IDLE_TIMEOUT, PG_POOL_MAX_CONNECTIONS,
    PG_POOL_MAX_LIFETIME, PG_POOL_MIN_CONNECTIONS, STORAGE_ENGINE_ENV,
};

use anyhow::{anyhow, Result};
use rusqlite::params;
use std::sync::Arc;

/// Persistent key-value store (the `settings` table), split into two planes
/// (Spec #2975, ST-3).
///
/// - **Control plane** ([`Self::control_get`] / [`Self::control_set`]): ALWAYS
///   synchronous SQLite on the shared write connection. It holds the keys that
///   must be readable *before* PostgreSQL exists (`postgres.enabled`,
///   `postgres_pid`, `postgres.password`) and the synchronous startup config
///   path. These keys NEVER route through the pool.
/// - **Data plane** ([`Self::get`] / [`Self::set`], async): routed through the
///   shared [`EngineHandle`] and therefore engine-selected — SQLite by default,
///   PostgreSQL once the supervisor installs the pool. Behavior is byte-equal to
///   the incumbent SQLite path while the engine stays on SQLite.
///
/// The control-plane SQLite engine is captured at [`Self::open`] so it survives
/// the swap-once handle's `SQLite -> PostgreSQL` transition: after the pool is
/// installed the handle reports PostgreSQL, but the control plane keeps serving
/// the synchronous startup/lifecycle reads.
pub struct AppStore {
    /// The shared swap-once engine handle (data plane).
    engine: Arc<EngineHandle>,
    /// The always-SQLite control plane (shared write connection).
    control: Arc<SqliteEngine>,
}

impl AppStore {
    /// Wrap the shared engine handle and materialize the `settings` schema on the
    /// SQLite control plane.
    ///
    /// The handle MUST start on SQLite (the production `lib.rs` order: the shared
    /// `SqliteEngine` exists before the supervisor can ever install PostgreSQL);
    /// a handle already on PostgreSQL has no control plane and is rejected.
    pub fn open(engine: Arc<EngineHandle>) -> Result<Self> {
        let active = engine.engine();
        let control = active.sqlite().cloned().ok_or_else(|| {
            anyhow!("AppStore requires the shared SQLite control engine at open")
        })?;

        control.write_conn().execute_batch(
            "CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )?;

        Ok(AppStore { engine, control })
    }

    /// Test-only convenience: open a SQLite-backed store at `<data_dir>/fredo.db`.
    ///
    /// Production callers always pass the shared `EngineHandle` built in
    /// `lib.rs`; this keeps unit tests terse and hermetic without a live pool.
    #[cfg(test)]
    pub fn open_sqlite_for_tests(data_dir: std::path::PathBuf) -> Result<Self> {
        let sqlite = SqliteEngine::open(&data_dir.join("fredo.db"))?;
        Self::open(EngineHandle::new(StoreEngine::Sqlite(sqlite)))
    }

    // ── Control plane (always synchronous SQLite; never behind the pool) ──────

    /// Read one control-plane KV value from the shared SQLite write connection.
    pub fn control_get(&self, key: &str) -> Result<Option<String>> {
        let conn = self.control.write_conn();
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    /// Upsert one control-plane KV value on the shared SQLite write connection.
    pub fn control_set(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.control.write_conn();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    // ── Data plane (engine-selected; async) ──────────────────────────────────

    /// Read one `settings` KV value from the ACTIVE engine.
    ///
    /// An unknown key returns `None` on both engines (REQ-4/EARS-4.3) — never an
    /// empty-string sentinel.
    pub async fn get(&self, key: &str) -> Result<Option<String>> {
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let conn = engine.write_conn();
                let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
                let mut rows = stmt.query(params![key])?;
                match rows.next()? {
                    Some(row) => Ok(Some(row.get(0)?)),
                    None => Ok(None),
                }
            }
            StoreEngine::Postgres(pg) => {
                let value: Option<String> =
                    sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
                        .bind(key)
                        .fetch_optional(&pg.pool)
                        .await?;
                Ok(value)
            }
        }
    }

    /// Upsert one `settings` KV value on the ACTIVE engine.
    ///
    /// PostgreSQL uses the PK upsert `ON CONFLICT(key) DO UPDATE SET value =
    /// EXCLUDED.value` (REQ-2/EARS-2.1), matching the SQLite `excluded` upsert
    /// 1:1.
    pub async fn set(&self, key: &str, value: &str) -> Result<()> {
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let conn = engine.write_conn();
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![key, value],
                )?;
                Ok(())
            }
            StoreEngine::Postgres(pg) => {
                sqlx::query(
                    "INSERT INTO settings (key, value) VALUES ($1, $2)
                     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
                )
                .bind(key)
                .bind(value)
                .execute(&pg.pool)
                .await?;
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a tempdir-backed SQLite engine + swap-once handle. The `TempDir`
    /// must be kept alive for the test's duration (it owns the DB file).
    fn make_handle() -> (tempfile::TempDir, Arc<EngineHandle>) {
        let dir = tempfile::tempdir().unwrap();
        let sqlite = SqliteEngine::open(&dir.path().join("fredo.db")).unwrap();
        let handle = EngineHandle::new(StoreEngine::Sqlite(sqlite));
        (dir, handle)
    }

    fn make_store() -> (tempfile::TempDir, AppStore) {
        let (dir, handle) = make_handle();
        let store = AppStore::open(handle).unwrap();
        (dir, store)
    }

    /// A lazily-connected pool: enough to swap the handle to PostgreSQL without a
    /// live server (a query then fails closed rather than hanging).
    fn make_pg_engine(url: &str) -> PgEngine {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .min_connections(0)
            .max_connections(1)
            .connect_lazy(url)
            .expect("lazy pool should build without connecting");
        PgEngine {
            pool,
            url: url.to_string(),
        }
    }

    // ── REQ-1: AppStore data-plane CRUD (SQLite default) ──────────────────

    #[tokio::test]
    async fn get_returns_some_for_previously_set_key() {
        let (_dir, store) = make_store();
        store.set("theme", "dark").await.unwrap();
        let result = store.get("theme").await.unwrap();
        assert_eq!(result, Some("dark".to_string()));
    }

    #[tokio::test]
    async fn get_returns_none_for_unknown_key() {
        let (_dir, store) = make_store();
        let result = store.get("nonexistent").await.unwrap();
        assert_eq!(result, None);
    }

    #[tokio::test]
    async fn set_upserts_same_key_twice() {
        let (_dir, store) = make_store();
        store.set("language", "en").await.unwrap();
        store.set("language", "fr").await.unwrap();
        let result = store.get("language").await.unwrap();
        assert_eq!(result, Some("fr".to_string()));
    }

    // ── REQ-1/EARS-1.3: control plane is ALWAYS synchronous SQLite ─────────

    #[tokio::test]
    async fn control_plane_round_trips_on_sqlite() {
        let (_dir, store) = make_store();
        store.control_set("postgres.enabled", "true").unwrap();
        assert_eq!(
            store.control_get("postgres.enabled").unwrap(),
            Some("true".to_string())
        );
        store.control_set("postgres.enabled", "false").unwrap();
        assert_eq!(
            store.control_get("postgres.enabled").unwrap(),
            Some("false".to_string())
        );
        assert_eq!(store.control_get("absent").unwrap(), None);
    }

    #[tokio::test]
    async fn control_plane_stays_on_sqlite_after_the_handle_swaps_to_postgres() {
        let (_dir, handle) = make_handle();
        let store = AppStore::open(handle.clone()).unwrap();

        // The pool is installed (lazy, no server needed): the data plane now
        // reports PostgreSQL...
        handle.install(StoreEngine::Postgres(Arc::new(make_pg_engine(
            "postgres://postgres:secret@127.0.0.1:1/none",
        ))));

        // ...but the CONTROL plane (the 3 control keys) still round-trips on the
        // captured SQLite write connection — it never routes through the pool.
        store.control_set("postgres.password", "loopback-secret").unwrap();
        assert_eq!(
            store.control_get("postgres.password").unwrap(),
            Some("loopback-secret".to_string())
        );

        // A DATA-plane read now targets the (unreachable) pool and fails closed
        // rather than silently falling back to SQLite.
        assert!(
            store.get("theme").await.is_err(),
            "a data-plane read must target the active engine, not the control plane"
        );
    }

    #[tokio::test]
    async fn data_and_control_planes_share_the_sqlite_table_by_default() {
        let (_dir, store) = make_store();
        // On the default SQLite engine the data plane and the control plane are
        // the SAME table, so a control write is visible to a data read.
        store.control_set("shared", "value").unwrap();
        assert_eq!(
            store.get("shared").await.unwrap(),
            Some("value".to_string())
        );
        store.set("shared", "updated").await.unwrap();
        assert_eq!(
            store.control_get("shared").unwrap(),
            Some("updated".to_string())
        );
    }

    #[tokio::test]
    async fn open_rejects_a_handle_already_on_postgres() {
        let sqlite = SqliteEngine::open(&tempfile::tempdir().unwrap().path().join("fredo.db"))
            .unwrap();
        let handle = EngineHandle::new(StoreEngine::Sqlite(sqlite));
        handle.install(StoreEngine::Postgres(Arc::new(make_pg_engine(
            "postgres://postgres:secret@127.0.0.1:1/none",
        ))));
        assert!(
            AppStore::open(handle).is_err(),
            "opening an AppStore without a SQLite control engine must fail"
        );
    }
}
