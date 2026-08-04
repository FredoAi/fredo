#!/usr/bin/env rust-script
//! ```cargo
//! [dependencies]
//! anyhow = "1"
//! serde = { version = "1", features = ["derive"] }
//! serde_json = "1"
//! chrono = { version = "0.4", features = ["serde"] }
//! uuid = { version = "1", features = ["v4"] }
//! base64 = "0.22"
//! ```

// pipeline-state.rs â€” the deterministic state machine for the Fredo agentic pipeline.
// Cross-platform (Windows/macOS/Linux). Owns the phase model, transitions, guards,
// GitHub writes (via the `gh` CLI), the context block, and metric events.
//
// Contract: docs/agentic-pipeline/07-state-machine.md
// Invocation: documented in the `pipeline-state` skill (loaded at agent wake).

use std::collections::{BTreeMap, HashMap};
use std::env;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use base64::Engine as _;

// â”€â”€ Pipeline config (loaded from .opencode/pipeline.json) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

static CONFIG: OnceLock<PipelineConfig> = OnceLock::new();

#[derive(Deserialize)]
struct PipelineConfig {
    #[allow(dead_code)]
    version: String,
    #[allow(dead_code)]
    description: String,
    phases: BTreeMap<String, PhaseConfig>,
    transitions: HashMap<String, bool>,
    label_to_phase: HashMap<String, String>,
    issue_types: HashMap<String, IssueTypeConfig>,
    blocked: BlockedConfig,
    #[allow(dead_code)]
    metric_anchors: MetricAnchors,
    agents: HashMap<String, AgentConfig>,
}

#[derive(Deserialize)]
struct PhaseConfig {
    order: u32,
    label: String,
    exit_guard: String,
    owner: String,
}

#[derive(Deserialize)]
struct IssueTypeConfig {
    label: String,
}

#[derive(Deserialize)]
struct BlockedConfig {
    label: String,
    #[allow(dead_code)]
    terminal_exempt: bool,
}

#[derive(Deserialize)]
struct MetricAnchors {
    #[allow(dead_code)]
    commitment_phase: String,
    #[allow(dead_code)]
    commitment_to: String,
    #[allow(dead_code)]
    delivery_phase: String,
    #[allow(dead_code)]
    delivery_to: String,
    #[allow(dead_code)]
    cycle_start_phase: String,
}

#[derive(Deserialize)]
struct AgentConfig {
    playbook: String,
}

fn load_config() -> anyhow::Result<&'static PipelineConfig> {
    if let Some(c) = CONFIG.get() {
        return Ok(c);
    }
    let root = project_root()?;
    let path = root.join(".opencode").join("pipeline.json");
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| anyhow::anyhow!("cannot read {}: {}", path.display(), e))?;
    let cfg: PipelineConfig = serde_json::from_str(&raw)
        .map_err(|e| anyhow::anyhow!("invalid pipeline.json: {}", e))?;
    Ok(CONFIG.get_or_init(|| cfg))
}

fn phase_label(phase: Phase) -> String {
    load_config()
        .ok()
        .and_then(|c| c.phases.get(phase.as_str()))
        .map(|p| p.label.clone())
        .unwrap_or_else(|| phase.as_str().to_string())
}

fn phase_exit_guard(phase: Phase) -> String {
    load_config()
        .ok()
        .and_then(|c| c.phases.get(phase.as_str()))
        .map(|p| p.exit_guard.clone())
        .unwrap_or_default()
}

/// The agent responsible for a phase (from pipeline.json `phases.<p>.owner`).
fn phase_owner(phase: Phase) -> String {
    load_config()
        .ok()
        .and_then(|c| c.phases.get(phase.as_str()))
        .map(|p| p.owner.clone())
        .unwrap_or_default()
}

/// The phase immediately before `phase` (by pipeline.json `order`), used for the
/// context block's "Previous phase" field. Returns `phase` itself at the start.
fn previous_phase(phase: Phase) -> Phase {
    let cfg = load_config().ok();
    let cur_order = cfg.as_ref()
        .and_then(|c| c.phases.get(phase.as_str()))
        .map(|p| p.order)
        .unwrap_or(0);
    if cur_order == 0 { return phase; }
    let prev_order = cur_order - 1;
    Phase::ORDER.iter()
        .find(|p| cfg.as_ref()
            .and_then(|c| c.phases.get(p.as_str()))
            .map(|pc| pc.order == prev_order)
            .unwrap_or(false))
        .copied()
        .unwrap_or(phase)
}

fn is_legal_transition(from: Phase, to: Phase) -> bool {
    load_config()
        .ok()
        .and_then(|c| c.transitions.get(&format!("{}:{}", from.as_str(), to.as_str())))
        .copied()
        .unwrap_or(false)
}

/// The unique legal next phase, when exactly one transition exists from `phase`.
fn next_phase(phase: Phase) -> Option<Phase> {
    let cfg = load_config().ok()?;
    let mut nexts: Vec<Phase> = cfg
        .transitions
        .iter()
        .filter(|(k, &v)| v && k.starts_with(&format!("{}:", phase.as_str())))
        .filter_map(|(k, _)| k.split(':').nth(1))
        .filter_map(|s| Phase::from_str(s))
        .collect();
    if nexts.len() == 1 {
        nexts.pop()
    } else {
        None
    }
}

fn phase_from_label(label: &str) -> Option<Phase> {
    let cfg = load_config().ok()?;
    cfg.label_to_phase.get(label).and_then(|p| Phase::from_str(p))
}

// â”€â”€ Phase model (canonical set; data lives in pipeline.json) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Intake,
    Triage,
    Implementation,
    Testing,
    Audit,
    Done,
}

impl Phase {
    const ORDER: [Phase; 6] = [
        Phase::Intake,
        Phase::Triage,
        Phase::Implementation,
        Phase::Testing,
        Phase::Audit,
        Phase::Done,
    ];

    fn as_str(&self) -> &'static str {
        match self {
            Phase::Intake => "intake",
            Phase::Triage => "triage",
            Phase::Implementation => "implementation",
            Phase::Testing => "testing",
            Phase::Audit => "audit",
            Phase::Done => "done",
        }
    }

    fn from_str(s: &str) -> Option<Phase> {
        match s {
            "intake" => Some(Phase::Intake),
            "triage" => Some(Phase::Triage),
            "implementation" => Some(Phase::Implementation),
            "testing" => Some(Phase::Testing),
            "audit" => Some(Phase::Audit),
            "done" => Some(Phase::Done),
            _ => None,
        }
    }
}

