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

- [ ] _(pending — the Tester records probe results here; do not pre-fill)_
