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

## Test run (round 1)

- **S-1 PASS** — `dom_snapshot(structure)` returned non-empty `<body>`.
- **S-2 PASS** — console read: no `Error:`/`Uncaught`/`Maximum update depth`; only a `motion() is deprecated` warn.
- **S-3 PARTIAL** — the desktop work area renders (toolbar + theme background), but NO window frame surface ever exists because no window can be opened (S-6 fails). Mark UNVERIFIED for "window frame controls once a window is open."
- **S-4 PASS** — settings dialog opens (gear) with sections (Companion/Appearance/Fredo Setup/Telemetry/Features) and exposes NO window-style variant selector.
- **S-5 PASS** — screenshots saved under `.opencode/tmp/2807/e2e/` (00..05).
- **S-6 FAIL** — clicking the toolbar Mission Monitor / Query Viewer entries opens NO window (0 `.fredo-window__surface`, 0 `.window-container`); toolbar open path routes to `@maomaolabs/core`'s own store (dist `index.es.js:44`), whose window host is unmounted. Root cause: `DesktopToolbar.tsx:2` uses `@maomaolabs/core` `Toolbar`; ST-5 re-pointed `useWindows` only.
- **S-7 UNVERIFIED (blocked by S-6)** — no window chrome controls to reach/close.
- **S-8 UNVERIFIED (blocked by S-6)** — no window to re-open.

## Test run (round 2)

- **S-1 PASS** — `dom_snapshot(structure)` non-empty `<body>`.
- **S-2 PASS** — console read: no `Error:`/`Uncaught`/`Maximum update depth`; only a `motion() is deprecated` warn + a transient React Flow layout warn.
- **S-3 PASS** — desktop work area renders; with a window open the window surface `role="group"` + chrome header + controls are reachable.
- **S-4 PASS** — settings dialog (gear) opens with sections (Companion/Appearance/Fredo Setup/Telemetry/Features); Appearance exposes NO window-style variant selector.
- **S-5 PASS** — screenshots saved under `.opencode/tmp/2807/e2e/` (00..07).
- **S-6 PASS (round-2 fix)** — clicking the toolbar `button[aria-label="Mission Monitor"]` opens the window framed in the Fredo brand chrome (own engine); DOM shows `.fredo-window__surface` + header + controls; screenshot `01-mm-open.png`. The `onClickCapture` wrapper routes the launcher click to the own kernel's `openFeatureWindow`.
- **S-7 PASS** — the window chrome controls (Minimize / Restore / Close) are rendered and reachable; clicking Close removes the window and the open-window list (idempotent, no crash); console clean.
- **S-8 PASS** — re-opening the same feature window after closing opens cleanly (no stale frame, no duplicate, no focus trap); re-open + update twice works end-to-end (session list grew 1→2→3 with identical surface class = no remount).