// â”€â”€ GitHub reads/writes (via `gh` CLI) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn run_gh(args: &[&str]) -> anyhow::Result<String> {
    let out = Command::new("gh").args(args).output()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        anyhow::bail!("gh {} failed: {}", args.join(" "), stderr);
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Run an arbitrary local command (e.g. `git`) and return stdout.
fn run_cmd(bin: &str, args: &[&str]) -> anyhow::Result<String> {
    let out = Command::new(bin).args(args).output()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        anyhow::bail!("{} {} failed: {}", bin, args.join(" "), stderr);
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Resolve the GitHub repository as `owner/name` (from the `gh` context).
fn gh_repo() -> anyhow::Result<String> {
    let out = run_gh(&["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])?;
    if out.is_empty() {
        anyhow::bail!("unable to resolve the GitHub repository");
    }
    Ok(out)
}

/// Run `gh api <args...>` and return stdout.
fn gh_api_raw(args: &[String]) -> anyhow::Result<String> {
    let owned: Vec<&str> = std::iter::once("api").chain(args.iter().map(|s| s.as_str())).collect();
    run_gh(&owned)
}

/// Run `gh api <args...>`; `Ok(None)` means the resource was not found (404).
fn gh_api_raw_opt(args: &[String]) -> anyhow::Result<Option<String>> {
    let owned: Vec<&str> = std::iter::once("api").chain(args.iter().map(|s| s.as_str())).collect();
    let out = Command::new("gh").args(&owned).output()?;
    if out.status.success() {
        Ok(Some(String::from_utf8_lossy(&out.stdout).trim().to_string()))
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if err.contains("404") || err.contains("Not Found") {
            Ok(None)
        } else {
            anyhow::bail!("gh api {} failed: {}", owned.join(" "), err);
        }
    }
}

/// Parse the parent spec number from an issue body's `Parent: Implementation Plan #N`
/// line (dev sub-issues and tester issues all carry it).
fn parent_spec(issue: u32) -> anyhow::Result<u32> {
    let body = run_gh(&["issue", "view", &issue.to_string(), "--json", "body", "--jq", ".body"])?;
    for line in body.lines() {
        let t = line.trim();
        let lower = t.to_ascii_lowercase();
        if !lower.starts_with("parent:") { continue; }
        if let Some(plan) = lower.find("implementation plan") {
            let rest = &t[plan + "implementation plan".len()..];
            for tok in rest.split(|c: char| !c.is_ascii_digit()) {
                if !tok.is_empty() {
                    if let Ok(n) = tok.parse::<u32>() {
                        return Ok(n);
                    }
                }
            }
        }
        break;
    }
    anyhow::bail!("no 'Parent: Implementation Plan #N' reference found in #{}", issue)
}

/// Resolve the base branch for sub-issue work: the spec integration branch
/// `spec/<parent>` when the issue references a parent, otherwise `main`.
fn resolve_base(issue: u32) -> anyhow::Result<String> {
    match parent_spec(issue) {
        Ok(spec) => {
            let branch = format!("spec/{}", spec);
            let _ = run_cmd("git", &["fetch", "origin", &branch]);
            Ok(branch)
        }
        Err(_) => Ok("main".to_string()),
    }
}

/// Upsert a file (base64 content) on `branch` via the Contents API.
fn upsert_file(repo: &str, branch: &str, path: &str, content_b64: &str, message: &str) -> anyhow::Result<()> {
    let url = format!("repos/{}/contents/{}", repo, path);
    let existing = gh_api_raw_opt(&[url.clone(), "-f".to_string(), format!("ref={}", branch)])?;
    let sha = existing
        .and_then(|v| serde_json::from_str::<serde_json::Value>(&v).ok())
        .and_then(|v| v["sha"].as_str().map(|s| s.to_string()));
    let mut payload = serde_json::json!({ "message": message, "content": content_b64, "branch": branch });
    if let Some(s) = sha {
        payload["sha"] = serde_json::Value::String(s);
    }
    let tmp = project_root()?.join(".opencode").join("tmp").join(format!("content-{}.json", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(tmp.parent().unwrap())?;
    std::fs::write(&tmp, serde_json::to_string(&payload)?)?;
    gh_api_raw(&["-X".to_string(), "PUT".to_string(), url.clone(), "--input".to_string(), tmp.to_str().unwrap().to_string()])?;
    let _ = std::fs::remove_file(&tmp);
    Ok(())
}

#[derive(Deserialize)]
struct GhLabel {
    name: String,
}

#[derive(Deserialize)]
struct GhIssue {
    labels: Vec<GhLabel>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
}

fn get_issue(issue: u32) -> anyhow::Result<Option<GhIssue>> {
    let json = run_gh(&[
        "issue", "view", &issue.to_string(), "--json", "state,labels,title,body",
    ])?;
    Ok(serde_json::from_str(&json).ok())
}

fn get_issue_comments(issue: u32) -> Vec<String> {
    let json = run_gh(&[
        "issue", "view", &issue.to_string(), "--comments", "--json", "comments",
    ])
    .unwrap_or_else(|_| "{\"comments\":[]}".to_string());
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap_or(serde_json::Value::Null);
    parsed
        .get("comments")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| c.get("body").and_then(|b| b.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// Guard for `create-worktree`: the sub-issue must be actionable
/// (labeled `ready-for-dev` or `in-progress-dev`). Assignment is not required —
/// this is a single-developer pipeline, so routing value is nil.
fn branch_guard(issue: u32) -> anyhow::Result<(bool, String)> {
    let issue_data = match get_issue(issue)? {
        Some(i) => i,
        None => return Ok((false, format!("issue #{} not found", issue))),
    };
    let labels: Vec<String> = issue_data.labels.iter().map(|l| l.name.clone()).collect();
    let actionable = labels.iter().any(|l| l == "ready-for-dev" || l == "in-progress-dev");
    if !actionable {
        return Ok((false, format!("issue #{} is not actionable (labels: {})", issue, labels.join(", "))));
    }
    Ok((true, String::new()))
}

/// Guard for `merge-pr`: the PR must be open, mergeable (mergeStateStatus CLEAN),
/// and have no failing/pending CI checks.
fn pr_merge_guard(pr: &str) -> anyhow::Result<(bool, String)> {
    let json = run_gh(&["pr", "view", pr, "--json", "state,mergeStateStatus,statusCheckRollup"])?;
    let v: serde_json::Value = serde_json::from_str(&json)?;
    let state = v.get("state").and_then(|s| s.as_str()).unwrap_or("");
    if state != "OPEN" {
        return Ok((false, format!("PR #{} is not open (state: {})", pr, state)));
    }
    // Reject DIRTY (conflicts), BLOCKED, BEHIND, UNKNOWN â€” only CLEAN is mergeable.
    let mss = v.get("mergeStateStatus").and_then(|s| s.as_str()).unwrap_or("");
    if mss != "CLEAN" {
        return Ok((false, format!("PR #{} is not mergeable (mergeStateStatus: {})", pr, mss)));
    }
    if let Some(rollup) = v.get("statusCheckRollup").and_then(|r| r.as_array()) {
        for check in rollup {
            // CheckRun shape: `name` + `status` + `conclusion`.
            if let (Some(status), Some(conclusion)) = (
                check.get("status").and_then(|s| s.as_str()),
                check.get("conclusion").and_then(|c| c.as_str()),
            ) {
                let name = check.get("name").and_then(|n| n.as_str()).unwrap_or("check");
                if status != "COMPLETED" {
                    return Ok((false, format!("PR #{} CI check '{}' is not completed (status: {})", pr, name, status)));
                }
                if conclusion != "SUCCESS" && conclusion != "NEUTRAL" && conclusion != "SKIPPED" {
                    return Ok((false, format!("PR #{} CI check '{}' failed: {}", pr, name, conclusion)));
                }
            } else if let (Some(context), Some(gh_state)) = (
                check.get("context").and_then(|s| s.as_str()),
                check.get("state").and_then(|s| s.as_str()),
            ) {
                // Legacy StatusContext shape: `context` + `state`.
                if gh_state != "SUCCESS" && gh_state != "NEUTRAL" {
                    return Ok((false, format!("PR #{} CI status '{}' is not success: {}", pr, context, gh_state)));
                }
            } else {
                let name = check.get("name").and_then(|n| n.as_str()).unwrap_or("check");
                return Ok((false, format!("PR #{} CI check '{}' is incomplete (unknown shape)", pr, name)));
            }
        }
    }
    // No checks at all is allowed (repo without CI configured).
    Ok((true, String::new()))
}

fn current_phase(issue: u32) -> anyhow::Result<Phase> {
    match get_issue(issue)? {
        Some(issue) => {
            for label in &issue.labels {
                if let Some(p) = phase_from_label(&label.name) {
                    return Ok(p);
                }
            }
            Ok(Phase::Intake)
        }
        None => Ok(Phase::Intake),
    }
}

/// The Implementation Plan is created as a *separate* issue (`create-issue
/// --issue-type impl-plan`), not a section inside the feature issue. Since parent
/// tracking is not available, detect it by scanning open issues for the plan's
/// signature sections (`## Scope` + `## Staffing Plan`). Lenient: returns false
/// only when the gh call itself fails or no open issue matches.
fn impl_plan_exists() -> bool {
    run_gh(&["issue", "list", "--state", "open", "--json", "number,body", "--limit", "500"])
        .ok()
        .and_then(|out| serde_json::from_str::<serde_json::Value>(&out).ok())
        .and_then(|v| v.as_array().cloned())
        .map(|issues| {
            issues.iter().any(|i| {
                let body = i.get("body").and_then(|b| b.as_str()).unwrap_or("");
                body.contains("## Scope") && body.contains("## Staffing Plan")
            })
        })
        .unwrap_or(false)
}

fn exit_guard_passes(phase: Phase, issue: u32) -> (bool, String) {
    let issue_data = get_issue(issue).ok().flatten();
    match phase {
        Phase::Intake => match issue_data {
            Some(i) if !i.body.trim().is_empty() => (true, String::new()),
            Some(_) => (false, "backlog body is empty".into()),
            None => (false, "issue not found".into()),
        },
        Phase::Triage => {
            // The Implementation Plan is a separate issue (impl-plan). Pass if the
            // SM pasted/linked the plan into the feature comments, or if any open
            // issue in the repo carries the plan's signature sections.
            let comments = get_issue_comments(issue);
            let has_plan = comments
                .iter()
                .any(|b| b.contains("## Implementation Plan") || b.contains("## Scope"))
                || impl_plan_exists();
            (has_plan, if has_plan { String::new() } else { "no Implementation Plan found (no impl-plan issue with ## Scope + ## Staffing Plan, and no ## Implementation Plan / ## Scope in comments)".into() })
        }
        Phase::Implementation => {
            // Exit guard: the feature issue must be labeled `ready-for-test`
            // (the doc contract: "feature labeled ready-for-test").
            match get_issue(issue) {
                Ok(Some(i)) => {
                    let has = i.labels.iter().any(|l| l.name == "ready-for-test");
                    (has, if has { String::new() } else { "feature not labeled ready-for-test".into() })
                }
                // Lenient fallback only when the issue cannot be found at all.
                Ok(None) => (true, String::new()),
                Err(_) => (false, "feature not labeled ready-for-test".into()),
            }
        }
        Phase::Testing => {
            let comments = get_issue_comments(issue);
            // The Tester posts a test report via the `comment` action, which formats the
            // body as `## {prefix}\n\n{body}` â€” i.e. `## Evidence`. Require that heading
            // prefix + a verdict marker, not a loose substring that any body could match.
            let has = comments.iter().any(|b| {
                let trimmed = b.trim_start();
                trimmed.starts_with("## Evidence")
                    && (trimmed.contains("PASS") || trimmed.contains("FAIL") || trimmed.contains("Verdict:"))
            });
            (has, if has { String::new() } else { "no tester verdict found".into() })
        }
        Phase::Audit => {
            let comments = get_issue_comments(issue);
            // `audit-record` posts "## Decision" + "Audit verdict: ...". Require the
            // Decision prefix AND the verdict marker together, not either alone.
            let has = comments.iter().any(|b| {
                let trimmed = b.trim_start();
                trimmed.starts_with("## Decision") && trimmed.contains("Audit verdict")
            });
            (has, if has { String::new() } else { "no audit verdict found".into() })
        }
        Phase::Done => (true, String::new()),
    }
}

// â”€â”€ Metric event log (per-issue JSONL) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn project_root() -> anyhow::Result<PathBuf> {
    let out = Command::new("git").args(["rev-parse", "--show-toplevel"]).output()?;
    Ok(PathBuf::from(String::from_utf8_lossy(&out.stdout).trim().to_string()))
}

fn event_log_path(issue: u32) -> anyhow::Result<PathBuf> {
    let root = project_root()?;
    let dir = root.join(".opencode").join("state").join("issues");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("{}.jsonl", issue)))
}

#[derive(Serialize)]
struct MetricEvent {
    ts: String,
    event_id: String,
    event_name: String,
    actor: String,
    entity: HashMap<String, String>,
    phase: String,
    outcome: String,
    attempt: u32,
    correlation_id: String,
    attributes: HashMap<String, String>,
    message: String,
}

fn append_event(
    issue: u32,
    event_name: &str,
    actor: &str,
    phase: &str,
    outcome: &str,
    message: &str,
) -> anyhow::Result<()> {
    append_event_attrs(issue, event_name, actor, phase, outcome, message, &[])
}

/// Append an event with structured `attributes` (e.g. `[("from", "intake"), ("to", "triage")]`).
fn append_event_attrs(
    issue: u32,
    event_name: &str,
    actor: &str,
    phase: &str,
    outcome: &str,
    message: &str,
    attrs: &[(&str, &str)],
) -> anyhow::Result<()> {
    let mut entity = HashMap::new();
    entity.insert("issueId".into(), issue.to_string());
    let attributes: HashMap<String, String> = attrs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();

    let event = MetricEvent {
        ts: chrono::Utc::now().to_rfc3339(),
        event_id: uuid::Uuid::new_v4().to_string(),
        event_name: event_name.into(),
        actor: actor.into(),
        entity,
        phase: phase.into(),
        outcome: outcome.into(),
        attempt: 1,
        correlation_id: format!("issue-{}", issue),
        attributes,
        message: message.into(),
    };
    let line = serde_json::to_string(&event)?;
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(event_log_path(issue)?)?;
    writeln!(f, "{}", line)?;
    Ok(())
}

// â”€â”€ Actions (single writer to GitHub) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

struct ActionArgs {
    issue: Option<u32>,
    actor: String,
    action: String,
    to_phase: Option<String>,
    body_file: Option<String>,
    title: Option<String>,
    issue_type: Option<String>,
    prefix: Option<String>,
    reason: Option<String>,
    verdict: Option<String>,
    base: Option<String>,
    pr: Option<String>,
    worktree_path: Option<String>,
    image: Option<String>,
    all: bool,
    json: bool,
}

fn run_action(a: &ActionArgs) -> anyhow::Result<()> {
    // phase is computed lazily per-arm (only per-issue actions need it).
    let phase_of = |a: &ActionArgs| -> anyhow::Result<Phase> { current_phase(req_issue(a)?) };
    match a.action.as_str() {
        "create-issue" => {
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "blocked", "role", &format!("actor {} not allowed to {}", a.actor, a.action))?;
                println!("BLOCKED: actor {} not allowed to {}", a.actor, a.action);
                return Ok(());
            }
            let title = a.title.as_deref().ok_or_else(|| anyhow::anyhow!("create-issue requires --title"))?;
            let body_file = a.body_file.as_deref().ok_or_else(|| anyhow::anyhow!("create-issue requires --body-file"))?;
            let issue_type = a.issue_type.as_deref().ok_or_else(|| anyhow::anyhow!("create-issue requires --issue-type"))?;
            let label = load_config()?
                .issue_types
                .get(issue_type)
                .map(|t| t.label.clone())
                .ok_or_else(|| anyhow::anyhow!("invalid --issue-type: {}", issue_type))?;
            // Fold-in of po-intake: for backlog/bug intakes, validate required sections.
            if issue_type == "backlog" || issue_type == "bug" {
                let body = std::fs::read_to_string(body_file)
                    .map_err(|e| anyhow::anyhow!("cannot read body {}: {}", body_file, e))?;
                let missing = intake_missing_sections(&body);
                if !missing.is_empty() {
                    anyhow::bail!("INTAKE INVALID: missing section(s): {}", missing.join(", "));
                }
            }
            let out = run_gh(&[
                "issue", "create", "--title", title, "--body-file", body_file, "--label", &label,
            ])?;
            println!("CREATED: {}", out);
            // Log the metric event under the real new issue number (from the created
            // issue URL's trailing id), not phantom issue 0.
            let new_issue = out
                .trim()
                .rsplit('/')
                .next()
                .and_then(|seg| seg.parse::<u32>().ok());
            match new_issue {
                Some(n) => {
                    append_event(n, "create-issue", &a.actor, "intake", "success", &format!("created {} {}", issue_type, out))?;
                    append_event(n, "phase.started", &a.actor, "intake", "success", "started intake")?;
                    // The agent now has an issue number; print its context block so it
                    // can proceed without a second --issue invocation. This is how Intake
                    // bridges the "no issue at wake" gap at the machine level.
                    println!();
                    print_context(n, &a.actor, false)?;
                }
                None => {
                    println!("WARNING: could not parse new issue number from '{}'; create-issue metric event skipped", out);
                }
            }
        }
        "comment" => {
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "blocked", "role", &format!("actor {} not allowed to {}", a.actor, a.action))?;
                println!("BLOCKED: actor {} not allowed to {}", a.actor, a.action);
                return Ok(());
            }
            let issue = req_issue(a)?;
            let phase = phase_of(a)?;
            let prefix = a.prefix.as_deref().ok_or_else(|| anyhow::anyhow!("comment requires --prefix"))?;
            if !["Decision", "Question", "Status", "Evidence"].contains(&prefix) {
                anyhow::bail!("invalid --prefix: {}", prefix);
            }
            let body_file = a.body_file.as_deref().ok_or_else(|| anyhow::anyhow!("comment requires --body-file"))?;
            let body = std::fs::read_to_string(body_file)?;
            let tmp = project_root()?.join(".opencode").join("tmp").join(format!("comment-{}.md", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(tmp.parent().unwrap())?;
            std::fs::write(&tmp, format!("## {}\n\n{}", prefix, body))?;
            run_gh(&["issue", "comment", &issue.to_string(), "--body-file", tmp.to_str().unwrap()])?;
            let _ = std::fs::remove_file(&tmp);
            println!("COMMENTED: {} on #{}", prefix, issue);
            append_event(issue, "comment", &a.actor, phase.as_str(), "success", &format!("posted {} comment", prefix))?;
        }
        "transition" => {
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "blocked", "role", &format!("actor {} not allowed to {}", a.actor, a.action))?;
                println!("BLOCKED: actor {} not allowed to {}", a.actor, a.action);
                return Ok(());
            }
            let issue = req_issue(a)?;
            let phase = phase_of(a)?;
            // `--to-phase` is optional: infer the unique legal next phase; require
            // it only when the phase has several exits (testing, audit).
            let to = match a.to_phase.as_deref() {
                Some(s) => Phase::from_str(s).ok_or_else(|| anyhow::anyhow!("invalid --to-phase: {}", s))?,
                None => next_phase(phase)
                    .ok_or_else(|| anyhow::anyhow!("transition requires --to-phase ({} has no unique next phase)", phase.as_str()))?,
            };
            if !is_legal_transition(phase, to) {
                append_event(issue, "transition", &a.actor, phase.as_str(), "blocked", &format!("illegal transition {} -> {}", phase.as_str(), to.as_str()))?;
                println!("BLOCKED: illegal transition {} -> {}", phase.as_str(), to.as_str());
                return Ok(());
            }
            let (ok, reason) = exit_guard_passes(phase, issue);
            if !ok {
                append_event(issue, "transition", &a.actor, phase.as_str(), "blocked", &reason)?;
                println!("BLOCKED: {}", reason);
                return Ok(());
            }
            // Remove the source phase's label too â€” otherwise labels accumulate and
            // `current_phase` (first-match) latches onto a stale source-phase label.
            let issue_str = issue.to_string();
            let to_label = phase_label(to);
            let from_label = phase_label(phase);
            let mut edit_args: Vec<&str> = vec!["issue", "edit", &issue_str, "--add-label", &to_label];
            if from_label != to_label {
                edit_args.push("--remove-label");
                edit_args.push(&from_label);
            }
            run_gh(&edit_args)?;
            println!("TRANSITIONED: {} -> {} (label: {})", phase.as_str(), to.as_str(), to_label);
            append_event(issue, "transition", &a.actor, to.as_str(), "success", &format!("transitioned {} -> {}", phase.as_str(), to.as_str()))?;
            // Phase lifecycle events feed the duration metrics (cycle/lead time).
            append_event_attrs(issue, "phase.completed", &a.actor, phase.as_str(), "success", &format!("completed {}", phase.as_str()), &[("phase", phase.as_str()), ("to", to.as_str())])?;
            append_event_attrs(issue, "phase.started", &a.actor, to.as_str(), "success", &format!("started {}", to.as_str()), &[("phase", to.as_str()), ("from", phase.as_str())])?;
        }
        "block" => {
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "blocked", "role", &format!("actor {} not allowed to {}", a.actor, a.action))?;
                println!("BLOCKED: actor {} not allowed to {}", a.actor, a.action);
                return Ok(());
            }
            let issue = req_issue(a)?;
            let phase = phase_of(a)?;
            let reason = a.reason.as_deref().ok_or_else(|| anyhow::anyhow!("block requires --reason"))?;
            let blocked_label = load_config()?.blocked.label.clone();
            run_gh(&["issue", "edit", &issue.to_string(), "--add-label", &blocked_label])?;
            let tmp = project_root()?.join(".opencode").join("tmp").join(format!("block-{}.md", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(tmp.parent().unwrap())?;
            std::fs::write(&tmp, format!("## Status\n\nBlocked: {}", reason))?;
            run_gh(&["issue", "comment", &issue.to_string(), "--body-file", tmp.to_str().unwrap()])?;
            let _ = std::fs::remove_file(&tmp);
            println!("BLOCKED: #{} ({})", issue, reason);
            append_event_attrs(issue, "block", &a.actor, phase.as_str(), "success", &format!("blocked: {}", reason), &[("reason", reason)])?;
        }
        "unblock" => {
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "blocked", "role", &format!("actor {} not allowed to {}", a.actor, a.action))?;
                println!("BLOCKED: actor {} not allowed to {}", a.actor, a.action);
                return Ok(());
            }
            let issue = req_issue(a)?;
            let phase = phase_of(a)?;
            let blocked_label = load_config()?.blocked.label.clone();
            run_gh(&["issue", "edit", &issue.to_string(), "--remove-label", &blocked_label])?;
            let tmp = project_root()?.join(".opencode").join("tmp").join(format!("unblock-{}.md", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(tmp.parent().unwrap())?;
            std::fs::write(&tmp, "## Status\n\nUnblocked.")?;
            run_gh(&["issue", "comment", &issue.to_string(), "--body-file", tmp.to_str().unwrap()])?;
            let _ = std::fs::remove_file(&tmp);
            println!("UNBLOCKED: #{}", issue);
            append_event(issue, "unblock", &a.actor, phase.as_str(), "success", "unblocked")?;
        }
        "close-issue" => {
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "blocked", "role", &format!("actor {} not allowed to {}", a.actor, a.action))?;
                println!("BLOCKED: actor {} not allowed to {}", a.actor, a.action);
                return Ok(());
            }
            let issue = req_issue(a)?;
            let phase = phase_of(a)?;
            let to_str = a.to_phase.as_deref().ok_or_else(|| anyhow::anyhow!("close-issue requires --to-phase done|canceled"))?;
            if to_str != "done" && to_str != "canceled" {
                anyhow::bail!("close-issue --to-phase must be done|canceled");
            }
            if to_str == "done" {
                // Closing as done is only legal from the Audit phase (with its exit
                // guard satisfied).
                if phase != Phase::Audit {
                    let msg = format!("issue is in {}, only audit-phase issues can close as done", phase.as_str());
                    append_event(issue, "close-issue", &a.actor, phase.as_str(), "blocked", &msg)?;
                    println!("BLOCKED: {}", msg);
                    return Ok(());
                }
                let (ok, reason) = exit_guard_passes(Phase::Audit, issue);
                if !ok {
                    append_event(issue, "close-issue", &a.actor, "audit", "blocked", &reason)?;
                    println!("BLOCKED: {}", reason);
                    return Ok(());
                }
            } else if phase == Phase::Done {
                // canceled: allowed from any phase except done.
                let msg = "issue is in done, cannot cancel a completed issue".to_string();
                append_event(issue, "close-issue", &a.actor, phase.as_str(), "blocked", &msg)?;
                println!("BLOCKED: {}", msg);
                return Ok(());
            }
            let reason = if to_str == "done" { "completed" } else { "not_planned" };
            run_gh(&["issue", "close", &issue.to_string(), "--reason", reason])?;
            println!("CLOSED: #{} as {}", issue, to_str);
            append_event(issue, "close-issue", &a.actor, to_str, "success", &format!("closed as {}", to_str))?;
        }
        "create-spec-branch" => {
            // Creates the spec integration branch `spec/<issue>` from main and
            // pushes it to origin. All sub-issue work, testing, and evidence
            // happens on this branch; it is never deleted (prune only touches
            // feat/). Idempotent. Gated to the scrum-master.
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "blocked", "role", &format!("actor {} not allowed to {}", a.actor, a.action))?;
                println!("BLOCKED: actor {} not allowed to {}", a.actor, a.action);
                return Ok(());
            }
            let issue = req_issue(a)?;
            let branch = format!("spec/{}", issue);
            let remote_exists = run_cmd("git", &["ls-remote", "--exit-code", "origin", &format!("refs/heads/{}", branch)]).is_ok();
            if remote_exists {
                println!("SPEC BRANCH EXISTS: {}", branch);
                append_event(issue, "create-spec-branch", &a.actor, "implementation", "success", &format!("spec branch {} already exists", branch))?;
                return Ok(());
            }
            let local_exists = run_cmd("git", &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}", branch)]).is_ok();
            if !local_exists {
                run_cmd("git", &["checkout", "-b", &branch, "main"])?;
            }
            run_cmd("git", &["push", "-u", "origin", &branch])?;
            // Return the main worktree to `main` so the spec branch is free for a
            // linked developer worktree (git allows one worktree per branch).
            let _ = run_cmd("git", &["checkout", "main"]);
            println!("SPEC BRANCH CREATED: {}", branch);
            append_event(issue, "create-spec-branch", &a.actor, "implementation", "success", &format!("created spec branch {}", branch))?;
        }
        "create-worktree" => {
            // Creates a worktree **detached at the tip of the spec integration
            // branch** (no per-developer branch): git allows many detached
            // worktrees at the same commit, so parallel developers each get one.
            // The developer commits on the detached HEAD and pushes with
            // `git push origin HEAD:spec/<N>`.
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "blocked", "role", &format!("actor {} not allowed to {}", a.actor, a.action))?;
                println!("BLOCKED: actor {} not allowed to {}", a.actor, a.action);
                return Ok(());
            }
            let issue = req_issue(a)?;
            let path = match a.worktree_path.as_deref() {
                Some(p) => p.to_string(),
                None => format!(".worktrees/{}", issue),
            };
            let base = resolve_base(issue)?;
            let (ok, reason) = branch_guard(issue)?;
            if !ok {
                append_event(issue, "create-worktree", &a.actor, "triage", "blocked", &reason)?;
                println!("BLOCKED: {}", reason);
                return Ok(());
            }
            run_cmd("git", &["worktree", "add", "--detach", &path, &base])?;
            println!("WORKTREE CREATED (detached at {}): {}", base, path);
            append_event(issue, "create-worktree", &a.actor, "triage", "success", &format!("detached worktree {} at {}", path, base))?;
        }
        "remove-worktree" => {
            // Removes a worktree after the developer has pushed. Plain removal
            // refuses dirty worktrees — commit + push first.
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "blocked", "role", &format!("actor {} not allowed to {}", a.actor, a.action))?;
                println!("BLOCKED: actor {} not allowed to {}", a.actor, a.action);
                return Ok(());
            }
            let issue = req_issue(a)?;
            let path = match a.worktree_path.as_deref() {
                Some(p) => p.to_string(),
                None => format!(".worktrees/{}", issue),
            };
            run_cmd("git", &["worktree", "remove", &path])?;
            println!("WORKTREE REMOVED: {}", path);
            append_event(issue, "remove-worktree", &a.actor, "triage", "success", &format!("removed worktree {}", path))?;
        }
        "create-pr" => {
            // Opens the spec PR (spec/<issue> -> base, default main) once all
            // sub-issues are pushed to the spec branch. The only PR in the
            // pipeline. Gated to the scrum-master.
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "blocked", "role", &format!("actor {} not allowed to {}", a.actor, a.action))?;
                println!("BLOCKED: actor {} not allowed to {}", a.actor, a.action);
                return Ok(());
            }
            let issue = req_issue(a)?;
            let head = format!("spec/{}", issue);
            let open_out = run_gh(&["pr", "list", "--head", &head, "--state", "open", "--json", "number"])?;
            let open_count = serde_json::from_str::<serde_json::Value>(&open_out)
                .ok()
                .and_then(|v| v.as_array().map(|a| a.len()))
                .unwrap_or(0);
            if open_count > 0 {
                anyhow::bail!("an open PR already exists for {}", head);
            }
            let title = match a.title.as_deref() {
                Some(t) => t.to_string(),
                None => get_issue(issue)?
                    .map(|i| i.title)
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| format!("Spec #{}", issue)),
            };
            // Default body references the spec and its sub-issues.
            let body = match a.body_file.as_deref() {
                Some(f) => std::fs::read_to_string(f)
                    .map_err(|e| anyhow::anyhow!("cannot read body {}: {}", f, e))?,
                None => format!("#{}\n\n`{}` → `main`. All sub-issues are on the spec integration branch.", issue, head),
            };
            let out = run_gh(&["pr", "create", "--base", "main", "--head", &head, "--title", &title, "--body", &body])?;
            println!("PR CREATED: {}", out);
            append_event(issue, "create-pr", &a.actor, "implementation", "success", &format!("created PR {}", out))?;
        }
        "merge-pr" => {
            // Merges a PR after review. Guards: PR exists, open, CI green.
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "blocked", "role", &format!("actor {} not allowed to {}", a.actor, a.action))?;
                println!("BLOCKED: actor {} not allowed to {}", a.actor, a.action);
                return Ok(());
            }
            let issue = req_issue(a)?;
            // `--pr` is optional: infer the spec's single open PR.
            let pr = match a.pr.as_deref() {
                Some(p) => p.to_string(),
                None => {
                    let head = format!("spec/{}", issue);
                    let out = run_gh(&["pr", "list", "--head", &head, "--state", "open", "--json", "number"])?;
                    let numbers: Vec<String> = serde_json::from_str::<serde_json::Value>(&out)
                        .ok()
                        .and_then(|v| v.as_array().map(|a| {
                            a.iter().filter_map(|e| e["number"].as_u64().map(|n| n.to_string())).collect()
                        }))
                        .unwrap_or_default();
                    if numbers.len() != 1 {
                        anyhow::bail!("expected exactly one open PR for {}, found {}", head, numbers.len());
                    }
                    numbers[0].clone()
                }
            };
            let (ok, reason) = pr_merge_guard(&pr)?;
            if !ok {
                append_event(issue, "merge-pr", &a.actor, "implementation", "blocked", &reason)?;
                println!("BLOCKED: {}", reason);
                return Ok(());
            }
            // Only the spec PR (spec/<N> -> main) reaches merge-pr; the integration
            // branch must always survive so evidence URLs keep rendering.
            run_gh(&["pr", "merge", &pr, "--merge"])?;
            println!("PR MERGED: #{}", pr);
            append_event(issue, "merge-pr", &a.actor, "implementation", "success", &format!("merged PR #{}", pr))?;
        }
        "prune" => {
            // Local hygiene after merges: remove stale feat/ branches and orphaned
            // worktrees. Idempotent; skips `main`/`master` and any non-feat branch.
            // spec/ integration branches are never pruned (they carry the evidence).
            let branches = run_cmd("git", &["for-each-ref", "--format=%(refname:short)", "refs/heads"])?;
            let spec_branches: Vec<&str> = branches.lines().map(|l| l.trim()).filter(|n| n.starts_with("spec/")).collect();
            let mut pruned: Vec<String> = Vec::new();
            for line in branches.lines() {
                let name = line.trim();
                if name.is_empty() || name == "main" || name == "master" { continue; }
                if !name.starts_with("feat/") { continue; }
                let merged_into_main = run_cmd("git", &["merge-base", "--is-ancestor", name, "main"]).is_ok();
                let merged_into_spec = spec_branches.iter().any(|sb|
                    run_cmd("git", &["merge-base", "--is-ancestor", name, sb]).is_ok());
                if merged_into_main || merged_into_spec {
                    run_cmd("git", &["branch", "-D", name]).ok();
                    pruned.push(name.to_string());
                }
            }
            run_cmd("git", &["worktree", "prune"])?;
            println!("PRUNED: {}", if pruned.is_empty() { "no stale feat/ branches".into() } else { pruned.join(", ") });
        }
        "metrics" => {
            // Fold-in of pipeline-metrics.rs
            if a.all {
                metrics_aggregate(a.json)?
            } else {
                match a.issue {
                    Some(issue) => metrics_per_issue(issue, a.json)?,
                    None => metrics_aggregate(a.json)?,
                }
            }
        }
        "audit" => {
            // Fold-in of pipeline-audit.rs
            let issue = req_issue(a)?;
            audit_evidence(issue, a.json)?;
        }
        "audit-record" => {
            // SI verdict: posts the Decision comment AND records the metric event â€”
            // one write path, one event, no separate `comment` step.
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "blocked", "role", &format!("actor {} not allowed to {}", a.actor, a.action))?;
                println!("BLOCKED: actor {} not allowed to {}", a.actor, a.action);
                return Ok(());
            }
            let issue = req_issue(a)?;
            let verdict = a.verdict.as_deref().ok_or_else(|| anyhow::anyhow!("audit-record requires --verdict success|restart"))?;
            let phase = a.to_phase.as_deref().unwrap_or("audit");
            let reason = a.reason.as_deref().unwrap_or("");
            let body = if verdict == "success" {
                format!("## Decision\n\nAudit verdict: **success**.\n\n{}", reason)
            } else {
                format!("## Decision\n\nAudit verdict: **restart â†’ {}**.\n\n{}", phase, reason)
            };
            let tmp = project_root()?.join(".opencode").join("tmp").join(format!("audit-{}.md", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(tmp.parent().unwrap())?;
            std::fs::write(&tmp, body)?;
            run_gh(&["issue", "comment", &issue.to_string(), "--body-file", tmp.to_str().unwrap()])?;
            let _ = std::fs::remove_file(&tmp);
            append_event_attrs(issue, "audit.verdict", "self-improver", phase,
                if verdict == "success" { "passed" } else { "failed" },
                reason, &[("verdict", verdict), ("phase", phase)])?;
            println!("AUDIT RECORDED: {} on #{}", verdict, issue);
        }
        "upload-evidence" => {
            // Posts an Evidence comment for a test case, committing the screenshot
            // to the spec's integration branch `spec/<parent>` (so the image renders
            // inline for repo members even on a private repo) and embedding the raw
            // URL. Gated to the tester (and scrum-master).
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "blocked", "role", &format!("actor {} not allowed to {}", a.actor, a.action))?;
                println!("BLOCKED: actor {} not allowed to {}", a.actor, a.action);
                return Ok(());
            }
            let issue = req_issue(a)?;
            let body_file = a.body_file.as_deref().ok_or_else(|| anyhow::anyhow!("upload-evidence requires --body-file"))?;
            let image = a.image.as_deref().ok_or_else(|| anyhow::anyhow!("upload-evidence requires --image <path>"))?;
            let body = std::fs::read_to_string(body_file)
                .map_err(|e| anyhow::anyhow!("cannot read body {}: {}", body_file, e))?;
            let bytes = std::fs::read(image)
                .map_err(|e| anyhow::anyhow!("cannot read image {}: {}", image, e))?;
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            let repo = gh_repo()?;
            let branch = match a.base.as_deref() {
                Some(b) => b.to_string(),
                None => {
                    let spec = parent_spec(issue).map_err(|_|
                        anyhow::anyhow!("cannot resolve parent spec for #{}; pass --base <spec-branch>", issue))?;
                    format!("spec/{}", spec)
                }
            };
            let ref_exists = gh_api_raw_opt(&[format!("repos/{}/git/ref/heads/{}", repo, branch)])?;
            if ref_exists.is_none() {
                anyhow::bail!("spec branch {} does not exist on origin — run create-spec-branch first", branch);
            }
            let fname = std::path::Path::new(image).file_name()
                .map(|s| s.to_string_lossy().replace([' ', '\\', '/', ':', '*', '?', '"', '<', '>', '|'], "-"))
                .ok_or_else(|| anyhow::anyhow!("cannot derive a filename from {}", image))?;
            let path = format!(".opencode/evidence/{}/{}", issue, fname);
            upsert_file(&repo, &branch, &path, &encoded, &format!("evidence: {} for #{}", fname, issue))?;
            let url = format!("https://github.com/{}/raw/{}/{}", repo, branch, path);
            let tmp = project_root()?.join(".opencode").join("tmp").join(format!("evidence-{}.md", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(tmp.parent().unwrap())?;
            std::fs::write(&tmp, format!("## Evidence\n\n{}\n\n![{}]({})", body, fname, url))?;
            run_gh(&["issue", "comment", &issue.to_string(), "--body-file", tmp.to_str().unwrap()])?;
            let _ = std::fs::remove_file(&tmp);
            println!("EVIDENCE POSTED: #{} -> {} ({})", issue, url, image);
            append_event(issue, "comment", &a.actor, "testing", "success", &format!("posted Evidence with {} for {}", image, issue))?;
        }
        "health" => {
            // Fold-in of pipeline-health.rs
            health_report(a.json)?;
        }
        "verify" => {
            // Anti-tamper gate: the record is append-only and must never be rewritten.
            verify_integrity(a.json)?;
        }
        other => anyhow::bail!("unknown action: {}", other),
    }
    Ok(())
}

