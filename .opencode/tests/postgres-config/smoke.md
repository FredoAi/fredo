# postgres-config — Smoke

Feature: embedded-PostgreSQL configuration editing from Settings (issue #3022). Quick app-boot +
core-path sanity plus the config-apply quick paths. Full detail lives in `functional.md`.

> **Verification policy: LIVE** — a live `telemetry_spans` receipt (functional F-12) is required for
> a live verdict; a static-only PASS is a FALSE PASS.
>
> **G-263 SAFETY:** the dev instance is started and stopped ONLY through
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up` / `-Action Down`. Time-bound every leg.

## Standard boilerplate

- [ ] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:` / `Uncaught` / `Maximum update depth exceeded`.
- [ ] **S-3:** Feature surface reachable — Settings opens and the **PostgreSQL** nav item renders its pane (password field + port + verbosity + Apply + Reset).
- [ ] **S-4:** Telemetry Settings accessible — the Telemetry nav item opens with sections visible.
- [ ] **S-5:** Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3022/e2e/smoke.jpeg")` succeeds.

## Config quick paths

- [ ] **S-6:** Cluster cold-start reaches `ready` (bounded) with the state-dir seams set; `pg_supervisor_status` returns a bound ephemeral `127.0.0.1` port ≠ 4317/4318/9223.
- [ ] **S-7:** Apply a password change on a healthy cluster — inline success, `ready`, and a fresh connection with the new password authenticates.
- [ ] **S-8:** After the apply, a live session's rows reach the store — Mission Monitor renders the session and `telemetry_spans` returns a non-zero result (functional F-12).

## Smoke-level pass/fail

PASS = S-1..S-3 and S-6..S-8 green; S-4/S-5 green or a named blocker. Any secret in a log/file, any
unbounded wait, any data loss on a password change, or a static-only receipt = **FAIL**.
