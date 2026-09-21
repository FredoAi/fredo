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

---

## #2864 extension — chrome/theming slice must not change companion behavior

> Issue #2864 is a visual/theming slice. The companion behavior invariants below MUST hold.
> Run alongside R-1..R-23. Verification policy: live.

## R-24 — Visibility toggle + idle-timeout semantics unchanged

- [ ] R-24: Toggle "Show Fredo Companion" ON/OFF; set a distinct auto-return value via the
      `NumberInput` (blur / Enter / stepper) and read it back; restart and re-read.
  **Expected:** the toggle still shows/hides the companion and honors
      `Fredo_companion_visible`; the idle value still commits on blur/Enter/stepper (never per
      keystroke), clamps (default 60, range [5, 3600]), and persists. Reference #2850 R-9/#2853
      R-12/F-23/F-25/F-26.
  - **Edge:** cleared/non-numeric/out-of-range entry heals; theme change while editing must not
    corrupt the draft.

## R-25 — Not-ready gate + wizard still gate correctly

- [ ] R-25: On a not-ready backend, open Settings → Companion; run a prerequisite action via the
      wizard; on ready, confirm the panel swaps to the controls.
  **Expected:** while not ready the wizard is the ONLY content (no toggle/tip); when readiness
      flips ready the controls render automatically. Reference #2850 F-12/#2853 and
      `llama-setup` regression. No orphan section/crash.
  - **Edge:** checking (first probe) renders per-step `checking`; an action error renders the
    step's error state.

## R-26 — Token contract for the companion chrome files

- [ ] R-26: Static-grep the audited companion files (F-44 list) for hardcoded colors and
      `var(--x)NN`; confirm the setting-row/tip surfaces use the resolved derived token T1
      `--hover-bg` (a `color-mix` set once in the `ThemeProvider` base pass — NOT the
      `--card-hover-bg` alias).
  **Expected:** zero true color literals; `tint()`/`var()` only; `--hover-bg` resolves
      non-transparent in BOTH themes (T1, derived per-theme — a single `color-mix`, not two
      literal values). Reference #2850 R-7/F-15.
  - **Edge:** comment issue-refs are not literals.

### #2864 testing round 1 (spec/2864 @ f2c8923, product 5c0fb5b) — results

- **R-24 PASS (live).** Toggle shows/hides the companion and honors `Fredo_companion_visible`; the idle value commits on blur/Enter/stepper, clamps (default 60, [5,3600]), persists (`#companion-idle-timeout-seconds` committed 9999→3600).
- **R-25 PASS (live).** Managed `llama-server` stopped → gate renders the wizard ONLY (no toggle/tip); server relaunched → controls render automatically (`get_llama_server_status` running/healthy). No orphan/crash.
- **R-26 PASS (static).** Zero true color literals; no `var(--x)NN`; the setting-row/tip surfaces resolve `--hover-bg` non-transparent in BOTH themes (`color(srgb .8 .8 .8/.06)` dark / `color(srgb .047 .067 .090/.06)` light).

---

## #2865 extension — the wizard UX visual audit must not change behavior

