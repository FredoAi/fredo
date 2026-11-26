//! The committed baseline + regression comparison (Spec #3232, ST-3; AC-3).
//!
//! The baseline is a **committed machine-readable record** keyed by fixture id —
//! never prose — so a run's pass set is diffable against it and a delta is a
//! measured fact rather than a recollection.
//!
//! ## Measured provenance (ST-7; the record must be a record of a RUN)
//!
//! A baseline is the pass set an ACTUAL run produced, never a hand-authored
//! reference (the v1 failure: an all-`true` file no run reproduces). The schema
//! therefore carries a **required** [`BaselineProvenance`] block
//! (`measured`/`tool`/`commit`) and [`CompanionScoreBaseline::from_json`] reads a
//! baseline FAIL-CLOSED when it does not declare a measured run. This is a
//! **declaration, not cryptographic proof** — a determined author could forge
//! `measured: true`; the guarantee against a fabricated pass set is the tester's
//! live reproduction of the pass set each round (AC-3's unchanged-tree clause).
//! The block's job is to make an unmeasured reference impossible to commit
//! **unseen** (the old v1 file no longer deserializes at all).
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
///
/// **v2 (ST-7)** adds the required `provenance` block, so a v1 (unmeasured)
/// baseline no longer deserializes — the schema change itself forces a
/// regeneration by a run.
pub const BASELINE_VERSION: u32 = 2;

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

/// The provenance of a MEASURED baseline (ST-7). REQUIRED on the schema and
/// read fail-closed: a baseline must declare it was produced by a real run.
///
/// This is a **declaration, not cryptographic proof** — the guarantee against a
/// fabricated pass set is the tester's live reproduction each round, not this
/// block. Its job is to make an unmeasured reference impossible to commit unseen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaselineProvenance {
    /// True when the fixture set below was produced by an actual run.
    pub measured: bool,
    /// The tool that produced the run (e.g. `fredo companion score`).
    pub tool: String,
    /// The 7–40 hex git commit the run measured.
    pub commit: String,
}

/// The committed baseline: a version, the provenance of the measured run, and one
/// entry per fixture, keyed by id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionScoreBaseline {
    /// The schema version ([`BASELINE_VERSION`]).
    pub version: u32,
    /// The provenance of the recorded run (ST-7). REQUIRED — see
    /// [`BaselineProvenance`]; there is deliberately no `#[serde(default)]`.
    pub provenance: BaselineProvenance,
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
    /// mismatch, on a duplicate fixture id (a duplicate would alias two records),
    /// and on unmeasured provenance (ST-7: a baseline must be the record of a
    /// real run, with the 7–40 hex commit it measured).
    pub fn from_json(json: &str) -> Result<Self> {
        let baseline: CompanionScoreBaseline =
            serde_json::from_str(json).context("invalid baseline JSON")?;
        if baseline.version != BASELINE_VERSION {
            return Err(anyhow!(
                "unsupported baseline version {} (expected {BASELINE_VERSION})",
                baseline.version
            ));
        }
        if !baseline.provenance.measured {
            return Err(anyhow!(
                "the baseline `provenance.measured` is not true — a baseline must be the record \
                 of an actual `fredo companion score` run, never a hand-authored reference"
            ));
        }
        if !is_hex_sha(&baseline.provenance.commit) {
            return Err(anyhow!(
                "the baseline `provenance.commit` is not a 7-40 hex git sha: {:?}",
                baseline.provenance.commit
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

/// Whether `value` is a 7–40 character hex git sha (the ONLY shape
/// `provenance.commit` accepts).
///
/// The lower bound is git's shortest abbreviated sha; the upper bound is a full
/// SHA-1. A commit that is not hex, or of the wrong length, is refused.
fn is_hex_sha(value: &str) -> bool {
    (7..=40).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
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
            provenance: BaselineProvenance {
                measured: true,
                tool: "fredo companion score".to_string(),
                commit: "674b320".to_string(),
            },
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
        let json = r#"{"version": 1, "provenance": {"measured": true, "tool": "fredo companion score", "commit": "674b320"}, "fixtures": []}"#;
        assert!(CompanionScoreBaseline::from_json(json).is_err());
        let duplicate = r#"{"version": 2, "provenance": {"measured": true, "tool": "fredo companion score", "commit": "674b320"}, "fixtures": [
            {"id": "a", "passed": true, "seed": 1},
            {"id": "a", "passed": false, "seed": 2}
        ]}"#;
        assert!(CompanionScoreBaseline::from_json(duplicate).is_err());
    }

    /// ST-7: a baseline that does not declare a MEASURED run is refused — the v1
    /// hand-authored reference can no longer load, so an unmeasured record cannot
    /// be committed unseen.
    #[test]
    fn an_unmeasured_baseline_is_refused() {
        let json = r#"{"version": 2, "provenance": {"measured": false, "tool": "fredo companion score", "commit": "674b320"}, "fixtures": []}"#;
        let error =
            CompanionScoreBaseline::from_json(json).expect_err("an unmeasured baseline must be refused");
        assert!(
            error.to_string().contains("provenance.measured"),
            "the error must name the field: {error}"
        );
    }

    /// ST-7: a baseline whose `provenance.commit` is not a 7–40 hex sha is refused,
    /// and the error NAMES the field; a short (7) sha and a full (40) SHA-1 both
    /// load.
    #[test]
    fn a_baseline_with_an_invalid_commit_is_refused() {
        // Each bad value is refused, and the error NAMES the field.
        for bad in ["", "abc", "not-a-sha", "z123456", "0123456789abcdef0123456789abcdef0123456789g"] {
            let json = format!(
                r#"{{"version": 2, "provenance": {{"measured": true, "tool": "fredo companion score", "commit": "{bad}"}}, "fixtures": []}}"#
            );
            let error = CompanionScoreBaseline::from_json(&json)
                .expect_err("an invalid provenance commit must be refused");
            assert!(
                error.to_string().contains("provenance.commit"),
                "{bad:?}: the error must name the field: {error}"
            );
        }
        // Both a short and a full hex sha load.
        for good in ["674b320", "674b32027529686bbac0cd98430db6885e6cc385"] {
            let json = format!(
                r#"{{"version": 2, "provenance": {{"measured": true, "tool": "fredo companion score", "commit": "{good}"}}, "fixtures": []}}"#
            );
            assert!(CompanionScoreBaseline::from_json(&json).is_ok(), "{good}");
        }
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
        // ST-7: the committed baseline must declare a MEASURED run (a real tool +
        // a 7-40 hex commit). `load` already fail-closes on unmeasured provenance,
        // so reaching here proves it; the asserts below pin the intent explicitly.
        assert!(
            baseline.provenance.measured,
            "the committed baseline must declare a MEASURED run (ST-7)"
        );
        assert!(
            baseline.provenance.tool.contains("companion score"),
            "the committed baseline provenance must name the producing tool: {}",
            baseline.provenance.tool
        );
        assert!(
            is_hex_sha(&baseline.provenance.commit),
            "the committed baseline provenance.commit must be a 7-40 hex sha: {}",
            baseline.provenance.commit
        );
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
