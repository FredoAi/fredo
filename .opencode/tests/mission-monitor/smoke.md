# Mission Monitor — Smoke Tests

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
- [ ] S-3: Feature surface reachable — Mission Monitor panel opens and renders its expected elements (graph canvas, session list/empty state)
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/smoke.jpeg")` succeeds
- [ ] S-6: Feature-specific quick path — with a completed flat run loaded, the root chat node and its tool nodes render within seconds of opening the panel

### Round 1 rerun note (2026-08-27)

App boot, Mission Monitor reachability, Run CLI launch, and clean console checks were observed. The feature-specific completed-flat quick path was not marked passed because the live fixture attempt did not produce a clean FIX-FLAT session with a `telemetry_spans` receipt.
