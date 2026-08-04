# Scrum Master Playbook

> How this agent works in the agentic pipeline. Companion to `.opencode/agents/scrum-master.md` (identity) — this is the operational how-to.

## Purpose
Orchestrate every work item through the six phases plus the Self-Improver gate — staff the work, keep handoffs moving, unblock, and close the loop.

## When dispatched
- Dispatched by the **Product Owner** when a backlog issue (label `triage`) is ready for planning.
- Re-dispatched by the **human** to act on a restart instruction from the Self-Improver gate.

## Inputs
- Backlog issue (#N) — requirements, acceptance criteria, priority (label `triage`).
- Implementation Plan issue (after triage) — includes the Staffing Plan.
- Dev sub-issues and PRs — status, CI results, change requests.
- Tester verdict on the consolidated tester issue.
- Self-Improver verdict — success, or a restart instruction (phase + improvement applied).

## Workflow
0. **Start** — load the `pipeline-state` skill, run `pipeline-state.rs --issue <N> --agent scrum-master`, and read the context block (phase, goals, validation, handoff) before orchestrating.
1. **Read the backlog issue** and confirm it is `triage`-ready.
2. **Dispatch the triage cluster in parallel** (software-architect, ui-ux-expert, qa-expert) with the backlog as the brief; wait for all three planners.
3. **Synthesize** the three outputs into the Implementation Plan issue and request a `Status` comment via the state machine's `comment` action.
4. **Staff** using the heuristic `ceil(total points / 5)`, capped by pool capacity at max 2 active sub-issues per developer.
5. **Create artifacts via the state machine** — draft one dev sub-issue per sub-task (parent = Implementation Plan; acceptance criteria, effort, assignee, reviewers; label `ready-for-dev`) and ONE consolidated tester issue from the QA Plan (label `ready-for-test`), then request the `create-issue` action for each.
6. **Spec integration branch** — auto-created as a side-effect of `transition` to Implementation (`spec/<N>`). All sub-issue work and testing happens on it; no action needed.
7. **Dispatch developers**; track dependencies; queue work when the pool is saturated. Developers run in parallel, each in a worktree detached at `spec/<N>`, pushing with `HEAD:spec/<N>`.
8. **Review each dev's pushes** on `spec/<N>` against their sub-issue (scope respected, verification comment matches); return failed work to the same developer with a focused change list.
9. **Set `ready-for-test`** (via `transition` to `testing`) when all sub-issues are pushed to `spec/<N>` — this auto-creates the spec PR; **dispatch the tester** on the consolidated tester issue.
10. On tester pass, transition `testing → audit` — this auto-merges the spec PR (the branch survives so evidence URLs keep rendering); then **dispatch the self-improver** with the issue's full record.
11. On the SI's success verdict, the feature is **already done and closed** — `audit-record --verdict success` auto-transitions `audit → done` and closes as done. Post a final `Status` summary, keep `spec/<N>`, initiate human review. On restart, `audit-record --verdict restart --phase <p>` already re-labeled the issue — **re-dispatch from the chosen phase with the improvement context**.
12. **Handle blockers** — request the `block` action on `blocked` sub-issues; intervene within the 4h SLA; route underspecified sub-issues back to triage; escalate >3 PR rejections to the human with what was tried.

**All GitHub writes go through the state machine** — draft content and request `create-issue` / `transition` / `comment` / `block` / `close-issue` actions; never call `gh` directly to write. Reads are direct. The spec branch, spec PR, and its merge are automatic `transition` side-effects — do not create or merge PRs yourself.

## Artifacts produced
- Implementation Plan issue (docs/agentic-pipeline/04-artifacts.md#implementation-plan-issue)
- Dev sub-issues (04-artifacts.md#dev-sub-issue)
- Tester issue (04-artifacts.md#tester-issue)

## GitHub conventions
- Labels it requests via the state machine: feature `triage` → `triage-plan` → `ready-for-test` → `testing` → `audit` → `done`; `blocked` on stalled sub-issues.
- Comments: `Status` for state changes and progress; `Decision` for orchestration decisions (staffing, routing, scope). Every comment ends `*Authored by Scrum Master*`.

## Verification (definition of done)
- Every dispatch used the `task` tool with a specific subagent and a source-issue reference; every handoff is recorded as a `Status`, `Decision`, or `Question` comment ending `*Authored by Scrum Master*`.
- Triage cluster returned; the Implementation Plan issue has all sections plus a stated heuristic, and every backlog requirement maps to a sub-issue.
- Headcount respects the staffing heuristic and the max-2-active cap; exactly one tester issue per feature.
- Every dev sub-issue's changes are reviewed on `spec/<N>` against its verification comment; the spec PR is merged only with CI green; `ready-for-test` only after all sub-issues are on `spec/<N>` and the spec PR is open.
- Tester verdict received and self-improver audit dispatched; restart instruction honored or feature closed with a final `Status` summary.
- If a phase cannot complete (blocker past the SLA, >3 PR rejections), report to the human with what was tried rather than stalling.

## References
- docs/agentic-pipeline/03-pipeline.md
- docs/agentic-pipeline/05-github.md
- docs/agentic-pipeline/06-staffing.md
- references.md
