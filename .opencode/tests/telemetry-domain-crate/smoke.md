# telemetry-domain-crate — Smoke Tests

> App-boots + core-path sanity for the domain-crate boundary. Run first on this feature's testing
> phase. The Rust-side smokes need no running app; S-6…S-11 need the isolated env up
> (`dev-env.ps1 -Action Up -Spec 3201 -EnvId spec3201 -EnvSlot 1 -RequireIsolation`).
>
> **Isolation:** every live check runs inside THIS issue's env; the read lever takes `-Manifest` so
> the cluster is this env's own (never a sibling env's, never the shared `%APPDATA%` cluster).
>
> **Persisted by the tester in round 1 (G-521).** The suite folder did not exist when
> `planning → implementation` ran, so the persist was a silent no-op and this round authored it.

## Rust boundary smokes (no app needed — developer)

- [ ] **S-1** — `cargo check --locked --manifest-path apps/tauri/src-tauri/Cargo.toml` exits **0**
  with zero warnings. (Fails on a stale `Cargo.lock`: "the lock file needs to be updated".)
- [ ] **S-2** — `cargo tree -p telemetry-domain --edges normal,build` resolves and prints a non-empty
  node set (a crate that does not resolve prints nothing and every absence check is vacuous).
  Round 1's guard reported **41 resolved nodes** — a zero-population scan is an INSTRUMENT FAILURE,
  never a pass.
- [ ] **S-3** — The crate's resolved tree names **none** of `tauri`, `tauri-build`,
  `tauri-runtime`, `tauri-runtime-wry`, `tauri-plugin-shell`, `tauri-plugin-mcp-bridge`, `fredo`,
  `fredo_lib`, `applications`.
- [ ] **S-4** — `cargo nextest run --locked --profile live --no-run` compiles the test targets
  (`check`/`clippy` do not compile test targets, so a test-only break is invisible without this).
  **State the instrument's compilation boundary** in the receipt: `cargo check` is a claim about the
  library target only; only this command compiles `tests/`. Round 1: EXIT 0 across 13 binaries /
  2089 tests, 4m 25s.
- [ ] **S-5** — The `**Feature tests:**` suite this plan declares exists on `main` after the
  `planning → implementation` transition (G-240/G-521) — i.e. `tests-commit` persisted it.
  **Round 1: this row FAILS the transition's promise and PASSES the persist.** The folder was
  absent when the transition ran (silent no-op, `persist_tests` returns `Ok(0)` with no note), and
  the round-1 tester created + persisted it. The defect is the MACHINE's silence, not the suite.

## App smokes (isolated env — tester)

- [ ] **S-6** — App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a
  non-empty `<body>`.
- [ ] **S-7** — No console errors — `tauri_read_logs(source="console", lines=50)` shows no
  `Error:` / `Uncaught` / `Maximum update depth exceeded`.
- [ ] **S-8** — The row pipeline is live — a real agent turn lands a `telemetry_spans` row with
  `end_time_ns IS NOT NULL` (the pre-condition that makes F-13 attributable; if this fails, report it
  and do not judge AC3).
- [ ] **S-9** — The consumer surface is reachable — Mission Monitor opens and lists sessions; a real
  session renders at least one chat node (proves the moved crate's rows still project).
- [ ] **S-10** — Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80,
  filePath=".opencode/tmp/3201/e2e/smoke.jpeg")` succeeds.
- [ ] **S-11** — Settings surface reachable — the sidebar-nav settings surface opens with its
  sections visible (no settings/`Rtdb` coupling leaked INTO the crate could break this).
