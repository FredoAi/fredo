# background-capture — Regression

The "must not change" baseline for issue **#3193**, plus links to the prior suites whose surface
this feature edits.

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

- [ ] **RT-2 (`ingest_autostart_get` stays READ-ONLY).** Open Settings → Background capture, change
  nothing, close it; `registry-entry.ps1 -Read` before and after.
  **Expected:** `RAW_SHA256` identical (and `ENTRY` identical). The KV mirror
  `ingest.autostart` is still written (`"true"`/`"false"`) — unchanged contract.

- [ ] **RT-3 (foreground cold launch still shows `main`, geometry unchanged).**
  `dev-env.ps1 -Action Up`; read the native handle and the window list.
  **Expected:** `MainWindowHandle != 0` after `Ready`; the window entry matches
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
  the span→row pipeline rows of `.opencode/tests/headless-ingest/functional.md` F-2 and
  `.opencode/tests/event-persistence/` still hold.
  **Expected:** EMPTY diff pasted; F-2's HTTP/gRPC parity still green.

- [ ] **RT-7 (tray + exit gate unchanged).** `app_lifecycle_status` still reports `trayItems`
  exactly `[Open, Quit]`; the exit gate is still `code.is_none() && tray_installed`; the macOS
  menu-quit carve-out is untouched. Pin: `infrastructure/tray.rs` + `app_lifecycle.rs` unit tests
  green (`cargo test … tray`).

- [ ] **RT-8 (the retained `fredo ingest` daemon still works).**
  The gated E2E `apps/tauri/src-tauri/tests/headless_ingest.rs` is unchanged and still gated; run
  `.opencode/tests/headless-ingest/smoke.md` S-4/S-5 if an environment is available.
  **Expected:** the daemon boots and stops bounded; no source change to `pg_supervisor/**`,
  `cli/commands/ingest.rs`, or the daemon's env seams. (Retiring the subcommand is #3194's call —
  this spec must not.)

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
  is legible in both. Links: `.opencode/tests/theme-contract/`,
  `.opencode/tests/contrast-gate/`.

## Prior suites this feature touches

| Suite | Relationship |
|---|---|
| `resident-shell` | owns the resident process, tray, probe and exit gate this spec composes with (RT-4/RT-5/RT-7). |
| `headless-ingest` | owns the retained `fredo ingest` daemon; its F-8 login-entry row is SUPERSEDED by this suite (rewritten in the same slice), F-6's DOM clause amended, smoke S-3 amended. |
| `settings` | owns the Settings shell; the nav item's LABEL changes, its testid does not. |
| `theme-contract`, `contrast-gate` | the pane must stay token-driven (RT-12). |

## Suite-level pass/fail

PASS = RT-1…RT-12 hold. FAIL = any CLI surface change beyond the sole-argument `--background`
branch; a foreground cold launch that does not show `main`; a second postmaster/`fredo.exe` around
the probe; an RTDB/classifier/storage diff; a new Tauri command or ACL drift; an `AGENTS.md` /
`opencode.json` edit; a registry read that mutates the value.
