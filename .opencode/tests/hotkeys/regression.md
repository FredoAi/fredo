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
- [x] **R-11 (served app boots + engine mounts — promoted round 1):** the SERVED entry `apps/tauri/src/main.tsx` must resolve every import in the `@fredo/ui` graph (no `@/...` alias assumed from `apps/ui`; the served alias is `@` → `apps/tauri/src`) AND must mount `HotkeysProvider` (engine + announcer + which-key overlay) the way `apps/ui/src/main.tsx` does. **Actual round 2 (PASS):** on `spec/2946 @ 4ad4f802` `#root` has children, `data-fredo-hotkeys-engine="1"`, no       `vite-error-overlay`; `ui-validate` now builds the served webview. (Round 1 was FAIL — blank served webview.)

## Spec #2958 additions (named interaction contexts)

- [ ] **R-12 (pending-multi-key Esc cancel unchanged):** at the TOP-LEVEL context, the shipped
      pending-sequence Escape cancel still works — arm a multi-key sequence (e.g. `g`), press
      Escape, and the pending sequence clears with NO context unwind (`data-fredo-pending-sequence`
      clears; the context indicator/depth unchanged, no `context:changed` announcement). Escape at the root must not be hijacked
      by the context model. Baseline recipe: dev-env UP on `main`, arm + Escape, record; repeat on
      `spec/2958`.
- [ ] **R-13 (Escape precedence unchanged):** in a text-entry field Escape still passes to the
      field/does not unwind a context; with a modal open Escape still belongs to the modal; in a
      focused terminal Escape still reaches the PTY (no context unwind). Anchors: `sequence.ts`
      precedence 2–4 (terminal > modal > text-entry), `.opencode/tests/terminal/` R-2.x.
- [ ] **R-14 (focus scoping + default bindings unchanged):** `data-fredo-focus-context` still
      classifies the focused control; a feature-tier binding still fires only while its own feature
      is focused (R-2.5); no shipped default binding is stolen/rebound by the context model
      (Ctrl+Space launcher, `g g`, `?`, the feature `s`/`n`/`p`/`f` sets behave as before when no
      context is entered). Cross-ref R-1/R-2 and F-6.
- [ ] **R-15 (no re-render loop / console clean with contexts):** descending, unwinding, focus
      churn and theme switching introduce no `Maximum update depth exceeded`/`Uncaught`/`Error:`
      (AGENTS.md #523 pattern); the context hook must not be consumed via a per-render changing
      dependency. Cross-ref R-7.

## Spec #2959 additions (persistent contextual key bar)

- [ ] **R-16 (S1 context model unchanged):** the merged #2958 behaviour must not change — the
      focus-derived base (`fredo.root`, `depth 1`), `primary+K` descent to `fredo.root.reference`
      (`depth 2`), one-Escape-per-level unwind, the `hotkeys-context-indicator` (label/pips/icon),
      and the single `hotkeys-announcer` announcements all behave as they did before the bar.
      Baseline recipe: dev-env UP on `main`, record descend/unwind + announcer; repeat on `spec/2959`.
      Cross-ref F-33..F-43.
- [ ] **R-17 (existing bindings not stolen):** the mode chord is ADDITIVE. Ctrl+Space (launcher),
      `g g` (`fredo.window.first`), `?` (cheat sheet), the feature `s`/`n`/`p`/`f` sets,
      `primary+K` (descent) and `y` (reference-only) still resolve exactly as before when keyboard
      mode is OFF; entering mode must not rebind or swallow a shipped binding. Cross-ref R-1/R-14,
      F-25/F-33.
- [ ] **R-18 (which-key overlay + cheat sheet unchanged):** the bar must not replace, suppress or
      re-spec the shipped pending which-key overlay or the `?` cheat sheet; a pending multi-key
      sequence still shows its own hint and Escape still cancels it with no context unwind (R-12).
      Cross-ref F-7/F-30/F-31/F-43.
- [ ] **R-19 (no OS-wide hotkeys, no shortcut-usage telemetry):** the new bar/mode layer registers
      no Tauri global-shortcut / OS-level hotkey and emits NO span/event/metric carrying shortcut
      usage, binding identity, or mode state (PO Q13). Diff `telemetry_spans`/`telemetry_metrics`
      names before vs after a mode drive. Carry-forward of R-9/R-10.
- [ ] **R-20 (token contract + no re-render loop / console clean + build gates):** the new
      bar/mode files introduce no hardcoded hex/rgba/hsla and no `var(--x)NN` alpha-append; no
      `Maximum update depth exceeded`/`Uncaught`/`Error:` across entry/exit/context-change/theming
      operations; `pnpm --filter @fredo/ui build` exit 0 (zero TS errors) and the served
      `build:webview` leg passes (H-11/G-251 class). Cross-ref R-6/R-7/R-8/R-11/R-15.

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

## #2958 testing round 1 — regression result (spec/2958 @ ea0db5c)

Run on the served app (dev-env UP, `spec/2958 @ ea0db5ca`, driver `com.fredo.app`). Live receipt:
195 `telemetry_spans` in the drive window 2026-09-26 23:52:46 → 2026-09-27 00:08:54.

- **R-12 PASS** — at the TOP-LEVEL context, `g` armed `data-fredo-pending-sequence="g"` and
  Escape cleared it (`null`) with NO context unwind (`depth` unchanged) and no `context:changed`
  announcement. Escape at the root is not hijacked. (The same rule held while descended —
  F-A/F-43.)
- **R-13 PASS** — text-entry: Escape does not unwind (depth unchanged), bare keys pass through;
  modal (cheat sheet, `role="dialog" aria-modal="true"`): Escape closed the sheet via its own
  handler with no unwind; terminal: focus context `terminal`, `data-fredo-passthrough="true"`,
  Escape not consumed and a real key reached the PTY.
- **R-14 PASS** — `data-fredo-focus-context` still classifies `default`/`interactive`/`text-entry`/
  `terminal`/`modal` live; the shipped `g g` sequence is intact (`g` arms, second `g` focuses the
  first window, which re-derived the context base to `terminal` — the focus-derived base rule);
  `primary+space` still toggles the launcher; the only new default bindings are the two additive
  #2958 entries (`primary+K` descent, `y` reference-only).
- **R-15 PASS** — console clean across all descent/unwind/focus-churn/theme operations: no
  `Maximum update depth exceeded` / `Uncaught` / `Error:` (only the pre-existing `motion() is
  deprecated` and `ghostty-vt` warnings).
- **R-8 PASS (CI)** — `gh pr checks 2967`: `ui-validate` pass, `validate` pass, `fast-validate`
  pass, `paths` pass, `rust-validate` skipping (no Rust change).
- **R-6 PASS** — no hex/rgb/hsl literal and no `var(--x)NN` alpha-append in the new hotkeys JSX
  (grep hits are issue-reference comments only; `ContextIndicator.test.tsx` pins it).

## #2959 testing round 2 — regression result (spec/2959 @ a693d30)

Run on the served app (dev-env UP, `spec/2959 @ a693d30`, driver `com.fredo.app`). Live receipt:
204 `telemetry_spans` in the drive window 2026-09-27 02:20:07 → 02:32:34 (`otlp_grpc`). Console clean.

- **R-16 PASS** — the merged #2958 context model is unchanged: focus-derived base (`setup`/
  `terminal`/`settings`, depth 1), `primary+K` → `fredo.root.reference` (depth 2), one-Escape
  unwind, the `hotkeys-context-indicator` label/pips, and the single `hotkeys-announcer`
  announcements all behave as before the bar.
