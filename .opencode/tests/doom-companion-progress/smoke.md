# doom-companion-progress — Smoke Test Cases (Spec #3031)

> Standardized smoke boilerplate (`.opencode/tests/README.md`) adapted to the Doom Companion
> **progress** surface — the `doom` window + the native in-process engine driven through the
> autoplay path. Runs on the `doom` window and the `start_doom_autoplay` path.
>
> **Verification policy: live** — a running-system feature. Every live-policy AC needs the
> `telemetry_spans` receipt (NON-ZERO count + recent `max(ingested_at)`; app-pool read preferred,
> G-307; managed `psql` DECLARED fallback, G-284). **Doom emits no OTLP span — DISCLOSE.**

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty
  `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/
  `Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: Feature surface reachable — entering Doom Mode (`iddqd` or the companion
  `doom_mode {action:enter}` call) opens the `doom` window and the `doom-root` + `doom-frame-canvas`
  elements render.
- [ ] S-4: Autoplay path is live — `get_doom_status` reports `running: true` / phase `ready`; a
  `start_doom_autoplay` (`commands.rs:558`) run advances so `get_doom_autoplay_status`
  (`commands.rs:707`) reports `steps`/`lastTic` climbing (step-driven, G-316); a `doom_read_state`
  IPC call returns a parseable observation.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80,
  filePath=".opencode/tmp/3031/e2e/smoke.jpeg")` succeeds.

**Feature usage: enter Doom Mode → autoplay.** Enter via the `iddqd` hotkey or the companion
`doom_mode {action:enter}` skill call; start a run with `start_doom_autoplay` and stop it with
`stop_doom_autoplay`; exit by closing the `doom` window (the ONLY exit path, R-3
`doom-native/regression.md`). Never force-maximize a child window.
