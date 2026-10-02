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

use super::migration::{MigrationGate, MigrationOutcome, MigrationStatusView};

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

/// The hot PostgreSQL statements the slice-3 stores prepare ONCE and reuse
/// (`sqlx::query(...).persistent(true)`), per Q-6 (Spec #2976).
///
/// These nine statements dominate the write-behind / point-read / prune paths.
/// Every other statement uses sqlx's default one-shot path; the pool's
/// per-connection statement cache is the sqlx default (no change), and the pool
/// sizing constants above stay verbatim (Q-6).
///
/// - three `*_rows` full-row upserts (REQ-3): `chat_rows` / `tool_use_rows` /
///   `agent_session_rows`
/// - three point reads (REQ-6): `get_chat_row` / `get_tool_use_row` /
///   `get_agent_session_row`
/// - the durable-seq seed (REQ-7): `SELECT COALESCE(MAX(seq), 0) …`
/// - the two prune `DELETE … RETURNING` forms (REQ-8): retention + global cap
pub const PG_PERSISTENT_STATEMENTS: [&str; 9] = [
    "chat_rows_upsert",
    "tool_use_rows_upsert",
    "agent_session_rows_upsert",
    "get_chat_row",
    "get_tool_use_row",
    "get_agent_session_row",
    "max_seq",
    "prune_retention",
    "prune_global_cap",
];

// -- Dialect ------------------------------------------------------------------

/// Which SQL dialect the active engine speaks. Returned by
/// [`StoreEngine::dialect`].
///
/// Since Spec #2979 CU-2 the data plane is PostgreSQL-only, so this enum has a
/// single variant; it is retained as the serialized status token (CU-3 extends
/// the status wire).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    Postgres,
}

// -- Engines ------------------------------------------------------------------

/// The ONE synchronous SQLite engine: the pre-PostgreSQL **control plane**
/// (Spec #2979 CU-1/CU-2). Since CU-2 removed the SQLite data plane, `rusqlite`
/// is retained ONLY here (the control plane) and in the one-shot migration
/// module (`storage/migration/**`). It opens two connections over the SAME
/// control-plane database (`<app_data_dir>/control.db`).
///
/// - `write` is the single write handle, in WAL journal mode.
/// - `read_only` is a second handle pinned with `PRAGMA query_only=ON`.
pub struct SqliteEngine {
    write: Mutex<Connection>,
    read_only: Mutex<Connection>,
}

impl SqliteEngine {
    /// Open (or create) `db_path` and build the shared write + read-only
    /// handles. Parent directories are created.
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
    /// selection contract's "absent => default" rule (the default is PostgreSQL
    /// since Spec #2979 CU-1), never a hard failure at selection time.
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

/// The active data-plane engine. Cloned into every migrated store.
///
/// Since Spec #2979 CU-2 the migrated stores are PostgreSQL-only: the SQLite
/// arm is removed, so this enum has a single variant. The synchronous control
/// plane (`control.db`) is NOT part of this seam — it stays on [`SqliteEngine`]
/// directly.
#[derive(Clone)]
pub enum StoreEngine {
    Postgres(Arc<PgEngine>),
}

impl StoreEngine {
    /// The SQL dialect this engine speaks (always PostgreSQL).
    pub fn dialect(&self) -> Dialect {
        Dialect::Postgres
    }

    /// The read-only canonical reader for this engine (AC3 / REQ-9).
    ///
    /// The ONE handle every canonical reader (the canonical backfill, provider
    /// re-derivation, and the declared-table backfill) consumes: the shared
    /// PostgreSQL pool, whose reads are wrapped in [`begin_read_only`]. `None`
    /// only when no engine is available.
    pub fn canonical_reader(&self) -> Option<CanonicalReader> {
        let StoreEngine::Postgres(engine) = self;
        Some(CanonicalReader::Postgres(engine.pool.clone()))
    }

    /// The active PostgreSQL pool (REQ-9).
    pub fn pg_pool(&self) -> &sqlx::PgPool {
        let StoreEngine::Postgres(engine) = self;
        &engine.pool
    }
}

// -- The read-only canonical seam (Spec #2976, ST-1) --------------------------

/// The read-only canonical reader (AC3 / REQ-9).
///
/// Since Spec #2979 CU-2 the data plane is PostgreSQL-only, so the reader always
/// carries a clone of the shared [`sqlx::PgPool`]; every read is wrapped in a
/// read-only transaction via [`begin_read_only`].
///
/// No canonical reader invents its own connection: the handle is derived from
/// [`StoreEngine::canonical_reader`], which follows the active engine.
#[derive(Clone)]
pub enum CanonicalReader {
    /// The shared PostgreSQL pool; wrap reads in [`begin_read_only`].
    Postgres(sqlx::PgPool),
}

/// The PostgreSQL analogue of `PRAGMA query_only=ON`: begin a
/// `START TRANSACTION READ ONLY` transaction on the shared pool (REQ-9).
///
/// Every write through the returned transaction is rejected by PostgreSQL, so a
/// canonical reader can never mutate `telemetry_spans` / `*_rows`. A rejected
/// write aborts only the transaction — the connection returns to the pool on
/// drop and writers are unaffected. Bounded by the pool's own acquire timeout
/// (G-263).
pub async fn begin_read_only(
    pool: &sqlx::PgPool,
) -> Result<sqlx::Transaction<'static, sqlx::Postgres>> {
    pool.begin_with("START TRANSACTION READ ONLY")
        .await
        .map_err(|error| anyhow::anyhow!("[pg:read-only] {error}"))
}

// -- The swap-once handle -----------------------------------------------------

/// The swap-once shared handle held by every migrated store (`Arc`-cloned).
///
/// Starts **pending** (no data-plane engine); [`Self::install`] performs the ONE
/// `Pending -> PostgreSQL` transition when the managed server becomes ready.
/// Until then, a data-plane operation fail-closes with a structured error
/// ([`Self::pg`]) rather than serving from SQLite (R-3.2). A reader that already
/// captured the previous `Arc` keeps completing on that engine — the swap never
/// invalidates an in-flight read.
pub struct EngineHandle {
    inner: RwLock<Option<Arc<StoreEngine>>>,
}

