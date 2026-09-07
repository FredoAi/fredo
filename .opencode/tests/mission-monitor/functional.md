# Mission Monitor — Functional tests

> Feature domain: `mission-monitor`. QA-authored; executed + expanded by the
> Tester. This suite covers the USER-VISIBLE functional behavior (spec #2835 is a
> perf regression, so the functional surface must be IDENTICAL before/after the
> fix — these pin the behavior that must NOT change).
>
> Mapping: R-1/R-4 (also see the QA Plan F-17/F-24). The unit-level functional
> gates live in `apps/ui/src/features/mission-monitor/{hooks,lib}/__tests__/`
> (`buildGraph.test.ts`, `rowDerivation.test.ts`, `corpusParity.test.ts`,
> `useMissionMonitor.realCorpus.test.ts`, `layout.chain-parity.test.ts`).

## F-01 Session list renders from the shared row store
- **Given** a non-empty RTDB snapshot, **when** Mission Monitor opens, **then**
  the drawer lists every session that renders ≥1 graph node via the single
  shared renderability rule (`deriveRenderableSessions`), sorted newest-first.
- **Edge**: empty DB → the tokenized EmptyState (never a spinner on a genuinely
  empty run); a session with rows but no renderable node is NOT listed.

## F-02 Graph renders the SELECTED session only
- **Given** a selected session, **when** it owns chat/tool rows, **then** the
  canvas emits exactly its chat chain + its SubagentNode companion columns (and
  nested subagent cards for a multi-hop delegation), and NO other session's
  nodes (session-scoped emission gates).
- **Invariant**: selecting a different session rebuilds the graph for THAT
  session only — the rebuild is bounded by the selected session's rows
  (R-2.c), never a recompute over every session in the store.

## F-03 Session token bar figures (R-1.1)
- **Given** a selected session, **then** the bar shows the five-way token
  families (Input/Cache/Reasoning/Output/Total) + estimated cost (parent +
  subagent shares) + total messages, byte-exact per `computeSessionMetrics` /
  `computeSubagentTokenTotals` / `computeSubagentCostTotals`.

## F-04 Detail panel (double-click, scoped tool view)
- **Given** a node, **when** double-clicked, **then** the DetailPanel opens for
  THAT node; a tool accordion item double-click opens the scoped tool view.
- **Edge**: single-click NEVER opens; a failed call shows the Reason/error row.

## F-05 Session actions (select / rename / delete / auto-follow)
- Rename persists via `saveCustomName` (atomic `featureStoreUpdate`) and
  re-renders immediately; delete removes from rows + persists tombstone
  (no resurrection on replay); a newly started session auto-follows unless the
  user explicitly picked a row (`userPickedRef`).

## F-06 Session metrics / auto-fit / auto-center
- The session-activation auto-fit (AC-13) fires exactly once per activation
  after the full node set is measured; the camera never fights the user's manual
  pan/zoom on streaming N→N+M arrivals; the newest chat node auto-centers.

## F-07 First render is prompt (R-1 / AC1 — the perf goal)
- **Given** a non-empty snapshot, **when** Mission Monitor opens from a cold
  webview, **then** the session list populates within the AC1 budget
  (≤1,000 ms) and `ready` settles within ≤1,500 ms — no multi-second blank.
- **Cross-check (F-18)**: AFTER session-list Δ ≤ BEFORE (`main`) Δ, with the
  numbers recorded.

*Authored by Developer (sub-task 7)*
