pub mod boot_config;
pub mod engine;
pub mod application_store;
pub mod migration;
pub mod settings_cache;
pub mod span_store;

// The ONE synchronous boot KV + the app-data-dir resolver (Spec #3005 ST-1),
// and the volatile PG-hydrated synchronous settings cache (Spec #3005 ST-2).
pub use boot_config::{
    resolve_app_data_dir, BootConfig, BOOT_CONFIG_FILENAME, BOOT_PID_KEY, DATA_DIR_ENV,
};
pub use settings_cache::SettingsCache;

// The storage engine seam (Spec #2975 ST-1) re-exported at the module root so
// consumers read `storage::{EngineHandle, StoreEngine, ...}`. Spec #2976 ST-1
// adds the read-only canonical seam + the slice-3 schema inits.
pub use engine::{
    begin_read_only, ensure_rtdb_rows_schema_on_pg, ensure_telemetry_schema_on_pg, quote_ident,
    CanonicalReader, Dialect, EngineHandle, PgEngine, SqliteEngine, StoreEngine,
    PG_PERSISTENT_STATEMENTS, PG_POOL_ACQUIRE_TIMEOUT, PG_POOL_IDLE_TIMEOUT,
    PG_POOL_MAX_CONNECTIONS, PG_POOL_MAX_LIFETIME, PG_POOL_MIN_CONNECTIONS, PG_RTDB_ROWS_DDL,
    PG_TELEMETRY_DDL,
};

// The one-shot `fredo.db` → PostgreSQL data migration (Spec #2977) re-exported
// at the module root so consumers read `storage::{run_pre_install, ...}`.
pub use migration::{
    run_pre_install, MigrationGate, MigrationOutcome, MigrationStatus, MigrationStatusView,
    SnapshotRecord, TableParity, MIGRATION_CHUNK_ROWS, MIGRATION_COMPLETED_KEY,
};

use anyhow::Result;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use self::application_store::block_on_pg;

/// The settings key whose value drives the tracing subscriber's log level;
/// [`AppStore::hydrate`] applies it through the retained reload handle (R-2.4).
pub const LOG_LEVEL_KEY: &str = "tracing.logging_level";

/// A boxed sink that applies a log level to the retained tracing reload handle.
pub type LogLevelSink = Box<dyn Fn(&str) + Send + Sync>;

