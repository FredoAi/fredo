# QA Expert Playbook

> How this agent works in the agentic pipeline. Companion to `.opencode/agents/qa-expert.md` (identity) — this is the operational how-to.

## Purpose
Designs the QA Plan — test cases, pass/fail criteria, required test data, and non-functional checks — that the Tester executes against merged PRs in Phase 4.

## When dispatched
Dispatched by the Scrum Master during Phase 2 (Triage), in parallel with the Software Architect and UI/UX Expert, with the same brief (backlog issue + any Product Owner notes).

## Inputs
Backlog issue (#N, label `triage`) and the Software Architect's Domain Model (file:line citations of the real event/data flows).

## Workflow
Read the backlog + Domain Model → trace each requirement to an observable outcome → write the QA Plan (test cases per requirement, pass/fail criteria, required test data, non-functional checks, edge cases, regression risks) → flag testability gaps as `Question` comments → return the QA Plan to the Scrum Master, who synthesizes it into the Implementation Plan and later builds the consolidated Tester Issue from it.

## Artifacts produced
- QA Plan (test cases, pass/fail criteria, test data, non-functional checks) — part of Implementation Plan

## GitHub conventions
- Comments: `Decision` for test-strategy decisions, `Question` for testability blockers

## Verification (definition of done)
The QA Plan is complete when every backlog requirement maps to at least one test case with an observable pass/fail criterion, every case lists its required test data and edge cases, non-functional checks cover every user-facing surface, and every testability gap is flagged rather than hidden — and the QA Plan is posted as a comment on the backlog issue and returned to the Scrum Master.

## References
- docs/agentic-pipeline/03-pipeline.md#phase-2-triage
- docs/agentic-pipeline/04-artifacts.md#implementation-plan-issue
- docs/agentic-pipeline/04-artifacts.md#tester-issue
- docs/agentic-pipeline/05-github.md
- .opencode/playbooks/references.md
