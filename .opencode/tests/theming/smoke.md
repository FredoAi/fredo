# Theming — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the theming surface.
> These confirm the app still boots and the theming path is reachable.

- [ ] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] **S-3:** Theming surface reachable — Settings → Appearance → Theming renders the expected sections (Theme Presets, Base Theme, Accent Colors, Backgrounds, Text, Status, Fonts, Animation Style).
- [ ] **S-4:** Preset selector present — the preset radio grid / selector exposes the 18 named presets.
- [ ] **S-5:** Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2811/e2e/smoke.jpeg")` succeeds.
