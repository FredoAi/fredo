# postgres-lifecycle — Smoke

Feature: embedded-PostgreSQL lifecycle supervisor (issue #2974, slice 1 of 6). Quick app-boot +
core-path sanity plus the lifecycle quick paths. Full detail lives in `functional.md`.

> **Verification policy: LIVE** — a live `telemetry_spans` receipt (functional F-15) is required for
> a live verdict; a static-only PASS is a FALSE PASS.
>
> **G-263 SAFETY:** the dev instance is started and stopped ONLY through
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2974` / `-Action Down`. Time-bound
> every leg; the named failure mode is the #2948 ~11 h `pg.stop()` hang.

## Standard boilerplate

- [ ] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:` / `Uncaught` / `Maximum update depth exceeded`.
- [ ] **S-3:** Feature surface reachable — Mission Monitor's entry point renders its expected elements (session list + graph canvas).
- [ ] **S-4:** Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible.
- [ ] **S-5:** Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2974/e2e/smoke.jpeg")` succeeds.

## Lifecycle quick paths

- [ ] **S-6:** With the PG engine enabled, cold-start the app — the shell renders before/while the
  server boots (non-empty `<body>`), and the app reaches a ready state within the declared caps.
- [ ] **S-7:** Quit normally — within the 30 s stop cap, `tasklist /FI "IMAGENAME eq postgres.exe"
  /FO CSV /NH` shows no `postgres.exe` PID this run started, and the KV marker is cleared.
- [ ] **S-8:** Mission Monitor renders a live session / tools / tokens from the store (functional
  F-15) — cross-check `telemetry_spans` at the same instant.

## Smoke-level pass/fail

PASS = S-1..S-3 and S-6..S-8 green; S-4/S-5 green or a named blocker. Any unbounded wait, any
`postgres.exe` this run started still alive after quit, or a stale marker = **FAIL**.
