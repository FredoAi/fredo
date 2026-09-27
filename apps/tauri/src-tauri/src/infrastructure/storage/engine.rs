//! Storage engine seam (Spec #2975, ST-1).
//!
//! The ONE seam every migrated store consumes, so no consumer invents its own
//! connection or dialect. This module is the producer for the SQLite ->
//! PostgreSQL migration: it defines the engine types, the swap-once shared
//! handle, the selection precedence, the identifier-quoting rule, and the pool
//! sizing constants.
//!
//! Scope of ST-1: types + helpers ONLY. No store method changes, no PG pool
//! wiring. The SQLite path is byte-identical to the incumbent one
//! (`SqliteEngine::open` reproduces the two incumbent connection conventions:
//! the WAL write handle `FeatureStore` established and the `PRAGMA
//! query_only=ON` read-only guard `ProjectionEngine` established).
//!
//! Later sub-tasks append to this module: ST-2 adds the bounded pool build +
//! `StorageEngineStatus`; ST-2/ST-3 wire the handle in `lib.rs`.

use anyhow::Result;
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

// -- Selection input names ----------------------------------------------------

/// **FS-2** test/QA hook: `FREDO_STORAGE_ENGINE` (`sqlite` | `postgres`)
/// overrides the control-plane KV key `postgres.enabled`. Inert when unset.
pub const STORAGE_ENGINE_ENV: &str = "FREDO_STORAGE_ENGINE";

/// The control-plane `settings` KV key that enables PostgreSQL. Mirrors
/// `features::pg_supervisor::PG_ENABLED_KEY`; declared here (not imported) so
/// `infrastructure/` never depends on a feature module.
const PG_ENABLED_KEY: &str = "postgres.enabled";

// -- Pool + server tuning constants (Spec #2975, Q-6) -------------------------

/// Pool sizing: `max_connections` inside the required 5-10 band (REQ-5/EARS-5.1).
pub const PG_POOL_MAX_CONNECTIONS: u32 = 8;
/// Keep one warm connection; the rest are opened on demand.
pub const PG_POOL_MIN_CONNECTIONS: u32 = 1;
/// Bound every pool acquisition (G-263: no unbounded wait).
pub const PG_POOL_ACQUIRE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
/// Reap idle connections after 10 minutes.
pub const PG_POOL_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);
/// Recycle every connection after 30 minutes.
pub const PG_POOL_MAX_LIFETIME: std::time::Duration = std::time::Duration::from_secs(1800);

// -- Dialect ------------------------------------------------------------------

/// Which SQL dialect the active engine speaks. Returned by
/// [`StoreEngine::dialect`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    Sqlite,
    Postgres,
}

// -- Engines ------------------------------------------------------------------

/// ONE shared SQLite engine for the migrated family: two connections over the
/// SAME `<app_data_dir>/fredo.db`.
///
/// - `write` is the single write handle (replaces every per-store
///   `Mutex<Connection>`), in WAL journal mode as the incumbent `FeatureStore`
///   established.
/// - `read_only` is a second handle pinned with `PRAGMA query_only=ON`, the
///   incumbent read-only guard `ProjectionEngine` established.
pub struct SqliteEngine {
    write: Mutex<Connection>,
    read_only: Mutex<Connection>,
}

impl SqliteEngine {
    /// Open (or create) `db_path` and build the shared write + read-only
    /// handles. Parent directories are created, preserving the incumbent
    /// `AppStore`/`FeatureStore` open behaviour.
    pub fn open(db_path: &Path) -> Result<Arc<Self>> {
        if let Some(parent) = db_path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }

        let write = Connection::open(db_path)?;
        write.execute_batch("PRAGMA journal_mode=WAL;")?;

        let read_only = Connection::open(db_path)?;
        // Canonical reads are read-only by contract (NFR-2); the pragma is the
        // incumbent guard, preserved verbatim.
        read_only.execute_batch("PRAGMA query_only=ON;")?;

