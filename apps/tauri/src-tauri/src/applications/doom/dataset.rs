//! Doom fine-tuning dataset core (Spec #3032, ST-1).
//!
//! The single producer (G-255) of the Companion's per-decision fine-tuning
//! dataset: the reconciled `DoomDatasetRecord` model (one JSON object per line),
//! the bounded **append-only** JSONL writer (`<app_data_dir>/doom-dataset/
//! doom-dataset.jsonl`), the rotate/evict retention policy with the
//! `export_in_progress` eviction deferral (AC3), and the `raw|sft|dpo` exporters
//! (AC4).
//!
//! # Storage (NO SQLite, no PG — a local file)
//!
//! The dataset is ONE local append-only JSONL under `<app_data_dir>/doom-dataset/`
//! (the app-data dir resolved through
//! [`resolve_app_data_dir`](crate::infrastructure::storage::boot_config::resolve_app_data_dir));
//! the test-only [`DOOM_DATASET_DIR_ENV`] (`FREDO_DOOM_DATASET_DIR`) overrides the
//! directory. Writes are `OpenOptions::append` only — existing lines are NEVER
//! rewritten; retention eviction (oldest rotated file first) is the ONLY deletion
//! path.
//!
//! # Bounded / best-effort
//!
//! The observation reuses the existing 8 KiB cap
//! ([`DOOM_OBSERVATION_BYTE_BUDGET`](super::perception::DOOM_OBSERVATION_BYTE_BUDGET));
//! `reasoning` is behind [`DOOM_DATASET_REASONING_ENV`] and truncated to
//! [`DOOM_DATASET_REASONING_MAX_BYTES`]; `modelRaw` is behind
//! [`DOOM_DATASET_RAW_ENV`]. No per-pixel payload ever enters a record. A write or
//! rotation failure is surfaced as an `io::Error` the caller logs and swallows —
//! it never fails the autoplay run.
//!
//! # No egress
//!
//! The export path performs ONLY local file I/O (`std::fs`): it never opens a
//! socket, spawns a process, or mutates the source files.
//!
//! # Purity / determinism
//!
//! Record assembly is a pure function of the observation/decision/execution
//! values; the ONLY clock read is the RFC3339 `ts` stamp the caller supplies (and
//! the export filename timestamp). No RNG.
//!
//! # Env seam (G-275; inert when unset)
//!
//! [`DOOM_DATASET_ENABLED_ENV`] (opt-in), [`DOOM_DATASET_DIR_ENV`] (dir override),
//! [`DOOM_DATASET_RAW_ENV`] / [`DOOM_DATASET_REASONING_ENV`] (bounded capture),
//! [`DOOM_DATASET_MAX_RECORDS_ENV`] (retention override).

use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::infrastructure::companion::doom_decision::{DoomPlan, DoomPlanStep};

// ── Pinned names / constants (Architect Names block, G-255) ───────────────────

/// Opt-in env seam: `FREDO_DOOM_DATASET_ENABLED` (default OFF; `1`/`true` enables).
pub const DOOM_DATASET_ENABLED_ENV: &str = "FREDO_DOOM_DATASET_ENABLED";
/// Test-only dataset-dir override: `FREDO_DOOM_DATASET_DIR`.
pub const DOOM_DATASET_DIR_ENV: &str = "FREDO_DOOM_DATASET_DIR";
/// Capture the raw model reply (`modelRaw`) env seam: `FREDO_DOOM_DATASET_RAW`.
pub const DOOM_DATASET_RAW_ENV: &str = "FREDO_DOOM_DATASET_RAW";
/// Capture the model `reasoning` env seam: `FREDO_DOOM_DATASET_REASONING`.
pub const DOOM_DATASET_REASONING_ENV: &str = "FREDO_DOOM_DATASET_REASONING";
/// Test-only retention-cap override: `FREDO_DOOM_DATASET_MAX_RECORDS`.
pub const DOOM_DATASET_MAX_RECORDS_ENV: &str = "FREDO_DOOM_DATASET_MAX_RECORDS";

/// The record schema version stamped on every record (`v`).
pub const DOOM_DATASET_SCHEMA_VERSION: u32 = 1;
/// The active dataset JSONL filename.
pub const DOOM_DATASET_FILE: &str = "doom-dataset.jsonl";
/// The rotated-file name prefix (`doom-dataset.<n>.jsonl`).
pub const DOOM_DATASET_ROTATION_PREFIX: &str = "doom-dataset.";
/// The dataset subdirectory under the app-data dir.
pub const DOOM_DATASET_SUBDIR: &str = "doom-dataset";
/// Rotate the active file at this many bytes (32 MiB).
pub const DOOM_DATASET_FILE_MAX_BYTES: u64 = 32 * 1024 * 1024;
/// Keep the dataset directory at or below this many bytes (256 MiB).
pub const DOOM_DATASET_MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
/// Keep the dataset directory at or below this many records (500k).
pub const DOOM_DATASET_MAX_RECORDS: u64 = 500_000;
/// Maximum captured `reasoning` length, in bytes (truncated on a char boundary).
pub const DOOM_DATASET_REASONING_MAX_BYTES: usize = 4096;
/// The exports subdirectory under the dataset dir.
pub const DOOM_DATASET_EXPORT_DIR: &str = "exports";
/// The SettingsStore settings KV key that is the SINGLE source of truth for the opt-in
/// (Rust-readable; written by `set_doom_dataset_enabled`, read by the loop).
pub const DOOM_DATASET_ENABLED_KEY: &str = "doom_dataset_enabled";

// ── Env / value parsers (pure where possible) ─────────────────────────────────

/// Whether a raw value enables a boolean capture flag: only the trimmed `"1"` or a
/// case-insensitive `"true"` enables; anything else (including unset) is OFF.
pub fn flag_from_value(value: Option<&str>) -> bool {
    match value.map(str::trim) {
        Some(value) => value == "1" || value.eq_ignore_ascii_case("true"),
        None => false,
    }
}

/// The opt-in gate from [`DOOM_DATASET_ENABLED_ENV`].
pub fn dataset_enabled_from_env() -> bool {
    flag_from_value(std::env::var(DOOM_DATASET_ENABLED_ENV).ok().as_deref())
}

/// Whether `modelRaw` capture is requested ([`DOOM_DATASET_RAW_ENV`]).
pub fn raw_capture_from_env() -> bool {
    flag_from_value(std::env::var(DOOM_DATASET_RAW_ENV).ok().as_deref())
}

/// Whether `reasoning` capture is requested ([`DOOM_DATASET_REASONING_ENV`]).
pub fn reasoning_capture_from_env() -> bool {
    flag_from_value(std::env::var(DOOM_DATASET_REASONING_ENV).ok().as_deref())
}

