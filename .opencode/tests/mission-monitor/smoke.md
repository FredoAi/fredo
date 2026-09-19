# Mission Monitor — Smoke (Spec #2791 — Ghost sessions)

## Standard boilerplate

- [x] S-1 (PASS 2026-09-02 #2791): App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [x] S-2 (PASS 2026-09-02 #2791): No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [x] S-3 (PASS 2026-09-02 #2791): Feature surface reachable — Mission Monitor entry point renders its expected elements (session list + graph canvas).
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible. (NOT exercised this round — not part of the #2791 QA plan.)
- [x] S-5 (PASS 2026-09-02 #2791): Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/smoke.jpeg")` succeeds.

## Mission Monitor quick path

- [x] S-6 (PASS 2026-09-02 #2791): Open Mission Monitor from the maomaolabs toolbar; the session list renders.
- [x] S-7 (PASS 2026-09-02 #2791): Select a session — the canvas renders the graph (or the ghost explanatory state for a ghost session); NEVER a silent blank canvas.
- [x] S-8 (PASS 2026-09-02 #2791): Run CLI feature reachable from the desktop toolbar (`button[aria-label="Run CLI"]`) — live opencode sessions are driven through it; the `run-cli-terminal` window launches and `write_pty_input` (with trailing `\r`) submits prompts.

## Mission Monitor tool-detail quick path (Spec #2792)

- [ ] S-9 (open for #2792): Select a session with a tool call and open a tool's detail view (from the chat node's or a subagent node's `── TOOLS (N) ──` list) — the panel renders Status / Duration / Input / Output (and, for a failed call, the reason row) without console errors or layout break. `tauri_read_logs(source="console")` clean.

## Mission Monitor ghost-session follow-up quick path (Spec #2795)

- [ ] S-10 (open for #2795): Select a listed session — the canvas renders ≥1 node; NEVER a silent blank canvas and NEVER the #2791 "No graph content for this session" explanatory state.
- [ ] S-11 (open for #2795): Session list — every listed session is a real session (renders ≥1 node once its rows land); no listed session is a ghost. Cross-check `telemetry_spans` at the same instant.
- [ ] S-12 (open for #2795): Live drive — launch a session via Run CLI and confirm it appears in the sidebar and resolves to content; no ghost entry appears at any point; no real session is dropped.

## Mission Monitor realtime-data quick path (Spec #2896)

- [ ] S-13: Open Mission Monitor with stored history — the session list renders persisted sessions immediately; no visible "0 sessions"/blank phase (`tauri_webview_wait_for` on the first session row succeeds before any blank state is observable); screenshot captured.
- [ ] S-14: With no session selected, the session list is live — emit an `agent_session`/`chat` event via `fredo emit` with a unique `e2e-<guid8>` session id; the new session appears in the list without reopening, and no per-session detail is delivered as if selected (REQ-5).
- [ ] S-15: Select a session, switch to a second live session — the first session's activity stops updating and the second's stays live; console clean (`tauri_read_logs(source="console")` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`).
- [ ] S-16: Fully restart the app and reopen Mission Monitor — stored sessions are present on open with no missing/duplicate entries; a previously deleted session stays absent.