        Ok(Arc::new(SqliteEngine {
            write: Mutex::new(write),
            read_only: Mutex::new(read_only),
        }))
    }

    /// Lock the shared write connection (poison-recovering).
    pub fn write_conn(&self) -> MutexGuard<'_, Connection> {
        lock(&self.write)
    }

    /// Lock the shared read-only connection (`PRAGMA query_only=ON`).
    pub fn read_only_conn(&self) -> MutexGuard<'_, Connection> {
        lock(&self.read_only)
    }

    /// Read one `settings` KV value from the control plane.
    ///
    /// A missing table, a missing key, or any read error yields `None` -- the
    /// selection contract's "absent => default" rule (fail-closed to SQLite),
    /// never a hard failure at selection time.
    fn kv_get(&self, key: &str) -> Option<String> {
        let conn = lock(&self.write);
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .ok()
    }
}

/// ONE shared async PostgreSQL pool for the migrated family. Built once by ST-2
/// on the background task after the supervisor's readiness resolves; installed
/// exactly once into an [`EngineHandle`].
pub struct PgEngine {
    pub pool: sqlx::PgPool,
    pub url: String,
}

/// The active engine. Cloned into every migrated store.
#[derive(Clone)]
pub enum StoreEngine {
    Sqlite(Arc<SqliteEngine>),
    Postgres(Arc<PgEngine>),
}

impl StoreEngine {
    /// The SQL dialect this engine speaks.
    pub fn dialect(&self) -> Dialect {
        match self {
            StoreEngine::Sqlite(_) => Dialect::Sqlite,
            StoreEngine::Postgres(_) => Dialect::Postgres,
        }
    }

    /// The shared synchronous SQLite engine, when active (the control plane).
    pub fn sqlite(&self) -> Option<&Arc<SqliteEngine>> {
        match self {
            StoreEngine::Sqlite(engine) => Some(engine),
            StoreEngine::Postgres(_) => None,
        }
    }
}

// -- The swap-once handle -----------------------------------------------------

/// The swap-once shared handle held by every migrated store (`Arc`-cloned).
///
/// Starts on SQLite; [`Self::install`] performs the ONE
/// `SQLite -> PostgreSQL` transition when the managed server becomes ready.
/// A reader that already captured the previous `Arc` keeps completing on that
/// engine -- the swap never invalidates an in-flight read.
pub struct EngineHandle {
    inner: RwLock<Arc<StoreEngine>>,
}

impl EngineHandle {
    /// Wrap the initial engine (always SQLite in production) and share it.
    pub fn new(engine: StoreEngine) -> Arc<Self> {
        Arc::new(EngineHandle {
            inner: RwLock::new(Arc::new(engine)),
        })
    }

    /// The active engine. Cheap: clones the `Arc` under a read lock.
    pub fn engine(&self) -> Arc<StoreEngine> {
        lock_read(&self.inner).clone()
    }

    /// The ONLY path to PostgreSQL: install `engine` exactly once.
    ///
    /// Swap-once semantics: only the first `SQLite -> PostgreSQL` transition
    /// replaces the active engine; every later call is a no-op (first-wins), so
    /// a second install can never replace an active pool.
    pub fn install(&self, engine: StoreEngine) {
        let mut guard = lock_write(&self.inner);
        if matches!(**guard, StoreEngine::Sqlite(_)) && matches!(engine, StoreEngine::Postgres(_)) {
            *guard = Arc::new(engine);
        }
    }
}

// -- Engine selection ---------------------------------------------------------

/// Which engine the app should run the data plane on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineChoice {
    Sqlite,
    Postgres,
}

