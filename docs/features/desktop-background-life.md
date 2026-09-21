# Desktop background: Life

Fredo's **Life** desktop background is an opt-in, engine-backed surface that renders
Conway's Game of Life (the B3/S23 cellular automaton) behind the desktop windows. It
sits alongside `None` (the unchanged default) and the six declarative CSS recipes
(Aurora, Nebula, Mesh, Topography, Constellation, Halo) in
**Settings → Appearance → Desktop Background**.

Selecting a tile applies immediately; nothing else about the desktop shell changes.
Life is a `BackgroundDescriptor` with `id: 'life'`, `label: 'Life'`,
`renderer: 'life'` and `layers: []` — the empty layer list is deliberate: the desktop
backdrop dispatches the `renderer: 'life'` kind to a canvas-2D engine
(`background/life/lifeEngine.ts`) via `LifeBackgroundCanvas` instead of the generic
CSS-recipe layer loop. It is **not** part of the six-recipe `BACKGROUND_DESCRIPTORS`
array, so the six declarative recipes and the `None` default stay byte-identical.

## Licensing and attribution

The Life pattern catalogue (`background/life/lifePatterns.ts`) is an authored,
**bounded subset** of the **Life Lexicon** by **Stephen A. Silver**
(<https://conwaylife.com/patterns/>), which is licensed under the
**Creative Commons Attribution-ShareAlike 3.0 Unported License (CC BY-SA 3.0)**
(<https://creativecommons.org/licenses/by-sa/3.0/>).

Only **ten** named patterns are curated — glider, LWSS, blinker, toad, block,
beehive, pulsar, acorn, R-pentomino and the Gosper glider gun. The catalogue is
capped at `LIFE_PATTERN_COUNT = 10` (enforced at module load), and the **full Life
Lexicon dataset is never bundled**. Coordinates are stored as explicit `[col, row]`
cell offsets inside this repository; no raster, binary, or `data:` asset is shipped.

The same CC BY-SA 3.0 notice appears in three places:

- the attribution + licence header of `background/life/lifePatterns.ts`;
- this docs note; and
- an always-visible in-app notice under the Desktop Background chooser
  (`data-testid="desktop-background-life-attribution"`, text
  `Patterns: Life Lexicon (Stephen Silver), CC BY-SA 3.0.`).

The in-app notice renders regardless of which background is selected (the pattern set
ships with the app), lives outside the inert backdrop so it is legible and reachable
by assistive technology, and is the `aria-describedby` target of the Life tile.

## Bounds

The simulation is bounded by authored constants (`background/life/lifeConstants.ts`);
nothing in the Life domain hardcodes a limit inline.

| Bound | Value |
| --- | --- |
| Cell footprint | `LIFE_CELL_PX = 12` CSS px |
| Grid cap | `LIFE_COLS_MAX × LIFE_ROWS_MAX = 160 × 100 = 16,000` cells |
| Buffers | two `Uint8Array`s (one byte per cell; `step()` allocates nothing) |
| Step interval | `LIFE_STEP_MS = 160` ms (≈6.25 generations/s) |
| Re-seed cap | `LIFE_RESEED_GENERATIONS = 150` generations (`LIFE_RESEED_MS = 24,000` ms) |
| Patterns per seed | `LIFE_RESEED_PATTERNS_MIN..MAX = 2..4` |
| Random fill | `LIFE_FILL_DENSITY = 0.1` |
| Population band | `LIFE_DENSITY_MIN..MAX = 0.04..0.3` (never empty, never saturated) |
| Stagnation | unchanged population for `LIFE_STAGNATION_GENERATIONS = 3` generations at/below `LIFE_STAGNATION_MIN_DENSITY = 0.04` |
| Backing store | `LIFE_DPR_MAX = 1.5` × the CSS viewport on each axis (linear) |

### Re-seed policy

Each load starts from a fresh random seed (`data-life-seed` exposes it). A populate
places 2–4 randomly chosen catalogue patterns at random positions and one of the
eight dihedral orientations, plus bounded random fill, then clamps the live count into
the density band. The field re-randomizes when the **generation cap** (150) is
reached **or** when the population has been unchanged for three generations while at
or below the stagnation density — so the surface never settles into a still life and
never dies out.

### Frame loop

Exactly **one** bounded `requestAnimationFrame` handle drives generations at the step
cadence; the loop is cancelled (not merely skipped) while the document is hidden and
resumes on restore. `destroy()` cancels the handle and releases the canvas.

## Reduced motion

When the OS `prefers-reduced-motion: reduce` preference is set, the engine paints
**exactly one seeded frame** and schedules **zero** rAF/timers — the animation is
removed, not paused. The canvas then stamps `data-life-motion="static"` and
`data-life-running="false"`, and the backdrop root stamps `data-motion="static"` with
no injected motion stylesheet. `None` remains the unchanged default.
