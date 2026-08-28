# Implementation Plan #<issue> — <title>

> Backlog: #<backlog> — filled from the agreed triage drafts.
>
> **Source of truth for `gen_ai.*` emission:** the OpenTelemetry GenAI semantic
> conventions — https://github.com/open-telemetry/semantic-conventions-genai/tree/main/docs/gen-ai/
> (`gen-ai-spans.md`, `gen-ai-agent-spans.md`, `gen-ai-events.md`,
> `gen-ai-exceptions.md`, `gen-ai-metrics.md`). Every `gen_ai.*` attribute in
> this plan MUST match a registry key under its CURRENT name; renamed legacy keys
> (e.g. `gen_ai.system` → `gen_ai.provider.name`) MUST be used under the spec
> name. Any deviation requires a PO-amended acceptance criterion — never a silent
> triage substitution.
>
> Machine-parsing contract (keep these headings stable — the pipeline depends on them):
> - The `- [ ]` lines under `### Sub-issue Decomposition` are the implementation checklist (developers work them on the spec branch — no sub-issues are generated).
> - The `### QA Plan` table feeds the tester's `## Tests Runs` verification.
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
it satisfies, and the files it owns. Developers work these checklist items on the spec branch.>

- [ ] Sub-task 1: <intent → why; non-goals; EARS #; files>

---

## UI/UX Expert

### Design Assets (or "N/A")

<mockups, component specs, interaction flows, states, accessibility — or "N/A" for backend-only work>

---

## QA Expert

> **Verification policy: live** — replace `live` with `static` ONLY if every AC in this
> plan is genuinely verifiable without observing a running system (pure unit-testable
> logic). Emission/observability features (telemetry, spans, events, metrics, UI
> rendering) MUST stay `live`: the testing exit gate and audit fail-closed unless the
> tester's Evidence references `telemetry_spans` (a live-query result) for live-policy
> plans. A static PASS for a live-policy plan is a false PASS.

### QA Plan

| REQ | Test case | Expected | Edge cases |
|-----|-----------|----------|------------|

<plus pass/fail criteria, required test data, non-functional checks>

---

## Summary

<goal + acceptance criteria>

## Staffing Plan

<# developers, roles, estimated effort, heuristic used>

> The machine parses the spec size for trend normalization from a line in the exact form
> `- **Effort:** N story points` in this section (marker `**Effort:**`, then the digit
> run) — keep that exact marker format here; prose like "Effort: N story points" in
> backticks or mid-sentence is NOT parsed.

## Deployment Notes

<branch strategy, CI checks, infrastructure needs>

## Risks & Mitigations

<risk> → <mitigation>
