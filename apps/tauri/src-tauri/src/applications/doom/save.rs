//! Doom save contract + persistence (Spec #2972 ST-2; Spec #3011 ST-1).
//!
//! This module is the SINGLE producer (G-255) of the persisted resume contract
//! every other Doom sub-task compiles against: the [`DoomSave`] record, the
//! [`DoomCampaign`] transition model, the [`DoomSaveStatus`] wire model, the
//! `parse`/`serialize` codec, and the PG feature-store `load`/`store`/`clear`
//! persistence surface.
//!
//! ## Persistence surface (binding, G-255)
//!
//! The save lives in the dedicated typed PostgreSQL feature table
//! `feature_doom_save` (application `doom`, table `save`) owned through
//! [`ApplicationStore`] over the ONE shared pool (#2975/#3005). Exactly ONE row
//! is ever held, keyed [`DOOM_SAVE_ROW_ID`] = `"singleton"`; repeated writes are
//! one atomic `INSERT ... ON CONFLICT(id) DO UPDATE`
//! ([`ApplicationStore::upsert`]) — never delete-then-insert. `updatedAt` is an
//! RFC3339 timestamp serialized camelCase over the IPC wire.
//!
//! ## Test-only induction levers (G-275/G-300; inert when unset)
//!
//! * [`DOOM_SAVE_STATE_DIR_ENV`] — a tester-writable state dir. When set,
//!   `load`/`store`/`clear` use `<dir>/doom-save.json` (temp-file-then-rename)
//!   instead of the PG table, so a valid/corrupt/absent/unwritable fixture can be
//!   driven deterministically. The repo-relative
//!   [`DEFAULT_DOOM_SAVE_STATE_DIR`] is only the inert fallback.
//! * [`DOOM_SAVE_FORCE_FAIL_ENV`] — `read | write` in-process fault injection on
//!   the PG path (`read` → `load` reports no-save; `write` → `store` returns
//!   `Err` with NO PG write). Inert when unset/blank/unknown.
//!
//! ## Bounded + crash-safe (NFR-2 / NFR-3)
//!
//! One fixed row, one fixed-shape scalar record, no arrays and no append log.
//! [`DoomSave::parse`] returns `Option` and never panics: an absent, corrupt, or
//! out-of-contract save yields "no save" (a clean run). A write failure is the
//! caller's to log and ignore — it never fails the autoplay run.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::infrastructure::storage::application_store::{ApplicationStore, ColumnDef, ColumnType};

// ── Pinned constants (G-255 names block — do not rename) ─────────────────────

/// The persisted save schema version. A save carrying any other version is
/// rejected by [`DoomSave::parse`] (treated as absent → clean run).
pub const DOOM_SAVE_VERSION: u32 = 1;
/// The [`ApplicationStore`] namespace application id (`feature_doom_save`).
pub const DOOM_SAVE_FEATURE_ID: &str = "doom";
/// The [`ApplicationStore`] table name within the `doom` namespace.
pub const DOOM_SAVE_TABLE_NAME: &str = "save";
/// The record key of the single save row (`id = "singleton"`).
pub const DOOM_SAVE_ROW_ID: &str = "singleton";
/// **G-275** test-only state-dir override: when set to a non-blank path,
/// `load`/`store`/`clear` use `<dir>/doom-save.json` instead of the PG table.
/// Inert when unset.
pub const DOOM_SAVE_STATE_DIR_ENV: &str = "FREDO_DOOM_SAVE_STATE_DIR";
/// The inert repo-relative fallback state dir (never used unless a caller
/// resolves a dir without an override).
pub const DEFAULT_DOOM_SAVE_STATE_DIR: &str = ".opencode/tmp/3011/doom-save";
/// **G-300** in-process fault injection on the PG feature-store path
/// (`read | write`; inert when unset/blank/unknown).
pub const DOOM_SAVE_FORCE_FAIL_ENV: &str = "FREDO_DOOM_SAVE_FORCE_FAIL";
/// The file name used inside the state-dir seam.
const DOOM_SAVE_FILE_NAME: &str = "doom-save.json";
/// The first campaign episode (`E1`).
pub const DOOM_CAMPAIGN_FIRST_EPISODE: i64 = 1;
/// The last campaign episode (`E4` — Freedoom Phase 1 / Ultimate-Doom surface).
pub const DOOM_CAMPAIGN_LAST_EPISODE: i64 = 4;
/// The first campaign map (`M1`).
pub const DOOM_CAMPAIGN_FIRST_MAP: i64 = 1;
/// The last campaign map (`M9`).
pub const DOOM_CAMPAIGN_LAST_MAP: i64 = 9;
/// The default skill level (matches the launch argv `-skill 3`).
pub const DOOM_DEFAULT_SKILL: i64 = 3;
/// The default deterministic seed.
pub const DOOM_DEFAULT_SEED: i64 = 0;

/// The valid skill range (inclusive) the engine's `/api/episode` accepts.
const DOOM_SKILL_MIN: i64 = 0;
/// The valid skill range (inclusive) the engine's `/api/episode` accepts.
const DOOM_SKILL_MAX: i64 = 4;

