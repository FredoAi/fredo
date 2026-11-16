# Wireframe Contrast — Smoke

> Short standardized checks that the app still boots and the feature's core path works. Adapted
> from the tests README boilerplate to the Wireframe-contrast surface.

- [ ] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a
      non-empty `<body>`.
- [ ] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no
      `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] **S-3:** Feature surface reachable — open Wireframe, select nothing; the page-settings
      panel renders `wireframe-page-controls` with `wireframe-page-presets`,
      `wireframe-page-preset-{desktop|tablet|phone}`, `wireframe-page-width-number` and
      `wireframe-page-height-number`.
- [ ] **S-4:** Anchors present — `find_element` confirms the `data-contrast-*` anchors exist on
      the page-settings controls (and the toolbar/status bar/dialog/banner anchors after their
      surfaces render).
- [ ] **S-5:** Theme switch works — Settings → Appearance (`select[aria-label="Theme presets"]`)
      switches a light preset ↔ a dark preset and the canvas repaints.
- [ ] **S-6:** Gate green — `pnpm --filter @fredo/ui contrast:gate` exits 0; `pnpm --filter
      @fredo/ui build` exits 0.
- [ ] **S-7:** Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80,
      filePath=".opencode/tmp/3086/e2e/smoke.jpeg")` succeeds (supplementary evidence only —
      never the contrast oracle).

Full DOM + visual execution methodology lives in the `dev-environment` skill.
