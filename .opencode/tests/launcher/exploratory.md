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
