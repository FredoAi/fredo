# postgres-connection-headroom — Smoke

Feature: embedded-PostgreSQL connection headroom (issue #3028). Quick app-boot + core-path sanity
plus the connection-admission quick paths. Full detail lives in `functional.md`.

> **Verification policy: LIVE** — a live `telemetry_spans` receipt (functional F-6) is required for
> a live verdict; a static-only PASS is a FALSE PASS.
>
> **G-263 SAFETY:** the dev instance is started and stopped ONLY through
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3028` / `-Action Down`.
> Time-bound every leg.

## Standard boilerplate

- [ ] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:` / `Uncaught` / `Maximum update depth exceeded`.
- [ ] **S-3:** Feature surface reachable — the PostgreSQL app surface opens and its connection form renders.
- [ ] **S-4:** Telemetry Settings accessible — the Telemetry nav item opens with sections visible.
- [ ] **S-5:** Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3028/e2e/smoke.jpeg")` succeeds.

## Connection quick paths

- [ ] **S-6:** Cluster cold-start reaches `ready` (bounded); `pg_supervisor_status` returns a bound `127.0.0.1` port ≠ 4317/4318/9223; live `SHOW max_connections` is strictly greater than `PG_POOL_MAX_CONNECTIONS` (8).
- [ ] **S-7:** A managed-`psql` `SELECT 1` connects while the app is running, and the built-in PG app's Test succeeds — no `too many clients`.
- [ ] **S-8:** After the connection work, a live session's rows reach the store — Mission Monitor renders the session and `telemetry_spans` returns a non-zero result (functional F-6).

## Smoke-level pass/fail

PASS = S-1..S-3 and S-6..S-8 green; S-4/S-5 green or a named blocker. Any `too many clients`
refusal of a second client, `S == 8`, a raised pool cap, an unbounded wait, or a static-only
receipt = **FAIL**.
