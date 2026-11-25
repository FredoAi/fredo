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
  - **#3223 · UX-14 — the Doom leg (same fake renderer, `doomEngaged` prop true).** Engage Doom
    Mode through the store: **Expected** `data-avatar-motion="still"`, exactly **ONE** renderer draw
    of the resolved DOOM clip (`doom-idle` on the first engagement), **ZERO** RAF ticks after it, no
    `doom-in` / `doom-out` / `doom-shoot` (the phase jumps `idle→holding` on engage and `→idle` on
    release — the instant costume swap, UX-14), the Doom palette still applies (`--accent-primary`
    `#8fbf3f` on the body family), and the still comes from the **LIVE 3D path** (`data-avatar-render`
    stays `live`, canvas present, poster `visibility: hidden`) — never the poster, which would erase
    state legibility. **Edge:** the still keeps the held weapon, so a second engagement's still is a
    different weapon; a one-shot (`teleport-out`) must not loop; no second animation loop and no
    second canvas.

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
  - **#3223 — the Doom armour is in the SAME class (G-403: every member, not one).** Repeat (i) with
    the Doom performance active, over the full material set the shipped manifest declares
    (`fredo-character.manifest.json:14-32`): the four body-family materials
    (`fredo_body`/`fredo_limb`/`fredo_boot`/`fredo_accent`) still track the palette, and **all eight
    armour materials keep their AUTHORED hex in both accent passes** — `fredo_doom`, `fredo_helm`,
    `fredo_visor`, `fredo_metal`, `fredo_brass`, `fredo_lava`, `fredo_trim`, `fredo_glove`. The
    armour is authored-colour **by construction** (it is outside `applyAvatarTint`'s two name sets,
    `avatarPalette.ts:46-47,165-192`), so a hit here means a second tint path was added. The row
    reads the MATERIAL colours, never a screenshot (G-419). **Reddens after the change:** any armour
    material whose hex moved in either pass, or a body material that stopped tracking the palette.

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
  - **Edge:** release-mid-`doom-in`, the weapon cycle and the armour clips are **`F-AV-22`…`F-AV-29`**
    of this suite (Spec #3223) and MUST NOT be asserted here; the per-engagement weapon identity is
    `data-avatar-clip` (`doom-idle`/`doom-mg`/`doom-sword`), never a badge.

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
  - **#3223 · UX-16 — the same read WITH Doom engaged (independent leg).** Engage and settle into the
      armour idle, then repeat every read: **Expected** the ROOT still `aria-hidden="true"`, still
      ZERO focusable nodes inside it (the armour is painted inside the canvas — nothing becomes
      focusable, no role, no live region, no `<button>`/`<a>`/`[tabindex]` is added), the wrapper's
      accessible name is **still `Fredo companion -- <state>`** and does **not** announce Doom (the
      12-state readout is the functional state; the persona is decorative), the `title` tooltip is
      unchanged, and Tab order across the window is untouched. **Reddens after the change:** any new
      focusable inside the root, a wrapper name that gains a Doom token, or a new live region.

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

---

# fredo-avatar — Doom cut-over: the clip-driven armour + weapon cycle (Spec #3223)

> **Verification policy: live.** This slice's AC (AC5, moved word-for-word from #3210) is a rendered
> performance inside the live 3D canvas. Every visual leg is a LOCAL CAPTURE from the live dev app
> (`tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3223/e2e/<name>.jpeg")`,
> MCP driver `com.fredo.app`, main window) **paired with** a same-task `execute_js` read of
> `data-avatar-clip` / `data-state` / `data-avatar-render` / `data-avatar-body-color` — a visual row is
> never UNVERIFIED by construction. Upload every capture into the round's POSTED `## Tests Runs`
> (`gh image` via `upload-evidence`): the posted comment is the durable record (G-415); the
> `.opencode/tmp/3223/e2e/` path is only where the file is authored. **Doom emits NO OTLP span** — the
> round's live-pipeline receipt (`telemetry_spans`, non-zero + recent `max(ingested_at)`) proves the
> pipeline, not the feature; DISCLOSE that.
>
> **The observable is `data-avatar-clip`** — the mixer's APPLIED clip (`FredoAvatar.tsx:153`), live
> only. While engaged it carries one of six doom names (`doom-in`, `doom-idle`, `doom-mg`,
> `doom-sword`, `doom-shoot`, `doom-out`); otherwise a 12-state name; absent on the poster. There is
> **no `data-avatar-doom-phase` hook** and no 13th state. The weapon identity IS the clip.
>
> **Instruments (defined once, used by every row below).**
> **I-1 `QAClipRecorder`** — pasted in ONE `execute_js` task before a drive and dumped in one task
> after it. A `requestAnimationFrame` loop re-querying the document each frame (so a surface remount
> cannot blind it) that appends `{t, clip, state, render, motion, bodyColor}` whenever
> `data-avatar-clip` changes: `clip`/`motion`/`bodyColor` from
> `.fredo-companion-avatar [data-avatar-render]` (or `.fredo-avatar-idle [data-avatar-render]` for the
> OFF-seat leg), `state` from the wrapper's `data-state`. Sub-second states and 1.333 s clips are read
> from THIS log, never a serial driver round-trip.
> **I-2 `QaZoom` capture aid** — the shipped screenshot call has no crop, and `sm` is 80×100 CSS px.
> In the SAME task that reads a row's DOM facts, set `style.transform='scale(4)'` +
> `style.transformOrigin='top left'` on the avatar wrapper, shoot, then remove the inline style in the
> next task. A transform changes no `offsetWidth` and triggers no camera re-fit; no assertion is read
> while it is on, and the receipt says it was applied.
> **I-3 levers** — engage: five `document.dispatchEvent(new KeyboardEvent('keydown',{key,
> bubbles:true,cancelable:true}))` for `i`,`d`,`d`,`q`,`d` (`useSecretCode.ts:41-74`; it IGNORES an
> editable target, `:45` — never type into the launcher bar or the composer). Disengage:
> `window.__TAURI_INTERNALS__.invoke('exit_doom_mode')` in the main webview (the shipped invoke path).
> **Precondition for every row:** `get_doom_mode_status.phase === "active"` while engaged and
> `data-avatar-render === "live"`.
>
> **Tag legend:** `[NEW]` must redden on the pre-change tree — the control is the frozen vocabulary:
> `doomClips.ts`/`DOOM_CLIPS` do not exist there and `data-avatar-clip` can only carry one of the 12
> state names, so any `doom-*` expectation is unsatisfiable on `main`'s tip.

## F-AV-22 `[NEW]` (REQ-1 / REQ-4 / REQ-7 / REQ-8 — UX-10) — engage mid-`thinking`: armour in, weapon idle, palette, then retract

- [ ] F-AV-22 **leg A (engage).** START from a page reload (a fresh page session resets the module
      weapon cursor to `shotgun`; a prior engagement in the session would advance it). Companion
      visible on the shipped surface with `data-avatar-render="live"` and `data-state="thinking"`
      (single-click the `.fredo-companion-avatar` — the joke's LLM wait is `thinking` until the first
      token, `CompanionEntity.tsx:1100-1105`; a cold model gives the widest window). Read the baseline
      (`data-avatar-clip` ∈ the 12 names; `data-avatar-body-color` channels numerically equal
      `--accent-primary`). Install **I-1**, then dispatch the five `iddqd` keydowns (**I-3**).
  **Expected:** `data-avatar-clip` becomes `doom-in` and is observed for **≥1.0 s** (authored 1.333 s,
      one-shot ended by the mixer's `finished`); then a weapon idle and it HOLDS (no flap) — on the
      FIRST engagement of a fresh page session that is `doom-idle` (shotgun), and after any earlier
      engagement in the same session read the clip rather than assuming the weapon; `data-avatar-render`
      stays `live`; a second `iddqd` while engaged does NOT re-play `doom-in` (idempotent). `data-avatar-body-color` channels equal the computed
      `--accent-primary` = **`DOOM_PALETTE.accentPrimary` `#8fbf3f`** (`doomTheme.ts:39`) — compare a
      channel TRIPLE, never a string; `data-state` may keep changing underneath (the overlay is
      independent of the flow) — record it. Captures: `doom0-thinking.jpeg`, `doom-in-mid.jpeg`
      (~0.4 s in), `doom-idle-shotgun.jpeg` (settled).
  - **Reddens after the change:** on `main`'s tip no doom clip can be applied at all → `doom-in` /
    `doom-idle` never appear (the control).
  - **Edge:** engage mid-stream (`data-streaming="true"`); engage twice fast; a click during
    `doom-in` must not cut the entrance (see F-AV-24 leg B for the reference sequence).
- [ ] F-AV-22 **leg B (release + restore).** From the settled armour idle, invoke
      `exit_doom_mode` (**I-3**) with the recorder still running; capture mid-retract and after the
      clip settles. Read `data-state` immediately BEFORE the invoke and again at the restore instant.
  **Expected:** `doom-idle` → `doom-out` (observed **≥1.0 s**, one-shot on `finished`) → a 12-state
      clip; the palette reverts on the same edge the armour retracts (`data-avatar-body-color` back to
      the theme accent, no flash, no remount — a marker stamped on `[data-avatar-canvas]` survives the
      whole engage/release); **the restored clip EQUALS `data-state` at that instant** (no stale
      pre-engagement snapshot, no 13th state). Captures: `doom-out-mid.jpeg`, `restored-thinking.jpeg`.
  - **The AC's "returns to the thinking performance":** if `data-state` reads `thinking` at BOTH
    reads, the restored clip MUST be `thinking`. If the companion's turn already left `thinking`, the
    literal leg is RE-DRIVEN (recommended: the TicTacToe O-move, whose vision turn holds `thinking`
    for seconds) — the disclosure `precondition window missed; re-driven` is pre-authorized and is not
    a FAIL; a restore that differs from a `thinking`-at-restore `data-state` IS a FAIL.
  - **Edge:** release from `flourishing` (must go straight to `doom-out`); a double release (idempotent
    no-op).

## F-AV-23 `[NEW]` (REQ-2 — UX-11) — the weapon cycle across four consecutive engagements

- [ ] F-AV-23 (live) In ONE page session (no reload — the cursor is module-scoped), run four
      engagement cycles: `iddqd` → poll until a holding clip → read it → `exit_doom_mode` → poll until
      a 12-state clip → repeat. Capture each engagement's armour idle with **I-2**.
  **Expected:** engagement 1 `doom-idle` (**shotgun**), 2 `doom-mg` (**machine gun**), 3
      `doom-sword` (**energy sword**), 4 `doom-idle` again (**wraps**); the three captures show three
      DIFFERENT silhouettes (UX-11: a horizontal boomstick across the chest / a bulky drum-fed chest
      mass / a diagonal self-lit blade — the sword is the only self-lit prop); the recorder shows no
      extra `doom-in` inside a single engagement. Captures: `doom-engage-1.jpeg` … `doom-engage-4.jpeg`.
  - **Reddens after the change:** no doom clip exists on the pre-change tree (control).
  - **Edge:** the release→`idle`→re-engage "flick" walks all three in a few seconds (UX-11) — covered
    by F-AV-25 leg B. **Count ENGAGEMENTS, not `iddqd` presses:** a second `iddqd` while still engaged
    (including during `entering`) is a no-op and must NOT advance the cursor — the plan's repeated-edge
    rule means an entry edge during `entering` settles to `holding` on the SAME weapon (it never reaches
    `idle`). A page reload restarts the cursor at `shotgun` (declare it, do not fail it).
  - **Unit (same row):** `__tests__/doomClips.test.ts` — `DOOM_WEAPON_ORDER` is
    `['shotgun','machine-gun','energy-sword']`, `DOOM_WEAPON_CLIP` maps `shotgun→doom-idle`,
    `machine-gun→doom-mg`, `energy-sword→doom-sword`, `advanceDoomWeapon()` returns `shotgun` first
    and wraps after the third, and `isDoomClipName` rejects the 12 state names. In
    `__tests__/doomPerformance.test.ts`: the cursor SURVIVES a consumer unmount — unmount mid-session,
    re-engage, and the next weapon (not `shotgun`) is selected.

## F-AV-24 `[NEW]` (REQ-3 / REQ-11 — UX-12) — the deterministic flourish

- [ ] F-AV-24 **leg A (the beat).** Engage, settle into the armour idle, keep recording ~12 s; capture
      the frame the `doom-shoot` clip is first observed.
  **Expected:** exactly **ONE** `doom-shoot` entry in the log; it STARTS **9.6–11.4 s** after the
      `iddqd` keys (9 s of continuous holding after the settle + the 1.333 s intro, UX-12 — the band
      is the declared tolerance), lasts **1.0–1.8 s** (`DOOM_FLOURISH_MS = 1333`, ended by the timer
      because a loop clip emits no `finished`), then returns to the **SAME** weapon clip; no RNG (the
      same beat on a repeat run). Capture: `doom-flourish.jpeg`.
  - **The row asserts that a flourish PLAYED and returned to `holding` — it never asserts the weapon
    silhouette during the flourish.** `doom-shoot` is authored on the shotgun, so an MG/sword
    engagement visibly shows the shotgun for one loop: recorded AUTHORED quirk (UX-12), not a defect.
- [ ] F-AV-24 **leg B (never after a release begins).** Repeated with the recorder running, issue
      `exit_doom_mode` the instant `doom-shoot` is observed.
  **Expected:** the very next recorded clip is `doom-out`, and NO second `doom-shoot` entry appears
      after the release edge; the exit's own one-shot is not delayed by the flourish.
- [ ] F-AV-24 **leg C (unit — the six "nevers").** `__tests__/doomPerformance.test.ts` with fake
      timers + a fake renderer: no flourish from `entering` or `exiting`; none while suspended
      (teleport); the 9 s interval restarts on every entry into `holding` (two flourishes are never
      adjacent); a fake renderer that never emits `finished` for `doom-shoot` still returns to
      `holding` at `DOOM_FLOURISH_MS`; release during `flourishing` clears the timer; reduced motion
      never arms it (see F-AV-4's Doom leg).

## F-AV-25 `[NEW]` (REQ-5 / REQ-6 — UX-13) — the two mid-transition sequences, and the repeated-edge invariant

- [ ] F-AV-25 **leg A (release mid-`entering`, live).** With **I-1** installed, in ONE task: dispatch
      the five `iddqd` keydowns, then `setTimeout(() => window.__TAURI_INTERNALS__.invoke(
      'exit_doom_mode'), 300)`. Capture during `doom-in` and after the sequence settles.
  **Expected:** the recorded sequence is `doom-in` → `doom-out` → `<12-state>`; **never** `doom-in` →
      `<12-state>`; the `doom-in`→`doom-out` interval is **≥1.0 s** (the in-flight one-shot completed;
      the release intent is held by the plan's coalesce-to-latest mirror, never a `pendingExit`
      boolean); no 12-state clip appears between the two doom clips; the final
      `data-avatar-clip` equals `data-state` (the armour is never left half-applied).
      Captures: `doom-release-mid-in.jpeg`, `doom-retract-complete.jpeg`.
  - **Disclosure (required in the receipt):** the backend's own teardown reaches `inactive` after its
    bounded stop (the `exiting` phase still reads engaged, `types.ts:69-71`), so the live leg may
    complete `doom-in` before the edge lands. The live leg proves ORDERING + DURATION; the
    coalesce-to-latest mechanics are proven by leg C. Say which path the run took.
- [ ] F-AV-25 **leg B (re-engage mid-`exiting`, live).** Engage, settle, `exit_doom_mode`, then poll
      in-page (rAF) until `data-avatar-clip === 'doom-out'` and immediately dispatch the five `iddqd`
      keydowns again. Capture mid-retract and at the new holding.
  **Expected:** `doom-out` → `doom-in` → the **NEXT** weapon clip (releasing a shotgun engagement
      re-enters at `doom-mg`); `doom-out` is not cut (≥1.0 s observed) and the fresh `doom-in` is full
      length. Captures: `doom-reengage-mid-out.jpeg`, `doom-reengage-armour.jpeg`.
- [ ] F-AV-25 **leg C (unit — the repeated-edge rule + the settled invariant).**
      `__tests__/doomPerformance.test.ts` with a fake renderer that records `setDoomPerformance` and
      emits `onDoomClipFinished`: `setDoomPerformanceEngaged(false)` during `entering` leaves the phase
      and the pushed clip UNCHANGED; the exit is pushed only after `completeDoomOneShot('doom-in')`
      (→ `exiting`); the mirror holds for an entry edge during `exiting` (→ `entering` after
      `finished(doom-out)`, weapon advanced EXACTLY once). **Mechanism note (binding — the plan's
      Convergence section supersedes an earlier two-boolean design):** there is NO
      `pendingExit`/`pendingEntry` slot; every edge rewrites ONE `desiredEngaged` mirror and
      `settle()` runs on every one-shot completion. Assert the BEHAVIOUR, never a boolean name.
      Then the settled invariant: `false→true→false→true` inside one `doom-in` ends in `holding`, and
      `true→false→true→false` inside one `doom-out` ends in `idle` (the figure converges on the mode's
      ACTUAL final state, never on edge order), and after EVERY `finished`
      `desiredEngaged === (phase === 'holding' || phase === 'flourishing')` — i.e. the rendered armour
      matches `isDoomVisualEngaged()`: **never un-armoured with the mode ON, never armoured with it
      OFF.**

## F-AV-26 `[NEW]` (REQ-13 — UX-15) — the poster host: palette only, no doom clip

- [ ] F-AV-26 Record `Get-FileHash` (SHA-256) of `apps/ui/public/avatar/fredo-character.glb`, **move
      it** to `.opencode/tmp/3223/lever/`, hard-reload the dev app, engage Doom Mode, read the surface;
      capture `doom-poster.jpeg`; **restore the file**, re-verify the digest and reload.
  **Expected:** for the whole mount `data-avatar-render="poster"`, `[data-avatar-canvas]` count **0**,
      `data-avatar-clip` **absent** while engaged (no doom clip, no weapon), and the Doom palette
      still applies (`--accent-primary` = `#8fbf3f`; the poster body layer resolves that accent — a
      green idle silhouette is the acknowledgement, UX-15); no app-level `Error:`/`Uncaught` (one
      failed-resource line for the missing file is expected and is not an app error). After restore:
      digest matches and a reload returns the surface to `live`. **Restore is verified BEFORE any
      later live row runs** (a stale lever poisons them — paste the digest into the receipt).
  - **Unit (same row):** `useAvatarRenderer.reducedMotion.test.tsx`'s literal `AvatarRenderer` fake
    gains `setDoomPerformance` (ST-3) or the typecheck fails; `avatarAssetContract.test.ts` asserts
    `DOOM_CLIPS` ⇄ the manifest (six names, 1.333 s, only `doom-in`/`doom-out` `loop:false`) and
    presence in the GLB.
  - **Edge:** both surfaces; the capability-loss leg is a renderer-seam unit row, not this lever.

## F-AV-27 `[NEW]` (REQ-9) — a teleport outranks the Doom overlay and hands it back

- [ ] F-AV-27 With the companion floated (away overlay, so the landing point is observable) and Doom
      engaged in `holding` with a known weapon, dispatch
      `window.dispatchEvent(new MouseEvent('mousedown',{button:2,ctrlKey:true,clientX,clientY,
      bubbles:true}))` (`FredoCompanion.tsx:192-215`), with **I-1** running.
  **Expected:** recorded `holding-clip` → `teleport-out` → `teleport-in` → the **SAME** weapon clip
      (the overlay is suspended then restored, `DOOM_SUPPRESSING_STATES`); `data-avatar-clip` is never
      left on a `teleport-*` name after settle (≤2 s — never stuck mid-teleport); the landing point
      equals today's clamp on the overlay (`left = clamp(clientX−40, 0, innerWidth−80)`,
      `top = clamp(clientY−50, 0, innerHeight−100)` — `CompanionEntity.tsx:1043-1059`, the 80×100 box);
      the resting state after arrival is the doom weapon clip while engaged. Captures:
      `doom-teleport-out.jpeg`, `doom-teleport-in.jpeg`, `doom-teleport-resumed.jpeg`.
  - **Reddens after the change:** no doom clip exists pre-change, so "resumes the weapon clip" cannot
    pass (control).
  - **Unit (same row):** `doomPerformance.test.ts` — `setDoomPerformanceSuspended(true)` pushes
    `null`, freezes the phase and CLEARS the flourish timer; on resume the phase clip is re-pushed,
    and `entering` restarts `doom-in` (a teleport during the intro swallows its `finished` — R-4).
    `avatarRenderer.test.ts` — while a doom performance is active, `setState('teleport-out')` applies
    the teleport clip (teleport always wins) and the doom clip resumes afterwards.
  - **Edge:** teleport during `doom-in`, during `flourishing`, and twice in rapid succession.

## F-AV-28 `[NEW]` (REQ-1 / REQ-2 / REQ-6) — one store, both shipped avatar consumers

- [ ] F-AV-28 **leg A (mount freshness).** Engage on the home seat (`CompanionEntity surface="seat"`),
      note the holding clip, then teleport away (the seat entity UNMOUNTS and the away overlay mounts)
      with **I-1** running.
  **Expected:** the freshly mounted surface immediately reports the SAME holding clip — no second
      `doom-in`, never `null` and never a 12-state clip while engaged; a release on the new surface
      retracts normally and lands on a 12-state clip. (The phase is store-owned: module scope, never a
      `useRef`, per ENGINEERING_RULES persistence.)
  - **Edge:** teleport back to the seat mid-holding; a release that lands mid-remount.
- [ ] F-AV-28 **leg B (the OFF-seat mascot).** Toggle **Settings → Companion → the
      `aria-label="Show Fredo Companion"` switch** OFF (`CompanionSettingsPanel.tsx:679`) so the
      launcher renders the decorative `.fredo-avatar-idle` mascot, then engage Doom Mode; release.
  **Expected:** the decorative mascot ALSO arms — its `[data-avatar-render]` reports a doom clip while
      engaged and a 12-state clip after release (both shipped `FredoAvatar` consumers read the same
      store); exactly ONE `[data-avatar-render]` per mounted surface throughout.
  - **Remount control:** the OFF→ON toggle must not blank the seat for a frame; see `R-AV-10`.

## F-AV-29 `[NEW]` (unit only — REQ-6 settled invariant) — the double-flick converges on the mode's actual state

- [ ] F-AV-29 `__tests__/doomPerformance.test.ts` (fake timers, fake renderer): drive edge bursts
      faster than one one-shot — `false→true→false→true` inside one `doom-in`, and
      `true→false→true→false` inside one `doom-out` — then settle.
  **Expected:** the first burst ends in `holding` with `isDoomVisualEngaged() === true` (armoured), the
      second ends in `idle` with `isDoomVisualEngaged() === false` (un-armoured); and after EVERY
      `finished` (`settle()`) `desiredEngaged === (phase === 'holding' || phase === 'flourishing')`
      and `getDoomPerformanceSnapshot().clip` agrees with `isDoomVisualEngaged()` — armour rendered
      iff the mode is engaged. **Mechanism (binding):** one `desiredEngaged` mirror rewritten by every
      edge + `settle()` on every one-shot completion — the plan's Convergence section supersedes an
      earlier `pendingExit`/`pendingEntry` design, so the test asserts the snapshot and the invariant,
      never a boolean name. **Reddens after the change:** this module does not exist on the pre-change
      tree (control). **Edge:** three edges inside one one-shot; an edge arriving exactly on the
      `finished` callback; a suspended (teleport) burst; **an entry edge DURING `entering`** (no
      `idle` visit) settles to `holding` on the SAME weapon — one engagement, exactly one
      `advanceDoomWeapon` for the whole flick.

