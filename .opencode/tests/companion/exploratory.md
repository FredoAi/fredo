# Companion — Exploratory

> Unscripted edge/failure probes for the companion overlay feature domain (Spec #2850). The
> Tester adds findings here; a confirmed finding PROMOTES to `functional.md` as a new `F-` row
> (keep the origin note). A confirmed regression-free probe is recorded here (no promotion).

## Prompt lines

- [x] E-1: **State-expression edge at the sm scale.** Trigger talk, teleport-out, and teleport-in
      at the 80×100 sm render and screenshot each. Do the mouth overlay, closed-eye lines, streak,
      and sparkle highlights stay crisp (uniform crisp cells — no subpixel smear, no anti-alias
      fill-in of the hollow head / fragmentation gaps) at the small scale? Any illegible/merged
      detail is a finding (promotes to functional F-3).
  - **FINDING — regression-free (no promotion needed).** At the 80×100 sm scale, the talk mouth overlay `(440,692,134,14)`/`(440,675,134,38)`, the teleport-out closed-eye lines `(323,564,68,14)`/`(623,564,68,14)` + streak `(499,180,16,520)`, and the teleport-in sparkles `(340,452,16,16)`/`(658,452,16,16)` all render as discrete `<rect>`s inside `#fredo-expression` at exactly the frozen-geometry coordinates (no merge/mutation of the 58 base rects). The base rects stay 58/58/58/58 across idle/talk/teleport-out/teleport-in. The whole figure uses `shapeRendering="crispEdges"`; the expression overlays sit at integer viewBox coords so they stay crisp at the sm scale. No subpixel smear observed.
- [x] E-2: **Rapid click churn.** Rapidly single-click / double-click / triple-click the avatar
      (joke + TicTacToe + teleport interleaved). Does the 250 ms discriminator stay correct (no
      stray joke after a game-open double-click, no stuck talk/idle), and does the console stay
      clean? Any mis-discrimination / stuck state / console error is a finding.
  - **FINDING — regression-free.** Single → joke; double-click → `[companion] double-click → toggle TicTacToe` (NO joke); game-open click churn did not leak a stray joke; teleport while the game was open settled cleanly. Console stayed clean (no errors).
- [x] E-3: **Rapid teleport spam.** Ctrl+right-click several points in quick succession (and
      across both windows when the terminal window is open). Does the out → hidden → in sequence
      settle cleanly each time (no mid-teleport state corruption, no double-mount, no ghost avatar
      in the wrong window)? Any race/corruption is a finding (promotes to functional F-6/F-10).
  - **FINDING — regression-free.** Multiple same-window teleports (400,400→600,500→extreme bottom-right) each settled to the clamped point with the correct `out→in→idle` sequence; cross-window (main↔terminal) teleports each settled cleanly — no double-mount, no ghost avatar in the wrong window (only the destination window renders the companion).
- [x] E-4: **Near-edge teleport + resize mid-idle.** Teleport the companion to a point where the
      sm avatar's +20 px height is critical (bottom edge, right edge), then resize the window
      while it idles there. Does the avatar stay fully on-screen and un-clipped after the resize,
      and does the next bubble/teleport re-derive correctly? Any off-screen/clipped avatar or stale
      anchor is a finding (promotes to functional F-5/F-11).
  - **FINDING — regression-free (partial).** Bottom-right extreme teleport clamped so the FULL 80×100 avatar stayed on-screen (`bottom=1015 ≤ 1017`, right=1920 ≤ 1920) — the +20 px height is respected. Bubble side-choosing at the bottom (above) and top-right (left) edges is correct. The resize-mid-idle sub-case was not driven live (no driver window-resize after idling at an edge) — noted, not promoted.
- [x] E-6: **Re-theme while a bubble is open + streaming.** Switch themes/presets mid-stream and
      mid-bubble-hold. Does the avatar + bubble chrome + cursor all re-tint together with no stale
      color (border/tail/cursor all follow `--accent-primary`)? Any element stuck on a stale color
      is a finding (promotes to functional F-14).
  - **FINDING — regression-free.** Switching light-default → Matrix re-tinted the avatar (cyan→green) AND the open bubble border (`rgb(0,255,65)` green) — both follow the SAME `--accent-primary`, no stale color. The re-tint was token-native.
- [x] E-7: **Legacy-key chaos.** Seed `Fredo_companion_color`/`Fredo_companion_auto_walk` with
      mixed/bogus values across localStorage AND the AppStore simultaneously, then open the
      settings modal and relaunch. Any crash / resurrected color UI / console error is a finding
      (promotes to functional F-13).
  - **FINDING — regression-free.** Seeded `#22d3ee`/`true`/`#zzz` across localStorage + AppStore; the settings modal opened without crash; no resurrected color/auto-walk UI; relaunch booted clean with the theme accent. Keys inert.
- [x] E-9: **Cross-window teleport with an open game.** Open TicTacToe in main, then Ctrl+right-click
      in the terminal window. Does the game bubble close cleanly on out and does main return to
      idle-with-no-bubble after the teleport? Any orphaned bubble/game state in either window is a
      finding.
  - **FINDING — regression-free.** The game bubble closed cleanly on teleport-out; main returned to idle-with-no-bubble after the cross-window teleport; no orphaned game state in either window (the terminal arrival rendered idle, no game bubble).
- [ ] E-5: **Fractional-DPI render of the expression overlays.** At a fractional OS/webview zoom,
      do the state overlays (mouth, closed-eye lines, streak, sparkles) stay proportional with no
      seam-shifted cells / merged rects? Any distortion at non-integer scale is a finding.
- [ ] E-8: **Joke-stream error path.** Stop the model / drop the mmproj mid-session and single-click
      the avatar. Does the bubble show the loading/error path and recover to idle (no stuck talk,
      no cursor left blinking, no console error)? Any stuck state is a finding.
- [ ] E-10: **Reduced-motion teleport legibility.** Under `prefers-reduced-motion: reduce`, is the
      teleport still readable as a teleport (opacity crossfade out/in ~400 ms), and is the mouth
      still visible while talking? Any state that becomes indistinguishable under reduced motion is
      a finding.

## #2852 extension — launcher-adopts-sm cross-surface probes

> **Round 1 (spec/2852 @ 1677eca8) — E-11 UNVERIFIED-with-named-blocker (no confirmed finding).** The MCP driver cannot flip `prefers-reduced-motion` live (named blocker). Parity is structurally satisfied: both surfaces consume the SAME shared keyframes and each carries its own `@media (prefers-reduced-motion: reduce){ … animation:none }` rule; companion teleport crossfade rules unchanged in the diff. No asymmetry observable in the non-reduced state.

> Add findings here for issue #2852; a confirmed finding PROMOTES to `functional.md` as a new
> `F-` row (keep the origin note). A confirmed regression-free probe is recorded here (no
> promotion).

## E-11 — Reduced-motion parity across both surfaces

- [ ] E-11: Under `prefers-reduced-motion: reduce`, compare the launcher sm mascot and the companion sm avatar — is the idle bob/glow suppressed on BOTH (static), while both stay 80×100 and render their 58 rects? Is the companion's teleport opacity-crossfade unaffected by the launcher change? Any asymmetry (one surface still animating, a size drift) is a finding. Reference companion F-19/R-11 + launcher F-46.

## #2853 extension — presence-lifecycle edge probes

> Unscripted probes for issue #2853. A confirmed finding PROMOTES to `functional.md` as a new `F-`
> row (keep the origin note); a confirmed regression-free probe is recorded here.

- [ ] E-12: **Auto-return race with an interaction.** Fire an interaction (click/joke, double-click/game, teleport, or drag) at/near the exact idle deadline — does the interaction win (companion stays / returns) or does the auto-return fire and swallow the gesture? Any lost gesture, stuck state, duplicate Fredo, or console error is a finding (promotes to functional F-22/F-24).
- [ ] E-13: **Auto-return while the launcher is covered by a window.** With another window over the launcher, let the countdown expire — does the companion still hide and the desktop mascot return (behind the covering window is accepted per the PO)? Any failure to swap, two Fredos in the DOM, or console error is a finding (do **not** fail on Z-order).
- [ ] E-14: **Cleared / absurd timeout values.** Set the idle timeout to cleared/empty, `0`, a negative number, a non-numeric string, and a very large value (e.g. 99999) in turn — does the UI reject/fallback cleanly, or crash/wedge/freeze the countdown? Any unhandled error, infinite loop, or timer that never fires (or fires instantly forever) is a finding (promotes to functional F-25).
- [ ] E-15: **Cross-window auto-return.** With the terminal window open and the companion in the terminal, let the countdown expire there — does the terminal companion hide and the terminal desktop mascot return, without disturbing the main window's presence state? Any ghost across windows is a finding (promotes to functional F-22/R-16).
- [ ] E-16: **Manual toggle off during the countdown.** Toggle the companion off while a countdown is running, then back on — is the old timer cancelled cleanly (no late auto-return firing against the freshly-shown companion, no double timer)? Any stale/duplicate timer or premature hide is a finding (promotes to functional F-26/F-27).
- [ ] E-17: **Rapid toggle churn around the deadline.** Toggle the companion on/off several times straddling the idle deadline — does the timer re-arm exactly once per show, with no accumulating timers, no re-render loop (`Maximum update depth exceeded`), and exactly one Fredo at rest? Any timer leak / loop / zero-or-two Fredo is a finding (promotes to functional F-28).

## Round 2 (spec/2853 @ 4c9ba542) — exploratory findings

- [x] E-12: **Auto-return race with an interaction.** FINDING — regression-free. While a fresh window's 5 s auto-return was mid-`teleport-out`, a single-click joke recalled Fredo (`notifyInteraction` → `CANCEL_AUTO_RETURN`) and the stream played; the interaction won, no lost gesture, no stuck state. The subsequent stream/talk suppressed the re-armed timer and it fired 5.0 s after `talk→idle` (console + 250 ms recorder). Reference F-22/F-24.
- [x] E-14: **Cleared / absurd timeout values.** FINDING — regression-free. Seeded `Fredo_companion_idle_timeout`=`0` → after reload the control resolves to the 60 s default (stored `0` left inert, not re-written); no crash/wedge; full clamp matrix green in the ST-6 unit suite. Reference F-25.
- [x] E-15: **Cross-window auto-return.** FINDING — regression-free (canonical). Companion teleported main→terminal; terminal host-owned 20 s timer fired → terminal companion hidden and the main mascot returned via the `companion-presence {idle-settle}` broadcast; no ghost across windows. Reference F-22/R-16.
- [ ] E-18: **Window loaded AFTER an auto-return misses the `idle-settle` broadcast.** Repro: with the companion auto-hidden in `main` (mascot home), (re)load the `run-cli-terminal` window so its fresh React state has `isAutoHidden=false` (no `companion-presence` replay on mount), then Ctrl+right-click in the terminal. **Observed:** the terminal companion renders while `main`'s mascot is still home → one Fredo per window (the F-21 edge's documented per-window rule), two avatars globally. **Expected (to confirm with the Architect):** an explicit teleport is a recall interaction and should clear the transient auto-hidden presence globally (suppressing the main mascot), OR the mascot gate should also consider a companion hosted elsewhere. **Diagnosis:** the teleport path emits only `companion-teleport`, never `companion-presence`; the mascot gate is `isVisible && !isAutoHidden` (`LauncherShell.tsx:125`), so `main` never learns the companion left home. Pre-existing (the round-2 diff does not touch presence sync); NOT a round-2 regression. Promote to functional if confirmed in scope.

