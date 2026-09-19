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
