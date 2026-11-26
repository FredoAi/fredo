//! The committed baseline + regression comparison (Spec #3232, ST-3; AC-3).
//!
//! The baseline is a **committed machine-readable record** keyed by fixture id —
//! never prose — so a run's pass set is diffable against it and a delta is a
//! measured fact rather than a recollection.
//!
//! ## The comparison rule (recorded, not assumed)
//!
//! A fixture regresses **iff it is present in BOTH the baseline and the run and
//! its verdict flipped from pass to fail**; it newly passes iff its verdict
//! flipped the other way. Both directions require a prior recorded state:
//!
//! * a fixture **absent from the baseline** (newly added) has no recorded state
//!   and is therefore neither a regression nor a newly-passing fixture;
//! * a **baseline entry absent from the run** (a fixture removed from the set)
//!   is likewise not a regression — a removed fixture is not a failing one.
//!
//! AC-3's non-zero exit keys off exactly one thing: a non-empty `regressions`
//! list.

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

use super::CompanionScoreResult;

/// The baseline schema version this loader understands. A baseline declaring any
/// other version is read FAIL-CLOSED (a wrong-version record must never be
/// silently treated as current).
pub const BASELINE_VERSION: u32 = 1;

/// The default committed baseline path, relative to the repository root.
///
/// `--baseline` defaults to this (`the Architect's Binding Names`).
pub const DEFAULT_BASELINE_PATH: &str = ".opencode/tests/companion/score-baseline.json";

/// One committed baseline entry: the fixture id, its recorded verdict, and the
/// seed that produced it (so a seed change is visible in the diff).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaselineEntry {
    /// The fixture id (the join key).
    pub id: String,
    /// The recorded verdict for this fixture.
    pub passed: bool,
    /// The per-fixture seed the recorded verdict was produced with.
    pub seed: u32,
}

/// The committed baseline: a version plus one entry per fixture, keyed by id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionScoreBaseline {
    /// The schema version ([`BASELINE_VERSION`]).
    pub version: u32,
    /// The recorded entries, in report order.
    pub fixtures: Vec<BaselineEntry>,
}

/// The computed delta of one run against the baseline (AC-3).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BaselineDelta {
    /// Fixture ids that newly FAIL (recorded pass → observed fail).
    pub regressions: Vec<String>,
    /// Fixture ids that newly PASS (recorded fail → observed pass).
    pub newly_passing: Vec<String>,
}

impl BaselineDelta {
    /// Whether the run introduced any regression — the AC-3 non-zero-exit key.
    pub fn has_regression(&self) -> bool {
        !self.regressions.is_empty()
    }
}

impl CompanionScoreBaseline {
    /// Parse and validate a baseline JSON document. Fail-closed on a version
    /// mismatch and on a duplicate fixture id (a duplicate would alias two
    /// records).
    pub fn from_json(json: &str) -> Result<Self> {
        let baseline: CompanionScoreBaseline =
            serde_json::from_str(json).context("invalid baseline JSON")?;
        if baseline.version != BASELINE_VERSION {
            return Err(anyhow!(
                "unsupported baseline version {} (expected {BASELINE_VERSION})",
                baseline.version
            ));
        }
        let mut seen: Vec<&str> = baseline.fixtures.iter().map(|entry| entry.id.as_str()).collect();
        seen.sort_unstable();
        let mut deduped = seen.clone();
        deduped.dedup();
        if seen != deduped {
            return Err(anyhow!("the baseline carries a duplicate fixture id"));
        }
        Ok(baseline)
    }

    /// Load and validate the baseline at `path`.
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading the baseline {}", path.display()))?;
        Self::from_json(&text)
    }

    /// The recorded entry for `id`, when present.
    pub fn get(&self, id: &str) -> Option<&BaselineEntry> {
        self.fixtures.iter().find(|entry| entry.id == id)
    }
}

