# doom-loot — Smoke Test Cases (Spec #3054)

> Standardized smoke boilerplate (`.opencode/tests/README.md`) adapted to the Doom Companion
> **looting** surface — the `doom` window + the native in-process engine driven through the autoplay
> path, now with an opportunistic loot policy layered on the retained reflex/combat/plan chains.
>
> **Verification policy: live** — a running-system feature. The tester's `## Tests Runs` comment
> MUST carry a LIVE receipt: a `telemetry_spans` query result (NON-ZERO count + recent
> `max(ingested_at)`; app-pool read preferred, G-307; managed `psql` DECLARED fallback, G-284)
> and/or an `upload-evidence` screenshot of the LIVE `doom` window status area
> (`https://github.com/user-attachments/...` URL). **The Doom native loop emits no OTLP span —
> DISCLOSE.**

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty
  `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/
  `Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: Feature surface reachable — entering Doom Mode (`iddqd` or the companion
  `doom_mode {action:enter}` call) opens the `doom` window and the `doom-root` +
  `doom-frame-canvas` elements render.
- [ ] S-4: Loot path is live — `get_doom_status` reports the engine ready; a `start_doom_autoplay`
  run advances (`get_doom_autoplay_status.steps`/`lastTic` climbing, step-driven G-316); a
  `doom_read_state` IPC call returns a parseable observation carrying additive `level.itemsCollected`
  (integer) and `player.weapons` (array, baseline `["fist","pistol"]`); `get_doom_autoplay_status`
  carries `itemsCollected` (camelCase); with an in-range `items[]` injected
  (`FREDO_DOOM_INJECT_OBSERVATION`) the run issues the loot `turn-to`+`forward`.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80,
  filePath=".opencode/tmp/3054/e2e/smoke.jpeg")` succeeds and shows the `doom` window status area;
  upload the status-area frame via `upload-evidence`.

**Feature usage: enter Doom Mode → autoplay → loot.** Enter via the `iddqd` hotkey or the companion
`doom_mode {action:enter}` skill call; start a run with `start_doom_autoplay` and stop it with
`stop_doom_autoplay`; exit by closing the `doom` window (the ONLY exit path). Never force-maximize a
child window.