impl EngineHandle {
    /// A handle with no data-plane engine installed yet. The supervisor installs
    /// the PostgreSQL pool once the managed server is ready.
    pub fn new_pending() -> Arc<Self> {
        Arc::new(EngineHandle {
            inner: RwLock::new(None),
        })
    }

    /// Wrap an already-built engine (test/eager construction).
    pub fn new(engine: StoreEngine) -> Arc<Self> {
        Arc::new(EngineHandle {
            inner: RwLock::new(Some(Arc::new(engine))),
        })
    }

    /// The active engine, or `None` while the PostgreSQL pool is not installed.
    pub fn engine(&self) -> Option<Arc<StoreEngine>> {
        lock_read(&self.inner).clone()
    }

    /// The ONLY path to PostgreSQL: install `engine` exactly once.
    ///
    /// Swap-once semantics: only the first `Pending -> PostgreSQL` transition
    /// replaces the active engine; every later call is a no-op (first-wins), so
    /// a second install can never replace an active pool.
    pub fn install(&self, engine: StoreEngine) {
        let mut guard = lock_write(&self.inner);
        if guard.is_none() {
            *guard = Some(Arc::new(engine));
        }
    }

    /// The active engine, or a structured fail-closed error when the PostgreSQL
    /// pool is not installed yet (R-3.2: a data-plane op never serves from
    /// SQLite).
    pub fn engine_or_err(&self) -> Result<Arc<StoreEngine>> {
        self.engine().ok_or_else(|| {
            anyhow::anyhow!(
                "[storage] engine not ready: the PostgreSQL pool is not installed yet (fail-closed, R-3.2)"
            )
        })
    }

    /// The active PostgreSQL engine, or a structured fail-closed error when the
    /// pool is not installed yet (R-3.2: a data-plane op never serves from
    /// SQLite).
    pub fn pg(&self) -> Result<Arc<PgEngine>> {
        match self.engine() {
            Some(engine) => {
                let StoreEngine::Postgres(pg) = engine.as_ref();
                Ok(Arc::clone(pg))
            }
            None => Err(anyhow::anyhow!(
                "[storage] engine not ready: the PostgreSQL pool is not installed yet (fail-closed, R-3.2)"
            )),
        }
    }
}

// -- Engine selection ---------------------------------------------------------

/// Which engine the app should run the data plane on.
///
/// Spec #2979 CU-1-R2: PostgreSQL is UNCONDITIONAL — the historical `Sqlite`
/// variant was removed because post-CU-2 there is no SQLite data plane to
/// select. Single-variant by design, mirroring the
/// [`crate::features::pg_supervisor::release_gate::ShippedDefault`] precedent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineChoice {
    Postgres,
}

/// Resolve the engine choice (REQ-1/EARS-1.1; Spec #2979 CU-1, reworked CU-1-R2).
///
/// PostgreSQL is the UNCONDITIONAL data-plane engine. Neither the
/// `FREDO_STORAGE_ENGINE` env lever nor the legacy control-plane KV key
/// `postgres.enabled` can select SQLite (post-CU-2 there is no SQLite data
/// plane):
/// - `postgres` (case-insensitive) selects PostgreSQL;
/// - the legacy `sqlite` env value is inert/rejected => PostgreSQL;
/// - the legacy control-plane opt-out `postgres.enabled = "false"` is INERT =>
///   PostgreSQL. A carried key out of an upgraded install must NOT disable the
///   PostgreSQL-only data plane (CU-1-R2 defect: it left the `EngineHandle`
///   `Pending` and bricked the app).
///
/// `control` is the DEDICATED control-plane engine (`control.db`), not the
/// data-plane engine.
pub fn select_engine(control: &SqliteEngine) -> EngineChoice {
    let env = std::env::var(STORAGE_ENGINE_ENV).ok();
    let kv = control.kv_get(PG_ENABLED_KEY);
    resolve_engine_choice(env.as_deref(), kv.as_deref())
}

/// The pure precedence rule, split out so it is unit-testable without touching
/// process-global environment state. Both inputs are retained (and ignored) so
/// the unconditional-PostgreSQL rule stays directly testable — see the
/// selection-precedence tests below.
fn resolve_engine_choice(_env: Option<&str>, _kv_enabled: Option<&str>) -> EngineChoice {
    EngineChoice::Postgres
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

// -- PostgreSQL pool build (Spec #2975, ST-2) ---------------------------------

/// Wall-clock bound on the WHOLE pool build + schema init (G-263). Every leg of
/// the build is additionally bounded by the pool's own acquire timeout.
pub const PG_POOL_BUILD_BOUND: std::time::Duration = std::time::Duration::from_secs(30);

/// A named stage of the bounded pool build. The **FS-4** injectable fault seam
/// (`FREDO_PG_POOL_FORCE_FAIL`, owned by `features::pg_supervisor`) forces the
/// build to fail AT one of these stages, so the fail-closed `Pending` outcome
/// (no engine installed; there is NO SQLite data-plane fallback) is observable
/// without corrupting a real data dir (G-275).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PgPoolStage {
    /// Establish the pool (real connections to the managed server).
    Connect,
    /// Create the shared `settings` KV schema on the new pool.
    SchemaInit,
}

impl PgPoolStage {
    /// Parse a fault-seam value into a stage. `None` for blank/unset;
    /// `1`/`true`/`yes`/`connect` => [`PgPoolStage::Connect`]; a schema spelling
    /// => [`PgPoolStage::SchemaInit`]; any other non-blank value still forces a
    /// failure (at `Connect`), so a simple truthy toggle is enough.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "" => None,
            "schema" | "schema-init" | "schema_init" | "schemainit" => Some(PgPoolStage::SchemaInit),
            _ => Some(PgPoolStage::Connect),
        }
    }

    /// The stage's stable name, used in the structured failure reason.
    pub fn name(self) -> &'static str {
        match self {
            PgPoolStage::Connect => "connect",
            PgPoolStage::SchemaInit => "schemaInit",
        }
    }
}