/// Compute the delta of `results` against `baseline` under the recorded rule.
pub fn compare(
    baseline: &CompanionScoreBaseline,
    results: &[CompanionScoreResult],
) -> BaselineDelta {
    let mut delta = BaselineDelta::default();
    for result in results {
        let Some(entry) = baseline.get(&result.fixture_id) else {
            // Absent from the baseline ⇒ no prior state ⇒ no delta.
            continue;
        };
        match (entry.passed, result.passed) {
            (true, false) => delta.regressions.push(result.fixture_id.clone()),
            (false, true) => delta.newly_passing.push(result.fixture_id.clone()),
            _ => {}
        }
    }
    delta
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::llm_server::engine::score::ScoreMeasurements;

    fn result(id: &str, passed: bool, seed: u32) -> CompanionScoreResult {
        if passed {
            CompanionScoreResult::passed(id, seed, ScoreMeasurements::default())
        } else {
            CompanionScoreResult::failed(id, seed, ScoreMeasurements::default(), "nope")
        }
    }

    fn baseline_with(entries: &[(&str, bool, u32)]) -> CompanionScoreBaseline {
        CompanionScoreBaseline {
            version: BASELINE_VERSION,
            fixtures: entries
                .iter()
                .map(|(id, passed, seed)| BaselineEntry {
                    id: (*id).to_string(),
                    passed: *passed,
                    seed: *seed,
                })
                .collect(),
        }
    }

    /// The baseline round-trips through JSON with the contract's field set.
    #[test]
    fn baseline_round_trips_through_json() {
        let baseline = baseline_with(&[("text-chat", true, 7)]);
        let json = serde_json::to_string(&baseline).expect("serialize");
        let parsed = CompanionScoreBaseline::from_json(&json).expect("parse");
        assert_eq!(parsed, baseline);
        assert_eq!(baseline.get("text-chat").map(|entry| entry.seed), Some(7));
        assert!(baseline.get("absent").is_none());
    }

    /// A version mismatch is read FAIL-CLOSED — never silently accepted.
    #[test]
    fn a_wrong_version_is_refused() {
        let json = r#"{"version": 2, "fixtures": []}"#;
        assert!(CompanionScoreBaseline::from_json(json).is_err());
        let duplicate = r#"{"version": 1, "fixtures": [
            {"id": "a", "passed": true, "seed": 1},
            {"id": "a", "passed": false, "seed": 2}
        ]}"#;
        assert!(CompanionScoreBaseline::from_json(duplicate).is_err());
    }

    /// AC-3: a newly-FAILING fixture is named as a regression and the delta says
    /// the run regressed (the non-zero-exit key).
    #[test]
    fn a_newly_failing_fixture_is_a_named_regression() {
        let baseline = baseline_with(&[("text-chat", true, 7)]);
        let delta = compare(&baseline, &[result("text-chat", false, 7)]);
        assert_eq!(delta.regressions, vec!["text-chat".to_string()]);
        assert!(delta.newly_passing.is_empty());
        assert!(delta.has_regression());
    }

    /// AC-3: a newly-PASSING fixture is named, and it is NOT a regression (so the
    /// exit stays clean).
    #[test]
    fn a_newly_passing_fixture_is_named_but_not_a_regression() {
        let baseline = baseline_with(&[("vision-screen-text", false, 4)]);
        let delta = compare(&baseline, &[result("vision-screen-text", true, 4)]);
        assert_eq!(delta.newly_passing, vec!["vision-screen-text".to_string()]);
        assert!(delta.regressions.is_empty());
        assert!(!delta.has_regression());
    }

    /// Two regressions are BOTH named (AC-3 "name every fixture").
    #[test]
    fn every_regression_is_named() {
        let baseline = baseline_with(&[("a", true, 1), ("b", true, 2), ("c", true, 3)]);
        let delta = compare(
            &baseline,
            &[result("a", false, 1), result("b", false, 2), result("c", true, 3)],
        );
        assert_eq!(delta.regressions, vec!["a".to_string(), "b".to_string()]);
    }

    /// A fixture absent from the baseline has no recorded state ⇒ no delta
    /// (recorded rule, QA-1).
    #[test]
    fn a_fixture_absent_from_the_baseline_produces_no_delta() {
        let baseline = baseline_with(&[("known", true, 1)]);
        let delta = compare(&baseline, &[result("brand-new", false, 9)]);
        assert!(delta.regressions.is_empty());
        assert!(delta.newly_passing.is_empty());
    }

    /// The committed baseline is a real, valid record that covers EXACTLY the
    /// committed fixture set with each fixture's committed seed — so a fixture
    /// added to the set without a baseline entry is caught here.
    #[test]
    fn the_committed_baseline_matches_the_committed_fixture_set() {
        use crate::applications::llm_server::engine::score::fixtures;
        // CARGO_MANIFEST_DIR = <repo>/apps/tauri/src-tauri
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .expect("repo root");
        let path = repo_root.join(DEFAULT_BASELINE_PATH);
        let baseline = CompanionScoreBaseline::load(&path)
            .unwrap_or_else(|error| panic!("load the committed baseline {}: {error}", path.display()));
        let fixture_set = fixtures::fixtures();
        assert_eq!(
            baseline.fixtures.len(),
            fixture_set.len(),
            "the committed baseline must carry one entry per fixture"
        );
        for fixture in &fixture_set {
            let entry = baseline
                .get(fixture.id)
                .unwrap_or_else(|| panic!("the committed baseline is missing fixture {}", fixture.id));
            assert_eq!(
                entry.seed, fixture.seed,
                "the baseline seed for {} must match the fixture's committed seed",
                fixture.id
            );
        }
    }
}
