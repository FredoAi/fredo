//! `fredo companion score` (Spec #3232, ST-5).
//!
//! The maintainer-facing scoring harness: it drives the committed fixture set
//! through THIS binary's own in-process companion engine, scores every fixture
//! against its OWN structural expectation, persists each record, compares the
//! resulting pass set against a committed baseline, prints ONE JSON object on
//! stdout, and exits on the fixed code contract.
//!
//! It is a PRODUCT diagnostic, not a test seam (compiled unconditionally, no
//! Tauri command, no `AppHandle`), exactly like the shipped `fredo companion
//! probe`: it spawns its OWN [`CompanionEngineHandle`], starts it, runs one turn
//! per fixture, and stops it. The process-scoped engine slot is never touched.
//!
//! ## Exit codes (fixed by the plan's Binding Names)
//!
//! * `0` — every fixture passed and no regression was detected.
//! * `1` — a fixture failed, the engine could not start, OR a regression was
//!   detected.
//! * `2` — a usage or local precondition error (a requested baseline that is
//!   missing/unparsable, an unusable store endpoint, a malformed scratch file).
//! * `3` — skipped: the pinned model files are absent (AC-5). NOTHING ran, and
//!   NO pass/fail total is printed.
//!
//! ## No `AppHandle` (the models-dir rule)
//!
//! A CLI invocation has no Tauri app, so the models dir resolves through the
//! SAME rule the engine integration gate uses: `FREDO_COMPANION_MODELS_DIR` when
//! non-blank, else `<home>/fredo-models`. The manifest is the compiled
//! [`default_manifest`].
//!
//! ## The store endpoint (AC-4)
//!
//! The embedded cluster's port is published in memory only, so the harness takes
//! an EXPLICITLY supplied endpoint (`--pg-port`, or `--manifest` carrying
//! `ports.pg`) — never a probed port. The password comes from
//! `FREDO_PG_PASSWORD_FILE` (first non-blank line), then `PGPASSWORD`. When no
//! endpoint is supplied the run still scores and reports, and the report's
//! `detail` names that persistence was skipped — an omission is always visible.

use std::io::Write;
use std::path::PathBuf;

use clap::Args;
use serde::Deserialize;

use crate::applications::llm_server::engine::handle::CompanionEngineHandle;
use crate::applications::llm_server::engine::paths;
use crate::applications::llm_server::engine::score::baseline::{
    self, CompanionScoreBaseline, DEFAULT_BASELINE_PATH,
};
use crate::applications::llm_server::engine::score::persist::{
    CompanionScoreStore, ScoreStoreEndpoint,
};
use crate::applications::llm_server::engine::score::{
    fixtures, runner, CompanionScoreReport, Expectation, ScoreFixture, SkipReport,
    MODELS_DIR_LEVER,
};
use crate::applications::llm_server::engine::CompanionBackendMode;
use crate::infrastructure::companion::models::{default_manifest, missing_files};

/// The password-file seam the store endpoint reads (the product's documented
/// lever).
pub const PG_PASSWORD_FILE_ENV: &str = "FREDO_PG_PASSWORD_FILE";

/// The store host (loopback only — the embedded cluster never listens off-box).
const STORE_HOST: &str = "127.0.0.1";
/// The store role (unchanged `postgres`).
const STORE_USER: &str = "postgres";
/// The Fredo application database.
const STORE_DATABASE: &str = "fredo";

/// Exit code: every fixture passed and no regression was detected.
const EXIT_PASS: i32 = 0;
/// Exit code: a fixture failed, the engine failed to start, or a regression.
const EXIT_FAIL: i32 = 1;
/// Exit code: a usage or local precondition error.
const EXIT_USAGE: i32 = 2;
/// Exit code: the pinned model files are absent — a NAMED skip (AC-5).
const EXIT_SKIPPED: i32 = 3;

