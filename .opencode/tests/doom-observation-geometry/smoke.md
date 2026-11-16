# doom-observation-geometry — Smoke Test Cases (Spec #3030)

> Standardized smoke boilerplate (`.opencode/tests/README.md`) adapted to the Doom
> observation-geometry surface. Runs on the `doom` window + the native engine.
>
> **Verification policy: live** — a running-system feature. Every live-policy AC needs the
> `telemetry_spans` receipt (NON-ZERO count + recent `max(ingested_at)`; app-pool read preferred,
> G-307; managed `psql` DECLARED fallback, G-284). **Doom emits no OTLP span — DISCLOSE.**

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty
  `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/
  `Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: Feature surface reachable — entering Doom Mode (`iddqd` or the companion
  `doom_mode {action:enter}`) opens the `doom` window and the `doom-root` + `doom-frame-canvas`
  elements render.
- [ ] S-4: Native engine is live — `get_doom_status` reports `running: true` / phase `ready`; a
  `doom_read_state` IPC call returns a parseable observation.
- [ ] S-5: `doom_step` advances — `doom_step({tics:1, actions:[]})` returns a `state` whose `tic`
  equals the pre-step `tic` + 1 (step-driven, G-316).
- [ ] S-6: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible.
- [ ] S-7: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80,
  filePath=".opencode/tmp/3030/e2e/smoke.jpeg")` succeeds.

**Feature usage: enter/exit Doom Mode.** Enter via the `iddqd` hotkey or the companion
`doom_mode {action:enter}` skill call; exit by closing the `doom` window (the ONLY exit path,
R-3 `doom-native/regression.md`). Never force-maximize a child window.