// ── Campaign transition model ────────────────────────────────────────────────

/// The Doom campaign coordinates + terminal flag the autoplay loop tracks
/// (binding name, G-255).
///
/// Storage unit: integer `episode`/`map`/`skill`/`seed` (G-187). The bounds are
/// `episode 1..=4 × map 1..=9`; [`DoomCampaign::advance`] walks them and returns
/// `None` at the final level (completion).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DoomCampaign {
    /// Current episode (`1..=4`).
    pub episode: i64,
    /// Current map (`1..=9`).
    pub map: i64,
    /// Skill level (`0..=4`).
    pub skill: i64,
    /// Deterministic seed.
    pub seed: i64,
    /// Whether the final level has been exited (campaign complete).
    pub completed: bool,
}

impl Default for DoomCampaign {
    fn default() -> Self {
        Self::initial()
    }
}

impl DoomCampaign {
    /// The campaign's initial position: `E1M1`, default skill, default seed, not
    /// yet completed.
    pub fn initial() -> Self {
        Self {
            episode: DOOM_CAMPAIGN_FIRST_EPISODE,
            map: DOOM_CAMPAIGN_FIRST_MAP,
            skill: DOOM_DEFAULT_SKILL,
            seed: DOOM_DEFAULT_SEED,
            completed: false,
        }
    }

    /// Whether the campaign is at the final level (`E4M9`).
    pub fn at_final_level(&self) -> bool {
        self.episode == DOOM_CAMPAIGN_LAST_EPISODE && self.map == DOOM_CAMPAIGN_LAST_MAP
    }

    /// Advance one level: `map + 1`, or `episode + 1` / `map = 1` when the map
    /// wraps, or `None` at `E4M9` (the completion signal).
    ///
    /// A campaign already marked `completed` never advances (idempotent).
    pub fn advance(&self) -> Option<DoomCampaign> {
        if self.completed {
            return None;
        }
        if self.map < DOOM_CAMPAIGN_LAST_MAP {
            Some(DoomCampaign {
                map: self.map + 1,
                ..*self
            })
        } else if self.episode < DOOM_CAMPAIGN_LAST_EPISODE {
            Some(DoomCampaign {
                episode: self.episode + 1,
                map: DOOM_CAMPAIGN_FIRST_MAP,
                ..*self
            })
        } else {
            None
        }
    }
}

// ── Persisted record ─────────────────────────────────────────────────────────

/// The bounded persisted resume record (binding name, G-255).
///
/// One fixed-shape scalar object stored as the single `feature_doom_save` row
/// (or the state-dir seam file). `updatedAt` is an RFC3339 timestamp and
/// serializes camelCase over the seam.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomSave {
    /// The schema version; must equal [`DOOM_SAVE_VERSION`].
    pub version: u32,
    /// Saved episode (`>= 1`).
    pub episode: i64,
    /// Saved map (`>= 1`).
    pub map: i64,
    /// Saved skill (`0..=4`).
    pub skill: i64,
    /// Saved deterministic seed.
    pub seed: i64,
    /// Whether the campaign was completed at save time.
    pub completed: bool,
    /// RFC3339 timestamp of the last write.
    pub updated_at: String,
}

/// One [`ColumnDef`] helper for [`DoomSave::columns`].
fn column_def(name: &str, col_type: ColumnType, nullable: bool, primary_key: bool) -> ColumnDef {
    ColumnDef {
        name: name.to_string(),
        col_type,
        nullable,
        primary_key,
    }
}

impl DoomSave {
    /// The typed `feature_doom_save` column contract (G-255 names block):
    /// `id` (PK), `version`, `episode`, `map`, `skill`, `seed`, `completed`,
    /// `updated_at`. `completed` is `INTEGER` (0/1) because [`ColumnType`] has no
    /// boolean affinity.
    pub fn columns() -> Vec<ColumnDef> {
        vec![
            column_def("id", ColumnType::TEXT, false, true),
            column_def("version", ColumnType::INTEGER, false, false),
            column_def("episode", ColumnType::INTEGER, false, false),
            column_def("map", ColumnType::INTEGER, false, false),
            column_def("skill", ColumnType::INTEGER, false, false),
            column_def("seed", ColumnType::INTEGER, false, false),
            column_def("completed", ColumnType::INTEGER, false, false),
            column_def("updated_at", ColumnType::TEXT, false, false),
        ]
    }

    /// Project this record onto a `feature_doom_save` row map (the singleton
    /// [`DOOM_SAVE_ROW_ID`] primary key + the typed columns).
    pub fn to_row(&self) -> Map<String, Value> {
        let mut row = Map::new();
        row.insert("id".to_string(), json!(DOOM_SAVE_ROW_ID));
        row.insert("version".to_string(), json!(self.version));
        row.insert("episode".to_string(), json!(self.episode));
        row.insert("map".to_string(), json!(self.map));
        row.insert("skill".to_string(), json!(self.skill));
        row.insert("seed".to_string(), json!(self.seed));
        row.insert(
            "completed".to_string(),
            json!(if self.completed { 1i64 } else { 0i64 }),
        );
        row.insert("updated_at".to_string(), json!(self.updated_at));
        row
    }

