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

// pipeline-state.rs — the deterministic state machine for the Fredo agentic pipeline.
// Cross-platform (Windows/macOS/Linux). Owns the phase model, transitions, guards,
// GitHub writes (via the `gh` CLI), the context block, and metric events.
//
// Contract: docs/agentic-pipeline/state-machine.md
// Invocation: documented in the `pipeline-state` skill (loaded at agent wake).

use std::collections::{BTreeMap, HashMap};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use base64::Engine as _;

// ── Pipeline config (loaded from .opencode/pipeline.json) ────────────────────

static CONFIG: OnceLock<PipelineConfig> = OnceLock::new();

#[derive(Deserialize)]
struct PipelineConfig {
    phases: BTreeMap<String, PhaseConfig>,
    transitions: HashMap<String, bool>,
    label_to_phase: HashMap<String, String>,
    issue_types: HashMap<String, IssueTypeConfig>,
    blocked: BlockedConfig,
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
    if mock_mode() {
        return mock_gh(args);
    }
    let out = Command::new("gh").args(args).output()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        anyhow::bail!("gh {} failed: {}", args.join(" "), stderr);
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Run an arbitrary local command (e.g. `git`) and return stdout.
fn run_cmd(bin: &str, args: &[&str]) -> anyhow::Result<String> {
    if mock_mode() && bin == "git" {
        return mock_git(args);
    }
    let out = Command::new(bin).args(args).output()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        anyhow::bail!("{} {} failed: {}", bin, args.join(" "), stderr);
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ── Mock GitHub (FREDO_MOCK_GH=1) ────────────────────────────────────────────
//
// The validation harness runs the state machine against a local mock repo instead
// of the real GitHub, so the 50+ `gh issue create`/PR/Contents-API writes per run
// never touch the tracker. When `FREDO_MOCK_GH=1`, every `gh`/`git` call the
// machine makes is emulated against a JSON-file store under
// `.opencode/tmp/mock-repo/` (gitignored). The store mirrors the exact shapes the
// machine parses (issue `labels` as `[{name}]`, `state` OPEN/CLOSED, comments
// `[{body}]`; PR `state`/`mergeStateStatus`/`statusCheckRollup`; Contents API
// `{sha}`). `FREDO_MOCK_STORE` overrides the store root (the harness points it at
// its own scratch dir).

fn mock_mode() -> bool {
    std::env::var("FREDO_MOCK_GH").map(|v| v == "1").unwrap_or(false)
}

fn mock_root() -> PathBuf {
    std::env::var("FREDO_MOCK_STORE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| project_root().map(|r| r.join(".opencode").join("tmp").join("mock-repo")).unwrap_or_else(|_| PathBuf::from("mock-repo")))
}

fn mock_repo_name() -> String {
    std::env::var("FREDO_MOCK_REPO").unwrap_or_else(|_| "fredo/mock".into())
}

fn mock_file(parts: &[&str]) -> PathBuf {
    let mut p = mock_root();
    for part in parts {
        p = p.join(part);
    }
    p
}

fn mock_ensure_dir(dir: &Path) {
    let _ = std::fs::create_dir_all(dir);
}

fn mock_read(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

fn mock_write(path: &Path, content: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        mock_ensure_dir(parent);
    }
    std::fs::write(path, content)?;
    Ok(())
}

fn mock_next_counter(kind: &str) -> u32 {
    let path = mock_file(&["counters.json"]);
    let mut counters: serde_json::Value = mock_read(&path)
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let next = counters.get(kind).and_then(|v| v.as_u64()).unwrap_or(0) + 1;
    counters[kind] = serde_json::json!(next);
    let _ = mock_write(&path, &serde_json::to_string(&counters).unwrap_or_default());
    next as u32
}

fn mock_issue_path(n: u32) -> PathBuf {
    mock_file(&["issues", &format!("{}.json", n)])
}

fn mock_issue_exists(n: u32) -> bool {
    mock_issue_path(n).exists()
}

fn mock_read_issue(n: u32) -> serde_json::Value {
    let mut v = mock_read(&mock_issue_path(n))
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    // PS 5.1 ConvertTo-Json collapses empty arrays to `{}` and single-element
    // arrays to a bare object; normalize both so the machine always sees real
    // arrays for `labels` and `comments`.
    for key in ["labels", "comments"] {
        if let Some(val) = v.get_mut(key) {
            if !val.is_array() {
                *val = serde_json::json!([]);
            }
        }
    }
    v
}

fn mock_write_issue(n: u32, issue: &serde_json::Value) -> anyhow::Result<()> {
    mock_write(&mock_issue_path(n), &serde_json::to_string(issue)?)
}

fn mock_pr_path(n: u32) -> PathBuf {
    mock_file(&["prs", &format!("{}.json", n)])
}

fn mock_read_pr(n: u32) -> serde_json::Value {
    mock_read(&mock_pr_path(n))
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn mock_write_pr(n: u32, pr: &serde_json::Value) -> anyhow::Result<()> {
    mock_write(&mock_pr_path(n), &serde_json::to_string(pr)?)
}

fn mock_ref_exists(branch: &str) -> bool {
    mock_file(&["refs", branch]).exists()
}

fn mock_ref_write(branch: &str) -> anyhow::Result<()> {
    mock_write(&mock_file(&["refs", branch]), "")
}

fn mock_ref_delete(branch: &str) -> anyhow::Result<()> {
    let _ = std::fs::remove_file(mock_file(&["refs", branch]));
    Ok(())
}

fn mock_commits_ahead(branch: &str) -> u64 {
    mock_read(&mock_file(&["commits", branch]))
        .and_then(|c| c.trim().parse::<u64>().ok())
        .unwrap_or(0)
}

fn mock_set_commits_ahead(branch: &str, count: u64) -> anyhow::Result<()> {
    mock_write(&mock_file(&["commits", branch]), &count.to_string())
}

fn mock_contents_path(branch: &str, path: &str) -> PathBuf {
    mock_file(&["contents", branch, path])
}

/// Emulate the `gh` CLI surface the state machine uses, against the mock store.
/// Returns exactly what `gh` would print (URLs, JSON) so the machine's parsers
/// (`rsplit('/')` on created-issue URLs, `--jq`-style field reads, array length
/// counts) work unchanged.
fn mock_gh(args: &[&str]) -> anyhow::Result<String> {
    let sub = args.first().copied().unwrap_or("");
    match sub {
        "repo" => {
            if args[1..].iter().any(|a| *a == "nameWithOwner") {
                Ok(mock_repo_name())
            } else {
                Ok(String::new())
            }
        }
        "issue" => mock_gh_issue(args),
        "pr" => mock_gh_pr(args),
        "api" => mock_gh_api(args),
        _ => anyhow::bail!("mock gh: unsupported subcommand `{}` ({})", sub, args.join(" ")),
    }
}

fn mock_gh_issue(args: &[&str]) -> anyhow::Result<String> {
    let op = args.get(1).copied().unwrap_or("");
    match op {
        "create" => {
            let mut title = String::new();
            let mut body = String::new();
            let mut label = String::new();
            let mut i = 2;
            while i < args.len() {
                match args[i] {
                    "--title" => { title = args.get(i + 1).copied().unwrap_or("").to_string(); i += 2; }
                    "--body-file" => {
                        if let Some(f) = args.get(i + 1) {
                            body = mock_read(&PathBuf::from(f)).unwrap_or_default();
                        }
                        i += 2;
                    }
                    "--label" => { label = args.get(i + 1).copied().unwrap_or("").to_string(); i += 2; }
                    _ => { i += 1; }
                }
            }
            let n = mock_next_counter("issue");
            let issue = serde_json::json!({
                "number": n,
                "title": title,
                "body": body,
                "state": "OPEN",
                "labels": if label.is_empty() { serde_json::json!([]) } else { serde_json::json!([{"name": label}]) },
                "comments": [],
            });
            mock_write_issue(n, &issue)?;
            Ok(format!("https://github.com/{}/issues/{}", mock_repo_name(), n))
        }
        "view" => {
            let n = args.get(2).and_then(|a| a.parse::<u32>().ok()).ok_or_else(|| anyhow::anyhow!("mock gh issue view: no issue number"))?;
            // Unknown issue numbers (e.g. the harness fixture #633, which exists on
            // real GitHub but not in a fresh mock store) resolve to a default OPEN
            // issue with no labels — mirrors gh's behavior for a real-but-empty issue.
            let issue = if mock_issue_exists(n) { mock_read_issue(n) } else {
                serde_json::json!({ "number": n, "title": "", "body": "", "state": "OPEN", "labels": [], "comments": [] })
            };
            let with_comments = args.iter().any(|a| *a == "--comments");
            let json_fields = args.windows(2).find(|w| w[0] == "--json").and_then(|w| w.get(1)).copied();
            let jq = args.windows(2).find(|w| w[0] == "--jq").and_then(|w| w.get(1)).copied();
            if with_comments {
                let comments = issue.get("comments").cloned().unwrap_or_else(|| serde_json::json!([]));
                let out = serde_json::json!({ "comments": comments });
                if let Some(q) = jq {
                    return Ok(mock_jq(&out, q));
                }
                return Ok(serde_json::to_string(&out)?);
            }
            let fields: Vec<&str> = json_fields.map(|f| f.split(',').collect()).unwrap_or_default();
            if fields.iter().any(|f| *f == "body") && fields.len() == 1 {
                return Ok(issue.get("body").and_then(|b| b.as_str()).unwrap_or("").to_string());
            }
            let mut out = serde_json::json!({});
            for f in fields {
                match f {
                    "state" => { out["state"] = issue.get("state").cloned().unwrap_or_else(|| serde_json::json!("OPEN")); }
                    "labels" => { out["labels"] = issue.get("labels").cloned().unwrap_or_else(|| serde_json::json!([])); }
                    "title" => { out["title"] = issue.get("title").cloned().unwrap_or_else(|| serde_json::json!("")); }
                    "body" => { out["body"] = issue.get("body").cloned().unwrap_or_else(|| serde_json::json!("")); }
                    _ => {}
                }
            }
            if let Some(q) = jq {
                return Ok(mock_jq(&out, q));
            }
            Ok(serde_json::to_string(&out)?)
        }
        "comment" => {
            let n = args.get(2).and_then(|a| a.parse::<u32>().ok()).ok_or_else(|| anyhow::anyhow!("mock gh issue comment: no issue number"))?;
            let body_file = args.windows(2).find(|w| w[0] == "--body-file").and_then(|w| w.get(1)).copied();
            let body = body_file.map(|f| mock_read(&PathBuf::from(f)).unwrap_or_default()).unwrap_or_default();
            let mut issue = mock_read_issue(n);
            let mut comments = issue.get("comments").cloned().unwrap_or_else(|| serde_json::json!([]));
            comments.as_array_mut().map(|a| a.push(serde_json::json!({ "body": body })));
            issue["comments"] = comments;
            mock_write_issue(n, &issue)?;
            Ok(String::new())
        }
        "edit" => {
            let n = args.get(2).and_then(|a| a.parse::<u32>().ok()).ok_or_else(|| anyhow::anyhow!("mock gh issue edit: no issue number"))?;
            let mut issue = mock_read_issue(n);
            let mut labels: Vec<serde_json::Value> = issue.get("labels").cloned().unwrap_or_else(|| serde_json::json!([]))
                .as_array().cloned().unwrap_or_default();
            let mut i = 3;
            while i < args.len() {
                match args[i] {
                    "--add-label" => {
                        if let Some(l) = args.get(i + 1) {
                            if !labels.iter().any(|x| x["name"].as_str() == Some(*l)) {
                                labels.push(serde_json::json!({ "name": l }));
                            }
                        }
                        i += 2;
                    }
                    "--remove-label" => {
                        if let Some(l) = args.get(i + 1) {
                            labels.retain(|x| x["name"].as_str() != Some(*l));
                        }
                        i += 2;
                    }
                    "--body-file" => {
                        if let Some(f) = args.get(i + 1) {
                            issue["body"] = serde_json::json!(mock_read(&PathBuf::from(f)).unwrap_or_default());
                        }
                        i += 2;
                    }
                    _ => { i += 1; }
                }
            }
            issue["labels"] = serde_json::json!(labels);
            mock_write_issue(n, &issue)?;
            Ok(String::new())
        }
        "close" => {
            let n = args.get(2).and_then(|a| a.parse::<u32>().ok()).ok_or_else(|| anyhow::anyhow!("mock gh issue close: no issue number"))?;
            let mut issue = mock_read_issue(n);
            issue["state"] = serde_json::json!("CLOSED");
            mock_write_issue(n, &issue)?;
            Ok(String::new())
        }
        "list" => {
            // gh issue list --state open --label blocked --json number
            // gh issue list --state open --search "Parent: Implementation Plan #N" --json number
            let state = args.windows(2).find(|w| w[0] == "--state").and_then(|w| w.get(1)).copied().unwrap_or("");
            let label = args.windows(2).find(|w| w[0] == "--label").and_then(|w| w.get(1)).copied();
            let search = args.windows(2).find(|w| w[0] == "--search").and_then(|w| w.get(1)).copied();
            let mut nums = Vec::new();
            let dir = mock_file(&["issues"]);
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for e in entries.flatten() {
                    let file = e.path();
                    let Some(name) = file.file_stem().and_then(|s| s.to_str()) else { continue; };
                    let Ok(n) = name.parse::<u32>() else { continue; };
                    let issue = mock_read_issue(n);
                    let is_open = issue.get("state").and_then(|s| s.as_str()).unwrap_or("") == "OPEN";
                    let has_label = label.map(|l| issue.get("labels").and_then(|v| v.as_array()).map(|a| a.iter().any(|x| x["name"].as_str() == Some(l))).unwrap_or(false)).unwrap_or(true);
                    let matches_search = search.map(|q| {
                        let q = q.trim_matches('"');
                        let q = q.trim_start_matches("Parent: Implementation Plan #");
                        let haystack = format!("{} {}", issue.get("title").and_then(|v| v.as_str()).unwrap_or(""), issue.get("body").and_then(|v| v.as_str()).unwrap_or(""));
                        haystack.contains(q)
                    }).unwrap_or(true);
                    if state == "open" && is_open && has_label && matches_search {
                        nums.push(serde_json::json!({ "number": n }));
                    }
                }
            }
            if args.iter().any(|a| *a == "--json") {
                Ok(serde_json::to_string(&serde_json::json!(nums))?)
            } else {
                Ok(nums.iter().map(|n| n["number"].as_u64().unwrap_or(0).to_string()).collect::<Vec<_>>().join("\n"))
            }
        }
        _ => anyhow::bail!("mock gh issue: unsupported op `{}`", op),
    }
}

fn mock_gh_pr(args: &[&str]) -> anyhow::Result<String> {
    let op = args.get(1).copied().unwrap_or("");
    match op {
        "list" => {
            // gh pr list --head spec/N --state open|merged --json number
            let head = args.windows(2).find(|w| w[0] == "--head").and_then(|w| w.get(1)).copied().unwrap_or("");
            let state = args.windows(2).find(|w| w[0] == "--state").and_then(|w| w.get(1)).copied().unwrap_or("open");
            let mut nums = Vec::new();
            let dir = mock_file(&["prs"]);
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for e in entries.flatten() {
                    let file = e.path();
                    let Some(name) = file.file_stem().and_then(|s| s.to_str()) else { continue; };
                    let Ok(n) = name.parse::<u32>() else { continue; };
                    let pr = mock_read_pr(n);
                    let pr_head = pr.get("head").and_then(|v| v.as_str()).unwrap_or("");
                    let pr_state = pr.get("state").and_then(|v| v.as_str()).unwrap_or("");
                    let match_state = if state == "merged" { pr_state == "MERGED" } else { pr_state == "OPEN" };
                    if pr_head == head && match_state {
                        nums.push(serde_json::json!({ "number": n }));
                    }
                }
            }
            Ok(serde_json::to_string(&serde_json::json!(nums))?)
        }
        "view" => {
            let p = args.get(2).ok_or_else(|| anyhow::anyhow!("mock gh pr view: no pr number"))?.to_string();
            let n = p.trim_start_matches('#').parse::<u32>().map_err(|_| anyhow::anyhow!("mock gh pr view: bad pr `{}`", p))?;
            if !mock_pr_path(n).exists() {
                anyhow::bail!("mock gh pr view #{}: not found", n);
            }
            let pr = mock_read_pr(n);
            let out = serde_json::json!({
                "state": pr.get("state").cloned().unwrap_or_else(|| serde_json::json!("OPEN")),
                "mergeStateStatus": pr.get("mergeStateStatus").cloned().unwrap_or_else(|| serde_json::json!("CLEAN")),
                "statusCheckRollup": pr.get("statusCheckRollup").cloned().unwrap_or_else(|| serde_json::json!([])),
            });
            Ok(serde_json::to_string(&out)?)
        }
        "create" => {
            // gh pr create --base main --head spec/N --title T --body B
            let mut base = "main";
            let mut head = "";
            let mut title = "";
            let mut body = "";
            let mut i = 2;
            while i < args.len() {
                match args[i] {
                    "--base" => { base = args.get(i + 1).copied().unwrap_or("main"); i += 2; }
                    "--head" => { head = args.get(i + 1).copied().unwrap_or(""); i += 2; }
                    "--title" => { title = args.get(i + 1).copied().unwrap_or(""); i += 2; }
                    "--body" => { body = args.get(i + 1).copied().unwrap_or(""); i += 2; }
                    _ => { i += 1; }
                }
            }
            let n = mock_next_counter("pr");
            let pr = serde_json::json!({
                "number": n,
                "head": head,
                "base": base,
                "title": title,
                "body": body,
                "state": "OPEN",
                "mergeStateStatus": "CLEAN",
                "statusCheckRollup": [],
            });
            mock_write_pr(n, &pr)?;
            Ok(format!("https://github.com/{}/pull/{}", mock_repo_name(), n))
        }
        "merge" => {
            let p = args.get(2).ok_or_else(|| anyhow::anyhow!("mock gh pr merge: no pr number"))?.to_string();
            let n = p.trim_start_matches('#').parse::<u32>().map_err(|_| anyhow::anyhow!("mock gh pr merge: bad pr `{}`", p))?;
            let mut pr = mock_read_pr(n);
            pr["state"] = serde_json::json!("MERGED");
            mock_write_pr(n, &pr)?;
            Ok(String::new())
        }
        _ => anyhow::bail!("mock gh pr: unsupported op `{}`", op),
    }
}

fn mock_gh_api(args: &[&str]) -> anyhow::Result<String> {
    // gh api repos/owner/repo/contents/PATH?ref=B   (GET, returns {sha} or 404)
    // gh api -X PUT repos/.../contents/PATH --input F (upsert)
    // gh api repos/owner/repo/git/ref/heads/B       (GET, returns {ref,object.sha} or 404)
    let mut rest = &args[1..];
    let mut method = "GET";
    if rest.first().map(|a| *a == "-X").unwrap_or(false) {
        method = rest.get(1).copied().unwrap_or("GET");
        rest = &rest[2..];
    }
    let url = rest.first().map(|s| s.to_string()).unwrap_or_default();
    let repo = mock_repo_name();
    // Normalize the URL: repos/<owner>/<repo>/<api-path>
    let api = url.strip_prefix(&format!("repos/{}/", repo)).unwrap_or(&url);
    if api.starts_with("contents/") {
        let path_and_branch = &api["contents/".len()..];
        // path may carry `?ref=<branch>`
        let (path, branch) = match path_and_branch.split_once("?ref=") {
            Some((p, b)) => (p.to_string(), b.to_string()),
            None => (path_and_branch.to_string(), "main".to_string()),
        };
        let cp = mock_contents_path(&branch, &path);
        if method == "GET" {
            if !cp.exists() {
                anyhow::bail!("HTTP 404 (Not Found): {}", path);
            }
            let content = mock_read(&cp).unwrap_or_default();
            let sha = format!("mock{}", path.len());
            let encoded = base64::engine::general_purpose::STANDARD.encode(content);
            return Ok(serde_json::json!({ "sha": sha, "content": encoded }).to_string());
        }
        if method == "PUT" {
            // payload JSON: { message, content (b64), branch, sha? } from --input
            let input = rest.windows(2).find(|w| w[0] == "--input").and_then(|w| w.get(1)).map(|s| PathBuf::from(s));
            let payload: serde_json::Value = input
                .and_then(|p| mock_read(&p))
                .and_then(|c| serde_json::from_str(&c).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            let content_b64 = payload.get("content").and_then(|c| c.as_str()).unwrap_or("");
            let content = base64::engine::general_purpose::STANDARD.decode(content_b64).unwrap_or_default();
            mock_write(&cp, &String::from_utf8_lossy(&content))?;
            return Ok(serde_json::json!({ "content": { "sha": format!("mock{}", path.len()), "name": path } }).to_string());
        }
        if method == "DELETE" {
            let _ = std::fs::remove_file(&cp);
            return Ok(String::new());
        }
    }
    if api.starts_with("git/ref/heads/") {
        let branch = &api["git/ref/heads/".len()..];
        if method == "GET" {
            if !mock_ref_exists(branch) {
                anyhow::bail!("HTTP 404 (Not Found): {}", api);
            }
            return Ok(serde_json::json!({ "ref": format!("refs/heads/{}", branch), "object": { "sha": "mock1" } }).to_string());
        }
    }
    if api.starts_with("git/refs/heads/") {
        let branch = &api["git/refs/heads/".len()..];
        if method == "DELETE" {
            mock_ref_delete(branch)?;
            return Ok(String::new());
        }
    }
    anyhow::bail!("mock gh api: unsupported path `{}`", url)
}

/// Minimal `--jq` support for the handful of selectors the machine/harness use.
fn mock_jq(v: &serde_json::Value, query: &str) -> String {
    match query {
        ".body" => v.get("body").and_then(|b| b.as_str()).unwrap_or("").to_string(),
        ".state" => v.get("state").and_then(|s| s.as_str()).unwrap_or("").to_string(),
        ".nameWithOwner" => mock_repo_name(),
        ".comments[].body" => v.get("comments").and_then(|c| c.as_array()).map(|a| a.iter().filter_map(|c| c["body"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default(),
        ".labels[].name" => v.get("labels").and_then(|l| l.as_array()).map(|a| a.iter().filter_map(|x| x["name"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default(),
        _ => v.to_string(),
    }
}

/// Emulate the `git` commands the state machine uses, against the mock store.
fn mock_git(args: &[&str]) -> anyhow::Result<String> {
    let sub = args.first().copied().unwrap_or("");
    match sub {
        "fetch" => {
            // git fetch origin main / git fetch origin spec/N — no-op; record FETCH_HEAD.
            if let Some(branch) = args.get(2) {
                mock_write(&mock_file(&["last-fetch"]), branch)?;
            }
            Ok(String::new())
        }
        "rev-list" => {
            // git rev-list --count origin/main..FETCH_HEAD
            if args.iter().any(|a| *a == "--count") {
                let branch = mock_read(&mock_file(&["last-fetch"])).unwrap_or_default();
                let branch = branch.trim().trim_start_matches("origin/");
                return Ok(mock_commits_ahead(branch).to_string());
            }
            Ok(String::new())
        }
        "ls-remote" => {
            // git ls-remote --exit-code origin refs/heads/<branch>
            if args.iter().any(|a| *a == "--exit-code") {
                let branch = args.last().map(|s| s.to_string()).unwrap_or_default();
                let branch = branch.strip_prefix("refs/heads/").map(|s| s.to_string()).unwrap_or(branch);
                let branch = branch.strip_prefix("origin/").map(|s| s.to_string()).unwrap_or(branch);
                if mock_ref_exists(&branch) {
                    return Ok(String::new());
                }
                anyhow::bail!("git ls-remote --exit-code: branch `{}` not found", branch);
            }
            Ok(String::new())
        }
        "rev-parse" => {
            // git rev-parse --verify --quiet refs/heads/<branch>
            if args.iter().any(|a| *a == "--verify") {
                let branch = args.last().map(|s| s.to_string()).unwrap_or_default();
                let branch = branch.strip_prefix("refs/heads/").map(|s| s.to_string()).unwrap_or(branch);
                if mock_ref_exists(&branch) {
                    return Ok("mock-sha".into());
                }
                anyhow::bail!("git rev-parse --verify: branch `{}` not found", branch);
            }
            Ok(String::new())
        }
        "checkout" => {
            // git checkout -b spec/N main  (create ref) / git checkout main (no-op)
            if args.iter().any(|a| *a == "-b") {
                let branch = args.get(2).copied().unwrap_or("");
                mock_ref_write(branch)?;
            }
            Ok(String::new())
        }
        "push" => {
            // git push -u origin spec/N — mark the branch ref (simulated push)
            if let Some(branch) = args.last() {
                let branch = branch.strip_prefix("origin/").map(|s| s.to_string()).unwrap_or_else(|| branch.to_string());
                if !branch.is_empty() && !branch.contains(':') {
                    mock_ref_write(&branch)?;
                }
            }
            Ok(String::new())
        }
        "worktree" => {
            let op = args.get(1).copied().unwrap_or("");
            match op {
                "add" => {
                    // git worktree add --detach <path> <base>
                    let path = args.windows(2).find(|w| w[0] == "--detach").and_then(|w| w.get(1)).copied().unwrap_or("");
                    if !path.is_empty() {
                        mock_ensure_dir(&PathBuf::from(path));
                    }
                    Ok(String::new())
                }
                "remove" => {
                    let path = args.get(2).copied().unwrap_or("");
                    if !path.is_empty() {
                        let _ = std::fs::remove_dir_all(path);
                    }
                    Ok(String::new())
                }
                "prune" => Ok(String::new()),
                _ => Ok(String::new()),
            }
        }
        "for-each-ref" => {
            // git for-each-ref --format=%(refname:short) refs/heads
            let mut out = String::new();
            let dir = mock_file(&["refs"]);
            if let Ok(entries) = std::fs::read_dir(&dir) {
                let mut names: Vec<String> = entries.flatten()
                    .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
                    .filter(|s| s.starts_with("spec/"))
                    .collect();
                names.sort();
                for n in names {
                    out.push_str(&n);
                    out.push('\n');
                }
            }
            Ok(out.trim_end().to_string())
        }
        "merge-base" => {
            // git merge-base --is-ancestor <name> main
            if args.iter().any(|a| *a == "--is-ancestor") {
                return Ok(String::new());
            }
            Ok(String::new())
        }
        "branch" => {
            // git branch -D <name>
            Ok(String::new())
        }
        "ls-tree" => {
            // git ls-tree -r --name-only origin/main -- <path>
            let _ = args;
            Ok(String::new())
        }
        "prune" => Ok(String::new()),
        _ => anyhow::bail!("mock git: unsupported subcommand `{}` ({})", sub, args.join(" ")),
    }
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
    if mock_mode() {
        // The mock raises a 404 as an Err; anything else that succeeds is Some(stdout).
        return match mock_gh(&owned) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.to_string().contains("404") => Ok(None),
            Err(e) => Err(e),
        };
    }
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
    }
    anyhow::bail!("no 'Parent: Implementation Plan #N' reference found in #{}", issue)
}

/// Resolve the base branch for sub-issue work: the spec integration branch
/// `spec/<parent>` when the issue references a parent, otherwise `main`.
fn resolve_base(issue: u32) -> anyhow::Result<String> {
    // The developer works directly on the FEATURE issue (sub-issues were removed).
    // If the issue references a plan (a legacy sub-issue), map plan → feature;
    // otherwise the issue IS the feature and its branch is `spec/<issue>`.
    match parent_spec(issue) {
        Ok(plan) => {
            // The sub-issue references the PLAN; the integration branch is named
            // after the FEATURE — map plan → feature (falling back to the plan
            // number) so `spec/<feature>` resolves instead of a phantom `spec/<plan>`.
            let feature = plan_feature(plan).unwrap_or(plan);
            let branch = format!("spec/{}", feature);
            let _ = run_cmd("git", &["fetch", "origin", &branch]);
            Ok(branch)
        }
        Err(_) => {
            let branch = format!("spec/{}", issue);
            let _ = run_cmd("git", &["fetch", "origin", &branch]);
            Ok(branch)
        }
    }
}

/// Extract the text under a `## Heading` in a markdown body (until the next heading).
fn section(body: &str, heading: &str) -> String {
    let mut out = String::new();
    let mut capture = false;
    for line in body.lines() {
        let t = line.trim_start();
        if t.starts_with("## ") {
            if t == heading {
                capture = true;
            } else if capture {
                break;
            }
        } else if capture {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// The number of leading `#` on a markdown line (0 for non-heading lines).
fn heading_level(line: &str) -> usize {
    line.trim_start().chars().take_while(|&c| c == '#').count()
}

/// Normalize a section key / heading for case-insensitive matching: lowercase and
/// drop all non-alphanumerics, so `software-architect` matches `Software Architect`
/// and `ui-ux` matches `UI/UX Expert`.
fn normalize_section_key(s: &str) -> String {
    s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

/// Whether a heading (without the leading `#`) matches a normalized section key.
fn section_key_matches(heading: &str, key_norm: &str) -> bool {
    let h = normalize_section_key(heading);
    h == key_norm || h.starts_with(key_norm)
}

/// Replace the block under the first top-level `## <key>` heading (matched
/// case-insensitively) with `new_text`, keeping the heading line. The block runs
/// until the next same-or-higher-level heading (`# ` or `## `) — nested `###`
/// subsections are part of the block and are replaced too. Errors when no
/// matching heading exists. Idempotent: re-running replaces the same section.
fn replace_section(body: &str, key: &str, new_text: &str) -> anyhow::Result<String> {
    let key_norm = normalize_section_key(key);
    let mut out: Vec<String> = Vec::new();
    let mut found = false;
    let mut in_block = false;
    for line in body.lines() {
        let level = heading_level(line);
        if in_block {
            // Skip everything until the next same-or-higher-level heading.
            if level >= 1 && level <= 2 {
                in_block = false;
                out.push(line.to_string());
            }
            continue;
        }
        if !found && level == 2 {
            let heading = line.trim_start().trim_start_matches('#').trim();
            if section_key_matches(heading, &key_norm) {
                found = true;
                in_block = true;
                out.push(line.to_string());
                out.push(String::new());
                out.extend(new_text.lines().map(|l| l.to_string()));
                continue;
            }
        }
        out.push(line.to_string());
    }
    if !found {
        anyhow::bail!("update-plan: no '## ' section matching '{}' in the issue body", key);
    }
    if body.ends_with('\n') {
        out.push(String::new());
    }
    Ok(out.join("\n"))
}

/// Upsert a file (base64 content) on `branch` via the Contents API.
fn upsert_file(repo: &str, branch: &str, path: &str, content_b64: &str, message: &str) -> anyhow::Result<()> {
    let url = format!("repos/{}/contents/{}", repo, path);
    let existing = gh_api_raw_opt(&[format!("{}?ref={}", url, branch)])?;
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
    // The developer works directly on the FEATURE issue in the implementation
    // phase (sub-issues were removed) — its phase label is `ready-for-test`; the
    // legacy dev labels remain accepted too.
    let actionable = labels.iter().any(|l| l == "ready-for-dev" || l == "in-progress-dev" || l == "ready-for-test");
    if !actionable {
        return Ok((false, format!("issue #{} is not actionable (labels: {})", issue, labels.join(", "))));
    }
    Ok((true, String::new()))
}

/// Guard for `ensure_spec_pr_merged`: the PR must be open, mergeable
/// (mergeStateStatus CLEAN), and have no failing/pending CI checks.
/// Environmental runner-provisioning failures (a CI check that failed in under
/// 10s with no steps) are exempted — they are GitHub runner outages, not real
/// build/test failures, and must not block the spec-PR auto-merge indefinitely.
fn pr_merge_guard(pr: &str) -> anyhow::Result<(bool, String)> {
    let json = run_gh(&["pr", "view", pr, "--json", "state,mergeStateStatus,statusCheckRollup"])?;
    let v: serde_json::Value = serde_json::from_str(&json)?;
    let state = v.get("state").and_then(|s| s.as_str()).unwrap_or("");
    if state != "OPEN" {
        return Ok((false, format!("PR #{} is not open (state: {})", pr, state)));
    }
    // Evaluate the CI check rollup first: a non-exempt failing/pending check is a
    // hard block regardless of mergeStateStatus. Exempt env failures are noted.
    let mut env_failures = 0usize;
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
                    // Environmental runner-provisioning exemption: a FAILURE that
                    // completed in under 10s (the runner could not even start — the
                    // log zip is empty) is an infrastructure failure, NOT a real
                    // build/test failure. Real cargo/pnpm builds cannot fail that
                    // fast (they take minutes to reach compilation). A genuine
                    // build failure always takes longer and produces a log.
                    let env_failure = (|| {
                        let start = check.get("startedAt").and_then(|s| s.as_str())?;
                        let end = check.get("completedAt").and_then(|s| s.as_str())?;
                        let start_ts = chrono::DateTime::parse_from_rfc3339(start).ok()?;
                        let end_ts = chrono::DateTime::parse_from_rfc3339(end).ok()?;
                        let secs = (end_ts - start_ts).num_seconds();
                        Some(secs >= 0 && secs < 10)
                    })().unwrap_or(false);
                    if env_failure {
                        env_failures += 1;
                    } else {
                        return Ok((false, format!("PR #{} CI check '{}' failed: {}", pr, name, conclusion)));
                    }
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
    // mergeStateStatus: CLEAN is fine; UNSTABLE is acceptable IF every failing
    // check was an exempt environmental runner failure (real check failures were
    // already rejected above). DIRTY/BLOCKED/BEHIND/UNKNOWN still hard-block.
    let mss = v.get("mergeStateStatus").and_then(|s| s.as_str()).unwrap_or("");
    match mss {
        "CLEAN" => {}
        "UNSTABLE" if env_failures > 0 => {
            // All CI-red is environmental (runner-provisioning) — allow the merge.
        }
        "UNSTABLE" => {
            return Ok((false, format!("PR #{} is not mergeable (mergeStateStatus: {} — no exempt CI failures; the checks above block)", pr, mss)));
        }
        _ => {
            return Ok((false, format!("PR #{} is not mergeable (mergeStateStatus: {})", pr, mss)));
        }
    }
    // No checks at all is allowed (repo without CI configured).
    Ok((true, String::new()))
}

/// Post a compact final-metrics `Status` comment for a completed issue (durations,
/// rework, blocked, failures, event count). The mechanical half of the closing summary.
fn post_final_summary(issue: u32) -> anyhow::Result<()> {
    let events = read_issue_events(issue);
    if events.is_empty() {
        return Ok(());
    }
    let mut phase_starts: BTreeMap<String, i64> = BTreeMap::new();
    let mut phase_completes: BTreeMap<String, i64> = BTreeMap::new();
    let mut rework = 0usize;
    let mut blocked = 0usize;
    let mut failures = 0usize;
    for e in &events {
        let ts = chrono::DateTime::parse_from_rfc3339(&e.ts).map(|t| t.timestamp()).unwrap_or(0);
        match e.event_name.as_str() {
            "phase.started" => { phase_starts.entry(e.phase.clone()).or_insert(ts); }
            "phase.completed" => { phase_completes.insert(e.phase.clone(), ts); }
            "transition" => { if is_rework(e) { rework += 1; } }
            "block" => { blocked += 1; }
            _ => {}
        }
        if e.outcome == "blocked" { blocked += 1; }
        if e.outcome == "failure" { failures += 1; }
    }
    let mut durations: Vec<(String, f64)> = Vec::new();
    for (p, s) in &phase_starts {
        if let Some(en) = phase_completes.get(p) {
            durations.push((p.clone(), (en - s) as f64 / 60.0));
        }
    }
    durations.sort_by(|a, b| a.0.cmp(&b.0));
    let dur_text = if durations.is_empty() {
        "n/a".to_string()
    } else {
        durations.iter().map(|(p, m)| format!("{}:{:.0}m", p, m)).collect::<Vec<_>>().join(", ")
    };
    let body = format!(
        "## Status\n\nFinal metrics: **{}** events · rework **{}** · blocked **{}** · failures **{}** · phase durations ({})",
        events.len(), rework, blocked, failures, dur_text
    );
    let tmp = project_root()?.join(".opencode").join("tmp").join(format!("summary-{}.md", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(tmp.parent().unwrap())?;
    std::fs::write(&tmp, body)?;
    run_gh(&["issue", "comment", &issue.to_string(), "--body-file", tmp.to_str().unwrap()])?;
    let _ = std::fs::remove_file(&tmp);
    Ok(())
}

/// Transition side-effect: ensure the spec integration branch `spec/<issue>` exists
/// on origin (created from `main`). Idempotent. Returns a note if it created it.
fn ensure_spec_branch(issue: u32) -> anyhow::Result<Option<String>> {
    let branch = format!("spec/{}", issue);
    let remote_exists = run_cmd("git", &["ls-remote", "--exit-code", "origin", &format!("refs/heads/{}", branch)]).is_ok();
    if remote_exists {
        return Ok(None);
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
    Ok(Some(format!("spec branch `{}` created", branch)))
}

/// Transition side-effect: ensure an open spec PR (`spec/<issue>` → `main`) exists.
/// Idempotent — skips if one is already open. Title/body default from the issue.
/// Returns a note if it created one.
fn ensure_spec_pr(issue: u32) -> anyhow::Result<Option<String>> {
    let head = format!("spec/{}", issue);
    let open_out = run_gh(&["pr", "list", "--head", &head, "--state", "open", "--json", "number"])?;
    let open_count = serde_json::from_str::<serde_json::Value>(&open_out)
        .ok()
        .and_then(|v| v.as_array().map(|a| a.len()))
        .unwrap_or(0);
    if open_count > 0 {
        return Ok(None);
    }
    let title = get_issue(issue)?
        .map(|i| i.title)
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| format!("Spec #{}", issue));
    let body = format!("#{}\n\n`{}` → `main`. All sub-issues are on the spec integration branch.", issue, head);
    let out = run_gh(&["pr", "create", "--base", "main", "--head", &head, "--title", &title, "--body", &body])?;
    println!("SPEC PR CREATED: {}", out);
    Ok(Some(format!("spec PR created: {}", out)))
}

/// Transition side-effect (`testing → audit`): merge the spec PR once the tester
/// passed. Idempotent — no open PR (already merged) is a no-op. The branch is
/// always kept so evidence URLs keep rendering. Returns a note if it merged one.
fn ensure_spec_pr_merged(issue: u32) -> anyhow::Result<Option<String>> {
    let head = format!("spec/{}", issue);
    let open_out = run_gh(&["pr", "list", "--head", &head, "--state", "open", "--json", "number"])?;
    let numbers: Vec<String> = serde_json::from_str::<serde_json::Value>(&open_out)
        .ok()
        .and_then(|v| v.as_array().map(|a| {
            a.iter().filter_map(|e| e["number"].as_u64().map(|n| n.to_string())).collect()
        }))
        .unwrap_or_default();
    if numbers.len() > 1 {
        // No-PR means "already merged", but duplicate PRs are a real anomaly —
        // surface them instead of silently skipping (one would never get merged).
        println!("WARNING: {} open {} PRs (#{}) — expected exactly one; skipping merge", numbers.len(), head, numbers.join(", #"));
        return Ok(None);
    }
    if numbers.is_empty() {
        return Ok(None);
    }
    let pr = &numbers[0];
    let (ok, reason) = pr_merge_guard(pr)?;
    if !ok {
        anyhow::bail!("cannot merge spec PR #{}: {}", pr, reason);
    }
    // This repo is squash-merge-only (merge commits and rebase are disabled), so
    // the spec PR must be squash-merged — `--merge` fails with "Merge commits are
    // not allowed on this repository."
    run_gh(&["pr", "merge", pr, "--squash"])?;
    println!("SPEC PR MERGED: #{}", pr);
    Ok(Some(format!("spec PR #{} merged", pr)))
}

/// Swap an issue's phase label from `from` to `to` (removes the source label,
/// adds the target label, keeping any non-phase labels).
fn swap_phase_label(issue: u32, from: Phase, to: Phase) -> anyhow::Result<()> {
    let issue_str = issue.to_string();
    let from_label = phase_label(from);
    let to_label = phase_label(to);
    let mut edit_args: Vec<&str> = vec!["issue", "edit", &issue_str, "--add-label", &to_label];
    if from_label != to_label {
        edit_args.push("--remove-label");
        edit_args.push(&from_label);
    }
    run_gh(&edit_args)?;
    Ok(())
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

/// Find the open issue that is the Implementation Plan **for feature `issue`**.
/// Single-issue model: the plan is a `## Triage Plan` comment on the feature
/// issue — NO separate plan issue is created — so this always returns `None`.
/// Kept as a legacy fallback only (pre-refactor specs that still carry a plan
/// issue retain evidence resolution); new specs never have one.
fn find_impl_plan(issue: u32) -> Option<u32> {
    let _ = issue;
    None
}

/// Resolve the ephemeral A2A working file for a feature issue.
fn triage_a2a_path(issue: u32) -> anyhow::Result<PathBuf> {
    Ok(project_root()?.join(".opencode").join("tmp").join(issue.to_string()).join("triage.md"))
}

/// The heading-line marker the QA Expert uses in its A2A section to declare which
/// feature-domain test suites were seeded (`**Feature tests:** a, b`).
const FEATURE_TESTS_PREFIX: &str = "**Feature tests:**";

/// Parse feature-domain names from the QA Expert's A2A section so the
/// `triage → implementation` transition can persist each suite automatically.
fn parse_feature_names(a2a: &str) -> Vec<String> {
    section(a2a, "## QA Expert")
        .lines()
        .map(|l| l.trim())
        .filter(|l| l.starts_with(FEATURE_TESTS_PREFIX))
        .flat_map(|l| l[FEATURE_TESTS_PREFIX.len()..].split(','))
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'))
        .map(str::to_string)
        .collect()
}

/// Idempotently seed the ephemeral A2A working file from the triage template.
/// Returns a note when created. Used by the `triage-init` action and as an auto
/// side-effect of `intake → triage`.
fn ensure_triage_a2a(issue: u32, actor: &str) -> anyhow::Result<Option<String>> {
    let path = triage_a2a_path(issue)?;
    if path.exists() {
        return Ok(None);
    }
    let root = project_root()?;
    let title = get_issue(issue)?
        .map(|i| i.title)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| anyhow::anyhow!("cannot resolve the title of #{} (pass --title)", issue))?;
    let template = root.join("docs").join("agentic-pipeline").join("templates").join("triage-plan-template.md");
    let raw = std::fs::read_to_string(&template)
        .map_err(|_| anyhow::anyhow!("triage template not found (create docs/agentic-pipeline/templates/triage-plan-template.md)"))?;
    let backlog = format!("#{}", issue);
    let seeded = raw
        .replace("{{issue}}", &issue.to_string())
        .replace("<issue>", &issue.to_string())
        .replace("{{title}}", &title)
        .replace("<title>", &title)
        .replace("{{backlog}}", &backlog)
        .replace("<backlog>", &backlog);
    let body = format!("{}{}\n## Discussion\n", TRIAGE_A2A_HEADER, seeded.trim_end());
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, &body)?;
    println!("TRIAGE A2A FILE CREATED: {}", path.display());
    append_event(issue, "triage-init", actor, "triage", "success", &path.to_string_lossy().to_string())?;
    Ok(Some(format!("A2A file `{}` seeded", path.display())))
}

/// The `## ` heading each plan section key maps to in the A2A file / template.
fn plan_heading(key: &str) -> &'static str {
    match key {
        "software-architect" => "## Software Architect",
        "ui-ux" => "## UI/UX Expert",
        "qa" => "## QA Expert",
        "summary" => "## Summary",
        "staffing" => "## Staffing Plan",
        "deployment" => "## Deployment Notes",
        "risks" => "## Risks & Mitigations",
        _ => unreachable!("unknown plan key"),
    }
}

/// Plan section keys, in display order, matching the triage-plan template.
const PLAN_KEYS: &[&str] = &["software-architect", "ui-ux", "qa", "summary", "staffing", "deployment", "risks"];

/// Assemble the plan at the `triage → implementation` transition into the
/// `## Triage Plan` timeline-comment draft (`.opencode/tmp/<issue>/triage-plan.md`),
/// which the transition's `post_pending_comments` then auto-posts ON the feature
/// issue. Single-issue model: no separate Implementation Plan issue is created —
/// the feature issue is the only issue per spec and carries the plan as a comment.
/// Returns `Some(())` when the draft was written (idempotent).
fn assemble_impl_plan(issue: u32, actor: &str) -> anyhow::Result<Option<()>> {
    let a2a_path = triage_a2a_path(issue)?;
    let a2a = std::fs::read_to_string(&a2a_path)
        .map_err(|_| anyhow::anyhow!("A2A file missing at {} — run triage-init (or transition intake→triage) first", a2a_path.display()))?;
    let title = get_issue(issue)?
        .map(|i| i.title)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| anyhow::anyhow!("cannot resolve the title of #{}", issue))?;
    let mut body = seed_triage_plan_body(&title)?
        .replace("#<TBD>", &format!("#{}", issue))
        .replace("{{issue}}", &issue.to_string())
        .replace("<issue>", &issue.to_string());
    let mut filled: Vec<String> = Vec::new();
    for key in PLAN_KEYS {
        let content = section(&a2a, plan_heading(key));
        if !content.trim().is_empty() {
            body = replace_section(&body, key, &content.trim_end())?;
            filled.push(key.to_string());
        }
    }
    // The `## Triage Plan` timeline draft must carry the agent footer (anti-spoofing).
    if !body.to_lowercase().contains("*authored by") {
        body.push_str("\n\n*Authored by Self-Improver*");
    }
    let draft_dir = project_root()?.join(".opencode").join("tmp").join(issue.to_string());
    std::fs::create_dir_all(&draft_dir)?;
    let draft = draft_dir.join("triage-plan.md");
    std::fs::write(&draft, &body)?;
    let filled_note = if filled.is_empty() { "none".to_string() } else { filled.join(", ") };
    println!("TRIAGE PLAN DRAFTED: {} (sections: {})", draft.display(), filled_note);
    append_event(issue, "assemble-plan", actor, "implementation", "success", &format!("triage plan drafted (sections: {})", filled_note))?;
    Ok(Some(()))
}

/// Extract the feature issue number from an impl-plan's title
/// (`Implementation Plan #<N> — …` or `Implementation Plan #<N> - …`) so the
/// manual `generate-work` can build a correct spec branch reference
/// (`spec/<feature>`, not `spec/<plan>`). Parses the leading digits directly —
/// robust to both dash styles and to hyphens inside the feature name.
fn plan_feature(plan_issue: u32) -> Option<u32> {
    let title = get_issue(plan_issue).ok().flatten().map(|i| i.title)?;
    let rest = title.strip_prefix("Implementation Plan #")?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() { None } else { digits.parse().ok() }
}

/// Persist one feature-domain test suite `.opencode/tests/<feature>/` to `main`.
/// Returns the number of files persisted (0 when the suite does not exist yet).
/// Reused by the `tests-commit` action and the transition side-effect.
fn persist_tests(feature: &str) -> anyhow::Result<usize> {
    let dir = project_root()?.join(".opencode").join("tests").join(feature);
    if !dir.is_dir() {
        return Ok(0);
    }
    let mut files: Vec<std::fs::DirEntry> = std::fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file() && e.path().extension().map(|x| x == "md").unwrap_or(false))
        .collect();
    files.sort_by_key(|e| e.file_name());
    if files.is_empty() {
        return Ok(0);
    }
    let repo = gh_repo()?;
    for entry in &files {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = format!(".opencode/tests/{}/{}", feature, name);
        let bytes = std::fs::read(&path)?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        upsert_file(&repo, "main", &rel, &encoded, &format!("tests({}): update {}", feature, name))?;
    }
    println!("TESTS COMMITTED: feature '{}' ({} file(s)) to main", feature, files.len());
    Ok(files.len())
}

/// Seed the Implementation Plan issue body from the triage-plan template when the
/// orchestrator (self-improver) creates an impl-plan without a
/// `--body-file`. Substitutes the title and a backlog marker; the `<issue>`
/// placeholder cannot be filled until the issue number is known, so it is patched
/// by the caller after creation.
fn seed_triage_plan_body(title: &str) -> anyhow::Result<String> {
    let root = project_root()?;
    let path = root.join("docs").join("agentic-pipeline").join("templates").join("triage-plan-template.md");
    let raw = std::fs::read_to_string(&path).map_err(|_| {
        anyhow::anyhow!("triage template not found — create docs/agentic-pipeline/templates/triage-plan-template.md")
    })?;
    // The template line is `> Backlog: #<backlog>`. Replace the WHOLE token (with
    // its leading `#`) so the final plan reads `> Backlog: #<issue>` — a single
    // hash that `find_impl_plan`'s body marker can match.
    Ok(raw
        .replace("{{title}}", title)
        .replace("<title>", title)
        .replace("#<backlog>", "#<TBD>")
        .replace("{{backlog}}", "#<TBD>")
        .replace("<backlog>", "#<TBD>"))
}

/// Verification status of a feature's tester evidence, shared by the testing exit
/// gate, the audit bundle, `audit-record`, and the `done` close path (Spec #1499
/// false-PASS hardening). Returns:
///   (has_evidence, verdict_is_pass, policy, live_evidence, ok, reason)
/// Rules:
///   - Only `## Evidence` comments count (a Status/Question comment must never be
///     able to plant the `telemetry_spans` token).
///   - The verdict must be a clear PASS (a FAIL evidence never advances to audit).
///   - Under the plan's verification policy (default LIVE), live evidence means an
///     `## Evidence` comment that references `telemetry_spans` (a live query).
///     `ok` is false unless ALL three hold.
#[allow(clippy::too_many_arguments)]
/// The LATEST `## Evidence` / `## Tests Runs` comment across the feature issue AND
/// its plan issue, ordered by GitHub `created_at` (comments arrive oldest-first;
/// explicit timestamp sort makes the two issues comparable). Returns the body, or
/// None when no evidence comment exists on either issue. Fixes the cross-issue
/// stale-mask: a newer FAIL on one issue always beats an older PASS on the other.
fn latest_evidence_comment(issue: u32, plan: Option<u32>) -> Option<String> {
    let mut items: Vec<(String, String)> = Vec::new();
    let mut issues: Vec<u32> = vec![issue];
    if let Some(p) = plan { issues.push(p); }
    for id in issues {
        let json = run_gh(&["issue", "view", &id.to_string(), "--comments", "--json", "comments"]).unwrap_or_default();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) {
            if let Some(arr) = v.get("comments").and_then(|c| c.as_array()) {
                for c in arr {
                    let body = c.get("body").and_then(|b| b.as_str()).unwrap_or("");
                    let t = body.trim_start();
                    if t.starts_with("## Evidence") || t.starts_with("## Tests Runs") {
                        let ts = c.get("createdAt").and_then(|x| x.as_str()).unwrap_or("").to_string();
                        items.push((ts, body.to_string()));
                    }
                }
            }
        }
    }
    items.sort_by(|a, b| a.0.cmp(&b.0));
    items.last().map(|(_, b)| b.clone())
}

fn verification_status(issue: u32) -> (bool, bool, String, bool, bool, String) {
    let plan = find_impl_plan(issue);
    // The LATEST evidence comment across the feature + plan issues (timestamped).
    let latest = latest_evidence_comment(issue, plan).unwrap_or_default();
    let has_evidence = !latest.trim().is_empty();
    // Parse the explicit `Verdict:` line — a FAIL verdict that also contains the
    // substring "PASS" in its per-AC rows must NOT be read as PASS.
    let verdict_line = latest.lines()
        .find(|l| l.trim().to_lowercase().starts_with("verdict:"))
        .map(|l| l.trim().to_lowercase());
    let verdict_pass = verdict_line.map(|v| v.contains("pass") && !v.contains("fail")).unwrap_or(false);
    // The verification policy comes from the plan. Single-issue model: the plan is
    // the feature issue's `## Triage Plan` comment (or the A2A file's QA section
    // pre-posting); the legacy plan-issue body remains a fallback for old specs.
    let mut plan_source = get_issue_comments(issue).into_iter().rev()
        .find(|b| b.trim_start().starts_with("## Triage Plan"))
        .unwrap_or_default();
    if plan_source.trim().is_empty() {
        if let Ok(p) = triage_a2a_path(issue) {
            plan_source = std::fs::read_to_string(p).unwrap_or_default();
        }
    }
    if plan_source.trim().is_empty() {
        plan_source = plan
            .map(|p| get_issue(p).ok().flatten().map(|i| i.body).unwrap_or_default())
            .unwrap_or_default();
    }
    let policy_static = plan_source
        // Line-anchored + bold-tolerant: an actual `> **Verification policy: static**`
        // blockquote line (the template convention) counts — prose that merely
        // MENTIONS the policy in a sentence must not drop the live-evidence rule.
        .lines()
        .any(|l| {
            let t = l.trim().trim_start_matches('>').trim().trim_start_matches('*').trim().to_lowercase();
            t.starts_with("verification policy:") && t.contains("static")
        });
    let policy = if policy_static { "static".to_string() } else { "live".to_string() };
    let live_evidence = latest.contains("telemetry_spans");
    let ok = has_evidence && verdict_pass && (policy_static || live_evidence);
    let reason = if !has_evidence {
        "no tester Evidence / Tests Runs comment found on the feature issue".to_string()
    } else if !verdict_pass {
        "tester verdict is not PASS (no `Verdict: PASS` line) — a failing feature must route back to implementation, not audit".to_string()
    } else if !policy_static && !live_evidence {
        "Evidence is static-only for a live-policy plan — include a telemetry-query result (a `telemetry_spans` reference) for emission ACs, or the plan must declare `> Verification policy: static`".to_string()
    } else {
        String::new()
    };
    (has_evidence, verdict_pass, policy, live_evidence, ok, reason)
}

fn exit_guard_passes(phase: Phase, issue: u32) -> (bool, String) {
    let issue_data = get_issue(issue).ok().flatten();
    match phase {
        Phase::Intake => match issue_data {
            // Real gate: the backlog must carry the required intake sections
            // (reuses the same validation `create-issue` applies to backlog/bug
            // bodies), not merely a non-empty body.
            Some(i) => {
                let missing = intake_missing_sections(&i.body);
                if missing.is_empty() {
                    (true, String::new())
                } else {
                    (false, format!("backlog missing required section(s): {}", missing.join(", ")))
                }
            }
            None => (false, "issue not found".into()),
        },
        Phase::Triage => {
            // Leaving triage needs the DELIVERABLE: the implementation plan is the
            // A2A working file `.opencode/tmp/<issue>/triage.md` (the triage
            // cluster's converged draft) — NOT a GitHub Decision comment. The gate
            // checks the plan exists and is converged: every required section is
            // present and the `## Convergence: agreed` marker is appended. If an
            // agent looks for a GitHub comment and finds none, it reads the
            // `.md` files under `.opencode/tmp/<issue>/` instead — the plan is
            // the artifact.
            let a2a_path = triage_a2a_path(issue).unwrap_or_default();
            let a2a = std::fs::read_to_string(a2a_path).unwrap_or_default();
            let has_convergence = a2a.contains("## Convergence: agreed");
            let missing: Vec<&str> = [
                "## Summary", "## Software Architect", "## UI/UX Expert",
                "## QA Expert", "## Staffing Plan", "## Deployment Notes",
                "## Risks & Mitigations",
            ].iter().copied().filter(|h| !a2a.contains(h)).collect();
            if !has_convergence || !missing.is_empty() {
                let why = if !has_convergence {
                    "the implementation plan lacks '## Convergence: agreed'".to_string()
                } else {
                    format!("the implementation plan lacks section(s): {}", missing.join(", "))
                };
                return (false, format!("triage not converged — {}", why));
            }
            (true, String::new())
        }
        Phase::Implementation => {
            // Real gate: the spec integration branch has commits the developer
            // pushed — commits reachable from the branch but not from main.
            // (Sub-issues were removed; all work is tracked on the plan issue +
            // the spec branch.) Fails CLOSED on any lookup error.
            let branch = format!("spec/{}", issue);
            let ahead: Option<u64> = (|| {
                run_cmd("git", &["fetch", "origin", "main"]).ok()?;
                run_cmd("git", &["fetch", "origin", &branch]).ok()?;
                run_cmd("git", &["rev-list", "--count", "origin/main..FETCH_HEAD"]).ok()?
                    .trim().parse::<u64>().ok()
            })();
            match ahead {
                Some(n) if n > 0 => (true, String::new()),
                Some(_) => (false, format!("{} has no commits beyond main — the developer must push", branch)),
                None => (false, format!("cannot verify {} (does it exist on origin? triage→implementation creates it)", branch)),
            }
        }
        Phase::Testing => {
            // A tester verdict comment must exist to leave testing at all — a FAIL
            // verdict routes BACK to implementation (rework), a PASS continues to
            // audit. The audit-specific full verification (policy + live evidence,
            // fail-closed) is enforced in the transition for the testing→audit leg.
            let (has_evidence, _, _, _, _, reason) = verification_status(issue);
            (has_evidence, if has_evidence { String::new() } else { reason })
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

/// Entry/actionability check for the context block's "Validation" field: whether the
/// dispatched issue is actionable NOW. Unlike `exit_guard_passes` (an EXIT condition
/// that must hold to LEAVE a phase), this never blocks a sub-issue on the exit guard
/// (e.g. `ready-for-test`) — that condition is shown separately under Goals/Handoff.
/// A sub-issue is actionable iff it carries a dev-work label and the `branch_guard`
/// passes; feature/tester/impl-plan issues are actionable unless blocked.
fn entry_ok(_phase: Phase, issue: u32) -> anyhow::Result<(bool, String)> {
    let issue_data = match get_issue(issue)? {
        Some(i) => i,
        None => return Ok((false, "issue not found".to_string())),
    };
    if issue_data.labels.iter().any(|l| l.name == "blocked") {
        return Ok((false, "issue is blocked — see the Status comment for the reason".to_string()));
    }
    if issue_data.labels.iter().any(|l| l.name == "ready-for-dev" || l.name == "in-progress-dev") {
        return branch_guard(issue);
    }
    Ok((true, "ok".to_string()))
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
    // Retry ordinal: how many times this event_name has fired for this issue before.
    let attempt = read_issue_events(issue)
        .iter()
        .filter(|e| e.event_name == event_name)
        .count() as u32
        + 1;

    let event = MetricEvent {
        ts: chrono::Utc::now().to_rfc3339(),
        event_id: uuid::Uuid::new_v4().to_string(),
        event_name: event_name.into(),
        actor: actor.into(),
        entity,
        phase: phase.into(),
        outcome: outcome.into(),
        attempt,
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
    section: Option<String>,
    base: Option<String>,
    worktree_path: Option<String>,
    image: Option<String>,
    feature: Option<String>,
    all: bool,
    json: bool,
    ghargs: Option<String>,
    gitargs: Option<String>,
    branch: Option<String>,
    commits: Option<u64>,
}

/// Working-conventions header prepended to every triage A2A file. The triage
/// planners write under their own sections and converse in `## Discussion`
/// instead of GitHub comments; the converged plan is written back via
/// `update-plan` and the SM posts the 'Triage converged' marker.
const TRIAGE_A2A_HEADER: &str = "\
<!-- A2A working file for the triage cluster. Ephemeral scratch (gitignored).
     Each planner writes under its own section and appends agent-tagged lines
     to ## Discussion. The converged result is assembled into the GitHub plan by
     the triage -> implementation transition, and the orchestrator posts the
     'Triage converged' marker. -->

";

/// Post any pending timeline-comment drafts in `.opencode/tmp/<issue>/` as GitHub
/// comments. Each draft file maps to a titled comment (the PO backlog, the triage
/// plan, the development summary, the tests runs, the SI summary). The file is
/// consumed (deleted) after posting so a draft is never posted twice. Runs as a
/// transition side-effect and via the `post-comments` action. **Best-effort:** a
/// failed comment post is logged, never fatal — a comment failure must not undo
/// an already-applied phase transition or issue close.
fn post_pending_comments(issue: u32, actor: &str, phase: &str) -> anyhow::Result<()> {
    const TIMELINE: &[(&str, &str)] = &[
        ("po-backlog.md", "PO Backlog"),
        ("triage-plan.md", "Triage Plan"),
        ("dev-summary.md", "Development Summary"),
        ("tests-runs.md", "Tests Runs"),
        ("si-summary.md", "SI Summary"),
    ];
    let dir = project_root()?.join(".opencode").join("tmp").join(issue.to_string());
    if !dir.is_dir() {
        return Ok(());
    }
    for (fname, title) in TIMELINE {
        let p = dir.join(fname);
        if !p.exists() {
            continue;
        }
        let body = match std::fs::read_to_string(&p) {
            Ok(b) => b,
            Err(e) => { println!("WARNING: could not read {} ({}) — skipping", fname, e); continue; }
        };
        // Anti-spoofing: a timeline draft must carry the template's `*Authored by
        // <Agent>*` footer, else it is never auto-posted as a bot comment.
        if !body.to_lowercase().contains("*authored by") {
            println!("WARNING: {} lacks an '*Authored by <Agent>*' footer — not posting (anti-spoofing)", fname);
            continue;
        }
        match post_one_timeline_comment(issue, actor, phase, &p, title, &body) {
            Ok(()) => {}
            Err(e) => println!("WARNING: could not post {} comment ({}): {}", title, fname, e),
        }
    }
    Ok(())
}

/// Post a single timeline-comment draft (writes `## <title>` + body, posts it,
/// consumes the file).
fn post_one_timeline_comment(issue: u32, actor: &str, phase: &str, p: &std::path::Path, title: &str, body: &str) -> anyhow::Result<()> {
    let tmp = project_root()?.join(".opencode").join("tmp").join(format!("timeline-{}.md", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(tmp.parent().unwrap())?;
    std::fs::write(&tmp, format!("## {}\n\n{}", title, body))?;
    run_gh(&["issue", "comment", &issue.to_string(), "--body-file", tmp.to_str().unwrap()])?;
    let _ = std::fs::remove_file(&tmp);
    let _ = std::fs::remove_file(p);
    println!("COMMENTED: {} on #{}", title, issue);
    append_event(issue, "comment", actor, phase, "success", &format!("posted {} comment", title))?;
    Ok(())
}

fn run_action(a: &ActionArgs) -> anyhow::Result<()> {
    // phase is computed lazily per-arm (only per-issue actions need it).
    let phase_of = |a: &ActionArgs| -> anyhow::Result<Phase> { current_phase(req_issue(a)?) };
    match a.action.as_str() {
        "create-issue" => {
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "unknown", "blocked", &format!("actor {} not allowed to {}", a.actor, a.action))?;
                println!("BLOCKED: actor {} not allowed to {}", a.actor, a.action);
                return Ok(());
            }
            let title = a.title.as_deref().ok_or_else(|| anyhow::anyhow!("create-issue requires --title"))?;
            let issue_type = a.issue_type.as_deref().ok_or_else(|| anyhow::anyhow!("create-issue requires --issue-type"))?;
            let label = load_config()?
                .issue_types
                .get(issue_type)
                .map(|t| t.label.clone())
                .ok_or_else(|| anyhow::anyhow!("invalid --issue-type: {}", issue_type))?;
            // Body source: an explicit --body-file, or (impl-plan only) the machine-
            // seeded triage template when none is given. The template carries an
            // `<issue>` placeholder that is patched with the real number post-create.
            let seeded = if a.body_file.is_none() && issue_type == "impl-plan" {
                Some(seed_triage_plan_body(title)?)
            } else {
                None
            };
            let body_path: String = match a.body_file.as_deref() {
                Some(f) => f.to_string(),
                None => match &seeded {
                    Some(body) => {
                        let tmp = project_root()?.join(".opencode").join("tmp").join(format!("impl-plan-seed-{}.md", uuid::Uuid::new_v4()));
                        std::fs::create_dir_all(tmp.parent().unwrap())?;
                        std::fs::write(&tmp, body)?;
                        tmp.to_str().unwrap().to_string()
                    }
                    None => anyhow::bail!("create-issue requires --body-file (impl-plan accepts the machine-seeded triage template)"),
                },
            };
            // Fold-in of po-intake: for backlog/bug intakes, validate required sections.
            if issue_type == "backlog" || issue_type == "bug" {
                let body = std::fs::read_to_string(&body_path)
                    .map_err(|e| anyhow::anyhow!("cannot read body {}: {}", body_path, e))?;
                let missing = intake_missing_sections(&body);
                if !missing.is_empty() {
                    anyhow::bail!("INTAKE INVALID: missing section(s): {}", missing.join(", "));
                }
            }
            let out = run_gh(&[
                "issue", "create", "--title", title, "--body-file", &body_path, "--label", &label,
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
                    // Record the start phase from the issue type's label so
                    // sub-issues (implementation) and tester issues (testing) get
                    // correct phase anchors instead of a blanket "intake".
                    let start_phase = load_config()?.label_to_phase.get(&label).cloned().unwrap_or_else(|| "intake".into());
                    append_event(n, "create-issue", &a.actor, &start_phase, "success", &format!("created {} {}", issue_type, out))?;
                    append_event(n, "phase.started", &a.actor, &start_phase, "success", &format!("started {}", start_phase))?;
                    // The template cannot know its own issue number at seed time;
                    // patch the `<issue>` placeholder with the real number now.
                    if let Some(body) = &seeded {
                        if body.contains("<issue>") || body.contains("{{issue}}") {
                            let patched = body
                                .replace("{{issue}}", &n.to_string())
                                .replace("<issue>", &n.to_string());
                            let tmp = project_root()?.join(".opencode").join("tmp").join(format!("impl-plan-issue-{}.md", uuid::Uuid::new_v4()));
                            std::fs::create_dir_all(tmp.parent().unwrap())?;
                            std::fs::write(&tmp, &patched)?;
                            run_gh(&["issue", "edit", &n.to_string(), "--body-file", tmp.to_str().unwrap()])?;
                            let _ = std::fs::remove_file(&tmp);
                        }
                    }
                    // The agent now has an issue number; print its context block so it
                    // can proceed without a second --issue invocation. This is how Intake
                    // bridges the "no issue at wake" gap at the machine level.
                    // Single-issue deterministic PO output: derive the `## PO Backlog`
                    // timeline-comment draft from the intake body (the PO never posts a
                    // comment directly), so the intake → triage transition auto-posts it.
                    if issue_type == "backlog" || issue_type == "bug" {
                        let intake = std::fs::read_to_string(&body_path).unwrap_or_default();
                        let dir = project_root()?.join(".opencode").join("tmp").join(n.to_string());
                        std::fs::create_dir_all(&dir)?;
                        let po = dir.join("po-backlog.md");
                        let po_body = format!("{}\n\n*Authored by Product Owner*", intake.trim());
                        std::fs::write(&po, po_body)?;
                        println!("PO BACKLOG DRAFTED: {}", po.display());
                    }
                    println!();
                    print_context(n, &a.actor, false)?;
                }
                None => {
                    println!("WARNING: could not parse new issue number from '{}'; create-issue metric event skipped", out);
                }
            }
            // The seeded body lives in a temp file; drop it after creation.
            if seeded.is_some() {
                let _ = std::fs::remove_file(&body_path);
            }
        }
        "comment" => {
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "unknown", "blocked", &format!("actor {} not allowed to {}", a.actor, a.action))?;
                println!("BLOCKED: actor {} not allowed to {}", a.actor, a.action);
                return Ok(());
            }
            let issue = req_issue(a)?;
            let phase = phase_of(a)?;
            let prefix = a.prefix.as_deref().ok_or_else(|| anyhow::anyhow!("comment requires --prefix"))?;
            if !["Decision", "Question", "Status", "Evidence"].contains(&prefix) {
                anyhow::bail!("invalid --prefix: {}", prefix);
            }
            // `Decision` and `Evidence` comments carry exit-guard markers (the triage
            // convergence marker, the audit verdict, the tester's testing verdict).
            // `Decision` is the orchestrator's alone (it feeds the triage/audit
            // gates); `Evidence` belongs to the tester + orchestrator. A sub-agent
            // can never forge a gate.
            let allowed = match prefix {
                "Decision" => a.actor == "self-improver",
                "Evidence" => matches!(a.actor.as_str(), "self-improver" | "tester"),
                _ => true,
            };
            if !allowed {
                append_event(issue, "comment", &a.actor, phase.as_str(), "blocked", &format!("actor {} not allowed to post a {} comment", a.actor, prefix))?;
                println!("BLOCKED: actor {} not allowed to post a {} comment", a.actor, prefix);
                return Ok(());
            }
            // The agent drafts its comment as `.opencode/tmp/<issue>/<prefix>.md`
            // (lowercased prefix) using the comment templates in
            // `docs/agentic-pipeline/templates/*-comment-template.md`. The state
            // machine reads that file and posts it — `--body-file` is optional and
            // overrides the conventional path.
            let body_file = match a.body_file.as_deref() {
                Some(f) => f.to_string(),
                None => {
                    let conventional = project_root()?
                        .join(".opencode").join("tmp").join(issue.to_string())
                        .join(format!("{}.md", prefix.to_lowercase()));
                    if conventional.exists() {
                        conventional.to_string_lossy().to_string()
                    } else {
                        anyhow::bail!("comment requires --body-file (or draft `.opencode/tmp/{}/{}.md` per the comment templates)", issue, prefix.to_lowercase());
                    }
                }
            };
            let body = std::fs::read_to_string(&body_file)?;
            // Content validation per prefix (fail fast with a clear message so a
            // malformed comment never reaches GitHub):
            //   Evidence — must carry a verdict; the testing gate + audit enforce the
            //     live-evidence requirement on top of this.
            if prefix == "Evidence" {
                let has_verdict = body.contains("PASS") || body.contains("FAIL") || body.contains("Verdict:");
                if !has_verdict {
                    anyhow::bail!("Evidence comment must carry a verdict (Verdict: **PASS** / **FAIL**) — see docs/agentic-pipeline/templates/Evidence-comment-template.md");
                }
            }
            let tmp = project_root()?.join(".opencode").join("tmp").join(format!("comment-{}.md", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(tmp.parent().unwrap())?;
            std::fs::write(&tmp, format!("## {}\n\n{}", prefix, body))?;
            run_gh(&["issue", "comment", &issue.to_string(), "--body-file", tmp.to_str().unwrap()])?;
            let _ = std::fs::remove_file(&tmp);
            println!("COMMENTED: {} on #{}", prefix, issue);
            append_event(issue, "comment", &a.actor, phase.as_str(), "success", &format!("posted {} comment from {}", prefix, body_file))?;
        }
        "post-comments" => {
            // Manually trigger the timeline-comment posting (agents can flush
            // pending drafts without a transition).
            let issue = req_issue(a)?;
            let phase = phase_of(a)?.as_str().to_string();
            post_pending_comments(issue, &a.actor, &phase)?;
        }
        "transition" => {
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "unknown", "blocked", &format!("actor {} not allowed to {}", a.actor, a.action))?;
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
            // `done` is reached only through `audit-record --verdict success` (which
            // closes the issue); a bare `transition` to `done` would relabel without
            // closing — refuse it.
            if to == Phase::Done {
                let msg = "transition to done is not allowed — use audit-record --verdict success to close as done".to_string();
                append_event(issue, "transition", &a.actor, phase.as_str(), "blocked", &msg)?;
                println!("BLOCKED: {}", msg);
                return Ok(());
            }
            let (ok, reason) = exit_guard_passes(phase, issue);
            if !ok {
                append_event(issue, "transition", &a.actor, phase.as_str(), "blocked", &reason)?;
                println!("BLOCKED: {}", reason);
                return Ok(());
            }
            // Testing → audit requires the FULL verification (verdict PASS + live
            // evidence per the plan's policy, fail-closed) — a FAIL verdict may
            // leave testing only to rework (testing → implementation).
            if phase == Phase::Testing && to == Phase::Audit {
                let (_, _, _, _, vok, vreason) = verification_status(issue);
                if !vok {
                    append_event(issue, "transition", &a.actor, phase.as_str(), "blocked", &vreason)?;
                    println!("BLOCKED: {}", vreason);
                    return Ok(());
                }
            }
            let to_label = phase_label(to);
            // Deterministic side-effects of entering each phase (idempotent). Run
            // before mutating labels so a failed side-effect leaves no half-state.
            let mut notes: Vec<String> = Vec::new();
            match to {
                Phase::Triage => {
                    // Auto-seed the A2A deliberation file (idempotent) so the triage
                    // cluster has a place to draft before the SI dispatches it.
                    // On an `audit → triage` restart, back up the stale converged
                    // file and re-seed fresh — the retry cluster must not inherit the
                    // previous round's converged drafts.
                    if phase == Phase::Audit {
                        let p = triage_a2a_path(issue)?;
                        if p.exists() {
                            let ts = chrono::Utc::now().format("%Y%m%d%H%M%S");
                            let backup = p.with_file_name(format!("triage.restart-{}.md", ts));
                            if std::fs::rename(&p, &backup).is_ok() {
                                notes.push(format!("A2A re-seeded (previous file backed up as `{}`)", backup.display()));
                            }
                        }
                    }
                    if let Some(n) = ensure_triage_a2a(issue, &a.actor)? { notes.push(n); }
                }
                Phase::Implementation => {
                    // Assemble the Implementation Plan from the converged A2A file
                    // and persist the QA-seeded test suites — both deterministic,
                    // both before the label swap. No sub-issues are generated: all
                    // work is tracked directly on the plan issue + the spec branch.
                    if assemble_impl_plan(issue, &a.actor)?.is_some() {
                        let a2a = std::fs::read_to_string(triage_a2a_path(issue)?).unwrap_or_default();
                        for feat in parse_feature_names(&a2a) {
                            if let Ok(n) = persist_tests(&feat) {
                                if n > 0 { notes.push(format!("tests for '{}' → main", feat)); }
                            }
                        }
                    }
                    if let Some(n) = ensure_spec_branch(issue)? { notes.push(n); }
                }
                Phase::Testing => { if let Some(n) = ensure_spec_pr(issue)? { notes.push(n); } }
                Phase::Audit => { if phase == Phase::Testing { if let Some(n) = ensure_spec_pr_merged(issue)? { notes.push(n); } } }
                _ => {}
            }
            swap_phase_label(issue, phase, to)?;
            println!("TRANSITIONED: {} -> {} (label: {})", phase.as_str(), to.as_str(), to_label);
            append_event(issue, "transition", &a.actor, to.as_str(), "success", &format!("transitioned {} -> {}", phase.as_str(), to.as_str()))?;
            // Phase lifecycle events feed the duration metrics (cycle/lead time).
            append_event_attrs(issue, "phase.completed", &a.actor, phase.as_str(), "success", &format!("completed {}", phase.as_str()), &[("phase", phase.as_str()), ("to", to.as_str())])?;
            append_event_attrs(issue, "phase.started", &a.actor, to.as_str(), "success", &format!("started {}", to.as_str()), &[("phase", to.as_str()), ("from", phase.as_str())])?;
            // Side-effect notes are printed (no auto Status comment is posted — the
            // feature issue is the single source of truth, agents comment explicitly).
            if !notes.is_empty() {
                println!("SIDE-EFFECTS: {}", notes.join("; "));
            }
            // Post any pending timeline-comment drafts (`.opencode/tmp/<issue>/*.md`):
            // PO Backlog, Triage Plan, Development Summary, Tests Runs, SI Summary.
            post_pending_comments(issue, &a.actor, to.as_str())?;
        }
        "block" => {
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "unknown", "blocked", &format!("actor {} not allowed to {}", a.actor, a.action))?;
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
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "unknown", "blocked", &format!("actor {} not allowed to {}", a.actor, a.action))?;
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
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "unknown", "blocked", &format!("actor {} not allowed to {}", a.actor, a.action))?;
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
                // A feature closes as done only from the Audit phase (exit guard
                // satisfied). Sub-issues were removed — the plan issue is closed
                // alongside the feature by `audit-record` only (it never holds a
                // phase label and is not closed via close-issue).
                if phase != Phase::Audit {
                    let msg = format!("issue is in {}, only audit-phase features can close as done", phase.as_str());
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
                // Guardrail (Spec #1499 false-PASS): the `done` close path must not
                // bypass the verification checks that audit-record enforces.
                let (_, _, _, _, verification_ok, vreason) = verification_status(issue);
                if !verification_ok {
                    let msg = format!("cannot close as done: {}", vreason);
                    append_event(issue, "close-issue", &a.actor, "audit", "blocked", &msg)?;
                    println!("BLOCKED: {}", msg);
                    return Ok(());
                }
            } else if phase == Phase::Done {
                // canceled: allowed from any phase except done.
                let msg = "issue is in done, cannot cancel a completed issue".to_string();
                append_event(issue, "close-issue", &a.actor, phase.as_str(), "blocked", &msg)?;
                println!("BLOCKED: {}", msg);
                return Ok(());
            }
            let reason = if to_str == "done" { "completed" } else { "not planned" };
            run_gh(&["issue", "close", &issue.to_string(), "--reason", reason])?;
            println!("CLOSED: #{} as {}", issue, to_str);
            // Log the event under the issue's actual phase (canceled is an outcome,
            // not a phase — it would pollute the per-phase aggregates otherwise).
            append_event_attrs(issue, "close-issue", &a.actor, phase.as_str(), "success", &format!("closed as {}", to_str), &[("closed_as", to_str)])?;
        }
        "create-worktree" => {
            // Creates a worktree **detached at the tip of the spec integration
            // branch** (no per-developer branch): git allows many detached
            // worktrees at the same commit, so parallel developers each get one.
            // The developer commits on the detached HEAD and pushes with
            // `git push origin HEAD:spec/<N>`.
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "unknown", "blocked", &format!("actor {} not allowed to {}", a.actor, a.action))?;
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
            append_event(issue, "create-worktree", &a.actor, phase_of(a)?.as_str(), "success", &format!("detached worktree {} at {}", path, base))?;
        }
        "remove-worktree" => {
            // Removes a worktree after the developer has pushed. Plain removal
            // refuses dirty worktrees — commit + push first.
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "unknown", "blocked", &format!("actor {} not allowed to {}", a.actor, a.action))?;
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
            append_event(issue, "remove-worktree", &a.actor, phase_of(a)?.as_str(), "success", &format!("removed worktree {}", path))?;
        }
        "generate-work" => {
            // Deprecated: sub-issues and the consolidated tester issue were removed
            // (PO decision), and the plan is a `## Triage Plan` comment on the
            // feature issue (single-issue model). All work is tracked directly on
            // the feature issue + the spec branch. This action is kept only to fail
            // with a clear message instead of a mystery.
            println!("GENERATE-WORK REMOVED: sub-issues + tester issue were dropped — work happens directly on the feature issue (`--issue <feature>`) and the spec branch; the tester posts `## Tests Runs` / `## Evidence` on the feature issue");
            append_event(req_issue(a).unwrap_or(0), "generate-work", &a.actor, "implementation", "blocked", "generate-work removed — no sub-issues; work tracked on the feature + spec branch")?;
        }
        "update-plan" => {
            // Single-issue model: the plan is the `## Triage Plan` timeline draft
            // `.opencode/tmp/<issue>/triage-plan.md` (auto-posted on the feature
            // issue). Replaces one whole `##` section of that draft with the new
            // content, writing it back to the draft (idempotent per section — the
            // machine reads it on the next `post-comments` flush / transition).
            // Gated to the self-improver.
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "unknown", "blocked", &format!("actor {} not allowed to {}", a.actor, a.action))?;
                println!("BLOCKED: actor {} not allowed to {}", a.actor, a.action);
                return Ok(());
            }
            let issue = req_issue(a)?;
            let phase = phase_of(a)?;
            let section_key = a.section.as_deref().ok_or_else(|| anyhow::anyhow!("update-plan requires --section <key>"))?;
            const PLAN_SECTIONS: &[&str] = &[
                "software-architect", "ui-ux", "qa", "summary", "staffing", "deployment", "risks",
            ];
            if !PLAN_SECTIONS.contains(&section_key) {
                anyhow::bail!("invalid --section: {} (expected one of {})", section_key, PLAN_SECTIONS.join(", "));
            }
            let draft = a.body_file.as_deref().ok_or_else(|| anyhow::anyhow!("update-plan requires --body-file <draft>"))?;
            let raw_text = std::fs::read_to_string(draft)
                .map_err(|e| anyhow::anyhow!("cannot read draft {}: {}", draft, e))?;
            // Strip a UTF-8 BOM so `- [ ]` checkboxes keep their line-anchored shape.
            let new_text = raw_text.strip_prefix('\u{feff}').unwrap_or(&raw_text).trim();
            let draft_path = project_root()?
                .join(".opencode").join("tmp").join(issue.to_string()).join("triage-plan.md");
            let body = std::fs::read_to_string(&draft_path)
                .map_err(|_| anyhow::anyhow!("triage-plan draft missing at {} — run the triage → implementation transition first", draft_path.display()))?;
            // Strip a UTF-8 BOM so heading matching isn't broken on the first line.
            let body = body.strip_prefix('\u{feff}').unwrap_or(&body);
            let new_body = replace_section(body, section_key, new_text)?;
            std::fs::write(&draft_path, &new_body)?;
            println!("PLAN UPDATED: {} section '{}' replaced", draft_path.display(), section_key);
            append_event(issue, "update-plan", &a.actor, phase.as_str(), "success", &format!("replaced section '{}' of triage-plan draft", section_key))?;
        }
        "triage-init" => {
            // Creates the ephemeral A2A working file for the triage cluster at
            // `.opencode/tmp/<issue>/triage.md` (gitignored scratch) by seeding
            // the triage-plan template with the issue number/title. The triage
            // planners write under their own sections and converse in `##
            // Discussion` instead of GitHub comments; the converged result is
            // assembled into the plan by the `triage → implementation` transition.
            // Also an auto side-effect of `intake → triage`. Gated to self-improver.
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "unknown", "blocked", &format!("actor {} not allowed to {}", a.actor, a.action))?;
                println!("BLOCKED: actor {} not allowed to {}", a.actor, a.action);
                return Ok(());
            }
            let issue = req_issue(a)?;
            ensure_triage_a2a(issue, &a.actor)?;
        }
        "tests-commit" => {
            // Persists the durable, reusable per-feature test suite
            // `.opencode/tests/<feature>/` to `main` (NOT a spec branch — tests
            // are per-feature-domain and accumulate across specs, so they ride
            // main as the regression asset; unique paths keep concurrent specs
            // conflict-free). Also an auto side-effect of `triage → implementation`
            // (feature names come from the QA Expert's `**Feature tests:**` line).
            // Gated to self-improver and tester.
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "unknown", "blocked", &format!("actor {} not allowed to {}", a.actor, a.action))?;
                println!("BLOCKED: actor {} not allowed to {}", a.actor, a.action);
                return Ok(());
            }
            let issue = req_issue(a)?;
            let feature = a.feature.as_deref()
                .map(str::trim)
                .filter(|f| !f.is_empty() && f.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'))
                .ok_or_else(|| anyhow::anyhow!("tests-commit: --feature <name> required (lowercase-kebab, ascii) — resolves .opencode/tests/<feature>/"))?;
            let dir = project_root()?.join(".opencode").join("tests").join(feature);
            if !dir.is_dir() {
                anyhow::bail!("tests-commit: no test suite at {} (create .opencode/tests/<feature>/*.md first)", dir.display());
            }
            let phase = phase_of(a)?;
            let count = persist_tests(feature)?;
            if count == 0 {
                anyhow::bail!("tests-commit: no .md files in {} ", dir.display());
            }
            append_event(issue, "tests-commit", &a.actor, phase.as_str(), "success", &format!("feature '{}' ({} file(s)) -> main", feature, count))?;
        }
        "prune" => {
            // Local hygiene after merges: remove stale feat/ branches and orphaned
            // worktrees. Idempotent; skips `main`/`master` and any non-feat branch.
            // spec/ integration branches are never pruned (they carry the evidence).
            // Local-only (no GitHub/state writes); gated to the orchestrator.
            if a.actor != "self-improver" {
                println!("BLOCKED: actor {} not allowed to prune", a.actor);
                return Ok(());
            }
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
            // Fold-in of pipeline-audit.rs. The SI's judgment must never rest on a
            // tampered record — always run the integrity gate as part of the bundle.
            let issue = req_issue(a)?;
            let problems = check_log_integrity()?;
            if problems.is_empty() {
                println!("Record integrity: OK");
            } else {
                println!("Record integrity: TAMPER DETECTED ({})", problems.len());
                for p in &problems { println!("  {}", p); }
            }
            audit_evidence(issue, a.json)?;
        }
        "audit-record" => {
            // SI verdict: posts the Decision comment AND records the metric event —
            // one write path, one event, no separate `comment` step.
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "unknown", "blocked", &format!("actor {} not allowed to {}", a.actor, a.action))?;
                println!("BLOCKED: actor {} not allowed to {}", a.actor, a.action);
                return Ok(());
            }
            let issue = req_issue(a)?;
            let verdict = a.verdict.as_deref().ok_or_else(|| anyhow::anyhow!("audit-record requires --verdict success|restart"))?;
            // Guardrail (Spec #1499 false-PASS): `--verdict success` fails CLOSED
            // unless the tester evidence substantiates a PASS under the plan's
            // verification policy. A static-only PASS, a FAIL, or no Evidence
            // comment cannot close a feature as done — the SI must restart instead.
            if verdict == "success" {
                let (_, _, _, _, verification_ok, reason) = verification_status(req_issue(a)?);
                if !verification_ok {
                    let msg = format!("cannot record success: {}", reason);
                    append_event(req_issue(a)?, "audit-record", &a.actor, "audit", "blocked", &msg)?;
                    println!("BLOCKED: {}", msg);
                    return Ok(());
                }
            }
            // `phase` is derived from --phase for the Decision comment / event message.
            let phase = a.to_phase.as_deref().unwrap_or("audit");
            let reason = a.reason.as_deref().unwrap_or("");
            // Validate the restart target before any write: only the four real restart
            // phases are legal. `done` is rejected explicitly (audit:done is a close,
            // not a restart) — otherwise `--verdict restart --phase done` would leave
            // the issue open in `done` with no close.
            let restart_to = if verdict == "restart" {
                let to = Phase::from_str(phase)
                    .ok_or_else(|| anyhow::anyhow!("audit-record restart requires --phase <intake|triage|implementation|testing>"))?;
                if to == Phase::Done {
                    anyhow::bail!("illegal restart phase: done");
                }
                if !is_legal_transition(Phase::Audit, to) {
                    anyhow::bail!("illegal restart phase: {}", phase);
                }
                Some(to)
            } else {
                None
            };
            // The Decision comment implies a label swap (+ close on success) — refuse
            // to post it unless the issue is actually in the audit phase, so a failed
            // label swap can never leave a posted verdict behind (no half-state).
            let current = phase_of(a)?;
            if current != Phase::Audit {
                let msg = format!("audit-record requires the issue to be in the audit phase (current: {})", current.as_str());
                append_event(issue, "audit-record", &a.actor, current.as_str(), "blocked", &msg)?;
                println!("BLOCKED: {}", msg);
                return Ok(());
            }
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
            append_event_attrs(issue, "audit.verdict", "self-improver", phase,
                if verdict == "success" { "passed" } else { "failed" },
                reason, &[("verdict", verdict), ("phase", phase)])?;
            // The verdict IS the decision — drive the next phase automatically.
            if verdict == "success" {
                swap_phase_label(issue, Phase::Audit, Phase::Done)?;
                run_gh(&["issue", "close", &issue.to_string(), "--reason", "completed"])?;
                append_event(issue, "transition", "self-improver", "done", "success", "audit -> done (auto)")?;
                append_event_attrs(issue, "phase.completed", "self-improver", "audit", "success", "completed audit", &[("phase", "audit"), ("to", "done")])?;
                append_event_attrs(issue, "phase.started", "self-improver", "done", "success", "started done", &[("phase", "done"), ("from", "audit")])?;
                // Auto final-metrics summary (the mechanical half of the closing report).
                let _ = post_final_summary(issue);
                println!("AUDIT -> DONE (auto): #{} closed as done", issue);
            } else if let Some(to) = restart_to {
                // A restart supersedes the round's testing — the stale Evidence
                // verdict lives as a comment on the feature issue; the tester
                // re-posts a fresh verdict. On a restart → triage, re-seed the A2A
                // file (the retry cluster must NOT inherit the prior round's
                // converged drafts) — mirrors the transition's triage side-effect.
                if to == Phase::Triage {
                    let p = triage_a2a_path(issue)?;
                    if p.exists() {
                        let ts = chrono::Utc::now().format("%Y%m%d%H%M%S");
                        let backup = p.with_file_name(format!("triage.restart-{}.md", ts));
                        if std::fs::rename(&p, &backup).is_ok() {
                            println!("A2A re-seeded (previous file backed up as `{}`)", backup.display());
                        }
                    }
                    if let Some(n) = ensure_triage_a2a(issue, &a.actor)? {
                        println!("{}", n);
                    }
                }
                swap_phase_label(issue, Phase::Audit, to)?;
                append_event(issue, "transition", "self-improver", to.as_str(), "success", &format!("audit -> {} (auto restart)", to.as_str()))?;
                append_event_attrs(issue, "phase.completed", "self-improver", "audit", "success", "completed audit", &[("phase", "audit"), ("to", to.as_str())])?;
                append_event_attrs(issue, "phase.started", "self-improver", to.as_str(), "success", &format!("started {}", to.as_str()), &[("phase", to.as_str()), ("from", "audit")])?;
                println!("AUDIT -> {} (auto restart)", to.as_str());
            }
            println!("AUDIT RECORDED: {} on #{}", verdict, issue);
            // Post any pending timeline-comment drafts (SI Summary, Tests Runs, ...).
            post_pending_comments(issue, &a.actor, "audit")?;
        }
        "upload-evidence" => {
            // Posts an Evidence comment for a test case, committing the screenshot
            // to the spec's integration branch `spec/<parent>` (so the image renders
            // inline for repo members even on a private repo) and embedding the raw
            // URL. Gated to the tester (and self-improver).
            if !actor_allowed(a.action.as_str(), &a.actor) {
                append_event(req_issue(a).unwrap_or(0), a.action.as_str(), &a.actor, "unknown", "blocked", &format!("actor {} not allowed to {}", a.actor, a.action))?;
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
                    let plan = parent_spec(issue).map_err(|_|
                        anyhow::anyhow!("cannot resolve parent plan for #{}; pass --base <spec-branch>", issue))?;
                    // The tester issue references the PLAN; the evidence lands on
                    // `spec/<feature>` — map plan → feature.
                    let feature = plan_feature(plan).unwrap_or(plan);
                    format!("spec/{}", feature)
                }
            };
            let ref_exists = gh_api_raw_opt(&[format!("repos/{}/git/ref/heads/{}", repo, branch)])?;
            if ref_exists.is_none() {
                anyhow::bail!("spec branch {} does not exist on origin — transition the spec to implementation to auto-create it", branch);
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
            append_event(issue, "upload-evidence", &a.actor, "testing", "success", &format!("posted Evidence with {} for {}", image, issue))?;
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
        "create-issue" => matches!(actor, "product-owner" | "self-improver"),
        "comment" => actor != "product-owner",
        "transition" => actor == "self-improver",
        "block" | "unblock" => matches!(actor, "self-improver" | "developer"),
        "close-issue" => actor == "self-improver",
        "create-worktree" => actor == "developer",
        "remove-worktree" => actor == "developer",
        "update-plan" => actor == "self-improver",
        "triage-init" => actor == "self-improver",
        "tests-commit" => matches!(actor, "tester" | "self-improver"),
        "audit-record" => actor == "self-improver",
        "upload-evidence" => matches!(actor, "tester" | "self-improver"),
        "post-comments" => matches!(actor, "self-improver" | "tester"),
        "audit" | "prune" | "metrics" | "health" | "verify" | "context" => true,
        _ => true,
    }
}

