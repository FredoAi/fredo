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
| Transition to next phase | `rust-script .opencode/scripts/pipeline-state.rs --issue <N> --agent <you> --action transition --to-phase <phase>` |
| Create a feature branch | `rust-script .opencode/scripts/pipeline-state.rs --issue <N> --action create-branch [--base <main>]` (guards: sub-issue is `ready-for-dev`/`in-progress-dev`) |
| Create a worktree | `rust-script .opencode/scripts/pipeline-state.rs --issue <N> --action create-worktree --worktree-path <path> [--base <main>]` |
| Merge a PR | `rust-script .opencode/scripts/pipeline-state.rs --issue <N> --action merge-pr --pr <PR#> ` (guards: PR open, CI green; deletes the merged branch) |
| Block / unblock | `rust-script .opencode/scripts/pipeline-state.rs --issue <N> --agent <you> --action block --reason "<why>"` / `--action unblock` |
| Close as done/canceled | `rust-script .opencode/scripts/pipeline-state.rs --issue <N> --agent <you> --action close-issue --to-phase done` |

### Reads & derived reports

| You need to... | Run |
|----------------|-----|
| Issue metrics (lifecycle) | `rust-script .opencode/scripts/pipeline-state.rs --action metrics --issue <N>` |
| Pipeline aggregate metrics | `rust-script .opencode/scripts/pipeline-state.rs --action metrics --all` |
| Audit evidence bundle (SI) | `rust-script .opencode/scripts/pipeline-state.rs --action audit --issue <N>` |
| Record an audit verdict | `rust-script .opencode/scripts/pipeline-state.rs --action audit-record --issue <N> --verdict success\|restart [--phase <p> \| --to-phase <p> --reason "<why>"]` — **posts the `Decision` comment AND records the metric event in one write** |
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

- Do NOT call `gh issue create/edit/close` or `git push` directly to write — the state machine is the single writer.
- Do NOT improvise a phase or label name — `pipeline.json` owns the model.
- Do NOT treat this skill as the source of truth for phases/transitions — that is `07-state-machine.md`, `.opencode/pipeline.json`, and the script.

## References

- docs/agentic-pipeline/07-state-machine.md (phases, action API, metrics)
- docs/agentic-pipeline/01-principles.md (rule 2 single-writer, rule 9 scripts-via-skills)
- .opencode/pipeline.json (config)
