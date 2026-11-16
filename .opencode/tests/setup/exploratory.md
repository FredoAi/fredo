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
