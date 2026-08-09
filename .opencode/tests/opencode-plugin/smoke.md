# opencode-plugin - Smoke

Standard smoke checks adapted for a non-UI feature. This feature has NO UI surface (the plugin is a backend emitter) - the smoke set below checks the host app boots, the plugin builds, and the OTLP pipeline is reachable so functional cases can run.

## Host boot + pipeline sanity

- [ ] S-1: App window renders - `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [ ] S-2: No console errors - `tauri_read_logs(source="console", lines=50)` shows no "Error:"/"Uncaught"/"Maximum update depth exceeded"
- [ ] S-3: OTLP gRPC receiver reachable - a telemetry-query SELECT over `telemetry_spans` returns rows (proves the receiver and DB are live before functional cases run)
- [ ] S-4: Plugin build passes - `bun build` in `apps/opencode-plugin` exits 0
- [ ] S-5: Plugin typecheck passes - `tsc --noEmit` in `apps/opencode-plugin` exits 0
- [ ] S-6: Screenshot captured - `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/smoke.jpeg")` succeeds