# Run CLI — Regression Test Suite

Feature domain: `run-cli`. Baseline invariants for Spec #2728 (single-window launch + ghostty-web terminal).
These cases verify behavior that MUST NOT change while this spec lands.

Conventions: ID prefix `R-`; observable expected outcomes. On pass keep the checkbox and append evidence; on fail mark `FAIL`.

## No-change baseline (Spec #2728 non-goals)

- No changes to the opencode session logic (spawn/PTY/event pipeline beyond the window + launch-flow surface).
- No migration of other terminal surfaces (only the Run CLI terminal window switches to ghostty-web).
- Run CLI settings UI changes limited to keeping the working-directory preference functional.

## Cases

- [ ] R-1: **opencode session logic intact.** The real opencode CLI session still spawns, runs, and emits `run-cli-output` / `run-cli-exited` events plus `run_cli` Hook events (`EventBus`, `tool_name="run_cli"`, per `commands.rs`); `telemetry_spans` still records the session's `fredo.*` spans. Expected: the session under test behaves identically to pre-spec — only the window/rendering surface changed. **PARTIAL** — Session spawns and runs (PTY buffer has 11KB). Backend emits events via `app.emit()`. But events don't reach webview listeners (Tauri v2 event routing bug). `telemetry_spans` shows no `run_cli` Hook spans (only OTLP). Evidence: Spec #2728 round 1 `## Tests Runs`.

- [x] R-2: **No migration of other terminal surfaces.** Any other surface rendering terminal-style output (e.g. query-viewer output, dev-mode logs) still renders with its pre-spec renderer — the xterm→ghostty change is scoped to the Run CLI terminal window only. Expected: other surfaces visually unchanged; no new renderer dependency outside the Run CLI terminal component. **PASS** — No other terminal surfaces affected. Ghostty-web only used in RunCliTerminalWindow.tsx. Evidence: Spec #2728 round 1.

- [x] R-3: **Run CLI settings surface unchanged except the preference.** The settings UI still exposes and persists the working-directory preference (`run_cli_work_dir`); no other settings surface is added/removed by the spec. Expected: `settingsService`/`get_setting` read-write for `run_cli_work_dir` works and the value is applied on next launch. **PASS** — Settings UI works, value persists, applied on next launch. Evidence: Spec #2728 round 1 `## Tests Runs`.

- [ ] R-4: **PTY command contract preserved.** `open_run_cli` (work_dir arg), `get_pty_buffer`, `write_pty_input`, `resize_pty`, `close_run_cli` still function: keyboard input (F-5), output replay on window mount, PTY resize on window resize, and stop/close all work through the same command surface. Expected: no rename/removal of these commands; behavior unchanged. **PARTIAL** — `get_pty_buffer` returns 11KB (works). `close_run_cli` works (Stop button closes window). Cannot verify keyboard/resize due to event routing bug. Evidence: Spec #2728 round 1 `## Tests Runs`.

- [x] R-5: **Single-instance semantics.** Repeated clicks on "Run CLI" while a session is running never open a second window — the existing single window is focused/reused. Expected: window count stays at main + 1 after a double-click. **PASS** — Window count stayed at 2 (main + terminal) throughout testing. Evidence: Spec #2728 round 1.

- [x] R-6: **Main window health.** No console errors (`Error:` / `Uncaught` / `Maximum update depth exceeded`) in the main window during launch, streaming, and close of the terminal window. Expected: clean main-window console. **PASS** — Console clean (zero errors). Evidence: Spec #2728 round 1 `## Tests Runs`.

- [ ] R-7: **Work-dir fallback preserved.** With `run_cli_work_dir` unset, launch still falls back to `USERPROFILE`/`HOME` (pre-spec `commands.rs` behavior). Expected: session starts in the home directory. **UNVERIFIED** — Could not test (event routing bug prevents `pwd` verification). Evidence: Spec #2728 round 1.
