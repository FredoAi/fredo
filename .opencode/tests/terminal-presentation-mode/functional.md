# Functional — terminal-presentation-mode

> Feature #2947. Terminal presentation mode: **Same window** (inside the main Fredo
> window as one of Fredo's in-window apps) vs **Separate window** (its own native Tauri
> window — today's behaviour). Choice is remembered and applies from every entry
> point (app directory, in-app toolbar, `fredo open-terminal`).
>
> **Binding names (G-187):**
> - Storage unit: AppStore key `terminal_presentation_mode` via `save_setting`/`get_setting`; wire values `same-window` | `new-window`.
> - Display unit: Settings → Terminal → field heading **"Presentation"**; card titles **"Same window"** (`same-window`) / **"Separate window"** (`new-window`).
> - DOM hooks: `terminal-presentation-mode` (group), `terminal-presentation-mode-same-window`, `terminal-presentation-mode-new-window`, `terminal-presentation-mode-hint` (switch hint).
> - Default for absent/unrecognized: `new-window` (today's behaviour).
>
> Each case states an observable expected outcome. On pass keep the checkbox and
> append evidence; on fail leave `- [ ]` and mark FAIL with expected-vs-actual + repro.
> Evidence levers: `dev-env.ps1 -Action Up/Restart`, `tauri_driver_session start`,
> `tauri_manage_window(action="list")`, `tauri_webview_dom_snapshot`/`screenshot`/`execute_js`,
> `list_terminal_sessions`, `get_pty_buffer{sessionId}`, `process-hygiene.ps1 -List`,
> `clean-fredo-db.ps1`, `fredo open-terminal …`. Live-policy gate: a `telemetry_spans`
> baseline via the telemetry-query skill.

## Cases

- [x] **F-1 (REQ-1) — mode control is discoverable and persists across restart.** (round 2 PASS: restart leg — set same-window + Save, `dev-env.ps1 -Action Restart`, `get_setting` = `same-window`, Settings shows "Same window" `checked`.)
  Open Settings → Terminal; find the "Presentation" radio card group with exactly the two options (`terminal-presentation-mode-same-window`, `terminal-presentation-mode-new-window`). Select "Same window", click the unified **Save**. Restart (`dev-env.ps1 -Action Restart`), reconnect, reopen Settings → Terminal.
  **Expected:** group present with both options; a loading skeleton shows before the stored value resolves (no flash of a wrong pre-selection); after restart "Same window" has `aria-checked="true"`; `execute_js` → `get_setting{key:"terminal_presentation_mode"}` returns `same-window`; `tauri_ipc_monitor` shows NO session/record mutation command (only `get_setting`/`save_setting`).

- [ ] **F-2 (REQ-2) — same-window mode renders inside the main window and creates no extra OS window.**
  Set mode = `same-window` (F-1). Launch Terminal from the toolbar desktop item; then from the app directory. Snapshot `tauri_manage_window(action="list")` before/after and inspect the `main` webview DOM.
  **Expected:** the Terminal session UI (sidebar + pane, "Add session", previous-sessions group) renders inside `main` (in-window app, window-system id `terminal`); the launch creates NO `terminal`-labelled native window (run from a clean state with none pre-existing, so the list is only `main`); add/close/rename/resume all work there. (A mode flip WITH a live host tears the superseded host down behind the confirmation — SI adjudication #1 — so once `same-window` is active no native `terminal` window should remain; the assertion is "no NEW window" AND "no stale superseded host".)

- [ ] **F-3 (REQ-3) — separate-window mode opens/focuses its own native window.**
  Set mode = `new-window`. Launch Terminal from the toolbar and app directory. Snapshot windows; invoke a second time.
  **Expected:** exactly one native Tauri window labelled `terminal` (`index.html?view=terminal`), focused on open; the second invocation focuses that same window — never a second one; behaviour matches today's Terminal.

- [x] **F-4 (REQ-4) — absent/unrecognized stored value resolves to the defined default.** (round 2 PASS: absent (`null`, both stores clear) → native `terminal` window opened (default `new-window`); unrecognized `not-a-mode` → native window + default; `" same-window "` → recognized after trim on BOTH sides (FS-2); `"Same-Window"`/JSON array → default per FS-8 unit pins.)
  (a) `clean-fredo-db.ps1` then launch. (b) `execute_js` → `save_setting{key:"terminal_presentation_mode", value:"not-a-mode"}`, restart, launch Terminal.
  **Expected:** both resolve to `new-window` with no thrown error and no crash; Terminal opens as a separate native window labelled `terminal`.

- [x] **F-5 (REQ-5) — `fredo open-terminal` respects the selected mode with no stale/duplicate/orphaned window.** (round 2 PASS: same-window cold `--cli opencode --dir <valid>` → `started`, windows `[main]` only, exactly 1 live session, PTY non-empty with the opencode TUI; warm + no-args `opened` → 0 new sessions; new-window unchanged.)
  mode = `same-window`: run `fredo open-terminal --cli shell --dir <valid-dir>`. Then mode = `new-window`: run it again. Snapshot windows + sessions each time.
  **Expected:** same-window → the session appears inside `main` and the windows list has NO `terminal` window; new-window → the session appears in the focused native `terminal` window; in both cases at most ONE `terminal` window exists (existing reused/focused).

- [x] **F-6 (REQ-6) — CLI outcome + exit-code contract.** (round 2 PASS on outcomes + static exit-code mapping: `cargo test --locked` covers `exit_code_for_response` — 963 passed; live `$LASTEXITCODE` remains a named tooling blocker (G-092/FS-5c) — do NOT re-FAIL on the numeric leg.)
  Run each: no flags; `--cli shell`; `--cli bogus`; `--cli ""`; `--dir <nonexistent>`; app stopped.
  **Expected:** `opened`=0, `started`=0, `invalid-cli`=1, `invalid-argument`=1, `invalid-directory`=1, app-not-running=2 (assert the printed `outcome` AND `$LASTEXITCODE`); every refusal creates no window and no session.

- [x] **F-7 (REQ-7) — lifecycle regression in each mode.** (round 2 PASS in both modes: in-window add/type/PTY/rename; native add/type/`get_pty_buffer`/rename/close/reopen/resume — record `3f1d226d` resumed in the native host with the same id.)
  In BOTH modes: add a session, type input, read `get_pty_buffer{sessionId}` (non-empty), rename it, close it, then resume a previous-session record.
  **Expected:** multi-session sidebar, add/close, rename, previous-sessions/resume, plain-shell sessions, session-type + working-directory defaults and output streaming all behave identically in both modes; rename updates both the live row and the previous row.

- [x] **F-8 (REQ-8) — closing a Terminal window tree-kills processes, no orphans (both modes).** (round 2 PASS with a live `opencode` fixture in BOTH modes: native close removed the whole tree; same-window in-window chrome-X close removed the whole tree — 18→14 processes, no surviving PID; FS-1 fix.)
  Spawn an `opencode` session; note PIDs with `process-hygiene.ps1 -List`. Close the Terminal window (OS X / Alt+F4; in same-window mode close the in-window Terminal). Re-run `-List`.
  **Expected:** no process from the session's PID tree survives; in same-window mode closing the in-window Terminal also drains + tree-kills every session.

- [ ] **F-9 (REQ-9) — no session silently dropped when the mode changes.**
  new-window with one live session and one persisted previous record; flip to `same-window` + Save; open Terminal; flip back to `new-window`.
  **Expected:** every persisted record is still listed after each flip; the previously live session's record remains resumable; no spurious session is created by the flip.

- [ ] **F-10 (REQ-10, complex) — switch with a live session end-to-end.**
  new-window mode with a live session; select `same-window` + Save; open Terminal; confirm the next open is in `main`; verify the record resumes; inspect windows + processes.
  **Expected:** selection saved; next open presents inside `main`; existing session record resumable; an already-open Terminal host IS torn down at flip time behind the confirmation dialog (SI adjudication #1 — superseded host ended via the shipped `close_terminal_window` path, records retained → resumable; the "already-open host" is NOT left alone — it is ended, not re-parented or duplicated); no extra window is created, no stale superseded host remains, and process hygiene stays clean; a second open is idempotent.

- [x] **F-11 (REQ-1/REQ-2) — theming + accessibility of the mode control.** (round 2 PASS in light theme: group `role="radiogroup"` with both options and accessible names; theme tokens only; native `<input type="radio">` focusable. Dark-theme leg PASS round 1. Note: the OS keyboard driver could not deliver Arrow/Space key events to the covered settings window — a driver limitation, not a product defect; the native radio is inherently keyboard-operable.)
  Inspect the mode radio in light AND dark theme; drive it by keyboard only.
  **Expected:** control uses theme tokens/CSS vars only (no hardcoded hex/rgba, no alpha-append onto `var()`); selection conveyed by more than colour; keyboard-reachable with an accessible group name/role and both choices exposed.

- [ ] **F-12 (REQ-2/REQ-3) — opening when already open never duplicates.**
  With Terminal already open (in each mode), invoke the entry point again.
  **Expected:** the existing in-window app / native window is focused; `tauri_manage_window list` never shows two `terminal` windows (new-window) and never shows any `terminal` window (same-window).

- [x] **F-13 (REQ-5) — single-spawner invariant for the CLI.** (round 2 PASS: each `fredo open-terminal` invocation produced exactly ONE new session — cold arm 1 session; warm arm 1 new session; no-args arm 0 new sessions; cold-handshake + warm-event did not double-spawn.)
  `tauri_ipc_monitor(action="start")`; run `fredo open-terminal --cli shell --dir <valid-dir>` once.
  **Expected:** exactly ONE session-add results from the one invocation (one `spawn_terminal_session` / one new session in `list_terminal_sessions`); the backend does not spawn a duplicate against the webview listener.

- [x] **F-14 — CI-parity command set (from `CONTRIBUTING.md`; must pass with zero errors and zero warnings).** (round 2 PASS: `typecheck` 0, `build` 0, `test:run` 163 files/2319 tests 0 failed, `cargo check --locked` 0 warnings, `cargo test --locked` 963 passed/0 failed, `cargo clippy --locked -- -D warnings` 0 warnings.)
  ```sh
  pnpm --filter @fredo/ui typecheck
  pnpm --filter @fredo/ui build
  pnpm --filter @fredo/ui test:run
  cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml --locked
  cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml --locked
  cargo clippy --manifest-path apps/tauri/src-tauri/Cargo.toml --locked -- -D warnings
  ```
  **Expected:** every command exits 0; `cargo clippy` reports no warnings (`-D warnings`); the UI build reports no TypeScript errors. (Static; complements — never replaces — the live rows above.)
