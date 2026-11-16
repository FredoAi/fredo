# Smoke — terminal-presentation-mode

> Feature #2947. Short standardized checks (adapted from `.opencode/tests/README.md`
> boilerplate) + feature-specific quick paths. Run on this feature's testing phase
> and on any regression-smoke for zero-observable-AC specs touching Terminal.

## Standard

- [ ] **S-1: App window renders** — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] **S-2: No console errors** — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded` (check before AND after interactions).
- [ ] **S-3: Feature surface reachable** — the Terminal entry point (toolbar desktop item + app directory) renders/opens its expected surface in the selected mode.
- [ ] **S-4: Terminal settings tab accessible** — Settings opens and the auto-discovered Terminal section (with the "Presentation" control) renders.
- [ ] **S-5: Screenshot captured** — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/smoke.jpeg")` succeeds.

## Feature-specific quick paths

- [ ] **S-6: Mode control present** — the "Presentation" radio card group renders both options (`terminal-presentation-mode-same-window` = "Same window", `terminal-presentation-mode-new-window` = "Separate window") with exactly one selected.
- [ ] **S-7: Default mode** — with no stored value, `get_setting{key:"terminal_presentation_mode"}` is absent and Terminal opens in a native `terminal` window (default `new-window`).
- [ ] **S-8: Window count honours mode** — `tauri_manage_window(action="list")`: `same-window` → no `terminal` window; `new-window` → exactly one.
- [ ] **S-9: CLI smoke** — `fredo open-terminal` with no flags exits 0 with outcome `opened`; app-not-running exits 2.
- [ ] **S-10: No orphans after open/close** — open a Terminal session, close the window, `process-hygiene.ps1 -List` shows no surviving session process tree.