> Issue #2865 is a VISUAL/UX audit of the not-ready wizard. Run alongside R-1..R-26. The prior
> "accepted residual R3" disposition (recorded in the #2864 rows/logs above) is SUPERSEDED for
> this spec — the residual is an explicit requirement — but no historical record is deleted.

- [ ] **R-27 (gate semantics unchanged):** `stop_llama_server` → the Companion section renders the
      wizard ONLY (no toggle/tip/auto-return); `launch_llama_server` → the controls render
      automatically in place, no reload. Reference R-25/F-56.
  - **Edge:** partial readiness never reads complete; the swap works with the modal open.

- [ ] **R-28 (configured Companion controls unchanged after the swap):** once ready, the visibility
      toggle honors `Fredo_companion_visible`, the idle-timeout control commits/clamps/persists,
      and the teleport tip is present/undimmed. Reference R-24/#2853 R-12.
  - **Edge:** a visual-only diff must not alter the control semantics or persistence keys.

- [ ] **R-29 (token contract + semantic-token bridge):** no hardcoded hex/rgba/hsla or `var(--x)NN`
      is introduced in the audited wizard files; the R3 root cause (`fg.muted`/`fg.subtle`/
      `fg.default`/`bg-hover`/`fg-onAccent`/`accent-solid` not resolving to Fredo vars) is
      resolved at the token layer — no literal fallback is introduced to mask it.
  - **Edge:** a direct `var(--text-secondary)` migration is acceptable; leaving `fg.muted` as stock
    Chakra is a FAIL (F-55).

- [ ] **R-30 (no test weakening / build gates):** no existing assertion weakened/disabled/deleted;
      a hook that must move is refreshed in the same scope and named (G-125);
      `pnpm --filter @fredo/ui build` exit 0; `pnpm --filter @fredo/ui test:run` green.
  - **Edge:** frozen hooks (`companion-setup-wizard`, `companion-step-*`, `data-state`,
    `data-server-state`) retained — a silently dropped hook is a FAIL.

---

## #2868 extension — the Companion settings section now hosts inside the Settings app window (G-136)

> Issue #2868 moves the Companion settings section out of the retired `ProfileSettingsModal` into
> the Settings `FredoFeatureClass` window. **G-136:** R-9's parenthetical "the settings modal
> (`ProfileSettingsModal` Companion nav item) still mounts `CompanionSettingsPanel`" is SUPERSEDED
> — the host is now the Settings feature window (launcher-grid entry). The Companion panel
> behavior/state vocabulary and the readiness gate are unchanged. Historical records above
> preserved. Live policy.

- [ ] **R-31 (gate semantics unchanged in the new host):** with the backend not ready, the Settings
      window → Companion renders the wizard ONLY (`[data-testid="companion-setup-wizard"]`,
      `companion-step-*`, `data-server-state`) — no toggle/tip/auto-return; on ready the controls
      swap in place with no reload. Reference R-25/R-27 + `.opencode/tests/settings/` F-35/F-36.
  - **Edge:** the first readiness probe in flight renders `checking` per-step; open/close the
    Settings window during the swap leaves a consistent state; no orphan/crash.

- [ ] **R-32 (Companion panel content contract survives the host swap):** the visibility toggle
      honors `Fredo_companion_visible`, the idle-timeout control commits/clamps/persists, and the
      Teleport tip is present/undimmed — reached via the launcher grid, not the gear. The frozen
      hooks are retained. Reference R-24/R-28/R-30.
  - **Edge:** a settings-section list with zero discovered sections must not break the Companion
    section; the modal-only Escape/backdrop behavior is gone (window close semantics).

### #2868 testing round 1 (spec/2868 @ 90da8de) — results

- **R-31 PASS (live + component test).** With the readiness probe in flight/not ready, Settings → Companion rendered the wizard ONLY (`companion-setup-wizard`, `companion-step-*`); on ready the controls (`companion-controls`) swapped in place with no reload. `SettingsSurface.companionGate.test.tsx` 3/3.
- **R-32 PASS (live).** Reached via the launcher grid (not the gear): the visibility toggle ("Show Fredo Companion"), the idle-timeout control (`valuenow=3600`), and the Teleport tip all render; window-close semantics replaced modal Escape/backdrop. Evidence: `.opencode/tmp/2868/tests-runs.md` / `## Tests Runs (round 1)`.

---

## #2870 extension — one-Fredo-at-home invariants (must-not-change)

> Issue #2870 gives Fredo a home/away location: enabling the companion keeps him AT the centre seat; away
> shows an empty-seat placeholder; every turn-on greets. **G-136 supersedes:** R-12's "companion ON ⇒
> mascot yields / OFF ⇒ mascot shown", R-14's "mascot presence gated by companion visibility", and
> R-16/R-22's "main mascot suppressed" wording all pin the REMOVED `!companionPresent` gate — they are
> superseded by the rows below (historical PASS records above are preserved, not deleted). R-24's control
> semantics remain in force. Run alongside R-1..R-32. Live policy.

## R-33 — Teleport choreography + joke/game/bubble/avatar behaviors unchanged after the entity extraction

- [ ] R-33: Exercise a same-window and a cross-window teleport (timing), single-click joke, double-click TicTacToe (250 ms discriminator), and the speech-bubble side-choosing/anchoring; probe the avatar's 80×100 geometry + the 58-rect set.
  **Expected:** the extraction of `CompanionEntity` does not alter R-1..R-5 / R-13 / R-19..R-21 — teleport out ≈400 ms / in ≈400 ms + ~50 ms settle, the `isTeleportingRef` guard, the joke/vision flows, the 240×120 bubble + 208×268 game bubble, the `above > right > left > below` ranking, the frozen 58 base rects, and the `AVATAR_SM` clamp/anchor math are byte/behaviour-identical. Reference F-59/F-60 + #2853 R-13 + #2854 R-19..R-21.
  - **Edge:** a status/teleport mid-joke; the seat and overlay both consume the same entity without double-firing the joke/game.

## R-34 — Persisted keys/ranges untouched (`Fredo_companion_visible`, `Fredo_companion_idle_timeout`)

- [ ] R-34: Toggle the companion ON/OFF and set a distinct idle value; read the persisted keys before/after and after a relaunch. Probe that `isAway` is NOT persisted.
  **Expected:** `Fredo_companion_visible` is honored on boot and updated only by the toggle; `Fredo_companion_idle_timeout` keeps its default 60 / range [5, 3600] and its commit/clamp/persist semantics; `isAway` is a transient context flag only — never written to localStorage/AppStore; no new persisted key is introduced. Reference #2853 R-12/R-15/R-24 + the SI mechanism decision (G-023).

## R-35 — Seat slot always present ⇒ launcher column height constant (no CLS)

- [ ] R-35: Measure the centred-column height + command-bar `getBoundingClientRect().y` in all three states — OFF, ON-home, ON-away — and after an auto-return settle, at default and 700×900 widths.
  **Expected:** the seat slot (80×100 + `mb="4"`) is rendered UNCONDITIONALLY; the column height and the command-bar `y` are constant (≤1 px) across OFF / ON-home / ON-away / post-auto-return; no new scrollbar/overflow/clip. Reference F-64 + #2852 R-29.

## R-36 — Token-native + console clean / no re-render loop after the location state

- [ ] R-36: Static-grep the changed files for hardcoded colors/`var(--x)NN`; read the console in every leg/window; inspect the new `isAway`/`markAway`/`SYNC_PRESENCE` code for effect/memo deps and listener registration.
  **Expected:** zero color literals in the changed files (EmptySeat/seat chrome token-native); no `Error:`/`Uncaught`/`Maximum update depth exceeded` in any leg/window; the new location state introduces no re-render loop (no dep on array `.length`/fresh objects); the cross-window listeners are registered once per window. Reference R-7/R-8/R-17 + #2850 F-15/F-19.

---

## #2871 extension — bar-chat source must not change the companion (G-136)

> Issue #2871 adds the launcher command bar as a second message source. R-1..R-36 remain in
> force (no companion resolution superseded). Live policy.

## R-37 — Joke / TicTacToe / teleport / bubble geometry unchanged; a send is an interaction

- [ ] R-37: With the companion ON, exercise single-click joke, double-click TicTacToe (250 ms
      discriminator), Ctrl+right-click teleport, and the speech-bubble side-choosing/anchoring;
      then send a bar message and re-check the idle timer.
  **Expected:** R-1/R-2/R-3/R-4/R-33 still hold — the 240×120 / 208×268 bubbles, the
      `above > right > left > below` ranking, the streaming cursor, the joke/vision flows, the
      teleport timing, and the frozen 58 base rects are unchanged. A bar send resets the idle
      timer as an interaction and never fires a stray joke.
  - **Edge:** bar send in flight then click the avatar; teleport mid-bar-stream; the 5 s idle
    deadline at/around a bar send.

## R-38 — #2870 presence / persisted keys unchanged; chat is active-only

- [ ] R-38: Toggle the companion ON/OFF and away; read `Fredo_companion_visible` +
      `Fredo_companion_idle_timeout`; confirm `isAway` is not persisted. With the companion OFF
      and away, send a bar message; then let an idle auto-return settle and send again.
  **Expected:** the #2870 home/away model + persisted keys are unchanged (R-34/R-35/R-36); the
      bar chat path exists when `isVisible && !isAway` — no `llm_chat`/bubble when OFF or away
      (the seat renders `EmptySeat`), and it remains ACTIVE at home after an idle auto-return
      (`isAutoHidden` does not gate the interactive seat).
  - **Edge:** away while hosted in `run-cli-terminal`; a stale away flag; auto-return then send.

### #2871 testing round 1 (spec/2871 @ e5fa7612) — results

- **R-37 PASS (live).** Single-click joke, double-click TicTacToe (`Your turn (X)`, 208×268 game
  bubble), Ctrl+right-click teleport (overlay `position:fixed` + seat placeholder 80×100), bubble
  240×120 `position:absolute` above the slot, frozen 58 base rects — all unchanged. A bar send
  streams the same `thinking`→`joking`→`happy` flow; no stray joke.
- **R-38 PASS (live).** ON/OFF toggled live (`Fredo_companion_visible` true→false→true); OFF and
  away → no `llmChat`/bubble, seat placeholder/mascot per #2870; after >60 s idle (auto-return) a
  bar send streamed a reply → chat remains ACTIVE at home (`isVisible && !isAway`).

### #2871 testing round 2 (spec/2871 @ bd168ee) — results

- **R-37 PASS (live).** Single-click → real joke streamed (`playful`→`idle`→`thinking`→`happy`;
  "Why did the programmer quit debugging? Because they couldn't find the bug in their *heart*"),
  and the joke did NOT announce in the live region (correct — only bar sends announce).
  Double-click → TicTacToe ("Your turn (X)", `.tictactoe` node). Seat slot WRAPPER 80×100 +
  `margin-bottom:16px`, `.fredo-companion-avatar` 80×100 `position:relative`, command-bar
  `getBoundingClientRect().y` = 485.765625, `scrollHeight == clientHeight` (no scrollbar). Bar send
  resets the idle timer; the persona split did NOT break the joke path (`FREDO_PERSONA` retained
  for `askForJoke`).
- **R-38 PASS (live).** Toggled OFF via the Settings Companion switch → `.fredo-companion-avatar`=0,
  decorative mascot=1 at the seat, bar `aria-label="Search or command"`, no chip, persisted
  `Fredo_companion_visible="false"`; a non-tile Enter took NO chat path (no new generation, no
  bubble). Away (MCP `companion-teleport` recipe c) → `[data-state="away"]` placeholder 80×100
  `aria-label="Fredo is away"`, bar inactive, Enter no chat. Home-after-auto-return behaviour
  unchanged from round 1. Persisted keys `Fredo_companion_visible`/`Fredo_companion_idle_timeout`
  intact; `isAway` not persisted.

---

## #2877 extension — voice settings are ADDITIVE to the Companion section (G-136)

> Added at Spec #2877 (local STT foundation). #2877 adds a "Voice input" group INSIDE
> `CompanionSettingsPanel` (enable toggle, model status + one-action setup, device select, autosend
> setting) and a non-gating `sttModel` step in the Companion setup wizard. R-1..R-38 above remain in
> force; this note records the additive surface so no prior resolution is silently contradicted and
> no historical PASS/FAIL record is deleted. **Verification policy: live.**
>
> - **R-31/R-32 (settings host)** stay in force: the Companion section renders in the Settings app
>   window; the not-ready gate still renders the wizard ONLY (no toggle/tip), with the optional
>   `sttModel` row additive; on ready the controls swap in place with no reload. The voice group is
>   part of the controls and must not disturb the gate.
> - **R-33..R-38 (overlay behavior + persisted keys)** must be UNCHANGED by the voice group — the
>   joke / TicTacToe / teleport / bubble / avatar behaviors and the `Fredo_companion_visible` /
>   `Fredo_companion_idle_timeout` semantics are untouched; `isAway` stays transient. The voice
>   group adds its own persisted keys (`Fredo_companion_voice_enabled` — default false; the device
>   id; the autosend value) and MUST NOT mutate the existing keys.
> - **R-9 successor:** the panel's ready-state content keeps its existing controls (visibility
>   toggle + teleport tip) with the voice group additive — the voice group must not remove or gate
>   them.
> - **Cross-ref:** `.opencode/tests/voice-input/` R-13/R-16 (overlay unchanged; voice settings under
>   Companion) and functional F-16..F-37; `.opencode/tests/llama-setup/` R-30 (counts stay
>   GGUF-only).

