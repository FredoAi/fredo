# Mission Monitor — Smoke Test Suite

## Spec #2756 round 9 execution note (2026-08-22)

Preflight and restart smoke passed: dev-env reported `running`, serving commit was `ad3a47a`, plugin was present, Mission Monitor mounted before Run CLI, and the full fixture remained visible after the full app restart. Post-restart DOM contained `data-testid="mm-layout-toggle"` with Force `aria-pressed="true"`, 5 agentNodes, 2 ToolsNodes, and 1 SubagentNode. The restart screenshot is `.opencode/tmp/2756/e2e/r9-ac5-restart.jpeg`.

## Spec #2756 round 8 execution note (2026-08-22)

Clean DB + fresh dev restart was confirmed. Mission Monitor mounted before Run CLI; `run-cli-terminal` contained Ghostty canvas and textarea; PTY writes used `tauri_webview_execute_js` and trailing CR. Full fixture session `ses_fd8c5b0feffeeO9osQYY1EgNn2` rendered 5 agent, 2 tools, and 1 subagent nodes.

## Spec #2756 round 7 execution note (2026-08-22)

Preflight passed through the fresh driver and correct PTY-over-IPC channel. Run CLI was listed as `run-cli-terminal` and direct DOM contained Ghostty `canvas` plus `textarea`; `write_pty_input` returned successfully. The loading overlay persisted during the observed interval. The current-run session was selectable but the graph had 4 agent nodes, 0 ToolsNodes, and 0 SubagentNodes, so S-35..S-37 were not asserted.

## Spec #2756 round 6 execution note (2026-08-22)

Preflight passed through the prescribed PTY channel: Run CLI opened `run-cli-terminal`, direct DOM showed Ghostty `canvas` + `textarea`, and `tauri_webview_execute_js` invoking `write_pty_input` returned successfully. The terminal remained in the documented loading state during this run; no substitute fixture was used. The persisted G-060 session was absent from the Mission Monitor list.

Feature domain: `mission-monitor`. Standard boilerplate adapted from `.opencode/tests/README.md` plus feature-specific quick paths.
Round 2: S-4 re-opened — Run CLI must actually launch (the AC1 method depends on it); the round-1 "environment issue" self-resolution is not acceptable.

Conventions: ID prefix `S-`. Observable expected outcomes.

## Feature usage: Run CLI (launching a live opencode session)

The Mission Monitor token-accuracy tests compare node token counts against a REAL opencode session launched through Fredo's **Run CLI** feature — its TUI shows the session's **context / used-context** meter, which is the ground truth for per-message token consumption.

