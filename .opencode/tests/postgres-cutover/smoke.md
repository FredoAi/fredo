# postgres-cutover — Smoke

Feature: default embedded-PostgreSQL cutover + SQLite-path removal (issue #2979, slice 6 of 6).
Quick app-boot + core-path sanity plus the default-cutover / backout quick paths. Full detail lives
in `functional.md`.

> **Verification policy: LIVE** — a live receipt (PG store read via managed `psql`, or a
> `telemetry_spans` read) is required for a live verdict; a static-only PASS is a FALSE PASS.
>
> **G-263 SAFETY:** the dev instance is started and stopped ONLY through
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2979` / `-Action Down`.
> Time-bound every leg; the named failure mode is the #2948 ~11 h `pg.stop()` hang.

## Standard boilerplate

- [ ] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:` / `Uncaught` / `Maximum update depth exceeded`.
- [ ] **S-3:** Feature surface reachable — Mission Monitor's entry point renders its expected elements (session list + graph canvas).
- [ ] **S-4:** Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible.
- [ ] **S-5:** Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2979/e2e/smoke.jpeg")` succeeds.

## Cutover quick paths

- [ ] **S-6:** Fresh install (no `fredo.db`, fresh PG data dir) boots on PostgreSQL with no migration
  leg; `storage_engine_status.engine == "postgres"` (F-1/F-4).
- [ ] **S-7:** Upgraded install (fixture `fredo.db`) cuts over once; marker set; second startup skips
  (F-2).
- [ ] **S-8:** A forced parity mismatch (`FREDO_MIGRATION_FORCE_MISMATCH`) fails closed: no marker,
  engine stays SQLite, `fredo.db` byte-unchanged (F-3).
- [ ] **S-9:** `rollback.verified` reads true after an executed backout; the restored checksums match
  (F-5).
- [ ] **S-10:** `cargo tree -i rusqlite` is empty for the app crate (or every remaining site is
  named) (F-7).
- [ ] **S-11:** Mission Monitor renders a live session's chat / tools / tokens / graph from the
  migrated store on the PostgreSQL-default path — cross-check the PG store at the same instant (F-12).
- [ ] **S-12:** Backout smoke — restore the pre-cutover snapshot over `fredo.db`, start the SQLite
  build, and confirm the restored counts/checksums match (F-5/F-12).
- [ ] **S-13:** Screenshot capture — `tauri_webview_screenshot(format="jpeg", quality=80,
  filePath=".opencode/tmp/2979/e2e/smoke.jpeg")` succeeds.

## Smoke-level pass/fail

PASS = S-1..S-3, S-6..S-13 green; S-4/S-5 green or a named blocker. Any count/checksum mismatch, a
marker set on a mismatch, an engine flip despite a parity failure, a mutated `fredo.db` on the
migration leg, a blank Mission Monitor while migrated rows exist, a write reaching `telemetry_spans`,
a residual SQLite-only construct in a migrated path, or an unbounded wait = **FAIL**.
