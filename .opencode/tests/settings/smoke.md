# Settings — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the shared Settings
> dialog shell (`ProfileSettingsModal`). Seeded at Issue #2864. Runs on a running Fredo desktop
> app; live policy — screenshot + console-clean at each step.

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: Settings surface reachable — the gear (`[aria-label="Settings"]`) opens the dialog; the sidebar nav (Companion / Appearance / Fredo Setup / Telemetry) renders.
- [ ] S-4: Companion section accessible — Settings → Companion renders the visibility toggle + auto-return input + Teleport tip (or the not-ready wizard); no orphan section.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2864/e2e/smoke.jpeg")` succeeds.
- [ ] S-6: Theme re-tint quick path — switch dark↔light with the dialog open; the chrome + Companion panel re-tint with no stale color; screenshot succeeds; console clean.
