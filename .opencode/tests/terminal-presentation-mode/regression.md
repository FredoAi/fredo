# Regression — terminal-presentation-mode

> Feature #2947. This feature is **presentation only** — the backend/emulator/CLI-set
> is unchanged. These are the "must not change" baselines to re-run on every testing
> phase that touches the Terminal surface.
>
> Overlapping prior suites to inherit from: `.opencode/tests/terminal/` (multi-session
> lifecycle, resume, tree-kill), `.opencode/tests/settings/` (Settings shell / feature
> tabs), and — for the module-scoped-persistence rule — `.opencode/tests/mission-monitor/`.

## Invariants

- [ ] **R-1 — new-window mode is byte-for-byte today's behaviour.**
  With mode = `new-window` (or absent → default), Terminal opens its own native
  window labelled `terminal` and every existing capability works: multi-session
  sidebar, add/close session, rename, previous-sessions/resume, plain-shell
  sessions, session-type + working-directory defaults, output streaming.
  **Expected:** no observable change vs the pre-feature baseline.

- [ ] **R-2 — one-window guarantee.**
  Repeated `open_terminal_window` / entry-point invocations focus the existing
  `terminal` window; never a second `terminal` window.
  **Expected:** `tauri_manage_window(action="list")` shows exactly one `terminal`.

- [ ] **R-3 — window close tree-kills every session (no orphans).**
  Close the Terminal window (OS X / Alt+F4 / `close_terminal_window`) with one or
  more live sessions.
  **Expected:** `process-hygiene.ps1 -List` shows no surviving process from any
  session's PID tree; no orphaned `node.exe`/`opencode` carrying a session workdir.

- [ ] **R-4 — persisted records survive a close.**
  Close the Terminal window; reopen.
  **Expected:** every previously persisted record is still listed under "Previous
  sessions" and remains resumable; closing stamps `last_active_at` and never deletes
  a record.

- [ ] **R-5 — `fredo open-terminal` validation + exit codes unchanged.**
  no flags → `opened` (0); `--cli shell` → `started` (0); `--cli bogus` →
  `invalid-cli` (1); `--cli ""` → `invalid-argument` (1); `--dir <missing>` →
  `invalid-directory` (1); app stopped → exit 2.
  **Expected:** identical to the pre-feature contract; a refusal opens no window and
  starts no session.

- [ ] **R-6 — cold-launch one-shot handshake intact.**
  `fredo open-terminal --cli shell --dir <valid-dir>` against a NOT-yet-open window;
  then reload/re-invoke.
  **Expected:** exactly one session spawns per invocation (the `PendingTerminalOpen`
  intent is drained once); a reload does not re-spawn.

- [ ] **R-7 — session-type / working-directory defaults unchanged.**
  Change "Default session type" and "Working directory" in Settings → Terminal; add a
  session; also omit `--cli`/`--dir` on the CLI.
  **Expected:** new sessions use the saved type + work-dir exactly as before; the
  stored keys are still `terminal_default_cli` / `terminal_work_dir` with the same
  value domain (`shell` | `opencode` | `copilot`).

- [ ] **R-8 — Terminal settings tab still wired into the settings shell.**
  Open Settings; the Terminal section is present (auto-discovered via `hasSettings`).
  **Expected:** `SettingsSurface` renders the Terminal nav item and `TerminalSettings`
  without a shell edit; the unified Save footer is intact.

- [ ] **R-9 — presentation-only constraint: no backend wire/CLI-set change.**
  Diff the feature's touched surface against the plan's non-goals.
  **Expected:** no new/changed `Transport` variant, no change to `FredoEvent`, no new
  CLI subcommand or `--cli` value, no emulator/backend change — presentation only.

- [ ] **R-10 — no session dropped across any mode change.**
  Any live/persisted session present before a mode flip is still present (listed /
  resumable) after it.
  **Expected:** zero silent drops; no spurious sessions created by the flip itself.

## CI-parity baseline

- [ ] **R-11 — full local CI command set green** (`CONTRIBUTING.md`):
  `pnpm --filter @fredo/ui typecheck`, `pnpm --filter @fredo/ui build`,
  `pnpm --filter @fredo/ui test:run`, `cargo check --locked`, `cargo test --locked`,
  `cargo clippy --locked -- -D warnings`.
  **Expected:** all exit 0 with zero warnings.
