# Developer Playbook

> How this agent works in the agentic pipeline. Companion to `.opencode/agents/developer.md` (identity) — this is the operational how-to.

## Purpose
Implement a dev sub-issue end-to-end in a worktree on the spec integration branch: worktree, build, verify, push to the spec branch, report.

## When dispatched
Dispatched by the Scrum Master with a dev sub-issue; max 2 active per developer.

## Inputs
Sub-issue (parent Implementation Plan, acceptance criteria, effort, scope).

## Workflow
0. **Start** — load the `pipeline-state` skill, run `pipeline-state.rs --issue <N> --agent developer`, and read the context block (phase, goals, validation, handoff) before touching the sub-issue.
1. **Create a worktree on the spec integration branch** — request the `create-worktree` action (`--worktree-path <path>`); it checks the worktree out on `spec/<parent>` (auto-resolved from the sub-issue's `Parent: Implementation Plan #N`). Only one worktree can sit on `spec/<N>` at a time, so request `remove-worktree` for the previous one first if the state machine reports the branch is in use.
2. Implement in scope → verify (build/check/tests).
3. **Commit and push directly to `spec/<N>`** (your one allowed direct write) → `Status` comment **using the [Verification Comment template](04-artifacts.md#verification-comment-developer)**: files changed, build PASSED/FAILED, tests passed/failed, acceptance criteria X/Y met, scope notes. The bare status is not enough — the verification results are what the Scrum Master reviews against.
4. **Remove the worktree** — request the `remove-worktree` action once done, freeing `spec/<N>` for the next sub-issue.
5. Retry: re-enter the worktree, pull the latest `spec/<N>`, fix exactly what was requested, commit + push, request `Status: <sub-issue> updated` via the `comment` action. When blocked on another sub-issue: request the `block` action (label `blocked`) and report to the Scrum Master — never stall silently.

**All GitHub writes go through the state machine except pushing to `spec/<N>`**: request `create-worktree`/`remove-worktree` for worktrees, `comment` for `Status`/`Question`, and `block` for blockers. The spec PR (`spec/<N>` → `main`) and all merges are the Scrum Master's call — never open or merge PRs yourself.

## Artifacts produced
- Verified changes pushed to `spec/<N>` (05-github.md#branch-naming)
- Verification comment (04-artifacts.md#verification-comment-developer)

## GitHub conventions
- Worktree on the spec integration branch `spec/<N>` (via state machine `create-worktree`)
- Direct push: `git push` to `spec/<N>` only — never `main`/`master`
- Comments: `Status` on the sub-issue; `Question` if the sub-issue is ambiguous (never improvise scope) — both via the state machine `comment` action

## Verification (definition of done)
Run build/check/tests and report exact output; every acceptance criterion met or explicitly reported as blocked; changes pushed to `spec/<N>`; worktree removed. When a check fails, stop and report — never modify tests or build configuration to make it pass.

## References
- docs/agentic-pipeline/03-pipeline.md#phase-3-implementation
- docs/agentic-pipeline/04-artifacts.md#dev-sub-issue
- docs/agentic-pipeline/05-github.md#pr-checklist
- docs/agentic-pipeline/06-staffing.md#max-parallel-tasks-per-developer
- references.md
