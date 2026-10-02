# postgres-packaging — Smoke

Feature: embedded-PostgreSQL packaging & install — acquisition mode, SHA-pinned integrity, measured
footprint, Windows distribution quality, release gate (issue #2978, slice 5 of 6). Quick app-boot +
core-path sanity plus the packaging quick paths. Full detail lives in `functional.md`.

> **Verification policy: LIVE** — a live receipt (a measured byte number, a DOM snapshot, a
> `telemetry_spans` read) is required for a live verdict; a static-only PASS is a FALSE PASS.
>
> **G-263 SAFETY:** the dev instance is started and stopped ONLY through
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2978` / `-Action Down`.
> Time-bound every leg; the named failure mode is the #2948 ~11 h `pg.stop()` hang.
>
> **G-284:** live PG reads use the managed `psql` via `run-exitcode.ps1` (the `telemetry-query` skill
> is SQLite-only). A missing lever is a tooling gap to `block` on.

## Standard boilerplate

- [ ] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:` / `Uncaught` / `Maximum update depth exceeded`.
- [ ] **S-3:** Feature surface reachable — Mission Monitor's entry point renders its expected elements (session list + graph canvas).
- [ ] **S-4:** Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible.
- [ ] **S-5:** Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2978/e2e/smoke.jpeg")` succeeds.

## Packaging quick paths

- [ ] **S-6:** The default build is `runtime-download` — `cargo tree -e features -p postgresql_embedded`
  shows NO `bundled`; `cargo metadata` shows the shipped feature set (F-1/F-2).
- [ ] **S-7:** The `bundled` branch builds (`cargo build --features bundled`) and boots; no first-run
  network for the archive (F-9/F-10).
- [ ] **S-8:** First-run acquisition on the default build fetches the archive (164,026,008 B) within
  the finite bound; a completed archive is skipped on the next launch (F-3).
- [ ] **S-9:** A corrupt/truncated acquisition (`.opencode/tmp/2978/acq-corrupt/`) is deleted and
  surfaces an actionable error — no partial extract (F-4).
- [ ] **S-10:** A first-run network failure (`FREDO_PG_ARCHIVE_URL` unreachable) surfaces a retryable
  error with no half-extracted tree (F-5).
- [ ] **S-11:** The app launches with no console flash and a server log tail exists (F-6/F-7).
- [ ] **S-12:** Mission Monitor renders a live session's chat / tools / tokens / graph after the
  packaging change — cross-check `telemetry_spans` at the same instant (F-13).

## Smoke-level pass/fail

PASS = S-1..S-3 and S-6..S-12 green; S-4/S-5 green or a named blocker. A mode not build-time
enforced, a corrupt/truncated acquisition that extracts, a first-run failure that leaves a partial
tree, a console flash, no log tail, a static-only receipt on S-12, or an unbounded wait = **FAIL**.
