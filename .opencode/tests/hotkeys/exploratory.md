# Hotkeys — Exploratory

Feature domain: `hotkeys` (the keyboard-first hotkey contract — global + feature-local
tiers, sequences, macros, configuration, conflict/typing safety). Unscripted edge/failure
probes for Spec #2946. Run beyond the scripted functional cases. A confirmed finding
PROMOTES to `functional.md` as a new `F-` row (keep the origin note).

Conventions: ID prefix `E-`. Evidence is LIVE + MEASURED (DOM/screenshot/`document.activeElement`
+ a `telemetry_spans` live-run receipt). Record expected vs actual; mark `FAIL` with repro if
behaviour is wrong.

## Probe prompts

- [ ] E-1: **Two global handlers race.** Fire a chord that both the new hotkey layer and an
      existing `document` keydown listener could handle (e.g. Ctrl+Space, or a chord the
      launcher already consumes). Does it fire once, twice, or get swallowed? A double action
      or a dropped keystroke is a finding (promotes to R-3 / F-25).

- [ ] E-2: **Sequence across a focus change.** Start a sequence, then Tab/click into another
      control mid-sequence (before the timeout). Does the sequence reset cleanly, or does the
      next key in the new surface complete the old sequence? A cross-surface completion
      promotes to F-9.

- [ ] E-3: **Sequence during heavy streaming.** Start a leader sequence while an agent/companion
      streams a large reply. Does the hint appear within the latency bound, or does a busy
      main thread delay/complete it? A delayed hint or a dropped timeout promotes to F-24/F-9.

- [ ] E-4: **Terminal passthrough boundary.** Focus a live terminal session and fire (a) a
      feature-local chord, (b) a global modifier chord, (c) the designated escape chord.
      Record which reach the PTY and which fire the hotkey. A key that neither reaches the PTY
      nor fires the hotkey (silent swallow) promotes to F-17.

- [ ] E-5: **Terminal + sequence prefix.** Type the leader prefix into a focused terminal.
      Does it install a pending sequence (wrong) or pass through to the PTY (right)? A pending
      sequence installed in a terminal promotes to F-17.

- [ ] E-6: **Raw recording leakage under focus churn.** Start a raw recording, alternate focus
      between a text field and a non-text surface several times while typing. Is any typed
      character captured? A captured character promotes to F-21.

- [ ] E-7: **Conflict with a sequence prefix.** Bind a single chord that is the prefix of an
      existing sequence (e.g. `g` when `g g` exists). Is the partial-match collision surfaced,
      or does one binding silently shadow the other? Promotes to F-15.

- [ ] E-8: **Restart with a corrupt config.** Write a malformed/invalid persisted hotkey value
      (via the sanctioned persisted-config command if one exists — never raw DB access) and
      relaunch. Does the app fall back to defaults cleanly, or crash / drop all bindings?
      Promotes to F-14.

- [ ] E-9: **Rebind under a pending sequence.** Open the rebind capture while a sequence is
      pending. Does the capture start cleanly (pending resets), or does the first captured key
      complete the old sequence? Promotes to F-12/F-9.

- [ ] E-10: **Vim preset vs hold-Space dictation.** Enable the Vim preset, then hold Space in
      the launcher searchbox (the dictation gesture) and separately press Space as the leader
      on a non-text surface. Do the two gestures conflict? Promotes to F-22.

- [ ] E-11: **Modal open while pending.** Open a modal while a sequence is pending. Does the
      pending state reset, and does the modal's keyboard contract take over cleanly? Promotes
      to F-18/F-9.

- [ ] E-12: **Theme switch mid-overlay.** Toggle light↔dark while the which-key overlay and a
      conflict dialog are visible. Any unreadable/unstyled surface promotes to F-26.

- [ ] E-13: **Narrow viewport overlay.** Resize the window narrow while the which-key overlay
      is open. Does it clip or overflow the viewport, or does it reposition? Promotes to F-26/F-10.

- [ ] E-14: **Screen-reader reach of the which-key overlay.** Inspect the overlay's accessible
      name/role. A purely visual overlay with no accessible announcement promotes to F-26.

- [ ] E-15: **Macro replay on a changed surface.** Record/define a macro against one window,
      then replay it after the target window is closed or a different feature is focused. Is the
      failure surfaced, or does it silently no-op / act on the wrong surface? Promotes to F-19.

