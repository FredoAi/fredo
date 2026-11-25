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
   - **`#3224` — this clause is deliberately NOT widened to the 23 (UX-21).** The still is frame 1,
     `t = 0` by shipped contract (`drawStillFrame` → `mixer.setTime(0)`, `avatarRenderer.ts:450-465`),
     and **every prop is authored hidden at frame 1** and revealed from frame 2
     (`build_character.py:1909-1916`). So at `t = 0` four of the eleven emotions legitimately lose
     their primary marker — `happy` and `uwu` (bounce / sway), `angry` and `funny` (props) — and three
     pairs collapse (`happy`/`uwu`, `squint`/`angry`, `funny`/`idle`). Asserting "all 23 stills are
     pairwise distinct" would guarantee a **spurious FAIL on a correct build**. AC1's "visibly
     distinct" is the shipped **animated** 1.333 s performance, which `F-AV-30` leg E captures with
     motion on; this still limitation is a PO/asset note (its remedy — a still phase other than
     `t = 0` — would move the shipped 12's reduced-motion frames, so it is out of this spec). Do
     **not** extend the pairwise claim here, and do **not** "fix" it with per-state CSS.
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
    #3224). An unreachable recipe is a BLOCKED-harness (named), never a static PASS. **Perceptibility pointer for the 23-state round: `F-AV-30`.**
   - **#3224 note:** the 11 emotion ids deliberately have **no recipe in the table above** — they
     are not selectable by a shipped product signal on this surface; `F-AV-30` drives them with the
     DEV lever (`window.__FREDO_QA_AVATAR_FLOW__`) and `F-AV-34` proves their product reachability
     (a model-declared status). Do not invent a recipe for them here.
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
   - **#3224 — these fractions are the CAMERA-FIT PIN'S GROUND.** Since #3224 the vocabulary is 23
     and the camera fit is derived from `AVATAR_FRAMING_CLIPS` (the 12 status states only), so this
     row's frozen fractions are what proves the widening did not re-frame the shipped figure:
     **`F-AV-31` leg (b) requires this row to stay green with the SAME values.** Do not re-baseline
     them to accommodate an emotion pose — an emotion that would move the fit is a PO/asset finding,
     never a reason to accept a new fraction (`fredoAvatar/regression` R-AV-13 also pins the
     engaged-Doom case).

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
      Then the settled invariant, asserted exactly as the suite's `expectSettled()` does — a TWO-PART
      predicate: after EVERY `finished` (every `settle()`)
      `desiredEngaged === (phase !== 'idle' && phase !== 'exiting')`, **and** whenever the completion
      comes to rest (it hands over to no in-flight one-shot — the suite's `phase !== 'entering'`
      guard) the literal `desiredEngaged === (phase === 'holding' || phase === 'flourishing')` also
      holds. Both halves are required: the two predicates are identical on
      `idle`/`holding`/`flourishing`/`exiting` and diverge ONLY at `entering`, the one mandated
      hand-over (an entry edge during `exiting` → `finished(doom-out)` → `entering` while `doom-in` is
      still in flight, so the mode reads ON before any armour clip rests) — the literal form is
      UNSATISFIABLE at `entering`, so **do not "simplify" this back to the literal alone**. Also
      `false→true→false→true` inside one `doom-in` ends in `holding`, and `true→false→true→false`
      inside one `doom-out` ends in `idle` (the figure converges on the mode's ACTUAL final state,
      never on edge order). Together: the rendered armour matches `isDoomVisualEngaged()` — **never
      un-armoured with the mode ON, never armoured with it OFF.**
  - **Reddens:** any completion whose `settle()` leaves `desiredEngaged` disagreeing with the settled
      phase (`true` at `idle`/`exiting`, `false` at `holding`/`flourishing`), or a rest state where
      the literal form fails (a completion that comes to rest in `entering` with no one-shot in
      flight, i.e. a stranded hand-over).

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
      `finished` (`settle()`) `desiredEngaged === (phase !== 'idle' && phase !== 'exiting')`, **and**
      whenever the completion comes to rest (no hand-over to an in-flight one-shot — the suite's
      `phase !== 'entering'` guard) the literal
      `desiredEngaged === (phase === 'holding' || phase === 'flourishing')` also holds; at rest
      `getDoomPerformanceSnapshot().clip` agrees with `isDoomVisualEngaged()` — armour rendered iff
      the mode is engaged. **Why two forms (do NOT simplify):** the predicates are identical on
      `idle`/`holding`/`flourishing`/`exiting` and differ ONLY at `entering`, the one mandated
      hand-over (entry edge during `exiting` → `finished(doom-out)` → `entering` while `doom-in` is
      in flight and `desiredEngaged` is already `true`) — the literal form alone is UNSATISFIABLE at
      that phase, so it is asserted at rest and never demanded mid-hand-over.
      **Mechanism (binding):** one `desiredEngaged` mirror rewritten by every
      edge + `settle()` on every one-shot completion — the plan's Convergence section supersedes an
      earlier `pendingExit`/`pendingEntry` design, so the test asserts the snapshot and the invariant,
      never a boolean name. **Reddens after the change:** this module does not exist on the pre-change
      tree (control); and once it exists, any completion whose `settle()` leaves `desiredEngaged`
      disagreeing with the settled phase (`true` at `idle`/`exiting`, `false` at
      `holding`/`flourishing`), or a rest state where the literal form fails (a completion coming to
      rest in `entering` with no one-shot in flight). **Edge:** three edges inside one one-shot; an
      edge arriving exactly on the `finished` callback; a suspended (teleport) burst; **an entry edge
      DURING `entering`** (no `idle` visit) settles to `holding` on the SAME weapon — one engagement,
      exactly one `advanceDoomWeapon` for the whole flick.

---

# fredo-avatar — the 23-state vocabulary (Spec #3224)

> **Verification policy: live.** AC1 is a rendered performance a user can see; AC2's "no stray
> marker, no crash" clause is observable in the live DOM. One row (F-AV-35) is a
> **static-by-artifact** build pin inside the live policy — the ABSENCE of a DEV-only token is read
> from the BUILT chunk's own files, never by driving the surface claimed absent (G-408).
>
> **The round's live receipt (disclosed):** the avatar/boot surfaces emit **no OTLP span** — a
> companion turn runs through the in-process engine, not the OTLP plugin. The round therefore
> carries (a) one genuine `telemetry_spans` query (non-zero count + recent `max(ingested_at)`) that
> proves the **live pipeline**, explicitly disclosed as *not* evidence for this feature (the #3223
> precedent), and (b) a per-row `tauri_webview_screenshot(...)` capture **paired with** a same-task
> `execute_js` DOM read. A capture without its DOM read is UNVERIFIED; a static-only PASS is a false
> PASS.
>
> **Instruments (defined once, used by every row below).**
> **Q-1 `QA_FLOW` — the DEV drive lever** (ST-2, `qaAvatarFlowLever.ts`):
> `window.__FREDO_QA_AVATAR_FLOW__ = '<state>'` for a member of the 23. Unset = inert; a page
> reload clears it; it enters the resolver at **normal rank**, so a teleport still outranks it.
> **Precondition for every lever row:** companion at rest (`data-streaming` absent), bar un-engaged,
> no stream, no teleport, no skill pending, no Doom engagement.
> **Q-2 `QA_READ` — the three mount paths of the ONE shared shell.** **L1** = the launcher seat
> mascot with the companion **OFF** (wrapper `.fredo-avatar-idle` `data-state`,
> `LauncherShell.tsx:1784`; inner `[data-avatar-render]` `data-avatar-clip`); **C-seat** = the
> companion at the home seat (`.fredo-companion-avatar`, `surface="seat"`); **C-overlay** = the
> companion floated (`surface="overlay"`, same wrapper class). Per path read the wrapper
> `data-state` + `aria-label` and the inner root's `data-avatar-clip` / `data-avatar-motion` /
> `data-avatar-render` in ONE `execute_js` task.
> **Q-3 `QAClipRecorder`** — inherited verbatim from this file's **I-1** (a per-frame `rAF` log of
> `{t, clip, state}` re-querying the document each frame). Sub-second and one-shot states are read
> from this log, never a serial driver round-trip.
> **Q-4 the two teleport one-shots** are driven by their SHIPPED trigger (Ctrl+right-click, the
> recipe table above), not by Q-1: a levered `teleport-out` clamps on its final frame (the empty
> seat, `avatarRenderer.test.ts:138-141`), so a lever-driven capture would be a dead seat rather
> than the dissolve. Their `data-avatar-clip` identity **is** lever-drivable and is read that way.
> **Q-5 `QAClipEcho` — the applied-clip seam (jsdom tier).** `probeAvatar3d()` is `false` under
> jsdom so the real renderer never mounts (`FredoAvatar.tsx:96`); the leg stubs
> `WebGL2RenderingContext` (`avatarRenderer.test.ts:69` precedent) and injects a fake through the
> SHIPPED seam `setAvatarRendererFactoryForTests` (`avatarRenderer.ts:144`) whose `setState(next)`
> calls `onClipChange(next)` **only when `next` is a key of an action map built from the GLB's own
> animation names** — mirroring `applyClip`'s `if (!action) return;` (`avatarRenderer.ts:498-499`).
> That mirror is what makes the instrument non-tautological: a union member with no clip in the GLB
> reports NO clip change, so `data-avatar-clip` keeps its previous value and the row reddens.
>
> **Drive coverage (G-440).** All 23 are drivable on all three mount paths. The 12 keep their
> shipped recipes on C-seat/C-overlay, but **the launcher's product selection set is 4**
> (`LauncherShell.tsx:687-690` passes no `modelStatus`/`captureActive`/`teleporting`), so **19 of the
> 23 are unreachable on L1 without Q-1** — that substitution is stated, not hidden (F-AV-30). The 11
> emotions are unreachable on EVERY surface by a shipped product signal except a model-declared
> status, so their matrix leg is lever-driven while F-AV-34 proves the product reach.
>
> **Two cadence edges — a FAILED DRIVE, never a product FAIL.** (a) `useFredoRestingCadence(12000/
> 1800)` injects a `playful` CANDIDATE: an emotion outranks it (the band is above `playful`) but the
> BASE state `talk` does not, so a levered `talk` reads `playful` during the 1.8 s beat — sample the
> ≈10.2 s resting-idle window. (b) A levered `idle` reads `playful` in the same window, so `idle` is
> captured only on an `idle` reading (poll ≤14 s; re-capture if the beat lands).
>
> **Tag legend:** `[NEW]` must redden on the pre-change tree (the control is named in the row);
> `[RETAINED]` / `[GUARD]` are green today and must stay green.