// ── Context block ────────────────────────────────────────────────────────────

/// Read-only operational snapshot for the orchestrator (self-improver) context
/// block: the linked plan, work items, A2A file, spec branch, and open blockers.
/// Best-effort — every field falls back to a safe default if the underlying
/// read fails, so the context block always renders.
fn orchestration_snapshot(issue: u32) -> serde_json::Value {
    let plan = find_impl_plan(issue);
    // Spec-branch work indicator: commits on the spec branch not on main (0 =
    // the developer has not pushed; >0 = implementation progress). Fails open to 0.
    let spec_ahead = (|| {
        let branch = format!("spec/{}", issue);
        run_cmd("git", &["fetch", "origin", "main"]).ok()?;
        run_cmd("git", &["fetch", "origin", &branch]).ok()?;
        let out = run_cmd("git", &["rev-list", "--count", "origin/main..FETCH_HEAD"]).ok()?;
        Some(out.trim().parse::<u64>().unwrap_or(0))
    })().unwrap_or(0);
    // Whether the tester has posted an Evidence comment (single-issue model: the
    // evidence lands on the feature issue; the legacy plan issue is a fallback).
    let evidence_on_plan = get_issue_comments(issue)
        .into_iter()
        .chain(plan.map(|p| get_issue_comments(p)).unwrap_or_default())
        .any(|b| { let t = b.trim_start(); t.starts_with("## Evidence") || t.starts_with("## Tests Runs") });
    let a2a = triage_a2a_path(issue)
        .ok()
        .filter(|p| p.exists())
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "none".into());
    let spec_present = run_gh(&["pr", "list", "--head", &format!("spec/{}", issue), "--json", "number"])
        .ok()
        .and_then(|out| serde_json::from_str::<serde_json::Value>(&out).ok())
        .and_then(|v| v.as_array().map(|a| !a.is_empty()))
        .unwrap_or(false);
    let blockers = run_gh(&["issue", "list", "--state", "open", "--label", "blocked", "--json", "number"])
        .ok()
        .and_then(|out| serde_json::from_str::<serde_json::Value>(&out).ok())
        .and_then(|v| v.as_array().map(|a| a.len()))
        .unwrap_or(0);
    serde_json::json!({
        "impl_plan": "feature-issue-comment".to_string(),
        "spec_branch_ahead": spec_ahead,
        "evidence_on_plan": evidence_on_plan,
        "a2a_file": a2a,
        "spec_branch": if spec_present { format!("spec/{}", issue) } else { "absent".to_string() },
        "open_blocked_issues": blockers,
    })
}

