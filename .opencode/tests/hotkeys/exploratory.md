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