## #2854 extension — status-vocabulary edge probes

> Unscripted probes for issue #2854. A confirmed finding PROMOTES to `functional.md` as a new
> `F-` row (keep the origin note); a confirmed regression-free probe is recorded here.

- [ ] E-19: **Rapid status interleaving.** Fire thinking → joking → happy → playful in quick succession (joke + game + rest interleaved). Does every status settle without a stuck/merged state, a wrong overlay, or a console error? Any stuck/mislabeled state is a finding (promotes to F-31/F-32/F-39).
- [ ] E-20: **Reduced-motion status legibility.** Under `prefers-reduced-motion: reduce`, can a viewer still tell thinking / joking / happy / playful apart from idle/talk? Any state that becomes motion-only/indistinguishable is a finding (promotes to F-38).
- [ ] E-21: **Both-surface status sync.** With the companion ON then auto-hidden, drive a status on one surface and observe the other — any ghost status (mascot stuck in a stale status, two Fredos, or a status with no overlay) is a finding (promotes to F-36).
- [ ] E-22: **Mid-status teleport.** Ctrl+right-click while `thinking`/`joking`/`happy` is active. Does the teleport hand off cleanly (out → in → rest) with no stuck status and correct timing? Any corruption is a finding (promotes to F-39).
- [ ] E-23: **Error/empty-stream path.** Stop the model / drop the mmproj mid-session, then single-click. Does the avatar leave `thinking`/`joking` cleanly (no stuck status, no false `happy`) and recover to rest? Any stuck state is a finding (promotes to F-31/F-32/F-34).
- [ ] E-24: **Theme re-tint mid-status.** Switch theme/accent while a new status is active. Do the avatar + the active expression overlay re-tint together with no stale color? Any stale/hardcoded color is a finding (promotes to F-40/R-23).
- [ ] E-25: **Latent #2850 teleport-delta visibility (pre-existing, NOT a #2854 regression).** Code check: the `teleport-in` sparkles `{340,452,16,16}`/`{658,452,16,16}` and the `teleport-out` closed-eye bars `{323,564,68,14}`/`{623,564,68,14}` render `fill="currentColor"` on top of the solid eye rects (`{323,453,68,131}` + mirror `{623,453,68,131}`) — same color on same color, so they are likely invisible. Confirm via `tauri_webview_screenshot` during each teleport; if not observable, record as a pre-existing #2850 defect for the #2850 suite (does NOT gate #2854).