/// Build ONE bounded `sqlx::PgPool` against `url`, then run the shared schema
/// init.
///
/// Fail-closed contract (REQ-3/EARS-3.2): ANY error or timeout returns `Err` and
/// no pool — the caller installs nothing and the app stays on SQLite. `force_fail`
/// is the **FS-4** fault seam (G-275): when `Some`, the build fails at that named
/// stage without touching a real data dir (REQ-3/EARS-3.3).
pub async fn build_pg_pool(url: &str, force_fail: Option<PgPoolStage>) -> Result<PgEngine> {
    match tokio::time::timeout(PG_POOL_BUILD_BOUND, build_pg_pool_inner(url, force_fail)).await {
        Ok(result) => result,
        Err(_) => Err(anyhow::anyhow!(
            "[pool] the pool build exceeded its {PG_POOL_BUILD_BOUND:?} wall-clock bound"
        )),
    }
}

async fn build_pg_pool_inner(url: &str, force_fail: Option<PgPoolStage>) -> Result<PgEngine> {
    // FS-4: fail at the named stage, deterministically, before connecting.
    if force_fail == Some(PgPoolStage::Connect) {
        return Err(forced_pool_failure(PgPoolStage::Connect));
    }

    let pool = sqlx::postgres::PgPoolOptions::new()
        .min_connections(PG_POOL_MIN_CONNECTIONS)
        .max_connections(PG_POOL_MAX_CONNECTIONS)
        .acquire_timeout(PG_POOL_ACQUIRE_TIMEOUT)
        .idle_timeout(Some(PG_POOL_IDLE_TIMEOUT))
        .max_lifetime(Some(PG_POOL_MAX_LIFETIME))
        .connect(url)
        .await
        .map_err(|error| anyhow::anyhow!("[pool:connect] {error}"))?;

    // FS-4: fail after the pool connected but before schema init.
    if force_fail == Some(PgPoolStage::SchemaInit) {
        return Err(forced_pool_failure(PgPoolStage::SchemaInit));
    }

    ensure_settings_schema(&pool)
        .await
        .map_err(|error| anyhow::anyhow!("[pool:schemaInit] {error}"))?;

    Ok(PgEngine {
        pool,
        url: url.to_string(),
    })
}

fn forced_pool_failure(stage: PgPoolStage) -> anyhow::Error {
    anyhow::anyhow!(
        "[pool:{}] forced failure via the FS-4 fault seam",
        stage.name()
    )
}

/// Create the shared `settings` KV schema on a PostgreSQL pool (idempotent).
pub async fn ensure_settings_schema(pool: &sqlx::PgPool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
    )
    .execute(pool)
    .await?;
    Ok(())
}

// -- Slice-3 PostgreSQL schema init (Spec #2976, ST-1) ------------------------

