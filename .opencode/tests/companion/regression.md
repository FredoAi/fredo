# Companion — Regression

> "Must not change" baseline for the companion overlay feature domain. First suite seeded at
> Spec #2850 (shared-avatar refactor + sprite/state cleanup). These invariants MUST hold after
> the refactor — any FAIL is a regression. Run on every testing phase that touches the
> companion surface.
> **Verification policy: live** — companion behavior is only observable on a running app; the
> tester's Evidence MUST reference `telemetry_spans` (a live-query result) for live verdicts
> (the functional F-17 receipt).

## Must NOT change (regression invariants)

- [x] **R-1 (SpeechBubble geometry unchanged):** The speech bubble keeps its fixed dimensions —
      240×120 text bubble, 208×268 game bubble — and its side-choosing ranking
      (`above > right > left > below`), on-screen margin clamp, framer-motion spring transition
      (`stiffness: 380, damping: 30`), and the streaming cursor block (`Fredo-cursor-blink`
      0.9s step-end infinite, 2×14 px accent) are UNCHANGED. Only the avatar's derived
      width/height feeding the anchor change (80/100 sm vs the old 80/80).
  - **PASS (live, spec/2850).** The bubble rendered 240×120 `(style width:240px; height:120px)` for text and 208×268 for the game bubble; the `chooseSide` ranking `above > right > left > below` is preserved (`SpeechBubble.tsx:49`), the margin clamp (`:90-91`), and the spring `stiffness:380, damping:30` (`:116`) are unchanged. The streaming cursor 2×14 px blinks on `Fredo-cursor-blink` 0.9s (`companion.css:94` retained + `SpeechBubble.tsx:160`), verified live during active streaming (`cursorAnim {w:2px,h:14px,anim:Fredo-cursor-blink,dur:0.9s}`). The anchor now feeds the real sm dims (80/100).
  - **Edge:** the streaming cursor BLINKS after the sprite-keyframe cleanup — `Fredo-cursor-blink`
    must remain in `companion.css` and the cursor must blink during F-7 streaming.
- [x] **R-2 (single vs double-click discriminator):** The 250 ms click timer semantics are
      unchanged — a single click fires the joke (unless TicTacToe is open), a second click within
      250 ms toggles TicTacToe WITHOUT firing the joke. Reference functional F-7/F-8.
  - **PASS (live, spec/2850).** Single-click fired the joke (state → talk); double-click logged `[companion] double-click → toggle TicTacToe` and opened the game bubble with NO `askForJoke`. The 250 ms timer (`FredoCompanion.tsx:280`) + the `if (!showTicTacToe) askForJoke()` guard are unchanged.
- [x] **R-3 (TicTacToe behaviors unchanged):** The board, X-vs-O rules, Fredo's single-digit
      response, the `capture_screen_region` vision move, the random-move fallback, and the
      win/draw status text all behave as before. Reference functional F-8.
  - **PASS (live, spec/2850).** TicTacToe opened in the 208×268 game bubble, X placed (user), Fredo (O) replied in a legal empty cell (center), status text updated `Your turn (X)`↔`Companion's turn (O)`.
- [x] **R-4 (teleport choreography unchanged):** The cross-window choreography (source plays
      teleport-out then hides; destination becomes visible and plays teleport-in; hidden
      elsewhere in every non-active window), the `isTeleportingRef` guard, the `+50` settle, and
      the local-dev vs Tauri `companion-teleport` broadcast split are unchanged — only the clamp
      math source (80/80 → real dims) changes. Reference functional F-6/F-9/F-10.
  - **PASS (live, spec/2850).** Same-window teleport: state sequence `idle→teleport-out→teleport-in→idle` at preserved ~400ms+50ms timing. Cross-window (main↔terminal): source plays out + hides (`present:false`), destination plays in + settles, hidden elsewhere. `isTeleportingRef` guard + `+50` settle + the `IS_TAURI` broadcast/local split all unchanged.