    /// Parse a `feature_doom_save` row map back into a record, routing through
    /// [`Self::validate`]. A malformed or out-of-contract row yields `None`.
    pub fn from_row(row: &Map<String, Value>) -> Option<DoomSave> {
        let version = u32::try_from(row.get("version")?.as_u64()?).ok()?;
        let save = DoomSave {
            version,
            episode: row.get("episode")?.as_i64()?,
            map: row.get("map")?.as_i64()?,
            skill: row.get("skill")?.as_i64()?,
            seed: row.get("seed")?.as_i64()?,
            completed: row.get("completed")?.as_i64()? != 0,
            updated_at: row.get("updated_at")?.as_str()?.to_string(),
        };
        save.validate()?;
        Some(save)
    }

    /// Parse a persisted save, rejecting anything outside the pinned contract:
    /// an unknown `version`, an `episode`/`map` outside the campaign bounds
    /// (`1..=4` / `1..=9`), or a `skill` outside `0..=4` yields `None`. Never
    /// panics — malformed JSON is simply "no save".
    ///
    /// The campaign **upper** bound is enforced here (not only the non-positive
    /// lower bound): CU-1's live spike (`spikes/2972-doom-resume/campaign-surface.md`
    /// §4) shows the engine does **not** reject an out-of-range episode — `episode 5`
    /// is a **fatal** path that kills the API daemon — so this parse gate must
    /// reject it before ST-5 ever builds a `POST /api/episode` (NFR-3/AC4).
    pub fn parse(text: &str) -> Option<DoomSave> {
        let save: DoomSave = serde_json::from_str(text).ok()?;
        save.validate()?;
        Some(save)
    }

    /// Validate the parsed record against the pinned contract (see [`Self::parse`]).
    fn validate(&self) -> Option<()> {
        if self.version != DOOM_SAVE_VERSION {
            return None;
        }
        if self.episode < DOOM_CAMPAIGN_FIRST_EPISODE || self.episode > DOOM_CAMPAIGN_LAST_EPISODE {
            return None;
        }
        if self.map < DOOM_CAMPAIGN_FIRST_MAP || self.map > DOOM_CAMPAIGN_LAST_MAP {
            return None;
        }
        if self.skill < DOOM_SKILL_MIN || self.skill > DOOM_SKILL_MAX {
            return None;
        }
        Some(())
    }

    /// Serialize to the camelCase JSON used by the state-dir seam. The shape is a
    /// scalar object, so serialization cannot fail; a failure yields an empty
    /// string rather than a panic (the caller treats it as a write failure).
    pub fn serialize(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// Project the record onto the campaign transition model.
    pub fn to_campaign(&self) -> DoomCampaign {
        DoomCampaign {
            episode: self.episode,
            map: self.map,
            skill: self.skill,
            seed: self.seed,
            completed: self.completed,
        }
    }

    /// Build the persisted record for a campaign position at `updated_at`.
    pub fn from_campaign(campaign: &DoomCampaign, updated_at: String) -> DoomSave {
        DoomSave {
            version: DOOM_SAVE_VERSION,
            episode: campaign.episode,
            map: campaign.map,
            skill: campaign.skill,
            seed: campaign.seed,
            completed: campaign.completed,
            updated_at,
        }
    }
}

// ── Wire model (camelCase, IPC) ──────────────────────────────────────────────

/// The `get_doom_save` / `reset_doom_save` return shape (binding name, G-255).
///
/// Absent/corrupt → [`DoomSaveStatus::absent`]: `hasSave:false` and every
/// coordinate `null`. A valid save mirrors the record's coordinates.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomSaveStatus {
    /// Whether a valid save is present.
    pub has_save: bool,
    /// Saved episode, when a valid save exists.
    pub episode: Option<i64>,
    /// Saved map, when a valid save exists.
    pub map: Option<i64>,
    /// Saved skill, when a valid save exists.
    pub skill: Option<i64>,
    /// Saved seed, when a valid save exists.
    pub seed: Option<i64>,
    /// Whether the saved run was completed.
    pub completed: bool,
    /// RFC3339 timestamp of the last write, when a valid save exists.
    pub updated_at: Option<String>,
}

impl DoomSaveStatus {
    /// The absent/corrupt shape: no save, every field null/default.
    pub fn absent() -> Self {
        DoomSaveStatus {
            has_save: false,
            episode: None,
            map: None,
            skill: None,
            seed: None,
            completed: false,
            updated_at: None,
        }
    }

    /// The present shape mirroring a valid save.
    pub fn from_save(save: &DoomSave) -> Self {
        DoomSaveStatus {
            has_save: true,
            episode: Some(save.episode),
            map: Some(save.map),
            skill: Some(save.skill),
            seed: Some(save.seed),
            completed: save.completed,
            updated_at: Some(save.updated_at.clone()),
        }
    }
}

// ── Test-only induction levers ────────────────────────────────────────────────