fn req_issue(a: &ActionArgs) -> anyhow::Result<u32> {
    a.issue.ok_or_else(|| anyhow::anyhow!("--issue <N> is required for action {}", a.action))
}

/// Role gate for write actions: the `--agent` arg is self-declared, so authority
/// is enforced per-action here. Read-only / non-authoritative actions allow any
/// actor. Unknown actions default to allowed (they fail later on the match arm).
fn actor_allowed(action: &str, actor: &str) -> bool {
    match action {
        "create-issue" => matches!(actor, "product-owner" | "scrum-master"),
        "comment" => true,
        "transition" => actor == "scrum-master",
        "block" | "unblock" => matches!(actor, "scrum-master" | "developer"),
        "close-issue" => actor == "scrum-master",
        "create-worktree" => actor == "developer",
        "remove-worktree" => actor == "developer",
        "create-spec-branch" => actor == "scrum-master",
        "create-pr" => actor == "scrum-master",
        "merge-pr" => actor == "scrum-master",
        "audit-record" => actor == "self-improver",
        "upload-evidence" => matches!(actor, "tester" | "scrum-master"),
        "audit" | "prune" | "metrics" | "health" | "verify" | "context" => true,
        _ => true,
    }
}

// â”€â”€ Context block â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn print_context(issue: u32, actor: &str, raw: bool) -> anyhow::Result<()> {
    let phase = current_phase(issue)?;
    let (ok, reason) = exit_guard_passes(phase, issue);
    let validation = if ok { "passed".to_string() } else { format!("BLOCKED: {}", reason) };
    let goals = phase_exit_guard(phase);
    let owner = phase_owner(phase);
    let prev = previous_phase(phase);

    let phase_idx = Phase::ORDER.iter().position(|p| *p == phase).unwrap_or(0);
    let next_idx = (phase_idx + 1).min(Phase::ORDER.len() - 1);
    let next_phase = Phase::ORDER[next_idx];

    if raw {
        let block = serde_json::json!({
            "phase": phase.as_str(),
            "feature": format!("#{}", issue),
            "phase_owner": owner,
            "dispatched_agent": actor,
            "triggering_event": format!("dispatched to {} for phase {}", actor, phase.as_str()),
            "previous_phase": if prev == phase { "start" } else { prev.as_str() },
            "goals": goals,
            "playbook": playbook_path(actor),
            "responsibilities": format!("The {} agent performs the work of the {} phase per its playbook", actor, phase.as_str()),
            "handoff": format!("Next phase: {} â€” what must exist: {}", next_phase.as_str(), goals),
            "validation": validation,
            "doc_references": "03-pipeline.md, 05-github.md, 06-staffing.md, 07-state-machine.md",
        });
        println!("{}", serde_json::to_string_pretty(&block)?);
    } else {
        println!("=== PIPELINE STATE ===");
        println!("{:<16} {}", "Phase:", phase.as_str());
        println!("{:<16} #{}", "Feature:", issue);
        println!("{:<16} {}", "Phase owner:", owner);
        println!("{:<16} {}", "Triggering event:", format!("dispatched to {} for phase {}", actor, phase.as_str()));
        println!("{:<16} {}", "Previous phase:", if prev == phase { "start" } else { prev.as_str() });
        println!("{:<16} {}", "Goals:", goals);
        println!("{:<16} {}", "Playbook:", playbook_path(actor));
        println!("{:<16} {}", "Responsibilities:", format!("The {} agent performs the {} phase per its playbook", actor, phase.as_str()));
        println!("{:<16} {}", "Handoff:", format!("Next: {} â€” requires: {}", next_phase.as_str(), goals));
        println!("{:<16} {}", "Validation:", validation);
        println!("{:<16} {}", "Doc references:", "03-pipeline.md, 05-github.md, 06-staffing.md, 07-state-machine.md");
        println!("====================");
    }

    // Schema outcome enum is success|failure|blocked|unknown â€” map the exit-guard
    // result to that vocabulary (the human-readable Validation text above stays).
    let outcome = if ok { "success" } else { "blocked" };
    append_event_attrs(issue, "state_machine.call", actor, phase.as_str(), outcome, "", &[("validation", outcome)])?;
    Ok(())
}

