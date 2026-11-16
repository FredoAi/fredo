# wireframe-navigation — Exploratory

Unscripted probes for the declaration-driven Wireframe surface (Spec #3119). Run beyond the
scripted rows. A confirmed finding **PROMOTES** to `functional.md` as a new `F-N` row (keep the
origin note).

> **Verification policy: live.** Evidence = a quoted `tauri_webview_*` result + an uploaded
> capture. No `telemetry_spans` receipt (the feature emits none). Env + driver: see
> `functional.md`.

- [ ] **E-N1 (value-key cycles — verify the declared behaviour end-to-end).** With the right kind
      selected (shape for `f`/`o`/`z`, button for `p`, text for `t`, text/button/input/card for
      `r`) press each key repeatedly past the wrap point. Record: the exact value sequence
      (`WIREFRAME_COLOR_TOKENS` order with `info→surface`; `none→thin→thick→none`;
      `primary→secondary→ghost→primary`; `none→s→m→l→none`; `body→heading→body`), whether each
      press is exactly ONE human entry, whether the panel control's pressed state follows, and
      for `r` whether focus lands in the right name field with its text selected (and that no
      document entry is written). Then press `f` on a text element: it must announce
      `f isn't available here` once and change nothing.

- [ ] **E-N2 (armed state across places and focus).** Press `r` to arm a rectangle, then click
      the rail to enter Edit before the 250 ms timeout, then press `d`. Does the stale armed
      prefix leak into the new place, fire a rect, or clear cleanly? Then repeat with a text
      control focused between the two strokes.

- [ ] **E-N3 (same stroke, four meanings).** With one element selected press `s` at the root,
      then `s` in Create, `s` in Arrange, and `s` in Style. Record `data-wireframe-place`, the
      journal verb id and the observable effect each time. Any cross-place leakage means the
      resolver consults tier 2/4 while a place binding exists.

- [ ] **E-N4 (`u` and `y` at two tiers).** At the root press `u` (undo alias) and `y` (redo
      alias); then enter Arrange and press `u` (ungroup). With ≥2 elements selected, does Arrange
      `u` ungroup (tier 1) and the root `u` still undo (tier 2)? Record which ran and whether an
      accidental undo occurred.

- [ ] **E-N5 (double announcement / dedupe).** Enter and immediately exit the same place three
      times, then enter Create and let the draw auto-exit. Count the updates in the single live
      region (`hotkeys-announcer` textContent changes). Identical consecutive messages must be
      ONE update; distinct messages must be exactly one each.

- [ ] **E-N6 (focus after the auto-exit).** Focus a rail row button, press `c`, `r`, then drag
      to create. After the auto-exit, where is `document.activeElement`? Expected: the same rail
      button (never `body`, never the canvas stealing focus). Then repeat with the map open
      (the dialog trap must not swallow the post-close focus).

- [ ] **E-N7 (map filteredTo on the Create overflow).** Enter Create and click `more…`.
      Does the map open scrolled/filtered to the Create block with all 9 verbs, and does closing
      it leave `data-wireframe-place` unchanged? Then reopen the map with `?` — the filter must
      reset to `null`.

- [ ] **E-N8 (journal memory and trail cap).** Perform 120 small document mutations. Does the
      app stay responsive, does the trail still render 10 entries, and does undo still walk back?
      (The journal is intentionally unbounded this slice — record the memory shape as an
      observation, not a defect.)

- [ ] **E-N9 (selection churn vs availability).** Shift-click quickly between 0/1/2/3 elements
      while the map is open. Does any row stick on `available`/`disabled` from a stale snapshot,
      or does every row follow the live count? Any stale row = a snapshot-subscription defect.

- [ ] **E-N10 (pointer/keyboard interleave).** Drag a rectangle, then immediately press `c r`
      and drag a second one, then undo once, then drag a third. Assert the journal has exactly
      three human mutation entries plus one system undo, and that each entry's `placePath`
      reflects the place at dispatch time.

## Teardown (run after this suite)

- [ ] Close every Wireframe window, restore the appearance preset to the served default,
      delete probe captures under `.opencode/tmp/3119/e2e/` that are not part of the plan, and
      `Down` the isolated env. Confirm no settings key, DB row or capability file was left
      modified.
