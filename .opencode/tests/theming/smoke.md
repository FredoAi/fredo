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