/// The retention-cap override from [`DOOM_DATASET_MAX_RECORDS_ENV`], if set to a
/// valid non-zero integer (inert otherwise).
pub fn max_records_from_env() -> Option<u64> {
    std::env::var(DOOM_DATASET_MAX_RECORDS_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
}

/// Truncate `value` to at most [`DOOM_DATASET_REASONING_MAX_BYTES`] bytes on a
/// UTF-8 char boundary (NFR-4 bound).
pub fn truncate_reasoning(value: &str) -> String {
    if value.len() <= DOOM_DATASET_REASONING_MAX_BYTES {
        return value.to_string();
    }
    let mut end = DOOM_DATASET_REASONING_MAX_BYTES;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

/// Resolve the dataset directory from the app-data dir + the
/// [`DOOM_DATASET_DIR_ENV`] override. A non-blank override wins (trimmed); an
/// unset/blank override uses `<app_data_dir>/doom-dataset`. Pure.
pub fn dataset_dir_from(app_data_dir: &Path, override_value: Option<&str>) -> PathBuf {
    match override_value.map(str::trim) {
        Some(value) if !value.is_empty() => PathBuf::from(value),
        _ => app_data_dir.join(DOOM_DATASET_SUBDIR),
    }
}

/// Resolve the dataset directory from the app-data dir + the process env override.
pub fn resolve_dataset_dir(app_data_dir: &Path) -> PathBuf {
    let override_value = std::env::var(DOOM_DATASET_DIR_ENV).ok();
    dataset_dir_from(app_data_dir, override_value.as_deref())
}

/// The `episodeId` correlation string: `<runId>:e<episode>-m<map>`.
pub fn episode_id_for(run_id: &str, episode: i64, map: i64) -> String {
    format!("{run_id}:e{episode}-m{map}")
}

/// The `decisionId` correlation string: `<runId>:<decisions>`.
pub fn decision_id_for(run_id: &str, decisions: u64) -> String {
    format!("{run_id}:{decisions}")
}

// ── The adopted decision (the plan, not the legacy `{tics,actions}`) ──────────

/// The plan shape of a record's `decision` field: the adopted [`DoomPlan`]'s steps.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomDatasetDecision {
    /// The plan steps as `{op,…}` objects (the `doom_plan` contract).
    pub plan: Vec<Value>,
}

/// Serialize a [`DoomPlanStep`] to its `doom_plan` `{op,…}` object. The shape
/// round-trips through
/// [`parse_doom_plan`](crate::infrastructure::companion::doom_decision::parse_doom_plan).
pub fn plan_step_to_value(step: &DoomPlanStep) -> Value {
    match step {
        DoomPlanStep::Move { bearing, distance } => json!({
            "op": "move", "bearing": bearing, "distance": distance,
        }),
        DoomPlanStep::OpenDoor { bearing } => json!({
            "op": "open-door", "bearing": bearing,
        }),
        DoomPlanStep::Shoot { tics } => json!({ "op": "shoot", "tics": tics }),
        DoomPlanStep::Wait { tics } => json!({ "op": "wait", "tics": tics }),
        DoomPlanStep::Hold { tics, actions } => json!({
            "op": "hold", "tics": tics, "actions": actions,
        }),
    }
}

/// Serialize a whole [`DoomPlan`] to the record's `decision.plan` array.
pub fn plan_steps_to_values(plan: &DoomPlan) -> Vec<Value> {
    plan.steps.iter().map(plan_step_to_value).collect()
}

// ── Record model (reconciled schema; camelCase) ───────────────────────────────

/// The level identity of a record.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomDatasetLevel {
    /// The episode (e.g. `1`).
    pub episode: i64,
    /// The map (e.g. `1`).
    pub map: i64,
    /// The skill level.
    pub skill: i64,
    /// The WAD id (e.g. `DOOM1.WAD`).
    pub wad_id: String,
}

/// The model metadata of a record. The string fields are absent for a
/// non-model source (`scripted`/`local`); `schemaVersion` is always the
/// `doom_plan` schema name.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomDatasetModel {
    /// The model id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// The llama-server flags string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_flags: Option<String>,
    /// The prompt template version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_version: Option<String>,
    /// The plan schema name (e.g. `doom_plan`).
    pub schema_version: String,
}

/// The one executed step of a plan within a record's execution.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomDatasetExecutionStep {
    /// The plan-step index.
    pub index: u32,
    /// The controller that issued the actions: `plan|legacy|reflex|fallback`.
    pub controller: String,
    /// The actions issued for this step (the engine action vocabulary).
    pub actions: Vec<Value>,
    /// The number of engine tics this step occupied.
    pub tics: u32,
}

/// One re-plan event of a record (`execution.replans[]`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomDatasetReplan {
    /// The plan-step index at which the re-plan fired.
    pub index: u32,
    /// The five-reason vocabulary: `blocked|noProgress|frontEnemy|doorClosed|exhausted`.
    pub reason: String,
    /// The engine tic of the re-plan.
    pub tic: u64,
}

/// A record's execution: the adopted→exhausted window and per-step executed actions.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomDatasetExecution {
    /// The tic the plan was adopted.
    pub adopted_tic: u64,
    /// The tic the plan left the executor (exhausted/superseded/terminal).
    pub exhausted_tic: u64,
    /// The planned step count.
    pub planned_steps: u32,
    /// The executed step count.
    pub executed_steps: u32,
    /// The per-step executed actions.
    pub steps: Vec<DoomDatasetExecutionStep>,
    /// The re-plan events (the #3039 five-reason vocabulary).
    pub replans: Vec<DoomDatasetReplan>,
}

/// The shaped reward of one decision (delta between adoption and next state).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomDatasetReward {
    /// Kill-count delta.
    pub d_kills: i64,
    /// Item-count delta.
    pub d_items: i64,
    /// Secret-count delta.
    pub d_secrets: i64,
    /// Health delta.
    pub d_health: i64,
    /// Exit-distance delta; `null` when fair-play gated (field absent).
    pub d_distance_to_exit: Option<i64>,
    /// Whether the player moved between adoption and next state.
    pub moved: bool,
}

/// A typed decision failure (`decisionError`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomDatasetDecisionError {
    /// The typed kind: `malformed|modelUnavailable|timedOut|engineError`.
    pub kind: String,
    /// A human-readable detail.
    pub detail: String,
}

/// A level result (`terminal.levelResult`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomDatasetLevelResult {
    /// The episode.
    pub episode: i64,
    /// The map.
    pub map: i64,
    /// The outcome.
    pub outcome: String,
    /// The kill count.
    pub kills: u64,
    /// The item count.
    pub items: u64,
    /// The secret count.
    pub secrets: u64,
    /// The wall-clock duration of the level, in ms.
    pub tic_ms: u64,
}

/// A terminal stamp (`terminal`); `kind` is `exited|dead|timeout|aborted`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomDatasetTerminal {
    /// The terminal kind: `exited|dead|timeout|aborted`.
    pub kind: String,
    /// The level result at termination.
    pub level_result: DoomDatasetLevelResult,
}