/// The named failure stage forced by [`DOOM_SAVE_FORCE_FAIL_ENV`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DoomSaveFailStage {
    /// `load` reports no-save.
    Read,
    /// `store` returns `Err` with NO PG write.
    Write,
}

/// Parse a [`DOOM_SAVE_FORCE_FAIL_ENV`] value. Returns `None` (inert) for
/// blank/unknown input.
pub fn parse_force_fail(value: &str) -> Option<DoomSaveFailStage> {
    match value.trim().to_ascii_lowercase().as_str() {
        "read" => Some(DoomSaveFailStage::Read),
        "write" => Some(DoomSaveFailStage::Write),
        _ => None,
    }
}

/// Resolve the active forced-failure stage. Inert (`None`) when unset, blank, or
/// unrecognised.
fn force_fail_stage() -> Option<DoomSaveFailStage> {
    let raw = std::env::var(DOOM_SAVE_FORCE_FAIL_ENV).ok()?;
    parse_force_fail(&raw)
}

/// Resolve a state dir from an explicit override value: a non-blank override
/// wins, else the inert repo-relative [`DEFAULT_DOOM_SAVE_STATE_DIR`]. ONE shared
/// rule so the seam reader and any future reader cannot diverge.
pub fn resolve_state_dir(override_value: Option<&str>) -> PathBuf {
    match override_value {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => PathBuf::from(DEFAULT_DOOM_SAVE_STATE_DIR),
    }
}

/// The active test-only state dir, or `None` when the override is unset/blank
/// (the production path then uses the PG feature table).
fn active_state_dir() -> Option<PathBuf> {
    let override_value = std::env::var(DOOM_SAVE_STATE_DIR_ENV).ok()?;
    let value = override_value.trim();
    if value.is_empty() {
        None
    } else {
        Some(resolve_state_dir(Some(value)))
    }
}

/// The `<dir>/doom-save.json` path when the state-dir override is active.
fn active_save_file_path() -> Option<PathBuf> {
    active_state_dir().map(|dir| dir.join(DOOM_SAVE_FILE_NAME))
}

// ── Persistence (dedicated PG feature store) ─────────────────────────────────

/// Create the `feature_doom_save` table if it does not exist (idempotent) — the
/// startup schema-init registry entry (`lib.rs`), delegating to the ONE DDL
/// builder on [`ApplicationStore`] so the table exists on PostgreSQL before any
/// Doom save read/write.
pub fn ensure_table_on_pg(pool: &sqlx::PgPool) -> anyhow::Result<()> {
    ApplicationStore::ensure_table_on_pg(
        pool,
        DOOM_SAVE_FEATURE_ID,
        DOOM_SAVE_TABLE_NAME,
        &DoomSave::columns(),
    )
}

/// Load the persisted save, or `None` when absent/unreadable/out-of-contract.
///
/// Uses the state-dir seam when set, else the PG feature table. `read`-stage
/// fault injection reports no-save. Never fails: any read/parse problem is
/// "no save".
pub fn load(store: &ApplicationStore) -> Option<DoomSave> {
    if let Some(path) = active_save_file_path() {
        return read_save_file(&path);
    }
    if force_fail_stage() == Some(DoomSaveFailStage::Read) {
        return None;
    }
    let mut where_cols = Map::new();
    where_cols.insert("id".to_string(), json!(DOOM_SAVE_ROW_ID));
    let rows = store
        .query(
            DOOM_SAVE_FEATURE_ID,
            DOOM_SAVE_TABLE_NAME,
            Some(&where_cols),
            None,
            Some(1),
        )
        .ok()?;
    rows.first().and_then(DoomSave::from_row)
}

/// The `feature_doom_save` primary-key **column** list for the single row.
///
/// The key COLUMN is `id` (declared `PRIMARY KEY` in [`DoomSave::columns`] and
/// written by [`DoomSave::to_row`]); [`DOOM_SAVE_ROW_ID`] (`"singleton"`) is the
/// VALUE held in that column. [`ApplicationStore::upsert`] treats this list as
/// column names verbatim, so passing the row value here emitted
/// `ON CONFLICT("singleton")` → PostgreSQL `column "singleton" does not exist` →
/// every save failed (best-effort) and NO row ever persisted (Spec #3011
/// round-2 defect). Kept as a named constructor so the column/value distinction
/// is pinned by [`tests::store_primary_key_is_the_id_column_never_the_row_value`].
fn save_primary_key_columns() -> [String; 1] {
    ["id".to_string()]
}

