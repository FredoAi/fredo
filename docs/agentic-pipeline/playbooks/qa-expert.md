# QA Expert Playbook

> How this agent works in the agentic pipeline. Companion to `.opencode/agents/qa-expert.md` (identity) â€” this is the operational how-to.

## Purpose
Designs the QA Plan â€” test cases, pass/fail criteria, required test data, and non-functional checks â€” that the Tester executes against the spec integration branch in Phase 4.

## When dispatched
Dispatched by the Scrum Master during Phase 2 (Triage), in parallel with the Software Architect and UI/UX Expert, with the same brief (backlog issue + any Product Owner notes).

## Inputs
Backlog issue (#N, label `triage`) and the Software Architect's Domain Model (file:line citations of the real event/data flows).

## Workflow
0. **Start** â€” load the `pipeline-state` skill, run `pipeline-state.rs --issue <N> --agent qa-expert`, and read the context block (phase, goals, validation, handoff) before designing the QA Plan.
1. Read the backlog issue and the Domain Model from the triage brief. Trace each requirement to the observable behavior that proves it â€” prefer the real event/data paths the Domain Model cites over assumed payload shapes.
2. Write the QA Plan:
   - Test cases per requirement: a table mapping each REQ to test cases, expected outcomes, and edge cases.
   - Pass/fail criteria: observable, per case, executable by a diligent-but-literal tester.
   - Required test data: fixtures, mock event injection commands, environment setup.
   - Non-functional checks: performance, accessibility, theme, and loading/empty/error states.
   - Edge cases and regression risks: what could break, and which existing behavior must not change.
3. Flag testability gaps: if a requirement cannot be verified by an observable outcome, state the gap explicitly and request a `Question` comment via the state machine's `comment` action â€” do not paper over it.
4. Post the QA Plan as a `Decision` comment on the backlog issue and return it to the Scrum Master, who synthesizes it into the Implementation Plan and later builds the consolidated Tester Issue from it.
5. When the tester reports an ambiguous case, revise the affected cases and return the clarification.

## Artifacts produced
- QA Plan (test cases, pass/fail criteria, test data, non-functional checks) â€” part of Implementation Plan

## GitHub conventions
- Comments: `Decision` for test-strategy decisions, `Question` for testability blockers

## Verification (definition of done)
The QA Plan is complete when every backlog requirement maps to at least one test case with an observable pass/fail criterion, every case lists its required test data and edge cases, non-functional checks cover every user-facing surface, and every testability gap is flagged rather than hidden â€” and the QA Plan is posted as a comment on the backlog issue and returned to the Scrum Master.

## References
- docs/agentic-pipeline/03-pipeline.md#phase-2-triage
- docs/agentic-pipeline/04-artifacts.md#implementation-plan-issue
- docs/agentic-pipeline/04-artifacts.md#tester-issue
- docs/agentic-pipeline/05-github.md
- references.md
