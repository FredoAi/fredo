# Contrast Gate — Regression

> "Must not change" baseline for the contrast gate (#3033). The gate is a **read-only, static, in-repo
> instrument** — it must NOT alter product behaviour, the theme engine, or the existing focus suite.
> Run this file alongside `.opencode/tests/theming/regression.md` (overlapping surface) whenever a
> spec touches theming tokens or the gate.

## Invariants (must NOT change)

- [ ] **CR-1 (theme engine untouched):** `ThemeProvider.tsx`, `system.ts`, `theme.ts` (presets/base
      records) and the `overrides ?? preset ?? base` layering behave exactly as before — the gate
      only READS resolved tokens (via `resolvePresetToken`), it never mutates them. Reference
      `.opencode/tests/theming/regression.md` R-1..R-34.
- [ ] **CR-2 (existing focus suite byte-identical):** `apps/ui/src/app/theme/__tests__/globalFocusVisible.test.ts`
      is unchanged except the ST-1 import swap (its `parseColor`/`luminance`/`contrast`/`mixSrgb`/`round2`
      helpers now imported from `contrast/wcag.ts`). Its `no-worse-than-control` Δ≤0.2 tolerance tier is
      retained as pre-validation **history**; it is NOT weakened, disabled, deleted, or re-pointed at the
      new absolute floor. `git diff` shows the import line only.
- [ ] **CR-3 (read-only gate):** the contrast modules (`wcag.ts`, `matrix.ts`, `evaluate.ts`,
      `contrastBaseline.ts`, `rawColorScan.ts`, `rawColorAllowlist.ts`) contain no `fs.write*`/
      `writeFile`/`setProperty` — the gate never writes source, baseline, or allowlist. Baseline/
      allowlist additions are PR diffs only.
- [ ] **CR-4 (no new dependency):** the `apps/ui/package.json` diff adds only the `contrast:gate`
      script; vitest is reused; no new runtime or test dependency; no new workflow file is added.
- [ ] **CR-5 (no product-code change):** ST-1..ST-6 own only `apps/ui/src/app/theme/contrast/**`
      (new), the `globalFocusVisible.test.ts` import swap, `apps/ui/package.json`, and
      `.github/workflows/validate.yml`. Component styles, tokens, and `system.ts` declarations are
      unchanged (ST-2 cites them, never edits them).
- [ ] **CR-6 (whole suite green):** `pnpm --filter @fredo/ui test:run` green with the gate included;
      `pnpm --filter @fredo/ui build` exit 0 (zero TS errors); no dangling import from the parseColor
      extraction.

## Overlapping suites to run alongside

- `.opencode/tests/theming/regression.md` — the theme engine / preset / override invariants
  (R-1..R-34); the gate reads the same token layers.
- `.opencode/tests/theming/functional.md` — F-13 (Settings chrome contrast AA) and F-25/F-27
  (literal/alpha-append scans) overlap the gate's R-2/R-3 surface.
