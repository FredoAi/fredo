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

- [x] F-7 (AR-1, AC-1, PASS 2026-09-02 #2792): Drive a live opencode session via Run CLI (free model, minimal tree, marker in first prompt) with a tool call that FAILS and surfaces a captured `tool.error` (invalid argument / permission denial / provider error). Wait for landing, select the session, open the tool detail view from the failed call in the chat node's `── TOOLS (N) ──` list. Cross-check DOM + `telemetry_spans`/`tool_use_rows` at the same instant.
  - Fixture `FX2792F1` (Muse Spark 1.3 Free): Read non-existent `C:\Code\fredo\definitely_missing_fx2792_file.txt`. `tool_use_rows`=`read / tool_success=0 / tool_error="File not found: C:\Code\fredo\definitely_missing_fx2792_file.txt"` (session `ses_f9afad6b4ffe9TCp9DQWlnps3O`, duration_ms=17, is_subagent=0). Detail view (chat-node `── TOOLS (1) ──` double-click) shows Status=Failed + Reason=the same text verbatim. Evidence: ar1-reason-row.jpeg.
  - EXPECTED: detail view shows the "Failed" status AND a failure-reason row carrying the captured `tool.error` verbatim; a `telemetry_spans`/`tool_use_rows` query at the same instant returns the row whose `toolError` equals the displayed text.
  - Edge: long / whitespace-heavy / special-char reason text renders as text and wraps/clips without layout break (`wordBreak: break-all` already on detail values); multiple failed tools in one session each show their own reason; an in-progress tool (no end, no outcome) shows In progress and no reason row.
- [x] F-8 (AR-2, AC-2, PASS 2026-09-02 #2792): In the same drive, open the SAME detail view for a failed tool in a SUBAGENT node's tools list (a user-requested @-subagent, NOT `build`/`plan`). Cross-check DOM + `telemetry_spans`/`tool_use_rows` at the same instant.
  - Fixture `FX2792F2`: primary Read `.gitignore` succeeded, then `task`-dispatched subagent (agent type `explore`, session `ses_f9af66210ffeY3pGAr0QwGVRqj`) Read non-existent `definitely_missing_sub_fx2792.txt` → `tool_success=0 / tool_error="File not found: C:\Code\fredo\definitely_missing_sub_fx2792.txt"` (is_subagent=1). SubagentNode · explore `── TOOLS (1) ──` double-click → Status=Failed + Reason=the same text (duration_ms=28). Evidence: ar2-subagent-reason-row.jpeg.
  - EXPECTED: "Failed" + the same failure reason as the chat-node path — location-independent (both ChatNode.tsx:198 and SubagentNode.tsx:343 open the same `ToolCallDetailView`).
  - Edge: a subagent with no failed tool shows no error surface; the subagent tool's reason matches that row's `toolError` (not the parent's); a `build`/`plan` internal tool-execution session stays excluded (no spurious SubagentNode).
- [ ] F-9 (AR-3, AC-3, UNVERIFIED 2026-09-02 #2792): Produce a failed tool call with NO captured error text (`success === false`, empty/absent `error`). Prefer a real drive (sandbox/provider-layer failure that yields `success:false` with no string error); if not producible, inject via `fredo emit` a tool_use event carrying `success:false` + empty error and confirm the landed row via `telemetry_spans`/`tool_use_rows` — **real path first, injection as a documented fallback, never the reverse** (mock-vs-real divergence rule). Open the detail view for that call.
  - ATTEMPTED (both paths, NOT producible): (1) real drive `bash exit 7` → `tool_success=1` (opencode marks a non-zero-exit tool call successful; no success:false shape). (2) failing `read` calls (AR-1/AR-2) populate `tool.error` — the wrong shape. (3) `fredo emit` injection (`{"tool.success":false,"tool.error":""}` and `{"success":false,"error":""}`) → landed `tool_success=NULL, tool_error=NULL`; mock classifier does NOT produce `success:false + empty-error`, and mock tool rows carry no span timing so they do NOT associate to a chat node's tools list (no openable detail view). The AC3 branch is covered by the unit test `DetailPanel.test.tsx` (`#2792 AC3`) and the gating logic (`getToolCallOutcome(success===false)='error'`, `hasErrorText(empty)=false` → placeholder) — but no live `telemetry_spans` receipt, so NOT live-verified. Requires an architect/QA decision (accept-unit-coverage vs add a recipe for the shape).
  - EXPECTED: a CLEAR "Failed" status (never reads as succeeded) AND an explicit absent-reason placeholder (a literal visible placeholder, never a silently blank reason area); `getToolCallOutcome` still returns `error` for `success===false` even with no error string.
  - Edge: `toolError` empty string / null / undefined all resolve to the same explicit placeholder; placeholder uses theme tokens (never hardcoded hex); placeholder never carries success styling/color.
- [x] F-10 (AR-4, AC-4, PASS 2026-09-02 #2792): In the same drive, open the detail view for a SUCCEEDED tool call (a tool that returned output normally). Cross-check DOM + `telemetry_spans`/`tool_use_rows` at the same instant.
  - Fixture `FX2792F2`: `.gitignore` `read` → `tool_success=1 / tool_error=NULL` (session `ses_f9af67759ffe6MYMAVLGexqJUg`). Detail view (chat-node tools list) shows Status=Succeeded + Duration=99ms + full Input/Output, NO Reason row. Mixed-session per-tool independence: the same session also contains the subagent's failed read (each tool's detail shows the correct per-tool outcome). Evidence: ar4-success-no-reason-row.jpeg, mixed-session-graph.jpeg.
  - EXPECTED: no error/reason row for the succeeded call — the failure surface appears ONLY for failed calls; Status=Succeeded, Duration, Input, Output render as before (no regression to the success path).
  - Edge: a mixed session (some succeeded, some failed) shows the correct per-tool outcome; a succeeded tool whose output merely mentions "error"/"fail" is NOT rendered failed (`call.error` empty, `success !== false`).
- [x] F-11 (CT-1, contract-trust, PASS 2026-09-02 #2792): Verify the displayed reason equals the projected single-path `ToolCallSummary.error` / `ToolUseRow.toolError` (rowDerivation.ts:276) — not a fallback/multi-path/`??` chain or an output-driven derivation.
  - Code inspection: DetailPanel.tsx:520-527 consumes ONLY `call.error` (gated `getToolCallOutcome(call)==='error'`, discriminator `hasErrorText(call)` graph.ts:140-142). No `??` chain, no `toolOutputJson`/`rawJson` re-parse. `getToolCallOutcome` (graph.ts:123-128) untouched. Displayed reason byte-matches landed `toolError` in AR-1/AR-2.
  - EXPECTED: reason byte-matches `summary.error`; code inspection confirms ONE extraction path; a tool with non-empty `error` AND output text mentioning "error" still derives the reason from `summary.error` only (never from output heuristics).
  - Regression risk (Contract-Trust Cleanup): a `??` fallback chain or multi-path lookup reintroduced is a FAIL.

## Non-functional (NFR-1 / NFR-2)

- [x] N-4 (NFR-1, theme, PASS 2026-09-02 #2792): Visual check of the reason row + absent-reason placeholder across light / dark / user-accent overrides.
  - Code inspection: fix passes `color={hasErrorText(call) ? 'var(--status-error)' : 'var(--text-secondary)'}` — both theme CSS vars (ThemeProvider.tsx:65,79; system.ts `status.error`/`fg.muted`). No hardcoded hex/rgba, no `var(--x)NN` alpha-append. Reason text shares `--status-error` with the "Failed" pill; placeholder uses `--text-secondary` (muted, not error-red). (Absent-placeholder variant not live-renderable — see F-9 UNVERIFIED; token usage verified by code.)
  - EXPECTED: reason row/placeholder use theme tokens (existing `--status-error` family → `status.*`/`bg.*`/`fg.*`/`accent.*` semantic tokens in system.ts → CSS vars); NO hardcoded hex/rgba; no invalid `var(--token)NN` alpha-append (use `color-mix()`/`tint()`).
  - Regression risk: a hardcoded hex/rgba reason row or a fixed-color placeholder that ignores the user accent is a FAIL.
- [x] N-5 (NFR-2, no re-render loop, PASS 2026-09-02 #2792): After each open/close of the detail view and each selection switch, read the webview JS console (`tauri_read_logs source="console"`).
  - No `Error:` / `Uncaught` / `Maximum update depth exceeded` / re-render-loop symptom across the AR-1/AR-2/AR-4 detail opens + session switches. The Reason row is a plain render conditional (no effect/setState, no `.length`/object-identity dep). Only pre-existing warning: DesktopToolbar duplicate key (app-startup, unrelated).
  - EXPECTED: no `Error:` / `Uncaught` / `Maximum update depth exceeded` / re-render-loop symptom; recomputation is row-store epoch based (per #523) — no `.length`/newly-created object-ref `useEffect`/`useMemo` deps added.
  - Regression risk (#523): a `useEffect` depending on array `.length` or the target `call` object identity → FAIL.