/// Arguments for `fredo companion score`.
#[derive(Debug, Args)]
pub struct ScoreArgs {
    /// The committed baseline to compare against
    /// (default: `.opencode/tests/companion/score-baseline.json`).
    #[arg(long, value_name = "PATH")]
    pub baseline: Option<PathBuf>,
    /// The embedded-PostgreSQL port the score store is reached on
    /// (the store seam's explicit lever).
    #[arg(long, value_name = "N", conflicts_with = "manifest")]
    pub pg_port: Option<u16>,
    /// The environment process-manifest path that records `ports.pg`
    /// (the store seam's manifest lever).
    #[arg(long, value_name = "PATH")]
    pub manifest: Option<PathBuf>,
    /// Write the run's report JSON to this path (in addition to stdout).
    #[arg(long, value_name = "PATH")]
    pub report: Option<PathBuf>,
    /// Apply per-fixture overrides from this scratch JSON file (the deliberate
    /// wrong-expectation seam; each entry names a committed fixture and replaces
    /// its expectation).
    #[arg(long, value_name = "PATH")]
    pub fixtures: Option<PathBuf>,
}

/// The ONE JSON object the runner prints — either the scored report or the
/// named skip (two structurally distinct shapes, AC-2 vs AC-5).
#[derive(Debug)]
enum ScoreOutcome {
    /// A scored run.
    Scored(CompanionScoreReport),
    /// A named skip (AC-5): no total.
    Skipped(SkipReport),
}

impl ScoreOutcome {
    /// Serialize to the ONE JSON object stdout carries.
    fn to_json(&self) -> serde_json::Result<String> {
        match self {
            Self::Scored(report) => serde_json::to_string(report),
            Self::Skipped(report) => serde_json::to_string(report),
        }
    }
}

/// Run `fredo companion score`: print ONE JSON object on stdout and exit 0/1/2/3.
pub async fn run_score(args: &ScoreArgs) -> anyhow::Result<()> {
    let (outcome, exit_code) = score(args).await;
    let json = outcome.to_json()?;
    // Flush explicitly: `process::exit` must not race a buffered stdout on the
    // release (windows-subsystem) binary whose stdout is redirected by the caller.
    let mut stdout = std::io::stdout();
    writeln!(stdout, "{json}")?;
    stdout.flush()?;
    if let Some(path) = args.report.as_deref() {
        if let Err(error) = std::fs::write(path, format!("{json}\n")) {
            eprintln!(
                "fredo companion score: could not write the report to {}: {error}",
                path.display()
            );
        }
    }
    std::process::exit(exit_code);
}

/// Build the report and its exit code. Pure over the engine/store boundary, so
/// the skip and usage shapes are unit-pinnable.
async fn score(args: &ScoreArgs) -> (ScoreOutcome, i32) {
    score_with_models_dir(args, resolve_models_dir()).await
}

