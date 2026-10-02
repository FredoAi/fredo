//! Persisted Terminal session records (Spec #2935 ST-2).
//!
//! Each spawned Terminal session is recorded in `fredo.db` as a
//! [`FeatureStore`] table (`feature_terminal_sessions`, feature id `terminal`)
//! so it survives a window close and an app restart and can be offered for
//! resume. The record carries **only** identity + timing + the optional
//! CLI-native session id — never credentials, launch args, environment, or
//! transcripts (NFR).
//!
//! The table is written directly from this module (the backend-owned path);
//! the record columns are exactly
//! `{id, cli, work_dir, title, created_at, last_active_at, cli_session_id}`.

use anyhow::Result;
use serde_json::{json, Map, Value};

use crate::features::terminal::state::SessionKind;
use crate::infrastructure::storage::feature_store::{ColumnDef, ColumnType, FeatureStore};

/// The owning feature namespace (`feature_terminal_sessions`).
pub const FEATURE_ID: &str = "terminal";
/// The table within the feature namespace.
pub const TABLE_NAME: &str = "sessions";
/// Bounded retention: the newest `MAX_RECORDS` by `last_active_at` are kept;
/// older records are evicted after each insert so the list cannot grow without
/// bound.
pub const MAX_RECORDS: usize = 100;

/// One persisted Terminal session record.
///
/// This is BOTH the storage mapping and the UI wire record (`list_persisted_terminal_sessions`
/// / `terminal-persisted-sessions-changed`) — serde `camelCase` on the wire,
/// snake_case columns in SQLite.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSession {
    /// Fredo record id (uuid v4); stable across restarts. A resume REUSES it as
    /// the live session id, so one logical session is exactly one record.
    pub id: String,
    pub cli: SessionKind,
    pub work_dir: String,
    /// Stable identity ("OpenCode", "OpenCode 2", "GitHub Copilot") minted once
    /// at creation — never re-derived, so ordinals do not renumber on restart.
    pub title: String,
    /// Epoch milliseconds.
    pub created_at: u64,
    /// Epoch milliseconds; refreshed on window close, session close, and self-exit.
    pub last_active_at: u64,
    /// The CLI-native session id when it could be captured (OpenCode listing
    /// surface); `None` otherwise.
    pub cli_session_id: Option<String>,
}

impl PersistedSession {
    /// Column definitions for `FeatureStore::ensure_table` (TEXT/INTEGER only).
    pub fn columns() -> Vec<ColumnDef> {
        vec![
            column("id", ColumnType::TEXT, false, true),
            column("cli", ColumnType::TEXT, false, false),
            column("work_dir", ColumnType::TEXT, false, false),
            column("title", ColumnType::TEXT, false, false),
            column("created_at", ColumnType::INTEGER, false, false),
            column("last_active_at", ColumnType::INTEGER, false, false),
            column("cli_session_id", ColumnType::TEXT, true, false),
        ]
    }

    /// Project this record onto a `FeatureStore` row map.
    pub fn to_row(&self) -> Map<String, Value> {
        let mut row = Map::new();
        row.insert("id".into(), json!(self.id));
        row.insert("cli".into(), json!(self.cli.wire()));
        row.insert("work_dir".into(), json!(self.work_dir));
        row.insert("title".into(), json!(self.title));
        row.insert("created_at".into(), json!(self.created_at));
        row.insert("last_active_at".into(), json!(self.last_active_at));
        row.insert(
            "cli_session_id".into(),
            match &self.cli_session_id {
                Some(id) => json!(id),
                None => Value::Null,
            },
        );
        row
    }