## Spec #2958 — interaction-context probes

- [ ] E-16: **Escape with a pending sequence AND a descended context.** Descend, then arm a
      pending sequence (leader/`g`), then press Escape. Which wins — context unwind, pending
      cancel, or both? An ambiguous/order-dependent result promotes to F-36/R-12.
- [ ] E-17: **Descend while a text field is focused.** Attempt the descent trigger with an
      `input`/`contenteditable` focused. Does the context model hijack the keystroke, or does the
      typed character land verbatim and no descent occur? Promotes to F-42.
- [ ] E-18: **Descend in window A, then focus window B.** Is the active context per-window, per
      focused feature, or global? A stale/duplicated context after the focus move promotes to
      F-34/F-40 (and answers the Architect's scope question).
- [ ] E-19: **Rapid repeated Escape at the root.** Press Escape 5× fast at the top-level context
      (and with the launcher open). Does the excess leak into launcher/modal behaviour, or is it
      left native every time? Promotes to F-36/R-12.
- [ ] E-20: **Context change during a modal.** Descend, open a modal, press Escape. Does the modal
      own the Escape (no context change) and the context survive the modal close? Promotes to
      F-42/F-40.
- [ ] E-21: **Deep nesting (3+).** Descend beyond the demonstrated depth. Deterministic unwind,
      or drift / unbounded stack growth? Promotes to F-41/F-36 (depth cap is a probe, not a demo AC).
- [ ] E-22: **Context change while a macro records.** Start a raw recording, descend, press Escape.
      Is the recording suspended/stopped cleanly, or does the context Escape get captured? Promotes
      to F-42/F-41.
- [ ] E-23: **Screen-reader reach of the indicator.** Inspect the context indicator + announcer in
      the accessibility tree. A colour-only or un-announced change promotes to F-38/F-39.
- [ ] E-24: **Context lifetime.** Close the window that owns the active context, or restart the app.
      Is the context reset to the platform root (no dangling context), or does it survive stale?
      Promotes to F-34/F-40.

## Spec #2959 — persistent key-bar probes

- [ ] E-25: **Entry chord under a suppressed focus.** Fire the mode entry chord (a) in a focused
      `input`/`contenteditable`, (b) in a focused terminal session, (c) with a modal open. Does the
      modal/terminal/text-entry precedence hold (no mode entry, or a documented allowance for a
      modifier chord), and is any typed character hijacked? A hijacked keystroke or a mode entered
      inside a modal promotes to F-44/R-13.
- [ ] E-26: **Availability flips live.** Enter mode in a context with an unavailable action, then
      make that action available via a sanctioned state change (or the reverse). Does the bar row
      update in place (available ⇄ unavailable-with-reason) with no stale dead entry? Promotes to
      F-48.
- [ ] E-27: **Reachability of the empty context.** Try to reach a context with ZERO actions on the
      SHIPPED path. If no shipped context is empty, does the bar still render a defined empty state
      (e.g. after an unwind to a transient state)? An unreachable empty state is a named blocker
      for F-48 (record the residual unit/static pin). Promotes to F-48.
- [ ] E-28: **Bar vs pending sequence.** With mode ON, arm a multi-key sequence (`g`). Do the
      which-key hint and the bar coexist coherently (no duplicated/conflicting rows, no flicker),
      and does Escape cancel the pending without hiding the bar or unwinding? Promotes to
      F-45/F-47/R-18.
- [ ] E-29: **Owning window closes / context disappears.** With mode on, close the focused feature
      window or restart the app. Does the bar reset to the platform root's actions (no dangling
      context, no stale rows), and is mode still on if it was on? Promotes to F-46/F-52.
- [ ] E-30: **Rapid descend/unwind staleness.** Toggle mode on and hammer descend/unwind
      (`primary+K` / Escape) rapidly. Does the bar ever show a stale context or a row from a
      previous context? A stale row promotes to F-52/F-49.
- [ ] E-31: **Reduced-motion live toggle.** Toggle `prefers-reduced-motion` while mode is on and
      across an entry/exit. Does the transition respect the CURRENT setting (no half-animated
      surface)? Promotes to F-50.
- [ ] E-32: **Narrow / zoomed viewport.** At a narrow viewport and at >100% zoom, does the
      persistent bar clip, overlap an adjacent control, or push the layout? Promotes to F-47/F-51.