## F-AV-30 `[NEW]` (R-1a / R-1b / R-1c / R-1d — AC1, two tiers) — the 23-state matrix on all three mount paths

- [ ] F-AV-30 **leg A (union ⇄ clip 1:1, structural).** Read `fredoAvatarStates.ts` +
      `avatarClips.ts`; assert `FREDO_AVATAR_STATES.length === 23`; `FREDO_AVATAR_STATES` deep-equals
      `[...FREDO_AVATAR_STATUS_STATES, ...FREDO_AVATAR_EMOTION_STATES]`;
      `FREDO_AVATAR_STATUS_STATES` equals the pre-change 12 **in the same order**
      (`idle, talk, teleport-out, teleport-in, thinking, happy, playful, joking, listening,
      working, error, greeting`); `FREDO_AVATAR_EMOTION_STATES` equals the 11 ids in
      `ASSET.md:103-116` order (`uwu, love, sad, surprised, sleepy, skeptical, confused, silly,
      squint, angry, funny`); `Object.keys(AVATAR_CLIPS)` equals the 23 names, every `loop: true`
      except `teleport-out`/`teleport-in`; `AvatarClipName` still accepts every `FredoAvatarState`
      (compile-enforced by `Readonly<Record<AvatarClipName, AvatarClipSpec>>` — report the build exit).
  **Expected:** all of the above green.
      **Control (pre-change):** `FREDO_AVATAR_STATES.length === 12` and `AVATAR_CLIPS` has no `uwu`
      entry (adding one is a TS error pre-change) → red.
  - **Edge:** a duplicate id; the 12 re-ordered; a `doom-*` name leaking into `AVATAR_CLIPS`; a 24th
    invented id added to only one of the two arrays.

