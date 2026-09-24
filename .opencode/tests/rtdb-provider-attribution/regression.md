# RTDB Provider Attribution — Regression Baseline (Spec #2932)

> The "must not change" baseline for provider attribution on the canonical RTDB rows. Run on every testing phase that touches the row pipeline, the query language, `fredo emit`, the canonical backfill, or the frontend row wire types.
>
> **Evidence policy: LIVE** — the migration/data-loss and latency legs require a live `fredo.db` read; a static-only result does not clear them.

## Must NOT change (regression invariants)

- [ ] R-1 (row lifecycle + merge semantics unchanged): adding `provider` must not alter any existing field's merge rule or the row lifecycle. The merge tables stay total — exactly one rule per canonical field, order-preserved (`rtdb/merge.rs` totality test green; the three `*_FIELDS` consts grow by exactly one entry; the hard length assertions move 17/15/12 → **18/16/13**; the provider slot is after `state` while the SQL column stays last per table). `provider` uses the Architect-bound `MergeRule::LastNonZero` (non-empty applies; absent/empty never clears) — note the R4-vs-`LastNonZero` conflict flagged in the plan Discussion. Retention remains the only `remove` producer; no change to merge ordering.
- [ ] R-2 (schema migration is additive, no data loss): `ensure_schema` must add the `provider` column (`TEXT NOT NULL DEFAULT 'unknown'`) to an EXISTING store via a `PRAGMA table_info`-guarded re-runnable `ALTER TABLE` (never drop/recreate). After upgrade: `SELECT COUNT(*) FROM chat_rows` ≥ pre-upgrade count; `SELECT COUNT(*) FROM chat_rows WHERE provider IS NULL OR provider = ''` = 0. Row identity (`session_id`, `correlation_id`, `seq`) and all pre-existing fields are preserved; the positional mappers (chat 17 / tool 15 / agent 12) move in lockstep with the SELECT/INSERT lists and `select_snapshot`.
- [ ] R-3 (single shared extract rule, NFR-6): provider extraction is implemented ONCE and shared by live ingest and the canonical backfill (`rtdb/attrs.rs` helper) — no duplicated extraction path. Live vs backfill derivation is byte-comparable (F-8).
- [ ] R-4 (query-language backwards compatibility): every pre-existing query validates and returns the same result as before; hard-named validation errors are unchanged (unknown fields still error, type mismatches still error); adding `provider` to the schema does not relax any rule.
- [ ] R-5 (existing ingest unchanged for provider-less consumers): the classifier's other canonical projections (user message, tokens, cost, model, timing, tool fields, agent name, compositing stamps) are unchanged — cross-check `telemetry_spans` and row shape at the same instant. Attribution must not add a per-row span lookup or reorder classification.
- [ ] R-6 (no contract-trust regression): no `??` fallback chains, multi-path provider lookups, text filtering, or v1 hydration reintroduced (#568 cleanup not regressed). Once the row store guarantees `provider`, consumers read the typed field directly.
- [ ] R-7 (frontend wire stability + no re-render loop): adding `provider` to `EventSubscription.ts` is additive; existing consumers compile unchanged; no `.length`/newly-created-object `useEffect`/`useMemo` deps; console clean after subscription start/stop and app open/close (no `Maximum update depth exceeded`, #523).
- [ ] R-8 (no cross-feature imports / theming): row-pipeline code stays in `infrastructure/rtdb/`; features never import from each other; no new user-visible surface means no theming change (if one appears, tokens only — no hardcoded hex/rgba, no invalid `var(--token)NN`).
- [ ] R-9 (`fredo emit` default behavior unchanged): a bare `emit` with no `--provider` still defaults to `internal`; adding the Copilot token to the enum does not renumber or rename existing variants (`open_code`, `claude_code`, `internal` wire names stable).

## Overlapping prior-feature suites (run the untouched legs)

- `.opencode/tests/realtime-data/regression.md` R-1 (RTDB row pipeline untouched), R-2 (row-store merge semantics), R-3 (subscription contract), R-4 (no contract-trust regression) — the closest overlap; this spec adds a field to the same rows.
- `.opencode/tests/event-persistence/` — persisted-delivery/row-store behavior the migration builds on.
- `.opencode/tests/otlp-genai/` R-17 (Transport enum wire names) + `.opencode/tests/opencode-plugin/` R-8 (`service.name=fredo-opencode-plugin` resource identity) — the raw provider source this spec normalizes.
- `.opencode/tests/fredo-cli/` — the `fredo emit` CLI surface whose `--provider` enum is extended.
- `.opencode/tests/mission-monitor/regression.md` — the first consumer's invariants (row projection must not change shape/behavior).

## Round notes

> (Tester appends per-round results here — FAIL rows keep `- [ ]` with expected-vs-actual + repro.)
