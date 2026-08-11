# Mission Monitor — Smoke Suite (Spec #2700)

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a
      non-empty `<body>`
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no
      `Error:`/`Uncaught`/`Maximum update depth exceeded`
- [ ] S-3: Mission Monitor surface reachable — the Mission Monitor feature entry renders the
      panel header ("Mission Monitor"), the session sidebar drawer, and the ReactFlow canvas
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections
      visible
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80,
      filePath=".opencode/tmp/2700/e2e/smoke.jpeg")` succeeds
- [ ] S-6: Live run produces a chat chain — starting one agent run yields ≥1 `agent-*` node
      and ≥1 `e-chat-*` edge in the canvas; `telemetry_spans` contains the run's
      `fredo.llm` rows