/// ONE per-decision fine-tuning record (one JSON object per line).
///
/// `decision` and `terminal` are always present (`null` when absent);
/// `modelRaw`, `reasoning`, and `decisionError` are omitted when absent. See the
/// module docs and the Architect's reconciled schema (G-255).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomDatasetRecord {
    /// The record schema version ([`DOOM_DATASET_SCHEMA_VERSION`]).
    pub v: u32,
    /// The run id, stamped on EVERY record (AC2 correlation).
    pub run_id: String,
    /// The per-level episode correlation (`<runId>:e<episode>-m<map>`).
    pub episode_id: String,
    /// The decision correlation (`<runId>:<decisions>`, monotonic per run).
    pub decision_id: String,
    /// The RFC3339 adoption timestamp.
    pub ts: String,
    /// The engine tic at adoption.
    pub tic: u64,
    /// The executor cursor at adoption.
    pub step_index: u32,
    /// The decision source: `model|scripted|local`.
    pub source: String,
    /// The level identity.
    pub level: DoomDatasetLevel,
    /// The model metadata.
    pub model: DoomDatasetModel,
    /// The full engine observation at adoption (incl. `walls` + `forward`).
    pub observation: Value,
    /// The adopted plan (`null` on a failed attempt).
    pub decision: Option<DoomDatasetDecision>,
    /// The raw model reply — present ONLY when `FREDO_DOOM_DATASET_RAW` is set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_raw: Option<String>,
    /// The model reasoning — present ONLY when `FREDO_DOOM_DATASET_REASONING` is set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    /// The loop-measured decision latency, in ms.
    pub latency_ms: u64,
    /// The typed decision failure — present ONLY on a failed attempt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_error: Option<DoomDatasetDecisionError>,
    /// The execution window + per-step executed actions.
    pub execution: DoomDatasetExecution,
    /// The engine observation after the last executed step (or the terminal obs).
    pub next_state: Value,
    /// The shaped reward.
    pub reward: DoomDatasetReward,
    /// The terminal stamp (`null` until the run terminates).
    pub terminal: Option<DoomDatasetTerminal>,
}

impl DoomDatasetRecord {
    /// Serialize this record to ONE line of JSON (no trailing newline).
    pub fn json_line(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// Parse one JSONL line into a record.
    pub fn from_json_line(line: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(line)
    }
}

// ── Configuration ─────────────────────────────────────────────────────────────

/// The dataset writer/retention configuration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DoomDatasetConfig {
    /// The dataset directory (the active file + rotated files live here; exports
    /// go in `<dir>/exports/`).
    pub dir: PathBuf,
    /// Rotate the active file at this many bytes.
    pub file_max_bytes: u64,
    /// Keep the directory at or below this many bytes.
    pub max_total_bytes: u64,
    /// Keep the directory at or below this many records.
    pub max_records: u64,
}

impl DoomDatasetConfig {
    /// Build a config from the dataset directory with the pinned bounds.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            file_max_bytes: DOOM_DATASET_FILE_MAX_BYTES,
            max_total_bytes: DOOM_DATASET_MAX_TOTAL_BYTES,
            max_records: DOOM_DATASET_MAX_RECORDS,
        }
    }

    /// Build a config with the [`DOOM_DATASET_MAX_RECORDS_ENV`] retention override
    /// applied (inert when unset).
    pub fn from_env(dir: impl Into<PathBuf>) -> Self {
        let mut config = Self::new(dir);
        if let Some(max_records) = max_records_from_env() {
            config.max_records = max_records;
        }
        config
    }
}

// ── Export models ─────────────────────────────────────────────────────────────

/// The export format (`raw` is the lossless default).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DoomDatasetFormat {
    /// Lossless JSONL (the concatenated source, verbatim).
    #[default]
    Raw,
    /// Supervised fine-tuning: `{prompt, completion, reward, terminal}`.
    Sft,
    /// Preference pairs: `{prompt, chosen, rejected, reward}` (skips no-replan records).
    Dpo,
}

impl DoomDatasetFormat {
    /// The wire value (`raw|sft|dpo`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Raw => "raw",
            Self::Sft => "sft",
            Self::Dpo => "dpo",
        }
    }

    /// Parse a wire value (case-insensitive, trimmed), or `None` when unknown.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "raw" => Some(Self::Raw),
            "sft" => Some(Self::Sft),
            "dpo" => Some(Self::Dpo),
            _ => None,
        }
    }

    /// The default-export filename extension.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Raw => "jsonl",
            Self::Sft => "sft.jsonl",
            Self::Dpo => "dpo.jsonl",
        }
    }
}

/// The default export filename for `format`: `doom-dataset-<ts>.<ext>`.
///
/// The default target is `<dataset dir>/exports/<this name>`. Shared by the
/// native save dialog's suggested name and [`DoomDatasetWriter::export`]'s
/// default target so the two can never drift (Spec #3078 ST-3).
pub fn default_export_name(format: DoomDatasetFormat) -> String {
    let ts = chrono::Utc::now()
        .format("%Y%m%dT%H%M%S%3fZ")
        .to_string()
        .replace('.', "");
    format!("doom-dataset-{ts}.{}", format.extension())
}

/// A successful export result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomDatasetExportResult {
    /// The format written.
    pub format: DoomDatasetFormat,
    /// The absolute path of the written file.
    pub path: String,
    /// The number of records written.
    pub records: u64,
    /// The number of bytes written.
    pub bytes: u64,
}

/// The dataset status snapshot (`get_doom_dataset_status`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomDatasetStatus {
    /// Whether capture is enabled (the opt-in gate).
    pub enabled: bool,
    /// The dataset directory.
    pub dir: String,
    /// The number of records currently on disk.
    pub records: u64,
    /// The number of bytes currently on disk.
    pub bytes: u64,
}

/// A typed dataset error (export failures; ST-3 maps these onto `DoomCommandError`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DoomDatasetError {
    /// A local file I/O failure.
    Io(String),
    /// The dataset is empty — nothing to export (no partial file is created).
    Empty,
}

impl std::fmt::Display for DoomDatasetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(detail) => write!(f, "dataset io error: {detail}"),
            Self::Empty => write!(f, "the dataset is empty — there is nothing to export"),
        }
    }
}

impl std::error::Error for DoomDatasetError {}

impl From<std::io::Error> for DoomDatasetError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

// ── The writer (append-only + retention) ──────────────────────────────────────

/// A rotated file's retention bookkeeping.
#[derive(Clone, Debug, PartialEq, Eq)]
struct RotatedFile {
    index: u64,
    bytes: u64,
    records: u64,
}

/// The writer's mutable state (guarded by one mutex).
#[derive(Debug, Default)]
struct WriterState {
    /// The number of records in the active file.
    active_records: u64,
    /// The next rotation index (`doom-dataset.<next_rotation>.jsonl`).
    next_rotation: u64,
    /// The rotated files, oldest (smallest index) first.
    rotated: Vec<RotatedFile>,
}

/// The shared writer interior.
struct Inner {
    dir: PathBuf,
    file_max_bytes: u64,
    max_total_bytes: u64,
    max_records: u64,
    /// Set for the duration of an export — DEFERS eviction (AC3).
    export_in_progress: AtomicBool,
    state: Mutex<WriterState>,
}

