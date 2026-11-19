# navigation-retirement — Exploratory

Unscripted probes for the removal slice. A CONFIRMED finding promotes to `functional.md` as a new
`F-`/`Q-` row (keep the origin note). Nothing here is an AC; a FAIL here is reported, not fatal,
unless it exposes a capability loss or a live console error.

## Prompts

- With all 8 applications open for several minutes, does ANY surface appear that was missed by the
  selector sweep in Q-1 — a keycap glyph, a `kbd` chip, a "press ? for help" string, a trailing
  breadcrumb? Probe with a text-content scan for `?`, `press`, `hotkey`, `shortcut`, `key` inside
  application roots, then adjudicate each hit by hand (most will be legitimate copy).
- Press every single printable key (not only the 20 retired ones) at the Wireframe root and diff
  the hook tuple. Anything that changes is a residual key binding Q-2's enumerated list missed.
- Open a second and third webview (`?view=terminal`, a standalone app window) and press the three
  chords in each. Is exactly ONE listener per webview armed (`isPlatformChordsInstalled()`), with
  no double-fire across windows (focus moves ONE step, never two)?
- After the deletion landing, open every application window, then reload the webview (dev HMR or a
  full reload). Does anything 404, throw, or render an error boundary? The retired barrel lines are
  the likeliest import-time break.
- Wireframe: after 100 undos, close the window and reopen it. Does the history survive, or is it
  cleared, or does the control state desync from `canUndo`/`canRedo`?
- Wireframe: press `Undo` twice in rapid succession before React repaints. Does one press = one
  entry (no double-pop)?
- Terminal: type during a chord press. Is any character dropped or duplicated by the re-homed
  suppression predicate?
- Companion: submit a turn naming a NON-showable app in the middle of another word (e.g.
  `themeing`, `theming-ish`). Does the whole-word matcher behave (no false positive)?
- Companion: open the box, then open a modal (SQL Studio destructive confirm) underneath it. Does
  the composer stay reachable / does focus escape?
- Dev Mode: with the Konami route, does any navigation verb still dispatch a `noop` into a host
  that no longer exists (console warn)?

## Do not run

- Never run the `opencode` binary from a shell (the mission-monitor suite's fixture doctrine).
- Never a bare `postgres`/`pg_ctl`/`psql` — SQL Studio's managed levers only.