- [x] **R-5 (launcher md avatar unchanged):** The launcher renders the md avatar (132 × 165,
      aspect 1014:1264, crispEdges, accent fill, `aria-hidden`) visually unchanged after the
      shared refactor. Launcher layout (app grid, command bar, keyboard hints, clock/LED chrome,
      open/close lifecycle) is NOT changed by this spec. Cross-reference `.opencode/tests/launcher/`
      regression R-16/R-22..R-25 + functional F-39b/F-39c.
  - **PASS (live, spec/2850).** md avatar 132×165, 58 rects, crispEdges, accent fill, `aria-hidden` — unchanged; launcher layout verified unchanged (only the import swap).
- [x] **R-6 (persisted legacy keys tolerated):** A pre-existing install that carries
      `Fredo_companion_color` and/or `Fredo_companion_auto_walk` in its store must boot clean and
      render the companion with the theme accent — the keys are inert, never crash, and never
      resurrect the color/auto-walk UI. Reference functional F-13.
  - **PASS (live, spec/2850).** Seeded keys (valid + malformed) in localStorage + AppStore, relaunched → booted clean, companion rendered with the theme accent (`rgb(147,51,234)`, NOT the seeded cyan), keys stayed present but inert.
- [x] **R-7 (token contract):** No hardcoded hex/`rgba(`/`rgb(` and no `var(--x)NN` alpha-append
      are introduced in the changed companion/avatar/settings files; SpeechBubble's accent-derived
      border/tail/cursor use `var(--accent-primary)` (+ `tint()` for translucent surfaces).
      Reference functional F-15 + `.opencode/tests/launcher/` regression R-23.
  - **PASS (static grep).** ZERO hardcoded hex/rgb in the changed files; `var(--accent-primary)` + `tint()` only; banner literals converted to `tint('var(--status-error)',…)`, boxShadow to `tint('var(--border-color)',45)`.
- [x] **R-8 (no re-render loop / no console errors):** The new state-expression code introduces no
      `Maximum update depth exceeded`; the state transitions remain timer-driven as today. Console
      clean after every interaction. Reference functional F-19.
  - **PASS (live, console).** No `Maximum update depth exceeded`/`Uncaught`/`Error:` in any leg in either window; state transitions are timer-driven (`useRef` timers + `animKey`).
- [x] **R-9 (settings Companion section survives):** The model-missing warning banner + the
      visibility toggle + the teleport tip survive the bubble-color section deletion; the settings
      modal (ProfileSettingsModal Companion nav item) still mounts `CompanionSettingsPanel`
      without an orphan section/crash. Reference functional F-12/F-13.
  - **PASS (live, spec/2850).** Companion settings section (with the legacy keys seeded) renders ONLY the toggle + tip; the model-missing banner (token-native `tint('var(--status-error)',…)`) + toggle survive the color-section deletion; no orphan nav item/crash.
- [x] **R-10 (geometry-suite move):** `fredoAvatarGeometry.test.ts` passes UNMODIFIED from its new
      shared path inside `pnpm --filter @fredo/ui test:run` — the #2837 geometry invariants (31
      source rects → 58 expanded; mirror math `x' = 1014 − x − width`; canvas bounds; as-authored
      center buttons) are the strongest regression net for the avatar asset.
  - **PASS (static/build).** Moved test passes UNMODIFIED (7 tests) at `shared/fredo-avatar/__tests__/` inside the full `test:run` (52 files/757 tests green) — byte-identical to the pre-move source.
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

---

## #2852 extension — launcher size/idle slice must NOT touch the companion

> Issue #2852 changes the DESKTOP LAUNCHER mascot (md → sm 80×100 + idle bob/glow). The
> companion is the size/animation REFERENCE, not a target: it is already 80×100 and must remain
> byte/behaviour-identical. Run alongside R-1..R-10 AND the launcher `#2852` regression
> R-29..R-32.

