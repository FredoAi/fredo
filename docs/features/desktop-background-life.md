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
| Dim weights | `LIFE_CELL_MIX = 0.2` (cell blend toward `--text-primary`), `LIFE_SCRIM_WEIGHT = 0.2` (`--overlay-bg` weight in the scrim) |
| Contrast floor | `LIFE_CONTRAST_MIN = 3` (dimmed cell-vs-ground WCAG ratio; below it the untransformed pair is painted) |

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

## Dimming and legibility (#2925)

The field is deliberately **calmer and less single-hue-dominant** than the first Life
ship (#2915) — a comfort/polish refinement, not a rule change. The changes are
**paint-only**: the automaton, the pattern catalogue, the grid/density caps and the
re-seed policy are byte-unchanged.

Two derived CSS custom properties carry the work. They are registered **once** in
`app/providers/ThemeProvider.tsx` (base pass, next to `--accent-strong`) as live
`color-mix()` expressions, so they re-resolve on any preset/accent change with no
restart and no per-preset values:

| Token | Expression | Meaning |
| --- | --- | --- |
| `--life-cell` | `color-mix(in srgb, var(--accent-strong) 80%, var(--text-primary) 20%)` | Live-cell colour: the accent-strong cell blended 20 % toward the text colour (lowers chroma). |
| `--life-dim` | `color-mix(in srgb, transparent 80%, var(--overlay-bg) 20%)` → `rgba(0, 0, 0, 0.12)` | Field-wide 12 % black scrim composited over ground **and** cells. |

`paint()` stays ground fill → cell pass, then adds **exactly one** final
`ctx.fillRect(0, 0, w, h)` with `tokens.dim` — constant cost, no per-cell alpha, no
second pass, no new allocation, no second rAF/timer. Because the scrim is
field-wide it dims both sides together and preserves the cell-vs-ground ratio,
while the cell mix (M2) lowers chroma and is contrast-safe or contrast-enhancing on
every theme (dark `--text-primary` darkens cells on light presets; light
`--text-primary` lightens them on dark presets).

The two numeric weights are the single authored home in
`lifeConstants.ts` (`LIFE_CELL_MIX`, `LIFE_SCRIM_WEIGHT`); `ThemeProvider` interpolates
them into the expressions, and `lifeEngine.resolveLifeTokens` reads the resolved
values. The canvas element style (`LifeBackgroundCanvas.tsx`: `color:
var(--life-cell)` over `var(--body-bg)`) and the static chooser thumbnail
(`LifeThumbnail.tsx`: ground `var(--body-bg)`, cells `var(--life-cell)`, a final
`var(--life-dim)` SVG rect) consume the **same** expressions, so the preview cannot
promise a brighter field than the desktop delivers. Zero colour literal, zero
`var(--x)NN` alpha-append.

### Contrast guard

`lifeEngine.resolveLifeTokens` runs a cheap legibility guard at **token-resolution
time** (never per frame). It resolves the painted cell/ground pair and, if their WCAG
contrast ratio is below `LIFE_CONTRAST_MIN = 3`, returns the **untransformed** pair —
`--accent-strong` cells and no scrim (`dim = 'transparent'`). It is a safety net for
arbitrary user accents; if either colour is unparseable the authored dimmed pair is
kept (fail-safe — the engine never guesses a breach). `ctx.fillStyle` consumes the
`getComputedStyle`-resolved value, never `var()` directly.

### Pre-implementation contrast pre-validation (G-227)

Before implementation the exact painted pair was pre-validated offline over **all 18
built-in presets plus the `turbo` and `classic` bases (20 rows)**, using the same
sRGB `color-mix` + WCAG relative-luminance arithmetic the guard uses. Solarized is the
acceptance-binding row:

| Preset | `--accent-strong` baseline | `--life-cell` (dimmed) |
| --- | --- | --- |
| solarized (binding) | 3.741 | **3.970** |
| arctic | 4.616 | 5.440 |
| sunset | 4.754 | 5.635 |
| paper | 5.060 | 5.918 |
| light-default | 5.100 | 6.791 |
| dark | 11.497 | 12.064 |
| coffee | 10.145 | 10.981 |

**No shipped preset trips `LIFE_CONTRAST_MIN`** — every row sits at ≥ 3.97 : 1, the
cell mix raises the ratio on every preset, and the guard is therefore inert on the
shipped palette (it only fires on arbitrary user accents). The full 20-row sweep is
re-measured against **rendered pixels** by the tester (live leg).

## Reduced motion

When the OS `prefers-reduced-motion: reduce` preference is set, the engine paints
**exactly one seeded frame** and schedules **zero** rAF/timers — the animation is
removed, not paused. The canvas then stamps `data-life-motion="static"` and
`data-life-running="false"`, and the backdrop root stamps `data-motion="static"` with
no injected motion stylesheet. `None` remains the unchanged default.
