# Companion — Regression

> "Must not change" baseline for the companion overlay feature domain. First suite seeded at
> Spec #2850 (shared-avatar refactor + sprite/state cleanup). These invariants MUST hold after
> the refactor — any FAIL is a regression. Run on every testing phase that touches the
> companion surface.
> **Verification policy: live** — companion behavior is only observable on a running app; the
> tester's Evidence MUST reference `telemetry_spans` (a live-query result) for live verdicts
> (the functional F-17 receipt).

## Must NOT change (regression invariants)

- [ ] **R-1 (SpeechBubble geometry unchanged):** The speech bubble keeps its fixed dimensions —
      240×120 text bubble, 208×268 game bubble — and its side-choosing ranking
      (`above > right > left > below`), on-screen margin clamp, framer-motion spring transition
      (`stiffness: 380, damping: 30`), and the streaming cursor block (`Fredo-cursor-blink`
      0.9s step-end infinite, 2×14 px accent) are UNCHANGED. Only the avatar's derived
      width/height feeding the anchor change (80/100 sm vs the old 80/80).
  - **Edge:** the streaming cursor BLINKS after the sprite-keyframe cleanup — `Fredo-cursor-blink`
    must remain in `companion.css` and the cursor must blink during F-7 streaming.
- [ ] **R-2 (single vs double-click discriminator):** The 250 ms click timer semantics are
      unchanged — a single click fires the joke (unless TicTacToe is open), a second click within
      250 ms toggles TicTacToe WITHOUT firing the joke. Reference functional F-7/F-8.
- [ ] **R-3 (TicTacToe behaviors unchanged):** The board, X-vs-O rules, Fredo's single-digit
      response, the `capture_screen_region` vision move, the random-move fallback, and the
      win/draw status text all behave as before. Reference functional F-8.
- [ ] **R-4 (teleport choreography unchanged):** The cross-window choreography (source plays
      teleport-out then hides; destination becomes visible and plays teleport-in; hidden
      elsewhere in every non-active window), the `isTeleportingRef` guard, the `+50` settle, and
      the local-dev vs Tauri `companion-teleport` broadcast split are unchanged — only the clamp
      math source (80/80 → real dims) changes. Reference functional F-6/F-9/F-10.
- [ ] **R-5 (launcher md avatar unchanged):** The launcher renders the md avatar (132 × 165,
      aspect 1014:1264, crispEdges, accent fill, `aria-hidden`) visually unchanged after the
      shared refactor. Launcher layout (app grid, command bar, keyboard hints, clock/LED chrome,
      open/close lifecycle) is NOT changed by this spec. Cross-reference `.opencode/tests/launcher/`
      regression R-16/R-22..R-25 + functional F-39b/F-39c.
- [ ] **R-6 (persisted legacy keys tolerated):** A pre-existing install that carries
      `Fredo_companion_color` and/or `Fredo_companion_auto_walk` in its store must boot clean and
      render the companion with the theme accent — the keys are inert, never crash, and never
      resurrect the color/auto-walk UI. Reference functional F-13.
- [ ] **R-7 (token contract):** No hardcoded hex/`rgba(`/`rgb(` and no `var(--x)NN` alpha-append
      are introduced in the changed companion/avatar/settings files; SpeechBubble's accent-derived
      border/tail/cursor use `var(--accent-primary)` (+ `tint()` for translucent surfaces).
      Reference functional F-15 + `.opencode/tests/launcher/` regression R-23.
- [ ] **R-8 (no re-render loop / no console errors):** The new state-expression code introduces no
      `Maximum update depth exceeded`; the state transitions remain timer-driven as today. Console
      clean after every interaction. Reference functional F-19.
- [ ] **R-9 (settings Companion section survives):** The model-missing warning banner + the
      visibility toggle + the teleport tip survive the bubble-color section deletion; the settings
      modal (ProfileSettingsModal Companion nav item) still mounts `CompanionSettingsPanel`
      without an orphan section/crash. Reference functional F-12/F-13.
- [ ] **R-10 (geometry-suite move):** `fredoAvatarGeometry.test.ts` passes UNMODIFIED from its new
      shared path inside `pnpm --filter @fredo/ui test:run` — the #2837 geometry invariants (31
      source rects → 58 expanded; mirror math `x' = 1014 − x − width`; canvas bounds; as-authored
      center buttons) are the strongest regression net for the avatar asset.
  - **Edge:** the launcher regression rows R-22..R-25 in `.opencode/tests/launcher/regression.md`
    (#2837 avatar geometry invariants) remain in force — the launcher render stays geometry-correct
    through the shared move.

## Overlapping prior-feature suites (run alongside)

- `.opencode/tests/launcher/` — launcher md avatar + shell layout invariants (R-16, R-22..R-25);
  the #2823 Ctrl+Space and #2830 LED invariants (R-20/R-25) confirm the companion Ctrl+right-click
  handler and the teleport shortcut stay intact.
- `.opencode/tests/desktop-shell/` — shell chrome + theming token contract; the shared-avatar
  change must not disturb the desktop idle/engaged surfaces.
- `.opencode/tests/window-manager/` — the cross-window teleport uses the Tauri multi-window model;
  window lifecycle/z-order invariants hold while the terminal-window choreography runs.
- `.opencode/tests/theming/` — the token→var→theme flow that the companion's accent-derived bubble
  chrome now exclusively follows (bubble-color setting deleted).
