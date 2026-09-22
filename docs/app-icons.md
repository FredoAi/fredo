# App Icons — Source of Truth and Regeneration (Spec #2926, revised by #2930)

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
  icon master transcribes (one interior `<path>` drawn under the 58 rects,
  `shapeRendering="crispEdges"`).

One **committed SVG master** is the raster generator's only input:

| Master | Path | Used for |
|---|---|---|
| Full bust | `apps/tauri/src-tauri/icons/fredo-icon-large.svg` | **every** target size — all PNG artifacts, every ICO frame including 16 and 24, every ICNS element, and the Square/Store logos |

The former 16/24 px head-only master `apps/tauri/src-tauri/icons/fredo-icon-small.svg` is **removed**
(spec #2930): the file no longer exists, and no generator, test or doc path selects a second master.

The master is pure SVG (no external references), `shape-rendering="crispEdges"`, integer coordinates,
and carries **no colour outside the baked palette** (section 3).

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

Everything is pre-composed inside the square master, then rasterised with a single uniform scale —
**no stretch, ever** (brand misuse rule).

- **Tile:** a full-bleed, opaque, rounded **`#0c1117`** tile (brand dark), with **corner radius =
  12.5% of the canvas** (proportional, so the rounded-square intent survives at every size rather
  than a fixed pixel radius). Corners outside the radius are transparent.
- **Content box:** the figure sits inside an **86% content box** (safe-area inset) so OS masks and
  circular crops never clip the head or the eyes.
- **Uniform scale only:** the `1014:1264` figure is letterboxed/centred inside that content box with
  **one** uniform `scale(S)` about its bbox. A non-uniform `scale(sx, sy)` is forbidden and is
  mechanically rejected by the parity guard (section 5).
- **Size routing:** **every** target derives from the one full-bust master — the 16/24/32/48/64/128/
  256 px ICO frames, every ICNS element, every PNG artifact and the Square/Store logos. There is no
  per-size master choice.
  - **Targets ≥ 32 px** rasterise the master directly with the shared normalisation. 32 px — the
    most-seen small size (taskbar / Start menu) — is the faithful full bust (dome, eyes, bow-tie,
    body) and is byte-identical to the pre-#2930 render.
  - **Targets below 32 px (16 px and 24 px)** apply one **deterministic raster post-process** to the
    same master render: a 16× supersample, a block-average downsample and an accent-ink coverage
    snap (floor **`0.20` at 16 px, `0.15` at 24 px**) that resolves weak sub-pixel ink to solid
    pixels. This is a raster treatment of the **single** master — not a second master and not a
    per-size geometry change. Its documented residual is in section 7.

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

- `scripts/generate-app-icons.mjs` reads the one committed SVG master and rasterises every manifest
  row with the already-present root `sharp` dependency (no new packages, no network), packs
  `icon.ico` / `icon.icns`, and writes `apps/tauri/src-tauri/icons/manifest.sha256`.
  `--out <dir>` regenerates into an alternate directory (used by the determinism check).
- `scripts/check-app-icons.mjs` verifies: `tauri.conf.json` parses and its `bundle.icon` array is the
  frozen 5-path list; every listed path exists; every manifest row matches its declared pixel size
  and frame set; every artifact's sha256 matches `manifest.sha256`; and a fresh `--out` regeneration
  reproduces those hashes **byte-for-byte**. It exits non-zero with a named failure otherwise.

`tauri icon` is deliberately **not** used: it offers no deterministic small-size raster treatment and
its internals are an untraceable prebuilt binary.

Regeneration is a pure function of the committed master + the pinned palette: two consecutive runs
are byte-identical, and `tauri.conf.json` is untouched (`bundle.icon` keeps its 5 exact paths).

---

## 5. Parity / legibility guard

`apps/ui/src/shared/components/fredo-avatar/__tests__/iconSourceParity.test.ts` pins the raster
source to the frozen geometry so drift fails CI:

- the master's `<rect>` multiset equals `expandFredoRects(FREDO_AVATAR_SOURCE_RECTS)`, and its
  interior `<path d>` equals `buildInteriorPathD(expandFredoRects(FREDO_AVATAR_INTERIOR_RECTS))`;
- exactly one **uniform** `scale(...)` in the master's transform (no `scale(sx, sy)`);
- the master contains no colour outside `{#0c1117, #00D1D1, #0A373C}`;
- a second master cannot return: `fredo-icon-small.svg` must be **absent**, and
  `scripts/generate-app-icons.mjs` must contain no `SMALL_MASTER` / `master: 'small'` selection.

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
unchanged (`16, 24, 32, 48, 64, 128, 256`) and **every** frame derives from the one full-bust master —
the 16 px and 24 px frames carry its small-size raster snap (section 7).

**Explicitly scoped out:**

- `icons/android/**` and `icons/ios/**` — **deleted**. They are unreferenced by any in-repo config
  and mobile is not a shipped platform.
- `icon.icns` **is regenerated** for `bundle.icon` completeness and config validity, even though the
  **macOS bundle is not shipped** today.

---

## 7. 16 / 24 px treatment and its documented residual (below the 24 px brand floor)

The brand guide sets a **24 px minimum digital size**, while Windows genuinely renders taskbar icons
at **16 px**. One master must serve every size, so the master geometry stays **unchanged at every
size** — tile radius 12.5%, the **86% content box**, one uniform `scale(0.754619)`, no source stroke.
Neither geometry lever can lift the smallest features above a pixel: the canonical rim is 0.48 px at
16 px, and changing the content box from 86% to 96% would move it only to 0.54 px — still sub-pixel —
while breaking the frozen composition.

The mitigation is therefore at the **raster layer**, for targets **< 32 px** only (16 px and 24 px):
a **raster coverage snap** — a 16× supersample, a block-average downsample, then an accent-ink
coverage floor (**`0.20` at 16 px, `0.15` at 24 px**) that resolves any pixel at or above the floor to
solid ink, so nothing dissolves to grey. It is a deterministic post-process on the **single** master's
render: no second master, no authored small artwork, no per-size geometry, and every artifact at
≥ 32 px stays byte-identical.

**Residual versus the retired head-only control.** The snap restores a crisp full-bust *silhouette* —
a continuous dome outline, two distinct eye bars and body/limb ink — but the sub-pixel features the
retired head-only master resolved are lost:

- **head width ≈ 9.90 px vs the control's 14 px (≈ −29%)** — a one-master icon must carry the body in
  the same canvas, so the head cannot fill the tile the way a head-only master did;
- **eye separation ≈ 3.54 px vs 5 px (≈ −29%)** — both eyes stay distinct, but the face reads tighter;
- the **bow-tie / smile / interior fill bands** (0.11–0.18 px features) fall below the snap floor and
  drop to the tile / interior ground tone at 16 px — the "butler" identity cue is gone at that size;
- 16 px **remains below the brand's documented 24 px minimum**.

At 24 px the rim and most of the interior detail recover; 32 px and larger are unchanged and fully
detailed. This deviation is **gated to the smallest renders only** and is **not a general licence** to
render the brand below 24 px elsewhere.

---

## Non-goals

- No avatar redesign — the geometry is frozen; this is icon derivation only.
- No in-app surface changes; the token-rule exception never applies in-app.
- No `tauri.conf.json` change (`bundle.icon` keeps its exact 5 paths).
- No new dependencies — root `sharp` only.
- No runtime behaviour, IPC, row-pipeline or telemetry change.
