# Mission Monitor — Smoke Test Suite

Feature domain: `mission-monitor`. Standard boilerplate adapted from `.opencode/tests/README.md` plus feature-specific quick paths.
Round 2: S-4 re-opened — Run CLI must actually launch (the AC1 method depends on it); the round-1 "environment issue" self-resolution is not acceptable.

Conventions: ID prefix `S-`. Observable expected outcomes.

## Feature usage: Run CLI (launching a live opencode session)

The Mission Monitor token-accuracy tests compare node token counts against a REAL opencode session launched through Fredo's **Run CLI** feature — its TUI shows the session's **context / used-context** meter, which is the ground truth for per-message token consumption.

How to drive it (discoverable here — no other doc needed):
1. **Open the feature:** in the Fredo app, open the **Run CLI** entry (feature grid → Run CLI). On mount it auto-launches the opencode CLI into a dedicated terminal window (Tauri window label `run-cli-terminal`, launched by `open_run_cli`; work dir read from the feature's settings, key `run_cli_work_dir`).
2. **Maximize the window:** resize/maximize `run-cli-terminal` (`tauri_manage_window`, windowId=`run-cli-terminal`) so the opencode TUI is fully visible.
3. **Read the context meter:** the opencode TUI shows the session's context / used-context. Send a message, then read the meter before/after each message to derive per-message token consumption.
4. **Cross-check nodes:** compare each Mission Monitor chat node's prompt/completion/total tokens against the derived per-message numbers.
5. **End the session:** the Run CLI panel's "Stop" button (calls `close_run_cli`).

The terminal output is also streamed as `run-cli-output` events / buffered in the RunCliState output buffer if programmatic access is needed.

**Never touch opencode's config/install outside the repo** (`~/.config/opencode/*`, `%APPDATA%\com.fredo.app\*`) — the sandbox denies it (G-008/G-009) and you never need it: Run CLI launches opencode itself.

## Cases

- [x] S-1: **App window renders** — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`. **PASS (2026-08-12, round 1):** DOM snapshot shows full app structure.

- [x] S-2: **No console errors** — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`. **PASS (2026-08-12, round 1):** no product errors; ResizeObserver benign.

- [x] S-3: **Mission Monitor surface reachable** — the Mission Monitor toolbar item/entry renders the panel with its expected elements (graph canvas, session list). **PASS (2026-08-12, round 1).** Re-confirm on round-2 sessions.

- [ ] S-4: **Run CLI launches a session (RE-OPENED).** The Run CLI entry renders its launch panel AND actually launches the opencode window (the AC1 verification method depends on it). Round-1 note (2026-08-12): panel showed "Launching..." indefinitely and the tester self-resolved with `opencode run` — INVALIDATED. Round 2: if "Launching..." persists after one retry, STOP and report a `Question` blocker; do not substitute another launch method.

- [ ] S-5: **Telemetry Settings accessible** — gear/nav opens the settings dialog with sections visible.

- [x] S-6: **ECE contract registration on mount** — opening Mission Monitor emits `registerEventContracts()` (visible via IPC monitor / delivery traffic) before any session runs (G-012 ordering). **PASS (2026-08-12, round 1).** Re-confirm on round-2 sessions.

- [x] S-7: **Screenshot captured** — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2711/e2e/smoke.jpeg")` succeeds. **PASS (2026-08-12, round 1):** multiple screenshots captured.

## #2717/#2723 quick path (session token bar — now at the TOP per AC1)

- [x] S-8: **Session token bar visible at the TOP of the main graph view (#2723 update).** Opening Mission Monitor with an existing session selected shows the session bar at the TOP of the main view (above the graph canvas) with the five category labels (Input / Cache / Reasoning / Output / Total), values right-aligned. Quick smoke — full assertions live in F-23/F-24. Evidence: bar screenshot. **PASS (2026-08-13, round 1):** Bar at top (barAboveCanvas=true). Abbreviated labels In:/Ca:/Re:/Ou:/Σ. All 5 categories + Total present.

- [x] S-9: **Selecting a session populates the session bar (top).** Clicking a session in the session list populates the bar cells (non-NaN values); with no session selected the bar is hidden (R-1). Quick smoke — full selection-update assertions live in F-14/F-21. **PASS (2026-08-13, round 1):** Session selected, bar populated with In=7,397, Ca=28,072,704, Re=19,645, Ou=10,543, Σ=28,110,289. No NaN values.

- [x] S-10: **No subagent nodes in a subagent-invoking session (AC5 quick path).** In a session that dispatched a @-subagent, the DOM snapshot contains zero SubagentNode elements and the graph shows only the parent session's chat nodes. Quick smoke — full assertions live in F-32/F-33/R-17. Evidence: DOM snapshot + screenshot. **FAIL (2026-08-13, round 1):** Child session `ses_0077bd6cfffezzJDXRbd2Rvg2D` has 2 nodes visible. See F-32 for details. **PASS (2026-08-13, round 2):** Fresh session parent `ses_0067289c3ffe33xpYFW5IENImt` dispatches child `ses_006726b06ffeyEvLGmQReWOr7s`. DOM: 0 subagentNode elements, 2 agentNode elements only. `telemetry_spans` child `fredo.llm` span carries `"agent.type":"subagent"` (round-2 fix).

## #2734 quick path (Run CLI right-sidebar = session-total source of truth)

- [ ] S-11: **Run CLI right sidebar visible when maximized (R2 quick path).** Launch a session via Run CLI (maomaolabs toolbar) and maximize the opencode window. The opencode window shows a RIGHT SIDEBAR with the session's total tokens used — readable (no clipping). Quick smoke — full reconciliation assertions live in F-36. If no right-sidebar total is visible after maximize, STOP and report a `Question` gap (AC1/AC5 depend on it); do not fall back to the context meter or `opencode run`. Evidence: maximized-window screenshot with the right sidebar fully visible.