## R-11 — Companion avatar stays exactly 80×100 with its idle animation unchanged

> **Round 1 (spec/2852 @ 1677eca8) — PASS.** `.fredo-companion-avatar` `offsetWidth=80`/`offsetHeight=100`; 58-rect set byte-identical to the shared source (and to the launcher sm render); `animationName="fredo-idle-bob, fredo-idle-glow"` 2.4s ease-in-out infinite. The only companion diff is the planned `@keyframes` relocation in `companion.css` (selector + reduced-motion rule retained → computed animation byte-equivalent).

- [ ] R-11: Measure the companion `.fredo-companion-avatar` (`offsetWidth`/`offsetHeight`, G-040) and read its computed idle `animation-name`/`animation-duration`; read its full `<rect>` set and diff against the launcher sm avatar + `expandFredoRects(FREDO_AVATAR_SOURCE_RECTS)`.
  **Expected:** companion `offsetWidth = 80` / `offsetHeight = 100` (unchanged, aspect 1014:1264); its 58-rect set byte-identical to the shared source (and now also to the launcher sm render); idle `animation-name` still includes `fredo-idle-bob` + `fredo-idle-glow` at `2.4s ease-in-out infinite`; the talk/teleport states, gestures, clamp/bubble-anchor `AVATAR_SM` math are UNCHANGED. git diff for #2852 shows NO companion file change.
  - **Edge:** the shared-size module must still resolve `AVATAR_SM = {80,100}` (no drift); a launcher change must not alternatively alter the companion's size, animation, or rect set; reduced-motion companion behavior (F-19) still holds. Reference #2850 R-5 + companion F-4/F-19 + launcher R-32.

---

## #2853 extension — presence lifecycle must not change existing companion behavior

> Issue #2853 adds a presence lifecycle (single Fredo + idle auto-return + a configurable timeout).
> These invariants MUST hold after the slice — any FAIL is a regression. Run alongside R-1..R-11.

## R-12 — Companion visibility toggle semantics unchanged (`Fredo_companion_visible` still honored)

- [x] R-12: Toggle "Show Fredo Companion" OFF → the companion hides and the desktop mascot is shown; toggle ON → the companion returns (and the desktop mascot yields). Inspect the persisted key `Fredo_companion_visible`.
  **Expected:** the existing toggle behavior is unchanged; the persisted key is honored on boot and updated on toggle; the Companion settings section still mounts without an orphan/crash, now with the added idle-timeout control.
  - **Edge:** toggle with the companion mid-countdown; toggle off after an auto-return leaves the user preference intact (R-15); settings modal opens cleanly with the added control. Reference #2850 R-9 + functional F-12/F-26.

## R-13 — Teleport / joke / game / speech-bubble / avatar behaviors untouched

- [x] R-13: Exercise teleport choreography + timing, single-click joke, double-click TicTacToe, and the speech-bubble side-choosing/anchoring; inspect avatar geometry/animation.
  **Expected:** R-1..R-5 + F-6..F-11 still hold — the presence slice does not alter teleport timing/choreography, the click discriminator, the game, bubble geometry/anchoring, the avatar's 80×100 geometry, or its idle animation.
  - **Edge:** a teleport or joke at the idle boundary; the interaction must reset (not corrupt) the timer (F-24). Reference R-1..R-5.

## R-14 — Launcher shell layout not disturbed

- [x] R-14: Open the launcher and inspect its layout (app grid, command bar, keyboard hints, clock/LED chrome, open/close lifecycle) with the companion both ON and OFF.
  **Expected:** the launcher shell is visually/behaviorally unchanged and its layout is not shifted by hiding the desktop mascot slot; only the mascot's presence is gated by the companion's visibility state. Cross-reference `.opencode/tests/launcher/` regression R-16/R-20/R-22..R-25 and `.opencode/tests/desktop-shell/`.
  - **Edge:** no reserved-blank gap / no collapsed layout where the mascot was; launcher open/close still works with the companion visible.

