# doom-companion-dataset — Smoke Test Cases (Spec #3032)

> Standardized smoke boilerplate (`.opencode/tests/README.md`) adapted to the Doom Companion
> **dataset-export** surface — the `doom` window + the native in-process engine driven through
> the autoplay path, now writing a per-decision JSONL dataset and exporting it locally. Runs on
> the `doom` window, the `start_doom_autoplay` path, and the `fredo` export path.
>
> **Verification policy: live** — a running-system feature. Every live-policy AC needs the
> `telemetry_spans` receipt (NON-ZERO count + recent `max(ingested_at)`; app-pool read preferred,
> G-307; managed `psql` DECLARED fallback, G-284). **The Doom loop emits no OTLP span — DISCLOSE.**

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a
  non-empty `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/
  `Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: Feature surface reachable — entering Doom Mode (`iddqd` or the companion
  `doom_mode {action:enter}` call) opens the `doom` window and the `doom-root` +
  `doom-frame-canvas` elements render.
- [ ] S-4: Autoplay path is live — `start_doom_autoplay` advances so `get_doom_autoplay_status`
  (`commands.rs:717`) reports `steps`/`decisions`/`lastTic` climbing (step-driven, G-316); a
  `doom_read_state` IPC call returns a parseable observation carrying the additive `forward`
  sensor.
- [ ] S-5: Dataset surface reachable — with `FREDO_DOOM_DATASET_ENABLED=1` and
  `FREDO_DOOM_DATASET_DIR` at scratch, a short run creates `doom-dataset.jsonl`; the
  `fredo doom export-dataset --out …` path writes a file under `<dir>/exports/`.
- [ ] S-6: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80,
  filePath=".opencode/tmp/3032/e2e/smoke.jpeg")` succeeds.

**Feature usage: enter Doom Mode → autoplay (dataset capture) → export.** Enter via the `iddqd`
hotkey or the companion `doom_mode {action:enter}` skill call; start a run with
`start_doom_autoplay` and stop it with `stop_doom_autoplay`; export with the `fredo` CLI; exit by
closing the `doom` window (the ONLY exit path, R-3 `doom-native/regression.md`). Never
force-maximize a child window.
