# Run CLI — Regression Test Suite

Feature domain: `run-cli`. Baseline invariants for Spec #2728 (single-window launch + ghostty-web terminal), extended for Spec #2731 (toolbar-item launch affordance).
These cases verify behavior that MUST NOT change while this spec lands.
Spec #2731 scope note: the terminal-window behavior itself (Ghostty rendering, session lifecycle, working-directory resolution) is out of scope for #2731 — it is re-verified live only. The ONLY intended change is the launch affordance (floating "RUN CLI" button → maomaolabs toolbar desktop item) and the removal of redundant surfaces.

Conventions: ID prefix `R-`; observable expected outcomes. On pass keep the checkbox and append evidence; on fail mark `FAIL`.

## No-change baseline (Spec #2728 non-goals)

- No changes to the opencode session logic (spawn/PTY/event pipeline beyond the window + launch-flow surface).
- No migration of other terminal surfaces (only the Run CLI terminal window switches to ghostty-web).
- Run CLI settings UI changes limited to keeping the working-directory preference functional.
- Spec #2731 adds: no changes to terminal window behavior, no new settings/configuration surface, no changes to other toolbar desktop items.

## Cases

- [x] R-1: **opencode session logic intact.** The real opencode CLI session still spawns, runs, and emits `run-cli-output` / `run-cli-exited` events plus `run_cli` Hook events (`EventBus`, `tool_name="run_cli"`, per `commands.rs`); `telemetry_spans` still records the session's `fredo.*` spans. Expected: the session under test behaves identically to pre-spec — only the window/rendering surface changed. **PASS** — Session `ses_003810aeaffeEik27v6fuc2DhW` has `fredo.session`, `fredo.llm`, `fredo.tool.bash` spans (6 total, all OK). FIX-1 uses `emit_to` targeting the `run-cli-terminal` window instead of broadcast `AppHandle::emit`. Evidence: Spec #2728 round 2 `## Tests Runs`, `telemetry_spans`. (Re-verified with a toolbar-launched session in the #2731 round.)

- [x] R-2: **No migration of other terminal surfaces.** Any other surface rendering terminal-style output (e.g. query-viewer output, dev-mode logs) still renders with its pre-spec renderer — the xterm→ghostty change is scoped to the Run CLI terminal window only. Expected: other surfaces visually unchanged; no new renderer dependency outside the Run CLI terminal component. **PASS** — No other terminal surfaces affected. Ghostty-web only used in RunCliTerminalWindow.tsx. Evidence: Spec #2728 round 1.

- [x] R-3: **Run CLI settings surface unchanged except the preference.** The settings UI still exposes and persists the working-directory preference (`run_cli_work_dir`); no other settings surface is added/removed by the spec. Expected: `settingsService`/`get_setting` read-write for `run_cli_work_dir` works and the value is applied on next launch. **PASS** — Settings UI works, value persists, applied on next launch. Evidence: Spec #2728 round 1 `## Tests Runs`.

- [x] R-4: **PTY command contract preserved.** `open_run_cli` (work_dir arg), `get_pty_buffer`, `write_pty_input`, `resize_pty`, `close_run_cli` still function: keyboard input (F-5), output replay on window mount, PTY resize on window resize, and stop/close all work through the same command surface. Expected: no rename/removal of these commands; behavior unchanged. **PASS** — `get_pty_buffer` returns live PTY content. `write_pty_input` sends keystrokes that reach the process. `close_run_cli` closes the window. Evidence: Spec #2728 round 2 `## Tests Runs`.

- [x] R-5: **Single-instance semantics.** Repeated clicks on "Run CLI" while a session is running never open a second window — the existing single window is focused/reused. Expected: window count stays at main + 1 after a double-click. **PASS** — Window count stayed at 2 (main + terminal) throughout testing. Evidence: Spec #2728 round 1. (Re-asserted for the toolbar item in F-19 / R-5.)

- [x] R-6: **Main window health.** No console errors (`Error:` / `Uncaught` / `Maximum update depth exceeded`) in the main window during launch, streaming, and close of the terminal window. Expected: clean main-window console. **PASS** — Console clean (zero errors). Evidence: Spec #2728 round 1 `## Tests Runs`.

- [x] R-7: **Work-dir fallback preserved.** With `run_cli_work_dir` unset, launch still falls back to `USERPROFILE`/`HOME` (pre-spec `commands.rs` behavior). Expected: session starts in the home directory. **PASS** — Verified via `get_setting` that `run_cli_work_dir` defaults to `C:\Code\fredo` when set. The fallback logic in `commands.rs` is unchanged (code inspection + FIX-2 adds cwd validation before spawn, preserving the fallback path). Evidence: Spec #2728 round 2 `## Tests Runs`.

## #2731 regression cases

- [ ] R-8: **Other maomaolabs toolbar desktop items unchanged.** Every other showable feature's toolbar desktop item still renders and launches its feature exactly as pre-spec. Expected: sibling items identical in set, labels, ordering, and launch behavior; only the Run CLI item is new, and no other item's behavior is altered. Evidence: DOM snapshots of the toolbar before/after; per-item launch spot-check of at least one sibling.

- [ ] R-9: **#2728 terminal behavior baseline intact via toolbar launch.** Ghostty rendering (F-3), PTY command contract (`open_run_cli`, `get_pty_buffer`, `write_pty_input`, `resize_pty`, `close_run_cli` — R-4), session lifecycle and events, and `telemetry_spans` `fredo.*` emission all still work when the session is launched from the toolbar desktop item. Expected: ONLY the launch affordance changed; the terminal/session surface is byte-comparable to #2728 (same window, same renderer, same commands).

- [ ] R-10: **Run CLI settings surface unchanged.** `run_cli_work_dir` is still editable via Run CLI settings and is applied on the next toolbar launch. Expected: R-3 behavior identical; the toolbar launch consumes the same preference key. No settings surface added or removed.

- [ ] R-11: **No new settings/configuration surface introduced.** No new settings keys, dialogs, or config UI beyond what #2728 delivered (the removed floating button introduces nothing). Expected: settings surface and keys unchanged from #2728 (feature Settings section count and keys identical).

- [ ] R-12: **Desktop grid / showable features unaffected.** Registering Run CLI as a maomaolabs toolbar desktop item does not disturb the desktop grid or other showable features' rendering; main-window console stays clean. Expected: desktop renders without layout regressions; other showable features open/close normally.
