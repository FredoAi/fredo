# background-capture — Regression

The "must not change" baseline for issue **#3193**, plus links to the prior suites whose surface
this feature edits. Extended by **#3195** (RT-13: AC2 stays a regression invariant; RT-14: the
capture line and the sign-in line stay separate statements).

> **Verification policy: mixed.** RT-1/RT-5/RT-9/RT-10 are `static` (source + committed pins);
> RT-3/RT-4/RT-6/RT-8 have live legs. Every live leg states its tree condition (served env at the
> tested commit).

## Must-not-change invariants

- [ ] **RT-1 (CLI surface).** Every argv other than the sole `--background` keeps today's path and
  today's exit codes: `--help` → 0 with the same subcommand set; `--version` → 0;
  `open-terminal --cli bogus` → 1 with `{"outcome":"invalid-cli",...}`;
  `emit` without a resident app → the pre-existing app-not-running path (exit **2**, reserved).
  `--background` appears in NO clap item. Pin: `apps/tauri/src-tauri/src/infrastructure/cli/mod.rs`
  (commands list + `exit_code_for_parse_error`) unchanged apart from the absence of any new item.
  **Edge:** `--background --help` (two args) is a clap parse error, not a background launch.

- [ ] **RT-2 (`ingest_autostart_get` stays READ-ONLY).** Seed a PRESENT value first
  (`registry-entry.ps1 -SeedForeign`, or the pane's own ON), then open Settings → Background capture,
  change nothing, close it; `registry-entry.ps1 -Read` before and after.
  **Expected:** `ENTRY=Present` on BOTH reads and `RAW_SHA256` identical and NOT `(absent)` — the
  pair must be two non-empty digests of the same subject (two `(absent)` readings are equal and prove
  nothing, G-469). The KV mirror `ingest.autostart` is still written (`"true"`/`"false"`) — unchanged
  contract. Finish with `-Restore`.

- [ ] **RT-3 (foreground cold launch still shows `main`, geometry unchanged).**
  `dev-env.ps1 -Action Up`; read the native window enumeration
  (`launch-background.ps1 -Action Windows -ManifestPath <manifest>`) and the window list.
  **Expected:** `VISIBLE_PRODUCT_WINDOW=True` with a `VISIBLE_NON_CONSOLE_WINDOW_TITLE` after
  `Ready` (the predicate excludes the debug `ConsoleWindowClass` window; `MAIN_WINDOW_HANDLE` alone
  is not the witness); the window entry matches
  `label=main`, `index.html`, 1400×900 / min 900×600 / maximized; the config drift guard test
  (`app_lifecycle` parsing `tauri.conf.json` via `include_str!`) passes with the new
  `visible` key asserted against `MAIN_WINDOW_VISIBLE_BY_CONFIG`;
  `run-exitcode.ps1 -Command "cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml
  app_lifecycle"` → `EXITCODE=0`.

- [ ] **RT-4 (resident shell semantics unchanged — delegate to the #3192 suite).**
  Run `.opencode/tests/resident-shell/functional.md` **F-1a, F-2a, F-2b, F-2c, F-3, F-4** and its
  `regression.md` RT rows.
  **Expected:** close-destroys/process-survives, tray menu exactly `Open`/`Quit`, `open_main_window`
  recreate−or−focus, quit teardown ≤30 s, second launch exits with no new PID — all as before. The
  one DELIBERATE change: `ensure_main_window` now calls `show()` before unminimize/focus, so a
  never-shown window is revealed (F-1c of this suite proves the new leg).

- [ ] **RT-5 (single-instance FOREGROUND probe unchanged).**
  Static pins: `PROBE_TIMEOUT == 1500 ms`; the foreground command is still
  `CliCommand::OpenMainWindow` with wire shape `{"type":"open_main_window"}`; the resident side
  still answers any well-formed answer as resident. New: `Background` sends
  `CliCommand::Ping` → `{"type":"ping"}` answered `{"resident": true}` with NO window work.
  `run-exitcode.ps1 -Command "cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml
  single_instance"` → `EXITCODE=0`, and paste the `Ping` unit test name.

- [ ] **RT-6 (no RTDB / classifier / storage change).**
  `git diff --stat origin/main...HEAD -- apps/tauri/src-tauri/src/infrastructure/rtdb` is EMPTY;
  the span→row pipeline rows of `.opencode/tests/resident-ingest/functional.md` F-5 (successor to
  the retired `headless-ingest/` F-2 — see `resident-ingest/retirement-ledger.md`) and
  `.opencode/tests/event-persistence/` still hold.
  **Expected:** EMPTY diff pasted; F-5's HTTP/gRPC parity still green.

- [ ] **RT-7 (tray + exit gate unchanged).** `app_lifecycle_status` still reports `trayItems`
  exactly `[Open, Quit]`; the exit gate is still `code.is_none() && tray_installed`; the macOS
  menu-quit carve-out is untouched. Pin: `infrastructure/tray.rs` + `app_lifecycle.rs` unit tests
  green (`cargo test … tray`).

- [ ] **RT-8 (INVERTED by #3194 — the retired daemon is GONE, and the resident owner took its
  place).** The gated E2E `apps/tauri/src-tauri/tests/headless_ingest.rs` and
  `applications/pg_supervisor/{headless,descriptor}.rs` were **deleted** by #3194 (ST-1), together
  with `infrastructure/cli/commands/ingest.rs` and the `--run-ms`/`--shutdown-file` seams. Assert
  the absence and run the successor evidence instead of the deleted drive:
  (i) those four paths do not exist; (ii) `run-exitcode.ps1 -Command "\"<exe>\" --help"` lists no
  `ingest` and no `--run-ms`/`--shutdown-file`; (iii) the one-owner row is green —
  `.opencode/tests/resident-ingest/functional.md` **F-1/F-2** (`pg_supervisor_status` ready with
  its own pid/port, one postmaster, one binder per OTLP port).
  **Expected:** (i) all four absent; (ii) exit **0**, no retired token; (iii) F-1/F-2 PASS.
  **KEPT:** `matches_legacy_ingest` / `RunEntryClass::OwnedLegacy` and the
  `no_production_code_path_builds_the_ingest_command` pin still exist and stay green (F-10) — a
  removed *command* is not a removed stored *value*.
  **FAIL:** a surviving module/E2E/seam, or a second postmaster/binder.

- [ ] **RT-9 (KV + command names unchanged).** `AUTOSTART_KEY == "ingest.autostart"`;
  commands are still `ingest_autostart_get` / `ingest_autostart_set` with the same argument names;
  the UI store's `INGEST_AUTOSTART_SETTING_KEY` is unchanged (grep both sides, paste the lines).

- [ ] **RT-10 (no new Tauri command / ACL byte-identical).**
  `git diff --stat origin/main...HEAD -- apps/tauri/src-tauri/src/runtime/command_manifest.rs
  apps/tauri/src-tauri/gen/schemas` EMPTY. `IngestAutostartView` gains FIELDS — a return type, not
  a command.

- [ ] **RT-11 (no `AGENTS.md` / `opencode.json` edit).**
  `git diff --stat origin/main...HEAD -- AGENTS.md opencode.json` EMPTY.

- [ ] **RT-12 (theme.)** The pane uses semantic tokens only: no hex/rgba literal in
  `apps/ui/src/applications/ingest/**`; renders in both light and dark presets; the disabled switch
  is legible in both. **#3195 adds:** the three capture-state colours come from tokens
  (`status.success` / `status.warning` / `status.info` + `fg.muted`) and `tint()` — an alpha-append
  on a `var()` reference is invalid CSS and is a FAIL (see `functional.md` F-12e). Links:
  `.opencode/tests/theme-contract/`, `.opencode/tests/contrast-gate/`.

- [ ] **RT-13 (#3195 — AC2 is a REGRESSION INVARIANT: the pane reads the REAL registry on mount).**
  *Shipped by #3193; #3195 must not regress it while the status line moves off the login-entry
  boolean.* Drive `functional.md` **F-2a → F-2b → F-2c → F-2d**.
  **Expected:** the toggle writes/removes the exact `"<exe>" --background` value; the OUT-OF-BAND
  registry mutation performed while the pane is unmounted is what the reopened pane renders
  (`switchChecked` follows the registry, never a cached/optimistic value); the host is restored
  (`RESTORED_MATCH=True`).
  **FAIL:** a pane that shows the pre-unmount value after the registry changed (a cached UI value);
  a disable that deletes a value the product does not own; a host left mutated.

- [ ] **RT-14 (#3195 — the capture line and the sign-in line are SEPARATE statements, and the old
  capture vocabulary stays dead).** Drive `functional.md` **F-9c** (cross-state absence), **F-10a /
  F-10b** (running vs not running) and **F-12c / F-12d** (retired id + copy absent from
  `apps/ui/src`).
  **Expected:** the capture line reflects `stream_health` in every state; the sign-in state is
  stated ONLY by the switch + `timing`; `settings-ingest-autostart-status` exists only as a negative
  absence pin (the pin body plus its header declaration — three hits in that one test file at the
  #3195 tree); `Background capture: On|Off|Unavailable on this platform` has **zero RENDER sites** —
  its only surviving spellings are the pane suite's `RETIRED_COPY` pin (`:102-104`) and its header,
  which is what F-12d's two sweeps (a non-test sweep at zero, the whole-tree sweep reconciling to the
  pin) are for.
  **FAIL:** the two statements coupled again (the retired line re-introduced, or the capture line
  derived from the login entry); a rendered retired string.

## Prior suites this feature touches

| Suite | Relationship |
|---|---|
| `resident-shell` | owns the resident process, tray, probe and exit gate this spec composes with (RT-4/RT-5/RT-7). |
| `resident-ingest` | owns the ONE resident owner: cluster + OTLP binder set, the typed ingest failure, bounded quit, and the `fredo ingest` ABSENCE rows this suite's F-5a/F-5b/RT-8 now delegate to (seeded #3194). |
| `headless-ingest` | **RETIRED by #3194** — folder deleted; its row-by-row disposition is `resident-ingest/retirement-ledger.md`. Do not run it, do not cite it as a live surface. |
| `settings` | owns the Settings shell; the nav item's LABEL changes, its testid does not. |
| `theme-contract`, `contrast-gate` | the pane must stay token-driven (RT-12). |

## Suite-level pass/fail

PASS = RT-1…RT-14 hold. FAIL = any CLI surface change beyond the sole-argument `--background`
branch; a foreground cold launch that does not show `main`; a second postmaster/`fredo.exe` around
the probe; an RTDB/classifier/storage diff; a new Tauri command or ACL drift; an `AGENTS.md` /
`opencode.json` edit; a registry read that mutates the value; **a pane that renders a cached rather
than the registry's sign-in state (RT-13)**; **a re-introduced `Background capture: On|Off` line or
a capture line derived from the login entry (RT-14)**.