- [ ] F-AV-30 **leg B (all 23 clips really are in the shipped asset).** Extend the committed
      `__tests__/avatarAssetContract.test.ts` pin: the 23 union names are a **subset** of the
      shipped GLB's animation names (parsed from its own JSON chunk), each at `1.333 s` (±`0.01`)
      and matching the authoring manifest's `loop` flag. Report the executed count and the resolved
      GLB path.
  **Expected:** 23/23 present at the authored duration and loop flag; the existing "32 clips" and
      "manifest list equality" pins stay **green and unmodified** (the 3 unowned extras —
      `analyzing`, `planning`, `complete` — stay outside the union).
  - **Edge:** a clip renamed in a re-export (the set-equality pin catches it); a duplicated
    animation name in the GLB; an asset-gated pin that early-returns on a missing file is
    **corroboration only** (G-435) — leg B is a hard `existsSync` assert, never a skip.

- [ ] F-AV-30 **leg C (no two clips are the same performance).** Extend the same committed pin: for
      each of the 23, locate its animation's **sampler OUTPUT** accessors in the GLB's BIN chunk and
      digest those bytes; compare all **253 pairwise combinations** (23·22/2 — *the plan's "276
      pairs" is 24·22/2 and is corrected here*). Print the 23 digests and the **minimum pairwise
      distance**, and paste the plan's number beside the measured one.
  **Expected:** 23 distinct payloads, 0 identical pairs, a printed non-zero minimum. **ST-1 owns the
      first run** (its Phase-0 diagnostic) and must paste the per-pair minimum; if a pair IS
      byte-identical the shipped art aliases two performances — record a PO/asset scope finding and
      **do not weaken the assertion**.
  - **Edge:** an exporter that de-duplicates identical samplers to one accessor (that IS an alias —
    FAIL); two clips differing only by a scalar keyframe.

- [ ] F-AV-30 **leg D (per-state applied clip through the renderer seam, Q-5).** In a new committed
      case in `__tests__/avatarRenderer.test.ts` (or a sibling), mount `<FredoAvatar state={S} />`
      for all 23 with Q-5 installed; record `data-avatar-clip` per state.
  **Expected:** for all 23 `data-avatar-clip === S`; **`idle` is the ONLY state whose applied clip is
      `idle`**; a state whose clip is missing from the GLB reports NO change (the previous clip
      persists) — so this leg cannot pass by falling back.
  - **Edge:** `talk` with `streaming` false/true; reduced motion (all 23 still resolve a clip);
    `teleport-out`/`teleport-in` (clamp, no loop).
  - **Poster clause (UX-24):** repeat one pass on the shipped poster path (the `F-AV-2` asset lever,
    or jsdom which is always the poster path): all 23 paint the SAME authored idle figure,
    `data-avatar-clip` is **absent** by contract (`FredoAvatar.tsx:161` — `live && status.clip`), the
    wrapper `data-state` is still correct, and **no copy is added** to explain it. A run that reads
    the poster as "the wrong state" is THAT run's defect, not a FAIL of this clause.

- [ ] F-AV-30 **leg E (the live 23-state PHASE-SHEET matrix + the bounded vision read — the AC1 tier
      that needs eyes).** Per state, capture a **phase sheet, never a still**: **8 samples across one
      1.333 s loop at `t = 0.10 s + k·0.15 s`** (k = 0…7) — the sampling starts after the prop reveal
      (every prop is authored hidden at frame 1 and shown from f2) and spans `funny`'s wink
      (f9–f13) and both of `happy`'s humps; it **never** samples the t = 0 pose that several states
      share. A 3-frame minimum (`t ≤ 0.15 / 0.35–0.45 / 0.85–0.95 s`) is acceptable if tiling is
      unavailable. **Named trap:** a `canvas.toDataURL()` composite of the WebGL canvas is blank
      without `preserveDrawingBuffer` — build the sheet from screenshots, not the GL canvas.
      Artifacts: **23 sheets on S1** (the floating companion) + **4 sheets on S2** (the launcher seat,
      companion OFF) for the four members of the two Architect-named pairs — `happy`, `uwu`, `squint`,
      `angry` — at the same phase (the wrapper rules are surface-scoped CSS, so "both surfaces" is a
      per-surface claim) + **1 duplicate control** + **23 S2 DOM reads**. Drive each state with
      **Q-1** (the two teleports via **Q-4**), read **Q-3** for every state, and read each sheet against
      `ASSET.md:101-116` (the asset's own per-clip description) — the UI/UX §2 marker table is the
      review checklist and §3 is the full same-glyph inventory.
  **Expected (the legibility premise, stated so no reviewer files it as a defect):** at 80 × 100 CSS px
      an eye glyph is ≈6–7 px wide with a ≈1.5 px curve, so eye **family** (curve / chevron / ring /
      bar / heart / droop) is legible and eye **polarity** is not; every emotion is therefore carried
      by a **second channel** — a prop, a mouth, a posture, or a beat direction — and the eye family
      only confirms. Per sheet: the state's **primary marker is PRESENT**, **no other state's primary
      marker is present**, and the sheet is not the idle pose.
  **Expected (the 8 declared comparisons — each state's single nearest neighbour; this bounds the read,
      it is not 253 pairwise judgements):** `{uwu, happy}`, `{love, happy}`, `{sad, idle}`,
      `{surprised, confused}`, `{sleepy, skeptical}`, `{silly, idle}`, `{squint, angry}`,
      `{funny, idle}`. Each is presented **blind** (unlabelled, random order); the reviewer commits
      which is which **before** reading any filename or DOM label and names the feature used. PASS =
      both assignments correct **and** the named feature is the **declared discriminator**, not "it
      moved". **The declared discriminator, named per pair:**
      · `happy` / `uwu` — `happy` rises **twice** with squash-and-stretch plus the −3 px whole-wrapper
        bounce (`companion.css:86-95`, `fredoAvatarIdle.css:29-32`); `uwu` rises **once** while the
        head sweeps laterally. **Motion only — a still is INADMISSIBLE for this pair.**
      · `squint` / `angry` — `angry` adds **steam + hat + both arms raised** and the fastest lateral
        head shake; `squint` is chev eyes with an **empty silhouette**. **A still at t ≥ ~0.17 s IS
        admissible** (the props are large and static-visible); **never at t ≈ 0**, where both are
        "chev + nothing".
      · `sleepy` / `skeptical` (the **third** same-glyph pair — the asset has three, not two) — both
        call `eyes("lid")`; the discriminator is the **axis**: `sleepy` droops **down** (vertical,
        body sinks), `skeptical` sweeps **level and lateral**.
      · `confused` / `surprised` (a shared **single** glyph) — **count**: one ring + one bar vs two
        rings.
      · `love` / `happy` (watched, not a declared pair) — a **filled** 7-slab blob vs a **thin** arc;
        if a reviewer cannot separate them, report it.
      · `sad` / `idle`, `silly` / `idle`, `funny` / `idle` — posture, the only `:v` mouth, and the
        hat + monocle respectively.
  **Expected (the duplicate control):** one comparison is the SAME state under two labels. A reviewer
      who "distinguishes" it has failed the **method** — the whole read is REPEATED, never merely
      re-marked.
  **Expected (DOM, all three paths):** `data-avatar-clip === S` and wrapper `data-state === S` for the
      same driven state; `aria-label="Fredo companion -- <S>"` on C-seat/C-overlay (an **emotion id is
      LEGITIMATE in the accessible name** — the label is a state-id echo; banning it would invert R-1b).
  **Five FAIL conditions — any ONE fails the leg:** (i) a wrong assignment; (ii) a correct assignment
      reachable only from the artifact's timestamp/label; (iii) the declared discriminator invisible at
      80 × 100 (i.e. the reviewer needed evidence the shipped surface does not produce); (iv) a sheet
      matching `idle` (that is AC1's "no silent fallback" clause); (v) the duplicate control split.
      A failed PAIR is recorded **by name** as an asset-legibility finding for the PO — never a
      source change, never a relaxed criterion.
  - **Drive substitutions, named (not hidden):** the launcher seat (S2) reaches only 4 states by
    product signal (`LauncherShell.tsx:687-690`), so **19 of 23 are lever-driven there**; the 11
    emotions on **every** surface are lever-driven (their product reach is F-AV-34's); the two
    teleports use their shipped Ctrl+right-click recipe, captured ~150 ms into the dissolve.
  - **Edge:** a sheet taken during a resting `playful` beat is a **FAILED DRIVE** (re-capture); a sheet
    taken while `data-avatar-render !== "live"` is a FAILED DRIVE **except** on a poster host, where
    the run asserts `data-state` only and records it (UX-24: the poster is state-blind for all 23 —
    `data-avatar-clip` is absent by contract, `FredoAvatar.tsx:161`); clear Q-1 at the end and re-read
    the resting state (a stale lever poisons later Doom/teleport rows); both surfaces for a state must
    report the SAME clip.
  - **Disclosed residual:** "visibly distinct" is proven by (legs A–D) structural identity + this
    **bounded human read of documented markers**, not by a pixel metric. The pixel instrument remains
    a named Toolsmith gap — do not improvise one.
  - **Annexes these clauses cite (UI/UX §2/§3/§4 — UX-15…UX-20):** §2's per-emotion marker table is
    the review checklist; §3's inventory is the FULL same-glyph set; §4 is the capture protocol and
    the decision rule above.

## F-AV-31 `[NEW]` (R-1e — AC1's framing clause) — the camera fit stays the 12's; no emotion pose clips

- [ ] F-AV-31 **leg (a) — the framing set is the 12, exactly.** Read `avatarClips.ts`: assert
      `AVATAR_FRAMING_CLIPS` deep-equals `FREDO_AVATAR_STATUS_STATES` (12 members, same order) and is
      a **strict subset** of `FREDO_AVATAR_STATES`.
  **Expected:** set identity holds. **Control:** on the pre-change tree `AVATAR_FRAMING_CLIPS` does
      not exist (the fit is measured over every clip in the action map, `avatarRenderer.ts:263`) → red.
  - **Edge:** the set listing all 23 (red — that is precisely the regression); the set listing the 12
    in a different order (harmless to the fit but red, so the order is never silently re-derived).

- [ ] F-AV-31 **leg (b) — the 12's silhouette is byte-identical before/after.** Re-run **F-AV-19** on
      the spec tip and compare with its FROZEN fractions: silhouette bbox `0.8284 W × 0.9233 H`
      (±2 %), feet baseline `0.9763 H`, horizontally centred.
  **Expected:** the fractions hold to the same tolerance as on the pre-change tree — the widening did
      not move the shipped figure. Report the measured W/H/baseline beside the frozen values.
  - **Edge:** an emotion whose prop/POP would have entered the union if the pin were missing — that is
    exactly what this leg detects; a per-state re-fit (zoom pumping) is a FAIL.

- [ ] F-AV-31 **leg (c) — the framing CONSTANTS and the pinned measurement input are the proof (a
      committed camera-rect baseline is a NAMED BLOCKER, not a row).** Assert the framing constants the
      shipped fit is derived from are **byte-identical** to the pre-change values —
      `contentWidthFraction = 0.8284`, `contentHeightFraction = 0.9233`, the centre/offset pair
      `0.0237` / `0.5` (`three/avatarFraming.ts`) — and that the measurement **input** is pinned: the
      framing pass consumes exactly `AVATAR_FRAMING_CLIPS` (the 12 status states of leg (a)), never the
      full action map or the 23.
  **Expected:** the four constants equal the pre-change literals **exactly** (string/number equality,
      not a tolerance), and the measurement input is the 12-element set of leg (a).
  - **Named blocker (harness absent) — do NOT file this as a product defect and do NOT block the
    round on it:** no **GPU-free skinned-mesh measurement harness** exists in the repo (the same
    Toolsmith gap this spec already names for a pixel instrument), so a *committed numeric
    camera-rect baseline* measured on the pre-change tip cannot be produced by any capsule this round.
    The previously-planned "frozen framing baseline reproduced by the shipped measurement" leg is
    therefore recorded as **UNVERIFIED by method, with this named blocker** — never as a FAIL and never
    as a PASS. When the harness lands, that leg becomes executable with no change to this row's
    expectation.
  - **What still reddens the row (so it is not vacuous):** (i) any of the four constants moved — the
    single most likely way a widening re-frames the figure; (ii) the framing pass taking its input
    from the 23 (or from `actions.values()`) instead of `AVATAR_FRAMING_CLIPS`; (iii) `AVATAR_FRAMING_CLIPS`
    no longer equalling `FREDO_AVATAR_STATUS_STATES` (leg (a)); (iv) **F-AV-19's frozen silhouette
    fractions** (`0.8284 W × 0.9233 H` ±2 %, feet `0.9763 H`) moving on the spec tip (leg (b)) — the
    live, seam-free half. A row whose only evidence were the unproducible baseline would be the
    instrument defect; legs (a), (b) and this one are independently discriminating.
  - **Edge:** constants "close enough" is a FAIL (they are authored literals, not measurements); a
    re-derivation of `0.0237`/`0.5` from a new framing formula counts as a move.

- [ ] F-AV-31 **leg (d) — no emotion pose is clipped by the frame (live).** With Q-1 set to each of
      the 11 emotions in turn on C-overlay, capture `s3224-frame-<S>.jpeg` at 4× zoom
      (`style.transform='scale(4)'` + `transformOrigin='top left'` on the avatar wrapper, removed in
      the next task — the #3223 **I-2** aid) and read the character's head/prop regions.
  **Expected:** the character mesh (head, hat, the emotive props: the `angry`/`funny` hat,
      `surprised`'s pop-up, `sad`/`sleepy` head-down, `silly`'s `:v`) stays fully inside the reserved
      80×100 box; a character-attached prop cut by the frame edge is a FAIL, **pure FX may bleed**
      (the #3210 rule).
  - **Edge:** a character-attached prop overflowing the box = **PO/asset finding** (no re-fit is
    allowed); the same read with Doom engaged is R-AV-13's.

## F-AV-32 `[NEW]` (R-2a / R-2d — AC2's boundary clause) — a non-member never renders a marker, never throws

- [ ] F-AV-32 **leg A (live — the display boundary).** Companion visible and floated, at rest, bar
      un-engaged. Record the current state. Then, for EACH of `explode`, `dancing`, `IDLE`, `uuu`,
      `"  uwu  "`, `hyper` (a 24th invented id): set **Q-1** to that literal, wait 2 frames, read
      **Q-2** on all mounted paths **and**
      `document.querySelector('.fredo-companion-avatar').outerHTML`; then single-click the companion
      and confirm a turn still settles.
  **Expected:** after each write, `data-state` is a member of the 23 **and equals the state recorded
      immediately before the write** (the flow/idle holds — record which); `aria-label` matches it;
      `data-avatar-clip` is a member of the 23; the literal written (`explode`, `hyper`, …) appears
      **nowhere** in any `data-state` / `aria-label` / `data-avatar-clip` or the wrapper
      `outerHTML`; the click still produces a reply; console has no `Error:` / `Uncaught`.
      **Control (pre-change):** the lever module does not exist, so Q-1 cannot be written at all →
      the row cannot run and is red.
  - **`"  uwu  "` is REJECTED, not trimmed** — the lever is exact-match; a trimmed acceptance is a
    FAIL (a boundary that silently repairs input is the over-permissive direction AC2 forbids).
  - **Edge:** a non-string (`null`, `{}`, `23`) must not throw; the raw value `undefined` must leave
    the surface exactly as it was; two consecutive non-members (no latch); then a member (`angry`)
    still renders — the boundary did not wedge the surface.

- [ ] F-AV-32 **leg B (unit — the two-way matrix: under-drop AND over-drop).** In
      `__tests__/fredoAvatarResolver.test.ts`:
      **`[GUARD]` (green today)** `resolveCompanionAvatarState({flow:'idle', modelStatus:'explode'})`
      → `'idle'`; `{flow:'working', modelStatus:'explode'}` → `'working'` (the **flow** holds, not
      `idle`); `'IDLE'` / `''` / `' success '` / `dancing` / `waiting` / `hyper` → dropped;
      **`[NEW]`** `{flow:'idle', modelStatus:'uwu'}` → `'uwu'`, and **every one of the 20 RANKED
      members** (`FREDO_AVATAR_STATE_PRIORITY`) used as `modelStatus` resolves to itself.
      Separately, the **3 base states** (`talk`, `teleport-out`, `teleport-in`) are asserted as base
      states driven by the **flow / the DEV lever** — `{flow:'talk'}` → `'talk'`,
      `{flow:'teleport-out'}` → `'teleport-out'` — and **NOT** via `modelStatus`.
  **Why this is 20 and not 23 (do not "restore" the impossible form):** R-2c and R-2d deliberately
      keep `talk` and the two `teleport-*` states **outside the conflict order** (they are base states
      passed through before the order is consulted) and **outside the model-emittable set**
      (`talk`/`teleport-out`/`teleport-in`/`error`/`greeting` are flow/motion/error-owned, so a model
      can never be the sole candidate for their triggers — G-220). A row demanding `modelStatus:
      'talk'` → `'talk'` would therefore demand a behaviour the plan forbids, and would fail a correct
      build. The invariant is **20 ranked + 3 base**, and the base states are proven reachable by
      their own drive (the shipped recipe for the teleports, `F-AV-12`'s table; the stream for
      `talk`).
  **Expected:** both halves green. A widening that forgets the boundary reddens the `[GUARD]` half;
      a boundary still closed over 12 reddens the `[NEW]` half; a boundary that also admits a base
      state through `modelStatus` reddens the base-state half (`{flow:'idle', modelStatus:'talk'}` →
      `'idle'`, not `'talk'`). Also assert the lever reader returns `undefined` for a non-member (the
      lever is never a bypass).
  - **Edge:** a value equal to a *Doom* clip name (`doom-idle`) — dropped; a Symbol/number; `'idle '`
    (trailing space — dropped, exact match); `modelStatus:'teleport-in'` — dropped, and the teleport
    still outranks whatever else is signalled.

## F-AV-33 `[NEW]` (R-2c — AC2's order + teleport clauses) — the 20-ranked order, and a teleport still wins

- [ ] F-AV-33 **leg A (the order is data).** In `__tests__/fredoAvatarResolver.test.ts`:
      `FREDO_AVATAR_STATE_PRIORITY.length === 20`; the 9 status states appear as a **subsequence in
      the shipped order** (`working > error > happy > joking > listening > greeting > thinking >
      playful > idle`); the 11 emotions form one **contiguous band** between `thinking` and
      `playful` in `ASSET.md` order; `talk`/`teleport-out`/`teleport-in` absent; no duplicates; every
      member ∈ the 23.
      Adjacency proofs: for every adjacent pair `(hi, lo)` drive `lo` as `flow` + `hi` as
      `modelStatus` → `hi`. Band boundaries: `thinking` outranks every emotion; every emotion
      outranks `playful` (i.e. `{flow:'idle', resting:'playful', modelStatus: E}` → `E`).
  **Expected:** all green. **The pre-change 9-member assertion at `:28-40` is RE-CUT to the
      subsequence form, NEVER deleted** — it is the only guard that the 12 did not move.
      **Control:** the 20-member length is red on the pre-change tree (9).
  - **Edge:** an emotion placed BELOW `playful` (masked by the resting beat — G-220); an emotion
    ABOVE `thinking` (steals `thinking`'s sole trigger); a duplicate rank; `talk` accidentally ranked.

- [ ] F-AV-33 **leg B (live — a teleport outranks a levered emotion).** C-overlay, **Q-1 set to
      `angry`**, **Q-3** running. Ctrl+right-click out of the main window, then Ctrl+right-click
      inside `run-cli-terminal` to arrive.
  **Expected:** the recorded sequence is `angry` → `teleport-out` → `teleport-in` → `angry`; `angry`
      NEVER appears during either teleport window; `data-avatar-clip` is never left on a
      `teleport-*` name after settle (≤2 s); the wrapper `data-state` matches the clip at each step.
      Captures `s3224-lever-teleport-out.jpeg` / `-in.jpeg`.
  - **Why this leg exists, and which capsule owns it (binding — G-273/G-409):** the override must be
    applied to the resolver's **non-teleport candidate path only**. Placed before the teleport branch
    (`fredoAvatarResolver.ts:119`), it would return the LEVER value while `teleporting` is true, so a
    debug lever would beat a teleport — weakening AC2 even in a DEV build. The owning capsule is
    **ST-2** ("the 11 documented priority positions + the DEV-only QA drive lever"), which ships
    `qaAvatarFlowLever.ts` **and** the resolver's one-line read together; its non-goals already state
    "the lever never bypasses the resolver's ordering (a teleport still wins over it)". This row is
    that clause's executable proof, and the capsule must also record the placement in the code
    comment it lands. **If the lever is absent the row is UNVERIFIED (never a PASS); if the lever
    defeats the teleport the row FAILs and the fix is the placement, never the assertion.**
  - **Edge:** a teleport during a stream; two teleports in quick succession; the lever cleared
    mid-teleport (must still land on a resting state, never a stranded one-shot).

## F-AV-34 `[NEW]` (R-2b / R-2d / R-2e) — the 18-value emittable contract, three-way pinned, and an emotion that reaches the pixel

- [ ] F-AV-34 **leg A (the contract, three sources).**
      (i) **Rust** (`cargo test applications::llm_server::status`; report the count):
      `FREDO_STATUS_VALUES.len() == 18`; `fredo_status_schema()`'s enum order-equals it;
      `fredo_status_only_schema()` order-equals it; `STATUS_INSTRUCTION` and
      `STATUS_ONLY_INSTRUCTION` EACH contain all 18; `DEFAULT_FREDO_STATUS == "happy"`.
      (ii) **TS** (`fredoReplyStatus.test.ts`): `FREDO_REPLY_STATUSES` order-equals
      `apps/tauri/src-tauri/src/applications/llm_server/fredo_status_contract.json`'s `values`
      (read from cwd `apps/ui` — precedent `avatarAssetContract.test.ts:326`); `default == "happy"`.
      (iii) **Three-way equality:** the fixture `values` == `FREDO_STATUS_VALUES` (a Rust
      `include_str!` parity test) == `FREDO_REPLY_STATUSES`.
      (iv) **Non-vacuity:** the TS leg asserts the fixture file **exists**, `values.length === 18`,
      and every value is a member of the 23 — a missing/blank/empty fixture is a hard FAIL.
      (v) **`funny` is first-class:** `resolveReplyStatus('funny') === 'funny'`,
      `resolveReplyStatus('FUNNY') === 'funny'`, and for EVERY member `M`,
      `resolveReplyStatus(M) === M` (no alias may shadow a member).
  **Expected:** 18 values in one order across three sources; `talk`/`teleport-out`/`teleport-in`/
      `error`/`greeting` stay non-emittable; the other 6 aliases (`success`, `reasoning`, `busy`,
      `focused`, `neutral`, `calm`) unchanged; `DEFAULT_FREDO_STATUS` unchanged.
  - **Drift detection is the EQUALITY of three independently-read sources plus (iv).** The tester
    holds no write grant outside `.opencode/`, so a mutation drive is NOT planned and must not be
    improvised: paste the three read value lists into the receipt.
  - **Edge:** a value in the JSON absent from Rust (reddens (iii)); an order swap (the equality is
    ORDERED); `funny` still aliased (reddens (v)); the fixture deleted (reddens (iv)).

- [ ] F-AV-34 **leg B (live — an emotion reaches `data-state` through the model's channel).** C-seat
      at rest. Inject `{"reply":"…","status":"uwu"}` on the real `llm-token` channel via
      `tauri_ipc_emit_event` (the `companion/functional.md` **LV2** lever, `:2357-2359`), then
      `llm-status` `uwu`, then `llm-done`; sample **Q-3** at 50 ms across the whole turn and the
      `HAPPY_HOLD_MS = 5000` hold. Then ONE real model turn; record which of the 18 it declared.
  **Expected:** the settle reads `data-state === "uwu"` and `data-avatar-clip === "uwu"` for the
      hold, then returns to `idle` when the hold ends; the injected status word never appears as
      reply text; the real turn's settled `data-state` is a member of the 23 (report it — the schema
      pins what the model MAY emit; AC1 does not require one particular word from one sample).
      Captures `s3224-settle-uwu.jpeg`.
  - **Edge:** a status arriving on the last token; `uwu` while streaming (gated to `undefined` —
    R-2e); an `llm-status` carrying a non-member (F-AV-32 holds).

- [ ] F-AV-34 **leg C `[RETAINED]` (R-2e — the shipped #2918 gate is unchanged).** With an emotion
      settled, drive (i) a stream, (ii) a teleport, (iii) a pending skill call, (iv) live voice
      capture; re-read `data-state` at each.
  **Expected:** the emotion is NOT asserted while any of the four owns the expression
      (`CompanionEntity.tsx:560-563`); `pnpm --filter @fredo/ui test:run` keeps
      `CompanionEntity.replyStatus.test.ts` green **unmodified**.
  - **Edge:** two of the four at once; the gate releasing while the hold is still running (record —
    the hold is timer-owned, so a shortened emotion is a finding to report, not to patch here).

## F-AV-35 `[NEW]` (lever safety, static-by-artifact) — the DEV lever is absent from a production build

- [ ] F-AV-35 **leg A (the build pin — a REAL production build, never a conditional).** Run
      `pnpm --filter @fredo/ui build` **in this round** (report the exit code), assert the build
      **produced** `apps/ui/dist/assets/*.js` (print the resolved glob and the file count; a
      non-empty set is a precondition), then grep those files for `__FREDO_QA_AVATAR_FLOW__`. Print the
      scanned file count and the hit count. **Independent control (G-408):** the same grep over the
      same files for a production token that MUST be present (`data-avatar-clip`) and require a
      **non-zero** hit count (the developer's receipt records 1).
  **Expected:** a **fresh, non-empty production `dist`** exists; **zero** hits for
      `__FREDO_QA_AVATAR_FLOW__`; a **non-zero** control hit count.
      **No conditional path:** the row is not satisfied by a grep against whatever `dist` happens to
      be on disk, and not by "the token is absent because nothing was built".
      **An absent or empty `dist` is UNVERIFIED — never a PASS on a zero of nothing** (a zero hit
      count over zero files is the empty-pair defect: two absences are equal). If the build cannot run
      in the round, the tester records **UNVERIFIED (build not produced)** with the build error — it
      never reports PASS. A control count of 0 is likewise a FAILED DRIVE (wrong path, or the build
      never ran).
      Unit: `readQaAvatarFlowOverride()` returns `undefined` when the global is unset and when it
      holds a non-member; the guard is `import.meta.env.DEV` (constant-folded in a build). Source: no
      product module other than the lever module and the resolver's single read references the global;
      no component, test id or `data-*` attribute was added for it.
  **Control (pre-change):** the token and the module do not exist on the pre-change tree → red.
  - **Live corroboration (same row, cheap):** with the DEV app running, the global is readable (the
    lever works) while the built chunk does not carry it — that asymmetry is the property under test;
    record both readings.
  - **UX-22 / UX-23 static clauses (same row):** assert **zero** new authored strings naming an
    emotion (no label, tooltip, settings row, toast or onboarding sentence; `CompanionEntity.tsx:1881`'s
    shipped `title` names no state), **zero** new focusable nodes and **zero** `[data-state='<emotion>']`
    CSS rule (the only wrapper state rule is the shipped `happy` one — an emotion rule is a FAIL, not
    a fix); the lever module imports no React/JSX and emits no `data-*`/`aria-*`/console/tooltip; it is
    not persisted and not reachable from a URL/query/hash; and no other product module references the
    global except the resolver's single read.
  - **G-430/G-431 note:** the scan universe is the BUILT output (`apps/ui/dist/assets/**`); this
    suite's own prose (which spells the global) is outside it, so the row cannot hit itself.
  - **Edge:** a token surviving only as a source-map string (the grep covers `*.js` — report whether
    maps are emitted and say so); the DEV-served app legitimately carries it (that is the point —
    never scan `src/` for this clause).
  - **Why not `live`:** driving the built app to prove the lever is gone would use the very surface
    claimed absent (G-408). This row is a static-by-artifact clause INSIDE the live policy.

