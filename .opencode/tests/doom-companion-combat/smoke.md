# doom-companion-combat — Smoke Test Cases (Spec #3053)

> Standardized smoke boilerplate (`.opencode/tests/README.md`) adapted to the Doom Companion
> **combat** surface — the `doom` window + the native in-process engine driven through the
> autoplay path, now with an engagement/aim/fire policy layered on the retained reflex chain.
>
> **Verification policy: live** — a running-system feature. The tester's `## Tests Runs` comment
> MUST carry a LIVE webview receipt — an `upload-evidence` screenshot of the LIVE `doom` window's
> status area (`https://github.com/user-attachments/...` URL) — OR a genuine `telemetry_spans`
> query result (NON-ZERO count + recent `max(ingested_at)`; app-pool read preferred, G-307;
> managed `psql` DECLARED fallback, G-284). **The Doom native loop emits no OTLP span — DISCLOSE.**

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty
  `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/
  `Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: Feature surface reachable — entering Doom Mode (`iddqd` or the companion
  `doom_mode {action:enter}` call) opens the `doom` window and the `doom-root` +
  `doom-frame-canvas` elements render.
- [ ] S-4: Combat path is live — `get_doom_status` reports the engine ready; a
  `start_doom_autoplay` run advances (`get_doom_autoplay_status.steps`/`lastTic` climbing,
  step-driven G-316); the `doom-combat-kills` HUD renders `Kills: {n}` (visible once `phase !==
  'idle'`); with a front enemy injected (`FREDO_DOOM_INJECT_OBSERVATION`) a `shoot` is issued each
  tick and `engagements` climbs; a `doom_read_state` IPC call returns a parseable observation.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80,
  filePath=".opencode/tmp/3053/e2e/smoke.jpeg")` succeeds and shows the `doom-combat-kills` readout;
  upload the status-area frame via `upload-evidence`.

**Feature usage: enter Doom Mode → autoplay → engage.** Enter via the `iddqd` hotkey or the
companion `doom_mode {action:enter}` skill call; start a run with `start_doom_autoplay` and stop it
with `stop_doom_autoplay`; exit by closing the `doom` window (the ONLY exit path). Never
force-maximize a child window.
