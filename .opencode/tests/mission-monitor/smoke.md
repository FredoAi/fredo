# mission-monitor - Smoke

Standard smoke checks for the Mission Monitor surface (frontend UI + the OTLP
delivery pipeline it consumes).

- [ ] S-1: App window renders - `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [ ] S-2: No console errors - `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
- [ ] S-3: Mission Monitor reachable - toolbar opens the feature; ReactFlow canvas renders (`.react-flow` present)
- [ ] S-4: OTLP gRPC receiver live - a telemetry-query SELECT over `telemetry_spans` returns rows (receiver + DB up)
- [ ] S-5: Adapter/ECE unit suite passes - `cargo test` on the comm modules exits 0
- [ ] S-6: Frontend builds - `pnpm --filter @fredo/ui build` exits 0
- [ ] S-7: Screenshot captured - `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/smoke.jpeg")` succeeds