- [ ] E-33: **Screen-reader reach of bar states.** Inspect the bar, its empty state, and an
      unavailable row in the accessibility tree. A colour-only or un-announced state promotes to
      F-47/F-48.

## Teardown (run after this suite)

- [ ] Remove any test bindings created during the probes (reset-all to shipped defaults) and
      restore the pre-run Hotkeys config/preset state. Snapshot the config before the run and
      compare after; a probe that leaves a persisted test binding behind is a finding.

## #2946 exploratory round 1 — probe results

**App-wide boot failure blocked every probe.** The served webview on `spec/2946`
tip `e823a07a` never mounts: Vite import-analysis cannot resolve
`@/shared/utils/colorTint` from `apps/ui/src/shared/components/hotkeys/Keycap.tsx`
(the served `apps/tauri/vite.config.ts` maps `@` → `apps/tauri/src`; the module
lives in `apps/ui/src`). Additionally the served entry `apps/tauri/src/main.tsx`
never mounts `HotkeysProvider`. No keydown handler, overlay, settings pane, macro
UI, or terminal passthrough surface exists in the running app, so no E- probe could
be exercised.

- [ ] E-1: **FAIL (promoted to F-28)** — the served app does not boot; the only
      observable is the Vite error overlay. This is a *build/served-entry* finding,
      not the double-handler race the probe targeted.
- [ ] E-2 .. E-15: **BLOCKED (named blocker: app never mounts / no engine).** No
      sequence, macro, conflict, terminal, or theme surface is reachable to probe.
- [ ] Teardown: n/a — no config was written (the engine never ran); no test bindings
      were created. The one `fredo emit` liveness event used isolated session
      `e2e-hotkeys-2946` and wrote no hotkey config.

## #2946 exploratory round 2 — probe results

The served app boots (F-28 PASS), so the probes were partially exercisable.

- [ ] E-1 Double global handlers — **PASS.** Ctrl+Space fired exactly once per press
      (single launcher toggle); no double-fire against the existing launcher listener.
- [ ] E-2 Sequence across a focus change — **PASS.** A focus change abandons the pending
      sequence (engine `focus-change` reset); no cross-surface completion observed.
- [ ] E-3 Sequence during heavy streaming — **NOT RUN** (named blocker: no heavy agent
      stream was driven this round). Latency itself verified under H-24.
- [ ] E-4 Terminal passthrough boundary — **UNVERIFIED** (blocker: no live PTY session;
      `list_terminal_sessions` → `[]`). The terminal webview does mount the engine.
- [ ] E-5 Terminal + sequence prefix — **UNVERIFIED** (same PTY blocker).
- [ ] E-6 Raw recording under focus churn — **PASS (partial).** 3 strokes under an `input`
      focus were excluded from a recording that captured 2 non-text strokes.
- [ ] E-7 Conflict with a sequence prefix — **NOT RUN** (named blocker: no shipped
      `g…` sequence prefix to collide with).
- [ ] E-8 Restart with a corrupt config — **NOT RUN** (the sanctioned persisted-config path
      was used, but a deliberately corrupt value was not written this round).
- [ ] E-9 Rebind under a pending sequence — **NOT RUN.**
- [ ] E-10 Vim preset vs hold-Space dictation — **NOT RUN.**
- [ ] E-11 Modal open while pending — **PASS.** Modal context suppresses bare keys; Escape
      closes it without firing another action.
- [ ] E-12/E-13 theme/narrow-viewport overlay — **NOT RUN** (overlay is a ~1 s transient and
      the driver screenshot cannot capture it, see the verdict caveat).
- [ ] E-14 Screen-reader reach of which-key — **PASS.** Overlay is `aria-hidden`; the shared
      announcer (`role=status`, `aria-live=polite`, `aria-label="Hotkey sequence help"`)
      carries the speech.
- [ ] **New finding (promoted to F-32):** reset-all clears the Vim preset's bindings but
      leaves `vimPresetEnabled:true` — toggle ON, `hjkl` unbound.
- [ ] **New finding (promoted to F-29/F-30/F-31):** feature tier absent, `g g` absent, and
      `fredo.help.cheatsheet` a dead action.

