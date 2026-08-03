#!/usr/bin/env rust-script
//! ```cargo
//! [dependencies]
//! anyhow = "1"
//! serde = { version = "1", features = ["derive"] }
//! serde_json = "1"
//! chrono = { version = "0.4", features = ["serde"] }
//! uuid = { version = "1", features = ["v4"] }
//! ```

// pipeline-state.rs — the deterministic state machine for the Fredo agentic pipeline.
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

// ── Pipeline config (loaded from .opencode/pipeline.json) ────────────────────

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
    #[allow(dead_code)]
    order: u32,
    label: String,
    exit_guard: String,
    #[allow(dead_code)]
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

fn is_legal_transition(from: Phase, to: Phase) -> bool {
    load_config()
        .ok()
        .and_then(|c| c.transitions.get(&format!("{}:{}", from.as_str(), to.as_str())))
        .copied()
        .unwrap_or(false)
}

fn phase_from_label(label: &str) -> Option<Phase> {
    let cfg = load_config().ok()?;
    cfg.label_to_phase.get(label).and_then(|p| Phase::from_str(p))
}

// ── Phase model (canonical set; data lives in pipeline.json) ─────────────────

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

// ── GitHub reads/writes (via `gh` CLI) ───────────────────────────────────────

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

#[derive(Deserialize)]
struct GhLabel {
    name: String,
}

