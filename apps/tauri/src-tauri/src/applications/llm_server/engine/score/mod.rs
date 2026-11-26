//! Companion scoring harness — shared types (Spec #3232, ST-1).
//!
//! The harness scores the companion against a **committed fixture set** so every
//! engine tuning change is judged by a measured regression instead of an
//! anecdote. This module owns the types every other part of the harness consumes
//! (the fixture set, the structural expectation model, the result record, the
//! printed report, the skip report); the runner, baseline comparison, persistence
//! and the CLI subcommand live in their own sibling modules.
//!
//! ## One request vocabulary (AC-1)
//!
//! A fixture is a [`ScoreFixture`] whose `turn` is the product's OWN
//! [`ChatTurn`](super::request::ChatTurn). There is deliberately **no
//! OpenAI-shaped request fixture and no parallel request model** anywhere in this
//! harness: the runner drives the same `ChatTurn` → `CompanionEngineHandle` seam
//! the shipped chat command drives, and fixtures are shaped by the same
//! producers (`skills::skill_turn`, `doom_agent::doom_turn`). The absence is
//! enforced by a committed static scan pinned in [`fixtures`]'s tests.
//!
//! ## Structural expectations only (AC-2)
//!
//! An [`Expectation`] is a structural predicate — an expected tool call (name +
//! required arguments) or a schema-validity predicate (top-level required fields
//! present). It is never prose and never a second model. [`expect`] owns the
//! evaluator.
//!
//! ## Determinism (AC-3)
//!
//! Each fixture carries a committed `seed`. The runner passes it as
//! [`ChatRequest.seed`](super::ChatRequest) and records it with the result, so a
//! re-run of an unchanged tree reproduces the same pass set.

pub mod baseline;
pub mod expect;
pub mod fixtures;
pub mod persist;

use serde::{Deserialize, Serialize};

use super::request::ChatTurn;

/// The models-dir lever the skip path names (AC-5). The engine's own rule: when
/// set (non-blank) it overrides the default `<home>/fredo-models`.
pub const MODELS_DIR_LEVER: &str = "FREDO_COMPANION_MODELS_DIR";

/// The hard cap on the committed fixture set (the bounded NFR for this slice),
/// so the harness stays a scoring harness and never grows into a benchmark suite.
pub const MAX_FIXTURES: usize = 20;

/// One committed fixture: the id the baseline is keyed by, the pinned seed, the
/// [`ChatTurn`] to drive, and the structural expectation that decides its result.
///
/// A fixture is built from the product's own turn type (AC-1) — never an
/// OpenAI-shaped request body.
#[derive(Debug, Clone, PartialEq)]
pub struct ScoreFixture {
    /// Kebab-case fixture id; the baseline and the persisted record are keyed by it.
    pub id: &'static str,
    /// The committed sampling seed, passed as `ChatRequest.seed`.
    pub seed: u32,
    /// The turn to drive through the engine.
    pub turn: ChatTurn,
    /// How this fixture's outcome is scored.
    pub expect: Expectation,
}

/// The structural expectation for one fixture (AC-2).
///
/// Deliberately a closed two-variant set: a run is decided by comparing the
/// turn's outcome against one of these — never by a human reading text and never
/// by a second model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expectation {
    /// The turn must produce a tool call with this name and these required
    /// argument key/value pairs. `required_args` values are compared as exact
    /// strings (the JSON argument value must be that string).
    Call {
        /// The tool name the turn must call.
        name: &'static str,
        /// The `(key, value)` argument pairs the call must carry.
        required_args: &'static [(&'static str, &'static str)],
    },
    /// The turn must produce a JSON object (its text content) carrying every
    /// named top-level required field. `name` identifies the schema for the
    /// record/messages; the predicate is field presence on the top-level object.
    Schema {
        /// The schema name (e.g. `fredo_reply`, `doom_plan`).
        name: &'static str,
        /// The top-level required field names that must be present.
        require: &'static [&'static str],
    },
}

/// The harness status the printed report carries (AC-2 vs AC-5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScoreStatus {
    /// The fixture set ran and every fixture was scored.
    Scored,
    /// The pinned model files are absent: a named skip, never a score (AC-5).
    Skipped,
}

