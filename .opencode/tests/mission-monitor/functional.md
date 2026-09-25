# Mission Monitor — Functional Test Cases (Spec #2791 — Ghost sessions)

> Durable functional suite (feature domain `mission-monitor`). One `- [ ]` case per requirement; observable expected outcome per case.
>
> **Evidence policy: LIVE** — the exit gate / audit fail-closed unless the tester's Evidence references `telemetry_spans` (a live-query result) for the emission/observability ACs. A static-only PASS is a FALSE PASS.
>
> Fixture doctrine (G-073/G-076/G-080): drive via Fredo's Run CLI feature (free model, minimal session trees, unique marker in the FIRST prompt); assert DOM only on COMPLETED sessions whose telemetry agrees at the same instant; never run the `opencode` binary from a shell.

## Ghost-session fix (AC1 / AC2 / AC3)

- [x] F-1 (REQ-1, PASS 2026-09-02 #2791): Drive a normal opencode session via Run CLI (free model, minimal tree, marker in first prompt). Wait for the telemetry store to confirm its rows landed, then select it in Mission Monitor's session list and snapshot the canvas (DOM + screenshot).
  - EXPECTED: canvas renders ≥1 graph node (ChatNode / SubagentNode / embedded `── TOOLS (N) ──` section); DOM snapshot shows the node set AND a `telemetry_spans` query returns the landed chat/tool/agent-session rows for that session at the same instant (G-073.3).
  - Edge: (d) normal session graph renders normally, unaffected.
- [x] F-2 (REQ-1a, PASS 2026-09-02 #2791): Select a listed session that lands zero visible graph nodes (ghost / transitional / subagent-only).
  - EXPECTED: canvas renders the explicit explanatory state (plain-language message stating no graph content is available); DOM snapshot shows the explanatory-state element AND zero graph nodes. Never a silent blank canvas.
  - Edge: (a) transitional-turn session (landed rows + zero visible nodes) → explanatory state; (b) subagent-only / composited session → explanatory state, never silent blank.
- [x] F-3 (REQ-2, PASS 2026-09-02 #2791): Inspect the session list for a session with landed telemetry rows + zero rendered graph nodes.
  - EXPECTED: the session is EITHER excluded from the list OR, if listed, surfaces the explanatory state. It is NOT presented as an ordinary session with a blank canvas.
  - Edge: (e) one ghost among many listed sessions → only the ghost shows the state (or is excluded); others unaffected.
- [x] F-4 (REQ-3, PASS 2026-09-02 #2791): Select a session immediately after launch before its first spans land (zero nodes, zero landed spans).
  - EXPECTED: the transient empty state still renders (zero nodes + empty-state message), NOT replaced by the ghost explanatory state. After spans land, resolves to content-or-explanation. Legitimate transient is not regressed (G-074).
  - Edge: (c) zero-landed-span transient not regressed; must NOT be a silent blank.
- [x] F-5 (REQ-3a, PASS 2026-09-02 #2791): For a landing-in-progress session, observe zero spans → landed rows → content-or-explanation.
  - EXPECTED: state stable and observable at each stage; no flicker, no silent-blank window at the landed-rows stage. Cross-check DOM vs `telemetry_spans` at the same instant (G-073.3).
- [x] F-6 (REQ-3b, PASS 2026-09-02 #2791): Drive two sequential fixtures; confirm each resolves consistently.
  - EXPECTED: each session consistently resolves to content-or-explanation per its landed rows at the same instant; no session flips between blank / ghost / content without a corresponding telemetry change.
  - Edge: G-076 marker-resolved session ids; subagents joined via the parent task-span child-session attribute + the child's parent-relationship attribute.

## Non-functional (NFR-1 / NFR-2 / NFR-3)

- [x] N-1 (NFR-1, PASS 2026-09-02 #2791): With several listed sessions, verify the session-list derivation is a single map pass (no per-session rescan) and the list does not lag/block.
  - EXPECTED: list renders within normal time; no O(n²) blocking; code inspection confirms a single map pass (no re-deriving the graph per listed session).
  - Regression risk: a fix that re-derives the graph per listed session violates NFR-1 → FAIL.
- [x] N-2 (NFR-2, PASS 2026-09-02 #2791): After each interaction, read the webview JS console (`tauri_read_logs source="console"`).
  - EXPECTED: no `Error:` / `Uncaught` / `Maximum update depth exceeded` / re-render-loop symptom; recomputation is monotonic-epoch based (per #523).
  - Regression risk (#523): a `useEffect` depending on array `.length` or newly-created object refs → FAIL.
- [x] N-3 (NFR-3, PASS 2026-09-02 #2791): Verify no graph-node layout/color/edge change, no ingestion/storage/classification change, no v1 hydration/fallback reintroduced.
  - EXPECTED: graph renders with pre-fix node layout/colors/edges across all sessions; `useEventRows` is the only row source; no `??` fallback chains / multi-path lookups reintroduced.
  - Regression risk (Contract-Trust Cleanup): no defensive fallback extraction / event-level rewrite.

---

# Mission Monitor — Functional Test Cases (Spec #2792 — Tool-failure reason in detail view)

> Durable functional suite (feature domain `mission-monitor`), extended from Spec #2791. One `- [ ]` case per requirement; observable expected outcome per case.
>
> **Evidence policy: LIVE** — the exit gate / audit fail-closed unless the tester's Evidence references `telemetry_spans` (a live-query result) for the emission/observability ACs. A static-only PASS is a FALSE PASS.
>
> Fixture doctrine (G-073/G-076/G-080): drive via Fredo's Run CLI feature (free model, minimal session trees, unique marker in the FIRST prompt); assert DOM only on COMPLETED sessions whose telemetry agrees at the same instant; never run the `opencode` binary from a shell. Cross-check the DOM-rendered reason/status against `telemetry_spans`/`tool_use_rows` at the same instant (G-073.3).

## Tool-failure reason (AC1 / AC2 / AC3 / AC4)

- [ ] F-7 (AR-1, AC-1): Drive a live opencode session via Run CLI (free model, minimal tree, marker in first prompt) with a tool call that FAILS and surfaces a captured `tool.error` (invalid argument / permission denial / provider error). Wait for landing, select the session, open the tool detail view from the failed call in the chat node's `── TOOLS (N) ──` list. Cross-check DOM + `telemetry_spans`/`tool_use_rows` at the same instant.
  - EXPECTED: detail view shows the "Failed" status AND a failure-reason row carrying the captured `tool.error` verbatim; a `telemetry_spans`/`tool_use_rows` query at the same instant returns the row whose `toolError` equals the displayed text.
  - Edge: long / whitespace-heavy / special-char reason text renders as text and wraps/clips without layout break (`wordBreak: break-all` already on detail values); multiple failed tools in one session each show their own reason; an in-progress tool (no end, no outcome) shows In progress and no reason row.
- [ ] F-8 (AR-2, AC-2): In the same drive, open the SAME detail view for a failed tool in a SUBAGENT node's tools list (a user-requested @-subagent, NOT `build`/`plan`). Cross-check DOM + `telemetry_spans`/`tool_use_rows` at the same instant.
  - EXPECTED: "Failed" + the same failure reason as the chat-node path — location-independent (both ChatNode.tsx:198 and SubagentNode.tsx:343 open the same `ToolCallDetailView`).
  - Edge: a subagent with no failed tool shows no error surface; the subagent tool's reason matches that row's `toolError` (not the parent's); a `build`/`plan` internal tool-execution session stays excluded (no spurious SubagentNode).
- [ ] F-9 (AR-3, AC-3): Produce a failed tool call with NO captured error text (`success === false`, empty/absent `error`). Prefer a real drive (sandbox/provider-layer failure that yields `success:false` with no string error); if not producible, inject via `fredo emit` a tool_use event carrying `success:false` + empty error and confirm the landed row via `telemetry_spans`/`tool_use_rows` — **real path first, injection as a documented fallback, never the reverse** (mock-vs-real divergence rule). Open the detail view for that call.
  - EXPECTED: a CLEAR "Failed" status (never reads as succeeded) AND an explicit absent-reason placeholder (a literal visible placeholder, never a silently blank reason area); `getToolCallOutcome` still returns `error` for `success===false` even with no error string.
  - Edge: `toolError` empty string / null / undefined all resolve to the same explicit placeholder; placeholder uses theme tokens (never hardcoded hex); placeholder never carries success styling/color.
- [ ] F-10 (AR-4, AC-4): In the same drive, open the detail view for a SUCCEEDED tool call (a tool that returned output normally). Cross-check DOM + `telemetry_spans`/`tool_use_rows` at the same instant.
  - EXPECTED: no error/reason row for the succeeded call — the failure surface appears ONLY for failed calls; Status=Succeeded, Duration, Input, Output render as before (no regression to the success path).
  - Edge: a mixed session (some succeeded, some failed) shows the correct per-tool outcome; a succeeded tool whose output merely mentions "error"/"fail" is NOT rendered failed (`call.error` empty, `success !== false`).
- [ ] F-11 (CT-1, contract-trust): Verify the displayed reason equals the projected single-path `ToolCallSummary.error` / `ToolUseRow.toolError` (rowDerivation.ts:276) — not a fallback/multi-path/`??` chain or an output-driven derivation.
  - EXPECTED: reason byte-matches `summary.error`; code inspection confirms ONE extraction path; a tool with non-empty `error` AND output text mentioning "error" still derives the reason from `summary.error` only (never from output heuristics).
  - Regression risk (Contract-Trust Cleanup): a `??` fallback chain or multi-path lookup reintroduced is a FAIL.

## Non-functional (NFR-1 / NFR-2)

- [ ] N-4 (NFR-1, theme): Visual check of the reason row + absent-reason placeholder across light / dark / user-accent overrides.
  - EXPECTED: reason row/placeholder use theme tokens (existing `--status-error` family → `status.*`/`bg.*`/`fg.*`/`accent.*` semantic tokens in system.ts → CSS vars); NO hardcoded hex/rgba; no invalid `var(--token)NN` alpha-append (use `color-mix()`/`tint()`).
  - Regression risk: a hardcoded hex/rgba reason row or a fixed-color placeholder that ignores the user accent is a FAIL.
- [ ] N-5 (NFR-2, no re-render loop): After each open/close of the detail view and each selection switch, read the webview JS console (`tauri_read_logs source="console"`).
  - EXPECTED: no `Error:` / `Uncaught` / `Maximum update depth exceeded` / re-render-loop symptom; recomputation is row-store epoch based (per #523) — no `.length`/newly-created object-ref `useEffect`/`useMemo` deps added.
  - Regression risk (#523): a `useEffect` depending on array `.length` or the target `call` object identity → FAIL.

---

# Mission Monitor — Functional Test Cases (Spec #2795 — Ghost sessions: remove the #2791 message, list real sessions only)

> Durable functional suite (feature domain `mission-monitor`), extended from Spec #2791/#2792. One `- [ ]` case per AC (AC1–AC5); observable expected outcome per case.
>
> **Evidence policy: LIVE** — the exit gate / audit fail-closed unless the tester's Evidence references `telemetry_spans` (a live-query result) for the emission/observability ACs. A static-only PASS is a FALSE PASS.
>
> Fixture doctrine (G-073/G-076/G-080): drive via Fredo's Run CLI feature (free model, minimal session trees, unique marker in the FIRST prompt); assert DOM only on COMPLETED sessions whose telemetry agrees at the same instant; never run the `opencode` binary from a shell. Verify ghost sources against real telemetry before asserting them as fact (G-028/G-088). The #2791 ghost-EXPLANATORY-state expectations (F-2/F-3/F-4, R-1, E-2) are INVERTED by #2795 — the "No graph content for this session" message must NOT appear and a ghost session must NOT be listed.

## Ghost-session follow-up (AC1 / AC2 / AC3 / AC4 / AC5)

- [ ] F-12 (AC-1): Drive a ghost-class session (landed rows + zero graph nodes; confirm the exact ghost source via `telemetry_spans` — do NOT assume `build`/`plan`/transitional/composited as fact). Select it. DOM snapshot + screenshot + grep for the literal #2791 copy in the whole DOM and console.
  - EXPECTED: the delivered UI NEVER renders "No graph content for this session" NOR any empty-diagram/explained placeholder; zero occurrences of the literal copy anywhere; never a silent blank canvas (whether or not the session is listed — it must NOT be listed per AC-2).
  - Edge: (a) a deliberately non-qualifying session is never presented as an explained OR silent blank; (b) theme tokens only in any residual state.
- [ ] F-13 (AC-2): After the drive, enumerate every sidebar session; for each, select it and snapshot the canvas. Cross-check `telemetry_spans` at the same instant (G-073.3).
  - EXPECTED: sidebar lists ONLY sessions that render ≥1 node; every listed session's canvas renders ≥1 node (ChatNode / SubagentNode / `── TOOLS (N) ──`) once its rows have landed; a session with landed rows + zero nodes is NOT listed; no listed session presents a blank canvas once rows landed.
  - Edge: (c) ghost among many listed — only real sessions listed; (d) subagent-only / composited-child / transitional rows as their OWN sidebar entry absent (verify against real telemetry); (e) a listed session whose rows are still streaming is exempt from the ≥1-node check across the landing window (covered by F-15).
- [ ] F-14 (AC-3): At a fixed instant compute (a) the sessionIds in the sidebar and (b) the sessionIds for which the graph renders ≥1 node. Cross-check `telemetry_spans` at that instant; then code-inspect the qualification rule.
  - EXPECTED: (a) == (b) when rows have landed; a listed session always renders ≥1 node, an unlisted-but-landed session renders zero nodes. Code inspection confirms list qualification and graph-node emission consume the SAME rule (one shared predicate/function).
  - Edge: (f) same-instant drift; (g) a session whose rows are still streaming is a transient (F-15), not a disagreement; (h) retention-eviction boundary.
- [ ] F-15 (AC-4): (a) Drive a normal session rendering ≥1 node — confirm it stays listed at all times (never dropped across selection/search/deletion of others). (b) Launch a fresh session; BEFORE its rows land confirm it still appears in the sidebar; then wait for rows to land and confirm the canvas renders ≥1 node.
  - EXPECTED: a session rendering ≥1 node is NEVER dropped; a just-started session whose rows are still landing still appears and resolves to content once rows land — a legitimate transient (G-074), never a ghost, never a silent blank at the landed-rows stage, never dropped.
  - Edge: (i) zero-rows → landed-rows → content stages stable with `telemetry_spans` at each instant; (j) switching selection mid-stream never drops a real session; (k) only a user-deleted session is not listed (anti-resurrection).
- [ ] F-16 (AC-5, live drive — human's chain VERBATIM): Start a ROOT session, send as FIRST prompt exactly `hey can you call SI so can ask Architect for a joke, both should use print in powerbash`; expect the SI → Architect subagent chain, EACH printing via PowerShell; then interact a little with the session. Throughout, assert at NO point does a listed-but-nodeless (ghost) session appear, and NO real session is hidden. Cross-check `telemetry_spans` at the SAME instant as each observation.
  - EXPECTED: root session renders ≥1 node (ChatNode + SubagentNode for the SI→Architect chain); sidebar NEVER lists a session rendering zero nodes at any observed instant; every real session (root + the genuine user @-subagent) is listed; `build`/`plan` internal tool-execution sessions don't surface as separate sessions or spurious SubagentNodes (Spec #509 filter retained).
  - Edge: (l) interleave rapid sidebar toggles during streaming; (m) the SI→Architect `task` tool call composites under the parent root (first-wins) while internal sessions are excluded; (n) verify against real telemetry which sessionIds exist and which render nodes (G-028/G-088).

## Non-functional #2795 (NFR-1 / NFR-2 / NFR-3 / NFR-4)

- [ ] N-6 (NFR-1, list qualification): verify the shared qualification rule is a single map pass / memoized predicate — NO per-listed-session graph re-derive (O(n²) blocking); recomputes on the row-store epoch, never map identity/size.
  - EXPECTED: list qualifies/renders within normal time across a high session-count; code inspection confirms ONE shared predicate (no re-deriving the graph per listed session).
  - Regression risk: a fix that re-derives the graph per listed session violates NFR-1 → FAIL.
- [ ] N-7 (NFR-2, no re-render loop): after each selection toggle across F-12..F-16, read the webview JS console (`tauri_read_logs source="console"`).
  - EXPECTED: no `Error:` / `Uncaught` / `Maximum update depth exceeded`; recomputation is epoch-based (per #523) — no `.length`/object-ref `useEffect`/`useMemo` deps added.
  - Regression risk (#523): a `useEffect` depending on array `.length` or newly-created object refs → FAIL.
- [ ] N-8 (NFR-3, contract-trust): verify the shared qualification rule consumes the projected single-path node/node-set derived from rows — NO `??` fallback chains / multi-path lookups / event-level rewrite / v1 hydration reintroduced.
  - EXPECTED: code inspection confirms ONE qualification path shared by list + graph (no defensive fallback extraction).
- [ ] N-9 (NFR-4, theme): visual check of any state left after deleting the explanatory state (spinner empty state, "Select a session" hint) across light/dark/user-accent.
  - EXPECTED: theme tokens only; no hardcoded hex/rgba; no invalid `var(--token)NN` alpha-append (use `color-mix()`/`tint()`).

---

# Mission Monitor — Functional Test Cases (Spec #2835 — RTDB row-pipeline performance regression)

> Durable functional suite (feature domain `mission-monitor`), extended for Spec #2835 (research-first perf regression: delayed first render, then slowdown/freeze). One `- [ ]` case per AC/REQ (R-1..R-4 = AC1..AC4); observable + MEASURED expected outcome per case. Marks `unknown` until executed by the Tester.
>
> **Evidence policy: LIVE** — the exit gate / audit fail-closed unless the tester's Evidence references `telemetry_spans` (a live-query result) and/or rendered-webview live receipts (DOM snapshots, console logs, IPC captures, JS-API metrics). A static-only PASS is a FALSE PASS. Root cause is UNKNOWN (research-first) — the BEFORE numbers must be measured against the buggy `main` baseline, never assumed.
>
> Fixture doctrine (G-073/G-076/G-080): drive via Fredo's Run CLI feature (free model, minimal session trees, unique marker in the FIRST prompt); never run the `opencode` binary from a shell. Sustained workload = a live opencode session streaming continuously for ≥ 60s with periodic selection toggles. Burst/large-replay = a high session-count corpus (≥ 30 sessions, ≥ a few hundred rows) replayed into the RTDB.

## First-render latency (R-1 / AC-1)

- [ ] F-17 (R-1, AC-1, `unknown`): From a cold webview, open Mission Monitor. Record `performance.now()` immediately before triggering the feature mount, then again when the session-list first row renders (`tauri_webview_wait_for` on a session-list/row selector); compute Δ. Repeat for a zero-session empty DB.
  - EXPECTED: populated session-list Δ ≤ **500 ms** and empty-state Δ ≤ **300 ms** (budget pending Architect confirmation — QA-1); no "~seconds" stall. Record the exact ms in the verdict.
  - Edge: empty DB; large-replay first-open; cold vs warm webview; measure the Δ against the BEFORE baseline (F-18), not an absolute if the buggy baseline is slower.
- [ ] F-18 (R-1, AC-1, `unknown`): Capture F-17's Δ against `main` (buggy baseline, BEFORE) and against `spec/2835` (AFTER). Report both numbers + Δ.
  - EXPECTED: AFTER Δ ≤ BEFORE Δ (a real improvement) AND within the AC-1 budget. A "renders faster" with no numbers is a FAIL.
  - Edge: same workload both runs; same window size; repeat 3× take median; note GC/compaction noise.

## Sustained-run / no-degradation (R-2 / AC-2)

- [ ] F-19 (R-2, AC-2, `unknown`): With Mission Monitor open and the row stream active (live session streaming ≥ 60s + selection toggles), sample `performance.memory.usedJSHeapSize` via `tauri_webview_execute_js` at t0 (mount), t1 (+30s), t2 (+60s).
  - EXPECTED: heap plateaus after GC (t2 ≈ t1, not t2 ≫ t1); growth t0→t2 ≤ **50 MB** (budget pending — QA-1); app responsive (a button click registers) at every sample; `telemetry_spans` row count bounded (ingest not leaking).
  - Edge: read-only session (no streaming); high-session-count list; a GC pause read as a dip; server-side flood vs frontend leak (cross-check `telemetry_spans`).
- [ ] F-20 (R-2, AC-2, `unknown`): Read `tauri_read_logs source="console"` repeatedly through F-19 and after every interaction.
  - EXPECTED: no `Maximum update depth exceeded`, no `Uncaught`, no infinite re-render-loop console symptom; recomputation epoch-based (per #523) — no `.length`/object-ref `useEffect`/`useMemo` deps added.
  - Edge: a one-off warning is tracked but not a FAIL; a repeated identical re-render trace is a FAIL.
- [ ] F-21 (R-2, AC-2, `unknown`): Use `tauri_ipc_monitor` to capture `fredo-stream-event` RowDeliveryBatch emissions over a fixed window during the sustained workload; count emitted batches/envelopes.
  - EXPECTED: batch emissions are coalesced/rate-bound (track the data rate, NOT a run-away per-render loop); no storm of identical/duplicated envelopes; no max-throughput flood (RTDB_MAX_EMISSION_BATCH=512) absent matching data growth.
  - Edge: a large-replay burst is a legitimate transient; per-query replay drains are finite.
- [ ] F-22 (R-2, AC-2, `unknown`): Cross-check the frontend live-row count against `telemetry_spans`/`chat_rows`/`tool_use_rows` counts at the same instant.
  - EXPECTED: live-row count ≈ landed telemetry row count (no runaway growth beyond landed rows); `insert` spread-merge semantics not violated (no per-render duplicate re-add).
  - Edge: retention eviction legitimately shrinks the store (do not read the eviction-only `remove` path as a leak).

## Profile evidence before/after (R-3 / AC-3)

- [ ] F-23 (R-3, AC-3, `unknown`): Produce a literal Before|After|Δ evidence table: (a) first-render latency (F-17/18), (b) long-task count over a 30s window (`performance.getEntriesByType('longtask')`), (c) JS heap growth (F-19), (d) session-list population time, (e) emitted batch count (F-21). Attach screenshots of each measurement + a `telemetry_spans` query at the same instant.
  - EXPECTED: the verdict's Evidence carries a numerical Before|After|Δ table (a bare "it's faster"/"notably improved" with no numbers = **FAIL**); each AFTER row meets its AC threshold; a measured improvement over the buggy baseline; root cause(s) attributable to the AC suspects.
  - Edge: Rust/flush-path numbers are NOT webview-readable (must come from the Architect/Developer — QA-4); CDP Performance recorder may not be reachable through the bridge (QA-3).

## Regression — window-manager / launcher / theming (R-4 / AC-4)

- [ ] F-24 (R-4, AC-4, `unknown`): (a) `tauri_manage_window` list/resize/focus/min/max succeed. (b) Run CLI launcher reachable (`button[aria-label="Run CLI"]`), `run-cli-terminal` launches, `write_pty_input` submits. (c) Sessions list + graph + tool-detail render with theme tokens across light/dark/user-accent.
  - EXPECTED: all actions succeed with no console errors; theming renders from semantic tokens/CSS vars only (no hardcoded hex/rgba, no invalid `var(--token)NN` alpha-append); window-manager + launcher identical to pre-fix.
  - Edge: the perf fix accidentally alters a window/launcher property or slips in a theming change.

## Non-functional — #2835 (memory / latency / theme / contract-trust / row-path)

- [ ] N-10 (NFR-1, memory): `performance.memory.usedJSHeapSize` plateaus over the sustained window (no monotonic unbounded growth).
  - EXPECTED: bounded heap; plateau after GC; no growth proportional to time/data that never settles.
  - Regression risk: an unbounded live-row store or per-render re-insert → FAIL.
- [ ] N-11 (NFR-2, latency): first-render + interaction latency within the budgets (AC-1 / QA-1); no O(n²) per-render identity churn.
  - EXPECTED: session list + graph derivation stays a single map pass / memoized on the row-store epoch.
- [ ] N-12 (NFR-3, theme): theming tokens preserved across the perf fix — no hardcoded hex/rgba or invalid `var(--token)NN` introduced.
- [ ] N-13 (NFR-4, IPC/coalescing): no runaway flush/batch flood (F-21); the ~5ms coalescing window + `RTDB_MAX_EMISSION_BATCH=512` chunking still function.
- [ ] N-14 (NFR-5, contract-trust): the perf fix must NOT reintroduce defensive fallback extraction / event-level rewrite / v1 hydration — single-path extraction preserved (Spec #568 cleanup not regressed).
- [ ] N-15 (NFR-6, RTDB row path unchanged): the RTDB row-pipeline mappings + ingest classification are unchanged — the perf fix touches only the render/flush/coalescing path, not what rows are produced (cross-check `telemetry_spans`).

---

# Mission Monitor — Functional Test Cases (Spec #2896 — feature-owned realtime data layer)

> Durable functional suite (feature domain `mission-monitor`), extended from #2791/#2792/#2795/#2835/#2893. One `- [ ]` case per requirement; observable expected outcome per case.
>
> **Evidence policy: LIVE** — the exit gate / audit fail-closed unless the tester's Evidence references `telemetry_spans` (a live-query result) and/or rendered-webview live receipts (DOM snapshots, screenshots, console logs, IPC captures). A static-only PASS is a FALSE PASS.
>
> **Bound-literal confirmation (G-184/A-18):** the Architect's bound literals (A-1..A-18) are substituted below — commands `feature_data_declare|read|watch|unwatch|write|delete`; channel `"fredo-stream-event"` carrying `{"featureBatch": FeatureRowNotification[]}`; watch scope `{kind:'table'}|{kind:'record', key}|{kind:'query', where}` + `fields` narrowing + `initial:true`; read returns `{ version, rows, retention: { maxRows, ttlDays } }`; probe surface A-12 (`tauri_ipc_execute_command` + `tauri_ipc_monitor`/`tauri_ipc_get_captured` + Dev Mode → Feature Data feed); eviction lever A-6 (`feature_data_delete` or cap + restart); retention knobs `feature_data.default_max_rows`/`feature_data.default_retention_days` (MM `sessions` `maxRows: 500`, no TTL); latency bound A-14 (≤ 250 ms absolute AND ≤ 2.0× small-corpus Δ, 100 ms floor); failure signal `error: string | null` (A-13). No placeholder remains.
>
> Fixture doctrine (G-073/G-076/G-080): drive via Fredo's Run CLI feature (free model, minimal trees, unique marker in the FIRST prompt); assert DOM only on completed sessions whose telemetry agrees at the same instant; never run the `opencode` binary from a shell. Unique `e2e-<guid8>` session ids for `fredo emit`; cross-check `telemetry_spans`/row store at the same instant (G-073.3).

## Read-watch feature data (REQ-1..REQ-5 ↔ AC1..AC5)

- [ ] F-25 (REQ-1, AC-1, **FAIL 2026-09-19 #2896** — declared store empty; root cause in `realtime-data/functional.md` F-19): Cold read with NO watch open — restart the app; before opening any session watch, `feature_data_read` the session scope (`ref: {source:'feature', featureId:'mission-monitor', table:'sessions'}`); cross-check `telemetry_spans`/the RTDB row store at the same instant.
  - EXPECTED: the read returns the persisted CURRENT rows and agrees with the last change notification for the same scope (same current values, no older snapshot presented as current). Never a persisted-history read presented as "0 sessions".
  - Edge: empty DB → empty result, not an error; a value changed twice → read returns the final value; rapid consecutive mutations → read never older than the last notification.
- [ ] F-26 (REQ-1, AC-1): Read-only consumer (no watch), drive a mutation on the real channel (`fredo emit` unique session or live drive), then `feature_data_read`.
  - EXPECTED: the read reflects the mutation; the changed field equals the last-notified current value; a post-mutation read is never stale.
  - Edge: mutation during an in-flight read; a no-op write produces no phantom change; two mutations in one coalescing window.
- [ ] F-27 (REQ-1, AC-1): Fully restart the app, then first-`feature_data_read` a scope persisted pre-restart with NO post-restart mutation (watches do not auto-resume — A-9).
  - EXPECTED: read returns the persisted post-restart current values, matching the row store / `telemetry_spans` count and max seq at the same instant.
  - Edge: row only in SQLite; row in the write-behind cache at shutdown; row updated in the final pre-restart second.
- [ ] F-28 (REQ-2, AC-2): Register `feature_data_watch` `scope:{kind:'table'}` (session list) plus `scope:{kind:'record', key:[...]}` on session X; mutate a sibling session Y.
  - EXPECTED: the table watch is notified of Y's change (what changed + current value); the record-X watch receives ZERO notifications for Y.
  - Edge: brand-new session; existing-session update; Y and a table-only change in one window.
- [ ] F-29 (REQ-2, AC-2): `feature_data_watch` `scope:{kind:'record', key:[...]}` open on session X; mutate a field of X.
  - EXPECTED: record-X watch notified with what changed + current value; the table watch also notified (record change reaches both).
  - Edge: two fields of X in one mutation; field cleared to null; X mutated twice before delivery.
- [ ] F-30 (REQ-2, AC-2): `feature_data_watch` on sibling fields F1/F2 of session X via `fields` narrowing; mutate F1 only.
  - EXPECTED: F1 watch fires; F2 watch receives ZERO notifications. Probe (A-12): `tauri_ipc_execute_command` drives both `feature_data_watch` calls (captured `watchId`s); `tauri_ipc_monitor` + `tauri_ipc_get_captured` and the Dev Mode → Feature Data feed assert F2's zero deliveries.
  - Edge: then mutate F2 → only F2 fires; both fields in one write → both fire with their own current values; a no-op write fires neither.
- [ ] F-31 (REQ-2, AC-2): With table + record + field watches open, `feature_data_unwatch` only the record watch (`watchIds`); then mutate the record and the table.
  - EXPECTED: the stopped watch delivers nothing further; the table and field watches keep delivering every later change; stopping twice is idempotent.
  - Edge: unsubscribe a never-started watch (no-op); two watches with the same query shape; a pending delivery at stop time is discarded (no post-stop delivery).
- [ ] F-32 (REQ-3, AC-3): Inspect every delivered `featureBatch` notification of a table/record/field mutation.
  - EXPECTED: each notification identifies the changed `key`/`changedFields` AND carries the CURRENT `values` at its `version` — never delta-only, never a pre-change value as current. Cross-check `telemetry_spans`/row store at the same instant.
  - Edge: value changed twice before delivery → notification carries the second (current) value; a `kind:"remove"` notification (`values:null`, `changedFields` = the removed record's known fields) must not assert a current value it no longer has.
- [ ] F-33 (REQ-3, AC-3): Start the watch FIRST, then drive a CONTINUOUS live opencode session (Run CLI) that mutates rows while the watch is open.
  - EXPECTED: every mutation after watch start is delivered — no gap, no dropped change (count matches the mutations visible in `telemetry_spans`/row store at the same instant).
  - Edge: mutation in the same millisecond as watch start; a burst coalesced into ≤1 notification still carrying the current value; watch started mid-replay/drain. REAL PATH (G-130) — a non-streaming fixture cannot verify this.
- [ ] F-34 (REQ-3, AC-3): Mutate a field to V1 then V2 before the notification is observed; then read.
  - EXPECTED: the notification reports V2 as current (never V1-as-current); the post-settle read returns V2.
  - Edge: V2 === V1 (no-op second write); the two writes land in two windows → two notifications, both ending at V2.
- [ ] F-35 (REQ-3, AC-3 — Scenario A): Live-drive session A streaming and selected; switch to a live session B; confirm no further A delivery; then fully restart the app and reopen Mission Monitor.
  - EXPECTED: after the switch, zero A-activity notifications reach the layer (old session watch closed) while B's watch is open and delivering. After restart, every pre-restart session and latest value is present — no missing rows, no duplicates.
  - Edge: switch while A mid-stream; switch back to A; rapid A↔B toggling; restart with a write in flight; a session in both cache and SQLite. REAL PATH (G-088/G-130).
- [ ] F-36 (REQ-4, AC-4, **PARTIAL 2026-09-19 #2896** — declare idempotent, but the legacy physical table is accepted in place of the declared schema): Launch the app twice (and invoke `feature_data_declare` twice in one session) with the same feature declaration.
  - EXPECTED: created when missing, no-op when present — no error, no duplicate table/row, no data loss (inspect the `feature_mission_monitor_*` table(s) read-only).
  - Edge: declaration changed (added column) after creation; creation raced by a read; creation while a watch is open.
- [ ] F-37 (REQ-4, AC-4 — Scenario B, **FAIL 2026-09-19 #2896**): Write rows through the layer (projection + `feature_data_write`; removal via `feature_data_delete` tombstone), fully stop/start the app, then `feature_data_read` without a full history scan.
  - EXPECTED: rows persist and are returned by the first read; updates/deletes survive; no duplicates.
  - Edge: user deletion survives restart (no resurrection); same-session update reflected after restart; torn last write.
- [ ] F-38 (REQ-4, AC-4 — Scenario B, **FAIL 2026-09-19 #2896**): Large stored corpus vs small corpus; open Mission Monitor; measure Δ mount→first rendered session row.
  - ACTUAL: `No sessions yet` + spinner `Waiting for agent activity…` despite 29,503 canonical chat rows / 176 sessions; no first row renders, so no Δ is measurable.
  - EXPECTED: stored sessions appear immediately — no visible "0 sessions"/blank/loading phase once stored sessions exist; open time does not grow with total stored history: large corpus (≥ 3× rows / ≥ 30 sessions) Δ ≤ **250 ms** absolute AND ≤ **2.0×** the small-corpus Δ, with a 100 ms small-corpus floor (A-14). Record raw ms.
  - Edge: cold vs warm webview; empty DB; multi-batch replay drain.
- [x] F-39 (REQ-4, AC-4, **PASS 2026-09-19 #2896**): Two declared feature scopes (`feature_data_declare` with a second `featureId`); write to A, read/watch B. Cross-namespace read refused with the hard named error `feature 'qa2896probe' has not declared table 'sessions'`.
  - EXPECTED: B never receives A's data (zero cross-feature bleed); cross-namespace access refused with a named error; B's table holds only B's rows.
  - Edge: same table name; same record key; one feature absent; hyphenated feature id.
- [x] F-40 (REQ-5, AC-5, negative, **PASS 2026-09-19 #2896** — negative only): Open Mission Monitor with NO session selected (fresh launch). Dev Mode → Feature Data shows exactly 1 watch (`mission-monitor · sessions · scope: table`), no per-session query watch; the positive (delivers new sessions) is FAIL.
  - EXPECTED: zero per-session activity watches open (per-session `feature_data_watch` `scope:{kind:'query', where:[{field:'sessionId', eq:S}]}`; zero `featureBatch` deliveries for any per-session `watchId` via `tauri_ipc_monitor`/`tauri_ipc_get_captured`) and no per-session activity delivered — while the session-list (table-level) watch stays live and delivers new sessions.
  - Edge: select then deselect; a new session starts while nothing selected → appears in the list; its activity rows must NOT be delivered as if selected.

## Non-functional #2896

- [ ] N-16 (NFR-1, history-size independence, **FAIL 2026-09-19 #2896** — the declared store (0 rows) never serves the list, so no first paint and no measurable Δ): Compare first-paint Δ + switch latency small vs large corpus.
  - EXPECTED: both within the bound — large corpus (≥ 3× rows / ≥ 30 sessions) Δ ≤ **250 ms** absolute AND ≤ **2.0×** the small-corpus Δ, 100 ms small-corpus floor (A-14); no growth proportional to total history; raw numbers recorded ("feels faster" with no numbers = FAIL).
- [ ] N-17 (NFR-2, closed-UI correctness, **FAIL 2026-09-19 #2896**): Close Mission Monitor's UI, drive live activity, reopen and read.
  - ACTUAL: with MM closed, a canonical `chat` mutation (`e2e-2896p0a1`) landed and the projection observer ran and FAILED (`no such column: sessionId`); reopened read returns `rows:[]` — the change was lost to the declared table.
  - EXPECTED: no session/change missed while closed (the projection runs unconditionally in the canonical ingest path — universal for declared tables, A-8, verified by ST-8; watches resume on reopen with `initial:true` + the version guard, A-9); reopened view current with no gap.
  - Edge: closed across an app restart; activity spans the reopen.
- [x] N-18 (NFR-3, no re-render loop, **PASS 2026-09-19 #2896**): `tauri_read_logs(source="console")` after every watch start/stop, switch, and feature open/close — clean (only Vite/React boot + one `motion() is deprecated` WARN; no `Error:`/`Uncaught`/`Maximum update depth exceeded`).
  - EXPECTED: no `Error:`/`Uncaught`/`Maximum update depth exceeded`; epoch-based derivation (#523).
- [ ] N-19 (NFR-4, theme + no redesign, **PARTIAL 2026-09-19 #2896** — MM chrome observed visually unchanged, theme tokens only; full light/dark/accent re-tint not exercised with no rows): visual check across light/dark/user-accent.
  - EXPECTED: Mission Monitor list/canvas visually unchanged (ANY visual/layout/graph redesign = FAIL — scope exclusion); theme tokens only; no hardcoded hex/rgba; no invalid `var(--token)NN`.

## UI/UX state contract cross-check (G-187) — #2896

- [ ] F-41 (S4, REQ-5 / AC-5, **UNVERIFIED 2026-09-19 #2896** — list is empty so no selection/deselection is possible; the `NoSessionSelected` copy is unreachable): No session selected with a non-empty list — snapshot the panel.
  - EXPECTED: the existing `NoSessionSelected` copy (MissionMonitorPanel.tsx:161) rendered unchanged; no per-session content/nodes; the table-level watch still delivers new sessions.
  - Edge: after deselecting; after deleting the selected session → falls back to S4 (useSessionHistory.ts:328), never a blank canvas.
- [ ] F-42 (S0 + S5, REQ-4 / AC-4, **FAIL 2026-09-19 #2896**): Open with stored sessions and capture the FIRST painted frame
  - ACTUAL: first painted frame is `No sessions yet` + inline spinner `Waiting for agent activity…` while stored history exists. (screenshot + DOM); repeat with a genuinely empty store.
  - EXPECTED: stored rows are in the first painted frame — the inline `EmptyState` (MissionMonitorPanel.tsx:123), `No sessions yet` (SessionHistoryDrawer.tsx:462) and a blank canvas are NOT the visible state at any frame while stored sessions exist; with a genuinely empty store the existing empty state renders, but only after the durable read has settled empty (never the pre-read placeholder). Both themes + one non-default accent.
  - Edge: warm reopen; multi-batch drain; empty store with live activity (must leave the empty state once a row lands).
- [ ] F-43 (S6, REQ-3 / AC-3, **UNVERIFIED 2026-09-19 #2896** — named blocker: no watch failure/disconnect was forced; the hooks see `rows:[]` with no `error` and never surface the server-side projection failure): Force a watch/read failure and a stream disconnect.
  - EXPECTED: a non-blocking inline status appears — icon + text + verbatim backend error; `role="alert"` for a watch failure, `role="status"` for a disconnect; `--status-error` / `--status-warning`; previously stored sessions remain visible (fail-open — never an empty state, never console-only). **Bound (A-13):** `feature_data_read|watch|write|delete` reject with hard named errors and `useFeatureRead`/`useFeatureWatch` expose `error: string | null` (verbatim backend text) and NEVER swallow it; a removed record is `kind:"remove"`, not an error.
  - Edge: failure at mount; failure mid-stream; recovery on re-subscribe; both themes.
- [ ] F-44 (S2/S3 + S1 budgets, UI/UX, **UNVERIFIED 2026-09-19 #2896** — named blocker: 0 sessions ⇒ no row to select, switch, or animate; budgets unmeasurable): Measure first meaningful paint, selection feedback, switch clear, and new-row animation.
  - EXPECTED: first meaningful paint = drawer's first painted frame with stored rows (no backend round-trip / full history scan); selection highlight <100 ms with no round-trip; A's context cleared ≤100 ms on switch with no stale-A flash beyond one frame; no main-thread sync work >50 ms; new-row animation uses `transform`/`opacity` only and is disabled/reduced under `prefers-reduced-motion`. Record raw ms.
  - Edge: cold vs warm; large corpus; rapid switching; reduced-motion on.
- [ ] F-45 (drawer chrome regression, UI/UX, **UNVERIFIED 2026-09-19 #2896** — named blocker: no sessions exist to rename/search/select; drawer chrome itself observed unchanged): exercise collapse/expand, rename, search, `SessionTokenBar`, `DetailPanel` during live updates.
  - EXPECTED: collapse/expand (210/28 px) + hover-expand unchanged; rename/search unchanged; long names ellipsize with no row-height change on a live update; `SessionTokenBar`/`DetailPanel` unchanged; no horizontal scroll from live inserts.
  - Edge: live insert during a rename/search; live update on the selected row.

## Non-functional #2896 (continued)

- [ ] N-20 (NFR-5, interaction budgets, **UNVERIFIED 2026-09-19 #2896** — named blocker: no rows to interact with; budgets unmeasurable): raw-ms budget table for F-44 — a "feels instant" with no numbers = FAIL.
- [ ] N-21 (NFR-5, reduced motion, **UNVERIFIED 2026-09-19 #2896** — named blocker: no new-row animation/skeleton can be produced with 0 sessions): with `prefers-reduced-motion` on, the new-row animation and any skeleton shimmer are disabled/reduced — no layout break.
- [ ] N-22 (NFR-6, S6 contrast/theme, **UNVERIFIED 2026-09-19 #2896** — named blocker: the S6 error/disconnect state was never rendered, so its contrast could not be checked): the inline error/disconnect status renders legibly in light + dark with a non-default accent using theme tokens (no hardcoded hex).

## Round-2 re-test results (#2896, 2026-09-19, served `spec/2896 @ 8b9c8f3a`)

> Full evidence: the #2896 `## Tests Runs` (round 2, Verdict FAIL). The round-1 blocking defect (legacy physical-table collision) is FIXED and verified live; the remaining FAIL is the incomplete one-time backfill (see F-38/N-16).

- [x] F-25 (QA-1.1, PASS 2026-09-19 #2896 round 2): declared schema real; `feature_data_read` returns projected rows with `version>0` (1 row, `version:1` → later `version:3/15`). Evidence: `## Tests Runs (round 2)` leg 2a.
- [x] F-36 (QA-4.1, PASS 2026-09-19 #2896 round 2): legacy table quarantined (never dropped) as `feature_mission_monitor_sessions__legacy_20260919071609`; declared schema created; re-declare/restart is a no-op (exactly 1 `__legacy_*` after a second cold start).
- [x] F-37 (QA-4.2, PASS 2026-09-19 #2896 round 2): declared rows + feature-owned `customName` persist across a full stop/start (6→6 rows; `noop-test` survived). See the round-2 tests-runs screenshot.
- [ ] F-38 (QA-4.3, **FAIL 2026-09-19 #2896 round 2**): the declared store does not reproduce the stored history. After >12 min the one-time backfill is still draining (`backfill_done=0`, no completion log) and MM shows 7 of ~34 qualifying sessions of 168 canonical. NFR-1 unmeasurable.
- [ ] F-41 (S4, **UNVERIFIED 2026-09-19 #2896 round 2** — named blocker): MM auto-selects a stored session on open and no deselect affordance was reachable; `NoSessionSelected` not renderable.
- [x] F-42 (S0/S5, PASS-literal 2026-09-19 #2896 round 2): first painted frame with stored rows contains them; no `No sessions yet` / inline spinner / blank canvas while stored sessions exist. Intent PARTIAL: only 7 of ~34 stored sessions present.
- [ ] F-43 (S6, **UNVERIFIED 2026-09-19 #2896 round 2** — named blocker): no in-app lever forces a live watch/read failure or stream disconnect; `mm-watch-error`/`mm-watch-disconnected` never rendered. Cross-namespace read DOES reject with the verbatim hard error.
- [x] F-44 (S2/S3 + S1 budgets, PASS 2026-09-19 #2896 round 2): selection/render work with a non-empty list; declared-table `update` notifications re-fit the canvas (`auto-fit … epoch N` console lines); no round-trip on selection observed. Raw ms budget table not separately sampled (time-boxed).
- [x] F-45 (drawer chrome, PASS-observed 2026-09-19 #2896 round 2): drawer/rename/search/token-bar/DetailPanel chrome unchanged; rename persisted across restart; theme vars only.
- [ ] N-16 (NFR-1, **UNVERIFIED 2026-09-19 #2896 round 2** — named blocker): declared store < 30 sessions (backfill incomplete) and no small-corpus DB was available; no valid large/small Δ pair could be produced.
- [x] N-17 (NFR-2, PASS 2026-09-19 #2896 round 2, mechanism-level): a canonical emit projects into the declared table with no read/watch gating (observer installed unconditionally, `lib.rs:395-398`); `feature_data_while_closed.rs` covers the closed-state negative.
- [x] N-18 (NFR-3, PASS 2026-09-19 #2896 round 2): console clean after open/watch/mutate/delete — only the pre-existing `motion() is deprecated` WARN.
- [x] N-19 (NFR-4, PASS-observed 2026-09-19 #2896 round 2): MM list/canvas visually unchanged; theme tokens only (single theme observed).
- [x] N-20/N-21 (NFR-5, PASS-literal 2026-09-19 #2896 round 2): no new-row animation/skeleton regression observed; `auto-fit` epochs behave. Reduced-motion not separately driven.
- [ ] N-22 (NFR-6 S6 contrast, **UNVERIFIED 2026-09-19 #2896 round 2**): S6 state never rendered (same blocker as F-43).

## Round-3 re-test results (#2896, 2026-09-19, served `spec/2896 @ 74449897`)

> Full evidence: the #2896 `## Tests Runs` (round 3, Verdict PASS). The round-2 FAILs (incomplete one-time backfill; phantom no-op write) are FIXED and verified live. The two UNVERIFIED legs (S6 error/disconnect, S4 `NoSessionSelected`) remain named blocks per the round-3 Fix Plan classification (technique/scope, not product).

- [x] F-38 (QA-4.3, **PASS 2026-09-19 #2896 round 3**): the declared `feature_mission_monitor_sessions` holds **31 rows** = exactly the 31 canonically-qualifying, non-tombstoned sessions (SQL: 187 canonical chat sessions → 31 qualifying after the lowercase `response`/`timeout` terminal-blank rule and 13 tombstones; 0 missing). `feature_data_tables['mission-monitor'].backfill_done = 1` WITH rows. Backfill logs: row leg `fed=0`, rollup leg `fed=210 elapsed_ms=4377`, final `declared-table projection backfill complete tables=1 completed=1 failed=0 fed=210`. Cold restarts (08:10:58 and 08:16:57) re-materialize only (`persisted declared tables re-materialized tables=1`) with **no** backfill leg re-drain (marker respected). NFR-1 measurable.
- [x] F-42 (S0+S5, **PASS 2026-09-19 #2896 round 3**): MM open renders stored rows in the first painted frame — 31 `.mm-session-row` nodes in the drawer container (overflow auto, scrollHeight 1395) and a selected session's Chat node; `No sessions yet` / `Waiting for agent activity` never present during mount (MutationObserver `sawEmpty=false`, `sawSpinner=false`). Screenshot: the Sessions drawer with the stored list. (Genuinely-empty S5 leg not re-driven this round — time-boxed; no regression evidence.)
- [ ] F-41 (S4, **UNVERIFIED 2026-09-19 #2896 round 3** — named blocker retained): MM auto-selects the newest stored session on open (`useSessionHistory.ts` auto-select + `userPickedRef`), and clicking the selected row re-selects (verified: click `r3-change-A` → still selected, `NoSessionSelected` absent). `sessions.length > 0 && selectedSessionId === null` is not a steady state; no deselect affordance exists. Per the round-3 Fix Plan this is a technique/scope reachability gap (R-5.1 remains unit-covered; a live S4 steady state needs a new deselect affordance = out of non-goals), not a product defect.
- [ ] F-43 (S6, **UNVERIFIED 2026-09-19 #2896 round 3** — named blocker retained): the `mm-watch-error` leg's sanctioned lever (drop the declared table on the disposable DB) is **sandbox-denied** — `sqlite3 "<appdata>\fredo.db" "DROP TABLE IF EXISTS feature_mission_monitor_sessions"` → permission denied (only `sqlite3 -readonly` is allowlisted); no product command invalidates a declared table. The `mm-watch-disconnected` leg has no product lever at all (`isConnected` is a mount-lifetime flag; `AppProvider.tsx:88-92`; no stream-health signal). The hook-level hard rejection remains live-verified (`feature '<x>' has not declared table '<y>' (call feature_data_declare first)`).
- [x] F-44/F-45 (S2/S3 + drawer chrome, **PASS-observed 2026-09-19 #2896 round 3**): selection renders the stored session's Chat node; drawer/rename/search/token-bar/DetailPanel chrome unchanged (screenshots); all surfaces use CSS vars (`var(--card-bg)`, `var(--border-color)`, `var(--text-secondary)`, `var(--status-error)`) — no hardcoded hex.
- [x] N-16 (NFR-1, **PASS 2026-09-19 #2896 round 3**): A-14 Δ pair measured live — large corpus (31 sessions / 30,320 chat rows) mount→first-session-row Δ = **39.8 ms** and **92.7 ms** (two runs); small corpus (3 sessions / 3 chat rows, SI-B disposable DB) Δ = **62.4 ms**. 92.7 ≤ 250 ms absolute PASS; 92.7 ≤ 2.0 × max(62.4, 100 ms floor) = 200 ms PASS. No growth with total history.
- [x] N-17 (NFR-2, **PASS 2026-09-19 #2896 round 3**): the projection ran unconditionally (no read/watch gating) — with MM closed a canonical `fredo emit` projected a declared row; `feature_data_while_closed.rs` still green on the branch.
- [x] N-18 (NFR-3, **PASS 2026-09-19 #2896 round 3**): console clean after open/mount/measure/watch start-stop — only the pre-existing `motion() is deprecated` WARN and `[mission-monitor] auto-fit` DEBUG lines.
- [x] N-19 (NFR-4, **PASS 2026-09-19 #2896 round 3**): MM list/canvas visually unchanged; theme tokens only.
- [x] Legacy quarantine + no resurrection (**PASS 2026-09-19 #2896 round 3**): on the real-corpus snapshot exactly one `feature_mission_monitor_sessions__legacy_20260919071609` exists (legacy `events`/`session_names`/`deleted_sessions` preserved); 13 tombstones; declared rows whose sessionId is one of the 12 legacy-deleted sessions = **0**.

---

# Mission Monitor — Functional Test Cases (Spec #2945 — every supported agent CLI in one view, each labeled with its CLI)

> Durable functional suite (feature domain `mission-monitor`), extended from #2791/#2792/#2795/#2835/#2896/#2933. One `- [ ]` case per AC (AC1–AC5; AC-3 split into its positive and negative legs). Marks `unknown` until executed by the Tester.
>
> **Evidence policy: LIVE** — the exit gate / audit fail-closed unless the tester's Evidence references `telemetry_spans` (a live-query result) AND a rendered-webview receipt (DOM snapshot / screenshot) for the same instant. A static-only PASS is a FALSE PASS.
>
> **Provider vocabulary oracle (Spec #2932):** canonical `provider` tokens are exactly `open_code` / `claude_code` / `copilot_cli` / `internal` / `unknown`, resolved from the OTLP resource `service.name` (`fredo-opencode-plugin → open_code`; `copilot-cli → copilot_cli`; else `unknown`). The CLI label MUST read the row's `provider` field — NEVER `telemetry_spans.provider` (a label equal to a model id such as `openai`/`anthropic` is a FAIL).
>
> Fixture doctrine (G-073/G-076/G-080): OpenCode = live Run CLI drive (free model, minimal tree, unique marker in the FIRST prompt), never the `opencode` binary from a shell. Copilot = the in-repo deterministic `inject-otlp-fixture.ts --copilot` producer (no paid subscription). Cross-check `telemetry_spans`/`chat_rows`/`tool_use_rows`/`agent_session_rows` at the same instant as every DOM assertion (G-073.3).

## Both CLIs in one view + Copilot activity parity (AC-1)

- [ ] F-46 (AC-1, `unknown`): With an OpenCode session (`open_code`) AND a Copilot-shaped session (`copilot_cli`, session `e2e-copilotsplit2933`) both present in the store, open Mission Monitor and enumerate the session list; then select the Copilot session. Cross-check the row tables + `telemetry_spans` at the same instant.
  - EXPECTED: the list shows sessions from BOTH CLIs as distinct entries (never merged, never one hidden); selecting the Copilot session renders its activity at the SAME structural detail as an equivalent OpenCode session — chat turn node(s), user prompt (or the documented `—`/absent outcome for a null continuation `userMessage`), `── TOOLS (N) ──` (or a zero-tools node), RESPONSE, token figures.
  - Edge: OpenCode-only store; Copilot-only store; both in one store; switching back and forth; the Copilot session renders while its split-turn rows land mid-stream.
- [ ] F-47 (AC-1, `unknown`): Inspect the Copilot session's rendered node set and compare it field-for-field against an OpenCode session's node set from the same corpus.
  - EXPECTED: no structural element present for OpenCode is missing for Copilot at the same data shape (same sections/labels/token rows); a split-turn continuation with a null `userMessage` still renders its node (never dropped) and does NOT yield two list entries.
  - Edge: content-off Copilot split turn (call 1 user-text + tool-call, call 2 tool-response + assistant-text, `execute_tool view` inside call 1's window); no `task`/subagent dispatch → zero SubagentNodes, not a rendering failure.

## CLI label in list row + header, from canonical provider (AC-2)

- [ ] F-48 (AC-2, `unknown`): Inspect the OpenCode session's LIST ROW and the selected session's HEADER; repeat for the Copilot session. Cross-check `SELECT provider FROM chat_rows WHERE session_id = '<s>'`.
  - EXPECTED: each list row and the header display the CLI that produced the session, resolved from canonical provider attribution — `open_code` renders the OpenCode label, `copilot_cli` renders the Copilot label; text non-blank and consistent between row and header.
  - Edge: label survives rename / select / switch; a session whose rows carry `internal`/`claude_code` (if present) renders its own label; label is not the model provider (`openai`/`anthropic`).
- [ ] F-49 (AC-2 negative, `unknown`): A session whose canonical `provider` is `unknown` (Resource omits `service.name`, e.g. `inject-otlp-fixture.ts --count 1 --prefix ses_prov2945`).
  - EXPECTED: the label is an EXPLICIT, NON-BLANK fallback (the Architect-bound literal — QA-4) and is NEVER silently presented as `OpenCode`/`open_code`; the fallback is visually distinct from the OpenCode label.
  - Edge: absent/empty provider value; a legacy pre-provider row defaulting to `unknown`; the label updates if the provider is later re-derived (never stale).

## Copilot-shaped session appears once it has renderable activity (AC-3 positive)

- [ ] F-50 (AC-3a, `unknown`): Replay the Copilot split-turn fixture (`bun .opencode/scripts/inject-otlp-fixture.ts --copilot --fixture .opencode/scripts/copilot-turn-split.fixture.json`); wait for the rows to land; enumerate the list and select the session. Cross-check rows at the same instant.
  - EXPECTED: the session appears ONCE (no duplicate per split span) and renders ≥1 node once its activity lands — consistent with the #2896/#2933 renderable-activity qualification; the split turn does not produce two list entries.
  - Edge: a continuation whose `userMessage` is null → node still renders; the session qualifying only after the continuation row lands (legitimate transient, G-074).

## No-agent-activity session does not appear (AC-3 negative)

- [ ] F-51 (AC-3b, `unknown`): Produce (or, if no lever exists, predicate-verify) a session that yields NO renderable agent activity — the plain-shell `Terminal` session type, which is not an agent. See QA-2 for the lever/decision.
  - EXPECTED: the non-agent session does NOT appear in the Mission Monitor session list. If no sanctioned lever exists, the deliberate triage decision is verified instead: a declared rollup row with `visibleTurnCount = 0` and no user dispatch is not listed — the renderable-agent-activity qualification excludes it.
  - Edge: Terminal session alongside real sessions → only real sessions listed; never receives an agent label; a session that later gains real agent activity becomes listed (transient, G-074).

## Themeable CLI labeling (AC-5)

- [ ] F-52 (AC-5, `unknown`): Visual check of the list-row label and the header label for both providers across light / dark / a non-default user accent.
  - EXPECTED: labels use the theming feature's semantic tokens (→ CSS vars); no hardcoded hex/rgba; no invalid `var(--token)NN` alpha-append (use `color-mix()`/`tint()`); a theme/accent change restyles the label with zero code change.
  - Edge: light; dark; non-default accent; both providers' labels; the fallback label.

## CI parity (mandatory — the spec touches the UI build and possibly the Rust rollup)

- [ ] F-53 (CI parity, F-14-style): Run the repo's CI-parity commands and report raw output tail.
  - EXPECTED: `pnpm --filter @fredo/ui build` clean (TypeScript, zero errors); `pnpm --filter @fredo/ui test` (or the UI unit runner) green for the mission-monitor + session-history suites; if the Rust rollup/declaration is touched, `cargo check` and `cargo clippy --locked -- -D warnings` clean from `apps/tauri/src-tauri/`. Any red = FAIL for the whole spec.
  - Edge: a UI-only change still runs the UI build + tests; a Rust change additionally requires both cargo gates with `--locked`.

## Non-functional #2945 (NFR-1 / NFR-2 / NFR-3 / NFR-4)

- [ ] N-23 (NFR-1, latency): Open Mission Monitor with stored history; measure Δ mount→first rendered session row with the provider label present; compare small vs large corpus. Record raw ms.
  - EXPECTED: Δ within the #2896 A-14 bound (≤ 250 ms absolute AND ≤ 2.0× small-corpus Δ, 100 ms floor — QA-6) — provider labeling adds no measurable latency. A "feels fine" with no numbers = FAIL.
- [ ] N-24 (NFR-2, no full-history scan): inspect the list data path (declared `sessions` rollup first read + table watch, Spec #2896) for a per-session OTLP span lookup or history scan added for the label.
  - EXPECTED: the label is a projected row field; the list still renders on its first round-trip with no full-history scan.
- [ ] N-25 (NFR-3, single shared provider rule, NFR-6): code-inspect the label resolution and cross-check the row's `provider` against `resolve_provider_token` output.
  - EXPECTED: ONE shared extraction path (`rtdb/attrs.rs`, Spec #2932) feeds the row's `provider`; the UI reads the typed field directly — no `??` fallback chain, no multi-path lookup, no text filtering. FAIL if the label re-derives provider or reads `telemetry_spans.provider`.
- [ ] N-26 (NFR-4, no re-render loop, #523): `tauri_read_logs(source="console")` after open/select/switch/rename and after a live provider patch.
  - EXPECTED: no `Error:` / `Uncaught` / `Maximum update depth exceeded`; derivation epoch-based (no `.length`/newly-created-object `useEffect`/`useMemo` deps added).
  - Regression risk (#523): a `useEffect` depending on the session array `.length` or a newly-created label object → FAIL.
