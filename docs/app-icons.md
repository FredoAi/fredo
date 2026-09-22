# App Icons — Source of Truth and Regeneration (Spec #2926)

This document is the reproducibility record (AC5 / R-5) for Fredo's **shipped OS-level app icon
set** under `apps/tauri/src-tauri/icons/`. It exists so a future brand tweak can regenerate the whole
set from a committed source with one command, instead of reverse-engineering the pipeline.

Shell-only surface: this is a **static shipped raster** asset consumed by the Tauri bundle. It has no
runtime path — no Rust, no TypeScript product code, no IPC/row-pipeline/telemetry involvement — and
nothing in this document changes how the in-app avatar renders.

---

## 1. Source of truth

The icon is derived from the **canonical SVG geometry** — the same geometry every in-app brand
surface renders:

- `apps/ui/src/shared/components/fredo-avatar/fredoAvatarGeometry.ts` — the frozen 58-rect figure
  (`FREDO_AVATAR_SOURCE_RECTS` expanded by `expandFredoRects`) and the interior fill bands
  (`FREDO_AVATAR_INTERIOR_RECTS`, flattened by `buildInteriorPathD`), in the `1014 × 1264`
  reference space (`FREDO_AVATAR_SPACE` / `FREDO_AVATAR_VIEWBOX`).
- `apps/ui/src/shared/components/fredo-avatar/FredoAvatar.tsx` — the canonical in-app SVG that the
  icon masters transcribe (one interior `<path>` drawn under the 58 rects,
  `shapeRendering="crispEdges"`).

Two **committed SVG masters** are the raster generator's only inputs:

| Master | Path | Used for |
|---|---|---|
| Large (full bust) | `apps/tauri/src-tauri/icons/fredo-icon-large.svg` | target sizes **≥ 30 px** |
| Small (head-only) | `apps/tauri/src-tauri/icons/fredo-icon-small.svg` | target sizes **16 px and 24 px** |

Both masters are pure SVG (no external references), `shape-rendering="crispEdges"`, integer
coordinates, and carry **no colour outside the baked palette** (section 3).

### Not the source

`.opencode/wireframes/fredo-avatar.png` is **NOT** the icon source, and neither is any other retired
bitmap. That reference PNG:

- bakes a black background + a cyan **glow** (`box-shadow`/blurred layer in
  `.opencode/wireframes/fredo-avatar.html`), which the brand misuse rules forbid ("don't add
  effects"); and
- is the **pre-#2917 hollow figure** — it has no interior fill, so deriving from it would silently
  drop the solid interior shipped by #2917 / #2922.

The four legacy in-app bitmaps (`apps/ui/src/assets/fredo-logo.png`, `fredo-logo-trimmed.png`,
`fredo-logo-icon.png`, `fredo.png`) were grep-verified unreferenced and **deleted** (NFR-5, ST-4), so
the icon's source of truth cannot silently be a stale pre-#2850 duplicate.

---

## 2. Composition

Everything is pre-composed inside each square master, then rasterised with a single uniform scale —
**no stretch, ever** (brand misuse rule).

- **Tile:** a full-bleed, opaque, rounded **`#0c1117`** tile (brand dark), with **corner radius =
  12.5% of the canvas** (proportional, so the rounded-square intent survives at every size rather
  than a fixed pixel radius). Corners outside the radius are transparent.
- **Content box:** the figure sits inside an **86% content box** (safe-area inset) so OS masks and
  circular crops never clip the head or the eyes.
- **Uniform scale only:** the `1014:1264` figure is letterboxed/centred inside that content box with
  **one** uniform `scale(S)` about its bbox. A non-uniform `scale(sx, sy)` is forbidden and is
  mechanically rejected by the parity guard (section 5).
- **Size routing:**
  - **16 px / 24 px → the small master** — a `viewBox="0 0 16 16"`, grid-aligned **head-only**
    transcription of the canonical head (dome + two mirror-symmetric eyes), rim raised to the
    1-unit grid minimum. Every feature is ≥ 1 grid unit, i.e. ≥ 1 px at a 16 px render. The body /
    bow-tie / smile are deliberately omitted there because they would be sub-unit noise. 24 px uses
    the same master rasterised at 1.5× (no re-authoring).
  - **≥ 30 px → the large master** — the faithful full bust (dome, eyes, bow-tie, body) with the
    canonical rim. This keeps **32 px** (the most-seen small size — taskbar / Start menu) full-bust
    and removes any "swapped mascot" discontinuity across the 32→44 band.

**Why the opaque tile:** the avatar is a cyan *outline*. A transparent mark would vanish on one of
the two taskbar grounds; the opaque tile supplies its own ground, so the mark reads on both light and
dark taskbars.

---

## 3. Baked palette and the token-rule exception (explicit and narrow)

Baked literals:

| Role | Value |
|---|---|
| Tile | `#0c1117` (brand dark — `apps/ui/src/app/types/theme.ts` `bodyBg`, dark preset) |
| Rim + eyes (ink) | `#00D1D1` (brand primary cyan — `theme.ts` `accentPrimary`) |
| Interior | `#0A373C` (20% cyan over brand dark: `0.2·#00D1D1 + 0.8·#0c1117`) |
| Tile corner radius | `12.5%` of canvas |

**Token-rule exception.** `AGENTS.md` requires all colours to come from the theming feature and
forbids hardcoded hex/rgba. An **OS app icon is a static shipped raster** and cannot follow the
theming feature's CSS variables, so it necessarily bakes a fixed palette. This is a deliberate,
**narrow** exception:

- it applies **only to the static icon asset**;
- the baked values are the implemented brand tokens (verified against `theme.ts`), not invented
  values;
- it must **never leak into in-app surfaces** (the in-app interior stays
  `var(--fredo-avatar-interior)` = `color-mix(in srgb, var(--accent-primary) 20%, var(--body-bg))`,
  set by `ThemeProvider.tsx` / `system.ts`); and
- it is **not a precedent** — no other surface may adopt these literals.

---

## 4. Regeneration commands

```sh
pnpm icons:generate     # -> node scripts/generate-app-icons.mjs
pnpm icons:check        # -> node scripts/check-app-icons.mjs
```

- `scripts/generate-app-icons.mjs` reads the two committed SVG masters and rasterises every manifest
  row with the already-present root `sharp` dependency (no new packages, no network), packs
  `icon.ico` / `icon.icns`, and writes `apps/tauri/src-tauri/icons/manifest.sha256`.
  `--out <dir>` regenerates into an alternate directory (used by the determinism check).
- `scripts/check-app-icons.mjs` verifies: `tauri.conf.json` parses and its `bundle.icon` array is the
  frozen 5-path list; every listed path exists; every manifest row matches its declared pixel size
  and frame set; every artifact's sha256 matches `manifest.sha256`; and a fresh `--out` regeneration
  reproduces those hashes **byte-for-byte**. It exits non-zero with a named failure otherwise.

`tauri icon` is deliberately **not** used: it derives every frame from a single source (no per-size
treatment) and its internals are an untraceable prebuilt binary.

Regeneration is a pure function of the committed masters + the pinned palette: two consecutive runs
are byte-identical, and `tauri.conf.json` is untouched (`bundle.icon` keeps its 5 exact paths).

---

## 5. Parity / legibility guard

`apps/ui/src/shared/components/fredo-avatar/__tests__/iconSourceParity.test.ts` pins the raster
source to the frozen geometry so drift fails CI:

- the large master's `<rect>` multiset equals `expandFredoRects(FREDO_AVATAR_SOURCE_RECTS)`, and its
  interior `<path d>` equals `buildInteriorPathD(expandFredoRects(FREDO_AVATAR_INTERIOR_RECTS))`;
- exactly one **uniform** `scale(...)` in the large master's transform (no `scale(sx, sy)`);
- the small master's `viewBox` is `0 0 16 16`, every rect is integer within `[0,16]`, every `w`/`h`
  is ≥ 1 unit, the two eyes are mirror-symmetric about the centre and in the upper half, and the tile
  is the only full-canvas rect;
- neither master contains a colour outside `{#0c1117, #00D1D1, #0A373C}`.

---

## 6. Platform scope

**Regenerated and shipped (Windows — the only shipped platform today):**

- the 5 `bundle.icon` paths in `apps/tauri/src-tauri/tauri.conf.json`: `icons/32x32.png`,
  `icons/128x128.png`, `icons/128x128@2x.png`, `icons/icon.icns`, `icons/icon.ico`;
- the derived Windows family: `icons/icon.png`, `icons/64x64.png`, the `Square*Logo.png` set and
  `StoreLogo.png`;
- `icons/manifest.sha256` (path + sha256 of every artifact).

`icon.ico` is the sole source of the built `.exe` / taskbar / Start-menu / window-chrome / NSIS
installer icon (the Windows bundle config declares no separate Windows icon path). Its frame set is
unchanged (`16, 24, 32, 48, 64, 128, 256`); only which master each frame derives from is routed —
16/24 from the small head-only master, 32+ from the large full-bust master.

**Explicitly scoped out:**

- `icons/android/**` and `icons/ios/**` — **deleted**. They are unreferenced by any in-repo config
  and mobile is not a shipped platform.
- `icon.icns` **is regenerated** for `bundle.icon` completeness and config validity, even though the
  **macOS bundle is not shipped** today.

---

## 7. Documented small-size deviation (16 px, below the 24 px brand floor)

The brand guide sets a **24 px minimum digital size**, while AC3 requires a **16 px** render because
Windows genuinely renders taskbar icons at 16 px. This is an acknowledged, documented deviation:
16 / 24 px are handled by the deliberate **grid-aligned head-only small master** with a derived
**≥ 1-grid-unit presence floor** (nothing vanishes to resampling), instead of a naive downscale of
the `1014 × 1264` figure (whose canonical rim would be ~0.6 px at 16 px — a provable blur).

This deviation is **gated to the small renders only** and is **not a general licence** to render the
brand below 24 px elsewhere.

---

## Non-goals

- No avatar redesign — the geometry is frozen; this is icon derivation only.
- No in-app surface changes; the token-rule exception never applies in-app.
- No `tauri.conf.json` change (`bundle.icon` keeps its exact 5 paths).
- No new dependencies — root `sharp` only.
- No runtime behaviour, IPC, row-pipeline or telemetry change.