/// The bounded append-only dataset writer (cheap to clone — an `Arc` interior).
///
/// Construct it only when capture is enabled (R-5: a writer that is never built
/// creates no directory and no file). Moves into the autoplay loop; shared with
/// the export IPC.
#[derive(Clone)]
pub struct DoomDatasetWriter {
    inner: Arc<Inner>,
}

impl DoomDatasetWriter {
    /// Build a writer for `config`. Performs NO I/O beyond an in-memory scan of an
    /// already-existing dataset directory (to seed the retention counters); it
    /// creates NO directory and NO file (R-5).
    pub fn new(config: DoomDatasetConfig) -> Self {
        let state = scan_dir(&config.dir);
        Self {
            inner: Arc::new(Inner {
                dir: config.dir,
                file_max_bytes: config.file_max_bytes,
                max_total_bytes: config.max_total_bytes,
                max_records: config.max_records,
                export_in_progress: AtomicBool::new(false),
                state: Mutex::new(state),
            }),
        }
    }

    /// The dataset directory.
    pub fn dir(&self) -> &Path {
        &self.inner.dir
    }

    /// Append ONE record as a JSONL line. Best-effort: the caller logs and swallows
    /// a returned error (a dataset write never fails the run).
    pub fn append(&self, record: &DoomDatasetRecord) -> std::io::Result<()> {
        let line = record.json_line().map_err(|error| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string())
        })?;
        self.append_line(line.as_bytes())
    }

    /// Append one pre-serialized line (no trailing newline).
    fn append_line(&self, line: &[u8]) -> std::io::Result<()> {
        fs::create_dir_all(&self.inner.dir)?;
        let mut state = lock_state(&self.inner.state);
        let active = self.inner.dir.join(DOOM_DATASET_FILE);
        let active_bytes = fs::metadata(&active).map(|meta| meta.len()).unwrap_or(0);
        let projected = active_bytes.saturating_add(line.len() as u64);
        let over_bytes = projected > self.inner.file_max_bytes
            || projected > self.inner.max_total_bytes;
        let over_records = state.active_records >= self.inner.max_records.max(1);
        if state.active_records > 0 && (over_bytes || over_records) {
            self.rotate_locked(&mut state, &active)?;
        }

        let mut file = OpenOptions::new().create(true).append(true).open(&active)?;
        file.write_all(line)?;
        file.write_all(b"\n")?;
        file.flush()?;
        state.active_records += 1;
        self.enforce_retention_locked(&mut state);
        Ok(())
    }

    /// Seal the active file into the next `doom-dataset.<n>.jsonl`.
    fn rotate_locked(&self, state: &mut WriterState, active: &Path) -> std::io::Result<()> {
        let index = state.next_rotation;
        let target = self
            .inner
            .dir
            .join(format!("{DOOM_DATASET_ROTATION_PREFIX}{index}.jsonl"));
        fs::rename(active, &target)?;
        let bytes = fs::metadata(&target).map(|meta| meta.len()).unwrap_or(0);
        state.rotated.push(RotatedFile {
            index,
            bytes,
            records: state.active_records,
        });
        state.next_rotation = index + 1;
        state.active_records = 0;
        Ok(())
    }

    /// Evict the oldest rotated files until the directory is within bounds.
    /// DEFERS entirely while an export is in progress (AC3).
    fn enforce_retention_locked(&self, state: &mut WriterState) {
        if self.inner.export_in_progress.load(Ordering::SeqCst) {
            return;
        }
        let active = self.inner.dir.join(DOOM_DATASET_FILE);
        let mut total_bytes = fs::metadata(&active).map(|meta| meta.len()).unwrap_or(0)
            + state.rotated.iter().map(|file| file.bytes).sum::<u64>();
        let mut total_records =
            state.active_records + state.rotated.iter().map(|file| file.records).sum::<u64>();
        while (total_bytes > self.inner.max_total_bytes
            || total_records > self.inner.max_records)
            && !state.rotated.is_empty()
        {
            let oldest = state.rotated.remove(0);
            let path = self
                .inner
                .dir
                .join(format!("{DOOM_DATASET_ROTATION_PREFIX}{}.jsonl", oldest.index));
            let _ = fs::remove_file(&path);
            total_bytes = total_bytes.saturating_sub(oldest.bytes);
            total_records = total_records.saturating_sub(oldest.records);
        }
    }

    /// The current on-disk `(records, bytes)` (active + rotated).
    pub fn counts(&self) -> (u64, u64) {
        let state = lock_state(&self.inner.state);
        let active = self.inner.dir.join(DOOM_DATASET_FILE);
        let active_bytes = fs::metadata(&active).map(|meta| meta.len()).unwrap_or(0);
        let rotated_bytes: u64 = state.rotated.iter().map(|file| file.bytes).sum();
        let rotated_records: u64 = state.rotated.iter().map(|file| file.records).sum();
        (
            state.active_records + rotated_records,
            active_bytes + rotated_bytes,
        )
    }

    /// Build the dataset status snapshot for the given opt-in `enabled` value.
    pub fn status(&self, enabled: bool) -> DoomDatasetStatus {
        let (records, bytes) = self.counts();
        DoomDatasetStatus {
            enabled,
            dir: self.inner.dir.to_string_lossy().into_owned(),
            records,
            bytes,
        }
    }

    /// The fixed, ordered snapshot of source files for an export: rotated files
    /// oldest-first, then the active file. Taken once per export so no referenced
    /// record is resolved mid-copy.
    fn file_snapshot(&self) -> Vec<PathBuf> {
        let state = lock_state(&self.inner.state);
        let mut rotated: Vec<&RotatedFile> = state.rotated.iter().collect();
        rotated.sort_by_key(|file| file.index);
        let mut files: Vec<PathBuf> = rotated
            .into_iter()
            .map(|file| {
                self.inner
                    .dir
                    .join(format!("{DOOM_DATASET_ROTATION_PREFIX}{}.jsonl", file.index))
            })
            .collect();
        files.push(self.inner.dir.join(DOOM_DATASET_FILE));
        files
    }

    /// The default export path: `<dir>/exports/doom-dataset-<ts>.<ext>`.
    fn default_export_path(&self, format: DoomDatasetFormat) -> PathBuf {
        self.inner
            .dir
            .join(DOOM_DATASET_EXPORT_DIR)
            .join(default_export_name(format))
    }

    /// Export the dataset in `format` to `out` (or the default
    /// `<dir>/exports/...` path). Sets the `export_in_progress` guard for the whole
    /// copy (deferring eviction), reads a fixed file-list snapshot, writes ONLY the
    /// target file (atomically: temp then rename — no partial file), and never
    /// mutates a source file or performs network I/O.
    pub fn export(
        &self,
        format: DoomDatasetFormat,
        out: Option<&Path>,
    ) -> Result<DoomDatasetExportResult, DoomDatasetError> {
        let _guard = ExportGuard::engage(&self.inner.export_in_progress);
        let files = self.file_snapshot();
        let content = self.build_export(format, &files)?;

        let target = match out {
            Some(path) => path.to_path_buf(),
            None => self.default_export_path(format),
        };
        if let Some(parent) = target.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        let tmp = temp_sibling(&target);
        if let Err(error) = write_chunks(&tmp, &content) {
            let _ = fs::remove_file(&tmp);
            return Err(error);
        }
        fs::rename(&tmp, &target).map_err(|error| {
            let _ = fs::remove_file(&tmp);
            DoomDatasetError::Io(format!(
                "rename {} -> {}: {error}",
                tmp.display(),
                target.display()
            ))
        })?;
        let bytes = fs::metadata(&target).map(|meta| meta.len()).unwrap_or(0);
        Ok(DoomDatasetExportResult {
            format,
            path: target.to_string_lossy().into_owned(),
            records: content.records,
            bytes,
        })
    }

    /// Build the export content (chunks + record count) from the file snapshot.
    /// An empty dataset is a typed [`DoomDatasetError::Empty`] (no file is written).
    fn build_export(
        &self,
        format: DoomDatasetFormat,
        files: &[PathBuf],
    ) -> Result<ExportContent, DoomDatasetError> {
        let mut chunks: Vec<String> = Vec::new();
        let mut records: u64 = 0;
        for path in files {
            let Ok(text) = fs::read_to_string(path) else {
                // A file rotated/evicted between the snapshot and the read is
                // skipped (best-effort); the snapshot is otherwise stable.
                continue;
            };
            match format {
                DoomDatasetFormat::Raw => {
                    let count = text.lines().filter(|line| !line.trim().is_empty()).count() as u64;
                    if count == 0 {
                        continue;
                    }
                    records += count;
                    chunks.push(text);
                }
                DoomDatasetFormat::Sft | DoomDatasetFormat::Dpo => {
                    for line in text.lines() {
                        let line = line.trim();
                        if line.is_empty() {
                            continue;
                        }
                        let Ok(record) = DoomDatasetRecord::from_json_line(line) else {
                            continue;
                        };
                        let shaped = if format == DoomDatasetFormat::Sft {
                            Some(sft_record(&record))
                        } else {
                            dpo_record(&record)
                        };
                        if let Some(value) = shaped {
                            let json = serde_json::to_string(&value)
                                .map_err(|error| DoomDatasetError::Io(error.to_string()))?;
                            chunks.push(json);
                            records += 1;
                        }
                    }
                }
            }
        }
        if records == 0 {
            return Err(DoomDatasetError::Empty);
        }
        Ok(ExportContent { chunks, records })
    }
}

