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
| Dim weights | `LIFE_CELL_MIX = 0.35` (cell blend toward the derived `--life-neutral`), `LIFE_NEUTRAL_BG_MIX = 0.3` (`--body-bg` share of that neutral), `LIFE_SCRIM_WEIGHT = 0.12` (`--overlay-bg` weight in the scrim → 7.2 % black) |
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

Three derived CSS custom properties carry the work. They are registered **once** in
`app/providers/ThemeProvider.tsx` (base pass, next to `--accent-strong`) as live
`color-mix()` expressions, so they re-resolve on any preset/accent change with no
restart and no per-preset values:

| Token | Expression | Meaning |
| --- | --- | --- |
| `--life-neutral` | `color-mix(in srgb, var(--text-primary) 70%, var(--body-bg) 30%)` | The **mid-luminance chroma leg**: `--text-primary` pulled toward the page surface, so the neutral sits mid-grey on every preset. |
| `--life-cell` | `color-mix(in srgb, var(--accent-strong) 65%, var(--life-neutral) 35%)` | Live-cell colour: the accent-strong cell blended 35 % toward the mid-neutral (lowers chroma on **both** light and dark presets). |
| `--life-dim` | `color-mix(in srgb, transparent 88%, var(--overlay-bg) 12%)` → `rgba(0, 0, 0, 0.072)` | Field-wide **7.2 %** black scrim composited over ground **and** cells. |

**Why the mix target had to change (round 2).** #2925's first cut blended the cell
20 % toward `--text-primary` directly. On light presets that token is near-black
(light-default `#0c1117`), so the blend was effectively a per-channel multiplicative
darken — and HSL saturation `S = (max−min)/max` is invariant under a uniform scale, so
the light leg's chroma barely moved (−0.025 modal, far under the ≥ 0.10 absolute gate).
Targeting the derived mid-luminance `--life-neutral` instead compresses the channel
range on both legs: the modal cell saturation drops ≈ 0.25 (light) / 0.14 (dark). The
smaller 7.2 % scrim also returns the light-preset ground under the shell chrome to
≥ 4.5:1 (see the AC3b gate below) while the field still dims materially (round-2
declared target: ≥ 14 % relative full-frame; QA hard floor ≥ 10 %).

`paint()` stays ground fill → cell pass, then adds **exactly one** final
`ctx.fillRect(0, 0, w, h)` with `tokens.dim` — constant cost, no per-cell alpha, no
second pass, no new allocation, no second rAF/timer. Because the scrim is
field-wide it dims both sides together and preserves the cell-vs-ground ratio.

`--life-cell` embeds `--life-neutral`, which is itself a `color-mix()`: the resolver's
`color-mix()` text is therefore **three levels** nested once the browser substitutes the
live custom properties. The guard's `parseColorMix` / `splitTopLevel` recursion is
nesting-depth-agnostic, so the guard resolves it (and falls back fail-safe if any shape
is unrecognised).

The three numeric weights are the single authored home in
`lifeConstants.ts` (`LIFE_NEUTRAL_BG_MIX`, `LIFE_CELL_MIX`, `LIFE_SCRIM_WEIGHT`);
`ThemeProvider` interpolates them into the expressions, and
`lifeEngine.resolveLifeTokens` reads the resolved values. The canvas element style
(`LifeBackgroundCanvas.tsx`: `color: var(--life-cell)` over `var(--body-bg)`) and the
static chooser thumbnail (`LifeThumbnail.tsx`: ground `var(--body-bg)`, cells
`var(--life-cell)`, a final `var(--life-dim)` SVG rect) consume the **same**
expressions, so the preview cannot promise a brighter field than the desktop delivers.
Zero colour literal, zero `var(--x)NN` alpha-append.

### Contrast guard

