# Mission Monitor — Smoke Tests

> Standard boilerplate adapted to the feature surface (see `.opencode/tests/README.md`).

- [ ] S-1 App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [ ] S-2 No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
- [ ] S-3 Feature surface reachable — Mission Monitor opens from the toolbar; with no sessions it shows the empty state ("Waiting for agent activity…")
- [ ] S-4 Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible
- [ ] S-5 Token formatting sanity — with any session open, a rendered token count uses grouping separators (no `k`/`M` compact forms)
- [ ] S-6 Detail panel opens — clicking a chat node opens the DetailPanel (right-side overlay); Escape/background-click closes it
- [ ] S-7 Chat title sanity — a chat node's title shows agent + model (e.g. `opencode · deepseek-v4-flash`), never the generic "Chat"
- [ ] S-8 Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/smoke.jpeg")` succeeds

## #2707 quick path

- [x] S-9 Mission Monitor graph renders — with a finished-run session open, `tauri_webview_dom_snapshot(type="structure")` inside the Mission Monitor panel shows chat/session nodes and edges (graph NOT empty, NOT the "Waiting for agent activity…" empty state) **PASS**: Graph shows chat/session nodes and edges. NOT empty state.
- [x] S-10 Static finished run — with the finished-run session open and NO new agent activity, a second snapshot 30s later shows the identical node/edge set (no live-updating behavior introduced by #2707) **PASS**: No new nodes appear after session completes. Graph stays fixed.
