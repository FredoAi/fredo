# Realtime Data Layer — Regression Baseline (Spec #2896)

> The "must not change" baseline for the feature-owned read/watch layer. Run on every testing phase that touches the layer or its first consumer (Mission Monitor).

## Must NOT change (regression invariants)

- [ ] R-1 (RTDB row pipeline untouched): the IngestClassifier's canonical row upserts and the shared extract rules (`rtdb/ingest.rs` / `attrs.rs`, NFR-6) are unchanged — the layer reads/watches the row pipeline, it does not re-classify or alter what rows are produced. Cross-check `telemetry_spans`/row counts + shape at the same instant.
- [ ] R-2 (row-store merge semantics preserved): `insert` spread-merges (init-time fields survive), `update` is `{ ...row, ...patch }` with seq-guarded stale-patch drops, `remove` only ever from retention eviction (`StreamContext.tsx`); the layer must not replace or bypass these semantics.
- [ ] R-3 (existing subscription contract preserved): the existing `subscribe_events` / `unsubscribe_events` query-text contract, hard named validation errors (zero partial registration), replay register-before-snapshot, and the `replayCompleteQueryId` settle marker are unchanged for existing consumers.
- [ ] R-4 (no contract-trust regression): no `??` fallback chains / multi-path extraction / event-level rewrite / v1 hydration reintroduced (#568 cleanup not regressed); report queries are byte-comparable with live derivation.
- [ ] R-5 (no cross-feature imports): the layer lives in shared infrastructure and never imports from a feature; features never import from each other; Mission Monitor is a consumer only.
- [ ] R-6 (theming): any new surface uses semantic tokens → CSS vars; no hardcoded hex/rgba; no invalid `var(--token)NN` alpha-append (use `tint()`/`color-mix()`).
- [ ] R-7 (no re-render-loop pattern, #523): epoch-based recomputation; no `.length`/newly-created object-ref `useEffect`/`useMemo` deps; no `Maximum update depth exceeded` after watch start/stop or scope switch.
- [ ] R-8 (FeatureStore namespacing intact): feature tables remain `feature_{feature_id}_{table}` with hyphens sanitized to underscores; cross-namespace access is refused; delete/update never become delete+insert (AGENTS.md upsert rule).
- [ ] R-9 (retention/removal semantics unchanged unless the spec explicitly changes them): the only `remove` producer remains retention eviction; a row that merely stops matching a query arg never emits a removal.

## Overlapping prior-feature suites

- `.opencode/tests/mission-monitor/regression.md` R-33..R-42 — the first consumer's invariants (no visual redesign, ingest unchanged, compositing/#509, deletion tombstones, latency budgets).
- `.opencode/tests/event-persistence/` — persisted-delivery/row-store behavior the layer builds on.
- `.opencode/tests/otlp-genai/` and `.opencode/tests/fredo-cli/` — the real emission/classification channels the layer consumes; run the unaffected legs when the layer touches ingestion (it must not).
- This spec's functional suite: `functional.md` F-1..F-16 + N-1..N-6.
