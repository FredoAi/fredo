# workspace-layout — Smoke

Standardized smoke for the workspace-layout surface, layered on the tests-README boilerplate. Live policy: DOM + screenshot + console at each step, plus the `telemetry_spans` reference.

## Standard boilerplate

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: Feature surface reachable — the desktop work area renders; with ≥2 feature windows open, the workspace root `[data-testid="workspace-layout"]` and its panes are present.
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the Settings window with sections visible; Appearance still renders the theming controls.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2980/e2e/smoke.jpeg")` succeeds.

> **Live-policy observation note:** this suite is `live` — each step needs a DOM snapshot + `getBoundingClientRect` read + console read, and the round's Evidence must reference a `telemetry_spans` live query (non-zero count + recent `max(ingested_at)`); a static-only observation is a FALSE PASS.

## Zone quick path

- [ ] S-6: Boot PG-default; open Settings → click `[data-testid="settings-nav-layout"]` → `layout-enabled-toggle` on → `layout-new-button` → `layout-template-columns` (`layout-template-count`=2) → `layout-editor-confirm` → `layout-assign-<id>`.
  - EXPECTED: `layout-settings` renders; the layout is saved (`layout-list-item-<id>`) and assigned ("Active"); `get_setting('Fredo_layout_zones')` shows `enabled:true`, one layout, `activeLayoutId` set.
- [ ] S-7: Hold the activation chord (`layout-chord-select`, default `alt`) and drag a window header (`window-frame-<id>`) over a zone; release over the highlighted zone.
  - EXPECTED: `zone-overlay` appears; the zone under the pointer sets `zone-target-<zoneId>` `data-hovered="true"`; on release the window renders as `workspace-pane-<windowId>` with `data-zone-id` at the zone rect (fraction×workspace, `gap/2` inset, clamped ≥320×200); `zone-announcer` announces the snap; console clean.
- [ ] S-8: Fully restart Fredo.
  - EXPECTED: the zoned window restores into its zone on FIRST paint (`workspace-pane-<windowId>` `data-zone-id`, no manual action) and Mission Monitor still renders live sessions inside its zoned pane (`telemetry_spans` non-zero); `tauri_read_logs` clean.
- [ ] S-9: CI-parity quick gate (F-14-style) — `pnpm --filter @fredo/ui typecheck` exits 0 (fastest signal); the full command set runs as functional F-27.
