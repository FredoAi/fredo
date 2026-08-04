---
name: pipeline-state
description: Loader for the pipeline state machine. Run this skill FIRST whenever you are dispatched. It tells you how to invoke the single state machine script (pipeline-state.rs) — read the context block (your phase, goals, playbook, handoff), request GitHub actions, read metrics, audit an issue, or get a health report. Load at agent start — before doing any work.
---

# Pipeline State — Loader

This is a **thin loader**. It does NOT contain the phase model, transitions, guards, goals, or metrics — all of that lives in the script (`.opencode/scripts/pipeline-state.rs`), which is the single source of truth per `docs/agentic-pipeline/07-state-machine.md`.

> **One script owns the pipeline.** `pipeline-state.rs` is a `rust-script` (Rust, cross-platform). It is the state machine AND the metrics/audit/health engine — all deterministic pipeline operations live here. Run it via `rust-script`; it compiles on first use, then is cached.

## What to do at wake (always)

Run the state machine to get your context block:

```
rust-script .opencode/scripts/pipeline-state.rs --issue <N> --agent <your-name>
```

Read the context block: **Phase**, **Goals**, **Playbook** (read it before working), **Validation** (`passed` or `BLOCKED: <reason>`), **Handoff**. If `BLOCKED`, report it — do not attempt the phase.

## Actions

### GitHub writes (the state machine is the single writer)

| You need to... | Run |
|----------------|-----|
| Create an issue | `rust-script .opencode/scripts/pipeline-state.rs --action create-issue --title "<t>" --body-file <path> --issue-type <type>` (`backlog`/`impl-plan`/`sub-issue`/`tester-issue`; backlog/bug drafts are validated against the PO template first) |
| Post a comment | `rust-script .opencode/scripts/pipeline-state.rs --issue <N> --agent <you> --action comment --prefix <Decision\|Question\|Status\|Evidence> --body-file <path>` |
| Transition to next phase | `rust-script .opencode/scripts/pipeline-state.rs --issue <N> --agent <you> --action transition [--to-phase <phase>]` (`--to-phase` optional — inferred when the current phase has exactly one legal exit; required for `testing`/`audit`). **Auto side-effects:** entering `implementation` creates `spec/<N>`; entering `testing` opens the spec PR; `testing → audit` merges it |
| Create a worktree | `rust-script .opencode/scripts/pipeline-state.rs --issue <N> --action create-worktree [--worktree-path <path>]` (defaults to `.worktrees/<N>`; checks the worktree out **detached** at the tip of the spec integration branch `spec/<N>`, auto-resolved from the sub-issue's `Parent: Implementation Plan #N`; guards: sub-issue is `ready-for-dev`/`in-progress-dev`; parallel developers each get their own detached worktree) |
| Remove a worktree | `rust-script .opencode/scripts/pipeline-state.rs --issue <N> --action remove-worktree [--worktree-path <path>]` (defaults to `.worktrees/<N>`; refuses dirty worktrees) |
| Upload test evidence | `rust-script .opencode/scripts/pipeline-state.rs --issue <N> --action upload-evidence --body-file <path> --image <screenshot> [--base <branch>]` (tester/scrum-master; commits the screenshot to `.opencode/evidence/<N>/` on `spec/<parent>` and posts an `Evidence` comment with the raw URL — renders inline for repo members) |
| Prune stale local branches/worktrees | `rust-script .opencode/scripts/pipeline-state.rs --action prune` (removes local `feat/` branches already merged to `main` or any `spec/*` branch, prunes orphaned worktrees; idempotent — safe to run after merges; never touches `spec/*`) |
| Block / unblock | `rust-script .opencode/scripts/pipeline-state.rs --issue <N> --agent <you> --action block --reason "<why>"` / `--action unblock` |
| Close as done/canceled | `rust-script .opencode/scripts/pipeline-state.rs --issue <N> --agent <you> --action close-issue --to-phase done` |

### Reads & derived reports

| You need to... | Run |
|----------------|-----|
| Issue metrics (lifecycle) | `rust-script .opencode/scripts/pipeline-state.rs --action metrics --issue <N>` |
| Pipeline aggregate metrics | `rust-script .opencode/scripts/pipeline-state.rs --action metrics --all` |
| Audit evidence bundle (SI) | `rust-script .opencode/scripts/pipeline-state.rs --action audit --issue <N>` |
| Record an audit verdict | `rust-script .opencode/scripts/pipeline-state.rs --action audit-record --issue <N> --verdict success\|restart [--phase <p>] [--reason "<why>"]` — **posts the `Decision` comment, records the metric event, AND drives the next phase**: `success` auto-transitions `audit → done` + closes as done; `restart` auto-transitions `audit → <p>` |
| Pipeline health report | `rust-script .opencode/scripts/pipeline-state.rs --action health` |
| Verify record integrity (anti-tamper gate) | `rust-script .opencode/scripts/pipeline-state.rs --action verify` |

Append `--json` to any read for machine-readable output.

> **`verify` is the anti-tamper gate (principle 6 gate 3).** It scans the event log and error log for unparseable lines, out-of-order timestamps, and duplicate event IDs. `INTEGRITY: OK` means the record is append-only and unmodified. Any flag exits non-zero (code 3) — the record is the evidence the Self-Improver judges on and must never be rewritten or backdated. Run it before trusting a health or audit report.

## Reading the result

- `TRANSITIONED:` / `COMMENTED:` / `CREATED:` / `CLOSED:` — the write succeeded.
- `BLOCKED: <reason>` — a guard failed; do NOT retry or work around it, report the blocker.
- `INTAKE INVALID: missing section(s): ...` — a draft failed PO-template validation; fix it before creating.
- Errors are auto-logged to `.opencode/state/script-errors.jsonl`.

## What you may NOT do

- Do NOT call `gh issue create/edit/close` or `git push` to `main`/`master` to write — the state machine is the single writer. **Exception:** the developer pushes `HEAD:spec/<N>` only.
- Do NOT improvise a phase or label name — `pipeline.json` owns the model.
- Do NOT treat this skill as the source of truth for phases/transitions — that is `07-state-machine.md`, `.opencode/pipeline.json`, and the script.

## References

- docs/agentic-pipeline/07-state-machine.md (phases, action API, metrics)
- docs/agentic-pipeline/01-principles.md (rule 2 single-writer, rule 9 scripts-via-skills)
- .opencode/pipeline.json (config)
