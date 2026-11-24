# setup — Exploratory

> Unscripted edge/failure probes for the Fredo Setup auto-open removal + launcher tile (#3010).
> A confirmed finding **promotes** to `functional.md` (with the origin note). Live policy.

## E-1 — First-launch chrome with no wizard

- [ ] E-1: Probe a first launch on a wiped/fresh store (settings reset lever) — does the idle
      desktop/launcher chrome (notch + avatar + command bar + ticks + grid) render correctly with
      NO wizard auto-opened, and does it stay correct after ≥10 s idle? Any auto-open, blank
      surface, or console error is a finding.

## E-2 — Tile open while the launcher is in each engagement state

- [ ] E-2: Probe activating the `Fredo Setup` tile from the resting, engaged, and
      query-filtered grid, and with another feature window already open. Does the wizard window
      open/focus exactly once, land on top, and leave the launcher usable? Any duplicate window,
      lost focus, or clipped surface is a finding.

## E-3 — Settings entry with a wizard window already open

- [ ] E-3: Probe Settings → `Fredo Setup` while the tile-opened wizard window is open. Does it
      render the same wizard without a second/conflicting window, and does switching away and back
      re-render cleanly? Any duplicate, stale, or blank surface is a finding.

## E-4 — CLI/companion `open-app setup`

- [ ] E-4: Probe `fredo open-app setup` / companion `open setup` on a booted env. Since
      `showable=true` makes `setup` addressable, this is an explicit user route; confirm it opens
      the wizard only on explicit command and never automatically, and that it does not create a
      duplicate window. Any automatic/forced open is a finding.

## E-5 — Reload / re-theme stability

- [ ] E-5: Probe repeated `Ctrl+R`, light↔dark switches, and reduced-motion while the tile is
      visible and the wizard window is open. Do the tile and window re-render token-native with no
      stale color, no clip, and no console error? Any regression is a finding.

## #3198 probes — version gate / plugin install / retired env writer

> Seeded at triage for Spec #3198. Unscripted probes beyond F-9..F-22. A confirmed finding
> PROMOTES to `functional.md` (keep the origin note).

- [ ] E-6: **Version-string shapes.** Point the gate at a shim whose `--version` prints
      `v2.0.0`, `opencode 2.4.1`, a bare `2`, and a two-line banner + version. Does
      `parse_major()` read every shape the constant's contract claims ("first semver-ish
      token, stdout+stderr")? A shape the parser cannot read, or a wrong major, promotes to
      F-9/F-11.
- [ ] E-7: **Half-retired variable set.** With only `OPENCODE_OTLP_PROTOCOL=grpc` still set
      (the other two removed by the user), boot + install + run a session. Does setup stay
      green, and does the session still land in `telemetry_spans`? A setup that re-writes the
      missing variables (or a session that stops capturing) is a finding (F-16/F-17).
- [ ] E-8: **Install destination is a file, not a dir / dangling case.** Replace
      `~\.config\opencode\plugins\fredo.js` with a directory of the same name, then run
      `--install-plugin`. Is the failure loud and cause-naming (no silent skip, no partial
      write)? A silent success promotes to F-14. Restore the file afterwards.