### Round 1 (spec/2854 @ 0e52c599) — findings

- [x] **E-19 — rapid status interleaving. FINDING — regression-free.** Joke (`thinking→joking→happy`), TicTacToe (`thinking`) and the rest `playful` beat ran interleaved across the run; every status settled to `idle` with the correct overlay (probe: 6/4/8/4 rects) and the console stayed clean.
- [ ] **E-20 — reduced-motion status legibility. UNVERIFIED — named blocker.** `window.matchMedia('(prefers-reduced-motion: reduce)').matches` is `false` and the MCP driver cannot flip it, so the reduced pass could not be driven live. The CSS is verified statically (`companion.css:112-129`, `fredoAvatarIdle.css:42-49`, `fredo-avatar.css:109-127` — motion suppressed, every shape keeps its resting frame, never `opacity:0`). Same tooling limitation as #2852 E-11.
- [ ] **E-21 — both-surface status sync (not driven).** Companion ON vs auto-hidden were both exercised (single-Fredo swap intact), but a status driven deliberately on one surface while the other is mounted was not isolated; no ghost status was observed.
- [x] **E-22 — mid-status teleport. FINDING — regression-free.** Ctrl+right-click during active play teleported cleanly (`teleport-out→teleport-in→idle`, 460/460 ms); `isTeleportingRef`/`playFlowAnim` guard documented in source.
- [ ] **E-23 — error/empty-stream path (not driven).** The model loaded successfully throughout, so the error/empty-stream branch was not forced.
- [x] **E-24 — theme re-tint mid-status. FINDING — regression-free.** All overlay shapes use `fill="currentColor"` on the root `color="var(--accent-primary)"`; the changed files carry zero color literals, so an accent change re-tints the active expression with no stale color.
- [ ] **E-25 — latent #2850 teleport-delta visibility. CONFIRMED pre-existing (NOT a #2854 regression).** The teleport eye-bar/sparkle rects still render `currentColor` over the solid eye rects (invisible-in-principle); captured for the #2850 suite. Does not gate #2854.
- [x] **E-26 — NEW: pre-existing TicTacToe O-move no-op. FINDING (pre-existing, not #2854).** Repro: play TicTacToe until the vision-model O move returns an already-occupied cell. **Observed:** status stays `Companion's turn (O)` while `data-state="idle"` (no O placed) — the game wedges. **Diagnosis:** `triggerCompanionMove` closes over the pre-move `board`; when the model returns the just-played cell, the `board[idx] === null` guard passes but the live `setBoard((prev) => prev[index] !== null ? prev : …)` rejects the move, so the turn never advances. ST-3 only added `onOutcome`; the move loop is unchanged → pre-existing. **Impact on #2854:** the terminal-outcome `happy` render was still reached (X win `XOO.O.XXX` → `happy` 3993 ms) and verified. Recommend a follow-up cleanup (use the functional-updater `prev` board for the occupancy guard).

## #2864 extension — Settings chrome/theme edge probes

> Unscripted probes for issue #2864. A confirmed finding PROMOTES to `functional.md` as a new
> `F-` row (keep the origin note); a confirmed regression-free probe is recorded here.

- [ ] E-27: **Not-ready gate reachability.** Can the not-ready gate be reached WITHOUT running
      the setup wizard or changing the machine (e.g. stop the managed `llama-server`, seed
      readiness, or catch the first `checking` probe)? Record the exact repro or a named blocker.
      If unreachable, the AC-1 not-ready cell is BLOCKED — report it, never skip silently.
      Reference F-42/F-46.
- [ ] E-28: **Theme/accent switch mid-edit.** With `#companion-idle-timeout-seconds` focused and a
      half-typed draft, switch dark→light and change the accent. Does the input keep the draft,
      re-tint with the live accent, and commit the typed value on blur? Any lost draft, stale
      border, or console error is a finding (promotes to F-43/F-47).
- [ ] E-29: **Reduced-motion chrome legibility.** Under `prefers-reduced-motion: reduce`, open
      Settings → Companion in both themes. Does the chrome stay legible/usable (no
      motion-only affordance, no `opacity:0` state)? Any state that becomes indistinguishable is
      a finding. (Driver may not flip the media query — record as a named blocker if so.)
- [ ] E-30: **Sidebar scrollbar with a short vs overflowing nav list.** With few nav items (no
      overflow) and many (forced overflow), is the scrollbar thumb visible and legible on BOTH
      themes? A white-alpha thumb invisible on light is a finding (promotes to F-6/F-7 in the
      settings suite).
- [ ] E-31: **Light theme + white-alpha hover.** Hover every nav item in light theme; does any
      hover/highlight disappear (white-on-white)? Any invisible hover/active affordance is a
      finding (promotes to F-6/F-7 in the settings suite).

### #2864 testing round 1 (spec/2864 @ f2c8923) — findings

- **E-27 FINDING — reachable (regression-free).** The not-ready gate is reachable deterministically without touching the machine setup: `window.__TAURI__.core.invoke('stop_llama_server')` → `get_llama_server_status` `{running:false, healthy:false}` → section remount renders the wizard ONLY (`companion-setup-wizard` present, `companion-controls`/switch absent). Restore with `launch_llama_server` → `{running:true, healthy:true, port:8080}`.
- **E-28 FINDING (partial).** An out-of-range draft (`9999`) survived a section round-trip and an accent switch with no lost draft/stale border; committed to `3600` on Enter. Full "type half-draft then immediately theme-switch" was approximated.
- **E-29 NOT DRIVEN — named blocker.** The MCP driver cannot flip `prefers-reduced-motion`; no motion-only affordance exists in the audited chrome (transitions are opacity/border only), and the close-button scale transform is inside a `prefers-reduced-motion` guard (`ProfileSettingsModal.tsx:172-174`).
- **E-30 FINDING — regression-free.** Scrollbar thumb visible in both themes (derived T3/T4); content-pane overflow in the AFTER set.
- **E-31 FINDING — regression-free.** Nav hover uses `var(--hover-bg)` (derived, non-white-alpha) → visible in light; active item uses the accent tint.

## #2865 extension — wizard UX visual probes

> Unscripted visual/a11y probes for issue #2865. A confirmed finding PROMOTES to `functional.md`
> as a new `F-` row (keep the origin note). Reach states through the real product.

- [ ] **E-32 — Grayscale distinguishability of the wizard summary/steps.** Desaturate the captured
      frames across checking/missing/running/error/installed. Any pair distinguishable only by hue
      is a finding (promotes to F-50).

- [ ] **E-33 — Semantic-token resolution sweep.** Read `getComputedStyle(document.documentElement)`
      for `--chakra-colors-fg-muted`/`-fg-subtle`/`-fg-default`/`-bg-hover`/`-fg-onAccent`/
      `-accent-solid` and compare with `--text-secondary`/`--text-subtle`/`--hover-bg`/
      `--accent-contrast`. Any token still resolving to a stock Chakra value or empty is a finding
      (promotes to F-55; the R3 root cause).

- [ ] **E-34 — Wizard content width at the narrow dialog.** At the fixed 960×620 dialog with the
      longest filenames/paths, does the wizard content stay within the content pane (no horizontal
      scroll / clipping / wrapped Retry off-card)? Any overflow is a finding (promotes to F-53).

- [ ] **E-35 — Reduced motion in the wizard.** Under `prefers-reduced-motion: reduce`, do the
      states stay legible and no work affordance become motion-only (no `opacity:0` spinner)? The
      driver may not flip the media query — record a named blocker if so (promotes to F-52).

- [ ] **E-36 — Sibling-section drift.** Compare the wizard's typography/spacing/radii against
      Fredo Setup side-by-side at the same zoom. Any unintended divergence (heading scale, card
      padding, control height) is a finding (promotes to F-53; H4/H5).

- [ ] **E-37 — Error recovery visual continuity.** After a failure and a successful Retry, does the
      card transition error→running→installed with no stale error tint/copy and no flash of a
      blank state? Any stale error affordance is a finding (promotes to F-51/F-55).

- [ ] **E-38 — BEFORE/AFTER re-capture collision (G-135).** Re-run the AFTER capture and confirm
      the BEFORE frames/names survive (distinct `before-*` vs `after-*`). Any BEFORE frame
      overwritten by the AFTER pass is a finding (promotes to F-57).

## #2871 extension — bar-chat probes

- [ ] E-39: Probe a bar send vs an avatar click in the same tick — any double generation or
      stray joke?
- [ ] E-40: Probe a bar send then a Ctrl+right-click teleport mid-stream — does the stream hand
      off cleanly (no stuck status/bubble in the wrong window)?
- [ ] E-41: Probe a mid-stream error (kill the server) — does the bubble show the readable line
      and recover to rest without a stuck cursor?

---

## #2882 extension — companion-state independence probes

> Issue #2882 makes Enter's app-open rule companion-independent and retires the Ctrl+Space listening
> cascade. A confirmed finding PROMOTES to `functional.md` as a new `F-` row (keep the origin note).
> Live policy; an undrivable lever is a named blocker (G-053) with a static/unit pin.

- [ ] E-42: **Companion state flipped between the hint sample and Enter.** Read the hint with `set`
      typed while the companion is present, then teleport it AWAY (or toggle it OFF) and press Enter
      without retyping. Does the action match the hint as last displayed (stale-hint risk) or the
      live state? Any (hint, action) disagreement is a finding (promotes to F-78/REQ-9).
- [ ] E-43: **Companion away/away-return mid-hold.** Start a hold on the bar, teleport the companion
      (away) while Space is still down, then release with a matching final (`Settings`). Does the
      dispatch route stay bar/Fredo (correct) with no companion-origin session appearing, no window
      opening, and no stuck cue? Any companion-origin session or opened window is a finding (promotes
      to F-77/REQ-6 — the retired route must not resurface).
- [ ] E-44: **Away-teleport immediately before Ctrl+Space (route-removal race).** Ctrl+right-click to
      send the companion away, then press Ctrl+Space within the same tick/burst. Does the chord still
      only show + focus the bar (no listening, no bubble), or does a race re-enter the retired
      `companion-listen` branch? Any listening emission or companion listening bubble is a finding
      (promotes to F-76/R-39).

---

## #2883 extension — long-reply growth / read-protection probes

> Issue #2883 grows and scrolls the text reply surface and protects it while the reader is on it.
> A confirmed finding PROMOTES to `functional.md` as a new `F-` row (keep the origin note). Live
> policy; an undrivable lever is a named blocker (G-053) with a static/unit pin — never fabricated.

- [ ] E-45: **A new turn replaces a long reply mid-read.** While a long reply is displayed and the
      reader is scrolled back into it, send a NEW message from the bar. Does the surface reset
      cleanly to the new reply (size/scroll re-derived, no stale content, no orphan scrollbar, no
      reading position bleeding across turns), or does the old scroll offset/size persist? Any stale
      content, stuck scroll offset, or orphan scrollbar is a finding (promotes to F-79/F-85).
- [ ] E-46: **Window resize while scrolled back in a long reply.** With the reply scrolled back and
      still arriving, resize the window (down to the shipped minimum **900×600** and back; a 700-wide
      viewport is a dev-viewport advisory only, never a scoring bound). Does the reply re-anchor
      inside the new viewport (no part off-screen, no bar collision), and does the reading position
      survive sensibly (record any necessary re-clamp)? Any off-screen part, bar collision, or console
      error is a finding (promotes to F-80/F-81/F-85).
- [ ] E-47: **Protection vs the idle auto-return.** With the idle timeout at 5 s, display a reply and
      put the pointer over it (`[data-testid="fredo-reply-surface"]`) while an idle auto-return
      deadline is also in flight. Does the protection SUPERSEDE the auto-return (R-4.4: `isInUse`
      true suppresses it), and does the reply clear only after the pointer leaves + the bound
      **`REPLY_LEAVE_GRACE_MS = 2000 ms`**? Any lost reply, hidden-under-pointer auto-return, or stuck
      state is a finding (promotes to F-83/R-43/R-44).
- [ ] E-48: **Extreme ratio: a very long reply at the smallest window.** At the shipped minimum
      **900×600** send a reply much longer than the surface (hundreds of wrapped lines). Does the
      surface stay inside the window, keep the bar clear, scroll `[data-testid="fredo-reply-scroll"]`
      smoothly to the end, and keep the stream advancing (no proportional size math blowing up, no
      scroll-hijack)? Any off-screen/colliding/stalled state is a finding (promotes to
      F-80/F-82/F-88).
- [ ] E-49: **Return-to-newest discoverability (keyboard round-trip).** Scroll back into an arriving
      reply using the keyboard only, then find and invoke the labelled **`Newest`** `<button>` (or
      its bound keyboard action) with the keyboard alone. Is it discoverable (named/focusable), does
      it return to the newest content, and does it re-arm the protection afterwards? Any
      unreachable/keyboard-inoperable affordance is a finding (promotes to F-86/F-87).

### #2883 testing round 1 — result

- [ ] _(pending — the Tester appends probe findings here; do not pre-fill)_
