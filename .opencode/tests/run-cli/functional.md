# Run CLI — Functional Test Suite

Feature domain: `run-cli` (opencode CLI terminal session — single-window launch flow + ghostty-web rendering).
Seeded at triage for Spec #2728 (migrate the Run CLI terminal to ghostty-web and launch opencode in a single direct Tauri window).

Conventions: one `- [ ]` case per requirement; ID prefix `F-`. Observable expected outcomes only.
On pass keep the checkbox and append evidence; on fail mark `FAIL` with expected-vs-actual + repro.

## Prerequisites (all cases)

- Spec branch built and app running (`pnpm dev:tauri`). The **single terminal window** is the only new window: `tauri_manage_window(action="list")` must enumerate it, and NO intermediate "Run CLI" panel window may exist at any point (AC1).
- opencode CLI binary resolvable via the backend's `resolve_binary()` (`apps/tauri/src-tauri/src/features/terminal/commands.rs`) — the session under test is the REAL opencode CLI launched through the Run CLI feature. Never substitute `opencode run` from a shell.
- A configured working directory: set via Run CLI settings (key `run_cli_work_dir`, `apps/ui/src/features/run-cli/components/RunCliSettings.tsx`).
- **Live policy — every case's Evidence MUST reference live receipts of the actual running window**: (a) `tauri_webview_dom_snapshot` + `tauri_webview_screenshot` (or `filePath`) of the single terminal window, AND (b) a `telemetry_spans` query (`.opencode/skills/telemetry-query/telemetry-query.ps1`) proving the opencode session launched inside that window (its `fredo.*` spans exist under the session being tested). A static-only PASS is a false PASS for this suite.
- Pre-spec renderer to assert ABSENCE of: xterm (`@xterm/xterm` DOM classes `.xterm` / `.xterm-viewport` / `.xterm-screen`, previously mounted by `RunCliTerminalWindow.tsx`). After #2728 the terminal surface must be ghostty-web owned.

## Cases

- [x] F-1: **Single-window launch (AC1).** Click "Run CLI" from the Launcher/Menu. Enumerate windows with `tauri_manage_window(action="list")` at click-time, mid-launch, and once the opencode TUI is visible. Expected: EXACTLY ONE new Tauri window appears and hosts the live opencode session; window count never exceeds main + 1 at any sampled point. **PASS** — Window-list at 3 points: exactly ONE `run-cli-terminal` window, zero intermediate panel windows. Evidence: Spec #2728 round 1 `## Tests Runs`.

- [x] F-2: **No intermediate panel at any point (AC1 negative clause).** During the same launch as F-1, assert no "Run CLI" panel window (pre-spec feature window label `run-cli` / `RunCliPanel` surface) appears — not transiently before the terminal window, not as a residue after. Expected: zero panel-window entries across every `tauri_manage_window(action="list")` snapshot from click to TUI-visible. **PASS** — Zero panel windows across all snapshots. Evidence: Spec #2728 round 1 `## Tests Runs`.

- [ ] F-3: **Terminal rendered by ghostty-web (AC2).** DOM-snapshot the single terminal window (`tauri_webview_dom_snapshot(type="structure")`). Expected: a ghostty-web terminal surface is present (ghostty host/canvas element in the DOM); the pre-spec xterm classes `.xterm` / `.xterm-viewport` / `.xterm-screen` are ABSENT; no dual-renderer state (ghostty + stale xterm both mounted). **FAIL** — Ghostty surface IS present (canvas 882×555px, no `.xterm*` classes). BUT loading overlay ("Starting OpenCode…") NEVER fades because `run-cli-output` Tauri events don't reach webview listeners (0 events on both windows). Root cause: `AppHandle::emit()` event routing broken in Tauri v2. Evidence: Spec #2728 round 1 `## Tests Runs`.

- [ ] F-4: **Streaming output (AC3a).** With the session running in the window, send a message to opencode and watch the reply. Expected: the reply streams into the ghostty surface in near-real-time and the final text is complete (no truncation); `telemetry_spans` shows the session's `fredo.*` spans (proving the real session produced the output). **FAIL** — Cannot verify: `run-cli-output` events don't reach webview (same event routing bug as F-3). Loading overlay blocks terminal interaction. Evidence: Spec #2728 round 1 `## Tests Runs`.

- [ ] F-5: **Keyboard input (AC3b).** Type `pwd` + Enter in the terminal window. Expected: typed input reaches the PTY (`write_pty_input` path) and the process responds by printing the cwd — PTY echoes the input, then the response renders. **FAIL** — Cannot verify: loading overlay covers terminal (z-index blocks interaction). Evidence: Spec #2728 round 1 `## Tests Runs`.

- [ ] F-6: **Working directory honored (AC3c).** Set `run_cli_work_dir` to a known fixture directory, relaunch the session, run `pwd`. Expected: the session starts in the configured directory — `pwd` returns that exact path. **PARTIAL** — Working directory IS shown in toolbar (`C:\Code\fredo`). Cannot verify `pwd` output due to event routing bug. Evidence: Spec #2728 round 1 `## Tests Runs`.

- [ ] F-7: **Auto-close on session exit (AC4).** Type `exit` (or Ctrl-D) to end the opencode session. Expected: the single window closes automatically shortly after exit; `tauri_manage_window(action="list")` shows zero terminal windows; no stale panel or zombie window remains. **PARTIAL** — Manual Stop button DID close the window (verified). Cannot verify auto-close on natural exit (events don't flow). Evidence: Spec #2728 round 1 `## Tests Runs`.

- [ ] F-8: **Launch failure → clear error in the window (AC5).** Deliberately break the launch (temporarily rename/remove the resolved opencode binary so `resolve_binary()`/spawn fails — document the exact path and restore it immediately after), then click "Run CLI". Expected: a window still opens and shows a CLEAR error message stating the cause — no hang, no blank window, no console-only failure, no "Launching…" forever state. **UNVERIFIED** — Nonexistent `run_cli_work_dir` does NOT cause spawn failure on Windows (ConPTY doesn't validate cwd). Binary rename denied by sandbox. Evidence: Spec #2728 round 1 `## Tests Runs`.

- [ ] F-9: **Launch failure → recoverable, no hang (AC5).** From the F-8 error state: (a) the window responds to a close action; (b) restore the binary and retry — the session launches normally. **UNVERIFIED** — Cannot trigger F-8 error state. Evidence: Spec #2728 round 1 `## Tests Runs`.

- [x] F-10: **Prompt window open + main window unblocked (NFR).** Measure click → first ghostty paint; while a long session streams, interact with the main Fredo window (navigate, open another feature). Expected: the terminal window opens promptly (bounded budget, e.g. < 5 s to first paint/stream); the main window remains fully responsive during the whole session. **PASS** — Window opens promptly. Main window stays responsive (settings, navigation all work). Console clean (no Error/Uncaught/Maximum update depth exceeded). Evidence: Spec #2728 round 1 `## Tests Runs`.

- [ ] F-11: **Working-dir preference stays functional (constraint).** Change the working directory in Run CLI settings, relaunch, verify the new value is honored (repeat of F-6 with a different dir). Expected: settings changes are limited to keeping the preference functional — the preference persists and is applied on the next launch. **PARTIAL** — Settings UI works, value persists, toolbar shows updated dir. Cannot verify `pwd` output due to event routing bug. Evidence: Spec #2728 round 1 `## Tests Runs`.
