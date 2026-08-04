# Implementation Plan #<issue> — <title>

> Backlog: #<backlog> — filled from the agreed triage drafts.
>
> Machine-parsing contract (keep these headings stable — `generate-work` depends on them):
> - `generate-work` turns each `- [ ]` checkbox under `### Sub-issue Decomposition` into a dev sub-issue.
> - `generate-work` turns the `### QA Plan` table into the consolidated tester issue.
> - `update-plan` replaces one whole `##` section per call (idempotent — other sections are untouched).

---

## Software Architect

### Domain Model (file:line)

<affected systems + event/data flow, every claim cited `file:line`>

### Requirements (EARS)

<the shall-statements the feature must meet>

### API Contracts & Data Models

<endpoints, payloads, schemas, data models — as code blocks>

### Sub-issue Decomposition + Effort Estimates

<one `- [ ]` line per independent sub-issue; effort estimates feed the Staffing Plan>

- [ ] Sub-task 1: <desc>

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