`lifeEngine.resolveLifeTokens` runs a cheap legibility guard at **token-resolution
time** (never per frame). It resolves the painted cell/ground pair and, if their WCAG
contrast ratio is below `LIFE_CONTRAST_MIN = 3`, returns the **untransformed** pair —
`--accent-strong` cells and no scrim (`dim = 'transparent'`). It is a safety net for
arbitrary user accents; it resolves the nested `color-mix()` chain at any depth (the
third-level `--life-neutral` leg included) and, if either colour is unparseable, the
authored dimmed pair is kept (fail-safe — the engine never guesses a breach).
`ctx.fillStyle` consumes the `getComputedStyle`-resolved value, never `var()` directly.

### Pre-implementation contrast pre-validation (G-227)

Before implementation the exact painted pair was pre-validated offline over **all 18
built-in presets plus the `turbo` and `classic` bases (20 rows)**, using the same
sRGB `color-mix` + WCAG relative-luminance arithmetic the guard uses. The tool is
`.opencode/tmp/2925/contrast-check.mjs`; it sweeps **both** legs — the dimmed
cell-vs-ground pair **and** the shell-chrome `--text-secondary`-over-dimmed-ground
pair — with the pre-dim (None / Life-absent control) and the post-fix values side by
side. Solarized is the acceptance-binding row.

**Leg 1 — dimmed cell-vs-ground (AC3a, floor ≥ 3 : 1).** Round-2 fixed column is the
round-2 arithmetic (`--life-cell` = accent-strong 65 % / neutral 35 %, scrim 7.2 %).

| Preset | #2915 baseline | round-1 (#2925) | round-2 fixed |
| --- | --- | --- | --- |
| solarized (binding) | 3.741 | 3.737 | **3.315** |
| light-default | 5.100 | 6.137 | 5.603 |
| arctic | 4.616 | 4.982 | 4.449 |
| sunset | 4.754 | 5.144 | 4.615 |
| paper | 5.060 | 5.362 | 4.701 |
| classic | 5.480 | 5.119 | 4.947 |
| turbo | 8.341 | 7.674 | 7.338 |
| nord | 7.470 | 6.573 | 6.082 |
| synthwave | 9.322 | 7.915 | 7.360 |
| high-contrast | 19.802 | 15.187 | 13.497 |
| dark | 11.497 | 9.422 | 8.658 |
| coffee | 10.145 | 8.673 | 8.073 |
| tokyo-night | 8.322 | 7.016 | 6.512 |
| monochrome | 21.000 | 15.968 | 14.139 |
| cyberpunk | 8.757 | 7.749 | 7.304 |
| deep-space | 9.326 | 8.109 | 7.603 |
| dracula | 8.690 | 7.820 | 7.326 |
| matrix | 16.039 | 12.521 | 11.214 |
| terminal-green | 10.797 | 8.927 | 8.212 |
| blueprint | 12.784 | 10.360 | 9.230 |

**20/20 rows ≥ 3 : 1; solarized 3.315 leaves 10.5 % headroom; no row trips
`LIFE_CONTRAST_MIN`.** The guard is therefore inert on the shipped palette (it only
fires on arbitrary user accents). The full 20-row sweep is re-measured against
**rendered pixels** by the tester (live leg). `--life-neutral` is derived from tokens
already in the AC4 consumption contract, so the unconsumed-token negative pin
(`cardBg`) still holds.

**Leg 2 — shell chrome (`--text-secondary`) over the dimmed ground (AC3b).**