    /// Parse a `FeatureStore` row map back into a record. Returns `None` for a
    /// malformed row (missing id/fields or an unknown `cli`).
    pub fn from_row(row: &Map<String, Value>) -> Option<Self> {
        Some(Self {
            id: row.get("id")?.as_str()?.to_string(),
            cli: SessionKind::parse(row.get("cli")?.as_str()?)?,
            work_dir: row.get("work_dir")?.as_str()?.to_string(),
            title: row.get("title")?.as_str()?.to_string(),
            created_at: row.get("created_at")?.as_u64()?,
            last_active_at: row.get("last_active_at")?.as_u64()?,
            cli_session_id: row
                .get("cli_session_id")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }
}

fn column(
    name: &str,
    col_type: ColumnType,
    nullable: bool,
    primary_key: bool,
) -> ColumnDef {
    ColumnDef {
        name: name.to_string(),
        col_type,
        nullable,
        primary_key,
    }
}

/// Create the record table if it does not exist (idempotent).
pub fn ensure_table(store: &FeatureStore) -> Result<()> {
    store.ensure_table(FEATURE_ID, TABLE_NAME, &PersistedSession::columns())
}

/// Create the record table on a PostgreSQL pool (idempotent) — the startup
/// schema-init registry entry (`lib.rs`), delegating to the ONE DDL-builder
/// source on [`FeatureStore`] so the terminal table exists on PostgreSQL before
/// any terminal operation (Spec #2975 ST-2 rework).
pub fn ensure_table_on_pg(pool: &sqlx::PgPool) -> Result<()> {
    FeatureStore::ensure_table_on_pg(pool, FEATURE_ID, TABLE_NAME, &PersistedSession::columns())
}

/// Every persisted record, newest `last_active_at` first.
pub fn list(store: &FeatureStore) -> Result<Vec<PersistedSession>> {
    let rows = store.query(
        FEATURE_ID,
        TABLE_NAME,
        None,
        Some("last_active_at DESC"),
        None,
    )?;
    Ok(rows
        .iter()
        .filter_map(PersistedSession::from_row)
        .collect())
}

/// One record by id.
pub fn get(store: &FeatureStore, id: &str) -> Result<Option<PersistedSession>> {
    let mut where_cols = Map::new();
    where_cols.insert("id".into(), json!(id));
    let rows = store.query(
        FEATURE_ID,
        TABLE_NAME,
        Some(&where_cols),
        None,
        Some(1),
    )?;
    Ok(rows.first().and_then(PersistedSession::from_row))
}

/// Insert a record, then evict the oldest beyond [`MAX_RECORDS`].
pub fn insert(store: &FeatureStore, record: &PersistedSession) -> Result<()> {
    // Spec #2977 ST-4: quiesce the write against the exclusive migration barrier.
    let _guard = store.writer_guard()?;
    store.insert(FEATURE_ID, TABLE_NAME, &[record.to_row()])?;
    // Already inside the guard above — no re-acquire (an exclusive barrier is
    // not re-entrant; a nested shared acquire could deadlock behind it).
    evict_oldest_beyond_max(store)?;
    Ok(())
}

/// Refresh a record's `last_active_at` (window close / session close / self-exit).
pub fn touch(store: &FeatureStore, id: &str, at: u64) -> Result<()> {
    // Spec #2977 ST-4: quiesce the write against the exclusive migration barrier.
    let _guard = store.writer_guard()?;
    let mut set_cols = Map::new();
    set_cols.insert("last_active_at".into(), json!(at));
    let mut where_cols = Map::new();
    where_cols.insert("id".into(), json!(id));
    store.update(FEATURE_ID, TABLE_NAME, &set_cols, &where_cols)?;
    Ok(())
}

/// Persist a captured CLI-native session id onto a record.
pub fn set_cli_session_id(store: &FeatureStore, id: &str, cli_session_id: &str) -> Result<()> {
    // Spec #2977 ST-4: quiesce the write against the exclusive migration barrier.
    let _guard = store.writer_guard()?;
    let mut set_cols = Map::new();
    set_cols.insert("cli_session_id".into(), json!(cli_session_id));
    let mut where_cols = Map::new();
    where_cols.insert("id".into(), json!(id));
    store.update(FEATURE_ID, TABLE_NAME, &set_cols, &where_cols)?;
    Ok(())
}

/// Rename a record's session name (Spec #2942 ST-3).
///
/// The name is the record's `title` and the ONLY editable field. The write is an
/// atomic column UPDATE through `FeatureStore::update` — the SAME path as
/// [`touch`]/[`set_cli_session_id`], never a delete+insert — so the record's key
/// identity is untouched (`id`, `created_at`, `cli`, `work_dir`, `cli_session_id`
/// all stay byte-identical; exactly one row keeps the same `id`, never an orphan
/// or duplicate — G-242).
///
/// Returns the number of rows updated (`0` when no record has that `id`).
pub fn rename(store: &FeatureStore, id: &str, name: &str) -> Result<u64> {
    // Spec #2977 ST-4: quiesce the write against the exclusive migration barrier.
    let _guard = store.writer_guard()?;
    let mut set_cols = Map::new();
    set_cols.insert("title".into(), json!(name));
    let mut where_cols = Map::new();
    where_cols.insert("id".into(), json!(id));
    store.update(FEATURE_ID, TABLE_NAME, &set_cols, &where_cols)
}

/// Delete one record by id (user-requested removal).
pub fn delete(store: &FeatureStore, id: &str) -> Result<u64> {
    // Spec #2977 ST-4: quiesce the write against the exclusive migration barrier.
    let _guard = store.writer_guard()?;
    delete_locked(store, id)
}

/// The delete body, with the caller already holding the writer guard.
fn delete_locked(store: &FeatureStore, id: &str) -> Result<u64> {
    let mut where_cols = Map::new();
    where_cols.insert("id".into(), json!(id));
    store.delete(FEATURE_ID, TABLE_NAME, &where_cols)
}

/// Evict every record beyond the newest [`MAX_RECORDS`] by `last_active_at`.
/// Returns the number evicted.
///
/// Private: callers already hold the writer guard (`insert` and this module's
/// tests) — acquiring it again here would nest a shared acquire behind a waiting
/// exclusive migration barrier (deadlock).
fn evict_oldest_beyond_max(store: &FeatureStore) -> Result<u64> {
    let all = list(store)?;
    if all.len() <= MAX_RECORDS {
        return Ok(0);
    }
    let mut evicted = 0;
    for record in all.into_iter().skip(MAX_RECORDS) {
        evicted += delete_locked(store, &record.id)?;
    }
    Ok(evicted)
}

/// Mint a stable title for a new record: the CLI label, with the lowest unused
/// positive ordinal appended when a record of the same CLI already exists
/// (`"OpenCode"`, `"OpenCode 2"`, …). The title is persisted, so existing titles
/// never renumber when a later record is removed.
pub fn mint_title(cli: SessionKind, existing: &[PersistedSession]) -> String {
    let base = cli.label();
    let next = existing
        .iter()
        .filter(|record| record.cli == cli)
        .filter_map(|record| ordinal_of(&record.title, base))
        .max()
        .map(|max| max + 1)
        .unwrap_or(1);
    if next <= 1 {
        base.to_string()
    } else {
        format!("{base} {next}")
    }
}

/// The ordinal encoded in a title for `base` (`"OpenCode"` → 1,
/// `"OpenCode 2"` → 2), or `None` when the title is not this CLI's.
fn ordinal_of(title: &str, base: &str) -> Option<u32> {
    if title == base {
        return Some(1);
    }
    title.strip_prefix(base)?.trim().parse().ok()
}

/// Normalize a filesystem path for case- and separator-insensitive comparison.
pub fn normalize_dir(path: &str) -> String {
    path.replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

/// Pick the CLI-native session id of the newest OpenCode session whose
/// `directory` matches `work_dir` and whose `created` time is at/after
/// `created_at_or_after_ms`.
///
/// Input is the raw stdout of `opencode session list --format json` (ST-1 pinned
/// that surface). Returns `None` when no matching entry exists — the caller then
/// keeps `cli_session_id = None` and resumes with the last-session flag.
pub fn newest_session_id_for_dir(
    json_stdout: &str,
    work_dir: &str,
    created_at_or_after_ms: u64,
) -> Option<String> {
    let parsed: Value = serde_json::from_str(json_stdout).ok()?;
    let entries = parsed.as_array()?;
    let target = normalize_dir(work_dir);
    entries
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str()?;
            let directory = entry.get("directory")?.as_str()?;
            let created = entry.get("created")?.as_u64()?;
            if normalize_dir(directory) != target || created < created_at_or_after_ms {
                return None;
            }
            Some((created, id.to_string()))
        })
        .max_by_key(|(created, _)| *created)
        .map(|(_, id)| id)
}
