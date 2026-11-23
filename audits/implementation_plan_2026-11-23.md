# Implementation Plan — Pipeline Performance Audit (2026-11-23)

Tracks the fixes in [`performance_audit_2026-11-23.md`](./performance_audit_2026-11-23.md).
Execution mode: **direct implementation**. Last updated: 2026-11-23.

Verification: `test-scripts.ps1` is **180/180 PASS** after each state-machine batch;
`--action verify` is INTEGRITY OK. Docs updated in the same pass.

## P1 — Machine correctness — DONE

- [x] **B1** One round authority: `round_authority()` derives ending + entering rounds from one read; Fix Plan + Development Summary share `entering`, Tests Runs uses `ending`.
- [x] **B2** `is_rework_reentry` keyed on destination + source (PASS legs no longer post a stray Fix Plan).
- [x] **B3** Fallback extraction accepts `Sub-task`/numeric items; fallback must carry a `Root cause class:`.
- [x] **B5** `Tested commit:` line parsed; a stale-head verdict is rejected (legacy no-stamp falls back to round).
- [x] **C3** One verdict-header parser (header on any line, BOM-tolerant).
- [x] **F1** Bounded `gh`/`git` timeout (120 s default, `FREDO_CMD_TIMEOUT_SECS`).

## P2 — Measurement hygiene — DONE (tmp prune deferred)

- [x] **G1** Fixture `633.jsonl` quarantined to `.opencode/state/fixtures/`; metrics/health headline + agent/phase mix filtered to real specs (`create-issue`) and explicitly exclude fixture ids `0`/`633` (the offline harness recreates `633.jsonl`, so the filter is the durable fix).
- [x] **G5** Validate-on-append; `ad-hoc-scripts` recorded once per issue; `verify` already flags non-JSON/malformed lines.
- [~] **G2** Log cap added to `prune` (delete >200 MB or >7 days); removed the 2.87 GB log. `.opencode/tmp` prune deferred.

## P3a — Planning discipline — PARTIAL

- [x] **A1** Plan size cap: >15 SP blocks `planning → implementation` unless a PO `## Scope Override` section exists.
- [ ] **A3** Plan-time drivability census script + skill — **not done**.

## P3b — Evidence mechanics — PARTIAL

- [x] **C2** A verdict citing a consumed `.opencode/tmp/` draft is refused (G-415).
- [x] **C5** Env-id tolerance: no-lease accepts `spec<N>` / `wf<N>-a` / `qa<N>-a`.
- [x] **D3** Covered by the existing `upload-evidence` existence check.
- [~] **F4** Architect playbook now routes sibling-owned fix-scope items to the owner (doc fix); machine pre-check not added.
- [ ] **C1** Product-subtree diff (re-serve only when product changed) — **not done**.

## P4 — Throughput instrumentation — PARTIAL

- [x] **F2** `retry_state` reads the event log once (was 3×); rounds shared via `round_authority`.
- [ ] **G4** Retrospective instrument (per-spec rounds/rework/cycle/ad-hoc) — **not done**.

## P5 — Guardrail / instruction slimming — NOT STARTED

- [ ] **E1** Curate ledger (stubs/dups/stale).
- [ ] **E2** Progressive disclosure in playbooks.
- [ ] **E3** Curator gating — blocked by the post-audit gate requiring a `pipeline.improvement` event (needs a principle decision).
- [ ] **E5** Class→Lever routing.

## P6 — Tooling library — NOT STARTED

- [ ] **D1** Probe families as committed tools.
- [ ] **D2** Deterministic lint scripts.
- [ ] **C4** Guard-universe instrument.

## Human batch — PARTIAL

- [x] **D4** `software-architect` granted `telemetry-query` (via `set-permission`).
- [~] **F4** Doc-level ownership routing (see P3b); no permission grant.
- [ ] **B4** Parallel Curator variant (`principles.md`) — not done.
- [ ] **H1/H2** Prune deprecated actions/labels/channels — not done.
- [ ] **G3** Close abandoned #2694/#2711 — not done (needs a public-issue decision).

## Deferred

- **F3** parallel dev waves, **F6** parallel envs — revisit after G4 data.
