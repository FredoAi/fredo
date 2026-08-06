# Triage Plan Comment Template

> Drafted by the **Self-Improver** after the triage cluster converges, as `.opencode/tmp/<issue>/triage-plan.md`, auto-posted as `## Triage Plan` by the triage → implementation transition. **Should contain ALL the information** needed to implement + verify the feature.

<!-- The full converged plan — everything below is required. -->

## Scope & intent

- <what we build, in user terms; the slice>

## Technical plan

### Domain Model (file:line)

<affected systems + event/data flow, every claim cited `file:line`>

### Requirements (EARS)

<one `WHEN <trigger>, the system SHALL <response>` clause per observable behavior; GA-1..GA-N>

### API / data contracts

<endpoints, payloads, schemas, `gen_ai.*` keys if telemetry, metric names>

### Sub-task decomposition

- [ ] Sub-task 1: <intent/why; non-goals; EARS #; files; effort>
- [ ] Sub-task 2: <...>

## QA Plan

> **Verification policy: live** (or `static` ONLY if every AC is verifiable without a running system).

| REQ | Test case | Expected | Edge cases |
|-----|-----------|----------|------------|

- Pass/fail criteria, required test data, non-functional checks.

## Staffing / Deployment / Risks

- <# developers, effort, branch strategy, CI, top risks + mitigations>

## PO sign-off required?

- [ ] **No deviations from the acceptance criteria.** (If YES — any AC observable key changed — the PO must approve via a `Decision` comment before implementation.)

*Authored by Self-Improver*
