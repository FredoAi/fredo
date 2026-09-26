# workspace-layout — Smoke

Standardized smoke for the workspace-layout surface, layered on the tests-README boilerplate. Live policy: DOM + screenshot + console at each step, plus the `telemetry_spans` reference.

## Standard boilerplate

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: Feature surface reachable — the desktop work area renders; with ≥2 feature windows open, the workspace root `[data-testid="workspace-layout"]` and its panes are present.
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the Settings window with sections visible; Appearance still renders the dock-position + theming controls.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2949/e2e/smoke.jpeg")` succeeds.

## Workspace quick path

- [ ] S-6: Open Terminal + Mission Monitor and activate the tiled workspace — both panes render simultaneously (`workspace-pane-terminal` + `workspace-pane-mission-monitor`) with non-zero rects and their content; not one-at-a-time full-bleed.
- [ ] S-7: Drag the shared divider once and move one pane to another region — the rendered pane rects reflect both changes; console clean.
- [ ] S-8: Save a layout named `twopane`, fully restart Fredo — the two panes re-render on first paint at the saved regions/rects with no manual action; `tauri_read_logs` clean.
- [ ] S-9: CI-parity quick gate (F-14-style) — `pnpm --filter @fredo/ui typecheck` exits 0 (fastest signal); the full command set runs as functional F-20.
