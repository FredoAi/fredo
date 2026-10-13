# postgres-naming — Smoke

Feature: embedded-PostgreSQL cluster identity (application database `fredo`, bootstrap role
`postgres` UNCHANGED, one-time catalog-only no-data-loss migration) at issue **#3036**. Quick
app-boot + core-path sanity plus the identity quick paths. Full detail lives in `functional.md`.

> **Verification policy: LIVE** — a live `telemetry_spans` receipt (functional F-LIVE) is required
> for a live verdict; a static-only PASS is a FALSE PASS.
>
> **G-263 SAFETY:** the dev instance is started/stopped ONLY through
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up|Down -Spec 3036`. Time-bound every
> leg; the named failure mode is the #2948 ~11 h `pg.stop()` hang.

## Standard boilerplate

- [ ] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:` / `Uncaught` / `Maximum update depth exceeded`.
- [ ] **S-3:** Feature surface reachable — the PostgreSQL Settings pane / Mission Monitor entry point renders its expected elements.
- [ ] **S-4:** Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible.
- [ ] **S-5:** Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3036/e2e/smoke.jpeg")` succeeds.

## Identity quick paths

- [ ] **S-6:** On a fresh boot, the live identity is `postgres`/`fredo` — managed-`psql`
  `SELECT current_user, current_database()` ⇒ `postgres`,`fredo` (functional F-1).
- [ ] **S-7:** A second client (managed `psql` and/or the built-in PG app) connects while the app
  runs — no `too many clients`; `SHOW max_connections` == 12 (functional N-5).
- [ ] **S-8:** After booting an upgraded (legacy-seeded) dir, the app is `ready` and Mission
  Monitor renders a live session from the migrated store (functional F-3/F-12, F-LIVE).

## Smoke-level pass/fail

PASS = S-1..S-3 and S-6..S-8 green; S-4/S-5 green or a named blocker. Any connection failure, a
lost `telemetry_spans` row, a `max_connections` regression, a role rename, or a static-only
receipt = **FAIL**.