/// One `settings` upsert on a PostgreSQL pool (the ONE durable write rule).
async fn upsert_settings(pool: &sqlx::PgPool, key: &str, value: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

/// Persistent key-value store (the `settings` table), split into two planes
/// (Spec #2975 ST-3; Spec #3005 ST-2).
///
/// - **Synchronous plane** ([`Self::cached_get`] / [`Self::cached_set`]): a
///   volatile, process-local [`SettingsCache`] hydrated ONCE from PostgreSQL by
///   [`Self::hydrate`] and write-through back to PostgreSQL. It backs the
///   synchronous hot paths (the log-filter refresh, the per-emit terminal label,
///   the metrics collector, the retention knobs) that cannot await, plus the
///   tracing subscriber's reload handle. It is NOT a second persistence system:
///   it holds no durable state of its own.
/// - **Data plane** ([`Self::get`] / [`Self::set`], async): routed through the
///   shared [`EngineHandle`] and therefore PostgreSQL-only. A data-plane op with
///   no pool installed fails closed (R-3.2).
///
/// Exactly ONE key is readable before PostgreSQL exists and lives outside both
/// planes: the postmaster PID marker in [`BootConfig`] (`<app_data_dir>/boot-config.json`).
pub struct AppStore {
    /// The shared swap-once engine handle (data plane).
    engine: Arc<EngineHandle>,
    /// The volatile synchronous settings cache (hydrated from PostgreSQL).
    cache: SettingsCache,
    /// The ONE synchronous boot KV (`<app_data_dir>/boot-config.json`).
    boot: BootConfig,
    /// `true` once [`Self::hydrate`] has run (a `cached_set` buffers until then).
    hydrated: AtomicBool,
    /// Writes made before hydration, buffered and flushed by [`Self::hydrate`].
    pending: Mutex<HashMap<String, String>>,
    /// Startup defaults seeded for keys PostgreSQL has no row for.
    defaults: Mutex<Vec<(String, String)>>,
    /// The retained tracing reload handle's applier (set once by `lib.rs`).
    log_level_sink: Mutex<Option<LogLevelSink>>,
}

impl AppStore {
    /// Wrap the shared engine handle and target `<app_data_dir>` for the boot KV.
    ///
    /// No file database is created: the synchronous plane is the volatile
    /// [`SettingsCache`], hydrated from PostgreSQL once the pool is ready.
    pub fn open(engine: Arc<EngineHandle>, app_data_dir: &Path) -> Result<Self> {
        Ok(AppStore {
            engine,
            cache: SettingsCache::new(),
            boot: BootConfig::open(app_data_dir)?,
            hydrated: AtomicBool::new(false),
            pending: Mutex::new(HashMap::new()),
            defaults: Mutex::new(Vec::new()),
            log_level_sink: Mutex::new(None),
        })
    }

    /// The ONE synchronous boot KV (`<app_data_dir>/boot-config.json`). Holds the
    /// postmaster PID marker ([`BOOT_PID_KEY`]) - the only key readable before
    /// PostgreSQL exists.
    pub fn boot(&self) -> &BootConfig {
        &self.boot
    }

    /// Install the retained tracing reload handle's applier. Set once by `lib.rs`
    /// after the subscriber is initialized; [`Self::hydrate`] invokes it with the
    /// persisted `tracing.logging_level` (R-2.4, single `.init()`, no re-init).
    pub fn set_log_level_sink(&self, sink: LogLevelSink) {
        *lock(&self.log_level_sink) = Some(sink);
    }

    /// Register a startup default. [`Self::hydrate`] seeds it ONLY when
    /// PostgreSQL has no row for the key, so a persisted user value always wins.
    pub fn register_default(&self, key: &str, value: &str) {
        lock(&self.defaults).push((key.to_string(), value.to_string()));
    }

    /// Read one value from the synchronous cache. A pre-hydration read of an
    /// unknown key returns `None` (the consumer's default-on-`None` rule); an
    /// unknown key is NEVER `Some("")`.
    pub fn cached_get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.cache.get(key))
    }

    /// Write one value: update the cache immediately, then durably upsert into
    /// PostgreSQL. Before hydration the write is buffered and flushed by
    /// [`Self::hydrate`] (R-2.2/R-2.3).
    pub fn cached_set(&self, key: &str, value: &str) -> Result<()> {
        self.cache.set(key, value);
        if !self.hydrated.load(Ordering::SeqCst) {
            lock(&self.pending).insert(key.to_string(), value.to_string());
            return Ok(());
        }
        self.durable_upsert(key, value)
    }

    /// Write-through one value to PostgreSQL from the synchronous plane. When the
    /// pool is not installed yet the write is buffered for the next hydrate.
    fn durable_upsert(&self, key: &str, value: &str) -> Result<()> {
        let Some(engine) = self.engine.engine() else {
            lock(&self.pending).insert(key.to_string(), value.to_string());
            return Ok(());
        };
        let StoreEngine::Postgres(pg) = engine.as_ref();
        block_on_pg(upsert_settings(&pg.pool, key, value))
    }

    // ── Hydration ────────────────────────────────────────────────────────────

    /// Hydrate the synchronous cache from PostgreSQL ONCE (R-2.2): one bounded
    /// `SELECT key, value FROM settings` (bounded by the pool acquire timeout).
    ///
    /// Ordering contract: the persisted rows replace the cache; any write
    /// buffered before hydration (a `cached_set` while the pool was pending, or
    /// an env override applied at startup) is then flushed and wins; finally the
    /// registered defaults are seeded for keys PostgreSQL has no row for. A
    /// hydration failure leaves the cache at defaults (in memory) and is logged -
    /// it NEVER blocks boot (N-2).
    pub async fn hydrate(&self) -> Result<()> {
        if self.hydrated.load(Ordering::SeqCst) {
            return Ok(());
        }
        match self.select_all().await {
            Ok(rows) => {
                self.cache.replace_all(rows);
                let pending: Vec<(String, String)> = lock(&self.pending).drain().collect();
                for (key, value) in pending {
                    self.cache.set(&key, &value);
                    if let Err(error) = self.upsert_async(&key, &value).await {
                        tracing::warn!(target: "fredo::storage", %error, key, "settings write-through failed while flushing pre-hydration writes");
                    }
                }
                let defaults = lock(&self.defaults).clone();
                for (key, value) in defaults {
                    if self.cache.get(&key).is_none() {
                        self.cache.set(&key, &value);
                        if let Err(error) = self.upsert_async(&key, &value).await {
                            tracing::warn!(target: "fredo::storage", %error, key, "settings write-through failed while seeding a default");
                        }
                    }
                }
            }
            Err(error) => {
                tracing::warn!(
                    target: "fredo::storage",
                    error = %error,
                    "settings hydration failed; serving defaults (boot is never blocked)"
                );
                for (key, value) in lock(&self.defaults).clone() {
                    self.cache.set(&key, &value);
                }
            }
        }
        self.hydrated.store(true, Ordering::SeqCst);
        self.apply_log_level();
        Ok(())
    }

    /// The one bounded hydration read.
    async fn select_all(&self) -> Result<HashMap<String, String>> {
        let engine = self.engine.engine_or_err()?;
        let StoreEngine::Postgres(pg) = engine.as_ref();
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT key, value FROM settings")
                .fetch_all(&pg.pool)
                .await?;
        Ok(rows.into_iter().collect())
    }

    /// One async write-through (no-op when the pool is not installed).
    async fn upsert_async(&self, key: &str, value: &str) -> Result<()> {
        match self.engine.engine() {
            Some(engine) => {
                let StoreEngine::Postgres(pg) = engine.as_ref();
                upsert_settings(&pg.pool, key, value).await
            }
            None => Ok(()),
        }
    }

    /// Apply the persisted log level through the retained reload handle (R-2.4).
    fn apply_log_level(&self) {
        let Some(level) = self.cache.get(LOG_LEVEL_KEY) else {
            return;
        };
        if let Some(sink) = lock(&self.log_level_sink).as_ref() {
            sink(&level);
        }
    }

    // ── Data plane (engine-selected; async) ──────────────────────────────────

    /// Read one `settings` KV value from the ACTIVE engine.
    ///
    /// An unknown key returns `None` on both engines (REQ-4/EARS-4.3) — never an
    /// empty-string sentinel.
    pub async fn get(&self, key: &str) -> Result<Option<String>> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
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
    /// EXCLUDED.value` (REQ-2/EARS-2.1).
    pub async fn set(&self, key: &str, value: &str) -> Result<()> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
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

