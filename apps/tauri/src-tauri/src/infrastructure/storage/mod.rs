pub mod engine;
pub mod application_store;
pub mod migration;
pub mod span_store;

// The storage engine seam (Spec #2975 ST-1) re-exported at the module root so
// consumers read `storage::{EngineHandle, StoreEngine, ...}`. Spec #2976 ST-1
// adds the read-only canonical seam + the slice-3 schema inits.
pub use engine::{
    begin_read_only, ensure_rtdb_rows_schema_on_pg, ensure_telemetry_schema_on_pg, quote_ident,
    select_engine, CanonicalReader, Dialect, EngineChoice, EngineHandle, PgEngine,
    SqliteEngine, StoreEngine, PG_PERSISTENT_STATEMENTS, PG_POOL_ACQUIRE_TIMEOUT,
    PG_POOL_IDLE_TIMEOUT, PG_POOL_MAX_CONNECTIONS, PG_POOL_MAX_LIFETIME,
    PG_POOL_MIN_CONNECTIONS, PG_RTDB_ROWS_DDL, PG_TELEMETRY_DDL, STORAGE_ENGINE_ENV,
};

// The one-shot `fredo.db` → PostgreSQL data migration (Spec #2977) re-exported
// at the module root so consumers read `storage::{run_pre_install, ...}`.
pub use migration::{
    run_pre_install, MigrationGate, MigrationOutcome, MigrationStatus, MigrationStatusView,
    SnapshotRecord, TableParity, MIGRATION_CHUNK_ROWS, MIGRATION_COMPLETED_KEY,
};

use anyhow::Result;
use rusqlite::{params, Connection, OpenFlags};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The dedicated control-plane database filename (Spec #2979 CU-1).
pub const CONTROL_DB_FILENAME: &str = "control.db";

/// Resolve the dedicated control-plane database path under the resolved
/// app-data dir (Spec #2979 CU-1): `<app_data_dir>/control.db`.
///
/// The synchronous control plane was split off `fredo.db` onto this file so
/// `fredo.db` can be retained read-only (AC4/NFR); it is the ONE rule the
/// control-plane store uses.
pub fn resolve_control_db_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(CONTROL_DB_FILENAME)
}

/// The bounded ceiling on how many legacy `settings` rows the first-boot carry
/// reads out of `fredo.db` (Spec #2979 CU-1; G-263 — no unbounded read).
const CONTROL_CARRY_MAX_ROWS: i64 = 1_000;

/// Persistent key-value store (the `settings` table), split into two planes
/// (Spec #2975, ST-3; Spec #2979 CU-1/CU-2).
///
/// - **Control plane** ([`Self::control_get`] / [`Self::control_set`]): ALWAYS
///   synchronous SQLite, on its OWN `<app_data_dir>/control.db` (Spec #2979
///   CU-1). It holds the keys that must be readable *before* PostgreSQL exists
///   (`postgres.enabled`, `postgres_pid`, `postgres.password`) and the
///   synchronous startup config path. These keys NEVER route through the pool.
/// - **Data plane** ([`Self::get`] / [`Self::set`], async): routed through the
///   shared [`EngineHandle`] and therefore PostgreSQL-only (Spec #2979 CU-2). A
///   data-plane op with no pool installed fails closed (R-3.2).
///
/// The control-plane SQLite engine is opened on `control.db` at [`Self::open`]
/// so it is independent of the swap-once handle's `Pending -> PostgreSQL`
/// transition: after the pool is installed the handle serves the data plane,
/// while the control plane keeps serving the synchronous startup/lifecycle
/// reads.
pub struct AppStore {
    /// The shared swap-once engine handle (data plane).
    engine: Arc<EngineHandle>,
    /// The always-SQLite control plane (`control.db`, shared write connection).
    control: Arc<SqliteEngine>,
}