/// Resolve the engine choice (REQ-1/EARS-1.1).
///
/// Precedence: `FREDO_STORAGE_ENGINE` (`sqlite` | `postgres`, case-insensitive)
/// OVERRIDES the control-plane KV key `postgres.enabled` (`"true"` => Postgres,
/// case-insensitive). An unset, blank, or unrecognized env value is treated as
/// unset and falls back to the KV key; an absent (or unreadable) KV key =>
/// SQLite -- the fail-closed default.
pub fn select_engine(sqlite: &SqliteEngine) -> EngineChoice {
    let env = std::env::var(STORAGE_ENGINE_ENV).ok();
    let kv = sqlite.kv_get(PG_ENABLED_KEY);
    resolve_engine_choice(env.as_deref(), kv.as_deref())
}

/// The pure precedence rule, split out so it is unit-testable without touching
/// process-global environment state.
fn resolve_engine_choice(env: Option<&str>, kv_enabled: Option<&str>) -> EngineChoice {
    match env.map(str::trim) {
        Some(value) if value.eq_ignore_ascii_case("postgres") => EngineChoice::Postgres,
        Some(value) if value.eq_ignore_ascii_case("sqlite") => EngineChoice::Sqlite,
        // Unset, blank, or an unrecognized value: no override intent, so consult
        // the KV key (a typo must not silently *disable* an enabled engine).
        _ => match kv_enabled.map(str::trim) {
            Some(value) if value.eq_ignore_ascii_case("true") => EngineChoice::Postgres,
            _ => EngineChoice::Sqlite,
        },
    }
}

// -- Identifier quoting -------------------------------------------------------

/// Double-quote a dynamic SQL identifier, doubling any embedded `"` (Q-9).
///
/// The ONLY identifier-quoting rule; identifiers are derived solely from
/// [`crate::infrastructure::storage::feature_store::FeatureStore::validate_namespace`].
pub fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