/// The report + exit code, with the models dir passed in (so the skip path is
/// unit-pinnable without mutating the process-global env lever).
async fn score_with_models_dir(
    args: &ScoreArgs,
    models_dir: PathBuf,
) -> (ScoreOutcome, i32) {
    // The models precondition: absent files are a NAMED skip (AC-5) that asserts
    // (and reports) nothing. It wins over every later precondition, so a store
    // error can never turn a skip into a usage failure.
    let manifest = default_manifest();
    let missing: Vec<String> = missing_files(&models_dir, &manifest)
        .iter()
        .map(|status| status.relative_path.clone())
        .collect();
    if !missing.is_empty() {
        let detail = format!(
            "missing model file(s): {} — set {MODELS_DIR_LEVER} to a manifest-shaped models dir.",
            missing.join(", ")
        );
        return (
            ScoreOutcome::Skipped(SkipReport::new(missing, detail)),
            EXIT_SKIPPED,
        );
    }

    // The store endpoint (AC-4): an explicitly supplied endpoint, never probed.
    // An unusable supplied endpoint is a named precondition failure.
    let endpoint = match resolve_store_endpoint(args) {
        Ok(endpoint) => endpoint,
        Err(detail) => return (usage_report(detail), EXIT_USAGE),
    };

    // The baseline: a requested file that is missing or malformed is a usage
    // error; the DEFAULT path being absent simply means "not yet characterised"
    // (no comparison), so a first run can still produce a report.
    let explicit_baseline = args.baseline.is_some();
    let baseline_path = args
        .baseline
        .clone()
        .unwrap_or_else(|| PathBuf::from(DEFAULT_BASELINE_PATH));
    let loaded = if baseline_path.exists() {
        match CompanionScoreBaseline::load(&baseline_path) {
            Ok(baseline) => Some(baseline),
            Err(error) => {
                return (
                    usage_report(format!(
                        "the baseline file {} could not be read: {error}",
                        baseline_path.display()
                    )),
                    EXIT_USAGE,
                )
            }
        }
    } else if explicit_baseline {
        return (
            usage_report(format!(
                "the baseline file {} does not exist.",
                baseline_path.display()
            )),
            EXIT_USAGE,
        );
    } else {
        None
    };

    let engine_paths = match paths::resolve_for_app(&models_dir, &manifest) {
        Ok(engine_paths) => engine_paths,
        Err((_code, detail)) => return (usage_report(detail), EXIT_USAGE),
    };

    // Build the run's fixture set and apply any scratch overrides BEFORE the
    // engine starts, so a malformed scratch file fails fast (never after a load).
    let mut set = fixtures::fixtures();
    if let Some(path) = args.fixtures.as_deref() {
        if let Err(detail) = apply_overrides(&mut set, path) {
            return (usage_report(detail), EXIT_USAGE);
        }
    }

    // Spawn THIS invocation's own engine handle; nothing process-global is touched.
    let handle = CompanionEngineHandle::spawn();
    let started = handle.start(engine_paths.clone(), CompanionBackendMode::Auto);
    if !started.success {
        handle.stop();
        return (
            ScoreOutcome::Scored(CompanionScoreReport::scored(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                format!("the companion engine did not start: {}", started.detail),
            )),
            EXIT_FAIL,
        );
    }

    let results = runner::score_fixtures(&handle, &set, &engine_paths, CompanionBackendMode::Auto)
        .await;
    handle.stop();

    // Persist each record (AC-4). A supplied endpoint that cannot be reached or
    // written is a named precondition failure — never a silent skip.
    let persist_note = match &endpoint {
        Some(endpoint) => match persist_results(endpoint, &results).await {
            Ok(count) => format!("; persisted {count} record(s)"),
            Err(detail) => return (usage_report(detail), EXIT_USAGE),
        },
        None => "; persistence skipped (no store endpoint; pass --pg-port or --manifest)".to_string(),
    };

    let delta = match &loaded {
        Some(baseline) => baseline::compare(baseline, &results),
        None => Default::default(),
    };
    let baseline::BaselineDelta {
        regressions,
        newly_passing,
    } = delta;
    let passed = results.iter().filter(|result| result.passed).count();
    let total = results.len();
    let comparison = match &loaded {
        Some(_) => String::new(),
        None => format!(
            "; no baseline at {} (nothing compared)",
            baseline_path.display()
        ),
    };
    let detail = format!("{passed} of {total} fixtures passed{comparison}{persist_note}");
    let report = CompanionScoreReport::scored(results, regressions, newly_passing, detail);
    let exit_code = if report.failed > 0 || !report.regressions.is_empty() {
        EXIT_FAIL
    } else {
        EXIT_PASS
    };
    (ScoreOutcome::Scored(report), exit_code)
}

/// Connect to `endpoint` and persist every result (AC-4).
async fn persist_results(
    endpoint: &ScoreStoreEndpoint,
    results: &[crate::applications::llm_server::engine::score::CompanionScoreResult],
) -> Result<usize, String> {
    let store = CompanionScoreStore::connect(endpoint)
        .await
        .map_err(|error| format!("the score store could not be reached: {error}"))?;
    store
        .persist(results)
        .await
        .map_err(|error| format!("the score records could not be written: {error}"))
}

/// A usage/precondition report (no fixture ran) with `detail`.
fn usage_report(detail: impl Into<String>) -> ScoreOutcome {
    ScoreOutcome::Scored(CompanionScoreReport::scored(
        Vec::new(),
        Vec::new(),
        Vec::new(),
        detail,
    ))
}