/// Lock a mutex, recovering from poisoning (no `unwrap`).
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a tempdir-backed store over a PENDING data-plane handle (the
    /// PostgreSQL pool is not installed in these tests).
    fn make_store() -> (tempfile::TempDir, AppStore) {
        let dir = tempfile::tempdir().unwrap();
        let handle = EngineHandle::new_pending();
        let store = AppStore::open(handle, dir.path()).unwrap();
        (dir, store)
    }

    /// A lazily-connected pool: enough to install PostgreSQL without a live
    /// server (a query then fails closed rather than hanging).
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

    // ── Spec #3005 ST-2: the synchronous cache replaces the SQLite control plane ──

    #[test]
    fn open_creates_no_file_database() {
        // R-1.2: no `.db` file is created now that the control plane is a
        // volatile in-memory cache.
        let (dir, _store) = make_store();
        let db_files: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".db"))
            .collect();
        assert!(
            db_files.is_empty(),
            "AppStore::open must create no database file, found {db_files:?}"
        );
    }

    #[tokio::test]
    async fn cached_set_then_get_round_trips() {
        let (_dir, store) = make_store();
        store.cached_set("rtdb.retention_days", "7").unwrap();
        assert_eq!(
            store.cached_get("rtdb.retention_days").unwrap(),
            Some("7".to_string())
        );
        store.cached_set("rtdb.retention_days", "3").unwrap();
        assert_eq!(
            store.cached_get("rtdb.retention_days").unwrap(),
            Some("3".to_string())
        );
    }

    #[tokio::test]
    async fn an_unknown_key_is_none_never_an_empty_string() {
        let (_dir, store) = make_store();
        assert_eq!(store.cached_get("absent").unwrap(), None);
    }

    #[tokio::test]
    async fn data_plane_fails_closed_while_the_pool_is_pending() {
        let (_dir, store) = make_store();
        // R-3.2: no fallback data plane.
        assert!(store.get("theme").await.is_err());
        assert!(store.set("theme", "dark").await.is_err());
    }

    #[tokio::test]
    async fn hydrate_without_a_pool_seeds_defaults_and_never_blocks() {
        // N-2: a hydration failure (no pool) leaves the cache at the registered
        // defaults and returns Ok - boot is never blocked.
        let (_dir, store) = make_store();
        store.register_default("tracing.enabled", "true");
        store.register_default("tracing.logging_level", "INFO");

        store.hydrate().await.expect("hydrate must not fail the boot");

        assert_eq!(
            store.cached_get("tracing.enabled").unwrap(),
            Some("true".to_string())
        );
        assert_eq!(
            store.cached_get("tracing.logging_level").unwrap(),
            Some("INFO".to_string())
        );
        // Idempotent: a second hydrate is a no-op.
        store.hydrate().await.expect("a second hydrate is inert");
        assert_eq!(
            store.cached_get("tracing.enabled").unwrap(),
            Some("true".to_string())
        );
    }

    #[tokio::test]
    async fn a_write_before_hydration_is_buffered_and_visible() {
        let (_dir, store) = make_store();
        store.cached_set("doom_save_v1", "pre-hydration").unwrap();
        assert_eq!(
            store.cached_get("doom_save_v1").unwrap(),
            Some("pre-hydration".to_string()),
            "a pre-hydration write is visible to a synchronous read"
        );
        // A write after a no-pool hydrate still succeeds (buffered).
        store.hydrate().await.unwrap();
        store.cached_set("doom_save_v1", "post-hydration").unwrap();
        assert_eq!(
            store.cached_get("doom_save_v1").unwrap(),
            Some("post-hydration".to_string())
        );
    }

    #[tokio::test]
    async fn hydrate_applies_the_log_level_through_the_retained_handle() {
        // R-2.4: the persisted tracing.logging_level is applied through the
        // retained reload handle (here a recording sink) without re-initializing.
        let (_dir, store) = make_store();
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let recorder = seen.clone();
        store.set_log_level_sink(Box::new(move |level: &str| {
            recorder.lock().unwrap().push(level.to_string());
        }));
        store.register_default(LOG_LEVEL_KEY, "DEBUG");

        store.hydrate().await.unwrap();

        assert_eq!(
            seen.lock().unwrap().clone(),
            vec!["DEBUG".to_string()],
            "hydrate must apply the persisted log level through the sink"
        );
    }

    #[tokio::test]
    async fn cached_plane_never_routes_through_the_engine() {
        // The synchronous cache answers even after the handle installs an
        // (unreachable) PostgreSQL pool: it never dials the pool.
        let dir = tempfile::tempdir().unwrap();
        let handle = EngineHandle::new_pending();
        let store = AppStore::open(handle.clone(), dir.path()).unwrap();
        handle.install(StoreEngine::Postgres(Arc::new(make_pg_engine(
            "postgres://postgres:secret@127.0.0.1:1/none",
        ))));

        store.cached_set("postgres.password", "loopback-secret").unwrap();
        assert_eq!(
            store.cached_get("postgres.password").unwrap(),
            Some("loopback-secret".to_string())
        );

        // A DATA-plane read targets the (unreachable) pool and fails closed.
        assert!(
            store.get("theme").await.is_err(),
            "a data-plane read must target the active engine, not the cache"
        );
    }
}