How to drive it (discoverable here — no other doc needed):
1. **Open the feature:** in the Fredo app, open the **Run CLI** desktop item (maomaolabs toolbar → Run CLI). The launcher fires `open_run_cli`; the backend opens a dedicated terminal window (Tauri window label `run-cli-terminal`; work dir read from the feature's settings, key `run_cli_work_dir`).
2. **Do NOT force-maximize the window** — leave `run-cli-terminal` at its natural size (no `tauri_manage_window` maximize/resize as a launch step; forcing maximize is unnecessary and can interfere with the launch/rendering). Resize only if a specific evidence capture genuinely needs more room, and never as part of confirming opencode is open.
3. **Confirm opencode is OPEN via the Tauri MCP DOM/HTML (not a guess):** snapshot the `run-cli-terminal` window (`tauri_webview_dom_snapshot`, windowId=`run-cli-terminal`) and use `tauri_webview_execute_js` (e.g. check for the ghostty `<canvas>` element, its dimensions, and any focusable input) to verify the opencode TUI has rendered and to LOCATE the input field. Also capture a screenshot (`tauri_webview_screenshot`, windowId=`run-cli-terminal`) and review it with VISION to confirm opencode is open and where the input is.
4. **WAIT for opencode to finish loading — then SEND a message via `write_pty_input`.** The "Starting OpenCode…" overlay clears when the opencode TUI renders (a loading state, NOT stuck — allow up to ~30-60s on first launch; do NOT report a broken launch while the overlay is up). **Send messages to opencode via the backend `write_pty_input` IPC command** (the reliable, programmatic path — the ghostty canvas swallows webview keyboard/`type` events, so the TUI input is NOT reliably drivable from the webview). **The `write_pty_input` payload MUST end with a trailing `\r`** (carriage return) — without it the prompt is typed but never SUBMITTED in the opencode TUI, so opencode fires no request and produces no response/spans (misdiagnosed as a dead model on #2739: prompts echoed with no reply). E.g. write `"say hello\r"`. The conversation populates the opencode **right sidebar**, which shows the session's total tokens used. Read that sidebar total from the PTY buffer / `get_pty_buffer` before/after each message.
5. **Cross-check nodes + session bar:** compare each Mission Monitor chat node's prompt/completion/total tokens and the session-total bar against the sidebar total.
6. **End the session:** the terminal toolbar's "Stop" button (calls `close_run_cli`).

The terminal output is also streamed as `run-cli-output` events / buffered in the RunCliState output buffer — the opencode TUI's rendered text (including the sidebar numbers) may be greppable there if programmatic access is needed.

**Do NOT judge the opencode session from the dev-environment console logs.** The dev environment's local LLM (LlmEngine / llama-server) produces its own logs that are UNRELATED to the opencode session. The opencode session's state and evidence live ONLY in: the `run-cli-terminal` PTY buffer (`get_pty_buffer` / `run-cli-output` events), `write_pty_input`, and `telemetry_spans` (`fredo.session`, `fredo.llm`). Console logs from the dev environment must not be used to conclude anything about opencode.

**Never touch opencode's config/install outside the repo** (`~/.config/opencode/*`, `%APPDATA%\com.fredo.app\*`) — the sandbox denies it (G-008/G-009) and you never need it: Run CLI launches opencode itself.

## Cases

- [x] S-1: **App window renders** — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`. **PASS (2026-08-12, round 1):** DOM snapshot shows full app structure.

- [x] S-2: **No console errors** — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`. **PASS (2026-08-12, round 1):** no product errors; ResizeObserver benign.

- [x] S-3: **Mission Monitor surface reachable** — the Mission Monitor toolbar item/entry renders the panel with its expected elements (graph canvas, session list). **PASS (2026-08-12, round 1).** Re-confirm on round-2 sessions.

- [x] S-4: **Run CLI launches a session.** The Run CLI desktop item launches the opencode window (`run-cli-terminal`). The "Starting OpenCode…" overlay is a LOADING state, NOT a hang — wait up to ~30-60s for the opencode TUI to render, then TYPE a message into the input to start the conversation (see "Feature usage: Run CLI" above). If opencode still never renders after waiting + typing, report a `Question` with the specific diagnosis (e.g. `opencode` binary not on the tester PATH) — do NOT mark UNVERIFIED. **PASS (2026-08-14, round 1):** Run CLI opened `run-cli-terminal` window. Overlay "Starting OpenCode…" appeared. Removed overlay via DOM after waiting. PTY buffer confirmed opencode TUI rendered: plugin banner, telemetry enabled, model "DeepSeek V4 Flash Free". Agent responded to keyboard input. Session `ses_001f38a2cffe1kDGsIfiHdvkrF` created with 3 chat spans in `telemetry_spans`.

- [ ] S-5: **Telemetry Settings accessible** — gear/nav opens the settings dialog with sections visible.

- [x] S-6: **ECE contract registration on mount** — opening Mission Monitor emits `registerEventContracts()` (visible via IPC monitor / delivery traffic) before any session runs (G-012 ordering). **PASS (2026-08-12, round 1).** Re-confirm on round-2 sessions.

- [x] S-7: **Screenshot captured** — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2711/e2e/smoke.jpeg")` succeeds. **PASS (2026-08-12, round 1):** multiple screenshots captured.

## #2717/#2723 quick path (session token bar — now at the TOP per AC1)

- [x] S-8: **Session token bar visible at the TOP of the main graph view (#2723 update).** Opening Mission Monitor with an existing session selected shows the session bar at the TOP of the main view (above the graph canvas) with the five category labels (Input / Cache / Reasoning / Output / Total), values right-aligned. Quick smoke — full assertions live in F-23/F-24. Evidence: bar screenshot. **PASS (2026-08-13, round 1):** Bar at top (barAboveCanvas=true). Abbreviated labels In:/Ca:/Re:/Ou:/Σ. All 5 categories + Total present.

- [x] S-9: **Selecting a session populates the session bar (top).** Clicking a session in the session list populates the bar cells (non-NaN values); with no session selected the bar is hidden (R-1). Quick smoke — full selection-update assertions live in F-14/F-21. **PASS (2026-08-13, round 1):** Session selected, bar populated with In=7,397, Ca=28,072,704, Re=19,645, Ou=10,543, Σ=28,110,289. No NaN values.

- [x] S-10: **No subagent nodes in a subagent-invoking session (AC5 quick path).** In a session that dispatched a @-subagent, the DOM snapshot contains zero SubagentNode elements and the graph shows only the parent session's chat nodes. Quick smoke — full assertions live in F-32/F-33/R-17. Evidence: DOM snapshot + screenshot. **FAIL (2026-08-13, round 1):** Child session `ses_0077bd6cfffezzJDXRbd2Rvg2D` has 2 nodes visible. See F-32 for details. **PASS (2026-08-13, round 2):** Fresh session parent `ses_0067289c3ffe33xpYFW5IENImt` dispatches child `ses_006726b06ffeyEvLGmQReWOr7s`. DOM: 0 subagentNode elements, 2 agentNode elements only. `telemetry_spans` child `fredo.llm` span carries `"agent.type":"subagent"` (round-2 fix).

## #2734 quick path (Run CLI right-sidebar = session-total source of truth)

- [x] S-11: **Run CLI right sidebar visible (quick path, no force-maximize).** Launch a session via Run CLI (maomaolabs toolbar) and leave the opencode window at its NATURAL size (do NOT force-maximize). The opencode window shows a RIGHT SIDEBAR with the session's total tokens used — readable (no clipping). Quick smoke — full reconciliation assertions live in F-36. Evidence: window screenshot with the right sidebar fully visible. **PASS (2026-08-14, round 1):** `run-cli-terminal` at natural size (historically maximized to 1920×1080). PTY buffer confirms sidebar text: "Context", "26,734 tokens", "13% used", "26.7K (13%)", "$0.00 spent". MCP and LSP sections visible. Right sidebar fully visible. Screenshot captured.

## #2739 quick path (Tools summary node)

- [x] S-12: **ToolsNode appears for a tool-call session (quick path).** Run Fixture T1 (Run CLI, open Mission Monitor first, `$env:OPENCODE_ENABLE_TELEMETRY="1"` before the run). The graph shows a ToolsNode to the right of the tool-calling chat node with a visible title and ≥1 accordion item. Quick smoke — full assertions live in F-40..F-50. Evidence: ToolsNode screenshot + DOM snapshot. **FAIL (2026-08-14, round 1):** BLOCKER — Run CLI opencode model (DeepSeek V4 Flash Free) not responding. Zero OTLP spans emitted from any Run CLI session. `fredo emit` cannot substitute (Hook transport filtered by `otlp_grpc` contract). Question blocker posted. Code-level verification only: TypeScript build passes, ToolsNode component exists (295 lines), ECE contract registered, unit tests exist. **PASS (2026-08-14, round 2):** Root cause was `write_pty_input` missing trailing `\r` — prompts typed but never submitted. With `\r`, opencode responded. Session `ses_000e5ccf1ffeKK3KUW0Evqfyr8`: 3 tool_use spans (read/bash/grep) + 3 chat spans in `telemetry_spans`. DOM: `button "Tools summary — 3 calls, 0 tokens"` with 3 accordion items. Edge from `agent-..._4` to `tools-..._4` visible. Exchange tokens: In=24,791, Ca=1,920, Re=136, Ou=181, Σ=27,028.

## #2743 quick path (Mission Control polish surface)

**Round 4 execution note (2026-08-15):** S-1/S-2/S-3/S-4 smoke evidence refreshed: React mounted, Mission Monitor rendered, Run CLI opened, `write_pty_input` with trailing CR completed a fresh session, and the console contained only the pre-existing `motion() is deprecated` warning. S-13..S-16 were not all completed as standalone captures.

- [ ] S-13: **Full labels + comma figures visible (quick path).** Open Mission Monitor with a session that has a node ≥1000 tokens. The Total Top Bar shows full labels (INPUT/CACHE/REASONING/OUTPUT/TOTAL) and comma-grouped figures; a ChatNode token row shows "Token Usage" left + comma figures right. Quick smoke — full assertions in F-52/F-53/F-54. Evidence: bar + node screenshot.

- [ ] S-14: **Double-click opens, single-click doesn't (quick path).** Single-click a chat node (panel stays closed), double-click it (panel opens for that node). Quick smoke — full assertions in F-57. Evidence: before/after screenshots.

- [ ] S-15: **Auto fitView on session switch (quick path).** With ≥2 sessions, switch sessions: the graph re-fits so all nodes are visible without manual zoom/pan. Quick smoke — full assertions in F-62. Evidence: before/after switch screenshots.

- [ ] S-16: **Per-tool duration + indicator in a tool-call session (quick path).** Run a tool-call exchange (≥1 tool); each ToolsNode entry shows a duration (e.g. `1.2s`) and a success/error indicator at its right. Quick smoke — full assertions in F-59/F-60. Evidence: ToolsNode screenshot.

## #2745 quick path (SubagentNode + task exclusion)

- [ ] S-17: **SubagentNode appears for a task-dispatch session (quick path).** Run Fixture S1 (Run CLI, open Mission Monitor first, `$env:OPENCODE_ENABLE_TELEMETRY="1"` before the run, @-subagent dispatch + other tool calls). The graph shows exactly one `subagentNode` element per dispatch to the RIGHT of the parent chat node, in its own column (x ≈ parent.x + 1128), plus the ToolsNode listing the other tools WITHOUT a `task` item. Quick smoke — full assertions in F-64/F-67. Evidence: SubagentNode screenshot + DOM snapshot + `telemetry_spans` `fredo.tool.task` query.

- [ ] S-18: **No spurious SubagentNodes in a no-dispatch session (quick path).** Run Fixture S2 (tool calls, no dispatch). The DOM contains zero `subagentNode` elements; the graph shows only chat nodes + ToolsNodes. Quick smoke — full assertions in F-69/R-34. Evidence: DOM snapshot + screenshot. **CRITICAL:** after S2 completes, SELECT S2 in the Mission Monitor session list before capturing — the evidence must show the S2 graph (zero subagent nodes), not whatever session was previously selected. Round 5 of #2745 failed because the captured image showed the stale S1 graph.

- [ ] S-19: **App still boots clean with the cleanup (quick path).** After the #2745 changes, `pnpm --filter @fredo/ui build` passes and Mission Monitor opens with no console `Error:`/`Uncaught`; the session bar, chat chain, and ToolsNodes render as before; zero `ToolNode`/`FileNode` references in the DOM. Quick smoke — full assertions in F-75/R-37. Evidence: build log + console excerpt + graph screenshot.

## #2748 quick path (session names + rename + SUBAGENTS + header/status removal)

### Tester run 1 (2026-08-17) — FAIL / incomplete live run

- S-20: **FAIL** — rows showed timestamp labels rather than first-message names, although compact start date-time lines rendered and no `N deliveries` text was present.
- S-21: **UNVERIFIED** — rename/restart not completed; mount logged missing `feature_mission_monitor_session_names` table.
- S-22: **UNVERIFIED** — no subagent fixture.
- S-23: **FAIL** — DOM/screenshot showed dialog title `Mission Monitor`, so the no-remnant scan fails.
- S-24: **UNVERIFIED** — no live status transition or both-theme capture completed.

- [ ] S-20: **Name + date visible (quick path).** Open Mission Monitor with a session that has a chat message (any existing session, or a quick one-message Run CLI session — open Mission Monitor FIRST, G-012). The sidebar row shows a Name line (the first message's text, or the timestamp label for a no-chat session) with the session's start date-time below it — and NO `N deliveries` line anywhere on the row. Quick smoke — full assertions in F-76/F-77. Evidence: drawer screenshot.

- [ ] S-21: **Rename persists across restart (quick path).** Hover a session row, click the edit icon (aria-label "Rename session"), type a distinctive custom name, Enter to save; then close and reopen the Mission Monitor panel (a full app restart if feasible) — the custom name still displays on that row. Quick smoke — full assertions in F-80. Evidence: before/after screenshots.

- [ ] S-22: **SUBAGENTS on the bar (quick path).** In a session that dispatched a @-subagent (after the child completes — the figure is 0 while in flight), the session token bar shows a SUBAGENTS figure between the five parent figures and TOTAL, and TOTAL = parent five-way + SUBAGENTS. Quick smoke — full assertions in F-83. Evidence: bar screenshot.

- [ ] S-23: **No header strip (quick path).** With a session selected, the panel top shows the session token bar as the TOP row — no `Mission Monitor · <label> · <sessionId>` header strip above it; DOM text scan finds no `Mission Monitor` / `<sessionId>` header remnant. Quick smoke — full assertions in F-87/F-88. Evidence: panel-top screenshot + DOM text scan.

- [ ] S-24: **Zero status badges (quick path).** In a session with a completed node (and a subagent dispatch if available), a DOM text scan finds no WORKING / DONE / FAILED / COMPACTED badge text on any Agent/Subagent/Tools node, and node borders are plain neutral (`var(--border-color)`) in the current theme (PO-amended round 4 — Mission Monitor is a fixed dark surface, no light-theme verification). Quick smoke — full assertions in F-89/F-90/F-91. Evidence: graph screenshot + DOM text scan (current theme).

### AC2 rename driving recipe (round 5, #2748)

> **Authoritative driver recipe for the full AC2 live flow.** Round-4 FAIL root cause: the inline-input selector became unavailable after the first Enter-save because the row re-renders with the custom name, detaching any pre-save element handle — a DRIVER (stale-handle) issue, NOT a product defect (source-verified rounds 3–5: Enter-save `SessionHistoryDrawer.tsx:351-354`, Esc-cancel `:355-358` + `cancelRename:177-181`, empty-clear `commitRename:164-175` + `saveCustomName('')`→NULL, focus return `closeRename:159-161`, persistence round-trip `persistence.ts:434-471` + `:176-192`; 392/392 unit tests green).
>
> **Hard rules:** (1) run EVERY step as its own `tauri_webview_execute_js` snippet — NEVER cache an element handle across snippets (every re-render swaps the DOM subtree; re-`querySelector` after every save/reopen); (2) wait ~300 ms after each snippet that mutates state (click/save/cancel/close/reopen) before the next; (3) each snippet is a self-contained IIFE ending in `JSON.stringify(...)` (returns the assertion to the tester); (4) per-step scratch state lives on `window.__e2e2748` (a plain property — persists across `tauri_webview_execute_js` calls in the same webview); (5) never use MCP resolveRef/resolveAll — plain `querySelector` only.
>
> **DOM facts (from source, spec/2748 tip):** row = `div.mm-session-row[role="button"]` with `aria-label` = the row's display name (`SessionHistoryDrawer.tsx:294-299`); edit button = `button.mm-row-edit-btn[aria-label="Rename session"]` (`:414-437`, resting `opacity:0; pointer-events:none` via the `.mm-row-edit-btn` CSS — still clickable programmatically, `.click()`/dispatched `MouseEvent` bypass CSS); inline input = `input.mm-rename-input[aria-label="Session name"]` (`:346-376`); panel window container = `div#window-mission-monitor` (feature id `mission-monitor`), its chrome close button = `#window-mission-monitor button[data-action="close"]` (maomaolabs core `dist/index.es.js:207-218`, enabled because `gridConfig.closable` defaults true); reopen item = `[role="toolbar"][aria-label="Desktop Toolbar"] button[aria-label="Mission Monitor"]` (toolbar item button `aria-label` = feature name — `dist/index.es.js:277-288`).
>
> **Step A — baseline + activation row A (Enter-save):**
> ```js
> (() => {
>   window.__e2e2748 = window.__e2e2748 || {};
>   const rows = [...document.querySelectorAll('.mm-session-row')];
>   if (rows.length === 0) return JSON.stringify({ ok: false, error: 'no .mm-session-row' });
>   const rowA = rows[0];
>   window.__e2e2748.originalA = rowA.getAttribute('aria-label');
>   const editBtn = rowA.querySelector('.mm-row-edit-btn') ?? rowA.querySelector('button[aria-label="Rename session"]');
>   if (!editBtn) return JSON.stringify({ ok: false, error: 'no edit btn' });
>   editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
>   return JSON.stringify({ ok: true, originalA: window.__e2e2748.originalA });
> })()
> ```
> **Step B — assert the inline input opened, focused, prefilled:**
> ```js
> (() => {
>   const input = document.querySelector('input[aria-label="Session name"]');
>   if (!input) return JSON.stringify({ ok: false, error: 'input not found' });
>   return JSON.stringify({ ok: true, focused: document.activeElement === input, prefilled: input.value, selectAll: input.selectionStart === 0 && input.selectionEnd === input.value.length });
> })()
> ```
> **Step C — set a distinctive custom name via the native setter (never `input.value =` — React would discard it):**
> ```js
> (() => {
>   const input = document.querySelector('input[aria-label="Session name"]');
>   if (!input) return JSON.stringify({ ok: false, error: 'input not found' });
>   const name = 'e2e-2748-r5-' + Date.now();
>   window.__e2e2748.nameA = name;
>   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, name);
>   input.dispatchEvent(new Event('input', { bubbles: true }));
>   return JSON.stringify({ ok: true, name });
> })()
> ```
> **Step D — Enter saves (bubbled KeyboardEvent):**
> ```js
> (() => {
>   const input = document.querySelector('input[aria-label="Session name"]');
>   if (!input) return JSON.stringify({ ok: false, error: 'input not found' });
>   input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
>   return JSON.stringify({ ok: true });
> })()
> ```
> **Step E — assert row A now shows the custom name (FRESH query — the pre-save handle is dead):**
> ```js
> (() => {
>   const name = window.__e2e2748 && window.__e2e2748.nameA;
>   const row = name ? [...document.querySelectorAll('.mm-session-row')].find(r => r.getAttribute('aria-label') === name) : null;
>   return JSON.stringify({ ok: !!row, rowAriaLabel: row ? row.getAttribute('aria-label') : null, rowText: row ? row.textContent : null });
> })()
> ```
> **Step F — RE-QUERY row A (fresh handle) → empty-clear save → fallback to derived name:**
> ```js
> (() => {
>   const name = window.__e2e2748 && window.__e2e2748.nameA;
>   const rowA = name ? [...document.querySelectorAll('.mm-session-row')].find(r => r.getAttribute('aria-label') === name) : document.querySelector('.mm-session-row');
>   if (!rowA) return JSON.stringify({ ok: false, error: 'row A not found' });
>   const editBtn = rowA.querySelector('button[aria-label="Rename session"]');
>   if (!editBtn) return JSON.stringify({ ok: false, error: 'no edit btn' });
>   editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
>   return JSON.stringify({ ok: true });
> })()
> ```
> Wait ~300 ms, then **clear the input to `''`** (native setter):
> ```js
> (() => {
>   const input = document.querySelector('input[aria-label="Session name"]');
>   if (!input) return JSON.stringify({ ok: false, error: 'input not found' });
>   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '');
>   input.dispatchEvent(new Event('input', { bubbles: true }));
>   return JSON.stringify({ ok: true });
> })()
> ```
> Then **Enter** (same keydown snippet as Step D). Then **assert the custom name is GONE and the original derived name is back:**
> ```js
> (() => {
>   const name = window.__e2e2748 && window.__e2e2748.nameA;
>   const original = window.__e2e2748 && window.__e2e2748.originalA;
>   const rows = [...document.querySelectorAll('.mm-session-row')];
>   const customGone = name ? !rows.some(r => r.getAttribute('aria-label') === name) : true;
>   const derivedBack = rows.some(r => r.getAttribute('aria-label') === original);
>   return JSON.stringify({ ok: customGone && derivedBack, customGone, derivedBack, rowLabels: rows.map(r => r.getAttribute('aria-label')) });
> })()
> ```
> **Step G — row B: fresh handle → click edit → type junk → Escape → pre-edit name restored:**
> ```js
> (() => {
>   window.__e2e2748 = window.__e2e2748 || {};
>   const rows = [...document.querySelectorAll('.mm-session-row')];
>   const rowB = rows[1] ?? rows[0];
>   if (!rowB) return JSON.stringify({ ok: false, error: 'no row B' });
>   window.__e2e2748.originalB = rowB.getAttribute('aria-label');
>   rowB.querySelector('button[aria-label="Rename session"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
>   return JSON.stringify({ ok: true, originalB: window.__e2e2748.originalB });
> })()
> ```
> Wait ~300 ms, type junk:
> ```js
> (() => {
>   const input = document.querySelector('input[aria-label="Session name"]');
>   if (!input) return JSON.stringify({ ok: false, error: 'input not found' });
>   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'JUNK-NOT-SAVED-' + Date.now());
>   input.dispatchEvent(new Event('input', { bubbles: true }));
>   return JSON.stringify({ ok: true });
> })()
> ```
> Escape (cancels — `onRename` NOT called):
> ```js
> (() => {
>   const input = document.querySelector('input[aria-label="Session name"]');
>   if (!input) return JSON.stringify({ ok: false, error: 'input not found' });
>   input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
>   return JSON.stringify({ ok: true });
> })()
> ```
> Assert restore (no junk anywhere, original B aria-label back):
> ```js
> (() => {
>   const original = window.__e2e2748 && window.__e2e2748.originalB;
>   const rows = [...document.querySelectorAll('.mm-session-row')];
>   const restored = rows.some(r => r.getAttribute('aria-label') === original);
>   const junkGone = !rows.some(r => /JUNK-NOT-SAVED/.test(r.getAttribute('aria-label') ?? ''));
>   return JSON.stringify({ ok: restored && junkGone, restored, junkGone, rowLabels: rows.map(r => r.getAttribute('aria-label')) });
> })()
> ```
> **Step H — close/reopen persistence (FIX-12): rename row A to a distinctive name, Enter, close the panel, reopen, assert the custom name survived.**
> H1 — rename row A (`e2e-2748-r5-persist-<ts>`): re-query row A by its derived-name aria-label, click edit, then reuse Step C/D with the persist name:
> ```js
> (() => {
>   const original = window.__e2e2748 && window.__e2e2748.originalA;
>   const rowA = original ? [...document.querySelectorAll('.mm-session-row')].find(r => r.getAttribute('aria-label') === original) : document.querySelector('.mm-session-row');
>   if (!rowA) return JSON.stringify({ ok: false, error: 'row A not found' });
>   const persistName = 'e2e-2748-r5-persist-' + Date.now();
>   window.__e2e2748.persistName = persistName;
>   rowA.querySelector('button[aria-label="Rename session"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
>   return JSON.stringify({ ok: true, persistName });
> })()
> ```
> Wait ~300 ms, set the value with the native setter (`persistName` — Step C pattern), `input` event, Enter (Step D pattern). Then **close the panel** via its chrome close button:
> ```js
> (() => {
>   const btn = document.querySelector('#window-mission-monitor button[data-action="close"]');
>   if (!btn) return JSON.stringify({ ok: false, error: 'close button not found' });
>   btn.click();
>   return JSON.stringify({ ok: true });
> })()
> ```
> H2 — wait for the window to unmount, then open the toolbar menu and **reopen the panel** (fresh DOM each step):
> ```js
> (() => {
>   const gone = !document.querySelector('#window-mission-monitor');
>   const launcher = document.querySelector('[role="toolbar"][aria-label="Desktop Toolbar"] button[aria-label="Open Menu"]') ?? document.querySelector('[role="toolbar"][aria-label="Desktop Toolbar"] button[aria-label="Close Menu"]');
>   if (launcher) launcher.click();
>   return JSON.stringify({ gone, launcherClicked: !!launcher });
> })()
> ```
> Wait ~300 ms, then click the reopen item:
> ```js
> (() => {
>   const item = [...document.querySelectorAll('[role="toolbar"][aria-label="Desktop Toolbar"] button')].find(b => b.getAttribute('aria-label') === 'Mission Monitor');
>   if (!item) return JSON.stringify({ ok: false, error: 'toolbar item not found' });
>   item.click();
>   return JSON.stringify({ ok: true });
> })()
> ```
> H3 — wait for the drawer rows to render (`loadPersistedSessions()` is async IPC), then **assert the persisted custom name is displayed** (fresh DOM query):
> ```js
> (() => {
>   const persistName = window.__e2e2748 && window.__e2e2748.persistName;
>   const rows = [...document.querySelectorAll('.mm-session-row')];
>   const found = persistName ? rows.some(r => r.getAttribute('aria-label') === persistName) : false;
>   return JSON.stringify({ ok: found, persistName, rowLabels: rows.map(r => r.getAttribute('aria-label')) });
> })()
> ```
> **Optional (no app restart needed — SQLite load covers both panel close/reopen AND app restart, `persistence.ts:176-192`):** restart the app via the dev-env and repeat H3 — the custom name loads from the `session_names` table on mount (`rowToSession` merge at `persistence.ts:571-593`).
>
> **Evidence to capture:** Step E rowText (custom name), Step F rowLabels (derived restored), Step G rowLabels (junk gone), H1 screenshot (`ac2-r5-persist-saved.jpeg`), H3 rowLabels + screenshot (`ac2-r5-persist-reopened.jpeg`). Console check after the full flow (`tauri_read_logs`): no `Error:`/`Uncaught`/`Maximum update depth exceeded`.

## #2750 quick path (subagent-inclusive cost + name filter + status-free panel + single subagent node)

- [ ] S-25: **Bar ESTIMATED COST includes subagents (quick path).** Run Fixture #2750-A (Run CLI, open Mission Monitor FIRST, `$env:OPENCODE_ENABLE_TELEMETRY="1"` BEFORE the run, ≥1 @-subagent dispatch; wait for the child to complete). The session token bar's ESTIMATED COST cell shows a value ≥ the parent-only sum (parent Σ `cost_usd` + Σ `childCost`). Quick smoke — full byte-exact assertions in F-94/F-95. Evidence: bar screenshot + `telemetry_spans` query (chat `cost_usd` + task `child_total_cost_usd`).

- [ ] S-26: **Filter by name (quick path).** In a session list with ≥1 custom-named and ≥1 derived-named session, type a fragment of a session's display name into the filter input (drive via `tauri_webview_execute_js` + querySelector/KeyboardEvent — never `window.__MCP__.resolveRef`). The matching session appears in the list. Quick smoke — full assertions in F-102..F-105. Evidence: filtered-list screenshot + DOM readout.

- [ ] S-27: **Double-click panel has no status badge (quick path).** Double-click a chat node. The detail panel opens with NO status badge in its header and no `Status` row; a DOM text scan of the panel finds no status token. Quick smoke — full assertions in F-98..F-101. Evidence: panel screenshot + DOM text scan.

- [ ] S-28: **Single subagent node (quick path).** In a subagent-dispatching session (after the child completes), the DOM contains exactly one `subagentNode` element per user-requested dispatch — no duplicate node showing the internal tool-executor's thinking. Quick smoke — full assertions in F-106..F-108. Evidence: DOM snapshot (subagentNode count) + `telemetry_spans` `fredo.tool.task` span count.

## #2752 quick path (Chain/Force toggle + live force layout)

- [ ] S-29: **Toggle control visible on the canvas (quick path).** Open Mission Monitor with a session selected (any existing session, or a quick one-message Run CLI session — open MM FIRST, G-012). The floating `data-testid="mm-layout-toggle"` control with "Chain" and "Force" segments is visible over the canvas; Chain shows `aria-pressed="true"` by default (no stored value). Quick smoke — full assertions in F-113/F-114. Evidence: canvas screenshot + DOM snapshot.

- [ ] S-30: **Force toggles, glides, and settles (quick path).** Click Force on the #2752 L1 fixture session. The graph re-renders in a force layout — nodes move from their chain slots (sample positions via `tauri_webview_execute_js` at ~100ms intervals: at least one intermediate frame before settling), then movement STOPS (positions byte-identical across ≥500ms). Click Chain — the deterministic chain layout returns. Quick smoke — full assertions in F-115..F-119. Evidence: t0/t-mid/t-settled screenshots + sampled position log + console excerpt (no errors).

- [ ] S-31: **Mode persists across panel close/reopen (quick path).** Switch to Force, close the Mission Monitor panel, reopen it. The control shows Force active and the graph renders in the force layout (persisted via the `Fredo_mm_*` key). Quick smoke — full assertions in F-120. Evidence: pre-close + post-reopen screenshots + settings-store readout.

## #2754 quick path (hybrid Force — chain spine + orbiting companions)

- [ ] S-32: **Hybrid Force renders: chat spine static, companions floating (quick path).** Open Mission Monitor FIRST (G-012), run Fixture H1 (≥3 chat messages + ≥1 tool exchange + ≥1 @-subagent dispatch; `$env:OPENCODE_ENABLE_TELEMETRY="1"` before the run), then click Force. The chat nodes stay in their vertical chain (oldest top → newest bottom, x=0) while the ToolsNode/SubagentNode float around their parents. Discriminator: sample chat-node positions via a SYNCHRONOUS `tauri_webview_execute_js` snippet (G-055) at t0 and again after ~500ms — chat x/y byte-identical (spine static) while ≥1 companion differs. Quick smoke — full assertions in F-133/F-135/F-138. Evidence: t0/settled position logs + screenshot.

- [ ] S-33: **Hybrid Force settles (quick path).** After switching to Force on Fixture H1, wait for motion to stop, then sample companion positions twice ≥500ms apart (synchronous snippets only — G-055). Positions byte-identical across the window (settled); console clean. Quick smoke — full assertions in F-142/F-143. Evidence: settle-window position log + console excerpt.

- [ ] S-34: **Mode persists for the hybrid (quick path).** Switch to Force (hybrid), close the MM panel, reopen it. The control shows Force active and the graph renders the HYBRID (chat spine static — NOT the #2752 all-nodes force layout). Quick smoke — full assertions in F-140. Evidence: pre-close + post-reopen screenshots + settings-store readout (`Fredo_mm_layout_mode`).

## #2756 quick path (TRUE disjoint force layout)

**Round 4 execution note (2026-08-22):** Phase 0 was blocked on the mandatory PTY-over-IPC probe: the running app returned `Unsupported Tauri command: write_pty_input`. Run CLI stayed at `Starting OpenCode…`, so the G-060 fixture and S-35..S-37 assertions were not run. No substitute launch or mock events were used.

- [ ] S-35: **Force mode: all nodes move, clusters form (quick path).** Open Mission Monitor FIRST (G-012), run Fixture D1 (≥3 exchanges incl. a tool call + an @-subagent dispatch; `$env:OPENCODE_ENABLE_TELEMETRY="1"` before the run), SELECT the session, click Force. Sample node transforms via SYNCHRONOUS `execute_js` (G-055/G-057) at t0 and ~500ms later: ≥1 CHAT node AND ≥1 companion moved (chat nodes are force-simulated — the #2754 static spine is gone); after settle, each exchange's nodes sit closer to each other than to any other exchange's nodes (cohesion spot-check). Quick smoke — full assertions in F-147/F-148. Evidence: t0/settled transform logs + screenshot.

- [ ] S-36: **Force settles and Chain round-trip restores (quick path).** After switching to Force on D1, sample positions twice ≥500ms apart on the quiescent graph (synchronous snippets — G-055): byte-identical (settled); console clean. Click Chain: positions byte-identical to the pre-toggle chain baseline (spot-check ≥2 nodes). Quick smoke — full assertions in F-150/F-151. Evidence: settle-window log + baseline-vs-return transforms + console excerpt.

- [ ] S-37: **Force persists across panel close/reopen (quick path).** Switch to Force (disjoint), close the MM panel, reopen it. The control shows Force active and the graph re-renders in the disjoint force layout (persisted `Fredo_mm_layout_mode`). Quick smoke — full assertions in F-151. Evidence: pre-close + post-reopen screenshots + settings-store readout.
