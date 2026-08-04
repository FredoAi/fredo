# Developer Playbook

> How this agent works in the agentic pipeline. Companion to `.opencode/agents/developer.md` (identity) — this is the operational how-to.

## Purpose
Implement a dev sub-issue end-to-end: branch, build, verify, PR, report.

## When dispatched
Dispatched by the Scrum Master with a dev sub-issue; max 2 active per developer.

## Inputs
Sub-issue (parent Implementation Plan, acceptance criteria, effort, scope).

## Workflow
0. **Start** — load the `pipeline-state` skill, run `pipeline-state.rs --issue <N> --agent developer`, and read the context block (phase, goals, validation, handoff) before touching the sub-issue.
1. Branch `feat/<issue-number>-short-desc` off the spec integration branch (the `create-branch` action auto-resolves the base from the sub-issue's `Parent: Implementation Plan #N`) → implement in scope → verify (build/check/tests) → open PR **against the spec integration branch** with checklist → `Status` comment **using the [Verification Comment template](04-artifacts.md#verification-comment-developer)**: files changed, build PASSED/FAILED, tests passed/failed, acceptance criteria X/Y met, scope notes. The bare status is not enough — the verification results are what the Scrum Master reviews against. **All GitHub writes go through the state machine**: request the `create-branch` action for the branch, the `comment` action for `Status`/`Question`, and the `merge-pr` action is the Scrum Master's call. Retry: re-enter branch, fetch + rebase, fix exactly what was requested, push to the same branch, request `Status: PR #N updated` via the `comment` action. When blocked on another sub-issue: request the `block` action (label `blocked`) and report to the Scrum Master — never stall silently. Once all sub-issues are merged into `spec/<N>`, open the **spec PR** (`spec/<N>` → `main`) — it stays open during testing.

## Artifacts produced
- Feature PR (05-github.md#pr-checklist)
- Verification comment (04-artifacts.md#verification-comment-developer)

## GitHub conventions
- Branch: `feat/<issue-number>-short-desc` branched from `spec/<N>` (created via state machine `create-branch`; base auto-resolved)
- PR base: the spec integration branch `spec/<N>`
- Comments: `Status` on the sub-issue; `Question` if the sub-issue is ambiguous (never improvise scope) — both via the state machine `comment` action

## Verification (definition of done)
Run build/check/tests and report exact output; PR checklist completed, every acceptance criterion met or explicitly reported as blocked. When a check fails, stop and report — never modify tests or build configuration to make it pass.

## References
- docs/agentic-pipeline/03-pipeline.md#phase-3-implementation
- docs/agentic-pipeline/04-artifacts.md#dev-sub-issue
- docs/agentic-pipeline/05-github.md#pr-checklist
- docs/agentic-pipeline/06-staffing.md#max-parallel-tasks-per-developer
- references.md
