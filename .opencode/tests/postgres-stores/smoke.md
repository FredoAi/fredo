# postgres-stores — Smoke

Feature: storage engine seam + shared async PostgreSQL pool (issue #2975, slice 2 of 6). Quick
app-boot + core-path sanity plus the store quick paths. Full detail lives in `functional.md`.

> **Verification policy: LIVE** — a live `telemetry_spans` receipt (functional F-16) is required for
> a live verdict; a static-only PASS is a FALSE PASS.
>
> **G-263 SAFETY:** the dev instance is started and stopped ONLY through
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2975` / `-Action Down`. Time-bound
> every leg; the named failure mode is the #2948 ~11 h `pg.stop()` hang.

## Standard boilerplate

- [ ] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:` / `Uncaught` / `Maximum update depth exceeded`.
- [ ] **S-3:** Feature surface reachable — Mission Monitor's entry point renders its expected elements (session list + graph canvas).
- [ ] **S-4:** Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible.
- [ ] **S-5:** Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2975/e2e/smoke.jpeg")` succeeds.

## Store quick paths

- [ ] **S-6:** Boot with SQLite selected (default) — the app reaches a ready state and a store
  read + write succeed; behaviour is unchanged (F-8).
- [ ] **S-7:** Boot with PG selected on a fresh data dir — exactly ONE shared pool serves the
  `AppStore` / `FeatureStore` / `FeatureDataStore` + read-only paths (F-1/F-2).
- [ ] **S-8:** Mission Monitor renders a live session / tools / tokens from the store (functional
  F-16) — cross-check `telemetry_spans` at the same instant.

## Smoke-level pass/fail

PASS = S-1..S-3 and S-6..S-8 green; S-4/S-5 green or a named blocker. Any per-store connection, any
unbounded wait, a mutated `fredo.db` on PG failure, or a blank Mission Monitor while live rows exist
= **FAIL**.