impl AppStore {
    /// Open the dedicated control plane and wrap the shared engine handle.
    ///
    /// The control plane lives on `<app_data_dir>/control.db`, where the
    /// app-data dir is resolved by the caller (`lib.rs`). The data-plane handle
    /// may be pending at open; only the control plane is opened here.
    ///
    /// On the FIRST boot of this control plane (no rows yet) the legacy
    /// `settings` rows are carried out of the existing `<app_data_dir>/fredo.db`
    /// READ-ONLY and seeded into `control.db` (bounded). `fredo.db` is never
    /// written by this path.
    pub fn open(engine: Arc<EngineHandle>, app_data_dir: &Path) -> Result<Self> {
        let control = SqliteEngine::open(&resolve_control_db_path(app_data_dir))?;
        control.write_conn().execute_batch(
            "CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )?;
        carry_legacy_settings(app_data_dir, &control)?;

        Ok(AppStore { engine, control })
    }

    /// The dedicated control-plane engine (`control.db`). Used by `lib.rs` to
    /// resolve the engine selection from the control plane (Spec #2979 CU-1).
    pub fn control_engine(&self) -> &Arc<SqliteEngine> {
        &self.control
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
    /// EXCLUDED.value` (REQ-2/EARS-2.1), matching the SQLite `excluded` upsert
    /// 1:1.
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

/// First-boot carry (Spec #2979 CU-1): when `control.db` has no rows yet and a
/// legacy `<app_data_dir>/fredo.db` exists, read its `settings` rows through a
/// READ-ONLY connection (bounded by [`CONTROL_CARRY_MAX_ROWS`]) and seed them
/// into the control plane. A missing/unreadable/table-less legacy db is a
/// no-op — the carry never fails a boot and never writes `fredo.db`.
fn carry_legacy_settings(app_data_dir: &Path, control: &SqliteEngine) -> Result<()> {
    // First boot only: an already-populated control plane is authoritative.
    let existing: i64 = control
        .write_conn()
        .query_row("SELECT COUNT(*) FROM settings", [], |row| row.get(0))
        .unwrap_or(0);
    if existing > 0 {
        return Ok(());
    }

    let legacy_path = app_data_dir.join("fredo.db");
    if !legacy_path.exists() {
        return Ok(());
    }

    let rows = read_legacy_settings(&legacy_path);
    if rows.is_empty() {
        return Ok(());
    }

    let mut conn = control.write_conn();
    let tx = conn.transaction()?;
    for (key, value) in &rows {
        tx.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Read at most [`CONTROL_CARRY_MAX_ROWS`] `settings` rows from `path` through a
/// READ-ONLY connection. Any error (missing file, missing table, unreadable) is
/// treated as "nothing to carry".
fn read_legacy_settings(path: &Path) -> Vec<(String, String)> {
    let Ok(conn) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare("SELECT key, value FROM settings LIMIT ?1") else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(params![CONTROL_CARRY_MAX_ROWS], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) else {
        return Vec::new();
    };
    rows.filter_map(|row| row.ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a tempdir-backed control-plane store over a PENDING data-plane
    /// handle (the PostgreSQL pool is not installed in these tests).
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

    // ── Spec #2979 CU-1/CU-2: the control plane lives on `control.db` ───────

    #[test]
    fn resolve_control_db_path_is_control_db_under_the_data_dir() {
        assert_eq!(
            resolve_control_db_path(Path::new("C:/appdata")),
            PathBuf::from("C:/appdata").join(CONTROL_DB_FILENAME)
        );
        assert_eq!(CONTROL_DB_FILENAME, "control.db");
    }

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
    async fn data_plane_fails_closed_while_the_pool_is_pending() {
        let (_dir, store) = make_store();
        // R-3.2: no SQLite data-plane fallback.
        assert!(store.get("theme").await.is_err());
        assert!(store.set("theme", "dark").await.is_err());
    }

    #[tokio::test]
    async fn control_plane_stays_on_sqlite_after_the_handle_installs_postgres() {
        let dir = tempfile::tempdir().unwrap();
        let handle = EngineHandle::new_pending();
        let store = AppStore::open(handle.clone(), dir.path()).unwrap();

        // The pool is installed (lazy, no server needed): the data plane now
        // targets PostgreSQL...
        handle.install(StoreEngine::Postgres(Arc::new(make_pg_engine(
            "postgres://postgres:secret@127.0.0.1:1/none",
        ))));

        // ...but the CONTROL plane (its own `control.db`) still round-trips — it
        // never routes through the pool.
        store.control_set("postgres.password", "loopback-secret").unwrap();
        assert_eq!(
            store.control_get("postgres.password").unwrap(),
            Some("loopback-secret".to_string())
        );

        // A DATA-plane read targets the (unreachable) pool and fails closed
        // rather than silently falling back to SQLite.
        assert!(
            store.get("theme").await.is_err(),
            "a data-plane read must target the active engine, not the control plane"
        );
    }

    #[tokio::test]
    async fn data_and_control_planes_are_separate_files() {
        let (dir, store) = make_store();
        // CU-1: the control plane is its OWN file under the resolved app-data
        // dir, so `fredo.db` is not the control plane any more.
        assert!(
            dir.path().join(CONTROL_DB_FILENAME).exists(),
            "the control plane must be materialized on control.db"
        );
        store.control_set("shared", "value").unwrap();
        assert_eq!(
            store.control_get("shared").unwrap(),
            Some("value".to_string())
        );
    }

    #[tokio::test]
    async fn control_plane_carries_legacy_settings_on_first_open_only() {
        let dir = tempfile::tempdir().unwrap();
        // Seed a legacy `fredo.db` settings row (the pre-CU-1 control plane).
        {
            let legacy = SqliteEngine::open(&dir.path().join("fredo.db")).unwrap();
            let conn = legacy.write_conn();
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS settings (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('postgres.enabled', 'false')",
                [],
            )
            .unwrap();
        }

        let store = AppStore::open(EngineHandle::new_pending(), dir.path()).unwrap();
        assert_eq!(
            store.control_get("postgres.enabled").unwrap(),
            Some("false".to_string()),
            "the legacy settings row must be carried into control.db"
        );

        // A later control-plane change is authoritative: a re-open must NOT
        // re-carry the stale legacy value (first boot only).
        store.control_set("postgres.enabled", "true").unwrap();
        let store2 = AppStore::open(EngineHandle::new_pending(), dir.path()).unwrap();
        assert_eq!(
            store2.control_get("postgres.enabled").unwrap(),
            Some("true".to_string()),
            "the carry must run once; control.db is authoritative afterwards"
        );
    }
}