/// The PostgreSQL DDL for the three RTDB canonical `*_rows` tables + their
/// indexes (REQ-2), 1:1 with the SQLite schema (`rtdb/store.rs::ensure_schema`;
/// C1 type map `TEXT→TEXT`, `INTEGER→BIGINT`, `REAL→DOUBLE PRECISION`).
///
/// The single PostgreSQL DDL source for these tables: the startup schema-init
/// registry ([`StorageEngineState::register_slice3_pg_schema_inits`]) and the
/// store's `ensure_schema` PostgreSQL arm both route here, so the DDL is never
/// re-declared (NFR-6 spirit). `provider` is `NOT NULL DEFAULT 'unknown'`, the
/// composite `(session_id, correlation_id)` is the PK, and re-running is a no-op.
pub const PG_RTDB_ROWS_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS chat_rows (
    session_id                  TEXT NOT NULL,
    correlation_id              TEXT NOT NULL,
    seq                         BIGINT NOT NULL,
    started_at_ns               BIGINT,
    ended_at_ns                 BIGINT,
    updated_at                  TEXT NOT NULL,
    state                       TEXT NOT NULL,
    user_message                TEXT,
    agent_reply                 TEXT,
    prompt_tokens               BIGINT,
    completion_tokens           BIGINT,
    cache_read_tokens           BIGINT,
    cost_usd                    DOUBLE PRECISION,
    model                       TEXT,
    parent_session_id           TEXT,
    composited_child_session_id TEXT,
    raw_json                    TEXT NOT NULL,
    provider                    TEXT NOT NULL DEFAULT 'unknown',
    PRIMARY KEY (session_id, correlation_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_started ON chat_rows(started_at_ns);
CREATE INDEX IF NOT EXISTS idx_chat_session_time ON chat_rows(session_id, started_at_ns);
CREATE INDEX IF NOT EXISTS idx_chat_updated ON chat_rows(updated_at);
CREATE TABLE IF NOT EXISTS tool_use_rows (
    session_id                 TEXT NOT NULL,
    correlation_id             TEXT NOT NULL,
    seq                        BIGINT NOT NULL,
    started_at_ns              BIGINT,
    ended_at_ns                BIGINT,
    updated_at                 TEXT NOT NULL,
    state                      TEXT NOT NULL,
    tool_name                  TEXT,
    tool_success               BIGINT,
    tool_error                 TEXT,
    duration_ms                BIGINT,
    tool_input_json            TEXT,
    tool_output_json           TEXT,
    is_subagent                BIGINT,
    raw_json                   TEXT NOT NULL,
    provider                   TEXT NOT NULL DEFAULT 'unknown',
    PRIMARY KEY (session_id, correlation_id)
);
CREATE INDEX IF NOT EXISTS idx_tool_started ON tool_use_rows(started_at_ns);
CREATE INDEX IF NOT EXISTS idx_tool_session_time ON tool_use_rows(session_id, started_at_ns);
CREATE INDEX IF NOT EXISTS idx_tool_updated ON tool_use_rows(updated_at);
CREATE TABLE IF NOT EXISTS agent_session_rows (
    session_id                 TEXT NOT NULL,
    correlation_id             TEXT NOT NULL,
    seq                        BIGINT NOT NULL,
    started_at_ns              BIGINT,
    ended_at_ns                BIGINT,
    updated_at                 TEXT NOT NULL,
    state                      TEXT NOT NULL,
    total_tokens               BIGINT,
    total_messages             BIGINT,
    total_cost_usd             DOUBLE PRECISION,
    agent_name                 TEXT,
    raw_json                   TEXT NOT NULL,
    provider                   TEXT NOT NULL DEFAULT 'unknown',
    PRIMARY KEY (session_id, correlation_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_started ON agent_session_rows(started_at_ns);
CREATE INDEX IF NOT EXISTS idx_agent_session_time ON agent_session_rows(session_id, started_at_ns);
CREATE INDEX IF NOT EXISTS idx_agent_updated ON agent_session_rows(updated_at);
"#;

/// The PostgreSQL DDL for the three telemetry tables + their indexes (REQ-2),
/// with the C1 type map (`INTEGER→BIGINT`, `REAL→DOUBLE PRECISION`, and
/// `GENERATED ALWAYS AS IDENTITY` identity columns).
///
/// The single PostgreSQL DDL source for these tables (see [`PG_RTDB_ROWS_DDL`]).
/// `telemetry_spans` keeps the `span_id` PK and the `WHERE status_code = 'ERROR'`
/// partial index; `telemetry_logs.id` / `telemetry_metrics.id` are
/// `BIGINT GENERATED ALWAYS AS IDENTITY`.
pub const PG_TELEMETRY_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS telemetry_spans (
    trace_id        TEXT NOT NULL,
    span_id         TEXT PRIMARY KEY,
    parent_span_id  TEXT,
    span_name       TEXT NOT NULL,
    span_kind       TEXT NOT NULL DEFAULT 'INTERNAL',
    start_time_ns   BIGINT NOT NULL,
    end_time_ns     BIGINT,
    status_code     TEXT NOT NULL DEFAULT 'UNSET',
    status_message  TEXT,
    session_id      TEXT NOT NULL,
    attributes_json TEXT,
    events_json     TEXT,
    provider        TEXT,
    transport       TEXT,
    event_type      TEXT,
    ingested_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telemetry_spans_trace_id ON telemetry_spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_spans_start_time ON telemetry_spans(start_time_ns);
CREATE INDEX IF NOT EXISTS idx_telemetry_spans_session ON telemetry_spans(session_id, start_time_ns);
CREATE INDEX IF NOT EXISTS idx_telemetry_spans_event_type ON telemetry_spans(event_type, start_time_ns);
CREATE INDEX IF NOT EXISTS idx_telemetry_spans_error ON telemetry_spans(status_code) WHERE status_code = 'ERROR';
CREATE TABLE IF NOT EXISTS telemetry_logs (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    timestamp       TEXT NOT NULL,
    level           TEXT NOT NULL,
    target          TEXT NOT NULL,
    message         TEXT NOT NULL,
    attributes_json TEXT DEFAULT '{}',
    trace_id        TEXT,
    span_id         TEXT,
    session_id      TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON telemetry_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_level ON telemetry_logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_trace_id ON telemetry_logs(trace_id);
CREATE INDEX IF NOT EXISTS idx_logs_session_id ON telemetry_logs(session_id);
CREATE TABLE IF NOT EXISTS telemetry_metrics (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    metric_name          TEXT NOT NULL,
    metric_type          TEXT NOT NULL,
    labels_json          TEXT DEFAULT '{}',
    value                DOUBLE PRECISION NOT NULL,
    timestamp            TEXT NOT NULL,
    aggregation_window_s BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_name_time ON telemetry_metrics(metric_name, timestamp);
"#;

/// Create the three RTDB canonical `*_rows` tables on a PostgreSQL pool
/// (idempotent). Runs the PostgreSQL arm of `RtdbStore::ensure_schema`.
pub fn ensure_rtdb_rows_schema_on_pg(pool: &sqlx::PgPool) -> Result<()> {
    super::feature_store::block_on_pg(async {
        sqlx::raw_sql(PG_RTDB_ROWS_DDL).execute(pool).await.map(|_| ())
    })?;
    Ok(())
}

/// Create the three telemetry tables on a PostgreSQL pool (idempotent). Runs the
/// PostgreSQL arm of `SpanStore::ensure_schema` / `ensure_logs_schema` /
/// `ensure_metrics_schema`.
pub fn ensure_telemetry_schema_on_pg(pool: &sqlx::PgPool) -> Result<()> {
    super::feature_store::block_on_pg(async {
        sqlx::raw_sql(PG_TELEMETRY_DDL).execute(pool).await.map(|_| ())
    })?;
    Ok(())
}

impl StorageEngineState {
    /// Register the six canonical slice-3 tables' PostgreSQL schema initializers
    /// (REQ-2) for the two stores, so `lib.rs` can wire them PRE-install (ST-7).
    ///
    /// Appends two initializers — one per store — to the [`PgSchemaInit`]
    /// registry: `chat_rows` / `tool_use_rows` / `agent_session_rows`
    /// ([`ensure_rtdb_rows_schema_on_pg`]) and `telemetry_spans` /
    /// `telemetry_logs` / `telemetry_metrics` ([`ensure_telemetry_schema_on_pg`]).
    /// They run against the candidate pool BEFORE it is installed, so the six
    /// tables exist before any feature op. Like every registered initializer, a
    /// failure is fail-closed (the pool is never installed).
    pub fn register_slice3_pg_schema_inits(&self) {
        self.register_pg_schema_init(Arc::new(ensure_rtdb_rows_schema_on_pg));
        self.register_pg_schema_init(Arc::new(ensure_telemetry_schema_on_pg));
    }
}

// -- Engine status (Spec #2975, ST-2) -----------------------------------------

/// Serialize [`Dialect`] as its lowercase wire name (`"postgres"`), the shape
/// `storage_engine_status` exposes to the webview.
impl serde::Serialize for Dialect {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(match self {
            Dialect::Postgres => "postgres",
        })
    }
}

/// Read-only observable storage-engine status (the live hook for the fail-closed
/// seam). `engine` is the TARGET dialect (always `postgres` since CU-2);
/// `ready` is `true` only once the PostgreSQL pool is installed into the handle;
/// `fallback_reason` carries the structured failure when the leg failed and the
/// handle stayed `Pending` (R-1.4). There is no SQLite data-plane fallback.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageEngineStatus {
    /// The target engine's dialect (always PostgreSQL).
    pub engine: Dialect,
    /// `true` once the PostgreSQL pool is installed; `false` while the handle is
    /// `Pending` (pre-install or a fail-closed leg).
    pub ready: bool,
    /// Why the engine is not ready (the structured fail-closed reason), when it
    /// is not.
    pub fallback_reason: Option<String>,
}

/// A PostgreSQL schema initializer run against the **candidate** pool BEFORE it
/// is installed into the swap-once handle (Spec #2975 ST-2 rework).
///
/// Registered at startup in `lib.rs` (the feature-data metadata tables + the
/// terminal record table). `Fn` (not `FnMut`) so it can be cloned out of the
/// registry and run without holding the registry lock.
pub type PgSchemaInit = Arc<dyn Fn(&sqlx::PgPool) -> Result<()> + Send + Sync>;

/// Shared engine state handed to the supervisor's background pool build and
/// exposed by [`storage_engine_status`]: the swap-once handle, the resolved
/// selection, the fail-closed reason recorded when the engine stays on SQLite,
/// and the startup schema initializers run on the candidate pool pre-install.
pub struct StorageEngineState {
    handle: Arc<EngineHandle>,
    choice: EngineChoice,
    fallback_reason: Mutex<Option<String>>,
    schema_inits: Mutex<Vec<PgSchemaInit>>,
    /// The exclusive pre-install migration barrier (Spec #2977 ST-4). Held by
    /// the migration leg across snapshot → copy → parity → install; writers
    /// quiesce through [`Self::migration_gate`].
    migration_gate: Arc<MigrationGate>,
    /// The last migration outcome, for the read-only `migration_status` hook.
    migration_outcome: Mutex<Option<MigrationOutcome>>,
}

impl StorageEngineState {
    /// Wrap the handle + the resolved selection and share it as Tauri state.
    pub fn new(handle: Arc<EngineHandle>, choice: EngineChoice) -> Arc<Self> {
        Arc::new(Self {
            handle,
            choice,
            fallback_reason: Mutex::new(None),
            schema_inits: Mutex::new(Vec::new()),
            migration_gate: MigrationGate::new(),
            migration_outcome: Mutex::new(None),
        })
    }

    /// Register a schema initializer to run against the candidate pool BEFORE
    /// the engine is installed. Populated at startup so the full startup schema
    /// set exists on PostgreSQL before any feature operation.
    pub fn register_pg_schema_init(&self, init: PgSchemaInit) {
        lock(&self.schema_inits).push(init);
    }

    /// Run every registered initializer against `pool`, in registration order.
    /// The FIRST error wins and stops the run, so the caller installs NOTHING
    /// (fail-closed). The registry lock is released before any initializer runs.
    pub fn run_pg_schema_inits(&self, pool: &sqlx::PgPool) -> Result<()> {
        let inits: Vec<PgSchemaInit> = lock(&self.schema_inits).clone();
        for init in inits {
            init(pool)?;
        }
        Ok(())
    }

    /// Test-only: the number of registered initializers, so a pin can assert
    /// registration without a live PostgreSQL server.
    #[cfg(test)]
    pub(crate) fn schema_init_count(&self) -> usize {
        lock(&self.schema_inits).len()
    }

    /// The swap-once handle (cloned into the supervisor's pool build).
    pub fn handle(&self) -> Arc<EngineHandle> {
        Arc::clone(&self.handle)
    }

    /// The resolved engine selection (before the pool is ever built).
    pub fn choice(&self) -> EngineChoice {
        self.choice
    }

    /// Install the ONE PostgreSQL engine (first-wins on the swap-once handle).
    pub fn install_postgres(&self, pg: PgEngine) {
        self.handle.install(StoreEngine::Postgres(Arc::new(pg)));
    }

    /// Record why the engine stayed on SQLite. The FIRST reason wins, so the
    /// original failure is never masked by a later one.
    pub fn set_fallback_reason(&self, reason: String) {
        let mut guard = lock(&self.fallback_reason);
        if guard.is_none() {
            *guard = Some(reason);
        }
    }

    /// The recorded fail-closed reason, if any.
    pub fn fallback_reason(&self) -> Option<String> {
        lock(&self.fallback_reason).clone()
    }

    /// The read-only status snapshot. `ready` is derived from the swap-once
    /// handle: it is `true` only once the PostgreSQL pool is installed (R-1.4).
    pub fn status(&self) -> StorageEngineStatus {
        StorageEngineStatus {
            engine: Dialect::Postgres,
            ready: self.handle.engine().is_some(),
            fallback_reason: self.fallback_reason(),
        }
    }

    /// The ONE exclusive pre-install migration barrier (Spec #2977 ST-4).
    ///
    /// Writer call-sites (`writer_enter`) quiesce against it; the migration leg
    /// (`migration_enter`) holds it across snapshot → copy → parity → install.
    pub fn migration_gate(&self) -> Arc<MigrationGate> {
        Arc::clone(&self.migration_gate)
    }

    /// Record the terminal outcome of the last migration leg (first-write is not
    /// enforced — the supervisor runs the leg at most once per boot).
    pub fn record_migration_outcome(&self, outcome: MigrationOutcome) {
        *lock(&self.migration_outcome) = Some(outcome);
    }

    /// The read-only migration status view (derived from the recorded outcome).
    pub fn migration_status_view(&self) -> MigrationStatusView {
        match lock(&self.migration_outcome).as_ref() {
            Some(outcome) => MigrationStatusView {
                status: outcome.status,
                tables: outcome.tables.clone(),
                snapshot_path: outcome
                    .snapshot
                    .as_ref()
                    .map(|snapshot| snapshot.path.display().to_string()),
                completed: outcome.completed(),
            },
            None => MigrationStatusView::default(),
        }
    }
}

/// The live-observable engine-status hook (read-only, no state mutation).
#[tauri::command]
pub async fn storage_engine_status(app: tauri::AppHandle) -> StorageEngineStatus {
    use tauri::Manager as _;
    match app.try_state::<Arc<StorageEngineState>>() {
        Some(state) => state.status(),
        None => StorageEngineStatus {
            engine: Dialect::Postgres,
            ready: false,
            fallback_reason: None,
        },
    }
}

// -- Tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::storage::migration::MigrationStatus;

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
        let pg = StoreEngine::Postgres(Arc::new(make_pg_engine(
            "postgres://postgres:secret@127.0.0.1:5432/fredo",
        )));
        assert_eq!(pg.dialect(), Dialect::Postgres);
        assert!(!pg.pg_pool().is_closed());
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
    fn resolve_engine_choice_env_postgres_overrides_kv() {
        // The `postgres` env override is authoritative over any KV value.
        assert_eq!(
            resolve_engine_choice(Some("postgres"), Some("false")),
            EngineChoice::Postgres
        );
    }

    #[test]
    fn resolve_engine_choice_defaults_to_postgres() {
        // The CU-1 flip: absent env + absent/`true` KV => PostgreSQL.
        assert_eq!(resolve_engine_choice(None, None), EngineChoice::Postgres);
        assert_eq!(
            resolve_engine_choice(None, Some("true")),
            EngineChoice::Postgres
        );
        assert_eq!(
            resolve_engine_choice(None, Some("")),
            EngineChoice::Postgres
        );
    }

    #[test]
    fn resolve_engine_choice_treats_the_kv_opt_out_as_inert() {
        // CU-1-R2: a carried `postgres.enabled=false` must NOT select a SQLite
        // data plane (there is none) — it is inert and PostgreSQL is unconditional.
        assert_eq!(
            resolve_engine_choice(None, Some("false")),
            EngineChoice::Postgres
        );
        assert_eq!(
            resolve_engine_choice(None, Some("FALSE")),
            EngineChoice::Postgres
        );
        assert_eq!(
            resolve_engine_choice(None, Some("False")),
            EngineChoice::Postgres
        );
    }

    #[test]
    fn resolve_engine_choice_rejects_the_sqlite_env_value() {
        // `sqlite` is removed as a data-plane selection (CU-1): inert/rejected,
        // so it can never select SQLite — even alongside an opt-out KV.
        assert_eq!(
            resolve_engine_choice(Some("sqlite"), None),
            EngineChoice::Postgres
        );
        assert_eq!(
            resolve_engine_choice(Some("sqlite"), Some("false")),
            EngineChoice::Postgres
        );
        assert_eq!(
            resolve_engine_choice(Some("SQLITE"), Some("true")),
            EngineChoice::Postgres
        );
    }

    #[test]
    fn resolve_engine_choice_is_unconditionally_postgres_cu1_r2() {
        // The CU-1-R2 acceptance set: every combination — including a carried
        // `postgres.enabled=false` — resolves to PostgreSQL.
        assert_eq!(
            resolve_engine_choice(None, Some("false")),
            EngineChoice::Postgres
        );
        assert_eq!(
            resolve_engine_choice(None, Some("true")),
            EngineChoice::Postgres
        );
        assert_eq!(resolve_engine_choice(None, None), EngineChoice::Postgres);
        assert_eq!(
            resolve_engine_choice(Some("sqlite"), Some("false")),
            EngineChoice::Postgres
        );
        assert_eq!(
            resolve_engine_choice(Some("postgres"), Some("false")),
            EngineChoice::Postgres
        );
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
            EngineChoice::Postgres
        );
        // A blank/unknown env still leaves the inert opt-out inert.
        assert_eq!(
            resolve_engine_choice(Some("bogus"), Some("false")),
            EngineChoice::Postgres
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
        assert_eq!(
            resolve_engine_choice(None, Some("False")),
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
    fn select_engine_env_sqlite_is_inert() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _env = set_env(STORAGE_ENGINE_ENV, "sqlite");
        let dir = tempfile::tempdir().unwrap();
        let engine = make_sqlite_engine(dir.path());
        seed_kv(&engine, PG_ENABLED_KEY, "true");
        assert_eq!(select_engine(&engine), EngineChoice::Postgres);
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
    fn select_engine_defaults_to_postgres_when_nothing_is_set() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _env = unset_env(STORAGE_ENGINE_ENV);
        let dir = tempfile::tempdir().unwrap();
        // No `settings` table at all -> absent KV -> PostgreSQL (CU-1 default).
        let engine = make_sqlite_engine(dir.path());
        assert_eq!(select_engine(&engine), EngineChoice::Postgres);
    }

    #[test]
    fn select_engine_treats_the_seeded_kv_opt_out_as_inert() {
        // CU-1-R2: the exact upgraded-install artifact (a `postgres.enabled=false`
        // control row carried out of `fredo.db`) must resolve to PostgreSQL, not
        // a (non-existent) SQLite data plane.
        let _lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _env = unset_env(STORAGE_ENGINE_ENV);
        let dir = tempfile::tempdir().unwrap();
        let engine = make_sqlite_engine(dir.path());
        seed_kv(&engine, PG_ENABLED_KEY, "false");
        assert_eq!(select_engine(&engine), EngineChoice::Postgres);
    }

    // -- swap-once handle -----------------------------------------------------

    #[tokio::test]
    async fn engine_handle_starts_pending_and_fails_closed() {
        let handle = EngineHandle::new_pending();
        assert!(handle.engine().is_none(), "the handle starts pending");
        // R-3.2: a data-plane op with no engine must fail closed with a
        // structured error — never serve from SQLite.
        let error = handle.pg().err().expect("pending handle must fail closed");
        assert!(error.to_string().contains("engine not ready"), "{error}");
    }

    #[tokio::test]
    async fn engine_handle_installs_postgres_at_most_once() {
        let handle = EngineHandle::new_pending();

        // First install: Pending -> Postgres.
        let first_url = "postgres://postgres:secret@127.0.0.1:5432/fredo_first";
        handle.install(StoreEngine::Postgres(Arc::new(make_pg_engine(first_url))));
        let installed = handle.engine().expect("installed");
        assert_eq!(installed.dialect(), Dialect::Postgres);
        let StoreEngine::Postgres(pg) = installed.as_ref();
        assert_eq!(pg.url, first_url);

        // Second install is a no-op (first-wins).
        let second_url = "postgres://postgres:secret@127.0.0.1:5432/fredo_second";
        handle.install(StoreEngine::Postgres(Arc::new(make_pg_engine(second_url))));
        let StoreEngine::Postgres(pg) = handle.engine().expect("installed").as_ref().clone();
        assert_eq!(pg.url, first_url, "install must run at most once");
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

    // -- ST-2: pool-build fault seam -----------------------------------------

    #[test]
    fn pg_pool_stage_parse_maps_the_fault_seam_values() {
        assert_eq!(PgPoolStage::parse(""), None);
        assert_eq!(PgPoolStage::parse("   "), None);
        assert_eq!(PgPoolStage::parse("1"), Some(PgPoolStage::Connect));
        assert_eq!(PgPoolStage::parse("true"), Some(PgPoolStage::Connect));
        assert_eq!(PgPoolStage::parse("connect"), Some(PgPoolStage::Connect));
        assert_eq!(PgPoolStage::parse("Connect"), Some(PgPoolStage::Connect));
        assert_eq!(
            PgPoolStage::parse("schemaInit"),
            Some(PgPoolStage::SchemaInit)
        );
        assert_eq!(
            PgPoolStage::parse("schema_init"),
            Some(PgPoolStage::SchemaInit)
        );
        // An unrecognized non-blank value still forces a failure (at connect).
        assert_eq!(PgPoolStage::parse("bogus"), Some(PgPoolStage::Connect));
    }

    #[tokio::test]
    async fn build_pg_pool_forced_connect_failure_returns_err_without_connecting() {
        // Port 1 is never dialled: the FS-4 seam fails BEFORE any network attempt,
        // so this is bounded and deterministic without a live server.
        let result =
            build_pg_pool("postgres://postgres:pw@127.0.0.1:1/none", Some(PgPoolStage::Connect))
                .await;
        assert!(result.is_err(), "the FS-4 seam must fail the build");
        let error = result.err().expect("error");
        let text = error.to_string();
        assert!(text.contains("[pool:connect]"), "{text}");
        assert!(text.contains("FS-4"), "{text}");
    }

    // -- ST-2: engine status --------------------------------------------------

    #[test]
    fn storage_engine_state_starts_on_postgres_without_a_fallback_reason() {
        let handle = EngineHandle::new_pending();
        let state = StorageEngineState::new(handle, EngineChoice::Postgres);
        let status = state.status();
        assert_eq!(status.engine, Dialect::Postgres);
        assert!(
            !status.ready,
            "the handle starts Pending, so the engine is not ready"
        );
        assert_eq!(status.fallback_reason, None);
    }

    #[test]
    fn storage_engine_state_keeps_the_first_fallback_reason() {
        let handle = EngineHandle::new_pending();
        let state = StorageEngineState::new(handle, EngineChoice::Postgres);
        state.set_fallback_reason("[pool:connect] forced".to_string());
        state.set_fallback_reason("[start] later".to_string());
        assert_eq!(
            state.status().fallback_reason.as_deref(),
            Some("[pool:connect] forced"),
            "the FIRST failure reason must survive"
        );
        // A failed build leaves the handle pending and not ready (fail-closed).
        assert!(state.handle().engine().is_none());
        assert!(!state.status().ready);
    }

    #[tokio::test]
    async fn storage_engine_state_installs_postgres_once() {
        let handle = EngineHandle::new_pending();
        let state = StorageEngineState::new(handle, EngineChoice::Postgres);
        state.install_postgres(make_pg_engine("postgres://postgres:secret@127.0.0.1:5432/fredo"));
        assert_eq!(state.status().engine, Dialect::Postgres);
        assert!(state.status().ready, "an installed pool is ready");
        // A second install is a no-op (first-wins on the swap-once handle).
        state.install_postgres(make_pg_engine("postgres://postgres:secret@127.0.0.1:5432/other"));
        assert_eq!(state.status().engine, Dialect::Postgres);
        assert!(state.status().ready);
    }

    /// CU-3 (R-1.4): a failed cutover leg records `Failed`, installs NOTHING (the
    /// handle stays `Pending`), and reports `ready:false` + the structured reason.
    #[test]
    fn failed_migration_reports_not_ready_and_installs_nothing() {
        let handle = EngineHandle::new_pending();
        let state = StorageEngineState::new(handle, EngineChoice::Postgres);
        state.record_migration_outcome(MigrationOutcome {
            status: MigrationStatus::Failed,
            tables: Vec::new(),
            snapshot: None,
            elapsed_ms: 7,
        });
        state.set_fallback_reason("[migration] parity mismatch on 'settings'".to_string());

        let status = state.status();
        assert_eq!(status.engine, Dialect::Postgres);
        assert!(!status.ready, "a fail-closed leg must report not-ready");
        assert_eq!(
            status.fallback_reason.as_deref(),
            Some("[migration] parity mismatch on 'settings'")
        );
        let view = state.migration_status_view();
        assert_eq!(view.status, MigrationStatus::Failed);
        assert!(!view.completed, "a failed leg is not completed");
        assert!(
            state.handle().engine().is_none(),
            "no partially-migrated engine may be installed"
        );
    }

    /// CU-3 (R-1.1/R-4.1): a fresh install (no source) is `Fresh`, counts as
    /// completed, and installs PostgreSQL normally.
    #[tokio::test]
    async fn fresh_migration_reports_completed_and_installs_normally() {
        let handle = EngineHandle::new_pending();
        let state = StorageEngineState::new(handle, EngineChoice::Postgres);
        state.record_migration_outcome(MigrationOutcome {
            status: MigrationStatus::Fresh,
            tables: Vec::new(),
            snapshot: None,
            elapsed_ms: 0,
        });
        assert!(
            state.migration_status_view().completed,
            "a fresh install is authoritative on PostgreSQL"
        );
        // The supervisor installs on the `Fresh` Ok path (R-1.1).
        state.install_postgres(make_pg_engine("postgres://postgres:secret@127.0.0.1:5432/fresh"));
        let status = state.status();
        assert!(status.ready);
        assert_eq!(status.fallback_reason, None);
    }

    // -- ST-2 rework: startup schema-init registry ----------------------------

    #[tokio::test]
    async fn run_pg_schema_inits_runs_every_initializer_in_order() {
        let handle = EngineHandle::new_pending();
        let state = StorageEngineState::new(handle, EngineChoice::Postgres);

        // A fresh registry is empty: running it is a no-op.
        let pg = make_pg_engine("postgres://postgres:secret@127.0.0.1:5432/fredo");
        state.run_pg_schema_inits(&pg.pool).unwrap();

        let order = Arc::new(Mutex::new(Vec::<u8>::new()));
        let first = Arc::clone(&order);
        state.register_pg_schema_init(Arc::new(move |_pool| {
            first.lock().unwrap().push(1);
            Ok(())
        }));
        let second = Arc::clone(&order);
        state.register_pg_schema_init(Arc::new(move |_pool| {
            second.lock().unwrap().push(2);
            Ok(())
        }));

        state.run_pg_schema_inits(&pg.pool).unwrap();
        assert_eq!(*order.lock().unwrap(), vec![1, 2], "registration order");
        // The registry is retained: a re-run executes every initializer again.
        state.run_pg_schema_inits(&pg.pool).unwrap();
        assert_eq!(*order.lock().unwrap(), vec![1, 2, 1, 2]);
    }

    #[tokio::test]
    async fn run_pg_schema_inits_stops_at_the_first_error() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let handle = EngineHandle::new_pending();
        let state = StorageEngineState::new(handle, EngineChoice::Postgres);

        state.register_pg_schema_init(Arc::new(|_pool| Err(anyhow::anyhow!("[init] boom"))));
        let ran = Arc::new(AtomicBool::new(false));
        let trailing = Arc::clone(&ran);
        state.register_pg_schema_init(Arc::new(move |_pool| {
            trailing.store(true, Ordering::SeqCst);
            Ok(())
        }));

        let pg = make_pg_engine("postgres://postgres:secret@127.0.0.1:5432/fredo");
        let error = state.run_pg_schema_inits(&pg.pool).unwrap_err();
        assert!(error.to_string().contains("[init] boom"), "{error}");
        assert!(
            !ran.load(Ordering::SeqCst),
            "an initializer after the first error must not run"
        );
    }

    #[test]
    fn storage_engine_status_serializes_camel_case_with_lowercase_dialect() {
        let status = StorageEngineStatus {
            engine: Dialect::Postgres,
            ready: false,
            fallback_reason: Some("[pool:connect] forced".to_string()),
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["engine"], "postgres");
        assert_eq!(json["ready"], false);
        assert_eq!(json["fallbackReason"], "[pool:connect] forced");
        assert_eq!(
            serde_json::to_value(Dialect::Postgres).unwrap(),
            serde_json::json!("postgres")
        );
    }

    // -- ST-1: read-only canonical seam ---------------------------------------

    #[tokio::test]
    async fn canonical_reader_and_pg_pool_follow_the_active_engine() {
        let engine = StoreEngine::Postgres(Arc::new(make_pg_engine(
            "postgres://postgres:secret@127.0.0.1:5432/fredo",
        )));
        match engine.canonical_reader().expect("a postgres reader") {
            CanonicalReader::Postgres(pool) => assert!(!pool.is_closed()),
        }
        assert!(!engine.pg_pool().is_closed());
    }

    #[tokio::test]
    async fn begin_read_only_fails_closed_on_an_unreachable_pool() {
        let pg = make_pg_engine("postgres://postgres:pw@127.0.0.1:1/none");
        let error = begin_read_only(&pg.pool).await.err().expect("must fail");
        assert!(error.to_string().contains("[pg:read-only]"), "{error}");
    }

    // -- ST-1: six-table PostgreSQL schema init -------------------------------

    #[test]
    fn slice3_pg_ddl_declares_the_six_tables_one_to_one() {
        for table in ["chat_rows", "tool_use_rows", "agent_session_rows"] {
            assert!(
                PG_RTDB_ROWS_DDL.contains(&format!("CREATE TABLE IF NOT EXISTS {table}")),
                "missing {table}"
            );
        }
        for table in ["telemetry_spans", "telemetry_logs", "telemetry_metrics"] {
            assert!(
                PG_TELEMETRY_DDL.contains(&format!("CREATE TABLE IF NOT EXISTS {table}")),
                "missing {table}"
            );
        }
        assert!(PG_RTDB_ROWS_DDL.contains("PRIMARY KEY (session_id, correlation_id)"));
        assert!(PG_RTDB_ROWS_DDL.contains("DEFAULT 'unknown'"));
        assert!(PG_TELEMETRY_DDL.contains("TEXT PRIMARY KEY"));
        assert!(PG_TELEMETRY_DDL.contains("DOUBLE PRECISION"));
        assert!(PG_TELEMETRY_DDL.contains("WHERE status_code = 'ERROR'"));
        assert_eq!(
            PG_TELEMETRY_DDL.matches("GENERATED ALWAYS AS IDENTITY").count(),
            2,
            "telemetry_logs.id and telemetry_metrics.id are the identity columns"
        );
    }

    #[test]
    fn register_slice3_pg_schema_inits_registers_one_init_per_store() {
        let handle = EngineHandle::new_pending();
        let state = StorageEngineState::new(handle, EngineChoice::Postgres);
        assert_eq!(state.schema_init_count(), 0);
        state.register_slice3_pg_schema_inits();
        assert_eq!(
            state.schema_init_count(),
            2,
            "one initializer per store (RtdbStore + SpanStore)"
        );
    }

    #[test]
    fn persistent_statement_knobs_cover_the_nine_hot_statements() {
        assert_eq!(PG_PERSISTENT_STATEMENTS.len(), 9);
        for kind in [
            "chat_rows_upsert",
            "tool_use_rows_upsert",
            "agent_session_rows_upsert",
        ] {
            assert!(PG_PERSISTENT_STATEMENTS.contains(&kind), "{kind}");
        }
        assert!(PG_PERSISTENT_STATEMENTS.contains(&"max_seq"));
        assert_eq!(
            PG_PERSISTENT_STATEMENTS
                .iter()
                .filter(|s| s.starts_with("prune_"))
                .count(),
            2,
            "the two prune DELETE ... RETURNING forms"
        );
    }
}
