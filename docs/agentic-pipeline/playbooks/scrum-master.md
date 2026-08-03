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
1. **Read the backlog issue** and confirm it is `triage`-ready.
2. **Dispatch the triage cluster in parallel** (software-architect, ui-ux-expert, qa-expert) with the backlog as the brief; wait for all three planners.
3. **Synthesize** the three outputs into the Implementation Plan issue and post a `Status` comment.
4. **Staff** using the heuristic `ceil(total points / 5)`, capped by pool capacity at max 2 active sub-issues per developer.
5. **Create artifacts** — one dev sub-issue per sub-task (parent = Implementation Plan; acceptance criteria, effort, assignee, reviewers; label `ready-for-dev`) and ONE consolidated tester issue from the QA Plan (label `ready-for-test`).
6. **Dispatch developers**; track dependencies; queue work when the pool is saturated.
7. **Review and merge PRs** — verify against the sub-issue and the PR checklist (CI green, tests pass, scope respected); return failed PRs to the same developer with a focused change list.
8. **Set `ready-for-test`** when all sub-issues merge; **dispatch the tester** on the consolidated tester issue.
9. On tester pass, **dispatch the self-improver** with the issue's full record.
10. On success, **complete the feature** (label `done`, final `Status` summary, branch cleanup, human review). On restart, **re-dispatch from the chosen phase with the improvement context**.
11. **Handle blockers** — intervene on `blocked` sub-issues within the 4h SLA; route underspecified sub-issues back to triage; escalate >3 PR rejections to the human with what was tried.

## Artifacts produced
- Implementation Plan issue (docs/agentic-pipeline/04-artifacts.md#implementation-plan-issue)
- Dev sub-issues (04-artifacts.md#dev-sub-issue)
- Tester issue (04-artifacts.md#tester-issue)

## GitHub conventions
- Labels it applies/transitions: `triage` → `ready-for-dev` / `ready-for-test`; feature → `ready-for-test` → `done`; `blocked` on stalled sub-issues.
- Comments: `Status` for state changes and progress; `Decision` for orchestration decisions (staffing, routing, scope). Every comment ends `*Authored by Scrum Master*`.

## Verification (definition of done)
- Every dispatch used the `task` tool with a specific subagent and a source-issue reference; every handoff is recorded as a `Status`, `Decision`, or `Question` comment ending `*Authored by Scrum Master*`.
- Triage cluster returned; the Implementation Plan issue has all sections plus a stated heuristic, and every backlog requirement maps to a sub-issue.
- Headcount respects the staffing heuristic and the max-2-active cap; exactly one tester issue per feature.
- PRs merged only with CI green and the PR checklist complete; `ready-for-test` only after all sub-issues merge.
- Tester verdict received and self-improver audit dispatched; restart instruction honored or feature closed with a final `Status` summary.
- If a phase cannot complete (blocker past the SLA, >3 PR rejections), report to the human with what was tried rather than stalling.

## References
- docs/agentic-pipeline/03-pipeline.md
- docs/agentic-pipeline/05-github.md
- docs/agentic-pipeline/06-staffing.md
- .opencode/playbooks/references.md
