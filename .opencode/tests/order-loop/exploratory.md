# Order Loop — Exploratory

> Unscripted probes for the Tester. **Verification policy: live.** Nothing here is an AC — findings are
> observations, and any error/failure state probed MUST name an in-repo induction lever or be marked
> non-AC (G-300). **A confirmed finding PROMOTES to `functional.md` as a new row** (keep the origin
> note). No filesystem hunts for out-of-repo assets.

## The gesture's sub-second states

- Probe the `armed` → `starting` → `listening` transition with a ≤50 ms observer (a `data-order-capture`
  attribute sample plus the announcement timeline). Is there any interval where capture is LIVE while
  `data-order-capture` still reads `idle`? Does the `starting voice input…` cue ever appear for a gesture
  that never crossed the threshold? (The 150–200 ms window is authored shipped behaviour — record it,
  do not score it.)

- Hold Space, then release inside the SAME tick as a blur. Which cancel wins? Is exactly one outcome
  reached (never both a cancel and a space)?

- Does an OS auto-repeat keydown during a live capture restart the session? Does a second Space keydown
  while already armed insert a space?

## The gate's failure surface

- Confirm an order, then teleport away BEFORE the executor completes (the placement ends mid-run). Is
  the invocation dropped, is nothing run, and is a refusal rendered — or is the pending action silently
  abandoned? (The design says a pending confirmation dies with the placement and an explicit refusal is
  rendered.)

- Press Confirm twice in the same tick. Exactly one execution, or two?

- Mount a confirmation, then let the composer re-render (a second submit). Is the dialog torn down by the
  composer's re-render? (It must be mounted where the flight is.)

- Open the composer with NO resolved target and dispatch an `order`. Does the refusal fire, or does the
  legacy `ask(text, context)` path narrate prose about what Fredo would do?

## The undo surface

- Press the APP's own Undo first, then the order's Undo. Does the order refuse to claim it undid its own
  change (stale-safe), or revert the user's later edit?

- Undo the same record twice (a double-click on `fredo-order-undo`). Does the second press render
  `orderNothingToUndoReply`, or silently no-op?

- Fill, then delete the SAME element, then press the order's Undo once. Which record is newest, and does
  the LIFO order match the user's mental model?

## Speech

- What does `speechSynthesis.getVoices()` return on this host? If the list is non-empty, does
  `speechSynthesis.speaking` ever become true for an order settle? If it is empty, record the named
  blocker verbatim (this is the AC-1 environmental precondition, never a PASS).

- Enable Doom Mode, then settle an order. Does the polite region carry the sentence while nothing is
  spoken? Then exit Doom Mode and settle again — does speech resume?

- Settle two orders inside one utterance. Is the first actually cancelled, or does `speechSynthesis`
  queue them?

## The in-flight order vs the move

- Move the app TWICE during one in-flight order. Which app does the settle name? Does the chip thrash?

- Move the app DURING the confirmation dialog (not during the run). Is the dialog dropped and the
  invocation refused, and is the refusal announced?

- Move the app while the ticker reads `done`. Does anything about the completed order change?

## The fourth skill

- On a real turn (PATH-A), read the offered `tools`. Is the fourth entry `order` present on EVERY turn,
  and are the first three byte-identical between two consecutive turns?

- Drive an audio turn. Does it carry the SAME four-name offer as the typed turn, byte-equal?

- With the lever UNARMED, attempt `order_skill_lever_take`. Is it inert? (This is the control every
  lever-driven row depends on — an armed-by-default lever would make F-13b/F-21..F-28 prove nothing.)
