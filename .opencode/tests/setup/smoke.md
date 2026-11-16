# setup — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the Fredo Setup surface.
> Runs on a running Fredo desktop app on `spec/3010`. **Verification policy: live.**

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: Setup surface reachable — on boot NO Setup window auto-opens; the launcher tile `#fredo-launcher-grid [role="button"][aria-label="Fredo Setup"]` exists exactly once, and activating it opens `div[role="group"][aria-label="Fredo Setup"]` rendering `SetupWizard`.
- [ ] S-4: Settings→Fredo Setup reachable — open Settings; the `plugin-setup` nav item (label `Fredo Setup`) renders `<SetupWizard/>`.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3010/e2e/smoke.jpeg")` succeeds.
- [ ] S-6: Live receipt — `telemetry_spans` non-zero with a recent timestamp from the env's `ports.pg` (the live-policy gate; a static-only PASS is a FALSE PASS).