---

## #2882 extension — the Enter/hold-Space slice must not disturb the companion (G-136)

> Issue #2882 changes the launcher bar's trigger and Enter rule and retires the Ctrl+Space listening
> cascade. The companion overlay behavior, the persisted keys and the avatar are NON-GOALS.
> **G-136 SUPERSESSION (history preserved):** the Ctrl+Space `companion-away ⇒ companion-listen`
> route pinned by `voice-input` F-57 and `companion` F-75 is RETIRED — its PASS records stand as
> history and must NOT be re-run as PASS or FAIL. R-1..R-38 above remain in force; the #2877
> additive-voice note stands. Run alongside the `launcher` R-40..R-43 and `voice-input` R-18..R-20
> extensions. **Verification policy: live.**

## R-39 — Overlay behaviour + persisted keys untouched; the chord no longer reaches the companion

- [ ] R-39: Toggle the companion ON/OFF; exercise single-click joke, double-click TicTacToe
      (250 ms discriminator), Ctrl+right-click teleport, and the speech bubble; read
      `Fredo_companion_visible` / `Fredo_companion_idle_timeout` (and confirm `isAway` is NOT
      persisted). Separately, in the companion-AWAY state, press Ctrl+Space and subscribe to
      `stt:state`.
  **Expected:** R-33..R-38 still hold (teleport timing, bubble geometry/anchoring, ranking, persisted
      keys); the voice slice adds only its declared keys and mutates none of the existing ones; the
      away-state Ctrl+Space produces ZERO listening emissions and NO companion listening bubble/dot
      (the retired route) while the launcher bar shows + focuses.

## R-40 — Seat geometry / one-Fredo-at-home unchanged by the hold-Space affordance

- [ ] R-40: Measure the seat-slot WRAPPER `offsetWidth`/`offsetHeight` + the command-bar
      `getBoundingClientRect().y` with the companion OFF, ON-at-home, ON-away, and DURING a hold
      (a Space `down` with the bar focused); check `scrollHeight`/overflow at default and 700×900.
  **Expected:** the wrapper stays exactly 80×100 with `margin-bottom: 16px` and the column centre-x
      matches within ±1 px; the command-bar `y` is constant within ±1 px in every state INCLUDING
      during a hold (a listening cue must not shift the layout); no new scrollbar/overflow/clip.
      Reference R-35 + `launcher` R-35 (the Chakra numeric-token pin).

## R-41 — Console clean / no re-render loop / no leaked listeners from the new trigger

- [ ] R-41: Read `tauri_read_logs(source="console")` after every leg (hold, release, cancel, rapid
      Space churn, companion toggle mid-hold); inspect the new trigger code for effect/memo deps on
      array `.length`/fresh refs and for listener registration across cycles.
  **Expected:** no `Error:`/`Uncaught`/`Maximum update depth exceeded` (the pre-existing
      `motion() is deprecated` WARN exempt); no per-keystroke state churn that re-renders the
      companion; the `stt:state`/`llm-*` listeners register once per lifecycle and are removed —
      no accumulation. Reference R-17/R-36 + `launcher` R-43.

