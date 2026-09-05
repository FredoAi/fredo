# desktop-shell — Smoke Tests

> Standardized app-boots + core-path sanity for the clean desktop shell.

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
- [ ] S-3: Shell surface reachable — the launch surface renders the FREDO notch, pixel-butler avatar, `>` search-or-command bar, side ticks, and online clock (no full-screen animation, no centered "Fredo" title card)
- [ ] S-4: Settings accessible — gear/nav opens the settings dialog with the theming appearance sections visible (no "Animation Style" or "Base Theme" control)
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2817/e2e/smoke.jpeg")` succeeds