/// The models dir: `FREDO_COMPANION_MODELS_DIR` when non-blank, else the product
/// default `<home>/fredo-models` (the SAME rule the engine gate resolves). A blank
/// or whitespace-only value is treated as unset.
fn resolve_models_dir() -> PathBuf {
    if let Ok(dir) = std::env::var(MODELS_DIR_LEVER) {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    home_dir().join("fredo-models")
}

/// The home directory, resolved with the SAME rule `fredo setup` uses.
fn home_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    }
}

// ── The store endpoint (AC-4) ────────────────────────────────────────────────

/// Resolve the store endpoint from the supplied levers, or `None` when neither
/// is given (the run then scores and reports without persisting — visibly).
fn resolve_store_endpoint(args: &ScoreArgs) -> Result<Option<ScoreStoreEndpoint>, String> {
    let port = match (args.pg_port, args.manifest.as_deref()) {
        (Some(port), _) => port,
        (None, Some(path)) => manifest_pg_port(path)?,
        (None, None) => return Ok(None),
    };
    if port == 0 {
        return Err(
            "the score store port is 0 — supply the cluster's resolved loopback port \
             (pg_supervisor_status, a dev-env manifest `ports.pg`, or --pg-port), never a \
             stale port."
                .to_string(),
        );
    }
    let password = resolve_pg_password();
    Ok(Some(ScoreStoreEndpoint::new(
        STORE_HOST,
        port,
        STORE_USER,
        password,
        STORE_DATABASE,
    )))
}

/// The `ports.pg` port recorded in an environment process manifest.
fn manifest_pg_port(path: &std::path::Path) -> Result<u16, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| format!("the store manifest {} could not be read: {error}", path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("the store manifest {} is not valid JSON: {error}", path.display()))?;
    let port = value
        .get("ports")
        .and_then(|ports| ports.get("pg"))
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| {
            format!(
                "the store manifest {} does not record an integer ports.pg",
                path.display()
            )
        })?;
    u16::try_from(port)
        .map_err(|_| format!("the store manifest ports.pg ({port}) is not a valid port"))
}

/// The loopback password: the first non-blank line of `FREDO_PG_PASSWORD_FILE`,
/// then `PGPASSWORD`, then an empty string (the connection then fails loudly).
fn resolve_pg_password() -> String {
    if let Ok(path) = std::env::var(PG_PASSWORD_FILE_ENV) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Some(line) = text.lines().map(str::trim).find(|line| !line.is_empty()) {
                return line.to_string();
            }
        }
    }
    std::env::var("PGPASSWORD").unwrap_or_default()
}

// ── The scratch-fixture override seam (F-183 / F-184) ────────────────────────

/// The scratch-override file: per-fixture expectation overrides applied to the
/// committed set.
///
/// This is the F-183/F-184 live lever: a caller supplies a deliberately-WRONG
/// expectation for a committed fixture so the harness can be driven to FAIL a
/// fixture the baseline records as passing (the regression direction). The
/// overridden turn stays the COMMITTED `ChatTurn` — a scratch file can never
/// introduce a foreign, request-body-shaped fixture.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScratchOverrides {
    /// The per-fixture overrides.
    overrides: Vec<ScratchOverride>,
}

/// One committed fixture's scratch override.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScratchOverride {
    /// The COMMITTED fixture id to override.
    id: String,
    /// An optional seed override.
    #[serde(default)]
    seed: Option<u32>,
    /// The (deliberately wrong) expectation to apply.
    expect: ScratchExpectation,
}

/// A scratch expectation — the same two shapes as [`Expectation`], as owned data.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ScratchExpectation {
    /// A call predicate.
    Call {
        /// The required call name.
        name: String,
        /// The required argument pairs.
        #[serde(default)]
        required_args: Vec<ScratchArg>,
    },
    /// A schema predicate.
    Schema {
        /// The schema name.
        name: String,
        /// The required top-level fields.
        require: Vec<String>,
    },
}

/// One required-argument pair in a scratch override.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScratchArg {
    /// The argument key.
    key: String,
    /// The required value.
    value: String,
}

