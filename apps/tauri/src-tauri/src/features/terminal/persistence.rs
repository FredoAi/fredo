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
    store.insert(FEATURE_ID, TABLE_NAME, &[record.to_row()])?;
    evict_oldest_beyond_max(store)?;
    Ok(())
}

/// Refresh a record's `last_active_at` (window close / session close / self-exit).
pub fn touch(store: &FeatureStore, id: &str, at: u64) -> Result<()> {
    let mut set_cols = Map::new();
    set_cols.insert("last_active_at".into(), json!(at));
    let mut where_cols = Map::new();
    where_cols.insert("id".into(), json!(id));
    store.update(FEATURE_ID, TABLE_NAME, &set_cols, &where_cols)?;
    Ok(())
}

/// Persist a captured CLI-native session id onto a record.
pub fn set_cli_session_id(store: &FeatureStore, id: &str, cli_session_id: &str) -> Result<()> {
    let mut set_cols = Map::new();
    set_cols.insert("cli_session_id".into(), json!(cli_session_id));
    let mut where_cols = Map::new();
    where_cols.insert("id".into(), json!(id));
    store.update(FEATURE_ID, TABLE_NAME, &set_cols, &where_cols)?;
    Ok(())
}

/// Delete one record by id (user-requested removal).
pub fn delete(store: &FeatureStore, id: &str) -> Result<u64> {
    let mut where_cols = Map::new();
    where_cols.insert("id".into(), json!(id));
    store.delete(FEATURE_ID, TABLE_NAME, &where_cols)
}