/// The built export content.
struct ExportContent {
    chunks: Vec<String>,
    records: u64,
}

/// An RAII guard that sets/clears the export-in-progress flag.
struct ExportGuard<'a> {
    flag: &'a AtomicBool,
}

impl<'a> ExportGuard<'a> {
    fn engage(flag: &'a AtomicBool) -> Self {
        flag.store(true, Ordering::SeqCst);
        Self { flag }
    }
}

impl Drop for ExportGuard<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

/// Lock the writer state, recovering from a poisoned mutex (never panics).
fn lock_state(state: &Mutex<WriterState>) -> std::sync::MutexGuard<'_, WriterState> {
    state.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// Seed the retention state from an already-existing dataset directory (no write).
fn scan_dir(dir: &Path) -> WriterState {
    let mut state = WriterState::default();
    let mut max_index: Option<u64> = None;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if name == DOOM_DATASET_FILE {
                state.active_records = count_records(&entry.path());
                continue;
            }
            if let Some(index) = rotation_index(&name) {
                let bytes = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
                let records = count_records(&entry.path());
                state.rotated.push(RotatedFile {
                    index,
                    bytes,
                    records,
                });
                max_index = Some(max_index.map_or(index, |current| current.max(index)));
            }
        }
    }
    state.rotated.sort_by_key(|file| file.index);
    state.next_rotation = max_index.map_or(0, |index| index + 1);
    state
}

/// Parse a rotated filename (`doom-dataset.<n>.jsonl`) to its index, or `None`.
fn rotation_index(name: &str) -> Option<u64> {
    let remainder = name.strip_prefix(DOOM_DATASET_ROTATION_PREFIX)?;
    let digits = remainder.strip_suffix(".jsonl")?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Count the non-empty (complete) records in a file.
fn count_records(path: &Path) -> u64 {
    fs::read_to_string(path)
        .map(|text| text.lines().filter(|line| !line.trim().is_empty()).count() as u64)
        .unwrap_or(0)
}

/// A sibling temp path for an atomic write (`<name>.tmp`).
fn temp_sibling(target: &Path) -> PathBuf {
    let mut name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "doom-dataset".to_string());
    name.push_str(".tmp");
    target.with_file_name(name)
}

/// Write the export chunks to `tmp`, separating chunks with a newline.
fn write_chunks(tmp: &Path, content: &ExportContent) -> Result<(), DoomDatasetError> {
    let file = fs::File::create(tmp)?;
    let mut out = BufWriter::new(file);
    for chunk in &content.chunks {
        out.write_all(chunk.as_bytes())?;
        if !chunk.ends_with('\n') {
            out.write_all(b"\n")?;
        }
    }
    out.flush()?;
    Ok(())
}

/// The `sft` shape: `{prompt, completion, reward, terminal}`.
fn sft_record(record: &DoomDatasetRecord) -> Value {
    json!({
        "prompt": {
            "level": record.level,
            "model": record.model,
            "observation": record.observation,
        },
        "completion": record.decision.as_ref().map(|decision| decision.plan.clone()),
        "reward": record.reward,
        "terminal": record.terminal,
    })
}

