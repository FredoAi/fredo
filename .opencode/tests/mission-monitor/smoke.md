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
