# doom-mode — Smoke Test Cases (Spec #2968)

> Standardized app-boots + core-path sanity boilerplate (adapted to the Doom surface). Runs on this feature's testing phase.
>
> **Verification policy: live** — the smoke receipt includes the `telemetry_spans` live-pipeline reference (non-zero count + recent `max(ingested_at)`; managed `psql` on the PG default, G-284). A static-only smoke cannot pass.

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: Doom feature surface reachable — `doom-entry-button` renders in the main window; clicking it opens the `doom` window (`doom-root` + `doom-window-title`="Doom" present).
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2968/e2e/smoke.jpeg")` succeeds.
- [ ] S-6: Doom runtime core path — with the STUB engine, the window reaches `doom-status` `ready` and `doom-frame-canvas` renders; closing the window leaves no engine process.
- [ ] S-7: Live-pipeline receipt — `telemetry_spans` returns a NON-ZERO count with a recent `max(ingested_at)` (PG via the managed `psql`, or SQLite with a disclosed substitution).
- [ ] S-8: Mission Monitor still renders live sessions with the Doom feature present (the F-MM smoke row).
