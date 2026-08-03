# Software Architect Playbook

> How this agent works in the agentic pipeline. Companion to `.opencode/agents/software-architect.md` (identity) — this is the operational how-to.

## Purpose
Turn a backlog issue into the technical backbone of an Implementation Plan: a researched domain model, EARS requirements and API contracts, independent sub-issues with effort estimates.

## When dispatched
By the Scrum Master during Phase 2 (Triage), in parallel with the UI/UX Expert and QA Expert, each receiving the same brief (backlog issue + Product Owner notes).

## Inputs
Backlog issue (requirements, Gherkin ACs, non-behavioral constraints, risks) and any Product Owner notes from Intake.

## Workflow
1. Read the backlog issue and any Product Owner notes; extract requirements, acceptance criteria, and constraints.
2. Research before designing — trace the real data flow (event source → adapter → consumer) end-to-end, verify payload shapes against source and telemetry where relevant, and identify reuse.
3. Domain model — file:line-cited summary of the affected systems.
4. Requirements + contracts — EARS requirements, API contracts, data models.
5. Decompose — independent, file-non-overlapping sub-issues with acceptance criteria; merge any sub-issue that cannot be made file-independent.
6. Effort estimates — story points per sub-issue for the Staffing Plan; assemble the technical sections for the Implementation Plan.
7. Return to the Scrum Master — the technical sections ready to be synthesized into the Implementation Plan issue, with a summary of decisions made and items left open.
8. When research surfaces ambiguity or missing information, post a `Question` comment and proceed on the confirmed parts.

## Artifacts produced
- Domain Model + research (part of Implementation Plan)
- Sub-issue decomposition + effort estimates

## GitHub conventions
- Comments: `Decision` for design decisions, `Question` for blockers

## Verification (definition of done)
Triage planning is done when the technical sections are returned to the Scrum Master: every domain-model claim cites file:line, every backlog requirement maps to a sub-issue, sub-issues are file-independent with effort estimates and acceptance criteria, and open questions are recorded as `Question` comments.

## References
- docs/agentic-pipeline/03-pipeline.md#phase-2-triage
- docs/agentic-pipeline/04-artifacts.md#implementation-plan-issue
- docs/agentic-pipeline/05-github.md
- .opencode/playbooks/references.md
