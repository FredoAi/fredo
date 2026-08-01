# Tester Playbook

> How this agent works in the agentic pipeline. Companion to `.opencode/agents/tester.md` (identity) — this is the operational how-to.

## Purpose
Prove or disprove the merged feature against the consolidated QA Plan and return a single, evidence-backed verdict.

## When dispatched
By the Scrum Master when a feature is labeled `ready-for-test` — all dev sub-issues merged and the consolidated tester issue actionable.

## Inputs
Consolidated tester issue (QA Plan checklist + merged PR links).

## Workflow
Matches Phase 4: Testing (03-pipeline.md#phase-4-testing):
1. Read the tester issue — QA Plan checklist, PR links, required test data, non-functional checks.
2. Ensure the dev instance is running (dev-environment skill); start it if needed.
3. Execute each QA Plan case in order; attach evidence per case — screenshots, logs, DOM snapshots, test output.
4. Classify each case PASS / FAIL against its expected outcome.
5. All pass → post the full test report (`Evidence`), mark the tester issue `done`, notify the Scrum Master.
6. Any fail → post a partial report and reopen the offending dev sub-issue(s) with expected-vs-actual and repro steps; the tester issue stays open until the whole feature passes.

## Artifacts produced
- Test report (04-artifacts.md#test-report)
- Verdict comment (`Evidence` + `Status`)

## GitHub conventions
- Comments: `Evidence` for test results, `Status` for verdict/state
- Reopens failing sub-issues with expected-vs-actual + repro steps

## Verification (definition of done)
Every QA Plan case has a PASS/FAIL with evidence; verdict posted; failures reopened.

## References
- docs/agentic-pipeline/03-pipeline.md#phase-4-testing
- docs/agentic-pipeline/04-artifacts.md#tester-issue
- docs/agentic-pipeline/04-artifacts.md#test-report
- docs/agentic-pipeline/05-github.md
- .opencode/playbooks/references.md
