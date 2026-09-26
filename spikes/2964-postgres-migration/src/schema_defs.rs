//! The SQLite DDL and its PostgreSQL translation, held **in lockstep**.
//!
//! Source of truth (production, read-only reference — never modified):
//!
//! * `chat_rows`  — `apps/tauri/src-tauri/src/infrastructure/rtdb/store.rs:310-336`
//!   (18 columns, composite PK `(session_id, correlation_id)`, three indexes)
//! * `settings`   — `apps/tauri/src-tauri/src/infrastructure/storage/mod.rs:23-26`
//!   (`key TEXT PRIMARY KEY`, `value TEXT NOT NULL`)
//! * batch upsert — `rtdb/store.rs:424-429` (`INSERT OR REPLACE`)
//! * settings upsert — `storage/mod.rs:48-50` (`ON CONFLICT(key) DO UPDATE ... excluded.value`)
//!
//! Binding C1 mapping rule (from the #2964 plan):
//!
//! ```text
//! TEXT -> TEXT ; INTEGER -> BIGINT ; REAL -> DOUBLE PRECISION ; BLOB -> BYTEA
//! INTEGER PRIMARY KEY AUTOINCREMENT -> BIGINT GENERATED ALWAYS AS IDENTITY
//! INSERT OR REPLACE ...   -> INSERT ... ON CONFLICT(<pk>) DO UPDATE SET c=EXCLUDED.c
//! INSERT OR IGNORE ...    -> INSERT ... ON CONFLICT(<pk>) DO NOTHING
//! excluded.c              -> EXCLUDED.c
//! ?n                      -> $n
//! composite PK (a,b)      -> PRIMARY KEY (a,b)               (1:1)
//! ```
//!
//! Every pair below is verified against a real PostgreSQL client by the `schema`
//! binary; the SQLite leg is executed locally (in-memory) so the two write paths
//! can be compared for byte-equivalent final state.

/// SQLite DDL — byte-for-byte the production `chat_rows` columns/PK/indexes plus
/// the AppStore `settings` KV. Used to build the in-memory SQLite reference.
pub const SQLITE_DDL: &str = "\
CREATE TABLE IF NOT EXISTS chat_rows (
    session_id                  TEXT NOT NULL,
    correlation_id              TEXT NOT NULL,
    seq                         INTEGER NOT NULL,
    started_at_ns               INTEGER,
    ended_at_ns                 INTEGER,
    updated_at                  TEXT NOT NULL,
    state                       TEXT NOT NULL,
    user_message                TEXT,
    agent_reply                 TEXT,
    prompt_tokens               INTEGER,
    completion_tokens           INTEGER,
    cache_read_tokens           INTEGER,
    cost_usd                    REAL,
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
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);";

/// PostgreSQL DDL — the same table/columns/indexes as [`SQLITE_DDL`], type-mapped
/// (`INTEGER -> BIGINT`, `REAL -> DOUBLE PRECISION`), same composite PK and the
/// same three indexes (1:1).
pub const PG_DDL: &str = "\
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
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);";

/// Mapping-rule probe: `INTEGER PRIMARY KEY AUTOINCREMENT` →
/// `BIGINT GENERATED ALWAYS AS IDENTITY`. Production uses AUTOINCREMENT for
/// `telemetry_logs.id` / `telemetry_metrics.id` (`infrastructure/storage/span_store.rs:104`).
pub const IDENTITY_PROBE_DDL: &str = "\
CREATE TABLE IF NOT EXISTS identity_probe (
    id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    label TEXT NOT NULL
);";

/// Column list shared by both engines' INSERT/SELECT (order matters).
pub const CHAT_COLUMNS: &str = "session_id, correlation_id, seq, started_at_ns, ended_at_ns, \
updated_at, state, user_message, agent_reply, prompt_tokens, completion_tokens, \
cache_read_tokens, cost_usd, model, parent_session_id, composited_child_session_id, \
raw_json, provider";

/// Number of columns above.
pub const CHAT_COLUMN_COUNT: usize = 18;

/// `(column_name, information_schema data_type)` expected on the PG table —
/// the C1 type mapping applied to the production SQLite DDL.
pub const PG_CHAT_COLUMNS_EXPECTED: &[(&str, &str)] = &[
    ("session_id", "text"),
    ("correlation_id", "text"),
    ("seq", "bigint"),
    ("started_at_ns", "bigint"),
    ("ended_at_ns", "bigint"),
    ("updated_at", "text"),
    ("state", "text"),
    ("user_message", "text"),
    ("agent_reply", "text"),
    ("prompt_tokens", "bigint"),
    ("completion_tokens", "bigint"),
    ("cache_read_tokens", "bigint"),
    ("cost_usd", "double precision"),
    ("model", "text"),
    ("parent_session_id", "text"),
    ("composited_child_session_id", "text"),
    ("raw_json", "text"),
    ("provider", "text"),
];

