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

- [ ] **F-1 (REQ-1) — mode control is discoverable and persists across restart.**
  Open Settings → Terminal; find the "Presentation" radio card group with exactly the two options (`terminal-presentation-mode-same-window`, `terminal-presentation-mode-new-window`). Select "Same window", click the unified **Save**. Restart (`dev-env.ps1 -Action Restart`), reconnect, reopen Settings → Terminal.
  **Expected:** group present with both options; a loading skeleton shows before the stored value resolves (no flash of a wrong pre-selection); after restart "Same window" has `aria-checked="true"`; `execute_js` → `get_setting{key:"terminal_presentation_mode"}` returns `same-window`; `tauri_ipc_monitor` shows NO session/record mutation command (only `get_setting`/`save_setting`).

- [ ] **F-2 (REQ-2) — same-window mode renders inside the main window and creates no extra OS window.**
  Set mode = `same-window` (F-1). Launch Terminal from the toolbar desktop item; then from the app directory. Snapshot `tauri_manage_window(action="list")` before/after and inspect the `main` webview DOM.
  **Expected:** the Terminal session UI (sidebar + pane, "Add session", previous-sessions group) renders inside `main` (in-window app, window-system id `terminal`); the launch creates NO `terminal`-labelled native window (run from a clean state with none pre-existing, so the list is only `main`); add/close/rename/resume all work there. (A `terminal` window left open from before the mode flip is left intact per UI/UX §2 — the assertion is "no NEW window", not "none exists".)

- [ ] **F-3 (REQ-3) — separate-window mode opens/focuses its own native window.**
  Set mode = `new-window`. Launch Terminal from the toolbar and app directory. Snapshot windows; invoke a second time.
  **Expected:** exactly one native Tauri window labelled `terminal` (`index.html?view=terminal`), focused on open; the second invocation focuses that same window — never a second one; behaviour matches today's Terminal.

- [ ] **F-4 (REQ-4) — absent/unrecognized stored value resolves to the defined default.**
  (a) `clean-fredo-db.ps1` then launch. (b) `execute_js` → `save_setting{key:"terminal_presentation_mode", value:"not-a-mode"}`, restart, launch Terminal.
  **Expected:** both resolve to `new-window` with no thrown error and no crash; Terminal opens as a separate native window labelled `terminal`.

- [ ] **F-5 (REQ-5) — `fredo open-terminal` respects the selected mode with no stale/duplicate/orphaned window.**
  mode = `same-window`: run `fredo open-terminal --cli shell --dir <valid-dir>`. Then mode = `new-window`: run it again. Snapshot windows + sessions each time.
  **Expected:** same-window → the session appears inside `main` and the windows list has NO `terminal` window; new-window → the session appears in the focused native `terminal` window; in both cases at most ONE `terminal` window exists (existing reused/focused).

- [ ] **F-6 (REQ-6) — CLI outcome + exit-code contract.**
  Run each: no flags; `--cli shell`; `--cli bogus`; `--cli ""`; `--dir <nonexistent>`; app stopped.
  **Expected:** `opened`=0, `started`=0, `invalid-cli`=1, `invalid-argument`=1, `invalid-directory`=1, app-not-running=2 (assert the printed `outcome` AND `$LASTEXITCODE`); every refusal creates no window and no session.

- [ ] **F-7 (REQ-7) — lifecycle regression in each mode.**
  In BOTH modes: add a session, type input, read `get_pty_buffer{sessionId}` (non-empty), rename it, close it, then resume a previous-session record.
  **Expected:** multi-session sidebar, add/close, rename, previous-sessions/resume, plain-shell sessions, session-type + working-directory defaults and output streaming all behave identically in both modes; rename updates both the live row and the previous row.

- [ ] **F-8 (REQ-8) — closing a Terminal window tree-kills processes, no orphans (both modes).**
  Spawn an `opencode` session; note PIDs with `process-hygiene.ps1 -List`. Close the Terminal window (OS X / Alt+F4; in same-window mode close the in-window Terminal). Re-run `-List`.
  **Expected:** no process from the session's PID tree survives; in same-window mode closing the in-window Terminal also drains + tree-kills every session.

- [ ] **F-9 (REQ-9) — no session silently dropped when the mode changes.**
  new-window with one live session and one persisted previous record; flip to `same-window` + Save; open Terminal; flip back to `new-window`.
  **Expected:** every persisted record is still listed after each flip; the previously live session's record remains resumable; no spurious session is created by the flip.

- [ ] **F-10 (REQ-10, complex) — switch with a live session end-to-end.**
  new-window mode with a live session; select `same-window` + Save; open Terminal; confirm the next open is in `main`; verify the record resumes; inspect windows + processes.
  **Expected:** selection saved; next open presents inside `main`; existing session record resumable; an already-open Terminal window is LEFT ALONE at flip time (UI/UX §2 — not re-parented, closed, or duplicated); no extra window is created and process hygiene stays clean; a second open is idempotent.

- [ ] **F-11 (REQ-1/REQ-2) — theming + accessibility of the mode control.**
  Inspect the mode radio in light AND dark theme; drive it by keyboard only.
  **Expected:** control uses theme tokens/CSS vars only (no hardcoded hex/rgba, no alpha-append onto `var()`); selection conveyed by more than colour; keyboard-reachable with an accessible group name/role and both choices exposed.

- [ ] **F-12 (REQ-2/REQ-3) — opening when already open never duplicates.**
  With Terminal already open (in each mode), invoke the entry point again.
  **Expected:** the existing in-window app / native window is focused; `tauri_manage_window list` never shows two `terminal` windows (new-window) and never shows any `terminal` window (same-window).

- [ ] **F-13 (REQ-5) — single-spawner invariant for the CLI.**
  `tauri_ipc_monitor(action="start")`; run `fredo open-terminal --cli shell --dir <valid-dir>` once.
  **Expected:** exactly ONE session-add results from the one invocation (one `spawn_terminal_session` / one new session in `list_terminal_sessions`); the backend does not spawn a duplicate against the webview listener.

- [ ] **F-14 — CI-parity command set (from `CONTRIBUTING.md`; must pass with zero errors and zero warnings).**
  ```sh
  pnpm --filter @fredo/ui typecheck
  pnpm --filter @fredo/ui build
  pnpm --filter @fredo/ui test:run
  cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml --locked
  cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml --locked
  cargo clippy --manifest-path apps/tauri/src-tauri/Cargo.toml --locked -- -D warnings
  ```
  **Expected:** every command exits 0; `cargo clippy` reports no warnings (`-D warnings`); the UI build reports no TypeScript errors. (Static; complements — never replaces — the live rows above.)