/// Persist the save, returning an error on any failure (the caller logs and
/// ignores it — a save write never fails the autoplay run).
///
/// Uses the state-dir seam when set (temp-file-then-rename), else the atomic
/// single-row upsert on `feature_doom_save`. `write`-stage fault injection
/// returns `Err` with NO PG write.
pub fn store(store: &ApplicationStore, save: &DoomSave) -> Result<(), String> {
    if let Some(path) = active_save_file_path() {
        return write_save_file_atomic(&path, save);
    }
    if force_fail_stage() == Some(DoomSaveFailStage::Write) {
        return Err(
            "doom save write failed (forced by FREDO_DOOM_SAVE_FORCE_FAIL=write)".to_string(),
        );
    }
    let primary_key = save_primary_key_columns();
    store
        .upsert(
            DOOM_SAVE_FEATURE_ID,
            DOOM_SAVE_TABLE_NAME,
            &primary_key,
            &[save.to_row()],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Resolve the campaign to play on start (Spec #2972 R-1/R-5) — the command
/// composition helper, kept pure so the fresh-start/resume decision is unit
/// testable without a Tauri `AppHandle`.
///
/// `fresh_start == Some(true)` always yields the campaign initial (an explicitly
/// requested fresh run); otherwise a valid loaded campaign wins, falling back to
/// the initial when none was loaded (absent/corrupt → clean run). A
/// `completed:true` campaign is returned as-is — the autoplay loop treats it as
/// terminal at start (G-321); only an explicit fresh start replaces it.
pub fn resolve_start_campaign(
    fresh_start: Option<bool>,
    loaded: Option<DoomCampaign>,
) -> DoomCampaign {
    if fresh_start == Some(true) {
        return DoomCampaign::initial();
    }
    loaded.unwrap_or_else(DoomCampaign::initial)
}

/// Discard the persisted save (Spec #2972 `reset_doom_save`): delete the
/// singleton `feature_doom_save` row, or remove the state-dir file when the seam
/// is set. Idempotent — an absent save is a no-op. A real failure is returned for
/// the caller to log; the command still reports `hasSave:false` afterwards
/// because a missing row parses as "no save".
pub fn clear(store: &ApplicationStore) -> Result<(), String> {
    if let Some(path) = active_save_file_path() {
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("remove {}: {error}", path.display())),
        };
    }
    let mut where_cols = Map::new();
    where_cols.insert("id".to_string(), json!(DOOM_SAVE_ROW_ID));
    store
        .delete(DOOM_SAVE_FEATURE_ID, DOOM_SAVE_TABLE_NAME, &where_cols)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Read + parse a save from an explicit path (the state-dir file primitive).
///
/// A missing file, a directory, an unreadable file, or out-of-contract JSON all
/// yield `None` — never a panic.
fn read_save_file(path: &Path) -> Option<DoomSave> {
    let text = std::fs::read_to_string(path).ok()?;
    DoomSave::parse(&text)
}

/// Write a save to an explicit path atomically via temp-file-then-rename.
///
/// A missing parent directory fails at temp-file creation; a target that is a
/// directory (or otherwise un-replaceable) fails at the rename. **Both surface
/// as `Err`** (G-300) — the write never silently "succeeds" on an unwritable
/// path. On success the target is replaced in one atomic rename.
fn write_save_file_atomic(path: &Path, save: &DoomSave) -> Result<(), String> {
    let contents = save.serialize();
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("invalid save path: {}", path.display()))?;
    let temp_name = format!("{}.tmp", file_name.to_string_lossy());
    let temp_path = match path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        Some(parent) => parent.join(temp_name),
        None => PathBuf::from(temp_name),
    };

    // A missing parent (or an unwritable directory) fails HERE.
    std::fs::write(&temp_path, contents)
        .map_err(|error| format!("write temp {}: {error}", temp_path.display()))?;

    // Replacing a directory (or any un-replaceable target) fails HERE. On Windows
    // this is `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` — atomic for files, an
    // error for directories.
    std::fs::rename(&temp_path, path).map_err(|error| {
        let _ = std::fs::remove_file(&temp_path);
        format!("replace {}: {error}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> DoomSave {
        DoomSave {
            version: DOOM_SAVE_VERSION,
            episode: 1,
            map: 2,
            skill: DOOM_DEFAULT_SKILL,
            seed: DOOM_DEFAULT_SEED,
            completed: false,
            updated_at: "2026-10-05T12:00:00+00:00".to_string(),
        }
    }

    #[test]
    fn the_binding_constants_are_pinned() {
        assert_eq!(DOOM_SAVE_VERSION, 1);
        assert_eq!(DOOM_SAVE_FEATURE_ID, "doom");
        assert_eq!(DOOM_SAVE_TABLE_NAME, "save");
        assert_eq!(DOOM_SAVE_ROW_ID, "singleton");
        assert_eq!(DOOM_SAVE_STATE_DIR_ENV, "FREDO_DOOM_SAVE_STATE_DIR");
        assert_eq!(DOOM_SAVE_FORCE_FAIL_ENV, "FREDO_DOOM_SAVE_FORCE_FAIL");
        assert_eq!(DEFAULT_DOOM_SAVE_STATE_DIR, ".opencode/tmp/3011/doom-save");
        assert_eq!(DOOM_CAMPAIGN_FIRST_EPISODE, 1);
        assert_eq!(DOOM_CAMPAIGN_LAST_EPISODE, 4);
        assert_eq!(DOOM_CAMPAIGN_FIRST_MAP, 1);
        assert_eq!(DOOM_CAMPAIGN_LAST_MAP, 9);
        assert_eq!(DOOM_DEFAULT_SKILL, 3);
        assert_eq!(DOOM_DEFAULT_SEED, 0);
    }

    #[test]
    fn columns_are_the_typed_names_block_contract() {
        let columns = DoomSave::columns();
        let names: Vec<&str> = columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "id",
                "version",
                "episode",
                "map",
                "skill",
                "seed",
                "completed",
                "updated_at"
            ]
        );
        // `id` is the TEXT primary key; the coordinates are INTEGER; the
        // timestamp is TEXT; `completed` is the 0/1 INTEGER affinity.
        assert_eq!(columns[0].col_type, ColumnType::TEXT);
        assert!(columns[0].primary_key);
        assert!(!columns[0].nullable);
        for index in 1..=6 {
            assert_eq!(columns[index].col_type, ColumnType::INTEGER);
            assert!(!columns[index].primary_key);
            assert!(!columns[index].nullable);
        }
        assert_eq!(columns[7].col_type, ColumnType::TEXT);
    }

    /// Regression pin (Spec #3011 round 2): `store`'s upsert key list is the PK
    /// **column** `id`, never the row **value** `"singleton"`. The pre-fix code
    /// passed `[DOOM_SAVE_ROW_ID.to_string()]`, so `ApplicationStore::upsert`
    /// emitted `ON CONFLICT("singleton")` and every save failed with
    /// `column "singleton" does not exist`. A future column/value swap now fails
    /// `cargo test`.
    #[test]
    fn store_primary_key_is_the_id_column_never_the_row_value() {
        let primary_key = save_primary_key_columns();
        assert_eq!(primary_key, ["id".to_string()], "the PK COLUMN is `id`");
        assert_ne!(
            primary_key,
            [DOOM_SAVE_ROW_ID.to_string()],
            "the PK list must never be the row VALUE `{}`",
            DOOM_SAVE_ROW_ID
        );

        // The list agrees with the declared schema PK column and with the row
        // key `to_row` actually writes.
        let columns = DoomSave::columns();
        assert!(columns[0].primary_key);
        assert_eq!(columns[0].name, primary_key[0]);
        let row = sample().to_row();
        assert!(
            row.contains_key(primary_key[0].as_str()),
            "the PK column must be present in the written row"
        );
        assert_eq!(
            row.get(primary_key[0].as_str()).and_then(Value::as_str),
            Some(DOOM_SAVE_ROW_ID),
            "the PK column holds the singleton value"
        );
    }

    #[test]
    fn to_row_and_from_row_round_trip_through_validate() {
        let save = sample();
        let row = save.to_row();
        assert_eq!(row.get("id").and_then(Value::as_str), Some(DOOM_SAVE_ROW_ID));
        assert_eq!(row.get("completed").and_then(Value::as_i64), Some(0));
        assert_eq!(DoomSave::from_row(&row), Some(save.clone()));

        // A completed save round-trips the 0/1 flag.
        let completed = DoomSave {
            completed: true,
            ..save.clone()
        };
        assert_eq!(
            DoomSave::from_row(&completed.to_row()),
            Some(completed.clone())
        );

        // Out-of-contract rows route through `validate` and yield `None`.
        let mut unknown_version = save.to_row();
        unknown_version.insert("version".to_string(), json!(2));
        assert_eq!(DoomSave::from_row(&unknown_version), None);

        let mut episode_five = save.to_row();
        episode_five.insert("episode".to_string(), json!(5));
        assert_eq!(DoomSave::from_row(&episode_five), None);

        let mut map_ten = save.to_row();
        map_ten.insert("map".to_string(), json!(10));
        assert_eq!(DoomSave::from_row(&map_ten), None);

        let mut high_skill = save.to_row();
        high_skill.insert("skill".to_string(), json!(5));
        assert_eq!(DoomSave::from_row(&high_skill), None);

        // A missing column is `None` (never a panic).
        let mut missing = save.to_row();
        missing.remove("seed");
        assert_eq!(DoomSave::from_row(&missing), None);
    }

    #[test]
    fn parse_accepts_a_valid_save_and_rejects_every_out_of_contract_shape() {
        // Valid.
        assert_eq!(DoomSave::parse(&sample().serialize()), Some(sample()));

        // Unknown version.
        let mut unknown_version = sample();
        unknown_version.version = 2;
        assert_eq!(DoomSave::parse(&unknown_version.serialize()), None);

        // Non-positive episode / map.
        let mut zero_episode = sample();
        zero_episode.episode = 0;
        assert_eq!(DoomSave::parse(&zero_episode.serialize()), None);
        let mut negative_episode = sample();
        negative_episode.episode = -1;
        assert_eq!(DoomSave::parse(&negative_episode.serialize()), None);
        let mut zero_map = sample();
        zero_map.map = 0;
        assert_eq!(DoomSave::parse(&zero_map.serialize()), None);
        let mut negative_map = sample();
        negative_map.map = -9;
        assert_eq!(DoomSave::parse(&negative_map.serialize()), None);

        // Out-of-campaign episode / map. `episode 5` is a FATAL engine path
        // (CU-1 spike §4: it kills the API daemon), so it must never parse.
        let mut episode_five = sample();
        episode_five.episode = 5;
        assert_eq!(DoomSave::parse(&episode_five.serialize()), None);
        let mut map_ten = sample();
        map_ten.map = 10;
        assert_eq!(DoomSave::parse(&map_ten.serialize()), None);

        // The campaign's final coordinate is accepted verbatim.
        let mut final_level = sample();
        final_level.episode = DOOM_CAMPAIGN_LAST_EPISODE;
        final_level.map = DOOM_CAMPAIGN_LAST_MAP;
        assert_eq!(DoomSave::parse(&final_level.serialize()), Some(final_level));

        // Skill outside 0..=4.
        let mut low_skill = sample();
        low_skill.skill = -1;
        assert_eq!(DoomSave::parse(&low_skill.serialize()), None);
        let mut high_skill = sample();
        high_skill.skill = 5;
        assert_eq!(DoomSave::parse(&high_skill.serialize()), None);
        // Boundary values are accepted.
        let mut min_skill = sample();
        min_skill.skill = 0;
        assert!(DoomSave::parse(&min_skill.serialize()).is_some());
        let mut max_skill = sample();
        max_skill.skill = 4;
        assert!(DoomSave::parse(&max_skill.serialize()).is_some());

        // Non-JSON, empty, whitespace, wrong shape — never panics.
        assert_eq!(DoomSave::parse("not json"), None);
        assert_eq!(DoomSave::parse(""), None);
        assert_eq!(DoomSave::parse("   "), None);
        assert_eq!(DoomSave::parse("{}"), None);
        assert_eq!(DoomSave::parse("[]"), None);
        assert_eq!(DoomSave::parse(r#"{"version":1,"episode":1}"#), None);
    }

    #[test]
    fn serialize_round_trips_camel_case() {
        let save = sample();
        let json = save.serialize();
        assert!(json.contains("\"updatedAt\""), "camelCase key: {json}");
        assert!(!json.contains("updated_at"), "no snake_case key: {json}");
        assert_eq!(DoomSave::parse(&json), Some(save));
    }

    #[test]
    fn campaign_initial_is_e1m1_at_the_defaults() {
        let campaign = DoomCampaign::initial();
        assert_eq!(campaign.episode, DOOM_CAMPAIGN_FIRST_EPISODE);
        assert_eq!(campaign.map, DOOM_CAMPAIGN_FIRST_MAP);
        assert_eq!(campaign.skill, DOOM_DEFAULT_SKILL);
        assert_eq!(campaign.seed, DOOM_DEFAULT_SEED);
        assert!(!campaign.completed);
        assert_eq!(DoomCampaign::default(), campaign);
    }

    #[test]
    fn campaign_advance_walks_maps_then_wraps_episodes_and_completes_at_e4m9() {
        let start = DoomCampaign::initial();
        // Map + 1.
        assert_eq!(start.advance().map(|c| (c.episode, c.map)), Some((1, 2)));

        // Wrap at the end of an episode: E1M9 → E2M1.
        let wrap = DoomCampaign {
            episode: 1,
            map: DOOM_CAMPAIGN_LAST_MAP,
            ..start
        };
        assert_eq!(wrap.advance().map(|c| (c.episode, c.map)), Some((2, 1)));

        // Wrap again: E3M9 → E4M1.
        let wrap3 = DoomCampaign {
            episode: 3,
            map: DOOM_CAMPAIGN_LAST_MAP,
            ..start
        };
        assert_eq!(wrap3.advance().map(|c| (c.episode, c.map)), Some((4, 1)));

        // Final level → completion (None).
        let final_level = DoomCampaign {
            episode: DOOM_CAMPAIGN_LAST_EPISODE,
            map: DOOM_CAMPAIGN_LAST_MAP,
            ..start
        };
        assert!(final_level.at_final_level());
        assert_eq!(final_level.advance(), None);

        // A completed campaign never advances.
        let completed = DoomCampaign {
            completed: true,
            ..start
        };
        assert_eq!(completed.advance(), None);

        // A full walk terminates at E4M9 and preserves skill/seed throughout.
        let mut campaign = DoomCampaign::initial();
        let mut visited = 1;
        while let Some(next) = campaign.advance() {
            assert_eq!(next.skill, DOOM_DEFAULT_SKILL);
            assert_eq!(next.seed, DOOM_DEFAULT_SEED);
            campaign = next;
            visited += 1;
        }
        assert_eq!((campaign.episode, campaign.map), (4, 9));
        assert_eq!(visited, 36); // 4 episodes × 9 maps.
    }

    #[test]
    fn campaign_save_round_trips() {
        let campaign = DoomCampaign {
            episode: 2,
            map: 3,
            skill: 4,
            seed: 7,
            completed: false,
        };
        let save = DoomSave::from_campaign(&campaign, "2026-10-05T12:00:00+00:00".to_string());
        assert_eq!(save.to_campaign(), campaign);
        assert_eq!(DoomSave::parse(&save.serialize()), Some(save));
    }

    #[test]
    fn status_absent_and_present_shapes_serialize_camel_case() {
        let absent = DoomSaveStatus::absent();
        let value = serde_json::to_value(&absent).expect("serialize");
        assert_eq!(value["hasSave"], false);
        assert!(value["episode"].is_null());
        assert!(value["map"].is_null());
        assert!(value["skill"].is_null());
        assert!(value["seed"].is_null());
        assert_eq!(value["completed"], false);
        assert!(value["updatedAt"].is_null());

        let present = DoomSaveStatus::from_save(&sample());
        let value = serde_json::to_value(&present).expect("serialize");
        assert_eq!(value["hasSave"], true);
        assert_eq!(value["episode"], 1);
        assert_eq!(value["map"], 2);
        assert_eq!(value["skill"], 3);
        assert_eq!(value["seed"], 0);
        assert_eq!(value["completed"], false);
        assert_eq!(value["updatedAt"], "2026-10-05T12:00:00+00:00");
    }

    #[test]
    fn state_dir_seam_file_round_trips_and_rejects_unwritable_paths() {
        let dir = tempfile::tempdir().expect("tempdir");
        let save = sample();

        // A normal file path round-trips atomically.
        let path = dir.path().join("doom-save.json");
        write_save_file_atomic(&path, &save).expect("write save file");
        assert_eq!(read_save_file(&path), Some(save.clone()));
        // No temp file is left behind.
        assert!(!dir.path().join("doom-save.json.tmp").exists());

        // A directory at the seam path is a write failure (G-300), not a silent
        // success.
        let as_dir = dir.path().join("save-dir");
        std::fs::create_dir(&as_dir).expect("create dir");
        assert!(write_save_file_atomic(&as_dir, &save).is_err());
        assert_eq!(read_save_file(&as_dir), None);

        // A missing parent is a write failure (G-300).
        let missing_parent = dir.path().join("no-such-dir").join("doom-save.json");
        assert!(write_save_file_atomic(&missing_parent, &save).is_err());

        // Absent / corrupt reads are "no save", never a panic.
        assert_eq!(read_save_file(&dir.path().join("absent.json")), None);
        let corrupt = dir.path().join("corrupt.json");
        std::fs::write(&corrupt, "not json").expect("write corrupt");
        assert_eq!(read_save_file(&corrupt), None);
    }

    #[test]
    fn state_dir_resolution_prefers_the_override_else_the_inert_default() {
        assert_eq!(
            resolve_state_dir(Some("C:/tmp/doom-save")),
            PathBuf::from("C:/tmp/doom-save")
        );
        assert_eq!(
            resolve_state_dir(Some("  C:/tmp/doom-save  ")),
            PathBuf::from("C:/tmp/doom-save")
        );
        // Blank / absent override falls back to the inert repo-relative default.
        assert_eq!(
            resolve_state_dir(Some("")),
            PathBuf::from(DEFAULT_DOOM_SAVE_STATE_DIR)
        );
        assert_eq!(
            resolve_state_dir(Some("   ")),
            PathBuf::from(DEFAULT_DOOM_SAVE_STATE_DIR)
        );
        assert_eq!(
            resolve_state_dir(None),
            PathBuf::from(DEFAULT_DOOM_SAVE_STATE_DIR)
        );

        // Inert in the normal test process (no test sets the env override).
        if std::env::var(DOOM_SAVE_STATE_DIR_ENV).is_err() {
            assert_eq!(active_state_dir(), None);
            assert_eq!(active_save_file_path(), None);
        }
    }

    #[test]
    fn force_fail_parsing_recognises_read_write_and_is_inert_otherwise() {
        assert_eq!(parse_force_fail("read"), Some(DoomSaveFailStage::Read));
        assert_eq!(parse_force_fail("READ"), Some(DoomSaveFailStage::Read));
        assert_eq!(parse_force_fail(" write "), Some(DoomSaveFailStage::Write));
        assert_eq!(parse_force_fail(""), None);
        assert_eq!(parse_force_fail("   "), None);
        assert_eq!(parse_force_fail("unknown"), None);
    }

    #[test]
    fn resolve_start_campaign_prefers_fresh_then_loaded_then_initial() {
        let loaded = DoomCampaign {
            episode: 2,
            map: 5,
            skill: 1,
            seed: 7,
            completed: false,
        };
        // An explicit fresh start wins over a loaded save.
        assert_eq!(
            resolve_start_campaign(Some(true), Some(loaded)),
            DoomCampaign::initial()
        );
        // Absent / false freshStart resumes the loaded save.
        assert_eq!(resolve_start_campaign(None, Some(loaded)), loaded);
        assert_eq!(resolve_start_campaign(Some(false), Some(loaded)), loaded);
        // No loaded save -> the campaign initial (clean run, R-4).
        assert_eq!(resolve_start_campaign(None, None), DoomCampaign::initial());
        assert_eq!(
            resolve_start_campaign(Some(false), None),
            DoomCampaign::initial()
        );
        // A completed save is preserved (terminal at start, G-321); only an
        // explicit fresh start replaces it.
        let completed = DoomCampaign {
            completed: true,
            ..loaded
        };
        assert_eq!(resolve_start_campaign(None, Some(completed)), completed);
        assert_eq!(
            resolve_start_campaign(Some(true), Some(completed)),
            DoomCampaign::initial()
        );
    }
}
