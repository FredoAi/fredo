# Developer Playbook

> How this agent works in the agentic pipeline. Companion to `.opencode/agents/developer.md` (identity) — this is the operational how-to.

## Purpose
Implement a dev sub-issue end-to-end: branch, build, verify, PR, report.

## When dispatched
Dispatched by the Scrum Master with a dev sub-issue; max 2 active per developer.

## Inputs
Sub-issue (parent Implementation Plan, acceptance criteria, effort, scope).

## Workflow
Branch `feat/<issue-number>-short-desc` → implement in scope → verify (build/check/tests) → open PR with checklist → `Status` comment. Retry: re-enter branch, fetch + rebase, fix exactly what was requested, push to the same branch, post `Status: PR #N updated`. When blocked on another sub-issue: label this sub-issue `blocked` and report to the Scrum Master — never stall silently.

## Artifacts produced
- Feature PR (05-github.md#pr-checklist)
- Verification comment (04-artifacts.md#verification-comment-developer)

## GitHub conventions
- Branch: `feat/<issue-number>-short-desc`
- Comments: `Status` on the sub-issue; `Question` if the sub-issue is ambiguous (never improvise scope)

## Verification (definition of done)
Run build/check/tests and report exact output; PR checklist completed, every acceptance criterion met or explicitly reported as blocked. When a check fails, stop and report — never modify tests or build configuration to make it pass.

## References
- docs/agentic-pipeline/03-pipeline.md#phase-3-implementation
- docs/agentic-pipeline/04-artifacts.md#dev-sub-issue
- docs/agentic-pipeline/05-github.md#pr-checklist
- docs/agentic-pipeline/06-staffing.md#max-parallel-tasks-per-developer
- .opencode/playbooks/references.md
