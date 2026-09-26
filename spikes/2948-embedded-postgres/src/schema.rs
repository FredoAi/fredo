//! Representative schema parity.
//!
//! The SQLite DDL is copied from Fredo's production `chat_rows` table
//! (`apps/tauri/src-tauri/src/infrastructure/rtdb/store.rs:310-336`) plus the
//! AppStore KV (`infrastructure/storage/mod.rs:23-26`). The PostgreSQL DDL is a
//! 1:1 type mapping of the same table:
//!
//!   TEXT             -> TEXT
//!   INTEGER          -> BIGINT
//!   REAL             -> DOUBLE PRECISION
//!   composite PK     -> (session_id, correlation_id)
//!   same indexes     -> same indexes
//!
//! Keep the two DDLs in lockstep: this is the parity the spike compares.

/// SQLite DDL — byte-for-byte equivalent to the production `chat_rows` DDL
/// (column names/types/PK/indexes) plus the `settings` KV table.
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

/// PostgreSQL DDL — the same table/columns/indexes as `SQLITE_DDL`, type-mapped
/// (INTEGER -> BIGINT, REAL -> DOUBLE PRECISION).
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

/// Column list shared by the INSERT statements of both variants (order matters).
pub const CHAT_COLUMNS: &str = "session_id, correlation_id, seq, started_at_ns, ended_at_ns, \
updated_at, state, user_message, agent_reply, prompt_tokens, completion_tokens, \
cache_read_tokens, cost_usd, model, parent_session_id, composited_child_session_id, \
raw_json, provider";

/// Number of the columns above (SELECT list order for the read-back checks).
pub const CHAT_COLUMN_COUNT: usize = 18;

/// SQLite batch upsert (18 positional params).
pub const SQLITE_UPSERT: &str = "\
INSERT INTO chat_rows (session_id, correlation_id, seq, started_at_ns, ended_at_ns, \
updated_at, state, user_message, agent_reply, prompt_tokens, completion_tokens, \
cache_read_tokens, cost_usd, model, parent_session_id, composited_child_session_id, \
raw_json, provider) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18) \
ON CONFLICT(session_id, correlation_id) DO UPDATE SET \
seq=excluded.seq, started_at_ns=excluded.started_at_ns, ended_at_ns=excluded.ended_at_ns, \
updated_at=excluded.updated_at, state=excluded.state, user_message=excluded.user_message, \
agent_reply=excluded.agent_reply, prompt_tokens=excluded.prompt_tokens, \
completion_tokens=excluded.completion_tokens, cache_read_tokens=excluded.cache_read_tokens, \
cost_usd=excluded.cost_usd, model=excluded.model, \
parent_session_id=excluded.parent_session_id, \
composited_child_session_id=excluded.composited_child_session_id, \
raw_json=excluded.raw_json, provider=excluded.provider";

/// PostgreSQL batch upsert (18 positional params).
pub const PG_UPSERT: &str = "\
INSERT INTO chat_rows (session_id, correlation_id, seq, started_at_ns, ended_at_ns, \
updated_at, state, user_message, agent_reply, prompt_tokens, completion_tokens, \
cache_read_tokens, cost_usd, model, parent_session_id, composited_child_session_id, \
raw_json, provider) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) \
ON CONFLICT(session_id, correlation_id) DO UPDATE SET \
seq=EXCLUDED.seq, started_at_ns=EXCLUDED.started_at_ns, ended_at_ns=EXCLUDED.ended_at_ns, \
updated_at=EXCLUDED.updated_at, state=EXCLUDED.state, user_message=EXCLUDED.user_message, \
agent_reply=EXCLUDED.agent_reply, prompt_tokens=EXCLUDED.prompt_tokens, \
completion_tokens=EXCLUDED.completion_tokens, cache_read_tokens=EXCLUDED.cache_read_tokens, \
cost_usd=EXCLUDED.cost_usd, model=EXCLUDED.model, \
parent_session_id=EXCLUDED.parent_session_id, \
composited_child_session_id=EXCLUDED.composited_child_session_id, \
raw_json=EXCLUDED.raw_json, provider=EXCLUDED.provider";

/// SQLite point read by PK.
pub const SQLITE_POINT_READ: &str =
    "SELECT raw_json FROM chat_rows WHERE session_id = ?1 AND correlation_id = ?2";

/// PostgreSQL point read by PK.
pub const PG_POINT_READ: &str =
    "SELECT raw_json FROM chat_rows WHERE session_id = $1 AND correlation_id = $2";

/// SQLite range read by `started_at_ns`.
pub const SQLITE_RANGE_READ: &str =
    "SELECT count(*), coalesce(sum(prompt_tokens), 0) FROM chat_rows \
     WHERE started_at_ns >= ?1 AND started_at_ns < ?2";

/// PostgreSQL range read by `started_at_ns`.
pub const PG_RANGE_READ: &str = "\
SELECT count(*), coalesce(sum(prompt_tokens), 0) FROM chat_rows \
WHERE started_at_ns >= $1 AND started_at_ns < $2";