/// Apply the scratch overrides at `path` to `set`.
///
/// A file that cannot be read/parsed, or that names a fixture outside the
/// committed set, is an error — a scratch seam that silently no-ops would let a
/// control run look green.
fn apply_overrides(set: &mut [ScoreFixture], path: &std::path::Path) -> Result<(), String> {
    let text = std::fs::read_to_string(path).map_err(|error| {
        format!("the scratch fixture file {} could not be read: {error}", path.display())
    })?;
    let parsed: ScratchOverrides = serde_json::from_str(&text).map_err(|error| {
        format!("the scratch fixture file {} is not valid: {error}", path.display())
    })?;
    for over in parsed.overrides {
        let Some(fixture) = set.iter_mut().find(|fixture| fixture.id == over.id) else {
            return Err(format!(
                "the scratch fixture file names unknown fixture id `{}`",
                over.id
            ));
        };
        if let Some(seed) = over.seed {
            fixture.seed = seed;
        }
        fixture.expect = match over.expect {
            ScratchExpectation::Call {
                name,
                required_args,
            } => Expectation::Call {
                name: leak_str(name),
                required_args: leak_args(required_args),
            },
            ScratchExpectation::Schema { name, require } => Expectation::Schema {
                name: leak_str(name),
                require: leak_fields(require),
            },
        };
    }
    Ok(())
}

/// Leak an owned string to `'static` — safe and bounded: the scratch seam exists
/// only for a ONE-SHOT CLI invocation, so the arena is released by process exit.
fn leak_str(value: String) -> &'static str {
    Box::leak(value.into_boxed_str())
}

/// Leak a required-argument list to `'static`.
fn leak_args(args: Vec<ScratchArg>) -> &'static [(&'static str, &'static str)] {
    let leaked: Vec<(&'static str, &'static str)> = args
        .into_iter()
        .map(|arg| (leak_str(arg.key), leak_str(arg.value)))
        .collect();
    Box::leak(leaked.into_boxed_slice())
}