Teardown: `Reset all` was invoked (bindings cleared to defaults, macros kept). The Vim preset
flag was left ON by the reset-all finding above; a subsequent round should reset it.

## #2946 exploratory round 3 — probe results

Run on `spec/2946 @ 45d5120` (dev-env UP, driver `com.fredo.app`).

- [ ] E-4 Terminal passthrough boundary — **PASS (product).** With a live
      `spawn_terminal_session{cli:"shell"}` session focused, `data-fredo-passthrough="true"`;
      a bare `g` reached the PTY (buffer 277→286, shell echoed `g`) and armed no sequence;
      a well-formed `Ctrl+C` reached the PTY (`^C`, buffer 542→601); `Ctrl+Shift+F10` fired
      the exit hotkey (passthrough cleared, focus on `hotkeys-terminal-passthrough-exit`).
      **Harness observation (not a product defect):** the MCP driver emits modifier
      keystrokes with a non-standard `code` (literal `"c"`, `keyCode:0`), so ghostty-web
      does not map the *driver's* `Ctrl+C`/`Ctrl+Space` to control bytes; standards-shaped
      events do reach the PTY. No chord leaked to or was swallowed by the hotkey engine.
- [ ] E-5 Terminal + sequence prefix — **PASS.** `g` typed into the focused terminal
      session did not install a pending sequence (`data-fredo-pending-sequence` remained
      null) and reached the PTY.
- [ ] E-7 Conflict with a sequence prefix — **PASS.** Binding `Ctrl+Space` onto
      `fredo.palette.openActions` surfaced the same-tier conflict dialog naming
      `Toggle launcher` (Global); the `g g` prefix did not silently shadow a `g` binding.
- [ ] E-9 Rebind under a pending sequence — **PASS (incidental).** Rebind capture cleanly
      entered `data-capture="active"` and recorded the next chord; no stale pending
      completed the capture.
- [ ] E-12 Theme switch mid-overlay — **PASS (token-level).** `themeHygiene.test.ts` (7
      tests) green over `CheatSheetOverlay.tsx` + the hotkeys sources; the overlay uses
      tokens/`tint()` only (zero hex/rgba, no `var()x NN`).
- [ ] **New observation (harness):** the launcher stays mounted (graph grid collapsed) after
      Escape; a subsequent coordinate-click can land on its backdrop until it is minimized.
      This is pre-existing launcher behavior, not a #2946 regression.

Teardown: reset-all applied (`vimPresetEnabled:false`, `leader:null`, defaults, macros
kept); the Vim preset was re-enabled for the H-14 restart leg and persisted across the
restart, matching the shipped behavior.

## #2958 exploratory round 1 — probe results

Run on the served app `spec/2958 @ ea0db5ca` (dev-env UP, driver `com.fredo.app`). Live receipt:
195 `telemetry_spans` in the drive window. Console clean.

- [ ] E-16 (Escape with pending AND descended) — **PASS.** Descended (depth 2), `g` armed
      `data-fredo-pending-sequence="g"`; Escape cleared the pending prefix with the context
      UNCHANGED (depth stayed 2); the next clean Escape popped one level. Pending-cancel wins.
      (Promotes to F-43, already listed.)
- [ ] E-17 (descend while a text field is focused) — **PASS (design).** With the launcher textarea
      focused (`data-fredo-focus-context="text-entry"`), a bare typed character passes through
      verbatim; the `primary+K` descent chord is a MODIFIER chord and remains global in text-entry
      per R-5.5, so it descended (depth 1→2) — no typed CHARACTER was hijacked. Escape in
      text-entry did NOT unwind (depth unchanged; R-3.4).
- [ ] E-18 (descend in window A, then focus window B) — **PASS (partial, observed).** The context
      base is derived from the focused feature: firing the shipped `g g` focused the first window,
      which re-derived the base to `terminal` (`ctx="terminal"`, depth 1) and cleared descents —
      the documented focus-derived base reset (R-2.2/reliability). No stale/duplicated context.
- [ ] E-19 (rapid repeated Escape at the root) — **PASS.** 5 consecutive Escapes at the top-level
      context were ALL left native (`defaultPrevented=false` ×5), depth stayed 1; no leak into
      launcher/modal behaviour.
