# Tester Playbook

> How this agent works in the agentic pipeline. Companion to `.opencode/agents/tester.md` (identity) — this is the operational how-to.

## Purpose
Prove or disprove the feature on the spec integration branch against the consolidated QA Plan and return a single, evidence-backed verdict.

## When dispatched
By the Scrum Master when a feature is labeled `ready-for-test` — all dev sub-issues merged into the spec integration branch (`spec/<N>`) and the spec PR open.

## Inputs
Consolidated tester issue (QA Plan checklist + the spec branch to test: `spec/<N>`).

## Workflow
Matches Phase 4: Testing (03-pipeline.md#phase-4-testing):
0. **Start** — load the `pipeline-state` skill, run `pipeline-state.rs --issue <N> --agent tester`, and read the context block (phase, goals, validation, handoff) before executing the QA Plan.
1. Read the tester issue — QA Plan checklist, spec branch to test, required test data, non-functional checks.
2. Ensure the dev instance is running **on the spec integration branch** (`spec/<N>`) (dev-environment skill); start it if needed and confirm reachability.
3. Execute each QA Plan case in order; attach evidence per case — screenshots, logs, DOM snapshots, test output. For each user-observable AC, post an `Evidence` comment with at least one screenshot via the state machine's `upload-evidence` action (`--image <screenshot>`) — it commits the screenshot to `.opencode/evidence/<tester-issue>/` on `spec/<N>` and embeds the raw URL, which renders inline for repo members.
4. Classify each case PASS / FAIL against its expected outcome.
5. All pass → request the state machine's `comment` action with the full test report (`Evidence`), then notify the Scrum Master — the Scrum Master transitions the feature to `audit` (auto-merging the spec PR); the Self-Improver's `audit-record --verdict success` then auto-transitions the feature to `done` and closes it as done.
6. Any fail → request `comment` with a partial report (`Evidence`), then request the state machine to reopen the offending dev sub-issue(s) with expected-vs-actual and repro steps; the tester issue stays open until the whole feature passes.

**All GitHub writes go through the state machine** — draft the report and request the `comment` action; never call `gh` directly to write.

## Artifacts produced
- Test report (04-artifacts.md#test-report)
- Verdict comment (`Evidence` + `Status`)

## GitHub conventions
- Comments: `Evidence` for test results (screenshots via `upload-evidence`, committed to `spec/<N>`), `Status` for verdict/state — via the state machine
- Reopens failing sub-issues with expected-vs-actual + repro steps — via the state machine

## Verification (definition of done)
- Every QA Plan case has a PASS/FAIL verdict with attached evidence — none left blank
- Verdict posted on the tester issue with per-case results and a summary (total/passed/failed)
- On all-pass: verdict posted and the Scrum Master notified — the Scrum Master transitions the feature to `audit` (auto-merging the spec PR); the Self-Improver's `audit-record --verdict success` auto-transitions to `done` and closes as done
- On failure: every failing case maps to a reopened dev sub-issue with expected-vs-actual and repro steps
- Evidence is real receipts — screenshots, log excerpts, DOM snapshots — never "it works"

## References
- docs/agentic-pipeline/03-pipeline.md#phase-4-testing
- docs/agentic-pipeline/04-artifacts.md#tester-issue
- docs/agentic-pipeline/04-artifacts.md#test-report
- docs/agentic-pipeline/05-github.md
- references.md
