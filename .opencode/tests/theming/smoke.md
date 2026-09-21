# Theming — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the theming surface.
> These confirm the app still boots and the theming path is reachable.

- [x] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [x] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [x] **S-3:** Theming surface reachable — Settings → Appearance → Theming renders the expected sections (Theme Presets, Base Theme, Accent Colors, Backgrounds, Text, Status, Fonts, Animation Style).
- [x] **S-4:** Preset selector present — the preset radio grid / selector exposes the 18 named presets.
- [x] **S-5:** Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2811/e2e/smoke.jpeg")` succeeds.
- [ ] **S-6 (#2842):** Preset readout surface reachable — with a preset selected on Settings → Appearance → Theming, a grouped color-chip readout renders in the content area below the preset selector (`tauri_webview_dom_snapshot(type="structure")` shows the Accent/Backgrounds/Text/Status chip groups; `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Maximum update depth exceeded`).

## #2864 extension — chrome re-tint smoke

- [ ] **S-7:** With Settings open (Companion section), switch dark→light and change the accent;
      the dialog chrome (nav highlight, hover, scrollbar, borders) re-tints with no stale color;
      screenshot succeeds; console clean.
- [ ] **S-8:** `--hover-bg` consumers (Companion setting rows / tip) render a non-transparent
      surface in both themes (T1's single derived `color-mix` resolves per theme — not two literal
      values); `tauri_webview_execute_js` computed `backgroundColor` is a real color; console clean.

### #2864 testing round 1 (spec/2864 @ f2c8923, product 5c0fb5b) — results

- **S-7 PASS (live).** dark→light→accent switch with Settings open re-tints the chrome (nav highlight, borders) with no stale color.
- **S-8 PASS (live).** `--hover-bg` consumers compute `color(srgb .8 .8 .8/.06)` (dark) / `color(srgb .047 .067 .090/.06)` (light) — real colors, never transparent.

## #2865 extension — semantic-token bridge smoke

- [ ] S-9: Bridge quick path — `tauri_webview_execute_js` reads `--chakra-colors-fg-muted` vs
      `--text-secondary` (and `-fg-subtle`/`-bg-hover`); they resolve to the Fredo values (not stock
      `#52525b`/`#a1a1aa`, not empty); console clean.

- [ ] S-10: Wizard re-tint quick path — with the wizard open, switch dark↔light and change the
      accent; every state re-tints with no stale color; screenshot succeeds; console clean of
      `Error:`/`Uncaught`/`Maximum update depth exceeded`.

- [ ] S-11: Visual artifacts + gates — `.opencode/tmp/2865/visual-eval-before.md` +
      `before-after-verdict.md` exist; BEFORE/AFTER frames use DISTINCT `before-*`/`after-*` names;
      `pnpm --filter @fredo/ui build` exit 0; `pnpm --filter @fredo/ui test:run` green.

## #2899 extension — procedural desktop background smoke

> Issue #2899 adds a theme-colored procedural background chooser to Settings → Appearance
> (**None** default). Live policy — the receipt is a rendered-webview read (`tauri_webview_*`) +
> screenshot; F-26 in `functional.md` carries the `telemetry_spans` leg.

- [x] **S-12:** Background selector reachable — Settings → Appearance → Background renders a selector
      with **None + ≥5 procedural options**; a fresh profile shows **None** selected;
      `tauri_read_logs(source="console", lines=50)` clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [x] **S-13:** Quick switch — select a non-None background, confirm the desktop repaints and a feature
      window still opens/renders above it, screenshot succeeds, console clean; reselect **None** and
      confirm today's desktop returns.

### #2899 testing round 1 (spec/2899 @ c846e2e7) — results

- **S-12 PASS (live).** `[data-testid=desktop-background-chooser]` renders None + 6 procedural tiles; fresh profile → None selected (`data-selected="true"`); console clean (only the pre-existing `motion() is deprecated` WARN).
- **S-13 PASS (live).** Aurora selected → desktop repainted (backdrop present, scrim on the launcher surface); Settings + Mission Monitor windows rendered above it; None reselected → backdrop removed, `rgb(45,45,45)` + 28px grid returned.

## #2905 extension — animated procedural background smoke

> Issue #2905 revises #2899: the procedural background must be **visibly applied + animated**.
> Live policy — a rendered-webview read (`tauri_webview_*`) + **rendered-pixel** screenshot; F-37 in
> `functional.md` carries the `telemetry_spans` leg. **G-136:** #2899's static-only smoke intent is
> superseded for animated built-ins.

- [x] **S-14:** Background selector reachable + motion state readable — Settings → Appearance →
      Background renders **None + ≥5 procedural options**; a fresh profile shows **None**; select one
      procedural option and read `window.matchMedia('(prefers-reduced-motion: reduce)').matches` +
      `document.querySelector('[data-testid="desktop-backdrop"]')?.getAnimations()` + its
      `data-motion` / `data-background-id` attributes + the motion caption
      `[data-testid="desktop-background-motion-status"]` (record the raw flag; with reduce OFF expect
      ≥1 running animation and `data-motion="animated"`); `tauri_read_logs(source="console", lines=50)`
      clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [x] **S-15:** Quick switch + visibility + repaint — select a procedural option, screenshot the
      desktop and confirm the **rendered pixels differ from the None control** at ≥1 desktop point
      (not merely a non-empty computed style); a feature window still opens/renders above it; reselect
      **None** and confirm today's desktop returns (no `desktop-backdrop` DOM); screenshot succeeds;
      console clean.
- [x] **S-16:** Reduced-motion + gates — the product-unit/static pin for reduced-motion gating exists
      and passes; `pnpm --filter @fredo/ui build` exit 0; `pnpm --filter @fredo/ui test:run` green.


### #2905 testing round 1 (spec/2905 @ d64ac959) — results

- **S-14 PASS (live).** `desktop-background-chooser` renders None + 6 procedural options; select aurora → `data-motion="animated"`, `data-background-id="aurora"`, 2 running backdrop animations, caption `Motion: on`; console clean.
- **S-15 PASS (live).** procedural → desktop repaint (pixels differ from None at 3–5/5 points); Settings window renders above; reselect None → backdrop DOM absent, `rgb(45,45,45)`+grid returns.
- **S-16 PASS.** reduced-motion product-unit/static pin passes (5 files / 64 tests); build exit 0; `test:run` 108 files / 1779 tests passed.

## #2909 extension — perceptible motion smoke (revises #2905)

> Issue #2909 revises #2905: the animated background must be **genuinely perceptible**, not merely
> present. Live policy — a **dense rendered-pixel** diff (seek-based) + screenshot; F-53 in
> `functional.md` carries the `telemetry_spans` leg. **A signature/`getAnimations()` read is NOT
> evidence of perceptibility** (see F-40).

- [x] **S-17:** Background selector + motion state — Settings → Appearance → Background renders
      **None + ≥5 procedural options**; select a procedural option and read
      `window.matchMedia('(prefers-reduced-motion: reduce)').matches` +
      `document.querySelector('[data-testid="desktop-backdrop"]')?.getAnimations().length` + its
      `data-motion`/`data-background-id` + the caption `[data-testid="desktop-background-motion-status"]`;
      `tauri_read_logs(source="console", lines=50)` clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
      **Expected:** six recipe options; with reduce OFF `data-motion="animated"` and ≥1 running animation;
      console clean.
- [x] **S-18:** Quick perceptibility sanity — select a procedural option (all windows closed), pause the
      backdrop animations and seek to 0 then 3000 ms, screenshot each; run a **dense full-frame diff** of
      the two frames.
      **Expected:** **≥ 2.0 %** of backdrop pixels change by ≥ 8 per channel within the 3 s seek
      (constellation ≥ 3.0 %, aurora/nebula/mesh/halo ≥ 4.0 %) — a non-empty `getAnimations()` with a
      sub-floor diff is a FAIL. Then reselect **None** and confirm the backdrop DOM is absent
      (`[data-testid="desktop-backdrop"]` null) and today's desktop returns; screenshot succeeds.
- [x] **S-19:** Reduced-motion + gates — the product-unit/static pin for reduced-motion gating exists
      and passes (`resolveBackgroundMotion({ systemReducedMotion: true })` → `'static'`, zero
      `animation*` on the static render); `pnpm --filter @fredo/ui build` exit 0;
      `pnpm --filter @fredo/ui test:run` green; the live OS flip is recorded
      **UNVERIFIED-with-named-blocker** (Tauri MCP driver has no media-emulation API — G-050/G-148/#2870).

### #2909 testing round 1 (spec/2909 @ d2971844) — results

- **S-17 PASS (live).** Chooser renders None + the six recipes (`desktop-background-option-{none,aurora,nebula,mesh,topography,constellation,halo}`); raw `matchMedia('(prefers-reduced-motion: reduce)').matches` = **false**; with a recipe selected `data-motion="animated"`, `data-background-id` = the recipe, 2–3 running backdrop animations; caption `Motion: on`; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- **S-18 PASS (live).** Dense full-frame diff of paused seek 0 vs 3000 ms, all six recipes: aurora 64.7 %, nebula 2.93 %, mesh 18.3 %, topography 12.0 %, constellation 40.9 %, halo 13.0 % — every recipe additionally clears its floor on ≥ 2 of the 3 phase-spread intervals and the max pairwise interval (see F-39). Reselecting None → `desktop-backdrop` null; today's desktop returns; screenshot succeeds.
- **S-19 PASS.** Reduced-motion pin passes (`resolveBackgroundMotion({true})` → `'static'`, static render zero `animation*`); build exit 0; `test:run` 108 files / 1805 tests; live OS flip recorded UNVERIFIED-with-named-blocker (no media-emulation API).

## #2915 extension — Conway's Game of Life smoke

> Issue #2915 adds a **Life** option beside None + the six recipes. Live policy — a rendered-webview
> read (`tauri_webview_*`) + a **rendered-pixel** quick diff; F-70 in `functional.md` carries the
> `telemetry_spans` leg. No prior smoke row is superseded.

- [x] **S-20:** Background selector reachable + Life present — Settings → Appearance → Desktop Background
      renders **None + the six recipes + Life** (`[data-testid="desktop-background-option-life"]`); a fresh
      profile shows **None**; `tauri_read_logs(source="console", lines=50)` clean of
      `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [x] **S-21:** Quick Life switch + repaint — select Life; `[data-testid="desktop-backdrop"]` present with
      `data-background-id="life"`; a dense quick diff of two frames ≈2 s apart (windows closed) is a
      non-zero change (sanity — the full gate is F-61); open a feature window and confirm it renders above;
      reselect **None** → backdrop DOM absent + today's desktop returns; screenshot succeeds; console clean.
- [x] **S-22:** Reduced-motion + gates — the Life reduced-motion product-unit pin exists and passes (static
      render schedules no loop, `data-motion="static"`); `pnpm --filter @fredo/ui build` exit 0;
      `pnpm --filter @fredo/ui test:run` green; the live OS flip is recorded
      **UNVERIFIED-with-named-blocker** (Tauri MCP has no media-emulation API — G-050/G-148/#2870).
- [x] **S-23:** Attribution quick check — the **CC BY-SA 3.0** attribution + licence notice is present in the
      Life pattern module (source) and in the docs; the curated pattern set is bounded (no full-lexicon dump).

### #2915 testing round 1 (spec/2915 @ a3c7f245) — results

- **S-20 PASS (live).** Chooser renders None + six recipes + Life (`desktop-background-option-life`, `aria-label="Life"`, `aria-description="Living Conway's Game of Life"`); fresh profile → None; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded` (only the pre-existing `motion() is deprecated` WARN).
- **S-21 PASS (live).** Life selected → `data-background-id="life"` + Life canvas; dense diff of two fresh loads 11.974 %; Settings window renders above the field; reselect None → backdrop DOM absent + today's desktop returns.
- **S-22 PASS (gates) + named blocker.** Life reduced-motion pin passes (lifeBounds 8/8, lifeEngine 12/12); build exit 0; `test:run` 115 files / 1700 tests; live OS flip UNVERIFIED-with-named-blocker (no media-emulation API).
- **S-23 PASS.** CC BY-SA 3.0 notice in `lifePatterns.ts:6-21`, `docs/features/desktop-background-life.md`, and live at `desktop-background-life-attribution`; catalogue bounded at 10 patterns (module-load guard).

### #2915 testing round 2 (spec/2915 @ 79a80c1b) — results

- **S-20 PASS (live).** chooser None + six recipes + Life; fresh profile → None; console clean (only the pre-existing `motion() is deprecated` WARN).
- **S-21 PASS (live).** Life switch → `data-background-id="life"` + Life canvas; reselect None → backdrop DOM absent + today's desktop returns.
- **S-22 PASS (gates) + named blocker.** reduced-motion pin green (`lifeBounds` 8/8, `lifeEngine` 12/12); build exit 0; `test:run` 115 files / 1700 tests; live OS flip UNVERIFIED-with-named-blocker (no media-emulation API).
- **S-23 PASS.** attribution in source + docs + live notice; catalogue bounded at 10.
