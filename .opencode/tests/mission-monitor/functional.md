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

> Durable functional suite (feature domain `mission-monitor`), extended for Spec #2835 (research-first perf regression: delayed first render, then slowdown/freeze). One `- [ ]` case per AC/REQ (R-1..R-4 = AC1..AC4); observable + MEASURED expected outcome per case.
>
> **Evidence policy: LIVE** — the exit gate / audit fail-closed unless the tester's Evidence references `telemetry_spans` (a live-query result) and/or rendered-webview live receipts (DOM snapshots, console logs, IPC captures, JS-API metrics). A static-only PASS is a FALSE PASS. Root cause is UNKNOWN (research-first) — the BEFORE numbers must be measured against the buggy `main` baseline, never assumed.
>
> Fixture doctrine (G-073/G-076/G-080): drive via Fredo's Run CLI feature (free model, minimal session trees, unique marker in the FIRST prompt); never run the `opencode` binary from a shell. Sustained workload = a live opencode session streaming continuously for ≥ 60s with periodic selection toggles. Burst/large-replay = a high session-count corpus (≥ 30 sessions, ≥ a few hundred rows) replayed into the RTDB.
>
> Canonical budgets (QA-1 reconciled, triage plan): populated session-list Δ ≤ **1,000 ms**, empty-state Δ ≤ **300 ms**, replay `ready` settle ≤ **1,500 ms**; AFTER wire budget ≤ 40 batch envelopes. RESULTS (2026-09-07/08 #2835 round 1, tester): Before leg served pre-fix `296f881` via `dev-env -At`; After leg served fixed tip `00497c1a`. Corpus = the real fredo.db planning corpus (~14,0xx chat / ~17,4xx tool rows; clean+re-drive not reproducible at that scale — see baseline-before.md).

## First-render latency (R-1 / AC-1)

- [x] F-17 (R-1, AC-1, FAIL 2026-09-07 #2835): From a cold webview, open Mission Monitor. Record `performance.now()` immediately before triggering the feature mount, then again when the session-list first row renders; compute Δ. Repeat for a zero-session empty DB.
  - EXPECTED: populated session-list Δ ≤ **1,000 ms** (canonical) and empty-state Δ ≤ **300 ms**; no "~seconds" stall. Record the exact ms in the verdict.
  - ACTUAL (AFTER tip `00497c1a`): populated first-row Δ = **10,397 ms / 18,075 ms** (2 cold runs, median ≈ 14.2 s) — ≫ 1,000 ms → FAIL. Empty-DB first-open empty-state Δ = **41 ms** → PASS (edge). Warm reopen also re-drains the full table (second full replay per mount).
  - Edge: empty DB PASS (41 ms); large-replay first-open FAIL (multi-second false-empty "Waiting for agent activity…"); cold vs warm both pay the full replay.
- [x] F-18 (R-1, AC-1, FAIL 2026-09-07 #2835): Capture F-17's Δ against the buggy baseline (BEFORE, pre-fix `296f881`) and `spec/2835` tip (AFTER). Report both numbers + Δ.
  - EXPECTED: AFTER Δ ≤ BEFORE Δ (a real improvement) AND within the AC-1 budget.
  - ACTUAL: BEFORE first-row Δ = ≤15,682 / 13,197 / 20,732 ms (median ≈ 15.7 s); AFTER = 10,397 / 18,075 ms (median ≈ 14.2 s). Modest improvement (~1.5 s) but far outside the 1,000 ms budget → FAIL. Root cause: the `startedAtNs >= 604800000000000` replay window is a no-op for real rows (1970-relative bound), so the full real-table replay (~31.5k envelopes) still drains on every open and the session-list gate waits on Chat replay `ready`.
  - Edge: same workload + same DB corpus on both legs; window size constant.

## Sustained-run / no-degradation (R-2 / AC-2)

- [x] F-19 (R-2, AC-2, PARTIAL→FAIL 2026-09-07 #2835): With Mission Monitor open and the row stream active (real live opencode session driven via Run CLI `fredo2835l3marker`, ~80 s observation + selection toggles), sample `performance.memory.usedJSHeapSize` at t0 / mid / t2.
  - EXPECTED: heap plateaus after GC (t2 ≈ t1, not t2 ≫ t1); growth t0→t2 ≤ **50 MB**; app responsive at every sample; `telemetry_spans` row count bounded.
  - ACTUAL (AFTER tip): heap 1,380 MB (t0) → 1,398 MB (+22 s) → 1,338 MB (+75 s, GC) → 1,343 MB (+87 s). Within-window growth ≈ bounded/plateau (Δ ≈ −37 MB after GC) → no unbounded growth in the observed window. Absolute heap is enormous (≈1.3-1.4 GB retained corpus after replay). No freeze; selection toggles registered. → PASS for plateau, but the AC2 no-long-task / responsiveness budgets fail elsewhere (F-23 long tasks); row-leg evidence OK.
  - Edge: cross-checked `telemetry_spans`/`chat_rows` for the live session at the same instant (marker query: 8 spans / 2 sessions matched; chat 49 / tool 50 rows for the live session id at sample time).
- [x] F-20 (R-2, AC-2, PASS 2026-09-07 #2835): Read `tauri_read_logs source="console"` repeatedly through F-19 and after every interaction.
  - EXPECTED: no `Maximum update depth exceeded`, no `Uncaught`, no infinite re-render-loop symptom; recomputation epoch-based (per #523).
  - ACTUAL: console clean across Before + After legs (only `motion()` deprecation WARN + pre-existing MM debug auto-fit lines + a repeated pre-existing `cache reconciliation fallback` WARN for one corpus session on the pre-fix leg). No `Error:`/`Uncaught`/`Maximum update depth`. Code inspection (R-28): builderState memo deps = [chatEpoch, toolEpoch, injected builderState ref] — no `.length`/object-ref deps. → PASS.
- [x] F-21 (R-2, AC-2, PARTIAL 2026-09-07 #2835): Count emitted `fredo-stream-event` RowDeliveryBatch envelopes over the first-open window (webview-injected listener).
  - EXPECTED: emissions coalesced/rate-bound, finite, no flood.
  - ACTUAL: first-open replay batches = **94 / 102 / 96 (BEFORE)** vs **69 / 64 (AFTER)** per cold open; each open re-streams the FULL real corpus (≈45.5k envelopes BEFORE = 2×Chat+1×Tool; ≈31.5k AFTER = 1×Chat+1×Tool after the sub-task-2 dedupe). AFTER exceeds the plan's ≤ 40-envelope wire budget → FAIL on budget; no infinite flood (finite per-open drain, then quiescent).
  - Edge: a per-open replay drain is finite; live coalescing functioned (no per-render storm).
- [x] F-22 (R-2, AC-2, PASS 2026-09-07 #2835): Cross-check the frontend live-row store (deliveries observed in-window) against `chat_rows`/`tool_use_rows` at the same instant.
  - EXPECTED: live-row count ≈ landed telemetry row count; no duplicate re-add beyond landed rows.
  - ACTUAL: total deliveries across two mounts (cold + warm reopen) = 63,220 ≈ 2 × 31,680 landed rows (14,128 chat + 17,552 tool at that instant) — deliveries per mount ≈ landed rows exactly (replay is insert-deduped; store holds the unique row set ≈ landed rows). No runaway/duplicate-reinsert beyond the legitimate per-mount replay. → PASS (with the noted per-mount full replay cost).

## Profile evidence before/after (R-3 / AC-3)

- [x] F-23 (R-3, AC-3, FAIL 2026-09-07 #2835): Produce a literal Before|After|Δ evidence table: (a) first-render latency, (b) long-task count/duration over a 30 s window, (c) JS heap, (d) session-list population time, (e) emitted batch count.
  - EXPECTED: numerical Before|After|Δ table; each AFTER row meets its AC threshold.
  - ACTUAL: full table in `tests-runs.md` (round 1). AFTER first-row Δ 10,397/18,075 ms vs ≤1,000 ms budget → FAIL; ready settle ~16 s vs ≤1,500 ms → FAIL; batches 64-69 vs ≤40 → FAIL; long tasks max 1,507-1,825 ms vs ≤50 ms → FAIL; heap 0.78-0.92 GB retained (improved vs 1.1-1.4 GB Before but not bounded-low). Only the empty-DB edge passes (41 ms). → FAIL.
  - Edge: Rust/flush-path numbers not webview-readable (dev-provided regression tests cover the pushdown/prune contracts); CDP trace not available via bridge (JS-API metrics used).

## Regression — window-manager / launcher / theming (R-4 / AC-4)

- [x] F-24 (R-4, AC-4, PARTIAL 2026-09-07 #2835): (a) window-manager list/resize/focus/min/max. (b) Run CLI launcher reachable, `run-cli-terminal` launches, `write_pty_input` submits. (c) Sessions list + graph + tool-detail render with theme tokens across light/dark/user-accent.
  - EXPECTED: all succeed with no console errors; theming from semantic tokens/CSS vars only; window-manager + launcher identical to pre-fix.
  - ACTUAL: (a) window list + resize PASS; focus/min/max UNVERIFIED — blocked by `tauri-plugin-mcp-bridge < 0.13` in the connected app ("needs 0.13.0 or newer", G-053 named blocker; not a #2835 defect — no window-manager code touched by the diff). (b) PASS live: Run CLI launcher reached, `run-cli-terminal` window launched, `write_pty_input` prompts (fredo2835l3marker / fredo2835l3cont) submitted and answered. (c) PASS: theme preset switched live (Solarized → dark → Solarized) with CSS vars re-resolving (`--body-bg` #fdf6e3 → #111827 → #fdf6e3); MM session-row bg computed as `color-mix(in srgb, var(--accent-primary) 8%, transparent)` (tint pattern) + fg token text — token-driven, no hardcoded hex introduced (2835 diff contains zero theming files). Tool list renders in the chat node (`── TOOLS (1) ── todowrite 3ms` DOM receipt).
  - Edge: focus/min/max unverified (plugin version gap); launcher + theming no regression observed.

## Non-functional — #2835 (memory / latency / theme / contract-trust / row-path)

- [x] N-10 (NFR-1, memory, FAIL 2026-09-07): heap plateaus over the sustained window BUT only at an enormous absolute level (~1.3-1.4 GB retained corpus after each open); no monotonic unbounded growth observed in-window, but first-open heap cost to ~0.9-1.4 GB is not "bounded-low" and the per-open full replay re-inflates it (1,328 MB after a warm reopen). → FAIL (memory cost of the full replay remains).
- [x] N-11 (NFR-2, latency, FAIL 2026-09-07): first-render + ready settle far outside budget (10-18 s vs 1.0/1.5 s); the session-list gate waits on full Chat-drain `ready`; derive still re-runs per flush-batch epoch. → FAIL.
- [x] N-12 (NFR-3, theme, PASS 2026-09-07): no hardcoded hex/rgba introduced (no theming file in diff); MM renders from CSS vars/`color-mix` (live computed-style receipt).
- [x] N-13 (NFR-4, IPC/coalescing, PARTIAL 2026-09-07): per-open replay drain finite (not an infinite flood); coalescing + 512-chunking function. But every open (cold AND warm) re-streams the full corpus (~64-69 batches) — the wire budget (≤40) is exceeded → FAIL on the plan's budget.
- [x] N-14 (NFR-5, contract-trust, PASS 2026-09-07): no `??` fallback chain / multi-path extraction / event-level rewrite reintroduced (diff review; single-path projections unchanged).
- [x] N-15 (NFR-6, RTDB row path unchanged, PASS 2026-09-07): no change to `rtdb/ingest.rs`/`attrs.rs`/store production code (backend diff is test-only); `telemetry_spans`↔rows cross-checks consistent at every sampled instant.
