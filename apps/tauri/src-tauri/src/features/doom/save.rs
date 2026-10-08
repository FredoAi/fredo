//! Doom save contract + persistence (Spec #2972, ST-2).
//!
//! This module is the SINGLE producer (G-255) of the persisted resume contract
//! every other Doom sub-task compiles against: the [`DoomSave`] record, the
//! [`DoomCampaign`] transition model, the [`DoomSaveStatus`] wire model, the
//! `parse`/`serialize` codec, and the `load`/`store` persistence seam.
//!
//! ## Persistence surface (binding, G-023)
//!
//! Writes go through the `AppStore` **control plane** (`control.db` SQLite) under
//! the single key [`DOOM_SAVE_KEY`] — one atomic `INSERT ... ON CONFLICT(key) DO
//! UPDATE` ([`AppStore::control_set`]). The data plane is PostgreSQL-only and
//! fails closed while the pool is pending, so it is NOT used here.
//!
//! When the [`DOOM_SAVE_FILE_ENV`] seam is set to a non-empty path, `load`/`store`
//! use that JSON file instead (inert when unset, so the production path is
//! unchanged). File writes are **temp-file-then-rename** (atomic) and a write to
//! an unwritable path (a directory, or a missing parent) **surfaces an error**
//! rather than silently succeeding (G-300).
//!
//! ## Bounded + crash-safe (NFR-2 / NFR-3)
//!
//! One fixed key, one fixed-shape scalar object, no arrays and no append log.
//! [`DoomSave::parse`] returns `Option` and never panics: an absent, corrupt, or
//! out-of-contract save yields "no save" (a clean run). A write failure is the
//! caller's to log and ignore — it never fails the autoplay run.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::infrastructure::storage::AppStore;

use super::state::DOOM_SAVE_KEY;

// ── Pinned constants (G-255 names block — do not rename) ─────────────────────

/// The persisted save schema version. A save carrying any other version is
/// rejected by [`DoomSave::parse`] (treated as absent → clean run).
pub const DOOM_SAVE_VERSION: u32 = 1;
/// The G-275 seam: when set to a non-empty path, `load`/`store` use that JSON
/// file instead of the control plane. Inert when unset.
pub const DOOM_SAVE_FILE_ENV: &str = "FREDO_DOOM_SAVE_FILE";
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
/// One fixed-shape scalar object stored under [`DOOM_SAVE_KEY`] (or the
/// [`DOOM_SAVE_FILE_ENV`] path). `updatedAt` is an RFC3339 timestamp and
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

impl DoomSave {
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