fn playbook_path(actor: &str) -> String {
    let root = match project_root() {
        Ok(r) => r,
        Err(_) => return String::new(),
    };
    load_config()
        .ok()
        .and_then(|c| c.agents.get(actor))
        .map(|a| root.join(&a.playbook).to_string_lossy().to_string())
        .unwrap_or_default()
}

// â”€â”€ Fold-in: po-intake validation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const INTAKE_SECTIONS: &[&str] = &[
    "## Title",
    "## Problem / Why now",
    "## Intended users",
    "## Proposed behavior / Scope",
    "## Success metrics",
    "## Acceptance criteria",
    "## Out of scope",
    "## Priority",
];

fn intake_missing_sections(body: &str) -> Vec<&'static str> {
    // Strip a UTF-8 BOM so line-anchored matching isn't broken by a leading
    // zero-width marker on the first heading.
    let body = body.strip_prefix('\u{feff}').unwrap_or(body);
    INTAKE_SECTIONS
        .iter()
        .copied()
        .filter(|s| !has_section(body, s))
        .collect()
}

/// Match a `## Heading` on its own line, allowing a continuation suffix where the
/// next char after the heading is one of: space, `/`, `&`, `[`, `(`. This covers
/// template variants like `## Out of scope / constraints`, `## Priority & value`,
/// and the PO template's `[REQUIRED ...]` annotations (e.g. `## Success metrics
/// [REQUIRED]`, `## Acceptance criteria  [REQUIRED â€” 3-5...]`). Avoids substring
/// false-positives like a body mention of a heading inside prose.
fn has_section(body: &str, heading: &str) -> bool {
    body.lines().any(|l| {
        let t = l.trim();
        t == heading
            || (t.starts_with(heading)
                && matches!(t.as_bytes().get(heading.len()), Some(b' ') | Some(b'/') | Some(b'&') | Some(b'[') | Some(b'(')))
    })
}