---

## #2883 extension — the reply-surface change must not disturb the game bubble or companion behavior (G-136)

> Issue #2883 makes the TEXT reply surface grow/scroll and protects it while the reader is on it.
> The game bubble, the avatar, the click/teleport gestures, the presence lifecycle and the persisted
> keys are NON-GOALS. **G-136 SUPERSESSION (history preserved):** **R-1's** "the speech bubble keeps
> its fixed dimensions — **240×120 text bubble**, 208×268 game bubble" is **SUPERSEDED for the TEXT
> reply surface only** — the text reply now grows and scrolls (functional F-79/F-82). The **208×268
> GAME bubble**, the `above > right > left > below` ranking, the on-screen margin clamp, the
> framer-motion spring and the streaming cursor remain IN FORCE. **F-61's** welcome-bubble ~4 s
> auto-hide remains in force when nothing is hovering/focused. R-1..R-41 otherwise remain in force.
> Run alongside the `launcher` R-44..R-46 extensions. **Verification policy: live.**

## R-42 — Game bubble + anchoring contract unchanged; the frozen 208×268 stays fixed

- [ ] R-42: Double-click the avatar (250 ms discriminator) → the TicTacToe bubble; measure
      `[data-testid="fredo-game-bubble"]`'s rect and read the status text; separately drive the text
      reply to each screen edge and read the `chooseSide` ranking + the margin clamp on the FIXED
      away-overlay path.
  **Expected:** the TicTacToe game card is still exactly **208×268** (unchanged, fixed, a DIFFERENT
      surface) and playable; the away-overlay path's side-choosing ranking
      `above > right > left > below`, the on-screen margin clamp, the spring
      (`stiffness 380 / damping 30`) and the 2×14 px `Fredo-cursor-blink` streaming cursor are
      unchanged. **Only the TEXT reply's grown tier (`[data-testid="fredo-reply-surface"]`,
      `data-reply-tier="grown"`) and its `pointerEvents` are new** — the seat candidate set is the
      bound subset `above > right > left` (`below` stays exclusive to the overlay). The
      growing/scrolling text surface must NOT alter the GAME card or the ranking/clamp math.
      Reference R-1 (text half superseded), R-2/R-3/R-21/R-33.

## R-43 — Joke / click discriminator / teleport / presence / persisted keys unchanged

- [ ] R-43: Single-click joke; double-click TicTacToe; Ctrl+right-click teleport (same window and
      cross-window with `run-cli-terminal`); toggle the companion ON/OFF; set the idle timeout to
      5 s and let it auto-return; read `Fredo_companion_visible` / `Fredo_companion_idle_timeout`
      and confirm `isAway` is not persisted.
  **Expected:** R-33..R-41 still hold — the joke/vision flows, the 250 ms discriminator, the teleport
      timing (~400 ms out / ~400 ms in + ~50 ms settle), one-Fredo-at-home, the seat wrapper 80×100 +
      `mb="4"`, and the persisted keys/ranges are byte/behaviour-identical. The reply-surface change
      must not perturb the presence lifecycle or the idle timer. Reference R-33..R-41 + #2870 R-35/R-36.

## R-44 — Auto-dismiss / welcome-bubble timing still fires when nothing hovers or holds focus

- [ ] R-44: Display a reply with NO pointer over it and NO keyboard focus on it; sample presence
      across the dismiss period. Separately toggle the companion ON (the welcome bubble) with nothing
      hovering.
  **Expected:** the reply still auto-dismisses on its normal timer when unprotected, and the welcome
      bubble still auto-hides at ~4 s (`showMessage(WELCOME_TEXT, 4000)` ±500 ms, same cleared timer).
      The protection (F-83/F-84/F-87) is ADDITIVE and must not leave a reply permanently pinned.
      Reference F-61 + R-15/R-22.

## R-45 — Token-native / console clean / no re-render loop / listeners once after the reply change