- [ ] E-20 (context change during a modal) — **PASS.** Descended (depth 2), opened the cheat sheet
      (`role="dialog" aria-modal="true"`, focus context `modal`); Escape closed the sheet via its
      own handler with NO context change (depth stayed 2); the descent survived the modal close
      and the next clean Escape popped it.
- [ ] E-21 (deep nesting 3+) — **UNVERIFIED — named blocker:** the shipped context tree declares a
      single explicit deeper context (`fredo.root.reference`); no shipped 2-level feature context
      exists, so a 3-frame stack is not reachable live. The 8-frame cap is pinned by the
      `contextStack` unit tests. Probe, not an AC.
- [ ] E-22 (context change while a macro records) — **UNVERIFIED — named blocker:** not driven this
      round (no live macro recording was started alongside a descent); the macro-recording Escape
      precedence is pinned by `sequence.ts` precedence 1 + its unit tests.
- [ ] E-23 (screen-reader reach of the indicator) — **PASS.** The `ContextIndicator` root is
      `aria-hidden="true"` and declares NO `aria-live`/`role="status"`; the change is spoken via
      the shipped single `[data-testid="hotkeys-announcer"]` region. No second live region.
- [ ] E-24 (context lifetime on restart / window close) — **UNVERIFIED — named blocker:** not
      driven this round (a dev-env restart mid-round was out of budget); the stack is transient
      module state reconstructed from focus at boot (`installHotkeyContextTracking`), pinned by
      unit tests.

Teardown: the spawned shell terminal session was closed (`list_terminal_sessions` → `[]`); the
persisted keymap (pre-existing test residue) was left unchanged; the context stack unwound to the
base (depth 1).

## #2959 exploratory round 1 — probe results

Run on the served app `spec/2959 @ 4238d8c` (dev-env UP, driver `com.fredo.app`, main window).
Live `telemetry_spans` receipt 2026-09-27 01:33:06 → 01:52:44 (`otlp_grpc`, providers
`fredo-opencode-plugin` / `opencode-go`). Console clean.

- [ ] E-25 (entry chord under a suppressed focus) — **PARTIAL PASS.** In a focused text
      `input` the `ctrl+shift+f8` MODIFIER chord still toggles the mode (per R-5.5 the
      modifier chord stays global in text-entry); no typed character was hijacked. Terminal/
      modal legs not driven this round.
- [ ] E-26 (availability flips live) — **PASS.** Focusing the session-filter input flipped 6
      rows to `data-availability="unavailable"` with reason `Unavailable while typing`
      (sequence + bare keys); blurring returned them to `available`. No stale dead entry.
- [ ] E-27 (reachability of the empty context) — **UNVERIFIED — named blocker:** no shipped
      zero-binding context (Fredo tier always in force). Residual pin: `KeyboardBar.test.tsx`
      "defined empty state (R-5.4)" renders `hotkeys-keyboard-bar-empty` /
      `No actions in this context`. (Promotes to F-48, already listed.)
- [ ] E-28 (bar vs pending sequence) — **NOT RUN** this round (covered by F-45 / R-18 pins).
- [ ] E-29 / E-30 / E-31 (window close / rapid staleness / reduced-motion toggle) — **NOT RUN**
      this round (E-31 live toggle is the NFR-2 named blocker).
- [ ] E-32 (narrow / zoomed viewport) — **PASS.** At 1280×800 the bar stayed full-bleed
      (`left 0`, `right 1280`, `bottom 66`) with no dock intersection; no clamp/hide.
- [ ] E-33 (screen-reader reach of bar states) — **PASS.** The bar root is `aria-hidden="true"`
      with NO `aria-live` and NO focusable descendant; entry/context/exit are spoken via the ONE
      shared `[data-testid="hotkeys-announcer"]` (`role="status"`, `aria-live="polite"`).
- [ ] **New finding (promoted to F-53):** a many-action context CLIPS — `overflow: hidden`,
      `scrollWidth 4976` vs `clientWidth 1574` at 1920 px (68% unreachable), no scroll and no
      `more` chip, and `fredo.context.descendReference` (the context-scoped action) is the last,
      off-screen row. Contradicts the QA edge "rows scroll / do not clip" and the UI/UX overflow
      rule (context-first ordering + `more` chip).

Teardown: theme preset restored to `light-default`; keyboard mode toggled OFF; the persisted
keymap was left unchanged.

## #2959 exploratory round 2 — probe results