/// Production batch upsert (`rtdb/store.rs:424-429`): full-row `INSERT OR REPLACE`
/// on the composite PK, 18 positional params.
pub const SQLITE_UPSERT_CHAT: &str = "\
INSERT OR REPLACE INTO chat_rows
 (session_id, correlation_id, seq, started_at_ns, ended_at_ns, updated_at, state,
  user_message, agent_reply, prompt_tokens, completion_tokens, cache_read_tokens,
  cost_usd, model, parent_session_id, composited_child_session_id, raw_json, provider)
 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)";

/// PG translation of [`SQLITE_UPSERT_CHAT`]: `?n -> $n`,
/// `INSERT OR REPLACE -> INSERT ... ON CONFLICT DO UPDATE ... EXCLUDED`.
pub const PG_UPSERT_CHAT: &str = "\
INSERT INTO chat_rows
 (session_id, correlation_id, seq, started_at_ns, ended_at_ns, updated_at, state,
  user_message, agent_reply, prompt_tokens, completion_tokens, cache_read_tokens,
  cost_usd, model, parent_session_id, composited_child_session_id, raw_json, provider)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
 ON CONFLICT(session_id, correlation_id) DO UPDATE SET
  seq=EXCLUDED.seq, started_at_ns=EXCLUDED.started_at_ns, ended_at_ns=EXCLUDED.ended_at_ns,
  updated_at=EXCLUDED.updated_at, state=EXCLUDED.state, user_message=EXCLUDED.user_message,
  agent_reply=EXCLUDED.agent_reply, prompt_tokens=EXCLUDED.prompt_tokens,
  completion_tokens=EXCLUDED.completion_tokens, cache_read_tokens=EXCLUDED.cache_read_tokens,
  cost_usd=EXCLUDED.cost_usd, model=EXCLUDED.model,
  parent_session_id=EXCLUDED.parent_session_id,
  composited_child_session_id=EXCLUDED.composited_child_session_id,
  raw_json=EXCLUDED.raw_json, provider=EXCLUDED.provider";

/// SQLite point read by composite PK.
pub const SQLITE_POINT_READ: &str =
    "SELECT raw_json FROM chat_rows WHERE session_id = ?1 AND correlation_id = ?2";

/// PG point read by composite PK.
pub const PG_POINT_READ: &str =
    "SELECT raw_json FROM chat_rows WHERE session_id = $1 AND correlation_id = $2";

/// SQLite range read by `started_at_ns` (MIN/MAX probe → count + token sum).
pub const SQLITE_RANGE_READ: &str = "SELECT count(*), coalesce(sum(prompt_tokens), 0) \
FROM chat_rows WHERE started_at_ns >= ?1 AND started_at_ns < ?2";

/// PG range read. `sum(bigint)` yields `numeric`, so the translated statement
/// casts back to `bigint` to keep the read shape identical to SQLite.
pub const PG_RANGE_READ: &str = "SELECT count(*)::bigint, coalesce(sum(prompt_tokens), 0)::bigint \
FROM chat_rows WHERE started_at_ns >= $1 AND started_at_ns < $2";

/// Production settings upsert (`storage/mod.rs:48-50`).
pub const SQLITE_SETTINGS_UPSERT: &str = "\
INSERT INTO settings (key, value) VALUES (?1, ?2)
 ON CONFLICT(key) DO UPDATE SET value = excluded.value";

/// PG translation of [`SQLITE_SETTINGS_UPSERT`] (`excluded` → `EXCLUDED`, `?n` → `$n`).
pub const PG_SETTINGS_UPSERT: &str = "\
INSERT INTO settings (key, value) VALUES ($1, $2)
 ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value";

/// `INSERT OR IGNORE` probe (SQLite side), mapped 1:1 from `feature_store.rs:295`.
pub const SQLITE_SETTINGS_INSERT_IGNORE: &str =
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)";

/// `INSERT OR IGNORE` translation (PG side): `ON CONFLICT(<pk>) DO NOTHING`.
pub const PG_SETTINGS_INSERT_IGNORE: &str =
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING";

/// Read-only guard translation probe: `PRAGMA query_only=ON` →
/// `START TRANSACTION READ ONLY`.
pub const PG_READ_ONLY_BEGIN: &str = "START TRANSACTION READ ONLY";
pub const SQLITE_QUERY_ONLY: &str = "PRAGMA query_only=ON";
