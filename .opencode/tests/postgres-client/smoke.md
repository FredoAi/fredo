# postgres-client — Smoke

Feature: built-in PostgreSQL client (issue #2950). Quick app-boot + core-path sanity plus the
client quick paths. Full detail lives in `functional.md`.

> **Verification policy: LIVE** — a live `telemetry_spans` receipt (functional F-11) is
> required for a live verdict; a static-only PASS is a FALSE PASS.
>
> **G-263 SAFETY:** the dev instance is started and stopped ONLY through
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2950` / `-Action Down`.
> Time-bound every leg; managed psql only via `run-exitcode.ps1 -Command` (≤60 s).

## Standard boilerplate

- [ ] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:` / `Uncaught` / `Maximum update depth exceeded`.
- [ ] **S-3:** Feature surface reachable — the Postgres client entry point renders its expected elements (connection list / editor / schema tree).
- [ ] **S-4:** Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible.
- [ ] **S-5:** Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2950/e2e/smoke.jpeg")` succeeds.

## Client quick paths

- [ ] **S-6:** Boot on the PG-default path — the shell renders, the embedded postmaster
  becomes ready, and Mission Monitor renders a live session / tools / tokens from the store
  (functional F-11); cross-check `telemetry_spans` at the same instant.
- [ ] **S-7:** Connect + browse + query — add/select a connection to the embedded PG, expand
  the schema tree, run `SELECT 1`, and see a result grid.
- [ ] **S-8:** Destructive guard present — submitting a `DROP` in write mode shows a
  warning/confirmation before execution.

## Smoke-level pass/fail

PASS = S-1..S-3 and S-6..S-8 green; S-4/S-5 green or a named blocker. Any unbounded run, a
destructive statement executed without confirmation, or a blank Mission Monitor while live
rows exist = **FAIL**.