/// The `dpo` shape: `{prompt, chosen, rejected, reward}` — `None` for a record
/// without a re-plan (those are skipped in `dpo`).
fn dpo_record(record: &DoomDatasetRecord) -> Option<Value> {
    let replan = record.execution.replans.first()?;
    Some(json!({
        "prompt": {
            "level": record.level,
            "model": record.model,
            "observation": record.observation,
        },
        "chosen": record.decision.as_ref().map(|decision| decision.plan.clone()),
        "rejected": {
            "reason": replan.reason,
            "index": replan.index,
            "tic": replan.tic,
        },
        "reward": record.reward,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::infrastructure::companion::doom_decision::{
        parse_doom_plan, DOOM_PLAN_SCHEMA_NAME,
    };

    fn sample_observation() -> Value {
        json!({
            "tic": 10,
            "done": false,
            "level": { "episode": 1, "map": 1 },
            "player": { "x": 0, "y": 0, "angle": 90 },
            "walls": [],
            "forward": { "rays": [], "openings": [], "doorBearings": [], "exitBearing": 0 },
        })
    }

    fn sample_record(decision: u64) -> DoomDatasetRecord {
        DoomDatasetRecord {
            v: DOOM_DATASET_SCHEMA_VERSION,
            run_id: "run-1".to_string(),
            episode_id: episode_id_for("run-1", 1, 1),
            decision_id: decision_id_for("run-1", decision),
            ts: "2026-10-12T00:00:00Z".to_string(),
            tic: 10,
            step_index: 0,
            source: "scripted".to_string(),
            level: DoomDatasetLevel {
                episode: 1,
                map: 1,
                skill: 3,
                wad_id: "DOOM1.WAD".to_string(),
            },
            model: DoomDatasetModel {
                id: None,
                server_flags: None,
                prompt_version: None,
                schema_version: DOOM_PLAN_SCHEMA_NAME.to_string(),
            },
            observation: sample_observation(),
            decision: Some(DoomDatasetDecision {
                plan: plan_steps_to_values(&DoomPlan {
                    steps: vec![DoomPlanStep::Move {
                        bearing: 90,
                        distance: 256,
                    }],
                }),
            }),
            model_raw: None,
            reasoning: None,
            latency_ms: 12,
            decision_error: None,
            execution: DoomDatasetExecution {
                adopted_tic: 10,
                exhausted_tic: 11,
                planned_steps: 1,
                executed_steps: 1,
                steps: vec![DoomDatasetExecutionStep {
                    index: 0,
                    controller: "plan".to_string(),
                    actions: vec![json!({ "type": "forward", "amount": 1 })],
                    tics: 1,
                }],
                replans: Vec::new(),
            },
            next_state: sample_observation(),
            reward: DoomDatasetReward {
                d_kills: 1,
                d_items: 0,
                d_secrets: 0,
                d_health: -12,
                d_distance_to_exit: None,
                moved: true,
            },
            terminal: None,
        }
    }

    fn temp_writer(file_max_bytes: u64, max_total_bytes: u64, max_records: u64) -> (tempfile::TempDir, DoomDatasetWriter) {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = DoomDatasetConfig {
            dir: dir.path().to_path_buf(),
            file_max_bytes,
            max_total_bytes,
            max_records,
        };
        (dir, DoomDatasetWriter::new(config))
    }

    // ── Pinned constants ─────────────────────────────────────────────────────

    #[test]
    fn the_pinned_constants_match_the_names_block() {
        assert_eq!(DOOM_DATASET_ENABLED_ENV, "FREDO_DOOM_DATASET_ENABLED");
        assert_eq!(DOOM_DATASET_DIR_ENV, "FREDO_DOOM_DATASET_DIR");
        assert_eq!(DOOM_DATASET_RAW_ENV, "FREDO_DOOM_DATASET_RAW");
        assert_eq!(DOOM_DATASET_REASONING_ENV, "FREDO_DOOM_DATASET_REASONING");
        assert_eq!(DOOM_DATASET_MAX_RECORDS_ENV, "FREDO_DOOM_DATASET_MAX_RECORDS");
        assert_eq!(DOOM_DATASET_SCHEMA_VERSION, 1);
        assert_eq!(DOOM_DATASET_FILE, "doom-dataset.jsonl");
        assert_eq!(DOOM_DATASET_ROTATION_PREFIX, "doom-dataset.");
        assert_eq!(DOOM_DATASET_SUBDIR, "doom-dataset");
        assert_eq!(DOOM_DATASET_FILE_MAX_BYTES, 32 * 1024 * 1024);
        assert_eq!(DOOM_DATASET_MAX_TOTAL_BYTES, 256 * 1024 * 1024);
        assert_eq!(DOOM_DATASET_MAX_RECORDS, 500_000);
        assert_eq!(DOOM_DATASET_REASONING_MAX_BYTES, 4096);
        assert_eq!(DOOM_DATASET_EXPORT_DIR, "exports");
        assert_eq!(DOOM_DATASET_ENABLED_KEY, "doom_dataset_enabled");
    }

    #[test]
    fn the_format_wire_values_and_defaults_are_pinned() {
        assert_eq!(DoomDatasetFormat::default(), DoomDatasetFormat::Raw);
        assert_eq!(DoomDatasetFormat::Raw.as_str(), "raw");
        assert_eq!(DoomDatasetFormat::Sft.as_str(), "sft");
        assert_eq!(DoomDatasetFormat::Dpo.as_str(), "dpo");
        assert_eq!(DoomDatasetFormat::parse(" RAW "), Some(DoomDatasetFormat::Raw));
        assert_eq!(DoomDatasetFormat::parse("sft"), Some(DoomDatasetFormat::Sft));
        assert_eq!(DoomDatasetFormat::parse("dpo"), Some(DoomDatasetFormat::Dpo));
        assert_eq!(DoomDatasetFormat::parse("nope"), None);
        // camelCase IPC serialization.
        assert_eq!(
            serde_json::to_string(&DoomDatasetFormat::Raw).expect("serialize"),
            "\"raw\""
        );
        assert_eq!(
            serde_json::from_str::<DoomDatasetFormat>("\"dpo\"").expect("deserialize"),
            DoomDatasetFormat::Dpo
        );
    }

    // ── Env / value parsers ──────────────────────────────────────────────────

    #[test]
    fn the_flag_and_dir_and_cap_parsers_are_pure_and_inert_when_unset() {
        assert!(!flag_from_value(None));
        assert!(!flag_from_value(Some("")));
        assert!(!flag_from_value(Some("0")));
        assert!(!flag_from_value(Some("nope")));
        assert!(flag_from_value(Some("1")));
        assert!(flag_from_value(Some(" true ")));
        assert!(flag_from_value(Some("TRUE")));

        let base = Path::new("C:/appdata");
        assert_eq!(
            dataset_dir_from(base, None),
            PathBuf::from("C:/appdata/doom-dataset")
        );
        assert_eq!(
            dataset_dir_from(base, Some("  ")),
            PathBuf::from("C:/appdata/doom-dataset")
        );
        assert_eq!(
            dataset_dir_from(base, Some("  C:/fixture  ")),
            PathBuf::from("C:/fixture")
        );
    }

    #[test]
    fn truncate_reasoning_bounds_to_the_max_bytes_on_a_char_boundary() {
        let short = "short";
        assert_eq!(truncate_reasoning(short), "short");

        let long = "a".repeat(DOOM_DATASET_REASONING_MAX_BYTES + 100);
        assert_eq!(truncate_reasoning(&long).len(), DOOM_DATASET_REASONING_MAX_BYTES);

        // A multi-byte char straddling the boundary must not be split.
        let mut multibyte = "é".repeat(DOOM_DATASET_REASONING_MAX_BYTES);
        multibyte.push('x');
        let truncated = truncate_reasoning(&multibyte);
        assert!(truncated.len() <= DOOM_DATASET_REASONING_MAX_BYTES);
        assert!(std::str::from_utf8(truncated.as_bytes()).is_ok());
    }

    #[test]
    fn correlation_ids_are_pinned() {
        assert_eq!(episode_id_for("abc", 1, 2), "abc:e1-m2");
        assert_eq!(decision_id_for("abc", 42), "abc:42");
    }

    // ── Record model (serde round-trip) ──────────────────────────────────────

    #[test]
    fn a_record_round_trips_through_serde_json() {
        let record = sample_record(42);
        let line = record.json_line().expect("serialize");
        let parsed = DoomDatasetRecord::from_json_line(&line).expect("deserialize");
        assert_eq!(parsed, record);
    }

    #[test]
    fn the_record_uses_camel_case_keys_and_omits_the_optional_fields() {
        let record = sample_record(1);
        let value: Value = serde_json::to_value(&record).expect("to value");
        let object = value.as_object().expect("object");

        // camelCase correlation keys.
        for key in [
            "runId",
            "episodeId",
            "decisionId",
            "stepIndex",
            "modelRaw",
            "latencyMs",
            "decisionError",
            "nextState",
        ] {
            assert!(
                object.contains_key(key) || key == "modelRaw" || key == "decisionError",
                "expected key {key}"
            );
        }
        assert_eq!(value["runId"], "run-1");
        assert_eq!(value["source"], "scripted");
        assert_eq!(value["level"]["wadId"], "DOOM1.WAD");
        assert_eq!(value["model"]["schemaVersion"], "doom_plan");
        assert_eq!(value["reward"]["dDistanceToExit"], Value::Null);
        assert_eq!(value["reward"]["moved"], true);

        // `decision` and `terminal` are always present (null when absent).
        assert!(object.contains_key("decision"));
        assert!(object.contains_key("terminal"));
        assert_eq!(value["terminal"], Value::Null);

        // The optional fields are OMITTED when absent.
        assert!(!object.contains_key("modelRaw"));
        assert!(!object.contains_key("reasoning"));
        assert!(!object.contains_key("decisionError"));

        // `model` string fields are omitted for a non-model source.
        assert!(value["model"].get("id").is_none());
        assert!(value["model"].get("serverFlags").is_none());
        assert!(value["model"].get("promptVersion").is_none());
    }

    #[test]
    fn plan_steps_serialize_to_the_shapes_the_parser_accepts() {
        let plan = DoomPlan {
            steps: vec![
                DoomPlanStep::Move {
                    bearing: 90,
                    distance: 256,
                },
                DoomPlanStep::OpenDoor { bearing: 270 },
                DoomPlanStep::Shoot { tics: 20 },
                DoomPlanStep::Wait { tics: 35 },
            ],
        };
        let values = plan_steps_to_values(&plan);
        assert_eq!(
            values[0],
            json!({ "op": "move", "bearing": 90, "distance": 256 })
        );
        assert_eq!(values[1], json!({ "op": "open-door", "bearing": 270 }));
        assert_eq!(values[2], json!({ "op": "shoot", "tics": 20 }));
        assert_eq!(values[3], json!({ "op": "wait", "tics": 35 }));

        // The serialized steps round-trip through the shared plan parser.
        let reparsed = parse_doom_plan(&json!({ "steps": values })).expect("re-parse");
        assert_eq!(reparsed.steps, plan.steps);
    }

    // ── Writer: append-only, rotation, retention ─────────────────────────────

    #[test]
    fn a_fresh_writer_creates_no_directory_or_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dataset = dir.path().join("doom-dataset");
        let writer = DoomDatasetWriter::new(DoomDatasetConfig::new(&dataset));
        assert!(!dataset.exists(), "no directory before the first append");
        assert_eq!(writer.counts(), (0, 0));
    }

    #[test]
    fn the_writer_appends_without_rewriting() {
        let (dir, writer) = temp_writer(
            DOOM_DATASET_FILE_MAX_BYTES,
            DOOM_DATASET_MAX_TOTAL_BYTES,
            DOOM_DATASET_MAX_RECORDS,
        );
        let first = sample_record(1);
        let second = sample_record(2);
        writer.append(&first).expect("append 1");
        writer.append(&second).expect("append 2");

        let active = dir.path().join(DOOM_DATASET_FILE);
        let text = fs::read_to_string(&active).expect("read active");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2, "exactly one line per record");
        // The first line is byte-identical after the second append (no rewrite).
        assert_eq!(lines[0], first.json_line().expect("line 1"));
        assert_eq!(lines[1], second.json_line().expect("line 2"));
        assert_eq!(writer.counts().0, 2);
    }

    #[test]
    fn the_writer_rotates_at_the_file_byte_bound() {
        // A tiny byte bound forces rotation before the second record.
        let first = sample_record(1);
        let line_len = first.json_line().expect("line").len() as u64;
        let (dir, writer) = temp_writer(line_len + 1, DOOM_DATASET_MAX_TOTAL_BYTES, DOOM_DATASET_MAX_RECORDS);
        writer.append(&first).expect("append 1");
        writer.append(&sample_record(2)).expect("append 2");

        let rotated = dir.path().join(format!("{DOOM_DATASET_ROTATION_PREFIX}0.jsonl"));
        assert!(rotated.exists(), "the first record rotated into doom-dataset.0.jsonl");
        let active = dir.path().join(DOOM_DATASET_FILE);
        assert!(active.exists(), "a fresh active file exists");
        // No record was lost.
        assert_eq!(writer.counts().0, 2);
        // The rotated file holds the FIRST record verbatim.
        let rotated_text = fs::read_to_string(&rotated).expect("read rotated");
        assert_eq!(rotated_text.lines().next(), Some(first.json_line().expect("line").as_str()));
    }

    #[test]
    fn the_writer_bounds_the_record_cap_and_defers_eviction_under_an_export() {
        // max_records = 2 → the directory never holds more than 2 records.
        let (dir, writer) = temp_writer(DOOM_DATASET_FILE_MAX_BYTES, DOOM_DATASET_MAX_TOTAL_BYTES, 2);
        for decision in 0..2 {
            writer.append(&sample_record(decision)).expect("append");
        }
        assert_eq!(writer.counts().0, 2, "exactly at the cap is retained");

        // Set the export-in-progress guard directly, then append past the cap:
        // eviction is DEFERRED, so the directory may exceed the cap and no file is
        // deleted.
        writer.inner.export_in_progress.store(true, Ordering::SeqCst);
        for decision in 2..5 {
            writer.append(&sample_record(decision)).expect("append under export");
        }
        let rotated_under_export = count_rotated_files(dir.path());
        assert!(
            writer.counts().0 > 2,
            "eviction is deferred while an export is in progress"
        );
        assert!(
            rotated_under_export >= 1,
            "a rotation happened but no eviction deleted it"
        );

        // Clear the guard and append again: eviction resumes and re-bounds.
        writer.inner.export_in_progress.store(false, Ordering::SeqCst);
        writer.append(&sample_record(5)).expect("append");
        assert!(
            writer.counts().0 <= 2,
            "eviction re-bounds the directory once the export completes"
        );
    }

    #[test]
    fn the_writer_bounds_the_total_byte_cap() {
        let record = sample_record(0);
        let line_len = record.json_line().expect("line").len() as u64;
        // Allow a single record but not two, via the total-byte bound.
        let (dir, writer) = temp_writer(DOOM_DATASET_FILE_MAX_BYTES, line_len + 1, DOOM_DATASET_MAX_RECORDS);
        for decision in 0..4 {
            writer.append(&sample_record(decision)).expect("append");
        }
        let (_, bytes) = writer.counts();
        // Bounded to a single record (~ the byte cap), never unbounded.
        assert!(bytes <= 2 * line_len, "the total-byte cap bounds the directory");
        assert!(count_rotated_files(dir.path()) <= 1);
    }

    fn count_rotated_files(dir: &Path) -> usize {
        fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|entry| {
                        entry
                            .file_name()
                            .to_str()
                            .and_then(rotation_index)
                            .is_some()
                    })
                    .count()
            })
            .unwrap_or(0)
    }

    // ── Exporters ────────────────────────────────────────────────────────────

    fn seeded_writer() -> (tempfile::TempDir, DoomDatasetWriter) {
        let (dir, writer) = temp_writer(
            DOOM_DATASET_FILE_MAX_BYTES,
            DOOM_DATASET_MAX_TOTAL_BYTES,
            DOOM_DATASET_MAX_RECORDS,
        );
        // Record 0: plain. Record 1: carries a re-plan (dpo-eligible).
        writer.append(&sample_record(0)).expect("append 0");
        let mut second = sample_record(1);
        second.execution.replans.push(DoomDatasetReplan {
            index: 1,
            reason: "frontEnemy".to_string(),
            tic: 99,
        });
        writer.append(&second).expect("append 1");
        (dir, writer)
    }

    #[test]
    fn the_raw_exporter_writes_the_source_verbatim() {
        let (dir, writer) = seeded_writer();
        let out = dir.path().join("raw.jsonl");
        let result = writer
            .export(DoomDatasetFormat::Raw, Some(&out))
            .expect("export raw");
        assert_eq!(result.format, DoomDatasetFormat::Raw);
        assert_eq!(result.records, 2);

        let source = fs::read_to_string(dir.path().join(DOOM_DATASET_FILE)).expect("source");
        let exported = fs::read_to_string(&out).expect("exported");
        assert_eq!(exported, source, "raw is the JSONL verbatim");
    }

    #[test]
    fn the_sft_exporter_writes_the_declared_shape() {
        let (dir, writer) = seeded_writer();
        let out = dir.path().join("sft.jsonl");
        let result = writer
            .export(DoomDatasetFormat::Sft, Some(&out))
            .expect("export sft");
        assert_eq!(result.records, 2);

        let text = fs::read_to_string(&out).expect("read sft");
        for line in text.lines() {
            let value: Value = serde_json::from_str(line).expect("sft line json");
            let object = value.as_object().expect("object");
            assert!(object.contains_key("prompt"));
            assert!(object.contains_key("completion"));
            assert!(object.contains_key("reward"));
            assert!(object.contains_key("terminal"));
            assert!(value["prompt"].get("observation").is_some());
            assert!(value["prompt"].get("level").is_some());
            assert!(value["prompt"].get("model").is_some());
        }
    }

    #[test]
    fn the_dpo_exporter_skip_records_without_a_replan_and_writes_its_shape() {
        let (dir, writer) = seeded_writer();
        let out = dir.path().join("dpo.jsonl");
        let result = writer
            .export(DoomDatasetFormat::Dpo, Some(&out))
            .expect("export dpo");
        assert_eq!(result.records, 1, "only the record with a replan is exported");

        let text = fs::read_to_string(&out).expect("read dpo");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 1);
        let value: Value = serde_json::from_str(lines[0]).expect("dpo line json");
        let object = value.as_object().expect("object");
        assert!(object.contains_key("prompt"));
        assert!(object.contains_key("chosen"));
        assert!(object.contains_key("rejected"));
        assert!(object.contains_key("reward"));
        assert_eq!(value["rejected"]["reason"], "frontEnemy");
    }

    #[test]
    fn the_default_export_writes_into_the_exports_subdir() {
        let (dir, writer) = seeded_writer();
        let result = writer
            .export(DoomDatasetFormat::Raw, None)
            .expect("export default");
        let path = PathBuf::from(&result.path);
        assert!(path.starts_with(dir.path().join(DOOM_DATASET_EXPORT_DIR)));
        assert!(path.exists());
    }

    #[test]
    fn export_never_mutates_the_source_and_reports_bytes() {
        let (dir, writer) = seeded_writer();
        let source_path = dir.path().join(DOOM_DATASET_FILE);
        let before = fs::read(&source_path).expect("read before");
        let out = dir.path().join("copy.jsonl");
        let result = writer
            .export(DoomDatasetFormat::Raw, Some(&out))
            .expect("export");
        let after = fs::read(&source_path).expect("read after");
        assert_eq!(before, after, "the export must not mutate the source");
        assert_eq!(result.bytes, fs::metadata(&out).expect("meta").len());
    }

    #[test]
    fn export_preserves_records_referenced_across_a_rotation() {
        // Snapshot the source records, export, then confirm every referenced record
        // is still present on disk (the source file is never deleted by an export).
        let (dir, writer) = seeded_writer();
        let out = dir.path().join("snapshot.jsonl");
        writer
            .export(DoomDatasetFormat::Raw, Some(&out))
            .expect("export");
        let exported = fs::read_to_string(&out).expect("read exported");
        let reexport = fs::read_to_string(dir.path().join(DOOM_DATASET_FILE)).expect("read source");
        // Every exported record is still present in the source (nothing deleted).
        for line in exported.lines() {
            assert!(reexport.contains(line), "a referenced record was removed");
        }
    }

    #[test]
    fn exporting_an_empty_dataset_is_a_typed_error_with_no_partial_file() {
        let (dir, writer) = temp_writer(
            DOOM_DATASET_FILE_MAX_BYTES,
            DOOM_DATASET_MAX_TOTAL_BYTES,
            DOOM_DATASET_MAX_RECORDS,
        );
        let out = dir.path().join("empty.jsonl");
        let result = writer.export(DoomDatasetFormat::Raw, Some(&out));
        assert_eq!(result, Err(DoomDatasetError::Empty));
        assert!(!out.exists(), "no partial file is created for an empty export");
    }

    #[test]
    fn an_unwritable_target_is_a_typed_error_with_no_partial_file() {
        let (_dir, writer) = seeded_writer();
        // A directory as the target file cannot be created as a file.
        let bad = tempfile::tempdir().expect("tempdir");
        let result = writer.export(DoomDatasetFormat::Raw, Some(bad.path()));
        assert!(matches!(result, Err(DoomDatasetError::Io(_))));
    }

    #[test]
    fn the_writer_scans_a_pre_existing_directory_on_construction() {
        // A fresh writer over an existing dir seeds its retention counters.
        let dir = tempfile::tempdir().expect("tempdir");
        let dataset = dir.path().join("doom-dataset");
        {
            let writer = DoomDatasetWriter::new(DoomDatasetConfig::new(&dataset));
            writer.append(&sample_record(0)).expect("append 0");
            writer.append(&sample_record(1)).expect("append 1");
        }
        let reopened = DoomDatasetWriter::new(DoomDatasetConfig::new(&dataset));
        assert_eq!(reopened.counts().0, 2, "the existing records are counted");
    }
}
