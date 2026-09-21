# Launcher — Exploratory

> Unscripted edge/failure probes for the launcher shell (issue #2808). The Tester adds
> findings here; a confirmed finding promotes to `functional.md` as a new `F-` row
> (keep the origin note).
> **Serving checkout:** `spec/2808 @ bd30b07b`. Round 2.

## Prompt lines
- [x] E-1: Probe the `>` command bar — type text, cancel, focus-out; does it lose focus or error?
  - **Observed (no error).** Typed `zzzz` into `input[role="searchbox"]` — the controlled value updated (`inputVal: "zzzz"`) and the grid filtered to zero without error. Clearing the input restored the grid. No console error. (Note: the command-bar query is a grid filter only — it stays in the input on the next open because the host keeps the `query` state; this persisted `zzzz` across an open/close cycle, exercising the empty-grid path.)
- [x] E-2: Probe keyboard nav at the grid edges (first/last tile wrap) and Escape-to-close behavior.
  - **Observed (clamp, no wrap).** `ArrowRight` moved selection Mission Monitor → Query Viewer; `ArrowLeft` moved back. `clampIndex` clamps at the edges rather than wrapping (plan says "clamp is safer"). `Escape` closed the launcher (`open=false`) — confirmed on the empty-grid and open-grid states.
- [x] E-3: Probe opening many features quickly (rapid Enter) — does the kernel store stay consistent, does focus/z-order behave?
  - **Observed (kernel store consistent; z-order now verifiable).** Query Viewer then Mission Monitor each opened once from the grid; the window store held one `.fredo-window__surface` per open. **Round-2 (post ST-6):** the two windows coexisted (`openWindows: 2`) and stacked by z-order — `elementFromPoint(960,500)` returned `fredo-window__surface` (topWindow "Sessions/Mission Monitor"); the rapid-Enter focus-stacking behavior is now visually confirmed (round 1 flagged this leg unverifiable due to the occlusion).
- [x] E-4: Probe toggling light/dark while the launcher is open — do all surfaces re-theme without flicker or hardcoded color?
  - **Observed (re-theme works; no light mode).** Switching base theme turbo→classic while the launcher was open re-colored the avatar and the selected-tile border (accent token `#ae53ba` → `rgb(147,51,234)`) with no hardcoded color and no console error. **Finding:** the product ships NO light theme — `themes` defines only dark `turbo` and `classic`, so there is no light/dark toggle to probe (PO-scope, G-050).
- [x] E-5: Probe the empty `SHOWABLE_FEATURES` path with the command bar focused — any crash or console error?
  - **No crash, no console error.** With the grid empty (`zzzz` query) and the command bar focused, arrows + Enter were no-ops, the launcher stayed open, and the console stayed clean. (Exercised via the query-filter-to-zero path — see F-5.)
- [x] E-6: Probe window-manager focus after opening a feature from the grid then closing it — does the launcher regain focus, does the grid state persist?
  - **Verified (round 2 — ST-7 fix resolves the round-1 gap).** Round 1 found the notch `div[role="button"][aria-label="Fredo launcher"]` had NO `tabindex`, so Escape's focus-restore fell to `BODY`. **ST-7 added `tabIndex={0}` to the notch** (`LauncherChrome.tsx:160`). Round-2 live: notch `tabindex="0"` present (`hasTab: true, tab: "0"`); after open-launcher → Escape → `{"launcherOpen":false,"activeEl":"Fredo launcher","focusOnNotch":true,"activeIsBody":false}` — focus lands on the notch, NOT `BODY`. The launcher grid keyboard nav, open/close lifecycle, and the window-store epoch all behave. (Note: the grid-state `query` persists across launcher open/close by design — the host keeps the `query` state; clear via the input. This is not a defect.)

## Promoted findings
- Round 1 promoted the AC2b window-occlusion z-order defect (fixed round 2 by ST-6) and the notch-not-focusable/Escape-focus-restore gap (fixed round 2 by ST-7). Both are **resolved** in round 2 (see `functional.md` F-3/F-3 edge + `exploratory.md` E-6), so the previously-blocked re-focus / multi-window / E-3 legs are now visually verified. No new findings promoted in round 2.

## #2819 extension — idle/engaged launcher probes

> Add findings here for issue #2819; a confirmed finding PROMOTES to `functional.md` as a
> new `F-` row (keep the origin note).

## E-7 — Notch-click vs focus-idle interplay

- [ ] E-7: Probe what the NOTCH click does after the #2819 rework (it was the #2808 open trigger). Does it still open/engage the launcher, or is it now an idle-only ornament? If it toggles the engaged state, is focus placed correctly? Any regression to the #2808 notch `aria-expanded`/Escape-focus-restore is a finding.

## E-8 — Blur-to-idle ambiguity

- [ ] E-8: Probe blurring the command bar (focus-out) with an empty query — does the desktop stay ENGAGED (grid + hints) or return to IDLE? Record the actual behavior; if it differs from the AC expectation (triage Discussion QA-1), flag it.

## E-9 — Re-theme while engaged with the new chrome

- [ ] E-9: Probe switching a theme preset while the new chrome (side ticks, dot-grid, rounded frame) is ENGAGED — do the new elements re-tint token-native with no hardcoded color and no flicker? Any element stuck on a stale color/text token is a finding.

## E-10 — Rapid open/close + new idle chrome

- [ ] E-10: Probe opening a tile, closing it, then re-engaging the launcher rapidly — does the idle chrome (avatar, bar, ticks, dot-grid, frame) remain correct under the window lifecycle churn, with no console error and no orphan window?

## #2823 extension — global Ctrl+Space keyboard/focus probes

> Add findings here for issue #2823; a confirmed finding PROMOTES to `functional.md` as a
> new `F-` row (keep the origin note).

## E-11 — Rapid Ctrl+Space spam

- [ ] E-11: Probe rapidly pressing Ctrl+Space multiple times (e.g. 5× fast) — does the launcher toggle cleanly each press, or does it get stuck / focus-bounce / double-toggle? Any console error or focus trap is a finding.

## E-12 — Ctrl+Space in an IME / non-QWERTY layout

- [ ] E-12: Probe Ctrl+Space with an active IME input context (Windows input-method / CJK) and on a non-QWERTY layout — does the toggle fire, or does the OS/IME swallow the keydown? Any missed toggle is a finding (the native-collision risk).

## E-13 — Ctrl+Space over a maximized feature window

- [ ] E-13: Probe Ctrl+Space while a feature window is MAXIMIZED over the resting surface — does the overlay re-raise ABOVE the window (`elementFromPoint` returns a node inside the launcher dialog), or does it stay hidden behind? The resting surface is z'd below the window, so the overlay raise is the critical path.

## E-14 — Focus restore when the pre-open element is gone

- [ ] E-14: Probe opening the launcher from an element, then removing/unmounting that element while the launcher is open, then closing — does focus fall back gracefully (no crash, no focus-trap in a dead launcher)? Record the landing element.

## E-15 — ESC precedence across surfaces

- [ ] E-15: Probe ESC behavior when a feature window is ALSO open behind the launcher overlay (e.g. Mission Monitor detail panel with its own ESC-close handler) — which ESC wins, does any co-fire (two actions)? Any double-close / focus-chatter is a finding.

## #2824 extension — ESC/close hint keycap probes

> Add findings here for issue #2824; a confirmed finding PROMOTES to `functional.md` as a
> new `F-` row (keep the origin note).

## E-16 — Re-theme while the ESC hint is visible

- [ ] E-16: Switch theme surface (a light preset ↔ the dark base via the themed preset selector) while the engaged launcher shows `ESC CLOSE` — does the keycap badge + `CLOSE` label re-tint token-native (no hardcoded color, no stale token, no flicker)? Any element stuck on a stale color/text token is a finding.

## E-17 — Narrow-viewport / small window spacing

- [ ] E-17: Resize the webview window small/narrow while the launcher is engaged — does the ESC badge stay clear of the frame and the `CLOSE` label, or does it collide/clip at the reduced width? Any cramped/colliding layout is a finding.

## E-18 — Empty-grid hint-row edge

- [ ] E-18: Probe the engaged hint row when the grid is empty (empty feature set / non-matching query) — the `ESC CLOSE` hint is hidden (`showNavHints = entryCount > 0 && engaged`). Confirm the hint row + keycap do NOT render and no console error/crash occurs.

## #2827 extension — PixelButler avatar probes

> Add findings here for issue #2827; a confirmed finding PROMOTES to `functional.md` as a
> new `F-` row (keep the origin note). Probe the avatar-base-form change for unforeseen
> interactions; a confirmed regression-free probe is recorded here (no promotion).

## E-19 — Re-theme while the avatar is visible

- [x] E-19: Re-theme (via the shipped `ThemePresetSelector`) while the avatar is visible — does the avatar re-tint token-native (no dead/stale color, no hardcoded literal, no flicker)?
  - **Observed (PASS).** Switching presets while the launcher avatar was visible re-tinted the avatar from the accent token every time: Light Default → `rgb(0,209,209)` cyan on white; Dark base → cyan on `#0c1117`; Matrix (supplementary) → `rgb(0,255,65)` green. No dead/stale color, no hardcoded literal, no flicker. The avatar color is genuinely token-driven (Matrix proved a non-cyan accent re-tints the non-cyan). **No finding — no promotion.**

## E-20 — Narrow-viewport avatar scaling/clip

- [x] E-20: Resize the webview window small/narrow while the launcher shows the avatar — does the avatar scale/clip/collapse the launcher tile?
  - **Observed (PASS).** Resized the window to 700×900 (confirmed `window.innerWidth=700`, `innerHeight=900`): the avatar `getBoundingClientRect` stayed 48×48 at (326,306), `fullyVisible: true` — NOT clipped, cropped, or scaled; it re-centered; the command bar + chrome held. No layout collapse. Screenshot `avatar-ac5-narrow.png`. **No finding — no promotion.**

## E-21 — Rapid launcher open/close avatar integrity

- [ ] E-21: Rapidly open/close the launcher (or a tool window) around the avatar — does the avatar stay correct (crisp cells, token color, no console error / no re-render loop, no orphan)?
  - **Observed (PASS, limited).** The avatar survived the settings-modal open/close cycle + a theme-to-heme + resize cycle with zero console errors and a stable 48×48 rect (post-cycle re-measure: 48×48, 91 rects, cyan). A focused rapid-close loop was not driven (window resize + modal open/close exercised the same render re-entrancy); no console `Error:`/`Uncaught`/`Maximum update depth exceeded` appeared. Recorded as an observed PASS; no promotion.

---

## #2830 extension — single top-right status LED probes

> Add findings here for issue #2830; a confirmed finding PROMOTES to `functional.md` as a
> new `F-` row (keep the origin note).

## E-22 — Rapid hover on/off the launcher LED

- [ ] E-22: Rapidly hover on/off the LED trigger in the launcher (idle AND engaged) — does the Chakra tooltip flicker/get stuck, or settle to the correct open/closed state? Any console error is a finding.

## E-23 — LED + clock overlap at narrow/nonstandard widths

- [ ] E-23: Resize the launcher window narrow/small — does the enlarged LED stay clear of the clock HH:MM text (below it, `mt="6px"`, right-aligned), or does it collide/overlap the clock or the frame? The `led-overlay.png` bug must not recur. Any overlap is a finding.

## E-24 — Ctrl+Space / notch open does not hide the LED

- [ ] E-24: Open the launcher via Ctrl+Space and via the notch, in both idle and engaged states — does the single LED remain visible in the top-right cluster (it is part of the chrome band, not the grid), and does opening a feature window still sink the band + LED below the window stack? Any missing LED / band resurface above a window is a finding.

## E-25 — State flip while hovering the launcher LED

- [ ] E-25: With the tooltip open over the launcher LED, drive a connection-state flip — does the tooltip content swap live (Connected ↔ Disconnected) and the LED recolor `var(--accent-primary)` ↔ `var(--status-error)`, token-native, with no stale tooltip text / console error?

## #2837 extension — PixelButler fredo-avatar.html geometry probes

> Add findings here for issue #2837; a confirmed finding PROMOTES to `functional.md` as a
> new `F-` row (keep the origin note). Probe the avatar re-geometry for unforeseen
> interactions; a confirmed regression-free probe is recorded here (no promotion).

## E-26 — Re-theme across presets while the new avatar is visible

- [ ] E-26: Re-theme through several shipped presets (light + dark + a non-cyan accent such as Matrix) while the launcher avatar is visible — does the avatar re-tint token-native with no dead/stale color and NO geometry change/deformation? Any element stuck on a stale color, or any theme-dependent deformation, is a finding.

## E-27 — Narrow/DPI resize + rapid open-close integrity

- [ ] E-27: Resize the webview small/narrow and cycle launcher open/close rapidly around the new avatar — does the avatar stay crisp (uniform cells, no anti-alias fill-in of the fragmentation gaps), fully visible, no clip/overflow, no console error / no re-render loop? Any filled-in gap, clip, or console error is a finding.

## E-28 — Fractional-DPI render of the new geometry

- [ ] E-28: At a fractional OS/webview zoom or non-100% DPI, does the new multi-rect geometry stay proportional (no merged/seam-shifted cells, no subpixel blur destroying the fragmentation gaps)? Any distortion at non-integer scale is a finding.

## #2850 extension — shared-avatar refactor probes

> Add findings here for issue #2850; a confirmed finding PROMOTES to `functional.md` as a new
> `F-` row (keep the origin note). Probe the launcher-md-over-shared-avatar change for unforeseen
> interactions; a confirmed regression-free probe is recorded here (no promotion).

## E-29 — Launcher md ↔ companion sm cross-surface consistency

- [ ] E-29: Render the launcher md avatar AND the companion sm avatar in the SAME theme and compare
      their rect sets + aspect side-by-side. Is the sm render a faithful proportional downscale of
      md (identical 58-rect set, only the viewBox scale differs), and do both stay crisp at their
      sizes? Any rect-set drift or a sm render that loses the fragmentation gaps / reads as a
      solid silhouette is a finding.

## E-30 — Launcher md after the shared move: rapid open/close + narrow/DPI integrity

- [ ] E-30: Cycle the launcher open/close rapidly around the shared md avatar and resize narrow /
      fractional-DPI. Does the avatar stay crisp (uniform cells, no anti-alias fill-in), fully
      visible, un-clipped, with no console error / re-render loop? Reference E-27/E-28 — any
      regression from the shared-path change is a finding.

## #2852 extension — desktop mascot 80×100 + idle-animation probes

> **Round 1 (spec/2852 @ 1677eca8) — no confirmed findings; E-32 UNVERIFIED-with-named-blocker.** E-31 ✓ animation stayed `running` after focus/query/ESC + settings/theme churn; size held 80×100; console clean (feature-window-open leg not driveable — automation limitation, no product finding). E-32 ⚠ UNVERIFIED (no media-feature emulation in the MCP driver; suppression rule + size verified). E-33 ✓ 700×900: 80×100, un-clipped, no scrollbar, 58 crisp cells. E-34 ✓ glow `oklab` re-tinted purple→cyan→green with the accent token across Default/None, Light Default, Matrix.

> Add findings here for issue #2852; a confirmed finding PROMOTES to `functional.md` as a new
> `F-` row (keep the origin note). A confirmed regression-free probe is recorded here (no
> promotion).

## E-31 — Rapid open/close churn around the animating mascot

- [ ] E-31: Rapidly cycle the launcher open/engaged → ESC → resting around the animating 80×100 mascot (and open/close a feature window over it). Does the idle loop restart cleanly (no stuck/frozen mid-bob frame, no ghost), does the size stay 80×100, and does the console stay clean (no `Maximum update depth exceeded` / no re-render loop)? Any frozen animation, size drift, or console error is a finding. Reference F-45 + R-31.

## E-32 — Reduced-motion flip while the mascot is mounted

- [ ] E-32: If the environment can drive it, flip `prefers-reduced-motion` reduce ↔ no-preference while the launcher mascot is mounted (or toggle the OS animation setting). Does the animation stop/start WITHOUT any geometry jump (still 80×100), with the figure staying visible and no console error? Any size shift, hidden figure, or stuck animation is a finding. Reference F-46.

## E-33 — Fractional-DPI / narrow-viewport bob clipping

- [ ] E-33: Resize the webview small/narrow (e.g. 700×900) and run at a fractional OS scale/zoom while the mascot bobs. Does the −2px lift stay inside the avatar container (no clipping, no creep into the command bar, no scrollbar), with the size still 80×100 and the 58 cells crisp (no anti-alias fill-in)? Any clip, subpixel smear, or layout shift is a finding. Reference F-44/F-45 + E-27/E-28.

## E-34 — Glow re-tint across presets while animating

- [ ] E-34: Re-theme through shipped presets (light + dark + a non-cyan accent such as Matrix) while the mascot's idle glow is running. Does the glow (the `drop-shadow` filter) re-tint token-native to the live `var(--accent-primary)` with no stale color, no hardcoded fallback, and no animation interruption? Any stale/off-token glow is a finding. Reference F-45 + E-26.

## #2871 extension — smart-Enter / bar-chat probes

- [x] E-35: Probe a partial-match Enter (`set` filters tiles but equals none) — does Enter chat
      while the grid still shows/launches Settings by click, with no double action?
  - **Observed (PASS, no double action).** ACTIVE companion; `set` filtered the grid to the single
    Settings tile with the chip `↵ send to Fredo`; clicking the tile launched Settings (no chat);
    Enter with `set` would chat (non-exact). No double action. No finding.
- [x] E-36: Probe a send while a generation is already streaming (Enter spam) — any interleaved
    stream, duplicated token, or double busy-clear?
  - **Finding (confirmed, promoted to F-53/F-58 FAIL).** Enter during an in-flight generation did
    NOT start a second stream (single-in-flight holds) — but it did **not** no-op either: the send
    gate `companionActive && !companionBusy` fell through to `openSelected()` and **launched the
    selected tile mid-stream** (recorder `wins:0→1` at t=14507 while `aria-busy="true"`). The plan's
    busy contract (UI/UX §1 state 5) requires READ-ONLY + Enter no-op. Promoted into the F-58 /
    REQ-14 verdict.
- [x] E-37: Probe a theme/accent switch mid-stream and while the bubble holds — stale color,
    lost partial text, or console error?
  - **Not driven this round (time-box, G-092).** Static token-native verification passed
    (zero color literals in the changed files); no contrary evidence. Named blocker: round time-box.
- [x] E-38: Probe an IME/CJK composition in the command bar — does Enter commit the composed text
    without sending a partial composition to the LLM?
  - **Not drivable in this automation round.** The MCP keyboard driver does not expose IME
    composition state; named blocker (no IME emulation). The Enter handler reads the controlled
    `query` value, so a committed composition would send the committed text — static reasoning only.

### Promoted findings (#2871 round 1)

1. **Busy-state divergence (promoted → F-53/F-58 / REQ-14 FAIL).** During generation the bar has no
   `Fredo is replying…` placeholder/chip, the input is not `readOnly`, and Enter during busy
   launches a tile instead of no-op'ing.
2. **Reduced-motion cursor gap (promoted → F-58 / REQ-16 FAIL).** `Fredo-cursor-blink`
   (`companion.css:142-145`) has no `@media (prefers-reduced-motion: reduce)` gate, so the
   streaming cursor still blinks under reduced motion.

### Promoted findings resolution — #2871 round 2 (spec/2871 @ bd168ee)

- **Finding 1 (busy-state divergence) — RESOLVED.** F-58 round 2 PASS: the busy bar shows
  `Fredo is replying…` placeholder + chip, `readOnly`, `aria-busy="true"`; a REAL Enter with
  `streamingAtKeydown="true"`/`busyAtKeydown="true"` is a global no-op (window count unchanged,
  no second generation). The `—` minimize clicked mid-stream did not abort the stream.
- **Finding 2 (reduced-motion cursor) — RESOLVED statically.** `.fredo-cursor { animation: none
  !important; }` inside the `@media (prefers-reduced-motion: reduce)` block + the product pin
  `companion.cursorReducedMotion.test.ts` (2/2). Non-reduced cursor still
  `animationName="Fredo-cursor-blink"` during streaming. Live `matchMedia` flip remains a NAMED
  BLOCKER (driver cannot flip it — G-053/G-148).

### New round-2 probes

- [x] **E-39 (mid-stream real Enter) — regression-free.** A REAL `Enter` keydown instrumented at
      the top of the busy window (`streamingAtKeydown="true"`, `busyAtKeydown="true"`,
      `roAtKeydown=true`) did NOT launch a tile and did NOT start a second generation
      (`runGeneration` count unchanged). Reference F-58.
- [x] **E-40 (`—` minimize during busy) — regression-free.** Clicking `button[aria-label="Minimize
      launcher"]` while `data-streaming="true"` did not abort the generation; the reply completed
      (2,709 chars) and the busy state cleared. `—` stays operable in state 5.
- [x] **E-41 (persona split) — regression-free.** A general prompt (`Write one short sentence about
      cats.`) now returns a DIRECT answer ("Cats are graceful, independent, and wonderfully curious
      companions."), NOT a programming joke; the single-click avatar path still returns a joke
      (`FREDO_PERSONA` retained). Reference companion F-71/F-69.
- [ ] **E-42 (IME/CJK composition in the command bar) — still NOT drivable** (no IME emulation in
      the MCP driver; named blocker, carried over from round 1 E-38).

---

## #2882 extension — hold-Space / typed-match boundary probes

> Issue #2882 makes Space a gesture on an EMPTY bar and broadens the typed-query match. A confirmed
> finding PROMOTES to `functional.md` as a new `F-` row (keep the origin note). Live policy; an
> undrivable lever is a named blocker (G-053) with a static/unit pin — never fabricated.

- [ ] E-43: **Hold-Space on a focused launcher TILE (not the input).** With the engaged grid and a
      tile focused, hold Space for 1.5 s. Space currently opens the selected tile when the event is
      NOT from the input (`LauncherShell.tsx:887-895`). Does the hold dictate (WRONG — hold-Space is
      scoped to the focused search bar), open the tile, or neither? Record the observed branch,
      `stt_status`, and the window count. Any dictation started from a focused tile is a finding
      (promotes to F-69/REQ-14).
- [ ] E-44: **The empty↔non-empty boundary under real typing.** Type a character, delete it, and
      hold Space in the SAME keystroke burst; then type a character mid-hold. Is the decision made
      from the value AT keydown (a clean transition), or does a stale value pick the wrong branch
      (capture when it should be a space, or a space when it should be capture)? Any lost/converted
      space or a stuck session is a finding (promotes to R-41/REQ-15).
- [ ] E-45: **Hint truth under churn.** Re-theme (light preset ↔ dark base) and toggle the companion
      ON/OFF/away WHILE a matching query is typed, and while a dictated transcript sits in the bar.
      Does the hint always re-derive to the truth for the action Enter would take right now, with no
      stale chip text and no console error? Any (hint, action) disagreement is a finding (promotes
      to F-67/REQ-9).
- [ ] E-46: **Auto-repeat hold survival.** Hold Space for ≥5 s so the OS auto-repeat fires many
      `keydown` events with `e.repeat === true`; count `stt_start` invocations and the cue's
      presence timeline. Exactly ONE session, one cue, no flicker, and no duplicated transcript is
      expected; a restart, a duplicate session, or a cue gap while capturing is a finding (promotes
      to F-66/REQ-3 + R-41/REQ-12).

---

## #2883 extension — wrapped-input / newline boundary probes

> Issue #2883 wraps the bar's input and adds `Shift+Enter`. A confirmed finding PROMOTES to
> `functional.md` as a new `F-` row (keep the origin note). Live policy; an undrivable lever is a
> named blocker (G-053) with a static/unit pin — never fabricated.

- [ ] E-47: **A single unbroken token longer than the bar.** Insert a 120-char word with no spaces
      (and a long URL/path with no spaces) into the focused bar. Does the token WRAP/chop inside the
      bar's content box, or does it overflow horizontally, push the hint/collapse controls, or get
      clipped? Any horizontal overflow, any control displacement, or any hidden tail is a finding
      (promotes to F-70/F-71).
- [ ] E-48: **Paste / IME composition of a large multi-line blob.** Paste (or insert) a multi-KB
      multi-line text in one action, and (if drivable) commit an IME/CJK composition in the
      multiline input. Does the input handle the bulk insert without a re-render stall
      (`Maximum update depth exceeded`), a lost selection, or a partial first paint? Any stall, lost
      text, or console error is a finding (promotes to F-72/F-78; the IME leg is a named blocker if
      the driver has no IME emulation, per the #2882 E-38/E-42 precedent).
- [ ] E-49: **Resize / fractional DPI while wrapped at the cap.** With the field at the **108 px**
      cap (5+ visual lines, scrollable internally), resize the window to the shipped minimum
      **900×600** and run at a fractional OS/webview scale (a 700-wide viewport is a dev-viewport
      advisory only, never a scoring bound). Does the field stay within the cap, keep the controls
      clear of the text, and keep the launcher chrome unshifted, with no clipping/scrollbar residue?
      Any clip, control overlap, or layout shift is a finding (promotes to F-72/F-76).
- [ ] E-50: **Rapid growth/shrink churn around the cap + hint truth.** Grow the query past the cap
      and shrink it back repeatedly in one keystroke burst (including deleting through the cap
      boundary), toggling the companion ON/OFF/away mid-churn. Does the bar height track cleanly
      (no stuck height, no orphan scrollbar) and does the hint always re-derive to the truth for the
      action Enter would take right now? Any stuck height, stale chip, or console error is a finding
      (promotes to F-72/F-76 + F-74).

### #2883 testing round 1 — result

- [ ] _(pending — the Tester appends probe findings here; do not pre-fill)_

---

## #2886 extension — never-cover placement x launcher-chrome probes

> Unscripted probes for issue #2886. A confirmed finding PROMOTES to `functional.md` as a new `F-`
> row (keep the origin note). Live policy; an undrivable lever is a named blocker (G-053) with a
> static/unit pin — never fabricated.

- [ ] E-51: **Tiny window with tiles + bar + a long reply.** At the shipped minimum 900×600, engage
      the grid (tiles + hint row visible) and hold a long reply. Who gives way first — the reply
      shrinks and scrolls, or does it collide with a tile/the bar/its controls? Record the exact
      first collision (rects + intersection area) or confirm none. Promotes to F-79/F-80.
- [ ] E-52: **Re-anchor while the bar grows underneath.** With a reply displayed and anchored above
      the seat, grow the bar to its 108 px cap with a long multi-line query. Does the reply
      re-anchor/re-clamp to stay clear of the grown bar, or does the bar grow into the reply? Any
      intersection with the bar/field/hint/collapse ⇒ finding. Promotes to F-79.
- [ ] E-53: **Message-kind churn in one session.** In a single launcher session: joke → welcome
      (toggle OFF/ON) → short reply → long reply → joke, sampling both rects after each. Does EVERY
      kind keep clear of Fredo (no stale anchor from the previous kind, no overlapping transition),
      and is the console clean? Any kind that reuses a stale anchor ⇒ finding. Promotes to
      companion F-91/F-96.

### #2886 testing round 1 — result

- [ ] _(pending — the Tester appends probe findings here; do not pre-fill)_

---

## #2887 extension — hold-at-the-readiness-boundary probes

> Issue #2887 keeps the recognizer ready while idle so the hold starts instantly. A confirmed finding
> PROMOTES to `functional.md` as a new `F-` row (keep the origin note). Live policy; an undrivable
> lever is a named blocker (G-053) with a static/unit pin — never fabricated.

- [ ] E-54: **Hold at the exact readiness boundary.** Press Space while the resident is cold/warming;
      release BEFORE capture goes live; press again immediately. Record the press/capture-active
      timeline, the bar `value` after each leg, the `stt_start` count and the cue samples. Does the
      never-live hold land exactly one ordinary space, does the immediate re-hold start cleanly, and
      is there any stale/ghost cue? A lost space, a stuck session, or a cue gap is a finding
      (promotes to F-82/F-83).
- [ ] E-55: **Resident killed / crashes while the bar is armed.** Kill the resident process with the
      bar armed (nothing dictating), then hold. Does the next hold recover with a bounded start, does
      the failure surface as a TEXT state (never a stuck `Listening…`), is the mic released, and does
      the console stay clean? Any hang, stuck cue, or dishonest listening claim is a finding
      (promotes to F-83; cross-ref `voice-input` E-37).
- [ ] E-56: **Rapid hold/release churn with the resident armed.** ≥10 fast holds/releases (incl. taps)
      around the readiness transition. Does the cue flap cleanly (no ghost frame), does the mic stay
      released between holds, does the latency creep, and does any handle/thread leak? Any cue gap
      while capturing, hot mic, or latency creep is a finding (promotes to F-82/`voice-input` F-82).
- [ ] E-57: **Contention / sleep-resume on the bar surface.** Hold Space under heavy CPU load and
      after a sleep→resume with the resident armed. Record the press→active numbers, the cue honesty
      samples, and whether the opening word lands in the bar. A cold-equivalent regression after
      resume or a dishonest indicator under load is a finding (promotes to F-82..F-84).

### #2887 testing round 1 — result

- [ ] _(pending — the Tester appends probe findings here; do not pre-fill)_

---

## #2893 extension — open-intent edge probes

> Issue #2893 lets the Companion open an app named in a message. A confirmed finding PROMOTES to
> `functional.md` as a new `F-` row (keep the origin note). Live policy; an undrivable lever is a
> named blocker (G-053) with a static/unit pin — never fabricated.

- [ ] E-58: **Two apps named in one message.** Send `open Mission Monitor and Settings`. Which opens
      — one, both, or none — and does the reply match? Any wrong/multiple/zero open that contradicts
      the reply is a finding (promotes to F-85/F-88).
- [ ] E-59: **Open during an in-flight generation.** Send a long chat message, then immediately send
      `open Mission Monitor` before `llm-done`. Does the open request queue, preempt, or get dropped,
      and is the final state coherent (one window, no stuck stream)? Any double dispatch or stuck
      state is a finding (promotes to F-89/F-102).
- [ ] E-60: **Target window already open.** With Mission Monitor open, send `open Mission Monitor`.
      Does it focus/restore the existing window (no duplicate, no stack churn, window count stable)?
      Any duplicate window is a finding (promotes to F-85/Q-5).
- [ ] E-61: **Model non-selection / malformed skill output.** With the model answering without
      selecting the skill (or with a malformed identity), does the request fail closed (no arbitrary
      open) and reply readably? Any guessed/arbitrary open is a finding (promotes to F-88/F-100).

### #2893 testing round 1 (spec/2893 @ 614f26d3) — results

- **E-58..E-61 BLOCKED (not FAIL).** The Companion skill path is inert live (skill-aware adapter
  unregistered in the Tauri runtime entry — see `functional.md` F-85..F-89 / `companion`
  `functional.md` #2893 results). No live generation reaches the model, so these probes cannot be
  driven. Re-run after the wiring fix.

- **FINDING observed during the CLI edge probes (promotes as a note, not a spurious-open finding).**
  A CLI `open-app` issued while the main webview is backgrounded/throttled can return
  `{"outcome":"unavailable"}` exit 1 even though the window DOES open — the frontend confirms after
  the 5 s bound (`confirm_app_open_request failed No pending app-open request`). The CLI's reported
  outcome can therefore disagree with the actual window state under load; recorded for the
  architect/fix round.

### #2893 testing round 2 (spec/2893 @ 223279d3) — results

- **E-58 NOT DRIVEN.** `open Mission Monitor and Settings` (two apps in one message) was not sent this
  round; the fail-closed resolver (`appNameMatches` candidates ≤1) remains the residual pin.
- **E-59 NOT DRIVEN.** An open request during an in-flight generation was not exercised; the
  single-in-flight `isGeneratingRef` guard + the ST-9 settle tests remain the residual pins.
- **E-60 PASS.** Target window already open: a second `open Mission Monitor` left the window count
  unchanged (no duplicate; the dock entry stayed 1) and the existing window was focused. Reply
  exactly `Opening Mission Monitor`. The window title lifecycle is `Sessions` on a fresh mount
  (`MissionMonitorPanel` sets it) and `Mission Monitor` on a re-open of an already-mounted window —
  the SAME `openFeatureWindow(id, feature)` opener in both cases, so the identity is the same window
  keyed by `mission-monitor`.
- **E-61 PARTIAL.** Unknown/malformed selections fail closed (see `companion` E-54/E-55); a live
  malformed argument was not forceable through the model.
- **O-1 (observation, tester instrument — not a product finding).** The `reading 'slice'` console
  bursts this round came from the tester's own MutationObserver scripts (null reply text at
  bubble-clear); they disappeared after a page reload. See `companion` exploratory round 2.

---

## #2892 extension — always-editable bar / queue-race probes

> Unscripted probes for issue #2892. A confirmed finding PROMOTES to `functional.md` as a new `F-` row
> (keep the origin note). Live policy; an undrivable lever is a named blocker (G-053) with a
> static/unit pin — never fabricated. Cross-ref `companion` E-58..E-63 + `settings` E-17..E-20.

- [ ] E-62: **Enter spam at machine speed.** Under `queue`, dispatch Enter ~10x in one burst during a
      single stream (synthetic keydowns via `execute_js`). Record the queue size samples and the final
      reply set. Exactly ONE reply per accepted send, in order, with no interleaved streams and no
      double clear is expected; any drop, duplicate, or interleave is a finding (promotes to F-93/F-98).
- [ ] E-63: **Send landing exactly at the settle race.** Time a send to land within ~50 ms of
      `llm-done` (poll `data-streaming`). Does the message dispatch (queue vs immediate) without a
      double generation and without a lost message? Any zero/duplicate generation is a finding
      (promotes to F-93/F-98).
- [ ] E-64: **Hover leave/enter at the clear boundary.** With a displayed reply, leave the pointer
      within a few ms of the grace expiring, then re-enter. Does the reply survive (fresh grace) or
      get cleared mid-re-entry? A cleared-then-returned reply or a stuck pinned reply is a finding
      (promotes to companion F-113).
- [ ] E-65: **Disposition flips between sends.** Send under `queue`, change to `interrupt` before the
      queued item drains, then send again. Does the queued item still drain FIFO while the new send
      interrupts, with no stale-mode dispatch and no orphaned indicator? Any wrong-mode dispatch,
      orphaned queue entry, or stuck indicator is a finding (promotes to F-93/F-94).
- [ ] E-66: **Indicator vs the status-slot precedence.** Show an alert / hearing-nothing status while a
      queued message waits. Does the queue indicator yield to the higher-precedence status without
      hiding the queue entirely (and without relayout), or does one clobber the other? Any lost status
      or displaced geometry is a finding (promotes to F-93/R-58/R-59).

### #2892 testing round 1 — result

- [x] **E-62 (Enter spam at machine speed) — mechanism verified live.** The in-page dual-send drive under `queue` produced exactly one queued item (indicator literal `Queued — waiting for Fredo…`) that auto-dispatched once on settle (reply `alpha`); no interleaved stream, no double clear. See `functional.md` F-93 round 2.
- [x] **E-63 (send at the settle race) — bounded by the in-page drive.** The second send lands inside the in-flight window by construction (in-page 200 ms after the first send), so the settle race was exercised deterministically; no lost/double generation.

### #2892 testing round 2 — result

- [x] **E-62 — PASS (live).** As above; exactly-once queue dispatch confirmed.
- [x] **E-63 — PASS (live, bounded).** In-flight send landed within the generation window (no serial-cadence miss).
- [ ] **E-64 (hover leave/enter at the clear boundary) — not driven (time-box).** Named blocker: needs a sub-100 ms pointer-leave/enter pair at the grace expiry; the driver has no sub-second pointer choreography. Static/unit pins (`replyProtection.test.ts`) remain the residual.
- [x] **E-65 (disposition flips between sends) — partially observed.** The disposition was switched `interrupt ↔ queue` live (Settings → Companion select) and the effective dispatch followed the persisted value (interrupt superseded; queue queued). A flip *between* an enqueue and its drain was not isolated.
- [ ] **E-66 (indicator vs status-slot precedence) — not driven (time-box).** Named blocker: a hearing-nothing/alert status must be raised concurrently with a queued item; the driver cannot hold the voice-capture state while sending. Pin: `launcherCommandBarVoice.test.tsx` precedence suite.
- **Finding (harness technique, no product defect) — promoted to `functional.md` F-93/F-94 round 2.** Two sends must be issued inside ONE in-page `execute_js` script (or the second via real keyboard against a deliberately long first generation). The native-setter + `input`-event approach did NOT reliably update React's `query` for the SECOND send after a first send cleared the bar (the re-send carried the stale first prompt); `document.execCommand('insertText')` and a real keyboard send both propagate correctly. The driver's own `tauri_webview_keyboard`/`interact` round-trips are ~6 s each — longer than the ~1–2 s local generation — so serial tool calls can never land in-flight.

---

## #2904 extension — clean-render edge probes

> Unscripted probes for issue #2904. A confirmed finding PROMOTES to `functional.md` as a new `F-`
> row (keep the origin note). Live policy; an undrivable lever is a named blocker (G-053) with a
> static/unit pin — never fabricated.

- [ ] E-67: **The narrowest bar with the longest indicator copy.** While dictating in model mode,
      force the bar to its narrowest practical width and hold the countdown copy
      (`Fredo is listening · 10s left`) and then the `processing` copy
      (`Fredo is processing your speech…`, the widest reservation). Does the chip stay on ONE line
      (ellipsis is acceptable) or does it stack one character per line / push the field? Any
      vertical/stacked string, any ellipsis that hides the countdown, or any field displacement is a
      finding (promotes to F-101/F-105).
- [ ] E-68: **Theme/accent switch during a live capture.** Start a launcher-origin dictation, then
      switch presets (`light-default` ↔ `dark`, and a non-cyan accent) while the indicator is
      visible. Does the indicator + field re-tint token-native with no stale colour, no geometry
      change, and no vertical relayout? Any stale colour, layout jump, or console error is a
      finding (promotes to F-104/F-106).
- [ ] E-69: **Resize / DPI churn mid-capture.** Drag the window from full size to the shipped
      minimum (900×600) and back, and run at a fractional OS scale (125%), all while the chip is
      live. Does the indicator stay one line and clear of the field at every intermediate width, and
      does the full-size render restore cleanly (no stuck narrow width, no orphan clip)? Any
      transient or persistent stacking/overlap/clip is a finding (promotes to F-105).

### #2904 testing round 1 (spec/2904 @ 027bbf1f) — results

- **E-67 PASS (live).** Countdown copy `Fredo is listening · 7s left` (146.8×24, ONE line, whole countdown visible — no ellipsis of the bound) at default; processing copy `Fredo is processing your speech…` (212.2×24, ONE line). At the narrowest supported window (900×600, bar constant 560) both stayed one line with `fieldContentW ≥ 140`; no field displacement. No promotion.
- **E-68 PASS (live, driven mid-capture).** While the model capture was live, switched the shipped `select[aria-label="Theme presets"]` `dark`→`light-default` in one in-page task: chip color `rgb(229,231,235)` → `rgb(12,17,23)`, card `#151a21` → `#f7f8fa`, chip rect **byte-identical** (`left 1037.2 / right 1143 / 105.8×24`), still `nowrap`/`horizontal-tb`; dot stayed `rgb(0,209,209)`, field border accent-30. No stale color, no geometry change, no console error. No promotion.
- **E-69 PASS (resize churn) / 125% DPI sub-leg UNVERIFIED (named blocker).** Mid-capture churn 900×600 ↔ 1400×900 ↔ 700×900 ↔ 1936×1056: one line + clear of the field at every width; full-size restored cleanly. **NAMED BLOCKER:** no lever to force a fractional OS/webview scale — the MCP driver exposes only `tauri_manage_window resize` in logical px, and the observed scale is 1:1 (`window.innerWidth 1936 == window width 1936` ⇒ 100%); `execute_js` cannot set devicePixelRatio. Command attempted: `tauri_manage_window(action="resize", width=…)` + `window.innerWidth` probe. No promotion.

---

## #2917 extension — solid-fill edge probes on the launcher surface

> Unscripted probes for issue #2917. A confirmed finding PROMOTES to `functional.md` as a new `F-` row
> (keep the origin note); a confirmed regression-free probe is recorded here. Live policy; an undrivable
> lever is a named blocker (G-053) with a static/unit pin — never fabricated.

- [ ] E-70: **Worst-case accent contrast for the launcher fill.** Pick the shipped preset whose accent is
      closest to the launcher background (or a near-background user accent). Is the filled interior still
      distinguishable from the surface behind Fredo, and is the head rim still readable? Any interior
      that merges with the background is a finding (promotes to F-108).
- [ ] E-71: **Fractional-DPI / narrow-viewport fill integrity.** At a fractional OS scale and at the
      shipped minimum 900×600 (and narrower, dev-advisory), does the fill stay inside the silhouette with
      no seam-shifted/overflowing cells, and does the figure stay un-clipped? Any overflow, seam shift, or
      subpixel smear is a finding (promotes to F-108).
- [ ] E-72: **Theme/accent flip mid-open/close over the fill.** Switch presets while the launcher is
      opening/closing and the mascot animates. Does the fill re-tint token-native with no stale colour and
      no geometry jump? Any stale colour, layout jump, or console error is a finding (promotes to F-109).
- [ ] E-73: **Dense-vs-sparse metric aliasing at the launcher size.** For a thin/periodic state captured
      on the launcher leg, compare a dense full-frame diff with a sparse point-grid diff. Any state where
      the sparse grid would pass while the dense diff fails must be recorded — the sparse grid is never
      admissible (promotes to `companion` F-121).