/// The per-fixture measurements a result carries (latency + token + MTP
/// counters). Grouped so the record constructor stays within the argument limit
/// and so the runner has ONE place to fill the measurements it observed.
///
/// The persisted/printed [`CompanionScoreResult`] keeps these FLAT, so the wire
/// shape is the contract's; this struct is only the construction seam.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ScoreMeasurements {
    /// Wall-clock latency of the turn, in milliseconds.
    pub latency_ms: u64,
    /// Prompt tokens for the turn.
    pub prompt_tokens: u64,
    /// Completion tokens for the turn.
    pub completion_tokens: u64,
    /// MTP draft tokens proposed during the turn (diffed for this fixture).
    pub mtp_drafts_proposed: u64,
    /// MTP draft tokens accepted during the turn (diffed for this fixture).
    pub mtp_drafts_accepted: u64,
    /// MTP draft-call count during the turn (diffed for this fixture).
    pub mtp_draft_calls: u64,
}

/// One fixture's record (AC-2, AC-4). Serialized camelCase on the wire, and
/// persisted as the attributes of one `companion.score` span.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionScoreResult {
    /// The fixture id this record belongs to.
    pub fixture_id: String,
    /// The boolean verdict: the outcome compared against the fixture's OWN
    /// expectation.
    pub passed: bool,
    /// The committed per-fixture seed this run used (AC-3 determinism).
    pub seed: u32,
    /// Wall-clock latency of the turn, in milliseconds.
    pub latency_ms: u64,
    /// Prompt tokens for the turn.
    pub prompt_tokens: u64,
    /// Completion tokens for the turn.
    pub completion_tokens: u64,
    /// MTP draft tokens proposed during the turn (diffed for this fixture).
    pub mtp_drafts_proposed: u64,
    /// MTP draft tokens accepted during the turn (diffed for this fixture).
    pub mtp_drafts_accepted: u64,
    /// MTP draft-call count during the turn (diffed for this fixture).
    pub mtp_draft_calls: u64,
    /// Failure detail; `""` on pass. Diagnostic only — never decides `passed`.
    pub detail: String,
}

impl CompanionScoreResult {
    /// Build a record for `fixture_id` from its seed and observed measurements.
    /// `passed`/`detail` are set by [`Self::passed`] / [`Self::failed`].
    fn record(fixture_id: impl Into<String>, seed: u32, measurements: ScoreMeasurements) -> Self {
        Self {
            fixture_id: fixture_id.into(),
            passed: false,
            seed,
            latency_ms: measurements.latency_ms,
            prompt_tokens: measurements.prompt_tokens,
            completion_tokens: measurements.completion_tokens,
            mtp_drafts_proposed: measurements.mtp_drafts_proposed,
            mtp_drafts_accepted: measurements.mtp_drafts_accepted,
            mtp_draft_calls: measurements.mtp_draft_calls,
            detail: String::new(),
        }
    }

    /// A PASS record with the observed measurements.
    pub fn passed(
        fixture_id: impl Into<String>,
        seed: u32,
        measurements: ScoreMeasurements,
    ) -> Self {
        Self {
            passed: true,
            ..Self::record(fixture_id, seed, measurements)
        }
    }

    /// A FAIL record carrying `detail`.
    pub fn failed(
        fixture_id: impl Into<String>,
        seed: u32,
        measurements: ScoreMeasurements,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            detail: detail.into(),
            ..Self::record(fixture_id, seed, measurements)
        }
    }
}

/// The scored report the runner prints as ONE JSON object on stdout (AC-2, AC-3).
///
/// The totals are present only on this (scored) shape; the skipped shape is
/// [`SkipReport`], which structurally carries no totals (AC-5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionScoreReport {
    /// Always [`ScoreStatus::Scored`] for this shape.
    pub status: ScoreStatus,
    /// One record per fixture, in fixture order.
    pub fixtures: Vec<CompanionScoreResult>,
    /// The total fixture count.
    pub total: usize,
    /// How many fixtures passed.
    pub passed: usize,
    /// How many fixtures failed.
    pub failed: usize,
    /// Fixture ids that newly FAIL versus the committed baseline.
    pub regressions: Vec<String>,
    /// Fixture ids that newly PASS versus the committed baseline.
    pub newly_passing: Vec<String>,
    /// A human-readable summary line.
    pub detail: String,
}

impl CompanionScoreReport {
    /// Assemble the scored report from the per-fixture records (totals and
    /// pass/fail counts derived from the records, never supplied independently).
    pub fn scored(
        fixtures: Vec<CompanionScoreResult>,
        regressions: Vec<String>,
        newly_passing: Vec<String>,
        detail: impl Into<String>,
    ) -> Self {
        let total = fixtures.len();
        let passed = fixtures.iter().filter(|record| record.passed).count();
        Self {
            status: ScoreStatus::Scored,
            total,
            passed,
            failed: total - passed,
            fixtures,
            regressions,
            newly_passing,
            detail: detail.into(),
        }
    }
}