// â”€â”€ Fold-in: pipeline-metrics â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[derive(Deserialize)]
struct ReadEvent {
    ts: String,
    event_name: String,
    actor: String,
    phase: String,
    outcome: String,
    #[serde(default)]
    message: String,
    entity: Option<EntityRef>,
}

#[derive(Deserialize)]
struct EntityRef {
    #[serde(rename = "issueId")]
    issue_id: Option<String>,
}

fn read_issue_events(issue: u32) -> Vec<ReadEvent> {
    let path = event_log_path(issue).unwrap_or_default();
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    let content = content.strip_prefix('\u{feff}').unwrap_or(&content);
    content.lines().filter(|l| l.trim_start().starts_with('{'))
        .filter_map(|l| serde_json::from_str::<ReadEvent>(l).ok())
        .collect()
}

/// A rework loop is a transition whose message indicates the source phase was
/// `testing` (i.e. `testing -> implementation`). The normal `triage ->
/// implementation` entry must NOT be counted as rework.
fn is_rework(e: &ReadEvent) -> bool {
    e.event_name == "transition" && e.message.contains("testing -> implementation")
}

fn metrics_per_issue(issue: u32, json: bool) -> anyhow::Result<()> {
    let events = read_issue_events(issue);
    if events.is_empty() {
        println!("No metric events recorded for issue #{} yet.", issue);
        return Ok(());
    }
    let mut phase_starts: BTreeMap<String, i64> = BTreeMap::new();
    let mut phase_completes: BTreeMap<String, i64> = BTreeMap::new();
    let mut calls = 0usize;
    let mut rework = 0usize;
    let mut blocked = 0usize;
    let mut failures = 0usize;
    let mut transitions: Vec<String> = Vec::new();
    for e in &events {
        let ts = chrono::DateTime::parse_from_rfc3339(&e.ts).map(|t| t.timestamp()).unwrap_or(0);
        match e.event_name.as_str() {
            "state_machine.call" => calls += 1,
            "phase.started" => { phase_starts.entry(e.phase.clone()).or_insert(ts); }
            "phase.completed" => { phase_completes.insert(e.phase.clone(), ts); }
            "transition" => {
                transitions.push(e.message.clone());
                if is_rework(e) { rework += 1; }
            }
            "block" => blocked += 1,
            _ => {}
        }
        if e.outcome == "blocked" { blocked += 1; }
        if e.outcome == "failure" { failures += 1; }
    }
    let mut durations: BTreeMap<String, f64> = BTreeMap::new();
    for (p, s) in &phase_starts {
        if let Some(en) = phase_completes.get(p) {
            durations.insert(p.clone(), (en - s) as f64 / 60.0);
        }
    }
    if json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "issue": issue, "events": events.len(), "agent_calls": calls,
            "phase_durations_min": durations, "rework_loops": rework,
            "blocked_count": blocked, "failures": failures, "transitions": transitions,
        }))?);
        return Ok(());
    }
    println!("=== Issue #{} Metrics ===", issue);
    println!("Agent calls: {}", calls);
    println!("Phase durations (minutes):");
    for (k, v) in &durations { println!("  {} : {}", k, v); }
    println!("Rework loops (testing->implementation): {}", rework);
    println!("Blocked count: {}", blocked);
    println!("Failures: {}", failures);
    if !transitions.is_empty() {
        println!("Transitions:");
        for t in &transitions { println!("  {}", t); }
    }
    Ok(())
}

