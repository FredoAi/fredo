# fredo-avatar — Functional Tests

> The 3D character cut-over (base). AC3 = R-3 (accent drives the body, live) and AC4 = R-4
> (graceful degradation, no layout shift). Scope requirements SC-1..SC-3 are regression evidence
> and MUST NOT be counted as AC proof.
>
> **Verification policy: live.** Every visual leg is a LOCAL CAPTURE from the live dev app
> (`tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3210/e2e/…")`,
> MCP driver `com.fredo.app`); jsdom cannot render the scene. Each visual row names its capture
> **and** the DOM facts read in the same `execute_js` task beside it — a visual row is never
> UNVERIFIED by construction. Upload the captures to the round's `## Tests Runs` comment
> (`gh image`) — the posted comment is the durable record (G-415).
>
> **Tag legend:** `[NEW]` must redden on the pre-change tree (name the control); `[RETAINED]` /
> `[GUARD]` are green today and must stay green.

## The 12-state recipe table (validated against the shipped mapping, G-220/G-223)

| State | Recipe |
|---|---|
| `idle` | companion at rest, no interaction |
| `greeting` | companion switch OFF→ON (welcome ambient), sample `t < 1500 ms` (`GREETING_BEAT_MS`) |
| `talk` | the same turn-on at `1500 ms ≤ t < ~4000 ms` (`TALK_HOLD_MS`) |
| `thinking` | bar send / joke before the first token |
| `joking` | first token of the joke stream |
| `happy` | the completion settle (`HAPPY_HOLD_MS = 5000`) |
| `playful` | 12 s sustained rest (`useFredoRestingCadence` 12000/1800) |
| `listening` | hold Space on the focused EMPTY launcher bar (`down` → ≥300 ms → `up`) |
| `working` | bar send `open Mission Monitor` (live `llm-skill-call`, 900 ms beat) |
| `error` | bar send `open NotARealApp` (non-success reply, 8000 ms hold) |
| `teleport-out` | Ctrl+right-click in the main window |
| `teleport-in` | Ctrl+right-click inside `run-cli-terminal` (arrival) |

> `open notepad` is a STALE recipe (G-223) — it exists only as a unit-test fixture and fails
> closed live. Sub-second states (`greeting`, `working`) need the in-page recorder, never a
> serial driver round-trip.

---

## F-AV-1 `[NEW]` (R-4a) — the poster is painted before the character asset is available