/// The skipped report (AC-5): the pinned model files are absent, so the harness
/// names the missing files and the lever and reports **no** pass/fail total.
///
/// This is a DISTINCT shape from [`CompanionScoreReport`]: a skip can never carry
/// a total, by construction (there is no `total`/`passed`/`failed` field here).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipReport {
    /// Always [`ScoreStatus::Skipped`].
    pub status: ScoreStatus,
    /// The exact `<subdir>/<path>` list of absent model files (the product's own
    /// `missing_files()` output).
    pub missing_files: Vec<String>,
    /// The lever that points the engine at a manifest-shaped models dir.
    pub models_dir_lever: String,
    /// A human-readable summary line.
    pub detail: String,
}

impl SkipReport {
    /// Build the skipped report from the product's own missing-file list.
    pub fn new(missing_files: Vec<String>, detail: impl Into<String>) -> Self {
        Self {
            status: ScoreStatus::Skipped,
            missing_files,
            models_dir_lever: MODELS_DIR_LEVER.to_string(),
            detail: detail.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The result record serializes with the contract's camelCase field set, so
    /// the persisted span attributes and the printed report share one wire shape.
    #[test]
    fn result_serializes_the_contract_field_set() {
        let record = CompanionScoreResult::passed(
            "text-chat",
            7,
            ScoreMeasurements {
                latency_ms: 120,
                prompt_tokens: 30,
                completion_tokens: 12,
                mtp_drafts_proposed: 5,
                mtp_drafts_accepted: 4,
                mtp_draft_calls: 2,
            },
        );
        let value = serde_json::to_value(&record).expect("serialize a result");
        let mut keys: Vec<&str> = value
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "completionTokens",
                "detail",
                "fixtureId",
                "latencyMs",
                "mtpDraftCalls",
                "mtpDraftsAccepted",
                "mtpDraftsProposed",
                "passed",
                "promptTokens",
                "seed",
            ]
        );
        assert_eq!(value["fixtureId"], serde_json::json!("text-chat"));
        assert_eq!(value["passed"], serde_json::json!(true));
        assert_eq!(value["detail"], serde_json::json!(""));
    }

    /// A failure record carries its detail and `passed: false`.
    #[test]
    fn failure_record_carries_the_detail() {
        let record = CompanionScoreResult::failed(
            "schema-doom-plan",
            3,
            ScoreMeasurements::default(),
            "missing steps",
        );
        assert!(!record.passed);
        assert_eq!(record.detail, "missing steps");
        assert_eq!(record.seed, 3);
    }

    /// The scored report derives its own totals and pass/fail counts from the
    /// records — they are never supplied independently, so they cannot disagree.
    #[test]
    fn scored_report_derives_its_totals() {
        let report = CompanionScoreReport::scored(
            vec![
                CompanionScoreResult::passed("a", 1, ScoreMeasurements::default()),
                CompanionScoreResult::failed("b", 2, ScoreMeasurements::default(), "nope"),
            ],
            vec!["b".to_string()],
            Vec::new(),
            "one regression",
        );
        assert_eq!(report.status, ScoreStatus::Scored);
        assert_eq!(report.total, 2);
        assert_eq!(report.passed, 1);
        assert_eq!(report.failed, 1);
        assert_eq!(report.regressions, vec!["b".to_string()]);
    }

    /// AC-5: the skipped shape carries NO total/passed/failed field at all — a
    /// skip can never look like a score.
    #[test]
    fn skip_report_has_no_score_fields() {
        let report = SkipReport::new(
            vec!["gemma-4-e2b-it-qat/model.gguf".to_string()],
            "the pinned model files are absent",
        );
        let value = serde_json::to_value(&report).expect("serialize a skip report");
        let object = value.as_object().expect("object");
        for banned in ["total", "passed", "failed", "fixtures", "regressions"] {
            assert!(
                !object.contains_key(banned),
                "a skip report must not carry `{banned}`: {value}"
            );
        }
        assert_eq!(value["status"], serde_json::json!("skipped"));
        assert_eq!(value["modelsDirLever"], serde_json::json!("FREDO_COMPANION_MODELS_DIR"));
        assert_eq!(MODELS_DIR_LEVER, "FREDO_COMPANION_MODELS_DIR");
    }
}
