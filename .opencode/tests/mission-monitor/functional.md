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