## R-15 — Auto-return does NOT overwrite the persisted visibility preference

- [x] R-15: With the companion visible, trigger auto-return; read the persisted `Fredo_companion_visible` before and after; relaunch.
  **Expected:** the value is UNCHANGED by auto-return (still the user's `true`); on relaunch the companion returns per the preference (auto-return was transient). The idle timeout must not be reset to default by the auto-return path.
  - **Edge:** repeated auto-return cycles leave the preference and the idle-timeout value intact; a manual toggle after auto-return re-shows the companion. Reference functional F-26.

## R-16 — Cross-window presence unchanged (terminal companion)

- [x] R-16: Open the Run CLI terminal (`run-cli-terminal`) and exercise the companion there + a cross-window teleport.
  **Expected:** per-window single-Fredo holds (companion mounted-but-hidden until arrival, visible in exactly one window); cross-window teleport choreography unchanged (R-4/F-10); the idle timer behaves per-window without ghosting or double-mount.
  - **Edge:** auto-return while a teleport is in transit; terminal window closed mid-countdown → no crash, main recovers. Environment note: if the terminal cannot launch, mark BLOCKED-environment.

## R-17 — No console errors / no re-render loop introduced by the timer

- [x] R-17: After each presence leg, read the console in both windows; watch for re-render churn during a countdown.
  **Expected:** R-8 still holds — no `Error:`/`Uncaught`/`Maximum update depth exceeded`; the new idle timer does not introduce a `useEffect` re-render loop. Reference functional F-28.

## R-18 — Default companion position unchanged (non-goal)

- [x] R-18: Trigger auto-return, then re-show the companion (toggle or interaction) and measure its home position; compare with the pre-slice default placement.
  **Expected:** auto-return does not move or mutate the companion's default/home position (a non-goal of this slice); the desktop mascot returns to its own usual slot (F-21).
  - **Edge:** drag/move before an auto-return — the moved position is preserved or reset per existing behavior, not silently mutated by the presence lifecycle. Reference functional F-21.

### Round 2 (spec/2853 @ 4c9ba542) — regression results

- **R-12 PASS (live).** Toggle OFF ⇒ companion=0/mascot=1, persisted `Fredo_companion_visible`="false"; ON ⇒ companion=1/mascot=0, persisted "true"; settings modal mounts cleanly with the added idle-timeout control.
- **R-13 PASS (live+unit).** Single-click joke (talk + streaming cursor), double-click TicTacToe (250 ms discriminator, no stray joke), Ctrl+right-click teleport, bubble anchor at the real 80×100 dims — all unchanged; ST-6 suite (25/25) green.
- **R-14 PASS (live).** Launcher shell renders with the companion ON (mascot suppressed) and OFF (mascot at its usual slot); no collapsed/blank layout.
- **R-15 PASS (live).** After auto-return, persisted `Fredo_companion_visible` stayed "true" and `Fredo_companion_idle_timeout` stayed "20" — transient only.
- **R-16 PASS (live, canonical).** Cross-window teleport main→terminal: exactly one Fredo globally (terminal companion, main mascot suppressed); terminal host-owned 20 s timer returned it and the main mascot returned via the `companion-presence {idle-settle}` broadcast. Edge: a window (re)loaded after main auto-returned misses the broadcast (exploratory E-18).
- **R-17 PASS (live).** Console error-level reads empty in both windows; no `Maximum update depth exceeded`; no re-render loop from the new `isInUse` report effect.
- **R-18 PASS (live).** Auto-return did not move the companion's home position; after re-show the companion returned at its slot and the mascot at its own slot.

---

## #2854 extension — the new status vocabulary must not change existing behavior

> Issue #2854 extends the shared avatar status vocabulary. These invariants MUST hold after
> the slice — any FAIL is a regression. Run alongside R-1..R-18 + the #2852/#2853 rows.

## R-19 — Existing 4 states + teleport timing unchanged

- [ ] R-19: Drive idle/talk/teleport-out/teleport-in on the companion; probe the wrapper `data-state`, `#fredo-expression` overlay rect set, and computed `animationName`; timestamp a same-window teleport.
  **Expected:** the pre-#2854 fingerprints for idle/talk/teleport-out/teleport-in are unchanged (same overlay rect sets + same wrapper motion); teleport out ≈400 ms / in ≈400 ms + ~50 ms settle; `ANIM_DURATION` unchanged; the click discriminator (250 ms), the joke, and TicTacToe still work.
  - **Edge:** a new status must not hijack an existing state's overlay selector; teleport timing on the tested tip. Reference #2850 F-3/F-6/F-7/F-8 + R-2/R-4.

## R-20 — Frozen-geometry invariant holds

- [ ] R-20: Read the 58 base rects in every state (old + new) and diff against `expandFredoRects(FREDO_AVATAR_SOURCE_RECTS)`.
  **Expected:** the 58 base rects are byte-identical across ALL states; the shared geometry suite (`fredoAvatarGeometry.test.ts`) passes unmodified. Reference F-37 + #2850 R-10.

## R-21 — Joke / TicTacToe / speech-bubble behaviors untouched

- [ ] R-21: Exercise single-click joke, double-click TicTacToe (250 ms discriminator), and the speech-bubble side-choosing/anchoring; inspect the bubble geometry.
  **Expected:** R-1/R-2/R-3 still hold — the 240×120 bubble, the 208×268 game bubble, the `above > right > left > below` ranking, the streaming cursor, the vision move + legal-move fallback, and the status text. The new statuses change only the avatar expression/state, not the game or the bubble. Reference #2850 R-1..R-3/F-7/F-8/F-11.

## R-22 — Presence lifecycle (single Fredo + auto-return) unchanged

- [ ] R-22: Toggle the companion ON/OFF; with a short idle timeout let it auto-return; count rendered Fredos.
  **Expected:** #2853 R-12/R-15/F-21/F-22 still hold — exactly one Fredo at a time; the persisted visibility preference is honored; auto-return is transient. A new status must not keep the timer armed or block the auto-return. Reference #2853 R-12/R-15/F-21/F-22.

## R-23 — Token contract + build gates unchanged

- [ ] R-23: Static-grep the changed files for hardcoded colors; run `pnpm --filter @fredo/ui build` + `pnpm --filter @fredo/ui test:run`.
  **Expected:** ZERO hardcoded hex/rgb/hsla in the changed files; theme token → CSS var + `tint()` only; build exit 0 / zero TS errors; suite green. Reference F-40 + #2850 R-7/F-15/F-18.

### Round 1 (spec/2854 @ 0e52c599) — results

- **R-19 PASS (live).** idle/talk/teleport-out/teleport-in fingerprints unchanged (same overlay rect sets + wrapper motion); teleport out 0→460 ms, in 460→920 ms; `ANIM_DURATION` untouched; the 250 ms click discriminator, joke, and TicTacToe still work.
- **R-20 PASS (live).** 58 base rects byte-identical across ALL 8 states (`bytesEq=true`, `firstDiff=-1`); geometry suite green unmodified.
- **R-21 PASS (live).** single-click joke, double-click TicTacToe (250 ms discriminator, no stray joke), 208×268 game bubble, legal O moves, `Your turn (X)` status text — unchanged.
- **R-22 PASS (live).** Companion ON ⇒ one Fredo (`.fredo-companion-avatar`); OFF ⇒ mascot home; toggle + persisted `Fredo_companion_visible` intact.
- **R-23 PASS (static).** Only issue-refs matched the color grep in the 9 changed files (zero true hex/rgb/hsla); `pnpm --filter @fredo/ui build` exit 0; `pnpm --filter @fredo/ui test:run` 54/787 passed.