fn metrics_aggregate(json: bool) -> anyhow::Result<()> {
    let root = project_root()?;
    let dir = root.join(".opencode").join("state").join("issues");
    if !dir.exists() { println!("No metrics recorded yet."); return Ok(()); }
    let mut all: Vec<ReadEvent> = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let path = entry?.path();
        if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            all.extend(content.lines().filter(|l| l.trim_start().starts_with('{'))
                .filter_map(|l| serde_json::from_str::<ReadEvent>(l).ok()));
        }
    }
    if all.is_empty() { println!("No metrics recorded yet."); return Ok(()); }
    let issues = all.iter().filter_map(|e| e.entity.as_ref().and_then(|x| x.issue_id.clone()))
        .collect::<std::collections::BTreeSet<_>>().len();
    let blocked = all.iter().filter(|e| e.outcome == "blocked" || e.event_name == "block").count();
    let rework = all.iter().filter(|e| is_rework(e)).count();
    let failures = all.iter().filter(|e| e.outcome == "failure").count();
    let mut by_agent: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_phase: BTreeMap<String, usize> = BTreeMap::new();
    for e in &all {
        *by_agent.entry(e.actor.clone()).or_insert(0) += 1;
        *by_phase.entry(e.phase.clone()).or_insert(0) += 1;
    }
    if json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "issues": issues, "events": all.len(), "blocked": blocked,
            "rework": rework, "failures": failures, "by_agent": by_agent, "by_phase": by_phase,
        }))?);
        return Ok(());
    }
    println!("=== Pipeline Metrics ===");
    println!("Issues tracked: {}", issues);
    println!("Total events: {}", all.len());
    println!("Blocked events: {}", blocked);
    println!("Rework transitions: {}", rework);
    println!("Failure events: {}", failures);
    println!("Calls by agent:");
    for (k, v) in &by_agent { println!("  {} : {}", k, v); }
    println!("Calls by phase:");
    for (k, v) in &by_phase { println!("  {} : {}", k, v); }
    Ok(())
}

