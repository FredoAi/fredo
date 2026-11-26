# App Intelligibility — Smoke

> App-boots + core-path sanity for the app-intelligibility feature (#3244). Standardized boilerplate
> plus the feature's quick paths.

- [ ] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty
      `<body>`.
- [ ] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no
      `Error:` / `Uncaught` / `Maximum update depth exceeded`.
- [ ] **S-3:** The companion surface is reachable (composer / companion entity renders its expected
      elements) and a plain query turn settles.
- [ ] **S-4:** Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible.
- [ ] **S-5:** Screenshot captured —
      `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3244/e2e/smoke.jpeg")`
      succeeds.
- [ ] **S-6 (feature-specific):** The per-turn **injection span** is emitted on a companion turn — a
      `telemetry_spans` query returns at least one record for the injection event on the tested head
      SHA.