/// Evict every record beyond the newest [`MAX_RECORDS`] by `last_active_at`.
/// Returns the number evicted.
pub fn evict_oldest_beyond_max(store: &FeatureStore) -> Result<u64> {
    let all = list(store)?;
    if all.len() <= MAX_RECORDS {
        return Ok(0);
    }
    let mut evicted = 0;
    for record in all.into_iter().skip(MAX_RECORDS) {
        evicted += delete(store, &record.id)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::terminal::state::SessionKind;
    use std::path::PathBuf;

    fn store_with_table(dir: &tempfile::TempDir) -> FeatureStore {
        let store = FeatureStore::open(PathBuf::from(dir.path())).unwrap();
        ensure_table(&store).unwrap();
        store
    }

    fn record(id: &str, cli: SessionKind, title: &str, last_active_at: u64) -> PersistedSession {
        PersistedSession {
            id: id.to_string(),
            cli,
            work_dir: r"C:\Code\fredo".to_string(),
            title: title.to_string(),
            created_at: last_active_at,
            last_active_at,
            cli_session_id: None,
        }
    }

    // ── Record mapping ──────────────────────────────────────────────────────

    #[test]
    fn to_row_carries_exactly_the_seven_columns() {
        let session = PersistedSession {
            id: "s1".into(),
            cli: SessionKind::Copilot,
            work_dir: r"C:\repo".into(),
            title: "GitHub Copilot".into(),
            created_at: 10,
            last_active_at: 20,
            cli_session_id: None,
        };
        let row = session.to_row();
        let mut keys: Vec<&str> = row.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "cli",
                "cli_session_id",
                "created_at",
                "id",
                "last_active_at",
                "title",
                "work_dir"
            ]
        );
        assert_eq!(row.get("cli").unwrap(), &json!("copilot"));
        assert_eq!(row.get("cli_session_id").unwrap(), &Value::Null);
        assert_eq!(row.get("created_at").unwrap(), &json!(10));
    }

    #[test]
    fn row_round_trips_through_from_row() {
        let session = PersistedSession {
            id: "s1".into(),
            cli: SessionKind::OpenCode,
            work_dir: r"C:\repo".into(),
            title: "OpenCode 2".into(),
            created_at: 10,
            last_active_at: 20,
            cli_session_id: Some("ses_abc".into()),
        };
        let back = PersistedSession::from_row(&session.to_row()).unwrap();
        assert_eq!(back, session);
    }

    #[test]
    fn from_row_accepts_the_shell_kind() {
        // Spec #2942 R-5.3: a parse gap here would make shell records silently
        // INVISIBLE through `list`'s `filter_map` — the shell wire value MUST
        // parse back into a record.
        let session = PersistedSession {
            id: "s1".into(),
            cli: SessionKind::Shell,
            work_dir: r"C:\repo".into(),
            title: "Terminal".into(),
            created_at: 10,
            last_active_at: 20,
            cli_session_id: None,
        };
        let back = PersistedSession::from_row(&session.to_row()).unwrap();
        assert_eq!(back.cli, SessionKind::Shell);
        assert_eq!(back, session);
        assert_eq!(session.to_row().get("cli").unwrap(), &json!("shell"));
    }

    #[test]
    fn from_row_returns_none_for_a_malformed_row() {
        // Unknown cli wire value.
        let mut row = Map::new();
        row.insert("id".into(), json!("s1"));
        row.insert("cli".into(), json!("claude"));
        row.insert("work_dir".into(), json!("~"));
        row.insert("title".into(), json!("Claude"));
        row.insert("created_at".into(), json!(1));
        row.insert("last_active_at".into(), json!(1));
        assert!(PersistedSession::from_row(&row).is_none());

        // Missing id.
        let mut missing = Map::new();
        missing.insert("cli".into(), json!("opencode"));
        assert!(PersistedSession::from_row(&missing).is_none());
    }

    #[test]
    fn record_serializes_camel_case_for_the_ui_wire() {
        let session = PersistedSession {
            id: "s1".into(),
            cli: SessionKind::OpenCode,
            work_dir: r"C:\repo".into(),
            title: "OpenCode".into(),
            created_at: 10,
            last_active_at: 20,
            cli_session_id: None,
        };
        let json = serde_json::to_value(&session).unwrap();
        assert_eq!(json["id"], json!("s1"));
        assert_eq!(json["cli"], json!("opencode"));
        assert_eq!(json["workDir"], json!("C:\\repo"));
        assert_eq!(json["title"], json!("OpenCode"));
        assert_eq!(json["createdAt"], json!(10));
        assert_eq!(json["lastActiveAt"], json!(20));
        assert!(json["cliSessionId"].is_null());
    }

    // ── Title minting ───────────────────────────────────────────────────────

    #[test]
    fn mint_title_starts_at_the_bare_label() {
        assert_eq!(mint_title(SessionKind::OpenCode, &[]), "OpenCode");
        assert_eq!(mint_title(SessionKind::Copilot, &[]), "GitHub Copilot");
        // Spec #2942 — the plain shell's stable title uses the "Terminal" label.
        assert_eq!(mint_title(SessionKind::Shell, &[]), "Terminal");
    }

    #[test]
    fn mint_title_numbers_shell_records_independently() {
        let existing = vec![
            record("a", SessionKind::Shell, "Terminal", 1),
            record("b", SessionKind::OpenCode, "OpenCode", 2),
        ];
        assert_eq!(mint_title(SessionKind::Shell, &existing), "Terminal 2");
        // A different kind's records do not affect the ordinal.
        assert_eq!(mint_title(SessionKind::Copilot, &existing), "GitHub Copilot");
    }

    #[test]
    fn mint_title_appends_the_lowest_unused_ordinal() {
        let existing = vec![
            record("a", SessionKind::OpenCode, "OpenCode", 1),
            record("b", SessionKind::OpenCode, "OpenCode 2", 2),
        ];
        assert_eq!(mint_title(SessionKind::OpenCode, &existing), "OpenCode 3");
        // A different CLI's records do not affect the ordinal.
        assert_eq!(mint_title(SessionKind::Copilot, &existing), "GitHub Copilot");
    }

    #[test]
    fn mint_title_does_not_reuse_a_removed_middle_ordinal() {
        // Records 1 and 3 exist (2 was removed): the next title is 4, so no
        // existing title is duplicated.
        let existing = vec![
            record("a", SessionKind::OpenCode, "OpenCode", 1),
            record("c", SessionKind::OpenCode, "OpenCode 3", 3),
        ];
        assert_eq!(mint_title(SessionKind::OpenCode, &existing), "OpenCode 4");
    }

    // ── Retention / eviction ────────────────────────────────────────────────

    #[test]
    fn retention_keeps_the_newest_records_and_evicts_the_oldest() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with_table(&dir);

        for i in 0..(MAX_RECORDS as u64 + 5) {
            insert(&store, &record(&format!("r{i}"), SessionKind::OpenCode, "OpenCode", i)).unwrap();
        }

        let all = list(&store).unwrap();
        assert_eq!(all.len(), MAX_RECORDS, "the record set is bounded");
        // Newest first: the five oldest (last_active_at 0..5) are gone.
        assert_eq!(all.first().unwrap().last_active_at, MAX_RECORDS as u64 + 4);
        assert_eq!(all.last().unwrap().last_active_at, 5);
        assert!(get(&store, "r0").unwrap().is_none());
        assert!(get(&store, "r4").unwrap().is_none());
        assert!(get(&store, "r5").unwrap().is_some());
    }

    #[test]
    fn eviction_returns_zero_below_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with_table(&dir);
        insert(&store, &record("only", SessionKind::OpenCode, "OpenCode", 1)).unwrap();
        assert_eq!(evict_oldest_beyond_max(&store).unwrap(), 0);
    }

    // ── Lifecycle helpers ───────────────────────────────────────────────────

    #[test]
    fn touch_refreshes_last_active_at_and_keeps_the_record() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with_table(&dir);
        insert(&store, &record("s1", SessionKind::OpenCode, "OpenCode", 1)).unwrap();

        touch(&store, "s1", 42).unwrap();
        let record = get(&store, "s1").unwrap().unwrap();
        assert_eq!(record.last_active_at, 42);
        assert_eq!(record.created_at, 1, "created_at is immutable");
        assert_eq!(list(&store).unwrap().len(), 1, "the record is kept");
    }

    #[test]
    fn set_cli_session_id_persists_the_capture() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with_table(&dir);
        insert(&store, &record("s1", SessionKind::OpenCode, "OpenCode", 1)).unwrap();

        set_cli_session_id(&store, "s1", "ses_abc").unwrap();
        assert_eq!(
            get(&store, "s1").unwrap().unwrap().cli_session_id.as_deref(),
            Some("ses_abc")
        );
    }

    #[test]
    fn delete_removes_only_the_named_record() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with_table(&dir);
        insert(&store, &record("a", SessionKind::OpenCode, "OpenCode", 1)).unwrap();
        insert(&store, &record("b", SessionKind::Copilot, "GitHub Copilot", 2)).unwrap();

        assert_eq!(delete(&store, "a").unwrap(), 1);
        assert!(get(&store, "a").unwrap().is_none());
        assert!(get(&store, "b").unwrap().is_some());
    }

    // ── OpenCode session-id capture parser ──────────────────────────────────

    /// A trimmed, real-shaped fixture from the ST-1 probe output
    /// (`opencode session list --format json`).
    const OPENCODE_LIST: &str = r#"[
      { "id": "ses_old", "title": "Older",  "updated": 100, "created": 100, "projectId": "p", "directory": "C:\\Code\\fredo" },
      { "id": "ses_new", "title": "Newest", "updated": 300, "created": 300, "projectId": "p", "directory": "C:\\Code\\fredo" },
      { "id": "ses_elsewhere", "title": "Other", "updated": 400, "created": 400, "projectId": "p", "directory": "C:\\Code\\other" }
    ]"#;

    #[test]
    fn capture_picks_the_newest_session_in_the_matching_directory() {
        assert_eq!(
            newest_session_id_for_dir(OPENCODE_LIST, r"C:\Code\fredo", 50).as_deref(),
            Some("ses_new")
        );
    }

    #[test]
    fn capture_matches_the_directory_case_and_separator_insensitively() {
        assert_eq!(
            newest_session_id_for_dir(OPENCODE_LIST, "c:/code/FREDO/", 50).as_deref(),
            Some("ses_new")
        );
    }

    #[test]
    fn capture_ignores_sessions_created_before_the_spawn() {
        assert!(newest_session_id_for_dir(OPENCODE_LIST, r"C:\Code\fredo", 301).is_none());
    }

    #[test]
    fn capture_returns_none_for_another_directory_or_bad_json() {
        assert!(newest_session_id_for_dir(OPENCODE_LIST, r"C:\Code\none", 0).is_none());
        assert!(newest_session_id_for_dir("not json", r"C:\Code\fredo", 0).is_none());
    }
}
