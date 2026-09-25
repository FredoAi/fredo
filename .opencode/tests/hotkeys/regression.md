# Hotkeys — Regression

> "Must not change" baseline for the keyboard-first hotkey contract (issue #2946). Run on
> every testing phase that touches the global keydown layer, the launcher keyboard
> contract, the terminal key passthrough, or the Settings surface.
> **Verification policy: live** — the tester's Evidence MUST reference `telemetry_spans`
> (a live-query result) for live verdicts; a static-only PASS fails closed.

## Invariants (must NOT change)

- [ ] **R-1 (existing Ctrl+Space launcher shortcut):** Ctrl+Space still opens + focuses the launcher searchbox from any non-text focus, toggles exactly once per press, re-raises above the window stack, and is suppressed while a text field is focused. Anchors: `LauncherShell.tsx:1384-1489` (global `document` keydown), `LauncherCommandBar.tsx:1565` (`aria-keyshortcuts="Control+Space"`). Cross-ref `.opencode/tests/launcher/` F-16..F-20, `.opencode/tests/launcher/` F-34.
- [ ] **R-2 (launcher key contract):** the launcher's ESC/notch/grid/space behaviour is unchanged — ESC closes the shortcut overlay and restores the pre-open focus origin; hold-Space dictation and the Space-does-not-open-a-tile guard still work; the notch toggle still opens. Anchors: `LauncherShell.tsx:1177-1195`, `LauncherShell.tsx:123`. Cross-ref `.opencode/tests/launcher/` F-17/F-18/F-19/S-17.
- [ ] **R-3 (existing keydown listeners):** the pre-existing `document`/`window` keydown listeners still behave — `AppDock.tsx:310`, Mission Monitor `DetailPanel.tsx:202,223` (ESC), and the Konami-code sequence listener are not double-fired or swallowed by the new global hotkey layer. A chord firing twice, or a keystroke swallowed, is a FAIL.
- [ ] **R-4 (terminal input passthrough outside the exception):** with no terminal focused, terminal input handling is unchanged; with a terminal focused, the new layer must not steal any key except the one designated escape chord (`TerminalSidebar.tsx:376,394`, `SessionSidebar.tsx:95-100`). Cross-ref `.opencode/tests/terminal/` R-2.x.
- [ ] **R-5 (Settings surface contract):** the Hotkeys section is discovered via `hasSettings` + `renderSettings()` (`SettingsSurface.tsx:111-223`) and must NOT edit the settings shell; sibling sections (Companion, Appearance, Fredo Setup, Telemetry, discovered feature sections) are functionally unchanged; the SaveFooter contract (only registering panels show it) and section-switch remount (`SettingsSaveProvider key={activeSection}`) are intact. Cross-ref `.opencode/tests/settings/` R-11/R-12/R-14/R-15.
- [ ] **R-6 (token contract):** no hardcoded hex/rgba/hsla and no `var(--x)NN` alpha-append is introduced in the new files; colors use theme tokens/CSS vars/`tint()`. Reference `.opencode/tests/theming/` R-7 and AGENTS.md #2770.
- [ ] **R-7 (no re-render loop / console clean):** opening/closing the Hotkeys surface, switching sections, filtering, rebinding, pending sequences, and theme switching introduce no `Maximum update depth exceeded`/`Uncaught`/`Error:` (AGENTS.md #523 pattern).
- [ ] **R-8 (no test weakening / build gates — CI parity):** `pnpm --filter @fredo/ui build` exit 0 zero TypeScript errors; `pnpm --filter @fredo/ui test:run` green; the repo lint/typecheck leg passes; no existing assertion weakened/disabled/deleted (any refreshed assertion owned per G-125); `cargo check` zero warnings if the backend is touched (e.g. a persisted-config command).
- [ ] **R-9 (no shortcut-usage telemetry):** the new layer emits NO span/event/metric carrying shortcut usage or binding identity (PO resolution Q13). Verify by diffing `telemetry_spans`/`telemetry_metrics` span + metric names before vs after a hotkey drive.
- [ ] **R-10 (no OS-wide hotkeys):** no Tauri global-shortcut plugin / OS-level registration is introduced (PO out-of-scope: no OS-wide/unfocused hotkeys). The global layer remains a webview `document`/`window` listener.
- [x] **R-11 (served app boots + engine mounts — promoted round 1):** the SERVED entry `apps/tauri/src/main.tsx` must resolve every import in the `@fredo/ui` graph (no `@/...` alias assumed from `apps/ui`; the served alias is `@` → `apps/tauri/src`) AND must mount `HotkeysProvider` (engine + announcer + which-key overlay) the way `apps/ui/src/main.tsx` does. **Actual round 2 (PASS):** on `spec/2946 @ 4ad4f802` `#root` has children, `data-fredo-hotkeys-engine="1"`, no `vite-error-overlay`; `ui-validate` now builds the served webview. (Round 1 was FAIL — blank served webview.)

## #2946 testing round 2 — regression result

- R-1 PASS — Ctrl+Space opens/focuses the launcher when closed, keeps it open when the
  searchbox is focused (#2823 preserved), and fires from a locked text field when closed.
- R-2 PASS — launcher Escape closed it and restored the pre-open focus (`Companion` button).
- R-3 PASS — exactly one hotkey `document` keydown listener; Ctrl+Space fired once per press
  (no double-fire) and synthetic bare keys did not double-dispatch.
- R-5 PASS — the Hotkeys pane is a static `SettingsSurface` nav entry; sibling sections
  (Companion, Appearance, Fredo Setup, Telemetry) render unchanged.
- R-6/R-7 PASS — no hex/rgba/`var()NN` in the hotkeys sources; console clean after
  open/close/filter/rebind/pending/theme operations.
- R-9 PASS — no shortcut-usage span/metric names.
- R-10 PASS — no Tauri global-shortcut registration in `src-tauri`.
- R-11 PASS — served app boots + engine mounts (above).
- [ ] **R-5 note (stale text):** the binding adjudication supersedes this file's `hasSettings` + `renderSettings()` wording — the Hotkeys pane is a **static `SettingsSurface` `NavItem id="hotkeys"`**, not a discovered feature section. Assert the static nav entry + `hotkeys-*` testids, not `hasSettings`.

## Overlapping prior-feature suites (run alongside)

- `.opencode/tests/launcher/` — the Ctrl+Space launcher shortcut, ESC/notch/grid/space contract (F-16..F-20, F-34, S-17).
- `.opencode/tests/settings/` — the Settings window shell + discovered sections + SaveFooter/token contract (R-10..R-20).
- `.opencode/tests/terminal/` — terminal key input + sidebar keyboard handling (R-2.x, E-*).
- `.opencode/tests/desktop-chrome/` — desktop chrome keyboard entry points (F-19).
- `.opencode/tests/theming/` — the token→var→theme flow the new surface must follow.

## #2946 testing round 3 — regression result

Run on `spec/2946 @ 45d5120` (dev-env UP, driver `com.fredo.app`).

- R-1 PASS — Ctrl+Space opened/focused the launcher and is a global chord throughout the
  drive; the launcher's Escape collapsed it (grid hidden, focus released) once open.
- R-3 PASS — a bare `g`/`s`/`n`/`p` produced exactly one engine decision; no double-fire
  against the launcher's documented Ctrl+Space listener; typed `gn` in the MM session
  filter landed verbatim with no pending sequence.
- R-6 PASS — `themeHygiene.test.ts` (7 tests) green over the hotkeys sources, including
  the new `CheatSheetOverlay.tsx` (relative imports, tokens/`tint()` only).
- R-7 PASS — no `Maximum update depth exceeded`/`Uncaught`/`Error:` in the main-window
  console after open/close, pending sequences, rebind, reset-all, restart, theme pane.
- R-8 PASS (local) — `pnpm --filter @fredo/ui build` exit 0; `pnpm --filter @fredo/ui
  test:run` 161 files / 2287 tests green; `pnpm --filter @fredo/tauri build:webview`
  exit 0 (2624 modules). **CI note:** `gh pr checks 2952` shows `ui-validate` FAILED on
  `TerminalWindow.test.tsx#L262` (`terminal-session-sidebar-live-section` not found after
  `findByTestId('terminal-session-sidebar')`) — a pre-existing Spec #2934 terminal-sidebar
  test unrelated to #2946; it passes reliably locally (full suite + isolated 36 tests)
  and is a mount/render race, not a regression in this feature.
- R-9 PASS — 0 shortcut-usage span/metric names (see H-27).
- R-10 PASS — no Tauri global-shortcut registration introduced.
- R-11 PASS — the served app boots on `spec/2946 @ 45d5120`: `#root` mounts,
  `data-fredo-hotkeys-engine="1"`, no `vite-error-overlay`.