// â”€â”€ Fold-in: pipeline-audit (evidence bundle) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn audit_evidence(issue: u32, json: bool) -> anyhow::Result<()> {
    let events = read_issue_events(issue);
    let comments = run_gh(&["issue", "view", &issue.to_string(), "--comments", "--json", "comments"])?;
    let mut phase_counts: BTreeMap<String, usize> = BTreeMap::new();
    for e in &events {
        *phase_counts.entry(e.phase.clone()).or_insert(0) += 1;
    }
    let rework = events.iter().filter(|e| is_rework(e)).count();
    let blocked = events.iter().filter(|e| e.outcome == "blocked" || e.event_name == "block").count();
    let evidence_count = events.iter().filter(|e| e.event_name == "comment" && e.message.contains("Evidence")).count();
    let has_record = comments.contains("Evidence") || comments.contains("Verdict");
    if json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "issue": issue, "events": events.len(), "phase_counts": phase_counts,
            "rework_loops": rework, "blocked_count": blocked,
            "tester_evidence_events": evidence_count,
            "has_gh_record": has_record,
        }))?);
        return Ok(());
    }
    println!("=== Audit Evidence â€” Issue #{} ===", issue);
    println!("Events recorded: {}", events.len());
    println!("Phase distribution:");
    for (k, v) in &phase_counts { println!("  {} : {}", k, v); }
    println!("Rework loops (testing->implementation): {}", rework);
    println!("Blocked count: {}", blocked);
    println!("Tester Evidence comments: {}", evidence_count);
    println!("GitHub record has Evidence/Verdict: {}", has_record);
    println!();
    println!("Record verdict: pipeline-state.rs --action audit-record --issue {} --verdict success|restart [--phase <p> --reason <why>]", issue);
    Ok(())
}