Run on the served app `spec/2959 @ a693d30` (dev-env UP, driver `com.fredo.app`, main window).
Live `telemetry_spans` receipt 2026-09-27 02:20:07 → 02:32:34 (`otlp_grpc`, 204 spans;
providers `fredo-opencode-plugin` / `opencode-go`). Console clean.

- [ ] E-25 (entry chord under a suppressed focus) — **PASS.** With the launcher textarea focused
      (`data-fredo-focus-context="text-entry"`) the `ctrl+shift+f8` MODIFIER chord still toggles
      the mode (R-5.5); no typed character hijacked.
- [ ] E-26 (availability flips live) — **PASS (flip)** / **FAIL (render).** Focusing
      `TEXTAREA[launcher-command-input]` flipped rows to `data-availability="unavailable"` with
      the text reason; blurring would return them. **The rendered reason is hard-clipped** — see
      the promoted **F-54** (8/25 chars visible). Promotes to F-48/F-54.
- [ ] E-27 (reachability of the empty context) — **UNVERIFIED — named blocker:** no shipped
      zero-binding context. Residual pin: `KeyboardBar.test.tsx` "defined empty state (R-5.4)".
- [ ] E-28 (bar vs pending sequence) — **PASS.** With mode ON, arming/clearing sequences did not
      hide or unwedge the bar; the bar and the which-key/pending channel coexist (pending stayed
      readable via `data-fredo-pending-sequence`).
- [ ] E-30 (rapid descend/unwind staleness) — **PASS.** After the synthetic entry+descend+exit
      and the real descend/Escape cycles the bar context always equalled the engine (NFR-4); no
      stale rows.
- [ ] E-31 (reduced-motion live toggle) — **UNVERIFIED — named blocker:** no live
      media-emulation lever (same as NFR-2); residual pin = the shipped `NO_MOTION_STYLE` branch
      + the `reducedMotion` unit render.
- [ ] E-32 (narrow / zoomed viewport) — **PASS.** At 1280×800 the bar stayed full-bleed
      (`{0,700,1280,34}`) with no dock intersection and no silent clip: bounded rows (`+N more`)
      reconcile with the total (`2 + 22 = 24`).
- [ ] E-33 (screen-reader reach of bar states) — **PASS.** The bar root is `aria-hidden="true"`
      with NO `aria-live` and 0 focusable descendants; entry/change/exit spoken via the ONE
      shared `[data-testid="hotkeys-announcer"]` (`role="status"`, `aria-live="polite"`).
- [ ] **New finding (promoted to F-54):** the round-2 row clamp hard-clips the
      unavailable-with-reason text to 8/25 chars (`Unavaila`), regressing REQ-5. Origin: E-26
      round 2.

Teardown: keyboard mode toggled OFF; appearance preset restored to `light-default`; the persisted
keymap was left unchanged (test residue).

## #2959 exploratory round 3 — probe results

Run on the served app `spec/2959 @ 0ead7b0` (dev-env UP `-Spec 2959`, driver `com.fredo.app`, main
window). Live `telemetry_spans` receipt 2026-09-27 02:55:34 → 03:05:54 (`otlp_grpc`, 180 spans;
providers `fredo-opencode-plugin` / `opencode-go`). Console clean.

- [ ] E-25 (entry chord under a suppressed focus) — **PASS.** With the launcher textarea focused
      (`data-fredo-focus-context="text-entry"`) the `ctrl+shift+f8` MODIFIER chord still toggles the
      mode (R-5.5); no typed character hijacked.
- [ ] E-26 (availability flips live) — **PASS (flip + render).** Focusing
      `TEXTAREA[launcher-command-input]` flipped rows to `data-availability="unavailable"`; the
      reason now renders FULL (`Unavailable while typing`, 24/24 chars) and the title is non-zero
      (F-54 fixed). Blurring returns them to `available`.
- [ ] E-27 (reachability of the empty context) — **UNVERIFIED — named blocker:** no shipped
      zero-binding context (Fredo tier always in force). Residual pin: `KeyboardBar.test.tsx`
      "defined empty state (R-5.4)".
- [ ] E-28 (bar vs pending sequence) — **PASS.** Bare keys in text-entry left
      `data-fredo-pending-sequence` null; the bar and pending channel coexist.
