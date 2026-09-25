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

---

# Mission Monitor — Regression Baseline (Spec #2933 — Copilot CLI capture, provider coexistence)

> The Mission Monitor must render a captured GitHub Copilot CLI session from the canonical rows with **no feature-specific change** — it is the first row-consuming feature the new provider must reach (AC1 success metric). The existing OpenCode rendering must be unchanged. Run on every testing phase that touches mission-monitor or the row pipeline.

## Must NOT change (regression invariants) — Spec #2933

- [x] R-45 (Copilot session renders without feature changes — AC1): a captured Copilot session (`provider = copilot_cli` rows in `chat_rows`/`tool_use_rows`/`agent_session_rows`) is listed and rendered by Mission Monitor (session identity, chat node, tool section) with **zero mission-monitor code changes**. Read via `useEventRows`; capture the DOM + screenshot.
  - **FAIL (round 1, 2026-09-24, `spec/2933 @ 69ce5850`).** Session identity + chat node render (PASS halves): the real Copilot session `3736fe04-c91c-4948-983e-6882af63c5a8` is listed ("`<current_datetime>2026-09-24T09:51:59.4…`") and selected; session token bar shows INPUT 20,425 / OUTPUT 53 / TOTAL 20,478 / TOTAL MESSAGES 2; one chat node `agent-3736fe04-…_3` renders `mai-code-1.1-flash` with RESPONSE `fredo-copilot-2933-sentinel` and INPUT 10,241 / OUTPUT 14. **Missing: the `── TOOLS (N) ──` section and the `── USER ──` prompt (`USER` renders `—`).**
  - **Expected:** for a prompt-plus-tool Copilot exchange, Mission Monitor renders the chat node with the user prompt and the embedded `── TOOLS (N) ──` section (as the OpenCode baseline does for an equivalent exchange).
  - **Actual:** both are absent. Root cause (deterministic, code-cited): real Copilot splits one user turn across TWO `chat` spans — call 1 carries `gen_ai.input.messages` (the user text) + a `tool_call` output (no text → `agent_reply` empty) → `chatRowStatus = complete` + empty reply → `isTransitionalTurn` suppresses its node (`rowDerivation.ts:224-239`); call 2 carries only the tool response + the assistant text → the visible node (id `…_3`) has `userMessage = null`. The tool span lies INSIDE call 1's window but its anchor resolution (`resolveChildAnchor`/`resolveCompanionEmission`, `rowDerivation.ts:316-361`) requires the same-exchange reply to carry the SAME non-empty `userMessage` — call 2 does not → the tool item is not emitted. OpenCode never exhibits this because each of its chat spans re-emits the FULL accumulated `gen_ai.input.messages`, so its reply row carries the user message.
  - **Repro (deterministic, no quota):** `bun .opencode/scripts/inject-otlp-fixture.ts --copilot --fixture .opencode/tmp/2933/copilot-turn-split.fixture.json` (session `e2e-copilotsplit2933`, chat spans `…_2` user-text + tool-call / `…_4` tool-response + assistant-text, `execute_tool view` `…_3` inside `…_2`'s window) → graph renders exactly ONE node `agent-e2e-copilotsplit2933_4` with `USER —`, RESPONSE `fredo-copilot-2933-sentinel`, and no `TOOLS` section. Also reproduces with the real CLI drive (`3736fe04-…`) and with the committed ST-5 fixture (`e2e-copilot2933`).
  - **Rows are all present and correct** (`chat_rows` `…_2`/`…_3`, `tool_use_rows` `…_1` = `view`, `agent_session_rows` `…_4`; all `provider = copilot_cli`) — this is a rendering/linking gap, not a capture gap. That is why `copilot-capture` F-1..F-11 and R-1..R-5 are PASS while this consumer assertion fails.
  - Evidence: task-panel frame https://github.com/user-attachments/assets/e62e732b-4175-4929-a9ec-b91febae5e2b (real session, USER `—`, no TOOLS) and the deterministic repro https://github.com/user-attachments/assets/f1bd00be-eee2-416a-a6e5-73c07e3d3484 ; OpenCode baseline (USER + `── TOOLS (N) ──` present) https://github.com/user-attachments/assets/b122d065-5cdf-4b4f-bdc7-97346c6bb2e5 .
  - **PASS (round 2, 2026-09-24, `spec/2933 @ c96ab4dd` — ST-3R capture-side carry; consumer untouched).** Deterministic replay of the committed split-turn producer (`bun .opencode/scripts/inject-otlp-fixture.ts --copilot --fixture .opencode/scripts/copilot-turn-split.fixture.json`, session `e2e-copilotsplit2933`): Mission Monitor lists the session ("Read hello.txt and reply with i…") and the selected graph renders the single continuation node `agent-e2e-copilotsplit2933_4` (`gpt-4o`) with **`── USER ──` = "Read hello.txt and reply with its exact contents."** AND **`── TOOLS (1) ──`** (item `view`, outcome dot, `10ms`), plus `── RESPONSE ──` = `fredo-copilot-2933-sentinel` and TOKEN USAGE INPUT 10,241 / OUTPUT 14 / TOTAL 10,255. Session token bar INPUT 20,425 / OUTPUT 53 / TOTAL 20,478 / TOTAL MESSAGES 2. Both round-1 symptoms (`USER —`, missing `TOOLS`) are resolved. Rows agree: `chat_rows …_2` and `…_4` both carry the prompt, `…_4` the sentinel reply; `tool_use_rows …_3` `view` success; all `provider = copilot_cli`. Live delivery of the continuation (`fredo-stream-event` insert for `…_4`) patch = `{agentReply: "fredo-copilot-2933-sentinel", provider: "copilot_cli", promptTokens: 10241, userMessage: "Read hello.txt and reply with its exact contents."}`, terminal envelope `replayCompleteQueryId` == the registered queryId. No `apps/ui/` file in the spec diff (`git diff --stat origin/main HEAD`) — zero mission-monitor code changes. Frame: [Copilot split-turn chat node — USER prompt + `── TOOLS (1) ──`](https://github.com/user-attachments/assets/78c063ed-999e-41b8-a1a7-55c6da837ee7) ; OpenCode baseline unchanged: [OpenCode agent node — USER + THINKING + `── TOOLS (7) ──`](https://github.com/user-attachments/assets/505d9de3-920a-4660-b968-9a2b5b5bac8a) .
- [x] R-46 (OpenCode rendering unchanged — AC5): existing OpenCode sessions render the same session list, graph nodes, edges, colors and layout as the pre-spec baseline (same corpus). Adding a second provider must not alter node/edge derivation.
  - **PASS (2026-09-24, live).** No `apps/ui/` file is touched by the spec diff (`git diff --stat origin/main HEAD`). The same corpus rendered unchanged: the OpenCode session `ses_f358e9c58ffeCnb7iL44S7rR1s` showed its usual node sets, incl. `agent-…_13` with `USER` + `THINKING` + `── TOOLS (11) ──` + RESPONSE and the SubagentNodes' `INSTRUCTION`/`── TOOLS (38) ──`/`── TOOLS (72) ──` sections (DOM text) — identical to the baseline captured this run.
- [x] R-47 (no provider cross-contamination in derivation): a Copilot session and an OpenCode session in one store are never merged into one list entry / graph; no row's `provider` flips; provider-scoped filtering (if added to the panel) never hides OpenCode rows for an unfiltered view.
  - **PASS.** Live provider census (one store): `open_code` 1742/2297/51, `copilot_cli` 13/7/7, `unknown` 70/239/6 — no flip; the Copilot sessions (`e2e-copilot*`, `3736fe04-…`, `76cc4361-…`) and the OpenCode sessions were listed as separate entries; no provider filter exists in the panel (none added).
- [x] R-48 (contract-trust + no re-render loop): the panel consumes projected row fields directly (no `??` fallback / multi-path extraction added for Copilot, #568); no new `.length`/object-ref `useEffect`/`useMemo` deps; no `Maximum update depth exceeded` after a Copilot session's rows land.
  - **PASS.** No panel code changed; console clean after Copilot rows landed and after subscription start/stop (N-5/S-2).
- [x] R-49 (#523/#509 compositing unchanged): row-level compositing (first-wins stamp, re-key never removes rows, child rows composite under the parent carrying `parentSessionId`/`compositedChildSessionId`) and the `build`/`plan` internal-session exclusion are unchanged by Copilot capture.
  - **PASS.** No change to the relationship registry / compositing path (diff touches only the provider-scoped `invoke_agent` promotion + `copilot_cli` token guards); the OpenCode subagent/compositing rendering in the same corpus is unchanged (R-46 evidence).

## Overlapping prior-feature suites (Spec #2933)

- This spec's capture suite: `.opencode/tests/copilot-capture/` (functional F-1..F-11 + N-1..N-7, regression CR-1..CR-11, smoke S-1..S-12).
- `rtdb-provider-attribution` R-1..R-9 — provider vocabulary/resolution the Copilot rows use.
- Unaffected mission-monitor legs above run as-is (graph/list/tool-detail/latency invariants).

---

# Mission Monitor — Regression Baseline (Spec #2945 — every supported agent CLI in one view, each labeled with its CLI)

> Adding a second CLI's sessions to the list and a per-session CLI label must NOT change any existing OpenCode rendering or any mission-monitor behavior. Every invariant below is a FAIL if the spec branch changes it. Run on every testing phase that touches mission-monitor or the row pipeline.

## Must NOT change (regression invariants) — Spec #2945

- [ ] R-50 (AC-4, OpenCode rendering unchanged): an OpenCode session renders the SAME session list entry, graph nodes/edges/layout/colors, `── TOOLS (N) ──` section, token figures (INPUT/OUTPUT/TOTAL/TOTAL MESSAGES) and session name as the pre-spec baseline (same corpus). Compare node/edge sets + titles against a pre-spec capture.
- [ ] R-51 (AC-4, names/rename/delete unchanged): `deriveDisplayName` (custom > derived > label), rename persistence and delete/tombstone behavior are unchanged for OpenCode sessions; a Copilot session present in the same store does not alter an OpenCode session's name, rename, or delete.
- [ ] R-52 (no session merge/cross-contamination): a Copilot session and an OpenCode session in one store are never merged into one list entry / graph; no row's `provider` flips; provider-scoped filtering (if added) never hides OpenCode rows for an unfiltered view (extends #2933 R-47).
- [ ] R-53 (provider attribution contract unchanged): the `provider` column on `chat_rows`/`tool_use_rows`/`agent_session_rows` and the single shared `resolve_provider_token` (`rtdb/attrs.rs`, NFR-6) are unchanged; the label reads the row's `provider` — never `telemetry_spans.provider` (mixed model-provider precedence is out of scope). No new extraction path introduced (extends `rtdb-provider-attribution` R-3/R-6).
- [ ] R-54 (contract-trust): the UI reads the projected typed `provider`/label field directly — no `??` fallback chains, multi-path lookups, text filtering, or v1 hydration reintroduced (#568 cleanup not regressed). The single legitimate fallback is the explicit non-blank fallback for absent/unrecognized providers (AC-2).
- [ ] R-55 (list qualification unchanged): the renderable-agent-activity qualification (shared predicate, #2896) is unchanged; a listed OpenCode session still renders ≥1 node once its rows land and no unlisted-but-landed session renders ≥1 node; a legitimate transient (just-started / rows landing) is still listed and resolves (G-074).
- [ ] R-56 (ingest/classification + row-store semantics unchanged): the IngestClassifier mappings + canonical extract rules are unchanged (cross-check `telemetry_spans`/row counts + shape at the same instant); `insert` spread-merges, `update` is seq-guarded, `remove` only from retention eviction (`StreamContext.tsx`).
- [ ] R-57 (#523 compositing + #509 subagent filter unchanged): the relationship registry first-wins stamp persists, a re-key never removes rows, child rows composite under the parent carrying `parentSessionId`/`compositedChildSessionId`; `build`/`plan` internal tool-execution sessions stay excluded from list + graph; user-requested @-subagent dispatches still render SubagentNodes.
- [ ] R-58 (no re-render loop, #523): epoch-based recomputation; no `.length`/newly-created-object `useEffect`/`useMemo` deps added; no `Maximum update depth exceeded` after a Copilot session's rows land or on selection switch.
- [ ] R-59 (theming + no cross-feature imports): no hardcoded hex/rgba or invalid `var(--token)NN` introduced by the label; all colors via semantic tokens → CSS vars → `tint()`/`color-mix()`; no new cross-feature import introduced.
- [ ] R-60 (list first-paint/latency unchanged): the #2896 first-paint/list latency budget is preserved — provider labeling must not add a round-trip or a history scan (cross-check N-23/N-24).

## Overlapping prior-feature suites (Spec #2945)

- This spec's functional suite: `.opencode/tests/mission-monitor/functional.md` F-46..F-53 and N-23..N-26.
- `.opencode/tests/copilot-capture/` — the capture-side suite that produces the Copilot rows this spec consumes (incl. the split-turn producer); run its regression legs unchanged.
- `.opencode/tests/rtdb-provider-attribution/` — the `provider` column + `resolve_provider_token` the CLI label depends on; run R-1..R-9 unchanged.
- `mission-monitor` R-45..R-49 (#2933 Copilot provider coexistence) — run as the direct precedence for this spec's AC-1/AC-2/AC-4.
- `mission-monitor` R-33..R-44 (#2896 feature-owned realtime data layer) — run the unaffected legs; the label must not regress first-paint/list behavior.