// -- Lock helpers (poison-recovering; no `unwrap`) ----------------------------

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_read<T>(rwlock: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    rwlock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_write<T>(rwlock: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    rwlock.write().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// -- Tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes every test that mutates or reads the process-global
    /// `FREDO_STORAGE_ENGINE`, so environment precedence is deterministic.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvVarGuard {
        key: &'static str,
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            std::env::remove_var(self.key);
        }
    }

    fn set_env(key: &'static str, value: &str) -> EnvVarGuard {
        std::env::set_var(key, value);
        EnvVarGuard { key }
    }

    fn unset_env(key: &'static str) -> EnvVarGuard {
        std::env::remove_var(key);
        EnvVarGuard { key }
    }

    fn make_sqlite_engine(dir: &Path) -> Arc<SqliteEngine> {
        SqliteEngine::open(&dir.join("fredo.db")).expect("open sqlite engine")
    }

    /// Seed the control-plane KV so a selection test can exercise precedence.
    fn seed_kv(engine: &SqliteEngine, key: &str, value: &str) {
        let conn = engine.write_conn();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .unwrap();
    }

    /// A lazily-connected pool: enough to build a `PgEngine` for the type/handle
    /// tests without a live server.
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

    // -- dialect helpers ------------------------------------------------------

    #[tokio::test]
    async fn store_engine_reports_its_dialect() {
        let dir = tempfile::tempdir().unwrap();
        let sqlite = StoreEngine::Sqlite(make_sqlite_engine(dir.path()));
        assert_eq!(sqlite.dialect(), Dialect::Sqlite);
        assert!(sqlite.sqlite().is_some());

        let pg = StoreEngine::Postgres(Arc::new(make_pg_engine(
            "postgres://postgres:secret@127.0.0.1:5432/fredo",
        )));
        assert_eq!(pg.dialect(), Dialect::Postgres);
        assert!(pg.sqlite().is_none());
    }

    // -- quote_ident ----------------------------------------------------------

    #[test]
    fn quote_ident_wraps_a_plain_identifier() {
        assert_eq!(
            quote_ident("feature_mission_monitor_items"),
            "\"feature_mission_monitor_items\""
        );
    }

    #[test]
    fn quote_ident_doubles_embedded_quotes() {
        assert_eq!(quote_ident("weird\"name"), "\"weird\"\"name\"");
        assert_eq!(quote_ident("a\"b\"c"), "\"a\"\"b\"\"c\"");
    }

    #[test]
    fn quote_ident_handles_the_empty_identifier() {
        assert_eq!(quote_ident(""), "\"\"");
    }

    // -- selection precedence (pure rule) -------------------------------------

    #[test]
    fn resolve_engine_choice_env_overrides_kv() {
        // The env var is authoritative in BOTH directions.
        assert_eq!(
            resolve_engine_choice(Some("postgres"), Some("false")),
            EngineChoice::Postgres
        );
        assert_eq!(
            resolve_engine_choice(Some("sqlite"), Some("true")),
            EngineChoice::Sqlite
        );
    }

    #[test]
    fn resolve_engine_choice_falls_back_to_kv() {
        assert_eq!(
            resolve_engine_choice(None, Some("true")),
            EngineChoice::Postgres
        );
        assert_eq!(
            resolve_engine_choice(None, Some("false")),
            EngineChoice::Sqlite
        );
        assert_eq!(resolve_engine_choice(None, None), EngineChoice::Sqlite);
    }

    #[test]
    fn resolve_engine_choice_treats_blank_or_unknown_env_as_unset() {
        assert_eq!(
            resolve_engine_choice(Some(""), Some("true")),
            EngineChoice::Postgres
        );
        assert_eq!(
            resolve_engine_choice(Some("   "), Some("true")),
            EngineChoice::Postgres
        );
        assert_eq!(
            resolve_engine_choice(Some("bogus"), Some("true")),
            EngineChoice::Postgres
        );
        assert_eq!(
            resolve_engine_choice(Some("bogus"), None),
            EngineChoice::Sqlite
        );
    }

    #[test]
    fn resolve_engine_choice_is_case_insensitive() {
        assert_eq!(
            resolve_engine_choice(Some("POSTGRES"), None),
            EngineChoice::Postgres
        );
        assert_eq!(
            resolve_engine_choice(None, Some("TRUE")),
            EngineChoice::Postgres
        );
    }

    // -- selection over a real SqliteEngine -----------------------------------

    #[test]
    fn select_engine_env_postgres_overrides_absent_kv() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _env = set_env(STORAGE_ENGINE_ENV, "postgres");
        let dir = tempfile::tempdir().unwrap();
        let engine = make_sqlite_engine(dir.path());
        assert_eq!(select_engine(&engine), EngineChoice::Postgres);
    }

    #[test]
    fn select_engine_env_sqlite_overrides_enabled_kv() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _env = set_env(STORAGE_ENGINE_ENV, "sqlite");
        let dir = tempfile::tempdir().unwrap();
        let engine = make_sqlite_engine(dir.path());
        seed_kv(&engine, PG_ENABLED_KEY, "true");
        assert_eq!(select_engine(&engine), EngineChoice::Sqlite);
    }

    #[test]
    fn select_engine_reads_enabled_kv_when_env_unset() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _env = unset_env(STORAGE_ENGINE_ENV);
        let dir = tempfile::tempdir().unwrap();
        let engine = make_sqlite_engine(dir.path());
        seed_kv(&engine, PG_ENABLED_KEY, "true");
        assert_eq!(select_engine(&engine), EngineChoice::Postgres);
    }

    #[test]
    fn select_engine_defaults_to_sqlite_when_nothing_is_set() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _env = unset_env(STORAGE_ENGINE_ENV);
        let dir = tempfile::tempdir().unwrap();
        // No `settings` table at all -> absent KV -> SQLite (fail-closed).
        let engine = make_sqlite_engine(dir.path());
        assert_eq!(select_engine(&engine), EngineChoice::Sqlite);
    }

    // -- swap-once handle -----------------------------------------------------

    #[tokio::test]
    async fn engine_handle_installs_postgres_at_most_once() {
        let dir = tempfile::tempdir().unwrap();
        let sqlite = make_sqlite_engine(dir.path());
        let handle = EngineHandle::new(StoreEngine::Sqlite(sqlite.clone()));

        // Starts on SQLite.
        assert_eq!(handle.engine().dialect(), Dialect::Sqlite);
        let old = handle.engine();
        assert!(old.sqlite().is_some());

        // First install: SQLite -> Postgres.
        let first_url = "postgres://postgres:secret@127.0.0.1:5432/fredo_first";
        handle.install(StoreEngine::Postgres(Arc::new(make_pg_engine(first_url))));
        let installed = handle.engine();
        assert_eq!(installed.dialect(), Dialect::Postgres);
        match installed.as_ref() {
            StoreEngine::Postgres(pg) => assert_eq!(pg.url, first_url),
            StoreEngine::Sqlite(_) => panic!("install did not swap to Postgres"),
        }

        // Second install is a no-op (first-wins).
        let second_url = "postgres://postgres:secret@127.0.0.1:5432/fredo_second";
        handle.install(StoreEngine::Postgres(Arc::new(make_pg_engine(second_url))));
        match handle.engine().as_ref() {
            StoreEngine::Postgres(pg) => {
                assert_eq!(pg.url, first_url, "install must run at most once")
            }
            StoreEngine::Sqlite(_) => panic!("engine must remain Postgres"),
        }

        // A reader that captured the old Arc still completes on the old engine.
        assert_eq!(old.dialect(), Dialect::Sqlite);
        old.sqlite()
            .unwrap()
            .write_conn()
            .execute_batch("CREATE TABLE after_swap (id TEXT);")
            .expect("the old engine stays usable for an in-flight reader");
    }

    #[tokio::test]
    async fn engine_handle_does_not_install_a_sqlite_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let first = make_sqlite_engine(dir.path());
        let handle = EngineHandle::new(StoreEngine::Sqlite(first.clone()));

        // A second SQLite engine must never replace the active one (install is
        // the SQLite -> Postgres edge only).
        let other_dir = tempfile::tempdir().unwrap();
        handle.install(StoreEngine::Sqlite(make_sqlite_engine(other_dir.path())));
        match handle.engine().as_ref() {
            StoreEngine::Sqlite(active) => {
                assert!(Arc::ptr_eq(active, &first), "the original engine must stay active")
            }
            StoreEngine::Postgres(_) => panic!("must not install Postgres here"),
        }
    }

    // -- SQLite write / read-only connection split ----------------------------

    #[test]
    fn sqlite_engine_write_is_visible_through_the_read_only_connection() {
        let dir = tempfile::tempdir().unwrap();
        let engine = make_sqlite_engine(dir.path());

        {
            let write = engine.write_conn();
            write
                .execute_batch("CREATE TABLE probe (id TEXT PRIMARY KEY, value TEXT NOT NULL);")
                .unwrap();
            write
                .execute("INSERT INTO probe (id, value) VALUES ('a', 'hello')", [])
                .unwrap();
        }

        let read = engine.read_only_conn();
        let value: String = read
            .query_row("SELECT value FROM probe WHERE id = 'a'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(value, "hello");
    }

    #[test]
    fn sqlite_engine_read_only_connection_rejects_writes() {
        let dir = tempfile::tempdir().unwrap();
        let engine = make_sqlite_engine(dir.path());
        engine
            .write_conn()
            .execute_batch("CREATE TABLE probe (id TEXT PRIMARY KEY);")
            .unwrap();

        {
            let read = engine.read_only_conn();
            assert!(
                read.execute("INSERT INTO probe (id) VALUES ('x')", []).is_err(),
                "the read-only connection must reject writes"
            );
        }

        // The rejected write left the table empty.
        let count: i64 = engine
            .write_conn()
            .query_row("SELECT COUNT(*) FROM probe", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
