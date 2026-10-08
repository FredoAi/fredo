# postgres-only-persistence — Smoke

Feature: PostgreSQL as the ONLY database (spec #3005). Quick app-boot + core-path sanity plus the
store / settings / boot-file quick paths. Full detail lives in `functional.md`.

> **Verification policy: LIVE** — a live `telemetry_spans` receipt (functional F-6) is required for a
> live verdict; a static-only PASS is a FALSE PASS.
>
> **G-263 SAFETY:** start/stop ONLY via
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3005` / `-Action Down`; time-bound
> every leg. Never a bare `postgres`/`pg_ctl`.
>
> **PG read lever (G-284/G-307):** managed `psql` at the `pg_supervisor_status` port, or the named
> app-pool fallback (`telemetry_get_stats`/`feature_data_read`) with the substitution disclosed.

## Standard boilerplate

- [ ] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:` / `Uncaught` / `Maximum update depth exceeded`.
- [ ] **S-3:** Feature surface reachable — Mission Monitor's entry point renders its expected elements (session list + graph canvas).
- [ ] **S-4:** Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible.
- [ ] **S-5:** Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3005/e2e/smoke.jpeg")` succeeds.

## PostgreSQL-only quick paths

- [ ] **S-6:** Fresh cold boot (`FREDO_DATA_DIR=.opencode/tmp/3005/appdata-fresh`) →
  `storage_engine_status` `{ engine:"postgres", ready:true }` and zero `.db` files under app-data (F-1).
- [ ] **S-7:** Write one setting via `save_control_setting`, restart, read it back — same value (F-2).
- [ ] **S-8:** OTLP seed (`inject-otlp-fixture.ts --copilot`) → HTTP 200 → Mission Monitor renders ≥1
  `.mm-session-row`; cross-check `telemetry_spans` at the same instant (F-6).
- [ ] **S-9:** `boot-config.json` under the app-data dir carries only `postgres_pid`; no other pre-PG
  key exists there.
- [ ] **S-10:** Screenshot capture — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3005/e2e/smoke-postgres.jpeg")` succeeds.

## Smoke-level pass/fail

PASS = S-1..S-3, S-6..S-10 green; S-4/S-5 green or a named blocker. Any `.db` file under app-data, a
blank Mission Monitor while a qualifying declared row exists, or an unbounded wait = **FAIL**.