| Preset | pre-dim (None) `R0` | round-1 `R1` | round-2 fixed `R1` | tier | verdict |
| --- | --- | --- | --- | --- | --- |
| light-default | 5.425 | 4.125 | **4.619** | A | PASS |
| dark | 7.464 | 7.575 | 7.531 | A | PASS |
| monochrome | 7.838 | 7.838 | 7.838 | A | PASS |
| cyberpunk | 6.821 | 6.870 | 6.851 | A | PASS |
| deep-space | 5.637 | 5.704 | 5.677 | A | PASS |
| matrix | 6.405 | 6.405 | 6.405 | A | PASS |
| coffee | 5.913 | 6.058 | 6.002 | A | PASS |
| synthwave | 5.325 | 5.430 | 5.389 | A | PASS |
| terminal-green | 4.919 | 4.953 | 4.939 | A | PASS |
| high-contrast | 15.908 | 15.908 | 15.908 | A | PASS |
| blueprint | 6.712 | 7.251 | 7.034 | A | PASS |
| classic | 5.004 | 5.143 | 5.088 | A | PASS |
| turbo | 5.327 | 5.409 | 5.377 | A | PASS |
| tokyo-night | 2.762 | 2.858 | 2.820 | B | PASS |
| solarized | 2.479 | 1.888 | 2.113 | B | PASS |
| arctic | 4.240 | 3.232 | 3.614 | B | PASS |
| dracula | 3.026 | 3.238 | 3.153 | B | PASS |
| sunset | 4.368 | 3.330 | 3.725 | B | PASS |
| nord | 3.496 | 3.825 | 3.692 | B | PASS |
| paper | 3.474 | 2.649 | 2.962 | B | PASS |

**0 Tier A failures, 0 Tier B failures.** Only light-default was newly broken by
round 1 (4.125 → below 4.5); round 2 restores it to **4.619** with margin, and every
Tier B row stays within the ≤ 20 % relative-loss tolerance.

**Round-2 declared targets (the tester re-measures these live).** AC1a: light-based
full-frame mean-luminance reduction **≥ 14 % relative** (round-1 spent 25.8 % against a
chrome floor it had not priced in; the QA hard floor is ≥ 10 %), dark-based painted-pixel
mean **≥ 18 % relative** (round-1 −21.1 %). AC1b: dominant-hue mean saturation reduction
**≥ 0.10 absolute** on one light + one dark preset (round-2 arithmetic ≈ −0.25 light /
−0.14 dark), with the non-neutralisation guard `S_post ≥ 0.10`. AC3a: every row ≥ 3 : 1
(solarized binding at 3.315). AC3b: the two-tier gate below. Round-1's `PIXEL_DELTA_MIN`
and floor values are untouched — the smaller scrim increases per-channel deltas.

#### AC3b shell-chrome gate (two-tier, binding)

The absolute ≥ 4.5 : 1 normal-text floor is **arithmetically unreachable** on some light
presets under *any* backdrop dim: their Life-absent (None) controls are already below
4.5 : 1, because `--text-secondary` on the undimmed ground is itself sub-floor
(solarized 2.48, paper 3.47, arctic 4.24, sunset 4.37). No dim can raise a pre-existing
sub-4.5 pair, and a pure-white ground is the arithmetic maximum. The binding gate (UI/UX
disposition on the `## Fix Plan (round 2)`) is therefore **two-tier**:

- **Tier A** — where the None / Life-absent control `R0 ≥ 4.5 : 1`, the dimmed `R1` MUST
  stay `≥ 4.5 : 1`.
- **Tier B** — where `R0 < 4.5 : 1`, `R1 ≥ 0.80 × R0` (≤ 20 % relative loss; the
  Weber–Fechner materiality rule). There is NO secondary 3.0 floor for 16 px normal text.

In-scope pairs (chrome rendered directly on the raw field, with no opaque plate): the
clock (`--text-secondary` 16 px / 500) and the nav-hint labels (`--text-secondary`
11 px / 300). Out of scope, with reasons: the FREDO wordmark and `ESC` text (opaque
`--card-bg` plates), window / command-bar content (background-invariant), decorative
ticks / `+` / frame (3 : 1-exempt), and the status LED / chrome-over-a-lit-cell
(pre-existing sub-floor pairs).

## Reduced motion

When the OS `prefers-reduced-motion: reduce` preference is set, the engine paints
**exactly one seeded frame** and schedules **zero** rAF/timers — the animation is
removed, not paused. The canvas then stamps `data-life-motion="static"` and
`data-life-running="false"`, and the backdrop root stamps `data-motion="static"` with
no injected motion stylesheet. `None` remains the unchanged default.