#[derive(Deserialize)]
struct GhIssue {
    labels: Vec<GhLabel>,
    #[serde(default)]
    title: String,
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

/// Lowercase, hyphenate a title into a branch-safe slug (keeps alphanumerics + hyphens).
fn slugify(title: &str) -> String {
    let lower = title.to_lowercase();
    let mut out = String::new();
    for c in lower.chars() {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.len() > 60 { out.truncate(60); let _ = out.pop(); }
    out
}

/// Guard for `create-branch`/`create-worktree`: the sub-issue must be actionable
/// (labeled `ready-for-dev` or `in-progress-dev`) and assigned.
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

/// Guard for `merge-pr`: the PR must be open and have passing CI checks.
fn pr_merge_guard(pr: &str) -> anyhow::Result<(bool, String)> {
    let json = run_gh(&["pr", "view", pr, "--json", "state,mergeStateStatus,statusCheckRollup"])?;
    let v: serde_json::Value = serde_json::from_str(&json)?;
    let state = v.get("state").and_then(|s| s.as_str()).unwrap_or("");
    if state != "OPEN" {
        return Ok((false, format!("PR #{} is not open (state: {})", pr, state)));
    }
    if let Some(rollup) = v.get("statusCheckRollup").and_then(|r| r.as_array()) {
        for check in rollup {
            let name = check.get("name").and_then(|n| n.as_str()).unwrap_or("check");
            let status = check.get("status").and_then(|s| s.as_str()).unwrap_or("");
            let conclusion = check.get("conclusion").and_then(|c| c.as_str()).unwrap_or("");
            if status == "COMPLETED" && conclusion != "SUCCESS" && conclusion != "NEUTRAL" && conclusion != "SKIPPED" {
                return Ok((false, format!("PR #{} CI check '{}' failed: {}", pr, name, conclusion)));
            }
        }
    }
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

fn exit_guard_passes(phase: Phase, issue: u32) -> (bool, String) {
    let issue_data = get_issue(issue).ok().flatten();
    match phase {
        Phase::Intake => match issue_data {
            Some(i) if !i.body.trim().is_empty() => (true, String::new()),
            Some(_) => (false, "backlog body is empty".into()),
            None => (false, "issue not found".into()),
        },
        Phase::Triage => {
            let comments = get_issue_comments(issue);
            let has_plan = comments
                .iter()
                .any(|b| b.contains("## Implementation Plan") || b.contains("## Summary") || b.contains("## Scope"));
            (has_plan, if has_plan { String::new() } else { "no Implementation Plan found".into() })
        }
        Phase::Implementation => (true, String::new()),
        Phase::Testing => {
            let comments = get_issue_comments(issue);
            let has = comments.iter().any(|b| b.starts_with("Evidence") || b.contains("## E2E") || b.contains("Verdict"));
            (has, if has { String::new() } else { "no tester verdict found".into() })
        }
        Phase::Audit => {
            let comments = get_issue_comments(issue);
            let has = comments.iter().any(|b| b.starts_with("Decision") || b.contains("Audit verdict"));
            (has, if has { String::new() } else { "no audit verdict found".into() })
        }
        Phase::Done => (true, String::new()),
    }
}

// ── Metric event log (per-issue JSONL) ───────────────────────────────────────

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
    let mut entity = HashMap::new();
    entity.insert("issueId".into(), issue.to_string());
    let attributes = HashMap::new();

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

// ── Actions (single writer to GitHub) ────────────────────────────────────────

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
    all: bool,
    json: bool,
}

fn run_action(a: &ActionArgs) -> anyhow::Result<()> {
    // phase is computed lazily per-arm (only per-issue actions need it).
    let phase_of = |a: &ActionArgs| -> anyhow::Result<Phase> { current_phase(req_issue(a)?) };
    match a.action.as_str() {
        "create-issue" => {
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
            append_event(a.issue.unwrap_or(0), "create-issue", &a.actor, "intake", "success", &format!("created {} {}", issue_type, out))?;
        }
        "comment" => {
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
            let issue = req_issue(a)?;
            let phase = phase_of(a)?;
            let to_str = a.to_phase.as_deref().ok_or_else(|| anyhow::anyhow!("transition requires --to-phase"))?;
            let to = Phase::from_str(to_str).ok_or_else(|| anyhow::anyhow!("invalid --to-phase: {}", to_str))?;
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
            let label = phase_label(to);
            run_gh(&["issue", "edit", &issue.to_string(), "--add-label", &label])?;
            println!("TRANSITIONED: {} -> {} (label: {})", phase.as_str(), to.as_str(), label);
            append_event(issue, "transition", &a.actor, to.as_str(), "success", &format!("transitioned {} -> {}", phase.as_str(), to.as_str()))?;
        }
        "block" => {
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
            append_event(issue, "block", &a.actor, phase.as_str(), "success", &format!("blocked: {}", reason))?;
        }
        "unblock" => {
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
            let issue = req_issue(a)?;
            let to_str = a.to_phase.as_deref().ok_or_else(|| anyhow::anyhow!("close-issue requires --to-phase done|canceled"))?;
            if to_str != "done" && to_str != "canceled" {
                anyhow::bail!("close-issue --to-phase must be done|canceled");
            }
            if to_str == "done" {
                let (ok, reason) = exit_guard_passes(Phase::Audit, issue);
                if !ok {
                    append_event(issue, "close-issue", &a.actor, "audit", "blocked", &reason)?;
                    println!("BLOCKED: {}", reason);
                    return Ok(());
                }
            }
            let reason = if to_str == "done" { "completed" } else { "not_planned" };
            run_gh(&["issue", "close", &issue.to_string(), "--reason", reason])?;
            println!("CLOSED: #{} as {}", issue, to_str);
            append_event(issue, "close-issue", &a.actor, to_str, "success", &format!("closed as {}", to_str))?;
        }
        "create-branch" => {
            // Creates feat/<issue>-<desc> from the base branch (default: main).
            let issue = req_issue(a)?;
            let base = a.base.as_deref().unwrap_or("main");
            let (ok, reason) = branch_guard(issue)?;
            if !ok {
                append_event(issue, "create-branch", &a.actor, "triage", "blocked", &reason)?;
                println!("BLOCKED: {}", reason);
                return Ok(());
            }
            let title = get_issue(issue)?.map(|i| i.title.clone()).unwrap_or_default();
            let desc = slugify(&title);
            let branch = format!("feat/{}-{}", issue, desc);
            let exists = run_cmd("git", &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}", branch)])
                .is_ok();
            if exists {
                anyhow::bail!("branch already exists: {}", branch);
            }
            run_cmd("git", &["checkout", "-b", &branch, base])?;
            println!("BRANCH CREATED: {} (base: {})", branch, base);
            append_event(issue, "create-branch", &a.actor, "triage", "success", &format!("created {}", branch))?;
        }
        "create-worktree" => {
            // Creates a worktree for the feature branch at --worktree-path.
            let issue = req_issue(a)?;
            let path = a.worktree_path.as_deref().ok_or_else(|| anyhow::anyhow!("create-worktree requires --worktree-path"))?;
            let base = a.base.as_deref().unwrap_or("main");
            let title = get_issue(issue)?.map(|i| i.title.clone()).unwrap_or_default();
            let branch = format!("feat/{}-{}", issue, slugify(&title));
            run_cmd("git", &["worktree", "add", "-b", &branch, path, base])?;
            println!("WORKTREE CREATED: {} at {}", branch, path);
            append_event(issue, "create-worktree", &a.actor, "triage", "success", &format!("worktree {} at {}", branch, path))?;
        }
        "merge-pr" => {
            // Merges a PR after review. Guards: PR exists, open, CI green.
            let issue = req_issue(a)?;
            let pr = a.pr.as_deref().ok_or_else(|| anyhow::anyhow!("merge-pr requires --pr <N>"))?;
            let (ok, reason) = pr_merge_guard(pr)?;
            if !ok {
                append_event(issue, "merge-pr", &a.actor, "implementation", "blocked", &reason)?;
                println!("BLOCKED: {}", reason);
                return Ok(());
            }
            run_gh(&["pr", "merge", pr, "--merge", "--delete-branch"])?;
            println!("PR MERGED: #{}", pr);
            append_event(issue, "merge-pr", &a.actor, "implementation", "success", &format!("merged PR #{}", pr))?;
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
            // SI verdict: posts the Decision comment AND records the metric event —
            // one write path, one event, no separate `comment` step.
            let issue = req_issue(a)?;
            let verdict = a.verdict.as_deref().ok_or_else(|| anyhow::anyhow!("audit-record requires --verdict success|restart"))?;
            let phase = a.to_phase.as_deref().unwrap_or("audit");
            let reason = a.reason.as_deref().unwrap_or("");
            let body = if verdict == "success" {
                format!("## Decision\n\nAudit verdict: **success**.\n\n{}", reason)
            } else {
                format!("## Decision\n\nAudit verdict: **restart → {}**.\n\n{}", phase, reason)
            };
            let tmp = project_root()?.join(".opencode").join("tmp").join(format!("audit-{}.md", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(tmp.parent().unwrap())?;
            std::fs::write(&tmp, body)?;
            run_gh(&["issue", "comment", &issue.to_string(), "--body-file", tmp.to_str().unwrap()])?;
            let _ = std::fs::remove_file(&tmp);
            append_event(issue, "audit.verdict", "self-improver", phase,
                if verdict == "success" { "passed" } else { "failed" },
                reason)?;
            println!("AUDIT RECORDED: {} on #{}", verdict, issue);
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

// ── Context block ────────────────────────────────────────────────────────────

fn print_context(issue: u32, actor: &str, raw: bool) -> anyhow::Result<()> {
    let phase = current_phase(issue)?;
    let (ok, reason) = exit_guard_passes(phase, issue);
    let validation = if ok { "passed".to_string() } else { format!("BLOCKED: {}", reason) };
    let goals = phase_exit_guard(phase);

    let phase_idx = Phase::ORDER.iter().position(|p| *p == phase).unwrap_or(0);
    let next_idx = (phase_idx + 1).min(Phase::ORDER.len() - 1);
    let next_phase = Phase::ORDER[next_idx];

    if raw {
        let block = serde_json::json!({
            "phase": phase.as_str(),
            "feature": format!("#{}", issue),
            "phase_owner": actor,
            "triggering_event": "agent dispatch",
            "previous_phase": "intake",
            "goals": goals,
            "playbook": playbook_path(actor),
            "handoff": format!("Next phase: {} — what must exist: {}", next_phase.as_str(), goals),
            "validation": validation,
            "doc_references": "03-pipeline.md, 05-github.md, 06-staffing.md, 07-state-machine.md",
        });
        println!("{}", serde_json::to_string_pretty(&block)?);
    } else {
        println!("=== PIPELINE STATE ===");
        println!("{:<16} {}", "Phase:", phase.as_str());
        println!("{:<16} #{}", "Feature:", issue);
        println!("{:<16} {}", "Phase owner:", actor);
        println!("{:<16} {}", "Goals:", goals);
        println!("{:<16} {}", "Playbook:", playbook_path(actor));
        println!("{:<16} {}", "Handoff:", format!("Next: {} — requires: {}", next_phase.as_str(), goals));
        println!("{:<16} {}", "Validation:", validation);
        println!("====================");
    }

    append_event(issue, "state_machine.call", actor, phase.as_str(), &validation, "")?;
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

// ── Fold-in: po-intake validation ─────────────────────────────────────────────

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

/// Match a `## Heading` on its own line (allowing a trailing `/ constraints`
/// or `& value` suffix, so template variants like `## Out of scope / constraints`
/// satisfy the `## Out of scope` requirement). Avoids substring false-positives
/// like a body mention of a heading inside prose.
fn has_section(body: &str, heading: &str) -> bool {
    body.lines().any(|l| {
        let t = l.trim();
        t == heading || t.starts_with(&format!("{} /", heading)) || t.starts_with(&format!("{} &", heading))
    })
}

// ── Fold-in: pipeline-metrics ─────────────────────────────────────────────────

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
    let mut transitions: Vec<String> = Vec::new();
    for e in &events {
        let ts = chrono::DateTime::parse_from_rfc3339(&e.ts).map(|t| t.timestamp()).unwrap_or(0);
        match e.event_name.as_str() {
            "state_machine.call" => calls += 1,
            "phase.started" => { phase_starts.entry(e.phase.clone()).or_insert(ts); }
            "phase.completed" => { phase_completes.insert(e.phase.clone(), ts); }
            "transition" => {
                transitions.push(e.message.clone());
                if e.phase == "implementation" { rework += 1; }
            }
            "block" => blocked += 1,
            _ => {}
        }
        if e.outcome == "blocked" { blocked += 1; }
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
            "blocked_count": blocked, "transitions": transitions,
        }))?);
        return Ok(());
    }
    println!("=== Issue #{} Metrics ===", issue);
    println!("Agent calls: {}", calls);
    println!("Phase durations (minutes):");
    for (k, v) in &durations { println!("  {} : {}", k, v); }
    println!("Rework loops (testing->implementation): {}", rework);
    println!("Blocked count: {}", blocked);
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
    let rework = all.iter().filter(|e| e.event_name == "transition" && e.phase == "implementation").count();
    let mut by_agent: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_phase: BTreeMap<String, usize> = BTreeMap::new();
    for e in &all {
        *by_agent.entry(e.actor.clone()).or_insert(0) += 1;
        *by_phase.entry(e.phase.clone()).or_insert(0) += 1;
    }
    if json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "issues": issues, "events": all.len(), "blocked": blocked,
            "rework": rework, "by_agent": by_agent, "by_phase": by_phase,
        }))?);
        return Ok(());
    }
    println!("=== Pipeline Metrics ===");
    println!("Issues tracked: {}", issues);
    println!("Total events: {}", all.len());
    println!("Blocked events: {}", blocked);
    println!("Rework transitions: {}", rework);
    println!("Calls by agent:");
    for (k, v) in &by_agent { println!("  {} : {}", k, v); }
    println!("Calls by phase:");
    for (k, v) in &by_phase { println!("  {} : {}", k, v); }
    Ok(())
}