fn print_context(issue: u32, actor: &str, raw: bool) -> anyhow::Result<()> {
    let phase = current_phase(issue)?;
    let (ok, reason) = entry_ok(phase, issue)?;
    let validation = if ok { "passed".to_string() } else { format!("BLOCKED: {}", reason) };
    let goals = phase_exit_guard(phase);
    let owner = phase_owner(phase);
    let prev = previous_phase(phase);
    // Retry state: derived from the event log (failed audit verdicts). Agents on a
    // retry round are completing missed ACs, not re-doing the whole feature — they
    // must not repost prior content. `round` is 1 on first pass; the `last_failure`
    // reason is the audit's recorded cause of the restart.
    let (attempt, retry_reason) = retry_state(issue);
    let on_retry = attempt > 1;
    // The orchestrator (self-improver) gets an operational snapshot — the linked
    // artifacts it steers — so it does not re-discover the pipeline state each wake.
    let orch = if actor == "self-improver" {
        Some(orchestration_snapshot(issue))
    } else {
        None
    };

    let phase_idx = Phase::ORDER.iter().position(|p| *p == phase).unwrap_or(0);
    let next_idx = (phase_idx + 1).min(Phase::ORDER.len() - 1);
    let next_phase = Phase::ORDER[next_idx];

    if raw {
        let mut block = serde_json::json!({
            "phase": phase.as_str(),
            "feature": format!("#{}", issue),
            "phase_owner": owner,
            "dispatched_agent": actor,
            "triggering_event": format!("dispatched to {} for phase {}", actor, phase.as_str()),
            "previous_phase": if prev == phase { "start" } else { prev.as_str() },
            "attempt": attempt,
            "on_retry": on_retry,
            "retry_reason": retry_reason,
            "goals": goals,
            "playbook": playbook_path(actor),
            "responsibilities": format!("The {} agent performs the work of the {} phase per its playbook", actor, phase.as_str()),
            "handoff": format!("Next phase: {} — what must exist: {}", next_phase.as_str(), goals),
            "validation": validation,
            "doc_references": "pipeline.md, github.md, staffing.md, state-machine.md",
        });
        if let Some(o) = &orch {
            block["orchestration"] = o.clone();
        }
        println!("{}", serde_json::to_string_pretty(&block)?);
    } else {
        println!("=== PIPELINE STATE ===");
        println!("{:<16} {}", "Phase:", phase.as_str());
        println!("{:<16} #{}", "Feature:", issue);
        println!("{:<16} {}", "Phase owner:", owner);
        println!("{:<16} {}", "Triggering event:", format!("dispatched to {} for phase {}", actor, phase.as_str()));
        println!("{:<16} {}", "Previous phase:", if prev == phase { "start" } else { prev.as_str() });
        println!("{:<16} {}", "Attempt:", if on_retry { format!("round {} (RETRY — completing missed ACs)", attempt) } else { "round 1".into() });
        if on_retry {
            println!("{:<16} {}", "Retry reason:", if retry_reason.is_empty() { "(recorded reason unavailable)".into() } else { retry_reason.clone() });
        }
        println!("{:<16} {}", "Goals:", goals);
        println!("{:<16} {}", "Playbook:", playbook_path(actor));
        println!("{:<16} {}", "Responsibilities:", format!("The {} agent performs the {} phase per its playbook", actor, phase.as_str()));
        println!("{:<16} {}", "Handoff:", format!("Next: {} — requires: {}", next_phase.as_str(), goals));
        println!("{:<16} {}", "Validation:", validation);
        println!("{:<16} {}", "Doc references:", "pipeline.md, github.md, staffing.md, state-machine.md");
        if let Some(o) = &orch {
            println!("{:<16} {}", "Impl plan:", o["impl_plan"].as_str().unwrap_or("none"));
            println!("{:<16} {}", "Spec branch ahead:", o["spec_branch_ahead"]);
            println!("{:<16} {}", "Evidence on plan:", o["evidence_on_plan"]);
            println!("{:<16} {}", "A2A file:", o["a2a_file"].as_str().unwrap_or("none"));
            println!("{:<16} {}", "Spec branch:", o["spec_branch"].as_str().unwrap_or("absent"));
            println!("{:<16} {}", "Open blocked:", o["open_blocked_issues"]);
        }
        println!("====================");
    }

    // Schema outcome enum is success|failure|blocked|unknown — map the entry
    // actionability result to that vocabulary (the human-readable Validation text above stays).
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

/// Match a `## Heading` on its own line, allowing a continuation suffix where the
/// next char after the heading is one of: space, `/`, `&`, `[`, `(`. This covers
/// template variants like `## Out of scope / constraints`, `## Priority & value`,
/// and the PO template's `[REQUIRED ...]` annotations (e.g. `## Success metrics
/// [REQUIRED]`, `## Acceptance criteria  [REQUIRED — 3-5...]`). Avoids substring
/// false-positives like a body mention of a heading inside prose.
fn has_section(body: &str, heading: &str) -> bool {
    let heading_norm = normalize_section_key(heading);
    body.lines().any(|l| {
        let t = l.trim();
        if !t.starts_with('#') { return false; }
        let name = t.trim_start_matches('#').trim();
        !name.is_empty() && normalize_section_key(name).starts_with(&heading_norm)
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

/// Retry state derived from the append-only event log — never from agent self-report.
///
/// An issue is on a retry round when the audit gate has recorded one or more failed
/// verdicts (an `audit.verdict` event with outcome `failed`). `round` is 1 for the
/// first pass and increments by one per failed verdict (so a restart after one failed
/// audit is round 2). `last_failure` is the reason recorded with the most recent
/// failed verdict — the missed-AC context the restarted agents must complete.
fn retry_state(issue: u32) -> (u32, String) {
    let failed: Vec<(String, String)> = read_issue_events(issue)
        .into_iter()
        .filter(|e| e.event_name == "audit.verdict" && e.outcome == "failed")
        .map(|e| (e.message.clone(), e.ts))
        .collect();
    let round = failed.len() as u32 + 1;
    // Most recent failed verdict = the one with the latest timestamp.
    let last_failure = failed
        .iter()
        .max_by_key(|(_, ts)| ts.clone())
        .map(|(msg, _)| msg.clone())
        .unwrap_or_default();
    (round, last_failure)
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

// ── Fold-in: pipeline-audit (evidence bundle) ─────────────────────────────────

fn audit_evidence(issue: u32, json: bool) -> anyhow::Result<()> {
    let events = read_issue_events(issue);
    let mut phase_counts: BTreeMap<String, usize> = BTreeMap::new();
    for e in &events {
        *phase_counts.entry(e.phase.clone()).or_insert(0) += 1;
    }
    let rework = events.iter().filter(|e| is_rework(e)).count();
    let blocked = events.iter().filter(|e| e.outcome == "blocked" || e.event_name == "block").count();
    let evidence_count = events.iter()
        .filter(|e| (e.event_name == "comment" && e.message.contains("Evidence")) || e.event_name == "upload-evidence")
        .count();
    let plan = find_impl_plan(issue);
    // Guardrail (Spec #1499 false-PASS): `has_record` must mean "a real ## Evidence
    // comment exists" (not the SI's own verdict comment containing the words
    // Evidence/Verdict), and the verification signals come from the shared helper.
    let (evidence_on_plan, verdict_pass, plan_policy, live_evidence, verification_ok, _reason) = verification_status(issue);
    let has_record = evidence_on_plan;
    // Linked-artifact status: the leader's verdict must see what it actually
    // steered — the merged spec PR. (Sub-issues were removed; the spec branch +
    // the plan's Evidence are the work record.)
    let spec_merged = run_gh(&["pr", "list", "--head", &format!("spec/{}", issue), "--state", "merged", "--json", "number"])
        .ok()
        .and_then(|out| serde_json::from_str::<serde_json::Value>(&out).ok())
        .and_then(|v| v.as_array().map(|a| !a.is_empty()))
        .unwrap_or(false);
    if json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "issue": issue, "events": events.len(), "phase_counts": phase_counts,
            "rework_loops": rework, "blocked_count": blocked,
            "tester_evidence_events": evidence_count,
            "evidence_on_plan": evidence_on_plan,
            "verdict_is_pass": verdict_pass,
            "has_gh_record": has_record,
            "verification_policy": plan_policy,
            "live_telemetry_evidence": live_evidence,
            "verification_ok": verification_ok,
            "spec_pr_merged": spec_merged,
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
    println!("Evidence on plan #{}: {}", plan.map(|p| p.to_string()).unwrap_or_else(|| "none".into()), evidence_on_plan);
    println!("Verdict is PASS: {}", verdict_pass);
    println!("GitHub record has Evidence comment: {}", has_record);
    println!("Verification policy (plan): {}", plan_policy);
    println!("Live telemetry evidence (telemetry_spans refs): {}", live_evidence);
    println!("Verification OK (evidence PASS + policy-live has telemetry): {}", verification_ok);
    println!("Spec PR merged: {}", spec_merged);
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
    let rework = all.iter().filter(|e| is_rework(e)).count();
    let audit_pass = all.iter().filter(|e| e.event_name == "audit.verdict" && e.outcome == "passed").count();
    let audit_fail = all.iter().filter(|e| e.event_name == "audit.verdict" && e.outcome == "failed").count();
    let mut by_agent: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_phase: BTreeMap<String, usize> = BTreeMap::new();
    for e in &all {
        *by_agent.entry(e.actor.clone()).or_insert(0) += 1;
        *by_phase.entry(e.phase.clone()).or_insert(0) += 1;
    }
    // SLA escalation: issues blocked past the default 4h SLA with no later unblock.
    const BLOCK_SLA_MINS: i64 = 240;
    let now = chrono::Utc::now().timestamp();
    let mut last_block: BTreeMap<String, i64> = BTreeMap::new();
    let mut last_unblock: BTreeMap<String, i64> = BTreeMap::new();
    for e in &all {
        let ts = chrono::DateTime::parse_from_rfc3339(&e.ts).map(|t| t.timestamp()).unwrap_or(0);
        let id = e.entity.as_ref().and_then(|x| x.issue_id.clone()).unwrap_or_default();
        match e.event_name.as_str() {
            "block" => { last_block.insert(id, ts); }
            "unblock" => { last_unblock.insert(id, ts); }
            _ => {}
        }
    }
    let mut overdue: Vec<(String, i64)> = Vec::new();
    for (id, ts) in &last_block {
        if let Some(un) = last_unblock.get(id) {
            if un > ts { continue; }
        }
        let mins = (now - ts) / 60;
        if mins > BLOCK_SLA_MINS {
            overdue.push((id.clone(), mins));
        }
    }
    overdue.sort_by(|a, b| b.1.cmp(&a.1));
    // Little's Law consistency check: derive the average cycle time (implementation
    // start → done) from the event log so the check actually fires when telemetry
    // is broken (instead of a hardcoded pass).
    let first = all.iter().filter_map(|e| chrono::DateTime::parse_from_rfc3339(&e.ts).ok().map(|t| t.timestamp())).min().unwrap_or(0);
    let last = all.iter().filter_map(|e| chrono::DateTime::parse_from_rfc3339(&e.ts).ok().map(|t| t.timestamp())).max().unwrap_or(0);
    let span_hrs = ((last - first) as f64 / 3600.0).max(1.0);
    let throughput = issues.len() as f64 / span_hrs;
    let mut cycle_hrs: Vec<f64> = Vec::new();
    for issue_id in &issues {
        let evs: Vec<&ReadEvent> = all.iter().filter(|e| {
            e.entity.as_ref().and_then(|ent| ent.issue_id.as_ref()).map(|id| id == issue_id).unwrap_or(false)
        }).collect();
        let impl_start = evs.iter()
            .filter(|e| e.event_name == "phase.started" && e.phase == "implementation")
            .filter_map(|e| chrono::DateTime::parse_from_rfc3339(&e.ts).ok().map(|t| t.timestamp()))
            .min();
        let done = evs.iter()
            .filter(|e| (e.event_name == "phase.started" && e.phase == "done") || (e.event_name == "phase.completed" && e.phase == "audit"))
            .filter_map(|e| chrono::DateTime::parse_from_rfc3339(&e.ts).ok().map(|t| t.timestamp()))
            .min();
        if let (Some(s), Some(d)) = (impl_start, done) {
            if d > s { cycle_hrs.push((d - s) as f64 / 3600.0); }
        }
    }
    let avg_cycle_hrs = if cycle_hrs.is_empty() { None } else { Some(cycle_hrs.iter().sum::<f64>() / cycle_hrs.len() as f64) };
    let (wip_from_law, little_ok, cycle_note) = match avg_cycle_hrs {
        Some(avg) => {
            let w = throughput * avg;
            let ok = (w - issues.len() as f64).abs() / (issues.len().max(1) as f64) < 2.0;
            (w, ok, format!("{:.1}h avg cycle ({} completed)", avg, cycle_hrs.len()))
        }
        None => (0.0, true, "insufficient completed data — no false alarm".into()),
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "issues": issues.len(), "events": all.len(), "blocked": blocked,
            "rework_total": rework, "audit_pass": audit_pass, "audit_fail": audit_fail,
            "throughput_per_hr": throughput, "little_law": { "wip": issues.len(), "computed_wip": wip_from_law, "consistent": little_ok, "avg_cycle_hrs": avg_cycle_hrs, "cycle_note": cycle_note },
            "by_agent": by_agent, "by_phase": by_phase,
            "overdue_blockers": overdue,
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
    println!("Little's Law: WIP={} computed={:.1} {} ({})", issues.len(), wip_from_law, if little_ok { "CONSISTENT" } else { "CHECK REQUIRED" }, cycle_note);
    println!("Record integrity: {}", if integrity.is_empty() { "OK" } else { "TAMPER DETECTED" });
    for p in &integrity { println!("  {}", p); }
    println!("Calls by agent:");
    for (k, v) in &by_agent { println!("  {} : {}", k, v); }
    println!("Calls by phase:");
    for (k, v) in &by_phase { println!("  {} : {}", k, v); }
    if overdue.is_empty() {
        println!("SLA-overdue blockers (>{}m): none", BLOCK_SLA_MINS);
    } else {
        println!("SLA-overdue blockers (>{}m):", BLOCK_SLA_MINS);
        for (id, mins) in &overdue { println!("  #{} blocked for {}m", id, mins); }
    }
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
        section: val("--section"),
        base: val("--base"),
        worktree_path: val("--worktree-path"),
        image: val("--image"),
        feature: val("--feature"),
        all: args.iter().any(|a| a == "--all"),
        json: args.iter().any(|a| a == "--json"),
        ghargs: val("--ghargs"),
        gitargs: val("--gitargs"),
        branch: val("--branch"),
        commits: val("--commits").and_then(|s| s.parse().ok()),
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
        // Mock-repo passthroughs: the validation harness drives the mock store
        // with gh-shaped args (`--ghargs "issue view 5 --json state"`) and
        // git-shaped args (`--gitargs "ls-tree ..."`), so its assertions hit the
        // same local store the machine writes to. `mock-commit` simulates a
        // developer push by bumping a spec branch's ahead-count.
        "mock-gh" => {
            let raw = a.ghargs.as_deref().unwrap_or("");
            let parts: Vec<&str> = raw.split_whitespace().collect();
            match mock_gh(&parts) {
                Ok(s) => { println!("{}", s); Ok(()) }
                Err(e) => Err(e),
            }
        }
        "mock-git" => {
            let raw = a.gitargs.as_deref().unwrap_or("");
            let parts: Vec<&str> = raw.split_whitespace().collect();
            match mock_git(&parts) {
                Ok(s) => { if !s.is_empty() { println!("{}", s); } Ok(()) }
                Err(e) => Err(e),
            }
        }
        "mock-commit" => {
            match a.branch.as_deref() {
                Some(branch) => {
                    let count = a.commits.unwrap_or(1);
                    match mock_set_commits_ahead(branch, count) {
                        Ok(()) => {
                            println!("MOCK COMMIT: {} -> {} commits ahead", branch, count);
                            Ok(())
                        }
                        Err(e) => Err(e),
                    }
                }
                None => Err(anyhow::anyhow!("mock-commit requires --branch")),
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