- [ ] R-45: Static-grep the changed reply/companion files for `#[0-9a-fA-F]{3,8}` / `rgba(` / `rgb(` /
      `hsla(` / `var(--x)NN`; read the console after every reply leg (incl. repeated streams, scroll
      churn and a theme switch mid-stream); inspect the new size/scroll/protection code for
      effect/memo deps on array `.length`/fresh refs; count listener registrations across cycles.
  **Expected:** ZERO hardcoded colour literals (comment issue-refs exempt), NO `var(--x)NN`
      alpha-append (#2770); the reply chrome re-tints token-native in both themes/accent; no
      `Error:`/`Uncaught`/`Maximum update depth exceeded`; no re-render loop (AGENTS.md #523); the
      `llm-token`/`llm-done`/`llm-error` listeners register per generation and unlisten on settle —
      no accumulation. Reference R-7/R-8/R-17/R-36/R-41 + `launcher` R-46.

### #2883 testing round 1 — result

- [ ] _(pending — the Tester records the round verdict + per-row evidence here; do not pre-fill)_

---

## #2886 extension — the never-cover placement must not disturb the #2883 reply contracts (G-136)

> Issue #2886 re-anchors WHERE the surface sits; #2883's size / growth / scroll / `Newest` / hover
> protection are NON-GOALS. R-1..R-45 remain in force; the #2877/#2882 notes stand. Run alongside
> `.opencode/tests/launcher/` R-47..R-49 + `.opencode/tests/desktop-shell/` R-14..R-15.
> **Verification policy: live.**

## R-46 — #2883 growth / scroll / `Newest` / hover-protection unchanged

- [ ] R-46: Re-run the #2883 contracts with the new placement active: a long reply grows (≥3
      distinct samples while still arriving; `data-reply-tier="grown"`), scrolls internally
      (`[data-testid="fredo-reply-scroll"]` `scrollHeight > clientHeight`, tail reachable), the
      labelled `Newest` button returns to the newest content, pointer-over suspends an
      already-started countdown with a FRESH `REPLY_LEAVE_GRACE_MS = 2000 ms` after the leave, and a
      short reply stays `data-reply-tier="base"` at 240×120.
  **Expected:** all of the above hold UNCHANGED — the placement change must not alter the tier math,
      the scroller range, the reading-position/`following` semantics, the protection, or the leave
      grace. Reference F-79..F-90 + launcher F-70..F-78.

## R-47 — #2882 hold-to-dictate + Enter rule unchanged

- [ ] R-47: With the placement change live: hold Space on the focused empty bar (a HELD `down` →
      wait → `up` with a recorded duration) and check exactly one dispatch + ZERO listening
      emissions; type `set` + Enter → the Settings app opens with 0 generations; type an unmatched
      phrase + Enter (companion ACTIVE) → 1 generation, 0 windows.
  **Expected:** #2882's contract (R-39..R-41 / launcher R-42..R-44) is unchanged; the placement
      change touches only WHERE the surface sits. Reference F-76..F-78 + launcher F-69.

## R-48 — No layout shift / CLS introduced by the placement change

- [ ] R-48: Measure the command-bar `getBoundingClientRect().y`, the seat-slot WRAPPER
      `offsetWidth`/`offsetHeight`/`margin-bottom`, and `scrollHeight` vs `clientHeight` with a
      reply shown vs. not, at the default size AND the shipped minimum 900×600; include a resize
      and a re-anchor.
  **Expected:** `|Δy| ≤ 1 px` and the wrapper exactly 80×100 + 16 px in every state; no new
      scrollbar/overflow/clip; the surface does NOT participate in the launcher column's layout
      (a re-anchor must not move the seat or the bar). Reference R-35 + #2870 R-35 + launcher R-45.

## R-49 — Game card 208×268, on-screen containment, token-native, console clean

- [ ] R-49: Double-click → `[data-testid="fredo-game-bubble"]` is still exactly 208×268 and
      playable; the reply stays entirely inside the viewport at every edge/size; grep the changed
      files for `#[0-9a-fA-F]{3,8}` / `rgba(` / `rgb(` / `hsla(` / `var(--x)NN`; read the console
      after every leg; re-theme light ↔ dark mid-surface.
  **Expected:** the game card is unchanged (R-42); containment holds (`left ≥ 0 && top ≥ 0 &&
      right ≤ innerWidth && bottom ≤ innerHeight`); ZERO colour literals / no alpha-append; no
      `Error:`/`Uncaught`/`Maximum update depth exceeded`; the surface re-tints token-native with no
      stale colour. Reference R-42/R-45 + F-97.

### #2886 testing round 1 — result

> Served checkout: repo root `spec/2886 @ 0ac6b38a` (G-052).

- [x] **R-46 — PASS.** The long reply grew across distinct heights (120 → 133 → 152 → 171 → 209 →
      226 px) with `data-reply-tier="grown"` and scrolled internally (`fredo-reply-scroll`
      `scrollHeight 598 > clientHeight 195`); a short reply stayed `data-reply-tier="base"` at
      240×120; a single-click joke streamed through the same surface node. The placement change did
      not alter the tier math or the scroller range.
- [x] **R-48 — PASS.** Bar `y = 446` with a reply shown vs. cleared; seat wrapper 80×100 + 16 px
      `margin-bottom` in both states; the surface stays absolutely positioned and out of the launcher
      column's layout (a re-anchor did not move the seat or the bar).
- [ ] **R-49 — PARTIAL / UNVERIFIED.** Viewport containment held (`left ≥ 0 && top ≥ 0 && right ≤
      innerWidth && bottom ≤ innerHeight`) in every leg, console clean, no colour literals. The game
      card 208×268 clause was **not re-measured this round** (`[data-testid="fredo-game-bubble"]` did
      not remain mounted long enough to measure with the driver), and the double-click discriminator
      could not be isolated from the single-click joke in the webview driver. Named blocker: driver
      could not hold the TicTacToe bubble open for measurement.
- [ ] **R-47 — UNVERIFIED.** Hold-to-dictate (held Space `down` → wait → `up`) could not be driven —
      the webview driver's keyboard events do not produce a held-key duration, and no alternative
      sanctioned path exists this round. Named blocker, no product verdict.

---

## #2893 extension — the open-app skill must not disturb the companion (G-136)

> Issue #2893 adds a companion skill that opens apps. The companion's presence lifecycle, persisted
> keys, reply surface and gesture behaviors are NON-GOALS. R-1..R-49 remain in force. Run alongside
> `launcher` R-54..R-56 and `fredo-cli` R-1..R-3. **Verification policy: live.**

## R-50 — Presence / visibility toggle / persisted keys unchanged

- [ ] R-50: Toggle the companion ON/OFF; let a short idle auto-return fire; read
      `Fredo_companion_visible` + `Fredo_companion_idle_timeout`; confirm `isAway` is not persisted;
      change the idle value and re-read.
  **Expected:** the #2853/#2870/#2887 contracts are unchanged (R-12/R-15/R-24/R-34/R-38) — the toggle
      still shows/hides; auto-return remains transient; the persisted keys/ranges are untouched; an
      open request is an interaction that resets the idle timer and never mutates the persisted
      preference.
  - **Edge:** an open request at the idle deadline; OFF/away → the open request must not run the skill.

## R-51 — Joke / TicTacToe / teleport / reply-surface contracts unchanged

- [ ] R-51: Single-click joke; double-click TicTacToe (250 ms discriminator); Ctrl+right-click
      teleport; drive the #2883/#2886 reply surface (growth/scroll/never-cover).
  **Expected:** R-33..R-49 hold — the 240×120 base / grown+scroll reply, the 208×268 game card, the
      `above > right > left` placement, the streaming cursor, and the teleport timing are unchanged by
      the skill-registry addition; an open request does not fire a stray joke.
  - **Edge:** an open request mid-joke/mid-stream; a theme switch mid-open; the game bubble open.

## R-52 — Console clean / token-native / no re-render loop after the skill slice

- [ ] R-52: Read `tauri_read_logs(source="console")` after every leg; static-grep the changed
      companion/skill files for colour literals + `var(--x)NN`; inspect the new registry/skill code
      for effect/memo deps and listener registration across cycles.
  **Expected:** no `Error:`/`Uncaught`/`Maximum update depth exceeded`; ZERO colour literals / no
      alpha-append; no re-render loop (#523); listeners register once per lifecycle and are removed.
      Reference R-45/R-49.

### #2893 testing round 2 (spec/2893 @ 223279d3) — results

- **R-50 PASS.** Presence/visibility/idle contracts held across the round: the companion stayed
  present, an open request did not mutate the persisted keys (`Fredo_companion_visible`,
  `Fredo_companion_idle_timeout` unchanged in `localStorage`), and the companion returned to `idle`
  after every outcome.
- **R-51 PASS.** `hi` / `tell me a joke` streamed into the reply surface and settled normally
  (240×120 reply bubble; `happy` beat on content); no stray joke fired on an open request; the
  reply-region/`data-testid` contracts were unchanged.
- **R-52 PASS (with one disclosed tester artifact).** No `Error:`/`Uncaught`/`Maximum update depth
  exceeded` in a clean leg driven with **no tester instrumentation** (after a page reload:
  generation → tokens → `llm-done`, zero error entries). The `Uncaught TypeError … reading 'slice'`
  bursts seen earlier in the round were traced to the round's OWN MutationObserver scripts
  (`String.slice()` on a `null` reply text at bubble-clear) and vanished on reload — NOT a product
  defect. No re-render loop; no colour literals introduced by the #2893 diff.

### #2893 testing round 3 (spec/2893 @ cf25127c) — results

- **R-50 PASS (re-confirmed).** Presence/visibility/idle contracts held across the round: the
  companion stayed at the seat, the toggle semantics and `Fredo_companion_visible`/`_idle_timeout`
  were untouched, and every open request was an interaction that left the persisted preference intact.
- **R-51 PASS (re-confirmed).** Non-app-open messages streamed into the reply surface and settled
  normally; the reply surface (base tier + live region) was unchanged; no stray joke on an open
  request. No node/session or graph-output change from the `rowDerivation.ts` cost-only fix —
  Mission Monitor rendered the same 2 sessions / 4 react-flow nodes / 3 edges as round 2.
- **R-52 PASS (no product errors).** `tauri_read_logs(source="console", level="error")` was **empty**
  after the sweep and after a fresh restart. The round's samplers use a plain guarded `setInterval`
  (no MutationObserver), so the round-2 `reading 'slice'` tester artifact did NOT reproduce. No colour
  literals or `var(--x)NN` introduced by the #2893 diff; no re-render loop.

---

## #2892 extension — the reply-in-flight / dispatch slice must not disturb the companion (G-136)

> Issue #2892 splits `replyInFlight` from `isInUse`, makes the bar always editable, and adds
> queue/interrupt dispatch + two persisted settings. The companion overlay behavior, presence
> lifecycle, gesture set and the EXISTING persisted keys are NON-GOALS. **G-136 supersession (history
> preserved):** companion **F-72**'s "2nd Enter while streaming is ignored" clause is SUPERSEDED for
> the bar send (now accepted + queued). **F-70/F-83/F-84** remain in force (the grace default is
> unchanged). R-1..R-52 above otherwise remain in force. Run alongside `launcher` R-57..R-61 and
> `settings` R-17..R-20. **Verification policy: live.**

## R-53 — `isInUse` / presence / idle auto-return unchanged by the `replyInFlight` split

- [ ] R-53: toggle the companion ON/OFF and away; let a short idle auto-return fire; read
      `Fredo_companion_visible` + `Fredo_companion_idle_timeout`; hover a completed reply and wait
      past the timeout.
  **Expected:** the `isInUse` predicate is byte-identical (`isStreaming || replyProtected ||
      showTicTacToe || animState==='talk'`); auto-return stays transient; the persisted keys/ranges
      are untouched; a held reply still suppresses the auto-return (F-108).
  - **Edge:** hover at the deadline; away/teleport; OFF while a reply is displayed.

## R-54 — Shipped hold rules (F-83/F-84) unchanged at the default grace

- [ ] R-54: with the grace left at default, re-run hover-protection + leave-grace: a due clear is
      suspended while protected, and the reply dismisses only after the pointer leaves + a fresh
      full `REPLY_LEAVE_GRACE_MS = 2000` ms.
  **Expected:** identical to the shipped #2883 behavior; the configurable grace defaults to the same
      2000 ms (no silent behavior change).
  - **Edge:** focus-only protection; re-entry during the grace.

## R-55 — Joke / TicTacToe / teleport / bubble / avatar behaviors untouched

- [ ] R-55: single-click joke; double-click TicTacToe (250 ms discriminator); Ctrl+right-click
      teleport (same-window + cross-window); drive the reply surface (growth/scroll/never-cover).
  **Expected:** R-33..R-49 still hold — the 240×120 base / grown+scroll reply, the 208×268 game card,
      the `above > right > left` placement, the streaming cursor, teleport timing, and the frozen 58
      rects are unchanged.
  - **Edge:** a send during a joke/game; teleport mid-queue; theme switch mid-stream.

## R-56 — Existing persisted keys are not mutated by the two new keys

- [ ] R-56: read `Fredo_companion_visible`, `Fredo_companion_idle_timeout`, and the
      `Fredo_companion_voice_*` keys before/after changing the two new settings and after a restart.
  **Expected:** the new keys (`Fredo_companion_send_during_reply`, `Fredo_companion_reply_leave_grace_ms`)
      are ADDITIVE; the pre-existing keys keep their values/defaults/ranges; `isAway` stays transient.
  - **Edge:** legacy/malformed values on the existing keys; a fresh profile.

## R-57 — Token-native / console clean / no re-render loop / build gates

- [ ] R-57: static-grep the changed companion files for colour literals + `var(--x)NN`; read the
      console after every leg; inspect the new status/queue code for effect/memo deps and listener
      registration across cycles; run `pnpm --filter @fredo/ui build` + `test:run`.
  **Expected:** ZERO colour literals / no alpha-append; no `Error:`/`Uncaught`/`Maximum update depth
      exceeded`; no re-render loop (#523); listeners register once and are removed; build exit 0;
      suite green without weakening any assertion (refreshed ones owned per G-125).
  - **Edge:** the F-72 clause refresh is an intentional in-scope update, not a deletion.

### #2892 testing round 1 — result

- [ ] _(pending — the Tester records the round verdict + per-row evidence here; do not pre-fill)_

---

## #2917 extension — the solid interior + richer vocabulary must NOT change existing behavior

> Issue #2917 adds an additive interior fill layer and audits/extends the status vocabulary. These
> invariants MUST hold after the slice — any FAIL is a regression. Run alongside R-1..R-57 and the
> companion F-116..F-125. **Verification policy: live.** G-136 note: the fill layer is ADDITIVE, so the
> frozen-geometry rows stay in force unchanged (only the 58 base rects are pinned, not the total node
> count).

## R-58 — Existing state fingerprints + consumer timing unchanged

- [ ] R-58: Drive `idle`/`talk`/`teleport-out`/`teleport-in`; probe the wrapper `data-state`,
      `#fredo-expression` overlay rect set, computed `animationName`; timestamp a same-window teleport.
  **Expected:** the pre-#2917 fingerprints for the four states are unchanged (same overlay rect sets +
      same wrapper motion); teleport out ≈400 ms / in ≈400 ms + ~50 ms settle; `ANIM_DURATION`
      unchanged; the 250 ms click discriminator, the joke, and TicTacToe still work. The fill layer
      does not hijack an existing state's overlay selector or rect set. Reference R-19/R-33 + F-118.
  - **Edge:** a new status must not shadow an existing `#fredo-expression[data-state=…]` selector; the
    fill must not be inserted between the base rects and the overlay in paint order.

## R-59 — Frozen 58-rect geometry + additive fill

- [ ] R-59: Read the 58 base rects in every state (old + new) and diff against
      `expandFredoRects(FREDO_AVATAR_SOURCE_RECTS)`; confirm the fill is a separate additive layer.
  **Expected:** the 58 base rects are byte-identical across ALL states; the shared geometry suite
      (`fredoAvatarGeometry.test.ts`) passes UNMODIFIED; the fill is additive (a separate layer/group),
      never a geometry edit, and never removes a base rect. Reference R-20/#2850 R-10 + F-122.
  - **Edge:** a fill implemented by mutating `FREDO_AVATAR_SOURCE_RECTS` or the expansion math is a
    FAIL; the `fredoAvatarSizes.test.ts` suite passes unmodified.

## R-60 — Joke / TicTacToe / bubble / presence / persisted keys untouched

- [ ] R-60: Single-click joke; double-click TicTacToe (250 ms discriminator); Ctrl+right-click teleport
      (same + cross-window); toggle the companion ON/OFF; let a short idle auto-return fire; drive the
      reply surface; read `Fredo_companion_visible` / `Fredo_companion_idle_timeout` and confirm `isAway`
      is not persisted.
  **Expected:** R-1..R-5, R-13, R-21, R-33..R-49, R-53..R-57 still hold — the 240×120/grown reply,
      the 208×268 game card, the `above > right > left` placement, the streaming cursor, the
      joke/vision flows, the teleport timing, one-Fredo-at-home, the seat wrapper 80×100 + 16 px, and
      the persisted keys/ranges are byte/behaviour-identical. The vocabulary change adds no new
      persisted key and mutates none.
  - **Edge:** a status driven mid-joke/mid-stream; a teleport mid-status; an auto-return at the idle
    deadline.

## R-61 — Reduced-motion behavior preserved (no opacity:0, no strobe)

- [ ] R-61: Inspect + assert the reduced-motion rules for the fill and every state; run the static-CSS
      and product-unit pins (the live media-query flip is a named G-053 blocker). Confirm the launcher
      idle mascot's reduced-motion rule still resolves to a static, fully-visible figure.
  **Expected:** under `prefers-reduced-motion: reduce` motion is suppressed while the distinguishing
      frame stays legible — never `opacity:0`, never a strobe (WCAG 2.3.1); the pre-existing idle
      bob/glow suppression and teleport crossfade are unchanged; the figure stays 80×100 and fully
      opaque. Reference R-19/#2850 F-19 + F-122.
  - **Edge:** the fill must not introduce a new animated element that bypasses the reduced-motion
    block; a `!important`-free rule that loses specificity to the fill is a FAIL.

## R-62 — Token-native / console clean / no re-render loop / build gates

- [ ] R-62: Static-grep the changed avatar + companion files for `#[0-9a-fA-F]{3,8}` / `rgba(` / `rgb(` /
      `hsla(` / `var(--x)NN`; read the console after every leg; inspect the fill/state code for
      effect/memo deps on array `.length`/fresh refs; run `pnpm --filter @fredo/ui build` +
      `pnpm --filter @fredo/ui test:run`.
  **Expected:** ZERO colour literals / no alpha-append; no `Error:`/`Uncaught`/`Maximum update depth
      exceeded`; no re-render loop (#523); build exit 0; suite green without weakening any assertion
      (refreshed ones owned per G-125). Reference R-23/R-45/R-57 + F-124.
  - **Edge:** the fill layer must not add a per-frame computation or a mount-time state write; the
    pre-existing `motion() is deprecated` WARN is exempt.

### #2917 testing round 1 — result

- [ ] _(pending — the Tester records the round verdict + per-row evidence here; do not pre-fill)_

---

## #2918 extension — the structured-reply slice must not disturb the companion (G-136)

> Issue #2918 constrains the companion reply through `response_format` and adds a model-declared
> status input. The reply SURFACE, the skill/tool path, the gesture set, the presence lifecycle and
> the persisted keys are NON-GOALS. R-1..R-62 remain in force; the #2917 rows (R-58..R-62) and the
> frozen-geometry pins stay in force. Run alongside `llama-setup` (the probe) and `fredo-cli`.
> **Verification policy: live.** Sanctioned levers = LV1 (real managed `llama-server` via the MCP
> bridge), LV2 (synthetic `llm-token`/`llm-error`/`llm-done` injection), LV3 (the existing probe),
> LV4 (pure unit pins).

## R-63 — The skill/tool path and its deterministic reply copy are unchanged

- [ ] R-63: Drive a skill-aware generation (`open Mission Monitor` and `open NotARealApp`) from the
      companion while the structured reply path is enabled; capture the real `llm-skill-call` payload
      on its channel and read the settled reply copy + window counts; re-run the EXISTING
      `probe_companion_skills` and read its `tools` sub-report.
  **Expected:** the skill mechanism (the `tools` offer + `llm-skill-call`) still works and is NOT
      replaced or bypassed by the structured reply contract; the exact copy matrix is unchanged
      (`Opening Mission Monitor` / `I couldn't find "NotARealApp"`), zero spurious windows; the probe's
      `tools` sub-report is unaffected. The skill path never renders raw JSON (reference #2893
      F-99/F-100/F-105). A response_format change that disables or duplicates the tool offer is a FAIL.
  - **Edge:** a skill selection in the same turn as a structured reply object; the probe re-run with
    both sub-reports present; a skill turn while the reply object is malformed.

## R-64 — Pinned per-state `data-state` behavior + the 58-rect/overlay invariants unchanged

- [ ] R-64: Drive `idle`/`talk`/`teleport-out`/`teleport-in` + the #2917 states and read the wrapper
      `data-state`, the `#fredo-expression[data-state=…]` overlay rect set, and the 58 base rects
      (diff against `expandFredoRects(FREDO_AVATAR_SOURCE_RECTS)`); run the existing companion pins
      (`FredoCompanion.devMode.test.tsx`, `FredoCompanion.seatTeleport.test.tsx`,
      `FredoCompanion.crossWindow.test.tsx`, `skillSettle.test.tsx`, the resolver/geometry suites).
  **Expected:** the pre-#2918 per-state fingerprints are unchanged for every state that carries no
      model status; the 58 base rects stay byte-identical in every state; the existing pins pass
      UNMODIFIED (a pin that must change for the new status input is named per G-125, never silently
      weakened); teleport timing (`~400 ms` out / `~400 ms` + `~50 ms` settle) and `ANIM_DURATION`
      are unchanged.
  - **Edge:** a model status driven mid-status; a status-free turn after a status-bearing one; the
    resolver's `modelStatus` seam must not reorder the existing priority comparison.

## R-65 — Presence / persisted keys / gesture set / reply-surface contracts untouched

- [ ] R-65: Toggle the companion ON/OFF and away; single-click joke; double-click TicTacToe (250 ms
      discriminator); Ctrl+right-click teleport (same + cross-window); drive the #2883/#2886 reply
      surface (growth/scroll/never-cover); read `Fredo_companion_visible` / `Fredo_companion_idle_timeout`
      and confirm `isAway` is not persisted; let a short idle auto-return fire.
  **Expected:** R-33..R-49 / R-53..R-62 still hold — the 240×120 base / grown+scroll reply,
      the 208×268 game card, the `above > right > left` placement, the streaming cursor, the
      joke/vision flows, the teleport timing, one-Fredo-at-home, the seat wrapper 80×100 + 16 px, and
      the persisted keys/ranges are byte/behaviour-identical. The structured-reply slice adds NO
      persisted key and mutates none; the reply surface renders only the reply text (no markup).
  - **Edge:** a status driven mid-joke/mid-stream; a teleport mid-generation; an auto-return at the
    idle deadline; a malformed object mid-generation (F-128) must not perturb the presence lifecycle.

### #2918 testing round 1 (spec/2918 @ cb06fb24) — result

Verdict: **FAIL** — one blocking defect (R-63, the plan's Top Risk materialised). Q-1/Q-2/Q-3/Q-5/Q-6/Q-7/Q-8 pass; Q-4 cap-OFF render UNVERIFIED (G-053 named blocker).

- **R-63 FAIL (live).** Combining `tools` + `response_format: json_schema` on the pinned `llama-server` (Gemma-4 E2B IT QAT) **suppresses the native tool call**. `llm_chat_with_status(offerSkills:true)` with `open Mission Monitor` → `llm-token` "Opening Mission Monitor now." + `llm-status` `working` + `llm-done`, **NO `llm-skill-call`**, app not opened — 3/3 (incl. an explicit "Use the open_app tool…" prompt). Control: shipped `llm_chat_with_skills` with the same messages → `llm-skill-call {"skill":"open_app","arguments":{"app":"Mission Monitor"}}` + `Mission Monitor` opens — 2/2. Repro is in the `## Tests Runs (round 1)` comment on #2918. Route per plan: loop back to Phase 2 (Architect), do not ship a skills regression.
- **R-64 PASS (live).** Per-state fingerprints for status-free states unchanged: `idle` (58 base rects, no `#fredo-expression`), `thinking` (streaming), `joking` (first token), `teleport-out`/`teleport-in`, `working` (10.5 s under a skill-pending beat). The `modelStatus` seam is only fed at the settle hold; the resolver priority order and `ANIM_DURATION` are unchanged.
- **R-65 PASS (live + static).** Reply surface/chrome (`fredo-reply-surface`), the 240×120 base bubble, the 208×268 game card untouched; presence/persisted keys unchanged; no new persisted key (the status is ephemeral per-turn display state). `Fredo_companion_visible`/`Fredo_companion_idle_timeout` still read; teleport timing unchanged (`teleport-out` ~420 ms observed).

### #2918 testing round 2 (spec/2918 @ c94dd722) — result

Verdict: **FAIL** — the ST-6 fix CLEARS R-63; one new blocking defect (a teleport during the status hold leaves the model status stuck — F-134 in `functional.md`).

- **R-63 PASS (live, CLEARED).** `llm_chat_with_status({offerSkills:true})` with `open Mission Monitor` now emits `llm-skill-call {"skill":"open_app","arguments":{"app":"Mission Monitor"}}` (t=610 ms) then exactly one `llm-done`, **zero `llm-status`**, zero prose; Mission Monitor opens. Re-confirmed through the real typed dispatch path (`askActiveCompanion`) and the dictation-shaped audio body. The shipped `llm_chat_with_skills` control still emits the same selection 2/2. The tools bodies on the status path carry NO `response_format` (pin `the_tools_bodies_on_the_status_path_carry_no_response_format`, `status.rs:1088`).
- **R-64 PASS (live).** Status-free state fingerprints unchanged: `idle` (no `#fredo-expression`), `thinking` (pre-first-token), `joking` (first token), `teleport-out`/`teleport-in`, `working` (flow-owned at a skill selection). The resolver priority order and `ANIM_DURATION` are unchanged.
- **R-65 PASS (live + static).** Reply surface/chrome, bubble geometry, presence/persisted keys unchanged; teleport timing unchanged. **RESIDUAL (NEW, F-134):** a teleport mid-hold cancels the release timer without clearing `settledModelStatus`, so the avatar sticks in the reply status (and the bubble stays) after the teleport — a `no state sticks` regression introduced by the #2918 settle hold.

### #2918 testing round 3 (spec/2918 @ 15e1be50) — result

Verdict: **PASS** — the ST-8 entity fix releases the turn-scoped status on every hold-cancelling path; the F-134 residual is CLEARED.

- **R-63 PASS (live, re-confirmed).** Typed skill turn `askActiveCompanion('open Mission Monitor')` → `llm-skill-call {"skill":"open_app","arguments":{"app":"Mission Monitor"}}` (t=842 ms) + exactly one `llm-done`, **zero `llm-status`**, app opened (`[mission-monitor] auto-fit … 6 nodes`). The shipped `llm_chat_with_skills` control emits the same selection. The tools bodies on the status path carry NO `response_format` (pin `the_tools_bodies_on_the_status_path_carry_no_response_format`, `status.rs:1088`).
- **R-64 PASS (live).** Status-free state fingerprints unchanged: `idle` (no `#fredo-expression`), `thinking`, `joking`, `teleport-out`/`teleport-in`, `working`. The resolver priority order and `ANIM_DURATION` are unchanged.
- **R-65 PASS (live + static).** Reply surface/chrome, bubble geometry, presence/persisted keys unchanged; teleport timing unchanged. **F-134 residual CLEARED:** a teleport mid-hold now ends `happy → teleport-out → teleport-in → idle` and the reply bubble clears; post-settle samples at +5/+13/+20/+27 s are `idle`/`playful` only (no re-asserted model status). Round-3 commit `df42538` touches only `CompanionEntity.tsx` + its `__tests__` file (frontend, entity-local).