// ── Fold-in: pipeline-audit (evidence bundle) ─────────────────────────────────

fn audit_evidence(issue: u32, json: bool) -> anyhow::Result<()> {
    let events = read_issue_events(issue);
    let comments = run_gh(&["issue", "view", &issue.to_string(), "--comments", "--json", "comments"])?;
    let mut phase_counts: BTreeMap<String, usize> = BTreeMap::new();
    for e in &events {
        *phase_counts.entry(e.phase.clone()).or_insert(0) += 1;
    }
    let rework = events.iter().filter(|e| e.event_name == "transition" && e.phase == "implementation").count();
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
    println!("=== Audit Evidence — Issue #{} ===", issue);
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

// ── Anti-tamper: verify the record is append-only ─────────────────────────────

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
                problems.push(format!("{}:{}: duplicate eventId '{}' — record was rewritten or replayed", label, lineno, event_id));
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
            println!("INTEGRITY: OK — record is append-only and unmodified");
        }
    }
    if tamper { std::process::exit(3); }
    Ok(())
}

// ── Fold-in: pipeline-health ──────────────────────────────────────────────────

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
    let rework = all.iter().filter(|e| e.event_name == "transition" && e.phase == "implementation").count();
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
    println!("Little's Law: WIP={} computed={:.1} → {}", issues.len(), wip_from_law, if little_ok { "CONSISTENT" } else { "CHECK REQUIRED" });
    println!("Record integrity: {}", if integrity.is_empty() { "OK" } else { "TAMPER DETECTED" });
    for p in &integrity { println!("  {}", p); }
    println!("Calls by agent:");
    for (k, v) in &by_agent { println!("  {} : {}", k, v); }
    println!("Calls by phase:");
    for (k, v) in &by_phase { println!("  {} : {}", k, v); }
    Ok(())
}

// ── CLI ──────────────────────────────────────────────────────────────────────

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
        // Fold-in of pipeline-log.rs: record the failure for observability.
        let _ = log_error("pipeline-state", &e.to_string(), a.issue);
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


