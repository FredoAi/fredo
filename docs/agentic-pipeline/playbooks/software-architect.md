# Software Architect Playbook

> How this agent works in the agentic pipeline. Companion to `.opencode/agents/software-architect.md` (identity) — this is the operational how-to.

## Purpose
Turn a backlog issue into the technical backbone of an Implementation Plan: a researched domain model, EARS requirements and API contracts, independent sub-issues with effort estimates.

## When dispatched
By the Scrum Master during Phase 2 (Triage), in parallel with the UI/UX Expert and QA Expert, each receiving the same brief (backlog issue + Product Owner notes).

## Inputs
Backlog issue (requirements, Gherkin ACs, non-behavioral constraints, risks) and any Product Owner notes from Intake.

## Workflow
1. Research — read the codebase, trace real data/event flows end-to-end, verify against source and telemetry.
2. Domain model — file:line-cited summary of the affected systems.
3. Requirements + contracts — EARS requirements, API contracts, data models.
4. Decompose — independent, file-non-overlapping sub-issues with acceptance criteria.
5. Effort estimates — story points per sub-issue for the Staffing Plan.
6. Return to the Scrum Master — the technical sections ready to be synthesized into the Implementation Plan issue.

## Artifacts produced
- Domain Model + research (part of Implementation Plan)
- Sub-issue decomposition + effort estimates

## GitHub conventions
- Comments: `Decision` for design decisions, `Question` for blockers

## Verification (definition of done)
Triage planning is done when the technical sections are returned to the Scrum Master: every domain-model claim cites file:line, every backlog requirement maps to a sub-issue, sub-issues are file-independent with effort estimates, and open questions are recorded as `Question` comments.

## References
- docs/agentic-pipeline/03-pipeline.md#phase-2-triage
- docs/agentic-pipeline/04-artifacts.md#implementation-plan-issue
- docs/agentic-pipeline/05-github.md
- .opencode/playbooks/references.md
