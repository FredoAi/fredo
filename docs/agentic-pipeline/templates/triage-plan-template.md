# Implementation Plan #<issue> — <title>

> Backlog: #<backlog> — filled from the agreed triage drafts.
>
> Machine-parsing contract (keep these headings stable — `generate-work` depends on them):
> - `generate-work` turns each `- [ ]` checkbox under `### Sub-issue Decomposition` into a dev sub-issue.
> - `generate-work` turns the `### QA Plan` table into the consolidated tester issue.
> - `update-plan` replaces one whole `##` section per call (idempotent — other sections are untouched).
> - `tests-commit` parses `**Feature tests:**` from the `## QA Expert` section to auto-persist suites at the `triage → implementation` transition.

---

## Software Architect

### Domain Model (file:line)

<affected systems + event/data flow, every claim cited `file:line`>

### Requirements

Two layers — behavioral in EARS, everything else in prose:

**Behavioral requirements (EARS):** one EARS clause per observable behavior —
`WHEN <trigger>, the system SHALL <response>` (use `WHILE <state>` and
`IF ... THEN ...` where they fit). EARS clauses map 1:1 to the QA Plan test cases.

**Non-behavioral requirements & constraints (prose):** architectural constraints,
NFRs, cross-cutting budgets (latency, memory, retention), and anything that is not
conditional observable behavior — plain measurable prose, not forced "shall" statements.

### API Contracts & Data Models

<endpoints, payloads, schemas, data models — as code blocks>

### Sub-issue Decomposition + Effort Estimates

<one `- [ ]` line per independent sub-issue; effort estimates feed the Staffing Plan.
Every sub-task line carries: intent (goal + why), non-goals / regression invariants
(what must NOT change — mandatory for refactor/perf/infra), the EARS requirement IDs
it satisfies, and the files it owns. `generate-work` turns each line into a dev sub-issue.>

- [ ] Sub-task 1: <intent → why; non-goals; EARS #; files>

---

## UI/UX Expert

### Design Assets (or "N/A")

<mockups, component specs, interaction flows, states, accessibility — or "N/A" for backend-only work>

---

## QA Expert

### QA Plan

| REQ | Test case | Expected | Edge cases |
|-----|-----------|----------|------------|

<plus pass/fail criteria, required test data, non-functional checks>

---

## Summary

<goal + acceptance criteria>

## Staffing Plan

<# developers, roles, estimated effort, heuristic used>

## Deployment Notes

<branch strategy, CI checks, infrastructure needs>

## Risks & Mitigations

<risk> → <mitigation>
