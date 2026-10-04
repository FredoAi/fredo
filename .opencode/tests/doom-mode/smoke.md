# doom-mode — Smoke Test Cases (Spec #2968)

> Standardized app-boots + core-path sanity boilerplate (adapted to the Doom surface). Runs on this feature's testing phase.
>
> **Verification policy: live** — the smoke receipt includes the `telemetry_spans` live-pipeline reference (non-zero count + recent `max(ingested_at)`; managed `psql` on the PG default, G-284, or a disclosed `telemetry_get_stats` substitution). A static-only smoke cannot pass. Doom emits NO OTLP spans — the check proves the pipeline, not the feature.
>
> **Real-engine scope:** the runtime core-path smoke (S-6) uses the REAL `restful-doom.exe` built by `scripts/doom/build-restful-doom.ps1` (ST-2); the stub is not a valid smoke engine.

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3 (SUPERSEDED by #2970 — `doom-entry-button` is removed for secrecy; see S-12): Doom surface reachable via the secret typed trigger `iddqd`; the `doom` window opens (`doom-root` + `doom-window-title`="Doom" present).
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2968/e2e/smoke.jpeg")` succeeds.
- [ ] S-6: **Doom runtime core path (REAL engine)** — build + stage `restful-doom.exe` (ST-2); the window reaches `doom-status` `ready`; `doom-frame-canvas` renders real game pixels; `DoomStatus.enginePath` basename == `restful-doom.exe`; closing the window leaves zero `restful-doom.exe`.
- [ ] S-7: Live-pipeline receipt — `telemetry_spans` returns a NON-ZERO count with a recent `max(ingested_at)` (PG via the managed `psql`, or a disclosed `telemetry_get_stats` substitution).
- [ ] S-8: **PG-default boot** — `storage_engine_status` = PostgreSQL / PG supervisor ready (not SQLite).
- [ ] S-9: Mission Monitor still renders live sessions with the Doom feature present (the F-MM smoke row).
- [x] S-10 (PASS 2026-10-04 #2969 r1 — `doom-autoplay-toggle` + `doom-autoplay-status` render in the doom window): **Doom autoplay surface reachable** — with the `doom` window open, `doom-autoplay-toggle` and `doom-autoplay-status` render (ST-7 hooks). (Autoplay slice #2969.)
- [x] S-11 (PASS 2026-10-04 #2969 r1 — toggle click → status "Autoplay · step 28 · tic 1164 · alive" → … → "Autoplay complete · 600 steps · alive"; Stop button mounted while running; stop → idle; no console errors; no orphan): **Autoplay start/stop quick path** — with the stub engine + scripted lever, click `doom-autoplay-toggle`: `doom-autoplay-status` shows `Running`; click `doom-autoplay-stop`: phase returns to `Idle`. No console `Error:`/`Uncaught`/`Maximum update depth exceeded`; a bounded run leaves no orphan process.

---

## Secret-activation slice (Spec #2970) — smoke additions

> **Verification policy: live** — the live-pipeline `telemetry_spans` reference (non-zero
> count + recent `max(ingested_at)`; managed `psql` at the manifest `ports.pg`, G-284, or a
> disclosed substitution). Doom Mode emits no span. A static-only smoke cannot pass.

- [ ] S-12: **Secret activation quick path (REAL engine)** — from a fresh pre-feature state (no Doom tile/window), type `iddqd` in the main window: `doom-mode-changed {phase:"active",active:true,origin:"code"}`; the `doom` window opens (`doom-root` + `doom-window-title`="Doom"); `doom-frame-canvas` renders real pixels; `DoomStatus.enginePath` basename == `restful-doom.exe`. (Requires F-49 staging; a stub-only receipt is a FALSE PASS.)
- [ ] S-13: **Secret exit quick path** — with the mode active, click `doom-exit-button`: `doom-mode-changed {active:false}`; `get_doom_mode_status.voiceSuppressed === false`; the `doom` window closes; zero `restful-doom.exe` within `DOOM_STOP_TIMEOUT_S`.
- [ ] S-14: **Suppression observable** — while active, `stt_start` returns `{started:false, code:"disabled"}` and `get_doom_mode_status.voiceSuppressed === true`; after the S-13 exit, `stt_start` proceeds (voice otherwise enabled).
- [ ] S-15: **Secrecy** — before activation, no "Doom"/"iddqd" text is rendered on the launcher grid, Settings→Apps list, Settings sidebar, or help/hotkey surfaces; `doom-entry-button` is absent. (Scope: rendered surfaces only, not source/test files.)
- [ ] S-16: **PG-default boot + Mission Monitor (F-50 gate)** — `storage_engine_status` = PostgreSQL / PG supervisor ready; Mission Monitor renders ≥1 live session with the secret-activation slice present; the live-pipeline receipt is non-zero with a recent `max(ingested_at)`.
