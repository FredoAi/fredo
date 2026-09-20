# Mission Monitor — Regression Baseline (Spec #2791 — Ghost sessions)

> The "must not change" baseline for this spec + links to overlapping prior suites. Run on every testing phase that touches the mission-monitor surface.

## Must NOT change (regression invariants)

- [x] R-1 (G-074, PASS 2026-09-02 #2791): A session whose telemetry spans have NOT yet landed (zero nodes + zero landed spans) still renders the transient empty state — selecting it must NOT show the ghost explanatory state and must NOT be a silent blank.
- [x] R-2 (PASS 2026-09-02 #2791): A normal session (landed rows + rendered nodes) still renders its graph with the pre-fix node layout/colors/edges. No layout/color/edge change.
- [x] R-3 (PASS 2026-09-02 #2791): Telemetry ingestion, storage, and tool-outcome classification are unchanged. No v1 hydration / fallback extraction reintroduced; the RTDB row path (`useEventRows`) is the only row source.
- [x] R-4 (PASS 2026-09-02 #2791, #523 compositing semantics): row-level compositing (not event-level rewrite) is respected — the relationship registry's first-wins stamp persists, a re-key never removes rows (only retention eviction emits `kind: remove`), and child-session rows composite under the parent key carrying `parentSessionId` + `compositedChildSessionId`.
- [x] R-5 (PASS 2026-09-02 #2791): No new re-render loops — epoch-based recomputation; no `Maximum update depth exceeded` with `.length`/object-ref effect deps.
- [x] R-6 (PASS 2026-09-02 #2791): Subagent `build`/`plan` internal tool-execution sessions are still excluded from the graph; user-requested @-subagent dispatches still produce SubagentNodes when the parent anchor resolves; subagent chat rows excluded from the graph (isSubagentChatRow) while the parent session still lists.

## Overlapping prior-feature suites

- Priority prior mission-monitor regression legs (chat node rendering, embedded `── TOOLS (N) ──` section, subagent nodes, session list derivation) — inherited and extended by this spec.
- This spec's functional suite: `.opencode/tests/mission-monitor/functional.md` F-1..N and N-1..N-3.

---

# Mission Monitor — Regression Baseline (Spec #2792 — Tool-failure reason in detail view)

> The "must not change" baseline for this spec + links to overlapping prior suites. Run on every testing phase that touches the mission-monitor surface.

## Must NOT change (regression invariants) — Spec #2792

- [ ] R-7 (PASS gate): Tool-outcome classification (`getToolCallOutcome`, graph.ts:123-128) is unchanged — a failed call is still `error` when `call.error` is a non-empty string OR `success === false`; a success/`in-progress` call is never re-classified to `error` merely because a reason row now renders. No change to tool-outcome classification.
- [ ] R-8 (PASS gate): Graph-node colors/edges, chat-node/subagent-node layout, and session-list/graph derivation are unchanged — adding a reason row to the scoped tool-call detail view must NOT alter the graph canvas, node set, or edges.
- [ ] R-9 (PASS gate): Upstream error capture is unchanged — `tool.error` → `ToolUseRow.toolError` remains the single source (EventSubscription.ts:103, classifier); no change to ingest/classification/storage.
- [ ] R-10 (PASS gate): A succeeded tool call still shows NO error/reason row (no regression to the success case — REQ-4).
- [ ] R-11 (PASS gate): Contract-trust preserved — the detail view consumes the projected `ToolCallSummary.error` single path (rowDerivation.ts:276); NO `??` fallback chains / multi-path lookups / output-derived reason (REQ-5).
- [ ] R-12 (PASS gate): No new re-render loop — epoch-based recomputation; no `Maximum update depth exceeded` with `.length`/object-ref `useEffect` deps (NFR-2).
- [ ] R-13 (PASS gate): Subagent `build`/`plan` internal tool-execution sessions remain excluded from the graph; user-requested @-subagent dispatches still produce SubagentNodes when the parent anchor resolves (from Spec #509/#523 — unchanged by #2792).

## Overlapping prior-feature suites

- Priority prior mission-monitor regression legs (chat node rendering, embedded `── TOOLS (N) ──` section, subagent nodes, tool-call accordion/detail views from Spec #2739/#2743/#2764, session list derivation) — inherited and extended by this spec.
- This spec's functional suite: `.opencode/tests/mission-monitor/functional.md` F-7..F-11 and N-4..N-5.

---

# Mission Monitor — Regression Baseline (Spec #2795 — Ghost sessions follow-up)

> The "must not change" baseline for this spec + links to overlapping prior suites. Run on every testing phase that touches the mission-monitor surface.

## Must NOT change (regression invariants) — Spec #2795

- [ ] R-14 (AC-1, INVERTED from #2791): The #2791 explanatory ghost state is REMOVED — "No graph content for this session" is NEVER rendered, and no empty-diagram placeholder replaces it. (Supersedes + inverts the #2791 positive R-1/F-2/F-3/F-4/E-2 which asserted the explanatory state.)
- [ ] R-15 (AC-2/AC-3, shared truth): A normal session (landed rows + rendered nodes) still renders its graph with the pre-fix node layout/colors/edges; session-list qualification and graph-node emission share ONE rule — no listed session renders zero nodes once its rows have landed, and no unlisted-but-landed session renders ≥1 node.
- [ ] R-16 (AC-3): Telemetry ingestion, storage, and tool-outcome classification are unchanged; the RTDB row path (`useEventRows`) is the only row source; no v1 hydration / fallback extraction reintroduced.
- [ ] R-17 (AC-4, transient + no-hidden): A just-started session whose rows are still landing still appears and resolves to content (legitimate transient preserved, G-074); a session rendering ≥1 node is NEVER dropped; only a user-deleted session is not listed (anti-resurrection, REQ-3).
- [ ] R-18 (#523 compositing): row-level compositing is respected — the relationship registry's first-wins stamp persists, a re-key never removes rows (only retention eviction emits `kind: remove`), and child-session rows composite under the parent key carrying `parentSessionId` + `compositedChildSessionId`.
- [ ] R-19 (Spec #509): subagent `build`/`plan` internal tool-execution sessions are still excluded from the graph AND from the sidebar; user-requested @-subagent dispatches still produce SubagentNodes when the parent anchor resolves.
- [ ] R-20 (NFR-2): No new re-render loops — epoch-based recomputation; no `Maximum update depth exceeded` with `.length`/object-ref `useEffect`/`useMemo` deps.

## Overlapping prior-feature suites (Spec #2795)

- #2791 ghost-explanatory-state legs (F-2/F-3/F-4, R-1, E-2) are INVERTED — run the AC-1 negative (no explanatory message, ghost not listed) for #2795.
- This spec's functional suite: `.opencode/tests/mission-monitor/functional.md` F-12..F-16 and N-6..N-9.

---

# Mission Monitor — Regression Baseline (Spec #2835 — RTDB row-pipeline performance regression)

> The "must not change" baseline for a perf fix. Run on every testing phase that touches the mission-monitor surface. Perf fixes commonly slip a semantic change under a perf cover — every invariant below is a FAIL if the perf branch changes it.

## Must NOT change (regression invariants) — Spec #2835

- [ ] R-21 (RTDB row-pipeline mappings unchanged): the IngestClassifier maps the SAME OTLP spans / CLI events onto the SAME canonical row upserts — no change to which rows are produced or to any field projection (`rtdb/ingest.rs` / `attrs.rs`). Cross-check `telemetry_spans`/`chat_rows`/`tool_use_rows` count + shape unchanged at the same instant.
- [ ] R-22 (Ingest classification unchanged): the shared extract-rule implementation (`attrs.rs`, NFR-6) is unchanged — no duplicate extraction path introduced between the live classifier and the canonical backfill.
- [ ] R-23 (Contract-trust single-path extraction unchanged): the frontend consumes the projected single-path row fields — no `??` fallback chains / multi-path lookups / output-driven derivation / v1 hydration reintroduced (Spec #568 cleanup not regressed).
- [ ] R-24 (#523 compositing semantics unchanged): row-level compositing (relationship registry first-wins stamp; a re-key NEVER removes rows — only retention eviction emits `kind: remove`; child-session rows composite under the parent carrying `parentSessionId` + `compositedChildSessionId`); no event-level rewrite reintroduced.
- [ ] R-25 (#509 subagent filter unchanged): `build`/`plan` internal tool-execution sessions are still excluded from the graph AND the sidebar; user-requested @-subagent dispatches still produce SubagentNodes when the parent anchor resolves.
- [ ] R-26 (Theming tokens unchanged): the perf fix must not introduce any hardcoded hex/rgba or invalid `var(--token)NN` alpha-append; all colors via semantic tokens → CSS vars → `tint()`/`color-mix()`.
- [ ] R-27 (No cross-feature imports): the fix stays within `apps/ui/src/features/mission-monitor/*`, `apps/ui/src/shared/contexts/StreamContext.tsx`, `apps/ui/src/shared/hooks/useEventRows.ts`, and backend `infrastructure/rtdb/{flush,store,cache,ingest}.rs` + `infrastructure/comm/`; no new cross-feature import introduced.
- [ ] R-28 (Re-render-loop pattern unchanged, Spec #523): no new `.length`/newly-created object-ref `useEffect`/`useMemo` deps; recomputation stays epoch-based; no `Maximum update depth exceeded`.
- [ ] R-29 (Row-store merge semantics unchanged): `insert` spread-merges (init-time fields survive), `update` is seq-guarded with stale-patch drops, `remove` is only ever retention eviction — the perf fix must not bypass these semantics.

## Overlapping prior-feature suites (Spec #2835)

- #2791/#2792/#2795 functional legs (ghost sessions, tool-failure reason, real-sessions-only) — run the unaffected legs; the perf fix must not change graph rendering, list qualification, or tool-detail rendering.
- This spec's functional suite: `.opencode/tests/mission-monitor/functional.md` F-17..F-24 and N-10..N-15.
- The AC-4 window-manager/launcher/theming invariants (R-26) overlap the theming (N-4/N-9), launcher (S-8), and window-manager legs.

---

# Mission Monitor — Regression Baseline (Spec #2893 — row-derivation cost fix)

> The #2893 RD-1..RD-4 fix is **cost-only** (`rowDerivation.ts` WeakMap `rawJson` parse memo + source
> guard, duplicate tool-summary removed, plain code-unit comparator in place of `localeCompare`). The
> derive OUTPUT must be byte-identical; only the parse/sort cost changes. Run on every testing phase
> that touches the mission-monitor derivation.

## Must NOT change (regression invariants) — Spec #2893

- [x] **R-30 (derive output unchanged):** the panel renders the SAME session list, graph nodes and
  edges as before the cost fix — no session/node lost, added, or reordered.
  - **PASS (live, spec/2893 @ cf25127c).** Mission Monitor rendered the same corpus as round 2:
    2 sessions with the same titles (`hey lets create a spec with our PO. [Im…` / `stuck: Get-Process
    -Name fredo -ErrorAc…`), the same **4** react-flow nodes (`agent-ses_…_2/_3/_5`,
    `subagent-ses_…_1`) and **3** edges (`e-chat_2→3`, `e-chat_3→5`, `e-calls_1`), and the same window
    fingerprint (aria-label `Sessions` + header `FSessions`). The in-repo RD-4 pins (one parse per
    row per derive; zero on a second derive; re-parse on in-place `rawJson` change) + the corpus-parity
    and `useMissionMonitor.realCorpus` suites pin the output equivalence.
- [x] **R-31 (parse memo cannot go stale):** `rawPayload` returns a cached parse only when the row
  object AND its `rawJson` source string match; a real mutation (new merged row object) or an in-place
  `rawJson` rewrite re-parses.
  - **PASS (in-repo RD-4 pin (c), positive control).** The developer's positive control (cache GET
    forced off) failed all 3 RD-4 pins (single derive parsed 12 vs expected 7; second derive parsed 12
    vs expected 0; changed-rawJson count 2 vs expected 1), proving the pins detect a reintroduced
    per-call parse. All callers read the returned object (never mutate) — verified in the diff.
- [x] **R-32 (no unbounded new structure):** the parse cache is a `WeakMap` keyed by the row object
  (already retained by the row store) — no new unbounded structure, no retention change.
  - **PASS (static).** Module-scoped `WeakMap<object, { source, parsed }>` in `rowDerivation.ts`; no
    array/map growth keyed by anything but row identity.

## Overlapping prior-feature suites (Spec #2893)

- #2835 F-17..F-24 / N-10..N-15 (first-render latency, sustained-run, long-task) — the cost fix is a
  direct improvement to the F-17/F-23 long-task signal; the remaining #2835 legs are unaffected.
- This spec's functional suite: `.opencode/tests/launcher/functional.md` F-89 (Q-15 window-present
  latency, re-measured PASS) + `companion` F-99..F-105.

---

# Mission Monitor — Regression Baseline (Spec #2896 — feature-owned realtime data layer)

> The Mission Monitor migration to the feature-owned realtime data layer must preserve every Mission Monitor behavior below. Mission Monitor is the first consumer — a data-layer bug surfaces as a Mission Monitor regression. Run on every testing phase that touches the mission-monitor surface.

## Must NOT change (regression invariants) — Spec #2896

- [ ] R-33 (no visual/layout/graph redesign — explicit scope exclusion): the session list, graph canvas, nodes, edges, colors and layout are unchanged; the layer swap must not alter what the panel renders. Compare node/edge sets + titles against a pre-migration capture (same corpus).
- [ ] R-34 (ingest/classification unchanged): the IngestClassifier's rows and the canonical extract rules (`rtdb/ingest.rs` / `attrs.rs`, NFR-6) are unchanged — the layer sits ON TOP of the row pipeline, it does not re-classify; cross-check `telemetry_spans`/row counts + shape at the same instant.
- [ ] R-35 (row-store merge semantics): `insert` spread-merges (init-time fields survive), `update` is seq-guarded with stale-patch drops, `remove` only from retention eviction (`StreamContext.tsx`); the layer must not bypass or replace these semantics.
- [ ] R-36 (#523 compositing + #509 subagent filter): the relationship registry's first-wins stamp persists, a re-key never removes rows, child rows composite under the parent carrying `parentSessionId`/`compositedChildSessionId`; `build`/`plan` internal tool-execution sessions stay excluded from list + graph; user-requested @-subagent dispatches still render SubagentNodes.
- [ ] R-37 (session-list liveness + no resurrection): new sessions appear and existing session details update without reopening; a user-deleted session stays absent across restart (deletion tombstones intact); a just-started session still appears and resolves after rows land (legitimate transient, G-074).
- [ ] R-38 (tool-failure detail + ghost follow-up preserved): the #2792 tool-failure Reason row and the #2795 no-explanatory-message/no-ghost rules are unchanged by the migration.
- [ ] R-39 (contract-trust): no `??` fallback chains / multi-path extraction / v1 hydration reintroduced (#568 cleanup not regressed); the layer's read/watch is the only new data path.
- [ ] R-40 (no cross-feature imports / theming): no cross-feature import introduced; no hardcoded hex/rgba; no invalid `var(--token)NN` (use `tint()`/`color-mix()`).
- [ ] R-41 (no re-render loops, #523): epoch-based recomputation; no `.length`/newly-created object-ref `useEffect`/`useMemo` deps; no `Maximum update depth exceeded` after watch start/stop or session switch.
- [ ] R-42 (deletion cap/retention intact): the 50-session cap + deletion tombstone behavior in `persistence.ts` is preserved (or its replacement demonstrably equivalent) — no orphaned child rows after prune/delete.
- [ ] R-43 (drawer chrome unchanged — UI/UX binding invariant): `SessionHistoryDrawer` collapse/expand (210/28 px) + hover-expand, rename, search, long-name ellipsis/row-height stability, `SessionTokenBar` and `DetailPanel` are unchanged; live inserts must not alter drawer width or cause horizontal scroll; `NoSessionSelected` (MissionMonitorPanel.tsx:161) and the existing empty-state copy/visuals are unchanged (only *when* the list first renders and *how precisely* it live-updates may change).
- [ ] R-44 (existing snapshot/name/deletion semantics unchanged): `loadPersistedSessions` ordering + `session_names` merge, atomic `featureStoreUpdate` (never delete+insert), and the deletion tombstones still behave as before the layer migration.

## Overlapping prior-feature suites (Spec #2896)

- `mission-monitor` functional F-1..F-24 / N-1..N-15 — run every unaffected leg; the layer migration must not change graph rendering, list qualification, tool-detail rendering, or first-render latency budgets.
- The new generic-layer suite `.opencode/tests/realtime-data/` — its REQ-1..REQ-5 legs are the layer's own regression asset.
- Perf legs F-17..F-24 / N-10..N-15 (#2835) — re-run the first-render and sustained legs; F-38/F-39 extend them for #2896.
- This spec's functional suite: `functional.md` F-25..F-40 + N-16..N-19.
