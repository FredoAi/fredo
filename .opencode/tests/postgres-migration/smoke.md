# postgres-migration — Smoke

Feature: one-shot `fredo.db` → PostgreSQL data migration with a per-table parity gate + executable
SQLite rollback (issue #2977, slice 4 of 6). Quick app-boot + core-path sanity plus the migration
quick paths. Full detail lives in `functional.md`.

> **Verification policy: LIVE** — a live receipt (PG store read via managed `psql`, or a
> `telemetry_spans` read) is required for a live verdict; a static-only PASS is a FALSE PASS.
>
> **G-263 SAFETY:** the dev instance is started and stopped ONLY through
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2977` / `-Action Down`.
> Time-bound every leg; the named failure mode is the #2948 ~11 h `pg.stop()` hang.

## Standard boilerplate

- [ ] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:` / `Uncaught` / `Maximum update depth exceeded`.
- [ ] **S-3:** Feature surface reachable — Mission Monitor's entry point renders its expected elements (session list + graph canvas).
- [ ] **S-4:** Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible.
- [ ] **S-5:** Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2977/e2e/smoke.jpeg")` succeeds.

## Migration quick paths

- [ ] **S-6:** Boot with SQLite selected (default) — the app reaches a ready state and a store read
  + write succeed; behaviour is unchanged and `fredo.db` is byte-identical (F-2/R-1).
- [ ] **S-7:** PG-selected first cutover on a fixture `fredo.db` — the export runs, the parity gate
  passes, and the engine reports PostgreSQL; a `psql` read shows the migrated `settings` +
  `feature_data_tables` tables (F-1/F-3).
- [ ] **S-8:** A parity mismatch (induced via `FREDO_MIGRATION_FORCE_MISMATCH=<table>`) makes the
  export exit non-zero and the app start on SQLite with `fredo.db` byte-unchanged (F-4/F-7).
- [ ] **S-9:** Second startup after a successful cutover skips the export (marker set) and stays on
  PostgreSQL (F-8).
- [ ] **S-10:** Mission Monitor renders a live session's chat / tools / tokens / graph from the
  migrated store — cross-check the PG store at the same instant (F-12).
- [ ] **S-11:** Backout smoke — restore the pre-cutover snapshot over `fredo.db`, start the SQLite
  build, and confirm the restored counts/checksums match (F-6).
- [ ] **S-12:** Screenshot capture — `tauri_webview_screenshot(format="jpeg", quality=80,
  filePath=".opencode/tmp/2977/e2e/smoke.jpeg")` succeeds.

## Smoke-level pass/fail

PASS = S-1..S-3, S-6..S-12 green; S-4/S-5 green or a named blocker. Any count/checksum mismatch, a
marker set on a mismatch, an engine flip despite a parity failure, a mutated `fredo.db` on the
migration leg, a blank Mission Monitor while migrated rows exist, a write reaching `telemetry_spans`,
or an unbounded wait = **FAIL**.
