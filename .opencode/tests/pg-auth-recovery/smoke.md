# pg-auth-recovery — Smoke

Feature: embedded-PostgreSQL `AuthMismatch` recovery banner + `WHILE Failed` log-flood back-off
(issue #3067). Quick app-boot + core-path sanity plus the banner/back-off quick paths. Full detail
lives in `functional.md`.

> **Verification policy: LIVE** — a live receipt (`tauri_webview_*` DOM/screenshot or
> `telemetry_spans`) is required for a live verdict; a static-only PASS is a FALSE PASS.
>
> **G-263 SAFETY:** the dev instance is started and stopped ONLY through
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up|Down -Spec 3067 -EnvId spec3067 -EnvSlot 1 -RequireIsolation`.
> Time-bound every leg; the named failure mode is the #2948 ~11 h `pg.stop()` hang. The shared
> `%APPDATA%\com.fredo.app` path is FORBIDDEN (fails closed); `Restart` is forbidden for isolated envs.

## Standard boilerplate

- [ ] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:` / `Uncaught` / `Maximum update depth exceeded`.
- [ ] **S-3:** Feature surface reachable — with a `ready` cluster the app-shell `Home` renders (banner absent).
- [ ] **S-4:** Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible.
- [ ] **S-5:** Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3067/e2e/smoke.jpeg")` succeeds.

## Feature quick paths

- [ ] **S-6 (banner):** boot LEVER-A (`FREDO_PG_FORCE_AUTH_MISMATCH=1`) — `pg-recovery-banner` renders in
  the shell with `pg-recovery-banner-reset` present, without opening Settings (functional F-1).
- [ ] **S-7 (negative):** boot LEVER-D (`FREDO_PG_FORCE_START_FAIL=1`) — `pg-recovery-banner` is ABSENT
  (functional F-4).
- [ ] **S-8 (back-off quick look):** while LEVER-A holds `Failed`, the app log shows the
  `engine not ready … (fail-closed, R-3.2)` error family appearing with GROWING gaps (not a fixed 1 s
  cadence) — functional F-5.

## Smoke-level pass/fail

PASS = S-1..S-3 and S-6..S-8 green; S-4/S-5 green or a named blocker. Any banner for a non-`authMismatch`
kind, an unbounded wait, or a leaked poll interval = **FAIL**.