/// Leak a required-field list to `'static`.
fn leak_fields(fields: Vec<String>) -> &'static [&'static str] {
    let leaked: Vec<&'static str> = fields.into_iter().map(leak_str).collect();
    Box::leak(leaked.into_boxed_slice())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_args() -> ScoreArgs {
        ScoreArgs {
            baseline: None,
            pg_port: None,
            manifest: None,
            report: None,
            fixtures: None,
        }
    }

    /// AC-5: with an empty models dir, the command takes the NAMED skip — status
    /// `skipped`, exit `3`, the missing-file list from the product's own
    /// `missing_files`, the lever, and NO total.
    #[tokio::test]
    async fn an_empty_models_dir_is_a_named_skip_with_no_total() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (outcome, exit_code) =
            score_with_models_dir(&empty_args(), dir.path().to_path_buf()).await;

        assert_eq!(exit_code, EXIT_SKIPPED, "absent models must skip: {outcome:?}");
        let ScoreOutcome::Skipped(report) = outcome else {
            panic!("an absent-models run must be the named skip");
        };
        assert_eq!(
            report.status,
            crate::applications::llm_server::engine::score::ScoreStatus::Skipped
        );
        assert_eq!(report.models_dir_lever, MODELS_DIR_LEVER);
        // The list is the product's own `<subdir>/<path>` list — all three files.
        assert_eq!(report.missing_files.len(), 3, "{:?}", report.missing_files);
        assert!(
            report
                .missing_files
                .iter()
                .any(|file| file.ends_with("gemma-4-e2b-it-qat/mmproj-BF16.gguf")),
            "the skip must name the missing files: {:?}",
            report.missing_files
        );
    }

    /// AC-5: the skip wire shape carries NO totals (B's SkipReport is structurally
    /// free of them), so a skip can never look like a score.
    #[test]
    fn the_skip_shape_carries_no_score_fields() {
        let report = SkipReport::new(
            vec!["gemma-4-e2b-it-qat/mmproj-BF16.gguf".to_string()],
            "missing model file(s)",
        );
        let value = serde_json::to_value(&report).expect("serialize");
        let object = value.as_object().expect("object");
        for banned in ["total", "passed", "failed", "fixtures"] {
            assert!(!object.contains_key(banned), "a skip must not carry {banned}: {value}");
        }
    }

    /// The store manifest lever resolves `ports.pg`; a manifest without it is a
    /// named error, never a silent zero port.
    #[test]
    fn the_manifest_lever_resolves_the_pg_port() {
        let dir = tempfile::tempdir().expect("tempdir");
        let good = dir.path().join("manifest.json");
        std::fs::write(&good, r#"{"ports":{"pg":5433}}"#).expect("write");
        assert_eq!(manifest_pg_port(&good).expect("resolves"), 5433);

        let bad = dir.path().join("bad.json");
        std::fs::write(&bad, r#"{"ports":{}}"#).expect("write");
        assert!(manifest_pg_port(&bad).is_err());
    }

    /// No `--pg-port` and `--manifest` together (the declared `|` value set).
    #[test]
    fn the_store_flags_are_mutually_exclusive() {
        use clap::Parser;
        #[derive(Debug, Parser)]
        struct Wrapper {
            #[command(flatten)]
            args: ScoreArgs,
        }
        assert!(
            Wrapper::try_parse_from(["x", "--pg-port", "5432", "--manifest", "m.json"]).is_err(),
            "the two store levers are alternatives, never both"
        );
        assert!(Wrapper::try_parse_from(["x", "--pg-port", "5432"]).is_ok());
        assert!(Wrapper::try_parse_from(["x", "--manifest", "m.json"]).is_ok());
    }

    /// The endpoint resolves from an explicit port, and the models lever resolves
    /// the documented way.
    #[test]
    fn the_store_and_models_levers_match_the_documented_rules() {
        assert_eq!(MODELS_DIR_LEVER, "FREDO_COMPANION_MODELS_DIR");
        assert_eq!(PG_PASSWORD_FILE_ENV, "FREDO_PG_PASSWORD_FILE");
        let resolved = home_dir().join("fredo-models");
        assert!(
            resolved.to_string_lossy().ends_with("fredo-models"),
            "the default models dir must end in fredo-models: {}",
            resolved.display()
        );

        let args = ScoreArgs {
            pg_port: Some(5433),
            ..empty_args()
        };
        let endpoint = resolve_store_endpoint(&args)
            .expect("an explicit port resolves")
            .expect("an explicit port yields an endpoint");
        assert_eq!(endpoint.port, 5433);
        assert!(endpoint.is_resolved());

        // No lever ⇒ no endpoint (the run scores without persisting, visibly).
        assert!(resolve_store_endpoint(&empty_args()).expect("no lever is fine").is_none());
    }

    /// The scratch-override seam (the F-183/F-184 live lever): an override
    /// replaces a committed fixture's expectation while its turn is UNCHANGED, and
    /// an unknown id is an error rather than a silent no-op.
    #[test]
    fn the_scratch_override_seam_replaces_an_expectation() {
        use crate::applications::llm_server::engine::score::expect::{evaluate, ObservedTurn};

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("scratch.json");
        std::fs::write(
            &path,
            r#"{"overrides":[{"id":"text-chat","expect":{"kind":"schema","name":"fredo_reply","require":["definitely_not_present"]}}]}"#,
        )
        .expect("write the scratch file");

        let mut set = fixtures::fixtures();
        apply_overrides(&mut set, &path).expect("the override applies");
        let text = set
            .iter()
            .find(|fixture| fixture.id == "text-chat")
            .expect("text-chat");
        let observed = ObservedTurn {
            content: r#"{"reply":"hi","status":"happy"}"#.to_string(),
            ..ObservedTurn::default()
        };
        assert!(
            !evaluate(&text.expect, &observed).passed,
            "the overridden (deliberately wrong) expectation must fail a matching outcome"
        );

        // An unknown fixture id is an error, never a silent no-op.
        let bad = dir.path().join("bad.json");
        std::fs::write(
            &bad,
            r#"{"overrides":[{"id":"nope","expect":{"kind":"schema","name":"x","require":[]}}]}"#,
        )
        .expect("write the bad scratch file");
        let mut set = fixtures::fixtures();
        assert!(apply_overrides(&mut set, &bad).is_err());
    }
}