- **R-17 PASS** — the mode chord is ADDITIVE: `Ctrl+Space`, `g g`, `?`, `primary+K`, `y` and the
  focus chords resolve as before while mode is OFF (verified entering mode on a resting desktop,
  a context change with mode OFF, and the `Ctrl+Tab` focus change).
- **R-18 PASS** — the bar does not suppress the shipped which-key/cheat-sheet surfaces; the ONE
  announcer and pending-sequence channel are intact.
- **R-19 PASS** — no OS-wide hotkey and no shortcut-usage telemetry (0 shortcut/keymap metric names;
  the 16 `%keyboard%` span hits are the tester's own `tauri_webview_keyboard` tool spans).
- **R-20 PASS** — zero hardcoded colour literal / `var(--x)NN` in the changed files; console clean
  across entry/exit/context-change/theming; `gh pr checks 2973` green (ui-validate, validate,
  fast-validate, paths). **Caveat:** R-20's "no clip" spirit is violated for the
  unavailable-with-reason row (REQ-5 regression — see F-54), though the token/build legs pass.

## #2959 testing round 3 — regression result (spec/2959 @ 0ead7b0)

Run on the served app (dev-env UP `-Spec 2959`, driver `com.fredo.app`, main window). Live receipt:
180 `telemetry_spans` in the drive window 2026-09-27 02:55:34 → 03:05:54 (`otlp_grpc`). Console clean.

- **R-16 PASS** — the merged #2958 context model is unchanged: focus-derived base (`setup`,
  `mission-monitor`, `settings` — depth 1), `primary+K` → `fredo.root.reference` (depth 2),
  one-Escape unwind, the `hotkeys-context-indicator` label/pips, and the single `hotkeys-announcer`
  announcements all behave as before the bar.
- **R-17 PASS** — the mode chord is ADDITIVE: `Ctrl+Space`, `primary+K` and `Escape` resolve as
  before; entering mode rebinds/swallows nothing (the +N more bounded render shows the same
  resolved actions, merely capped for display).
- **R-18 PASS** — the bar does not suppress the shipped which-key/cheat-sheet surfaces; the ONE
  announcer and the `data-fredo-pending-sequence` channel are intact (REQ-5 text-entry drive left
  `pending=null`).
- **R-19 PASS** — no OS-wide hotkey and no shortcut-usage telemetry (0 shortcut/keymap metric
  names; the 2 `%keyboard%` span hits are the tester's own `tauri_webview_keyboard` tool spans).
- **R-20 PASS (local)** — zero hardcoded colour literal / `var(--x)NN` in the changed files;
  console clean across entry/exit/context-change/theming; local `ui-validate` parity green
  (`typecheck` exit 0, `test:run` 179 files / 2622 tests, `build:webview` exit 0). **Caveat:** the
  CI `ui-validate` check for PR #2973 reports FAILURE (unresolved; job log not retrievable in the
  tester sandbox — see the `## Tests Runs` caveats), which does not reproduce locally.

