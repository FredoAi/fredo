# Smoke — app-window-presentation

> Feature #2955. Short standardized checks (adapted from `.opencode/tests/README.md` boilerplate)
> + feature-specific quick paths. Run on this feature's testing phase and on any regression-smoke
> for zero-observable-AC specs touching the app-window surface.

## Standard

- [ ] **S-1: App window renders** — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] **S-2: No console errors** — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded` (before AND after interactions).
- [ ] **S-3: Feature surface reachable** — Settings opens and the `settings-nav-apps` nav item renders the `app-presentation-settings` section.
- [ ] **S-4: Telemetry Settings accessible** — the Settings window opens with its sections visible.
- [ ] **S-5: Screenshot captured** — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2955/e2e/smoke.jpeg")` succeeds.

## Feature-specific quick paths

- [ ] **S-6: Per-app rows present** — each eligible app renders a `app-presentation-row-<appId>` with exactly one of `app-presentation-mode-<appId>-same-window` / `-new-window` selected; the factory app's `-new-window` is disabled with `app-presentation-multi-window-note-<appId>`.
- [ ] **S-7: Default resolves in-window** — with no stored map, opening an app leaves `tauri_manage_window(action="list")` without a native window for it (opens in the main window).
- [ ] **S-8: Own-window resolves to one native window** — set an app to `new-window`, open it → exactly one native window (`terminal`/`doom`/`app-<id>`) with `app-window-root`; re-open focuses the same one.
- [ ] **S-9: Legacy fallback read** — seed `terminal_presentation_mode`=`"new-window"` with the map absent; open Terminal → native `terminal` window (legacy fallback), no crash.
- [ ] **S-10: No orphans after open/close** — open an app in its own window, close it, `process-hygiene.ps1 -List` shows no surviving session process tree.
- [ ] **S-11: Live receipt** — `telemetry_spans` non-zero with a recent `max(ingested_at)` via the managed `psql` lever (or the `telemetry_get_stats` fallback, disclosed).