- [ ] F-AV-1: Install an in-page recorder on the avatar root before forcing a remount:
      a `MutationObserver` on `[data-avatar-render]` plus a `requestAnimationFrame` loop that, per
      frame, records `{render, canvasCount, posterRect}`. Then force a remount (companion toggle
      OFF→ON) and, separately, a state change that re-keys the wrapper (`key={animKey}`,
      `CompanionEntity.tsx:1858` — a teleport). Capture the FIRST recorded frame
      (`r4a-poster-first-frame.jpeg`) and the settled frame (`r4a-settled.jpeg`).
  **Expected:** the FIRST recorded entry after each remount is `data-avatar-render="poster"` with
      `[data-avatar-poster-layer]` mounted and `posterRect` equal to the avatar root's box; the
      `live` entry (if any) comes later and is accompanied by `[data-avatar-canvas]`; **no recorded
      frame is blank** (the poster layer's rect never collapses and is never 0×0).
      **Control (pre-change):** the recorder's first entry is `null` — the attribute does not exist
      — so the row reddens on the pre-change tree.
  - **Edge:** the asset already cached (module scope) still paints the poster on the first frame
    after a remount; the poster→live crossfade must not move the box; a remount mid-crossfade.

## F-AV-2 `[NEW]` (R-4b) — live 3D unavailable ⇒ the poster for the whole mount (asset lever)

- [ ] F-AV-2: Record `Get-FileHash` (SHA-256) of `apps/ui/public/avatar/fredo-character.glb`, then
      **move it** to `.opencode/tmp/3210/lever/`. Hard-reload the dev app, read the avatar root for
      the whole mount, capture `r4b-unavailable.jpeg`. **Restore the file** and re-verify its
      SHA-256 equals the recorded digest.
  **Expected:** for the entire mount `data-avatar-render="poster"`, `[data-avatar-canvas]` count
      **0**, `data-avatar-clip` and `data-avatar-body-color` **absent** (live-only hooks), poster
      pixels non-background (F-AV-5), no app-level `Error:`/`Uncaught` in the console (one
      failed-resource log line for the missing file is expected and is not an app error).
      After restore: digest matches and a reload returns the surface to `live`.
  - **Edge:** restore is verified BEFORE any later live row runs (a stale lever poisons every
    subsequent row — paste the digest into the verdict); both surfaces.
  - **Note:** the `webglcontextlost` / unsupported-capability legs are unit-seam rows in
    `three/avatarRenderer` + `avatarCapability`, not this lever.

## F-AV-3 `[NEW]` (R-4) — exact reserved footprint, no layout shift (both shipped surfaces)

- [ ] F-AV-3: In ONE `execute_js` task, for the launcher seat surface (companion OFF ⇒
      `.fredo-avatar-idle`; companion ON-at-home ⇒ `.fredo-companion-avatar`) and for the away
      overlay, read: `[data-avatar-render]`'s `getBoundingClientRect()`, `offsetWidth/Height`,
      `scrollWidth/scrollHeight`, the seat slot wrapper's rect, and the launcher command bar's `y`
      — once while `data-avatar-render="poster"` and once when it is `live`. Capture
      `r4c-footprint-poster.jpeg` + `r4c-footprint-live.jpeg`.
  **Expected:** both surfaces `offsetWidth=80`, `offsetHeight=100`; `scrollWidth/scrollHeight` never
      exceed the client box; the rect is IDENTICAL between the poster and live readings (Δ = 0 on
      x/y/w/h); the seat slot stays 80×100 + the `mb="4"` band; the command-bar `y` is constant
      within ±1 px; no new scrollbar/overflow.
  - **Edge:** window at the 900×600 minimum; companion OFF / ON-at-home / away; resize mid-idle; the
    poster→live crossfade; the re-keyed wrapper (F-AV-1).
  - **`md` 132×165 is NOT a live leg** — no shipped surface renders `size="md"` (verified:
    `LauncherShell.tsx:1765,1773` and `CompanionEntity.tsx:1875,1882` are all `sm`). The `md` leg is
    `regression.md` R-AV-5 (component).

## F-AV-4 `[NEW]` (R-4c) — reduced motion renders one still frame and runs no animation loop

- [ ] F-AV-4: jsdom (G-053 — the live webview cannot be flipped to `reduce`): stub
      `matchMedia('(prefers-reduced-motion: reduce)')` → `{matches:true}`, render `FredoAvatar`
      through the **production** poster path, install a fake renderer through
      `setAvatarRendererFactoryForTests` counting `render()` calls and RAF ticks.
  **Expected:** `data-avatar-motion="still"`; exactly **ONE** renderer draw for the mount and
      **zero** RAF ticks after it; `resolveAvatarMotion(state, streaming, true) === 'still'` for all
      12 states; no animation on the avatar root.
  - **UI/UX §5 / UX-4 binding:** the still frame is the **LIVE 3D path, not the poster** —
    `data-avatar-render` stays `live` (canvas present, poster `visibility: hidden`) and each state's
    still is distinguishable from `idle` (UI/UX §4's table is the checklist). Substituting the poster
    would make all 12 states look like `idle` — a regression, not a pass.
  - **Edge:** `talk` streaming AND not streaming; a one-shot (`teleport-out`) must not loop; the
    poster path must not spin.
  - This is the ONLY row where reduced motion is proven (a live flip is impossible — record the
    blocker, never a static-CSS-only PASS for R-4c).

## F-AV-5 `[NEW]` (R-4) — "no blank seat" is measured in every degraded leg

- [ ] F-AV-5: In both the poster-before-load leg and the unavailable-lever leg, capture the avatar
      box as a lossless crop and compute a DENSE per-pixel diff against a same-task control where
      `[data-avatar-poster-layer]` is `display:none` (T = 8, 8-bit).
  **Expected:** the ink area is **non-zero** in both legs (the figure is painted) and the control
      reads the backdrop; report the ink pixel count per leg and the box rect (Δ = 0 vs F-AV-3).
  - **Edge:** both themes; report the fill-vs-backdrop sensitivity margin; the first frame after a
    remount (cross-checked by F-AV-1's recorder).

## F-AV-6 `[NEW]` (R-3a) — the accent re-tints the body live, with no remount and no flash

- [ ] F-AV-6: With the companion ON and a NON-idle state active, stamp the canvas
      (`document.querySelector('[data-avatar-canvas]').dataset.qaMarker='m1'`), then change the
      accent via `input[aria-label="Primary color"]` (`ThemingSettings.tsx:150-152`); read
      `data-avatar-body-color`, `data-avatar-render`, the marker, and the console after 2 frames.
      Capture `r3a-body-before.jpeg` before and `r3a-body-after.jpeg` after (same box).
  **Expected:** `data-avatar-body-color` changes to a value consistent with the new
      `--accent-primary` within 2 animation frames; the marker survives (SAME canvas element — no
      remount); `data-avatar-render` stays `live`; no `Error:`/`Uncaught`; the after-capture's body
      region differs from the before-capture while the box is unchanged.
      **Control (pre-change):** `data-avatar-body-color` does not exist → red.
  - **Edge:** accent changed mid-stream (`data-streaming="true"`) and mid-teleport; 5 rapid
    successive changes (no re-render loop); the window hidden then shown (the resume must read the
    CURRENT `--accent-primary`, never the mount snapshot).

## F-AV-7 `[NEW]` (R-3b) — the poster re-tints with the accent too

- [ ] F-AV-7: With the asset lever active (F-AV-2), change the accent; read the poster layer's
      computed `background-color`/mask colour before/after; capture `r3b-poster-after.jpeg`.
  **Expected:** the poster body colour follows the new accent within 2 frames with no reload; no
      canvas exists; the box is unchanged (the fallback is not a frozen picture of the accent).
  - **Edge:** both surfaces; a change while the window is hidden then shown.

## F-AV-8 `[NEW]` (R-3c) — wardrobe and effects keep their AUTHORED colours

- [ ] F-AV-8: (i) Unit leg through the renderer seam on a material tree named from the shipped
      manifest: call `applyAvatarTint(scene, palette)` twice with two accents and diff EVERY
      material's colour. (ii) Live corroboration: zoomed captures of one state under two accents,
      `r3c-authored-a.jpeg` / `r3c-authored-b.jpeg`, reading the dressed regions.
  **Expected:** only the four tint-target materials change colour — the body family (`fredo_body`,
      `fredo_limb`, `fredo_boot`) tracks `palette.body` (the live accent) and `fredo_accent` tracks
      `palette.detail` (`mixSrgb(accent, textPrimary, .55)`, the shipped `--accent-strong` weights —
      UI/UX §6); **every other material's colour hex equals its AUTHORED value in both passes**
      (G-419: assert the material's colour, never a screenshot's plausibility); the live pair shows
      the wardrobe/brass regions unchanged while the body region changed.
  - **Edge:** Doom accent; a poster leg (the detail PNG is authored colour and must not be tinted);
    a state with FX.

## F-AV-9 `[NEW]` (R-3d) — no avatar colour originates outside the theme/accent contract

- [ ] F-AV-9: Comment-stripped colour scan (the committed scanner's own semantics:
      `apps/ui/src/app/theme/contrast/rawColorScan.ts:43-51` — patterns `#[0-9a-fA-F]{3,8}\b`,
      `\b(?:rgba?|hsla?)\s*\(`, `var\(--[a-z0-9-]+\)[0-9]`, comments stripped before matching) of
      the avatar tree `apps/ui/src/shared/components/fredo-avatar/**` (`*.ts`/`*.tsx`/`*.css`; incl.
      `three/**`, `useAvatarRenderer.ts`, `AvatarPoster.tsx`, `__tests__/**`), reporting file:line
      for EVERY hit. Run a **non-vacuity control**: a planted probe file in the PRODUCT tree
      carrying `#ff00ff` must be reported (remove the probe afterwards).
  **Expected:** the avatar **product** modules — the tree minus `__tests__/`/`__mocks__`/
      `*.test.*`, the canonical `NON_SOURCE` rule at `rawColorScan.ts:108` — carry **zero hits** of
      every class; the corrected `\brgb\(` count in the product tree is 0 (`avatarPalette.ts`'s
      `rgb()` mentions are prose in comments, stripped). A **widened** scan over `__tests__/` runs
      as a hiding-place check: its ONLY permitted colour literals are the **re-pointed
      icon-provenance guard** `__tests__/iconSourceParity.test.ts`'s own provenance pin — five hex
      literals (`#0c1117`, `#00d1d1`, `#0a373c`, `#00D1D1`, `#0A373C`; re-count the guard's current
      text — the requirement is NON-ZERO, never a frozen number) — **permitted and expected
      non-zero**, because it pins the ICON ARTIFACT's baked palette (R-AV-1), not an avatar colour.
      A colour literal in any OTHER test file is a FAIL. Issue-number references in `describe()`
      titles (`#3210`, `#2917`, …) are NOT colour literals, and an EMPTY-argument grammar mention
      (`rgb()` / `rgba()` in a test title describing the parser's accepted forms —
      `avatarPalette.test.ts:107,216`) is prose, not a colour call: list both as non-colour and do
      not count them. The planted `#ff00ff` probe is reported (the scan is live);
      `data-avatar-body-color` is runtime DATA (exempt, named); the avatar's only colour inputs are
      `--accent-primary` and `--text-primary`.
  - **Reddens after the change:** a hex/rgb/rgba/hsl/hsla literal added to any avatar PRODUCT
    module; a colour literal in a second test file (hex, or a real `rgb(...)`/`rgba(...)`/
    `hsl(...)`/`hsla(...)` call with arguments); the planted probe not reported (a dead/vacuous
    scan); the guard's provenance pin emptied to force a zero (also a FAIL of R-AV-1).
  - **Edge:** the frozen icon provenance SVG + its baked palette are the allowlisted ARTIFACT, not
    avatar code; `var(--x)NN` alpha-append in avatar product code is a hit (#2770).
  - This row is a supplementary gate inside the live policy — it is corroborated by F-AV-6/F-AV-8,
    never counted alone.

## F-AV-10 `[NEW]` (R-3e) — the Doom leg: the body re-tints, and the base renders no armour

- [ ] F-AV-10: Engage Doom Mode (`iddqd`, real engine); read `data-avatar-body-color`, the computed
      `--accent-primary`, and assert the doom/armour hooks are absent; capture `r3e-doom.jpeg`; exit
      and re-read.
  **Expected:** `data-avatar-body-color` equals the Doom-resolved `--accent-primary`
      (`doomTheme.ts:39`) with no reload and no remount; `[data-avatar-doom-phase]`,
      `#fredo-armor`, `data-doom-armor` are ABSENT (the base renders no armour — the disclosed
      interim, U-9); on exit the body returns to the theme accent.
  - **Edge:** release-mid-`doom-in`, the weapon cycle and the armour clips are **#3223's** and MUST
    NOT be asserted here.

## F-AV-11 `[NEW]` (SC-1) — both surfaces render the character at their reserved footprint

- [ ] F-AV-11: Read the launcher seat in its three states (companion OFF ⇒ `.fredo-avatar-idle`;
      ON-at-home ⇒ `.fredo-companion-avatar`; away ⇒ `EmptySeat`) and the away overlay surface;
      per surface count `[data-avatar-render]`, read `offsetWidth/Height`, the seat slot's box and
      the command bar's `y`. Capture `sc1-seat.jpeg` + `sc1-overlay.jpeg`.
  **Expected:** exactly ONE `[data-avatar-render]` per mounted surface; each is 80×100; the seat
      slot + command-bar `y` are unchanged vs the pre-change tree (±1 px); the away overlay renders
      the same character (never blank, never the SVG). **Control (pre-change):**
      `[data-avatar-render]` count 0 → red.
  - **Edge:** exactly one Fredo at a time (#2853/#2870); `EmptySeat` is `data-state="away"` and is
    OUT of the avatar class.

## F-AV-12 `[NEW]` (SC-1) — the 12 states render their own clip; `idle` only for `idle`

- [ ] F-AV-12: Drive each of the 12 `FREDO_AVATAR_STATES` through the recipe table above; per state
      read `data-avatar-clip`, `data-state`, `aria-label` on every rendering surface; capture
      `state-<name>-sm.jpeg` per state.
  **Expected:** for all 12, `data-avatar-clip === <state>` (the mixer's APPLIED clip) and
      `data-state === <state>`; **`idle` is the only state whose applied clip is `idle`** (each of
      the other 11 must report its own clip — this is the "not `idle` for everything" clause);
      `aria-label="Fredo companion -- <state>"`; both surfaces report the same clip when they
      resolve the same state; one capture per state. **Control (pre-change):** `data-avatar-clip`
      absent → red.
  - **Edge:** sub-second states via the in-page recorder (G-220); **pairwise pixel-delta
    perceptibility is AC1 = #3224's row** — here distinctness is clip identity + a vision read of
    the captures; do NOT bind an uncommitted pixel-delta instrument (a Toolsmith gap owned by
    #3224). An unreachable recipe is a BLOCKED-harness (named), never a static PASS.
  - **UI/UX §4 / UX-6 binding:** the 12 captures are read against §4's table (clip motion + prop
    marker + "how it differs from idle at a glance"). **Six states carry props** — `greeting` hat,
    `thinking` bubble + monocle, `working` tray + glasses, `error` exclamation, `teleport-out`/
    `teleport-in` ring + flash + sparks: **no character geometry may be clipped** by the frame edge
    (character-attached props must stay inside; pure FX may bleed). The three ⚠ states
    (`listening`/`working`/`greeting`) are REPORTED as a legibility concern with #3224 named as the
    perceptual-floor owner — never patched here (one render path).

## F-AV-13 `[NEW]` (SC-2) — the SVG render path is gone

- [ ] F-AV-13: Run the executed grep for `fredoAvatarGeometry`, `fredo-avatar\.css`,
      `#fredo-expression`, `#fredo-armor`, `data-doom-armor`, `FREDO_AVATAR_VIEWBOX`,
      `FREDO_AVATAR_SOURCE_RECTS`, `expandFredoRects`, `buildInteriorPathD`, `FredoRect` over the
      repo; disposition EVERY hit; read both barrels; run `pnpm --filter @fredo/ui build`.
  **Expected:** hits allowed ONLY in (a) the frozen icon provenance SVG + its re-pointed guard,
      (b) docs recording the retirement, (c) durable-suite ABSENCE assertions and the ledger rows
      this spec writes. Every other hit is a FAIL. Both barrels export none of the deleted symbols;
      the build exits 0. **Non-vacuity control:** the same grep on the pre-change tree (or a
      planted probe) returns hits, so the scan is live.
  - **Edge:** the icon SVG must stay byte-identical (its header comment names `buildInteriorPathD`
    — allowlisted); a suite sentence asserting ABSENCE is compliance (judge polarity); do NOT
    comment-strip here — the AC bans the surface, not only its use.

## F-AV-14 `[NEW]` (SC-2) — one render path at runtime

- [ ] F-AV-14: Per mounted surface enumerate `[data-avatar-render]`, `[data-avatar-canvas]`,
      `[data-avatar-poster-layer]`, and `svg` INSIDE the avatar root; count them.
  **Expected:** one avatar root, one poster layer, at most one canvas, **zero** `svg` descendants
      inside the avatar root; no second avatar-implementing component renders (class anchor
      `[data-avatar-render]`, G-403).
  - **Edge:** poster + canvas coexist during the crossfade (one path, two layers); `EmptySeat` is
    out of the class.

## F-AV-15 `[NEW]` (SC-2 / NFR) — the asset is a real file, loaded lazily, never inlined

- [ ] F-AV-15: After a cold reload, read `performance.getEntriesByType('resource')` for
      `/avatar/fredo-character.glb` (name, initiatorType, transferSize, encodedBodySize) and for the
      two poster PNGs; read the built `apps/ui/dist/assets/*.js` for `data:` base64 payloads / the
      `glTF` magic.
  **Expected:** ONE resource entry for the GLB with `transferSize > 0` and decoded size
      3,554,176 B; the JS chunks contain NO `data:application/octet-stream;base64` and no `glTF`
      header; the committed copy in `apps/ui/public/avatar/` is byte-identical to the authoring GLB
      (SHA-256). **Control (pre-change):** no such request → red.
  - **Edge:** a remount must NOT re-fetch (exactly one entry across two mounts); the poster PNGs
    are separate entries; `connect-src 'self'` unchanged.

## F-AV-16 `[NEW]` (SC-2 / NFR) — the packaged/webview build delivers the asset

- [ ] F-AV-16: Build the webview bundle (`pnpm --filter @fredo/ui build`, then the tauri frontend
      build); assert `apps/tauri/dist/avatar/fredo-character.glb` exists with the same byte
      length/SHA-256 as `apps/ui/public/avatar/fredo-character.glb`; then from the running dev app's
      page context fetch `/avatar/fredo-character.glb` and record `status` + `content-length`.
  **Expected:** the built `dist` carries the asset at the identical digest (the `publicDir` wiring
      works); the page-context fetch returns **200** with the expected length; no second copy at
      another path is produced by a build step.
  - **Edge:** the row rebuilds rather than reading a stale `dist` (G-425); the installer payload is
    out of scope for this base (no installer is produced — named precondition, not a blocker).

## F-AV-17 `[GUARD]` (SC-3 / a11y) — decorative on the root, announced on the wrapper

- [ ] F-AV-17: Read `aria-hidden`, `role`, `tabIndex` on the avatar root and every descendant; read
      the companion wrapper's `aria-label` in two different states; Tab through the seat.
  **Expected:** avatar root `aria-hidden="true"`; ZERO focusable nodes inside (`tabIndex >= 0`,
      `<button>`, `<a>`, `<input>`); the poster's `<img>`/`<mask>` is `aria-hidden` (`alt=""`); the
      wrapper's `aria-label` equals `Fredo companion -- <state>` and tracks the state; Tab never lands
      inside the avatar; the wrapper `title` unchanged. (UI/UX §7 / UX-8.)

## F-AV-18 `[NEW]` (R-4 / SC-3 — UI/UX §2 / UX-2 / UX-7) — the poster is not a backdrop, and the canvas never paints a rectangle

- [ ] F-AV-18: With the avatar `live`: read
      `getComputedStyle([data-avatar-poster-layer]).visibility`; drive a `teleport-out` and capture
      mid-dissolve (`teleport-out-mid.jpeg`); then zoom the avatar box corners in BOTH themes
      (`corner-light.jpeg` / `corner-dark.jpeg`) and dense-diff the corner patches against a
      same-task control with the avatar root `display:none`.
  **Expected:** (a) while `data-avatar-render="live"` the poster layer's computed
      `visibility === 'hidden'` (mounted but not painted — the probe survives, the pixels do not);
      (b) the `teleport-out` mid-dissolve capture shows the reserved box **emptying** — **no ghost
      `idle` figure** standing behind the vanish (the poster is what would cause it);
      (c) the four corner patches over the surrounding surface show **no fill** in either theme
      (transparent canvas clear + RGBA poster → no opaque rectangle over the seat or over whatever the
      floating companion hovers above).
  - **Edge:** live→poster fallback (asset error / `webglcontextlost`) shows the poster again
    **instantly**; the handoff is opacity-only and 150 ms (no transform, no reflow); under reduced
    motion every boundary is instant.
  - **Control (pre-change):** no `[data-avatar-poster-layer]`, no canvas → the row cannot be driven
    → red.

## F-AV-19 `[NEW]` (SC-1 / R-4 — UI/UX §3 / UX-3) — silhouette occupancy matches today's SVG; no hat/boot clipping

- [ ] F-AV-19: From the `idle` capture (and one capture per prop-bearing state), measure the ink
      bbox of the avatar crop (crop + halo per the shipped dense-diff procedure) and compare with the
      frozen fractions.
  **Expected:** the measured silhouette bbox is within **±2 % of the box** in each dimension
      (±1.6 px at sm) of `0.8284 W` × `0.9233 H`, feet baseline at `0.9763 H`, horizontally centred;
      no hat/head/boot clipping in any captured state; the same fractions hold at `md` **through the
      renderer seam only** (`computeOrthoFraming` unit leg) — there is no live `md` surface.
  - **Edge:** a state whose prop is cut by the frame edge = FAIL for character-attached props (FX may
    bleed); a per-state re-fit (zoom pumping) is a FAIL — the camera is fitted once per mount.
  - **Control (pre-change):** the SVG's own ink bbox is the reference; the row is `[NEW]` because the
    measured object (the 3D render) does not exist on the pre-change tree.

## F-AV-20 `[NEW]` (R-4a — UI/UX §1) — the poster depicts the SAME character, front-on, at the idle pose

- [ ] F-AV-20: In the poster state (lever F-AV-2), capture `poster-full.jpeg` and read the poster
      layer's computed `background-color` and the detail `<img>` `src`/natural size.
  **Expected:** the poster shows the character **front-on (the face, not the back)** at the `idle`
      pose with the authored detail colours; layer 1 is `background-color: var(--accent-primary)`
      masked by `poster-body.png` (never a solid rectangle — the mask flips to opacity 1 only after
      decode); the detail `<img>` carries `alt=""`; no ground plane/shadow/background is baked in;
      the poster raster is 0.800 aspect (no distortion) scaled with `100% 100%` (never `contain`).
  - **Edge:** an undecoded/failed mask must not paint the accent rectangle (check `opacity` before and
    after decode); `image-rendering` is NOT `pixelated`/`crispEdges`.

## F-AV-21 `[NEW]` (R-3a) — the tint exists on the stock theme

- [ ] F-AV-21: Reach the stock theme through the SHIPPED control — theme state is not
      localStorage-only, so an absent key is not evidence of a stock theme:
      (1) Doom OFF;
      (2) open **Settings → Appearance** (`SettingsSurface.tsx:170`);
      (3) if a preset or any per-token override is applied, **"Reset to theme defaults"** is
      rendered (`ThemingSettings.tsx:422,439` — the button mounts only while
      `hasAnyOverride || selectedPreset !== ''`) → click it (`resetTheme` sets the preset to `''`
      and the overrides to `{}`, `ThemeProvider.tsx:594-597`); if the button is ABSENT the keys are
      already stock — record that observation and do NOT manufacture a preset just to enable it;
      (4) **cold-reload** the app, then re-read `localStorage['Fredo_theme_preset']` and
      `localStorage['Fredo_theme_overrides']` — they must be `''`/absent and `{}`/absent AFTER the
      reload (a reload-less reset leaves the live provider's in-memory snapshot in place, which is
      how a stock reading gets manufactured); any non-empty value is a named BLOCKED precondition,
      never a PASS;
      (5) once `data-avatar-render="live"`, read `data-avatar-body-color`, the computed
      `--accent-primary` (`getComputedStyle(document.documentElement).getPropertyValue('--accent-primary')`),
      and the poster body element `[data-avatar-poster-body]`'s resolved `background-color`
      (`getComputedStyle(...).backgroundColor`).
  **Expected:** `data-avatar-body-color` is **present** and its channels are **numerically equal**
      to the computed `--accent-primary`'s channels — for the stock theme that is
      `--accent-primary: rgb(147, 51, 234)` (`apps/ui/src/app/types/theme.ts:166`, the locked
      `classic` base) against `data-avatar-body-color: #9333ea` (147/51/234 = 0x93/0x33/0xea),
      compared as a channel TRIPLE, never as a string (the hook emits `#rrggbb`; the var is the
      authored `rgb(...)` token stream); the poster body layer resolves the **same** colour
      (`rgb(147, 51, 234)`), so the 2D fallback and the live canvas agree on the stock accent.
      A hex-string equality check is a method FAIL, not a product finding.
  - **Reddens after the change:** `data-avatar-body-color` absent while `render="live"`, OR any
    channel differing from `--accent-primary`, OR `[data-avatar-poster-body]` resolving a different
    accent — each is a FAIL of this row.
  - **Control (pre-change):** red on the pre-fix build — `data-avatar-body-color` is absent for the
    whole mount while the poster is already accent-correct. This is the row that separates "the
    accent re-tints" from "the accent re-tints, but only after the user has already touched it".
  - **Edge:** a first-frame read before `render="live"` is not a failure (the hook is only promised
    live); re-read after the live transition. If a reset was performed, the cold reload is
    mandatory before any read; if the reset control was absent, record the two storage keys as the
    stock-precondition receipt.