    /// Serialize to the camelCase JSON stored under the key/seam. The shape is a
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

// ── Persistence seam ─────────────────────────────────────────────────────────

/// Resolve the [`DOOM_SAVE_FILE_ENV`] seam to a path, or `None` when unset/blank
/// (in which case the control plane is used).
fn seam_path() -> Option<PathBuf> {
    let raw = std::env::var(DOOM_SAVE_FILE_ENV).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

/// Load the persisted save, or `None` when absent/unreadable/out-of-contract.
///
/// Uses the [`DOOM_SAVE_FILE_ENV`] seam when set, else the control-plane key
/// [`DOOM_SAVE_KEY`]. Never fails: any read/parse problem is "no save".
pub fn load(store: &AppStore) -> Option<DoomSave> {
    match seam_path() {
        Some(path) => load_at_path(&path),
        None => {
            let raw = store.control_get(DOOM_SAVE_KEY).ok().flatten()?;
            DoomSave::parse(&raw)
        }
    }
}

/// Persist the save, returning an error on any failure (the caller logs and
/// ignores it — a save write never fails the autoplay run).
///
/// Uses the [`DOOM_SAVE_FILE_ENV`] seam when set (temp-file-then-rename), else
/// the atomic control-plane upsert under [`DOOM_SAVE_KEY`].
pub fn store(store: &AppStore, save: &DoomSave) -> Result<(), String> {
    match seam_path() {
        Some(path) => store_at_path(&path, save),
        None => store
            .control_set(DOOM_SAVE_KEY, &save.serialize())
            .map_err(|error| error.to_string()),
    }
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

/// Discard the persisted save (Spec #2972 `reset_doom_save`): clear the
/// control-plane key, or remove the seam file when the [`DOOM_SAVE_FILE_ENV`]
/// seam is set. Idempotent — an absent save is a no-op. A real failure is
/// returned for the caller to log; the command still reports `hasSave:false`
/// afterwards because a blank/unreadable slot parses as "no save".
pub fn clear(store: &AppStore) -> Result<(), String> {
    match seam_path() {
        Some(path) => match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("remove {}: {error}", path.display())),
        },
        None => store
            .control_set(DOOM_SAVE_KEY, "")
            .map_err(|error| error.to_string()),
    }
}

/// Read + parse a save from an explicit path (the seam-file primitive).
///
/// A missing file, a directory, an unreadable file, or out-of-contract JSON all
/// yield `None` — never a panic.
pub fn load_at_path(path: &Path) -> Option<DoomSave> {
    let text = std::fs::read_to_string(path).ok()?;
    DoomSave::parse(&text)
}

/// Write a save to an explicit path atomically via temp-file-then-rename.
///
/// A missing parent directory fails at temp-file creation; a target that is a
/// directory (or otherwise un-replaceable) fails at the rename. **Both surface
/// as `Err`** (G-300) — the write never silently "succeeds" on an unwritable
/// path. On success the target is replaced in one atomic rename.
pub fn store_at_path(path: &Path, save: &DoomSave) -> Result<(), String> {
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
    use crate::infrastructure::storage::engine::EngineHandle;

    fn open_store(dir: &Path) -> AppStore {
        AppStore::open(EngineHandle::new_pending(), dir).expect("open app store")
    }

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
        assert_eq!(DOOM_SAVE_KEY, "doom_save_v1");
        assert_eq!(DOOM_SAVE_VERSION, 1);
        assert_eq!(DOOM_SAVE_FILE_ENV, "FREDO_DOOM_SAVE_FILE");
        assert_eq!(DOOM_CAMPAIGN_FIRST_EPISODE, 1);
        assert_eq!(DOOM_CAMPAIGN_LAST_EPISODE, 4);
        assert_eq!(DOOM_CAMPAIGN_FIRST_MAP, 1);
        assert_eq!(DOOM_CAMPAIGN_LAST_MAP, 9);
        assert_eq!(DOOM_DEFAULT_SKILL, 3);
        assert_eq!(DOOM_DEFAULT_SEED, 0);
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
    fn store_and_load_round_trip_through_the_control_plane() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app_store = open_store(dir.path());
        let save = sample();

        store(&app_store, &save).expect("store");
        assert_eq!(load(&app_store), Some(save.clone()));

        // When the file seam is unset (the normal case), the record lives under
        // the single control-plane key.
        if std::env::var(DOOM_SAVE_FILE_ENV).is_err() {
            let raw = app_store
                .control_get(DOOM_SAVE_KEY)
                .expect("control read")
                .expect("present");
            assert_eq!(DoomSave::parse(&raw), Some(save));
        }
    }

    #[test]
    fn file_seam_round_trips_and_rejects_unwritable_paths() {
        let dir = tempfile::tempdir().expect("tempdir");
        let save = sample();

        // A normal file path round-trips atomically.
        let path = dir.path().join("save.json");
        store_at_path(&path, &save).expect("store at path");
        assert_eq!(load_at_path(&path), Some(save.clone()));
        // No temp file is left behind.
        assert!(!dir.path().join("save.json.tmp").exists());

        // A directory at the seam path is a write failure (G-300), not a silent
        // success.
        let as_dir = dir.path().join("save-dir");
        std::fs::create_dir(&as_dir).expect("create dir");
        assert!(store_at_path(&as_dir, &save).is_err());
        assert_eq!(load_at_path(&as_dir), None);

        // A missing parent is a write failure (G-300).
        let missing_parent = dir.path().join("no-such-dir").join("save.json");
        assert!(store_at_path(&missing_parent, &save).is_err());

        // Absent / corrupt reads are "no save", never a panic.
        assert_eq!(load_at_path(&dir.path().join("absent.json")), None);
        let corrupt = dir.path().join("corrupt.json");
        std::fs::write(&corrupt, "not json").expect("write corrupt");
        assert_eq!(load_at_path(&corrupt), None);
    }

    #[test]
    fn seam_path_is_none_when_unset_or_blank() {
        // The seam is inert in the normal test process (no test sets it).
        if std::env::var(DOOM_SAVE_FILE_ENV).is_err() {
            assert_eq!(seam_path(), None);
        }
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

    #[test]
    fn clear_discards_the_control_plane_save_idempotently() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app_store = open_store(dir.path());
        let save = sample();
        store(&app_store, &save).expect("store");
        assert_eq!(load(&app_store), Some(save));

        clear(&app_store).expect("clear");
        assert_eq!(load(&app_store), None, "a cleared slot is no save");

        // Idempotent — clearing again is a no-op.
        clear(&app_store).expect("clear again");
    }
}
