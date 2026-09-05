# Window Manager — Smoke (Spec #2807 — Own window-system kernel)

> Standardized smoke for the window-manager surface. App-boots + core-path sanity, layered on the tests-README boilerplate. Live policy: capture + console-clean at each step.

## Standard boilerplate

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: Window chrome reachable — the desktop work area renders a window manager surface (empty workspace with reachable window frame controls once a window is open), not a broken/blank shell.
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible, and it no longer exposes a window-style variant selector.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2807/e2e/smoke.jpeg")` succeeds.

## Window Manager quick path

- [ ] S-6: Open a feature window from the desktop toolbar — the window opens framed in the Fredo brand chrome (own engine), NOT the third-party chrome; DOM snapshot shows the window surface + header.
- [ ] S-7: The window chrome controls (minimize / maximize / close) are rendered and reachable — clicking close removes the window from the work area and the open-window list (idempotent, no crash). `tauri_read_logs(source="console")` clean.
- [ ] S-8: Re-open the same feature window after closing it — it opens again cleanly (no stale frame, no duplicate, no focus trap); re-open + update twice works end-to-end.