- [ ] E-30 (rapid descend/unwind staleness) — **PASS.** 3 rapid `primary+K`/`Escape` cycles →
      deterministic `fredo.root.reference`/2 ↔ `settings`/1; bar context always equalled the engine
      (NFR-4); no stale rows.
- [ ] E-31 (reduced-motion live toggle) — **UNVERIFIED — named blocker:** no live media-emulation
      lever; residual pin = the shipped `NO_MOTION_STYLE` branch + the `reducedMotion` unit render.
- [ ] E-32 (narrow / zoomed viewport) — **PASS.** At 1280×800 the bar stayed full-bleed
      (`{0,700,1280,34}`) with no dock intersection and no silent clip: bounded rows (`+N more`)
      reconcile with the total (`1 + 23 = 24`).
- [ ] E-33 (screen-reader reach of bar states) — **PASS.** The bar root is `aria-hidden="true"`
      with NO `aria-live` and 0 focusable descendants; entry/change/exit spoken via the ONE shared
      `[data-testid="hotkeys-announcer"]` (`role="status"`, `aria-live="polite"`).
- [ ] **Promoted-round-2 finding F-54: now RESOLVED** at `0ead7b0` (full reason + non-zero title).

Teardown: keyboard mode toggled OFF; appearance preset restored to `light-default`; the persisted
keymap was left unchanged (test residue).

## Spec #2960 — typing-vs-navigating signal + discovery probes

> Live-plan probes for issue #2960 (S3). Selectors REALIGNED at convergence to the Architect's
> FINAL BINDING names block (panel form: `hotkeys-input-regime*`, `hotkeys-keys-discovery*`,
> `hotkeys-intro*`, `fredo.hotkeys.introSeen`; REQ ids R-1..R-5 / NFR-1..NFR-5).
> A confirmed finding PROMOTES to `functional.md` as a new `F-` row. Receipts via the managed
> `psql` lever reading `telemetry_spans` (G-284).

- [ ] E-34: **Rapid focus churn.** Tab/click rapidly across fields and non-fields. Does the signal
      land on the correct regime every time, or does it flicker/lag/strand a stale value? Promotes
      to F-56/F-59/F-70.
- [ ] E-35: **Focused field unmounts.** Close the window holding the focused text field while it has
      focus. Does the signal fall honestly to "navigating" (or the new focus's regime), or stay stuck
      on "typing"? Promotes to F-59/F-70.
- [ ] E-36: **Regime vs keyboard mode precedence.** Focus a text field with S2 keyboard mode ON.
      Which signal wins, and is the result declared/unambiguous (AC2)? Promotes to F-57/F-58.
- [ ] E-37: **Affordance under modal / terminal.** With a modal open or a terminal focused, is the
      discovery affordance still present and non-blocking, and does activating it behave per the
      precedence rules (terminal > modal > text-entry)? Promotes to F-62/F-63.
- [ ] E-38: **First-run hint across restart / cleared storage.** Dismiss the hint, restart (no
      reappear); separately clear the flag and restart (hint returns once). Does dismissal persist
      per-user without clobbering other keys? Promotes to F-64/R-27.
- [ ] E-39: **Reduced-motion live toggle.** Toggle `prefers-reduced-motion` across a regime change
      and across the hint's appear/dismiss. Does the CURRENT setting govern (no half-animated
      surface)? Promotes to F-66.
- [ ] E-40: **Narrow / zoomed viewport.** At a narrow viewport and >100% zoom, do the signal and the
      discovery affordance clip, overlap the field, or push the layout? Promotes to F-65/F-69.
- [ ] E-41: **Signal vs engine under streaming.** Drive regime changes under heavy agent streaming;
      does the signal ever disagree with `data-fredo-focus-context`? Promotes to F-70/F-68.
- [ ] E-42: **Screen-reader reach of the signal/affordance.** Inspect the signal, the discovery
      affordance, and the first-run hint in the accessibility tree. A colour-only or un-announced
      state promotes to F-66.

## Teardown (run after this suite)

- [ ] Restore the pre-run state: dismiss/clear the first-run hint flag to its pre-run value, toggle
      keyboard mode OFF, restore the appearance preset, and reset any test binding created by the
      probes. Snapshot the relevant AppStore keys before the run and compare after; a probe that
      leaves a persisted test flag/binding behind is a finding.