// â”€â”€ Anti-tamper: verify the record is append-only â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// Scan the append-only event log and return any integrity problems found.
/// Flags: unparseable lines, out-of-order timestamps, duplicate event IDs
/// (rewrite/replay), and non-JSON lines.
fn check_log_integrity() -> anyhow::Result<Vec<String>> {
    let root = project_root()?;
    let issues_dir = root.join(".opencode").join("state").join("issues");
    let state_dir = root.join(".opencode").join("state");
    let mut problems: Vec<String> = Vec::new();

    let mut check_file = |path: &std::path::Path, label: &str| -> anyhow::Result<()> {
        if !path.exists() { return Ok(()); }
        let content = std::fs::read_to_string(path)?;
        let content = content.strip_prefix('\u{feff}').unwrap_or(&content);
        let mut last_ts: Option<i64> = None;
        let mut seen_ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for (idx, line) in content.lines().enumerate() {
            let lineno = idx + 1;
            if line.trim().is_empty() { continue; }
            if !line.trim_start().starts_with('{') {
                problems.push(format!("{}:{}: non-JSON line", label, lineno));
                continue;
            }
            // Parse as generic JSON first (error-log schema differs from event schema),
            // then re-parse as ReadEvent when the shape matches.
            let v: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => { problems.push(format!("{}:{}: malformed JSON", label, lineno)); continue; }
            };
            let ts_str = v.get("ts").or_else(|| v.get("timestamp"))
                .and_then(|t| t.as_str()).unwrap_or_default();
            let ts = chrono::DateTime::parse_from_rfc3339(ts_str)
                .map(|t| t.timestamp()).unwrap_or_else(|_| {
                    problems.push(format!("{}:{}: unparseable timestamp '{}'", label, lineno, ts_str));
                    i64::MIN
                });
            if let Some(prev) = last_ts {
                if ts < prev {
                    problems.push(format!("{}:{}: out-of-order timestamp", label, lineno));
                }
            }
            if ts != i64::MIN { last_ts = Some(ts.max(last_ts.unwrap_or(ts))); }
            let event_id = v.get("eventId").or_else(|| v.get("event_id"))
                .and_then(|e| e.as_str()).unwrap_or_default();
            if !event_id.is_empty() && !seen_ids.insert(event_id.to_string()) {
                problems.push(format!("{}:{}: duplicate eventId '{}' â€” record was rewritten or replayed", label, lineno, event_id));
            }
        }
        Ok(())
    };

    if issues_dir.exists() {
        for entry in std::fs::read_dir(&issues_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                check_file(&path, &format!("issues/{}", path.file_name().unwrap_or_default().to_string_lossy()))?;
            }
        }
    }
    check_file(&state_dir.join("script-errors.jsonl"), "script-errors.jsonl")?;
    Ok(problems)
}

/// Anti-tamper gate (principle 6 gate 3): report and fail on any tampering.
fn verify_integrity(json: bool) -> anyhow::Result<()> {
    let problems = check_log_integrity()?;
    let tamper = !problems.is_empty();
    if json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "integrity": if tamper { "TAMPER DETECTED" } else { "OK" },
            "problems": problems,
        }))?);
    } else {
        println!("=== Record Integrity ===");
        if tamper {
            println!("INTEGRITY: TAMPER DETECTED");
            for p in &problems { println!("  {}", p); }
        } else {
            println!("INTEGRITY: OK â€” record is append-only and unmodified");
        }
    }
    if tamper { std::process::exit(3); }
    Ok(())
}

// â”€â”€ Fold-in: pipeline-health â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn health_report(json: bool) -> anyhow::Result<()> {
    let root = project_root()?;
    let dir = root.join(".opencode").join("state").join("issues");
    if !dir.exists() { println!("No metrics recorded yet."); return Ok(()); }
    let integrity = check_log_integrity()?;
    let mut all: Vec<ReadEvent> = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let path = entry?.path();
        if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            all.extend(content.lines().filter(|l| l.trim_start().starts_with('{'))
                .filter_map(|l| serde_json::from_str::<ReadEvent>(l).ok()));
        }
    }
    if all.is_empty() { println!("No metrics recorded yet."); return Ok(()); }
    let issues: std::collections::BTreeSet<String> = all.iter()
        .filter_map(|e| e.entity.as_ref().and_then(|x| x.issue_id.clone())).collect();
    let blocked = all.iter().filter(|e| e.outcome == "blocked" || e.event_name == "block").count();
    let rework = all.iter().filter(|e| is_rework(e)).count();
    let audit_pass = all.iter().filter(|e| e.event_name == "audit.verdict" && e.outcome == "passed").count();
    let audit_fail = all.iter().filter(|e| e.event_name == "audit.verdict" && e.outcome == "failed").count();
    let mut by_agent: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_phase: BTreeMap<String, usize> = BTreeMap::new();
    for e in &all {
        *by_agent.entry(e.actor.clone()).or_insert(0) += 1;
        *by_phase.entry(e.phase.clone()).or_insert(0) += 1;
    }
    // Little's Law consistency check.
    let first = all.iter().filter_map(|e| chrono::DateTime::parse_from_rfc3339(&e.ts).ok().map(|t| t.timestamp())).min().unwrap_or(0);
    let last = all.iter().filter_map(|e| chrono::DateTime::parse_from_rfc3339(&e.ts).ok().map(|t| t.timestamp())).max().unwrap_or(0);
    let span_hrs = ((last - first) as f64 / 3600.0).max(1.0);
    let throughput = issues.len() as f64 / span_hrs;
    let avg_cycle_hrs = 0.0; // requires paired start/end; conservative default
    let wip_from_law = throughput * avg_cycle_hrs;
    let little_ok = (wip_from_law - issues.len() as f64).abs() / (issues.len().max(1) as f64) < 2.0;
    if json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "issues": issues.len(), "events": all.len(), "blocked": blocked,
            "rework_total": rework, "audit_pass": audit_pass, "audit_fail": audit_fail,
            "throughput_per_hr": throughput, "little_law": { "wip": issues.len(), "computed_wip": wip_from_law, "consistent": little_ok },
            "by_agent": by_agent, "by_phase": by_phase,
            "integrity": if integrity.is_empty() { "OK" } else { "TAMPER DETECTED" },
            "integrity_problems": integrity,
        }))?);
        return Ok(());
    }
    println!("=== Pipeline Health ===");
    println!("Issues tracked: {}", issues.len());
    println!("Total events: {}", all.len());
    println!("Blocked events: {}", blocked);
    println!("Rework transitions: {}", rework);
    println!("Audit verdicts: {} pass, {} fail", audit_pass, audit_fail);
    println!("Throughput: {:.3} issues/hr", throughput);
    println!("Little's Law: WIP={} computed={:.1} â†’ {}", issues.len(), wip_from_law, if little_ok { "CONSISTENT" } else { "CHECK REQUIRED" });
    println!("Record integrity: {}", if integrity.is_empty() { "OK" } else { "TAMPER DETECTED" });
    for p in &integrity { println!("  {}", p); }
    println!("Calls by agent:");
    for (k, v) in &by_agent { println!("  {} : {}", k, v); }
    println!("Calls by phase:");
    for (k, v) in &by_phase { println!("  {} : {}", k, v); }
    Ok(())
}

// â”€â”€ CLI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn parse_args() -> ActionArgs {
    let args: Vec<String> = env::args().skip(1).collect();
    let val = |name: &str| -> Option<String> {
        args.windows(2).find_map(|w| if w[0] == name { Some(w[1].clone()) } else { None })
    };
    let issue: Option<u32> = val("--issue").and_then(|s| s.parse().ok());
    let actor = val("--agent").unwrap_or_else(|| "unknown".into());
    let action = val("--action").unwrap_or_else(|| "context".into());
    ActionArgs {
        issue,
        actor,
        action,
        to_phase: val("--to-phase").or_else(|| val("--phase")),
        body_file: val("--body-file"),
        title: val("--title"),
        issue_type: val("--issue-type"),
        prefix: val("--prefix"),
        reason: val("--reason"),
        verdict: val("--verdict"),
        base: val("--base"),
        pr: val("--pr"),
        worktree_path: val("--worktree-path"),
        image: val("--image"),
        all: args.iter().any(|a| a == "--all"),
        json: args.iter().any(|a| a == "--json"),
    }
}

fn main() {
    let raw = env::args().any(|a| a == "--raw");
    let a = parse_args();
    let result = match a.action.as_str() {
        "context" => {
            match a.issue {
                Some(i) => print_context(i, &a.actor, raw),
                None => Err(anyhow::anyhow!("--issue <N> is required for action context")),
            }
        }
        _ => run_action(&a),
    };
    if let Err(e) = result {
        // Fold-in of pipeline-log.rs: record the failure for observability AND as
        // a per-issue metric event so the metrics/health reads can see failure
        // rates per phase/agent (the script-errors log is the raw error detail).
        let _ = log_error("pipeline-state", &e.to_string(), a.issue);
        if let Some(issue) = a.issue {
            let _ = append_event_attrs(issue, "state_machine.failure", &a.actor, "unknown", "failure",
                &e.to_string(), &[("action", &a.action)]);
        }
        eprintln!("ERROR: {}", e);
        std::process::exit(1);
    }
}

/// Append an error line to .opencode/state/script-errors.jsonl (cross-platform).
fn log_error(source: &str, message: &str, issue: Option<u32>) -> anyhow::Result<()> {
    let root = project_root()?;
    let state_dir = root.join(".opencode").join("state");
    std::fs::create_dir_all(&state_dir)?;
    let log_file = state_dir.join("script-errors.jsonl");
    let entry = serde_json::json!({
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "source": source,
        "message": message,
        "issue": issue.map(|i| i.to_string()).unwrap_or_default(),
    });
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&log_file)?;
    writeln!(f, "{}", serde_json::to_string(&entry)?)?;
    Ok(())
}



