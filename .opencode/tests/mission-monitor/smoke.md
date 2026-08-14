# Mission Monitor — Smoke Test Suite

Feature domain: `mission-monitor`. Standard boilerplate adapted from `.opencode/tests/README.md` plus feature-specific quick paths.
Round 2: S-4 re-opened — Run CLI must actually launch (the AC1 method depends on it); the round-1 "environment issue" self-resolution is not acceptable.

Conventions: ID prefix `S-`. Observable expected outcomes.

## Feature usage: Run CLI (launching a live opencode session)

The Mission Monitor token-accuracy tests compare node token counts against a REAL opencode session launched through Fredo's **Run CLI** feature — its TUI shows the session's **context / used-context** meter, which is the ground truth for per-message token consumption.

How to drive it (discoverable here — no other doc needed):
1. **Open the feature:** in the Fredo app, open the **Run CLI** desktop item (maomaolabs toolbar → Run CLI). The launcher fires `open_run_cli`; the backend opens a dedicated terminal window (Tauri window label `run-cli-terminal`; work dir read from the feature's settings, key `run_cli_work_dir`).
2. **Maximize the window:** resize/maximize `run-cli-terminal` (`tauri_manage_window`, windowId=`run-cli-terminal`) so the opencode TUI is fully visible.
3. **Confirm opencode is OPEN via the Tauri MCP DOM/HTML (not a guess):** snapshot the `run-cli-terminal` window (`tauri_webview_dom_snapshot`, windowId=`run-cli-terminal`) and use `tauri_webview_execute_js` (e.g. check for the ghostty `<canvas>` element, its dimensions, and any focusable input) to verify the opencode TUI has rendered and to LOCATE the input field. Also capture a screenshot (`tauri_webview_screenshot`, windowId=`run-cli-terminal`) and review it with VISION to confirm opencode is open and where the input is.
4. **WAIT for opencode to finish loading — then SEND a message via `write_pty_input`.** The "Starting OpenCode…" overlay clears when the opencode TUI renders (a loading state, NOT stuck — allow up to ~30-60s on first launch; do NOT report a broken launch while the overlay is up). **Send messages to opencode via the backend `write_pty_input` IPC command** (the reliable, programmatic path — the ghostty canvas swallows webview keyboard/`type` events, so the TUI input is NOT reliably drivable from the webview). The conversation populates the opencode **right sidebar**, which shows the session's total tokens used. Read that sidebar total from the PTY buffer / `get_pty_buffer` before/after each message.
5. **Cross-check nodes + session bar:** compare each Mission Monitor chat node's prompt/completion/total tokens and the session-total bar against the sidebar total.
6. **End the session:** the terminal toolbar's "Stop" button (calls `close_run_cli`).

**Do NOT judge the opencode session from the dev-environment console logs.** The dev environment's local LLM (LlmEngine / llama-server) produces its own logs that are UNRELATED to the opencode session. The opencode session's state and evidence live ONLY in: the `run-cli-terminal` PTY buffer (`get_pty_buffer` / `run-cli-output` events), `write_pty_input`, and `telemetry_spans` (`fredo.session`, `fredo.llm`). Console logs from the dev environment must not be used to conclude anything about opencode (misread as "the local LLM is opencode" on #2739).

The terminal output is also streamed as `run-cli-output` events / buffered in the RunCliState output buffer — the opencode TUI's rendered text (including the sidebar numbers) may be greppable there if programmatic access is needed.

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

- [x] S-11: **Run CLI right sidebar visible when maximized (R2 quick path).** Launch a session via Run CLI (maomaolabs toolbar) and maximize the opencode window. The opencode window shows a RIGHT SIDEBAR with the session's total tokens used — readable (no clipping). Quick smoke — full reconciliation assertions live in F-36. Evidence: maximized-window screenshot with the right sidebar fully visible. **PASS (2026-08-14, round 1):** `run-cli-terminal` maximized to 1920×1080. PTY buffer confirms sidebar text: "Context", "26,734 tokens", "13% used", "26.7K (13%)", "$0.00 spent". MCP and LSP sections visible. Right sidebar fully visible. Screenshot captured.

## #2739 quick path (Tools summary node)

- [ ] S-12: **ToolsNode appears for a tool-call session (quick path).** Run Fixture T1 (Run CLI, open Mission Monitor first, `$env:OPENCODE_ENABLE_TELEMETRY="1"` before the run). The graph shows a ToolsNode to the right of the tool-calling chat node with a visible title and ≥1 accordion item. Quick smoke — full assertions live in F-40..F-50. Evidence: ToolsNode screenshot + DOM snapshot.
