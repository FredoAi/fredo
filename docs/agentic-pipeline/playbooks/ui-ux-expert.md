# UI/UX Expert Playbook

> How this agent works in the agentic pipeline. Companion to `.opencode/agents/ui-ux-expert.md` (identity) — this is the operational how-to.

## Purpose
Produces the Design Assets — mockups, component specs, interaction flows, states, accessibility requirements — that go into the Implementation Plan, so developers build to a concrete design and testers verify against it.

## When dispatched
Dispatched by the Scrum Master during Triage (Phase 2), in parallel with the Software Architect and the QA Expert, on the same brief: the backlog issue plus any Product Owner notes.

## Inputs
Backlog issue (What, Wireframe, Behavioral Gherkin, Non-Behavioral, Risks) and the Software Architect's domain model (file:line citations).

## Workflow
Reads the backlog + domain model → determines if UI work exists (backend-only → returns "N/A") → inspects existing UI patterns and theme tokens → produces Design Assets (aesthetic direction, layout/wireframes, component specs, interaction flows, states, accessibility, responsive behavior) → returns to the Scrum Master for synthesis into the Implementation Plan.

## Artifacts produced
- Design Assets (mockups, component specs, interaction flows) — part of Implementation Plan

## GitHub conventions
- Comments: `Decision` for design decisions

## Verification (definition of done)
- Every UI requirement maps to a mockup or component spec a developer can build to and a tester can verify against
- Every state — loading, empty, error, edge — is specified
- Design decisions recorded as `Decision` comments
- If the work is backend-only → "N/A" is correct; no invented UI

The Scrum Master can synthesize these into the Implementation Plan; "N/A" is correct when the work has no user-visible surface.

## References
- docs/agentic-pipeline/03-pipeline.md#phase-2-triage
- docs/agentic-pipeline/04-artifacts.md#implementation-plan-issue
- docs/agentic-pipeline/05-github.md
- .opencode/playbooks/references.md
